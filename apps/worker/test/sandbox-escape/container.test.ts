import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OwnedProcess } from '@remyral/agent-adapters';
import {
  assertTrustedGitUnchanged,
  createAttemptGitView,
  snapshotTrustedGit,
  type AttemptGitView,
} from '../../src/sandbox/attempt-git.js';
import { RUNTIME_PINS } from '../../src/runtimes/pins.js';
import { ContainerEngine } from '../../src/sandbox/container/engine.js';
import { ContainerSandboxRunner } from '../../src/sandbox/container/runner.js';
import { DEFAULT_LIMITS, type NetworkPolicy, type ResourceLimits } from '../../src/sandbox/types.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';
import { createOrigin, git } from '../git-fixtures.js';
import { tempDir } from '../helpers.js';
import { collect, dockerAvailable, ensureImages, expectOutcome, PROBE } from './harness.js';

/**
 * ADR-0007 `container` profile against a real engine (Docker Desktop, linux/arm64
 * VM on the macOS dev machine; rootless Linux engines are UNVERIFIED until CI).
 * Opt-in like the other real-engine suites (REMYRAL_TEST_DOCKER=1; it builds the runtime images, and a hosted CI
 * runner's engine and user ids do not match a worker host); skipped as well when no engine is reachable or
 * REMYRAL_SKIP_DOCKER_TESTS=1.
 */
const enabled = process.env.REMYRAL_TEST_DOCKER === '1' && dockerAvailable();
const T = { timeout: 600_000 };

const BASE = 'remyral/runtime-base:0.1.0';
const PROXY = 'remyral/egress-proxy:0.1.0';
const PI = 'remyral/runtime-pi:0.1.0';

function leftovers(label: string): string[] {
  const out = execFileSync(
    'docker',
    ['ps', '-a', '--filter', `label=remyral.job=${label}`, '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  );
  const nets = execFileSync(
    'docker',
    ['network', 'ls', '--filter', `label=remyral.job=${label}`, '--format', '{{.Name}}'],
    { encoding: 'utf8' },
  );
  return [...out.split('\n'), ...nets.split('\n')].filter(Boolean);
}

describe.skipIf(!enabled)('container profile escape suite (real Docker)', T, () => {
  let runner: ContainerSandboxRunner;
  const procs: OwnedProcess[] = [];

  beforeAll(() => {
    ensureImages(['base', 'egress-proxy', 'pi']);
    runner = new ContainerSandboxRunner({
      engine: new ContainerEngine(),
      images: { default: BASE, pi: PI },
      proxyImage: PROXY,
      allowNonLinuxHost: true,
    });
  }, 1_200_000);

  afterEach(async () => {
    await Promise.all(procs.splice(0).map((p) => p.dispose()));
  });

  async function attempt(jobId: string): Promise<{
    root: string;
    ws: string;
    other: string;
    fakeHome: string;
    keyFile: string;
    view: AttemptGitView;
    mirrorObjects: string;
    manager: WorkspaceManager;
    wsObj: Awaited<ReturnType<WorkspaceManager['prepare']>>;
  }> {
    const dir = await realpath(await tempDir('rw-sbx-c-'));
    const origin = await createOrigin(dir, 'origin', { 'README.md': 'hello\n' });
    const manager = await WorkspaceManager.create({
      root: join(dir, 'root'),
      projects: { proj: [origin.url] },
      allowFileUrls: true,
      freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    });
    const prep = (a: string) =>
      manager.prepare({
        projectId: 'proj',
        jobId,
        attemptId: a,
        epoch: 1,
        repository: { url: origin.url, baseRef: 'main' },
      });
    const wsObj = await prep('a1');
    const other = await prep('a2');
    const view = await createAttemptGitView({ root: manager.root, ws: wsObj, git: manager.git });
    const fakeHome = join(dir, 'fakehome');
    await mkdir(join(fakeHome, '.ssh'), { recursive: true });
    await writeFile(join(fakeHome, '.ssh', 'id_ed25519'), 'FAKE-PRIVATE-KEY\n');
    const keyFile = join(dir, 'worker-data', 'device.key');
    await mkdir(join(dir, 'worker-data'), { recursive: true });
    await writeFile(keyFile, 'FAKE-DEVICE-KEY\n');
    await copyFile(PROBE, join(wsObj.path, 'probe.mjs'));
    return {
      root: manager.root,
      ws: wsObj.path,
      other: other.path,
      fakeHome,
      keyFile,
      view,
      mirrorObjects: view.mirrorObjects,
      manager,
      wsObj,
    };
  }

  async function run(
    jobId: string,
    a: { ws: string; view?: AttemptGitView | undefined },
    command: string,
    args: string[],
    opts: { network?: NetworkPolicy; limits?: Partial<ResourceLimits>; runtime?: 'pi' } = {},
  ) {
    const proc = await runner.launch({
      jobId,
      attemptId: 'a1',
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
      workspacePath: a.ws,
      ...(a.view ? { git: a.view } : {}),
      network: opts.network ?? { mode: 'none' },
      limits: { ...DEFAULT_LIMITS, memoryBytes: 512 * 1024 ** 2, pids: 128, ...opts.limits },
      command,
      args,
      env: { PROBE_MARKER: 'x' },
      stdin: 'ignore',
    });
    procs.push(proc);
    return { proc, ...collect(proc) };
  }

  it('denies writes outside the workspace, host-home/secret reads, metadata/LAN/direct internet; proxy allows only the allowlist', async () => {
    const a = await attempt('jobc1');
    const cfg = {
      writeOutside: [
        '/etc/escape',
        '/usr/local/bin/escape',
        '/escape',
        `${a.mirrorObjects}/escape`,
        '/workspace/.git',
        '/remyral/escape',
      ],
      writeInside: '/workspace/inside.txt',
      readSecrets: [
        join(a.fakeHome, '.ssh', 'id_ed25519'),
        a.keyFile,
        join(a.other, 'README.md'),
        '/etc/shadow',
      ],
      listDirs: ['/Users', a.fakeHome, join(a.root, 'jobs')],
      lanIp: '192.168.1.1',
      proxy: 'http://egress-proxy:3128',
      proxyAllowed: ['example.com:443'],
      proxyDenied: ['example.org:443', '169.254.169.254:80', 'host.docker.internal:443', 'egress-proxy:3128'],
      listenPort: 0,
    };
    const r = await run('jobc1', a, 'node', ['/workspace/probe.mjs', JSON.stringify(cfg)], {
      network: { mode: 'allowlist', targets: [{ host: 'example.com', port: 443 }] },
    });
    const exit = await r.proc.exited;
    expect(exit.code, r.proc.stderrTail()).toBe(0);
    await r.waitFor('done');
    expectOutcome(r.results, 'write-outside-workspace', 'denied');
    expectOutcome(r.results, 'write-inside-workspace', 'allowed');
    expectOutcome(r.results, 'read-secret', 'denied');
    expectOutcome(r.results, 'list-dir', 'denied');
    expectOutcome(r.results, 'metadata-ip', 'denied');
    expectOutcome(r.results, 'private-lan-ip', 'denied');
    expectOutcome(r.results, 'direct-internet', 'denied');
    expectOutcome(r.results, 'proxy-allowlisted', 'allowed');
    expectOutcome(r.results, 'proxy-not-allowlisted', 'denied');
    expectOutcome(r.results, 'engine-socket', 'denied');
    // Listening inside the container's own network namespace is possible but never published.
    expectOutcome(r.results, 'listen-any-interface', 'allowed');
    expect(await readFile(join(a.ws, 'inside.txt'), 'utf8')).toBe('ok');
    // The read-only .git overlay kept the trusted .git file intact.
    expect(await readFile(join(a.ws, '.git'), 'utf8')).toMatch(/^gitdir: .*worktrees/);
    await r.proc.dispose();
    expect(leftovers('jobc1')).toEqual([]);
  });

  it('network none: no proxy, no DNS, nothing reachable', async () => {
    const a = await attempt('jobc2');
    const r = await run('jobc2', a, 'node', [
      '/workspace/probe.mjs',
      JSON.stringify({ proxy: 'http://egress-proxy:3128', proxyAllowed: ['example.com:443'] }),
    ]);
    await r.proc.exited;
    expectOutcome(r.results, 'metadata-ip', 'denied');
    expectOutcome(r.results, 'direct-internet', 'denied');
    expectOutcome(r.results, 'proxy-allowlisted', 'denied');
  });

  it('a listening port is not reachable from the host (nothing published)', async () => {
    const a = await attempt('jobc3');
    const r = await run('jobc3', a, 'node', [
      '/workspace/probe.mjs',
      JSON.stringify({ listenPort: 18765, keepListening: true, hang: true }),
    ]);
    await r.waitFor('hanging');
    const name = runner.containerName(r.proc);
    expect(name).toBeDefined();
    expect(execFileSync('docker', ['port', name ?? ''], { encoding: 'utf8' }).trim()).toBe('');
    const reach = await new Promise<string>((resolve) => {
      const s = connect(18765, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve('connected');
      });
      s.once('error', (e: NodeJS.ErrnoException) => {
        resolve(e.code ?? 'error');
      });
    });
    expect(reach).not.toBe('connected');
  });

  it('pids limit stops a fork bomb', async () => {
    const a = await attempt('jobc4');
    const r = await run('jobc4', a, 'node', ['/workspace/probe.mjs', JSON.stringify({ forkBomb: 300 })], {
      limits: { pids: 48 },
    });
    await r.proc.exited;
    expectOutcome(r.results, 'fork-bomb', 'denied');
    const fb = r.results.find((x) => x.probe === 'fork-bomb');
    expect(Number(/spawned (\d+)/.exec(fb?.target ?? '')?.[1])).toBeLessThan(48);
  });

  it('memory limit OOM-kills the job', async () => {
    const a = await attempt('jobc5');
    const r = await run(
      'jobc5',
      a,
      'node',
      ['--max-old-space-size=4096', '/workspace/probe.mjs', JSON.stringify({ memoryHogMiB: 1024 })],
      {
        limits: { memoryBytes: 128 * 1024 ** 2 },
      },
    );
    const exit = await r.proc.exited;
    expect(exit.code).toBe(137);
    expect(r.results.find((x) => x.probe === 'memory-hog')).toBeUndefined();
    await r.proc.dispose();
    expect(runner.finalState(r.proc)).toMatchObject({ oomKilled: true });
  });

  it('cancel reaps the whole tree, including a detached background process', async () => {
    const a = await attempt('jobc6');
    const r = await run('jobc6', a, 'node', [
      '/workspace/probe.mjs',
      JSON.stringify({ backgroundPidFile: '/workspace/bg.pid', hang: true }),
    ]);
    await r.waitFor('hanging');
    const name = runner.containerName(r.proc) ?? '';
    const top = execFileSync('docker', ['top', name, '-o', 'pid,args'], { encoding: 'utf8' });
    expect(top).toContain('setInterval');
    const outcome = await r.proc.terminate({ graceMs: 1000 });
    expect(['graceful', 'forced']).toContain(outcome.mode);
    expect(
      execFileSync('docker', ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('');
    await r.proc.dispose();
    expect(leftovers('jobc6')).toEqual([]);
  });

  it('git works inside the container on the per-attempt git dir; the mirror and trusted metadata stay untouched', async () => {
    const a = await attempt('jobc7');
    const snap = await snapshotTrustedGit(a.wsObj);
    const script = [
      'set -e',
      'git status --porcelain',
      'echo agent > agent.txt',
      'git -c user.name=a -c user.email=a@x add -A',
      'git -c user.name=a -c user.email=a@x commit -qm agent',
      'git rev-parse HEAD',
      'git update-ref refs/heads/rac/jobc7/a2 HEAD',
    ].join('\n');
    const r = await run('jobc7', a, 'sh', ['-c', script]);
    const exit = await r.proc.exited;
    expect(exit.code, r.proc.stderrTail()).toBe(0);
    const sha = r.proc.stdoutTail().trim().split('\n').pop() ?? '';
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(a.wsObj.mirrorPath, ['rev-parse', `refs/heads/${a.wsObj.branch}`])).toBe(a.wsObj.baseCommit);
    expect(git(a.wsObj.mirrorPath, ['rev-parse', 'refs/heads/rac/jobc7/a2'])).toBe(a.wsObj.baseCommit);
    expect(() => git(a.wsObj.mirrorPath, ['cat-file', '-e', sha])).toThrow();
    await assertTrustedGitUnchanged(snap);
    const tip = await a.manager.commit(a.wsObj, {
      message: 'result',
      author: { name: 'W', email: 'w@example.com' },
    });
    expect(git(a.wsObj.mirrorPath, ['show', `${tip}:agent.txt`])).toBe('agent');
  });

  it('runs the pinned Pi runtime image confined', async () => {
    const a = await attempt('jobc8');
    const r = await run('jobc8', { ws: a.ws }, 'pi', ['--version'], { runtime: 'pi' });
    const exit = await r.proc.exited;
    expect(exit.code, r.proc.stderrTail()).toBe(0);
    expect(r.proc.stdoutTail() + r.proc.stderrTail()).toContain(RUNTIME_PINS.pi.version);
  });
});
