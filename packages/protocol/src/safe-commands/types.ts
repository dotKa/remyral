import { type PathFlavor, resolveWorkspacePath, writeTargetProblem } from './paths.js';

/** Shell families the classifier parses. `posix` covers bash, sh and zsh with the strictest common subset. */
export const SHELL_FAMILIES = ['posix', 'powershell', 'cmd'] as const;
export type ShellFamily = (typeof SHELL_FAMILIES)[number];

export const SAFE_PLATFORMS = ['posix', 'win32'] as const;
export type SafePlatform = (typeof SAFE_PLATFORMS)[number];

/** What a proven-safe command does: only reads, or also writes inside the workspace. */
export const SAFE_VERDICTS = ['read', 'workspace_write'] as const;
export type SafeVerdict = (typeof SAFE_VERDICTS)[number];

/** How an argument is used by the command. */
export type ArgRole = 'path' | 'wpath' | 'data' | 'pattern';

/** One argument as the shell will pass it. `dynamic`: contains a command substitution (value unknown). */
export interface Arg {
  readonly text: string;
  readonly dynamic: boolean;
}

/** Thrown inside the classifier: the command is not proven safe. */
export class NotSafe extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'NotSafe';
  }
}

export function notSafe(reason: string): never {
  throw new NotSafe(reason);
}

/** Collected effects of one command line. */
export class Effects {
  readonly rules = new Set<string>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  usesGit = false;

  constructor(
    readonly flavor: PathFlavor,
    readonly root: string,
    /** PowerShell and cmd expand `*` / `?` / `[` in path arguments even when quoted. */
    readonly wildcardPaths: boolean,
  ) {}

  read(raw: string): void {
    if (raw === '-' && this.flavor !== 'win32') return; // stdin
    if (this.wildcardPaths && /[*?[\]]/.test(raw)) notSafe('wildcard_path');
    const r = resolveWorkspacePath(raw, this.root, this.flavor);
    if (!r.ok) notSafe(r.reason);
    this.reads.push(r.abs);
  }

  write(raw: string): void {
    if (/[*?[\]]/.test(raw)) notSafe('wildcard_path');
    const r = resolveWorkspacePath(raw, this.root, this.flavor);
    if (!r.ok) notSafe(r.reason);
    const problem = writeTargetProblem(r.segments);
    if (problem !== null) notSafe(problem);
    this.writes.push(r.abs);
  }

  apply(role: ArgRole, arg: Arg): void {
    if (role === 'data' || role === 'pattern') return;
    if (arg.dynamic) notSafe('dynamic_path');
    if (role === 'path') this.read(arg.text);
    else this.write(arg.text);
  }
}

/** Heuristic for an option value whose role is unknown: anything that could name a file is checked as one. */
export function looksLikePath(v: string): boolean {
  return /[\\/]/.test(v) || v.startsWith('.') || v.startsWith('~') || /^[A-Za-z]:/.test(v);
}
