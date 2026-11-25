import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { posixTreeKiller, type ProcessTreeKiller } from '@remyral/agent-adapters';

/**
 * Reaping processes that left the job's process group (ADR-0012 rule 4, T-SBX-5).
 *
 * A runtime (or the agent's shell) can `setsid`/double-fork a daemon that is no
 * longer in the process group the tree killer signals. Containers do not have
 * this problem (the container is the unit). On host profiles:
 *
 *  - Linux/Pi: every confined process inherits `REMYRAL_SANDBOX_TOKEN=<random>`;
 *    `/proc/<pid>/environ` (readable for the worker user's own processes) is the
 *    *initial* environment, so a daemon that merely detached still carries it.
 *    Residual: a process that re-`exec`s itself with a scrubbed environment.
 *  - macOS: the environment of other processes is not readable (`ps -E` shows
 *    nothing on macOS 26; verified), so the sweep looks at orphans (ppid 1) of
 *    the worker user that started after the job's process. Those whose cwd is in
 *    the attempt's dirs are killed; with `orphans: 'all-recent'` (the dedicated
 *    worker user, only one running host attempt) every such orphan is killed;
 *    otherwise the rest are reported as suspicious. Residual: a daemon that
 *    `chdir`s away while another attempt runs is reported, not killed.
 */

export const SANDBOX_TOKEN_ENV = 'REMYRAL_SANDBOX_TOKEN';

export interface ProcInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  /** Elapsed seconds since start. */
  readonly elapsedSec: number;
}

/** `[[dd-]hh:]mm:ss` → seconds. */
export function parseEtime(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (m === null) return Number.NaN;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

export function parsePs(out: string): ProcInfo[] {
  const list: ProcInfo[] = [];
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const [pid, ppid, uid, etime] = [Number(f[0]), Number(f[1]), Number(f[2]), parseEtime(f[3] ?? '')];
    if ([pid, ppid, uid, etime].every(Number.isFinite)) list.push({ pid, ppid, uid, elapsedSec: etime });
  }
  return list;
}

const lsofDefault = (pids: readonly number[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(
      '/usr/sbin/lsof',
      ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')],
      { timeout: 10_000 },
      (_e, stdout) => {
        resolve(stdout);
      },
    );
  });

/** `lsof -Fpn` output → pid → cwd. */
export function parseLsofCwd(out: string): Map<number, string> {
  const map = new Map<number, string>();
  let pid: number | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined) map.set(pid, line.slice(1));
  }
  return map;
}

const psDefault = (): Promise<string> =>
  new Promise((resolve) => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,uid=,etime='], { timeout: 10_000 }, (_e, stdout) => {
      resolve(stdout);
    });
  });

export interface ReaperDeps {
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  readonly selfPid: number;
  readonly ps?: () => Promise<string>;
  readonly lsof?: (pids: readonly number[]) => Promise<string>;
  readonly procRoot?: string;
  readonly kill?: (pid: number, sig: NodeJS.Signals) => void;
  readonly now?: () => number;
}

/** Linux: pids of the worker user's processes whose initial env carries `token`. */
async function pidsWithToken(token: string, deps: ReaperDeps): Promise<number[]> {
  const root = deps.procRoot ?? '/proc';
  const needle = `${SANDBOX_TOKEN_ENV}=${token}`;
  const out: number[] = [];
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === deps.selfPid) continue;
    const env = await readFile(`${root}/${entry}/environ`, 'latin1').catch(() => '');
    if (env.split('\0').includes(needle)) out.push(pid);
  }
  return out;
}

export interface SweepResult {
  readonly killed: readonly number[];
  /** Survivors that could not be attributed safely (reported, not killed). */
  readonly suspicious: readonly number[];
}

export async function sweepEscapedProcesses(opts: {
  token: string;
  startedAtMs: number;
  /** macOS: kill every recent orphan (`all-recent`, exclusive dedicated user) or only those in `dirs`. */
  orphans: 'all-recent' | 'in-dirs';
  /** Attempt dirs (real paths) for the macOS cwd attribution. */
  dirs: readonly string[];
  deps: ReaperDeps;
}): Promise<SweepResult> {
  const { deps } = opts;
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const tryKill = (pid: number): boolean => {
    try {
      kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  };
  if (deps.platform === 'linux') {
    const pids = await pidsWithToken(opts.token, deps);
    return { killed: pids.filter(tryKill), suspicious: [] };
  }
  if (deps.platform !== 'darwin') return { killed: [], suspicious: [] };
  const now = deps.now?.() ?? Date.now();
  const ageLimit = Math.ceil((now - opts.startedAtMs) / 1000) + 1;
  const orphans = parsePs(await (deps.ps ?? psDefault)()).filter(
    (p) => p.uid === deps.uid && p.ppid === 1 && p.pid !== deps.selfPid && p.elapsedSec <= ageLimit,
  );
  if (orphans.length === 0) return { killed: [], suspicious: [] };
  const cwd = parseLsofCwd(await (deps.lsof ?? lsofDefault)(orphans.map((p) => p.pid)));
  const inDirs = (pid: number): boolean => {
    const c = cwd.get(pid);
    return c !== undefined && opts.dirs.some((d) => c === d || c.startsWith(`${d}/`));
  };
  const target = orphans.filter((p) => opts.orphans === 'all-recent' || inDirs(p.pid)).map((p) => p.pid);
  const rest = orphans.filter((p) => !target.includes(p.pid)).map((p) => p.pid);
  return { killed: target.filter(tryKill), suspicious: rest };
}

/**
 * Process-group killer + escaped-process sweep.
 */
export function reapingTreeKiller(opts: {
  token: string;
  startedAtMs: number;
  /** Evaluated at kill time (concurrency may have changed). */
  orphans: () => 'all-recent' | 'in-dirs';
  dirs: readonly string[];
  deps: ReaperDeps;
  onSweep?: (r: SweepResult) => void;
}): ProcessTreeKiller {
  const group = posixTreeKiller();
  return {
    kind: 'posix-process-group',
    detached: true,
    signal: (pid, sig) => group.signal(pid, sig),
    kill: async (pid) => {
      await group.kill(pid);
      const r = await sweepEscapedProcesses({
        token: opts.token,
        startedAtMs: opts.startedAtMs,
        orphans: opts.orphans(),
        dirs: opts.dirs,
        deps: opts.deps,
      });
      if (r.killed.length > 0 || r.suspicious.length > 0) opts.onSweep?.(r);
    },
  };
}
