import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { SandboxRequestError } from '../errors.js';
import { PROTECTED_HOME_PATHS } from './seatbelt.js';

/**
 * p19-linux-host-isolation (ADR-0066): per-attempt confinement of Linux `host-restricted` attempts with bubblewrap.
 *
 * Every attempt runs in **its own user + mount + IPC namespace** (and its own PID namespace where the host allows a
 * private `/proc` in one — the self-check decides). Its view of the file system:
 *
 *  - the host read-only (`--ro-bind / /`), a private `/dev`, `/dev/shm`, `/proc` and `/tmp`;
 *  - the worker data dir and the workspace root replaced by empty read-only tmpfs; bound back only what this attempt
 *    may use: its worktree and sandbox dir (read-write), its mirror's object store (read-only), the worker-managed
 *    runtime / tool / MCP installs (read-only), the project's package cache and an added account's login folder
 *    (read-write) — so other attempts' worktrees, scratch, git views, mirrors and the worker's secrets do not exist
 *    in it;
 *  - the worktree's `.git` file read-only (trusted metadata, as with Seatbelt);
 *  - protected home paths (SSH, cloud CLI, browser profiles …) masked; a subscription-login (`local-login`) attempt
 *    keeps the worker HOME read-write (its login store, refresh locks and atomic rewrites work as before), every
 *    other attempt has its own HOME and sees none of the worker's login stores.
 *
 * Why other attempts' processes do not help: each attempt is in a different user namespace, so `/proc/<pid>/root`,
 * `cwd`, `environ` and `mem` of another attempt's processes are refused by the kernel's ptrace access check
 * (verified 2026-10-29 in Ubuntu 24.04 / bubblewrap 0.9 — design §3.3), with or without a PID namespace.
 *
 * Network (p22-worker-limits, backlog p19-linux-net-isolation): once the network self-check passed, an attempt that
 * serves nothing to the worker gets its own network namespace (`--unshare-net`: only its own loopback). Its egress
 * proxy is reached through a Unix socket bound into the view at {@link VIEW_EGRESS_SOCKET} and a tiny in-view TCP →
 * Unix forwarder ({@link NETNS_RELAY_SCRIPT}, the worker's own Node) listening on the proxy's port on the view's
 * loopback — so `HTTPS_PROXY` stays the same URL and everything else (other jobs' proxies and servers, the host's
 * loopback services, abstract Unix sockets) does not exist in the view. Attempts the worker must reach on loopback keep
 * the host network: services and IDE servers (`listen`), loopback API runtimes (OpenCode), jobs that may open preview
 * links (`hostNetwork`). Otherwise egress stays the proxy environment (`proxy_env_only`, as before on Linux).
 *
 * Proof before parallelism ({@link LinuxIsolationController.verify}): two probe attempts with exactly these arguments
 * run at the same time; each must reach its own dirs and must not reach the other's dirs (directly, through
 * `/proc/<pid>/root` or `/proc/<pid>/environ`), the worker data dir or the host's system dirs (writes). Only then is
 * `filesystemConfinement` `bwrap`; otherwise host attempts run one at a time as before and the Sandbox card says why.
 */

/** Login stores of the runtimes below a home (never visible to an attempt that does not use the worker's login). */
export const HOME_LOGIN_STORES: readonly string[] = [
  '.claude',
  '.claude.json',
  '.claude.lock',
  '.codex',
  '.local/share/opencode',
  '.pi/agent',
];

export interface HostBwrapSpec {
  /** Real path of the attempt worktree (read-write). */
  readonly workspace: string;
  /** Real path of the attempt sandbox dir (git view, TMPDIR, per-attempt HOME; read-write). */
  readonly sandboxDir: string;
  /** Real path of the workspace root (masked). */
  readonly workspaceRoot: string;
  /** Real path of the worker data dir (masked). */
  readonly workerDataDir: string;
  /** Data-dir subtrees bound back read-only (runtime installs, tools, MCP servers). */
  readonly readableInDataDir?: readonly string[];
  /** The mirror's object store (read-only, git alternates). */
  readonly mirrorObjects?: string | undefined;
  /** Further read-only paths (runtime extension files, MCP install dirs). */
  readonly readOnly?: readonly string[];
  /** Further read-write paths (package caches, an added account's login folder). */
  readonly writable?: readonly string[];
  /** Homes whose protected paths are masked (the worker user's, plus e.g. the owner's). */
  readonly homes: readonly string[];
  /** Paths masked besides the protected ones (the worker's login stores for attempts that do not use them). */
  readonly mask?: readonly string[];
  /** local-login: the worker HOME, bound read-write (its protected paths stay masked). */
  readonly sharedHome?: string | undefined;
  /** Own PID namespace + private /proc (only where the host allows it; the self-check decides). */
  readonly pidNamespace: boolean;
  /**
   * p22-worker-limits: a private network namespace (`--unshare-net`). `relay`: the host-side Unix socket of the
   * attempt's egress relay, bound into the view at `viewSocket` (below the view's private /tmp). Absent: host network.
   */
  readonly privateNetwork?: { readonly relay?: { readonly hostSocket: string; readonly viewSocket: string } };
  /**
   * p22-worker-limits (backlog p19-linux-local-login-parallel, `sandbox.linuxLoginStoreView`): a local-login attempt's
   * home — a private tmpfs at the worker HOME's path with the home's entries bound back read-only, the runtimes' login
   * stores read-write and their trusted configuration (settings, hooks, instructions …) read-only on top. Replaces
   * `sharedHome`.
   */
  readonly loginStoreHome?: LoginStoreHome;
}

/** p22-worker-limits: the parts of a {@link HostBwrapSpec.loginStoreHome} view (all absolute, real paths). */
export interface LoginStoreHome {
  /** The worker HOME (becomes a private tmpfs in the view). */
  readonly home: string;
  /** Top-level entries of the home bound back read-only. */
  readonly readOnly: readonly string[];
  /** Login stores bound back read-write (directories). */
  readonly stores: readonly string[];
  /** Trusted configuration inside the stores, read-only on top (they exist: the runner creates missing ones). */
  readonly protect: readonly string[];
}

/** p22-worker-limits: where an attempt's egress relay socket appears inside its view (short: a socket path ≤ 107). */
export const VIEW_EGRESS_SOCKET = '/tmp/.remyral-egress.sock';

/**
 * p22-worker-limits: the in-view TCP → Unix forwarder (`node -e NETNS_RELAY_SCRIPT -- <socket> <port> <cmd> <args…>`).
 * Listens on 127.0.0.1:<port> of the view's own loopback, pipes every connection to the egress relay socket, then
 * runs the command with the same stdio and exits with its status (a signal is passed on and re-raised). It holds no
 * secret and reads nothing else; a start failure exits 125 with the reason on stderr.
 */
export const NETNS_RELAY_SCRIPT = [
  "'use strict';",
  "const net = require('node:net');",
  "const cp = require('node:child_process');",
  'const [, sock, port, cmd, ...args] = process.argv;',
  'const fail = (m) => { process.stderr.write(`remyral-netns: ${m}\n`); process.exit(125); };',
  'const srv = net.createServer({ allowHalfOpen: true }, (c) => {',
  '  const u = net.connect(sock);',
  '  c.pipe(u); u.pipe(c);',
  '  const end = () => { c.destroy(); u.destroy(); };',
  "  c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end);",
  '});',
  "srv.on('error', (e) => fail(e.message));",
  "srv.listen(Number(port), '127.0.0.1', () => {",
  "  const child = cp.spawn(cmd, args, { stdio: 'inherit' });",
  "  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { try { child.kill(s); } catch {} });",
  "  child.on('error', (e) => { process.stderr.write(`remyral-netns: ${e.message}\n`); process.exit(127); });",
  "  child.on('exit', (code, sig) => {",
  '    srv.close();',
  '    if (sig !== null) { process.removeAllListeners(sig); process.kill(process.pid, sig); }',
  '    else process.exit(code ?? 1);',
  '  });',
  '});',
].join('\n');

/** The command (after bwrap's `--`) that runs `command` behind the in-view egress forwarder. */
export function netnsRelayArgv(
  node: string,
  viewSocket: string,
  port: number,
  command: string,
  args: readonly string[],
): string[] {
  return [node, '-e', NETNS_RELAY_SCRIPT, '--', viewSocket, String(port), command, ...args];
}

/**
 * p22-worker-limits: the host side of an attempt's egress relay — a Unix socket in a fresh 0700 dir under `base`
 * (short: socket paths are ≤ 107 bytes) whose connections are piped to the egress proxy on 127.0.0.1:<port>.
 */
export async function startEgressRelay(
  proxyPort: number,
  base: string = tmpdir(),
): Promise<{ readonly socket: string; close(): Promise<void> }> {
  const dir = await mkdtemp(join(base, 'rmy-n'));
  const socket = join(dir, 'e.sock');
  if (socket.length > 100) {
    await rm(dir, { recursive: true, force: true });
    throw new SandboxRequestError('egressRelay', `socket path too long (${socket})`);
  }
  const server: Server = createServer({ allowHalfOpen: true }, (c) => {
    const u = connect(proxyPort, '127.0.0.1');
    c.pipe(u);
    u.pipe(c);
    const end = (): void => {
      c.destroy();
      u.destroy();
    };
    c.on('error', end);
    u.on('error', end);
    c.on('close', end);
    u.on('close', end);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    socket,
    close: async () => {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Test seam for `lstat` (the builder checks which optional paths exist and whether they are files). */
export type Lstat = (p: string) => Promise<{ isDirectory(): boolean; isFile(): boolean } | null>;

const defaultLstat: Lstat = (p) => lstat(p).catch(() => null);

function checkPath(field: string, p: string): string {
  if (!isAbsolute(p) || p.includes('\0') || p.includes('\n')) {
    throw new SandboxRequestError(field, `must be an absolute path (${JSON.stringify(p)})`);
  }
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

const inside = (parent: string, p: string): boolean => p === parent || p.startsWith(`${parent}/`);

/**
 * bubblewrap arguments (everything between `bwrap` and `--`) of one attempt. Later mounts cover earlier ones, so the
 * order is: host read-only → private /dev /proc /tmp → masks of the data dir and workspace root → what this attempt
 * may use, bound back → protected / login paths masked again on top (they may lie below a bound-back home) →
 * the masks remounted read-only (writes there fail instead of filling memory) → cwd.
 */
export async function buildHostBwrapArgs(
  spec: HostBwrapSpec,
  cwd: string,
  fsLstat: Lstat = defaultLstat,
): Promise<string[]> {
  const args = [
    '--unshare-user',
    '--unshare-ipc',
    ...(spec.pidNamespace ? ['--unshare-pid'] : []),
    ...(spec.privateNetwork === undefined ? [] : ['--unshare-net']),
    '--die-with-parent',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--tmpfs',
    '/dev/shm',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
  ];
  const relay = spec.privateNetwork?.relay;
  if (relay !== undefined) {
    const host = checkPath('relay.hostSocket', relay.hostSocket);
    const view = checkPath('relay.viewSocket', relay.viewSocket);
    if (!inside('/tmp', view) || view === '/tmp') {
      throw new SandboxRequestError('relay.viewSocket', `must lie below the view's /tmp (${view})`);
    }
    args.push('--bind', host, view);
  }
  // 0. p22-worker-limits: a local-login attempt's home — private tmpfs, entries read-only, login stores read-write.
  //    Mounts apply in order and a later tmpfs covers everything below it, so the view follows the nesting: a home
  //    that contains the data dir or the workspace root goes first (their masks then cover what lies below it); a home
  //    inside the data dir — the system install, /var/lib/remyral-worker/home — goes after the masks (p22-harness-gaps,
  //    linux-worker-1 2026-11-02: before, the data-dir mask erased the view and `cp …/home/.claude.json` failed with 125).
  const lsh = spec.loginStoreHome;
  const lshArgs: string[] = [];
  let lshHome: string | undefined;
  if (lsh !== undefined) {
    const home = checkPath('loginStoreHome.home', lsh.home);
    lshHome = home;
    lshArgs.push('--tmpfs', home);
    for (const p of lsh.readOnly) {
      const real = checkPath('loginStoreHome.readOnly', p);
      if (!inside(home, real) || real === home) continue;
      if ((await fsLstat(real)) !== null) lshArgs.push('--ro-bind', real, real);
    }
    for (const p of lsh.stores) {
      const real = checkPath('loginStoreHome.stores', p);
      if (!inside(home, real) || real === home) continue;
      if ((await fsLstat(real))?.isDirectory() === true) lshArgs.push('--bind', real, real);
    }
    for (const p of lsh.protect) {
      const real = checkPath('loginStoreHome.protect', p);
      if ((await fsLstat(real)) !== null) lshArgs.push('--ro-bind', real, real);
    }
  }
  const maskRoots = [spec.workerDataDir, spec.workspaceRoot].map((p, i) =>
    checkPath(i === 0 ? 'workerDataDir' : 'workspaceRoot', p),
  );
  const homeBelowMask = lshHome !== undefined && maskRoots.some((m) => lshHome !== m && inside(m, lshHome));
  if (!homeBelowMask) args.push(...lshArgs);
  // 1. The worker data dir and the workspace root: empty, read-only (an inner one is already covered).
  const masked: string[] = [];
  for (const root of [...maskRoots].sort((a, b) => a.length - b.length)) {
    if (masked.some((m) => inside(m, root))) continue;
    if ((await fsLstat(root))?.isDirectory() !== true) continue;
    args.push('--tmpfs', root);
    masked.push(root);
  }
  // 2. Bound back: read-only installs and the mirror's objects, read-write caches / login folder, the shared home of
  // a local-login attempt, then the attempt's own dirs.
  const boundBack: string[] = [];
  // The home view below a mask: mounted on top of it, and counted as bound back (protected paths below it are hidden).
  if (homeBelowMask && lshHome !== undefined) {
    args.push(...lshArgs);
    boundBack.push(lshHome);
  }
  const bind = async (flag: '--ro-bind' | '--bind', field: string, p: string): Promise<void> => {
    const real = checkPath(field, p);
    if ((await fsLstat(real)) === null) return;
    args.push(flag, real, real);
    boundBack.push(real);
  };
  for (const p of spec.readableInDataDir ?? []) await bind('--ro-bind', 'readableInDataDir', p);
  for (const p of spec.readOnly ?? []) await bind('--ro-bind', 'readOnly', p);
  if (spec.mirrorObjects !== undefined) await bind('--ro-bind', 'mirrorObjects', spec.mirrorObjects);
  if (spec.sharedHome !== undefined && lsh === undefined) await bind('--bind', 'sharedHome', spec.sharedHome);
  for (const p of spec.writable ?? []) await bind('--bind', 'writable', p);
  args.push('--bind', checkPath('sandboxDir', spec.sandboxDir), spec.sandboxDir);
  args.push('--bind', checkPath('workspace', spec.workspace), spec.workspace);
  // The trusted worktree's `.git` file: readable, never writable.
  const dotGit = join(spec.workspace, '.git');
  if ((await fsLstat(dotGit))?.isFile() === true) args.push('--ro-bind', dotGit, dotGit);
  // 3. Protected home paths and other login stores: hidden even below a bound-back home.
  const hide = async (p: string): Promise<void> => {
    const real = checkPath('mask', p);
    // Inside a masked dir and not below anything bound back: it is not there anyway.
    if (masked.some((m) => inside(m, real)) && !boundBack.some((b) => inside(b, real))) return;
    const st = await fsLstat(real);
    if (st === null) return;
    if (st.isDirectory()) args.push('--tmpfs', real, '--remount-ro', real);
    else args.push('--ro-bind', '/dev/null', real);
  };
  const seen = new Set<string>();
  for (const home of spec.homes) {
    for (const rel of PROTECTED_HOME_PATHS) {
      const p = join(home, rel);
      if (!seen.has(p)) {
        seen.add(p);
        await hide(p);
      }
    }
  }
  for (const p of spec.mask ?? []) {
    if (!seen.has(p)) {
      seen.add(p);
      await hide(p);
    }
  }
  // 4. The masks themselves read-only: writes into the data dir / workspace root view fail.
  for (const m of masked) args.push('--remount-ro', m);
  args.push('--chdir', checkPath('cwd', cwd));
  return args;
}

// ------------------------------------------------------------------------------------------------ self-check

export type IsolationCode =
  | 'host_isolation_disabled'
  | 'host_isolation_bwrap_missing'
  | 'host_isolation_bwrap_untrusted'
  | 'host_isolation_userns_refused'
  | 'host_isolation_unverified'
  | 'host_isolation_selftest_failed';

export interface IsolationStatus {
  readonly active: boolean;
  /** Absent when active. */
  readonly code?: IsolationCode;
  readonly detail: string;
  /** Active: whether attempts also get their own PID namespace (private /proc). */
  readonly pidNamespace?: boolean;
  readonly bwrap?: string;
  readonly checkedAt?: string;
  /**
   * p22-worker-limits: active and the network self-check passed — attempts that serve nothing to the worker get their
   * own network namespace with a relay to their egress proxy.
   */
  readonly privateNetwork?: boolean;
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Starts a process; `wait()` resolves when it exits, `kill()` ends it (and its group). */
export interface Started {
  wait(): Promise<RunResult>;
  kill(): void;
}

export type StartProcess = (
  file: string,
  args: readonly string[],
  opts: { readonly env: Readonly<Record<string, string>>; readonly cwd: string; readonly timeoutMs: number },
) => Started;

export const nodeStart: StartProcess = (file, args, opts) => {
  const child = spawn(file, [...args], {
    cwd: opts.cwd,
    env: { ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => {
    if (stdout.length < 65_536) stdout += d.toString('utf8');
  });
  child.stderr.on('data', (d: Buffer) => {
    if (stderr.length < 65_536) stderr += d.toString('utf8');
  });
  const kill = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const timer = setTimeout(kill, opts.timeoutMs);
  const done = new Promise<RunResult>((resolve) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  return { wait: () => done, kill };
};

export interface LinuxIsolationOptions {
  /** `sandbox.linuxHostIsolation` (`off` = the owner's local switch). */
  readonly mode: 'auto' | 'off';
  readonly platform?: NodeJS.Platform;
  readonly workspaceRoot: string;
  readonly dataDir: string;
  readonly readableInDataDir: readonly string[];
  /** The first `bwrap` on PATH (probe/bwrap.ts `findBwrap`). */
  readonly findBwrap: () => Promise<string | null>;
  /** Tests: process starter. */
  readonly start?: StartProcess;
  /** Tests: bwrap binary trust check (default: root-owned, not group/world writable). */
  readonly trusted?: (bwrap: string) => Promise<string | null>;
  readonly now?: () => Date;
  /**
   * p22-worker-limits: `sandbox.linuxPrivateNetwork` — `auto` runs the network self-check after the cross-attempt one
   * and, when it passes, gives attempts their own network namespace. Default `off` (the factory passes the setting).
   */
  readonly privateNetwork?: 'auto' | 'off';
  /** The Node binary that runs the in-view egress forwarder (default: the worker's own). */
  readonly node?: string;
  /** Where the host side of an egress relay socket is made (default: the OS temp dir). */
  readonly relayBase?: string;
}

/** The bwrap binary must be root's and not writable by others: a replaceable bwrap would run as every attempt. */
export async function bwrapTrusted(path: string): Promise<string | null> {
  try {
    const real = await realpath(path);
    const st = await stat(real);
    if (st.uid !== 0) return `${real} is not owned by root`;
    if ((st.mode & 0o022) !== 0) return `${real} is writable by group or others`;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const PROBE_TIMEOUT_MS = 20_000;
/** p19-auto-bwrap: how often a worker without bubblewrap looks for it again. */
export const BWRAP_WATCH_MS = 60_000;

/** The probe one attempt runs inside its view; every line `R <check> <ok|leak|fail>`. */
export const PROBE_SCRIPT = [
  'echo "R started ok"',
  // own dirs: must work
  'if echo own > "$OWN_WS/own-probe" && [ "$(cat "$OWN_WS/own-probe")" = own ]; then echo "R own_workspace ok"; else echo "R own_workspace fail"; fi',
  'if echo tmp > "$OWN_SB/tmp/own-probe" && [ "$(cat "$OWN_SB/tmp/own-probe")" = tmp ]; then echo "R own_sandbox ok"; else echo "R own_sandbox fail"; fi',
  // the other attempt and the worker: must not exist / not be readable
  'if cat "$PEER_WS/marker" >/dev/null 2>&1; then echo "R peer_workspace leak"; else echo "R peer_workspace ok"; fi',
  'if cat "$PEER_SB/marker" >/dev/null 2>&1; then echo "R peer_sandbox leak"; else echo "R peer_sandbox ok"; fi',
  'if ls "$PEER_WS" >/dev/null 2>&1; then echo "R peer_listing leak"; else echo "R peer_listing ok"; fi',
  'if cat "$DATA_MARKER" >/dev/null 2>&1; then echo "R data_dir leak"; else echo "R data_dir ok"; fi',
  'if ls "$DATA_DIR" 2>/dev/null | grep -q "$DATA_NAME"; then echo "R data_listing leak"; else echo "R data_listing ok"; fi',
  // through another process: /proc/<pid>/root and /proc/<pid>/environ of the peer (running now)
  'leak=ok; for p in /proc/[0-9]*; do if cat "$p/root$PEER_WS/marker" >/dev/null 2>&1; then leak=leak; fi; if grep -q "REMYRAL_PROBE_TOKEN=$PEER_TOKEN" "$p/environ" 2>/dev/null; then leak=leak; fi; done; echo "R proc_peer $leak"',
  // the host stays read-only; a write into the masked workspace root fails too
  'if touch /usr/.remyral-isolation-probe 2>/dev/null; then echo "R system_write leak"; else echo "R system_write ok"; fi',
  'if mkdir -p "$PEER_WS" 2>/dev/null && echo planted > "$PEER_WS/planted" 2>/dev/null; then echo "R peer_write leak"; else echo "R peer_write ok"; fi',
].join('\n');

const EXPECTED = [
  'started',
  'own_workspace',
  'own_sandbox',
  'peer_workspace',
  'peer_sandbox',
  'peer_listing',
  'data_dir',
  'data_listing',
  'proc_peer',
  'system_write',
  'peer_write',
] as const;

/** Parses the probe's output; null = every expectation held, else what failed. */
export function probeVerdict(stdout: string): string | null {
  const seen = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const m = /^R ([a-z_]+) (ok|leak|fail)$/.exec(line.trim());
    if (m !== null) seen.set(m[1] ?? '', m[2] ?? '');
  }
  const bad: string[] = [];
  for (const k of EXPECTED) {
    const v = seen.get(k);
    if (v === undefined) bad.push(`${k}: no answer`);
    else if (v !== 'ok') bad.push(`${k}: ${v}`);
  }
  return bad.length === 0 ? null : bad.join(', ');
}

/** p22-worker-limits: the network probe (Node, inside a `--unshare-net` view behind the forwarder). */
export const NET_PROBE_SCRIPT = [
  "'use strict';",
  "const net = require('node:net');",
  'const get = (port) => new Promise((resolve) => {',
  "  const s = net.connect(Number(port), '127.0.0.1');",
  "  let d = '';",
  '  s.setTimeout(3000, () => { s.destroy(); resolve(null); });',
  "  s.on('data', (b) => { d += b; });",
  "  s.on('end', () => resolve(d));",
  "  s.on('error', () => resolve(null));",
  '});',
  '(async () => {',
  "  console.log('R started ok');",
  '  const relayed = await get(process.env.RELAY_PORT);',
  "  console.log(`R relay ${relayed !== null && relayed.includes(`relay-${process.env.MARKER}`) ? 'ok' : 'fail'}`);",
  '  const host = await get(process.env.HOST_PORT);',
  "  console.log(`R host_loopback ${host === null ? 'ok' : 'leak'}`);",
  "  const own = net.createServer((c) => c.end('own'));",
  "  await new Promise((r) => own.listen(0, '127.0.0.1', r));",
  '  const back = await get(own.address().port);',
  '  own.close();',
  "  console.log(`R own_loopback ${back === 'own' ? 'ok' : 'fail'}`);",
  '})();',
].join('\n');

const NET_EXPECTED = ['started', 'relay', 'host_loopback', 'own_loopback'] as const;

/** Parses the network probe's output; null = every expectation held. */
export function netProbeVerdict(stdout: string): string | null {
  const seen = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const m = /^R ([a-z_]+) (ok|leak|fail)$/.exec(line.trim());
    if (m !== null) seen.set(m[1] ?? '', m[2] ?? '');
  }
  const bad: string[] = [];
  for (const k of NET_EXPECTED) {
    const v = seen.get(k);
    if (v === undefined) bad.push(`${k}: no answer`);
    else if (v !== 'ok') bad.push(`${k}: ${v}`);
  }
  return bad.length === 0 ? null : bad.join(', ');
}

interface ProbeAttempt {
  readonly id: string;
  readonly workspace: string;
  readonly sandboxDir: string;
  readonly token: string;
}

/**
 * The Linux per-attempt isolation state: off, missing bubblewrap, unverified, failed, or verified (then
 * `HostRestrictedRunner.filesystemConfinement` is `bwrap`). `verify()` runs the cross-attempt self-check.
 */
export class LinuxIsolationController {
  readonly #o: LinuxIsolationOptions;
  #status: IsolationStatus;
  #running: Promise<IsolationStatus> | null = null;

  constructor(o: LinuxIsolationOptions) {
    this.#o = o;
    this.#status =
      o.mode === 'off'
        ? {
            active: false,
            code: 'host_isolation_disabled',
            detail:
              'per-attempt isolation is off on this machine (sandbox.linuxHostIsolation: "off"); host jobs run one at a time',
          }
        : {
            active: false,
            code: 'host_isolation_unverified',
            detail: 'checking the per-attempt bubblewrap view (cross-attempt self-check)…',
          };
  }

  status(): IsolationStatus {
    return this.#status;
  }

  /** The bwrap binary, the PID-namespace and private-network choices while active; null otherwise. */
  active(): {
    readonly bwrap: string;
    readonly pidNamespace: boolean;
    readonly privateNetwork: boolean;
    readonly node: string;
    readonly relayBase?: string;
  } | null {
    const s = this.#status;
    return s.active && s.bwrap !== undefined
      ? {
          bwrap: s.bwrap,
          pidNamespace: s.pidNamespace === true,
          privateNetwork: s.privateNetwork === true,
          node: this.#o.node ?? process.execPath,
          ...(this.#o.relayBase === undefined ? {} : { relayBase: this.#o.relayBase }),
        }
      : null;
  }

  /** Runs the self-check (one at a time; a second caller waits for the running one). */
  verify(): Promise<IsolationStatus> {
    if (this.#o.mode === 'off') return Promise.resolve(this.#status);
    this.#running ??= this.#verify().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /**
   * p19-auto-bwrap: while bubblewrap is missing, look for it again every `intervalMs` (the privileged helper installs
   * it after an update activation, or the owner does by hand). Once found, the self-check runs again and `onChanged`
   * re-reports the capabilities, so parallel host slots open without a restart. Stops by itself once the status is no
   * longer `host_isolation_bwrap_missing`; the timer never keeps the process alive. Returns a stop function.
   */
  watchBwrap(onChanged: () => void, intervalMs = BWRAP_WATCH_MS): () => void {
    if (this.#o.mode === 'off') return () => undefined;
    let busy = false;
    const timer = setInterval(() => {
      if (this.#status.code !== 'host_isolation_bwrap_missing') {
        clearInterval(timer);
        return;
      }
      if (busy) return;
      busy = true;
      void this.#o
        .findBwrap()
        .then(async (bwrap) => {
          if (bwrap === null) return;
          await this.verify();
          if (this.#status.code !== 'host_isolation_bwrap_missing') clearInterval(timer);
          onChanged();
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }

  async #verify(): Promise<IsolationStatus> {
    const at = (this.#o.now?.() ?? new Date()).toISOString();
    const set = (s: IsolationStatus): IsolationStatus => {
      this.#status = { ...s, checkedAt: at };
      return this.#status;
    };
    const bwrap = await this.#o.findBwrap();
    if (bwrap === null) {
      return set({
        active: false,
        code: 'host_isolation_bwrap_missing',
        detail:
          'bubblewrap is not installed: host jobs run one at a time. A current privileged helper installs it automatically after a worker update and the worker picks it up within a minute; to do it now install it (Debian/Ubuntu: sudo apt install bubblewrap; Fedora: sudo dnf install bubblewrap) or run Prepare with the privileged helper, then Prepare again',
      });
    }
    const untrusted = await (this.#o.trusted ?? bwrapTrusted)(bwrap);
    if (untrusted !== null) {
      return set({
        active: false,
        code: 'host_isolation_bwrap_untrusted',
        detail: `bubblewrap at ${bwrap} is not used: ${untrusted} (install the distribution package)`,
      });
    }
    try {
      // A private /proc in a new PID namespace is refused under some service hardening (locked /proc submounts,
      // e.g. systemd ProtectKernelTunables); the attempt is then isolated by its user + mount namespace only.
      const withPid = await this.#selfTest(bwrap, true);
      if (withPid.ok) {
        return set(
          await this.#withNetwork({
            active: true,
            bwrap,
            pidNamespace: true,
            detail: 'each host attempt runs in its own bubblewrap view (user, mount, IPC and PID namespace)',
          }),
        );
      }
      const without = withPid.procRefused ? await this.#selfTest(bwrap, false) : withPid;
      if (without.ok) {
        return set(
          await this.#withNetwork({
            active: true,
            bwrap,
            pidNamespace: false,
            detail:
              'each host attempt runs in its own bubblewrap view (user, mount and IPC namespace; this host refuses a private /proc in a PID namespace, so attempts see — not reach — each other’s process list)',
          }),
        );
      }
      if (without.userns) {
        return set({
          active: false,
          code: 'host_isolation_userns_refused',
          detail: `bubblewrap cannot create a user namespace here (${without.detail}); allow unprivileged user namespaces (Ubuntu 24.04: the AppArmor bwrap-userns-restrict profile, or kernel.apparmor_restrict_unprivileged_userns=0) — host jobs run one at a time`,
        });
      }
      return set({
        active: false,
        code: 'host_isolation_selftest_failed',
        detail: `cross-attempt self-check failed: ${without.detail}; host jobs run one at a time`,
      });
    } catch (err) {
      return set({
        active: false,
        code: 'host_isolation_selftest_failed',
        detail: `cross-attempt self-check could not run: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * p22-worker-limits: the network self-check of an active view (`privateNetwork: auto`). Never turns the isolation
   * off: a failure keeps the host network (as before) and says why in the detail.
   */
  async #withNetwork(s: IsolationStatus): Promise<IsolationStatus> {
    if (this.#o.privateNetwork !== 'auto' || s.bwrap === undefined) return s;
    const r = await this.#netSelfTest(s.bwrap, s.pidNamespace === true).catch((err: unknown) => ({
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    }));
    return r.ok
      ? {
          ...s,
          privateNetwork: true,
          detail: `${s.detail}; network: its own namespace (only its own loopback; egress only through its proxy — services, IDE servers, OpenCode and jobs with preview links keep the host network)`,
        }
      : {
          ...s,
          privateNetwork: false,
          detail: `${s.detail}; network: shared with the host (network self-check failed: ${r.detail.slice(0, 200)})`,
        };
  }

  /**
   * One probe attempt with `--unshare-net` behind the in-view forwarder: it must reach a stand-in egress proxy through
   * the relay, must NOT reach a listener on the host's loopback, and its own loopback must work.
   */
  async #netSelfTest(bwrap: string, pidNamespace: boolean): Promise<{ ok: boolean; detail: string }> {
    const start = this.#o.start ?? nodeStart;
    const node = await realpath(this.#o.node ?? process.execPath);
    const root = await realpath(this.#o.workspaceRoot);
    const data = await realpath(this.#o.dataDir);
    const tag = `hi-net-${randomBytes(6).toString('hex')}`;
    const workspace = join(root, 'jobs', tag, 'a');
    const sandboxDir = join(root, 'sandboxes', tag, 'a');
    const marker = randomBytes(8).toString('hex');
    const servers: Server[] = [];
    const listen = async (reply: string): Promise<number> => {
      const srv = createServer((c) => {
        c.on('error', () => undefined);
        c.end(reply);
      });
      servers.push(srv);
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          resolve();
        });
      });
      const a = srv.address();
      return typeof a === 'object' && a !== null ? a.port : 0;
    };
    let relay: { socket: string; close(): Promise<void> } | null = null;
    try {
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      await mkdir(join(sandboxDir, 'tmp'), { recursive: true, mode: 0o700 });
      const proxyPort = await listen(`relay-${marker}\n`);
      const hostPort = await listen('host\n');
      relay = await startEgressRelay(proxyPort, this.#o.relayBase);
      const args = await buildHostBwrapArgs(
        {
          workspace,
          sandboxDir,
          workspaceRoot: root,
          workerDataDir: data,
          readableInDataDir: this.#o.readableInDataDir,
          readOnly: [node],
          homes: [],
          pidNamespace,
          privateNetwork: { relay: { hostSocket: relay.socket, viewSocket: VIEW_EGRESS_SOCKET } },
        },
        workspace,
      );
      const r = await start(
        bwrap,
        [
          ...args,
          '--',
          ...netnsRelayArgv(node, VIEW_EGRESS_SOCKET, proxyPort, node, ['-e', NET_PROBE_SCRIPT]),
        ],
        {
          env: {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            LANG: 'C',
            HOME: join(sandboxDir, 'tmp'),
            RELAY_PORT: String(proxyPort),
            HOST_PORT: String(hostPort),
            MARKER: marker,
          },
          cwd: workspace,
          timeoutMs: PROBE_TIMEOUT_MS,
        },
      ).wait();
      if (!/^R started ok$/m.test(r.stdout)) {
        const err = r.stderr.trim().split('\n')[0]?.slice(0, 200) ?? '';
        return {
          ok: false,
          detail: `the network probe did not start (exit ${String(r.code)}${err === '' ? '' : `: ${err}`})`,
        };
      }
      const bad = netProbeVerdict(r.stdout);
      return bad === null ? { ok: true, detail: '' } : { ok: false, detail: bad };
    } finally {
      for (const s of servers) s.close();
      await relay?.close();
      await rm(join(root, 'jobs', tag), { recursive: true, force: true }).catch(() => undefined);
      await rm(join(root, 'sandboxes', tag), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Two concurrent probe attempts; each probes the other while it runs. */
  async #selfTest(
    bwrap: string,
    pidNamespace: boolean,
  ): Promise<{ ok: boolean; detail: string; procRefused: boolean; userns: boolean }> {
    const start = this.#o.start ?? nodeStart;
    const root = await realpath(this.#o.workspaceRoot);
    const data = await realpath(this.#o.dataDir);
    const tag = `hi-check-${randomBytes(6).toString('hex')}`;
    const dataName = `.${tag}.secret`;
    const dataMarker = join(data, dataName);
    const make = async (n: string): Promise<ProbeAttempt> => {
      const workspace = join(root, 'jobs', tag, n);
      const sandboxDir = join(root, 'sandboxes', tag, n);
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      await mkdir(join(sandboxDir, 'tmp'), { recursive: true, mode: 0o700 });
      await writeFile(join(workspace, 'marker'), `workspace ${n}\n`, { mode: 0o600 });
      await writeFile(join(sandboxDir, 'marker'), `sandbox ${n}\n`, { mode: 0o600 });
      return { id: n, workspace, sandboxDir, token: randomBytes(12).toString('hex') };
    };
    const cleanup = async (): Promise<void> => {
      await rm(join(root, 'jobs', tag), { recursive: true, force: true }).catch(() => undefined);
      await rm(join(root, 'sandboxes', tag), { recursive: true, force: true }).catch(() => undefined);
      await rm(dataMarker, { force: true }).catch(() => undefined);
    };
    try {
      await writeFile(dataMarker, 'worker secret\n', { mode: 0o600 });
      const a = await make('a');
      const b = await make('b');
      const problems: string[] = [];
      for (const [own, peer] of [
        [a, b],
        [b, a],
      ] as const) {
        const r = await this.#probePair(
          start,
          bwrap,
          pidNamespace,
          root,
          data,
          own,
          peer,
          dataMarker,
          dataName,
        );
        if (r.procRefused) return { ok: false, detail: r.detail, procRefused: true, userns: false };
        if (r.userns) return { ok: false, detail: r.detail, procRefused: false, userns: true };
        if (r.detail !== '') problems.push(`${own.id}→${peer.id}: ${r.detail}`);
      }
      // A write into the peer's path inside the view must never reach the peer's real dir.
      for (const x of [a, b]) {
        if ((await readdir(x.workspace)).includes('planted'))
          problems.push(`${x.id}: planted file reached it`);
        if ((await readFile(join(x.workspace, 'marker'), 'utf8')) !== `workspace ${x.id}\n`) {
          problems.push(`${x.id}: marker changed`);
        }
      }
      return problems.length === 0
        ? { ok: true, detail: '', procRefused: false, userns: false }
        : { ok: false, detail: problems.join('; ').slice(0, 600), procRefused: false, userns: false };
    } finally {
      await cleanup();
    }
  }

  async #probePair(
    start: StartProcess,
    bwrap: string,
    pidNamespace: boolean,
    root: string,
    data: string,
    own: ProbeAttempt,
    peer: ProbeAttempt,
    dataMarker: string,
    dataName: string,
  ): Promise<{ detail: string; procRefused: boolean; userns: boolean }> {
    const spec = (x: ProbeAttempt): HostBwrapSpec => ({
      workspace: x.workspace,
      sandboxDir: x.sandboxDir,
      workspaceRoot: root,
      workerDataDir: data,
      readableInDataDir: this.#o.readableInDataDir,
      homes: [],
      pidNamespace,
    });
    const env = (x: ProbeAttempt, extra: Record<string, string>): Record<string, string> => ({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C',
      HOME: join(x.sandboxDir, 'tmp'),
      REMYRAL_PROBE_TOKEN: x.token,
      ...extra,
    });
    const ready = join(peer.sandboxDir, 'tmp', 'ready');
    // The peer runs (and keeps running) while `own` probes it.
    const victim = start(
      bwrap,
      [
        ...(await buildHostBwrapArgs(spec(peer), peer.workspace)),
        '--',
        '/bin/sh',
        '-c',
        'echo up > "$READY"; exec sleep 30',
      ],
      { env: env(peer, { READY: ready }), cwd: peer.workspace, timeoutMs: PROBE_TIMEOUT_MS },
    );
    // The peer may exit before it is up (bwrap refused): stop waiting at once then.
    const peerState: { ended: RunResult | null } = { ended: null };
    void victim.wait().then((r) => {
      peerState.ended = r;
    });
    try {
      const up = await waitFor(
        async () => peerState.ended !== null || (await lstat(ready).catch(() => null)) !== null,
        10_000,
      );
      if (!up || peerState.ended !== null) {
        victim.kill();
        return classifyStartFailure(peerState.ended ?? (await victim.wait()), 'the peer probe did not start');
      }
      const prober = start(
        bwrap,
        [...(await buildHostBwrapArgs(spec(own), own.workspace)), '--', '/bin/sh', '-c', PROBE_SCRIPT],
        {
          env: env(own, {
            OWN_WS: own.workspace,
            OWN_SB: own.sandboxDir,
            PEER_WS: peer.workspace,
            PEER_SB: peer.sandboxDir,
            PEER_TOKEN: peer.token,
            DATA_DIR: data,
            DATA_MARKER: dataMarker,
            DATA_NAME: dataName,
          }),
          cwd: own.workspace,
          timeoutMs: PROBE_TIMEOUT_MS,
        },
      );
      const r = await prober.wait();
      if (!/^R started ok$/m.test(r.stdout)) return classifyStartFailure(r, 'the probe did not start');
      return { detail: probeVerdict(r.stdout) ?? '', procRefused: false, userns: false };
    } finally {
      victim.kill();
      await victim.wait();
    }
  }
}

function classifyStartFailure(
  r: RunResult,
  what: string,
): { detail: string; procRefused: boolean; userns: boolean } {
  const err = r.stderr.trim().split('\n')[0]?.slice(0, 200) ?? '';
  const detail = `${what} (exit ${String(r.code)}${err === '' ? '' : `: ${err}`})`;
  return {
    detail,
    procRefused: /can't mount proc|mount proc/i.test(r.stderr),
    userns:
      /namespace|setting up uid map|uid map|Operation not permitted/i.test(r.stderr) &&
      !/can't mount proc/i.test(r.stderr),
  };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}
