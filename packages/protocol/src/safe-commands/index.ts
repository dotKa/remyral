import { classifyCmd } from './cmd.js';
import { type PathFlavor, resolveWorkspacePath } from './paths.js';
import { classifyPosix } from './posix.js';
import { classifyPowerShell } from './powershell.js';
import { Effects, NotSafe, type SafePlatform, type SafeVerdict, type ShellFamily } from './types.js';

/**
 * p6-safe-auto-approve (docs/design/p6-safe-auto-approve.md): the conservative classifier that decides whether a
 * runtime's shell command is proven read-only (or writes only inside the job workspace). Pure, synchronous and
 * filesystem-free: the worker runs it (plus symlink / hard-link / repository checks) before it claims a command is
 * safe, and the master runs it again on the claimed command before it auto-approves. Both must agree; anything not
 * proven safe goes to a human as before.
 */

export * from './paths.js';
export * from './rules.js';
export {
  SAFE_PLATFORMS,
  SAFE_VERDICTS,
  SHELL_FAMILIES,
  type SafePlatform,
  type SafeVerdict,
  type ShellFamily,
} from './types.js';

/** Project setting (Policy tab). */
export const SAFE_COMMANDS_MODES = ['off', 'read-only', 'workspace-writes'] as const;
export type SafeCommandsMode = (typeof SAFE_COMMANDS_MODES)[number];

/**
 * Default for every project that has not chosen: read-only commands are auto-approved, writes still ask. Reading
 * inside the job's own workspace discloses nothing the agent cannot already read with its structured read tools
 * (Read / Grep / Glob, which never ask under `ask-sensitive`); writes stay a human decision until an admin opts in.
 */
export const DEFAULT_SAFE_COMMANDS_MODE: SafeCommandsMode = 'read-only';

export const SAFE_COMMANDS_MODE_LABEL: Readonly<Record<SafeCommandsMode, string>> = {
  off: 'Off — every shell command asks',
  'read-only': 'Read-only commands',
  'workspace-writes': 'Read-only + workspace writes',
};

export const MAX_SAFE_COMMAND_LENGTH = 4000;

export function isSafeCommandsMode(v: unknown): v is SafeCommandsMode {
  return typeof v === 'string' && (SAFE_COMMANDS_MODES as readonly string[]).includes(v);
}

/** Whether a project mode auto-approves a command with this verdict. */
export function modeAllows(mode: SafeCommandsMode, verdict: SafeVerdict): boolean {
  if (mode === 'off') return false;
  return verdict === 'read' || mode === 'workspace-writes';
}

export interface ClassifyInput {
  readonly command: string;
  /**
   * The shells that may run the command. More than one when the runtime picks its shell at run time (OpenCode on
   * Windows: Git Bash or cmd): the command must be safe in every one of them.
   */
  readonly shells: readonly ShellFamily[];
  readonly platform: SafePlatform;
  /** Absolute workspace root on the worker (relative paths resolve against it). */
  readonly workspaceRoot: string;
}

export type Classification =
  | {
      readonly safe: true;
      readonly verdict: SafeVerdict;
      /** Rule ids that matched (`SAFE_COMMAND_RULES`), sorted. */
      readonly rules: readonly string[];
      /** Absolute paths read / written (for the worker's symlink checks). */
      readonly reads: readonly string[];
      readonly writes: readonly string[];
      /** A git command: the workspace root must hold the repository. */
      readonly usesGit: boolean;
    }
  | { readonly safe: false; readonly reason: string; readonly shell?: ShellFamily };

function flavorOf(shell: ShellFamily, platform: SafePlatform): PathFlavor | null {
  if (shell === 'posix') return platform === 'win32' ? 'msys' : 'posix';
  return platform === 'win32' ? 'win32' : null; // PowerShell / cmd semantics are only modelled on Windows
}

function normalise(command: string): string | null {
  if (typeof command !== 'string' || command.length === 0 || command.length > MAX_SAFE_COMMAND_LENGTH) {
    return null;
  }
  const text = command.replaceAll('\r\n', '\n').trim();
  if (text.length === 0) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return null;
  if (/[\u2028\u2029\u0085]/.test(text)) return null; // line separators some parsers honour
  return text;
}

function classifyOne(text: string, shell: ShellFamily, platform: SafePlatform, root: string): Classification {
  const flavor = flavorOf(shell, platform);
  if (flavor === null) return { safe: false, reason: 'shell_platform', shell };
  if (!resolveWorkspacePath('.', root, flavor).ok)
    return { safe: false, reason: 'workspace_root_invalid', shell };
  const fx = new Effects(flavor, root, shell !== 'posix');
  try {
    if (shell === 'posix') classifyPosix(text, fx, platform);
    else if (shell === 'powershell') classifyPowerShell(text, fx);
    else classifyCmd(text, fx);
  } catch (err) {
    if (err instanceof NotSafe) return { safe: false, reason: err.reason, shell };
    // A parser bug must never approve anything.
    return { safe: false, reason: 'classifier_error', shell };
  }
  if (fx.rules.size === 0) return { safe: false, reason: 'empty_command', shell };
  return {
    safe: true,
    verdict: fx.writes.length > 0 ? 'workspace_write' : 'read',
    rules: [...fx.rules].sort(),
    reads: fx.reads,
    writes: fx.writes,
    usesGit: fx.usesGit,
  };
}

/** Classifies one command line. Not proven safe → `{ safe: false, reason }`. */
export function classifyCommand(input: ClassifyInput): Classification {
  const text = normalise(input.command);
  if (text === null) return { safe: false, reason: 'command_invalid' };
  if (input.shells.length === 0) return { safe: false, reason: 'no_shell' };
  const shells = [...new Set(input.shells)];
  let verdict: SafeVerdict = 'read';
  const rules = new Set<string>();
  const reads = new Set<string>();
  const writes = new Set<string>();
  let usesGit = false;
  for (const shell of shells) {
    const c = classifyOne(text, shell, input.platform, input.workspaceRoot);
    if (!c.safe) return c;
    if (c.verdict === 'workspace_write') verdict = 'workspace_write';
    for (const r of c.rules) rules.add(r);
    for (const p of c.reads) reads.add(p);
    for (const p of c.writes) writes.add(p);
    usesGit ||= c.usesGit;
  }
  return {
    safe: true,
    verdict,
    rules: [...rules].sort(),
    reads: [...reads],
    writes: [...writes],
    usesGit,
  };
}
