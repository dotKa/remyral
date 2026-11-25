import { EventEmitter } from 'node:events';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_CHANNEL,
  ChatBus,
  type ChatBusMessage,
  encodeFrames,
  FrameAssembler,
  MAX_NOTIFY_BYTES,
} from '../../src/chat/bus.js';
import type { Pool } from '../../src/db/pool.js';

const noop = (): void => undefined;
const log = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => log,
} as unknown as FastifyBaseLogger;

const ORIGIN = '6f1c2f4e-3b8a-4c1d-9e2f-0a1b2c3d4e5f';
const TURN = '0d6c1a8e-1f2b-4c3d-8e4f-5a6b7c8d9e0f';

describe('chat bus frames (p5-ops-chat-next)', () => {
  it('keeps small messages in one frame and splits large ones into bounded base64 chunks', () => {
    const small: ChatBusMessage = { t: 'event', th: 'x', ev: 'delta', d: { turnId: TURN, text: 'hi' } };
    expect(encodeFrames(ORIGIN, 1, small)).toHaveLength(1);
    // Multi-byte text, quotes and backslashes (JSON escaping must not push a chunk over the limit).
    const text = `ä"\\€😀 `.repeat(9_000);
    const big: ChatBusMessage = { t: 'event', th: 'x', ev: 'message', d: { content: text } };
    const frames = encodeFrames(ORIGIN, 2, big);
    expect(frames.length).toBeGreaterThan(5);
    for (const f of frames) expect(Buffer.byteLength(f, 'utf8')).toBeLessThanOrEqual(MAX_NOTIFY_BYTES);
    const a = new FrameAssembler();
    // Out-of-order chunks reassemble.
    const shuffled = [...frames].reverse();
    let out = null;
    for (const f of shuffled) out = a.accept(f) ?? out;
    expect(out?.m).toEqual(big);
    expect(a.pendingPartials).toBe(0);
  });

  it('drops duplicates, older sequence numbers, malformed frames and unknown types', () => {
    const a = new FrameAssembler();
    const m: ChatBusMessage = { t: 'cancel', turn: TURN, reason: 'x' };
    const [f5] = encodeFrames(ORIGIN, 5, m);
    const [f4] = encodeFrames(ORIGIN, 4, m);
    expect(a.accept(f5 ?? '')?.n).toBe(5);
    expect(a.accept(f5 ?? '')).toBeNull();
    expect(a.accept(f4 ?? '')).toBeNull();
    // Another origin has its own numbering.
    expect(a.accept(encodeFrames('other', 1, m)[0] ?? '')?.o).toBe('other');
    expect(a.accept('not json')).toBeNull();
    expect(a.accept(JSON.stringify({ o: ORIGIN, n: 9, m: { t: 'shell' } }))).toBeNull();
    expect(a.accept(JSON.stringify({ o: ORIGIN, n: 10, i: 3, k: 2, b: 'AA' }))).toBeNull();
  });

  it('forgets incomplete chunk sets after their time-to-live', () => {
    let now = 0;
    const a = new FrameAssembler({ partialTtlMs: 1_000, now: () => now });
    const frames = encodeFrames(ORIGIN, 1, {
      t: 'event',
      th: 'x',
      ev: 'message',
      d: { c: 'x'.repeat(20_000) },
    });
    expect(a.accept(frames[0] ?? '')).toBeNull();
    expect(a.pendingPartials).toBe(1);
    now = 5_000;
    // A later chunk of the expired set starts a new (incomplete) set instead of completing a stale one.
    expect(a.accept(frames[1] ?? '')).toBeNull();
    expect(a.pendingPartials).toBe(1);
  });
});

/** In-memory Postgres LISTEN/NOTIFY: every pg_notify reaches every listening client, in order. */
class FakePg {
  readonly clients = new Set<FakeClient>();
  failConnect = false;
  connects = 0;

  pool(): Pool {
    return {
      connect: () => {
        this.connects += 1;
        if (this.failConnect) return Promise.reject(new Error('down'));
        const c = new FakeClient(this);
        return Promise.resolve(c);
      },
    } as unknown as Pool;
  }

  notify(payload: string): void {
    for (const c of this.clients) if (c.listening) c.emit('notification', { channel: CHAT_CHANNEL, payload });
  }
}

class FakeClient extends EventEmitter {
  listening = false;
  constructor(private readonly pg: FakePg) {
    super();
  }

  query(sql: string, params?: unknown[]): Promise<unknown> {
    if (sql.startsWith('LISTEN')) {
      this.listening = true;
      this.pg.clients.add(this);
    } else if (sql.startsWith('UNLISTEN')) {
      this.listening = false;
      this.pg.clients.delete(this);
    } else if (sql.includes('pg_notify')) {
      if (!this.listening) return Promise.reject(new Error('connection closed'));
      const payload = String(params?.[1]);
      queueMicrotask(() => {
        this.pg.notify(payload);
      });
    }
    return Promise.resolve({ rows: [] });
  }

  release(): void {
    this.listening = false;
    this.pg.clients.delete(this);
  }
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ChatBus over LISTEN/NOTIFY', () => {
  const buses: ChatBus[] = [];
  afterEach(async () => {
    for (const b of buses.splice(0)) await b.stop();
  });

  function bus(pg: FakePg, workers: string[], opts: { presenceMs?: number; reconnectMs?: number } = {}) {
    const b = new ChatBus({ pool: pg.pool(), log, localWorkers: () => workers, ...opts });
    buses.push(b);
    return b;
  }

  it('learns which replica holds a worker, routes a dispatch to it only and returns its acknowledgement', async () => {
    const pg = new FakePg();
    const a = bus(pg, ['w-1']);
    const b = bus(pg, []);
    const c = bus(pg, []);
    const seen: Record<string, ChatBusMessage[]> = { a: [], b: [], c: [] };
    a.on((m) => seen.a?.push(m));
    b.on((m) => seen.b?.push(m));
    c.on((m) => seen.c?.push(m));
    await Promise.all([a.start(), b.start(), c.start()]);
    a.announce();
    await until(() => b.ownerOf('w-1') === a.replicaId);
    expect(b.ownerOf('w-2')).toBeNull();
    a.on((m, origin) => {
      if (m.t === 'dispatch') a.publish({ t: 'ack', to: origin, turn: m.turn, ok: true });
    });
    const ok = await b.dispatch({ t: 'dispatch', to: a.replicaId, turn: TURN, w: 'w-1', msg: 'm1' }, 2_000);
    expect(ok).toBe(true);
    expect(seen.a?.filter((m) => m.t === 'dispatch')).toHaveLength(1);
    // Addressed to A: C never sees it (nor its own messages, nor acknowledgements for others).
    expect(seen.c?.some((m) => m.t === 'dispatch' || m.t === 'ack')).toBe(false);
    expect(seen.b?.some((m) => m.t === 'dispatch')).toBe(false);
  });

  it('fans out large events intact and in order', async () => {
    const pg = new FakePg();
    const a = bus(pg, []);
    const b = bus(pg, []);
    const got: ChatBusMessage[] = [];
    b.on((m) => {
      if (m.t === 'event') got.push(m);
    });
    await Promise.all([a.start(), b.start()]);
    const big = 'ü'.repeat(30_000);
    a.publish({ t: 'event', th: 't', ev: 'delta', d: { turnId: TURN, text: 'one ' } });
    a.publish({ t: 'event', th: 't', ev: 'message', d: { content: big } });
    a.publish({ t: 'event', th: 't', ev: 'delta', d: { turnId: TURN, text: 'two' } });
    await until(() => got.length === 3);
    expect(got.map((m) => (m.t === 'event' ? m.ev : ''))).toEqual(['delta', 'message', 'delta']);
    expect((got[1] as { d: { content: string } }).d.content).toBe(big);
  });

  it('times a dispatch out without an answer and forgets a replica that said goodbye', async () => {
    const pg = new FakePg();
    const a = bus(pg, ['w-1']);
    const b = bus(pg, []);
    await Promise.all([a.start(), b.start()]);
    await until(() => b.ownerOf('w-1') === a.replicaId);
    const ok = await b.dispatch({ t: 'dispatch', to: a.replicaId, turn: TURN, w: 'w-1', msg: 'm1' }, 50);
    expect(ok).toBeNull();
    await a.stop();
    await until(() => b.ownerOf('w-1') === null);
  });

  it('expires silent peers', async () => {
    const pg = new FakePg();
    const a = bus(pg, ['w-1'], { presenceMs: 20 });
    const b = bus(pg, [], { presenceMs: 20 });
    await Promise.all([a.start(), b.start()]);
    await until(() => b.ownerOf('w-1') === a.replicaId);
    // A keeps its listener but stops announcing (e.g. its event loop is stuck): B forgets it after 3 periods.
    const client = [...pg.clients].find((c) => c.listenerCount('notification') > 0);
    expect(client).toBeDefined();
    (a as unknown as { announce: () => void }).announce = noop;
    await until(() => b.ownerOf('w-1') === null, 1_000);
  });

  it('expires a peer by its own announce period, not the receiving one (replicas with different periods)', async () => {
    const pg = new FakePg();
    const a = bus(pg, ['w-1'], { presenceMs: 200 });
    const b = bus(pg, [], { presenceMs: 20 });
    await Promise.all([a.start(), b.start()]);
    await until(() => b.ownerOf('w-1') === a.replicaId);
    // Well past 3 of B's periods but within 3 of A's: A is still the owner.
    await new Promise((r) => setTimeout(r, 120));
    expect(b.ownerOf('w-1')).toBe(a.replicaId);
  });

  it('falls back to single-process behaviour while the listener is down and reconnects', async () => {
    const pg = new FakePg();
    const a = bus(pg, ['w-1']);
    const b = bus(pg, [], { reconnectMs: 20 });
    await Promise.all([a.start(), b.start()]);
    await until(() => b.ownerOf('w-1') === a.replicaId);
    // B's connection breaks: it forgets the peers (nothing is routed) and drops what it publishes.
    const bClient = [...pg.clients].at(-1);
    bClient?.emit('error', new Error('reset'));
    expect(b.listening).toBe(false);
    expect(b.ownerOf('w-1')).toBeNull();
    expect(
      await b.dispatch({ t: 'dispatch', to: a.replicaId, turn: TURN, w: 'w-1', msg: 'm' }, 50),
    ).toBeNull();
    await until(() => b.listening);
    a.announce();
    await until(() => b.ownerOf('w-1') === a.replicaId);
  });

  it('keeps retrying when Postgres is unreachable at start', async () => {
    const pg = new FakePg();
    pg.failConnect = true;
    const b = bus(pg, [], { reconnectMs: 10 });
    await b.start();
    expect(b.listening).toBe(false);
    await until(() => pg.connects >= 3);
    pg.failConnect = false;
    await until(() => b.listening);
  });
});
