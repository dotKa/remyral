import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import {
  installerKitFileName,
  installerSigningPayload,
  releaseKeyId,
  releaseSigningPayload,
  sha256Hex,
} from '@remyral/protocol';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { AdminError } from '../../src/cli/admin.js';
import { createReleaseServices, type ReleaseServicesConfig } from '../../src/releases/factory.js';
import { importRelease } from '../../src/releases/import.js';
import { WorkerHub } from '../../src/workers/hub.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';

interface Key {
  publicKey: string;
  privateKey: KeyObject;
}
function key(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: String(publicKey.export({ format: 'jwk' }).x), privateKey };
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A release.json exactly as `sign.mjs build` writes it (manifest + signature + artifact + kits). */
function releaseJson(
  k: Key,
  version: string,
  opts: { channel?: string; kits?: boolean; tamperArtifact?: boolean; tamperKit?: boolean } = {},
): Buffer {
  const artifact = Buffer.from(`#!/usr/bin/env node\n// remyral-worker ${version}\n`);
  const manifest = Buffer.from(
    `${JSON.stringify({
      schema: 1,
      name: 'remyral-worker',
      version,
      channel: opts.channel ?? 'stable',
      protocolVersions: ['1.0'],
      minNode: '24.0.0',
      sha256: sha256Hex(artifact),
      size: artifact.byteLength,
      createdAt: '2026-10-15T10:00:00.000Z',
    })}\n`,
  );
  const doc: Record<string, unknown> = {
    manifest: manifest.toString('base64'),
    signature: {
      keyId: releaseKeyId(k.publicKey),
      signature: sign(null, releaseSigningPayload(manifest), k.privateKey).toString('base64url'),
    },
    artifact: (opts.tamperArtifact ? Buffer.from('evil worker') : artifact).toString('base64'),
  };
  if (opts.kits !== false) {
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
      kits: kits.map((x) => ({
        os: x.os,
        content: (opts.tamperKit && x.os === 'windows' ? Buffer.from('evil kit') : x.bytes).toString(
          'base64',
        ),
      })),
    };
  }
  return Buffer.from(`${JSON.stringify(doc)}\n`);
}

/**
 * p6-release-import against real Postgres: the host-side CLI core verifies exactly like the console upload
 * (signature, artifact, installer kits), is audited as the system actor `release-import`, can roll out
 * with the rollout route's service method, and the running master offers a channel changed by the CLI.
 */
describeIntegration('host-side release import (integration)', () => {
  const k = key();
  const foreign = key();
  let h: Harness;
  let admin: Client;

  const services = (cfg: ReleaseServicesConfig = { releases: { publicKeys: [k.publicKey] } }) =>
    createReleaseServices(
      {
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool),
        hub: new WorkerHub(h.app.log),
        clock: () => new Date(),
        log: h.app.log,
      },
      cfg,
    );
  const audit = async (action: string) =>
    (
      await h.db.pool.query<{
        actor_type: string;
        actor_id: string | null;
        outcome: string;
        target: string | null;
        ip: string | null;
        metadata: Record<string, unknown>;
      }>(
        'SELECT actor_type, actor_id, outcome, target, ip, metadata FROM audit_events WHERE action = $1 ORDER BY occurred_at, id',
        [action],
      )
    ).rows;

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      releases: { publicKeys: [k.publicKey], channelPollIntervalMs: 0 },
      installers: { publicOrigin: 'https://remyral.example.com', publicDownloads: true },
    });
    await h.createUser('owner1', PW);
    const { secret } = await enroll(h, 'owner1', PW);
    admin = await fullLogin(h, 'owner1', PW, secret);
  });
  afterAll(async () => {
    await h.stop();
  });

  it('imports a signed release with installer kits, audited as release-import, visible in the console', async () => {
    const result = await importRelease(services(), releaseJson(k, '1.0.17'));
    expect(result).toMatchObject({ version: '1.0.17', created: true, channel: 'stable', rollout: null });

    const up = (await audit('release.upload')).at(-1);
    expect(up).toMatchObject({
      actor_type: 'system',
      actor_id: 'release-import',
      outcome: 'success',
      target: '1.0.17',
      ip: null,
    });
    expect((await audit('release.installers.upload')).at(-1)).toMatchObject({
      actor_type: 'system',
      actor_id: 'release-import',
      outcome: 'success',
    });
    const row = await h.db.pool.query<{ uploaded_by: string | null }>(
      'SELECT uploaded_by FROM worker_releases WHERE version = $1',
      ['1.0.17'],
    );
    expect(row.rows[0]?.uploaded_by).toBeNull();

    const list = (await admin.req('GET', '/releases')).json<{ releases: { version: string }[] }>();
    expect(list.releases.map((r) => r.version)).toContain('1.0.17');
    const inst = await h.db.pool.query('SELECT 1 FROM worker_release_installer_kits WHERE version = $1', [
      '1.0.17',
    ]);
    expect(inst.rowCount).toBe(3);

    // The same document again is idempotent, exactly like a second console upload.
    expect(await importRelease(services(), releaseJson(k, '1.0.17'))).toMatchObject({ created: false });
  });

  it('refuses a tampered artifact or kit and an unsigned or foreign-signed document', async () => {
    const before = (await audit('release.upload')).length;
    await expect(
      importRelease(services(), releaseJson(k, '1.0.18', { tamperArtifact: true })),
    ).rejects.toThrow(/refused \(artifact_mismatch\)/);
    await expect(importRelease(services(), releaseJson(foreign, '1.0.18'))).rejects.toThrow(
      /refused \(signature_invalid\)/,
    );
    const denied = (await audit('release.upload')).slice(before);
    expect(denied).toHaveLength(2);
    for (const d of denied) {
      expect(d).toMatchObject({ actor_type: 'system', actor_id: 'release-import', outcome: 'denied' });
    }

    await expect(importRelease(services(), releaseJson(k, '1.0.19', { tamperKit: true }))).rejects.toThrow(
      /refused \(installer_kit_mismatch\)/,
    );
    expect((await audit('release.installers.upload')).at(-1)).toMatchObject({
      actor_id: 'release-import',
      outcome: 'denied',
    });

    // Unsigned: the signature field stripped → not a release document at all.
    const unsigned = JSON.parse(releaseJson(k, '1.0.20').toString()) as Record<string, unknown>;
    delete unsigned.signature;
    await expect(importRelease(services(), Buffer.from(JSON.stringify(unsigned)))).rejects.toThrow(
      /not a signed release.json/,
    );
    // A master without RELEASE_PUBLIC_KEYS verifies nothing and so accepts nothing.
    await expect(importRelease(services({}), releaseJson(k, '1.0.20'))).rejects.toThrow(
      /release_keys_not_configured/,
    );
    const rows = await h.db.pool.query(
      "SELECT version FROM worker_releases WHERE version IN ('1.0.18', '1.0.20')",
    );
    expect(rows.rowCount).toBe(0);
  });

  it('--rollout promotes with the rollout route method, audited release.promote by release-import', async () => {
    const result = await importRelease(services(), releaseJson(k, '1.0.21', { kits: false }), {
      rollout: { channel: 'stable', rolloutPercent: 25 },
    });
    expect(result).toMatchObject({
      version: '1.0.21',
      created: true,
      rollout: { channel: 'stable', rolloutPercent: 25 },
    });
    const ch = await h.db.pool.query<{ version: string; rollout_percent: number; updated_by: string | null }>(
      "SELECT version, rollout_percent, updated_by FROM worker_release_channels WHERE channel = 'stable'",
    );
    expect(ch.rows[0]).toEqual({ version: '1.0.21', rollout_percent: 25, updated_by: null });
    expect((await audit('release.promote')).at(-1)).toMatchObject({
      actor_type: 'system',
      actor_id: 'release-import',
      outcome: 'success',
      target: '1.0.21',
      metadata: { channel: 'stable', rolloutPercent: 25 },
    });

    // A canary-signed build cannot be rolled out on stable: imported, the rollout refused.
    await expect(
      importRelease(services(), releaseJson(k, '1.0.22-rc.1', { channel: 'canary', kits: false }), {
        rollout: { channel: 'stable', rolloutPercent: 100 },
      }),
    ).rejects.toThrow(/imported, but the rollout was refused \(channel_mismatch\)/);
    const rc = await h.db.pool.query("SELECT 1 FROM worker_releases WHERE version = '1.0.22-rc.1'");
    expect(rc.rowCount).toBe(1);
  });

  it('the running master offers a channel the CLI changed, once, and not its own promotions twice', async () => {
    const master = services().releases;
    const offered = vi.spyOn(master, 'offerToConnected');
    expect(await master.offerIfChannelsChanged()).toBe(false); // first look only records the state
    expect(await master.offerIfChannelsChanged()).toBe(false);

    await importRelease(services(), releaseJson(k, '1.0.23', { kits: false }), {
      rollout: { channel: 'stable', rolloutPercent: 50 },
    });
    expect(await master.offerIfChannelsChanged()).toBe(true);
    expect(offered).toHaveBeenCalledTimes(1);
    expect(await master.offerIfChannelsChanged()).toBe(false);

    await master.promote('stable', '1.0.23', 100, {
      userId: null as unknown as string,
      ip: '127.0.0.1',
      userAgent: null,
    });
    expect(offered).toHaveBeenCalledTimes(2); // the in-process promote offered itself
    expect(await master.offerIfChannelsChanged()).toBe(false);
    expect(offered).toHaveBeenCalledTimes(2);
  });

  it('refusals are AdminErrors (printed, exit 1), never stack traces', async () => {
    await expect(importRelease(services(), releaseJson(foreign, '1.0.24'))).rejects.toBeInstanceOf(
      AdminError,
    );
  });
});
