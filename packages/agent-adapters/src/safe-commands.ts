import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { SafeCommandClaim } from '@remyral/protocol';
import {
  classifyCommand,
  PROTECTED_WRITE_NAMES,
  type SafePlatform,
  type ShellFamily,
} from '@remyral/protocol/safe-commands';
import { containsSecret, type SecretEnv } from './secrets.js';

/**
 * p6-safe-auto-approve, worker half (docs/design/p6-safe-auto-approve.md): before a runtime's shell command goes to
 * the master as an approval request, the adapter asks this module whether it can *claim* the command is safe. The
 * claim needs (1) the shared classifier to prove it read-only or workspace-writing, and (2) every path it names to
 * stay inside the workspace on disk: symlinks of the deepest existing ancestor resolved, no `.git`, no hard-linked
 * file (a hard link inside the workspace can be the same file as one outside), and for git commands a repository
 * at the workspace root (otherwise git would discover a parent repository) whose own config names no program git
 * would run for a read (fsmonitor, filters, textconv, external diff, pager, includes). The master classifies the
 * command again
 * and decides with the project's mode; a claim alone approves nothing.
 */

export interface SafeFsProbe {
  /** Canonical path (symlinks resolved); throws when it cannot be resolved. */
  readonly realpath: (p: string) => string;
  /** lstat; null when the path does not exist. */
  readonly lstat: (p: string) => { readonly isFile: boolean; readonly nlink: number } | null;
  /** A small text file's content, or null when it cannot be read. */
  readonly readText?: (p: string) => string | null;
}

const nodeFs: SafeFsProbe = {
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8').slice(0, 256 * 1024);
    } catch {
      return null;
    }
  },
  realpath: (p) => realpathSync.native(p),
  lstat: (p) => {
    try {
      const s = lstatSync(p);
      return { isFile: s.isFile(), nlink: s.nlink };
    } catch {
      return null;
    }
  },
};

/** Which shells may run a runtime's shell tool (see the design note's per-runtime table). */
export function shellsForTool(
  runtime: 'claude-code' | 'opencode' | 'pi',
  tool: string,
  platform: SafePlatform,
): ShellFamily[] | null {
  switch (runtime) {
    case 'claude-code':
      // Bash uses $SHELL (bash/zsh/sh) or Git Bash on Windows; PowerShell is the Windows PowerShell tool.
      if (tool === 'Bash') return ['posix'];
      if (tool === 'PowerShell' && platform === 'win32') return ['powershell'];
      return null;
    case 'pi':
      if (tool === 'bash') return ['posix'];
      if (tool === 'powershell' && platform === 'win32') return ['powershell'];
      return null;
    case 'opencode':
      // OpenCode picks its shell at run time: $SHELL on POSIX; on Windows Git Bash when found, else cmd.exe (and
      // PowerShell in some builds). The command must be safe in every candidate.
      if (tool !== 'bash') return null;
      return platform === 'win32' ? ['posix', 'cmd', 'powershell'] : ['posix'];
  }
}

function pathApi(platform: SafePlatform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/** `abs` resolves (on disk) inside `realRoot`; for a write, not into a dot path or protected file. */
function onDisk(abs: string, realRoot: string, write: boolean, p: typeof posix, fs: SafeFsProbe): boolean {
  let cur = abs;
  let base: string;
  for (;;) {
    const st = fs.lstat(cur);
    if (st !== null) {
      if (cur === abs && st.isFile && st.nlink > 1) return false; // hard link: may be a file outside
      try {
        base = fs.realpath(cur);
      } catch {
        return false; // dangling symlink: following it could land anywhere
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
  if (rel === '') return !write;
  if (p.isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]/);
  if (parts[0] === '..') return false;
  if (parts.some((s) => s.toLowerCase() === '.git')) return false;
  if (write) {
    if (parts.some((s) => s.startsWith('.'))) return false;
    if (PROTECTED_WRITE_NAMES.includes((parts[parts.length - 1] ?? '').toLowerCase())) return false;
  }
  return true;
}

/**
 * Config keys that make a read-only git command run a program: `core.fsmonitor` (status), `filter.*.clean`
 * (status / diff), `diff.*.textconv` / `diff.*.command` / `diff.external`, `core.pager`, `core.hooksPath`,
 * `core.sshCommand` / `core.askPass` / `core.gitProxy`, and `include` / `includeIf` (another file could add any of
 * them). Aliases cannot shadow built-in commands but are refused too.
 */
const RISKY_GIT_CONFIG =
  /(fsmonitor|filter|textconv|external|command|pager|hookspath|sshcommand|askpass|gitproxy|include|alias)/i;

/**
 * The workspace root holds the repository git will use. A `.git` *file* is the worker's own worktree link (its
 * config lives in the worker-managed mirror outside the workspace); a `.git` *directory* must have a config that
 * names no program (it may have been written by a command a human approved earlier).
 */
function repositoryAtRoot(root: string, p: typeof posix, fs: SafeFsProbe): boolean {
  const dotGit = p.join(root, '.git');
  const st = fs.lstat(dotGit);
  if (st === null) return false;
  if (st.isFile) return true;
  const config = fs.readText?.(p.join(dotGit, 'config')) ?? null;
  if (config === null) return false;
  return !RISKY_GIT_CONFIG.test(config);
}

export interface SafeClaimInput {
  /** Runtime tool name as the runtime reports it. */
  readonly tool: string;
  readonly command: string;
  readonly shells: readonly ShellFamily[];
  readonly workspaceRoot: string;
  readonly platform?: SafePlatform;
  /** Secret values of the job: a command that contains one is never claimed (it is a credential use). */
  readonly secretEnv?: SecretEnv;
}

/** The claim to attach to the approval request, or null (the request goes to a human as before). */
export function safeCommandClaim(input: SafeClaimInput, fs: SafeFsProbe = nodeFs): SafeCommandClaim | null {
  const platform: SafePlatform = input.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
  if (input.secretEnv !== undefined && containsSecret(input.command, input.secretEnv)) return null;
  const c = classifyCommand({
    command: input.command,
    shells: input.shells,
    platform,
    workspaceRoot: input.workspaceRoot,
  });
  if (!c.safe) return null;
  const p = pathApi(platform);
  let realRoot: string;
  try {
    realRoot = fs.realpath(input.workspaceRoot);
  } catch {
    return null;
  }
  for (const r of c.reads) if (!onDisk(r, realRoot, false, p, fs)) return null;
  for (const w of c.writes) if (!onDisk(w, realRoot, true, p, fs)) return null;
  if (c.usesGit && !repositoryAtRoot(input.workspaceRoot, p, fs)) return null;
  return {
    tool: input.tool.slice(0, 64),
    command: input.command,
    shells: [...input.shells],
    platform,
    workspaceRoot: input.workspaceRoot,
    verdict: c.verdict,
    rules: [...c.rules],
  };
}
