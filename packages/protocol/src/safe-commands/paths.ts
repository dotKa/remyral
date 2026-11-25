/**
 * Lexical path checks of the safe-command classifier (p6-safe-auto-approve, docs/design/p6-safe-auto-approve.md).
 *
 * Pure and filesystem-free (the master runs it too, on another OS than the worker). The worker repeats every
 * check with symlinks resolved (`@remyral/agent-adapters` `verifySafeClaim`). Anything ambiguous is refused:
 * UNC / `\\?\` / `\\.\` paths, drive-relative `C:foo`, root-relative `\foo`, alternate data streams and provider
 * paths (`env:`, `HKLM:`), `~`, reserved device names, trailing dots or spaces (Win32 strips them, so `.git.`
 * is `.git`), and every `..` that leaves the workspace.
 */

/** How the target shell spells paths: POSIX, Win32 (PowerShell, cmd) or MSYS (Git Bash on Windows). */
export type PathFlavor = 'posix' | 'win32' | 'msys';

export type PathCheck =
  | {
      readonly ok: true;
      /** Normalised absolute path (Win32 flavours use `\`). */
      readonly abs: string;
      /** Segments below the workspace root; empty for the root itself. */
      readonly segments: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

const WIN_RESERVED =
  /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$|clock\$)$/i;
const WIN_BAD_CHARS = /[<>:"|?*]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Files and directories that change how a runtime, git or the worker behaves later. Never auto-approved as a
 * write target (any dot segment is refused anyway; these are the dot-less ones).
 */
export const PROTECTED_WRITE_NAMES: readonly string[] = [
  'agents.md',
  'claude.md',
  'claude.local.md',
  'gemini.md',
  'opencode.json',
  'opencode.jsonc',
];

interface Root {
  readonly prefix: string;
  readonly segments: readonly string[];
}

function winish(flavor: PathFlavor): boolean {
  return flavor !== 'posix';
}

function parseRoot(root: string, flavor: PathFlavor): Root | null {
  if (root.length === 0 || root.length > 4096 || CONTROL.test(root)) return null;
  if (winish(flavor)) {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(root);
    if (!m) return null;
    const segs = (m[2] ?? '').split(/[\\/]+/).filter((s) => s.length > 0);
    if (segs.some((s) => s === '.' || s === '..')) return null;
    return { prefix: `${(m[1] ?? '').toUpperCase()}:`, segments: segs };
  }
  if (!root.startsWith('/')) return null;
  const segs = root.split('/').filter((s) => s.length > 0);
  if (segs.some((s) => s === '.' || s === '..')) return null;
  return { prefix: '', segments: segs };
}

function same(a: string, b: string, flavor: PathFlavor): boolean {
  return winish(flavor) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function join(prefix: string, segments: readonly string[], flavor: PathFlavor): string {
  return winish(flavor) ? `${prefix}\\${segments.join('\\')}` : `/${segments.join('/')}`;
}

/**
 * Resolves `raw` (absolute, or relative to the workspace root) and checks that it stays inside `root`. Only the
 * spelling is checked; symlinks are the worker's job.
 */
export function resolveWorkspacePath(raw: string, root: string, flavor: PathFlavor): PathCheck {
  const r = parseRoot(root, flavor);
  if (r === null) return { ok: false, reason: 'workspace_root_invalid' };
  if (raw.length === 0) return { ok: false, reason: 'empty_path' };
  if (raw.length > 4096 || CONTROL.test(raw)) return { ok: false, reason: 'path_invalid' };
  if (raw.startsWith('~')) return { ok: false, reason: 'home_path' };

  let prefix: string;
  let rest: string;
  let absolute: boolean;
  if (flavor === 'posix') {
    if (raw.includes('\\')) return { ok: false, reason: 'path_backslash' };
    if (raw.startsWith('//')) return { ok: false, reason: 'unc_path' };
    absolute = raw.startsWith('/');
    prefix = '';
    rest = raw;
  } else {
    // 8.3 short names (`GIT~1` can be `.git`, `PROGRA~1` is `Program Files`) defeat every name check.
    if (raw.includes('~')) return { ok: false, reason: 'short_name' };
    const p = raw.replaceAll('/', '\\');
    if (p.startsWith('\\\\')) return { ok: false, reason: 'unc_path' };
    const drive = /^([A-Za-z]):(.*)$/.exec(p);
    if (drive) {
      const tail = drive[2] ?? '';
      if (!tail.startsWith('\\')) return { ok: false, reason: 'drive_relative_path' };
      absolute = true;
      prefix = `${(drive[1] ?? '').toUpperCase()}:`;
      rest = tail;
    } else if (flavor === 'msys' && /^\\[A-Za-z](\\|$)/.test(p)) {
      // Git Bash: /c/Users/x is C:\Users\x.
      absolute = true;
      prefix = `${p.charAt(1).toUpperCase()}:`;
      rest = p.slice(2);
    } else if (p.startsWith('\\')) {
      // Win32: root of the current drive; MSYS: inside the Git installation (/tmp, /etc, /usr) — never the workspace.
      return { ok: false, reason: flavor === 'msys' ? 'msys_root_path' : 'root_relative_path' };
    } else {
      absolute = false;
      prefix = r.prefix;
      rest = p;
    }
    if (rest.includes(':')) return { ok: false, reason: 'stream_or_provider_path' };
  }

  const segments = absolute ? [] : [...r.segments];
  for (const seg of rest.split(winish(flavor) ? /\\+/ : /\/+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) return { ok: false, reason: 'outside_workspace' };
      segments.pop();
      continue;
    }
    if (winish(flavor)) {
      if (WIN_BAD_CHARS.test(seg)) return { ok: false, reason: 'path_invalid' };
      if (/[. ]$/.test(seg)) return { ok: false, reason: 'trailing_dot_or_space' };
      if (WIN_RESERVED.test(seg.split('.')[0] ?? '')) return { ok: false, reason: 'device_name' };
    }
    segments.push(seg);
  }
  if (absolute && !same(prefix, r.prefix, flavor)) return { ok: false, reason: 'outside_workspace' };
  if (segments.length < r.segments.length) return { ok: false, reason: 'outside_workspace' };
  for (let i = 0; i < r.segments.length; i++) {
    if (!same(segments[i] ?? '', r.segments[i] ?? '', flavor))
      return { ok: false, reason: 'outside_workspace' };
  }
  const below = segments.slice(r.segments.length);
  // `.git` holds hooks, config (fsmonitor, textconv) and credentials: never read or written by a safe command.
  if (below.some((s) => s.toLowerCase() === '.git')) return { ok: false, reason: 'git_directory' };
  return { ok: true, abs: join(prefix, segments, flavor), segments: below };
}

/** Additional rules for a write target: not the root, no dot segment, no runtime instruction / config file. */
export function writeTargetProblem(segments: readonly string[]): string | null {
  if (segments.length === 0) return 'write_to_workspace_root';
  if (segments.some((s) => s.startsWith('.'))) return 'dot_path';
  const last = (segments[segments.length - 1] ?? '').toLowerCase();
  if (PROTECTED_WRITE_NAMES.includes(last)) return 'protected_file';
  return null;
}

/** Null devices a redirection may target without counting as a write. */
export function isNullDevice(target: string, flavor: PathFlavor | 'cmd'): boolean {
  if (flavor === 'cmd') return target.toLowerCase() === 'nul';
  return target === '/dev/null';
}
