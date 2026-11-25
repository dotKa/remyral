import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeFileOps } from '../src/fs/ops.js';
import { parseCloudflaredVersion } from '../src/tools/detect.js';
import { ToolInstaller } from '../src/tools/installer.js';
import {
  CLOUDFLARED_VERSION,
  defaultRecipe,
  findRecipe,
  recipePlatform,
  type UnprivilegedRecipe,
} from '../src/tools/recipes.js';
import { tgz } from './remote-ops-fixtures.js';

/** p8-preview-tunnels: the cloudflared recipe (pins, raw / tgz formats) — never downloads from the network. */

const logger = createLogger({ sink: () => undefined });
const platform = recipePlatform(process.platform, process.arch);
const describePosix = process.platform === 'win32' ? describe.skip : describe;

let server: Server;
let base = '';
const served = new Map<string, Buffer>();
beforeAll(async () => {
  server = createServer((req, res) => {
    const body = served.get(req.url ?? '');
    res.statusCode = body === undefined ? 404 : 200;
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
});

describe('cloudflared recipe pins', () => {
  it('is pinned for every desktop platform from the 2026.10.3 release, raw binaries and macOS tgz', () => {
    const r = findRecipe('cloudflared', CLOUDFLARED_VERSION) as UnprivilegedRecipe;
    expect(r).not.toBeNull();
    expect(r.elevated).toBe(false);
    expect(Object.keys(r.platforms).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]);
    for (const [p, step] of Object.entries(r.platforms)) {
      expect(step.url).toMatch(
        /^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\/2026\.10\.3\/cloudflared-/,
      );
      expect(step.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(step.format).toBe(p.startsWith('darwin') ? 'tgz' : 'raw');
      expect(step.entry).toBe(p === 'win32-x64' ? 'bin/cloudflared.exe' : 'bin/cloudflared');
    }
    expect(r.platforms['linux-x64']?.sha256).toBe(
      '053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0',
    );
    expect(defaultRecipe('cloudflared', 'linux-arm64')?.version).toBe(CLOUDFLARED_VERSION);
  });

  it('parses `cloudflared --version`', () => {
    expect(parseCloudflaredVersion('cloudflared version 2026.10.0 (built 2026-10-05-1743 UTC)')).toBe(
      '2026.10.0',
    );
    expect(parseCloudflaredVersion('something else')).toBeNull();
  });
});

describePosix('raw and tgz installs (local fixture server)', () => {
  async function install(format: 'raw' | 'tgz', body: Buffer, entry: string) {
    if (platform === null) throw new Error('unsupported platform');
    const path = `/cfd-${format}`;
    served.set(path, body);
    const recipe: UnprivilegedRecipe = {
      tool: 'cloudflared',
      version: CLOUDFLARED_VERSION,
      elevated: false,
      reportAs: 'cloudflared',
      title: 'test',
      platforms: {
        [platform]: {
          url: `${base}${path}`,
          sha256: createHash('sha256').update(body).digest('hex'),
          size: body.length,
          format,
          into: 'bin',
          entry,
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'rw-cfd-'));
    const t = await ToolInstaller.open({
      ops: createNodeFileOps(),
      dataDir: dir,
      platform,
      logger,
      recipes: [recipe],
      reserveBytes: 0,
    });
    const m = await t.install('cloudflared', CLOUDFLARED_VERSION);
    return { dir, m, t };
  }

  it('raw: the verified download becomes the executable (mode 0755)', async () => {
    const { dir, m, t } = await install(
      'raw',
      Buffer.from('#!/bin/sh\necho cloudflared\n'),
      'bin/cloudflared',
    );
    try {
      expect(m.entry).toBe(join(dir, 'tools', 'cloudflared', CLOUDFLARED_VERSION, 'bin', 'cloudflared'));
      expect((await stat(m.entry)).mode & 0o777).toBe(0o755);
      expect(await readFile(m.entry, 'utf8')).toContain('echo cloudflared');
      expect((await t.installed()).map((i) => i.reportAs)).toEqual(['cloudflared']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tgz: extracted with its own layout (no first component stripped)', async () => {
    const body = tgz([{ path: 'cloudflared', data: '#!/bin/sh\necho hi\n', mode: 0o755 }]);
    const { dir, m } = await install('tgz', body, 'bin/cloudflared');
    try {
      expect(await readFile(m.entry, 'utf8')).toContain('echo hi');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a checksum mismatch installs nothing', async () => {
    if (platform === null) throw new Error('unsupported platform');
    served.set('/bad', Buffer.from('tampered'));
    const dir = await mkdtemp(join(tmpdir(), 'rw-cfd-'));
    try {
      const t = await ToolInstaller.open({
        ops: createNodeFileOps(),
        dataDir: dir,
        platform,
        logger,
        reserveBytes: 0,
        recipes: [
          {
            tool: 'cloudflared',
            version: CLOUDFLARED_VERSION,
            elevated: false,
            reportAs: 'cloudflared',
            title: 'x',
            platforms: {
              [platform]: {
                url: `${base}/bad`,
                sha256: '0'.repeat(64),
                size: 8,
                format: 'raw',
                into: 'bin',
                entry: 'bin/cloudflared',
              },
            },
          },
        ],
      });
      await expect(t.install('cloudflared', CLOUDFLARED_VERSION)).rejects.toThrow();
      expect(await t.installed()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
