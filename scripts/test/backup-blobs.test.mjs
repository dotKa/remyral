// p17-object-storage: the backup runner's mirror of the master's local blob directory — new blobs encrypted (age) into
// the backup and uploaded off-site, unchanged ones skipped, deleted ones kept for keepDeletedDays then removed.
import { Buffer } from 'node:buffer';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listBlobFiles, mirrorBlobs } from '../../infra/backup/runner/lib/blobs.mjs';
import { loadConfig, parseKeepDays } from '../../infra/backup/runner/lib/config.mjs';
import { parseOffsiteConfig } from '../../infra/backup/runner/lib/s3.mjs';

/** A stand-in for `age -r … -o out in`: copies the input with a marker (the runner never sees plaintext keys). */
const fakeTools = {
  calls: [],
  async run(cmd, args) {
    this.calls.push([cmd, ...args]);
    const out = args[args.indexOf('-o') + 1];
    const input = args.at(-1);
    copyFileSync(input, out);
    writeFileSync(out, Buffer.concat([Buffer.from('AGE:'), readFileSync(out)]));
    return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
  },
};

describe('backup: blob directory mirror (p17-object-storage)', () => {
  let dir;
  let src;
  let server;
  let off;
  const puts = [];
  const stored = new Map();
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'remyral-bk-blobs-'));
    src = join(dir, 'src');
    mkdirSync(join(src, 'artifacts', 'job1', 'att1'), { recursive: true });
    mkdirSync(join(src, '.uploads', 'x'), { recursive: true });
    writeFileSync(join(src, 'artifacts', 'job1', 'att1', 'ws-o0-a'), 'zip bytes');
    writeFileSync(join(src, '.uploads', 'x', '1'), 'part in flight');
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (req.method === 'HEAD') {
          // The runner verifies every upload with a HEAD (size + x-amz-meta-sha256).
          const o = stored.get(req.url);
          res.statusCode = o === undefined ? 404 : 200;
          if (o !== undefined) {
            res.setHeader('content-length', String(o.body.length));
            res.setHeader('x-amz-meta-sha256', o.sha256);
          }
          res.end();
          return;
        }
        puts.push({ method: req.method, url: req.url, body });
        stored.set(req.url, { body, sha256: String(req.headers['x-amz-meta-sha256']) });
        res.statusCode = 200;
        res.setHeader('etag', '"e"');
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    off = parseOffsiteConfig({
      BACKUP_S3_BUCKET: 'remyral-backups',
      BACKUP_S3_ACCESS_KEY_ID: 'AKID',
      BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
      BACKUP_S3_ENDPOINT: `http://127.0.0.1:${String(server.address().port)}`,
    });
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it('config: the blob directory and the days a deleted blob stays', () => {
    const c = loadConfig({ BACKUP_ENV: 'prod' });
    expect(c.blobDir).toBe('/blobs');
    expect(c.blobKeepDeletedDays).toBe(35);
    expect(parseKeepDays('400')).toBe(400);
    expect(() => parseKeepDays('0')).toThrow();
  });

  it('lists blobs without in-flight uploads or temp files', () => {
    expect(listBlobFiles(src).map((f) => f.rel)).toEqual(['artifacts/job1/att1/ws-o0-a']);
  });

  it('copies new blobs encrypted, uploads them off-site, skips them next time, ages out deleted ones', async () => {
    const cfg = { root: join(dir, 'backups'), env: 'prod', blobDir: src, blobKeepDeletedDays: 2 };
    const t0 = new Date('2026-10-24T00:00:00Z');
    const first = await mirrorBlobs(cfg, {
      tools: fakeTools,
      recipients: ['age1example'],
      off,
      clock: () => t0,
    });
    expect(first, JSON.stringify(first.errors)).toMatchObject({
      status: 'ok',
      files: 1,
      copied: 1,
      failed: 0,
      offsite: true,
    });
    const copy = join(cfg.root, 'blobs', 'data', 'artifacts', 'job1', 'att1', 'ws-o0-a.age');
    expect(readFileSync(copy, 'utf8')).toBe('AGE:zip bytes');
    expect(fakeTools.calls[0]).toEqual([
      'age',
      '-r',
      'age1example',
      '-o',
      `${copy}.partial`,
      join(src, 'artifacts/job1/att1/ws-o0-a'),
    ]);
    expect(puts.map((p) => p.url)).toEqual([
      '/remyral-backups/remana/blobs/prod/artifacts/job1/att1/ws-o0-a.age',
    ]);
    expect(puts[0].body.toString()).toBe('AGE:zip bytes');

    const again = await mirrorBlobs(cfg, {
      tools: fakeTools,
      recipients: ['age1example'],
      off,
      clock: () => t0,
    });
    expect(again).toMatchObject({ copied: 0 });
    expect(puts).toHaveLength(1);

    // The master's GC deleted the blob: kept 2 days, then removed from the mirror.
    rmSync(join(src, 'artifacts', 'job1', 'att1', 'ws-o0-a'));
    const later = new Date(t0.getTime() + 86_400_000);
    expect(
      (
        await mirrorBlobs(cfg, {
          tools: fakeTools,
          recipients: ['age1example'],
          off: null,
          clock: () => later,
        })
      ).removed,
    ).toBe(0);
    expect(existsSync(copy)).toBe(true);
    const gone = new Date(t0.getTime() + 4 * 86_400_000);
    expect(
      (
        await mirrorBlobs(cfg, {
          tools: fakeTools,
          recipients: ['age1example'],
          off: null,
          clock: () => gone,
        })
      ).removed,
    ).toBe(1);
    expect(existsSync(copy)).toBe(false);
  });

  it('refuses to copy without the owner key; no blob directory is "not configured"', async () => {
    const cfg = { root: join(dir, 'b2'), env: 'prod', blobDir: src, blobKeepDeletedDays: 35 };
    expect(await mirrorBlobs(cfg, { tools: fakeTools, recipients: [], off: null })).toMatchObject({
      status: 'failed',
    });
    expect(
      await mirrorBlobs(
        { ...cfg, blobDir: join(dir, 'nope') },
        { tools: fakeTools, recipients: ['a'], off: null },
      ),
    ).toMatchObject({ status: 'not_configured' });
  });
});
