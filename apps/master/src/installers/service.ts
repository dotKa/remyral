import { createHash, randomBytes } from 'node:crypto';
import { type OriginInput, originOf } from '../console-domain/origin.js';
import {
  compareReleaseVersions,
  InstallerOs,
  type InstallerOs as InstallerOsType,
  verifyInstallerIndex,
  verifyInstallerKit,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { blobs, rowContent } from '../blobs/registry.js';
import { actorUserId, auditIdentity, type ReleaseActor } from '../releases/actor.js';
import type { ActorContext } from '../workers/fleet.js';
import { bootstrapFileName, bootstrapScript, installCommands, workerUrl } from './bootstrap.js';

/**
 * Installer kits for Fleet → "Add machine" (p5-worker-onboarding, docs/design/p5-worker-onboarding.md).
 *
 * - **Upload** (with `POST /releases`): the installer index must verify against `RELEASE_PUBLIC_KEYS`
 *   (domain `remyral-worker-installers/v1`), be bound to the exact manifest bytes of the stored release,
 *   and every uploaded kit must match its signed SHA-256 and size. The master stores, never signs.
 * - **Current**: the kits of the `stable` channel's release when it has valid ones, else of the newest
 *   release that does. Kits bound to an older manifest of a re-signed release are never served.
 * - **Serving**: kits and bootstrap scripts are immutable per release; a bootstrap script is generated
 *   from the public origin + the signed kit hash (deterministic, no secret).
 */
export interface InstallerServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly publicKeys: readonly string[];
  /**
   * PUBLIC_ORIGIN (https), or the live console address (p17-domain-wizard: the saved setting wins). Null: bootstrap
   * scripts cannot be generated.
   */
  readonly publicOrigin: OriginInput;
  /** INSTALLER_PUBLIC_DOWNLOADS. */
  readonly publicDownloads: boolean;
}

export interface InstallerUpload {
  readonly index: Buffer;
  readonly signature: unknown;
  readonly kits: readonly { readonly os: string; readonly content: Buffer }[];
}

export interface KitSummary {
  readonly os: InstallerOsType;
  readonly file: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  /** One-line install: download + verify the bootstrap, then run it. Null without a public origin. */
  readonly commands: {
    readonly bootstrapUrl: string;
    readonly bootstrapSha256: string;
    readonly download: string;
    readonly run: string;
  } | null;
  /** Direct (anonymous) kit URL when public downloads are on and the origin is known. */
  readonly kitUrl: string | null;
}

export interface InstallerOverview {
  readonly publicOrigin: string | null;
  readonly masterUrl: string | null;
  readonly publicDownloads: boolean;
  readonly current: {
    readonly version: string;
    readonly channel: string;
    /** True when this is the release the stable channel points at. */
    readonly stable: boolean;
    readonly keyId: string;
    readonly nodeVersion: string;
    readonly uploadedAt: string;
    readonly kits: KitSummary[];
  } | null;
  /** Releases that have no (current) kits — the owner must run `sign.mjs installers` for them. */
  readonly withoutKits: string[];
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

interface CurrentRow {
  version: string;
  channel: string;
  key_id: string;
  node_version: string;
  uploaded_at: Date;
}

/** Installer rows that are bound to the release's current manifest bytes. */
const VALID = `FROM worker_release_installers i JOIN worker_releases r ON r.version = i.version
               WHERE i.release_manifest_sha256 = encode(sha256(r.manifest), 'hex')`;

export class InstallerService {
  constructor(private readonly deps: InstallerServiceDeps) {}

  get publicDownloads(): boolean {
    return this.deps.publicDownloads;
  }

  /** Verifies and stores the kits of a release. Idempotent for identical bytes. */
  async attach(
    version: string,
    input: InstallerUpload,
    actor: ReleaseActor,
  ): Promise<{ created: boolean; kits: number }> {
    if (this.deps.publicKeys.length === 0) {
      throw new HttpError(
        503,
        'release_keys_not_configured',
        'RELEASE_PUBLIC_KEYS is not configured on the master.',
      );
    }
    const deny = async (reason: string, status: number, code: string, message: string): Promise<never> => {
      await this.#audit(actor, 'release.installers.upload', 'denied', version, { reason });
      throw new HttpError(status, code, message);
    };
    const v = verifyInstallerIndex(input.index, input.signature, this.deps.publicKeys);
    if (!v.ok) {
      return deny(
        v.reason,
        422,
        'installer_signature_invalid',
        `The installer index is not validly signed (${v.reason}).`,
      );
    }
    const index = v.index;
    if (index.version !== version) {
      return deny(
        'version_mismatch',
        422,
        'installer_version_mismatch',
        `The installer index is for ${index.version}, not ${version}.`,
      );
    }
    const uploaded = new Map<string, Buffer>();
    for (const k of input.kits) {
      if (!InstallerOs.safeParse(k.os).success || uploaded.has(k.os)) {
        return deny('bad_kit_list', 422, 'installer_kit_mismatch', 'Unknown or duplicate kit OS.');
      }
      uploaded.set(k.os, k.content);
    }
    if (uploaded.size !== index.kits.length) {
      return deny(
        'kit_missing',
        422,
        'installer_kit_mismatch',
        'Every kit named in the signed index must be uploaded, and nothing else.',
      );
    }
    for (const kit of index.kits) {
      const bytes = uploaded.get(kit.os);
      const check =
        bytes === undefined ? { ok: false as const, reason: 'kit_missing' } : verifyInstallerKit(kit, bytes);
      if (!check.ok) {
        return deny(
          check.reason,
          422,
          'installer_kit_mismatch',
          `The ${kit.os} kit does not match the signed index (${check.reason}).`,
        );
      }
    }
    return withTransaction(this.deps.pool, async (tx) => {
      const rel = await tx.query<{ manifest: Buffer }>(
        'SELECT manifest FROM worker_releases WHERE version = $1 FOR UPDATE',
        [version],
      );
      const manifest = rel.rows[0]?.manifest;
      if (manifest === undefined)
        throw new HttpError(
          404,
          'not_found',
          `Release ${version} does not exist.`,
          {},
          {},
          { reason: 'release', version },
        );
      if (sha256(manifest) !== index.releaseManifestSha256) {
        await this.#audit(actor, 'release.installers.upload', 'denied', version, {
          reason: 'manifest_mismatch',
        });
        throw new HttpError(
          409,
          'installers_manifest_mismatch',
          'These kits were built for other manifest bytes than the release stored on the master. Build them from the release dir that was uploaded (sign.mjs installers --dir …).',
        );
      }
      const prior = await tx.query<{ index_doc: Buffer; release_manifest_sha256: string }>(
        'SELECT index_doc, release_manifest_sha256 FROM worker_release_installers WHERE version = $1',
        [version],
      );
      const p = prior.rows[0];
      if (p !== undefined) {
        if (p.index_doc.equals(input.index)) return { created: false, kits: index.kits.length };
        if (p.release_manifest_sha256 === index.releaseManifestSha256) {
          await this.#audit(
            actor,
            'release.installers.upload',
            'denied',
            version,
            { reason: 'installers_exist' },
            tx,
          );
          throw new HttpError(
            409,
            'installers_exist',
            `Release ${version} already has installer kits; kits are immutable per release.`,
            {},
            {},
            { version },
          );
        }
        // Stale kits (the release was re-signed since): replaced.
        await tx.query('DELETE FROM worker_release_installers WHERE version = $1', [version]);
      }
      await tx.query(
        `INSERT INTO worker_release_installers (version, index_doc, signature, key_id, release_manifest_sha256,
                                                node_version, uploaded_at, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          version,
          input.index,
          JSON.stringify(input.signature),
          v.keyId,
          index.releaseManifestSha256,
          index.node.version,
          this.deps.clock(),
          actorUserId(actor),
        ],
      );
      for (const kit of index.kits) {
        // p17-object-storage: the kit goes to the blob store (never Postgres); the row keeps the key.
        // A fresh key per upload: replacing a stale kit set never overwrites bytes a committed row still names.
        const key = await blobs().write(
          'kit',
          `kits/${version}/${kit.os}-${randomBytes(6).toString('hex')}`,
          uploaded.get(kit.os) ?? Buffer.alloc(0),
        );
        await tx.query(
          `INSERT INTO worker_release_installer_kits (version, os, file_name, sha256, size_bytes, content, blob_key)
           VALUES ($1, $2, $3, $4, $5, NULL, $6)`,
          [version, kit.os, kit.file, kit.sha256, kit.size, key],
        );
      }
      await this.#audit(
        actor,
        'release.installers.upload',
        'success',
        version,
        {
          keyId: v.keyId,
          node: index.node.version,
          kits: index.kits.map((k) => ({ os: k.os, sha256: k.sha256 })),
          replacedStale: p !== undefined,
        },
        tx,
      );
      return { created: true, kits: index.kits.length };
    });
  }

  /** The release whose kits Add machine offers: stable channel's if it has valid kits, else the newest. */
  async #current(): Promise<CurrentRow | null> {
    const stable = await this.deps.pool.query<CurrentRow>(
      `SELECT i.version, r.channel, i.key_id, i.node_version, i.uploaded_at ${VALID}
         AND i.version = (SELECT version FROM worker_release_channels WHERE channel = 'stable')`,
    );
    if (stable.rows[0] !== undefined) return stable.rows[0];
    const all = await this.deps.pool.query<CurrentRow>(
      `SELECT i.version, r.channel, i.key_id, i.node_version, i.uploaded_at ${VALID}`,
    );
    const sorted = all.rows.sort((a, b) => compareReleaseVersions(b.version, a.version));
    return sorted[0] ?? null;
  }

  async overview(): Promise<InstallerOverview> {
    const origin = originOf(this.deps.publicOrigin);
    const cur = await this.#current();
    const stableVersion = (
      await this.deps.pool.query<{ version: string }>(
        "SELECT version FROM worker_release_channels WHERE channel = 'stable'",
      )
    ).rows[0]?.version;
    const missing = await this.deps.pool.query<{ version: string }>(
      `SELECT r.version FROM worker_releases r WHERE NOT EXISTS (
         SELECT 1 FROM worker_release_installers i
          WHERE i.version = r.version AND i.release_manifest_sha256 = encode(sha256(r.manifest), 'hex'))`,
    );
    let current: InstallerOverview['current'] = null;
    if (cur !== null) {
      const kits = await this.deps.pool.query<{
        os: InstallerOsType;
        file_name: string;
        sha256: string;
        size_bytes: number;
      }>(
        'SELECT os, file_name, sha256, size_bytes FROM worker_release_installer_kits WHERE version = $1 ORDER BY os',
        [cur.version],
      );
      current = {
        version: cur.version,
        channel: cur.channel,
        stable: cur.version === stableVersion,
        keyId: cur.key_id,
        nodeVersion: cur.node_version,
        uploadedAt: cur.uploaded_at.toISOString(),
        kits: kits.rows.map((k) => {
          const input = {
            origin: origin ?? '',
            version: cur.version,
            os: k.os,
            kitFile: k.file_name,
            kitSha256: k.sha256,
          };
          const c = origin === null ? null : installCommands(input);
          return {
            os: k.os,
            file: k.file_name,
            sha256: k.sha256,
            sizeBytes: k.size_bytes,
            commands:
              c === null || !this.deps.publicDownloads
                ? null
                : {
                    bootstrapUrl: c.url,
                    bootstrapSha256: c.bootstrapSha256,
                    download: c.download,
                    run: c.run,
                  },
            kitUrl:
              origin === null || !this.deps.publicDownloads
                ? null
                : `${origin}/v1/worker/install/${cur.version}/${k.os}/${k.file_name}`,
          };
        }),
      };
    }
    return {
      publicOrigin: origin,
      masterUrl: origin === null ? null : workerUrl(origin),
      publicDownloads: this.deps.publicDownloads,
      current,
      withoutKits: missing.rows.map((r) => r.version).sort((a, b) => compareReleaseVersions(b, a)),
    };
  }

  /** A valid kit (bound to the release's current manifest), or null. */
  async kit(version: string, os: string): Promise<{ file: string; sha256: string; content: Buffer } | null> {
    if (!InstallerOs.safeParse(os).success) return null;
    const { rows } = await this.deps.pool.query<{
      file_name: string;
      sha256: string;
      content: Buffer | null;
      blob_key: string | null;
    }>(
      `SELECT k.file_name, k.sha256, k.content, k.blob_key FROM worker_release_installer_kits k
        WHERE k.version = $1 AND k.os = $2 AND EXISTS (SELECT 1 ${VALID} AND i.version = k.version)`,
      [version, os],
    );
    const r = rows[0];
    if (r === undefined) return null;
    // p17-object-storage: the kit is in the blob store (or the legacy column until blobs:migrate ran).
    const content = await rowContent(r, 64 * 1024 * 1024);
    return content === null ? null : { file: r.file_name, sha256: r.sha256, content };
  }

  /** Bootstrap script for a valid kit; null when there is no such kit. Throws 503 without a public origin. */
  async bootstrap(version: string, os: string, file: string): Promise<string | null> {
    if (!InstallerOs.safeParse(os).success) return null;
    const o = os as InstallerOsType;
    if (file !== bootstrapFileName(o)) return null;
    const origin = originOf(this.deps.publicOrigin);
    if (origin === null) {
      throw new HttpError(
        503,
        'public_origin_not_configured',
        'PUBLIC_ORIGIN is not configured on the master.',
      );
    }
    const { rows } = await this.deps.pool.query<{ file_name: string; sha256: string }>(
      `SELECT k.file_name, k.sha256 FROM worker_release_installer_kits k
        WHERE k.version = $1 AND k.os = $2 AND EXISTS (SELECT 1 ${VALID} AND i.version = k.version)`,
      [version, os],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return bootstrapScript({
      origin,
      version,
      os: o,
      kitFile: r.file_name,
      kitSha256: r.sha256,
    });
  }

  /** The signed installer index (for offline verification with `sign.mjs verify-installers`). */
  async indexDocument(version: string): Promise<{ index: Buffer; signature: unknown } | null> {
    const { rows } = await this.deps.pool.query<{ index_doc: Buffer; signature: unknown }>(
      `SELECT i.index_doc, i.signature ${VALID} AND i.version = $1`,
      [version],
    );
    const r = rows[0];
    return r === undefined ? null : { index: r.index_doc, signature: r.signature };
  }

  async auditDownload(actor: ActorContext, version: string, os: string, sha: string): Promise<void> {
    await this.#audit(actor, 'installer.download', 'success', `${version}/${os}`, { sha256: sha });
  }

  async #audit(
    actor: ReleaseActor,
    action: string,
    outcome: 'success' | 'denied',
    target: string | null,
    metadata: Record<string, unknown>,
    tx?: Parameters<AuditRecorder['record']>[1],
  ): Promise<void> {
    await this.deps.audit.record(
      {
        ...auditIdentity(actor),
        action,
        outcome,
        target,
        metadata,
      },
      tx,
    );
  }
}
