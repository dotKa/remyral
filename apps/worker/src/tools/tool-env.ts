import { posix, win32 } from 'node:path';
import type { ProcessConfiner } from '@remyral/agent-adapters';
import type { CustomManagedTool, ManagedTool } from './installer.js';

/**
 * p5-live-fixes-2: worker-managed tools (p5-machine-admin recipes) are usable by the worker and by agents.
 *
 * - `resolveGitBinary`: the git the worker itself runs, resolved at use time — the config's `gitBinary`, else the
 *   worker-managed MinGit (Fleet → Tools), else `git` on PATH. A tool installed after the daemon started is
 *   picked up by the next git call (live finding 2026-10-14: `spawn git ENOENT` with MinGit installed).
 * - `managedToolEnv`: the bin dirs of the managed installs (git `cmd`, python + `Scripts` for pip, ffmpeg `bin`)
 *   and `PLAYWRIGHT_BROWSERS_PATH` / `REMYRAL_BROWSER` for the managed Chromium.
 * - `withToolEnv`: a confiner decorator that prepends those dirs to the runtime's PATH (host profiles only; a
 *   container sees none of the host's tool dirs, so the container profile is left untouched).
 */

export interface ToolEnv {
  /** Directories to put in front of PATH, in order. */
  readonly pathDirs: readonly string[];
  /**
   * p13-fleet-tools (ADR-0052): directories appended at the END of PATH — admin-defined (custom) installs, which
   * therefore never shadow a system or release-managed tool of the same command name.
   */
  readonly pathAppend?: readonly string[];
  /** Variables set when the runtime's environment does not have them already. */
  readonly vars: Readonly<Record<string, string>>;
}

export const EMPTY_TOOL_ENV: ToolEnv = { pathDirs: [], vars: {} };

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

/** The git executable: config → worker-managed install → `git` on PATH. */
export function resolveGitBinary(
  configured: string | undefined,
  managed: readonly ManagedTool[],
): { binary: string; source: 'config' | 'managed' | 'path' } {
  if (configured !== undefined && configured !== '') return { binary: configured, source: 'config' };
  const git = managed.findLast((m) => m.tool === 'git');
  if (git !== undefined) return { binary: git.entry, source: 'managed' };
  return { binary: 'git', source: 'path' };
}

/** PATH dirs and variables for the managed installs (newest install of a tool first, as the installer lists them). */
export function managedToolEnv(
  managed: readonly ManagedTool[],
  platform: NodeJS.Platform,
  custom: readonly CustomManagedTool[] = [],
): ToolEnv {
  const p = pathApi(platform);
  const dirs: string[] = [];
  const vars: { PLAYWRIGHT_BROWSERS_PATH?: string; REMYRAL_BROWSER?: string } = {};
  const add = (d: string): void => {
    if (!dirs.includes(d)) dirs.push(d);
  };
  for (const m of [...managed].reverse()) {
    if (m.tool === 'browser') {
      vars.PLAYWRIGHT_BROWSERS_PATH ??= m.dir;
      vars.REMYRAL_BROWSER ??= m.entry;
      continue;
    }
    const bin = p.dirname(m.entry);
    add(bin);
    // pip and the console scripts of packages installed into the managed Python.
    if (m.tool === 'python') add(platform === 'win32' ? p.join(bin, 'Scripts') : bin);
  }
  const append: string[] = [];
  for (const c of [...custom].reverse()) {
    const bin = p.dirname(c.entry);
    if (!dirs.includes(bin) && !append.includes(bin)) append.push(bin);
  }
  return { pathDirs: dirs, ...(append.length === 0 ? {} : { pathAppend: append }), vars };
}

/** Commands of the tool inventory that jobs are expected to call (`node` also brings `npm` / `npx` / `corepack`). */
export const JOB_PATH_TOOLS: readonly string[] = ['node', 'git', 'uv', 'python'];

export interface JobToolDirsInput {
  /**
   * The worker's own Node (`process.execPath`). The inventory reports its version as the machine's Node, so jobs
   * must find it: on Linux the installer keeps it privately under /opt/remyral-worker/node/node-v24…/bin (root-owned,
   * not on the service's PATH), next to its `npm`, `npx` and `corepack`.
   */
  readonly execPath: string;
  /** The cached tool inventory (system hits only are used; managed installs are already in `pathDirs`). */
  readonly detected: readonly {
    readonly name: string;
    readonly found: boolean;
    readonly path?: string | undefined;
    readonly source: 'system' | 'managed';
  }[];
  readonly platform: NodeJS.Platform;
  /** Directories whose subtrees never go on a job's PATH: the worker data dir, the workspace root, the worker's HOME. */
  readonly excluded: readonly string[];
  /**
   * True when the worker account may write `dir` (POSIX `access(W_OK)`). Such a directory never goes on a job's PATH:
   * a job running as the same account could plant a binary there for later jobs. Not asked on Windows, where
   * `access` does not reflect ACLs; the exclusions above cover the worker's own writable places there.
   */
  readonly writable: (dir: string) => Promise<boolean>;
}

/**
 * p14-repo-egress (problem 2): the directories of the tools the machine reports — the worker's own Node and the
 * system `node` / `git` / `uv` / `python` the inventory found — that a job's PATH must also contain, appended after the
 * runtime's own PATH (never shadowing it). Read-only places only: never inside the worker data dir (managed installs
 * come through `pathDirs`), the workspace root or the worker's HOME, and on POSIX never a directory the worker account
 * can write. Never a secret: these are directories, not values.
 */
export async function jobToolDirs(input: JobToolDirsInput): Promise<string[]> {
  const p = pathApi(input.platform);
  const win = input.platform === 'win32';
  const norm = (d: string): string => {
    const n = p.normalize(d);
    return win ? n.toLowerCase() : n;
  };
  const inside = (dir: string, root: string): boolean => {
    const r = norm(root);
    const d = norm(dir);
    const sep = win ? '\\' : '/';
    return d === r || d.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
  };
  const candidates = [
    p.dirname(input.execPath),
    ...input.detected
      .filter(
        (t) => t.found && t.source === 'system' && JOB_PATH_TOOLS.includes(t.name) && t.path !== undefined,
      )
      .map((t) => p.dirname(t.path ?? '')),
  ];
  const out: string[] = [];
  for (const dir of candidates) {
    if (!p.isAbsolute(dir) || out.some((o) => norm(o) === norm(dir))) continue;
    if (input.excluded.some((x) => x !== '' && inside(dir, x))) continue;
    if (!win && (await input.writable(dir).catch(() => true))) continue;
    out.push(dir);
  }
  return out;
}

/** `tools` with `extra` appended to `pathAppend` (after the custom installs). */
export function withJobToolDirs(tools: ToolEnv, extra: readonly string[]): ToolEnv {
  if (extra.length === 0) return tools;
  const append = [...(tools.pathAppend ?? [])];
  for (const d of extra) if (!append.includes(d) && !tools.pathDirs.includes(d)) append.push(d);
  return { ...tools, pathAppend: append };
}

/** The name of the PATH variable in `env` (Windows: case-insensitive, usually `Path`). */
export function pathKey(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string {
  if (platform !== 'win32') return 'PATH';
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

/** A copy of `env` with `dirs` in front of PATH (duplicates dropped) and missing `vars` set. */
export function applyToolEnv(
  env: Readonly<Record<string, string>>,
  tools: ToolEnv,
  platform: NodeJS.Platform,
): Record<string, string> {
  let out: Record<string, string> = { ...env };
  const append = tools.pathAppend ?? [];
  if (tools.pathDirs.length > 0 || append.length > 0) {
    const key = pathKey(out, platform);
    const sep = platform === 'win32' ? ';' : ':';
    const norm = (d: string): string => (platform === 'win32' ? d.toLowerCase() : d);
    const front = new Set(tools.pathDirs.map(norm));
    const rest = (out[key] ?? '').split(sep).filter((d) => d !== '' && !front.has(norm(d)));
    const present = new Set([...front, ...rest.map(norm)]);
    const tail = append.filter((d) => !present.has(norm(d)));
    // Windows: exactly one PATH variable, whatever its spelling.
    if (platform === 'win32') {
      out = Object.fromEntries(Object.entries(out).filter(([k]) => k === key || k.toUpperCase() !== 'PATH'));
    }
    out[key] = [...tools.pathDirs, ...rest, ...tail].join(sep);
  }
  for (const [k, v] of Object.entries(tools.vars)) {
    const present =
      platform === 'win32' ? Object.keys(out).some((x) => x.toUpperCase() === k.toUpperCase()) : k in out;
    if (!present) out[k] = v;
  }
  return out;
}

/**
 * Wraps a host-profile confiner so the runtime (and every process it starts) finds the worker-managed tools.
 * The tool env is read when the runtime starts, so a tool installed while the worker runs is included.
 */
export function withToolEnv(
  inner: ProcessConfiner,
  tools: () => Promise<ToolEnv>,
  platform: NodeJS.Platform = process.platform,
): ProcessConfiner {
  return {
    kind: inner.kind,
    confine: async (plan) => {
      const t = await tools().catch(() => EMPTY_TOOL_ENV);
      return inner.confine({ ...plan, env: applyToolEnv(plan.env, t, platform) });
    },
  };
}
