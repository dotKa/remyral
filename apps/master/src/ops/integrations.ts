import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { SecretBox, SecretBoxError } from '../auth/secret-box.js';
import type { Pool } from '../db/pool.js';
import { CloudflareClient } from './cloudflare.js';
import { type CoolifyClient, ProviderCallError } from './coolify.js';
import { CoolifyConnections, type CoolifyConnectionView } from './coolify-connections.js';
import type { OpsFetch } from './http.js';
import { OpsError } from './model.js';

/**
 * p6-deploy-integrations: Settings → Integrations → Coolify / Cloudflare (ADR-0028 §Tokens).
 *
 * The tokens are master-held secrets in the sense of ADR-0006 §1 (amended by ADR-0028): AES-256-GCM under the HKDF
 * sub-key `ops-integrations` of the master key file, AAD `ops-integration:<provider>`, one row per provider. They
 * are never returned, logged, audited, sent to a worker, put in a job environment or shown to the chat assistant;
 * the master decrypts them only to make the provider call of an ops action or a connection test.
 */

export type OpsProvider = 'coolify' | 'cloudflare';

export const CoolifySettings = z.strictObject({
  url: z.string().min(8).max(300),
  /** Optional: the team name the token is expected to belong to (checked by "Test connection"). */
  team: z.string().max(200).nullable().default(null),
  /** Extra control-plane resources (additive to OPS_CONTROL_PLANE_COOLIFY_UUIDS, which the panel cannot remove). */
  denyResources: z
    .array(z.string().regex(/^[A-Za-z0-9]{6,64}$/))
    .max(50)
    .default([]),
});
export type CoolifySettings = z.infer<typeof CoolifySettings>;

export const CloudflareSettings = z.strictObject({
  accountId: z.string().regex(/^[0-9a-f]{32}$/, 'Cloudflare account id (32 hex)'),
});
export type CloudflareSettings = z.infer<typeof CloudflareSettings>;

/** p8-preview-tunnels: the token permissions preview tunnels need, as the Cloudflare dashboard names them. */
export const PREVIEW_SCOPE_NAMES = {
  tunnels: 'Account → Cloudflare Tunnel → Edit',
  accessApps: 'Account → Access: Apps and Policies → Edit',
  serviceTokens: 'Account → Access: Service Tokens → Edit',
} as const;

/**
 * p10-publish-bundle: the account-level DNS permissions of a Cloudflare token do not reach a zone's records — a common
 * mix-up when creating the token.
 */
export const DNS_PERMISSION_HINT =
  'A zone’s DNS records need the zone permission “Zone → DNS → Edit” for that zone (Zone Resources: include the zone). The account-level permissions “DNS View”, “Account DNS Settings” and “DNS Firewall” do not cover zone records.';

/** Tokens: printable, no whitespace; Coolify (`<id>|<random>`) and Cloudflare (40 chars) both fit. */
export const ApiToken = z.string().regex(/^[\x21-\x7e]{20,512}$/, 'API token');

export interface IntegrationView {
  readonly provider: OpsProvider;
  readonly settings: Record<string, unknown>;
  readonly keyFingerprint: string;
  /** The stored token decrypts with the current master key. */
  readonly usable: boolean;
  readonly lastTest: Record<string, unknown> | null;
  readonly lastTestAt: string | null;
  readonly updatedAt: string;
}

export interface IntegrationsStatus {
  /** The default Coolify connection in the p6 shape (p13-multi-coolify: see `coolifyConnections`). */
  readonly coolify: IntegrationView | null;
  /** p13-multi-coolify: every Coolify connection (no tokens). */
  readonly coolifyConnections: readonly CoolifyConnectionView[];
  readonly cloudflare: IntegrationView | null;
  /** Control-plane Coolify resources from the environment (always denied). */
  readonly controlPlaneResources: readonly string[];
  readonly protectedHosts: readonly string[];
}

export interface IntegrationActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface OpsIntegrationsDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly box: SecretBox;
  readonly clock: () => Date;
  readonly fetch: OpsFetch;
  /** Exact origins exempt from the https/public-address rule (OPS_INTERNAL_ORIGINS). */
  readonly internalOrigins: ReadonlySet<string>;
  readonly cloudflareApi: string;
  readonly controlPlaneResources: readonly string[];
  readonly protectedHosts: readonly string[];
  /** p13-multi-coolify: COOLIFY_SSO_HOST (informational control-plane flag of a connection). */
  readonly coolifySsoHost?: string | null;
}

interface Row {
  provider: OpsProvider;
  config: Record<string, unknown>;
  secret: Buffer;
  key_fingerprint: string;
  last_test: Record<string, unknown> | null;
  last_test_at: Date | null;
  updated_at: Date;
}

const fingerprint = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);

export class OpsIntegrations {
  readonly #box: SecretBox;
  /** p13-multi-coolify (ADR-0050): the Coolify connections (the p6 single integration is the default one). */
  readonly coolifyConnections: CoolifyConnections;

  constructor(private readonly deps: OpsIntegrationsDeps) {
    this.#box = new SecretBox(deps.box.deriveKey('ops-integrations'));
    this.coolifyConnections = new CoolifyConnections({
      pool: deps.pool,
      audit: deps.audit,
      box: this.#box,
      clock: deps.clock,
      fetch: deps.fetch,
      internalOrigins: deps.internalOrigins,
      controlPlaneResources: deps.controlPlaneResources,
      protectedHosts: deps.protectedHosts,
      ssoHost: deps.coolifySsoHost ?? null,
    });
  }

  /** The default Coolify connection in the p6 integration shape. */
  #legacyCoolifyView(c: CoolifyConnectionView | undefined): IntegrationView | null {
    if (c === undefined) return null;
    return {
      provider: 'coolify',
      settings: { url: c.url, team: c.team, denyResources: [...c.denyResources] },
      keyFingerprint: c.keyFingerprint,
      usable: c.usable,
      lastTest: c.lastTest,
      lastTestAt: c.lastTestAt,
      updatedAt: c.updatedAt,
    };
  }

  async #row(provider: OpsProvider): Promise<Row | null> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT provider, config, secret, key_fingerprint, last_test, last_test_at, updated_at
         FROM ops_integrations WHERE provider = $1`,
      [provider],
    );
    return rows[0] ?? null;
  }

  #token(row: Row): string | null {
    try {
      return this.#box.decrypt(row.secret, `ops-integration:${row.provider}`).toString('utf8');
    } catch (err) {
      if (err instanceof SecretBoxError) return null;
      throw err;
    }
  }

  #view(row: Row | null): IntegrationView | null {
    if (row === null) return null;
    return {
      provider: row.provider,
      settings: row.config,
      keyFingerprint: row.key_fingerprint,
      usable: this.#token(row) !== null,
      lastTest: row.last_test,
      lastTestAt: row.last_test_at?.toISOString() ?? null,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async status(): Promise<IntegrationsStatus> {
    const connections = await this.coolifyConnections.list();
    return {
      coolify: this.#legacyCoolifyView(connections.find((c) => c.isDefault)),
      coolifyConnections: connections,
      cloudflare: this.#view(await this.#row('cloudflare')),
      controlPlaneResources: [...this.deps.controlPlaneResources],
      protectedHosts: [...this.deps.protectedHosts],
    };
  }

  async #save(
    actor: IntegrationActor,
    provider: OpsProvider,
    config: Record<string, unknown>,
    token: string | undefined,
  ): Promise<IntegrationView> {
    const existing = await this.#row(provider);
    if (existing === null && token === undefined) {
      throw new OpsError(400, 'token_required', 'Enter the API token.');
    }
    const now = this.deps.clock();
    const secret =
      token === undefined
        ? null
        : this.#box.encrypt(Buffer.from(token, 'utf8'), `ops-integration:${provider}`);
    const fp = token === undefined ? (existing?.key_fingerprint ?? '') : fingerprint(token);
    await this.deps.pool.query(
      `INSERT INTO ops_integrations (provider, config, secret, key_fingerprint, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (provider) DO UPDATE SET config = EXCLUDED.config,
         secret = COALESCE($7, ops_integrations.secret),
         key_fingerprint = EXCLUDED.key_fingerprint,
         -- A new token or URL invalidates the last test result.
         last_test = CASE WHEN $7 IS NULL AND ops_integrations.config = EXCLUDED.config
                          THEN ops_integrations.last_test ELSE NULL END,
         last_test_at = CASE WHEN $7 IS NULL AND ops_integrations.config = EXCLUDED.config
                             THEN ops_integrations.last_test_at ELSE NULL END,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [provider, config, secret ?? existing?.secret, fp, actor.userId, now, secret],
    );
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: `ops.integration.${provider}.save`,
      target: `ops-integration:${provider}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        keyFingerprint: fp,
        keyChanged: token !== undefined,
        previousKeyFingerprint: existing?.key_fingerprint ?? null,
        settings: config,
      },
    });
    const view = this.#view(await this.#row(provider));
    if (view === null) throw new Error('integration row vanished');
    return view;
  }

  /** p6 `PUT /integrations/ops/coolify`: the default Coolify connection (created when there is none). */
  async saveCoolify(
    actor: IntegrationActor,
    input: { settings: unknown; token?: string | undefined },
  ): Promise<IntegrationView> {
    const parsed = CoolifySettings.safeParse(input.settings);
    if (!parsed.success) throw new OpsError(400, 'invalid_settings', 'Invalid Coolify settings.');
    const v = await this.coolifyConnections.saveDefault(actor, parsed.data, input.token);
    const view = this.#legacyCoolifyView(v);
    if (view === null) throw new Error('connection vanished');
    return view;
  }

  async saveCloudflare(
    actor: IntegrationActor,
    input: { settings: unknown; token?: string | undefined },
  ): Promise<IntegrationView> {
    const parsed = CloudflareSettings.safeParse(input.settings);
    if (!parsed.success) throw new OpsError(400, 'invalid_settings', 'Invalid Cloudflare account id.');
    const token = input.token === undefined ? undefined : ApiToken.safeParse(input.token);
    if (token !== undefined && !token.success) throw new OpsError(400, 'invalid_token', 'Invalid API token.');
    return this.#save(actor, 'cloudflare', parsed.data, token?.success === true ? token.data : undefined);
  }

  async remove(actor: IntegrationActor, provider: OpsProvider): Promise<void> {
    if (provider === 'coolify') {
      // p13-multi-coolify: the p6 route removes the default connection.
      const id = await this.coolifyConnections.defaultId();
      if (id === null) throw new OpsError(404, 'not_configured', 'Not configured.');
      return this.coolifyConnections.remove(actor, id);
    }
    const { rowCount } = await this.deps.pool.query('DELETE FROM ops_integrations WHERE provider = $1', [
      provider,
    ]);
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: `ops.integration.${provider}.remove`,
      target: `ops-integration:${provider}`,
      outcome: (rowCount ?? 0) > 0 ? 'success' : 'failure',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
    });
    if ((rowCount ?? 0) === 0) throw new OpsError(404, 'not_configured', 'Not configured.');
  }

  /** The default Coolify connection's client, or null (p13-multi-coolify: see `coolifyConnections.handle`). */
  async coolify(): Promise<{ client: CoolifyClient; settings: CoolifySettings } | null> {
    const h = await this.coolifyConnections.handle(null);
    if (h === null) return null;
    return {
      client: h.client,
      settings: { url: h.settings.url, team: h.settings.team, denyResources: h.settings.denyResources },
    };
  }

  async cloudflare(): Promise<{ client: CloudflareClient; settings: CloudflareSettings } | null> {
    const row = await this.#row('cloudflare');
    if (row === null) return null;
    const token = this.#token(row);
    const settings = CloudflareSettings.safeParse(row.config);
    if (token === null || !settings.success) return null;
    return {
      client: new CloudflareClient({
        apiBase: this.deps.cloudflareApi,
        token,
        accountId: settings.data.accountId,
        fetch: this.deps.fetch,
      }),
      settings: settings.data,
    };
  }

  /** "Test connection": what the stored token can do. Stored (no secrets) and audited. */
  async test(actor: IntegrationActor, provider: OpsProvider): Promise<Record<string, unknown>> {
    if (provider === 'coolify') {
      // p13-multi-coolify: the p6 route tests the default connection.
      const id = await this.coolifyConnections.defaultId();
      if (id === null) throw new OpsError(404, 'not_configured', 'Not configured.');
      return this.coolifyConnections.test(actor, id);
    }
    const row = await this.#row(provider);
    if (row === null) throw new OpsError(404, 'not_configured', 'Not configured.');
    let result: Record<string, unknown>;
    try {
      result = await this.#testCloudflare();
    } catch (err) {
      if (!(err instanceof ProviderCallError)) throw err;
      result = { ok: false, error: err.message, status: err.status, code: err.code };
    }
    await this.deps.pool.query(
      'UPDATE ops_integrations SET last_test = $2, last_test_at = $3 WHERE provider = $1',
      [provider, result, this.deps.clock()],
    );
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: `ops.integration.${provider}.test`,
      target: `ops-integration:${provider}`,
      outcome: result.ok === true ? 'success' : 'failure',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { ok: result.ok === true, error: result.error ?? null },
    });
    return result;
  }

  async #testCloudflare(): Promise<Record<string, unknown>> {
    const c = await this.cloudflare();
    if (c === null)
      return { ok: false, error: 'The stored token cannot be used (master key changed?) — enter it again.' };
    const v = await c.client.verify();
    const zones = await c.client.zones().catch((err: unknown) => {
      if (err instanceof ProviderCallError && err.code === 'forbidden') return [];
      throw err;
    });
    let pages: { access: boolean; projects: string[]; error?: string };
    try {
      pages = { access: true, projects: (await c.client.pagesProjects()).map((p) => p.name).slice(0, 100) };
    } catch (err) {
      if (!(err instanceof ProviderCallError) || err.status === 0) throw err;
      pages = { access: false, projects: [], error: err.message };
    }
    const warnings: string[] = [];
    if (zones.length === 0)
      warnings.push('No zones visible: DNS changes need a token with Zone → DNS → Edit for the zone.');
    if (!pages.access)
      warnings.push('No Pages access: Pages deploys need Account → Cloudflare Pages → Edit.');
    const dns = await this.#dnsProbe(c.client);
    for (const d of dns) {
      if (!d.ok) {
        warnings.push(
          `Zone ${d.zone}: the token cannot read its DNS records — add Zone → DNS → Edit for ${d.zone} (used by ${d.projects.join(', ')}).`,
        );
      }
    }
    const previews = await this.#previewProbe(c.client);
    if (previews.missing.length > 0) {
      warnings.push(
        `Preview tunnels need more token permissions: ${previews.missing.join('; ')} (service tokens only for service-token protected previews).`,
      );
    }
    return {
      ok: v.status === 'active',
      tokenStatus: v.status,
      tokenKind: v.kind,
      expiresOn: v.expiresOn,
      zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status })),
      pages,
      dns,
      ...(dns.some((d) => !d.ok) ? { dnsHint: DNS_PERMISSION_HINT } : {}),
      previews,
      warnings,
    };
  }

  /**
   * p10-publish-bundle: for every zone some project allows (Project → Deploy → Allowed DNS zones), whether the token
   * can read its DNS records (`GET /zones/{id}/dns_records?per_page=1`). A read probe cannot tell Read from Edit; the
   * first DNS change proves Edit.
   */
  async #dnsProbe(
    client: CloudflareClient,
  ): Promise<{ zone: string; zoneId: string; ok: boolean; error?: string; projects: string[] }[]> {
    const { rows } = await this.deps.pool.query<{ project: string; config: unknown }>(
      'SELECT project, config FROM project_deploy_targets ORDER BY project',
    );
    const zones = new Map<string, { name: string; projects: string[] }>();
    for (const r of rows) {
      const list = (r.config as { dns?: { zones?: unknown } } | null)?.dns?.zones;
      if (!Array.isArray(list)) continue;
      for (const z of list as { id?: unknown; name?: unknown }[]) {
        if (typeof z.id !== 'string' || typeof z.name !== 'string' || !/^[0-9a-f]{32}$/.test(z.id)) continue;
        const e = zones.get(z.id) ?? { name: z.name, projects: [] };
        if (!e.projects.includes(r.project)) e.projects.push(r.project);
        zones.set(z.id, e);
      }
    }
    const out: { zone: string; zoneId: string; ok: boolean; error?: string; projects: string[] }[] = [];
    for (const [id, z] of [...zones.entries()].slice(0, 20)) {
      try {
        await client.dnsProbe(id);
        out.push({ zone: z.name, zoneId: id, ok: true, projects: z.projects });
      } catch (err) {
        if (!(err instanceof ProviderCallError) || err.status === 0 || err.code === 'rate_limited') throw err;
        out.push({
          zone: z.name,
          zoneId: id,
          ok: false,
          error: `${err.message} — missing Zone → DNS → Edit for ${z.name}`.slice(0, 400),
          projects: z.projects,
        });
      }
    }
    return out;
  }

  /**
   * p8-preview-tunnels (ADR-0032): which preview-tunnel permissions the token has, by read probes (a list call per
   * resource). A read probe cannot tell Read from Edit: Edit is proven by the first preview (documented).
   */
  async #previewProbe(client: CloudflareClient): Promise<{
    tunnels: boolean;
    accessApps: boolean;
    serviceTokens: boolean;
    missing: string[];
  }> {
    const can = async (probe: () => Promise<void>): Promise<boolean> => {
      try {
        await probe();
        return true;
      } catch (err) {
        if (!(err instanceof ProviderCallError) || err.status === 0 || err.code === 'rate_limited') throw err;
        return false;
      }
    };
    const tunnels = await can(() => client.listTunnelsProbe());
    const accessApps = await can(() => client.listAccessAppsProbe());
    const serviceTokens = await can(() => client.listServiceTokensProbe());
    const missing = [
      ...(tunnels ? [] : [PREVIEW_SCOPE_NAMES.tunnels]),
      ...(accessApps ? [] : [PREVIEW_SCOPE_NAMES.accessApps]),
      ...(serviceTokens ? [] : [PREVIEW_SCOPE_NAMES.serviceTokens]),
    ];
    return { tunnels, accessApps, serviceTokens, missing };
  }
}
