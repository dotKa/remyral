import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeKind } from '@remyral/protocol';
import { downloadVerified, InstallError, npmTarballUrl, type SourceOptions } from './fetch.js';
import { type BinaryFileSpec, type HostPlatform, type NpmPackageSpec, selectPackages } from './manifest.js';
import { extractTgz, TarError } from './tar.js';

/** How the worker starts an installed runtime: an executable and the arguments before the runtime's own. */
export interface Launch {
  readonly file: string;
  readonly args: readonly string[];
}

export type Progress = (step: string, done?: number, total?: number) => void;

/** Read through a call so a check after an `await` is not narrowed away by an earlier one. */
const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const MAX_TARBALL_BYTES = 512 * 1024 * 1024;

/**
 * npm install from the bundled lockfile: every package for this platform is downloaded from the registry,
 * checked against its lockfile sha512 **before** extraction, and extracted by the worker's own tar reader
 * into `<dir>/<lockfile path>`. No npm, no install scripts, no `.npmrc`.
 */
export async function installNpm(
  packages: readonly NpmPackageSpec[],
  host: HostPlatform,
  dir: string,
  opts: SourceOptions & { signal?: AbortSignal | undefined; progress: Progress; concurrency?: number },
): Promise<number> {
  const selected = selectPackages(packages, host);
  if (!selected.ok) throw new InstallError('platform_unsupported', selected.reason);
  const list = selected.packages;
  const downloads = join(dir, '.downloads');
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  let done = 0;
  opts.progress('download', 0, list.length);
  const queue = list.map((p, i) => ({ p, i }));
  // The first failure stops the other downloads; every worker settles before the error is reported.
  const stop = new AbortController();
  const signal = opts.signal === undefined ? stop.signal : AbortSignal.any([opts.signal, stop.signal]);
  const worker = async () => {
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (aborted(signal)) throw new InstallError('cancelled', 'cancelled');
        const { p, i } = next;
        const file = join(downloads, `${String(i)}.tgz`);
        await downloadVerified(npmTarballUrl(p.resolved, opts.npmRegistry), p.integrity, file, {
          ...opts,
          signal,
          maxBytes: MAX_TARBALL_BYTES,
        });
        try {
          await extractTgz(file, join(dir, ...p.path.split('/')));
        } catch (err) {
          throw new InstallError(
            'extract_failed',
            `${p.name}@${p.version}: ${err instanceof TarError ? err.message : 'extraction failed'}`,
          );
        }
        await rm(file, { force: true });
        done++;
        opts.progress('download', done, list.length);
      }
    } catch (err) {
      stop.abort();
      throw err;
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(opts.concurrency ?? 4, list.length || 1) }, worker),
  );
  const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
  if (errors.length > 0) {
    // Report the cause, not the cancellations it triggered (unless the caller cancelled).
    throw errors.find((e) => !(e instanceof InstallError && e.reason === 'cancelled')) ?? errors[0];
  }
  await rm(downloads, { recursive: true, force: true });
  return list.length;
}

/** First existing file among `candidates` (absolute). */
function firstExisting(candidates: readonly string[]): string | null {
  return candidates.find((c) => existsSync(c)) ?? null;
}

async function codexNative(dir: string, host: HostPlatform): Promise<string | null> {
  const os = host.os === 'win32' ? 'win32' : host.os;
  const pkg = join(dir, 'node_modules', '@openai', `codex-${os}-${host.arch}`, 'vendor');
  const exe = host.os === 'win32' ? 'codex.exe' : 'codex';
  const triples = await readdir(pkg).catch(() => [] as string[]);
  return firstExisting(triples.map((t) => join(pkg, t, 'bin', exe)));
}

async function binOf(packageDir: string, name: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
    if (rel === undefined || rel.includes('..')) return null;
    const file = join(packageDir, ...rel.split('/'));
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/**
 * The executable of an npm-installed runtime: the native platform binary where one exists (Claude Code,
 * Codex, OpenCode — exactly what the images link), else the package's `bin` script run by this worker's own
 * Node (Pi).
 */
export async function npmLaunch(
  runtime: RuntimeKind,
  dir: string,
  host: HostPlatform,
  nodePath: string,
): Promise<Launch | null> {
  const nm = join(dir, 'node_modules');
  const exe = host.os === 'win32' ? '.exe' : '';
  switch (runtime) {
    case 'claude-code': {
      const base = join(nm, '@anthropic-ai');
      const plat = `claude-agent-sdk-${host.os}-${host.arch}`;
      const order = host.libc === 'musl' ? [`${plat}-musl`, plat] : [plat, `${plat}-musl`];
      const file = firstExisting(order.map((p) => join(base, p, `claude${exe}`)));
      return file === null ? null : { file, args: [] };
    }
    case 'codex': {
      const file = await codexNative(dir, host);
      return file === null ? null : { file, args: [] };
    }
    case 'opencode': {
      const os = host.os === 'win32' ? 'windows' : host.os;
      const plat = `opencode-${os}-${host.arch}`;
      const order = host.libc === 'musl' ? [`${plat}-musl`, plat] : [plat, `${plat}-musl`];
      const file = firstExisting(order.map((p) => join(nm, p, 'bin', `opencode${exe}`)));
      return file === null ? null : { file, args: [] };
    }
    case 'pi': {
      const script = await binOf(join(nm, '@earendil-works', 'pi-coding-agent'), 'pi');
      return script === null ? null : { file: nodePath, args: [script] };
    }
  }
}

/** Single-file binary: downloaded, sha256-checked, made executable. */
export async function installBinary(
  file: BinaryFileSpec,
  dir: string,
  opts: SourceOptions & { signal?: AbortSignal | undefined; progress: Progress },
): Promise<Launch> {
  if (file.fileName.includes('/') || file.fileName.includes('\\') || file.fileName.startsWith('.')) {
    throw new InstallError('download_failed', 'invalid binary file name');
  }
  opts.progress('download', 0, 1);
  const target = join(dir, file.fileName);
  await downloadVerified(file.url, file.sha256, target, { ...opts, maxBytes: Math.max(file.size, 1) });
  await chmod(target, 0o755);
  opts.progress('download', 1, 1);
  return { file: target, args: [] };
}

/** sha256 (hex) of a file, streamed. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}
