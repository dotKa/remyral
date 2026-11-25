import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import {
  installerKitFileName,
  installerSigningPayload,
  releaseKeyId,
  releaseSigningPayload,
  sha256Hex,
} from '@remyral/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const ORIGIN = 'https://remyral.example.com';
type Os = 'linux' | 'macos' | 'windows';

interface Key {
  publicKey: string;
  privateKey: KeyObject;
}
function key(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: String(publicKey.export({ format: 'jwk' }).x), privateKey };
}
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function signedRelease(k: Key, version: string, channel = 'stable', createdAt = '2026-10-14T10:00:00.000Z') {
  const artifact = Buffer.from(`// remyral-worker ${version}\n`);
  const manifest = Buffer.from(
    `${JSON.stringify({ schema: 1, name: 'remyral-worker', version, channel, protocolVersions: ['1.0'], minNode: '24.0.0', sha256: sha256Hex(artifact), size: artifact.length, createdAt })}\n`,
  );
  const signature = {
    keyId: releaseKeyId(k.publicKey),
    signature: sign(null, releaseSigningPayload(manifest), k.privateKey).toString('base64url'),
  };
  return {
    manifest,
    body: { manifest: manifest.toString('base64'), signature, artifact: artifact.toString('base64') },
  };
}

function installers(
  k: Key,
  version: string,
  manifest: Buffer,
  opts: { oses?: Os[]; salt?: string; manifestSha?: string; swap?: Os } = {},
) {
  const oses = opts.oses ?? ['linux', 'macos', 'windows'];
  const kits = oses.map((os) => ({ os, bytes: Buffer.from(`kit ${version} ${os} ${opts.salt ?? ''}`) }));
  const index = Buffer.from(
    `${JSON.stringify(
      {
        schema: 1,
        name: 'remyral-worker-installers',
        version,
        releaseManifestSha256: opts.manifestSha ?? sha(manifest),
        node: { version: '24.21.0' },
        kits: kits.map((x) => ({
          os: x.os,
          file: installerKitFileName(version, x.os),
          sha256: sha(x.bytes),
          size: x.bytes.length,
        })),
        createdAt: '2026-10-14T10:00:00.000Z',
      },
      null,
      2,
    )}\n`,
  );
  const signature = {
    keyId: releaseKeyId(k.publicKey),
    signature: sign(null, installerSigningPayload(index), k.privateKey).toString('base64url'),
  };
  return {
    kits,
    doc: {
      index: index.toString('base64'),
      signature,
      kits: kits.map((x) => ({
        os: x.os,
        content: (x.os === opts.swap ? Buffer.from('evil') : x.bytes).toString('base64'),
      })),
    },
  };
}

interface Overview {
  publicOrigin: string | null;
  masterUrl: string | null;
  current: null | {
    version: string;
    stable: boolean;
    nodeVersion: string;
    kits: {
      os: Os;
      file: string;
      sha256: string;
      commands: null | { bootstrapUrl: string; bootstrapSha256: string; download: string; run: string };
      kitUrl: string | null;
    }[];
  };
  withoutKits: string[];
}

/**
 * p5-worker-onboarding against the real master (Postgres): signed kits uploaded with a release (and every way
 * they are refused), admin-only Add machine overview + audited bundle download, anonymous bootstrap / kit /
 * index downloads (immutable, bound to the current manifest, rate-limited), stale kits after a re-sign.
 */
describeIntegration('installer kits for Add machine (integration)', () => {
  const k = key();
  const foreign = key();
  let h: Harness;
  let admin: Client;
  let secret: string;
  let operator: Client;
  let viewer: Client;
  const stepUp = async () => {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  };
  const audit = async (action: string) =>
    (
      await h.db.pool.query<{ outcome: string; target: string | null; metadata: Record<string, unknown> }>(
        'SELECT outcome, target, metadata FROM audit_events WHERE action = $1 ORDER BY id',
        [action],
      )
    ).rows;

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      releases: { publicKeys: [k.publicKey] },
      installers: {
        publicOrigin: ORIGIN,
        publicDownloads: true,
        downloadRateLimit: { perIp: 40, windowMs: 60_000 },
      },
    });
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    await h.createUser('op1', PW, 'operator');
    operator = await fullLogin(h, 'op1', PW, (await enroll(h, 'op1', PW)).secret);
    await h.createUser('viewer1', PW, 'viewer');
    viewer = await fullLogin(h, 'viewer1', PW, (await enroll(h, 'viewer1', PW)).secret);
  });
  afterAll(async () => {
    await h.stop();
  });

  it('nothing uploaded: no current kits; only admins see Add machine', async () => {
    const r = await admin.req('GET', '/installers');
    expect(r.statusCode).toBe(200);
    expect(r.json<Overview>()).toMatchObject({
      publicOrigin: ORIGIN,
      masterUrl: 'wss://remyral.example.com/v1/worker',
      current: null,
    });
    for (const c of [operator, viewer]) {
      expect((await c.req('GET', '/installers')).statusCode).toBe(403);
      expect((await c.req('GET', '/installers/1.0.0/linux/kit')).statusCode).toBe(403);
    }
    expect((await h.client().req('GET', '/v1/worker/install/1.0.0/linux/bootstrap.sh')).statusCode).toBe(404);
  });

  it('a release uploaded with signed kits is offered with verified one-line commands', async () => {
    await stepUp();
    const rel = signedRelease(k, '1.0.0');
    const inst = installers(k, '1.0.0', rel.manifest);
    const up = await admin.req('POST', '/releases', { ...rel.body, installers: inst.doc });
    expect(up.statusCode, up.body).toBe(201);
    const ov = (await admin.req('GET', '/installers')).json<Overview>();
    expect(ov.current?.version).toBe('1.0.0');
    expect(ov.current?.nodeVersion).toBe('24.21.0');
    expect(ov.current?.kits.map((x) => x.os)).toEqual(['linux', 'macos', 'windows']);
    expect((await audit('release.installers.upload')).at(-1)).toMatchObject({
      outcome: 'success',
      target: '1.0.0',
    });

    const anon = h.client();
    for (const kit of ov.current?.kits ?? []) {
      const c = kit.commands;
      expect(c).not.toBeNull();
      if (c === null) continue;
      const path = c.bootstrapUrl.replace(ORIGIN, '');
      const script = await anon.req('GET', path);
      expect(script.statusCode, path).toBe(200);
      // The command pins the exact script that is served, and the script pins the kit.
      expect(sha(script.body)).toBe(c.bootstrapSha256);
      expect(c.download.toLowerCase()).toContain(c.bootstrapSha256);
      expect(script.body).toContain(kit.sha256);
      expect(script.body).toContain('wss://remyral.example.com/v1/worker');
      expect(script.body).not.toMatch(/token|password|bearer|cookie/i);
      const bytes = await anon.req('GET', kit.kitUrl?.replace(ORIGIN, '') ?? '');
      expect(bytes.statusCode).toBe(200);
      expect(sha(bytes.rawPayload)).toBe(kit.sha256);
    }
    const linux = ov.current?.kits.find((x) => x.os === 'linux');
    expect(linux?.commands?.download).toMatch(
      /^curl -fsSL --proto '=https' --tlsv1\.2 -o remyral-bootstrap\.sh '.*' && echo '[0-9a-f]{64} {2}remyral-bootstrap\.sh' \| sha256sum -c -$/,
    );
    expect(ov.current?.kits.find((x) => x.os === 'macos')?.commands?.download).toMatch(/shasum -a 256 -c -$/);
    expect(ov.current?.kits.find((x) => x.os === 'windows')?.commands?.download).toMatch(
      /Get-FileHash .* -ne '[0-9A-F]{64}'/,
    );
    // Signed index for offline verification.
    expect(
      Buffer.from((await anon.req('GET', '/v1/worker/install/1.0.0/index.json')).rawPayload).toString(
        'base64',
      ),
    ).toBe(inst.doc.index);
    expect((await anon.req('GET', '/v1/worker/install/1.0.0/index.sig.json')).json()).toEqual(
      inst.doc.signature,
    );
    // Wrong names, OS or bootstrap flavour: 404.
    for (const p of [
      '/v1/worker/install/1.0.0/linux/bootstrap.ps1',
      '/v1/worker/install/1.0.0/linux/remyral-worker-1.0.0-macos.tar.gz',
      '/v1/worker/install/1.0.0/plan9/bootstrap.sh',
      '/v1/worker/install/9.9.9/linux/bootstrap.sh',
      '/v1/worker/install/1.0.0/other.json',
    ]) {
      expect((await anon.req('GET', p)).statusCode, p).toBe(404);
    }
  });

  it('the signed-in bundle download is audited', async () => {
    const r = await admin.req('GET', '/installers/1.0.0/windows/kit');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="remyral-worker-1.0.0-windows.zip"');
    expect(r.rawPayload.toString()).toBe('kit 1.0.0 windows ');
    expect((await audit('installer.download')).at(-1)).toMatchObject({
      outcome: 'success',
      target: '1.0.0/windows',
    });
  });

  it('refuses untrusted, mismatching, incomplete and conflicting kits (audited); identical re-upload is idempotent', async () => {
    await stepUp();
    const rel = signedRelease(k, '1.0.0');
    const again = await admin.req('POST', '/releases', {
      ...rel.body,
      installers: installers(k, '1.0.0', rel.manifest).doc,
    });
    expect(again.statusCode, again.body).toBe(200);
    const cases: [string, unknown, number, string][] = [
      ['foreign key', installers(foreign, '1.0.0', rel.manifest).doc, 422, 'installer_signature_invalid'],
      [
        'swapped kit',
        installers(k, '1.0.0', rel.manifest, { swap: 'macos' }).doc,
        422,
        'installer_kit_mismatch',
      ],
      [
        'other manifest',
        installers(k, '1.0.0', rel.manifest, { manifestSha: 'b'.repeat(64) }).doc,
        409,
        'installers_manifest_mismatch',
      ],
      [
        'other kits for the same manifest',
        installers(k, '1.0.0', rel.manifest, { salt: 'v2' }).doc,
        409,
        'installers_exist',
      ],
      [
        'index for another version',
        installers(k, '1.0.1', rel.manifest).doc,
        422,
        'installer_version_mismatch',
      ],
    ];
    const missingKit = installers(k, '1.0.0', rel.manifest);
    cases.push([
      'a kit left out',
      { ...missingKit.doc, kits: missingKit.doc.kits.slice(0, 2) },
      422,
      'installer_kit_mismatch',
    ]);
    for (const [what, doc, status, code] of cases) {
      const r = await admin.req('POST', '/releases', { ...rel.body, installers: doc });
      expect(r.statusCode, `${what}: ${r.body}`).toBe(status);
      expect(r.json<{ error: string }>().error, what).toBe(code);
    }
    expect(
      (await audit('release.installers.upload')).filter((a) => a.outcome === 'denied').length,
    ).toBeGreaterThanOrEqual(5);
    // Still the original kits.
    const kit = await h
      .client()
      .req('GET', '/v1/worker/install/1.0.0/linux/remyral-worker-1.0.0-linux.tar.gz');
    expect(kit.rawPayload.toString()).toBe('kit 1.0.0 linux ');
  });

  it('stable channel wins; kits of a re-signed release go stale until rebuilt for the new manifest', async () => {
    await stepUp();
    const canary = signedRelease(k, '2.0.0', 'canary');
    expect(
      (
        await admin.req('POST', '/releases', {
          ...canary.body,
          installers: installers(k, '2.0.0', canary.manifest).doc,
        })
      ).statusCode,
    ).toBe(201);
    // No stable channel yet: the newest release with kits.
    expect((await admin.req('GET', '/installers')).json<Overview>().current?.version).toBe('2.0.0');
    expect((await admin.req('PUT', '/releases/channels/stable', { version: '1.0.0' })).statusCode).toBe(200);
    const ov = (await admin.req('GET', '/installers')).json<Overview>();
    expect(ov.current).toMatchObject({ version: '1.0.0', stable: true });
    // Same bytes re-signed for stable: the canary kits (with the canary manifest inside) are not served any more.
    const stable2 = signedRelease(k, '2.0.0', 'stable', '2026-10-14T11:00:00.000Z');
    expect((await admin.req('POST', '/releases', stable2.body)).statusCode).toBe(200);
    expect((await h.client().req('GET', '/v1/worker/install/2.0.0/linux/bootstrap.sh')).statusCode).toBe(404);
    expect((await admin.req('GET', '/installers')).json<Overview>().withoutKits).toContain('2.0.0');
    // Kits rebuilt for the stored manifest replace the stale ones.
    const re = await admin.req('POST', '/releases', {
      ...stable2.body,
      installers: installers(k, '2.0.0', stable2.manifest, { salt: 'stable' }).doc,
    });
    expect(re.statusCode, re.body).toBe(200);
    expect((await h.client().req('GET', '/v1/worker/install/2.0.0/linux/bootstrap.sh')).statusCode).toBe(200);
  });

  it('anonymous downloads are rate-limited per IP', async () => {
    const c = h.client();
    let limited = 0;
    for (let i = 0; i < 45; i++) {
      if ((await c.req('GET', '/v1/worker/install/1.0.0/index.json')).statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describeIntegration(
  'installer kits without a public origin / with public downloads off (integration)',
  () => {
    const k = key();
    const harness = async (installersCfg: { publicOrigin: string | null; publicDownloads: boolean }) => {
      const h = new Harness();
      await h.start({ releases: { publicKeys: [k.publicKey] }, installers: installersCfg });
      await h.createUser('owner1', PW);
      const { secret } = await enroll(h, 'owner1', PW);
      const admin = await fullLogin(h, 'owner1', PW, secret);
      h.clock.advance(30_000);
      await admin.req('POST', '/auth/step-up', { code: h.code(secret) });
      const rel = signedRelease(k, '1.0.0');
      expect(
        (
          await admin.req('POST', '/releases', {
            ...rel.body,
            installers: installers(k, '1.0.0', rel.manifest).doc,
          })
        ).statusCode,
      ).toBe(201);
      return { h, admin };
    };

    it('no PUBLIC_ORIGIN: no commands, bootstrap 503, the bundle download still works', async () => {
      const { h, admin } = await harness({ publicOrigin: null, publicDownloads: true });
      try {
        const ov = (await admin.req('GET', '/installers')).json<Overview>();
        expect(ov.masterUrl).toBeNull();
        expect(ov.current?.kits.every((x) => x.commands === null && x.kitUrl === null)).toBe(true);
        expect((await h.client().req('GET', '/v1/worker/install/1.0.0/linux/bootstrap.sh')).statusCode).toBe(
          503,
        );
        expect((await admin.req('GET', '/installers/1.0.0/linux/kit')).statusCode).toBe(200);
      } finally {
        await h.stop();
      }
    });

    it('INSTALLER_PUBLIC_DOWNLOADS=false: nothing anonymous, the console offers only the signed-in download', async () => {
      const { h, admin } = await harness({ publicOrigin: ORIGIN, publicDownloads: false });
      try {
        for (const p of [
          '/v1/worker/install/1.0.0/linux/bootstrap.sh',
          '/v1/worker/install/1.0.0/linux/remyral-worker-1.0.0-linux.tar.gz',
          '/v1/worker/install/1.0.0/index.json',
        ]) {
          expect((await h.client().req('GET', p)).statusCode, p).toBe(404);
        }
        const ov = (await admin.req('GET', '/installers')).json<Overview>();
        expect(ov.current?.kits.every((x) => x.commands === null)).toBe(true);
        expect((await admin.req('GET', '/installers/1.0.0/macos/kit')).statusCode).toBe(200);
      } finally {
        await h.stop();
      }
    });
  },
);

describe('bootstrap scripts (unit)', () => {
  it('are deterministic and contain only the origin, version, kit name and kit hash', async () => {
    const { bootstrapScript, installCommands } = await import('../../src/installers/bootstrap.js');
    const input = {
      origin: ORIGIN,
      version: '1.2.0',
      os: 'linux' as const,
      kitFile: 'remyral-worker-1.2.0-linux.tar.gz',
      kitSha256: 'c'.repeat(64),
    };
    expect(bootstrapScript(input)).toBe(bootstrapScript(input));
    expect(installCommands(input).bootstrapSha256).toBe(sha(bootstrapScript(input)));
    expect(() => bootstrapScript({ ...input, origin: "https://x.example'; rm -rf /" })).toThrow(/unsafe/);
  });

  it('are pure ASCII (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI and mis-parses typographic quotes)', async () => {
    const { bootstrapScript } = await import('../../src/installers/bootstrap.js');
    for (const os of ['linux', 'macos', 'windows'] as const) {
      const script = bootstrapScript({
        origin: ORIGIN,
        version: '1.2.0',
        os,
        kitFile: `remyral-worker-1.2.0-${os}.${os === 'windows' ? 'zip' : 'tar.gz'}`,
        kitSha256: 'c'.repeat(64),
      });
      expect(script).toMatch(/^[\t\n\r\x20-\x7e]*$/);
    }
  });
});
