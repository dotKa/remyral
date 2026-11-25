import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import { SecretBox, SecretBoxError } from '../auth/secret-box.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import {
  type PanelSection,
  SETTINGS,
  type SettingDef,
  type SettingValue,
  internalDefs,
  sectionDefs,
  settingDef,
} from './registry.js';

/**
 * p17-panel-settings (docs/design/p17-panel-settings.md §3): the master-stored settings that override environment
 * variables. Reads are synchronous from an in-memory copy (loaded at start, refreshed by the orchestrator tick when the
 * stored version changed, and at once after a save on this instance), so consumers read the effective value at use
 * time: a change applies without a restart wherever the consumer reads it per use; the catalog marks the others.
 *
 * Precedence per key: the panel value (a row) → the environment (its value or its default). Secrets: the sealed panel
 * value → the secret the environment provided (a file) → none. A secret never leaves this service except to its
 * consumer; views carry only "set" and the source.
 */

export type SettingSource = 'panel' | 'env';

/** The environment's value per key (its explicit value or its default); null: unset. */
export type PanelEnv = Readonly<Partial<Record<string, SettingValue | null>>>;
/** Secrets the environment provided (read from their files at start). */
export type PanelEnvSecrets = Readonly<Partial<Record<string, string | null>>>;

export interface SettingView {
  readonly key: string;
  readonly kind: SettingDef['kind'];
  readonly env: string;
  /** The effective value (null for a secret and for an unset value). */
  readonly value: SettingValue | null;
  /** The environment's value (null for a secret and when unset). */
  readonly envValue: SettingValue | null;
  readonly source: SettingSource;
  readonly options: readonly string[] | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly restart: boolean;
  readonly sensitive: boolean;
  /** Secrets: a value is in effect (from the panel or the environment). */
  readonly secretSet: boolean;
  readonly generated: 'random' | 'vapid' | 'ed25519' | null;
}

export interface SectionView {
  readonly section: PanelSection;
  readonly version: number;
  readonly fields: readonly SettingView[];
  readonly updatedAt: string | null;
}

export interface SectionUpdate {
  /** key → new value; null: remove the panel value (the environment applies again). */
  readonly values?: Readonly<Record<string, SettingValue | null>> | undefined;
  /** Secret key → new value; null: remove the panel value. */
  readonly secrets?: Readonly<Record<string, string | null>> | undefined;
  /** Secret keys the master generates now (a random 48-byte value / a VAPID key pair). */
  readonly generate?: readonly string[] | undefined;
  /** The panel's version the change was made on (a stale save is refused). */
  readonly version?: number | undefined;
}

export interface PanelActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/** Cross-field rules of a section, checked on the effective values after the change (throws HttpError 400). */
export type SectionValidator = (
  get: (key: string) => SettingValue | null,
  has: (key: string) => boolean,
) => void;

interface Row {
  key: string;
  value: SettingValue | null;
  sealed: Buffer | null;
  updated_at: Date;
}

export class PanelSettingsService {
  readonly #box: SecretBox;
  #rows = new Map<string, Row>();
  #version = -1;
  #listeners = new Set<(keys: readonly string[]) => void>();
  readonly #validators = new Map<PanelSection, SectionValidator>();

  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      /** 32-byte sub-key (`box.deriveKey('panel-settings')`). */
      readonly sealKey: Buffer;
      readonly env: PanelEnv;
      readonly envSecrets?: PanelEnvSecrets;
      readonly log?: { warn(obj: unknown, msg: string): void };
    },
  ) {
    this.#box = new SecretBox(deps.sealKey);
  }

  /** Registers the cross-field rules of a section (consumers add theirs at composition). */
  validator(section: PanelSection, fn: SectionValidator): void {
    this.#validators.set(section, fn);
  }

  /** Called with the changed keys after a save here or a reload that changed something. */
  onChange(fn: (keys: readonly string[]) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  get version(): number {
    return Math.max(this.#version, 0);
  }

  /** Loads the stored values (start; tests). */
  async load(): Promise<void> {
    const [{ rows }, state] = await Promise.all([
      this.deps.pool.query<Row>('SELECT key, value, sealed, updated_at FROM panel_settings'),
      this.deps.pool.query<{ version: number }>('SELECT version FROM panel_settings_state WHERE id = 1'),
    ]);
    const next = new Map<string, Row>();
    for (const r of rows) if (settingDef(r.key) !== undefined) next.set(r.key, r);
    const changed = [...new Set([...this.#rows.keys(), ...next.keys()])].filter(
      (k) => JSON.stringify(this.#rows.get(k) ?? null) !== JSON.stringify(next.get(k) ?? null),
    );
    this.#rows = next;
    this.#version = state.rows[0]?.version ?? 0;
    if (changed.length > 0) this.#emit(changed);
  }

  /** Orchestrator tick: reloads when another instance saved (cheap version check). Never throws. */
  async tick(): Promise<void> {
    try {
      const { rows } = await this.deps.pool.query<{ version: number }>(
        'SELECT version FROM panel_settings_state WHERE id = 1',
      );
      if ((rows[0]?.version ?? 0) !== this.#version) await this.load();
    } catch (err) {
      this.deps.log?.warn({ err }, 'panel settings reload failed');
    }
  }

  #emit(keys: readonly string[]): void {
    for (const fn of this.#listeners) {
      try {
        fn(keys);
      } catch (err) {
        this.deps.log?.warn({ err }, 'panel settings listener failed');
      }
    }
  }

  // ---------------------------------------------------------------- reads (synchronous)

  source(key: string): SettingSource {
    return this.#rows.has(key) ? 'panel' : 'env';
  }

  /** The effective value (panel → environment); null when neither sets it. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the setting's type
  value<T extends SettingValue>(key: string): T | null {
    const r = this.#rows.get(key);
    if (r !== undefined && r.value !== null) return r.value as T;
    const e = this.deps.env[key];
    return e === undefined || e === null ? null : (e as T);
  }

  /** The effective value or `fallback`. */
  get<T extends SettingValue>(key: string, fallback: T): T {
    return this.value<T>(key) ?? fallback;
  }

  /** The effective secret (panel → environment) — only for its consumer, never for a view. */
  secret(key: string): string | null {
    const r = this.#rows.get(key);
    if (r?.sealed !== undefined && r.sealed !== null) {
      try {
        return this.#box.decrypt(r.sealed, `panel-setting:${key}`).toString('utf8');
      } catch (err) {
        if (!(err instanceof SecretBoxError)) throw err;
        this.deps.log?.warn({ key }, 'a panel secret cannot be decrypted (master key changed?)');
        return null;
      }
    }
    return this.deps.envSecrets?.[key] ?? null;
  }

  secretSource(key: string): SettingSource | null {
    if (this.#rows.get(key)?.sealed != null) return 'panel';
    return (this.deps.envSecrets?.[key] ?? null) === null ? null : 'env';
  }

  // ---------------------------------------------------------------- views

  #field(d: SettingDef): SettingView {
    const secret = d.kind === 'secret';
    const envValue = secret ? null : (this.deps.env[d.key] ?? null);
    return {
      key: d.key,
      kind: d.kind,
      env: d.env,
      value: secret ? null : this.value(d.key),
      envValue,
      source: this.source(d.key),
      options: d.options ?? null,
      min: d.min ?? null,
      max: d.max ?? null,
      restart: d.restart === true,
      sensitive: d.sensitive === true,
      secretSet: secret ? this.secretSource(d.key) !== null : false,
      generated: d.generated ?? null,
    };
  }

  view(section: PanelSection): SectionView {
    const defs = sectionDefs(section);
    const times = defs.map((d) => this.#rows.get(d.key)?.updated_at.getTime() ?? 0).filter((t) => t > 0);
    return {
      section,
      version: this.version,
      fields: defs.map((d) => this.#field(d)),
      updatedAt: times.length === 0 ? null : new Date(Math.max(...times)).toISOString(),
    };
  }

  async history(limit = 20): Promise<
    readonly {
      version: number;
      section: string;
      changes: unknown;
      changedAt: string;
      changedBy: string | null;
    }[]
  > {
    const { rows } = await this.deps.pool.query<{
      version: number;
      section: string;
      changes: unknown;
      changed_at: Date;
      username: string | null;
    }>(
      `SELECT h.version, h.section, h.changes, h.changed_at, u.username
         FROM panel_settings_history h LEFT JOIN users u ON u.id = h.changed_by
        ORDER BY h.version DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map((r) => ({
      version: r.version,
      section: r.section,
      changes: r.changes,
      changedAt: r.changed_at.toISOString(),
      changedBy: r.username,
    }));
  }

  // ---------------------------------------------------------------- writes

  /**
   * Saves a section's changes (validated per key and across the section on the effective values), bumps the version,
   * writes the history and the audit entry (`settings.panel.update`: the keys, never a secret), applies them here at
   * once and tells the listeners. Returns what a generation produced for the owner to see once (a VAPID public key, a
   * generated webhook secret).
   */
  async update(
    actor: PanelActor,
    section: PanelSection | 'keys',
    input: SectionUpdate,
  ): Promise<{ view: SectionView | null; generated: Readonly<Record<string, string>> }> {
    // `keys`: the internal settings key rotation manages (never a section form).
    const defs = new Map(
      (section === 'keys' ? internalDefs() : sectionDefs(section)).map((d) => [d.key, d] as const),
    );
    const bad = (key: string, why: string): never => {
      throw new HttpError(400, 'invalid_panel_setting', `Invalid setting ${key}: ${why}.`, {}, {}, { key });
    };
    const values = new Map<string, SettingValue | null>();
    for (const [k, v] of Object.entries(input.values ?? {})) {
      const d = defs.get(k);
      if (d === undefined || d.kind === 'secret') bad(k, 'not a setting of this section');
      if (v === null) {
        values.set(k, null);
        continue;
      }
      const p = (d as SettingDef).schema.safeParse(v);
      if (!p.success) bad(k, p.error.issues[0]?.message ?? 'out of range');
      values.set(k, p.data as SettingValue);
    }
    const secrets = new Map<string, { plain: string | null; how: 'set' | 'generated' | 'cleared' }>();
    const generatedPublic: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.secrets ?? {})) {
      const d = defs.get(k);
      if (d?.kind !== 'secret') bad(k, 'not a secret of this section');
      if (v === null) {
        secrets.set(k, { plain: null, how: 'cleared' });
        continue;
      }
      const gen = (d as SettingDef).generated;
      if (gen === 'vapid' || gen === 'ed25519') bad(k, 'this key is generated by the server');
      const p = (d as SettingDef).schema.safeParse(v);
      if (!p.success) bad(k, p.error.issues[0]?.message ?? 'not accepted');
      secrets.set(k, { plain: v, how: 'set' });
    }
    for (const k of input.generate ?? []) {
      const d = defs.get(k);
      if (d?.kind !== 'secret' || d.generated === undefined) bad(k, 'cannot be generated');
      const g = generateSecret((d as SettingDef).generated ?? 'random');
      secrets.set(k, { plain: g.secret, how: 'generated' });
      // A VAPID key pair: its public key. A random secret the master made (the webhook HMAC key): the value itself,
      // shown once — receivers must be configured with it; it is never readable again.
      generatedPublic[k] = g.publicKey ?? g.secret;
    }
    if (values.size === 0 && secrets.size === 0) {
      throw new HttpError(400, 'invalid_panel_setting', 'Nothing to change.', {}, {}, { key: '' });
    }
    // Cross-field rules on the values as they would be.
    const after = (key: string): SettingValue | null => {
      if (values.has(key)) {
        const v = values.get(key) ?? null;
        return v === null ? (this.deps.env[key] ?? null) : v;
      }
      return this.value(key);
    };
    const hasSecret = (key: string): boolean => {
      const s = secrets.get(key);
      if (s !== undefined) return s.plain !== null || (this.deps.envSecrets?.[key] ?? null) !== null;
      return this.secretSource(key) !== null;
    };
    if (section !== 'keys') this.#validators.get(section)?.(after, hasSecret);

    const now = this.deps.clock();
    const changes: Record<string, unknown> = {};
    await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ version: number }>(
        'SELECT version FROM panel_settings_state WHERE id = 1 FOR UPDATE',
      );
      const current = rows[0]?.version ?? 0;
      if (input.version !== undefined && input.version !== current) {
        throw new HttpError(
          409,
          'panel_settings_stale',
          'The settings changed since this page loaded; reload and try again.',
        );
      }
      for (const [k, v] of values) {
        const before = this.#rows.get(k)?.value ?? null;
        if (v === null) {
          await tx.query('DELETE FROM panel_settings WHERE key = $1', [k]);
        } else {
          await tx.query(
            `INSERT INTO panel_settings (key, value, sealed, updated_at, updated_by) VALUES ($1, $2, NULL, $3, $4)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, sealed = NULL, updated_at = EXCLUDED.updated_at,
               updated_by = EXCLUDED.updated_by`,
            [k, JSON.stringify(v), now, actor.userId],
          );
        }
        if (JSON.stringify(before) !== JSON.stringify(v)) {
          changes[k] = { from: before, to: v };
        }
      }
      for (const [k, s] of secrets) {
        if (s.plain === null) {
          await tx.query('DELETE FROM panel_settings WHERE key = $1', [k]);
        } else {
          await tx.query(
            `INSERT INTO panel_settings (key, value, sealed, updated_at, updated_by) VALUES ($1, NULL, $2, $3, $4)
             ON CONFLICT (key) DO UPDATE SET value = NULL, sealed = EXCLUDED.sealed, updated_at = EXCLUDED.updated_at,
               updated_by = EXCLUDED.updated_by`,
            [k, this.#box.encrypt(Buffer.from(s.plain, 'utf8'), `panel-setting:${k}`), now, actor.userId],
          );
        }
        changes[k] = { secret: s.how };
      }
      const version = current + 1;
      await tx.query('UPDATE panel_settings_state SET version = $1 WHERE id = 1', [version]);
      await tx.query(
        `INSERT INTO panel_settings_history (version, section, changes, changed_at, changed_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [version, section, JSON.stringify(changes), now, actor.userId],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          action: 'settings.panel.update',
          target: `panel-settings:${section}`,
          outcome: 'success',
          metadata: {
            section,
            version,
            keys: Object.keys(changes),
            // Non-secret before / after values only (secrets: how they changed).
            changes,
          },
        },
        tx,
      );
    });
    // Reloading tells the listeners which keys changed.
    await this.load();
    return { view: section === 'keys' ? null : this.view(section), generated: generatedPublic };
  }
}

/** A secret the master makes itself: 48 random bytes (base64url) or a VAPID (EC P-256) key pair. */
export function generateSecret(kind: 'random' | 'vapid' | 'ed25519'): {
  secret: string;
  publicKey: string | null;
} {
  if (kind === 'random') return { secret: randomBytes(48).toString('base64url'), publicKey: null };
  if (kind === 'ed25519') {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
      secret: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      publicKey: String(publicKey.export({ format: 'jwk' }).x),
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  return { secret: pem, publicKey: Buffer.concat([Buffer.from([4]), x, y]).toString('base64url') };
}

/** Every key of the catalog (for the doctor / tests). */
export const ALL_KEYS: readonly string[] = SETTINGS.map((d) => d.key);
