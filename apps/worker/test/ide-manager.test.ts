import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnOwnedProcess } from '@remyral/agent-adapters';
import { createLogger } from '@remyral/observability';
import {
  type IdeEventPayload,
  type IdeFileDataPayload,
  type IdeGitResultPayload,
  type IdeProfile,
  IdeSpec,
  type IdeStatusPayload,
  leaseKeyId,
  type MasterToWorker,
  PROTOCOL_VERSION,
  signIdeControl,
  signIdeGit,
  signIdeStart,
} from '@remyral/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdeBridgeServer } from '../src/ide/bridge.js';
import { IdeExtensionCache } from '../src/ide/extensions.js';
import { buildZip } from './zip-fixtures.js';
import { BRIDGE_EXTENSION_DIR } from '../src/ide/bridge-extension.js';
import {
  IdeManager,
  type IdeManagerDeps,
  idePlatformRefusal,
  ideSandboxPlacement,
} from '../src/ide/manager.js';
import type { IdeServerPort } from '../src/ide/server.js';
import { DEFAULT_LIMITS, type SandboxLaunchRequest, type SandboxRunner } from '../src/sandbox/types.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin, git, remoteSha } from './git-fixtures.js';

/**
 * p19-ide W2: the worker's IDE manager with a real child process — a mock openvscode-server (node HTTP server that
 * checks its connection token like the real one, answers `<base>/version` unauthenticated) started through a
 * pass-through sandbox runner — and signed master messages: start → running, the server's arguments and state dirs
 * (bridge extension), stop / idle / memory stops, remove, refusals (signature, age, capacity, platform, an open
 * server), file reads for chat references, the bridge's push round trip, a worker restart, and the git path of a
 * repository workspace (IDE branch, commit + fast-forward push, secret refusal).
 */

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const logger = createLogger({ sink: () => undefined });
const WORKER = 'wrk_ide_test';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const raw = String(publicKey.export({ format: 'jwk' }).x);
const KEY = { kid: leaseKeyId(raw), publicKey: raw };

const MOCK = `
const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf('--' + n); return i < 0 ? undefined : args[i + 1]; };
const port = Number(opt('port'));
const base = opt('server-base-path');
const token = fs.readFileSync(opt('connection-token-file'), 'utf8').trim();
fs.writeFileSync(process.env.HOME + '/launch.json', JSON.stringify({ args, bridge: process.env.REMYRAL_IDE_BRIDGE_URL || null, bridgeToken: Boolean(process.env.REMYRAL_IDE_BRIDGE_TOKEN), label: process.env.REMYRAL_IDE_LABEL || null }));
const open = process.argv[1].endsWith('open.cjs');
http.createServer((q, s) => {
  if (q.url === base + '/version') { s.end('commit'); return; }
  if (!open && !(q.headers.cookie || '').includes('vscode-tkn=' + token)) { s.writeHead(403); s.end('Forbidden.'); return; }
  s.writeHead(200, { 'content-type': 'text/html' }); s.end('<html>workbench</html>');
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

let dir = '';
let root = '';
let statuses: IdeStatusPayload[] = [];
let gitResults: IdeGitResultPayload[] = [];
let files: IdeFileDataPayload[] = [];
let events: IdeEventPayload[] = [];
let resets: string[] = [];
let streams = 0;
const managers: IdeManager[] = [];
const bridges: IdeBridgeServer[] = [];

const passThrough: SandboxRunner = {
  profile: 'host-restricted',
  kind: 'test:passthrough',
  confiner: () => {
    throw new Error('unused');
  },
  launch: (req: SandboxLaunchRequest) =>
    spawnOwnedProcess({
      command: req.command,
      args: req.args,
      cwd: req.workspacePath,
      env: req.env,
      inheritEnv: [],
      ...(req.secretEnv === undefined ? {} : { secretEnv: req.secretEnv }),
      stdin: 'ignore',
    }),
};

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'rw-ide-')));
  root = join(dir, 'root');
  await mkdir(join(root, 'jobs'), { recursive: true });
  await mkdir(join(dir, 'server', 'bin'), { recursive: true });
  for (const name of ['mock.cjs', 'open.cjs']) await writeFile(join(dir, 'server', name), MOCK);
  for (const [bin, js] of [
    ['openvscode-server', 'mock.cjs'],
    ['open-server', 'open.cjs'],
  ] as const) {
    await writeFile(
      join(dir, 'server', 'bin', bin),
      `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'server', js)}" "$@"\n`,
    );
    await chmod(join(dir, 'server', 'bin', bin), 0o755);
  }
  statuses = [];
  gitResults = [];
  files = [];
  events = [];
  resets = [];
  streams = 0;
});

afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
  for (const b of bridges.splice(0)) await b.close();
  await rm(dir, { recursive: true, force: true });
});

function server(binary = 'openvscode-server'): IdeServerPort {
  return {
    version: '0.0.0-test',
    kind: 'openvscode-server',
    unsupported: () => null,
    ensure: () =>
      Promise.resolve({
        kind: 'openvscode-server' as const,
        version: '0.0.0-test',
        dir: join(dir, 'server'),
        binary: join(dir, 'server', 'bin', binary),
      }),
  };
}

async function manager(over: Partial<IdeManagerDeps> = {}): Promise<IdeManager> {
  let m: IdeManager | null = null;
  const bridge = new IdeBridgeServer(
    {
      reference: (id, r) => (m as IdeManager).bridgeHandler.reference(id, r),
      push: (id, r) => (m as IdeManager).bridgeHandler.push(id, r),
      terminal: (id, r) => (m as IdeManager).bridgeHandler.terminal(id, r),
      settings: (id) => (m as IdeManager).bridgeHandler.settings(id),
      saveSettings: (id, r) => (m as IdeManager).bridgeHandler.saveSettings(id, r),
    },
    logger,
  );
  await bridge.start();
  bridges.push(bridge);
  m = new IdeManager({
    dataDir: join(dir, 'data'),
    workspace: {
      root,
      prepare: () => Promise.reject(new Error('no repository in this test')),
      release: () => Promise.resolve(),
      ideGitStatus: () => Promise.reject(new Error('no repository')),
      idePush: () => Promise.reject(new Error('no repository')),
    },
    runner: () => passThrough,
    limits: DEFAULT_LIMITS,
    egressAllow: [],
    allowedProfiles: () => ['host-restricted'],
    keys: () => [KEY],
    channel: {
      status: (p) => {
        statuses.push(p);
        return Promise.resolve();
      },
      gitResult: (p) => {
        gitResults.push(p);
        return Promise.resolve();
      },
      fileData: (p) => {
        files.push(p);
        return Promise.resolve();
      },
      event: (p) => {
        events.push(p);
        return Promise.resolve();
      },
      workerId: () => WORKER,
    },
    server: server(),
    bridge,
    streamsFor: () => streams,
    resetStreams: (id) => {
      resets.push(id);
    },
    logger,
    platform: 'linux',
    stopGraceMs: 500,
    readyTimeoutMs: 10_000,
    ...over,
  });
  managers.push(m);
  await m.load();
  return m;
}

const filesSpec = (over: Partial<IdeSpec> = {}): IdeSpec =>
  IdeSpec.parse({
    workspaceId: randomUUID(),
    projectId: 'notes',
    userId: 'u-1',
    name: 'draft',
    source: { kind: 'files', seed: null },
    memoryMb: 4096,
    idleMinutes: 30,
    sandboxProfile: 'host-restricted',
    gitAuthor: { name: 'Ayse', email: 'ayse@example.com' },
    ...over,
  });

function start(
  spec: IdeSpec,
  over: {
    revision?: number;
    issuedAt?: string;
    unsigned?: boolean;
    profile?: IdeProfile;
    token?: string;
  } = {},
): MasterToWorker {
  const revision = over.revision ?? 1;
  const issuedAt = over.issuedAt ?? new Date().toISOString();
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'IDE_START',
    messageId: randomUUID(),
    seq: 0,
    ts: issuedAt,
    correlationId: 'c',
    workerId: WORKER,
    payload: {
      spec,
      revision,
      issuedAt,
      ...(over.profile === undefined ? {} : { profile: over.profile }),
      ...(over.token === undefined ? {} : { downloadToken: over.token }),
      ...(over.unsigned === true
        ? {}
        : {
            signature: signIdeStart(
              { workerId: WORKER, revision, issuedAt, spec, profile: over.profile },
              KEY.kid,
              privateKey,
            ),
          }),
    },
  } as MasterToWorker;
}

function control(workspaceId: string, op: 'stop' | 'remove'): MasterToWorker {
  const issuedAt = new Date().toISOString();
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'IDE_CONTROL',
    messageId: randomUUID(),
    seq: 0,
    ts: issuedAt,
    correlationId: 'c',
    workerId: WORKER,
    payload: {
      workspaceId,
      op,
      reason: op,
      issuedAt,
      signature: signIdeControl({ workerId: WORKER, workspaceId, op, issuedAt }, KEY.kid, privateKey),
    },
  } as MasterToWorker;
}

function gitMsg(
  workspaceId: string,
  op: 'status' | 'push' | 'diff',
  message?: string,
  path?: string,
): MasterToWorker {
  const issuedAt = new Date().toISOString();
  const requestId = randomUUID();
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'IDE_GIT',
    messageId: randomUUID(),
    seq: 0,
    ts: issuedAt,
    correlationId: 'c',
    workerId: WORKER,
    payload: {
      requestId,
      workspaceId,
      op,
      ...(message === undefined ? {} : { message }),
      ...(path === undefined ? {} : { path }),
      ...(op === 'push' ? { gitToken: 'test-token', gitTokenUsername: 'x-access-token' } : {}),
      issuedAt,
      signature: signIdeGit(
        { workerId: WORKER, workspaceId, requestId, op, message, issuedAt, path },
        KEY.kid,
        privateKey,
      ),
    },
  } as MasterToWorker;
}

async function until(fn: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const last = (id: string): IdeStatusPayload | undefined =>
  statuses.filter((s) => s.workspaceId === id).at(-1);

describePosix('IDE manager (p19-ide W2)', () => {
  it('starts a files workspace: server arguments, state dirs, bridge extension, running gateway', async () => {
    const m = await manager();
    const spec = filesSpec();
    const id = spec.workspaceId;
    expect(await m.onMessage(start(spec))).toBe(true);
    await until(() => last(id)?.state === 'running');
    expect(statuses.filter((s) => s.workspaceId === id).map((s) => s.state)).toEqual([
      'preparing',
      'starting',
      'running',
    ]);
    expect(m.gateway(id)).not.toBeNull();
    const run = join(root, 'sandboxes', `ide-${id}`, 'run');
    const launch = JSON.parse(await readFile(join(run, 'home', 'launch.json'), 'utf8')) as {
      args: string[];
      bridge: string;
      bridgeToken: boolean;
      label: string;
    };
    const arg = (n: string) => launch.args[launch.args.indexOf(`--${n}`) + 1];
    expect(arg('host')).toBe('127.0.0.1');
    expect(arg('server-base-path')).toBe(`/w/${id}`);
    expect(arg('default-folder')).toBe(join(root, 'jobs', `ide-${id}`, 'files'));
    expect(arg('extensions-dir')).toBe(join(run, 'extensions'));
    expect(arg('telemetry-level')).toBe('off');
    expect(launch.args).toContain('--accept-server-license-terms');
    expect(launch.args.join(' ')).not.toContain(await readFile(join(run, 'connection-token'), 'utf8'));
    expect((await stat(join(run, 'connection-token'))).mode & 0o077).toBe(0);
    expect(launch.bridge).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/ide/${id}$`));
    expect(launch.bridgeToken).toBe(true);
    expect(launch.label).toBe('notes/draft');
    expect(await readFile(join(run, 'extensions', BRIDGE_EXTENSION_DIR, 'extension.js'), 'utf8')).toContain(
      'remyral.addToChat',
    );
    const reg = JSON.parse(await readFile(join(run, 'extensions', 'extensions.json'), 'utf8')) as {
      identifier: { id: string };
    }[];
    expect(reg[0]?.identifier.id).toBe('remyral.ide-bridge');
    expect(m.report()).toMatchObject({
      available: true,
      max: 2,
      workspaces: [{ workspaceId: id, revision: 1, state: 'running' }],
    });
    // Re-sent start of the same revision: no second server.
    await m.onMessage(start(spec));
    expect(statuses.filter((s) => s.workspaceId === id && s.state === 'starting')).toHaveLength(1);

    await m.onMessage(control(id, 'stop'));
    await until(() => last(id)?.state === 'stopped');
    expect(last(id)?.stopReason).toBe('requested');
    expect(m.gateway(id)).toBeNull();
    expect(resets).toContain(id);
    // Started again later: same files, no re-seed.
    await m.onMessage(start(spec, { revision: 1 }));
    await until(() => last(id)?.state === 'running');
  });

  it('refuses unsigned, stale, over-capacity and unsupported starts', async () => {
    const m = await manager({ maxRunning: 1 });
    const a = filesSpec();
    await m.onMessage(start(a, { unsigned: true }));
    expect(last(a.workspaceId)?.state).toBe('refused');
    expect(last(a.workspaceId)?.detail).toContain('missing');
    await m.onMessage(start(a, { issuedAt: new Date(Date.now() - 20 * 60_000).toISOString() }));
    expect(last(a.workspaceId)?.detail).toContain('too old');
    await m.onMessage(start(a));
    await until(() => last(a.workspaceId)?.state === 'running');
    const b = filesSpec({ name: 'other' });
    await m.onMessage(start(b));
    expect(last(b.workspaceId)?.state).toBe('refused');
    expect(last(b.workspaceId)?.detail).toContain('at most 1');

    // W2b: macOS without Seatbelt and Windows without per-job accounts refuse (the reason as a code too).
    const mac = await manager({ platform: 'darwin' });
    expect(mac.report()).toMatchObject({ available: false, reasonCode: 'seatbelt_required' });
    expect(mac.report().reason).toContain('Seatbelt');
    const c = filesSpec();
    await mac.onMessage(start(c));
    expect(last(c.workspaceId)?.state).toBe('refused');
    const win = await manager({
      platform: 'win32',
      sandboxCheck: () => ({ ready: true, filesystemConfinement: 'none' }),
    });
    expect(win.report()).toMatchObject({ available: false, reasonCode: 'windows_accounts_required' });
    const notReady = await manager({
      sandboxCheck: () => ({
        ready: false,
        filesystemConfinement: 'bwrap',
        reason: 'worker OS user not acceptable',
      }),
    });
    expect(notReady.report()).toMatchObject({ available: false, reasonCode: 'sandbox_unavailable' });
    expect(notReady.report().reason).toContain('worker OS user');
    const noBuild = await manager({
      server: { ...server(), kind: null, unsupported: () => 'Windows on arm64: no IDE server build' },
    });
    expect(noBuild.report()).toMatchObject({ available: false, reasonCode: 'platform_unsupported' });
    expect(noBuild.report().serverKind).toBeUndefined();
  });

  it('never keeps a server that answers without its token', async () => {
    const m = await manager({ server: server('open-server') });
    const spec = filesSpec();
    await m.onMessage(start(spec));
    await until(() => last(spec.workspaceId)?.state === 'failed');
    expect(last(spec.workspaceId)?.detail).toContain('without its secret');
    expect(m.gateway(spec.workspaceId)).toBeNull();
  });

  it('stops an idle IDE (no stream for idleMinutes) and one above its memory limit', async () => {
    let now = Date.now();
    let memory = 100 * 1024 * 1024;
    const m = await manager({
      clock: () => new Date(now),
      watchIntervalMs: 30,
      sampler: () => Promise.resolve({ memoryBytes: memory }),
    });
    const idle = filesSpec({ idleMinutes: 10 });
    await m.onMessage(start(idle));
    await until(() => last(idle.workspaceId)?.state === 'running');
    // A browser stream keeps it alive …
    streams = 1;
    now += 11 * 60_000;
    await new Promise((r) => setTimeout(r, 100));
    expect(last(idle.workspaceId)?.state).toBe('running');
    // … without one it stops after the idle time.
    streams = 0;
    now += 11 * 60_000;
    await until(() => last(idle.workspaceId)?.state === 'stopped');
    expect(last(idle.workspaceId)?.stopReason).toBe('idle');

    const hungry = filesSpec({ memoryMb: 1024, name: 'hungry' });
    // The worker's clock moved on: the master signs with its own (same) time.
    await m.onMessage(start(hungry, { issuedAt: new Date(now).toISOString() }));
    await until(() => last(hungry.workspaceId)?.state === 'running');
    memory = 2 * 1024 * 1024 * 1024;
    await until(() => last(hungry.workspaceId)?.state === 'stopped');
    expect(last(hungry.workspaceId)?.stopReason).toBe('memory');
    expect(last(hungry.workspaceId)?.detail).toContain('1024 MB');
  }, 30_000);

  it('reads workspace files for chat references, confined to the workspace', async () => {
    const m = await manager();
    const spec = filesSpec();
    const id = spec.workspaceId;
    await m.onMessage(start(spec));
    await until(() => last(id)?.state === 'running');
    const base = join(root, 'jobs', `ide-${id}`, 'files');
    await mkdir(join(base, 'src'), { recursive: true });
    await writeFile(join(base, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(base, 'bin.dat'), Buffer.from([1, 0, 2]));
    await writeFile(join(dir, 'outside.txt'), 'secret');
    await symlink(join(dir, 'outside.txt'), join(base, 'link.txt'));
    const ask = async (path: string) => {
      const requestId = randomUUID();
      await m.onMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'IDE_FILE_REQUEST',
        messageId: randomUUID(),
        seq: 0,
        ts: new Date().toISOString(),
        correlationId: 'c',
        workerId: WORKER,
        payload: { requestId, workspaceId: id, path },
      } as MasterToWorker);
      return files.find((f) => f.requestId === requestId);
    };
    expect(await ask('src/a.ts')).toMatchObject({ status: 'ok', text: 'export const a = 1;\n' });
    expect((await ask('bin.dat'))?.status).toBe('binary');
    expect((await ask('missing.ts'))?.status).toBe('not_found');
    expect((await ask('link.txt'))?.status).toBe('refused');
  });

  it('turns bridge calls into events and answers a push with the master notice', async () => {
    const m = await manager({ pushTimeoutMs: 5_000 });
    const spec = filesSpec();
    const id = spec.workspaceId;
    await m.onMessage(start(spec));
    await until(() => last(id)?.state === 'running');
    expect(await m.bridgeHandler.reference(id, { path: 'a.ts', startLine: 2, endLine: 4 })).toMatchObject({
      status: 'ok',
    });
    expect(events.at(-1)).toMatchObject({
      kind: 'reference',
      workspaceId: id,
      path: 'a.ts',
      startLine: 2,
      endLine: 4,
    });
    await m.bridgeHandler.terminal(id, { name: 'bash' });
    expect(events.at(-1)).toMatchObject({ kind: 'terminal.open', name: 'bash' });
    // A files workspace has nothing to push.
    expect((await m.bridgeHandler.push(id, { message: 'x', pullRequest: false })).status).toBe('refused');
    // Not running: refused.
    expect(
      (await m.bridgeHandler.reference(randomUUID(), { path: 'a', startLine: 1, endLine: 1 })).status,
    ).toBe('refused');
  });

  it('removes a workspace with its files; a restarted worker reports the rest stopped', async () => {
    const m = await manager();
    const keep = filesSpec({ name: 'keep' });
    const gone = filesSpec({ name: 'gone' });
    await m.onMessage(start(keep));
    await m.onMessage(start(gone));
    await until(
      () => last(keep.workspaceId)?.state === 'running' && last(gone.workspaceId)?.state === 'running',
    );
    await m.onMessage(control(gone.workspaceId, 'remove'));
    await until(() => last(gone.workspaceId)?.state === 'removed');
    await expect(stat(join(root, 'jobs', `ide-${gone.workspaceId}`))).rejects.toThrow();
    await expect(stat(join(dir, 'data', 'ide', gone.workspaceId))).rejects.toThrow();
    await m.shutdown();
    managers.splice(managers.indexOf(m), 1);
    const again = await manager();
    expect(again.report().workspaces).toEqual([
      expect.objectContaining({ workspaceId: keep.workspaceId, state: 'stopped' }),
    ]);
  });
});

describePosix('IDE repository workspace (p19-ide W2)', () => {
  it('checks out the IDE branch, commits and pushes it fast-forward, refuses secrets', async () => {
    const origin = await createOrigin(join(dir, 'origin'), 'shop', { 'src/app.ts': 'export {};\n' });
    const ws = await WorkspaceManager.create({
      root,
      projects: { shop: [origin.url] },
      allowFileUrls: true,
      freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    });
    const m = await manager({ workspace: ws });
    const spec = filesSpec({
      projectId: 'shop',
      name: 'fix',
      source: {
        kind: 'repository',
        repositoryUrl: origin.url,
        baseRef: 'main',
        branch: 'remyral/ide/ayse/fix',
      },
    });
    const id = spec.workspaceId;
    await m.onMessage(start(spec));
    await until(() => last(id)?.state === 'running');
    expect(last(id)?.branch).toBe('remyral/ide/ayse/fix');
    const checkout = join(root, 'jobs', `ide-${id}`, 'checkout');
    expect(git(checkout, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/remyral/ide/ayse/fix');

    await writeFile(join(checkout, 'src', 'app.ts'), 'export const fixed = true;\n');
    await m.onMessage(gitMsg(id, 'status'));
    await until(() => gitResults.length === 1);
    expect(gitResults[0]).toMatchObject({ status: 'ok', changedFiles: 1, ahead: 0 });

    await m.onMessage(gitMsg(id, 'push', 'fix the app'));
    await until(() => gitResults.length === 2);
    expect(gitResults[1]).toMatchObject({
      status: 'ok',
      committed: true,
      pushed: true,
      branch: 'remyral/ide/ayse/fix',
    });
    expect(remoteSha(origin, 'refs/heads/remyral/ide/ayse/fix')).toBe(gitResults[1]?.head);
    expect(git(origin.bare, ['log', '-1', '--format=%an <%ae> %s', 'remyral/ide/ayse/fix'])).toBe(
      'Ayse <ayse@example.com> fix the app',
    );

    // A secret in the changes: nothing is pushed.
    await writeFile(join(checkout, 'leak.txt'), `token = "ghp_${'a1B2'.repeat(9)}"\n`);
    await m.onMessage(gitMsg(id, 'push', 'oops'));
    await until(() => gitResults.length === 3);
    expect(gitResults[2]).toMatchObject({ status: 'refused', reason: 'secret_found' });
    expect(remoteSha(origin, 'refs/heads/remyral/ide/ayse/fix')).toBe(gitResults[1]?.head);

    // Unsigned / foreign requests are refused.
    const bad = gitMsg(id, 'status') as Extract<MasterToWorker, { type: 'IDE_GIT' }>;
    await m.onMessage({ ...bad, payload: { ...bad.payload, op: 'push' } });
    await until(() => gitResults.length === 4);
    expect(gitResults[3]).toMatchObject({ status: 'refused', reason: 'not_signed' });

    // Removing the workspace deletes the worktree and the local branch; a new workspace continues the remote branch.
    await m.onMessage(control(id, 'remove'));
    await until(() => last(id)?.state === 'removed');
    await expect(stat(checkout)).rejects.toThrow();
    const again = filesSpec({ ...spec, workspaceId: randomUUID() });
    await m.onMessage(start(again));
    await until(() => last(again.workspaceId)?.state === 'running');
    const checkout2 = join(root, 'jobs', `ide-${again.workspaceId}`, 'checkout');
    expect(git(checkout2, ['rev-parse', 'HEAD'])).toBe(gitResults[1]?.head);
  });
});

describePosix('IDE workspace diff (p19-ide W4)', () => {
  it('answers IDE_GIT diff with the uncommitted changes (files, untracked, unified diff, path filter)', async () => {
    const origin = await createOrigin(join(dir, 'origin'), 'shop', {
      'src/app.ts': 'export {};\n',
      'src/old.ts': 'export const old = 1;\n',
    });
    const ws = await WorkspaceManager.create({
      root,
      projects: { shop: [origin.url] },
      allowFileUrls: true,
      freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    });
    const m = await manager({ workspace: ws });
    const spec = filesSpec({
      projectId: 'shop',
      name: 'diff',
      source: {
        kind: 'repository',
        repositoryUrl: origin.url,
        baseRef: 'main',
        branch: 'remyral/ide/ayse/diff',
      },
    });
    const id = spec.workspaceId;
    await m.onMessage(start(spec));
    await until(() => last(id)?.state === 'running');
    const checkout = join(root, 'jobs', `ide-${id}`, 'checkout');
    await writeFile(join(checkout, 'src', 'app.ts'), 'export const fixed = true;\n');
    await rm(join(checkout, 'src', 'old.ts'));
    await writeFile(join(checkout, 'notes.md'), '# new\n');

    await m.onMessage(gitMsg(id, 'diff'));
    await until(() => gitResults.length === 1);
    const r = gitResults[0];
    expect(r).toMatchObject({ status: 'ok', branch: 'remyral/ide/ayse/diff', truncated: false });
    expect(r?.files).toEqual([
      { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1 },
      { path: 'src/old.ts', status: 'deleted', additions: 0, deletions: 1 },
    ]);
    expect(r?.untracked).toEqual(['notes.md']);
    expect(r?.diff).toContain('+export const fixed = true;');
    expect(r?.diff).toContain('-export const old = 1;');
    // Read-only: nothing was staged or committed.
    expect(git(checkout, ['diff', '--cached', '--name-only'])).toBe('');

    await m.onMessage(gitMsg(id, 'diff', undefined, 'src/app.ts'));
    await until(() => gitResults.length === 2);
    expect(gitResults[1]?.files?.map((f) => f.path)).toEqual(['src/app.ts']);
    expect(gitResults[1]?.diff).not.toContain('old.ts');

    // The path is signed: a changed path is refused.
    const signed = gitMsg(id, 'diff', undefined, 'src/app.ts') as Extract<
      MasterToWorker,
      { type: 'IDE_GIT' }
    >;
    await m.onMessage({ ...signed, payload: { ...signed.payload, path: 'src/old.ts' } });
    await until(() => gitResults.length === 3);
    expect(gitResults[2]).toMatchObject({ status: 'refused', reason: 'not_signed' });
  });
});

describePosix('IDE extensions + settings sync (p19-ide W3)', () => {
  const vsix = buildZip([
    { name: 'extension.vsixmanifest', data: '<x/>' },
    {
      name: 'extension/package.json',
      data: JSON.stringify({ publisher: 'acme', name: 'tool', version: '1.2.0' }),
    },
    { name: 'extension/out/main.js', data: 'module.exports = {};' },
  ]);
  const sha = createHash('sha256').update(vsix).digest('hex');
  const TOKEN = 'T'.repeat(43);

  it('installs the signed profile from the master, allows only it, enforces settings, syncs settings', async () => {
    const downloads: string[] = [];
    const m = await manager({
      extensionCache: new IdeExtensionCache({ dataDir: join(dir, 'data'), logger }),
      download: (path, token) => {
        downloads.push(path);
        expect(token).toBe(TOKEN);
        if (path.startsWith('/v1/worker/ide/extensions/')) return Promise.resolve(vsix);
        return Promise.resolve(
          Buffer.from(JSON.stringify({ settings: '{"editor.fontSize": 15}', keybindings: null })),
        );
      },
      settingsTimeoutMs: 5_000,
    });
    const spec = filesSpec();
    const id = spec.workspaceId;
    const profile: IdeProfile = {
      extensions: [
        { id: 'acme.tool', version: '1.2.0', targetPlatform: 'universal', sha256: sha, size: vsix.length },
      ],
      allowed: ['acme.tool'],
      enforcedSettings: { 'files.exclude': { '**/dist': true }, 'extensions.allowed': { '*': true } },
      settingsSync: true,
    };
    await m.onMessage(start(spec, { profile, token: TOKEN }));
    await until(() => last(id)?.state === 'running');
    expect(last(id)?.extensions).toEqual({ installed: ['acme.tool'], failed: [] });
    const run = join(root, 'sandboxes', `ide-${id}`, 'run');
    expect(
      JSON.parse(await readFile(join(run, 'extensions', 'acme.tool-1.2.0', 'package.json'), 'utf8')),
    ).toMatchObject({ name: 'tool' });
    const reg = JSON.parse(await readFile(join(run, 'extensions', 'extensions.json'), 'utf8')) as {
      identifier: { id: string };
    }[];
    expect(reg.map((e) => e.identifier.id).sort()).toEqual(['acme.tool', 'remyral.ide-bridge']);
    const machine = JSON.parse(
      await readFile(join(run, 'user-data', 'Machine', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    // The worker's own keys win over enforced ones (a project cannot re-open extensions.allowed).
    expect(machine['extensions.allowed']).toEqual({
      '*': false,
      'remyral.ide-bridge': true,
      'acme.tool': true,
    });
    expect(machine['files.exclude']).toEqual({ '**/dist': true });
    expect(await readFile(join(dir, 'data', 'ide', 'extensions-cache', `${sha}.vsix`))).toEqual(vsix);
    expect(downloads).toEqual([`/v1/worker/ide/extensions/${sha}`, `/v1/worker/ide/settings/${id}`]);
    // Settings sync: the bridge gets the stored files; a save goes to the master and waits for its notice.
    expect(await m.bridgeHandler.settings(id)).toEqual({
      sync: true,
      settings: '{"editor.fontSize": 15}',
      keybindings: null,
    });
    const saving = m.bridgeHandler.saveSettings(id, { file: 'settings', content: '{"editor.fontSize": 16}' });
    await until(() => events.some((e) => e.kind === 'settings'));
    const ev = events.find((e) => e.kind === 'settings');
    expect(ev).toMatchObject({ kind: 'settings', file: 'settings', content: '{"editor.fontSize": 16}' });
    await m.onMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'IDE_NOTICE',
      messageId: randomUUID(),
      seq: 0,
      ts: new Date().toISOString(),
      correlationId: 'c',
      workerId: WORKER,
      payload: { workspaceId: id, eventId: ev?.eventId ?? '', status: 'ok', message: 'Ayarlar kaydedildi.' },
    } as MasterToWorker);
    expect(await saving).toEqual({ status: 'ok', message: 'Ayarlar kaydedildi.' });
    expect((await m.bridgeHandler.settings(id)).settings).toBe('{"editor.fontSize": 16}');
    // A second start uses the cache (no new VSIX download) and keeps the unchanged folder.
    await m.onMessage(control(id, 'stop'));
    await until(() => last(id)?.state === 'stopped');
    downloads.length = 0;
    await m.onMessage(
      start(spec, { revision: 2, profile: { ...profile, extensions: [], allowed: [] }, token: TOKEN }),
    );
    await until(() => last(id)?.state === 'running');
    expect(downloads).toEqual([`/v1/worker/ide/settings/${id}`]);
    await expect(stat(join(run, 'extensions', 'acme.tool-1.2.0'))).rejects.toThrow();
  });

  it('refuses a start whose profile was changed after signing, and reports a VSIX that does not match', async () => {
    const m = await manager({
      extensionCache: new IdeExtensionCache({ dataDir: join(dir, 'data'), logger }),
      download: () => Promise.resolve(Buffer.from('not the package')),
    });
    const spec = filesSpec();
    const profile: IdeProfile = {
      extensions: [
        { id: 'acme.tool', version: '1.2.0', targetPlatform: 'universal', sha256: sha, size: vsix.length },
      ],
      allowed: ['acme.tool'],
      enforcedSettings: {},
      settingsSync: false,
    };
    const msg = start(spec, { profile, token: TOKEN }) as Extract<MasterToWorker, { type: 'IDE_START' }>;
    const tampered = {
      ...msg,
      payload: { ...msg.payload, profile: { ...profile, allowed: ['acme.tool', 'evil.ext'] } },
    } as MasterToWorker;
    await m.onMessage(tampered);
    await until(() => last(spec.workspaceId)?.state === 'refused');
    expect(last(spec.workspaceId)?.detail).toMatch(/not signed/);
    const other = filesSpec({ name: 'other' });
    await m.onMessage(start(other, { profile, token: TOKEN }));
    await until(() => last(other.workspaceId)?.state === 'running');
    expect(last(other.workspaceId)?.extensions?.failed).toEqual([
      { id: 'acme.tool', reason: 'the downloaded VSIX has another size' },
    ]);
    expect(await m.bridgeHandler.settings(other.workspaceId)).toEqual({
      sync: false,
      settings: null,
      keybindings: null,
    });
  });
});

/** p19-ide W2b: a mock code-server — config-file secret, session cookie, `/healthz`, served at `/`. */
const CODE_SERVER_MOCK = `
const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf('--' + n); return i < 0 ? undefined : args[i + 1]; };
const [host, port] = opt('bind-addr').split(':');
const secret = /hashed-password: "([^"]+)"/.exec(fs.readFileSync(opt('config'), 'utf8'))[1];
fs.writeFileSync(process.env.HOME + '/launch.json', JSON.stringify({ args, gallery: process.env.EXTENSIONS_GALLERY ?? null,
  port: process.env.PORT ?? null, password: process.env.PASSWORD ?? null, bridge: process.env.REMYRAL_IDE_BRIDGE_URL || null }));
const wrong = process.argv[1].endsWith('cs-wrong.cjs');
http.createServer((q, s) => {
  if (q.url === '/healthz') { s.end('{"status":"alive"}'); return; }
  const ok = !wrong && (q.headers.cookie || '').split(/;\\s*/).includes('code-server-session=' + secret);
  if (!ok) { s.writeHead(401); s.end('{"error":"Unauthorized"}'); return; }
  s.writeHead(404); s.end('not found');
}).listen(Number(port), host);
process.on('SIGTERM', () => process.exit(0));
`;

describePosix('IDE manager on macOS / Windows (p19-ide W2b)', () => {
  async function codeServer(script: 'cs.cjs' | 'cs-wrong.cjs'): Promise<IdeServerPort> {
    const pkg = join(dir, 'code-server');
    await mkdir(join(pkg, 'lib'), { recursive: true });
    await writeFile(join(pkg, script), CODE_SERVER_MOCK);
    // `lib/node <package dir> …` as the real launch: the wrapper drops the package dir and runs the mock.
    const node = join(pkg, 'lib', `node-${script}`);
    await writeFile(node, `#!/bin/sh\nshift\nexec "${process.execPath}" "${join(pkg, script)}" "$@"\n`);
    await chmod(node, 0o755);
    return {
      version: '4.143.1',
      kind: 'code-server',
      unsupported: () => null,
      ensure: () =>
        Promise.resolve({ kind: 'code-server' as const, version: '4.143.1', dir: pkg, binary: node }),
    };
  }

  it('starts code-server under Seatbelt rules: config secret, flags, env, sandbox request', async () => {
    const launched: SandboxLaunchRequest[] = [];
    const m = await manager({
      platform: 'darwin',
      server: await codeServer('cs.cjs'),
      sandboxCheck: () => ({ ready: true, filesystemConfinement: 'seatbelt' }),
      runner: () => ({
        ...passThrough,
        launch: (req: SandboxLaunchRequest) => {
          launched.push(req);
          return passThrough.launch(req);
        },
      }),
      extraEnv: () => Promise.resolve({ PORT: '1', PASSWORD: 'nope', HASHED_PASSWORD: 'nope' }),
    });
    expect(m.report()).toMatchObject({
      available: true,
      serverKind: 'code-server',
      serverVersion: '4.143.1',
    });
    const spec = filesSpec();
    const id = spec.workspaceId;
    await m.onMessage(start(spec));
    await until(() => last(id)?.state === 'running');
    const run = join(root, 'sandboxes', `ide-${id}`, 'run');
    const launch = JSON.parse(await readFile(join(run, 'home', 'launch.json'), 'utf8')) as {
      args: string[];
      gallery: string | null;
      port: string | null;
      password: string | null;
      bridge: string;
    };
    const arg = (n: string) => launch.args[launch.args.indexOf(`--${n}`) + 1];
    expect(arg('bind-addr')).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(arg('auth')).toBe('password');
    expect(arg('config')).toBe(join(run, 'code-server.yaml'));
    expect(arg('user-data-dir')).toBe(join(run, 'user-data'));
    expect(arg('extensions-dir')).toBe(join(run, 'extensions'));
    expect(arg('session-socket')).toBe(join(run, 'cs.sock'));
    for (const f of [
      '--disable-proxy',
      '--disable-update-check',
      '--disable-telemetry',
      '--ignore-last-opened',
    ])
      expect(launch.args).toContain(f);
    expect(launch.args.slice(-2)).toEqual(['--', join(root, 'jobs', `ide-${id}`, 'files')]);
    const config = await readFile(join(run, 'code-server.yaml'), 'utf8');
    const secret = /hashed-password: "([0-9A-Za-z_-]{43})"/.exec(config)?.[1] ?? '';
    expect(secret).not.toBe('');
    expect(launch.args.join(' ')).not.toContain(secret);
    expect((await stat(join(run, 'code-server.yaml'))).mode & 0o077).toBe(0);
    expect(launch.gallery).toBe('{}');
    expect(launch.port).toBeNull();
    expect(launch.password).toBeNull();
    const req = launched[0];
    expect(req).toMatchObject({
      attemptId: 'run',
      jobAccount: false,
      unixSocketDirs: [run],
      readOnlyDirs: [],
    });
    expect(req?.loopbackPorts).toEqual([Number(new URL(launch.bridge).port)]);
    // The machine settings (extensions.allowed) land where VS Code's server reads them under code-server.
    expect(await readFile(join(run, 'user-data', 'Machine', 'settings.json'), 'utf8')).toContain(
      'extensions.allowed',
    );
    expect(m.gateway(id)).not.toBeNull();
  });

  it('fails a code-server start whose secret scheme does not work (never left behind a login page)', async () => {
    const m = await manager({
      platform: 'darwin',
      server: await codeServer('cs-wrong.cjs'),
      sandboxCheck: () => ({ ready: true, filesystemConfinement: 'seatbelt' }),
    });
    const spec = filesSpec();
    await m.onMessage(start(spec));
    await until(() => last(spec.workspaceId)?.state === 'failed');
    expect(last(spec.workspaceId)?.detail).toContain('secret');
    expect(m.gateway(spec.workspaceId)).toBeNull();
  });

  it('places the IDE per OS (Windows: its own per-job account) and refuses unconfined hosts', () => {
    const id = '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e002';
    expect(ideSandboxPlacement('win32', id, { bridgePort: 4100, runDir: 'C:\\r', mirror: 'C:\\m' })).toEqual({
      attemptId: `ide-${id}`,
      jobAccount: true,
      loopbackPorts: [4100],
      unixSocketDirs: ['C:\\r'],
      readOnlyDirs: ['C:\\m'],
    });
    expect(ideSandboxPlacement('linux', id, { bridgePort: null, runDir: '/r', mirror: null })).toMatchObject({
      attemptId: 'run',
      jobAccount: false,
      loopbackPorts: [],
    });
    expect(idePlatformRefusal('linux', 'none')).toBeNull();
    expect(idePlatformRefusal('darwin', 'seatbelt')).toBeNull();
    expect(idePlatformRefusal('darwin', 'none')?.code).toBe('seatbelt_required');
    expect(idePlatformRefusal('win32', 'job_user')).toBeNull();
    expect(idePlatformRefusal('win32', 'none')?.code).toBe('windows_accounts_required');
  });
});
