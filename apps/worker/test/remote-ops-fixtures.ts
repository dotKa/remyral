import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { HostPlatform, InstallManifest, NpmPackageSpec } from '../src/remote-ops/manifest.js';

/** Test fixtures for remote-ops installs: tarballs, a local npm registry, wheels and a PEP 503 index. */

export interface TarEntry {
  readonly path: string;
  readonly data?: Buffer | string;
  readonly mode?: number;
  /** '0' file (default), '5' dir, '2' symlink, '1' hardlink. */
  readonly type?: '0' | '5' | '2' | '1';
  readonly linkname?: string;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(e.path, 0, 100, 'utf8');
  h.write(octal(e.mode ?? 0o644, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(e.type ?? '0', 156, 1, 'ascii');
  if (e.linkname !== undefined) h.write(e.linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

export function tgz(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data =
      e.type === '5' || e.type === '2' || e.type === '1' ? Buffer.alloc(0) : Buffer.from(e.data ?? '');
    parts.push(header(e, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts));
}

export const sri512 = (b: Buffer): string => `sha512-${createHash('sha512').update(b).digest('base64')}`;
export const sha256hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export interface Registry {
  readonly base: string;
  readonly requests: string[];
  /** Replace what a path serves (tamper tests). */
  set(path: string, body: Buffer): void;
  close(): Promise<void>;
}

/** Serves `files` (URL path → body) on 127.0.0.1. */
export async function fixtureServer(files: Record<string, Buffer | string>): Promise<Registry> {
  const map = new Map<string, Buffer>(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    requests.push(path);
    const body = map.get(path) ?? (path.endsWith('/') ? undefined : map.get(`${path}/`));
    if (body === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': path.endsWith('/') ? 'text/html' : 'application/octet-stream',
      'content-length': String(body.length),
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${String(port)}`,
    requests,
    set: (path, body) => map.set(path, body),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

const TRIPLES: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};

/**
 * A Codex-shaped package set for `version`: `@openai/codex` + the platform package for this host (a tiny
 * shell "binary" that prints `codex-cli <version>`) + one for another platform that must never be fetched.
 */
export function codexFixture(
  version: string,
  host: HostPlatform,
  extra: { tarEntries?: TarEntry[] } = {},
): { packages: NpmPackageSpec[]; files: Record<string, Buffer> } {
  const plat = `${host.os}-${host.arch}`;
  const other = host.os === 'darwin' ? 'linux-x64' : 'darwin-arm64';
  const [otherOs, otherCpu] = other.split('-') as [string, string];
  const exe = host.os === 'win32' ? 'codex.exe' : 'codex';
  const root = tgz([
    {
      path: 'package/package.json',
      data: JSON.stringify({ name: '@openai/codex', version, bin: { codex: 'bin/codex.js' } }),
    },
    { path: 'package/bin/codex.js', data: '#!/usr/bin/env node\n', mode: 0o755 },
  ]);
  const native = tgz([
    {
      path: 'package/package.json',
      data: JSON.stringify({ name: '@openai/codex', version: `${version}-${plat}` }),
    },
    {
      path: `package/vendor/${TRIPLES[plat] ?? 'x'}/bin/${exe}`,
      data: `#!/bin/sh\necho "codex-cli ${version}"\n`,
      mode: 0o755,
    },
    ...(extra.tarEntries ?? []),
  ]);
  const foreign = tgz([{ path: 'package/package.json', data: '{}' }]);
  const url = (name: string) => `https://registry.npmjs.org/@openai/codex/-/${name}.tgz`;
  const packages: NpmPackageSpec[] = [
    {
      path: 'node_modules/@openai/codex',
      name: '@openai/codex',
      version,
      resolved: url(`codex-${version}`),
      integrity: sri512(root),
    },
    {
      path: `node_modules/@openai/codex-${plat}`,
      name: '@openai/codex',
      version: `${version}-${plat}`,
      resolved: url(`codex-${version}-${plat}`),
      integrity: sri512(native),
      optional: true,
      os: [host.os],
      cpu: [host.arch],
    },
    {
      path: `node_modules/@openai/codex-${other}`,
      name: '@openai/codex',
      version: `${version}-${other}`,
      resolved: url(`codex-${version}-${other}`),
      integrity: sri512(foreign),
      optional: true,
      os: [otherOs],
      cpu: [otherCpu],
    },
  ];
  return {
    packages,
    files: {
      [`/@openai/codex/-/codex-${version}.tgz`]: root,
      [`/@openai/codex/-/codex-${version}-${plat}.tgz`]: native,
      [`/@openai/codex/-/codex-${version}-${other}.tgz`]: foreign,
    },
  };
}

/** A manifest with only Codex, at the given versions (first = pinned). */
export function codexManifest(
  versions: Record<string, NpmPackageSpec[]>,
  pinned: string,
  previous?: string,
): InstallManifest {
  return {
    schema: 1,
    runtimes: {
      codex: {
        method: 'npm',
        pinned,
        ...(previous === undefined ? {} : { previous }),
        versions: Object.fromEntries(
          Object.entries(versions).map(([v, packages]) => [v, { npm: { root: '@openai/codex', packages } }]),
        ),
      },
    },
  };
}
