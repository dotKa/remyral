import { Writable } from 'node:stream';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry, MetricHistory } from '@remyral/observability/telemetry';
import { describe, expect, it } from 'vitest';
import { redactingLogStream } from '../../src/logging.js';
import { LogSink, toLogLine } from '../../src/system/logs.js';
import { chatTurnTelemetry } from '../../src/telemetry/instrument.js';

const CFG = { retentionDays: 7, minLevel: 'info' as const, requests: 'problems' as const, maxRows: 1000 };
const GH = `ghp_${'Z'.repeat(36)}`;

function lines(sink: LogSink): string[] {
  return sink.drain(1000).map((l) => l.msg);
}

describe('p16-observability log capture (LogSink)', () => {
  it('keeps lines at or above the level and normalises their ids', () => {
    const sink = new LogSink(CFG);
    sink.push({ level: 20, time: 1, msg: 'debug noise' });
    sink.push({
      level: 30,
      time: 2,
      msg: 'hello',
      component: 'orchestrator',
      jobId: 'job-1',
      pid: 1,
      extra: 1,
    });
    sink.push({ level: 50, time: 3, msg: 'boom', trace_id: 'a'.repeat(32), reqId: 'not an id with spaces' });
    const out = sink.drain(10);
    expect(out.map((l) => l.msg)).toEqual(['hello', 'boom']);
    expect(out[0]).toMatchObject({ component: 'orchestrator', jobId: 'job-1', fields: { extra: 1 } });
    expect(out[0]?.fields).not.toHaveProperty('pid');
    expect(out[1]).toMatchObject({ traceId: 'a'.repeat(32), reqId: null });
    expect(sink.stats().filtered).toBe(1);
  });

  it('drops the request pair of a healthy fast request and keeps a failed or slow one', () => {
    const sink = new LogSink(CFG);
    sink.push({ level: 30, msg: 'incoming request', reqId: 'r1', req: { method: 'GET', url: '/a' } });
    sink.push({ level: 30, msg: 'handler line', reqId: 'r1' });
    sink.push({
      level: 30,
      msg: 'request completed',
      reqId: 'r1',
      res: { statusCode: 200 },
      responseTime: 3,
    });
    sink.push({ level: 30, msg: 'incoming request', reqId: 'r2', req: { method: 'GET', url: '/b' } });
    sink.push({
      level: 30,
      msg: 'request completed',
      reqId: 'r2',
      res: { statusCode: 500 },
      responseTime: 3,
    });
    sink.push({ level: 30, msg: 'incoming request', reqId: 'r3' });
    sink.push({
      level: 30,
      msg: 'request completed',
      reqId: 'r3',
      res: { statusCode: 200 },
      responseTime: 4000,
    });
    expect(lines(sink)).toEqual([
      'handler line',
      'incoming request',
      'request completed',
      'incoming request',
      'request completed',
    ]);
    const all = new LogSink({ ...CFG, requests: 'all' });
    all.push({ level: 30, msg: 'incoming request', reqId: 'r1' });
    all.push({ level: 30, msg: 'request completed', reqId: 'r1', res: { statusCode: 200 } });
    expect(lines(all)).toHaveLength(2);
  });

  it('is bounded: rate limit, queue size, field size; off when the retention is 0', () => {
    let now = 0;
    const sink = new LogSink({ ...CFG, ratePerSec: 1, maxQueue: 100 }, () => now);
    for (let i = 0; i < 50; i++) sink.push({ level: 30, msg: `m${String(i)}` });
    expect(sink.stats()).toMatchObject({ queued: 10, dropped: 40 });
    now = 5000;
    sink.push({ level: 30, msg: 'later' });
    expect(sink.stats().queued).toBe(11);
    const big = toLogLine({ level: 30, msg: 'x'.repeat(5000), blob: 'y'.repeat(20_000) });
    expect(big?.msg).toHaveLength(2048);
    expect(big?.fields).toMatchObject({ truncated: true, keys: ['blob'] });
    const off = new LogSink({ ...CFG, retentionDays: 0 });
    off.push({ level: 50, msg: 'x' });
    expect(off.enabled).toBe(false);
    expect(off.stats().queued).toBe(0);
  });

  it('the production stream hands the tap the redacted object, and output stays unchanged', async () => {
    const seen: Record<string, unknown>[] = [];
    let text = '';
    const out = new Writable({
      write(chunk: Buffer, _e, cb) {
        text += chunk.toString('utf8');
        cb();
      },
    });
    const stream = redactingLogStream(out, undefined, (l) => {
      seen.push(l);
      throw new Error('a failing tap never breaks logging');
    });
    stream.write(`${JSON.stringify({ level: 50, time: 1, msg: `leak ${GH}` })}\nnot json\n`);
    await new Promise((r) => setImmediate(r));
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen)).not.toContain(GH);
    expect(text).not.toContain(GH);
    expect(text.trim().split('\n')).toHaveLength(2);
  });
});

describe('p16-observability chat turn telemetry', () => {
  it('a chat.turn span per turn (error when failed), its trace context and the turn counter', async () => {
    const spans = new InMemorySpanExporter();
    let now = 0;
    const history = new MetricHistory({ names: ['remyral_chat_turns'], now: () => now });
    const t = createTelemetry({ serviceName: 'svc', spanExporter: spans, metricReaders: [history] });
    const obs = chatTurnTelemetry(t);
    await history.sample();
    const tp = obs.started('turn-1', { runtime: 'claude-code', workerId: 'wrk_1' });
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    obs.started('turn-2', { runtime: undefined, workerId: 'wrk_1' });
    obs.ended('turn-1', 'done');
    obs.ended('turn-2', 'failed', 'worker_lost');
    obs.ended('turn-2', 'failed'); // a second end is ignored
    now = 60_000;
    await history.sample();
    const finished = spans.getFinishedSpans().filter((s) => s.name === 'chat.turn');
    expect(finished).toHaveLength(2);
    expect(finished.find((s) => s.attributes['remyral.chat.turn'] === 'turn-2')?.status.code).toBe(2);
    expect(finished[0]?.parentSpanContext).toBeUndefined();
    expect(tp).toContain(
      finished.find((s) => s.attributes['remyral.chat.turn'] === 'turn-1')?.spanContext().spanId,
    );
    expect(history.delta('remyral_chat_turns')).toBe(2);
    expect(history.delta('remyral_chat_turns', (a) => a.outcome === 'failed')).toBe(1);
    await t.shutdown();
  });
});
