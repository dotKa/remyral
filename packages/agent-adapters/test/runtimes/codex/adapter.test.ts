import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptId, JobId } from '@remyral/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  appServerArgs,
  CapabilityUnsupportedError,
  CODEX_API_KEY_PROVIDER,
  codexApiKeyEnv,
  codexApprovalPolicy,
  codexIsolatedThreadConfig,
  codexSandboxPolicy,
  CODEX_ASSISTANT_OVERRIDES,
  CODEX_USER_CONFIG_ISOLATION_OVERRIDES,
  codexAssistantArgs,
  createCodexAdapter,
  InvalidSpawnContextError,
  SecretValue,
  threadStartParams,
  tomlString,
  VersionMismatchError,
  type CodexAdapter,
  type CodexAdapterOptions,
  type ProcessConfiner,
  type SequencedEvent,
  type SessionRef,
  type SpawnContext,
  type SpawnPlan,
  SUBTASK_TOOL_NAMES,
  type SubtaskToolHost,
  PREVIEW_TOOL_NAMES,
  type PreviewToolHost,
} from '../../../src/index.js';
import { collectUntilStopped, readUntil } from '../../../src/testing/index.js';
import { codexTestStateDir, FAKE_APP_SERVER } from '../../fixtures/codex/helpers.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const stateDir = codexTestStateDir();
const wsRoot = mkdtempSync(join(tmpdir(), 'remyral-codex-unit-'));
const opened: { adapter: CodexAdapter; ref: SessionRef }[] = [];
afterEach(async () => {
  for (const { adapter, ref } of opened.splice(0)) await adapter.cleanup(ref);
});
afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(wsRoot, { recursive: true, force: true });
});

function ctx(overrides: Partial<SpawnContext> = {}): SpawnContext {
  return {
    jobId: JobId.parse('job-codex-unit'),
    attemptId: AttemptId.parse('attempt-1'),
    workspaceRoot: mkdtempSync(join(wsRoot, 'ws-')),
    job: { runtime: 'codex', prompt: 'p', limits: { maxDurationSec: 60 } },
    sandboxProfile: 'runtime-sandbox',
    approvalPolicy: 'ask-sensitive',
    repositoryTrust: 'untrusted',
    repoConfig: 'ignore-repository-config',
    secretEnv: {},
    timeouts: {
      startupMs: 10_000,
      cancelGraceMs: 500,
      cancelMs: 2_000,
      approvalMs: 5_000,
      maxDurationMs: 60_000,
    },
    allowUnverified: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function make(extra: CodexAdapterOptions = {}): CodexAdapter {
  return createCodexAdapter({
    codexPath: FAKE_APP_SERVER,
    stateDir,
    sourceEnv: { ...process.env, OPENAI_API_KEY: 'worker-own-key-must-not-leak', CODEX_API_KEY: 'x' },
    ...extra,
  });
}

async function start(adapter: CodexAdapter, c: SpawnContext, prompt: string): Promise<SessionRef> {
  await adapter.probe();
  const ref = await adapter.spawn(c);
  opened.push({ adapter, ref });
  await adapter.sendPrompt(ref, { text: prompt });
  return ref;
}

interface FakeRecord {
  pid: number;
  grandchild: number;
  argv: string[];
  envNames: string[];
  codexHome: string | null;
}

async function record(ws: string): Promise<FakeRecord> {
  const file = join(ws, '.fake-codex.json');
  const end = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error('fake app-server did not record itself');
    await new Promise((r) => setTimeout(r, 20));
  }
  return JSON.parse(readFileSync(file, 'utf8')) as FakeRecord;
}

async function lastDecision(ws: string): Promise<string> {
  const file = join(ws, '.fake-codex-decision.json');
  const end = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error('no decision recorded');
    await new Promise((r) => setTimeout(r, 20));
  }
  return (JSON.parse(readFileSync(file, 'utf8')) as { lastDecision: string }).lastDecision;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

const kinds = (events: SequencedEvent[]) => events.map((e) => e.event.kind);

describe('codex config builders (verified against codex-cli 0.162.1)', () => {
  it('app-server argv: no daemon, strict config, repo config untrusted, no history, secrets excluded from tools', () => {
    const args = appServerArgs({
      authMode: 'secret-ref',
      workspaceRoot: '/w/a "b"\\c',
      repositoryTrust: 'untrusted',
      secretNames: ['CODEX_API_KEY', 'REMYRAL_X'],
    });
    expect(args.slice(0, 5)).toEqual([
      '--no-daemon',
      'app-server',
      '--listen',
      'stdio://',
      '--strict-config',
    ]);
    expect(args).toContain('projects={ "/w/a \\"b\\"\\\\c" = { trust_level = "untrusted" } }');
    expect(args).toContain('history.persistence="none"');
    // p8-codex-images: image generation stays on for jobs whatever the worker user's config says.
    expect(args).toContain('features.image_generation=true');
    expect(args).toContain('cli_auth_credentials_store="ephemeral"');
    expect(args).toContain('project_doc_max_bytes=0');
    expect(args.find((a) => a.startsWith('shell_environment_policy.exclude='))).toBe(
      'shell_environment_policy.exclude=["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "REMYRAL_X"]',
    );
    const login = appServerArgs({
      authMode: 'local-login',
      workspaceRoot: '/w',
      repositoryTrust: 'trusted',
      secretNames: [],
    });
    expect(login).not.toContain('cli_auth_credentials_store="ephemeral"');
    expect(login).not.toContain('project_doc_max_bytes=0');
    expect(() => tomlString('a\nb')).toThrow(InvalidSpawnContextError);
  });

  it('p14-codex-mcp-isolation: every job app-server switches off user hooks, plugins, apps, notify … (shared with the assistant)', () => {
    expect(CODEX_USER_CONFIG_ISOLATION_OVERRIDES).toEqual([
      'features.hooks=false',
      'features.plugins=false',
      'features.remote_plugin=false',
      'features.apps=false',
      'features.skill_mcp_dependency_install=false',
      'features.computer_use=false',
      'features.browser_use=false',
      'features.browser_use_external=false',
      'features.memories=false',
      'notify=[]',
    ]);
    for (const authMode of ['local-login', 'secret-ref'] as const) {
      const args = appServerArgs({
        authMode,
        workspaceRoot: '/w',
        repositoryTrust: 'trusted',
        secretNames: [],
      });
      for (const o of CODEX_USER_CONFIG_ISOLATION_OVERRIDES) {
        expect(args[args.indexOf(o) - 1]).toBe('-c');
      }
      // Never switched on for a job.
      expect(args.some((a) => /^features\.(hooks|plugins|apps|remote_plugin)=true/.test(a))).toBe(false);
    }
    // The assistant gets the same set (once) plus its own stricter one.
    const assistant = codexAssistantArgs({ cwd: '/s', authMode: 'local-login' });
    for (const o of [...CODEX_USER_CONFIG_ISOLATION_OVERRIDES, ...CODEX_ASSISTANT_OVERRIDES]) {
      expect(assistant.filter((a) => a === o)).toHaveLength(1);
    }
    expect(codexIsolatedThreadConfig(['a', 'b.c'])).toEqual({
      mcp_servers: { a: { enabled: false }, 'b.c': { enabled: false } },
      notify: [],
    });
  });

  it('p6-codex-apikey-fix: secret-ref with an API key routes through the key provider entry (name only, never the value)', () => {
    const base = {
      authMode: 'secret-ref' as const,
      workspaceRoot: '/w',
      repositoryTrust: 'trusted' as const,
    };
    const keyed = appServerArgs({ ...base, secretNames: ['CODEX_API_KEY', 'REMYRAL_X'] });
    expect(keyed).toContain(
      'model_providers.remyral-openai={ name = "OpenAI (API key)", base_url = "https://api.openai.com/v1", env_key = "CODEX_API_KEY", wire_api = "responses" }',
    );
    expect(keyed).toContain('model_provider="remyral-openai"');
    expect(keyed.filter((a) => a.startsWith('model_provider')).length).toBe(2);
    // OPENAI_API_KEY alone is used too; CODEX_API_KEY wins when both are injected (as in the SDK).
    expect(appServerArgs({ ...base, secretNames: ['OPENAI_API_KEY'] }).join(' ')).toContain(
      'env_key = "OPENAI_API_KEY"',
    );
    expect(codexApiKeyEnv(['OPENAI_API_KEY', 'CODEX_API_KEY'])).toBe('CODEX_API_KEY');
    expect(codexApiKeyEnv(['CODEX_ACCESS_TOKEN'])).toBeUndefined();
    // A gateway / test endpoint.
    expect(
      appServerArgs({ ...base, secretNames: ['CODEX_API_KEY'], apiBaseUrl: 'http://127.0.0.1:9/v1' }).join(
        ' ',
      ),
    ).toContain('base_url = "http://127.0.0.1:9/v1"');
    expect(() =>
      appServerArgs({ ...base, secretNames: ['CODEX_API_KEY'], apiBaseUrl: 'file:///etc/passwd' }),
    ).toThrow(InvalidSpawnContextError);
    expect(() =>
      appServerArgs({ ...base, secretNames: ['CODEX_API_KEY'], apiBaseUrl: 'https://x/" , env_key = "Y' }),
    ).toThrow(InvalidSpawnContextError);
    // No key injected, or subscription (local-login): Codex's own provider and login, unchanged.
    for (const args of [
      appServerArgs({ ...base, secretNames: ['REMYRAL_X'] }),
      appServerArgs({ ...base, authMode: 'local-login', secretNames: [] }),
    ]) {
      expect(args.some((a) => a.startsWith('model_provider'))).toBe(false);
    }
  });

  it('approval and sandbox mapping', () => {
    expect(codexApprovalPolicy('ask-all')).toBe('untrusted');
    expect(codexApprovalPolicy('ask-sensitive')).toBe('on-request');
    expect(codexApprovalPolicy('deny-sensitive')).toBe('never');
    expect(codexApprovalPolicy('allow-all')).toBe('never');
    expect(codexSandboxPolicy('runtime-sandbox')).toEqual({
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: false,
    });
    // p6-warm-caches (ADR-0029): the project's shared package cache is a writable root of the Codex sandbox.
    expect(codexSandboxPolicy('runtime-sandbox', ['/d/caches/host/k'])).toMatchObject({
      type: 'workspaceWrite',
      writableRoots: ['/d/caches/host/k'],
      networkAccess: false,
    });
    expect(codexSandboxPolicy('container')).toEqual({ type: 'externalSandbox', networkAccess: 'restricted' });
    expect(codexSandboxPolicy('host-restricted')).toEqual({
      type: 'externalSandbox',
      networkAccess: 'restricted',
    });
    expect(threadStartParams({ cwd: '/w', approvalPolicy: 'ask-all' })).toMatchObject({
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      ephemeral: false,
    });
  });
});

describePosix('codex adapter against the fake app-server', () => {
  it('secret-ref: key reaches the app-server env only (not argv), per-session CODEX_HOME removed on cleanup', async () => {
    const plans: SpawnPlan[] = [];
    const confiner: ProcessConfiner = {
      kind: 'test:passthrough',
      confine: (plan) => {
        plans.push(plan);
        return Promise.resolve({ command: plan.command, args: plan.args, cwd: plan.cwd, env: plan.env });
      },
    };
    const adapter = make({ confinerFor: () => confiner });
    const key = new SecretValue('sk-proj-canary-0123456789');
    const c = ctx({ secretEnv: { CODEX_API_KEY: key } });
    const ref = await start(adapter, c, 'basic task');
    const rec = await record(c.workspaceRoot);
    expect(rec.envNames).toContain('CODEX_API_KEY');
    expect(rec.envNames).not.toContain('OPENAI_API_KEY');
    expect(rec.argv.join(' ')).not.toContain(key.reveal());
    expect(rec.codexHome).toMatch(/home-/);
    expect(rec.codexHome?.startsWith(stateDir)).toBe(true);
    expect(plans[0]?.secretNames).toEqual(['CODEX_API_KEY']);
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(JSON.stringify(events)).not.toContain(key.reveal());
    expect(adapter.threadInfo(ref)).toMatchObject({ approvalsReviewer: 'user', instructionSources: [] });
    await adapter.cleanup(ref);
    opened.length = 0;
    expect(existsSync(rec.codexHome ?? '/nonexistent')).toBe(false);
  });

  it('p6-codex-apikey-fix: the thread runs on the key provider; usage keeps provider openai; fails closed otherwise', async () => {
    const key = new SecretValue('sk-proj-canary-0123456789');
    const adapter = make();
    const c = ctx({ secretEnv: { CODEX_API_KEY: key } });
    const ref = await start(adapter, c, 'basic task');
    const rec = await record(c.workspaceRoot);
    expect(rec.argv).toContain(`model_provider="${CODEX_API_KEY_PROVIDER}"`);
    expect(rec.argv.join(' ')).not.toContain(key.reveal());
    expect(adapter.threadInfo(ref)).toMatchObject({ modelProvider: CODEX_API_KEY_PROVIDER });
    const events = await collectUntilStopped(adapter, ref, 10_000);
    const usage = events.map((e) => e.event).find((e) => e.kind === 'usage');
    expect(usage).toMatchObject({ provider: 'openai', authMode: 'secret-ref' });

    // A Codex that ignores the provider override would send requests without the key: the spawn is refused.
    const stripping: ProcessConfiner = {
      kind: 'test:strip-provider',
      confine: (plan) =>
        Promise.resolve({
          command: plan.command,
          args: plan.args.filter(
            (a, i, all) =>
              !a.startsWith('model_provider') && !(a === '-c' && all[i + 1]?.startsWith('model_provider')),
          ),
          cwd: plan.cwd,
          env: plan.env,
        }),
    };
    const ignoring = make({ confinerFor: () => stripping });
    await ignoring.probe();
    await expect(ignoring.spawn(ctx({ secretEnv: { CODEX_API_KEY: key } }))).rejects.toThrow(
      /not the API-key provider remyral-openai/,
    );
  });

  it('p5-git-identity: the job commit identity (GIT_AUTHOR_* / GIT_COMMITTER_*) reaches the app-server env', async () => {
    const adapter = make({
      sourceEnv: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Ada',
        GIT_AUTHOR_EMAIL: 'ada@example.com',
        GIT_COMMITTER_NAME: 'Ada',
        GIT_COMMITTER_EMAIL: 'ada@example.com',
      },
    });
    const c = ctx({ secretEnv: { CODEX_API_KEY: new SecretValue('sk-proj-canary-0123456789') } });
    const ref = await start(adapter, c, 'basic task');
    const rec = await record(c.workspaceRoot);
    for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
      expect(rec.envNames).toContain(name);
    }
    await collectUntilStopped(adapter, ref, 10_000);
  });

  it('p6-skills: verified skills land in the private CODEX_HOME/skills; repository skills are disabled by path', async () => {
    const adapter = make();
    expect(adapter.skillDelivery()).toBe('native');
    const c = ctx({
      skills: [
        {
          id: 'release-notes',
          version: '1.0.0',
          title: 'Release notes',
          description: 'd',
          files: [
            {
              path: 'SKILL.md',
              content: '---\nname: release-notes\ndescription: d\n---\nx\n',
              executable: false,
            },
          ],
        },
      ],
    });
    mkdirSync(join(c.workspaceRoot, '.agents', 'skills', 'evil'), { recursive: true });
    writeFileSync(join(c.workspaceRoot, '.agents', 'skills', 'evil', 'SKILL.md'), 'evil');
    const ref = await start(adapter, c, 'basic task');
    const rec = await record(c.workspaceRoot);
    expect(readFileSync(join(rec.codexHome ?? '', 'skills', 'release-notes', 'SKILL.md'), 'utf8')).toContain(
      'release-notes',
    );
    expect(existsSync(join(c.workspaceRoot, 'release-notes'))).toBe(false);
    expect(rec.argv.join(' ')).toContain(
      `skills.config=[{ path = "${join(c.workspaceRoot, '.agents/skills/evil/SKILL.md')}", enabled = false }]`,
    );
    await collectUntilStopped(adapter, ref, 10_000);
    await adapter.cleanup(ref);
    opened.length = 0;
  });

  it('p13-runtime-accounts: local-login with an account dir runs with CODEX_HOME = that dir', async () => {
    const dir = join(stateDir, 'runtime-accounts', 'codex', 'a1b2c3d4', '.codex');
    const adapter = make({ authMode: 'local-login', loginDir: dir, sourceEnv: { PATH: process.env.PATH } });
    const c = ctx();
    const ref = await start(adapter, c, 'basic');
    expect((await record(c.workspaceRoot)).codexHome).toBe(dir);
    await collectUntilStopped(adapter, ref, 10_000);
  });

  it('p14-codex-mcp-isolation: MCP servers of the user config.toml in CODEX_HOME are disabled on thread/start, never started', async () => {
    const dir = mkdtempSync(join(stateDir, 'user-home-'));
    writeFileSync(
      join(dir, 'config.toml'),
      [
        'notify = ["/bin/sh", "-c", "touch /tmp/remyral-notify-marker"]',
        '[mcp_servers.evil]',
        'command = "/bin/sh"',
        'args = ["-c", "touch /tmp/remyral-mcp-marker"]',
        '[mcp_servers."dotted.name"]',
        'url = "https://mcp.example.invalid/mcp"',
        '',
      ].join('\n'),
    );
    const adapter = make({ authMode: 'local-login', loginDir: dir, sourceEnv: { PATH: process.env.PATH } });
    const c = ctx();
    const ref = await start(adapter, c, 'basic');
    const events = await collectUntilStopped(adapter, ref, 10_000);
    const rec = await readJson<StartRecord>(join(c.workspaceRoot, '.fake-codex-start.json'));
    expect(rec.method).toBe('thread/start');
    expect(rec.config).toEqual({
      mcp_servers: { evil: { enabled: false }, 'dotted.name': { enabled: false } },
      notify: [],
    });
    expect(events.some((e) => e.event.kind === 'error')).toBe(false);
    expect((await adapter.collectResult(ref)).outcome).toBe('succeeded');
  });

  it('p14-codex-mcp-isolation: an MCP server that starts anyway fails the job closed (mcp_isolation_failed)', async () => {
    const adapter = make();
    const ref = await start(adapter, ctx(), 'mcp-start');
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(events.some((e) => e.event.kind === 'error' && e.event.code === 'mcp_isolation_failed')).toBe(
      true,
    );
    const result = await adapter.collectResult(ref);
    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('mcp_isolation_failed');
  });

  it('local-login: refuses provider keys, no CODEX_HOME override', async () => {
    const adapter = make({ authMode: 'local-login', sourceEnv: { PATH: process.env.PATH } });
    await adapter.probe();
    await expect(
      adapter.spawn(ctx({ secretEnv: { OPENAI_API_KEY: new SecretValue('sk-x') } })),
    ).rejects.toBeInstanceOf(InvalidSpawnContextError);
    const c = ctx();
    const ref = await start(adapter, c, 'basic');
    expect((await record(c.workspaceRoot)).codexHome).toBeNull();
    await collectUntilStopped(adapter, ref, 10_000);
    expect((await adapter.probe()).authenticated).toBe('no');
  });

  it('maps items, usage (tokens only, uncached input), diff and result', async () => {
    const adapter = make();
    const ref = await start(adapter, ctx(), 'basic task');
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(kinds(events)).toEqual([
      'status',
      'message',
      'status',
      'message',
      'tool_call',
      'tool_result',
      'message',
      'usage',
      'status',
    ]);
    const usage = events.map((e) => e.event).find((e) => e.kind === 'usage');
    expect(usage).toEqual({
      kind: 'usage',
      inputTokens: 80,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      turns: 1,
      durationMs: 42,
      provider: 'openai',
      model: 'gpt-6.1-sol',
      authMode: 'secret-ref',
      provenance: 'estimated-from-tokens',
    });
    const result = await adapter.collectResult(ref);
    expect(result).toMatchObject({
      outcome: 'succeeded',
      summary: 'done',
      diff: 'diff --git a/x b/x\n+hello\n',
    });
    expect(await adapter.getCost(ref)).toEqual({ provenance: 'unknown' });
  });

  it('collectResult carries no diff when artifacts are not offered', async () => {
    const adapter = make();
    const ref = await start(adapter, ctx({ allowUnverified: false }), 'basic');
    await collectUntilStopped(adapter, ref, 10_000);
    expect(await adapter.collectResult(ref)).not.toHaveProperty('diff');
  });

  it('approval: approve → accept', async () => {
    const adapter = make();
    const c = ctx();
    const ref = await start(adapter, c, 'needs approval');
    const seen = await readUntil(adapter, ref, (e) => e.event.kind === 'approval_request', 5000);
    expect(seen.at(-1)?.event).toMatchObject({ kind: 'approval_request', action: 'shell', risk: 'high' });
    // p10-approval-readable: Codex `reason` is the agent's explanation; command and cwd as fields.
    expect(seen.at(-1)?.event).toMatchObject({
      details: {
        tool: 'shell',
        description: 'needs network',
        command: 'git push origin work',
        cwd: c.workspaceRoot,
      },
    });
    const last = seen.at(-1)?.event;
    const id = last?.kind === 'approval_request' ? last.approvalId : undefined;
    expect(id).toBeDefined();
    await adapter.requestApproval(ref, { approvalId: id ?? '', decision: 'approve', decidedBy: 'alice' });
    await collectUntilStopped(adapter, ref, 10_000);
    expect(await lastDecision(c.workspaceRoot)).toBe('accept');
    expect((await adapter.collectResult(ref)).outcome).toBe('succeeded');
  });

  it('approval: timeout → decline (fail closed)', async () => {
    const adapter = make();
    const c = ctx({
      timeouts: {
        startupMs: 10_000,
        cancelGraceMs: 500,
        cancelMs: 2_000,
        approvalMs: 150,
        maxDurationMs: 60_000,
      },
    });
    const ref = await start(adapter, c, 'needs approval');
    await collectUntilStopped(adapter, ref, 10_000);
    expect(await lastDecision(c.workspaceRoot)).toBe('decline');
  });

  it('approval: deny-sensitive never asks; not offered → decline + approval_unavailable', async () => {
    const a1 = make();
    const c1 = ctx({ approvalPolicy: 'deny-sensitive' });
    const r1 = await start(a1, c1, 'needs approval');
    const e1 = await collectUntilStopped(a1, r1, 10_000);
    expect(kinds(e1)).not.toContain('approval_request');
    expect(await lastDecision(c1.workspaceRoot)).toBe('decline');

    const a2 = make();
    const c2 = ctx({ allowUnverified: false });
    const r2 = await start(a2, c2, 'needs approval');
    const e2 = await collectUntilStopped(a2, r2, 10_000);
    expect(e2.map((e) => e.event)).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'approval_unavailable' }),
    );
    expect(await lastDecision(c2.workspaceRoot)).toBe('decline');
    await expect(
      a2.requestApproval(r2, { approvalId: 'x', decision: 'approve', decidedBy: 'a' }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
  });

  it('approval: allow-all (ADR-0020) never asks a human; a request that still arrives is accepted', async () => {
    const adapter = make();
    const c = ctx({ approvalPolicy: 'allow-all' });
    const ref = await start(adapter, c, 'needs approval');
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(kinds(events)).not.toContain('approval_request');
    expect(await lastDecision(c.workspaceRoot)).toBe('accept');
  });

  it('follow-up prompt steers the running turn (turn/steer with expectedTurnId)', async () => {
    const adapter = make();
    const ref = await start(adapter, ctx(), 'long running');
    await readUntil(adapter, ref, (e) => e.event.kind === 'tool_call', 5000);
    await expect(adapter.sendPrompt(ref, { text: 'also do X' })).resolves.toBeUndefined();
    await adapter.cancel(ref);
  });

  // p15-message-delivery: receipts and refusals.
  const userTexts = (events: readonly SequencedEvent[]) =>
    events.flatMap((e) => (e.event.kind === 'message' && e.event.role === 'user' ? [e.event.text] : []));

  it('p15: a steer while an approval is pending is accepted, recorded, and read at the next agent output', async () => {
    const adapter = make();
    const ref = await start(adapter, ctx(), 'needs approval');
    const seen = await readUntil(adapter, ref, (e) => e.event.kind === 'approval_request', 5000);
    const last = seen.at(-1)?.event;
    const receipts: { kind: string }[] = [];
    await adapter.sendPrompt(ref, { text: 'push to staging', onReceipt: (r) => receipts.push(r) });
    expect(receipts).toEqual([]);
    await adapter.requestApproval(ref, {
      approvalId: last?.kind === 'approval_request' ? last.approvalId : '',
      decision: 'approve',
      decidedBy: 'alice',
    });
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(userTexts(events)).toContain('push to staging');
    expect(receipts.map((r) => r.kind)).toEqual(['consumed']);
  });

  it('p15: a steered message the agent never answered is reported dropped when the run ends', async () => {
    const adapter = make();
    const ref = await start(adapter, ctx(), 'long running');
    await readUntil(adapter, ref, (e) => e.event.kind === 'tool_call', 5000);
    const receipts: { kind: string }[] = [];
    await adapter.sendPrompt(ref, { text: 'also do Y', onReceipt: (r) => receipts.push(r) });
    await adapter.cancel(ref);
    await collectUntilStopped(adapter, ref, 5_000).catch(() => []);
    expect(receipts.map((r) => r.kind)).toEqual(['dropped']);
  });

  it('p15: after the turn ended a follow-up is refused and never shown as sent', async () => {
    const adapter = make();
    const ref = await start(adapter, ctx(), 'hello');
    const before = await collectUntilStopped(adapter, ref, 10_000);
    await expect(adapter.sendPrompt(ref, { text: 'too late' })).rejects.toThrow(/cannot send a prompt/);
    expect(userTexts(before)).not.toContain('too late');
  });

  it('cancel: turn/interrupt then EOF, graceful; process tree reaped', async () => {
    const adapter = make();
    const c = ctx();
    const ref = await start(adapter, c, 'long running');
    const rec = await record(c.workspaceRoot);
    await readUntil(adapter, ref, (e) => e.event.kind === 'tool_call', 5000);
    const outcome = await adapter.cancel(ref, 'user');
    expect(outcome.mode).toBe('graceful');
    const events = await collectUntilStopped(adapter, ref, 2000);
    expect(kinds(events)).toContain('usage');
    expect((await adapter.collectResult(ref)).outcome).toBe('cancelled');
    expect(await waitDead(rec.pid)).toBe(true);
    expect(await waitDead(rec.grandchild)).toBe(true);
  });

  it('a crashing app-server ends the session failed (runtime_crashed)', async () => {
    const adapter = make();
    const ref = await start(adapter, ctx(), 'crash now');
    const events = await collectUntilStopped(adapter, ref, 10_000);
    expect(events.map((e) => e.event)).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'runtime_crashed' }),
    );
    expect(await adapter.collectResult(ref)).toMatchObject({
      outcome: 'failed',
      errorCode: 'runtime_crashed',
    });
  });

  it('cleanup of a running session kills the tree', async () => {
    const adapter = make();
    const c = ctx();
    const ref = await start(adapter, c, 'long running');
    const rec = await record(c.workspaceRoot);
    await adapter.cleanup(ref);
    expect(await waitDead(rec.pid)).toBe(true);
    expect(await waitDead(rec.grandchild)).toBe(true);
  });

  it('version gate: a non-pinned codex is refused unless policy allows unverified', async () => {
    const dir = mkdtempSync(join(wsRoot, 'bin-'));
    const fake = join(dir, 'codex');
    writeFileSync(fake, '#!/bin/sh\necho "codex-cli 0.163.0"\n');
    chmodSync(fake, 0o755);
    const adapter = make({ codexPath: fake });
    const probe = await adapter.probe();
    expect(probe.version).toBe('0.163.0');
    expect(probe.versionMatchesPin).toBe(false);
    for (const e of Object.values(probe.capabilities.capabilities))
      expect(['unverified', 'unsupported']).toContain(e.status);
    await expect(adapter.spawn(ctx({ allowUnverified: false }))).rejects.toBeInstanceOf(VersionMismatchError);
  });

  it('p8-codex-images: generated images are copied into out/generated-images of a workspace job', async () => {
    const adapter = make();
    const c = ctx({ workspaceJob: true });
    mkdirSync(join(c.workspaceRoot, 'out'));
    const ref = await start(adapter, c, 'make an image');
    const events = (await collectUntilStopped(adapter, ref, 10_000)).map((e) => e.event);
    expect((await adapter.collectResult(ref)).outcome).toBe('succeeded');
    const calls = events.filter((e) => e.kind === 'tool_call' && e.toolName === 'image_generation');
    expect(calls).toHaveLength(3);
    const results = events.filter((e) => e.kind === 'tool_result');
    expect(results).toContainEqual(
      expect.objectContaining({ ok: true, outputSummary: 'image saved to out/generated-images/ig_one.png' }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({ ok: true, outputSummary: 'image saved to out/generated-images/ig_two.png' }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        ok: false,
        outputSummary: expect.stringContaining('not a PNG, JPEG or WebP') as unknown,
      }),
    );
    const one = readFileSync(join(c.workspaceRoot, 'out', 'generated-images', 'ig_one.png'));
    const two = readFileSync(join(c.workspaceRoot, 'out', 'generated-images', 'ig_two.png'));
    // ig_two's savedPath was outside CODEX_HOME: the base64 result was used, not that file.
    expect(two.equals(one)).toBe(true);
    expect(one.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
  });

  it('p8-codex-images: a repository job gets nothing written, even with an out/ folder; the event says where Codex saved it', async () => {
    const adapter = make();
    const c = ctx();
    mkdirSync(join(c.workspaceRoot, 'out'));
    const ref = await start(adapter, c, 'make an image');
    const events = (await collectUntilStopped(adapter, ref, 10_000)).map((e) => e.event);
    expect(existsSync(join(c.workspaceRoot, 'out', 'generated-images'))).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool_result',
        ok: true,
        outputSummary: expect.stringContaining(
          'not copied: a repository job keeps its worktree unchanged',
        ) as unknown,
      }),
    );
  });

  it('p8-codex-images: a workspace job without out/ gets nothing written', async () => {
    const adapter = make();
    const c = ctx({ workspaceJob: true });
    const ref = await start(adapter, c, 'make an image');
    const events = (await collectUntilStopped(adapter, ref, 10_000)).map((e) => e.event);
    expect(existsSync(join(c.workspaceRoot, 'out'))).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool_result',
        ok: true,
        outputSummary: expect.stringContaining('not copied: this job has no out/ directory') as unknown,
      }),
    );
  });

  it('refuses a CODEX_HOME root under /tmp on Linux', async () => {
    const adapter = make({ stateDir: '/tmp', platform: 'linux' });
    await adapter.probe();
    await expect(adapter.spawn(ctx())).rejects.toBeInstanceOf(InvalidSpawnContextError);
  });
});

// ------------------------------------------------------------------------------------------- sub-job tools

async function readJson<T>(file: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error(`${file} was not written`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

interface StartRecord {
  capabilities: { experimentalApi?: boolean } | null;
  method: string;
  config: Record<string, unknown> | null;
  dynamicTools:
    { type: string; name: string; description: string; inputSchema: Record<string, unknown> }[] | null;
}
interface ToolRecord {
  answer: { contentItems: { type: string; text: string }[]; success: boolean } | null;
  interrupted: boolean;
}

function subtaskHost(opts: { blockWait?: boolean } = {}) {
  const calls: unknown[][] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const host: SubtaskToolHost = {
    request: (args, signal) => {
      calls.push(['request', args]);
      signals.push(signal);
      return Promise.resolve({ ok: true, text: 'Sub-job 7d0c "API" (codex): queued. MARKER-QUEUED' });
    },
    wait: (id, waitSec, signal) => {
      calls.push(['wait', id, waitSec]);
      signals.push(signal);
      if (opts.blockWait !== true) return Promise.resolve({ ok: true, text: 'running' });
      return new Promise((resolve) => {
        signal?.addEventListener(
          'abort',
          () => {
            resolve({ ok: true, text: 'Still running. MARKER-ABORTED' });
          },
          { once: true },
        );
      });
    },
    cancel: (id) => {
      calls.push(['cancel', id]);
      return Promise.resolve({ ok: true, text: 'cancelled' });
    },
  };
  return { host, calls, signals };
}

const SUB_ID = '00000000-0000-4000-8000-0000000000e2';

describePosix('codex adapter: sub-job tools as app-server dynamic tools (p8-subtasks-codex)', () => {
  it('is an adapter that offers sub-job tools', () => {
    expect(make().offersSubtaskTools).toBe(true);
  });

  it('a job without sub-job tools: no experimental API opt-in, no dynamic tools, and a stray call is refused', async () => {
    const adapter = make();
    const c = ctx();
    const ref = await start(
      adapter,
      c,
      `subtask:request_subtask:${JSON.stringify({ title: 't', prompt: 'p' })}`,
    );
    await collectUntilStopped(adapter, ref, 10_000);
    const rec = await readJson<StartRecord>(join(c.workspaceRoot, '.fake-codex-start.json'));
    expect(rec.capabilities?.experimentalApi).toBe(false);
    expect(rec.dynamicTools).toBeNull();
    const tool = await readJson<ToolRecord>(join(c.workspaceRoot, '.fake-codex-tool.json'));
    expect(tool.answer?.success).toBe(false);
    expect(tool.answer?.contentItems[0]?.text).toMatch(/not available/);
  });

  it('declares the three tools (JSON Schema, paths included); a pre-approved call reaches the host and its text goes back', async () => {
    const adapter = make();
    const { host, calls, signals } = subtaskHost();
    // ask-all: the call still needs no human approval (the master's gates count, as for Claude Code).
    const c = ctx({ subtaskTools: host, approvalPolicy: 'ask-all' });
    const args = { title: 'API', prompt: 'Build it.', paths: ['src/api/', 'docs/api.md'], wait: false };
    const ref = await start(adapter, c, `subtask:request_subtask:${JSON.stringify(args)}`);
    const events = (await collectUntilStopped(adapter, ref, 10_000)).map((e) => e.event);
    const rec = await readJson<StartRecord>(join(c.workspaceRoot, '.fake-codex-start.json'));
    expect(rec.capabilities?.experimentalApi).toBe(true);
    expect(rec.method).toBe('thread/start');
    expect(rec.dynamicTools?.map((t) => t.name)).toEqual(SUBTASK_TOOL_NAMES);
    expect(rec.dynamicTools?.every((t) => t.type === 'function')).toBe(true);
    const request = rec.dynamicTools?.[0];
    expect(request?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: { paths: { type: 'array', maxItems: 32 } },
    });
    expect(request?.inputSchema).not.toHaveProperty('$schema');

    expect(calls).toEqual([
      [
        'request',
        {
          title: 'API',
          prompt: 'Build it.',
          runtime: undefined,
          requires: undefined,
          inputs: undefined,
          paths: ['src/api/', 'docs/api.md'],
          wait: false,
          waitSec: undefined,
        },
      ],
    ]);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    const tool = await readJson<ToolRecord>(join(c.workspaceRoot, '.fake-codex-tool.json'));
    expect(tool.answer).toEqual({
      contentItems: [{ type: 'inputText', text: 'Sub-job 7d0c "API" (codex): queued. MARKER-QUEUED' }],
      success: true,
    });
    expect(events.some((e) => e.kind === 'approval_request')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'tool_call', toolName: 'request_subtask' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool_result',
        ok: true,
        outputSummary: expect.stringContaining('MARKER-QUEUED') as unknown,
      }),
    );
    expect((await adapter.collectResult(ref)).outcome).toBe('succeeded');
  });

  it('invalid arguments and unknown tools never reach the host', async () => {
    const adapter = make();
    const { host, calls } = subtaskHost();
    const c1 = ctx({ subtaskTools: host });
    const r1 = await start(
      adapter,
      c1,
      `subtask:request_subtask:${JSON.stringify({ title: 't', prompt: 'p', paths: ['../escape'] })}`,
    );
    await collectUntilStopped(adapter, r1, 10_000);
    const t1 = await readJson<ToolRecord>(join(c1.workspaceRoot, '.fake-codex-tool.json'));
    expect(t1.answer?.success).toBe(false);
    expect(t1.answer?.contentItems[0]?.text).toMatch(/^invalid arguments: paths/);

    const c2 = ctx({ subtaskTools: host });
    const r2 = await start(adapter, c2, `subtask:run_shell:${JSON.stringify({ cmd: 'id' })}`);
    await collectUntilStopped(adapter, r2, 10_000);
    const t2 = await readJson<ToolRecord>(join(c2.workspaceRoot, '.fake-codex-tool.json'));
    expect(t2.answer?.success).toBe(false);
    expect(t2.answer?.contentItems[0]?.text).toMatch(/not available/);
    expect(calls).toEqual([]);
  });

  it('cancel aborts a waiting wait_subtask: the host sees the abort, the call is answered, the session stops', async () => {
    const adapter = make();
    const { host, calls, signals } = subtaskHost({ blockWait: true });
    const c = ctx({ subtaskTools: host });
    const ref = await start(
      adapter,
      c,
      `subtask:wait_subtask:${JSON.stringify({ subtaskId: SUB_ID, waitSec: 300 })}`,
    );
    await readUntil(adapter, ref, (e) => e.event.kind === 'tool_call', 5000);
    const end = Date.now() + 5000;
    while (calls.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([['wait', SUB_ID, 300]]);
    expect(signals[0]?.aborted).toBe(false);
    const outcome = await adapter.cancel(ref, 'user');
    expect(outcome.mode).not.toBe('already-stopped');
    expect(signals[0]?.aborted).toBe(true);
    expect((await adapter.collectResult(ref)).outcome).toBe('cancelled');
  });
});

describePosix('codex adapter: preview tools as app-server dynamic tools (p22-previews-inputs)', () => {
  function previewHost(withPublish = false) {
    const calls: unknown[][] = [];
    const host: PreviewToolHost = {
      ...(withPublish ? { tools: [...PREVIEW_TOOL_NAMES] } : {}),
      open: (a) => {
        calls.push(['open', a]);
        return Promise.resolve({ ok: true, text: 'Preview web: https://web-x.example.com MARKER-PREVIEW' });
      },
      close: (a) => {
        calls.push(['close', a]);
        return Promise.resolve({ ok: true, text: 'closed' });
      },
      list: () => {
        calls.push(['list']);
        return Promise.resolve({ ok: true, text: 'no previews' });
      },
      ...(withPublish
        ? {
            publish: (a: unknown) => {
              calls.push(['publish', a]);
              return Promise.resolve({ ok: true, text: 'recorded' });
            },
          }
        : {}),
    };
    return { host, calls };
  }

  it('a job with only preview tools declares exactly them; a pre-approved open_preview reaches the host', async () => {
    const adapter = make();
    const { host, calls } = previewHost();
    const c = ctx({ previewTools: host, sandboxProfile: 'host-restricted', approvalPolicy: 'ask-all' });
    const ref = await start(adapter, c, `subtask:open_preview:${JSON.stringify({ port: 5173 })}`);
    const events = (await collectUntilStopped(adapter, ref, 10_000)).map((e) => e.event);
    const rec = await readJson<StartRecord>(join(c.workspaceRoot, '.fake-codex-start.json'));
    expect(rec.capabilities?.experimentalApi).toBe(true);
    expect(rec.dynamicTools?.map((t) => t.name)).toEqual(['open_preview', 'close_preview', 'list_previews']);
    expect(rec.dynamicTools?.[0]?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['port'],
    });
    expect(calls).toEqual([
      ['open', { port: 5173, name: undefined, ttl: undefined, protect: undefined, stable: undefined }],
    ]);
    const tool = await readJson<ToolRecord>(join(c.workspaceRoot, '.fake-codex-tool.json'));
    expect(tool.answer?.success).toBe(true);
    expect(tool.answer?.contentItems[0]?.text).toContain('MARKER-PREVIEW');
    expect(events.some((e) => e.kind === 'approval_request')).toBe(false);
  });

  it('a denied port and publish_site without the host offering it never reach the host', async () => {
    const adapter = make();
    const { host, calls } = previewHost();
    const c1 = ctx({ previewTools: host, sandboxProfile: 'host-restricted' });
    const r1 = await start(adapter, c1, `subtask:open_preview:${JSON.stringify({ port: 22 })}`);
    await collectUntilStopped(adapter, r1, 10_000);
    const t1 = await readJson<ToolRecord>(join(c1.workspaceRoot, '.fake-codex-tool.json'));
    expect(t1.answer?.success).toBe(false);
    expect(t1.answer?.contentItems[0]?.text).toMatch(/^invalid arguments: port/);
    const c2 = ctx({ previewTools: host, sandboxProfile: 'host-restricted' });
    const r2 = await start(adapter, c2, `subtask:publish_site:${JSON.stringify({})}`);
    await collectUntilStopped(adapter, r2, 10_000);
    const t2 = await readJson<ToolRecord>(join(c2.workspaceRoot, '.fake-codex-tool.json'));
    expect(t2.answer?.success).toBe(false);
    expect(t2.answer?.contentItems[0]?.text).toMatch(/not available/);
    expect(calls).toEqual([]);
    // With the host offering it, publish_site is declared too.
    const withPublish = previewHost(true);
    const c3 = ctx({ previewTools: withPublish.host, sandboxProfile: 'host-restricted' });
    const r3 = await start(adapter, c3, `subtask:publish_site:${JSON.stringify({ env: 'preview' })}`);
    await collectUntilStopped(adapter, r3, 10_000);
    const rec = await readJson<StartRecord>(join(c3.workspaceRoot, '.fake-codex-start.json'));
    expect(rec.dynamicTools?.map((t) => t.name)).toContain('publish_site');
    expect(withPublish.calls).toEqual([['publish', { env: 'preview' }]]);
  });
});
