import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentEvent } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  descendantGroups,
  killGroups,
  parsePsOutput,
  PI_GATE_MARKER,
  PI_GATE_POLICY_ENV,
  PI_GATE_SOURCE,
  PI_SUBTASK_DIALOG_TIMEOUT_MS,
  PI_SUBTASK_MARKER,
  piCapabilities,
  piSubtaskExtensionSource,
  subtaskToolSpecs,
  SUBTASK_TOOL_NAMES,
  piCodec,
  PiEventMapper,
  piGatePolicy,
  PiInbound,
  SecretValue,
  snapshotDescendantGroups,
  spawnOwnedProcess,
  toIdentifier,
  type PiAction,
} from '../src/index.js';

const TRANSCRIPTS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi', 'transcripts');
const tmp = mkdtempSync(join(tmpdir(), 'remyral-pi-units-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function transcript(name: string): PiInbound[] {
  return readFileSync(join(TRANSCRIPTS, `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => PiInbound.parse(JSON.parse(line)));
}

function mapAll(name: string, authMode: 'secret-ref' | 'local-login' = 'secret-ref'): PiAction[] {
  let t = 0;
  const mapper = new PiEventMapper({ secrets: {}, authMode, now: () => (t += 10) });
  return transcript(name).flatMap((r) => mapper.map(r));
}

const emitted = (actions: PiAction[]) => actions.flatMap((a) => (a.kind === 'emit' ? [a.event] : []));

describe('Pi 1.1.0 recorded transcripts -> protocol events', () => {
  it('every recorded line validates against the strict inbound schema', () => {
    for (const name of [
      'basic',
      'approval-approve',
      'approval-deny',
      'approval-timeout',
      'bash-abort',
      'long-steer-abort',
      'prompt-no-auth',
    ]) {
      expect(transcript(name).length).toBeGreaterThan(0);
    }
  });

  it('basic run: assistant messages, tool call/result, usage per response, settled', () => {
    const actions = mapAll('basic');
    const events = emitted(actions);
    for (const e of events) expect(AgentEvent.safeParse(e).success).toBe(true);
    expect(events.map((e) => e.kind)).toEqual([
      'message',
      'usage',
      'tool_call',
      'tool_result',
      'message',
      'usage',
    ]);
    expect(events[0]).toEqual({ kind: 'message', role: 'assistant', text: 'ack' });
    expect(events[2]).toMatchObject({
      kind: 'tool_call',
      toolName: 'read',
      inputSummary: '{"path":"README.md"}',
    });
    expect(events[3]).toMatchObject({ kind: 'tool_result', ok: false });
    expect(events[1]).toMatchObject({
      kind: 'usage',
      provenance: 'reported-by-runtime',
      inputTokens: 1511,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 1511,
      costUsd: 0,
      turns: 1,
      durationMs: 10,
      provider: 'remyral-faux',
      model: 'scripted',
      authMode: 'secret-ref',
    });
    expect(actions.at(-1)).toEqual({ kind: 'settled', aborted: false });
  });

  it('approval: the gate dialog becomes approval_request with the tool and command', () => {
    const actions = mapAll('approval-approve');
    const approval = actions.find((a) => a.kind === 'approval');
    expect(approval).toMatchObject({ kind: 'approval', toolName: 'bash' });
    if (approval?.kind !== 'approval') throw new Error('unreachable');
    expect(approval.event).toMatchObject({
      kind: 'approval_request',
      action: 'runtime.dangerous_tool',
      risk: 'high',
      description: 'bash: {"command":"echo approved > approved.txt"}',
      // p10-approval-readable: the JSON input parsed into fields.
      details: { tool: 'bash', command: 'echo approved > approved.txt', shell: 'posix' },
    });
    expect(approval.approvalId).toBe(approval.uiId);
    expect(emitted(actions)).toContainEqual(expect.objectContaining({ kind: 'tool_result', ok: true }));
  });

  it('approval denied / timed out: tool_result not ok with the gate reason', () => {
    for (const name of ['approval-deny', 'approval-timeout']) {
      const result = emitted(mapAll(name)).find((e) => e.kind === 'tool_result');
      expect(result).toMatchObject({ kind: 'tool_result', ok: false });
    }
  });

  it('abort during bash and during model streaming end with settled{aborted:true}', () => {
    expect(mapAll('bash-abort').at(-1)).toEqual({ kind: 'settled', aborted: true });
    const long = mapAll('long-steer-abort');
    expect(long.at(-1)).toEqual({ kind: 'settled', aborted: true });
    expect(emitted(long).some((e) => e.kind === 'error')).toBe(false);
  });

  it('local-login usage is token-only', () => {
    const usage = emitted(mapAll('basic', 'local-login')).filter((e) => e.kind === 'usage');
    expect(usage.length).toBe(2);
    for (const u of usage) {
      expect(u).toMatchObject({ provenance: 'estimated-from-tokens', authMode: 'local-login' });
      expect(Object.keys(u)).not.toContain('costUsd');
    }
  });

  it('foreign dialogs are cancelled; fire-and-forget UI is ignored; ids are protocol identifiers', () => {
    const mapper = new PiEventMapper({ secrets: {}, authMode: 'secret-ref' });
    expect(
      mapper.map({
        type: 'extension_ui_request',
        id: 'u1',
        method: 'confirm',
        title: 'Delete?',
        message: 'x',
      }),
    ).toEqual([{ kind: 'cancel-dialog', uiId: 'u1' }]);
    expect(
      mapper.map({
        type: 'extension_ui_request',
        id: 'u2',
        method: 'select',
        title: `${PI_GATE_MARKER}{bad`,
        options: [],
      }),
    ).toEqual([{ kind: 'cancel-dialog', uiId: 'u2' }]);
    expect(mapper.map({ type: 'extension_ui_request', id: 'u3', method: 'notify', message: 'hi' })).toEqual(
      [],
    );
    const [call] = mapper.map({
      type: 'tool_execution_start',
      toolCallId: 'parent/1',
      toolName: 'bash',
      args: {},
    });
    expect(call?.kind === 'emit' && call.event.kind === 'tool_call' && call.event.callId).toMatch(
      /^parent_1-[0-9a-f]{12}$/,
    );
  });

  it('p8-subtasks-pi: a sub-job tool dialog becomes subtask-call; malformed or non-input ones are cancelled', () => {
    const mapper = new PiEventMapper({ secrets: {}, authMode: 'secret-ref' });
    const input = { title: 't', prompt: 'p', paths: ['src/api/'] };
    expect(
      mapper.map({
        type: 'extension_ui_request',
        id: 's1',
        method: 'input',
        title: `${PI_SUBTASK_MARKER}${JSON.stringify({ callId: 'c', tool: 'request_subtask', input })}`,
      }),
    ).toEqual([{ kind: 'subtask-call', uiId: 's1', tool: 'request_subtask', input }]);
    for (const [method, title] of [
      ['input', `${PI_SUBTASK_MARKER}{bad`],
      ['input', `${PI_SUBTASK_MARKER}${JSON.stringify({ callId: 'c' })}`],
      ['select', `${PI_SUBTASK_MARKER}${JSON.stringify({ callId: 'c', tool: 'request_subtask', input })}`],
    ] as const) {
      expect(mapper.map({ type: 'extension_ui_request', id: 's2', method, title, options: [] })).toEqual([
        { kind: 'cancel-dialog', uiId: 's2' },
      ]);
    }
  });

  it('secrets in runtime output are redacted before they become events', () => {
    const secret = new SecretValue('sk-live-123456789');
    const mapper = new PiEventMapper({ secrets: { K: secret }, authMode: 'secret-ref' });
    const actions = mapper.map({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      isError: false,
      result: { content: [{ type: 'text', text: 'KEY=sk-live-123456789' }] },
    });
    expect(JSON.stringify(actions)).not.toContain('sk-live-123456789');
    expect(JSON.stringify(actions)).toContain('[REDACTED]');
  });

  it('error stop reasons and retry/extension failures become error events', () => {
    const mapper = new PiEventMapper({ secrets: {}, authMode: 'secret-ref' });
    expect(mapper.map({ type: 'auto_retry_end', success: false, finalError: '529 overloaded' })).toEqual([
      { kind: 'emit', event: { kind: 'error', code: 'retry_exhausted', message: '529 overloaded' } },
    ]);
    expect(
      mapper.map({
        type: 'extension_error',
        extensionPath: '/secret/path.mjs',
        event: 'tool_call',
        error: 'boom',
      }),
    ).toEqual([
      { kind: 'emit', event: { kind: 'error', code: 'extension_error', message: 'tool_call: boom' } },
    ]);
  });

  it('the strict schema rejects unknown record types (schema drift surfaces)', () => {
    expect(PiInbound.safeParse({ type: 'agent_new_thing' }).success).toBe(false);
    expect(PiInbound.safeParse({ type: 'agent_settled' }).success).toBe(false);
  });
});

describe('Pi codec', () => {
  it('classifies responses, dialogs and events; encodes UI answers', () => {
    expect(piCodec.classify({ type: 'response', id: '1', command: 'abort', success: true })).toEqual({
      kind: 'response',
      id: '1',
      ok: true,
      result: undefined,
    });
    expect(
      piCodec.classify({ type: 'response', id: '2', command: 'prompt', success: false, error: 'No API key' }),
    ).toEqual({ kind: 'response', id: '2', ok: false, error: 'No API key' });
    expect(piCodec.classify({ type: 'response', command: 'parse', success: false, error: 'x' })).toEqual({
      kind: 'notification',
    });
    expect(
      piCodec.classify({ type: 'extension_ui_request', id: 'u', method: 'select', options: [] }),
    ).toEqual({
      kind: 'request',
      id: 'u',
    });
    expect(piCodec.classify({ type: 'extension_ui_request', id: 'u', method: 'notify' })).toEqual({
      kind: 'notification',
    });
    expect(piCodec.encodeRequest('7', { type: 'abort' })).toEqual({ type: 'abort', id: '7' });
    expect(piCodec.encodeResponse?.('u', { value: 'approve' })).toEqual({
      type: 'extension_ui_response',
      id: 'u',
      value: 'approve',
    });
  });
});

describe('Pi permission gate extension (generated source)', () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;

  async function loadGate(policy: string | undefined): Promise<Handler> {
    const file = join(tmp, `gate-${String(Math.random()).slice(2)}.mjs`);
    writeFileSync(file, PI_GATE_SOURCE);
    if (policy === undefined) Reflect.deleteProperty(process.env, PI_GATE_POLICY_ENV);
    else process.env[PI_GATE_POLICY_ENV] = policy;
    const mod = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void };
    let handler: Handler | undefined;
    mod.default({
      on: (name: string, h: Handler) => {
        if (name === 'tool_call') handler = h;
      },
    });
    Reflect.deleteProperty(process.env, PI_GATE_POLICY_ENV);
    if (!handler) throw new Error('gate registered no tool_call handler');
    return handler;
  }

  const ctx = (answer: string | undefined | Error) => ({
    hasUI: true,
    ui: {
      select: (title: string) => {
        expect(title.startsWith(PI_GATE_MARKER)).toBe(true);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  });
  const bash = { toolCallId: 't', toolName: 'bash', input: { command: 'rm -rf /' } };
  const read = { toolCallId: 't', toolName: 'read', input: { path: 'a' } };

  it('blocks everything without a valid policy (fail-closed)', async () => {
    for (const p of [undefined, 'not json', JSON.stringify({ v: 2, mode: 'ask-all' })]) {
      const h = await loadGate(p);
      expect(await h(read, ctx('approve'))).toMatchObject({ block: true });
    }
  });

  it('ask-sensitive: read-only tools run, bash asks; only "approve" allows', async () => {
    const h = await loadGate(JSON.stringify(piGatePolicy('ask-sensitive', 1000)));
    expect(await h(read, ctx(undefined))).toBeUndefined();
    expect(await h(bash, ctx('approve'))).toBeUndefined();
    const denied = await h(bash, ctx('deny'));
    expect(denied?.block).toBe(true);
    expect(denied?.reason).toContain('denied');
    const timedOut = await h(bash, ctx(undefined));
    expect(timedOut?.block).toBe(true);
    expect(timedOut?.reason).toContain('no approval');
    expect(await h(bash, ctx(new Error('ui failure')))).toMatchObject({ block: true });
    expect(await h(bash, { hasUI: false })).toMatchObject({ block: true });
    expect(await h({ toolCallId: 't', toolName: 'mcp__x__y', input: {} }, ctx('deny'))).toMatchObject({
      block: true,
    });
  });

  it('ask-all gates read-only tools too; deny-sensitive never asks', async () => {
    const askAll = await loadGate(JSON.stringify(piGatePolicy('ask-all', 1000)));
    expect(await askAll(read, ctx('deny'))).toMatchObject({ block: true });
    const deny = await loadGate(JSON.stringify(piGatePolicy('deny-sensitive', 1000)));
    expect(await deny(read, ctx(undefined))).toBeUndefined();
    expect(await deny(bash, ctx('approve'))).toMatchObject({ block: true });
  });

  it('p8-subtasks-pi: pre-approved sub-job tools run in every mode without asking; nothing else is exempt', async () => {
    const never = { hasUI: true, ui: { select: () => Promise.reject(new Error('must not ask')) } };
    const sub = { toolCallId: 't', toolName: 'request_subtask', input: { title: 't', prompt: 'p' } };
    for (const mode of ['ask-all', 'ask-sensitive', 'deny-sensitive', 'allow-all'] as const) {
      const h = await loadGate(JSON.stringify(piGatePolicy(mode, 1000, undefined, true, SUBTASK_TOOL_NAMES)));
      expect(await h(sub, never), mode).toBeUndefined();
      expect(await h(sub, { hasUI: false }), mode).toBeUndefined();
    }
    const deny = await loadGate(
      JSON.stringify(piGatePolicy('deny-sensitive', 1000, undefined, false, SUBTASK_TOOL_NAMES)),
    );
    expect(await deny(bash, ctx('approve'))).toMatchObject({ block: true });
    // Without the list (a job without sub-job tools) the name is an ordinary unknown tool.
    const plain = await loadGate(JSON.stringify(piGatePolicy('deny-sensitive', 1000)));
    expect(await plain(sub, ctx('approve'))).toMatchObject({ block: true });
    expect(piGatePolicy('ask-all', 1000)).not.toHaveProperty('preApprovedTools');
    // A malformed list fails closed.
    const bad = await loadGate(
      JSON.stringify({ ...piGatePolicy('allow-all', 1000), preApprovedTools: 'request_subtask' }),
    );
    expect(await bad(sub, never)).toMatchObject({ block: true });
  });

  it('allow-all (ADR-0020): nothing is blocked and nobody is asked', async () => {
    const h = await loadGate(JSON.stringify(piGatePolicy('allow-all', 1000)));
    const never = { hasUI: true, ui: { select: () => Promise.reject(new Error('must not ask')) } };
    expect(await h(bash, never)).toBeUndefined();
    expect(await h({ toolCallId: 't', toolName: 'mcp__x__y', input: {} }, never)).toBeUndefined();
    expect(await h(bash, { hasUI: false })).toBeUndefined();
  });

  it('ask-sensitive: edit/write inside the workspace run; outside, symlinks, .git, ~ and bash still ask', async () => {
    const ws = realpathSync(mkdtempSync(join(tmp, 'pi-ws-')));
    const outside = realpathSync(mkdtempSync(join(tmp, 'pi-out-')));
    mkdirSync(join(ws, 'out'));
    mkdirSync(join(ws, '.git'));
    if (process.platform !== 'win32') symlinkSync(outside, join(ws, 'escape'));
    const h = await loadGate(JSON.stringify(piGatePolicy('ask-sensitive', 1000, ws)));
    const w = (path: string, tool = 'write') => ({
      toolCallId: 't',
      toolName: tool,
      input: { path, content: 'x' },
    });
    expect(await h(w('out/summary.md'), ctx('deny'))).toBeUndefined();
    expect(await h(w(join(ws, 'out', 'summary.md')), ctx('deny'))).toBeUndefined();
    expect(await h(w('new/dir/file.md', 'edit'), ctx('deny'))).toBeUndefined();
    for (const p of [
      join(outside, 'x.md'),
      '../x.md',
      '.git/hooks/pre-commit',
      '~/x.md',
      ...(process.platform === 'win32' ? [] : ['escape/x.md']),
    ]) {
      expect(await h(w(p), ctx('deny')), p).toMatchObject({ block: true });
    }
    expect(await h(w('out/a.md', 'bash'), ctx('deny'))).toMatchObject({ block: true });
    // Without a workspace root in the policy there is no exemption.
    const noRoot = await loadGate(JSON.stringify(piGatePolicy('ask-sensitive', 1000)));
    expect(await noRoot(w('out/summary.md'), ctx('deny'))).toMatchObject({ block: true });
    // ask-all asks for workspace writes too.
    const askAll = await loadGate(JSON.stringify(piGatePolicy('ask-all', 1000, ws)));
    expect(await askAll(w('out/summary.md'), ctx('deny'))).toMatchObject({ block: true });
  });
});

describe('Pi capabilities (ADR-0008)', () => {
  it('contract-tested platform: decisions from the compat matrix, artifacts unsupported', () => {
    const set = piCapabilities('1.4.0', 'darwin', 'arm64').capabilities;
    expect(set.streaming.status).toBe('supported');
    expect(set.cancel.status).toBe('supported');
    expect(set.approval.status).toBe('degraded');
    expect(set.safe_cancel.status).toBe('degraded');
    expect(set.artifacts.status).toBe('unsupported');
  });

  it('other platforms are unverified; a version off the pin is never offered', () => {
    const linux = piCapabilities('1.4.0', 'linux', 'x64').capabilities;
    expect(linux.cancel.status).toBe('unverified');
    expect(linux.cancel.reason).toContain('linux-x64');
    const drift = piCapabilities('1.1.1', 'darwin', 'arm64').capabilities;
    expect(Object.values(drift).every((c) => c.status === 'unverified' || c.status === 'unsupported')).toBe(
      true,
    );
  });
});

describe('descendant process-group sweep', () => {
  it.skipIf(process.platform === 'win32')(
    'a group kill misses a detached grandchild; the snapshot sweep reaps it (real processes)',
    async () => {
      const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'detached-parent.mjs');
      const proc = await spawnOwnedProcess({ command: process.execPath, args: [fixture], cwd: tmp });
      const line = await new Promise<string>((resolve) => {
        proc.stdout.once('data', (c: Buffer) => {
          resolve(c.toString());
        });
      });
      const { grandchild } = JSON.parse(line) as { grandchild: number };
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const groups = await snapshotDescendantGroups(proc.pid);
      expect(groups).toContain(grandchild);
      await proc.terminate({ graceMs: 100 });
      expect(alive(grandchild)).toBe(true); // the gap: not in the runtime's group
      killGroups(groups);
      const deadline = Date.now() + 3_000;
      while (alive(grandchild) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(alive(grandchild)).toBe(false);
      await proc.dispose();
    },
  );

  it('collects the groups of all descendants except the root group', () => {
    const rows = parsePsOutput(`
      100 1 100
      101 100 100
      102 100 102
      103 102 102
      104 103 104
      200 1 200
      bogus line
    `);
    expect(descendantGroups(rows, 100).sort()).toEqual([102, 104]);
    expect(descendantGroups(rows, 200)).toEqual([]);
  });

  it('never signals pid <= 1 and ignores vanished groups', () => {
    const sent: number[] = [];
    const killed = killGroups([0, 1, 5, 6], (pid) => {
      if (pid === -6) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      sent.push(pid);
    });
    expect(sent).toEqual([-5]);
    expect(killed).toEqual([5]);
  });

  it('toIdentifier keeps conforming ids and makes others unique', () => {
    expect(toIdentifier('tool:1:abc')).toBe('tool:1:abc');
    expect(toIdentifier('a/b')).not.toBe(toIdentifier('a_b'));
  });
});

describe('Pi sub-job tool extension (generated source, p8-subtasks-pi)', () => {
  type Tool = {
    name: string;
    parameters: Record<string, unknown>;
    execute: (
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{ content: { type: string; text: string }[]; isError: boolean }>;
  };

  async function load(): Promise<Tool[]> {
    const file = join(tmp, `subtasks-${String(Math.random()).slice(2)}.mjs`);
    writeFileSync(file, piSubtaskExtensionSource(subtaskToolSpecs()));
    const mod = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void };
    const tools: Tool[] = [];
    mod.default({ registerTool: (t: Tool) => tools.push(t), on: () => undefined });
    return tools;
  }

  it('registers the three tools with their JSON Schemas and relays each call through an input dialog', async () => {
    const tools = await load();
    expect(tools.map((t) => t.name)).toEqual(SUBTASK_TOOL_NAMES);
    expect(tools[0]?.parameters).toMatchObject({ type: 'object', properties: { paths: { type: 'array' } } });
    const asked: { title: string; opts: { timeout: number; signal?: AbortSignal } }[] = [];
    const ctx = (answer: unknown) => ({
      hasUI: true,
      ui: {
        input: (title: string, _placeholder: string, opts: { timeout: number; signal?: AbortSignal }) => {
          asked.push({ title, opts });
          return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
        },
      },
    });
    const signal = new AbortController().signal;
    const ok = await tools[0]?.execute(
      'call-1',
      { title: 't', prompt: 'p' },
      signal,
      undefined,
      ctx(JSON.stringify({ content: 'queued', isError: false })),
    );
    expect(ok).toEqual({ content: [{ type: 'text', text: 'queued' }], details: undefined, isError: false });
    expect(asked[0]?.title.startsWith(PI_SUBTASK_MARKER)).toBe(true);
    expect(JSON.parse(asked[0]?.title.slice(PI_SUBTASK_MARKER.length) ?? '')).toEqual({
      callId: 'call-1',
      tool: 'request_subtask',
      input: { title: 't', prompt: 'p' },
    });
    expect(asked[0]?.opts).toEqual({ timeout: PI_SUBTASK_DIALOG_TIMEOUT_MS, signal });
    expect(PI_SUBTASK_DIALOG_TIMEOUT_MS).toBeGreaterThan(600_000);
    // Error answers, no answer, unreadable answers, a failing UI and no UI: error results.
    expect(
      (
        await tools[0]?.execute(
          'c',
          {},
          undefined,
          undefined,
          ctx(JSON.stringify({ content: 'no', isError: true })),
        )
      )?.isError,
    ).toBe(true);
    for (const answer of [undefined, 'not json', JSON.stringify({ nope: 1 }), new Error('ui')]) {
      expect((await tools[1]?.execute('c', {}, undefined, undefined, ctx(answer)))?.isError).toBe(true);
    }
    expect((await tools[2]?.execute('c', {}, undefined, undefined, { hasUI: false }))?.isError).toBe(true);
  });
});
