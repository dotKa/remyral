import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { type SecretBox, SecretBoxError } from '../auth/secret-box.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { CoolifyClient, coolifyFeatures, type CoolifyPermissionProbe, ProviderCallError } from './coolify.js';
import { checkBaseUrl, type OpsFetch } from './http.js';
import { OpsError } from './model.js';
import { coolifyDenyReason } from './policy.js';

/**
 * p13-multi-coolify (ADR-0050): several Coolify connections. Each connection is an API base URL (SSRF rules of
 * ADR-0028 §5), an optional team, a master-held token (AES-256-GCM under the HKDF sub-key `ops-integrations`, AAD
 * `coolify-connection:<id>`; the token migrated from the single p6 integration keeps its AAD `ops-integration:coolify`
 * until replaced), extra control-plane resources, the projects that may use it and a default flag. The token is never
 * returned, logged, audited, sent to a worker or shown to the assistant. The control-plane deny-list of the
 * environment applies to every connection.
 */

const aadOf = (id: string): string => `coolify-connection:${id}`;
/** The AAD of the token migrated from the single p6 integration (migration 0097), kept until the token is replaced. */
const LEGACY_AAD = 'ops-integration:coolify';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

const Label = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'no control characters');
const DenyList = z.array(z.string().regex(/^[A-Za-z0-9]{6,64}$/)).max(50);
/** Tokens: printable, no whitespace (Coolify `<id>|<random>`). */
const ApiToken = z.string().regex(/^[\x21-\x7e]{20,512}$/, 'API token');

/** Stored (non-secret) settings of a connection. */
export const CoolifyConnectionSettings = z.strictObject({
  url: z.string().min(8).max(300),
  team: z.string().max(200).nullable().default(null),
  denyResources: DenyList.default([]),
  /** Where "Open Coolify" goes in the browser (https, no credentials); null: the API base when it is https. */
  openUrl: z.string().max(300).nullable().default(null),
  /** "Open Coolify" through the server's SSO gate (only effective while the gate is configured). */
  useServerSso: z.boolean().default(false),
});
export type CoolifyConnectionSettings = z.infer<typeof CoolifyConnectionSettings>;

export const CoolifyConnectionCreate = z.strictObject({
  label: Label,
  url: z.string().min(8).max(300),
  team: z.string().max(200).nullable().optional(),
  denyResources: DenyList.optional(),
  openUrl: z.string().max(300).nullable().optional(),
  useServerSso: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  allProjects: z.boolean().optional(),
  projects: z.array(z.string().regex(PROJECT)).max(500).optional(),
  /** p15-coolify-create (ADR-0057): Remyral may create applications and change their variables / domains. */
  manageApps: z.boolean().optional(),
  token: z.string().min(1).max(512),
});
export const CoolifyConnectionUpdate = CoolifyConnectionCreate.partial();
export type CoolifyConnectionUpdate = z.infer<typeof CoolifyConnectionUpdate>;

export interface CoolifyConnectionView {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly host: string;
  readonly team: string | null;
  readonly denyResources: string[];
  readonly openUrl: string | null;
  readonly useServerSso: boolean;
  readonly isDefault: boolean;
  readonly allProjects: boolean;
  readonly projects: string[];
  /** p15-coolify-create: Remyral may create applications and change their variables and domains here. */
  readonly manageApps: boolean;
  /** Projects whose deploy targets use this connection, with the environments. */
  readonly usedBy: { project: string; envs: string[] }[];
  readonly keyFingerprint: string;
  /** The stored token decrypts with the current master key. */
  readonly usable: boolean;
  /** Informational: this connection reaches the control-plane Coolify (the refusal does not depend on it). */
  readonly controlPlane: boolean;
  readonly lastTest: Record<string, unknown> | null;
  readonly lastTestAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a project may use (no URL path, no token). */
export interface CoolifyConnectionChoice {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly isDefault: boolean;
}

/** A usable connection: the client with the decrypted token. */
export interface CoolifyHandle {
  readonly id: string;
  readonly label: string;
  readonly client: CoolifyClient;
  readonly settings: CoolifyConnectionSettings;
  /** p15-coolify-create (ADR-0057): creating / changing applications is allowed on this connection. */
  readonly manageApps: boolean;
  /**
   * p17-coolify-full: what the last "Test connection" found — the instance version (features such as storages depend
   * on it) and the token's abilities (a write the token cannot do is refused before calling Coolify). null: no test.
   */
  readonly lastTest?: {
    readonly version: string | null;
    readonly permissions: CoolifyPermissionProbe | null;
  } | null;
}

export interface ConnectionActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface CoolifyConnectionsDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  /** The `ops-integrations` box (already derived). */
  readonly box: SecretBox;
  readonly clock: () => Date;
  readonly fetch: OpsFetch;
  readonly internalOrigins: ReadonlySet<string>;
  readonly controlPlaneResources: readonly string[];
  readonly protectedHosts: readonly string[];
  /** COOLIFY_SSO_HOST (the server's SSO gate), for the informational control-plane flag. */
  readonly ssoHost?: string | null;
}

interface Row {
  id: string;
  label: string;
  config: Record<string, unknown>;
  secret: Buffer;
  secret_aad: string;
  key_fingerprint: string;
  is_default: boolean;
  all_projects: boolean;
  manage_apps: boolean;
  last_test: Record<string, unknown> | null;
  last_test_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = `id::text AS id, label, config, secret, secret_aad, key_fingerprint, is_default, all_projects, manage_apps,
  last_test, last_test_at, created_at, updated_at`;

export const fingerprintOf = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** A browser link: https, no credentials, no fragment. */
function safeOpenUrl(raw: string | null | undefined): { readonly url: string | null } | null {
  if (raw === null || raw === undefined || raw.trim() === '') return { url: null };
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.hash !== '') return null;
    return { url: u.href };
  } catch {
    return null;
  }
}

export class CoolifyConnections {
  constructor(private readonly deps: CoolifyConnectionsDeps) {}

  // ------------------------------------------------------------------------------------------- reads

  async #rows(where = '', params: unknown[] = [], q: Queryable = this.deps.pool): Promise<Row[]> {
    const { rows } = await q.query<Row>(
      `SELECT ${COLS} FROM coolify_connections ${where} ORDER BY is_default DESC, label`,
      params,
    );
    return rows;
  }

  async #row(id: string, q: Queryable = this.deps.pool): Promise<Row | null> {
    if (!UUID.test(id)) return null;
    return (await this.#rows('WHERE id = $1', [id], q))[0] ?? null;
  }

  #token(row: Row): string | null {
    // The AAD binds the token to its row: derived from the id, never taken from the database alone. The stored
    // value must equal it — or be the AAD of the token migrated from the single p6 integration (until replaced).
    // Anything else (rows' secrets swapped or copied in the database) is unusable, like a token that does not decrypt.
    const aad = row.secret_aad === LEGACY_AAD ? LEGACY_AAD : aadOf(row.id);
    if (row.secret_aad !== aad) return null;
    try {
      return this.deps.box.decrypt(row.secret, aad).toString('utf8');
    } catch (err) {
      if (err instanceof SecretBoxError) return null;
      throw err;
    }
  }

  #settings(row: Row): CoolifyConnectionSettings | null {
    const p = CoolifyConnectionSettings.safeParse(row.config);
    return p.success ? p.data : null;
  }

  async #projectsOf(ids: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    const { rows } = await this.deps.pool.query<{ id: string; project: string }>(
      `SELECT connection_id::text AS id, project FROM coolify_connection_projects
        WHERE connection_id = ANY($1::uuid[]) ORDER BY project`,
      [ids],
    );
    for (const r of rows) out.set(r.id, [...(out.get(r.id) ?? []), r.project]);
    return out;
  }

  /** Which projects' deploy targets name each connection (default-resolved: null means the default). */
  async #usage(defaultId: string | null): Promise<Map<string, { project: string; envs: string[] }[]>> {
    const { rows } = await this.deps.pool.query<{ project: string; config: Record<string, unknown> }>(
      `SELECT project, config FROM project_deploy_targets WHERE config ? 'coolify' ORDER BY project`,
    );
    const out = new Map<string, { project: string; envs: string[] }[]>();
    for (const r of rows) {
      const c = r.config.coolify as Record<string, unknown> | null | undefined;
      if (c === null || c === undefined || typeof c !== 'object') continue;
      for (const env of ['preview', 'production']) {
        const t = c[env] as { connection?: unknown } | null | undefined;
        if (t === null || t === undefined || typeof t !== 'object') continue;
        const id = typeof t.connection === 'string' ? t.connection : defaultId;
        if (id === null) continue;
        const list = out.get(id) ?? [];
        const e = list.find((x) => x.project === r.project);
        if (e === undefined) list.push({ project: r.project, envs: [env] });
        else e.envs.push(env);
        out.set(id, list);
      }
    }
    return out;
  }

  #controlPlane(row: Row, s: CoolifyConnectionSettings | null): boolean {
    if (s === null) return false;
    let origin = '';
    let host = '';
    try {
      const u = new URL(s.url);
      origin = u.origin;
      host = u.hostname.toLowerCase();
    } catch {
      // not a URL: no flag
    }
    if (origin !== '' && this.deps.internalOrigins.has(origin)) return true;
    const sso = this.deps.ssoHost?.toLowerCase() ?? null;
    if (sso !== null && host === sso) return true;
    const n = row.last_test?.controlPlaneResources;
    return typeof n === 'number' && n > 0;
  }

  async list(): Promise<CoolifyConnectionView[]> {
    const rows = await this.#rows();
    const projects = await this.#projectsOf(rows.map((r) => r.id));
    const usage = await this.#usage(rows.find((r) => r.is_default)?.id ?? null);
    return rows.map((r) => this.#view(r, projects.get(r.id) ?? [], usage.get(r.id) ?? []));
  }

  async get(id: string): Promise<CoolifyConnectionView | null> {
    const r = await this.#row(id);
    if (r === null) return null;
    const projects = await this.#projectsOf([r.id]);
    const def = (await this.#rows('WHERE is_default'))[0]?.id ?? null;
    return this.#view(r, projects.get(r.id) ?? [], (await this.#usage(def)).get(r.id) ?? []);
  }

  #view(
    r: Row,
    projects: readonly string[],
    usedBy: readonly { project: string; envs: string[] }[],
  ): CoolifyConnectionView {
    const s = this.#settings(r);
    const url = s?.url ?? '';
    return {
      id: r.id,
      label: r.label,
      url,
      host: hostOf(url),
      team: s?.team ?? null,
      denyResources: s?.denyResources ?? [],
      openUrl: s?.openUrl ?? null,
      useServerSso: s?.useServerSso ?? false,
      isDefault: r.is_default,
      allProjects: r.all_projects,
      projects: [...projects],
      manageApps: r.manage_apps,
      usedBy: usedBy.map((u) => ({ project: u.project, envs: [...u.envs] })),
      keyFingerprint: r.key_fingerprint,
      usable: this.#token(r) !== null,
      controlPlane: this.#controlPlane(r, s),
      lastTest: r.last_test,
      lastTestAt: r.last_test_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  async defaultId(): Promise<string | null> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      'SELECT id::text AS id FROM coolify_connections WHERE is_default',
    );
    return rows[0]?.id ?? null;
  }

  /** Whether `project` may use the connection (its `allProjects` flag or an explicit assignment). */
  async mayUse(id: string, project: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const { rows } = await this.deps.pool.query<{ ok: boolean }>(
      `SELECT c.all_projects OR EXISTS (SELECT 1 FROM coolify_connection_projects p
                                          WHERE p.connection_id = c.id AND p.project = $2) AS ok
         FROM coolify_connections c WHERE c.id = $1`,
      [id, project],
    );
    return rows[0]?.ok === true;
  }

  /** The connections a project may use (id, label, host, default) — for target editors and monitor forms. */
  async forProject(project: string): Promise<CoolifyConnectionChoice[]> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      label: string;
      config: Record<string, unknown>;
      is_default: boolean;
    }>(
      `SELECT c.id::text AS id, c.label, c.config, c.is_default FROM coolify_connections c
        WHERE c.all_projects OR EXISTS (SELECT 1 FROM coolify_connection_projects p
                                          WHERE p.connection_id = c.id AND p.project = $1)
        ORDER BY c.is_default DESC, c.label`,
      [project],
    );
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      host: hostOf(typeof r.config.url === 'string' ? r.config.url : ''),
      isDefault: r.is_default,
    }));
  }

  /** Labels by id (for status texts and diffs). */
  async labels(): Promise<Map<string, string>> {
    const { rows } = await this.deps.pool.query<{ id: string; label: string }>(
      'SELECT id::text AS id, label FROM coolify_connections',
    );
    return new Map(rows.map((r) => [r.id, r.label]));
  }

  /** The client of a connection (null id: the default), or null when it does not exist / cannot be used. */
  async handle(id: string | null): Promise<CoolifyHandle | null> {
    const row = id === null ? ((await this.#rows('WHERE is_default'))[0] ?? null) : await this.#row(id);
    if (row === null) return null;
    const token = this.#token(row);
    const settings = this.#settings(row);
    if (token === null || settings === null) return null;
    const url = checkBaseUrl(settings.url, this.deps.internalOrigins);
    if (!url.ok) return null;
    return {
      id: row.id,
      label: row.label,
      client: new CoolifyClient({ baseUrl: url.url, token, fetch: this.deps.fetch }),
      settings,
      manageApps: row.manage_apps,
      lastTest: lastTestOf(row.last_test),
    };
  }

  /**
   * The connection an ops action of `project` uses: `id` (null: the default). Throws OpsError when there is none, it
   * was removed, its token cannot be decrypted or the project may not use it.
   */
  async forAction(project: string, id: string | null): Promise<CoolifyHandle> {
    const wanted = id ?? (await this.defaultId());
    if (wanted === null) {
      throw new OpsError(
        409,
        'coolify_not_configured',
        'Coolify is not connected (Settings → Integrations).',
      );
    }
    const row = await this.#row(wanted);
    if (row === null) {
      throw new OpsError(
        409,
        'coolify_connection_removed',
        'The Coolify connection of this target was removed; choose another one (Project → Deploy).',
      );
    }
    if (!(await this.mayUse(wanted, project))) {
      throw new OpsError(
        403,
        'coolify_connection_not_allowed',
        `Project ${project} may not use the Coolify connection “${row.label}” (Settings → Integrations → Coolify).`,
      );
    }
    const h = await this.handle(wanted);
    if (h === null) {
      throw new OpsError(
        409,
        'coolify_not_configured',
        `The Coolify connection “${row.label}” cannot be used (its token does not decrypt with the master key, or its URL is refused) — enter the token again.`,
      );
    }
    return h;
  }

  /**
   * p13-multi-coolify: the connection of a Coolify uptime monitor of `project` watching `uuid`: the given one (must be
   * allowed), else the project's deploy-target connection that lists the uuid, else its only usable connection, else
   * the default when allowed. Throws `Error` with a user-facing message.
   */
  async resolveForMonitor(project: string, uuid: string, connection: string | null): Promise<string> {
    if (connection !== null) {
      if (!(await this.mayUse(connection, project))) {
        throw new Error(
          'This project may not use that Coolify connection (Settings → Integrations → Coolify).',
        );
      }
      return connection;
    }
    const usable = await this.forProject(project);
    if (usable.length === 0) throw new Error('No Coolify connection is available to this project.');
    const { rows } = await this.deps.pool.query<{ config: Record<string, unknown> }>(
      'SELECT config FROM project_deploy_targets WHERE project = $1',
      [project],
    );
    const coolify = (rows[0]?.config.coolify ?? null) as Record<
      string,
      { connection?: unknown; uuids?: unknown } | null | undefined
    > | null;
    const def = usable.find((c) => c.isDefault) ?? null;
    for (const env of ['preview', 'production']) {
      const t = coolify?.[env] ?? null;
      if (t === null || !Array.isArray(t.uuids) || !t.uuids.includes(uuid)) continue;
      const id = typeof t.connection === 'string' ? t.connection : (def?.id ?? null);
      if (id !== null && usable.some((c) => c.id === id)) return id;
    }
    if (usable.length === 1 && usable[0] !== undefined) return usable[0].id;
    if (def !== null) return def.id;
    throw new Error('Choose the Coolify connection of this application (the project may use several).');
  }

  /** The deny-list of a connection: the environment's control-plane uuids (always) + the connection's own. */
  denyUuids(settings: CoolifyConnectionSettings | null): Set<string> {
    return new Set([...this.deps.controlPlaneResources, ...(settings?.denyResources ?? [])]);
  }

  // ------------------------------------------------------------------------------------------ writes

  #checkUrl(raw: string): string {
    const url = checkBaseUrl(raw, this.deps.internalOrigins);
    if (!url.ok) throw new OpsError(400, 'invalid_url', `Coolify URL refused: ${url.reason}.`);
    return url.url;
  }

  #checkToken(raw: string): string {
    const t = ApiToken.safeParse(raw);
    if (!t.success) throw new OpsError(400, 'invalid_token', 'Invalid API token.');
    return t.data;
  }

  async #checkProjects(q: Queryable, projects: readonly string[]): Promise<string[]> {
    const unique = [...new Set(projects)].sort();
    if (unique.length === 0) return unique;
    const { rows } = await q.query<{ id: string }>('SELECT id FROM projects WHERE id = ANY($1::text[])', [
      unique,
    ]);
    const known = new Set(rows.map((r) => r.id));
    const missing = unique.find((p) => !known.has(p));
    if (missing !== undefined) throw new OpsError(400, 'unknown_project', `Unknown project ${missing}.`);
    return unique;
  }

  async #setProjects(q: Queryable, id: string, projects: readonly string[]): Promise<void> {
    await q.query('DELETE FROM coolify_connection_projects WHERE connection_id = $1', [id]);
    if (projects.length > 0) {
      await q.query(
        `INSERT INTO coolify_connection_projects (connection_id, project)
         SELECT $1, unnest($2::text[])`,
        [id, projects],
      );
    }
  }

  #labelTaken(err: unknown): boolean {
    const e = err as { code?: string; constraint?: string };
    return e.code === '23505' && (e.constraint ?? '').includes('label');
  }

  async create(actor: ConnectionActor, input: unknown): Promise<CoolifyConnectionView> {
    const p = CoolifyConnectionCreate.safeParse(input);
    if (!p.success) {
      throw new OpsError(
        400,
        'invalid_settings',
        `Invalid Coolify connection: ${p.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`.slice(0, 500),
      );
    }
    const i = p.data;
    const url = this.#checkUrl(i.url);
    const openUrl = safeOpenUrl(i.openUrl);
    if (openUrl === null)
      throw new OpsError(400, 'invalid_open_url', 'Open URL: an https:// link without credentials.');
    const token = this.#checkToken(i.token);
    const id = randomUUID();
    const settings: CoolifyConnectionSettings = {
      url,
      team: i.team ?? null,
      denyResources: i.denyResources ?? [],
      openUrl: openUrl.url,
      useServerSso: i.useServerSso ?? false,
    };
    const now = this.deps.clock();
    const fp = fingerprintOf(token);
    try {
      await withTransaction(this.deps.pool, async (tx) => {
        const projects = await this.#checkProjects(tx, i.projects ?? []);
        const first = (await tx.query('SELECT 1 FROM coolify_connections LIMIT 1')).rowCount === 0;
        const makeDefault = i.isDefault === true || first;
        if (makeDefault) await tx.query('UPDATE coolify_connections SET is_default = false WHERE is_default');
        await tx.query(
          `INSERT INTO coolify_connections (id, label, config, secret, secret_aad, key_fingerprint, is_default,
             all_projects, updated_by, created_at, updated_at, manage_apps)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)`,
          [
            id,
            i.label,
            settings,
            this.deps.box.encrypt(Buffer.from(token, 'utf8'), aadOf(id)),
            aadOf(id),
            fp,
            makeDefault,
            i.allProjects ?? false,
            actor.userId,
            now,
            i.manageApps ?? false,
          ],
        );
        await this.#setProjects(tx, id, projects);
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: actor.userId },
            action: 'ops.coolify_connection.create',
            target: `coolify-connection:${id}`,
            outcome: 'success',
            ip: actor.ip ?? null,
            userAgent: actor.userAgent ?? null,
            metadata: {
              label: i.label,
              keyFingerprint: fp,
              settings,
              isDefault: makeDefault,
              allProjects: i.allProjects ?? false,
              projects,
              manageApps: i.manageApps ?? false,
            },
          },
          tx,
        );
      });
    } catch (err) {
      if (this.#labelTaken(err))
        throw new OpsError(409, 'label_taken', `A Coolify connection named “${i.label}” exists.`);
      throw err;
    }
    const v = await this.get(id);
    if (v === null) throw new Error('connection vanished');
    return v;
  }

  async update(actor: ConnectionActor, id: string, input: unknown): Promise<CoolifyConnectionView> {
    const p = CoolifyConnectionUpdate.safeParse(input);
    if (!p.success) {
      throw new OpsError(
        400,
        'invalid_settings',
        `Invalid Coolify connection: ${p.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`.slice(0, 500),
      );
    }
    const i = p.data;
    if (i.isDefault === false) {
      throw new OpsError(400, 'invalid_settings', 'Make another connection the default instead.');
    }
    const token = i.token === undefined ? undefined : this.#checkToken(i.token);
    const url = i.url === undefined ? undefined : this.#checkUrl(i.url);
    const openUrl = i.openUrl === undefined ? undefined : safeOpenUrl(i.openUrl);
    if (openUrl === null)
      throw new OpsError(400, 'invalid_open_url', 'Open URL: an https:// link without credentials.');
    if (!UUID.test(id)) throw new OpsError(404, 'connection_not_found', 'Coolify connection not found.');
    try {
      await withTransaction(this.deps.pool, async (tx) => {
        const cur = (
          await tx.query<Row>(`SELECT ${COLS} FROM coolify_connections WHERE id = $1 FOR UPDATE`, [id])
        ).rows[0];
        if (cur === undefined)
          throw new OpsError(404, 'connection_not_found', 'Coolify connection not found.');
        const old =
          this.#settings(cur) ?? CoolifyConnectionSettings.parse({ url: url ?? 'https://invalid.example' });
        const settings: CoolifyConnectionSettings = {
          url: url ?? old.url,
          team: i.team === undefined ? old.team : i.team,
          denyResources: i.denyResources ?? old.denyResources,
          openUrl: openUrl === undefined ? old.openUrl : openUrl.url,
          useServerSso: i.useServerSso ?? old.useServerSso,
        };
        const projects = i.projects === undefined ? undefined : await this.#checkProjects(tx, i.projects);
        if (i.isDefault === true && !cur.is_default) {
          await tx.query('UPDATE coolify_connections SET is_default = false WHERE is_default');
        }
        const now = this.deps.clock();
        const fp = token === undefined ? cur.key_fingerprint : fingerprintOf(token);
        // A new token or URL invalidates the last test result.
        const resetTest = token !== undefined || settings.url !== old.url || settings.team !== old.team;
        await tx.query(
          `UPDATE coolify_connections SET label = $2, config = $3, secret = $4, secret_aad = $5, key_fingerprint = $6,
             is_default = $7, all_projects = $8, last_test = $9, last_test_at = $10, updated_by = $11, updated_at = $12,
             manage_apps = $13
           WHERE id = $1`,
          [
            id,
            i.label ?? cur.label,
            settings,
            token === undefined ? cur.secret : this.deps.box.encrypt(Buffer.from(token, 'utf8'), aadOf(id)),
            token === undefined ? cur.secret_aad : aadOf(id),
            fp,
            i.isDefault === true ? true : cur.is_default,
            i.allProjects ?? cur.all_projects,
            resetTest ? null : cur.last_test,
            resetTest ? null : cur.last_test_at,
            actor.userId,
            now,
            i.manageApps ?? cur.manage_apps,
          ],
        );
        if (projects !== undefined) await this.#setProjects(tx, id, projects);
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: actor.userId },
            action: 'ops.coolify_connection.update',
            target: `coolify-connection:${id}`,
            outcome: 'success',
            ip: actor.ip ?? null,
            userAgent: actor.userAgent ?? null,
            metadata: {
              label: i.label ?? cur.label,
              keyFingerprint: fp,
              keyChanged: token !== undefined,
              previousKeyFingerprint: cur.key_fingerprint,
              settings,
              ...(i.isDefault === true && !cur.is_default ? { madeDefault: true } : {}),
              ...(i.allProjects === undefined ? {} : { allProjects: i.allProjects }),
              ...(projects === undefined ? {} : { projects }),
              ...(i.manageApps === undefined || i.manageApps === cur.manage_apps
                ? {}
                : { manageApps: i.manageApps }),
            },
          },
          tx,
        );
      });
    } catch (err) {
      if (this.#labelTaken(err))
        throw new OpsError(409, 'label_taken', `A Coolify connection named “${String(i.label)}” exists.`);
      throw err;
    }
    const v = await this.get(id);
    if (v === null) throw new Error('connection vanished');
    return v;
  }

  async remove(actor: ConnectionActor, id: string): Promise<void> {
    const cur = await this.get(id);
    const { rowCount } = UUID.test(id)
      ? await this.deps.pool.query('DELETE FROM coolify_connections WHERE id = $1', [id])
      : { rowCount: 0 };
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'ops.coolify_connection.remove',
      target: `coolify-connection:${id}`,
      outcome: (rowCount ?? 0) > 0 ? 'success' : 'failure',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata:
        cur === null
          ? {}
          : {
              label: cur.label,
              keyFingerprint: cur.keyFingerprint,
              wasDefault: cur.isDefault,
              usedBy: cur.usedBy.map((u) => u.project),
            },
    });
    if ((rowCount ?? 0) === 0)
      throw new OpsError(404, 'connection_not_found', 'Coolify connection not found.');
  }

  // ------------------------------------------------------------------------------------------- test

  /** "Test connection": version, team, permissions, visible applications and how many are control plane. */
  async test(actor: ConnectionActor, id: string): Promise<Record<string, unknown>> {
    const row = await this.#row(id);
    if (row === null) throw new OpsError(404, 'connection_not_found', 'Coolify connection not found.');
    let result: Record<string, unknown>;
    try {
      result = await this.#probe(id);
    } catch (err) {
      if (!(err instanceof ProviderCallError)) throw err;
      result = { ok: false, error: err.message, status: err.status, code: err.code };
    }
    await this.deps.pool.query(
      'UPDATE coolify_connections SET last_test = $2, last_test_at = $3 WHERE id = $1',
      [id, result, this.deps.clock()],
    );
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'ops.coolify_connection.test',
      target: `coolify-connection:${id}`,
      outcome: result.ok === true ? 'success' : 'failure',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { label: row.label, ok: result.ok === true, error: result.error ?? null },
    });
    return result;
  }

  async #probe(id: string): Promise<Record<string, unknown>> {
    const c = await this.handle(id);
    if (c === null)
      return { ok: false, error: 'The stored token cannot be used (master key changed?) — enter it again.' };
    const version = await c.client.version();
    const team = await c.client.team().catch((err: unknown) => {
      if (err instanceof ProviderCallError && err.code !== 'unauthorized') return null;
      throw err;
    });
    const perms = await c.client.probe();
    const apps = perms.read ? await c.client.applications() : [];
    const deny = this.denyUuids(c.settings);
    const consoleHosts = new Set(this.deps.protectedHosts.map((h) => h.toLowerCase()));
    const controlPlane = apps.filter(
      (a) => coolifyDenyReason(a, { denyUuids: deny, consoleHosts }) !== null,
    ).length;
    const warnings: string[] = [];
    if (!perms.read)
      warnings.push(
        'The token cannot read: Remyral must read a resource before deploying it (control-plane check). Add the "read" permission.',
      );
    if (perms.deploy === false)
      warnings.push('The token lacks the "deploy" permission: deploys and restarts will fail.');
    // p15-coolify-create (ADR-0057): `write` is needed exactly when the connection may manage applications.
    if (perms.write === true && !c.manageApps)
      warnings.push(
        'The token can write (or is root). Remyral needs only read + deploy; create a narrower token.',
      );
    if (perms.write === false && c.manageApps)
      warnings.push(
        'Creating applications is on for this connection, but the token lacks the "write" permission: creating applications and changing variables or domains will fail.',
      );
    // p17-coolify-full: logs of databases / services and storages depend on these.
    if (perms.readSensitive === false)
      warnings.push(
        'The token lacks the "read:sensitive" permission: application, database and service logs cannot be read.',
      );
    const features = coolifyFeatures(version);
    if (features.storages === 'none' || features.storages === 'read')
      warnings.push(
        `This Coolify (${version}) cannot ${features.storages === 'none' ? 'list or ' : ''}add persistent storages through its API (added in v4.0.0-beta.470): update Coolify, or add volumes in Coolify → the resource → Persistent Storage.`,
      );
    if (c.settings.team !== null && team !== null && team.name !== c.settings.team) {
      warnings.push(`The token belongs to team "${team.name}", not "${c.settings.team}".`);
    }
    return {
      ok: perms.read && perms.deploy !== false,
      version,
      team: team?.name ?? null,
      permissions: perms,
      features,
      applications: apps.length,
      controlPlaneResources: controlPlane,
      warnings,
    };
  }

  // ------------------------------------------------------------------------- legacy single integration

  /**
   * p6 `PUT /integrations/ops/coolify`: change the default connection (url, team, denyResources, token) — or create it
   * as "Sunucu Coolify (varsayılan)" when there is none (all projects, server SSO, like the migrated one).
   */
  async saveDefault(
    actor: ConnectionActor,
    input: { url: string; team?: string | null | undefined; denyResources?: string[] | undefined },
    token: string | undefined,
  ): Promise<CoolifyConnectionView> {
    const id = await this.defaultId();
    if (id === null) {
      if (token === undefined) throw new OpsError(400, 'token_required', 'Enter the API token.');
      let label = 'Sunucu Coolify (varsayılan)';
      const taken = new Set((await this.#rows()).map((r) => r.label));
      for (let n = 2; taken.has(label); n++) label = `Sunucu Coolify (varsayılan) ${String(n)}`;
      return this.create(actor, {
        label,
        url: input.url,
        team: input.team ?? null,
        denyResources: input.denyResources ?? [],
        useServerSso: true,
        allProjects: true,
        isDefault: true,
        token,
      });
    }
    return this.update(actor, id, {
      url: input.url,
      team: input.team ?? null,
      denyResources: input.denyResources ?? [],
      ...(token === undefined ? {} : { token }),
    });
  }
}

/** p17-coolify-full: the version and abilities of a stored test result (null: none, or a failed test). */
export function lastTestOf(
  t: Record<string, unknown> | null,
): { version: string | null; permissions: CoolifyPermissionProbe | null } | null {
  if (t === null || t.ok === undefined) return null;
  const p = t.permissions as Record<string, unknown> | null | undefined;
  const tri = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  return {
    version: typeof t.version === 'string' ? t.version.slice(0, 64) : null,
    permissions:
      p !== null && typeof p === 'object'
        ? {
            read: p.read === true,
            deploy: tri(p.deploy),
            write: tri(p.write),
            readSensitive: tri(p.readSensitive),
          }
        : null,
  };
}

/** The connection id recorded on an ops action's target (`target.connection.id`), or null. */
export function connectionIdOf(target: Record<string, unknown> | null | undefined): string | null {
  const c = target?.connection as { id?: unknown } | null | undefined;
  return c !== null && typeof c === 'object' && typeof c.id === 'string' && UUID.test(c.id) ? c.id : null;
}

/** The connection label recorded on an ops action's target, or null. */
export function connectionLabelOf(target: Record<string, unknown> | null | undefined): string | null {
  const c = target?.connection as { label?: unknown } | null | undefined;
  return c !== null && typeof c === 'object' && typeof c.label === 'string' ? c.label : null;
}
