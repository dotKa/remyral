import { lstatSync, realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/**
 * p5-full-access (ADR-0020 §2): what Claude Code may do under `ask-sensitive` without asking a human.
 *
 * Only **workspace writes** are auto-allowed here — `Write` / `Edit` / `MultiEdit` / `NotebookEdit` whose target
 * (relative paths resolve against the workspace root) lies inside the job's workspace after resolving symlinks of the
 * deepest existing ancestor, and not inside `.git` (a hook written there would run later in the worker's own git
 * commands). The scratch directory of a workspace job (with `in/` and `out/`) is the workspace root.
 *
 * Read-only shell commands were allowed here too until p6-safe-auto-approve; they now go to the master with a
 * safe-command claim (`../../safe-commands.ts`), where the project's mode decides and each auto-approval is audited.
 *
 * Pure apart from the injectable filesystem probes (tests use them for Windows paths on POSIX hosts). Fail closed:
 * any doubt → `null` (ask).
 */

export type AutoAllowKind = 'workspace_write';

export interface FsProbe {
  /** Canonical path (symlinks resolved); throws when it does not exist or cannot be resolved. */
  readonly realpath: (p: string) => string;
  /** The path itself exists (lstat: a dangling symlink exists). */
  readonly exists: (p: string) => boolean;
}

const nodeFs: FsProbe = {
  realpath: (p) => realpathSync.native(p),
  exists: (p) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  },
};

const WRITE_TOOLS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

function pathApi(root: string): typeof posix {
  return /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\') ? win32 : posix;
}

/**
 * Whether `target` (absolute, or relative to `root`) is inside `root` once symlinks are resolved. `allowRoot`: the
 * root itself counts as inside. A dangling symlink anywhere on the way, a missing root or `.git` → false.
 */
export function insideWorkspace(
  target: string,
  root: string,
  opts: { readonly allowRoot?: boolean; readonly fs?: FsProbe } = {},
): boolean {
  const fs = opts.fs ?? nodeFs;
  if (target.length === 0 || target.length > 4096 || target.includes('\0')) return false;
  const p = pathApi(root);
  if (!p.isAbsolute(root)) return false;
  let realRoot: string;
  try {
    realRoot = fs.realpath(root);
  } catch {
    return false;
  }
  const abs = p.isAbsolute(target) ? p.resolve(target) : p.resolve(root, target);
  // Deepest existing ancestor, canonicalised; the missing tail is appended as is (it cannot contain `..`).
  let cur = abs;
  let base: string;
  for (;;) {
    if (fs.exists(cur)) {
      try {
        base = fs.realpath(cur);
      } catch {
        return false; // dangling symlink: writing through it could land anywhere
      }
      break;
    }
    const parent = p.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  const tail = p.relative(cur, abs);
  const real = tail === '' ? base : p.join(base, tail);
  const rel = p.relative(realRoot, real);
  if (rel === '') return opts.allowRoot === true;
  if (p.isAbsolute(rel)) return false; // another drive (win32)
  const parts = rel.split(/[\\/]/);
  if (parts[0] === '..') return false;
  return !parts.some((s) => s.toLowerCase() === '.git');
}

/** What Claude Code may run without asking under `ask-sensitive`, or null (ask a human). */
export function claudeAutoAllow(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot: string,
  fs?: FsProbe,
): AutoAllowKind | null {
  const key = WRITE_TOOLS[toolName];
  if (key !== undefined) {
    const target = input[key];
    if (typeof target !== 'string') return null;
    return insideWorkspace(target, workspaceRoot, fs === undefined ? {} : { fs }) ? 'workspace_write' : null;
  }
  // Shell commands (Bash, PowerShell) are never allowed here: p6-safe-auto-approve sends them to the master with a
  // safe-command claim, so the project's mode decides and every auto-approval is audited.
  return null;
}
