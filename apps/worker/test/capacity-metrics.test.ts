import { WorkerToMaster } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  createPressureReader,
  parseMeminfo,
  parsePsiSomeAvg10,
  parseSwapusage,
  parseVmStat,
  parseVmstatSwapIn,
  parseWindowsMemory,
  WINDOWS_MEMORY_QUERY,
} from '../src/daemon/pressure.js';
import { type CpuTimes, cpuPercentBetween, cpuTotals, createLoadSampler } from '../src/daemon/telemetry.js';
import type { RunFn, RunResult } from '../src/remote-ops/process.js';

const GiB = 2 ** 30;
const MiB = 2 ** 20;

const MEMINFO = `MemTotal:        8048576 kB
MemFree:          512000 kB
MemAvailable:    4194304 kB
Buffers:          100000 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB
`;
const VMSTAT = (n: number) => `nr_free_pages 12345\npswpin ${String(n)}\npswpout 99\n`;
const PSI = `some avg10=12.34 avg60=5.00 avg300=1.00 total=123456
full avg10=1.00 avg60=0.50 avg300=0.10 total=2345
`;
const SWAPUSAGE = 'total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)\n';
const VM_STAT = (swapins: number) => `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                           20000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                         90000.
Pages purgeable:                           1000.
"Translation faults":                  12345678.
Swapins:                                  ${String(swapins)}.
Swapouts:                                   500.
`;
/** `ConvertTo-Json -Compress` output of WINDOWS_MEMORY_QUERY (KiB for the OS class, bytes for the perf class). */
function winJson(o: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 2, ...o })}\r\n`;
}
const WIN_HEALTHY = {
  freeKb: 3 * 1024 * 1024,
  totalKb: 8 * 1024 * 1024,
  virtFreeKb: 6 * 1024 * 1024,
  virtTotalKb: 12 * 1024 * 1024,
  availBytes: 3 * GiB,
  committedBytes: 6 * GiB,
  commitLimitBytes: 12 * GiB,
  pagesInPerSec: 42,
  pageFileMb: 4096,
  pageFileUsedMb: 1024,
};
const WIN_OUT = winJson(WIN_HEALTHY);
/** The live Turkish host (1.0.26): the perf class yields nothing; the OS class and the page file read fine. */
const WIN_TR_NO_PERF = winJson({
  freeKb: 2_621_440,
  totalKb: 8_308_384,
  virtFreeKb: 4_194_304,
  virtTotalKb: 8_832_672,
  availBytes: null,
  committedBytes: null,
  commitLimitBytes: null,
  pagesInPerSec: null,
  pageFileMb: 512,
  pageFileUsedMb: 120,
});

function ok(stdout: string): RunResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

describe('pressure parsers', () => {
  it('reads /proc/meminfo, vmstat and PSI', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ available: 4 * GiB, swapTotal: 2 * GiB, swapFree: 1 * GiB });
    expect(parseMeminfo('MemTotal: 1 kB\n')).toEqual({});
    expect(parseVmstatSwapIn(VMSTAT(77))).toBe(77);
    expect(parseVmstatSwapIn('nr_free_pages 1\n')).toBeUndefined();
    expect(parsePsiSomeAvg10(PSI)).toBe(12.34);
    expect(parsePsiSomeAvg10('garbage')).toBeUndefined();
  });

  it('reads macOS swapusage and vm_stat', () => {
    expect(parseSwapusage(SWAPUSAGE)).toEqual({ total: 2048 * MiB, used: 1024.5 * MiB });
    expect(parseSwapusage('total = 1.50G  used = 0.00M  free = 1.50G')).toEqual({
      total: 1.5 * GiB,
      used: 0,
    });
    expect(parseSwapusage('nothing')).toBeUndefined();
    expect(parseVmStat(VM_STAT(7))).toEqual({
      availableBytes: (10000 + 20000 + 5000 + 1000) * 16384,
      swapins: 7,
    });
    expect(parseVmStat('Pages free: 1.')).toEqual({});
  });

  it('reads the Windows CIM JSON (perf class first)', () => {
    expect(parseWindowsMemory(WIN_OUT)).toEqual({
      memoryAvailableBytes: 3 * GiB,
      commitPercent: 50,
      swapInPerSec: 42,
      swapTotalBytes: 4096 * MiB,
      swapUsedBytes: 1024 * MiB,
    });
    expect(WINDOWS_MEMORY_QUERY).toContain('Win32_PerfFormattedData_PerfOS_Memory');
    expect(WINDOWS_MEMORY_QUERY).toContain('Win32_OperatingSystem');
    expect(WINDOWS_MEMORY_QUERY).toContain('Win32_PageFileUsage');
    expect(WINDOWS_MEMORY_QUERY).toContain('ConvertTo-Json -Compress');
    // Invariant names only: no localized Get-Counter paths, no culture-dependent -f formatting, no double quotes
    // (the script is one argv element).
    expect(WINDOWS_MEMORY_QUERY).not.toMatch(/Get-Counter|' -f |"/);
  });

  it('Windows, Turkish host without perf classes (the live 1.0.26 finding): OS-class fallback, never 0', () => {
    expect(parseWindowsMemory(WIN_TR_NO_PERF)).toEqual({
      memoryAvailableBytes: 2_621_440 * 1024,
      commitPercent: Math.round(((8_832_672 - 4_194_304) / 8_832_672) * 1000) / 10,
      swapTotalBytes: 512 * MiB,
      swapUsedBytes: 120 * MiB,
    });
    // Same, with Turkish PowerShell noise around the JSON (BOM, an error line, CRLF).
    const noisy =
      '\uFEFFGet-CimInstance : Geçersiz sınıf "Win32_PerfFormattedData_PerfOS_Memory"\r\n' +
      WIN_TR_NO_PERF +
      '\r\n';
    expect(parseWindowsMemory(noisy)?.memoryAvailableBytes).toBe(2_621_440 * 1024);
    expect(parseWindowsMemory(`\uFEFF${WIN_TR_NO_PERF}`)?.memoryAvailableBytes).toBe(2_621_440 * 1024);
  });

  it('Windows: a broken perf record (all zeros) is dropped as a whole', () => {
    const zeros = { availBytes: 0, committedBytes: 0, commitLimitBytes: 0, pagesInPerSec: 0 };
    expect(parseWindowsMemory(winJson({ ...WIN_HEALTHY, ...zeros }))).toEqual({
      memoryAvailableBytes: 3 * GiB, // FreePhysicalMemory
      commitPercent: 50, // the OS class
      swapTotalBytes: 4096 * MiB,
      swapUsedBytes: 1024 * MiB,
    });
    // Only zeros and nulls: no memory figures (a page file of 0 is a real reading: no page file configured).
    expect(
      parseWindowsMemory(
        winJson({
          ...zeros,
          freeKb: 0,
          totalKb: 0,
          virtFreeKb: null,
          virtTotalKb: null,
          pageFileMb: 0,
          pageFileUsedMb: 0,
        }),
      ),
    ).toEqual({ swapTotalBytes: 0, swapUsedBytes: 0 });
  });

  it('Windows: culture-formatted strings, negatives and impossible values are left out, never 0', () => {
    expect(
      parseWindowsMemory(
        winJson({
          freeKb: '2,5',
          totalKb: '8.308.384',
          virtFreeKb: -1,
          virtTotalKb: 'NaN',
          availBytes: '3221225472',
          committedBytes: '6.442.450.944',
          commitLimitBytes: '12884901888,0',
          pagesInPerSec: '1,5',
          pageFileMb: '4.096',
          pageFileUsedMb: true,
        }),
      ),
    ).toBeUndefined();
    // Available above the total RAM, free virtual above total virtual: not believable.
    expect(
      parseWindowsMemory(
        winJson({ freeKb: 9 * 1024 * 1024, totalKb: 8 * 1024 * 1024, virtFreeKb: 13, virtTotalKb: 12 }),
      ),
    ).toBeUndefined();
    // Committed above the limit is capped at 100 %.
    expect(
      parseWindowsMemory(winJson({ availBytes: GiB, committedBytes: 13 * GiB, commitLimitBytes: 12 * GiB }))
        ?.commitPercent,
    ).toBe(100);
    // A used page file above its size is capped at the size.
    expect(parseWindowsMemory(winJson({ pageFileMb: 512, pageFileUsedMb: 600 }))).toEqual({
      swapTotalBytes: 512 * MiB,
      swapUsedBytes: 512 * MiB,
    });
  });

  it('Windows: failing or unknown output yields nothing (the cached value is kept)', () => {
    for (const bad of [
      '',
      '\r\n',
      'Get-CimInstance : Geçersiz sınıf',
      '0,0,0,0,512,120', // the pre-fix CSV line (its zeros were failed readings)
      '3221225472,6442450944,12884901888,42,4096,1024',
      '{"v":2,',
      '[1,2,3]',
      'null',
      '{"v":1,"freeKb":1}',
      winJson({}),
    ]) {
      expect(parseWindowsMemory(bad)).toBeUndefined();
    }
  });
});

describe('pressure reader', () => {
  it('Linux: figures from /proc, swap-in as a rate after the first reading', async () => {
    let t = 0;
    let pswpin = 100;
    const read = createPressureReader({
      platform: 'linux',
      now: () => t,
      readFile: (p) =>
        p === '/proc/meminfo'
          ? Promise.resolve(MEMINFO)
          : p === '/proc/vmstat'
            ? Promise.resolve(VMSTAT(pswpin))
            : Promise.resolve(PSI),
    });
    const first = await read();
    expect(first).toEqual({
      memoryAvailableBytes: 4 * GiB,
      swapTotalBytes: 2 * GiB,
      swapUsedBytes: 1 * GiB,
      memoryPressurePercent: 12.3,
    });
    t = 10_000;
    pswpin = 600;
    expect((await read()).swapInPerSec).toBe(50);
  });

  it('Linux: missing files leave the figures out (never 0)', async () => {
    const read = createPressureReader({
      platform: 'linux',
      readFile: () => Promise.reject(new Error('ENOENT')),
    });
    expect(await read()).toEqual({});
  });

  it('macOS: sysctl + vm_stat with a fixed PATH and no shell', async () => {
    let t = 0;
    let swapins = 10;
    const calls: { file: string; env: Readonly<Record<string, string>> }[] = [];
    const run: RunFn = (file, _args, opts) => {
      calls.push({ file, env: opts.env });
      return Promise.resolve(ok(file.endsWith('sysctl') ? SWAPUSAGE : VM_STAT(swapins)));
    };
    const read = createPressureReader({ platform: 'darwin', run, now: () => t });
    expect(await read()).toEqual({
      memoryAvailableBytes: 36000 * 16384,
      swapTotalBytes: 2048 * MiB,
      swapUsedBytes: Math.floor(1024.5 * MiB),
    });
    t = 2_000;
    swapins = 30;
    expect((await read()).swapInPerSec).toBe(10);
    expect(calls.map((c) => c.file)).toContain('/usr/sbin/sysctl');
    expect(calls.map((c) => c.file)).toContain('/usr/bin/vm_stat');
    expect(calls.every((c) => Object.keys(c.env).join() === 'PATH')).toBe(true);
  });

  it('macOS: a failed command leaves its figures out', async () => {
    const run: RunFn = () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'x', timedOut: false });
    expect(await createPressureReader({ platform: 'darwin', run })()).toEqual({});
    const throws: RunFn = () => Promise.reject(new Error('spawn'));
    expect(await createPressureReader({ platform: 'darwin', run: throws })()).toEqual({});
  });

  it('Windows: one PowerShell query, cached, refreshed in the background, never overlapping', async () => {
    let t = 0;
    let calls = 0;
    let release: (() => void) | null = null;
    let env: Readonly<Record<string, string>> = {};
    const run: RunFn = (file, args, opts) => {
      calls += 1;
      env = opts.env;
      expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'.replace(/\\/g, '/'));
      expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', WINDOWS_MEMORY_QUERY]);
      if (calls === 1) return Promise.resolve(ok(WIN_OUT));
      return new Promise((resolve) => {
        release = () => {
          resolve(ok(winJson({ availBytes: GiB, committedBytes: 1, commitLimitBytes: 2 })));
        };
      });
    };
    const read = createPressureReader({
      platform: 'win32',
      run: (file, args, opts) => run(file.replace(/\\/g, '/'), args, opts),
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\evil' },
      now: () => t,
      windowsCacheMs: 60_000,
    });
    const first = await read();
    expect(first.commitPercent).toBe(50);
    expect(env).toEqual({ SystemRoot: 'C:\\Windows' });
    t = 30_000;
    expect((await read()).commitPercent).toBe(50);
    expect(calls).toBe(1);
    // Stale: the cached value is still returned while one refresh runs; a second stale read does not start another.
    t = 61_000;
    expect((await read()).commitPercent).toBe(50);
    expect((await read()).commitPercent).toBe(50);
    expect(calls).toBe(2);
    (release as (() => void) | null)?.();
    await new Promise((r) => setTimeout(r, 0));
    expect((await read()).memoryAvailableBytes).toBe(GiB);
  });

  it('Windows: failures report nothing; an old value expires', async () => {
    let t = 0;
    let fail = false;
    const run: RunFn = () =>
      Promise.resolve(fail ? { exitCode: 1, stdout: '', stderr: '', timedOut: false } : ok(WIN_OUT));
    const read = createPressureReader({
      platform: 'win32',
      run,
      env: {},
      now: () => t,
      windowsCacheMs: 1000,
    });
    expect((await read()).commitPercent).toBe(50);
    fail = true;
    t = 2_000;
    expect((await read()).commitPercent).toBe(50); // stale, refresh failed in the background
    await new Promise((r) => setTimeout(r, 0));
    t = 3_500;
    expect(await read()).toEqual({});
    const never = createPressureReader({ platform: 'win32', run, env: {}, now: () => t });
    expect(await never()).toEqual({});
    // Exit 0 with output that carries no reading (no perf class, no OS class): nothing, never memoryAvailableBytes 0.
    const empty: RunFn = () =>
      Promise.resolve(ok(winJson({ availBytes: 0, freeKb: null, commitLimitBytes: 0 })));
    expect(await createPressureReader({ platform: 'win32', run: empty, env: {}, now: () => t })()).toEqual(
      {},
    );
  });

  it('other platforms report nothing', async () => {
    expect(await createPressureReader({ platform: 'freebsd' })()).toEqual({});
  });
});

function times(busy: number, idle: number): { times: CpuTimes } {
  return { times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } };
}

describe('load sampler', () => {
  it('CPU percent from os.cpus() deltas', () => {
    const a = cpuTotals([times(100, 900), times(100, 900)]);
    const b = cpuTotals([times(400, 1600), times(200, 1800)]);
    expect(cpuPercentBetween(a, b)).toBe(20);
    expect(cpuPercentBetween(b, b)).toBeNull();
    expect(cpuPercentBetween(b, a)).toBeNull();
  });

  it('samples CPU deltas on Windows too, merges pressure figures and validates as HEARTBEAT', async () => {
    let snap = [times(0, 0), times(0, 0)];
    const sampler = createLoadSampler({
      dir: 'C:\\data',
      platform: 'win32',
      cpus: () => snap,
      loadavg: () => [0, 0, 0],
      freemem: () => 2 * GiB,
      statfs: () => Promise.resolve({ bavail: 1000, bsize: 4096 }),
      pressure: () =>
        Promise.resolve({ memoryAvailableBytes: 2 * GiB, commitPercent: 61.5, swapInPerSec: 3 }),
    });
    // No CPU time passed since creation: Windows has no load average → 0.
    expect((await sampler()).cpuPercent).toBe(0);
    snap = [times(250, 750), times(250, 750)];
    const load = await sampler();
    expect(load).toEqual({
      cpuPercent: 25,
      memoryFreeBytes: 2 * GiB,
      diskFreeBytes: 4096000,
      memoryAvailableBytes: 2 * GiB,
      commitPercent: 61.5,
      swapInPerSec: 3,
    });
    const parsed = WorkerToMaster.safeParse({
      protocolVersion: '1.0',
      type: 'HEARTBEAT',
      messageId: '0b8f2f8e-6a8a-4a57-9f1d-3c9f4c4f0a11',
      seq: 1,
      ts: '2026-10-16T00:00:00.000Z',
      correlationId: 'c',
      workerId: 'wrk_t',
      payload: { state: 'online', runningJobs: [], load },
    });
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('POSIX first sample falls back to the load average; failures never throw', async () => {
    const sampler = createLoadSampler({
      dir: '/x',
      platform: 'linux',
      cpus: () => [times(0, 0), times(0, 0)],
      loadavg: () => [1, 1, 1],
      freemem: () => {
        throw new Error('no');
      },
      statfs: () => Promise.reject(new Error('ENOENT')),
      pressure: () => Promise.reject(new Error('boom')),
    });
    expect(await sampler()).toEqual({ cpuPercent: 50, memoryFreeBytes: 0, diskFreeBytes: 0 });
  });

  it('concurrent calls share one sample', async () => {
    let n = 0;
    const sampler = createLoadSampler({
      dir: '/x',
      platform: 'linux',
      cpus: () => [times(0, 0)],
      loadavg: () => [0],
      freemem: () => 1,
      statfs: () => Promise.resolve({ bavail: 1, bsize: 1 }),
      pressure: () => {
        n += 1;
        return Promise.resolve({});
      },
    });
    const [a, b] = await Promise.all([sampler(), sampler()]);
    expect(a).toBe(b);
    expect(n).toBe(1);
  });
});
