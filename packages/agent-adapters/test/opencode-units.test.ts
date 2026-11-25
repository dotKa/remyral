import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentEvent } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  errorCode,
  findOpenCodeProjectConfig,
  OC_PERMISSION_KEYS,
  OcEventMapper,
  OpenCodeClient,
  opencodeCapabilities,
  opencodePermissionPolicy,
  permissionDrift,
  routeOf,
  SecretValue,
  type OcAction,
} from '../src/index.js';

const TRANSCRIPTS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode', 'transcripts');

function frames(name: string): unknown[] {
  return readFileSync(join(TRANSCRIPTS, `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as unknown);
}

function sessionOf(all: unknown[]): string {
  for (const f of all) {
    const p = (f as { properties?: { sessionID?: unknown } }).properties;
    if (typeof p?.sessionID === 'string') return p.sessionID;
  }
  throw new Error('no session in transcript');
}

function mapAll(name: string, authMode: 'secret-ref' | 'local-login' = 'secret-ref'): OcAction[] {
  const all = frames(name);
  let t = 0;
  const mapper = new OcEventMapper({ secrets: {}, authMode, now: () => (t += 10) });
  mapper.bind(sessionOf(all));
  return all.flatMap((f) => mapper.map(f));
}

const emitted = (actions: OcAction[]) => actions.flatMap((a) => (a.kind === 'emit' ? [a.event] : []));

describe('OpenCode 1.19.0 recorded /event frames -> protocol events', () => {
  it('basic: tool call/result once each, one usage per step, final text, idle', () => {
    const actions = mapAll('basic');
    const events = emitted(actions);
    for (const e of events) expect(AgentEvent.safeParse(e).success).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(['tool_call', 'tool_result', 'usage', 'message', 'usage']);
    expect(events[0]).toMatchObject({
      kind: 'tool_call',
      toolName: 'read',
      inputSummary: '{"filePath":"README.md"}',
    });
    expect(events[1]).toMatchObject({ kind: 'tool_result', ok: false });
    expect(events[2]).toMatchObject({
      kind: 'usage',
      provenance: 'reported-by-runtime',
      inputTokens: 60,
      outputTokens: 7,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      costUsd: 0,
      turns: 1,
      provider: 'fake',
      model: 'scripted',
      authMode: 'secret-ref',
    });
    expect(events[3]).toEqual({ kind: 'message', role: 'assistant', text: 'done' });
    expect(actions.some((a) => a.kind === 'busy')).toBe(true);
    expect(actions.at(-1)).toEqual({ kind: 'idle' });
  });

  it('approval: permission.asked becomes approval_request with the command; replies are reported', () => {
    for (const [name, ok] of [
      ['approval-once', true],
      ['approval-reject', false],
    ] as const) {
      const actions = mapAll(name);
      const approval = actions.find((a) => a.kind === 'approval');
      if (approval?.kind !== 'approval') throw new Error(`no approval in ${name}`);
      expect(approval.event).toMatchObject({
        kind: 'approval_request',
        action: 'runtime.dangerous_tool',
        risk: 'high',
        description: 'bash: echo approved > approved.txt',
        details: { tool: 'bash', command: 'echo approved > approved.txt', shell: 'posix' },
      });
      expect(approval.permissionId).toMatch(/^per/);
      expect(actions).toContainEqual({
        kind: 'permission-replied',
        permissionId: approval.permissionId,
        reply: ok ? 'once' : 'reject',
      });
      expect(emitted(actions)).toContainEqual(expect.objectContaining({ kind: 'tool_result', ok }));
    }
  });

  it('abort: MessageAbortedError session error, then idle', () => {
    const actions = mapAll('long-abort');
    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: 'session-error',
        name: 'MessageAbortedError',
        code: 'message_aborted_error',
      }),
    );
    expect(actions.at(-1)).toEqual({ kind: 'idle' });
  });

  it('local-login usage is token-only', () => {
    for (const u of emitted(mapAll('basic', 'local-login')).filter((e) => e.kind === 'usage')) {
      expect(u).toMatchObject({ provenance: 'estimated-from-tokens', authMode: 'local-login' });
      expect(Object.keys(u)).not.toContain('costUsd');
    }
  });

  it('ignores other sessions and unconsumed types; flags tamper signals and invalid consumed events', () => {
    const mapper = new OcEventMapper({ secrets: {}, authMode: 'secret-ref' });
    expect(mapper.map({ type: 'session.idle', properties: { sessionID: 'ses_a' } })).toEqual([]); // not bound yet
    mapper.bind('ses_a');
    expect(mapper.map({ type: 'session.idle', properties: { sessionID: 'ses_b' } })).toEqual([]);
    expect(mapper.map({ type: 'plugin.added', properties: { id: 'x' } })).toEqual([]);
    expect(mapper.map({ type: 'pty.created', properties: {} })).toEqual([
      { kind: 'tamper', reason: 'a PTY was created on the job server' },
    ]);
    expect(mapper.map({ type: 'session.created', properties: { info: { id: 'ses_b' } } })).toEqual([
      { kind: 'tamper', reason: 'another session was created on the job server' },
    ]);
    expect(
      mapper.map({
        type: 'session.status',
        properties: { sessionID: 'ses_a', status: { type: 'exploded' } },
      }),
    ).toEqual([{ kind: 'protocol-error', message: 'invalid session.status event' }]);
  });

  it('redacts secrets in tool output', () => {
    const secret = new SecretValue('sk-oc-123456789');
    const mapper = new OcEventMapper({ secrets: { K: secret }, authMode: 'secret-ref', sessionID: 'ses_a' });
    const actions = mapper.map({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_a',
        time: 1,
        part: {
          id: 'prt_1',
          messageID: 'msg_1',
          sessionID: 'ses_a',
          type: 'tool',
          tool: 'bash',
          callID: 'call_1',
          state: {
            status: 'completed',
            input: { command: 'env' },
            output: 'KEY=sk-oc-123456789',
            title: 'env',
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      },
    });
    expect(JSON.stringify(actions)).not.toContain('sk-oc-123456789');
    expect(errorCode('ProviderAuthError')).toBe('provider_auth_error');
  });
});

describe('OpenCode permission policy', () => {
  it('sets every key explicitly; never offers outside-workspace, sub-agents, questions, LSP, skills', () => {
    const { config, ruleset } = opencodePermissionPolicy('ask-sensitive', true);
    expect(Object.keys(config).sort()).toEqual([...OC_PERMISSION_KEYS].sort());
    expect(config).toMatchObject({
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      // p5-full-access §2: workspace edits do not ask (external_directory stays denied).
      edit: 'allow',
      bash: 'ask',
      webfetch: 'ask',
      websearch: 'ask',
      todowrite: 'allow',
      external_directory: 'deny',
      task: 'deny',
      question: 'deny',
      lsp: 'deny',
      doom_loop: 'deny',
      skill: 'deny',
    });
    expect(ruleset[0]).toEqual({ permission: '*', pattern: '*', action: 'ask' });
    expect(ruleset).toHaveLength(OC_PERMISSION_KEYS.length + 1);
  });

  it('ask-all asks for reads too; deny-sensitive and "approval not offered" never ask', () => {
    expect(opencodePermissionPolicy('ask-all', true).config.read).toBe('ask');
    for (const p of [
      opencodePermissionPolicy('deny-sensitive', true),
      opencodePermissionPolicy('ask-all', false),
    ]) {
      expect(Object.values(p.config)).not.toContain('ask');
      expect(p.ruleset.every((r) => r.action !== 'ask')).toBe(true);
    }
  });

  it('allow-all (ADR-0020): everything allowed except questions, LSP downloads and project skills', () => {
    const { config, ruleset } = opencodePermissionPolicy('allow-all', false);
    for (const key of OC_PERMISSION_KEYS) {
      expect(config[key]).toBe(['question', 'lsp', 'skill'].includes(key) ? 'deny' : 'allow');
    }
    expect(ruleset[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' });
    expect(ruleset.some((r) => r.action === 'ask')).toBe(false);
    expect(permissionDrift(config, { ...config })).toEqual([]);
  });

  it('drift detection lists every key that differs or is missing', () => {
    const { config } = opencodePermissionPolicy('ask-sensitive', true);
    expect(permissionDrift(config, { ...config })).toEqual([]);
    expect(permissionDrift(config, { ...config, bash: 'allow', '*': 'allow' })).toEqual(['bash']);
    expect(permissionDrift(config, { ...config, edit: { '*': 'allow' } })).toEqual(['edit']);
    expect(permissionDrift(config, undefined)).toHaveLength(OC_PERMISSION_KEYS.length);
  });
});

describe('OpenCode client route allowlist and SSE parsing', () => {
  it('only allowlisted routes; ids must match the runtime formats', () => {
    expect(routeOf({ op: 'abort', sessionID: 'ses_abc123' })).toEqual({
      method: 'POST',
      path: '/session/ses_abc123/abort',
    });
    expect(routeOf({ op: 'replyPermission', requestID: 'per_1', body: {} }).path).toBe(
      '/permission/per_1/reply',
    );
    expect(() => routeOf({ op: 'abort', sessionID: '../pty' })).toThrow(TypeError);
    expect(() => routeOf({ op: 'getSession', sessionID: 'ses_a/../../pty' })).toThrow(TypeError);
    expect(() => routeOf({ op: 'replyPermission', requestID: 'per_1?x=1', body: {} })).toThrow(TypeError);
  });

  it('adds ?directory= to every request and parses data-only SSE frames (LF and CRLF, multi-line, comments)', async () => {
    const body = [
      'data: {"type":"server.connected","properties":{}}\n\n',
      ': keepalive\n\n',
      'data: {"type":"a",\r\ndata: "properties":{}}\r\n\r\n',
      'data: {"type":"b","properties":{}}\n\n',
    ].join('');
    let requested = '';
    const client = new OpenCodeClient({
      baseUrl: 'http://127.0.0.1:1',
      directory: '/work space',
      headers: () => ({ authorization: 'Basic x' }),
      fetchImpl: (input) => {
        requested = input instanceof Request ? input.url : input.toString();
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
      },
    });
    const out: unknown[] = [];
    for await (const f of client.events(new AbortController().signal)) out.push(f);
    expect(requested).toBe('http://127.0.0.1:1/event?directory=%2Fwork+space');
    expect(out).toEqual([
      { type: 'server.connected', properties: {} },
      { type: 'a', properties: {} },
      { type: 'b', properties: {} },
    ]);
  });
});

describe('OpenCode capabilities (ADR-0008)', () => {
  it('tested platform: native approval degraded by the password exposure; others unverified', () => {
    const tested = opencodeCapabilities('1.19.4', 'darwin', 'arm64').capabilities;
    expect(tested.cancel.status).toBe('supported');
    expect(tested.approval.status).toBe('degraded');
    expect(tested.approval.reason).toContain('password');
    expect(tested.artifacts.status).toBe('unsupported');
    const win = opencodeCapabilities('1.19.4', 'win32', 'x64').capabilities;
    expect(win.streaming.status).toBe('unverified');
    const drift = opencodeCapabilities('1.18.35', 'darwin', 'arm64').capabilities;
    expect(Object.values(drift).every((c) => c.status === 'unverified' || c.status === 'unsupported')).toBe(
      true,
    );
  });
});

describe('OpenCode workspace guard (project config is loaded despite OPENCODE_DISABLE_PROJECT_CONFIG)', () => {
  it('finds .opencode / opencode.json(c) in the workspace and its ancestors, except in the worker home', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'remyral-oc-guard-')));
    const ws = join(root, 'repo', 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    expect(await findOpenCodeProjectConfig(ws, '/nonexistent-home')).toEqual([]);
    mkdirSync(join(ws, '.opencode', 'plugin'), { recursive: true });
    writeFileSync(join(root, 'repo', 'opencode.jsonc'), '{}');
    expect(await findOpenCodeProjectConfig(ws, '/nonexistent-home')).toEqual([
      join(ws, '.opencode'),
      join(root, 'repo', 'opencode.jsonc'),
    ]);
    writeFileSync(join(root, 'opencode.json'), '{}');
    expect(await findOpenCodeProjectConfig(ws, '/nonexistent-home')).toContain(join(root, 'opencode.json'));
    expect(await findOpenCodeProjectConfig(ws, root)).not.toContain(join(root, 'opencode.json'));
    rmSync(root, { recursive: true, force: true });
  });
});
