import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RunFn } from './process.js';

/**
 * Resolving an npm dependency tree into a lockfile without installing anything (p14-mcp-stdio, shared with
 * p16-runtime-updates): the worker's own npm (shipped next to its Node) runs `install --package-lock-only
 * --ignore-scripts` in a scratch dir with an empty user / global npmrc, the registry fixed to registry.npmjs.org, no
 * audit / fund / update notifier and only the caller's base environment (its proxy variables). Nothing is downloaded
 * into a node_modules here and no package code runs; the lock is checked and installed by the caller (sha512 per tarball
 * before unpacking).
 */

export class NpmResolveError extends Error {
  constructor(
    readonly reason: 'npm_unavailable' | 'resolve_failed' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'NpmResolveError';
  }
}

/** npm's CLI next to a Node binary from the official archives (lib/node_modules on POSIX, node_modules on Windows). */
export function npmCliNextTo(nodePath: string, platform: NodeJS.Platform = process.platform): string {
  const dir = dirname(nodePath);
  return platform === 'win32'
    ? join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

export const NPM_RESOLVE_TIMEOUT_MS = 10 * 60_000;

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return (lines.at(-1) ?? '').slice(0, 240);
}

export interface NpmResolveInput {
  /** Scratch dir (created); `package.json` is written here and npm writes `package-lock.json` next to it. */
  readonly work: string;
  /** The manifest whose dependencies are resolved (exact versions only). */
  readonly manifest: Readonly<Record<string, unknown>>;
  /** What is resolved, for messages (`name@version`). */
  readonly what: string;
  readonly nodePath: string;
  /** npm's CLI script (default: the one next to `nodePath`). */
  readonly npmCli?: string | null | undefined;
  readonly run: RunFn;
  /** The environment npm starts with (PATH, HOME, proxy variables); the npm settings are added here. */
  readonly baseEnv: Readonly<Record<string, string>>;
  /** npm's cache dir (a scratch dir of the caller). */
  readonly cacheDir: string;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
  /** Test seam: writes `package-lock.json` into `work` instead of running npm. */
  readonly resolve?: ((dir: string, opts: { readonly signal?: AbortSignal }) => Promise<void>) | undefined;
}

/** Resolves `manifest` and returns the bytes of the `package-lock.json` npm wrote. */
export async function resolveNpmLock(input: NpmResolveInput): Promise<Buffer> {
  const { work } = input;
  await mkdir(work, { recursive: true, mode: 0o700 });
  await writeFile(join(work, 'package.json'), `${JSON.stringify(input.manifest, null, 2)}\n`);
  if (input.resolve !== undefined) {
    await input.resolve(work, input.signal === undefined ? {} : { signal: input.signal });
  } else {
    const cli = input.npmCli ?? npmCliNextTo(input.nodePath);
    if (!existsSync(cli)) {
      throw new NpmResolveError('npm_unavailable', `npm is not next to the worker's Node (${cli})`);
    }
    await writeFile(join(work, 'user.npmrc'), '', { mode: 0o600 });
    await writeFile(join(work, 'global.npmrc'), '', { mode: 0o600 });
    const env = {
      ...input.baseEnv,
      npm_config_userconfig: join(work, 'user.npmrc'),
      npm_config_globalconfig: join(work, 'global.npmrc'),
      npm_config_cache: input.cacheDir,
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_ignore_scripts: 'true',
      npm_config_update_notifier: 'false',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    };
    const r = await input.run(
      input.nodePath,
      [
        cli,
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--omit=dev',
        '--lockfile-version=3',
        '--registry=https://registry.npmjs.org/',
      ],
      { env, cwd: work, timeoutMs: input.timeoutMs ?? NPM_RESOLVE_TIMEOUT_MS, signal: input.signal },
    );
    if (r.exitCode !== 0) {
      if (input.signal?.aborted === true) throw new NpmResolveError('cancelled', 'cancelled');
      throw new NpmResolveError(
        'resolve_failed',
        `npm could not resolve ${input.what} (${r.timedOut ? 'timed out' : `exit ${String(r.exitCode)}`}): ${lastLine(r.stderr)}`,
      );
    }
  }
  return readFile(join(work, 'package-lock.json')).catch(() => {
    throw new NpmResolveError('resolve_failed', 'npm wrote no package-lock.json');
  });
}

/** Variables npm may inherit from the worker (its own network settings and what Windows needs to start a process). */
export const NPM_PASS_ENV = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT',
  'COMSPEC',
  'LANG',
];

/** The base environment of a package manager run: the passed variables, a minimal PATH and HOME/TMP = `home`. */
export function packageManagerEnv(
  from: Readonly<Record<string, string | undefined>>,
  nodePath: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of NPM_PASS_ENV) {
    const v = from[k];
    if (typeof v === 'string' && v !== '') env[k] = v;
  }
  const sysPath =
    platform === 'win32' ? `${from.SystemRoot ?? 'C:\\Windows'}\\System32` : '/usr/bin:/bin:/usr/sbin:/sbin';
  env.PATH = [dirname(nodePath), sysPath].join(platform === 'win32' ? ';' : ':');
  env.HOME = home;
  env.USERPROFILE = home;
  env.TMPDIR = home;
  env.TEMP = home;
  env.TMP = home;
  return env;
}
