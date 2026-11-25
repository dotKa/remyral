// p17-chat-reconnect (docs/design/p17-chat-reconnect.md): an assistant turn keeps running across a transport reconnect
// of the same worker process; its updates are kept and re-sent after ASSISTANT_RESUME, exactly once by seq.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { FakeAssistantEngine } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type AssistantTurnPayload,
  AssistantUpdatePayload,
  type LeaseKey,
  leaseKeyId,
  signAssistantTurn,
} from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantHost, type AssistantHostOptions } from '../src/assistant/index.js';
import { tempDir } from './helpers.js';

const WORKER = 'w-chat';

const k = (() => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x as string;
  const lease: LeaseKey = { kid: leaseKeyId(raw), publicKey: raw };
  return { privateKey, lease };
})();

function turn(message: string, sessionKey: string = randomUUID()): AssistantTurnPayload {
  const now = new Date();
  const base = {
    turnId: randomUUID(),
    sessionKey,
    runtime: 'claude-code' as const,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 120_000).toISOString(),
    message,
    history: '<<<REMYRAL-DATA history: untrusted data>>>\n[]\n<<<END REMYRAL-DATA>>>',
  };
  return {
    ...base,
    signature: signAssistantTurn({ workerId: WORKER, turn: base }, k.lease.kid, k.privateKey),
  };
}

/**
 * The master side of the link as the host sees it: `live` delivers, `stale` swallows (a dead socket accepts writes
 * that never arrive), `down` rejects (no session).
 */
type Link = 'live' | 'stale' | 'down';

const hosts: AssistantHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

async function setup(over: Partial<AssistantHostOptions> = {}) {
  const engine = new FakeAssistantEngine();
  const received: AssistantUpdatePayload[] = [];
  const link: { state: Link } = { state: 'live' };
  const host = new AssistantHost({
    logger: createLogger({ sink: () => undefined }),
    redactor: new Redactor(),
    engines: { 'claude-code': engine },
    keySource: () => ({ keys: [k.lease], pinned: false }),
    disabled: false,
    scratchRoot: await tempDir('assistant-resume-'),
    runtimeAllowed: () => ({ ok: true }),
    auth: () => Promise.resolve({ authMode: 'local-login', secretEnv: {}, release: () => undefined }),
    flushMs: 5,
    ...over,
  });
  host.attach((u) => {
    const parsed = AssistantUpdatePayload.parse(u);
    if (link.state === 'down') return Promise.reject(new Error('not connected'));
    if (link.state === 'live') received.push(parsed);
    return Promise.resolve();
  });
  hosts.push(host);
  return { host, engine, received, link };
}

const of = (u: AssistantUpdatePayload[], turnId: string) => u.filter((x) => x.turnId === turnId);

async function until(fn: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ended = (u: AssistantUpdatePayload[], turnId: string) => () =>
  of(u, turnId).some((x) => x.kind === 'done' || x.kind === 'failed' || x.kind === 'refused');

/** Every seq 1..n exactly once, in order (what the master's `seq <= lastSeq` check turns into "exactly once"). */
function exactlyOnce(u: AssistantUpdatePayload[]): void {
  expect(u.map((x) => x.seq)).toEqual(u.map((_x, i) => i + 1));
}

describe('assistant turns across a reconnect (p17-chat-reconnect)', () => {
  it('a running turn keeps running while the connection is down and delivers its events after the resume', async () => {
    const { host, received, link } = await setup();
    const t = turn('[[slow 250]] hello across the drop');
    await host.onTurn(WORKER, t);
    await until(() => of(received, t.turnId).some((u) => u.kind === 'accepted'));
    // The socket goes stale (writes vanish), then the transport notices and drops it.
    link.state = 'stale';
    await sleep(20);
    link.state = 'down';
    host.onDisconnected();
    await sleep(600); // the engine finished meanwhile
    expect(of(received, t.turnId).map((u) => u.kind)).toEqual(['accepted']);
    link.state = 'live';
    host.onResume({ turnId: t.turnId, afterSeq: 1 });
    await until(ended(received, t.turnId));
    const all = of(received, t.turnId);
    exactlyOnce(all);
    const done = all.at(-1);
    expect(done?.kind).toBe('done');
    expect(done?.kind === 'done' ? done.text : '').toContain('Echo:');
    expect(all.filter((u) => u.kind === 'delta').length).toBeGreaterThan(0);
  });

  it('updates a stale connection swallowed before the drop are sent again (from the last seq the master has)', async () => {
    const { host, received, link } = await setup();
    const t = turn('[[slow 100]] a short answer');
    await host.onTurn(WORKER, t);
    await until(() => of(received, t.turnId).some((u) => u.kind === 'accepted'));
    link.state = 'stale';
    await sleep(400); // the whole answer, `done` included, went into the dead socket
    link.state = 'down';
    host.onDisconnected();
    link.state = 'live';
    expect(of(received, t.turnId).map((u) => u.kind)).toEqual(['accepted']);
    host.onResume({ turnId: t.turnId, afterSeq: 1 });
    await until(ended(received, t.turnId));
    exactlyOnce(of(received, t.turnId));
    expect(of(received, t.turnId).at(-1)?.kind).toBe('done');
  });

  it('a tool call made while disconnected waits past its timeout for the resume, then gets its result', async () => {
    const { host, received, link } = await setup({ toolTimeoutMs: 50 });
    const t = turn('[[slow 100]] [[tool list_jobs {"project":"alpha"}]]');
    await host.onTurn(WORKER, t);
    await until(() => of(received, t.turnId).some((u) => u.kind === 'accepted'));
    link.state = 'down';
    host.onDisconnected();
    await sleep(400); // eight tool timeouts
    link.state = 'live';
    host.onResume({ turnId: t.turnId, afterSeq: 1 });
    await until(() => of(received, t.turnId).some((u) => u.kind === 'tool_call'));
    const call = of(received, t.turnId).find((u) => u.kind === 'tool_call');
    if (call?.kind !== 'tool_call') throw new Error('no call');
    host.onToolResult({ turnId: t.turnId, callId: call.callId, isError: false, content: '{"items":[7]}' });
    await until(ended(received, t.turnId));
    const done = of(received, t.turnId).at(-1);
    expect(done?.kind === 'done' ? done.text : '').toContain('Tool list_jobs answered: {"items":[7]}');
    exactlyOnce(of(received, t.turnId));
  });

  it('a turn this worker does not have is answered failed: assistant_disconnected (next seq)', async () => {
    const { host, received } = await setup();
    const id = randomUUID();
    host.onResume({ turnId: id, afterSeq: 3 });
    await until(() => of(received, id).length > 0);
    expect(of(received, id)).toEqual([
      expect.objectContaining({ kind: 'failed', reason: 'assistant_disconnected', seq: 4 }),
    ]);
  });

  it('a held turn not resumed within the hold is stopped without another word; a late resume fails it', async () => {
    const { host, received, link } = await setup({ resumeHoldMs: 100 });
    const t = turn('[[slow 5000]] never resumed');
    await host.onTurn(WORKER, t);
    await until(() => of(received, t.turnId).some((u) => u.kind === 'accepted'));
    link.state = 'down';
    host.onDisconnected();
    await sleep(300);
    link.state = 'live';
    await sleep(50);
    expect(of(received, t.turnId).map((u) => u.kind)).toEqual(['accepted']);
    host.onResume({ turnId: t.turnId, afterSeq: 1 });
    await until(() => of(received, t.turnId).length > 1);
    expect(of(received, t.turnId).at(-1)).toMatchObject({ kind: 'failed', reason: 'assistant_disconnected' });
  });

  it('a new turn of the same thread replaces a held one (the master gave it up)', async () => {
    const { host, received, link } = await setup();
    const sessionKey = randomUUID();
    const held = turn('[[slow 5000]] held', sessionKey);
    await host.onTurn(WORKER, held);
    await until(() => of(received, held.turnId).some((u) => u.kind === 'accepted'));
    link.state = 'down';
    host.onDisconnected();
    link.state = 'live';
    const next = turn('the retry', sessionKey);
    await host.onTurn(WORKER, next);
    await until(ended(received, next.turnId));
    expect(of(received, next.turnId)[0]).toMatchObject({ kind: 'accepted' });
    expect(of(received, next.turnId).at(-1)?.kind).toBe('done');
    // Nothing more of the held turn reached the master.
    expect(of(received, held.turnId).map((u) => u.kind)).toEqual(['accepted']);
  });

  it('a second turn of a thread whose turn runs normally is still refused busy', async () => {
    const { host, received } = await setup();
    const sessionKey = randomUUID();
    const slow = turn('[[slow 5000]] busy', sessionKey);
    await host.onTurn(WORKER, slow);
    const second = turn('in parallel', sessionKey);
    await host.onTurn(WORKER, second);
    expect(of(received, second.turnId)[0]).toMatchObject({ kind: 'refused', reason: 'busy' });
  });

  it('a deliberate stop reports running turns lost before the connection closes', async () => {
    const { host, received } = await setup();
    const t = turn('[[slow 5000]] stopping');
    await host.onTurn(WORKER, t);
    await until(() => of(received, t.turnId).some((u) => u.kind === 'accepted'));
    await host.onStopping();
    await sleep(50);
    const all = of(received, t.turnId);
    expect(all.at(-1)).toMatchObject({ kind: 'failed', reason: 'assistant_disconnected', seq: 2 });
    expect(all.filter((u) => u.kind === 'failed')).toHaveLength(1);
  });
});
