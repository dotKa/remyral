import { execFile } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { SandboxRequestError } from '../errors.js';

/**
 * macOS Seatbelt profile for `host-restricted` (`sandbox-exec`).
 *
 * STATUS: `sandbox-exec(1)` is marked deprecated by Apple but is present and
 * functional on macOS 26.6 (verified on this machine, 2026-10-13; Codex and
 * Claude Code use the same mechanism). Facts verified here: the last matching
 * rule wins; `(param …)` values are passed with `-D`; a nested `sandbox-exec`
 * inside a sandboxed process fails (`sandbox_apply: Operation not permitted`), so
 * a runtime's own Seatbelt cannot run inside ours (see runtime-sandbox.ts).
 *
 * Shape (later rules override earlier ones):
 *   allow default
 *   deny  file-write*  everywhere
 *   allow file-write*  attempt worktree, attempt sandbox dir (scratch git dir,
 *                      TMPDIR), configured runtime state dirs, /dev/null & ttys
 *   deny  file-read*   worker data dir (device key, secrets)
 *   deny  file-read-data  the workspace root's jobs/sandboxes/mirrors trees, except
 *                      (require-not) the own worktree, sandbox dir, mirror object
 *                      store and the directories leading to them
 *   deny  file-read*   protected paths (~/.ssh, keychains, browser profiles, cloud
 *                      CLI credentials) of the worker user and any listed home
 *   deny  file-write*  the worktree's `.git` file (trusted metadata)
 *   deny  network*     except outbound to the per-job egress proxy on loopback;
 *                      listening only with `allowListen` (then on any interface)
 *
 * No path is ever interpolated into the profile text: every path is a `-D`
 * parameter, so a path cannot inject rules.
 */

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Paths below a home directory that agents must never read (T-SBX-1). */
export const PROTECTED_HOME_PATHS: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.config/gh',
  '.docker',
  '.kube',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Chromium',
  'Library/Application Support/Firefox',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge',
  'Library/Safari',
  'Library/Containers/com.apple.Safari',
  'Library/Mail',
  'Library/Messages',
  'Library/Application Support/1Password',
];

export interface SeatbeltSpec {
  /** Real path of the attempt worktree. */
  readonly workspace: string;
  /** Real path of the attempt's sandbox dir (scratch git dir, TMPDIR). */
  readonly sandboxDir: string;
  /** Real path of the workspace root (other jobs, mirrors are denied below it). */
  readonly workspaceRoot: string;
  /** Real path of the worker data dir (device key, secrets, state). */
  readonly workerDataDir: string;
  /**
   * Subtrees of the worker data dir that stay readable (never writable): the worker-managed runtime installs
   * (p5-remote-ops) the job's runtime executes from. Everything else in the data dir stays unreadable.
   */
  readonly readableInDataDir?: readonly string[];
  /** Mirror object store this attempt reads through `alternates` (read-only). */
  readonly mirrorObjects?: string | undefined;
  /** Home directories whose protected paths are denied (the worker user's, plus e.g. the owner's). */
  readonly homes: readonly string[];
  /** Keychain access for `local-login` runtimes (macOS stores some logins there). Default false. */
  readonly allowKeychain?: boolean;
  /** Extra writable directories (runtime state dirs for local-login, e.g. ~/.claude). */
  readonly extraWritable?: readonly string[];
  /** Extra denied read paths. */
  readonly extraDenyRead?: readonly string[];
  /**
   * Allow listening sockets (runtimes serving on loopback). Seatbelt cannot restrict
   * the interface, so this also permits 0.0.0.0 — off by default.
   */
  readonly allowListen?: boolean;
  /** Loopback port of the per-job egress proxy; undefined = no network at all. */
  readonly proxyPort?: number | undefined;
  /**
   * p6-warm-caches (ADR-0029): the project's shared package cache dir(s) — readable and writable although they lie
   * in the worker data dir; the directories leading to them allow path lookup only (no listing).
   */
  readonly cacheDirs?: readonly string[];
  /**
   * p13-runtime-accounts: an added runtime account's folder in the worker data dir — readable and writable for this
   * attempt (its login config dir and refresh locks), like `cacheDirs`.
   */
  readonly loginDirs?: readonly string[];
  /**
   * p19-ide W2b: loopback ports reachable besides the egress proxy (the IDE's bridge on the worker). Each is one
   * `remote ip "localhost:<port>"` rule.
   */
  readonly loopbackPorts?: readonly number[];
  /**
   * p19-ide W2b: directories where Unix-domain sockets may be bound, accepted and connected to (VS Code's IPC under
   * the IDE's run dir). `(deny network*)` covers Unix sockets too (verified on macOS 26.6, 2026-10-29: a bind in a
   * listed directory works, one in /tmp is refused).
   */
  readonly unixSocketDirs?: readonly string[];
  /**
   * p19-ide W2b: directories below the workspace root that stay readable (never writable) — the IDE's repository
   * mirror for its own git. They are carved out of the jobs / sandboxes / mirrors read deny like the own worktree.
   */
  readonly readOnlyDirs?: readonly string[];
}

export interface SeatbeltInvocation {
  readonly profile: string;
  readonly params: Readonly<Record<string, string>>;
  /** argv prefix: `/usr/bin/sandbox-exec -p <profile> -D K=V … --` */
  readonly argv: readonly string[];
}

function checkPath(field: string, p: string): string {
  if (!isAbsolute(p) || p.includes('\0') || p.includes('\n')) {
    throw new SandboxRequestError(field, `must be an absolute path (${JSON.stringify(p)})`);
  }
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** Directories strictly between `root` and `target` (both real paths), plus `root` itself. */
function ancestorsBelow(root: string, target: string): string[] {
  if (!target.startsWith(`${root}/`)) return [];
  const out = [root];
  let cur = root;
  for (const seg of target
    .slice(root.length + 1)
    .split('/')
    .slice(0, -1)) {
    cur = `${cur}/${seg}`;
    out.push(cur);
  }
  return out;
}

export function buildSeatbeltProfile(spec: SeatbeltSpec): SeatbeltInvocation {
  const params: Record<string, string> = {};
  const lines: string[] = ['(version 1)', '(allow default)'];
  let n = 0;
  const param = (field: string, value: string): string => {
    const key = `P${String(n++)}`;
    params[key] = checkPath(field, value);
    return `(param "${key}")`;
  };

  // Writes: nothing but the attempt's own dirs.
  lines.push('(deny file-write*)');
  const writable = [
    `(subpath ${param('workspace', spec.workspace)})`,
    `(subpath ${param('sandboxDir', spec.sandboxDir)})`,
    ...(spec.extraWritable ?? []).map((p) => `(subpath ${param('extraWritable', p)})`),
    ...(spec.cacheDirs ?? []).map((p) => `(subpath ${param('cacheDirs', p)})`),
    ...(spec.loginDirs ?? []).map((p) => `(subpath ${param('loginDirs', p)})`),
  ];
  lines.push(
    `(allow file-write* ${writable.join(' ')} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
  );

  // Reads. (1) Worker secrets: nothing. (2) The workspace root's jobs/sandboxes/mirrors/
  // .remyral trees: no contents or listings, *except* this attempt's own dirs, its
  // mirror's object store, and the directories on the way to them (getcwd(3) lists
  // those; their listings reveal ids, not contents). Expressed with `require-not`
  // instead of a later allow (verified: getcwd failed with the override form).
  // (3) Protected home paths: nothing at all (`file-read*`).
  const root = spec.workspaceRoot;
  const carved = [...(spec.readableInDataDir ?? []), ...(spec.cacheDirs ?? []), ...(spec.loginDirs ?? [])];
  const carveOut = carved.map((p) => `(require-not (subpath ${param('readableInDataDir', p)}))`);
  if (carveOut.length === 0) {
    lines.push(`(deny file-read* (subpath ${param('workerDataDir', spec.workerDataDir)}))`);
  } else {
    // p5-remote-ops: the managed runtime installs stay readable (p6-warm-caches: and the project's package cache);
    // the data dir and the directories on the way to them only for path lookup (metadata, no listing); everything
    // else in it stays unreadable.
    const dataDir = checkPath('workerDataDir', spec.workerDataDir);
    const lookups = [...new Set([dataDir, ...carved.flatMap((t) => ancestorsBelow(dataDir, t))])].map((d) =>
      param('workerDataDir', d),
    );
    lines.push(
      `(deny file-read* (require-all (subpath ${param('workerDataDir', dataDir)}) ${carveOut.join(' ')} ${lookups
        .map((d) => `(require-not (literal ${d}))`)
        .join(' ')}))`,
    );
    for (const d of lookups) lines.push(`(deny file-read-data file-read-xattr (literal ${d}))`);
  }
  const own = [
    `(require-not (subpath ${param('workspace', spec.workspace)}))`,
    `(require-not (subpath ${param('sandboxDir', spec.sandboxDir)}))`,
  ];
  if (spec.mirrorObjects !== undefined) {
    own.push(`(require-not (subpath ${param('mirrorObjects', spec.mirrorObjects)}))`);
  }
  for (const dir of spec.readOnlyDirs ?? []) {
    own.push(`(require-not (subpath ${param('readOnlyDirs', dir)}))`);
  }
  const targets = [
    spec.workspace,
    spec.sandboxDir,
    ...(spec.mirrorObjects === undefined ? [] : [spec.mirrorObjects]),
    ...(spec.readOnlyDirs ?? []),
  ];
  for (const dir of new Set(targets.flatMap((t) => ancestorsBelow(root, t)))) {
    own.push(`(require-not (literal ${param('ancestor', dir)}))`);
  }
  for (const d of ['jobs', 'sandboxes', 'mirrors', '.remyral']) {
    lines.push(
      `(deny file-read-data file-read-xattr (require-all (subpath ${param('workspaceRoot', join(root, d))}) ${own.join(' ')}))`,
    );
  }
  const denyRead: string[] = [];
  for (const home of spec.homes) {
    for (const rel of PROTECTED_HOME_PATHS) {
      if (rel === 'Library/Keychains' && spec.allowKeychain === true) continue;
      denyRead.push(`(subpath ${param('homes', join(home, rel))})`);
    }
  }
  for (const p of spec.extraDenyRead ?? []) denyRead.push(`(subpath ${param('extraDenyRead', p)})`);
  if (denyRead.length > 0) lines.push(`(deny file-read* ${denyRead.join(' ')})`);
  // The `.git` file of the trusted worktree: readable (status/log work), never writable.
  lines.push(`(deny file-write* (literal ${param('workspace', join(spec.workspace, '.git'))}))`);

  // Network: nothing, except the per-job egress proxy. Seatbelt cannot tell a loopback
  // listener from one on all interfaces (`local ip` accepts only `*`/`localhost`, and
  // allowing loopback inbound also permits binding 0.0.0.0 — verified), so listening is
  // denied unless explicitly allowed for runtimes that serve on loopback (OpenCode).
  lines.push('(deny network*)');
  if (spec.allowListen === true) {
    lines.push('(allow network-bind (local ip "localhost:*"))');
    lines.push('(allow network-inbound (local ip "localhost:*"))');
  }
  if (spec.proxyPort !== undefined) {
    if (!Number.isInteger(spec.proxyPort) || spec.proxyPort < 1 || spec.proxyPort > 65535) {
      throw new SandboxRequestError('proxyPort', String(spec.proxyPort));
    }
    // Seatbelt's `remote ip` takes a literal "host:port"; a port number cannot inject rules.
    lines.push(`(allow network-outbound (remote ip "localhost:${String(spec.proxyPort)}"))`);
  }
  for (const port of spec.loopbackPorts ?? []) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxRequestError('loopbackPorts', String(port));
    }
    lines.push(`(allow network-outbound (remote ip "localhost:${String(port)}"))`);
  }
  // One rule per directory: inside `unix-socket` only the first path filter counts (verified on macOS 26.6).
  for (const dir of spec.unixSocketDirs ?? []) {
    const d = param('unixSocketDirs', dir);
    lines.push(`(allow network-bind network-inbound (local unix-socket (subpath ${d})))`);
    lines.push(`(allow network-outbound (remote unix-socket (subpath ${d})))`);
  }

  const profile = lines.join('\n');
  const argv: string[] = [SANDBOX_EXEC, '-p', profile];
  for (const [k, v] of Object.entries(params)) argv.push('-D', `${k}=${v}`);
  return { profile, params, argv };
}

export interface SeatbeltStatus {
  readonly available: boolean;
  readonly detail: string;
}

/** Checks that `sandbox-exec` exists and can apply a trivial profile on this host. */
export function seatbeltStatus(platform: NodeJS.Platform = process.platform): Promise<SeatbeltStatus> {
  if (platform !== 'darwin') return Promise.resolve({ available: false, detail: 'not macOS' });
  return new Promise((resolve) => {
    execFile(
      SANDBOX_EXEC,
      ['-p', '(version 1)(allow default)(deny file-write* (subpath "/"))', '/usr/bin/true'],
      { timeout: 10_000 },
      (err, _stdout, stderr) => {
        if (err)
          resolve({ available: false, detail: `sandbox-exec failed: ${stderr.trim() || err.message}` });
        else resolve({ available: true, detail: 'sandbox-exec (deprecated by Apple, functional)' });
      },
    );
  });
}
