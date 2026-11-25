import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DiskHygieneReport, DiskHygieneRun } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { pathApi } from '../src/config/paths.js';
import {
  type Candidate,
  DiskHygiene,
  type DiskEntry,
  fileHygieneState,
  type HygieneFs,
  type HygieneSource,
  type HygieneState,
  hygieneSettings,
  isPreRenameLog,
  isRotatedLog,
  logsSource,
  measureUsage,
  nodeHygieneFs,
  notOurs,
  packageCachesSource,
  releasesSource,
  runtimesSource,
  tempSource,
  workspacesSource,
} from '../src/disk/index.js';
import { createNodeFileOps } from '../src/fs/ops.js';
import { tempDir } from './helpers.js';

/**
 * p17-disk-selfclean (docs/design/p17-disk-selfclean.md): the worker cleans what it owns when its disk runs low. Every
 * rule runs against an in-memory file system with Linux, macOS and Windows path shapes — what is deleted, what never
 * is (a running / parked / recoverable job's directories, pinned or unexpired kept files, the active runtime, a held
 * cache, a staged release an update still needs), the order, the target, and the usage report that names no user file.
 */

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const NOW = new Date('2026-10-25T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Node {
  kind: 'dir' | 'file' | 'link';
  size: number;
  mtimeMs: number;
}

/** A small in-memory file system (absolute paths of one platform's shape; links are never followed). */
class FakeFs implements HygieneFs {
  readonly nodes = new Map<string, Node>();
  readonly removed: string[] = [];
  /** Paths whose removal fails (in use). */
  readonly stuck = new Set<string>();
  /** p17-worker-managed: paths another account owns (EPERM, as on Windows for per-job accounts' folders). */
  readonly foreign = new Map<string, 'EPERM' | 'EACCES'>();
  free: number | null;
  readonly #p: ReturnType<typeof pathApi>;

  constructor(
    readonly platform: NodeJS.Platform,
    free: number | null,
  ) {
    this.free = free;
    this.#p = pathApi(platform);
  }

  #parents(path: string, mtimeMs: number): void {
    let cur = this.#p.dirname(path);
    while (cur !== this.#p.dirname(cur)) {
      if (!this.nodes.has(cur)) this.nodes.set(cur, { kind: 'dir', size: 0, mtimeMs });
      cur = this.#p.dirname(cur);
    }
  }

  file(path: string, size: number, mtimeMs = NOW.getTime() - 10 * DAY): this {
    this.#parents(path, mtimeMs);
    this.nodes.set(path, { kind: 'file', size, mtimeMs });
    return this;
  }

  dir(path: string, mtimeMs = NOW.getTime() - 10 * DAY): this {
    this.#parents(path, mtimeMs);
    this.nodes.set(path, { kind: 'dir', size: 0, mtimeMs });
    return this;
  }

  link(path: string): this {
    this.#parents(path, 0);
    this.nodes.set(path, { kind: 'link', size: 0, mtimeMs: 0 });
    return this;
  }

  #under(path: string): string[] {
    const prefix = path.endsWith(this.#p.sep) ? path : `${path}${this.#p.sep}`;
    return [...this.nodes.keys()].filter((k) => k === path || k.startsWith(prefix));
  }

  async list(dir: string): Promise<DiskEntry[]> {
    const out: DiskEntry[] = [];
    for (const [k, n] of this.nodes) {
      if (k !== dir && this.#p.dirname(k) === dir)
        out.push({ name: this.#p.basename(k), kind: n.kind, size: n.size, mtimeMs: n.mtimeMs });
    }
    return Promise.resolve(out);
  }

  async entry(path: string): Promise<DiskEntry | null> {
    const n = this.nodes.get(path);
    return Promise.resolve(
      n === undefined
        ? null
        : { name: this.#p.basename(path), kind: n.kind, size: n.size, mtimeMs: n.mtimeMs },
    );
  }

  async treeSize(path: string): Promise<{ bytes: number; partial: boolean }> {
    const n = this.nodes.get(path);
    // A link itself is the entry: never followed.
    if (n?.kind === 'link') return Promise.resolve({ bytes: 0, partial: false });
    const bytes = this.#under(path).reduce((s, k) => s + (this.nodes.get(k)?.size ?? 0), 0);
    return Promise.resolve({ bytes, partial: false });
  }

  async remove(path: string): Promise<void> {
    if (this.stuck.has(path)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    const foreign = this.foreign.get(path);
    if (foreign !== undefined) throw Object.assign(new Error(foreign), { code: foreign });
    let bytes = 0;
    for (const k of this.#under(path)) {
      bytes += this.nodes.get(k)?.size ?? 0;
      this.nodes.delete(k);
    }
    this.removed.push(path);
    if (this.free !== null) this.free += bytes;
    return Promise.resolve();
  }

  async freeBytes(): Promise<number | null> {
    return Promise.resolve(this.free);
  }
}

interface Layout {
  readonly platform: NodeJS.Platform;
  readonly dataDir: string;
  readonly workspaceRoot: string;
}

const LAYOUTS: readonly Layout[] = [
  { platform: 'linux', dataDir: '/var/lib/remyral-worker', workspaceRoot: '/srv/remyral/workspaces' },
  {
    platform: 'darwin',
    dataDir: '/Library/Application Support/RemyralWorker/data',
    workspaceRoot: '/Users/Shared/RemyralWorkspaces',
  },
  {
    platform: 'win32',
    dataDir: 'C:\\ProgramData\\RemyralWorker\\data',
    workspaceRoot: 'D:\\RemyralWorkspaces',
  },
];

describe.each(LAYOUTS)('temporary leftovers ($platform)', (l) => {
  const p = pathApi(l.platform);
  const sb = (...s: string[]) => p.join(l.workspaceRoot, 'sandboxes', ...s);

  it('drops old sandboxes of finished jobs; never an active, parked, recoverable, service or young one', async () => {
    const fs = new FakeFs(l.platform, GiB)
      .file(sb('job-done', 'att-1', 'tmp', 'big.bin'), 300 * MiB, NOW.getTime() - 3 * HOUR)
      .file(sb('job-running', 'att-1', 'x'), MiB, NOW.getTime() - 3 * HOUR)
      .file(sb('job-parked', 'att-1', 'x'), MiB, NOW.getTime() - 3 * HOUR)
      .file(sb('job-recover', 'att-1', 'x'), MiB, NOW.getTime() - 3 * HOUR)
      .file(sb('svc-web', 'run', 'x'), MiB, NOW.getTime() - 3 * HOUR)
      .file(sb('.slot-selftest-1234', 'x'), MiB, NOW.getTime() - 3 * HOUR)
      .file(sb('job-young', 'att-1', 'x'), MiB, NOW.getTime() - 10 * 60_000)
      .file(p.join(l.workspaceRoot, '.remyral', 'parked', 'job-parked.json'), 100)
      .file(p.join(l.workspaceRoot, '.remyral', 'continuity', 'job-recover.json'), 100)
      .file(p.join(l.dataDir, 'caches', '.trash', 'abc-1234', 'npm', 'pkg.tgz'), 50 * MiB)
      .file(
        p.join(l.dataDir, 'runtime-verify', 'codex', 'cand-old', 'bin'),
        20 * MiB,
        NOW.getTime() - 7 * HOUR,
      )
      .file(p.join(l.dataDir, 'runtime-verify', 'codex', 'cand-now', 'bin'), 20 * MiB, NOW.getTime() - HOUR);
    // Young: the job dir's newest child decides (a dir mtime changes when an entry is added).
    fs.nodes.set(sb('job-young'), { kind: 'dir', size: 0, mtimeMs: NOW.getTime() - 5 * HOUR });
    const src = tempSource({
      fs,
      dataDir: l.dataDir,
      workspaceRoot: l.workspaceRoot,
      activeJobs: () => new Set(['job-running']),
    });
    const got = await src.collect(NOW);
    expect(got.every((c) => c.light && c.category === 'temp')).toBe(true);
    expect(got.map((c) => c.label).sort()).toEqual(
      ['caches/.trash/abc-1234', 'runtime-verify/codex/cand-old', 'sandboxes/job-done'].sort(),
    );
    expect(got.find((c) => c.label === 'sandboxes/job-done')?.bytes).toBe(300 * MiB);
    for (const c of got) await c.remove();
    expect(fs.removed).toContain(sb('job-done'));
    expect(fs.nodes.has(sb('job-running', 'att-1', 'x'))).toBe(true);
    expect(fs.nodes.has(sb('job-parked', 'att-1', 'x'))).toBe(true);
    expect(fs.nodes.has(sb('svc-web', 'run', 'x'))).toBe(true);
  });

  it('logs: rotated generations only — beyond the cap / age always, the rest only while low', async () => {
    const logs = p.join(l.dataDir, 'logs');
    const fs = new FakeFs(l.platform, GiB)
      .file(p.join(logs, 'worker.log'), 4 * MiB, NOW.getTime())
      .file(p.join(logs, 'worker.log.1'), 4 * MiB, NOW.getTime() - HOUR)
      .file(p.join(logs, 'boot.log'), MiB, NOW.getTime())
      .file(p.join(logs, 'boot.log.1'), MiB, NOW.getTime() - 40 * DAY)
      .file(p.join(logs, 'old.log.2.gz'), 70 * MiB, NOW.getTime() - 2 * HOUR)
      .file(p.join(logs, 'notes.txt'), 9 * MiB, NOW.getTime() - 90 * DAY);
    const got = await logsSource({ fs, dirs: [logs], capBytes: 64 * MiB }).collect(NOW);
    const by = Object.fromEntries(got.map((c) => [c.label, c.light]));
    // worker.log.1 (newest, under the cap) only while low; the 70 MiB generation is over the cap; boot.log.1 is old.
    expect(by).toEqual({ 'logs/worker.log.1': false, 'logs/old.log.2.gz': true, 'logs/boot.log.1': true });
  });
});

describe('pre-rename logs (Remyral cut-over leftovers)', () => {
  const w = pathApi('win32');
  const logs = 'C:\\ProgramData\\RemyralWorker\\logs';
  const fs = () =>
    new FakeFs('win32', GiB)
      .file(w.join(logs, 'remyral-worker_rCURRENT.log'), MiB, NOW.getTime())
      .file(w.join(logs, 'shawl_rCURRENT.log'), MiB, NOW.getTime())
      .file(w.join(logs, 'remana-worker_rCURRENT.log'), 3 * MiB, NOW.getTime() - DAY)
      .file(w.join(logs, 'remana-worker_r2026-10-20_10-00-00.log'), 2 * MiB, NOW.getTime() - 5 * DAY)
      .file(w.join(logs, 'remana-worker.cfg'), MiB, NOW.getTime() - 90 * DAY)
      .file(w.join(logs, 'sub', 'remana-worker_rCURRENT.log'), MiB, NOW.getTime() - 90 * DAY)
      .file('C:\\ProgramData\\RemanaWorker\\logs\\remana-worker_rCURRENT.log', MiB, NOW.getTime() - 90 * DAY);

  it('removes the live and rotated logs of the pre-rename service in the worker logs dir, always light', async () => {
    const f = fs();
    const got = await logsSource({ fs: f, dirs: [logs], capBytes: 64 * MiB }).collect(NOW);
    const by = Object.fromEntries(got.map((c) => [c.label, c.light]));
    expect(by).toEqual({
      'logs/remana-worker_rCURRENT.log': true,
      'logs/remana-worker_r2026-10-20_10-00-00.log': true,
    });
    for (const c of got) await c.remove();
    expect(f.removed.sort()).toEqual([
      w.join(logs, 'remana-worker_r2026-10-20_10-00-00.log'),
      w.join(logs, 'remana-worker_rCURRENT.log'),
    ]);
    // Never the live Remyral logs, other names, sub directories or a dir outside the worker's own logs dirs.
    expect(f.nodes.has(w.join(logs, 'remyral-worker_rCURRENT.log'))).toBe(true);
    expect(f.nodes.has(w.join(logs, 'remana-worker.cfg'))).toBe(true);
    expect(f.nodes.has(w.join(logs, 'sub', 'remana-worker_rCURRENT.log'))).toBe(true);
    expect(f.nodes.has('C:\\ProgramData\\RemanaWorker\\logs\\remana-worker_rCURRENT.log')).toBe(true);
  });

  it('matches only the legacy prefix', () => {
    for (const n of ['remana-worker_rCURRENT.log', 'remana-worker_r2026-10-24_10-00-00.log'])
      expect(isPreRenameLog(n), n).toBe(true);
    for (const n of [
      'remyral-worker_rCURRENT.log',
      'shawl_rCURRENT.log',
      'remana-worker.log',
      'xremana-worker_rCURRENT.log',
      'remana-worker_rCURRENT.log.bak',
      '..\\remana-worker_rCURRENT.log',
    ])
      expect(isPreRenameLog(n), n).toBe(false);
  });
});

describe('rotated log names', () => {
  it('knows the worker, logrotate / newsyslog and shawl generations; never the live file', () => {
    for (const n of [
      'worker.log.1',
      'boot.log.2',
      'updater.log.1',
      'x.log.old',
      'x.log.3.gz',
      'remyral-worker_r2026-10-24_10-00-00.log',
      'shawl_r2026-10-24_10-00-00_r1.log',
    ])
      expect(isRotatedLog(n), n).toBe(true);
    for (const n of [
      'worker.log',
      'boot.log',
      'remyral-worker_rCURRENT.log',
      'shawl_rCURRENT.log',
      'notes.txt',
      '../worker.log.1',
      '.hidden.log.1',
    ])
      expect(isRotatedLog(n), n).toBe(false);
  });
});

describe('staged releases', () => {
  const staged = '/var/lib/remyral-worker/updates/staged';
  const fs = () =>
    new FakeFs('linux', GiB)
      .file(`${staged}/1.1.2/remyral-worker.mjs`, 30 * MiB)
      .file(`${staged}/1.1.3/remyral-worker.mjs`, 30 * MiB);

  it('never while an update is in flight; never the version a pending activation names', async () => {
    expect(
      await releasesSource({
        fs: fs(),
        stagedDir: staged,
        busy: () => true,
        pending: () => Promise.resolve(null),
      }).collect(NOW),
    ).toEqual([]);
    const f = fs();
    let pending: string | null = '1.1.3';
    const got = await releasesSource({
      fs: f,
      stagedDir: staged,
      busy: () => false,
      pending: () => Promise.resolve(pending),
    }).collect(NOW);
    expect(got.map((c) => [c.label, c.light, c.bytes])).toEqual([['updates/staged/1.1.2', true, 30 * MiB]]);
    // Re-checked at removal time: an activation that names it since keeps it.
    pending = '1.1.2';
    expect(await got[0]?.remove()).toBe(false);
    pending = null;
    expect(await got[0]?.remove()).toBe(30 * MiB);
  });
});

describe('kept and retained working directories', () => {
  const kept = [
    {
      jobId: 'j-exp',
      attemptId: 'a1',
      sizeBytes: 5 * GiB,
      expiresAt: '2026-10-20T00:00:00.000Z',
      pinnedUntil: null,
    },
    {
      jobId: 'j-pinned',
      attemptId: 'a1',
      sizeBytes: 5 * GiB,
      expiresAt: '2026-10-20T00:00:00.000Z',
      pinnedUntil: '2026-10-30T00:00:00.000Z',
    },
    {
      jobId: 'j-live',
      attemptId: 'a1',
      sizeBytes: 5 * GiB,
      expiresAt: '2026-11-20T00:00:00.000Z',
      pinnedUntil: null,
    },
    {
      jobId: 'j-active',
      attemptId: 'a1',
      sizeBytes: 5 * GiB,
      expiresAt: '2026-10-01T00:00:00.000Z',
      pinnedUntil: null,
    },
    { jobId: 'j-bad', attemptId: 'a1', sizeBytes: 5 * GiB, expiresAt: 'not a date', pinnedUntil: null },
  ];

  it('only expired, unpinned kept directories of jobs not running, and retained failures — only while low', async () => {
    const removedKept: string[] = [];
    const removedRetained: string[] = [];
    const fs = new FakeFs('linux', GiB).file('/ws/jobs/j-fail/a2/node_modules/x', 2 * GiB);
    const src = workspacesSource({
      fs,
      activeJobs: () => new Set(['j-active', 'j-run']),
      kept: {
        list: () => kept,
        remove: (j, a) => {
          removedKept.push(`${j}/${a}`);
          return Promise.resolve(true);
        },
      },
      retained: {
        list: () =>
          Promise.resolve([
            { jobId: 'j-fail', attemptId: 'a2', retainedAt: '2026-10-21T00:00:00.000Z' },
            { jobId: 'j-run', attemptId: 'a1', retainedAt: '2026-10-21T00:00:00.000Z' },
          ]),
        dir: (j, a) => `/ws/jobs/${j}/${a}`,
        remove: (j, a) => {
          removedRetained.push(`${j}/${a}`);
          return Promise.resolve(true);
        },
      },
    });
    const got = await src.collect(NOW);
    expect(got.map((c) => [c.label, c.light, c.bytes])).toEqual([
      ['kept/j-exp/a1', false, 5 * GiB],
      ['jobs/j-fail/a2 (failed, kept for inspection)', false, 2 * GiB],
    ]);
    for (const c of got) await c.remove();
    expect(removedKept).toEqual(['j-exp/a1']);
    expect(removedRetained).toEqual(['j-fail/a2']);
  });
});

describe('managed runtime versions', () => {
  it('never the active one or one of a busy runtime; the newest inactive only while low', async () => {
    const fs = new FakeFs('win32', GiB)
      .file('C:\\d\\runtimes\\codex\\0.160.0\\codex.exe', 100 * MiB)
      .file('C:\\d\\runtimes\\codex\\0.161.0\\codex.exe', 100 * MiB)
      .file('C:\\d\\runtimes\\codex\\0.162.1\\codex.exe', 100 * MiB)
      .file('C:\\d\\runtimes\\pi\\1.0.0\\pi.js', 10 * MiB);
    const removed: string[] = [];
    const installs = [
      { runtime: 'codex', version: '0.160.0', installedAt: '2026-09-01T00:00:00.000Z', active: false },
      { runtime: 'codex', version: '0.161.0', installedAt: '2026-10-01T00:00:00.000Z', active: false },
      { runtime: 'codex', version: '0.162.1', installedAt: '2026-10-20T00:00:00.000Z', active: true },
      { runtime: 'pi', version: '1.0.0', installedAt: '2026-09-01T00:00:00.000Z', active: false },
    ].map((i) => ({ ...i, dir: `C:\\d\\runtimes\\${i.runtime}\\${i.version}` }));
    const src = runtimesSource({
      fs,
      runtimes: {
        installs: () => installs,
        busy: (rt) => rt === 'pi',
        remove: (rt, v) => {
          removed.push(`${rt}@${v}`);
          return Promise.resolve();
        },
      },
    });
    const got = await src.collect(NOW);
    expect(got.map((c) => [c.label, c.light, c.bytes])).toEqual([
      ['runtimes/codex/0.161.0', false, 100 * MiB],
      ['runtimes/codex/0.160.0', true, 100 * MiB],
    ]);
    for (const c of got) await c.remove();
    expect(removed).toEqual(['codex@0.161.0', 'codex@0.160.0']);
  });
});

/** A source of fixed candidates removing from the fake file system. */
function fixed(
  fs: FakeFs,
  category: Candidate['category'],
  items: [string, number, number, boolean][],
): HygieneSource {
  return {
    category,
    collect: () =>
      Promise.resolve(
        items
          .filter(([path]) => fs.nodes.has(path))
          .map(([path, bytes, at, light]) => ({
            category,
            label: path,
            bytes,
            at,
            light,
            remove: async () => {
              await fs.remove(path);
              return bytes;
            },
          })),
      ),
  };
}

function memState(initial: HygieneState | null = null) {
  let saved = initial;
  return {
    port: {
      load: () => Promise.resolve(saved),
      save: (s: HygieneState) => {
        saved = s;
        return Promise.resolve();
      },
    },
    get: () => saved,
  };
}

describe.each(LAYOUTS)('the engine ($platform)', (l) => {
  const p = pathApi(l.platform);
  const d = (...s: string[]) => p.join(l.dataDir, ...s);
  const w = (...s: string[]) => p.join(l.workspaceRoot, ...s);

  function setup(free: number | null, settings = hygieneSettings(2 * GiB, undefined)) {
    const fs = new FakeFs(l.platform, free)
      .file(d('logs', 'worker.log.1'), 4 * MiB)
      .file(d('caches', 'host', 'aaa', 'npm', 'x'), GiB, NOW.getTime() - 5 * DAY)
      .file(d('caches', 'host', 'bbb', 'npm', 'x'), GiB, NOW.getTime() - 2 * DAY)
      .file(d('runtimes', 'codex', '0.161.0', 'x'), 512 * MiB)
      .file(w('sandboxes', 'old-job', 'x'), 256 * MiB)
      .file(w('kept', 'j1', 'a1', 'out', 'report.pdf'), GiB)
      .file(w('mirrors', 'abc.git', 'pack'), 20 * GiB)
      .file(d('my secret thesis', 'chapter.docx'), 3 * GiB)
      .link(d('external-link'));
    const sources: HygieneSource[] = [
      // Deliberately out of order: the engine orders by category.
      fixed(fs, 'packageCaches', [
        [d('caches', 'host', 'bbb'), GiB, NOW.getTime() - 2 * DAY, false],
        [d('caches', 'host', 'aaa'), GiB, NOW.getTime() - 5 * DAY, false],
      ]),
      fixed(fs, 'logs', [[d('logs', 'worker.log.1'), 4 * MiB, 0, false]]),
      fixed(fs, 'temp', [[w('sandboxes', 'old-job'), 256 * MiB, 0, true]]),
      fixed(fs, 'runtimes', [[d('runtimes', 'codex', '0.161.0'), 512 * MiB, 0, false]]),
    ];
    const state = memState();
    const changed: number[] = [];
    let now = NOW;
    const hygiene = DiskHygiene.open({
      fs,
      dataDir: l.dataDir,
      workspaceRoot: l.workspaceRoot,
      sources,
      settings: () => settings,
      state: state.port,
      clock: () => now,
      onChanged: () => changed.push(1),
    });
    return {
      fs,
      state,
      changed,
      hygiene,
      tick: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
    };
  }

  it('daily: only the light candidates, whatever the free space', async () => {
    const s = setup(10 * MiB);
    const run = await (await s.hygiene).run('daily');
    expect(DiskHygieneRun.parse(run)).toEqual(run);
    expect(s.fs.removed).toEqual([w('sandboxes', 'old-job')]);
    expect(run.freed).toEqual([{ category: 'temp', bytes: 256 * MiB, items: 1 }]);
    expect(run.stillLow).toBe(true);
    // A light run measures no usage (it was not asked to reach the target).
    expect((await s.hygiene).report().usage).toBeNull();
    expect(s.state.get()?.lastDailyAt).toBe(NOW.toISOString());
  });

  it('low disk: light first, then by category and oldest first, until the target is reached', async () => {
    // Threshold 2 GiB + margin 1 GiB = 3 GiB; 1.5 GiB free.
    const s = setup(1.5 * GiB);
    const h = await s.hygiene;
    const run = await h.run('low_disk');
    expect(s.fs.removed).toEqual([
      w('sandboxes', 'old-job'), // light
      d('logs', 'worker.log.1'), // logs before runtimes before caches
      d('runtimes', 'codex', '0.161.0'),
      d('caches', 'host', 'aaa'), // the older cache first; the target is reached after it
    ]);
    expect(s.fs.nodes.has(d('caches', 'host', 'bbb', 'npm', 'x'))).toBe(true);
    expect(run.freed.map((f) => f.category)).toEqual(['temp', 'logs', 'runtimes', 'packageCaches']);
    expect(run.freedBytes).toBe(256 * MiB + 4 * MiB + 512 * MiB + GiB);
    expect(run.stillLow).toBe(false);
    expect(run.freeBefore).toBe(1.5 * GiB);
    expect(run.freeAfter).toBe(1.5 * GiB + run.freedBytes);
    expect(h.report().usage).toBeNull();
    expect(s.changed.length).toBe(1);
  });

  it('still low after everything: the usage per top-level directory, never a user file or link name', async () => {
    const s = setup(100 * MiB);
    const h = await s.hygiene;
    const run = await h.run('manual');
    expect(run.stillLow).toBe(true);
    const report = DiskHygieneReport.parse(h.report());
    const usage = report.usage;
    if (usage === null) throw new Error('no usage');
    const names = [...usage.dataDir, ...usage.workspaceRoot].map((e) => e.name);
    expect(JSON.stringify(usage)).not.toContain('thesis');
    expect(JSON.stringify(usage)).not.toContain('external-link');
    expect(usage.dataDir.find((e) => e.name === 'other')?.bytes).toBe(3 * GiB);
    expect(usage.workspaceRoot.find((e) => e.name === 'mirrors')?.bytes).toBe(20 * GiB);
    expect(usage.workspaceRoot.find((e) => e.name === 'kept')?.bytes).toBe(GiB);
    expect((names as string[]).includes('my secret thesis')).toBe(false);
    // Largest first.
    expect(usage.workspaceRoot[0]?.name).toBe('mirrors');
  });

  it('free space not measurable: only the light candidates (never empties the caches blindly)', async () => {
    const s = setup(null);
    const run = await (await s.hygiene).run('manual');
    expect(s.fs.removed).toEqual([w('sandboxes', 'old-job')]);
    expect(run.stillLow).toBe(false);
    expect(run.freeBefore).toBeNull();
  });

  it('a removal that fails is counted, the run goes on', async () => {
    const s = setup(1.5 * GiB);
    s.fs.stuck.add(d('logs', 'worker.log.1'));
    const run = await (await s.hygiene).run('low_disk');
    expect(run.errors).toBe(1);
    expect(run.freed.map((f) => f.category)).not.toContain('logs');
    expect(s.fs.removed).toContain(d('runtimes', 'codex', '0.161.0'));
  });

  it('p17-worker-managed: what another account owns (EPERM / EACCES) is skipped quietly with a count', async () => {
    const s = setup(1.5 * GiB);
    s.fs.foreign.set(w('sandboxes', 'old-job'), 'EPERM');
    s.fs.foreign.set(d('logs', 'worker.log.1'), 'EACCES');
    const run = await (await s.hygiene).run('low_disk');
    expect(run.errors).toBe(0);
    expect(run.skipped).toBe(2);
    expect(s.fs.removed).toContain(d('runtimes', 'codex', '0.161.0'));
    expect(DiskHygieneRun.safeParse(run).success).toBe(true);
    // Nothing to skip: the key is absent (older masters never see it).
    const clean = setup(1.5 * GiB);
    expect('skipped' in (await (await clean.hygiene).run('low_disk'))).toBe(false);
  });

  it('notOurs: permission errors only, also inside an AggregateError', () => {
    const e = (code: string) => Object.assign(new Error(code), { code });
    expect(notOurs(e('EPERM'))).toBe(true);
    expect(notOurs(e('EACCES'))).toBe(true);
    expect(notOurs(e('EBUSY'))).toBe(false);
    expect(notOurs(new AggregateError([e('EPERM'), e('EACCES')]))).toBe(true);
    expect(notOurs(new AggregateError([e('EPERM'), e('ENOTEMPTY')]))).toBe(false);
  });
});

describe('the engine: checks, spacing, settings, state', () => {
  function engine(
    fs: FakeFs,
    settings: () => ReturnType<typeof hygieneSettings>,
    now: () => Date,
    state = memState(),
  ) {
    let items = 0;
    const src: HygieneSource = {
      category: 'packageCaches',
      collect: () =>
        Promise.resolve([
          {
            category: 'packageCaches',
            label: `c${String(items)}`,
            bytes: GiB,
            at: 0,
            light: false,
            remove: () => {
              items++;
              fs.free = (fs.free ?? 0) + GiB;
              return Promise.resolve(GiB);
            },
          },
        ]),
    };
    return {
      state,
      removed: () => items,
      open: () =>
        DiskHygiene.open({
          fs,
          dataDir: '/d',
          workspaceRoot: '/w',
          sources: [src],
          settings,
          state: state.port,
          clock: now,
        }),
    };
  }

  it('starts a run below threshold + margin, at most once per gap; nothing when off or above', async () => {
    const fs = new FakeFs('linux', 2.5 * GiB);
    let now = NOW;
    let settings = hygieneSettings(2 * GiB, undefined);
    const e = engine(
      fs,
      () => settings,
      () => now,
    );
    const h = await e.open();
    const first = await h.check();
    expect(first?.trigger).toBe('low_disk');
    expect(e.removed()).toBe(1);
    // Low again right after: spaced (default 30 min).
    fs.free = GiB;
    expect(await h.check()).toBeNull();
    expect(h.report().nextLowDiskAt).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
    now = new Date(NOW.getTime() + 31 * 60_000);
    expect((await h.check())?.trigger).toBe('low_disk');
    // Off: measured and reported, never cleaned automatically.
    settings = hygieneSettings(2 * GiB, { enabled: false });
    now = new Date(now.getTime() + 60 * 60_000);
    fs.free = GiB;
    expect(await h.check()).toBeNull();
    expect(h.report()).toMatchObject({ enabled: false, freeBytes: GiB, nextDailyAt: null });
    // Above the target: nothing.
    settings = hygieneSettings(2 * GiB, { enabled: true, marginBytes: 0 });
    fs.free = 2 * GiB + 1;
    expect(await h.check()).toBeNull();
  });

  it('a request while a run goes on joins it', async () => {
    const fs = new FakeFs('linux', GiB);
    const e = engine(
      fs,
      () => hygieneSettings(2 * GiB, undefined),
      () => NOW,
    );
    const h = await e.open();
    const [a, b] = await Promise.all([h.run('manual'), h.run('low_disk')]);
    expect(a).toBe(b);
  });

  it('the last run and the daily rhythm survive a restart', async () => {
    const fs = new FakeFs('linux', GiB);
    const state = memState();
    const e = engine(
      fs,
      () => hygieneSettings(2 * GiB, { enabled: true, marginBytes: GiB }),
      () => NOW,
      state,
    );
    const run = await (await e.open()).run('daily');
    const again = await engine(
      fs,
      () => hygieneSettings(2 * GiB, undefined),
      () => NOW,
      memState(state.get()),
    ).open();
    expect(again.report().lastRun).toEqual(run);
    expect(again.report()).toMatchObject({ thresholdBytes: 2 * GiB, marginBytes: GiB, targetBytes: 3 * GiB });
  });

  it('settings: absent = on with the default 1 GiB margin; the panel wins', () => {
    expect(hygieneSettings(2 * GiB, undefined)).toEqual({
      enabled: true,
      thresholdBytes: 2 * GiB,
      marginBytes: GiB,
    });
    expect(hygieneSettings(0.25 * GiB, { enabled: false, marginBytes: 5 * GiB })).toEqual({
      enabled: false,
      thresholdBytes: 0.25 * GiB,
      marginBytes: 5 * GiB,
    });
  });
});

describe('usage report', () => {
  it('names the workspace root inside the data dir as workspace-root (Windows paths)', async () => {
    const fs = new FakeFs('win32', 0)
      .file('C:\\data\\workspaces\\jobs\\j\\a\\x', 5 * GiB)
      .file('C:\\data\\runtimes\\codex\\1\\x', GiB)
      .file('C:\\data\\Personal Taxes 2026.xlsx', 7 * MiB);
    const u = await measureUsage(fs, 'C:\\data', 'C:\\data\\workspaces', NOW);
    expect(u.dataDir).toEqual([
      { name: 'workspace-root', bytes: 5 * GiB },
      { name: 'runtimes', bytes: GiB },
      { name: 'other', bytes: 7 * MiB },
    ]);
    expect(u.workspaceRoot).toEqual([{ name: 'jobs', bytes: 5 * GiB }]);
  });
});

describe('real file system', () => {
  it('lists, sizes (links not followed) and removes; the state file round-trips', async () => {
    const dir = await tempDir('dh-');
    const fs = nodeHygieneFs();
    await writeFile(join(dir, 'a.bin'), Buffer.alloc(1000));
    const entries = await fs.list(dir);
    expect(entries.map((e) => [e.name, e.kind, e.size])).toEqual([['a.bin', 'file', 1000]]);
    expect((await fs.treeSize(dir)).bytes).toBe(1000);
    expect(await fs.freeBytes(dir)).toBeGreaterThan(0);
    await fs.remove(join(dir, 'a.bin'));
    expect(await fs.list(dir)).toEqual([]);

    const port = fileHygieneState(createNodeFileOps(), dir);
    expect(await port.load()).toBeNull();
    const state: HygieneState = {
      lastRun: {
        trigger: 'daily',
        startedAt: NOW.toISOString(),
        finishedAt: NOW.toISOString(),
        freeBefore: 1,
        freeAfter: 2,
        freedBytes: 1,
        freed: [{ category: 'logs', bytes: 1, items: 1 }],
        stillLow: false,
        errors: 0,
      },
      lastDailyAt: NOW.toISOString(),
      lastLowDiskAt: null,
    };
    await port.save(state);
    expect(await port.load()).toEqual(state);
    await writeFile(join(dir, 'disk-hygiene.json'), '{"v":1,"lastRun":"nope"}');
    expect(await port.load()).toBeNull();
  });

  it('package caches source maps the cache port', async () => {
    const evicted: string[] = [];
    const src = packageCachesSource({
      caches: {
        candidates: () => Promise.resolve([{ key: 'k1', bytes: 10, lastUsedAt: new Date(5) }]),
        evict: (k) => {
          evicted.push(k);
          return Promise.resolve(10);
        },
      },
    });
    const [c] = await src.collect(NOW);
    expect(c).toMatchObject({
      category: 'packageCaches',
      label: 'caches/host/k1',
      bytes: 10,
      at: 5,
      light: false,
    });
    expect(await c?.remove()).toBe(10);
    expect(evicted).toEqual(['k1']);
  });
});
