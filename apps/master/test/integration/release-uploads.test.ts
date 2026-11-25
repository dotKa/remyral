import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import {
  installerKitFileName,
  installerSigningPayload,
  releaseKeyId,
  releaseSigningPayload,
  sha256Hex,
} from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { UPLOAD_PART_MIN_BYTES, UPLOAD_TTL_MS, UPLOADS_PER_USER } from '../../src/releases/uploads.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const MiB = 1024 * 1024;

interface Key {
  publicKey: string;
  privateKey: KeyObject;
}
function key(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: String(publicKey.export({ format: 'jwk' }).x), privateKey };
}
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** A signed release.json document (as written by scripts/release/sign.mjs), optionally with installer kits. */
function releaseDoc(k: Key, version: string, artifact: Buffer, withKits = false): Buffer {
  const manifest = Buffer.from(
    `${JSON.stringify({ schema: 1, name: 'remyral-worker', version, channel: 'stable', protocolVersions: ['1.0'], minNode: '24.0.0', sha256: sha256Hex(artifact), size: artifact.length, createdAt: '2026-10-15T10:00:00.000Z' })}\n`,
  );
  const signature = {
    keyId: releaseKeyId(k.publicKey),
    signature: sign(null, releaseSigningPayload(manifest), k.privateKey).toString('base64url'),
  };
  const doc: Record<string, unknown> = {
    manifest: manifest.toString('base64'),
    signature,
    artifact: artifact.toString('base64'),
  };
  if (withKits) {
    const kits = (['linux', 'macos', 'windows'] as const).map((os) => ({
      os,
      bytes: Buffer.from(`kit ${version} ${os}`),
    }));
    const index = Buffer.from(
      `${JSON.stringify({
        schema: 1,
        name: 'remyral-worker-installers',
        version,
        releaseManifestSha256: sha(manifest),
        node: { version: '24.21.0' },
        kits: kits.map((x) => ({
          os: x.os,
          file: installerKitFileName(version, x.os),
          sha256: sha(x.bytes),
          size: x.bytes.length,
        })),
        createdAt: '2026-10-15T10:00:00.000Z',
      })}\n`,
    );
    doc.installers = {
      index: index.toString('base64'),
      signature: {
        keyId: releaseKeyId(k.publicKey),
        signature: sign(null, installerSigningPayload(index), k.privateKey).toString('base64url'),
      },
      kits: kits.map((x) => ({ os: x.os, content: x.bytes.toString('base64') })),
    };
  }
  return Buffer.from(JSON.stringify(doc));
}

interface Started {
  id: string;
  partSize: number;
  partCount: number;
  received: number[];
}

/**
 * p6-release-upload against the real master (Postgres): resumable chunked upload of release.json — start
 * (step-up, per-user cap), raw parts with their SHA-256 (idempotent retry), status for resume, complete
 * (whole-document SHA-256, then exactly the POST /releases verification path), abort, expiry and sweep,
 * ownership and authorization.
 */
describeIntegration('chunked release upload (integration)', () => {
  const k = key();
  let h: Harness;
  let admin: Client;
  let secret: string;
  let admin2: Client;
  let secret2: string;
  let operator: Client;
  const stepUp = async (c: Client = admin, s: string = secret) => {
    h.clock.advance(30_000);
    expect((await c.req('POST', '/auth/step-up', { code: h.code(s) })).statusCode).toBe(200);
  };
  const start = async (doc: Buffer, partSize = UPLOAD_PART_MIN_BYTES, c: Client = admin) =>
    c.req('POST', '/releases/uploads', { totalBytes: doc.length, sha256: sha(doc), partSize });
  const putPart = (c: Client, id: string, n: number, bytes: Buffer, hash = sha(bytes)) =>
    c.req('PUT', `/releases/uploads/${id}/parts/${String(n)}`, bytes, {
      'content-type': 'application/octet-stream',
      'x-part-sha256': hash,
    });
  const parts = (doc: Buffer, size: number) => {
    const out: Buffer[] = [];
    for (let o = 0; o < doc.length; o += size) out.push(doc.subarray(o, o + size));
    return out;
  };
  const uploadAll = async (doc: Buffer, partSize = UPLOAD_PART_MIN_BYTES, c: Client = admin) => {
    const s = await start(doc, partSize, c);
    expect(s.statusCode, s.body).toBe(201);
    const up = s.json<Started>();
    for (const [n, p] of parts(doc, partSize).entries()) {
      const r = await putPart(c, up.id, n, p);
      expect(r.statusCode, r.body).toBe(200);
    }
    return up;
  };
  const audit = async () =>
    (
      await h.db.pool.query<{ outcome: string; target: string | null; metadata: Record<string, unknown> }>(
        `SELECT outcome, target, metadata FROM audit_events WHERE action = 'release.upload' ORDER BY id`,
      )
    ).rows;
  const openUploads = async () =>
    Number(
      (await h.db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM worker_release_uploads')).rows[0]
        ?.n,
    );

  beforeAll(async () => {
    h = new Harness();
    await h.start({ releases: { publicKeys: [k.publicKey] } });
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    await h.createUser('owner2', PW);
    ({ secret: secret2 } = await enroll(h, 'owner2', PW));
    await h.createUser('op1', PW, 'operator');
    operator = await fullLogin(h, 'op1', PW, (await enroll(h, 'op1', PW)).secret);
  });
  afterAll(async () => {
    await h.stop();
  });

  it('start needs admin + step-up; operators and anonymous callers are refused', async () => {
    const doc = releaseDoc(k, '0.9.0', Buffer.from('x'));
    h.clock.advance(20 * 60_000);
    const stale = await start(doc);
    expect(stale.statusCode).toBe(403);
    expect(stale.json<{ error: string }>().error).toBe('step_up_required');
    expect((await start(doc, UPLOAD_PART_MIN_BYTES, operator)).statusCode).toBe(403);
    expect((await h.client().req('POST', '/releases/uploads', { totalBytes: 1 })).statusCode).toBe(401);
    // CSRF like every state change.
    await stepUp();
    const noCsrf = admin.clone();
    noCsrf.sendCsrf = false;
    expect((await start(doc, UPLOAD_PART_MIN_BYTES, noCsrf)).statusCode).toBe(403);
    expect(await openUploads()).toBe(0);
  });

  it('happy path: 4 MiB parts of a ~12 MB release.json with kits → verified, stored, kits attached, upload gone', async () => {
    await stepUp();
    const doc = releaseDoc(k, '1.0.0', randomBytes(9 * MiB), true);
    expect(doc.length).toBeGreaterThan(12 * MiB);
    const up = await uploadAll(doc, 4 * MiB);
    expect(up.partCount).toBe(Math.ceil(doc.length / (4 * MiB)));
    const st = await admin.req('GET', `/releases/uploads/${up.id}`);
    expect(st.json<Started>().received).toEqual([...Array(up.partCount).keys()]);
    const done = await admin.req('POST', `/releases/uploads/${up.id}/complete`);
    expect(done.statusCode, done.body).toBe(201);
    expect(done.json()).toMatchObject({
      version: '1.0.0',
      channel: 'stable',
      keyId: releaseKeyId(k.publicKey),
    });
    expect(
      (await admin.req('GET', '/installers')).json<{ current: { version: string } | null }>().current
        ?.version,
    ).toBe('1.0.0');
    expect((await audit()).at(-1)).toMatchObject({ outcome: 'success', target: '1.0.0' });
    expect(await openUploads()).toBe(0);
    expect((await admin.req('GET', `/releases/uploads/${up.id}`)).statusCode).toBe(404);
    // The same document again through the old single request: idempotent (200), same path.
    const again = await admin.req('POST', '/releases', JSON.parse(doc.toString()) as Record<string, unknown>);
    expect(again.statusCode, again.body).toBe(200);
  });

  it('a part with a wrong hash, size or index is refused; a retry overwrites; missing parts block complete (resumable)', async () => {
    await stepUp();
    const doc = releaseDoc(k, '1.1.0', randomBytes(200 * 1024));
    const s = await start(doc);
    expect(s.statusCode, s.body).toBe(201);
    const up = s.json<Started>();
    const ps = parts(doc, up.partSize);
    expect(ps.length).toBeGreaterThan(3);
    const p0 = ps[0] ?? Buffer.alloc(0);
    const bad = await putPart(admin, up.id, 0, p0, sha('something else'));
    expect(bad.statusCode).toBe(422);
    expect(bad.json<{ error: string }>().error).toBe('part_checksum_mismatch');
    const short = await putPart(admin, up.id, 0, p0.subarray(1));
    expect(short.json<{ error: string }>().error).toBe('part_size_mismatch');
    expect((await putPart(admin, up.id, ps.length, p0)).json<{ error: string }>().error).toBe(
      'part_out_of_range',
    );
    const json = await admin.req('PUT', `/releases/uploads/${up.id}/parts/0`, { a: 1 });
    expect(json.statusCode).toBe(400);
    for (const [n, p] of ps.entries()) {
      if (n === 2) continue; // missing
      expect((await putPart(admin, up.id, n, p)).statusCode).toBe(200);
    }
    const incomplete = await admin.req('POST', `/releases/uploads/${up.id}/complete`);
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json<{ error: string; message: string }>()).toMatchObject({
      error: 'upload_incomplete',
      message: expect.stringContaining('2') as unknown,
    });
    expect((await admin.req('GET', `/releases/uploads/${up.id}`)).json<Started>().received).not.toContain(2);
    expect((await putPart(admin, up.id, 2, ps[2] ?? Buffer.alloc(0))).statusCode).toBe(200);
    expect((await putPart(admin, up.id, 1, ps[1] ?? Buffer.alloc(0))).statusCode).toBe(200); // idempotent
    const done = await admin.req('POST', `/releases/uploads/${up.id}/complete`);
    expect(done.statusCode, done.body).toBe(201);
  });

  it('a wrong whole-document hash is refused at complete (audited) and the upload is dropped', async () => {
    await stepUp();
    const doc = releaseDoc(k, '1.2.0', randomBytes(100 * 1024));
    const s = await admin.req('POST', '/releases/uploads', {
      totalBytes: doc.length,
      sha256: sha('not the document'),
      partSize: UPLOAD_PART_MIN_BYTES,
    });
    const up = s.json<Started>();
    for (const [n, p] of parts(doc, up.partSize).entries()) {
      expect((await putPart(admin, up.id, n, p)).statusCode).toBe(200);
    }
    const r = await admin.req('POST', `/releases/uploads/${up.id}/complete`);
    expect(r.statusCode).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('checksum_mismatch');
    expect((await audit()).at(-1)).toMatchObject({
      outcome: 'denied',
      metadata: { reason: 'checksum_mismatch' },
    });
    expect((await admin.req('GET', `/releases/uploads/${up.id}`)).statusCode).toBe(404);
    const list = (await admin.req('GET', '/releases')).json<{ releases: { version: string }[] }>();
    expect(list.releases.map((x) => x.version)).not.toContain('1.2.0');
  });

  it('the assembled document goes through signature verification: tampered or untrusted is refused like POST /releases', async () => {
    await stepUp();
    const good = releaseDoc(k, '1.3.0', randomBytes(100 * 1024));
    const parsed = JSON.parse(good.toString()) as { manifest: string };
    const tampered = Buffer.from(
      JSON.stringify({
        ...parsed,
        manifest: Buffer.from(
          Buffer.from(parsed.manifest, 'base64').toString().replace('1.3.0', '1.3.1'),
        ).toString('base64'),
      }),
    );
    const cases: [string, Buffer, string][] = [
      ['tampered manifest', tampered, 'signature_invalid'],
      ['untrusted key', releaseDoc(key(), '1.3.0', randomBytes(100 * 1024)), 'signature_invalid'],
      [
        'not a release document',
        Buffer.from(JSON.stringify({ hello: 'x'.repeat(70_000) })),
        'document_invalid',
      ],
      ['not JSON', randomBytes(70_000), 'document_invalid'],
    ];
    for (const [name, doc, error] of cases) {
      await stepUp();
      const up = await uploadAll(doc);
      const r = await admin.req('POST', `/releases/uploads/${up.id}/complete`);
      expect(r.statusCode, name).toBe(422);
      expect(r.json<{ error: string }>().error, name).toBe(error);
      expect((await audit()).at(-1)?.outcome, name).toBe('denied');
    }
    expect(await openUploads()).toBe(0);
    const list = (await admin.req('GET', '/releases')).json<{ releases: { version: string }[] }>();
    expect(list.releases.map((x) => x.version)).not.toContain('1.3.1');
  });

  it('complete needs a fresh step-up; parts do not', async () => {
    await stepUp();
    const doc = releaseDoc(k, '1.4.0', randomBytes(80 * 1024));
    const up = (await start(doc)).json<Started>();
    h.clock.advance(20 * 60_000); // step-up window over, upload still alive (sliding expiry)
    for (const [n, p] of parts(doc, up.partSize).entries()) {
      expect((await putPart(admin, up.id, n, p)).statusCode).toBe(200);
    }
    const r = await admin.req('POST', `/releases/uploads/${up.id}/complete`);
    expect(r.statusCode).toBe(403);
    expect(r.json<{ error: string }>().error).toBe('step_up_required');
    await stepUp();
    expect((await admin.req('POST', `/releases/uploads/${up.id}/complete`)).statusCode).toBe(201);
  });

  it('uploads belong to their user; per-user cap; abort frees a slot; operators cannot touch parts', async () => {
    await stepUp();
    const doc = releaseDoc(k, '1.5.0', randomBytes(80 * 1024));
    const ids: string[] = [];
    for (let i = 0; i < UPLOADS_PER_USER; i++) {
      const s = await start(doc);
      expect(s.statusCode).toBe(201);
      ids.push(s.json<Started>().id);
    }
    const over = await start(doc);
    expect(over.statusCode).toBe(409);
    expect(over.json<{ error: string }>().error).toBe('too_many_uploads');
    const id = ids[0] ?? '';
    const p0 = parts(doc, UPLOAD_PART_MIN_BYTES)[0] ?? Buffer.alloc(0);
    // Another admin sees nothing of it (fresh login: the clock moved past the idle timeout).
    admin2 = await fullLogin(h, 'owner2', PW, secret2);
    expect((await admin2.req('GET', `/releases/uploads/${id}`)).statusCode).toBe(404);
    expect((await putPart(admin2, id, 0, p0)).statusCode).toBe(404);
    expect((await admin2.req('DELETE', `/releases/uploads/${id}`)).statusCode).toBe(404);
    expect((await putPart(operator, id, 0, p0)).statusCode).toBe(403);
    expect((await operator.req('DELETE', `/releases/uploads/${id}`)).statusCode).toBe(403);
    expect((await admin.req('DELETE', `/releases/uploads/${id}`)).statusCode).toBe(204);
    expect((await admin.req('GET', `/releases/uploads/${id}`)).statusCode).toBe(404);
    expect((await start(doc)).statusCode).toBe(201);
    for (const x of (await h.db.pool.query<{ id: string }>('SELECT id FROM worker_release_uploads')).rows) {
      expect((await admin.req('DELETE', `/releases/uploads/${x.id}`)).statusCode).toBe(204);
    }
  });

  it('an abandoned upload expires (410), is swept, and no longer counts against the cap', async () => {
    await stepUp();
    const doc = releaseDoc(k, '1.6.0', randomBytes(80 * 1024));
    const a = (await start(doc)).json<Started>();
    const b = (await start(doc)).json<Started>();
    expect((await putPart(admin, a.id, 0, parts(doc, a.partSize)[0] ?? Buffer.alloc(0))).statusCode).toBe(
      200,
    );
    h.clock.advance(UPLOAD_TTL_MS + 1_000);
    admin = await fullLogin(h, 'owner1', PW, secret); // the session idled out too
    const gone = await putPart(admin, a.id, 1, parts(doc, a.partSize)[1] ?? Buffer.alloc(0));
    expect(gone.statusCode).toBe(410);
    expect(gone.json<{ error: string }>().error).toBe('upload_expired');
    expect((await admin.req('POST', `/releases/uploads/${a.id}/complete`)).statusCode).toBe(404);
    // b is expired too: starting sweeps it, so the cap is free again.
    await stepUp();
    expect((await start(doc)).statusCode).toBe(201);
    const left = (await h.db.pool.query<{ id: string }>('SELECT id FROM worker_release_uploads')).rows;
    expect(left.map((x) => x.id)).not.toContain(b.id);
    const parts0 = await h.db.pool.query('SELECT 1 FROM worker_release_upload_parts WHERE upload_id = $1', [
      a.id,
    ]);
    expect(parts0.rowCount).toBe(0);
  });

  it('refuses a document over the cap and a part size outside 64 KiB–4 MiB at start', async () => {
    await stepUp();
    const big = await admin.req('POST', '/releases/uploads', {
      totalBytes: 48 * MiB + 1,
      sha256: sha('x'),
      partSize: 4 * MiB,
    });
    expect(big.statusCode).toBe(413);
    for (const partSize of [1024, 4 * MiB + 1]) {
      expect(
        (await admin.req('POST', '/releases/uploads', { totalBytes: 10, sha256: sha('x'), partSize }))
          .statusCode,
      ).toBe(400);
    }
  });
});
