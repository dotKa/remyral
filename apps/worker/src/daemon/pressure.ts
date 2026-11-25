import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess, type RunFn } from '../remote-ops/process.js';

/**
 * p8-capacity-auto (docs/design/p8-capacity-auto.md §3): memory pressure figures for HEARTBEAT.load, read without
 * native dependencies:
 *  - Linux: `/proc/meminfo` (MemAvailable, SwapTotal, SwapFree), `/proc/vmstat` (pswpin, a counter → rate) and
 *    `/proc/pressure/memory` (PSI `some avg10`, absent on kernels without PSI);
 *  - macOS: `sysctl -n vm.swapusage` (total / used) and `vm_stat` (available ≈ free + inactive + speculative +
 *    purgeable pages; `Swapins` counter → rate);
 *  - Windows: one PowerShell CIM query with JSON output (Win32_PerfFormattedData_PerfOS_Memory: AvailableBytes,
 *    CommittedBytes, CommitLimit, PagesInputPersec; Win32_OperatingSystem as the fallback for available memory and
 *    the commit charge; Win32_PageFileUsage: AllocatedBaseSize / CurrentUsage in MB, summed), cached for 60 s.
 *    **UNVERIFIED on a real Windows host** (unit-tested with recorded / constructed output only).
 *
 * Every figure is optional: one that could not be read is left out, never reported as 0. Nothing here throws.
 */

export interface PressureFigures {
  memoryAvailableBytes?: number;
  swapTotalBytes?: number;
  swapUsedBytes?: number;
  swapInPerSec?: number;
  commitPercent?: number;
  memoryPressurePercent?: number;
}

const MiB = 1024 * 1024;

const int = (v: number): number | undefined =>
  Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER) : undefined;
const pct = (v: number): number | undefined =>
  Number.isFinite(v) && v >= 0 ? Math.round(Math.min(100, v) * 10) / 10 : undefined;
const rate = (v: number): number | undefined =>
  Number.isFinite(v) && v >= 0 ? Math.round(Math.min(1e9, v) * 10) / 10 : undefined;

/** Copies the defined figures only (exactOptionalPropertyTypes: no `undefined` values in the payload). */
function defined(f: Record<string, number | undefined>): PressureFigures {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(f)) if (v !== undefined) out[k] = v;
  return out;
}

// ------------------------------------------------------------------------------------------- parsers (pure)

/** `/proc/meminfo` values in bytes (kB lines). */
export function parseMeminfo(text: string): { available?: number; swapTotal?: number; swapFree?: number } {
  const get = (key: string): number | undefined => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m?.[1] === undefined ? undefined : Number(m[1]) * 1024;
  };
  const out: { available?: number; swapTotal?: number; swapFree?: number } = {};
  const a = get('MemAvailable');
  const t = get('SwapTotal');
  const f = get('SwapFree');
  if (a !== undefined) out.available = a;
  if (t !== undefined) out.swapTotal = t;
  if (f !== undefined) out.swapFree = f;
  return out;
}

/** `pswpin` (pages swapped in since boot) from `/proc/vmstat`. */
export function parseVmstatSwapIn(text: string): number | undefined {
  const m = /^pswpin\s+(\d+)\s*$/m.exec(text);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/** PSI `some avg10` from `/proc/pressure/memory` (percent). */
export function parsePsiSomeAvg10(text: string): number | undefined {
  const m = /^some\s+avg10=(\d+(?:\.\d+)?)\b/m.exec(text);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

const UNIT: Readonly<Record<string, number>> = { K: 1024, M: MiB, G: 1024 * MiB, T: 1024 * 1024 * MiB };

/** `sysctl -n vm.swapusage`: `total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)`. */
export function parseSwapusage(text: string): { total: number; used: number } | undefined {
  const field = (name: string): number | undefined => {
    const m = new RegExp(`${name}\\s*=\\s*(\\d+(?:\\.\\d+)?)([KMGT])`).exec(text);
    if (m?.[1] === undefined || m[2] === undefined) return undefined;
    return Number(m[1]) * (UNIT[m[2]] ?? 0);
  };
  const total = field('total');
  const used = field('used');
  return total === undefined || used === undefined ? undefined : { total, used };
}

/** `vm_stat`: available bytes (free + inactive + speculative + purgeable pages) and the `Swapins` counter. */
export function parseVmStat(text: string): { availableBytes?: number; swapins?: number } {
  const size = /page size of (\d+) bytes/.exec(text);
  const pages = (label: string): number | undefined => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text);
    return m?.[1] === undefined ? undefined : Number(m[1]);
  };
  const out: { availableBytes?: number; swapins?: number } = {};
  const free = pages('Pages free');
  if (size?.[1] !== undefined && free !== undefined) {
    const extra = ['Pages inactive', 'Pages speculative', 'Pages purgeable'].reduce(
      (sum, l) => sum + (pages(l) ?? 0),
      0,
    );
    out.availableBytes = (free + extra) * Number(size[1]);
  }
  const swapins = pages('Swapins');
  if (swapins !== undefined) out.swapins = swapins;
  return out;
}

/**
 * The Windows query's JSON object (p8-capacity-windows-metrics). Only JSON numbers count: a string (a culture-formatted
 * "1,5" / "8.308.384"), a negative or non-finite value is left out. The perf record (`Win32_PerfFormattedData_*`)
 * is used only when it looks alive (AvailableBytes and CommitLimit > 0 — a missing or broken perf provider yields
 * nulls or zeros, as on the live Turkish host); otherwise `Win32_OperatingSystem` supplies available memory
 * (FreePhysicalMemory, KiB) and the commit charge (TotalVirtualMemorySize − FreeVirtualMemory over
 * TotalVirtualMemorySize, KiB). Available memory is never reported as 0 or above the total RAM. Undefined when
 * nothing usable was read (the reader then keeps its previous value).
 */
export function parseWindowsMemory(text: string): PressureFigures | undefined {
  let obj: Record<string, unknown> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/^\uFEFF/, '').trim();
    if (!l.startsWith('{') || !l.endsWith('}')) continue;
    try {
      const v: unknown = JSON.parse(l);
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) obj = v as Record<string, unknown>;
    } catch {
      // not our line
    }
  }
  if (obj?.v !== 2) return undefined;
  const o = obj;
  const n = (key: string): number | undefined => {
    const v = o[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  };
  const KiB = 1024;
  const totalKb = n('totalKb');
  const total = totalKb !== undefined && totalKb > 0 ? totalKb * KiB : undefined;
  const plausible = (bytes: number | undefined): number | undefined =>
    bytes === undefined || bytes <= 0 || (total !== undefined && bytes > total) ? undefined : bytes;

  const availBytes = n('availBytes');
  const limit = n('commitLimitBytes');
  const perfAlive = availBytes !== undefined && availBytes > 0 && limit !== undefined && limit > 0;
  const freeKb = n('freeKb');
  const available =
    (perfAlive ? plausible(availBytes) : undefined) ??
    plausible(freeKb === undefined ? undefined : freeKb * KiB);

  let commit: number | undefined;
  const committed = n('committedBytes');
  if (perfAlive && committed !== undefined) commit = pct((committed / limit) * 100);
  else {
    const vt = n('virtTotalKb');
    const vf = n('virtFreeKb');
    if (vt !== undefined && vf !== undefined && vt > 0 && vf <= vt) commit = pct(((vt - vf) / vt) * 100);
  }

  const pfMb = n('pageFileMb');
  const pfUsedMb = n('pageFileUsedMb');
  const pagesIn = perfAlive ? n('pagesInPerSec') : undefined;
  const figures = defined({
    memoryAvailableBytes: available === undefined ? undefined : int(available),
    commitPercent: commit,
    swapInPerSec: pagesIn === undefined ? undefined : rate(pagesIn),
    swapTotalBytes: pfMb === undefined ? undefined : int(pfMb * MiB),
    swapUsedBytes:
      pfMb === undefined || pfUsedMb === undefined ? undefined : int(Math.min(pfUsedMb, pfMb) * MiB),
  });
  return Object.keys(figures).length === 0 ? undefined : figures;
}

/**
 * One PowerShell run, three CIM classes, each read on its own (a missing class costs only its figures). Invariant
 * class / property names only — never `Get-Counter` paths, which are localized (`\Bellek\Kullanılabilir MB` on a
 * Turkish Windows). `N` maps `$null` and unconvertible values to `$null` — never 0 (`[int64]$null` is 0, which is
 * how a failed reading reached the master as "0 bytes available" before). JSON output: numbers are
 * culture-invariant. No double quotes: the script is one argv element.
 */
export const WINDOWS_MEMORY_QUERY = [
  "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
  'function N($v) { if ($null -eq $v) { return $null }; try { return [int64]$v } catch { return $null } }',
  '$r = [ordered]@{ v = 2 }',
  'try { $o = Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object -First 1; ' +
    '$r.freeKb = N $o.FreePhysicalMemory; $r.totalKb = N $o.TotalVisibleMemorySize; ' +
    '$r.virtFreeKb = N $o.FreeVirtualMemory; $r.virtTotalKb = N $o.TotalVirtualMemorySize } catch { }',
  'try { $m = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Memory | Select-Object -First 1; ' +
    '$r.availBytes = N $m.AvailableBytes; $r.committedBytes = N $m.CommittedBytes; ' +
    '$r.commitLimitBytes = N $m.CommitLimit; $r.pagesInPerSec = N $m.PagesInputPersec } catch { }',
  'try { $p = @(Get-CimInstance -ClassName Win32_PageFileUsage); $a = [int64]0; $u = [int64]0; ' +
    'foreach ($x in $p) { $a += [int64]$x.AllocatedBaseSize; $u += [int64]$x.CurrentUsage }; ' +
    '$r.pageFileMb = $a; $r.pageFileUsedMb = $u } catch { }',
  '$r | ConvertTo-Json -Compress',
].join('; ');

// --------------------------------------------------------------------------------------------- reader

export interface PressureDeps {
  readonly platform?: NodeJS.Platform;
  readonly readFile?: (path: string) => Promise<string>;
  readonly run?: RunFn;
  readonly env?: NodeJS.ProcessEnv;
  /** Milliseconds (rates and the Windows cache). */
  readonly now?: () => number;
  /** Windows: how long one CIM query result is reused (default 60 s; the heartbeat runs every 15 s). */
  readonly windowsCacheMs?: number;
}

export type PressureReader = () => Promise<PressureFigures>;

/** A counter → per-second rate tracker (the first reading only primes it; a counter reset yields nothing). */
function counterRate(now: () => number): (value: number | undefined) => number | undefined {
  let prev: { value: number; at: number } | null = null;
  return (value) => {
    if (value === undefined) return undefined;
    const at = now();
    const p = prev;
    prev = { value, at };
    if (p === null || at <= p.at || value < p.value) return undefined;
    return rate((value - p.value) / ((at - p.at) / 1000));
  };
}

export function createPressureReader(deps: PressureDeps = {}): PressureReader {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? runProcess;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((path: string) => fsReadFile(path, 'utf8'));
  const tryRead = async (path: string): Promise<string | undefined> => {
    try {
      return await readFile(path);
    } catch {
      return undefined;
    }
  };
  const posix = async (file: string, args: readonly string[]): Promise<string | undefined> => {
    try {
      const r = await run(file, args, {
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        cwd: '/',
        timeoutMs: 5_000,
        maxBytes: 64 * 1024,
      });
      return r.exitCode === 0 && !r.timedOut ? r.stdout : undefined;
    } catch {
      return undefined;
    }
  };

  if (platform === 'linux') {
    const swapRate = counterRate(now);
    return async () => {
      const [meminfo, vmstat, psi] = await Promise.all([
        tryRead('/proc/meminfo'),
        tryRead('/proc/vmstat'),
        tryRead('/proc/pressure/memory'),
      ]);
      const m = meminfo === undefined ? {} : parseMeminfo(meminfo);
      return defined({
        memoryAvailableBytes: m.available === undefined ? undefined : int(m.available),
        swapTotalBytes: m.swapTotal === undefined ? undefined : int(m.swapTotal),
        swapUsedBytes:
          m.swapTotal === undefined || m.swapFree === undefined
            ? undefined
            : int(Math.max(0, m.swapTotal - m.swapFree)),
        swapInPerSec: swapRate(vmstat === undefined ? undefined : parseVmstatSwapIn(vmstat)),
        memoryPressurePercent: (() => {
          const v = psi === undefined ? undefined : parsePsiSomeAvg10(psi);
          return v === undefined ? undefined : pct(v);
        })(),
      });
    };
  }

  if (platform === 'darwin') {
    const swapRate = counterRate(now);
    return async () => {
      const [swap, vm] = await Promise.all([
        posix('/usr/sbin/sysctl', ['-n', 'vm.swapusage']),
        posix('/usr/bin/vm_stat', []),
      ]);
      const s = swap === undefined ? undefined : parseSwapusage(swap);
      const v = vm === undefined ? {} : parseVmStat(vm);
      return defined({
        memoryAvailableBytes: v.availableBytes === undefined ? undefined : int(v.availableBytes),
        swapTotalBytes: s === undefined ? undefined : int(s.total),
        swapUsedBytes: s === undefined ? undefined : int(s.used),
        swapInPerSec: swapRate(v.swapins),
      });
    };
  }

  if (platform === 'win32') {
    const cacheMs = deps.windowsCacheMs ?? 60_000;
    const sysRoot = env.SystemRoot ?? 'C:\\Windows';
    const ps = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let cached: { at: number; value: PressureFigures } | null = null;
    let inflight: Promise<void> | null = null;
    const refresh = (): Promise<void> => {
      inflight ??= (async () => {
        try {
          const r = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_MEMORY_QUERY], {
            env: { SystemRoot: sysRoot, ...(env.WINDIR === undefined ? {} : { WINDIR: env.WINDIR }) },
            cwd: sysRoot,
            timeoutMs: 15_000,
            maxBytes: 16 * 1024,
          });
          const parsed = r.exitCode === 0 && !r.timedOut ? parseWindowsMemory(r.stdout) : undefined;
          if (parsed !== undefined) cached = { at: now(), value: parsed };
        } catch {
          // a failed query keeps the previous value until it is too old
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    };
    return async () => {
      const t = now();
      if (cached === null) {
        await refresh();
      } else if (t - cached.at >= cacheMs) {
        void refresh(); // stale-while-revalidate: the heartbeat never waits for a second PowerShell start
      }
      const c: { at: number; value: PressureFigures } | null = cached;
      // A value older than three cache periods (refreshes keep failing) is no longer reported.
      return c === null || now() - c.at > 3 * cacheMs ? {} : { ...c.value };
    };
  }

  return () => Promise.resolve({});
}
