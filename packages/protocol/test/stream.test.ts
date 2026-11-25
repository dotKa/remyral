import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeStreamData,
  encodeStreamData,
  isStreamMessageType,
  MasterToWorker,
  MAX_STREAM_PAYLOAD,
  WorkerToMaster,
} from '../src/index.js';
import {
  type AcceptDecision,
  type MuxLink,
  type StreamControl,
  StreamMux,
  StreamRefusedError,
  StreamResetError,
  type TunnelStream,
} from '../src/stream-mux.js';

const WS1 = '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e002';
const WS2 = '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e003';
const TARGET = { target: 'ide' as const, workspaceId: WS1 };

/** Two muxes over an in-memory, asynchronous, ordered link (like one WebSocket). */
function pair(opts: {
  window?: number;
  onOpen?: (req: { workspaceId: string }) => AcceptDecision;
  maxStreams?: number;
}) {
  const log: { dir: 'm2w' | 'w2m'; kind: 'control' | 'data'; type?: string; bytes: number }[] = [];
  const muxes: { master?: StreamMux; worker?: StreamMux } = {};
  const peer = (name: 'master' | 'worker'): StreamMux => {
    const m = muxes[name];
    if (m === undefined) throw new Error('mux missing');
    return m;
  };
  const verdicts: string[] = [];
  const deliver = (to: () => StreamMux, dir: 'm2w' | 'w2m'): MuxLink => ({
    sendControl: (m: StreamControl) => {
      log.push({ dir, kind: 'control', type: m.type, bytes: 0 });
      // Round-trip through JSON like the real wire.
      const copy = JSON.parse(JSON.stringify(m)) as StreamControl;
      setImmediate(() => verdicts.push(to().handleControl(copy)));
      return Promise.resolve();
    },
    sendData: (frame: Buffer) => {
      log.push({ dir, kind: 'data', bytes: frame.length - 5 });
      const copy = Buffer.from(frame);
      return new Promise((resolve) => {
        setImmediate(() => {
          verdicts.push(to().handleData(copy));
          resolve();
        });
      });
    },
  });
  const master = new StreamMux(
    deliver(() => peer('worker'), 'm2w'),
    { window: opts.window ?? 8192 },
  );
  const worker = new StreamMux(
    deliver(() => peer('master'), 'w2m'),
    {
      window: opts.window ?? 8192,
      ...(opts.maxStreams === undefined ? {} : { maxStreams: opts.maxStreams }),
      onOpen: (req) => (opts.onOpen ? opts.onOpen(req) : { ok: false, reason: 'refused' }),
    },
  );
  muxes.master = master;
  muxes.worker = worker;
  return { master, worker, log, verdicts };
}

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', reject);
  });
}

describe('binary data frames', () => {
  it('round-trips and refuses malformed frames', () => {
    const f = encodeStreamData(42, Buffer.from('hello'));
    expect(f[0]).toBe(1);
    expect(decodeStreamData(f)).toEqual({ streamId: 42, payload: Buffer.from('hello') });
    expect(decodeStreamData(Buffer.from([1, 0, 0, 0, 1]))).toBeNull(); // empty payload
    const wrongKind = Buffer.from(f);
    wrongKind[0] = 2;
    expect(decodeStreamData(wrongKind)).toBeNull();
    expect(decodeStreamData(encodeStreamData(1, Buffer.alloc(MAX_STREAM_PAYLOAD)))).not.toBeNull();
    expect(() => encodeStreamData(1, Buffer.alloc(MAX_STREAM_PAYLOAD + 1))).toThrow(RangeError);
    expect(() => encodeStreamData(0, Buffer.from('x'))).toThrow(RangeError);
    const zeroId = Buffer.from(f);
    zeroId.writeUInt32BE(0, 1);
    expect(decodeStreamData(zeroId)).toBeNull();
  });
});

describe('stream mux', () => {
  it('opens, carries data both ways, half-closes and forgets the stream', async () => {
    const { master, worker } = pair({
      onOpen: () => ({
        ok: true,
        attach: (s: TunnelStream) => {
          // Echo server: uppercase everything, end after the peer ended.
          s.on('data', (c: Buffer) => s.write(Buffer.from(c.toString().toUpperCase())));
          s.on('end', () => s.end());
        },
      }),
    });
    const s = await master.open(TARGET);
    const got = collect(s);
    s.write('hello ');
    s.end('world');
    expect((await got).toString()).toBe('HELLO WORLD');
    await new Promise((r) => setTimeout(r, 20));
    expect(master.size).toBe(0);
    expect(worker.size).toBe(0);
  });

  it('refuses an open with the acceptor reason', async () => {
    const { master } = pair({ onOpen: () => ({ ok: false, reason: 'not_found' }) });
    await expect(master.open(TARGET)).rejects.toMatchObject({
      name: 'StreamRefusedError',
      reason: 'not_found',
    });
    expect(master.size).toBe(0);
  });

  it('enforces the acceptor stream limit', async () => {
    const { master } = pair({ maxStreams: 1, onOpen: () => ({ ok: true, attach: () => undefined }) });
    await master.open(TARGET);
    await expect(master.open(TARGET)).rejects.toBeInstanceOf(StreamRefusedError);
  });

  it('flow control: a slow consumer bounds in-flight bytes to the window and stalls the writer', async () => {
    const window = 8192;
    let sink!: TunnelStream;
    const { master, worker, log } = pair({
      window,
      onOpen: () => ({
        ok: true,
        attach: (s: TunnelStream) => {
          sink = s;
          s.pause(); // the consumer does not read yet
        },
      }),
    });
    const s = await master.open(TARGET);
    const payload = randomBytes(256 * 1024);
    let writeDone = false;
    s.end(payload, () => {
      writeDone = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    // Nothing beyond the granted window crossed the link while nobody read.
    const sent = log.filter((l) => l.dir === 'm2w' && l.kind === 'data').reduce((a, l) => a + l.bytes, 0);
    expect(sent).toBeLessThanOrEqual(window);
    expect(sink.readableLength).toBeLessThanOrEqual(window);
    expect(writeDone).toBe(false);
    // The consumer drains slowly; everything arrives intact and in order.
    const chunks: Buffer[] = [];
    let maxBuffered = 0;
    sink.on('data', (c: Buffer) => {
      chunks.push(c);
      maxBuffered = Math.max(maxBuffered, sink.readableLength);
    });
    sink.resume();
    await new Promise<void>((resolve) => sink.on('end', resolve));
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
    expect(maxBuffered).toBeLessThanOrEqual(window);
    expect(writeDone).toBe(true);
    expect(worker.stats.violations).toBe(0);
    // Credit came back in WINDOW messages, never as a single unbounded grant.
    const windows = log.filter((l) => l.type === 'STREAM_WINDOW' && l.dir === 'w2m').length;
    expect(windows).toBeGreaterThanOrEqual((256 * 1024) / window);
  });

  it('treats data beyond the granted credit as a violation and resets the stream', async () => {
    let sink!: TunnelStream;
    const { master, worker } = pair({
      window: 2048,
      onOpen: () => ({
        ok: true,
        attach: (s: TunnelStream) => {
          sink = s;
          s.pause();
        },
      }),
    });
    const s = await master.open(TARGET);
    const errored = new Promise<Error>((resolve) => sink.on('error', resolve));
    // A misbehaving peer ignores its credit.
    expect(worker.handleData(encodeStreamData(s.id, Buffer.alloc(2048)))).toBe('ok');
    expect(worker.handleData(encodeStreamData(s.id, Buffer.alloc(1)))).toBe('violation');
    expect(await errored).toBeInstanceOf(StreamResetError);
    expect(worker.stats.violations).toBe(1);
    const reset = await new Promise<Error>((resolve) => s.on('error', resolve));
    expect((reset as StreamResetError).reason).toBe('protocol');
  });

  it('counts malformed frames and data for a pending stream as violations, ignores late data', () => {
    const { worker } = pair({});
    expect(worker.handleData(Buffer.from([9, 9]))).toBe('violation');
    expect(worker.handleData(encodeStreamData(999, Buffer.from('late')))).toBe('ok');
    for (let i = 0; i < 3; i++) worker.handleData(Buffer.from([9]));
    expect(worker.tooManyViolations).toBe(true);
  });

  it('a lost link resets every stream and refuses new ones', async () => {
    let sink!: TunnelStream;
    const { master, worker } = pair({
      onOpen: () => ({
        ok: true,
        attach: (s: TunnelStream) => {
          sink = s;
        },
      }),
    });
    const s = await master.open(TARGET);
    const e1 = new Promise<Error>((resolve) => s.on('error', resolve));
    const e2 = new Promise<Error>((resolve) => sink.on('error', resolve));
    master.close('shutdown');
    worker.close('shutdown');
    expect(((await e1) as StreamResetError).reason).toBe('shutdown');
    expect(((await e2) as StreamResetError).reason).toBe('shutdown');
    await expect(master.open(TARGET)).rejects.toBeInstanceOf(StreamRefusedError);
  });

  it('resets the streams of one workspace only and counts them', async () => {
    const sinks: TunnelStream[] = [];
    const seen: string[] = [];
    const { master, worker } = pair({
      onOpen: (req) => {
        seen.push(req.workspaceId);
        return {
          ok: true,
          attach: (s: TunnelStream) => {
            s.on('error', () => undefined);
            sinks.push(s);
          },
        };
      },
    });
    const a = await master.open(TARGET);
    const b = await master.open({ target: 'ide', workspaceId: WS2 });
    expect(seen).toEqual([WS1, WS2]);
    expect(sinks[0]?.targetRef).toEqual(TARGET);
    expect(master.countFor(WS1)).toBe(1);
    const aErr = new Promise<Error>((resolve) => a.on('error', resolve));
    await new Promise((r) => setTimeout(r, 5));
    expect(worker.countFor(WS2)).toBe(1);
    expect(worker.resetWorkspace(WS1)).toBe(1);
    expect(((await aErr) as StreamResetError).reason).toBe('shutdown');
    expect(b.destroyed).toBe(false);
  });

  it('times out an open nobody answers', async () => {
    const link: MuxLink = { sendControl: () => Promise.resolve(), sendData: () => Promise.resolve() };
    const m = new StreamMux(link, { openTimeoutMs: 20 });
    await expect(m.open(TARGET)).rejects.toMatchObject({ reason: 'timeout' });
  });
});

describe('stream control messages (ADR-0066)', () => {
  const env = (type: string, payload: unknown) => ({
    protocolVersion: '1.0',
    type,
    messageId: '00000000-0000-4000-8000-000000000001',
    seq: 0,
    ts: '2026-10-28T10:00:00.000Z',
    correlationId: 'stream-1',
    workerId: 'wrk_1',
    payload,
  });

  it('master opens only the ide target, with a workspace id and a bounded window', () => {
    expect(
      MasterToWorker.safeParse(
        env('STREAM_OPEN', { streamId: 1, target: 'ide', workspaceId: WS1, window: 65536 }),
      ).success,
    ).toBe(true);
    expect(
      MasterToWorker.safeParse(
        env('STREAM_OPEN', { streamId: 1, target: 'openhands-session', workspaceId: WS1, window: 65536 }),
      ).success,
    ).toBe(false);
    expect(
      MasterToWorker.safeParse(
        env('STREAM_OPEN', { streamId: 1, target: 'ide', workspaceId: WS1, window: 10 }),
      ).success,
    ).toBe(false);
    expect(
      MasterToWorker.safeParse(
        env('STREAM_OPEN', { streamId: 1, target: 'ide', workspaceId: 'x', window: 4096 }),
      ).success,
    ).toBe(false);
  });

  it('accept / window / close parse in their directions', () => {
    expect(WorkerToMaster.safeParse(env('STREAM_ACCEPT', { streamId: 3, window: 4096 })).success).toBe(true);
    expect(MasterToWorker.safeParse(env('STREAM_ACCEPT', { streamId: 3, window: 4096 })).success).toBe(false);
    for (const parse of [WorkerToMaster, MasterToWorker]) {
      expect(parse.safeParse(env('STREAM_WINDOW', { streamId: 3, credit: 100 })).success).toBe(true);
      expect(
        parse.safeParse(env('STREAM_CLOSE', { streamId: 3, mode: 'reset', reason: 'shutdown' })).success,
      ).toBe(true);
    }
    expect(isStreamMessageType('STREAM_OPEN')).toBe(true);
    expect(isStreamMessageType('IDE_START')).toBe(false);
  });
});
