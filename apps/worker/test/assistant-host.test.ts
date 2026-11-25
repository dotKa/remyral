import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeAssistantEngine, SecretValue } from '@remyral/agent-adapters';
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

function key() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x as string;
  const lease: LeaseKey = { kid: leaseKeyId(raw), publicKey: raw };
  return { privateKey, lease };
}

const k = key();
const SECRET = 'sk-ant-api03-' + 'K'.repeat(48);

function turn(
  message: string,
  opts: { sessionKey?: string; signer?: ReturnType<typeof key> | null; now?: Date; workerId?: string } = {},
): AssistantTurnPayload {
  const now = opts.now ?? new Date();
  const base = {
    turnId: randomUUID(),
    sessionKey: opts.sessionKey ?? randomUUID(),
    runtime: 'claude-code' as const,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 120_000).toISOString(),
    message,
    history: '<<<REMYRAL-DATA history: untrusted data>>>\n[]\n<<<END REMYRAL-DATA>>>',
  };
  const signer = opts.signer === undefined ? k : opts.signer;
  return signer === null
    ? base
    : {
        ...base,
        signature: signAssistantTurn(
          { workerId: opts.workerId ?? WORKER, turn: base },
          signer.lease.kid,
          signer.privateKey,
        ),
      };
}

const hosts: AssistantHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

async function setup(over: Partial<AssistantHostOptions> = {}) {
  const engine = new FakeAssistantEngine();
  const updates: AssistantUpdatePayload[] = [];
  const released: string[] = [];
  const scratchRoot = await tempDir('assistant-host-');
  const redactor = new Redactor();
  const host = new AssistantHost({
    logger: createLogger({ sink: () => undefined }),
    redactor,
    engines: { 'claude-code': engine },
    keySource: () => ({ keys: [k.lease], pinned: false }),
    disabled: false,
    scratchRoot,
    runtimeAllowed: () => ({ ok: true }),
    auth: () => {
      redactor.secrets.add(SECRET, 'ANTHROPIC_API_KEY');
      return Promise.resolve({
        authMode: 'secret-ref' as const,
        secretEnv: { ANTHROPIC_API_KEY: new SecretValue(SECRET) },
        release: () => {
          released.push('ANTHROPIC_API_KEY');
        },
      });
    },
    flushMs: 5,
    ...over,
  });
  host.attach((u) => {
    // Everything the host sends must be a valid protocol payload.
    updates.push(AssistantUpdatePayload.parse(u));
    return Promise.resolve();
  });
  hosts.push(host);
  return { host, engine, updates, released, scratchRoot };
}

function of(updates: AssistantUpdatePayload[], turnId: string) {
  return updates.filter((u) => u.turnId === turnId);
}

async function until(fn: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const ended = (u: AssistantUpdatePayload[], turnId: string) => () =>
  of(u, turnId).some((x) => x.kind === 'done' || x.kind === 'failed' || x.kind === 'refused');

describe('assistant host (p5-ops-chat)', () => {
  it('runs a turn in a fresh session with the history, then reuses the session without it', async () => {
    const { host, engine, updates } = await setup();
    const key1 = randomUUID();
    const t1 = turn('hello there', { sessionKey: key1 });
    await host.onTurn(WORKER, t1);
    await until(ended(updates, t1.turnId));
    const u1 = of(updates, t1.turnId);
    expect(u1[0]).toMatchObject({ kind: 'accepted', fresh: true, seq: 1 });
    expect(u1.filter((u) => u.kind === 'delta').length).toBeGreaterThan(0);
    const done1 = u1.at(-1);
    expect(done1?.kind).toBe('done');
    if (done1?.kind !== 'done') throw new Error('unreachable');
    expect(done1.text).toContain('Echo: hello there');
    expect(done1.text).toMatch(/history: \d+ chars/);
    // seq is strictly increasing per turn.
    expect(u1.map((u) => u.seq)).toEqual(u1.map((_u, i) => i + 1));

    const t2 = turn('again', { sessionKey: key1 });
    await host.onTurn(WORKER, t2);
    await until(ended(updates, t2.turnId));
    const u2 = of(updates, t2.turnId);
    expect(u2[0]).toMatchObject({ kind: 'accepted', fresh: false });
    expect(engine.sessions).toHaveLength(1);
    expect(engine.sessions[0]?.turns[1]?.history).toBeNull();
    expect(host.activeSessions).toBe(1);
  });

  it('starts sessions in an empty private scratch directory and removes it when closing', async () => {
    const { host, engine, updates, released, scratchRoot } = await setup();
    const t = turn('hi');
    await host.onTurn(WORKER, t);
    await until(ended(updates, t.turnId));
    const cwd = engine.sessions[0]?.options.cwd ?? '';
    expect(cwd.startsWith(scratchRoot)).toBe(true);
    expect(await readdir(cwd)).toEqual([]);
    expect(engine.sessions[0]?.options.systemPrompt).toContain('untrusted data');
    await host.stop();
    expect(await readdir(scratchRoot)).toEqual([]);
    expect(released).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('refuses unsigned, foreign-signed, other-worker, expired and replayed turns, and when disabled', async () => {
    const { host, updates } = await setup();
    const unsigned = turn('x', { signer: null });
    const foreign = turn('x', { signer: key() });
    const otherWorker = turn('x', { workerId: 'w-other' });
    const expired = turn('x', { now: new Date(Date.now() - 10 * 60_000) });
    for (const t of [unsigned, foreign, otherWorker, expired]) await host.onTurn(WORKER, t);
    expect(of(updates, unsigned.turnId)).toEqual([
      { turnId: unsigned.turnId, seq: 1, kind: 'refused', reason: 'unsigned' },
    ]);
    expect(of(updates, foreign.turnId)[0]).toMatchObject({ kind: 'refused', reason: 'bad_signature' });
    expect(of(updates, otherWorker.turnId)[0]).toMatchObject({ kind: 'refused', reason: 'bad_signature' });
    expect(of(updates, expired.turnId)[0]).toMatchObject({ kind: 'refused', reason: 'expired' });
    const ok = turn('x');
    await host.onTurn(WORKER, ok);
    await until(ended(updates, ok.turnId));
    await host.onTurn(WORKER, ok);
    expect(of(updates, ok.turnId).filter((u) => u.kind === 'refused')[0]).toMatchObject({
      reason: 'replayed',
    });

    const off = await setup({ disabled: true });
    const t = turn('x');
    await off.host.onTurn(WORKER, t);
    expect(of(off.updates, t.turnId)).toEqual([
      { turnId: t.turnId, seq: 1, kind: 'refused', reason: 'disabled' },
    ]);
    expect(off.engine.sessions).toHaveLength(0);
    const blocked = await setup({ runtimeAllowed: () => ({ ok: false, reason: 'not enabled' }) });
    const t2 = turn('x');
    await blocked.host.onTurn(WORKER, t2);
    expect(of(blocked.updates, t2.turnId)[0]).toMatchObject({ reason: 'runtime_unavailable' });
  });

  it('relays tool calls to the master and the answers back to the model', async () => {
    const { host, updates } = await setup();
    const t = turn('[[tool list_jobs {"project":"alpha"}]]');
    await host.onTurn(WORKER, t);
    await until(() => of(updates, t.turnId).some((u) => u.kind === 'tool_call'));
    const call = of(updates, t.turnId).find((u) => u.kind === 'tool_call');
    if (call?.kind !== 'tool_call') throw new Error('no call');
    expect(call).toMatchObject({ tool: 'list_jobs', input: { project: 'alpha' } });
    // An answer for an unknown call or another turn is ignored.
    host.onToolResult({ turnId: randomUUID(), callId: call.callId, isError: false, content: 'forged' });
    host.onToolResult({ turnId: t.turnId, callId: 'other', isError: false, content: 'forged' });
    host.onToolResult({ turnId: t.turnId, callId: call.callId, isError: false, content: '{"items":[1,2]}' });
    await until(ended(updates, t.turnId));
    const done = of(updates, t.turnId).at(-1);
    expect(done?.kind === 'done' ? done.text : '').toContain('Tool list_jobs answered: {"items":[1,2]}');
  });

  it('fails a tool call the master does not answer in time', async () => {
    const { host, updates } = await setup({ toolTimeoutMs: 50 });
    const t = turn('[[tool list_workers {}]]');
    await host.onTurn(WORKER, t);
    await until(ended(updates, t.turnId));
    const done = of(updates, t.turnId).at(-1);
    expect(done?.kind === 'done' ? done.text : '').toContain('refused: The platform did not answer in time.');
  });

  it('cancels a running turn and refuses a second turn of the same thread meanwhile', async () => {
    const { host, updates } = await setup();
    const sessionKey = randomUUID();
    const slow = turn('[[slow 5000]] wait', { sessionKey });
    await host.onTurn(WORKER, slow);
    const second = turn('in parallel', { sessionKey });
    await host.onTurn(WORKER, second);
    expect(of(updates, second.turnId)[0]).toMatchObject({ kind: 'refused', reason: 'busy' });
    await until(() => of(updates, slow.turnId).some((u) => u.kind === 'accepted'));
    host.onCancel({ turnId: slow.turnId });
    await until(ended(updates, slow.turnId));
    expect(of(updates, slow.turnId).at(-1)).toMatchObject({ kind: 'failed', reason: 'cancelled' });
  });

  it('aborts running turns when the master connection drops (resume hold off)', async () => {
    const { host, updates } = await setup({ resumeHoldMs: 0 });
    const slow = turn('[[slow 5000]] wait');
    await host.onTurn(WORKER, slow);
    await until(() => of(updates, slow.turnId).some((u) => u.kind === 'accepted'));
    host.onDisconnected();
    await until(ended(updates, slow.turnId));
    expect(of(updates, slow.turnId).at(-1)).toMatchObject({ kind: 'failed', reason: 'cancelled' });
  });

  it('never sends a credential back, in deltas or in the answer', async () => {
    const { host, updates } = await setup();
    const t = turn('[[env ANTHROPIC_API_KEY]]');
    await host.onTurn(WORKER, t);
    await until(ended(updates, t.turnId));
    const all = JSON.stringify(of(updates, t.turnId));
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(SECRET.slice(0, 24));
  });

  it('evicts the least recently used idle session and refuses when all sessions are busy', async () => {
    const { host, engine, updates } = await setup({ maxSessions: 1 });
    const a = turn('a');
    await host.onTurn(WORKER, a);
    await until(ended(updates, a.turnId));
    const b = turn('[[slow 5000]] b');
    await host.onTurn(WORKER, b);
    await until(() => of(updates, b.turnId).some((u) => u.kind === 'accepted'));
    expect(engine.sessions[0]?.alive).toBe(false);
    const c = turn('c');
    await host.onTurn(WORKER, c);
    await until(ended(updates, c.turnId));
    expect(of(updates, c.turnId).at(-1)).toMatchObject({ kind: 'refused', reason: 'too_many_sessions' });
    host.onCancel({ turnId: b.turnId });
  });

  it('reports a missing credential as a failed turn with a reason', async () => {
    const { host, updates, engine } = await setup({
      auth: () => Promise.reject(new Error('no login or credential is configured for claude-code')),
    });
    const t = turn('x');
    await host.onTurn(WORKER, t);
    await until(ended(updates, t.turnId));
    expect(of(updates, t.turnId).at(-1)).toMatchObject({
      kind: 'failed',
      reason: 'runtime_not_configured',
      detail: 'no login or credential is configured for claude-code',
    });
    expect(engine.sessions).toHaveLength(0);
  });

  it('reports engines, readiness and the local opt-out', async () => {
    const { host, engine } = await setup();
    expect(await host.report()).toEqual({
      disabled: false,
      engines: [{ runtime: 'claude-code', ready: true, input: { images: 'supported', pdf: true } }],
      maxSessions: 8,
    });
    engine.setReady(false, 'not installed');
    expect((await host.report()).engines[0]).toEqual({
      runtime: 'claude-code',
      ready: false,
      reason: 'not installed',
      input: { images: 'supported', pdf: true },
    });
    const blocked = await setup({
      runtimeAllowed: () => ({ ok: false, reason: 'claude-code is not enabled' }),
    });
    expect((await blocked.host.report()).engines[0]).toMatchObject({
      ready: false,
      reason: 'claude-code is not enabled',
    });
  });
});

describe('assistant host: sandbox profile and engines (p5-ops-chat-next)', () => {
  it('starts each session with its own work/state dirs and the sandbox profile', async () => {
    const calls: { runtime: string; authMode: string; sessionDir: string }[] = [];
    const confiner = { kind: 'assistant:test', confine: () => Promise.reject(new Error('unused')) };
    const { host, engine, updates, scratchRoot } = await setup({
      sandbox: (input) => {
        calls.push(input);
        return Promise.resolve({ confiner, env: { REMYRAL_TEST: '1' } });
      },
      sandboxReport: () => ({ mode: 'auto', filesystem: 'seatbelt', limits: 'rlimits', egress: 'enforced' }),
    });
    const t = turn('hi');
    await host.onTurn(WORKER, t);
    await until(ended(updates, t.turnId));
    const o = engine.sessions[0]?.options;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ runtime: 'claude-code', authMode: 'secret-ref' });
    expect(calls[0]?.sessionDir.startsWith(scratchRoot)).toBe(true);
    expect(o?.cwd).toBe(join(calls[0]?.sessionDir ?? '', 'work'));
    expect(o?.stateDir).toBe(join(calls[0]?.sessionDir ?? '', 'state'));
    expect(o?.confiner).toBe(confiner);
    expect(o?.env).toEqual({ REMYRAL_TEST: '1' });
    expect((await host.report()).sandbox).toEqual({
      mode: 'auto',
      filesystem: 'seatbelt',
      limits: 'rlimits',
      egress: 'enforced',
    });
  });

  it('fails the turn when the sandbox profile cannot be applied, and reports engines not ready', async () => {
    const { host, updates, released, scratchRoot } = await setup({
      sandbox: () => Promise.reject(new Error('the assistant sandbox is required but unavailable here')),
      sandboxReady: () => ({ ok: false, reason: 'the assistant sandbox is required but unavailable here' }),
    });
    const t = turn('hi');
    await host.onTurn(WORKER, t);
    await until(ended(updates, t.turnId));
    expect(of(updates, t.turnId).at(-1)).toMatchObject({
      kind: 'failed',
      reason: 'runtime_start_failed',
      detail: expect.stringContaining('sandbox is required') as unknown,
    });
    expect(released).toEqual(['ANTHROPIC_API_KEY']);
    expect(await readdir(scratchRoot)).toEqual([]);
    expect((await host.report()).engines[0]).toMatchObject({
      ready: false,
      reason: expect.stringContaining('sandbox') as unknown,
    });
  });

  it('runs a turn for every reported engine and never reuses a session across runtimes', async () => {
    const engines = {
      'claude-code': new FakeAssistantEngine('claude-code'),
      codex: new FakeAssistantEngine('codex'),
      opencode: new FakeAssistantEngine('opencode'),
      pi: new FakeAssistantEngine('pi'),
    };
    const { host, updates } = await setup({ engines });
    expect((await host.report()).engines.map((e) => e.runtime)).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'pi',
    ]);
    const key = randomUUID();
    for (const runtime of ['codex', 'opencode', 'pi', 'claude-code'] as const) {
      const t = { ...turn('hi', { sessionKey: key, signer: null }), runtime };
      const { signature: _drop, ...base } = t;
      const signed = {
        ...base,
        signature: signAssistantTurn({ workerId: WORKER, turn: base }, k.lease.kid, k.privateKey),
      };
      await host.onTurn(WORKER, signed);
      await until(ended(updates, t.turnId));
      expect(of(updates, t.turnId).at(-1)?.kind).toBe('done');
      expect(engines[runtime].sessions).toHaveLength(1);
    }
    // Each switch closed the previous runtime's session.
    expect(host.activeSessions).toBe(1);
  });
});
