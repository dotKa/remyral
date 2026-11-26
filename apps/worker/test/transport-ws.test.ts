import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import type { WorkerToMaster } from '@remyral/protocol';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { DeviceKey, verifyChallenge } from '../src/identity/device-key.js';
import type { ConnectParams, TransportEvent } from '../src/transport/port.js';
import {
  backoffDelay,
  CloseCode,
  InvalidMasterUrlError,
  NotConnectedError,
  SendQueueFullError,
  workerEndpoint,
  WsTransport,
  type WsTransportOptions,
} from '../src/transport/ws.js';
import { FakeMaster } from './fake-master.js';
import { tempDir } from './helpers.js';

const FACTS = {
  os: 'darwin',
  osVersion: '26.0',
  arch: 'arm64',
  hostname: 'unit',
  cpuCount: 4,
  memoryBytes: 1024,
  diskFreeBytes: 2048,
} as const;

const FAST = {
  handshakeTimeoutMs: 2_000,
  helloTimeoutMs: 2_000,
  pingIntervalMs: 60_000,
  pongTimeoutMs: 1_000,
  backoffBaseMs: 20,
  backoffMaxMs: 80,
  stableAfterMs: 60_000,
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function logLines() {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    logger: createLogger({
      level: 'debug',
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  };
}

interface Rig {
  master: FakeMaster;
  transport: WsTransport;
  events: TransportEvent[];
  params: ConnectParams;
  key: DeviceKey;
  lines: Record<string, unknown>[];
}

async function rig(
  opts: {
    master?: FakeMaster;
    params?: Partial<ConnectParams>;
    transport?: Partial<WsTransportOptions>;
    onEvent?: (e: TransportEvent) => void | Promise<void>;
  } = {},
): Promise<Rig> {
  const master = opts.master ?? (await FakeMaster.start());
  const key = DeviceKey.generate();
  const { lines, logger } = logLines();
  const transport = new WsTransport({
    masterUrl: master.url,
    logger,
    workerVersion: '0.1.0-test',
    facts: () => FACTS,
    timing: FAST,
    random: () => 0.5,
    ...opts.transport,
  });
  const params: ConnectParams = {
    publicKey: key.publicKey,
    workerId: 'wrk_test',
    pairingCode: null,
    resumeFromSeq: 0,
    signChallenge: (n) => key.signChallenge(n),
    ...opts.params,
  };
  const events: TransportEvent[] = [];
  await transport.start({ ...params, refresh: () => params }, (e) => {
    events.push(e);
    return opts.onEvent?.(e);
  });
  cleanups.push(() => master.close());
  cleanups.push(() => transport.stop());
  return { master, transport, events, params, key, lines };
}

function heartbeat(): WorkerToMaster {
  return {
    protocolVersion: '1.0',
    type: 'HEARTBEAT',
    messageId: randomUUID(),
    seq: 0,
    ts: new Date().toISOString(),
    correlationId: 'test',
    workerId: 'wrk_test' as never,
    payload: {
      state: 'online',
      runningJobs: [],
      load: { cpuPercent: 0, memoryFreeBytes: 0, diskFreeBytes: 0 },
    },
  };
}

function ack(n: number): WorkerToMaster {
  return { ...heartbeat(), type: 'ACK', payload: { throughSeq: n } } as WorkerToMaster;
}

describe('workerEndpoint', () => {
  it('maps the configured master URL to /v1/worker', () => {
    expect(workerEndpoint('wss://master.example').toString()).toBe('wss://master.example/v1/worker');
    expect(workerEndpoint('https://master.example').toString()).toBe('wss://master.example/v1/worker');
    expect(workerEndpoint('ws://127.0.0.1:8080').toString()).toBe('ws://127.0.0.1:8080/v1/worker');
    expect(workerEndpoint('ws://[::1]:8080/custom').toString()).toBe('ws://[::1]:8080/custom');
  });

  it('refuses plaintext to non-loopback hosts, credentials, queries and other schemes', () => {
    for (const bad of [
      'ws://master.example',
      'ws://10.0.0.5:8080',
      'http://master.example',
      'wss://user:pw@master.example',
      'wss://master.example/?token=x',
      'ftp://master.example',
      'not a url',
    ]) {
      expect(() => workerEndpoint(bad), bad).toThrow(InvalidMasterUrlError);
    }
  });
});

describe('backoffDelay', () => {
  const t = { backoffBaseMs: 1_000, backoffMaxMs: 60_000 };
  it('grows exponentially with equal jitter and is capped', () => {
    expect(backoffDelay(0, t, () => 0)).toBe(500);
    expect(backoffDelay(0, t, () => 1)).toBe(1_000);
    expect(backoffDelay(3, t, () => 0)).toBe(4_000);
    expect(backoffDelay(3, t, () => 1)).toBe(8_000);
    expect(backoffDelay(10, t, () => 1)).toBe(60_000);
    expect(backoffDelay(1_000, t, () => 0)).toBe(30_000);
  });
  it('spreads reconnects (jitter)', () => {
    const values = new Set(Array.from({ length: 50 }, () => backoffDelay(4, t)));
    expect(values.size).toBeGreaterThan(10);
  });
});

describe('WsTransport handshake', () => {
  it('sends HELLO, answers the challenge with a domain-separated signature and reports the session', async () => {
    const r = await rig({ params: { resumeFromSeq: 9 } });
    const ws = await r.master.nextConnection();
    await expect.poll(() => r.master.frames.length).toBeGreaterThan(0);
    const hello = r.master.frames[0]?.message;
    if (hello?.type !== 'HELLO') throw new Error('expected HELLO first');
    expect(hello.seq).toBe(0);
    expect(hello.workerId).toBe('wrk_test');
    expect(hello.payload).toMatchObject({
      supportedVersions: ['1.0'],
      workerVersion: '0.1.0-test',
      publicKey: r.key.publicKey,
      resumeFromSeq: 9,
      facts: FACTS,
    });
    expect(hello.payload.pairingCode).toBeUndefined();
    await expect(r.transport.send(heartbeat())).rejects.toBeInstanceOf(NotConnectedError);

    const auth = await r.master.establish(ws, 0, { resumeFromSeq: 4, nonce: 'n'.repeat(40) });
    expect(verifyChallenge(r.key.publicKey, 'n'.repeat(40), auth.payload.signature)).toBe(true);
    await expect
      .poll(() => r.events.find((e) => e.kind === 'connected'))
      .toEqual({
        kind: 'connected',
        enrolled: true,
        session: expect.objectContaining({ negotiatedVersion: '1.0', resumeFromSeq: 4 }) as unknown,
      });
    expect(r.transport.established).toBe(true);
    await r.transport.send(heartbeat());
    await r.master.waitFor('HEARTBEAT');
  });

  it('offers the pairing code and reports a pending enrollment, then the approval without a second connect', async () => {
    const r = await rig({ params: { workerId: null, pairingCode: 'ABCD-EFGH' } });
    const ws = await r.master.nextConnection();
    const hello = await r.master.waitFor('HELLO');
    expect(hello.workerId).toBeUndefined();
    expect(hello.payload.pairingCode).toBe('ABCD-EFGH');
    r.master.send(ws, 'CHALLENGE', { nonce: 'x'.repeat(32), expiresAt: new Date().toISOString() });
    await r.master.waitFor('AUTH');
    r.master.send(
      ws,
      'ENROLL_PENDING',
      { fingerprint: r.key.fingerprint, expiresAt: new Date().toISOString() },
      { workerId: 'wrk_new' },
    );
    await expect.poll(() => r.events[0]).toEqual({ kind: 'connected', enrolled: false });
    r.master.send(
      ws,
      'ENROLL_APPROVED',
      { workerId: 'wrk_new', approvedAt: new Date().toISOString() },
      { workerId: 'wrk_new' },
    );
    r.master.send(
      ws,
      'SESSION_ESTABLISHED',
      { negotiatedVersion: '1.0', sessionExpiresAt: new Date().toISOString(), resumeFromSeq: 0 },
      { workerId: 'wrk_new' },
    );
    await expect
      .poll(() => r.events.map((e) => (e.kind === 'message' ? e.message.type : e.kind)))
      .toEqual(['connected', 'ENROLL_PENDING', 'ENROLL_APPROVED', 'SESSION_ESTABLISHED']);
    expect(r.transport.established).toBe(true);
  });

  it('answers an in-band re-authentication and refuses a reused nonce', async () => {
    const r = await rig();
    const ws = await r.master.nextConnection();
    await r.master.establish(ws, 0, { nonce: 'a'.repeat(32) });
    r.master.send(ws, 'CHALLENGE', { nonce: 'b'.repeat(32), expiresAt: new Date().toISOString() });
    const reauth = await r.master.waitFor('AUTH');
    expect(reauth.payload.nonce).toBe('b'.repeat(32));
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    r.master.send(ws, 'CHALLENGE', { nonce: 'b'.repeat(32), expiresAt: new Date().toISOString() });
    expect(await closed).toBe(CloseCode.protocolViolation);
  });
});

describe('WsTransport frame validation', () => {
  it('ignores invalid frames up to a limit, then closes', async () => {
    const r = await rig({ transport: { limits: { maxInvalidFrames: 2 } } });
    const ws = await r.master.nextConnection();
    await r.master.establish(ws, 0);
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    ws.send('{"type":"DRAIN"}');
    ws.send('not json');
    ws.send(JSON.stringify({ hello: 1 }));
    expect(await closed).toBe(CloseCode.protocolViolation);
    expect(r.transport.stats.invalidFrames).toBe(3);
  });

  it('refuses binary frames', async () => {
    const r = await rig();
    const ws = await r.master.nextConnection();
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    ws.send(Buffer.from([0, 1, 2]));
    expect(await closed).toBe(CloseCode.unsupportedData);
  });

  it('carries the STREAM_* plane with a stream handler (p19-ide W2, ADR-0066)', async () => {
    const seen: { control: string[]; data: Buffer[]; sessions: number; ends: number } = {
      control: [],
      data: [],
      sessions: 0,
      ends: 0,
    };
    const r = await rig();
    r.transport.setStreamHandler({
      onSessionStart: () => seen.sessions++,
      onSessionEnd: () => seen.ends++,
      onControl: (m) => seen.control.push(m.type),
      onData: (frame) => {
        seen.data.push(frame);
        return frame[0] === 1;
      },
    });
    const ws = await r.master.nextConnection();
    await r.master.establish(ws, 0);
    await new Promise((res) => setTimeout(res, 20));
    expect(seen.sessions).toBe(1);
    const fromWorker = new Promise<{ data: Buffer; binary: boolean }>((resolve) =>
      ws.on('message', (data, binary) => {
        if (binary) resolve({ data: data as Buffer, binary });
      }),
    );
    r.master.send(
      ws,
      'STREAM_OPEN',
      { streamId: 1, target: 'ide', workspaceId: '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e002', window: 4096 },
      { workerId: 'wrk_test' },
    );
    ws.send(Buffer.from([1, 0, 0, 0, 1, 42]));
    await new Promise((res) => setTimeout(res, 50));
    expect(seen.control).toEqual(['STREAM_OPEN']);
    expect(seen.data).toEqual([Buffer.from([1, 0, 0, 0, 1, 42])]);
    // Stream control never reaches the daemon's ordered event queue.
    expect(r.events.filter((e) => e.kind === 'message' && e.message.type === 'STREAM_OPEN')).toHaveLength(0);
    await r.transport.sendBinary(Buffer.from([1, 0, 0, 0, 1, 7]));
    expect(await fromWorker).toEqual({ data: Buffer.from([1, 0, 0, 0, 1, 7]), binary: true });
    // A frame the handler calls a violation drops the connection.
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    ws.send(Buffer.from([9, 9]));
    expect(await closed).toBe(CloseCode.protocolViolation);
    await new Promise((res) => setTimeout(res, 20));
    expect(seen.ends).toBe(1);
    await expect(r.transport.sendBinary(Buffer.from([1, 0, 0, 0, 1, 7]))).rejects.toBeInstanceOf(
      NotConnectedError,
    );
  });

  it('refuses application messages before the session is established', async () => {
    const r = await rig();
    const ws = await r.master.nextConnection();
    await r.master.waitFor('HELLO');
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    r.master.send(ws, 'DRAIN', { reason: 'x' }, { workerId: 'wrk_test' });
    expect(await closed).toBe(CloseCode.protocolViolation);
    expect(r.events.filter((e) => e.kind === 'message')).toHaveLength(0);
  });

  it('closes when the master exceeds the frame size (maxPayload)', async () => {
    const r = await rig();
    const ws = await r.master.nextConnection();
    await r.master.establish(ws, 0);
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    ws.send('x'.repeat(600 * 1024));
    expect([1006, 1009]).toContain(await closed);
  });
});

describe('WsTransport reconnect', () => {
  it('reconnects with backoff after a drop and re-reads the connect parameters', async () => {
    const r = await rig();
    const first = await r.master.nextConnection();
    await r.master.establish(first, 0);
    await expect.poll(() => r.transport.established).toBe(true);
    r.params.resumeFromSeq = 42;
    const second = r.master.nextConnection();
    first.terminate();
    await expect.poll(() => r.events.some((e) => e.kind === 'disconnected')).toBe(true);
    await second;
    const hello = await r.master.waitFor('HELLO', 1);
    expect(hello.payload.resumeFromSeq).toBe(42);
    await expect(r.transport.send(heartbeat())).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('keeps one instance id across reconnects (p5-live-fixes-2)', async () => {
    const r = await rig();
    const first = await r.master.nextConnection();
    const hello1 = await r.master.waitFor('HELLO');
    expect(hello1.payload.instanceId).toBe(r.transport.instanceId);
    expect(hello1.payload.pairOnly).toBeUndefined();
    const second = r.master.nextConnection();
    first.terminate();
    await second;
    const hello2 = await r.master.waitFor('HELLO', 1);
    expect(hello2.payload.instanceId).toBe(hello1.payload.instanceId);
  });

  it('backs off fully when another process replaced the connection (4409)', async () => {
    const r = await rig({ transport: { timing: { ...FAST, backoffMaxMs: 400 } } });
    const ws = await r.master.nextConnection();
    await r.master.establish(ws, 0);
    await expect.poll(() => r.transport.established).toBe(true);
    ws.close(4409, 'replaced by another process');
    await expect
      .poll(() => r.lines.find((l) => l.msg === 'disconnected from master; reconnecting')?.delayMs)
      .toBe(400);
    expect(
      r.lines.some((l) => l.msg === 'another process using this worker identity replaced the connection'),
    ).toBe(true);
  });

  it('marks a pair-only HELLO', async () => {
    const r = await rig({ params: { workerId: null, pairingCode: 'ABCD-EFGH', pairOnly: true } });
    await r.master.nextConnection();
    const hello = await r.master.waitFor('HELLO');
    expect(hello.payload.pairOnly).toBe(true);
  });

  it('does not reconnect after a 4403 refusal', async () => {
    const r = await rig();
    const ws = await r.master.nextConnection();
    await r.master.waitFor('HELLO');
    ws.close(4403, 'revoked');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(r.master.sockets).toHaveLength(1);
  });

  it('terminates a connection whose pings go unanswered', async () => {
    const master = await FakeMaster.start({ autoPong: false });
    const r = await rig({
      master,
      transport: { timing: { ...FAST, pingIntervalMs: 50, pongTimeoutMs: 100 } },
    });
    await r.master.nextConnection();
    const second = r.master.nextConnection();
    await second;
    expect(r.lines.some((l) => l.msg === 'master did not answer ping; terminating connection')).toBe(true);
  });
});

describe('WsTransport disconnect reports (p17-chat-reconnect)', () => {
  const probe = (ms: number) => ({ start: () => undefined, stop: () => undefined, maxMs: () => ms });

  it('reports a pong timeout with the wait and the event-loop delay in the next HELLO, once', async () => {
    const master = await FakeMaster.start({ autoPong: false });
    const r = await rig({
      master,
      transport: { timing: { ...FAST, pingIntervalMs: 300, pongTimeoutMs: 100 }, loopDelay: probe(37) },
    });
    const first = await r.master.nextConnection();
    const second = r.master.nextConnection();
    await r.master.establish(first, 0);
    const hello1 = r.master.frames.find((f) => f.conn === 0 && f.message.type === 'HELLO')?.message;
    expect(hello1?.type === 'HELLO' && hello1.payload.lastDisconnect).toBeUndefined();
    const ws2 = await second;
    await expect
      .poll(() => r.master.frames.some((f) => f.conn === 1 && f.message.type === 'HELLO'))
      .toBe(true);
    const h2 = r.master.frames.find((f) => f.conn === 1 && f.message.type === 'HELLO')?.message;
    if (h2?.type !== 'HELLO') throw new Error('no HELLO');
    const hello2 = h2;
    expect(hello2.payload.lastDisconnect).toMatchObject({ cause: 'pong_timeout', loopDelayMaxMs: 37 });
    // At least the 100 ms pong timeout, measured with Date.now (whole milliseconds against the timer's monotonic
    // clock: 99 seen on a CI runner).
    expect(hello2.payload.lastDisconnect?.pongWaitMs).toBeGreaterThanOrEqual(99);
    expect(hello2.payload.lastDisconnect?.connectedMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(hello2.payload.lastDisconnect?.at ?? '')).not.toBeNaN();
    const warn = r.lines.find((l) => l.msg === 'master did not answer ping; terminating connection');
    expect(warn).toMatchObject({ loopDelayMaxMs: 37 });
    // Reported: a session on the new connection clears it.
    await r.master.establish(ws2, 1);
    await expect.poll(() => r.transport.established).toBe(true);
    expect(r.transport.lastDisconnect).toBeNull();
  });

  it('reports a close by the master with its code and reason', async () => {
    const r = await rig();
    const ws = await r.master.nextConnection();
    await r.master.establish(ws, 0);
    await expect.poll(() => r.transport.established).toBe(true);
    const next = r.master.nextConnection();
    ws.close(4503, 'reorder buffer full; reconnect and resume');
    await next;
    const hello = await r.master.waitFor('HELLO', 1);
    expect(hello.payload.lastDisconnect).toMatchObject({
      cause: 'closed',
      code: 4503,
      detail: 'reorder buffer full; reconnect and resume',
    });
  });

  it('reports a socket error with its message', async () => {
    const r = await rig();
    const ws = await r.master.nextConnection();
    await r.master.establish(ws, 0);
    await expect.poll(() => r.transport.established).toBe(true);
    const next = r.master.nextConnection();
    // A frame with a reserved opcode: the worker's WebSocket fails with an error.
    (ws as unknown as { _socket: { write(b: Buffer): void } })._socket.write(Buffer.from([0x8f, 0x00]));
    await next;
    const hello = await r.master.waitFor('HELLO', 1);
    expect(hello.payload.lastDisconnect?.cause).toBe('socket_error');
    expect(hello.payload.lastDisconnect?.detail).toMatch(/opcode/i);
  });

  it('a connection that never reached a session does not replace the report', async () => {
    const r = await rig();
    const ws = await r.master.nextConnection();
    await r.master.establish(ws, 0);
    await expect.poll(() => r.transport.established).toBe(true);
    const second = r.master.nextConnection();
    ws.close(4503, 'overloaded');
    const ws2 = await second;
    await r.master.waitFor('HELLO', 1);
    const third = r.master.nextConnection();
    ws2.terminate(); // before any session
    await third;
    const hello = await r.master.waitFor('HELLO', 2);
    expect(hello.payload.lastDisconnect).toMatchObject({ cause: 'closed', code: 4503 });
  });

  it('a pong already received during an event-loop stall does not end the connection', async () => {
    const master = await FakeMaster.start();
    // The master answers the ping, then this process stalls past the pong timeout before reading the answer.
    master.onConnection = (ws) => {
      ws.on('ping', () => {
        const end = Date.now() + 120;
        while (Date.now() < end) {
          // busy: the event loop is blocked
        }
      });
    };
    const r = await rig({
      master,
      transport: { timing: { ...FAST, pingIntervalMs: 60, pongTimeoutMs: 30 } },
    });
    const ws = await r.master.nextConnection();
    await r.master.establish(ws, 0);
    await expect.poll(() => r.transport.established).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(r.lines.some((l) => l.msg === 'master did not answer ping; terminating connection')).toBe(false);
    expect(r.events.some((e) => e.kind === 'disconnected')).toBe(false);
    expect(r.master.sockets).toHaveLength(1);
  });
});

describe('WsTransport backpressure', () => {
  it('pauses reading while the consumer lags and delivers everything in order', async () => {
    let release: () => void = () => undefined;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = await rig({
      transport: { limits: { maxUnprocessedEvents: 4, resumeBelowEvents: 1 } },
      onEvent: (e) => (e.kind === 'message' && e.message.type === 'ACK' ? gate : undefined),
    });
    const ws = await r.master.nextConnection();
    await r.master.establish(ws, 0);
    for (let i = 1; i <= 50; i++) r.master.send(ws, 'ACK', { throughSeq: i }, { workerId: 'wrk_test' });
    await expect.poll(() => r.transport.stats.pausedReads).toBeGreaterThan(0);
    release();
    gate = Promise.resolve();
    await expect
      .poll(() => r.events.filter((e) => e.kind === 'message' && e.message.type === 'ACK').length)
      .toBe(50);
    const order = r.events.flatMap((e) =>
      e.kind === 'message' && e.message.type === 'ACK' ? [e.message.payload.throughSeq] : [],
    );
    expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('bounds the send queue and rejects instead of buffering without limit', async () => {
    const r = await rig({ transport: { limits: { maxQueuedMessages: 3, socketHighWaterBytes: 1 } } });
    const ws = await r.master.nextConnection();
    await r.master.establish(ws, 0);
    await expect.poll(() => r.transport.established).toBe(true);
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => r.transport.send(ack(i))));
    const rejected = results.filter((x) => x.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    for (const x of rejected) expect(x.reason).toBeInstanceOf(SendQueueFullError);
    expect(r.transport.stats.queueFull).toBe(rejected.length);
  });

  it('refuses to send a frame larger than MAX_FRAME_BYTES', async () => {
    const r = await rig();
    const ws = await r.master.nextConnection();
    await r.master.establish(ws, 0);
    await expect.poll(() => r.transport.established).toBe(true);
    const big = {
      ...heartbeat(),
      type: 'LOG_CHUNK',
      jobId: 'job_1',
      seq: 1,
      payload: {
        attemptId: 'a',
        epoch: 1,
        stream: 'stdout',
        chunkSeq: 0,
        data: 'x'.repeat(64 * 1024),
        redacted: true,
      },
    } as WorkerToMaster;
    await r.transport.send(big);
    const invalid = {
      ...big,
      payload: { ...(big.payload as object), data: 'x'.repeat(70 * 1024) },
    } as WorkerToMaster;
    await expect(r.transport.send(invalid)).rejects.toThrow(/invalid LOG_CHUNK/);
  });
});

describe('WsTransport TLS', () => {
  function makeCert(dir: string): { key: string; cert: string } | null {
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:prime256v1',
          '-nodes',
          '-keyout',
          join(dir, 'key.pem'),
          '-out',
          join(dir, 'cert.pem'),
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ],
        { stdio: 'ignore' },
      );
      return {
        key: readFileSync(join(dir, 'key.pem'), 'utf8'),
        cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
      };
    } catch {
      return null;
    }
  }

  // The certificate is made once, before the test: an openssl start alone can take seconds on a Windows runner.
  let material: { key: string; cert: string } | null = null;
  beforeAll(async () => {
    material = makeCert(await tempDir('rw-tls-'));
  }, 60_000);

  it('refuses an untrusted certificate and accepts it only as an explicit trust anchor', async (ctx) => {
    if (material === null) {
      ctx.skip(); // openssl missing on this runner
      return;
    }
    const server = createServer({ key: material.key, cert: material.cert });
    const wss = new WebSocketServer({ server });
    const connected: number[] = [];
    wss.on('connection', (ws) => {
      connected.push(1);
      ws.close();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        ),
    );
    cleanups.push(() => {
      for (const c of wss.clients) c.terminate();
    });
    const url = `wss://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

    const { logger, lines } = logLines();
    const untrusted = new WsTransport({
      masterUrl: url,
      logger,
      workerVersion: 't',
      facts: () => FACTS,
      timing: FAST,
    });
    await untrusted.start(
      {
        publicKey: DeviceKey.generate().publicKey,
        workerId: null,
        pairingCode: null,
        resumeFromSeq: 0,
        signChallenge: () => '',
      },
      () => undefined,
    );
    cleanups.push(() => untrusted.stop());
    await expect
      .poll(() =>
        lines.some((l) => typeof l.reason === 'string' && /self[- ]signed|certificate/i.test(l.reason)),
      )
      .toBe(true);
    expect(connected).toHaveLength(0);

    const trusted = new WsTransport({
      masterUrl: url,
      logger,
      workerVersion: 't',
      facts: () => FACTS,
      timing: FAST,
      ca: material.cert,
    });
    await trusted.start(
      {
        publicKey: DeviceKey.generate().publicKey,
        workerId: null,
        pairingCode: null,
        resumeFromSeq: 0,
        signChallenge: () => '',
      },
      () => undefined,
    );
    cleanups.push(() => trusted.stop());
    await expect.poll(() => connected.length).toBeGreaterThan(0);
  });
});
