import { describe, expect, it } from 'vitest';
import {
  osProcessTable,
  parsePsRss,
  parseWindowsProcessTable,
  type ProcRow,
  ProcessMemorySampler,
  treeRssBytes,
} from '../src/jobs/memory.js';
import type { RunFn } from '../src/remote-ops/process.js';

const MiB = 1024 * 1024;

describe('process table parsing (p6-capacity-advice)', () => {
  it('parses ps pid/ppid/rss (KiB) and skips malformed lines', () => {
    const out = '    1     0  1024\n  200     1 20480\nbogus line\n 300 200 x\n  301   200   512\n\n';
    expect(parsePsRss(out)).toEqual([
      { pid: 1, ppid: 0, rssBytes: 1024 * 1024 },
      { pid: 200, ppid: 1, rssBytes: 20480 * 1024 },
      { pid: 301, ppid: 200, rssBytes: 512 * 1024 },
    ]);
  });

  it('parses the Windows CIM lines (working set in bytes), CRLF included', () => {
    const out = '0,0,8192\r\n4,0,155648\r\n5120,4100,1288490188\r\nWARNING: x\r\n,,\r\n';
    expect(parseWindowsProcessTable(out)).toEqual([
      { pid: 0, ppid: 0, rssBytes: 8192 },
      { pid: 4, ppid: 0, rssBytes: 155648 },
      { pid: 5120, ppid: 4100, rssBytes: 1288490188 },
    ]);
  });
});

describe('treeRssBytes', () => {
  const rows: ProcRow[] = [
    { pid: 1, ppid: 0, rssBytes: 999 * MiB },
    { pid: 10, ppid: 1, rssBytes: 300 * MiB }, // runtime
    { pid: 11, ppid: 10, rssBytes: 100 * MiB }, // tool
    { pid: 12, ppid: 11, rssBytes: 50 * MiB }, // grandchild
    { pid: 20, ppid: 1, rssBytes: 700 * MiB }, // another job
    { pid: 30, ppid: 30, rssBytes: 1 * MiB }, // self-parented (must not loop)
  ];

  it('sums the root and every descendant once', () => {
    expect(treeRssBytes(rows, [10])).toBe(450 * MiB);
    // A second root inside the same tree is not counted twice.
    expect(treeRssBytes(rows, [10, 11])).toBe(450 * MiB);
    expect(treeRssBytes(rows, [10, 20])).toBe(1150 * MiB);
    expect(treeRssBytes(rows, [30])).toBe(1 * MiB);
  });

  it('is null when no root is alive (the sample is skipped, not zero)', () => {
    expect(treeRssBytes(rows, [4242])).toBeNull();
    expect(treeRssBytes(rows, [])).toBeNull();
  });

  it('never descends from pid 0 (Windows idle process)', () => {
    const win: ProcRow[] = [
      { pid: 0, ppid: 0, rssBytes: 8 },
      { pid: 4, ppid: 0, rssBytes: 100 },
    ];
    expect(treeRssBytes(win, [0])).toBeNull();
  });
});

describe('ProcessMemorySampler', () => {
  function fakeTimers() {
    let active = 0;
    return {
      opts: {
        setInterval: () => {
          active += 1;
          return active;
        },
        clearInterval: () => {
          active -= 1;
        },
      },
      active: () => active,
    };
  }

  it('records the peak per attempt over samples and stops its timer when nothing is tracked', async () => {
    let rss = 200 * MiB;
    const timers = fakeTimers();
    const sampler = new ProcessMemorySampler({
      read: () =>
        Promise.resolve([
          { pid: 10, ppid: 1, rssBytes: rss },
          { pid: 11, ppid: 10, rssBytes: 100 * MiB },
          { pid: 20, ppid: 1, rssBytes: 50 * MiB },
        ]),
      ...timers.opts,
    });
    const a = sampler.track();
    const b = sampler.track();
    expect(timers.active()).toBe(1);
    a.addRoot(10);
    b.addRoot(20);
    await sampler.sample();
    rss = 900 * MiB;
    await sampler.sample();
    rss = 100 * MiB;
    await sampler.sample();
    expect(a.finish()).toEqual({ peakMemoryBytes: 1000 * MiB, samples: 3 });
    expect(a.finish()).toEqual({ peakMemoryBytes: 1000 * MiB, samples: 3 });
    expect(timers.active()).toBe(1);
    expect(b.finish()).toEqual({ peakMemoryBytes: 50 * MiB, samples: 3 });
    expect(timers.active()).toBe(0);
    expect(sampler.tracked).toBe(0);
  });

  it('reports nothing without a sample, skips failed reads and ignores invalid pids', async () => {
    let fail = true;
    const sampler = new ProcessMemorySampler({
      read: () => (fail ? Promise.reject(new Error('ps missing')) : Promise.resolve(null)),
      ...fakeTimers().opts,
    });
    const t = sampler.track();
    t.addRoot(-1);
    t.addRoot(0);
    t.addRoot(1.5);
    await sampler.sample();
    t.addRoot(10);
    await sampler.sample();
    fail = false;
    await sampler.sample();
    expect(t.finish()).toBeNull();
  });

  it('does not overlap reads', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const sampler = new ProcessMemorySampler({
      read: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = () => {
            resolve([{ pid: 10, ppid: 1, rssBytes: 5 }]);
          };
        });
      },
      ...fakeTimers().opts,
    });
    const t = sampler.track();
    t.addRoot(10);
    const first = sampler.sample();
    await sampler.sample();
    release();
    await first;
    expect(calls).toBe(1);
    expect(t.finish()).toEqual({ peakMemoryBytes: 5, samples: 1 });
  });
});

describe('osProcessTable', () => {
  it('runs ps with a fixed PATH on POSIX and parses it', async () => {
    const calls: { file: string; args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
    const run: RunFn = (file, args, opts) => {
      calls.push({ file, args, env: opts.env });
      return Promise.resolve({ exitCode: 0, stdout: ' 10 1 2048\n', stderr: '', timedOut: false });
    };
    expect(await osProcessTable('linux', run, {})()).toEqual([{ pid: 10, ppid: 1, rssBytes: 2048 * 1024 }]);
    expect(calls[0]).toEqual({
      file: 'ps',
      args: ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'rss='],
      env: { PATH: '/usr/bin:/bin' },
    });
  });

  it('uses PowerShell CIM on Windows without passing the worker environment', async () => {
    const calls: { file: string; args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
    const run: RunFn = (file, args, opts) => {
      calls.push({ file, args, env: opts.env });
      return Promise.resolve({ exitCode: 0, stdout: '10,1,4096\r\n', stderr: '', timedOut: false });
    };
    const read = osProcessTable('win32', run, { SystemRoot: 'C:\\Windows', SECRET_TOKEN: 'x' });
    expect(await read()).toEqual([{ pid: 10, ppid: 1, rssBytes: 4096 }]);
    expect(calls[0]?.file).toMatch(/powershell\.exe$/);
    expect(calls[0]?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(calls[0]?.env).toEqual({ SystemRoot: 'C:\\Windows' });
  });

  it('returns null when the listing fails or times out', async () => {
    const run: RunFn = () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'x', timedOut: false });
    expect(await osProcessTable('darwin', run, {})()).toBeNull();
    const slow: RunFn = () => Promise.resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    expect(await osProcessTable('win32', slow, {})()).toBeNull();
  });

  // The real `ps` of this host (macOS / Linux CI): this test process must appear with a non-zero RSS.
  it.skipIf(process.platform === 'win32')('reads the real process table of this host', async () => {
    const rows = await osProcessTable()();
    expect(rows).not.toBeNull();
    const self = rows?.find((r) => r.pid === process.pid);
    expect(self?.rssBytes ?? 0).toBeGreaterThan(0);
    expect(treeRssBytes(rows ?? [], [process.pid])).toBeGreaterThan(0);
  });
});
