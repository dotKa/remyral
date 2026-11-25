import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { McpInstallScriptsRun } from '@remyral/protocol';
import type { RunFn } from '../remote-ops/process.js';

/**
 * p19-install-scripts (ADR-0068, docs/design/p19-install-scripts.md): runs the lifecycle scripts of the npm packages
 * of an MCP install whose install script an admin approved (exact name, version and integrity — the lockfile check
 * already refused every other package with a script). It runs after the tree was unpacked from hashed tarballs and
 * before the tree is hashed and made read-only, so the digest covers what the scripts produced.
 *
 *  1. `npm rebuild --ignore-scripts` links the packages' bins (`node_modules/.bin`, what scripts call) — npm only.
 *  2. `npm rebuild <name@version>… --foreground-scripts` runs exactly the approved packages' scripts (npm order:
 *     preinstall → install → postinstall, node-gyp for a `binding.gyp`) with a minimal environment (no worker
 *     secrets: only the network/proxy settings, PATH with the worker's Node, HOME / TMP in the install's staging dir)
 *     and an empty npmrc. On Linux, when bubblewrap is usable, inside it: the root file system read-only, the worker's
 *     data dir and the protected homes hidden, writable only the install dir and its staging dir; the network stays
 *     open (a script may download a prebuilt binary). macOS / Windows: no sandbox (the approval card says so).
 */

export class InstallScriptError extends Error {
  constructor(
    readonly reason: 'npm_unavailable' | 'install_failed' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'InstallScriptError';
  }
}

export interface ScriptRunnerDeps {
  readonly nodePath: string;
  readonly npmCli: string;
  readonly run: RunFn;
  /** Environment without secrets (network settings, PATH, HOME in the staging dir). */
  readonly baseEnv: Readonly<Record<string, string>>;
  /** Linux: a usable, trusted bubblewrap (null: run without a sandbox). */
  readonly bwrap: string | null;
  /** Directories hidden from the scripts (the worker's data dir, protected homes). */
  readonly hide: readonly string[];
  readonly timeoutMs: number;
}

export const SCRIPT_OUTPUT_MAX = 4000;

/** bubblewrap arguments (between `bwrap` and `--`) for the scripts of one install. */
export function scriptBwrapArgs(input: {
  readonly dir: string;
  readonly staging: string;
  readonly hide: readonly string[];
  readonly keep: readonly string[];
}): string[] {
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user-try',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
  ];
  for (const h of input.hide) args.push('--tmpfs', h);
  // What the hidden directories must still show: the worker's Node and npm (read-only), then the writable install.
  for (const k of input.keep) args.push('--ro-bind', k, k);
  args.push('--bind', input.dir, input.dir, '--bind', input.staging, input.staging, '--chdir', input.dir);
  return args;
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return (lines.at(-1) ?? '').slice(0, 240);
}

/** A directory that holds `p` and is not `/` (the prefix of the worker's Node / npm, kept visible). */
function prefixOf(p: string, up: number): string | null {
  let d = p;
  for (let i = 0; i < up; i++) d = dirname(d);
  return d === dirname(d) ? null : d;
}

export async function runApprovedScripts(
  d: ScriptRunnerDeps,
  input: {
    readonly dir: string;
    readonly staging: string;
    readonly packages: readonly { readonly name: string; readonly version: string }[];
    readonly signal?: AbortSignal | undefined;
  },
): Promise<McpInstallScriptsRun> {
  if (!existsSync(d.npmCli)) {
    throw new InstallScriptError('npm_unavailable', `npm is not next to the worker's Node (${d.npmCli})`);
  }
  const conf = join(input.staging, 'scripts-npmrc');
  await mkdir(conf, { recursive: true, mode: 0o700 });
  await writeFile(join(conf, 'user.npmrc'), '', { mode: 0o600 });
  await writeFile(join(conf, 'global.npmrc'), '', { mode: 0o600 });
  const env: Record<string, string> = {
    ...d.baseEnv,
    npm_config_userconfig: join(conf, 'user.npmrc'),
    npm_config_globalconfig: join(conf, 'global.npmrc'),
    npm_config_cache: join(input.staging, 'npm-cache'),
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_offline: 'true',
    npm_config_loglevel: 'warn',
  };
  const opts = { env, cwd: input.dir, timeoutMs: d.timeoutMs, signal: input.signal };
  const linked = await d.run(d.nodePath, [d.npmCli, 'rebuild', '--ignore-scripts'], {
    ...opts,
    env: { ...env, npm_config_ignore_scripts: 'true' },
  });
  if (linked.exitCode !== 0) {
    if (input.signal?.aborted === true) throw new InstallScriptError('cancelled', 'cancelled');
    throw new InstallScriptError(
      'install_failed',
      `npm could not link the packages' bins (${linked.timedOut ? 'timed out' : `exit ${String(linked.exitCode)}`}): ${lastLine(linked.stderr)}`,
    );
  }
  const specs = input.packages.map((p) => `${p.name}@${p.version}`);
  const npmArgs = [d.npmCli, 'rebuild', ...specs, '--foreground-scripts'];
  const runEnv = { ...env, npm_config_ignore_scripts: 'false' };
  let file = d.nodePath;
  let args = npmArgs;
  if (d.bwrap !== null) {
    const keep = [prefixOf(d.nodePath, 2), prefixOf(d.npmCli, 2)].filter(
      (k): k is string => k !== null && d.hide.some((h) => k === h || k.startsWith(`${h}/`)),
    );
    file = d.bwrap;
    args = [
      ...scriptBwrapArgs({ dir: input.dir, staging: input.staging, hide: d.hide, keep }),
      '--',
      d.nodePath,
      ...npmArgs,
    ];
  }
  const r = await d.run(file, args, { ...opts, env: runEnv });
  const output = tail(`${r.stdout}${r.stderr === '' ? '' : `\n${r.stderr}`}`.trim(), SCRIPT_OUTPUT_MAX);
  if (r.exitCode !== 0) {
    if (input.signal?.aborted === true) throw new InstallScriptError('cancelled', 'cancelled');
    throw new InstallScriptError(
      'install_failed',
      `the approved install script of ${specs.join(', ').slice(0, 300)} failed (${r.timedOut ? 'timed out' : `exit ${String(r.exitCode)}`}): ${lastLine(r.stderr === '' ? r.stdout : r.stderr)}`,
    );
  }
  return { ran: specs.slice(0, 50), sandbox: d.bwrap === null ? 'none' : 'bwrap', output };
}
