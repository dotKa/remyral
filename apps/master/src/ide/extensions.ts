import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  detectSecrets,
  IDE_EXTENSION_LIMITS,
  IdeExtensionId,
  IdeExtensionVersion,
  type IdeProfile,
  type IdeTargetPlatform,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { blobKeys, type BlobService } from '../blobs/store.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import {
  type AllowlistEntry,
  checkSettingsText,
  denial,
  ideTarget,
  resolveProfile,
  type SkipReason,
} from './extension-policy.js';
import {
  cacheTargets,
  DEFAULT_REGISTRY,
  normalizeRegistry,
  OpenVsxClient,
  OpenVsxError,
  type OpenVsxSearchHit,
} from './openvsx.js';

/**
 * p19-ide W3 (docs/design/p19-ide.md §4, decision 4): IDE extensions and settings on the master.
 *
 * - **The master is the gallery.** An admin searches Open VSX through the master and allows `publisher.name` (a chosen
 *   version, or the latest at approval time). The master downloads the VSIX for `universal` (else every Linux, macOS and
 *   Windows target — W2b),
 *   verifies size, SHA-256 and the registry's Ed25519 signature (openvsx.ts), and stores it in the blob store
 *   (`ide-extension`). There is no VSIX upload. Removing an extension drops its cache rows (the blob GC removes the
 *   bytes).
 * - **Policy**: global (registry, verified publishers only, deny), per project (required, recommended, deny, enforced
 *   settings), per user (their list from what is allowed). Deny always wins (extension-policy.ts).
 * - **Workspace start**: {@link profileFor} resolves the set for the workspace's machine; the IDE service puts it in
 *   the signed IDE_START with a download token ({@link issueToken}) valid 30 minutes for exactly those blobs and the
 *   owner's settings. Workers download from `GET /v1/worker/ide/extensions/<sha256>` and `/v1/worker/ide/settings/<id>`.
 * - **Settings sync**: the bridge's IDE_EVENT `settings` lands in {@link saveSettings} (≤ 256 KiB, a secret-looking
 *   value is refused and audited as `ide.settings.refused`, never stored).
 *
 * Every change is audited: `ide.policy.global`, `ide.policy.project`, `ide.extension.allow`, `ide.extension.remove`,
 * `ide.extensions.user`, `ide.settings.reset`, `ide.settings.refused`.
 */

export interface IdeExtensionsDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly blobs: () => BlobService | null;
  readonly openVsx?: OpenVsxClient;
  /** Download token lifetime (ms); default 30 min. */
  readonly tokenTtlMs?: number;
}

export interface Actor {
  readonly type: 'user';
  readonly id: string;
  readonly ip?: string | null;
}

export interface GlobalPolicyView {
  readonly registryUrl: string;
  readonly verifiedOnly: boolean;
  readonly deny: string[];
  readonly updatedAt: string | null;
}

export interface ProjectPolicyView {
  readonly required: string[];
  readonly recommended: string[];
  readonly deny: string[];
  readonly enforcedSettings: Record<string, unknown>;
  readonly updatedAt: string | null;
}

export interface AllowedExtensionView {
  readonly id: string;
  readonly version: string;
  readonly pinned: boolean;
  readonly displayName: string;
  readonly description: string;
  readonly publisherVerified: boolean;
  readonly license: string | null;
  readonly engine: string | null;
  readonly dependencies: string[];
  readonly registryUrl: string;
  readonly targets: {
    readonly target: IdeTargetPlatform;
    readonly sha256: string;
    readonly size: number;
    readonly keyId: string;
    readonly keyPinned: boolean;
  }[];
  readonly approvedBy: string | null;
  readonly approvedAt: string;
}

export interface UserExtensionsView {
  /** Usable in this project (allowed, not denied), with the project's marks. */
  readonly available: (AllowedExtensionView & {
    readonly required: boolean;
    readonly recommended: boolean;
  })[];
  readonly mine: string[];
  readonly required: string[];
  readonly recommended: string[];
  /** Ids on the user's list the policy does not allow here (with why). */
  readonly blocked: { readonly id: string; readonly reason: string }[];
  readonly settings: {
    readonly settingsBytes: number | null;
    readonly keybindingsBytes: number | null;
    readonly updatedAt: string | null;
  };
}

interface Grant {
  readonly workerId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly shas: ReadonlySet<string>;
  readonly expiresAt: number;
}

const json = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function normalizeIds(ids: readonly string[], what: string): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim().toLowerCase();
    if (!IdeExtensionId.safeParse(id).success) {
      throw new HttpError(
        400,
        'ide_extension_invalid',
        `${what}: “${raw.slice(0, 80)}” is not publisher.name.`,
      );
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const tooMany = (): HttpError =>
  new HttpError(
    400,
    'ide_extension_invalid',
    'Too many extensions in a list.',
    {},
    {},
    { reason: 'too_many' },
  );

/** The console's error for a registry failure (one fixed message per code; the detail stays in the audit). */
function registryError(err: unknown): HttpError {
  const reason = err instanceof OpenVsxError ? err.reason : 'unreachable';
  switch (reason) {
    case 'not_found':
      return new HttpError(404, 'ide_extension_not_found', 'Extension not found.');
    case 'bad_answer':
      return new HttpError(
        502,
        'ide_extension_bad_answer',
        'The extension registry gave an answer that cannot be used.',
      );
    case 'too_large':
      return new HttpError(409, 'ide_extension_too_large', 'The extension is larger than 100 MB.');
    case 'platform':
      return new HttpError(
        409,
        'ide_extension_platform',
        'This extension has no build for the machines’ platforms (Linux, macOS, Windows).',
      );
    case 'unsigned':
      return new HttpError(
        409,
        'ide_extension_unsigned',
        'The registry has no signature for this extension; it cannot be allowed.',
      );
    case 'signature':
      return new HttpError(
        409,
        'ide_extension_signature',
        'The extension’s registry signature does not verify; it was not stored.',
      );
    case 'digest':
      return new HttpError(
        409,
        'ide_extension_digest',
        'The downloaded extension does not match the registry’s checksum; it was not stored.',
      );
    case 'unreachable':
      return new HttpError(502, 'ide_extension_unreachable', 'The extension registry could not be reached.');
  }
}

export class IdeExtensions {
  readonly #openVsx: OpenVsxClient;
  readonly #grants = new Map<string, Grant>();

  constructor(private readonly deps: IdeExtensionsDeps) {
    this.#openVsx = deps.openVsx ?? new OpenVsxClient();
  }

  async #audit(
    actor: Actor | { readonly type: 'worker' | 'system'; readonly id: string },
    action: string,
    target: string,
    metadata: Record<string, unknown>,
    outcome: 'success' | 'failure' | 'denied' = 'success',
  ): Promise<void> {
    const ip = actor.type === 'user' ? actor.ip : undefined;
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action,
      target,
      outcome,
      metadata,
      ...(ip === undefined || ip === null ? {} : { ip }),
    });
  }

  // ============================================================================================= global policy

  async globalPolicy(): Promise<GlobalPolicyView> {
    const { rows } = await this.deps.pool.query<{
      registry_url: string | null;
      verified_only: boolean;
      deny: unknown;
      updated_at: Date;
    }>(
      'SELECT registry_url, verified_only, deny, updated_at FROM ide_extension_policy WHERE project IS NULL',
    );
    const r = rows[0];
    return {
      registryUrl: r?.registry_url ?? DEFAULT_REGISTRY,
      verifiedOnly: r?.verified_only ?? false,
      deny: json(r?.deny),
      updatedAt: r?.updated_at.toISOString() ?? null,
    };
  }

  async setGlobalPolicy(
    actor: Actor,
    input: {
      readonly registryUrl: string | null;
      readonly verifiedOnly: boolean;
      readonly deny: readonly string[];
    },
  ): Promise<GlobalPolicyView> {
    let registry: string | null = null;
    if (input.registryUrl !== null && input.registryUrl.trim() !== '') {
      try {
        registry = normalizeRegistry(input.registryUrl.trim());
      } catch {
        throw new HttpError(400, 'ide_registry_invalid', 'The registry address must be a plain https URL.');
      }
      if (registry === DEFAULT_REGISTRY) registry = null;
    }
    const deny = normalizeIds(input.deny, 'deny');
    if (deny.length > IDE_EXTENSION_LIMITS.allowlist) throw tooMany();
    const before = await this.globalPolicy();
    await this.deps.pool.query(
      `INSERT INTO ide_extension_policy (project, registry_url, verified_only, deny, updated_by, updated_at)
       VALUES (NULL, $1, $2, $3, $4, $5)
       ON CONFLICT ((coalesce(project, ''))) DO UPDATE SET registry_url = EXCLUDED.registry_url,
         verified_only = EXCLUDED.verified_only, deny = EXCLUDED.deny, updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at`,
      [registry, input.verifiedOnly, JSON.stringify(deny), actor.id, this.deps.clock()],
    );
    await this.#audit(actor, 'ide.policy.global', 'ide-extensions:global', {
      registry: registry ?? DEFAULT_REGISTRY,
      registryChanged: (registry ?? DEFAULT_REGISTRY) !== before.registryUrl,
      verifiedOnly: input.verifiedOnly,
      denied: deny,
    });
    return this.globalPolicy();
  }

  // ============================================================================================= allowlist

  async list(): Promise<AllowedExtensionView[]> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      version: string;
      pinned: boolean;
      display_name: string;
      description: string;
      publisher_verified: boolean;
      license: string | null;
      engine: string | null;
      dependencies: unknown;
      registry_url: string;
      username: string | null;
      approved_at: Date;
      targets: unknown;
    }>(
      `SELECT e.id, e.version, e.pinned, e.display_name, e.description, e.publisher_verified, e.license, e.engine,
              e.dependencies, e.registry_url, u.username, e.approved_at,
              coalesce((SELECT jsonb_agg(jsonb_build_object('target', b.target_platform, 'sha256', b.sha256,
                          'size', b.size_bytes, 'keyId', b.key_id, 'keyPinned', b.key_pinned)
                          ORDER BY b.target_platform)
                          FROM ide_extension_blobs b WHERE b.extension_id = e.id AND b.version = e.version),
                       '[]'::jsonb) AS targets
         FROM ide_extensions e LEFT JOIN users u ON u.id = e.approved_by
        ORDER BY e.id LIMIT ${String(IDE_EXTENSION_LIMITS.allowlist)}`,
    );
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      pinned: r.pinned,
      displayName: r.display_name,
      description: r.description,
      publisherVerified: r.publisher_verified,
      license: r.license,
      engine: r.engine,
      dependencies: json(r.dependencies),
      registryUrl: r.registry_url,
      targets: (Array.isArray(r.targets) ? r.targets : []).map((t) => {
        const o = t as Record<string, unknown>;
        return {
          target: o.target as IdeTargetPlatform,
          sha256: String(o.sha256),
          size: Number(o.size),
          keyId: String(o.keyId),
          keyPinned: o.keyPinned === true,
        };
      }),
      approvedBy: r.username,
      approvedAt: r.approved_at.toISOString(),
    }));
  }

  async #allowlist(): Promise<AllowlistEntry[]> {
    return (await this.list()).map((e) => ({
      id: e.id,
      version: e.version,
      publisherVerified: e.publisherVerified,
      dependencies: e.dependencies,
      blobs: e.targets.map((t) => ({ target: t.target, sha256: t.sha256, size: t.size })),
    }));
  }

  /** Open VSX search for the admin page, marked with what is allowed / denied here. */
  async search(
    query: string,
  ): Promise<(OpenVsxSearchHit & { allowedVersion: string | null; denied: boolean })[]> {
    const policy = await this.globalPolicy();
    let hits: OpenVsxSearchHit[];
    try {
      hits = await this.#openVsx.search(policy.registryUrl, query, 20);
    } catch (err) {
      throw registryError(err);
    }
    const allowed = new Map((await this.list()).map((e) => [e.id, e.version]));
    return hits.map((h) => ({
      ...h,
      allowedVersion: allowed.get(h.id) ?? null,
      denied: policy.deny.includes(h.id),
    }));
  }

  /**
   * Allows an extension (`version` absent: the latest at approval time) — downloads and verifies every build the
   * machines need and stores it, then records the approval. A newer approval replaces the older version.
   */
  async allow(
    actor: Actor,
    input: { readonly id: string; readonly version?: string | undefined },
  ): Promise<AllowedExtensionView> {
    const [id] = normalizeIds([input.id], 'id');
    if (id === undefined)
      throw new HttpError(400, 'ide_extension_invalid', 'An extension id is publisher.name.');
    if (input.version !== undefined && !IdeExtensionVersion.safeParse(input.version).success)
      throw new HttpError(
        400,
        'ide_extension_invalid',
        'Not an extension version.',
        {},
        {},
        { reason: 'version' },
      );
    const blobs = this.deps.blobs();
    if (blobs === null)
      throw new HttpError(409, 'ide_extension_storage', 'The server’s file storage is not available.');
    const policy = await this.globalPolicy();
    if (policy.deny.includes(id))
      throw new HttpError(
        409,
        'ide_extension_denied',
        'This extension is denied; remove it from the deny list first.',
      );
    const { count } = await this.deps.pool
      .query<{ n: number }>('SELECT count(*)::int AS n FROM ide_extensions WHERE id <> $1', [id])
      .then((r) => ({ count: r.rows[0]?.n ?? 0 }));
    if (count >= IDE_EXTENSION_LIMITS.allowlist)
      throw new HttpError(
        409,
        'ide_extension_limit',
        'The extension allowlist is full; remove an extension first.',
      );
    const registry = policy.registryUrl;
    let meta;
    try {
      meta = await this.#openVsx.meta(registry, id, input.version);
    } catch (err) {
      throw registryError(err);
    }
    if (policy.verifiedOnly && !meta.verified) {
      throw new HttpError(
        409,
        'ide_extension_unverified',
        'Only extensions of verified publishers may be allowed.',
      );
    }
    const targets = cacheTargets(meta);
    if (targets.length === 0) {
      throw new HttpError(
        409,
        'ide_extension_platform',
        'This extension has no build for the machines’ platforms (Linux, macOS, Windows).',
      );
    }
    const now = this.deps.clock();
    const stored: {
      target: IdeTargetPlatform;
      sha256: string;
      size: number;
      key: string;
      keyId: string;
      fp: string;
      pinned: boolean;
    }[] = [];
    for (const target of targets) {
      try {
        const m =
          target === 'universal' ? meta : await this.#openVsx.meta(registry, id, meta.version, target);
        if (m.version !== meta.version)
          throw new OpenVsxError('bad_answer', 'the registry answered another version');
        const v = await this.#openVsx.fetchVerified(registry, m);
        const key = blobKeys.ideExtension(v.sha256);
        await blobs.write('ide-extension', key, v.bytes, 'application/vsix');
        stored.push({
          target,
          sha256: v.sha256,
          size: v.bytes.length,
          key,
          keyId: v.keyId,
          fp: v.keyFingerprint,
          pinned: v.keyPinned,
        });
      } catch (err) {
        await this.#audit(
          actor,
          'ide.extension.allow',
          `ide-extension:${id}`,
          {
            version: meta.version,
            target,
            reason: err instanceof OpenVsxError ? err.reason : 'failed',
          },
          'failure',
        );
        throw registryError(err);
      }
    }
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ide_extensions (id, version, pinned, display_name, description, publisher_verified, license, engine,
           dependencies, registry_url, approved_by, approved_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
         ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, pinned = EXCLUDED.pinned,
           display_name = EXCLUDED.display_name, description = EXCLUDED.description,
           publisher_verified = EXCLUDED.publisher_verified, license = EXCLUDED.license, engine = EXCLUDED.engine,
           dependencies = EXCLUDED.dependencies, registry_url = EXCLUDED.registry_url,
           approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at, updated_at = EXCLUDED.updated_at`,
        [
          id,
          meta.version,
          input.version !== undefined,
          meta.displayName,
          meta.description,
          meta.verified,
          meta.license,
          meta.engine,
          JSON.stringify(meta.dependencies),
          registry,
          actor.id,
          now,
        ],
      );
      // Older versions' cache rows go (their blobs become unreferenced and the GC removes them).
      await client.query('DELETE FROM ide_extension_blobs WHERE extension_id = $1 AND version <> $2', [
        id,
        meta.version,
      ]);
      for (const s of stored) {
        await client.query(
          `INSERT INTO ide_extension_blobs (extension_id, version, target_platform, blob_key, sha256, size_bytes,
             signature, key_id, key_fingerprint, key_pinned, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'ed25519', $7, $8, $9, $10)
           ON CONFLICT (extension_id, version, target_platform) DO UPDATE SET blob_key = EXCLUDED.blob_key,
             sha256 = EXCLUDED.sha256, size_bytes = EXCLUDED.size_bytes, key_id = EXCLUDED.key_id,
             key_fingerprint = EXCLUDED.key_fingerprint, key_pinned = EXCLUDED.key_pinned,
             fetched_at = EXCLUDED.fetched_at`,
          [id, meta.version, s.target, s.key, s.sha256, s.size, s.keyId, s.fp, s.pinned, now],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    await this.#audit(actor, 'ide.extension.allow', `ide-extension:${id}`, {
      version: meta.version,
      pinned: input.version !== undefined,
      registry,
      targets: stored.map((s) => s.target),
      sha256: stored.map((s) => s.sha256),
      keyPinned: stored.every((s) => s.pinned),
      publisherVerified: meta.verified,
    });
    const view = (await this.list()).find((e) => e.id === id);
    if (view === undefined) throw new Error('allowed extension vanished');
    return view;
  }

  async remove(actor: Actor, rawId: string): Promise<void> {
    const id = rawId.toLowerCase();
    const { rowCount } = await this.deps.pool.query('DELETE FROM ide_extensions WHERE id = $1', [id]);
    if (rowCount === 0)
      throw new HttpError(
        404,
        'ide_extension_not_found',
        'This extension is not allowed.',
        {},
        {},
        {
          reason: 'not_allowed',
        },
      );
    await this.#audit(actor, 'ide.extension.remove', `ide-extension:${id}`, {});
  }

  // ============================================================================================= project policy

  async projectPolicy(project: string): Promise<ProjectPolicyView> {
    const { rows } = await this.deps.pool.query<{
      required: unknown;
      recommended: unknown;
      deny: unknown;
      enforced_settings: Record<string, unknown>;
      updated_at: Date;
    }>(
      'SELECT required, recommended, deny, enforced_settings, updated_at FROM ide_extension_policy WHERE project = $1',
      [project],
    );
    const r = rows[0];
    return {
      required: json(r?.required),
      recommended: json(r?.recommended),
      deny: json(r?.deny),
      enforcedSettings: r?.enforced_settings ?? {},
      updatedAt: r?.updated_at.toISOString() ?? null,
    };
  }

  async setProjectPolicy(
    actor: Actor,
    project: string,
    input: {
      readonly required: readonly string[];
      readonly recommended: readonly string[];
      readonly deny: readonly string[];
      readonly enforcedSettings: Readonly<Record<string, unknown>>;
    },
  ): Promise<ProjectPolicyView> {
    const required = normalizeIds(input.required, 'required');
    const recommended = normalizeIds(input.recommended, 'recommended').filter((x) => !required.includes(x));
    const deny = normalizeIds(input.deny, 'deny');
    if (required.length > 100 || recommended.length > 100 || deny.length > IDE_EXTENSION_LIMITS.allowlist)
      throw tooMany();
    const allowed = new Set((await this.list()).map((e) => e.id));
    const unknown = [...required, ...recommended].filter((x) => !allowed.has(x));
    if (unknown.length > 0) {
      throw new HttpError(
        409,
        'ide_extension_not_allowed',
        `Not on the allowlist (Ayarlar → Geliştirme ortamı): ${unknown.slice(0, 5).join(', ')}.`,
      );
    }
    const clash = [...required, ...recommended].filter((x) => deny.includes(x));
    if (clash.length > 0)
      throw new HttpError(
        409,
        'ide_extension_denied',
        `Both listed and denied: ${clash.slice(0, 5).join(', ')}.`,
      );
    const enforced = input.enforcedSettings;
    if (Buffer.byteLength(JSON.stringify(enforced), 'utf8') > IDE_EXTENSION_LIMITS.enforcedMaxBytes)
      throw new HttpError(400, 'ide_settings_too_large', 'Enforced settings are at most 32 KiB.');
    if (Object.keys(enforced).some((k) => k.length === 0 || k.length > 200))
      throw new HttpError(400, 'ide_settings_invalid', 'A setting name has 1-200 characters.');
    const secret = checkSettingsText(JSON.stringify(enforced), (t) => detectSecrets(t));
    if (!secret.ok)
      throw new HttpError(
        400,
        'ide_settings_secret',
        'An enforced setting looks like a secret; secrets never go into settings.',
      );
    await this.deps.pool.query(
      `INSERT INTO ide_extension_policy (project, required, recommended, deny, enforced_settings, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ((coalesce(project, ''))) DO UPDATE SET required = EXCLUDED.required,
         recommended = EXCLUDED.recommended, deny = EXCLUDED.deny, enforced_settings = EXCLUDED.enforced_settings,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [
        project,
        JSON.stringify(required),
        JSON.stringify(recommended),
        JSON.stringify(deny),
        JSON.stringify(enforced),
        actor.id,
        this.deps.clock(),
      ],
    );
    await this.#audit(actor, 'ide.policy.project', `project:${project}`, {
      project,
      required,
      recommended,
      denied: deny,
      enforcedKeys: Object.keys(enforced).slice(0, 50),
    });
    return this.projectPolicy(project);
  }

  // ============================================================================================= user

  async #userRow(userId: string): Promise<{
    extensions: string[];
    settings: string | null;
    keybindings: string | null;
    settings_updated_at: Date | null;
  } | null> {
    const { rows } = await this.deps.pool.query<{
      extensions: unknown;
      settings: string | null;
      keybindings: string | null;
      settings_updated_at: Date | null;
    }>(
      'SELECT extensions, settings, keybindings, settings_updated_at FROM ide_user_settings WHERE user_id = $1',
      [userId],
    );
    const r = rows[0];
    return r === undefined ? null : { ...r, extensions: json(r.extensions) };
  }

  async userView(userId: string, project: string): Promise<UserExtensionsView> {
    const [list, global, proj, mine] = await Promise.all([
      this.list(),
      this.globalPolicy(),
      this.projectPolicy(project),
      this.#userRow(userId),
    ]);
    const input = { allowlist: await this.#allowlist(), global, project: proj };
    const available = list
      .filter((e) => denial(e.id, input) === null)
      .map((e) => ({
        ...e,
        required: proj.required.includes(e.id),
        recommended: proj.recommended.includes(e.id),
      }));
    const own = mine?.extensions ?? [];
    return {
      available,
      mine: own,
      required: proj.required.filter((id) => denial(id, input) === null),
      recommended: proj.recommended.filter((id) => denial(id, input) === null),
      blocked: own
        .map((id) => ({ id, reason: denial(id, input) }))
        .filter((x): x is { id: string; reason: NonNullable<typeof x.reason> } => x.reason !== null),
      settings: {
        settingsBytes:
          mine?.settings === null || mine === null ? null : Buffer.byteLength(mine.settings, 'utf8'),
        keybindingsBytes:
          mine?.keybindings === null || mine === null ? null : Buffer.byteLength(mine.keybindings, 'utf8'),
        updatedAt: mine?.settings_updated_at?.toISOString() ?? null,
      },
    };
  }

  /** The user's own list: only allowed extensions (the project's deny is applied at each start). */
  async setUserExtensions(actor: Actor, ids: readonly string[]): Promise<string[]> {
    const list = normalizeIds(ids, 'extensions');
    if (list.length > IDE_EXTENSION_LIMITS.perUser) throw tooMany();
    const global = await this.globalPolicy();
    const input = { allowlist: await this.#allowlist(), global, project: null };
    const refused = list.filter((id) => denial(id, input) !== null);
    if (refused.length > 0) {
      throw new HttpError(
        409,
        'ide_extension_not_allowed',
        `Not allowed by the administrator: ${refused.slice(0, 5).join(', ')}.`,
      );
    }
    await this.deps.pool.query(
      `INSERT INTO ide_user_settings (user_id, extensions, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET extensions = EXCLUDED.extensions, updated_at = EXCLUDED.updated_at`,
      [actor.id, JSON.stringify(list), this.deps.clock()],
    );
    await this.#audit(actor, 'ide.extensions.user', `user:${actor.id}`, { extensions: list });
    return list;
  }

  async resetSettings(actor: Actor): Promise<void> {
    await this.deps.pool.query(
      `UPDATE ide_user_settings SET settings = NULL, keybindings = NULL, settings_updated_at = NULL, updated_at = $2
        WHERE user_id = $1`,
      [actor.id, this.deps.clock()],
    );
    await this.#audit(actor, 'ide.settings.reset', `user:${actor.id}`, {});
  }

  /**
   * The bridge saves a settings file of the workspace owner. A secret-looking value or a file over 256 KiB is refused
   * (audited, never stored); the answer is the IDE notice text.
   */
  async saveSettings(
    workerId: string,
    workspace: { readonly id: string; readonly userId: string; readonly project: string },
    file: 'settings' | 'keybindings',
    content: string,
  ): Promise<{ ok: boolean; message: string }> {
    const check = checkSettingsText(content, (t) => detectSecrets(t));
    if (!check.ok) {
      await this.#audit(
        { type: 'worker', id: workerId },
        'ide.settings.refused',
        `ide:${workspace.id}`,
        {
          owner: workspace.userId,
          project: workspace.project,
          file,
          reason: check.reason,
          kind: check.provider ?? null,
        },
        'denied',
      );
      return {
        ok: false,
        message:
          check.reason === 'secret'
            ? 'Ayarlar kaydedilmedi: gizli bilgiye (anahtar, token) benzeyen bir değer var. Gizli bilgiler ayarlara yazılmaz.'
            : 'Ayarlar kaydedilmedi: dosya 256 KiB sınırını aşıyor.',
      };
    }
    const col = file === 'settings' ? 'settings' : 'keybindings';
    const now = this.deps.clock();
    await this.deps.pool.query(
      `INSERT INTO ide_user_settings (user_id, ${col}, settings_updated_at, updated_at) VALUES ($1, $2, $3, $3)
       ON CONFLICT (user_id) DO UPDATE SET ${col} = EXCLUDED.${col}, settings_updated_at = EXCLUDED.settings_updated_at,
         updated_at = EXCLUDED.updated_at`,
      [workspace.userId, content, now],
    );
    return { ok: true, message: file === 'settings' ? 'Ayarlar kaydedildi.' : 'Kısayollar kaydedildi.' };
  }

  async syncedSettings(userId: string): Promise<{ settings: string | null; keybindings: string | null }> {
    const r = await this.#userRow(userId);
    return { settings: r?.settings ?? null, keybindings: r?.keybindings ?? null };
  }

  // ============================================================================================= workspace start

  /** The profile of a start of `userId`'s workspace in `project` on a machine (`os`/`arch` from its facts). */
  async profileFor(input: {
    readonly project: string;
    readonly userId: string;
    readonly os: string | null;
    readonly arch: string | null;
  }): Promise<{ profile: IdeProfile; skipped: readonly { id: string; reason: SkipReason }[] }> {
    const [allowlist, global, proj, mine] = await Promise.all([
      this.#allowlist(),
      this.globalPolicy(),
      this.projectPolicy(input.project),
      this.#userRow(input.userId),
    ]);
    return resolveProfile({
      allowlist,
      global,
      project: proj,
      user: mine?.extensions ?? [],
      target: ideTarget(input.os, input.arch),
      settingsSync: true,
    });
  }

  // ============================================================================================= worker downloads

  /** A download token for one start: exactly these blobs and the owner's settings, this worker, 30 minutes. */
  issueToken(grant: {
    workerId: string;
    workspaceId: string;
    userId: string;
    shas: readonly string[];
  }): string {
    const now = this.deps.clock().getTime();
    for (const [k, g] of this.#grants) if (g.expiresAt <= now) this.#grants.delete(k);
    const token = randomBytes(32).toString('base64url');
    this.#grants.set(createHash('sha256').update(token).digest('hex'), {
      workerId: grant.workerId,
      workspaceId: grant.workspaceId,
      userId: grant.userId,
      shas: new Set(grant.shas),
      expiresAt: now + (this.deps.tokenTtlMs ?? 30 * 60_000),
    });
    return token;
  }

  #grant(header: string | undefined): Grant | null {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? '')?.[1];
    if (token === undefined) return null;
    const g = this.#grants.get(createHash('sha256').update(token).digest('hex'));
    if (g === undefined || g.expiresAt <= this.deps.clock().getTime()) return null;
    return g;
  }

  /** `GET /v1/worker/ide/extensions/:sha256`: the cached VSIX when the token grants it. */
  async download(
    header: string | undefined,
    sha256: string,
  ): Promise<
    | { status: 'unauthorized' }
    | { status: 'not_found' }
    | { status: 'ok'; stream: Readable; size: number; workerId: string }
  > {
    const g = this.#grant(header);
    if (g === null || !/^[0-9a-f]{64}$/.test(sha256) || !g.shas.has(sha256))
      return { status: 'unauthorized' };
    const blobs = this.deps.blobs();
    const { rows } = await this.deps.pool.query<{ blob_key: string }>(
      'SELECT blob_key FROM ide_extension_blobs WHERE sha256 = $1 LIMIT 1',
      [sha256],
    );
    const key = rows[0]?.blob_key;
    if (key === undefined || blobs === null) return { status: 'not_found' };
    try {
      const s = await blobs.stream(key);
      return { status: 'ok', stream: s.stream, size: s.size, workerId: g.workerId };
    } catch {
      return { status: 'not_found' };
    }
  }

  /** `GET /v1/worker/ide/settings/:workspaceId`: the owner's synced settings when the token is that start's. */
  async downloadSettings(
    header: string | undefined,
    workspaceId: string,
  ): Promise<{ settings: string | null; keybindings: string | null } | null> {
    const g = this.#grant(header);
    if (g?.workspaceId !== workspaceId) return null;
    return this.syncedSettings(g.userId);
  }
}
