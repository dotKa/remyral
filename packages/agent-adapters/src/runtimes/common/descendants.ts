import { execFile } from 'node:child_process';

/**
 * Descendant process-group sweep (POSIX).
 *
 * Some runtimes start their tool processes in a *new* process group: Pi 1.1.0
 * spawns every `bash` tool call with `detached: true` (verified, see
 * docs/design/p3-adapter-pi-opencode.md §5). Signalling the runtime's own group
 * (`OwnedProcess.terminate`) does not reach them, and once the runtime is gone
 * they are re-parented to init and survive. Before force-killing a runtime the
 * adapter snapshots the process groups of all its live descendants and kills
 * those groups afterwards.
 *
 * Limits: a process started between the snapshot and the kill is missed; a
 * descendant that already left the tree (daemonised, re-parented) is not a
 * descendant any more. Both are covered only by the sandbox (container / reaper,
 * p3-sandbox).
 */

export interface PsRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
}

export function parsePsOutput(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, ppid, pgid] = parts.map(Number);
    if (pid === undefined || ppid === undefined || pgid === undefined) continue;
    if (![pid, ppid, pgid].every((n) => Number.isInteger(n) && n >= 0)) continue;
    rows.push({ pid, ppid, pgid });
  }
  return rows;
}

/** Process groups of all descendants of `rootPid`, excluding the root's own group and groups <= 1. */
export function descendantGroups(rows: readonly PsRow[], rootPid: number): number[] {
  const children = new Map<number, PsRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const rootGroup = rows.find((r) => r.pid === rootPid)?.pgid ?? rootPid;
  const groups = new Set<number>();
  const seen = new Set<number>([rootPid]);
  const stack = [rootPid];
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      stack.push(child.pid);
      if (child.pgid > 1 && child.pgid !== rootGroup) groups.add(child.pgid);
    }
  }
  return [...groups];
}

export type PsRunner = () => Promise<string>;

const runPs: PsRunner = () =>
  new Promise((resolve) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid='],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024, env: { PATH: '/usr/bin:/bin' } },
      (err, stdout) => {
        resolve(err ? '' : stdout);
      },
    );
  });

export async function snapshotDescendantGroups(rootPid: number, ps: PsRunner = runPs): Promise<number[]> {
  if (process.platform === 'win32' || !Number.isInteger(rootPid) || rootPid <= 1) return [];
  return descendantGroups(parsePsOutput(await ps()), rootPid);
}

type KillFn = (pid: number, signal: NodeJS.Signals) => void;

/** SIGKILL each group; groups that are already gone (ESRCH/EPERM) are ignored. Returns the groups signalled. */
export function killGroups(
  groups: readonly number[],
  kill: KillFn = (pid, sig) => process.kill(pid, sig),
): number[] {
  const killed: number[] = [];
  for (const pgid of groups) {
    if (!Number.isInteger(pgid) || pgid <= 1) continue;
    try {
      kill(-pgid, 'SIGKILL');
      killed.push(pgid);
    } catch {
      // gone or not ours
    }
  }
  return killed;
}
