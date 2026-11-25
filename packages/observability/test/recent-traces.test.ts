import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeTraceparent,
  contextFromTraceparent,
  createTelemetry,
  MetricHistory,
  parseTraceparent,
  RecentTraces,
  type Telemetry,
  traceparentOf,
} from '../src/telemetry/index.js';

let t: Telemetry | null = null;
afterEach(async () => {
  await t?.shutdown();
  t = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('traceparent helpers (W3C trace context)', () => {
  it('formats, parses and rejects malformed or all-zero values', () => {
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const sc = parseTraceparent(tp);
    expect(sc).toMatchObject({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      isRemote: true,
    });
    expect(traceparentOf(sc)).toBe(tp);
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeUndefined();
    expect(parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeUndefined();
    expect(parseTraceparent('garbage')).toBeUndefined();
    expect(parseTraceparent(42)).toBeUndefined();
    // An invalid value leaves the context unchanged.
    const base = context.active();
    expect(contextFromTraceparent('nope', base)).toBe(base);
  });

  it('a child started under a remote parent continues its trace', async () => {
    const recent = new RecentTraces();
    t = createTelemetry({ serviceName: 'svc', spanProcessors: [recent] });
    expect(t.tracing).toBe(true);
    expect(t.exporting).toBe(false);
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const span = t.tracer.startSpan('worker.message X', {}, contextFromTraceparent(tp));
    expect(span.spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    span.end();
    await t.span('outer', {}, () => {
      expect(activeTraceparent()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      return Promise.resolve();
    });
  });
});

describe('RecentTraces (in-process slow / error traces)', () => {
  it('keeps slow and failed traces with their sanitized spans, drops fast healthy ones', async () => {
    const recent = new RecentTraces({ slowMs: 20, slowMsByPrefix: { 'chat.turn': 100_000 } });
    t = createTelemetry({ serviceName: 'svc', spanProcessors: [recent] });
    const tel = t;
    await tel.span('HTTP GET /fast', { 'http.route': '/fast' }, async () => {
      await tel.span('db select', {}, () => Promise.resolve());
    });
    await tel.span(
      'HTTP GET /slow',
      { 'http.route': '/slow', 'remyral.job.prompt': 'sk-ant-SECRET' },
      async () => {
        await tel.span('db select', { 'db.operation.name': 'select' }, () => sleep(30));
      },
    );
    await expect(
      tel.span('HTTP POST /boom', {}, () => Promise.reject(new TypeError('secret message'))),
    ).rejects.toThrow();
    // A long chat turn below its own threshold is not "slow".
    await tel.span('chat.turn', {}, () => sleep(30));
    const all = recent.list();
    expect(all.map((x) => x.root).sort()).toEqual(['HTTP GET /slow', 'HTTP POST /boom']);
    const slow = recent.list('slow')[0];
    expect(slow?.slow).toBe(true);
    expect(slow?.attributes['http.route']).toBe('/slow');
    const detail = recent.get(slow?.traceId ?? '');
    expect(detail?.spans.map((s) => s.name).sort()).toEqual(['HTTP GET /slow', 'db select']);
    const dump = JSON.stringify(detail);
    expect(dump).not.toContain('sk-ant-');
    expect(dump).not.toContain('prompt');
    const err = recent.list('error')[0];
    expect(err?.error).toBe(true);
    expect(JSON.stringify(recent.get(err?.traceId ?? ''))).not.toContain('secret message');
    expect(recent.stats()).toMatchObject({ slow: 1, errors: 1, pending: 0 });
  });

  it('is bounded: list length, spans per trace and open traces', () => {
    let now = 0;
    const recent = new RecentTraces({
      slowMs: 0,
      limit: 3,
      maxSpansPerTrace: 2,
      maxPending: 2,
      pendingTtlMs: 10,
      now: () => now,
    });
    t = createTelemetry({ serviceName: 'svc', spanProcessors: [recent] });
    const tracer = t.tracer;
    for (let i = 0; i < 5; i++) {
      const root = tracer.startSpan(`r${String(i)}`);
      const ctx = trace.setSpan(context.active(), root);
      for (let j = 0; j < 4; j++) tracer.startSpan('child', {}, ctx).end();
      root.end();
    }
    const list = recent.list();
    expect(list).toHaveLength(3);
    expect(list.every((x) => !('spans' in x))).toBe(true);
    const one = recent.get(list[0]?.traceId ?? '');
    expect(one?.spans).toHaveLength(2);
    expect(one?.droppedSpans).toBe(3);
    // Open traces whose root never ends: at most maxPending, then dropped.
    for (let i = 0; i < 4; i++) {
      const root = tracer.startSpan('open');
      tracer.startSpan('child', {}, trace.setSpan(context.active(), root)).end();
    }
    expect(recent.stats().pending).toBe(2);
    now = 1000;
    for (let i = 0; i < 300; i++) tracer.startSpan('fast').end();
    expect(recent.stats().pending).toBe(0);
  });

  it('marks a failed span anywhere in the trace as an error trace', async () => {
    const recent = new RecentTraces({ slowMs: 60_000 });
    t = createTelemetry({ serviceName: 'svc', spanProcessors: [recent] });
    const tel = t;
    await tel.span('job.dispatch', {}, () => {
      const s = tel.tracer.startSpan('db insert');
      s.setStatus({ code: SpanStatusCode.ERROR });
      s.end();
      return Promise.resolve();
    });
    expect(recent.list('error')[0]?.root).toBe('job.dispatch');
  });
});

describe('MetricHistory', () => {
  it('reports counter and histogram growth over the window from cumulative samples', async () => {
    let now = 0;
    const history = new MetricHistory({ names: ['req', 'dur'], now: () => now });
    t = createTelemetry({ serviceName: 'svc', metricReaders: [history] });
    const c = t.meter.createCounter('req');
    const h = t.meter.createHistogram('dur');
    c.add(5, { status_class: '2xx' });
    await history.sample();
    expect(history.delta('req')).toBeNull();
    now = 60_000;
    c.add(3, { status_class: '5xx' });
    c.add(2, { status_class: '2xx' });
    h.record(1, { status_class: '5xx' });
    h.record(2, { status_class: '5xx' });
    await history.sample();
    expect(history.delta('req')).toBe(5);
    expect(history.delta('req', (a) => a.status_class === '5xx')).toBe(3);
    expect(history.delta('dur')).toBe(2);
    expect(history.delta('missing')).toBe(0);
    expect(history.coverageMinutes()).toBe(1);
  });
});
