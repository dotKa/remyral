import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { lockBytes, McpStdio } from '../../src/mcp/stdio.js';

/**
 * p14-mcp-stdio: the master's registry lookup (JSON metadata only, fixed hosts, no redirects, wheels only for PyPI)
 * and the lockfile check of a canary's report. The master never downloads or runs a package.
 */
function service(answers: Record<string, Response | Error>, seen: { url: string; init: RequestInit }[] = []) {
  return new McpStdio({
    pool: {} as never,
    audit: {} as never,
    clock: () => new Date('2026-10-21T10:00:00Z'),
    fetch: (url, init) => {
      seen.push({ url, init });
      const a = answers[url];
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve(a ?? new Response('nope', { status: 404 }));
    },
  });
}

describe('package lookup (registry metadata for the add form)', () => {
  it('npm: exact version, the dist sha512 and the bin names; only registry.npmjs.org, no redirects', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const url = 'https://registry.npmjs.org/@acme%2fmcp-files/1.2.3';
    const s = service(
      {
        [url]: Response.json({
          name: '@acme/mcp-files',
          version: '1.2.3',
          dist: { integrity: `sha512-${'A'.repeat(86)}==` },
          bin: { 'mcp-files': 'dist/index.js', 'bad name': 'x' },
          license: 'MIT',
        }),
      },
      seen,
    );
    const info = await s.lookup('u1', { manager: 'npm', name: '@acme/mcp-files', version: '1.2.3' });
    expect(info).toMatchObject({
      integrity: `sha512-${'A'.repeat(86)}==`,
      bins: ['mcp-files'],
      license: 'MIT',
    });
    expect(seen[0]?.url).toBe(url);
    expect(seen[0]?.init.redirect).toBe('error');
  });

  it('PyPI: the sha256 of a wheel (pure-Python preferred), never an sdist', async () => {
    const s = service({
      'https://pypi.org/pypi/mcp-server-time/2026.10.10/json': Response.json({
        info: { version: '2026.10.10', license_expression: 'MIT', summary: 'Time' },
        urls: [
          {
            filename: 'mcp_server_time-2026.10.10.tar.gz',
            packagetype: 'sdist',
            digests: { sha256: 'a'.repeat(64) },
          },
          {
            filename: 'mcp_server_time-2026.10.10-py3-none-any.whl',
            packagetype: 'bdist_wheel',
            digests: { sha256: 'b'.repeat(64) },
          },
        ],
      }),
      'https://pypi.org/pypi/sdist-only/1.0.0/json': Response.json({
        info: { version: '1.0.0' },
        urls: [
          { filename: 'sdist-only-1.0.0.tar.gz', packagetype: 'sdist', digests: { sha256: 'c'.repeat(64) } },
        ],
      }),
    });
    expect(
      await s.lookup('u1', { manager: 'pypi', name: 'mcp-server-time', version: '2026.10.10' }),
    ).toMatchObject({
      integrity: `sha256:${'b'.repeat(64)}`,
      file: 'mcp_server_time-2026.10.10-py3-none-any.whl',
      bins: [],
    });
    await expect(
      s.lookup('u1', { manager: 'pypi', name: 'sdist-only', version: '1.0.0' }),
    ).rejects.toMatchObject({
      code: 'mcp_package_invalid',
    });
  });

  it('refuses ranges and unknown versions; a registry failure is a 502', async () => {
    const s = service({ 'https://registry.npmjs.org/x/1.0.0': new Error('down') });
    await expect(s.lookup('u1', { manager: 'npm', name: 'x', version: '^1.0.0' })).rejects.toMatchObject({
      code: 'mcp_package_invalid',
    });
    await expect(s.lookup('u1', { manager: 'npm', name: 'y', version: '1.0.0' })).rejects.toMatchObject({
      code: 'mcp_package_not_found',
    });
    await expect(s.lookup('u1', { manager: 'npm', name: 'x', version: '1.0.0' })).rejects.toMatchObject({
      code: 'mcp_registry_unavailable',
    });
  });
});

describe('canary lockfile check', () => {
  it('accepts exactly the bytes its sha256 names', () => {
    const raw = Buffer.from('{"lockfileVersion":3}\n');
    const lock = {
      manager: 'npm' as const,
      sha256: createHash('sha256').update(raw).digest('hex'),
      bytes: raw.byteLength,
      gz: gzipSync(raw).toString('base64'),
    };
    expect(lockBytes(lock, 'npm')?.equals(raw)).toBe(true);
    expect(lockBytes(lock, 'pypi')).toBeNull();
    expect(lockBytes({ ...lock, sha256: 'f'.repeat(64) }, 'npm')).toBeNull();
    expect(lockBytes({ ...lock, bytes: 3 }, 'npm')).toBeNull();
  });
});
