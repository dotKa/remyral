import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeTraceIds,
  createTelemetry,
  parseHeaders,
  sanitizeAttributes,
  type Telemetry,
} from '../src/telemetry/index.js';

const GH = `ghp_${'X'.repeat(36)}`;
let t: Telemetry | null = null;
let server: Server | null = null;
afterEach(async () => {
  await t?.shutdown();
  t = null;
  await new Promise<void>((r) => {
    if (server) {
      server.close(() => {
        r();
      });
    } else r();
  });
  server = null;
});

describe('attribute policy', () => {
  it('keeps allowlisted identifiers only and filters free text and secrets', () => {
    const out = sanitizeAttributes({
      'remyral.job.id': '7d3c5c1e-0000-4000-8000-000000000001',
      'remyral.worker.id': 'wrk_abcdefghijklmnopqrstuvwxyz',
      'http.route': '/jobs/:id',
      'http.response.status_code': 200,
      'remyral.job.prompt': 'Fix the bug and use my key sk-ant-xxxxxxxxxxxxxxxxxxxxxx',
      'remyral.project': `p ${GH}`,
      'db.statement': "SELECT * FROM users WHERE password = 'x'",
      'http.request.header.authorization': 'Bearer abc',
    });
    expect(out).toEqual({
      'remyral.job.id': '7d3c5c1e-0000-4000-8000-000000000001',
      'remyral.worker.id': 'wrk_abcdefghijklmnopqrstuvwxyz',
      'http.route': '/jobs/:id',
      'http.response.status_code': 200,
      'remyral.project': '[filtered]',
    });
  });
});

describe('parseHeaders', () => {
  it('reads name=value lines and never echoes a bad line', () => {
    expect(parseHeaders('# c\nx-api-key = abc=def\n\nAuthorization=Bearer t\n')).toEqual({
      'x-api-key': 'abc=def',
      Authorization: 'Bearer t',
    });
    expect(() => parseHeaders('secret-value-without-name')).toThrow(/^OTLP headers file: every line/);
    try {
      parseHeaders('secret-value-without-name');
    } catch (err) {
      expect(String(err)).not.toContain('secret-value');
    }
  });
});

describe('createTelemetry', () => {
  it('exports sanitized spans: no unknown attributes, no status text, exceptions by type only', async () => {
    const exporter = new InMemorySpanExporter();
    t = createTelemetry({ serviceName: 'test', spanExporter: exporter });
    expect(t.tracing).toBe(true);
    await expect(
      t.span('job.run', { 'remyral.job.id': 'j1', 'remyral.job.prompt': 'secret prompt' }, async (span) => {
        expect(activeTraceIds().trace_id).toMatch(/^[0-9a-f]{32}$/);
        span.recordException(new Error(`token ${GH}`));
        span.setStatus({ code: SpanStatusCode.ERROR, message: `failed with ${GH}` });
        await Promise.resolve();
        throw new TypeError(`boom ${GH}`);
      }),
    ).rejects.toThrow(TypeError);
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('job.run');
    expect(span?.attributes).toEqual({ 'remyral.job.id': 'j1', 'error.type': 'TypeError' });
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(JSON.stringify(span?.events)).not.toContain(GH);
    expect(span?.events[0]?.attributes).toEqual({ 'exception.type': 'Error' });
    expect(JSON.stringify(span?.attributes)).not.toContain('prompt');
  });

  it('is a cheap no-op tracer without an exporter', async () => {
    t = createTelemetry({ serviceName: 'test' });
    expect(t.tracing).toBe(false);
    expect(await t.span('x', {}, () => Promise.resolve(42))).toBe(42);
    expect(activeTraceIds()).toEqual({});
  });

  it('serves Prometheus text through the handler', async () => {
    t = createTelemetry({ serviceName: 'test', prometheus: true });
    const c = t.meter.createCounter('remyral_test_events', { description: 'test counter' });
    c.add(3, { 'remyral.runtime': 'pi' });
    const handler = t.metricsHandler;
    expect(handler).not.toBeNull();
    server = createServer((req, res) => handler?.(req, res));
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const body = await (await fetch(`http://127.0.0.1:${String(port)}/metrics`)).text();
    expect(body).toContain('# TYPE remyral_test_events_total counter');
    expect(body).toMatch(/remyral_test_events_total\{.*remyral_runtime="pi".*\} 3/);
  });
});
