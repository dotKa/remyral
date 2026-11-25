import { readdir, readFile, readlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { previewPortProblem } from '@remyral/protocol';
import { osProcessTable, type ProcessTableReader, type ProcRow } from '../jobs/memory.js';
import { type RunFn, runProcess } from '../remote-ops/process.js';

/**
 * p8-preview-tunnels (ADR-0032): which local ports a job may expose through a preview tunnel.
 *
 *  1. Policy: 1024–65535, never a well-known service port ({@link previewPortProblem}), never a port the worker or
 *     its helpers listen on (egress proxies, adapter loopback servers).
 *  2. A listener on loopback (TCP connect to 127.0.0.1 / ::1 succeeds).
 *  3. Ownership (`owned`): the listening process is in the job's process tree — the roots the adapter reported
 *     (`SpawnContext.onProcessSpawned`) and their descendants in the OS process table. Ports a human declared for
 *     the job (`declared`) skip this step. Unverifiable ownership is a refusal, never a pass.
 *
 * Listener pids per OS (pure parsers below): Linux `/proc/net/tcp{,6}` (state 0A) → socket inode → pid through
 * `/proc/<pid>/fd` of the candidate pids; macOS `lsof -nP -a -iTCP:<port> -sTCP:LISTEN -Fp`; Windows `netstat -ano -p
 * TCP` / `-p TCPv6` (LISTENING). Linux and Windows are UNVERIFIED on real hosts (unit-tested parsers only).
 */

export type PortCheckMode = 'owned' | 'declared';

export type PortVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        'out_of_range' | 'denied' | 'worker_port' | 'not_listening' | 'not_owned' | 'unverifiable';
      readonly detail: string;
    };

// ------------------------------------------------------------------------------------- parsers (pure)

/** Socket inodes listening on `port` from `/proc/net/tcp` or `/proc/net/tcp6` text. */
export function parseProcNetTcp(text: string, port: number): string[] {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const out: string[] = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    // sl local rem st tx:rx tr:when retrnsmt uid timeout inode
    if (f.length < 10) continue;
    const local = f[1] ?? '';
    const state = f[3] ?? '';
    const inode = f[9] ?? '';
    if (state !== '0A') continue;
    if (local.slice(local.lastIndexOf(':') + 1).toUpperCase() !== hex) continue;
    if (/^\d+$/.test(inode) && inode !== '0') out.push(inode);
  }
  return out;
}

/** Pids from `lsof -F p` output (`p<pid>` lines). */
export function parseLsofPids(text: string): number[] {
  const out = new Set<number>();
  for (const line of text.split('\n')) {
    const m = /^p(\d+)$/.exec(line.trim());
    if (m?.[1] !== undefined) out.add(Number(m[1]));
  }
  return [...out];
}

/** Pids listening on `port` from `netstat -ano` output (Windows). */
export function parseNetstatListeners(text: string, port: number): number[] {
  const out = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0]?.toUpperCase() !== 'TCP' || f[3]?.toUpperCase() !== 'LISTENING') continue;
    const local = f[1] ?? '';
    const p = Number(local.slice(local.lastIndexOf(':') + 1));
    const pid = Number(f[4]);
    if (p === port && Number.isSafeInteger(pid) && pid > 0) out.add(pid);
  }
  return [...out];
}

/** Every pid in `roots`' trees (roots included when they are still in the table). */
export function processTree(rows: readonly ProcRow[], roots: Iterable<number>): Set<number> {
  const children = new Map<number, number[]>();
  const present = new Set<number>();
  for (const r of rows) {
    present.add(r.pid);
    if (r.ppid === r.pid) continue;
    const list = children.get(r.ppid) ?? [];
    list.push(r.pid);
    children.set(r.ppid, list);
  }
  const out = new Set<number>();
  const stack = [...roots].filter((p) => p > 0 && present.has(p));
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    if (out.has(pid)) continue;
    out.add(pid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return out;
}

// ------------------------------------------------------------------------------------- probes

/** Pids listening on a TCP port, or null when this host cannot tell. */
export type ListenerProbe = (port: number, candidates: ReadonlySet<number>) => Promise<number[] | null>;

export function osListenerProbe(
  platform: NodeJS.Platform = process.platform,
  run: RunFn = runProcess,
  env: NodeJS.ProcessEnv = process.env,
  fs: {
    readFile: (p: string) => Promise<string>;
    readdir: (p: string) => Promise<string[]>;
    readlink: (p: string) => Promise<string>;
  } = {
    readFile: (p) => readFile(p, 'utf8'),
    readdir: (p) => readdir(p),
    readlink: (p) => readlink(p),
  },
): ListenerProbe {
  if (platform === 'linux') {
    return async (port, candidates) => {
      const inodes = new Set<string>();
      let readAny = false;
      for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
        const text = await fs.readFile(f).catch(() => null);
        if (text === null) continue;
        readAny = true;
        for (const i of parseProcNetTcp(text, port)) inodes.add(i);
      }
      if (!readAny) return null;
      if (inodes.size === 0) return [];
      const out: number[] = [];
      for (const pid of candidates) {
        const fds = await fs.readdir(`/proc/${String(pid)}/fd`).catch(() => [] as string[]);
        for (const fd of fds) {
          const link = await fs.readlink(`/proc/${String(pid)}/fd/${fd}`).catch(() => '');
          const m = /^socket:\[(\d+)\]$/.exec(link);
          if (m?.[1] !== undefined && inodes.has(m[1])) {
            out.push(pid);
            break;
          }
        }
      }
      return out;
    };
  }
  if (platform === 'darwin') {
    return async (port) => {
      const r = await run('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-Fp'], {
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        cwd: '/',
        timeoutMs: 10_000,
      });
      // lsof exits 1 when nothing matches.
      if (r.spawnError !== undefined || r.timedOut) return null;
      if (r.exitCode !== 0 && r.exitCode !== 1) return null;
      return parseLsofPids(r.stdout);
    };
  }
  if (platform === 'win32') {
    const sysRoot = env.SystemRoot ?? 'C:\\Windows';
    const netstat = join(sysRoot, 'System32', 'NETSTAT.EXE');
    return async (port) => {
      const out = new Set<number>();
      for (const proto of ['TCP', 'TCPv6']) {
        const r = await run(netstat, ['-ano', '-p', proto], {
          env: { SystemRoot: sysRoot },
          cwd: sysRoot,
          timeoutMs: 15_000,
          maxBytes: 4 * 1024 * 1024,
        });
        if (r.exitCode !== 0 || r.timedOut) return null;
        for (const pid of parseNetstatListeners(r.stdout, port)) out.add(pid);
      }
      return [...out];
    };
  }
  return () => Promise.resolve(null);
}

/** TCP connect to the loopback addresses (a listener answers). */
export async function loopbackListening(port: number, timeoutMs = 1_500): Promise<boolean> {
  const tryHost = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const s = connect({ host, port });
      const done = (v: boolean) => {
        s.removeAllListeners();
        s.destroy();
        resolve(v);
      };
      s.setTimeout(timeoutMs, () => {
        done(false);
      });
      s.once('connect', () => {
        done(true);
      });
      s.once('error', () => {
        done(false);
      });
    });
  return (await tryHost('127.0.0.1')) || (await tryHost('::1'));
}

export interface PortCheckDeps {
  /** Ports the worker itself (or its helpers) is known to listen on (static list; may be empty). */
  readonly ownPorts?: () => readonly number[];
  /** The worker's own pid (default `process.pid`). */
  readonly workerPid?: number;
  readonly listening?: (port: number) => Promise<boolean>;
  readonly listeners?: ListenerProbe;
  readonly processTable?: ProcessTableReader;
}

/** The port policy without I/O. */
export function portPolicy(port: number, ownPorts: readonly number[]): PortVerdict {
  const p = previewPortProblem(port);
  if (p === 'out_of_range')
    return { ok: false, reason: p, detail: `port ${String(port)} is not between 1024 and 65535` };
  if (p === 'denied')
    return {
      ok: false,
      reason: p,
      detail: `port ${String(port)} is a known service port (database, shell, remote desktop …) and is never exposed`,
    };
  if (ownPorts.includes(port))
    return { ok: false, reason: 'worker_port', detail: `port ${String(port)} belongs to the worker itself` };
  return { ok: true };
}

/**
 * Full check of one port for one job.
 *
 * - `owned`: the listener must be in the job's process tree (unverifiable → refused).
 * - `declared` (a human named the port): a listener suffices, but never one of the worker itself or of its other
 *   children (egress proxies, other jobs, connectors) — when this host can tell.
 */
export async function checkPreviewPort(
  d: PortCheckDeps,
  port: number,
  mode: PortCheckMode,
  roots: ReadonlySet<number>,
): Promise<PortVerdict> {
  const policy = portPolicy(port, d.ownPorts?.() ?? []);
  if (!policy.ok) return policy;
  if (!(await (d.listening ?? loopbackListening)(port))) {
    return {
      ok: false,
      reason: 'not_listening',
      detail: `nothing listens on localhost:${String(port)} yet — start the server first (bind to localhost)`,
    };
  }
  const rows = await (d.processTable ?? osProcessTable())().catch(() => null);
  const tree = rows === null ? new Set<number>() : processTree(rows, roots);
  if (mode === 'declared') {
    if (rows === null) return { ok: true };
    const workerPid = d.workerPid ?? process.pid;
    const workerTree = processTree(rows, [workerPid]);
    workerTree.add(workerPid);
    const pids = await (d.listeners ?? osListenerProbe())(port, workerTree).catch(() => null);
    if (pids !== null && pids.some((p) => workerTree.has(p) && !tree.has(p))) {
      return {
        ok: false,
        reason: 'worker_port',
        detail: `localhost:${String(port)} belongs to the worker or another of its processes, not to this job`,
      };
    }
    return { ok: true };
  }
  const unverifiable: PortVerdict = {
    ok: false,
    reason: 'unverifiable',
    detail: `cannot verify that localhost:${String(port)} belongs to this job on this machine`,
  };
  if (roots.size === 0 || rows === null || tree.size === 0) return unverifiable;
  const pids = await (d.listeners ?? osListenerProbe())(port, tree).catch(() => null);
  if (pids === null) return unverifiable;
  if (pids.length === 0) {
    return {
      ok: false,
      reason: 'not_owned',
      detail: `localhost:${String(port)} is not served by a process of this job`,
    };
  }
  if (!pids.some((p) => tree.has(p))) {
    return {
      ok: false,
      reason: 'not_owned',
      detail: `localhost:${String(port)} is served by another program, not by this job`,
    };
  }
  return { ok: true };
}
