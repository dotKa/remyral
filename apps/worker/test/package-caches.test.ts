import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxProfile } from '@remyral/protocol';
import { PackageCacheReport } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  cacheEligibility,
  cacheEnv,
  dirSize,
  forceRemove,
  PackageCaches,
  projectKey,
  workspaceHints,
} from '../src/caches/index.js';
import { HostRestrictedRunner } from '../src/sandbox/host/runner.js';
import { buildSeatbeltProfile } from '../src/sandbox/host/seatbelt.js';
import { DEFAULT_LIMITS } from '../src/sandbox/types.js';
import { tempDir } from './helpers.js';

/**
 * p6-warm-caches (ADR-0029): shared package caches per project on a machine — who gets one, which variables point
 * where, isolation between projects and trust levels, LRU eviction, and the macOS Seatbelt rules around them.
 */

const HOST_PROFILES: readonly SandboxProfile[] = ['host-restricted', 'runtime-sandbox', 'unconfined'];

describe('eligibility (ADR-0029 rules)', () => {
  const base = {
    machineEnabled: true,
    projectAllows: true,
    sourceTrust: 'trusted' as const,
    profile: 'host-restricted' as SandboxProfile,
    projectId: 'acme',
  };

  it('trusted jobs on every host profile get the cache', () => {
    for (const profile of HOST_PROFILES) expect(cacheEligibility({ ...base, profile })).toEqual({ ok: true });
  });

  it('untrusted sources never get one, whatever the profile or the project says', () => {
    for (const profile of [...HOST_PROFILES, 'container' as const]) {
      expect(cacheEligibility({ ...base, profile, sourceTrust: 'untrusted' })).toEqual({
        ok: false,
        reason: 'untrusted_source',
      });
    }
  });

  it('container jobs get none even from a trusted source', () => {
    expect(cacheEligibility({ ...base, profile: 'container' })).toEqual({
      ok: false,
      reason: 'container_profile',
    });
  });

  it('the machine switch and the project opt-out win first', () => {
    expect(cacheEligibility({ ...base, machineEnabled: false })).toEqual({
      ok: false,
      reason: 'machine_disabled',
    });
    expect(cacheEligibility({ ...base, projectAllows: false })).toEqual({
      ok: false,
      reason: 'project_disabled',
    });
    expect(cacheEligibility({ ...base, projectId: undefined })).toEqual({ ok: false, reason: 'no_project' });
  });
});

describe('environment per package manager', () => {
  it('POSIX: npm/pnpm/pip/uv/go always, Yarn classic, CARGO_HOME only with a per-attempt home', () => {
    const env = cacheEnv({
      platform: 'linux',
      projectDir: '/d/caches/host/k',
      cargoHome: '/w/sandboxes/j/a/cargo-home',
      hints: { pnpm: false, yarnBerry: false },
    });
    expect(env).toEqual({
      npm_config_cache: '/d/caches/host/k/npm',
      pnpm_config_store_dir: '/d/caches/host/k/pnpm',
      PIP_CACHE_DIR: '/d/caches/host/k/pip',
      UV_CACHE_DIR: '/d/caches/host/k/uv',
      GOMODCACHE: '/d/caches/host/k/go',
      YARN_CACHE_FOLDER: '/d/caches/host/k/yarn',
      CARGO_HOME: '/w/sandboxes/j/a/cargo-home',
    });
    // A shared Cargo home (config.toml, credentials, bin) is never handed out.
    expect(Object.values(env)).not.toContain('/d/caches/host/k/cargo');
  });

  it('pnpm repositories also get npm_config_store_dir (pnpm ≤ 10); Yarn Berry gets YARN_GLOBAL_FOLDER instead', () => {
    const env = cacheEnv({
      platform: 'darwin',
      projectDir: '/d/k',
      cargoHome: null,
      hints: { pnpm: true, yarnBerry: true },
    });
    expect(env.npm_config_store_dir).toBe('/d/k/pnpm');
    expect(env.YARN_GLOBAL_FOLDER).toBe('/d/k/yarn-berry');
    expect(env.YARN_CACHE_FOLDER).toBeUndefined();
    expect(env.CARGO_HOME).toBeUndefined();
  });

  it('Windows paths use backslashes', () => {
    const env = cacheEnv({
      platform: 'win32',
      projectDir: 'C:\\ProgramData\\RemyralWorker\\data\\caches\\host\\k',
      cargoHome: null,
      hints: { pnpm: false, yarnBerry: false },
    });
    expect(env.npm_config_cache).toBe('C:\\ProgramData\\RemyralWorker\\data\\caches\\host\\k\\npm');
    expect(env.GOMODCACHE).toBe('C:\\ProgramData\\RemyralWorker\\data\\caches\\host\\k\\go');
  });

  it('hints come from the workspace root', async () => {
    const ws = await tempDir('pc-hints-');
    expect(await workspaceHints(ws)).toEqual({ pnpm: false, yarnBerry: false });
    await writeFile(join(ws, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    await writeFile(join(ws, '.yarnrc.yml'), 'nodeLinker: pnp');
    expect(await workspaceHints(ws)).toEqual({ pnpm: true, yarnBerry: true });
  });
});

async function fixture(opts: { maxBytes?: number; enabled?: boolean } = {}) {
  const dir = await realpath(await tempDir('pc-'));
  const settings = { enabled: opts.enabled ?? true, maxBytes: opts.maxBytes ?? 10 * 1024 ** 3 };
  let now = new Date('2026-10-16T10:00:00.000Z');
  let changed = 0;
  const caches = new PackageCaches({
    root: join(dir, 'data', 'caches'),
    settings: () => settings,
    clock: () => now,
    onChanged: () => {
      changed++;
    },
    sweepDelayMs: 60_000,
  });
  const attempt = async (name: string): Promise<{ ws: string; sb: string }> => {
    const ws = join(dir, 'ws', 'jobs', name);
    const sb = join(dir, 'ws', 'sandboxes', name);
    await mkdir(ws, { recursive: true });
    await mkdir(sb, { recursive: true });
    return { ws, sb };
  };
  const req = (projectId: string, a: { ws: string; sb: string }, over: Record<string, unknown> = {}) => ({
    projectId,
    projectAllows: true,
    sourceTrust: 'trusted' as const,
    profile: 'host-restricted' as SandboxProfile,
    workspacePath: a.ws,
    sandboxDir: a.sb,
    ...over,
  });
  return {
    dir,
    caches,
    settings,
    attempt,
    req,
    tick: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    changed: () => changed,
  };
}

describe('PackageCaches: grants and isolation', () => {
  it('creates the project dir with one subdir per manager and points the env at it', async () => {
    const f = await fixture();
    const a = await f.attempt('a1');
    const r = await f.caches.acquire(f.req('acme', a));
    if (!r.ok) throw new Error(r.reason);
    const g = r.grant;
    expect(g.projectDir).toBe(join(f.dir, 'data', 'caches', 'host', projectKey('acme')));
    expect(g.dirs).toEqual([g.projectDir]);
    expect((await readdir(g.projectDir)).sort()).toEqual(
      ['cargo', 'go', 'meta.json', 'npm', 'pip', 'pnpm', 'uv', 'yarn', 'yarn-berry'].sort(),
    );
    expect(g.env.npm_config_cache).toBe(join(g.projectDir, 'npm'));
    expect(JSON.parse(await readFile(join(g.projectDir, 'meta.json'), 'utf8'))).toMatchObject({
      v: 1,
      projectId: 'acme',
    });
    // Cargo: a per-attempt CARGO_HOME whose registry index/cache and git db link into the shared dir.
    expect(g.env.CARGO_HOME).toBe(join(a.sb, 'cargo-home'));
    for (const [x, y] of [
      ['registry', 'index'],
      ['registry', 'cache'],
      ['git', 'db'],
    ] as const) {
      const link = join(a.sb, 'cargo-home', x, y);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(join(g.projectDir, 'cargo', x, y));
    }
    await g.release();
  });

  it('two projects never share a directory; a project id cannot name a path', async () => {
    const f = await fixture();
    const a = await f.attempt('a1');
    const b = await f.attempt('a2');
    const r1 = await f.caches.acquire(f.req('acme', a));
    const r2 = await f.caches.acquire(f.req('other:proj', b));
    if (!r1.ok || !r2.ok) throw new Error('refused');
    expect(r1.grant.projectDir).not.toBe(r2.grant.projectDir);
    expect(r2.grant.projectDir.endsWith(projectKey('other:proj'))).toBe(true);
    expect(r2.grant.projectDir).not.toContain(':proj');
  });

  it('untrusted and container jobs get nothing and no directory is created', async () => {
    const f = await fixture();
    const a = await f.attempt('a1');
    expect(await f.caches.acquire(f.req('acme', a, { sourceTrust: 'untrusted' }))).toEqual({
      ok: false,
      reason: 'untrusted_source',
    });
    expect(await f.caches.acquire(f.req('acme', a, { profile: 'container' }))).toEqual({
      ok: false,
      reason: 'container_profile',
    });
    expect(await f.caches.acquire(f.req('acme', a, { projectAllows: false }))).toEqual({
      ok: false,
      reason: 'project_disabled',
    });
    expect(existsSync(join(f.dir, 'data', 'caches'))).toBe(false);
  });

  it('unconfined leaves Cargo alone (the worker user keeps its own Cargo config)', async () => {
    const f = await fixture();
    const a = await f.attempt('a1');
    const r = await f.caches.acquire(f.req('acme', a, { profile: 'unconfined' }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.grant.env.CARGO_HOME).toBeUndefined();
    expect(existsSync(join(a.sb, 'cargo-home'))).toBe(false);
  });

  it('refuses a planted symlink in place of a project dir (the job runs without a cache)', async () => {
    const f = await fixture();
    const host = join(f.dir, 'data', 'caches', 'host');
    await mkdir(host, { recursive: true });
    const elsewhere = join(f.dir, 'elsewhere');
    await mkdir(elsewhere);
    const { symlink } = await import('node:fs/promises');
    await symlink(elsewhere, join(host, projectKey('acme')));
    const a = await f.attempt('a1');
    expect(await f.caches.acquire(f.req('acme', a))).toEqual({ ok: false, reason: 'cache_error' });
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('machine switch off or a 0 limit: no grants', async () => {
    const off = await fixture({ enabled: false });
    expect(await off.caches.acquire(off.req('acme', await off.attempt('x')))).toEqual({
      ok: false,
      reason: 'machine_disabled',
    });
    const zero = await fixture({ maxBytes: 0 });
    expect(await zero.caches.acquire(zero.req('acme', await zero.attempt('x')))).toEqual({
      ok: false,
      reason: 'machine_disabled',
    });
    expect(zero.caches.report()).toMatchObject({ enabled: false, disabledReason: 'limit_zero' });
    expect(off.caches.report()).toMatchObject({ enabled: false, disabledReason: 'local_config' });
  });
});

async function fill(dir: string, bytes: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `blob-${String(bytes)}`), Buffer.alloc(bytes, 1));
}

describe('PackageCaches: LRU sweep and report', () => {
  it('evicts the least recently used projects not in use until the total fits', async () => {
    const f = await fixture({ maxBytes: 2500 });
    const grants: Record<string, Awaited<ReturnType<PackageCaches['acquire']>>> = {};
    for (const p of ['old', 'mid', 'new', 'busy']) {
      f.tick(60_000);
      grants[p] = await f.caches.acquire(f.req(p, await f.attempt(p)));
    }
    const dirOf = (p: string): string => {
      const g = grants[p];
      if (g?.ok !== true) throw new Error('refused');
      return g.grant.projectDir;
    };
    for (const p of ['old', 'mid', 'new', 'busy']) await fill(join(dirOf(p), 'npm'), 1000);
    // 'busy' is the oldest use but still held; the others are returned in order old, mid, new.
    for (const p of ['old', 'mid', 'new']) {
      f.tick(1000);
      const g = grants[p];
      if (g?.ok === true) await g.grant.release();
    }
    const out = await f.caches.sweep();
    expect(out.evicted.map((e) => e.projectId)).toEqual(['old', 'mid']);
    expect(out.usedBytes).toBe(2000);
    expect(existsSync(dirOf('old'))).toBe(false);
    expect(existsSync(dirOf('busy'))).toBe(true);
    const report = PackageCacheReport.parse(f.caches.report());
    expect(report.usedBytes).toBe(2000);
    expect(report.projects.map((p) => [p.projectId, p.inUse])).toEqual(
      expect.arrayContaining([
        ['busy', true],
        ['new', false],
      ]),
    );
    expect(report.projects.find((p) => p.projectId === 'new')?.managers).toEqual([
      { manager: 'npm', bytes: 1000 },
    ]);
    expect(report.lastEviction).toMatchObject({ projects: 2, bytes: 2000 });
    expect(f.changed()).toBeGreaterThan(0);
    // Nothing is left in the trash.
    expect(await readdir(join(f.dir, 'data', 'caches', '.trash'))).toEqual([]);
  });

  it('p17-disk-selfclean: candidates are the caches not in use; evictForSpace never takes a held one', async () => {
    const f = await fixture();
    const held = await f.caches.acquire(f.req('busy', await f.attempt('a')));
    const free = await f.caches.acquire(f.req('idle', await f.attempt('b')));
    if (!held.ok || !free.ok) throw new Error('refused');
    await fill(join(held.grant.projectDir, 'npm'), 700);
    await fill(join(free.grant.projectDir, 'pip'), 900);
    await free.grant.release();
    const list = await f.caches.candidates();
    expect(list.map((c) => [c.projectId, c.bytes])).toEqual([['idle', 900]]);
    // A held cache is refused even when asked for by key.
    expect(await f.caches.evictForSpace(projectKey('busy'))).toBe(false);
    expect(await f.caches.evictForSpace('../etc')).toBe(false);
    expect(await f.caches.evictForSpace(projectKey('idle'))).toBe(900);
    expect(existsSync(free.grant.projectDir)).toBe(false);
    expect(existsSync(held.grant.projectDir)).toBe(true);
    expect(f.caches.report().lastEviction).toMatchObject({ projects: 1, bytes: 900 });
    expect(f.caches.report().projects.map((p) => p.projectId)).toEqual(['busy']);
    await held.grant.release();
  });

  it('a 0 limit empties every cache not in use; a new grant starts empty', async () => {
    const f = await fixture();
    const g = await f.caches.acquire(f.req('acme', await f.attempt('a')));
    if (!g.ok) throw new Error(g.reason);
    await fill(join(g.grant.projectDir, 'pip'), 500);
    await g.grant.release();
    f.settings.maxBytes = 0;
    expect((await f.caches.sweep()).usedBytes).toBe(0);
    f.settings.maxBytes = 1024 ** 3;
    const again = await f.caches.acquire(f.req('acme', await f.attempt('b')));
    if (!again.ok) throw new Error(again.reason);
    expect(await dirSize(again.grant.projectDir)).toBeLessThan(200); // meta.json only
  });

  it('removes a read-only tree (Go marks its module cache read-only)', async () => {
    const dir = await tempDir('pc-ro-');
    const mod = join(dir, 'go', 'example.com', 'm@v1.0.0');
    await mkdir(mod, { recursive: true });
    await writeFile(join(mod, 'go.mod'), 'module m');
    await chmod(join(mod, 'go.mod'), 0o444);
    await chmod(mod, 0o555);
    await chmod(join(dir, 'go', 'example.com'), 0o555);
    await forceRemove(join(dir, 'go'));
    expect(existsSync(join(dir, 'go'))).toBe(false);
  });

  it('dirSize does not follow symlinks out of the cache', async () => {
    const dir = await tempDir('pc-size-');
    await fill(join(dir, 'outside'), 4096);
    await fill(join(dir, 'cache'), 10);
    const { symlink } = await import('node:fs/promises');
    await symlink(join(dir, 'outside'), join(dir, 'cache', 'link'));
    expect(await dirSize(join(dir, 'cache'))).toBe(10);
  });
});

describe('Seatbelt rules for the cache dir (macOS host-restricted)', () => {
  const spec = {
    workspace: '/r/jobs/j/a',
    sandboxDir: '/r/sandboxes/j/a',
    workspaceRoot: '/r',
    workerDataDir: '/d',
    readableInDataDir: ['/d/runtimes'],
    homes: [],
  };

  it('the project cache dir is writable and carved out of the data dir; its parents allow lookup only', () => {
    const { profile, params } = buildSeatbeltProfile({ ...spec, cacheDirs: ['/d/caches/host/k1'] });
    const values = Object.values(params);
    expect(values).toContain('/d/caches/host/k1');
    expect(values).toContain('/d/caches');
    expect(values).toContain('/d/caches/host');
    // The cache dir is in the single allow-write rule.
    const allowWrite = profile.split('\n').find((l) => l.startsWith('(allow file-write*'));
    const key = Object.entries(params).find(([, v]) => v === '/d/caches/host/k1')?.[0];
    expect(allowWrite).toContain(`(param "${String(key)}")`);
    // Lookup-only parents: no listing.
    for (const parent of ['/d', '/d/caches', '/d/caches/host']) {
      const keys = Object.entries(params)
        .filter(([, v]) => v === parent)
        .map(([k]) => k);
      expect(
        keys.some((k) => profile.includes(`(deny file-read-data file-read-xattr (literal (param "${k}")))`)),
      ).toBe(true);
    }
  });

  it('without a cache the profile is unchanged (no extra writable path)', () => {
    const { profile } = buildSeatbeltProfile(spec);
    const allowWrite = profile.split('\n').find((l) => l.startsWith('(allow file-write*')) ?? '';
    expect(allowWrite.match(/\(subpath/g)).toHaveLength(2);
  });

  it.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))(
    'live: writes into its own project cache, cannot read another project’s cache or the device key',
    async () => {
      const root = await realpath(await tempDir('pc-sb-'));
      const data = join(root, 'data');
      const work = join(root, 'work');
      const ws = join(work, 'jobs', 'j', 'a');
      const sb = join(work, 'sandboxes', 'j', 'a');
      const mine = join(data, 'caches', 'host', projectKey('acme'));
      const theirs = join(data, 'caches', 'host', projectKey('other'));
      for (const d of [ws, sb, join(mine, 'npm'), join(theirs, 'npm')]) await mkdir(d, { recursive: true });
      await writeFile(join(data, 'device-key.json'), 'SECRET-KEY');
      await writeFile(join(theirs, 'npm', 'entry'), 'THEIRS');
      const { argv } = buildSeatbeltProfile({
        workspace: ws,
        sandboxDir: sb,
        workspaceRoot: work,
        workerDataDir: data,
        readableInDataDir: [join(data, 'runtimes')],
        cacheDirs: [mine],
        homes: [],
      });
      const run = (cmd: string[]) =>
        spawnSync(argv[0] ?? '', [...argv.slice(1), ...cmd], { encoding: 'utf8', cwd: ws });
      const w = run([
        '/bin/sh',
        '-c',
        `echo cached > ${join(mine, 'npm', 'entry')} && cat ${join(mine, 'npm', 'entry')}`,
      ]);
      expect(w.stdout.trim()).toBe('cached');
      expect(run(['/bin/cat', join(theirs, 'npm', 'entry')]).status).not.toBe(0);
      expect(run(['/bin/sh', '-c', `echo x > ${join(theirs, 'npm', 'planted')}`]).status).not.toBe(0);
      expect(run(['/bin/ls', join(data, 'caches', 'host')]).status).not.toBe(0);
      expect(run(['/bin/cat', join(data, 'device-key.json')]).status).not.toBe(0);
    },
  );
});

describe('host runner: env injection per profile', () => {
  const identity = { verified: true, username: 'remyral', uid: 1001, problems: [] };

  async function confineWith(mode: 'restricted' | 'unconfined', withCache: boolean) {
    const root = await realpath(await tempDir('pc-host-'));
    const ws = join(root, 'jobs', 'j', 'a');
    await mkdir(ws, { recursive: true });
    const runner = new HostRestrictedRunner({
      identity,
      workspaceRoot: root,
      workerDataDir: join(root, 'data'),
      platform: 'linux',
      mode,
      unconfinedAllowed: () => ({ allowed: true }),
    });
    const confined = await runner
      .confiner({
        jobId: 'j',
        attemptId: 'a',
        workspacePath: ws,
        network: { mode: 'none' },
        limits: DEFAULT_LIMITS,
        ...(withCache
          ? {
              packageCaches: {
                dirs: ['/d/caches/host/k'],
                env: { npm_config_cache: '/d/caches/host/k/npm', PIP_CACHE_DIR: '/d/caches/host/k/pip' },
              },
            }
          : {}),
      })
      .confine({ command: '/bin/true', args: [], cwd: '/', env: { PATH: '/usr/bin' }, secretNames: [] });
    await confined.dispose?.();
    return confined.env;
  }

  it('host-restricted and unconfined runtimes get the variables of the grant', async () => {
    for (const mode of ['restricted', 'unconfined'] as const) {
      const env = await confineWith(mode, true);
      expect(env.npm_config_cache).toBe('/d/caches/host/k/npm');
      expect(env.PIP_CACHE_DIR).toBe('/d/caches/host/k/pip');
    }
  });

  it('without a grant no cache variable is set', async () => {
    const env = await confineWith('restricted', false);
    for (const k of ['npm_config_cache', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'GOMODCACHE', 'CARGO_HOME']) {
      expect(env[k]).toBeUndefined();
    }
  });
});
