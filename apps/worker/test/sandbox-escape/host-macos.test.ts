import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OwnedProcess } from '@remyral/agent-adapters';
import {
  assertTrustedGitUnchanged,
  createAttemptGitView,
  snapshotTrustedGit,
} from '../../src/sandbox/attempt-git.js';
import { isForbiddenAddress } from '../../src/sandbox/network.js';
import { HostRestrictedRunner } from '../../src/sandbox/host/runner.js';
import { seatbeltStatus } from '../../src/sandbox/host/seatbelt.js';
import { DEFAULT_LIMITS, type NetworkPolicy } from '../../src/sandbox/types.js';
import { WorkspaceManager, type Workspace } from '../../src/workspace/manager.js';
import { createOrigin, git } from '../git-fixtures.js';
import { tempDir } from '../helpers.js';
import { alive, collect, expectOutcome, PROBE } from './harness.js';

/**
 * ADR-0007 `host-restricted` on macOS with the real Seatbelt (`sandbox-exec`).
 * Runs as the developer's user (an admin, so the identity check is bypassed with
 * the test-only flag); every secret is a FAKE in a temp dir — real user secrets
 * are never targeted. Fork-bomb and memory probes are NOT run on the host (they
 * would hit the developer's session; RLIMIT_NPROC is per user and memory is not
 * enforceable with rlimits — see p3-sandbox.md).
 */
const enabled = process.platform === 'darwin' && (await seatbeltStatus()).available;
const T = { timeout: 180_000 };

describe.skipIf(!enabled)('host-restricted escape suite (real macOS Seatbelt)', T, () => {
  let upstream: Server;
  let upstreamPort = 0;
  const procs: OwnedProcess[] = [];

  beforeAll(async () => {
    upstream = createServer((s) => s.end('upstream-ok\n'));
    await new Promise<void>((r) =>
      upstream.listen(0, '127.0.0.1', () => {
        r();
      }),
    );
    upstreamPort = (upstream.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) =>
      upstream.close(() => {
        r();
      }),
    );
  });
  afterEach(async () => {
    await Promise.all(procs.splice(0).map((p) => p.dispose()));
  });

  async function setup() {
    const dir = await realpath(await tempDir('rw-sbx-h-'));
    const origin = await createOrigin(dir, 'origin', { 'README.md': 'hello\n' });
    const manager = await WorkspaceManager.create({
      root: join(dir, 'root'),
      projects: { proj: [origin.url] },
      allowFileUrls: true,
      freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    });
    const prep = (a: string): Promise<Workspace> =>
      manager.prepare({
        projectId: 'proj',
        jobId: 'jobh',
        attemptId: a,
        epoch: 1,
        repository: { url: origin.url, baseRef: 'main' },
      });
    const ws = await prep('a1');
    const other = await prep('a2');
    const view = await createAttemptGitView({ root: manager.root, ws, git: manager.git });
    // FAKE secrets only.
    const fakeHome = join(dir, 'fakehome');
    for (const [rel, content] of [
      ['.ssh/id_ed25519', 'FAKE-SSH-KEY'],
      ['Library/Keychains/login.keychain-db', 'FAKE-KEYCHAIN'],
      ['Library/Application Support/Google/Chrome/Default/Cookies', 'FAKE-COOKIES'],
      ['.aws/credentials', 'FAKE-AWS'],
    ] as const) {
      await mkdir(join(fakeHome, rel, '..'), { recursive: true });
      await writeFile(join(fakeHome, rel), content);
    }
    const dataDir = join(dir, 'worker-data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'device.key'), 'FAKE-DEVICE-KEY');
    const runner = new HostRestrictedRunner({
      identity: {
        verified: false,
        username: 'test',
        uid: process.getuid?.() ?? null,
        problems: ['developer machine'],
      },
      unsafeAllowUnverifiedIdentityForTests: true,
      workspaceRoot: manager.root,
      workerDataDir: dataDir,
      platform: 'darwin',
      protectedHomes: [fakeHome],
      // The test upstream is on loopback; the real filter stays for everything else.
      proxyIsForbidden: (a) => a !== '127.0.0.1' && isForbiddenAddress(a),
      proxyLookup: (h) =>
        h === 'allowed.example.com'
          ? Promise.resolve([{ address: '127.0.0.1', family: 4 }])
          : Promise.reject(new Error('ENOTFOUND')),
    });
    return { dir, manager, ws, other, view, fakeHome, dataDir, runner };
  }

  async function launch(
    s: Awaited<ReturnType<typeof setup>>,
    command: string,
    args: string[],
    network: NetworkPolicy = { mode: 'none' },
  ) {
    const proc = await s.runner.launch({
      jobId: 'jobh',
      attemptId: 'a1',
      workspacePath: s.ws.path,
      git: s.view,
      network,
      // RLIMIT_NPROC counts the developer's own processes here; keep it above them.
      limits: { ...DEFAULT_LIMITS, pids: 2000 },
      command,
      args,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: s.fakeHome, LANG: 'C' },
      stdin: 'ignore',
    });
    procs.push(proc);
    return { proc, ...collect(proc) };
  }

  it('denies writes outside the attempt, secret/other-attempt/worker-key reads, network except the proxy allowlist', async () => {
    const s = await setup();
    const root = s.manager.root;
    const cfg = {
      writeOutside: [
        join(s.fakeHome, 'escape'),
        join(s.dataDir, 'escape'),
        join(s.other.path, 'escape'),
        join(root, 'jobs', 'jobh', 'escape'),
        join(s.ws.mirrorPath, 'config'),
        join(s.ws.mirrorPath, 'refs', 'heads', 'rac', 'jobh', 'a2'),
        join(s.ws.path, '.git'),
        '/private/tmp/remyral-sbx-escape-probe',
        join(s.dir, 'escape'),
      ],
      writeInside: join(s.ws.path, 'inside.txt'),
      readSecrets: [
        join(s.fakeHome, '.ssh', 'id_ed25519'),
        join(s.fakeHome, 'Library', 'Keychains', 'login.keychain-db'),
        join(s.fakeHome, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies'),
        join(s.fakeHome, '.aws', 'credentials'),
        join(s.dataDir, 'device.key'),
        join(s.other.path, 'README.md'),
        join(s.ws.mirrorPath, 'config'),
      ],
      listDirs: [
        s.other.path,
        join(s.ws.mirrorPath, 'refs'),
        join(root, '.remyral'),
        join(s.fakeHome, '.ssh'),
      ],
      lanIp: '192.168.1.1',
      proxy: 'env',
      proxyAllowed: [`allowed.example.com:${String(upstreamPort)}`],
      proxyDenied: ['example.org:443', `127.0.0.1:${String(upstreamPort)}`],
      listenPort: 0,
    };
    const r = await launch(s, process.execPath, [PROBE, JSON.stringify(cfg)], {
      mode: 'allowlist',
      targets: [{ host: 'allowed.example.com', port: upstreamPort }],
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
    expectOutcome(r.results, 'listen-any-interface', 'denied');
    expect(await readFile(join(s.ws.path, 'inside.txt'), 'utf8')).toBe('ok');
  });

  it('git works on the per-attempt git dir under Seatbelt; mirror and trusted metadata untouched', async () => {
    const s = await setup();
    const snap = await snapshotTrustedGit(s.ws);
    const script = [
      'set -e',
      'git status --porcelain',
      'echo agent > agent.txt',
      'git -c user.name=a -c user.email=a@x add -A',
      'git -c user.name=a -c user.email=a@x commit -qm agent',
      'git rev-parse HEAD',
    ].join('\n');
    const r = await launch(s, '/bin/sh', ['-c', script]);
    const exit = await r.proc.exited;
    expect(exit.code, r.proc.stderrTail()).toBe(0);
    const sha = r.proc.stdoutTail().trim().split('\n').pop() ?? '';
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(s.ws.mirrorPath, ['rev-parse', `refs/heads/${s.ws.branch}`])).toBe(s.ws.baseCommit);
    expect(() => git(s.ws.mirrorPath, ['cat-file', '-e', sha])).toThrow();
    await assertTrustedGitUnchanged(snap);
  });

  it('a detached background process does not survive cancel/dispose', async () => {
    const s = await setup();
    const pidFile = join(s.ws.path, 'bg.pid');
    const r = await launch(s, process.execPath, [
      PROBE,
      JSON.stringify({ backgroundPidFile: pidFile, hang: true }),
    ]);
    await r.waitFor('hanging');
    const bg = Number(await readFile(pidFile, 'utf8'));
    expect(alive(bg)).toBe(true);
    await r.proc.terminate({ graceMs: 500 });
    await r.proc.dispose();
    const deadline = Date.now() + 5000;
    while (alive(bg) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    expect(alive(bg)).toBe(false);
  });

  it('applies rlimits to the confined tree', async () => {
    const s = await setup();
    const r = await launch(s, '/bin/sh', ['-c', 'ulimit -n; ulimit -f; ulimit -c']);
    await r.proc.exited;
    expect(r.proc.stdoutTail().trim().split('\n')).toEqual([
      String(DEFAULT_LIMITS.openFiles),
      String(DEFAULT_LIMITS.fileSizeBytes / 1024),
      '0',
    ]);
  });
});
