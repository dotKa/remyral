import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AttemptId, JobId } from '@remyral/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  codexSwitchResult,
  createClaudeCodeAdapter,
  type ClaudeCodeAdapter,
  opencodeLiveAction,
  opencodeSwitchResult,
  PI_GATE_MARKER,
  PI_GATE_POLICY_ENV,
  PI_GATE_SOURCE,
  PI_POLICY_MARKER,
  PiEventMapper,
  piGateMode,
  piGatePolicy,
  type SessionRef,
  type SpawnContext,
} from '../src/index.js';
import { collectUntilStopped, readUntil } from '../src/testing/index.js';
import { FAKE_CLI, FakeClaudeSdk, type FakeTurnScript } from './fixtures/claude-code/fake-sdk.js';
import { assistantText } from './fixtures/claude-code/sdk-messages.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

/** p6-approval-mode-switch (docs/design/p6-approval-mode-switch.md §2.6): how each adapter applies a mode change. */

const root = mkdtempSync(join(tmpdir(), 'remyral-approval-switch-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// The stand-in CLI (FAKE_CLI) is a shebang script, which Windows does not run by itself.
describePosix('Claude Code: live permission mode (SDK Query.setPermissionMode)', () => {
  const opened: { adapter: ClaudeCodeAdapter; ref: SessionRef }[] = [];
  afterEach(async () => {
    for (const { adapter, ref } of opened.splice(0)) await adapter.cleanup(ref);
  });

  /** A turn that pauses before its Bash call, so the test can switch the mode first. */
  const pausedTool: FakeTurnScript = () => [
    { kind: 'message', build: (sid) => assistantText(sid, 'thinking') },
    { kind: 'block', ms: 400 },
    { kind: 'tool', id: 'toolu_push_9', name: 'Bash', input: { command: 'git push origin work' } },
    { kind: 'message', build: (sid) => assistantText(sid, 'finished') },
  ];

  function ctx(approvalPolicy: SpawnContext['approvalPolicy']): SpawnContext {
    return {
      jobId: JobId.parse('job-switch'),
      attemptId: AttemptId.parse('attempt-1'),
      workspaceRoot: mkdtempSync(join(root, 'ws-')),
      job: { runtime: 'claude-code', prompt: 'p', limits: { maxDurationSec: 60 } },
      sandboxProfile: 'host-restricted',
      approvalPolicy,
      repositoryTrust: 'untrusted',
      repoConfig: 'ignore-repository-config',
      secretEnv: {},
      timeouts: {
        startupMs: 5_000,
        cancelGraceMs: 500,
        cancelMs: 2_000,
        approvalMs: 5_000,
        maxDurationMs: 60_000,
      },
      allowUnverified: true,
      signal: new AbortController().signal,
    };
  }

  async function run(start: SpawnContext['approvalPolicy'], refuse = false) {
    const sdk = new FakeClaudeSdk({ script: pausedTool, refuseSetPermissionMode: refuse });
    const adapter = createClaudeCodeAdapter({
      binaryPath: FAKE_CLI,
      sdkInfo: () => ({ sdkVersion: '0.3.310', claudeCodeVersion: '2.1.310', packageDir: root }),
      sdk,
      stateDir: join(root, 'state'),
      sourceEnv: { ...process.env, ANTHROPIC_API_KEY: 'k' },
    });
    await adapter.probe();
    const ref = await adapter.spawn(ctx(start));
    opened.push({ adapter, ref });
    await adapter.sendPrompt(ref, { text: 'go' });
    return { adapter, sdk, ref };
  }

  it('tightening to deny-sensitive switches the CLI to dontAsk and denies the next call', async () => {
    const { adapter, sdk, ref } = await run('ask-sensitive');
    const r = await adapter.setApprovalPolicy(ref, 'deny-sensitive');
    expect(r.application).toBe('live');
    expect(sdk.queries[0]?.permissionModes).toEqual(['dontAsk']);
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(events.map((e) => e.event.kind)).not.toContain('approval_request');
    expect(sdk.queries[0]?.lastDecision).toMatchObject({ behavior: 'deny' });
  });

  it('tightening out of bypassPermissions (allow-all → ask-all) switches to default and asks again', async () => {
    const { adapter, sdk, ref } = await run('allow-all');
    const r = await adapter.setApprovalPolicy(ref, 'ask-all');
    expect(r.application).toBe('live');
    expect(sdk.queries[0]?.permissionModes).toEqual(['default']);
    const asked = await readUntil(adapter, ref, (e) => e.event.kind === 'approval_request', 10_000);
    const req = asked.at(-1)?.event;
    if (req?.kind !== 'approval_request') throw new Error('no approval request');
    await adapter.requestApproval(ref, { approvalId: req.approvalId, decision: 'deny', decidedBy: 'u' });
    await collectUntilStopped(adapter, ref, 10_000);
    expect(sdk.queries[0]?.lastDecision).toMatchObject({ behavior: 'deny' });
  });

  it('loosening to allow-all keeps the CLI in default mode and the gate allows (bypass stays disabled)', async () => {
    const { adapter, sdk, ref } = await run('ask-sensitive');
    const r = await adapter.setApprovalPolicy(ref, 'allow-all');
    expect(r.application).toBe('gate');
    expect(sdk.queries[0]?.permissionModes).toEqual([]);
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(events.map((e) => e.event.kind)).not.toContain('approval_request');
    expect(sdk.queries[0]?.lastDecision).toMatchObject({ behavior: 'allow' });
  });

  it('a CLI that refuses the switch is reported as partial (never as applied)', async () => {
    const { adapter, ref } = await run('allow-all', true);
    const r = await adapter.setApprovalPolicy(ref, 'ask-all');
    expect(r.application).toBe('partial');
    expect(r.detail).toContain('refused');
  });
});

describe('Codex: approvalPolicy only at turn start', () => {
  it('before the first turn the change is live; a stricter policy mid-turn waits for the next turn', () => {
    expect(codexSwitchResult(undefined, 'untrusted').application).toBe('live');
    expect(codexSwitchResult('never', 'on-request').application).toBe('next_turn');
    expect(codexSwitchResult('on-request', 'untrusted').application).toBe('next_turn');
    expect(codexSwitchResult('untrusted', 'never').application).toBe('gate');
    expect(codexSwitchResult('on-request', 'never').application).toBe('gate');
    expect(codexSwitchResult('never', 'never').application).toBe('gate');
  });
});

describe('OpenCode: start ruleset fixed, asks follow the live mode', () => {
  it('reports partial when the start ruleset allowed what the new mode would ask or deny', () => {
    expect(opencodeSwitchResult('allow-all', 'ask-all', true).application).toBe('partial');
    expect(opencodeSwitchResult('ask-sensitive', 'ask-all', true)).toMatchObject({ application: 'partial' });
    expect(opencodeSwitchResult('ask-sensitive', 'ask-all', true).detail).toContain('read');
    expect(opencodeSwitchResult('ask-sensitive', 'deny-sensitive', true).detail).toContain('edit');
    expect(opencodeSwitchResult('ask-all', 'deny-sensitive', true).application).toBe('gate');
    expect(opencodeSwitchResult('ask-all', 'allow-all', true).application).toBe('gate');
    expect(opencodeSwitchResult('ask-sensitive', 'allow-all', true).application).toBe('gate');
  });

  it('decides an asked permission by the live mode', () => {
    expect(opencodeLiveAction('bash', 'allow-all', true)).toBe('allow');
    expect(opencodeLiveAction('question', 'allow-all', true)).toBe('deny');
    expect(opencodeLiveAction('bash', 'deny-sensitive', true)).toBe('deny');
    expect(opencodeLiveAction('read', 'ask-sensitive', true)).toBe('allow');
    expect(opencodeLiveAction('bash', 'ask-sensitive', true)).toBe('ask');
    expect(opencodeLiveAction('mcp_tool_x', 'ask-all', true)).toBe('ask');
    expect(opencodeLiveAction('mcp_tool_x', 'allow-all', true)).toBe('allow');
  });
});

describe('Pi: the gate asks the adapter for the live mode', () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;

  async function loadGate(policy: string): Promise<Handler> {
    const file = join(root, `gate-${String(Math.random()).slice(2)}.mjs`);
    writeFileSync(file, PI_GATE_SOURCE);
    process.env[PI_GATE_POLICY_ENV] = policy;
    const mod = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void };
    let handler: Handler | undefined;
    mod.default({
      on: (name: string, h: Handler) => {
        if (name === 'tool_call') handler = h;
      },
    });
    Reflect.deleteProperty(process.env, PI_GATE_POLICY_ENV);
    if (!handler) throw new Error('no handler');
    return handler;
  }

  /** Answers the policy dialog with `mode` and an approval dialog with `answer`; records the titles. */
  function ui(mode: string | undefined, answer: string | undefined) {
    const titles: string[] = [];
    return {
      titles,
      ctx: {
        hasUI: true,
        ui: {
          select: (title: string, options: string[]) => {
            titles.push(title);
            if (title.startsWith(PI_POLICY_MARKER)) {
              expect(options).toEqual(['ask-all', 'ask-sensitive', 'deny-sensitive', 'allow-all']);
              return Promise.resolve(mode);
            }
            expect(title.startsWith(PI_GATE_MARKER)).toBe(true);
            return Promise.resolve(answer);
          },
        },
      },
    };
  }
  const bash = { toolCallId: 't', toolName: 'bash', input: { command: 'make' } };
  const read = { toolCallId: 't', toolName: 'read', input: { path: 'a' } };

  it('follows the mode the adapter answers, call by call', async () => {
    const h = await loadGate(JSON.stringify(piGatePolicy('allow-all', 1000, undefined, true)));
    // Started allow-all, switched to ask-all: the read asks now.
    const a = ui('ask-all', 'deny');
    expect(await h(read, a.ctx)).toMatchObject({ block: true });
    expect(a.titles.map((t) => t.slice(0, 16))).toEqual([
      PI_POLICY_MARKER.slice(0, 16),
      PI_GATE_MARKER.slice(0, 16),
    ]);
    // deny-sensitive: bash blocked without asking a human.
    const d = ui('deny-sensitive', 'approve');
    expect(await h(bash, d.ctx)).toMatchObject({ block: true });
    expect(d.titles).toHaveLength(1);
    // allow-all again: nothing asked after the policy question.
    const f = ui('allow-all', 'deny');
    expect(await h(bash, f.ctx)).toBeUndefined();
    expect(f.titles).toHaveLength(1);
  });

  it('blocks when the adapter gives no valid mode (fail closed)', async () => {
    const h = await loadGate(JSON.stringify(piGatePolicy('allow-all', 1000, undefined, true)));
    expect(await h(bash, ui(undefined, 'approve').ctx)).toMatchObject({ block: true });
    expect(await h(bash, ui('yolo', 'approve').ctx)).toMatchObject({ block: true });
  });

  it('without a live flag the gate keeps its start mode (older behaviour)', async () => {
    const h = await loadGate(JSON.stringify(piGatePolicy('allow-all', 1000)));
    const never = ui('ask-all', 'deny');
    expect(await h(bash, never.ctx)).toBeUndefined();
    expect(never.titles).toHaveLength(0);
  });

  it('the mapper turns the policy dialog into a policy query, and the gate mode stays fail-closed', () => {
    const mapper = new PiEventMapper({ secrets: {}, authMode: 'secret-ref' });
    const actions = mapper.map({
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'select',
      title: `${PI_POLICY_MARKER}{}`,
      options: ['ask-all', 'ask-sensitive', 'deny-sensitive', 'allow-all'],
    } as never);
    expect(actions).toEqual([{ kind: 'policy-query', uiId: 'ui-1' }]);
    expect(piGateMode('ask-all', false)).toBe('deny-sensitive');
    expect(piGateMode('allow-all', false)).toBe('allow-all');
    expect(piGateMode('ask-sensitive', true)).toBe('ask-sensitive');
  });
});
