import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type FakeScript,
  FakeRuntimeAdapter,
  type McpDeliverySupport,
  type SpawnContext,
} from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type AssignedMcp,
  type LeaseKey,
  leaseKeyId,
  type MasterToWorker,
  mcpPolicySha256,
  mcpSetHash,
  type McpSpecInput,
  packMcpSpec,
  PROTOCOL_VERSION,
  signLeaseToken,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { LeaseKeyring } from '../src/jobs/keyring.js';
import { JobRunner, type JobRunnerDeps, type SandboxPort } from '../src/jobs/runner.js';
import { DEFAULT_LIMITS, type NetworkPolicy, type SandboxContext } from '../src/sandbox/types.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin } from './git-fixtures.js';
import { captureLines, nodeOps, tempDir } from './helpers.js';

/**
 * p14-mcp-core (ADR-0054 §2.4): an ASSIGN_JOB carrying `mcp` through the real JobRunner — admission declines,
 * delivery to the adapter (ctx.mcp, secrets in the job env only, 0700 config dir), the attempt's egress, the timeline
 * note, and the call-event filter.
 */
const WORKER = 'wrk_abcdefghijklmnopqrstuvwxyz';
const TOKEN = 'ghp_abcdef123456';

const skills = generateKeyPairSync('ed25519');
const skillsPub = String(skills.publicKey.export({ format: 'jwk' }).x);

const spec: McpSpecInput = {
  id: 'github',
  version: '1.2.0',
  transport: 'http',
  http: {
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: { secret: 'token', format: 'Bearer {}' } },
  },
  secrets: [{ slot: 'token', kind: 'generic', why: 'PAT' }],
  egressHosts: ['api.github.com'],
  runtimes: ['codex'],
  limits: { startupTimeoutSec: 30, toolTimeoutSec: 120 },
  createdAt: '2026-10-20T12:00:00.000Z',
};

function assignedMcp(): AssignedMcp {
  const p = packMcpSpec(spec, skills.privateKey, skillsPub);
  const rules = [{ tool: 'get_*', effect: 'allow' as const }];
  return {
    setHash: mcpSetHash([
      { id: 'github', version: '1.2.0', specSha256: p.specSha256, policySha256: mcpPolicySha256(rules) },
    ]),
    servers: [p.signed],
    policies: [{ server: 'github', rules }],
    secrets: [{ server: 'github', slot: 'token', ref: 'secret:vault-github' }],
  };
}

/** p14-mcp-stdio: a local server with a secret env slot. */
const stdioSpec: McpSpecInput = {
  id: 'files',
  version: '1.0.0',
  transport: 'stdio',
  stdio: {
    package: { manager: 'npm', name: 'mcp-files', version: '1.0.0', integrity: `sha512-${'A'.repeat(86)}==` },
    bin: 'mcp-files',
    env: { FILES_TOKEN: { secret: 'token' } },
  },
  secrets: [{ slot: 'token', kind: 'generic', why: 'PAT' }],
  egressHosts: ['files.example.com'],
  runtimes: ['codex'],
  limits: { startupTimeoutSec: 30, toolTimeoutSec: 120 },
  createdAt: '2026-10-21T12:00:00.000Z',
};

function assignedStdio(): { assigned: AssignedMcp; specSha256: string } {
  const p = packMcpSpec(stdioSpec, skills.privateKey, skillsPub);
  const rules = [{ tool: 'read_*', effect: 'allow' as const }];
  return {
    specSha256: p.specSha256,
    assigned: {
      setHash: mcpSetHash([
        { id: 'files', version: '1.0.0', specSha256: p.specSha256, policySha256: mcpPolicySha256(rules) },
      ]),
      servers: [p.signed],
      policies: [{ server: 'files', rules }],
      secrets: [{ server: 'files', slot: 'token', ref: 'secret:vault-github' }],
    },
  };
}

function keyPair(): { privateKey: KeyObject; key: LeaseKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

type Sent = { type: string; jobId: string; payload: Record<string, unknown> };

class McpAdapter extends FakeRuntimeAdapter {
  readonly spawns: SpawnContext[] = [];
  readonly configDirMode: number[] = [];
  /** p14-mcp-stdio: the launch spec files of stdio servers, read at spawn (the attempt dir goes afterwards). */
  readonly launchFiles: { content: string; mode: number }[] = [];
  constructor(
    script: FakeScript,
    readonly support: McpDeliverySupport | null = { supported: true },
  ) {
    super({ runtime: 'codex', script });
  }
  override async spawn(ctx: SpawnContext) {
    this.spawns.push(ctx);
    if (ctx.mcp !== undefined) this.configDirMode.push((await stat(ctx.mcp.configDir)).mode & 0o777);
    for (const srv of ctx.mcp?.servers ?? []) {
      if (srv.transport !== 'stdio' || srv.args[1] === undefined) continue;
      this.launchFiles.push({
        content: await readFile(srv.args[1], 'utf8'),
        mode: (await stat(srv.args[1])).mode & 0o777,
      });
    }
    return super.spawn(ctx);
  }
}

async function run(opts: {
  adapter: McpAdapter;
  sourceTrust?: 'trusted' | 'untrusted';
  mcpPort?: boolean;
  allowMcp?: boolean;
  egress?: boolean;
  secret?: string | null;
  /** p14-mcp-stdio: the job's MCP set (default: the remote github server). */
  assigned?: AssignedMcp;
  /** p14-mcp-stdio: the stdio port (absent: none). */
  stdio?: NonNullable<JobRunnerDeps['mcp']>['stdio'];
  /** p14-repo-egress: ASSIGN_JOB execution.repoEgress (absent: an older master). */
  repoEgress?: { mode: 'none' | 'allowlist' | 'web'; hosts: string[] };
}) {
  const dir = await tempDir('rw-mcp-runner-');
  const origin = await createOrigin(dir);
  const root = join(dir, 'ws');
  await mkdir(root);
  await chmod(root, 0o700);
  const workspace = await WorkspaceManager.create({
    root,
    projects: { acme: [origin.url] },
    allowFileUrls: true,
    minFreeBytes: 0,
  });
  const { store } = await WorkerStore.open(nodeOps(), join(dir, 'data'));
  const redactor = new Redactor();
  const logger = createLogger({ level: 'debug', redactor, sink: captureLines().sink });
  const machine = new WorkerStateMachine({ maxParallelJobs: 2 }, logger);
  machine.dispatch({ type: 'session_established' });
  const sent: Sent[] = [];
  const signing = keyPair();
  const keyring = new LeaseKeyring(null);
  keyring.setSessionKeys([signing.key]);
  const secretStore = new FileSecretStore(nodeOps(), join(dir, 'data'));
  if (opts.secret !== null) await secretStore.set('vault-github', opts.secret ?? TOKEN);
  const contexts: SandboxContext[] = [];
  const sandbox = {
    runners: {
      runner: () => ({
        confiner: (ctx: SandboxContext) => {
          contexts.push(ctx);
          return { kind: 'test', confine: (plan: unknown) => Promise.resolve(plan) };
        },
      }),
      capabilities: () =>
        Promise.resolve({
          platform: 'darwin' as const,
          container: { ready: true },
          hostRestricted: { ready: true, filesystemConfinement: 'seatbelt' as const, egressEnforced: true },
          runtimeSandboxes: [],
          runningAttempts: 0,
        }),
    },
    limits: DEFAULT_LIMITS,
    egressAllow: ['api.openai.com'],
  } as unknown as SandboxPort;
  const adapter = opts.adapter;
  if (adapter.support !== null) {
    const support = adapter.support;
    (adapter as unknown as { mcpDelivery: () => McpDeliverySupport }).mcpDelivery = () => support;
  }
  const deps: JobRunnerDeps = {
    store,
    machine,
    logger,
    channel: {
      reportApprovalPolicy: () => Promise.resolve(),
      sendSequenced: (d) => {
        sent.push(JSON.parse(JSON.stringify(d)) as Sent);
        return Promise.resolve(sent.length);
      },
      requestCredential: () => Promise.reject(new Error('no session')),
      workerId: () => WORKER,
    },
    keyring,
    workspace,
    adapters: (rt) => (rt === 'codex' ? adapter : null),
    secretStore,
    registry: new SecretRegistry(redactor.secrets),
    redactor,
    runtimeAuth: {},
    sandbox,
    allowUnconfined: false,
    timeouts: { cancelGraceMs: 50, cancelMs: 2_000, approvalMs: 5_000 },
    ...(opts.mcpPort === false
      ? {}
      : {
          mcp: {
            keys: () => [skillsPub],
            allowed: () => opts.allowMcp !== false,
            egress: () => opts.egress !== false,
            ...(opts.stdio === undefined ? {} : { stdio: opts.stdio }),
          },
        }),
  };
  const runner = new JobRunner(deps);
  const jobId = randomUUID();
  const attemptId = randomUUID();
  const iat = new Date('2026-10-13T10:00:00.000Z');
  const exp = new Date(iat.getTime() + 90_000);
  const token = signLeaseToken(
    {
      v: 1,
      kid: signing.key.kid,
      jobId,
      attemptId,
      workerId: WORKER,
      epoch: 1,
      iat: iat.toISOString(),
      exp: exp.toISOString(),
    },
    signing.privateKey,
  );
  const msg = {
    protocolVersion: PROTOCOL_VERSION,
    type: 'ASSIGN_JOB',
    messageId: randomUUID(),
    seq: 1,
    ts: iat.toISOString(),
    correlationId: 'c',
    workerId: WORKER,
    jobId,
    payload: {
      attemptId,
      lease: { epoch: 1, token, expiresAt: exp.toISOString() },
      spec: {
        projectId: 'acme',
        runtime: 'codex',
        prompt: 'hello',
        repository: { url: origin.url, baseRef: 'main', workBranch: 'w' },
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
        ...(opts.sourceTrust === undefined ? { sourceTrust: 'trusted' } : { sourceTrust: opts.sourceTrust }),
      },
      execution: {
        hostExecutionOptIn: true,
        ...(opts.repoEgress === undefined ? {} : { repoEgress: opts.repoEgress }),
      },
      mcp: opts.assigned ?? assignedMcp(),
    },
  } as unknown as MasterToWorker;
  await runner.onMessage(msg);
  await runner.settled(jobId);
  await runner.stop();
  return { sent, contexts };
}

const hosts = (n: NetworkPolicy | undefined): string[] =>
  n === undefined || n.mode === 'none' ? [] : n.targets.map((t) => t.host);
const ack = (sent: Sent[]) => sent.find((s) => s.type === 'LEASE_ACK')?.payload;
const result = (sent: Sent[]) => sent.find((s) => s.type === 'JOB_RESULT')?.payload;

const callEvent = (server: string) => ({
  kind: 'emit' as const,
  event: {
    kind: 'mcp_call' as const,
    server,
    tool: 'get_issue',
    decision: 'allow' as const,
    outcome: 'ok' as const,
    durationMs: 3,
    argsBytes: 2,
    argsSha256: 'a'.repeat(64),
    resultBytes: 10,
  },
});

describe('JobRunner: external MCP servers (p14-mcp-core)', { timeout: 30_000 }, () => {
  it('delivers ctx.mcp with the secret in the job env only, a 0700 config dir and the hosts for this attempt', async () => {
    const adapter = new McpAdapter(() => [
      callEvent('github'),
      callEvent('other'),
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'ok' } },
    ]);
    const { sent, contexts } = await run({ adapter });
    expect(ack(sent)).toMatchObject({ accepted: true });
    const ctx = adapter.spawns[0];
    expect(ctx?.mcp?.servers[0]).toMatchObject({
      id: 'github',
      name: 'x-github',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: { kind: 'secret', env: 'REMYRAL_MCP_GITHUB_TOKEN', format: 'Bearer {}' } },
    });
    expect(ctx?.mcp?.secretEnv.REMYRAL_MCP_GITHUB_TOKEN?.reveal()).toBe(TOKEN);
    expect(ctx?.secretEnv.REMYRAL_MCP_GITHUB_TOKEN?.reveal()).toBe(TOKEN);
    if (process.platform !== 'win32') expect(adapter.configDirMode).toEqual([0o700]);
    expect(hosts(contexts[0]?.network).sort()).toEqual([
      'api.github.com',
      'api.openai.com',
      'mcp.example.com',
    ]);
    const events = sent
      .filter((s) => s.type === 'EVENT')
      .map((s) => (s.payload as { event: { kind: string; text?: string; server?: string } }).event);
    expect(
      events.some((e) => e.kind === 'message' && (e.text ?? '').includes('api.github.com, mcp.example.com')),
    ).toBe(true);
    // A call event for a server not pinned to the job is dropped.
    expect(events.filter((e) => e.kind === 'mcp_call').map((e) => e.server)).toEqual(['github']);
    expect(JSON.stringify(sent)).not.toContain(TOKEN);
    expect(result(sent)).toMatchObject({ outcome: 'succeeded' });
  });

  it('allowMcpEgress: false adds no hosts (the note says why)', async () => {
    const adapter = new McpAdapter(() => [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'ok' } },
    ]);
    const { sent, contexts } = await run({ adapter, egress: false });
    expect(hosts(contexts[0]?.network)).toEqual(['api.openai.com']);
    expect(JSON.stringify(sent)).toContain('allowMcpEgress: false');
  });

  it('declines before anything is prepared: untrusted source, local veto, no MCP support, missing or unusable secret', async () => {
    const cases: [Parameters<typeof run>[0] extends infer O ? Omit<O & object, 'adapter'> : never, RegExp][] =
      [
        // An untrusted source is refused by the sandbox selection first here (host profile); the MCP check is unit-tested.
        [
          { sourceTrust: 'untrusted' },
          /^(mcp_untrusted|sandbox_unavailable \(untrusted_requires_container\))/,
        ],
        [{ allowMcp: false }, /^mcp_vetoed/],
        [{ mcpPort: false }, /^mcp_vetoed/],
        [{ secret: null }, /^mcp_secret_missing/],
        [{ secret: '!curl evil.example' }, /^mcp_secret_invalid/],
      ];
    for (const [o, re] of cases) {
      const adapter = new McpAdapter(() => []);
      const { sent, contexts } = await run({ adapter, ...o });
      expect(ack(sent)).toMatchObject({ accepted: false });
      expect(String(ack(sent)?.reason)).toMatch(re);
      expect(adapter.spawns).toHaveLength(0);
      expect(contexts).toHaveLength(0);
    }
  });

  it('p14-mcp-stdio: an installed stdio server reaches the adapter as the launcher command line; its secret only in the 0600 launch file', async () => {
    const { assigned, specSha256 } = assignedStdio();
    const dir = await tempDir('rw-mcp-stdio-inst-');
    const bin = join(dir, 'server.js');
    const ready: string[] = [];
    const adapter = new McpAdapter(() => [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'ok' } },
    ]);
    const { sent, contexts } = await run({
      adapter,
      assigned,
      stdio: {
        nodePath: '/opt/remyral/node/bin/node',
        enabled: () => true,
        installer: {
          root: dir,
          ready: (spec, sha) => {
            ready.push(`${spec.id}@${spec.version}:${sha === specSha256 ? 'pinned' : 'other'}`);
            return Promise.resolve({
              ok: true as const,
              install: {} as never,
              dir,
              exec: { kind: 'node' as const, file: bin },
            });
          },
        },
      },
    });
    expect(ack(sent)).toMatchObject({ accepted: true });
    expect(ready).toEqual(['files@1.0.0:pinned']);
    const server = adapter.spawns[0]?.mcp?.servers[0];
    expect(server).toMatchObject({
      id: 'files',
      name: 'x-files',
      transport: 'stdio',
      command: '/opt/remyral/node/bin/node',
    });
    if (server?.transport !== 'stdio') throw new Error('not stdio');
    expect(server.args[0]?.endsWith('remyral-mcp-launch.mjs')).toBe(true);
    expect(server.forwardEnv).toContain('HTTPS_PROXY');
    const launch = JSON.parse(adapter.launchFiles[0]?.content ?? '{}') as {
      exec: { file: string };
      env: Record<string, string>;
    };
    expect(launch.exec.file).toBe(bin);
    expect(launch.env.FILES_TOKEN).toBe(TOKEN);
    if (process.platform !== 'win32') expect(adapter.launchFiles[0]?.mode).toBe(0o600);
    // The runtime process never gets a stdio server's secret as env; it is redacted all the same.
    expect(adapter.spawns[0]?.secretEnv.REMYRAL_MCP_FILES_TOKEN).toBeUndefined();
    expect(adapter.spawns[0]?.mcp?.secretEnv.REMYRAL_MCP_FILES_TOKEN).toBeUndefined();
    expect(hosts(contexts[0]?.network)).toContain('files.example.com');
    expect(JSON.stringify(sent)).not.toContain(TOKEN);
  });

  it('p14-mcp-stdio: declines a stdio server that is not installed here, or without mcp-stdio-v1', async () => {
    const { assigned } = assignedStdio();
    const missing = new McpAdapter(() => []);
    const a = await run({
      adapter: missing,
      assigned,
      stdio: {
        nodePath: process.execPath,
        enabled: () => true,
        installer: {
          root: '/nonexistent',
          ready: () =>
            Promise.resolve({
              ok: false as const,
              code: 'not_installed' as const,
              message: 'files@1.0.0 is not installed',
            }),
        },
      },
    });
    expect(String(ack(a.sent)?.reason)).toMatch(/^mcp_not_installed/);
    expect(missing.spawns).toHaveLength(0);
    const off = new McpAdapter(() => []);
    const b = await run({ adapter: off, assigned });
    expect(String(ack(b.sent)?.reason)).toMatch(/^mcp_stdio_unsupported/);
    const vetoed = new McpAdapter(() => []);
    const c = await run({
      adapter: vetoed,
      assigned,
      stdio: {
        nodePath: process.execPath,
        enabled: () => false,
        installer: { root: '/x', ready: () => Promise.reject(new Error('no')) },
      },
    });
    expect(String(ack(c.sent)?.reason)).toMatch(/^mcp_stdio_unsupported/);
  });

  it('an adapter that cannot deliver MCP fails the attempt instead of running without the servers', async () => {
    const adapter = new McpAdapter(() => [], { supported: false, reason: 'no remote MCP here' });
    const { sent } = await run({ adapter });
    expect(adapter.spawns).toHaveLength(0);
    expect(JSON.stringify(result(sent))).toContain('mcp_runtime_unsupported');
  });
});

describe(
  'JobRunner: the project egress policy of a repository job (p14-repo-egress)',
  { timeout: 30_000 },
  () => {
    const done = () =>
      new McpAdapter(() => [{ kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'ok' } }]);

    it('older master (no policy): worker list + MCP hosts; the 403 hint says no policy was sent', async () => {
      const { contexts } = await run({ adapter: done() });
      const net = contexts[0]?.network;
      expect(net?.mode).toBe('allowlist');
      expect(hosts(net).sort()).toEqual(['api.github.com', 'api.openai.com', 'mcp.example.com']);
      expect(net?.mode !== 'none' && net?.refusalHint).toContain('did not send a project egress policy');
    });

    it('allowlist: + the project hosts, on top of the worker list and the MCP hosts', async () => {
      const { contexts } = await run({
        adapter: done(),
        repoEgress: {
          mode: 'allowlist',
          hosts: ['files.pythonhosted.org', 'pypi.org', 'registry.npmjs.org'],
        },
      });
      const net = contexts[0]?.network;
      expect(net?.mode).toBe('allowlist');
      expect(hosts(net).sort()).toEqual([
        'api.github.com',
        'api.openai.com',
        'files.pythonhosted.org',
        'mcp.example.com',
        'pypi.org',
        'registry.npmjs.org',
      ]);
      expect(net?.mode !== 'none' && net?.refusalHint).toContain('project egress policy: allowlist');
    });

    it('web: the sandbox network mode is web; none: exactly the worker list with the none hint', async () => {
      const web = (await run({ adapter: done(), repoEgress: { mode: 'web', hosts: [] } })).contexts[0]
        ?.network;
      expect(web?.mode).toBe('web');
      const none = (await run({ adapter: done(), repoEgress: { mode: 'none', hosts: ['github.com'] } }))
        .contexts[0]?.network;
      expect(none?.mode).toBe('allowlist');
      expect(hosts(none)).not.toContain('github.com');
      expect(none?.mode !== 'none' && none?.refusalHint).toContain('project egress policy: none');
    });
  },
);
