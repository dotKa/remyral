import { createHash, randomBytes } from 'node:crypto';
import { ProviderCallError } from './coolify.js';
import { jsonOf, OpsHttpError, type OpsFetch, type OpsHttpResponse } from './http.js';

/**
 * p6-deploy-integrations: the Cloudflare API v4 calls the master makes (docs/compat/cloudflare.md pins each one).
 * Base `https://api.cloudflare.com/client/v4` (configurable only in the master's environment, for tests), API token
 * as `Authorization: Bearer`. Every answer uses the envelope `{success, errors, messages, result}`.
 */

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

export type DnsType = 'A' | 'AAAA' | 'CNAME' | 'TXT';

export interface DnsRecord {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
  readonly proxied: boolean;
}

export interface DnsRecordInput {
  readonly type: DnsType;
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
  readonly proxied: boolean;
}

export interface Zone {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

export interface PagesProject {
  readonly name: string;
  readonly subdomain: string;
  readonly domains: readonly string[];
  readonly productionBranch: string;
}

/** p6-pages-create: a custom domain of a Pages project and its validation (certificate) / verification state. */
export interface PagesDomain {
  readonly id: string;
  readonly name: string;
  /** initializing | pending | active | deactivated | blocked | error */
  readonly status: string;
  readonly validation: {
    readonly method: string;
    readonly status: string;
    readonly errorMessage: string | null;
    readonly txtName: string | null;
    readonly txtValue: string | null;
  };
  readonly verification: { readonly status: string; readonly errorMessage: string | null };
}

export interface PagesDeployment {
  readonly id: string;
  readonly url: string;
  readonly environment: string;
  readonly stage: string;
  readonly stageStatus: string;
}

export interface PagesFile {
  /** Path inside the site, without a leading slash (e.g. `index.html`, `assets/app.js`). */
  readonly path: string;
  readonly content: Buffer;
  readonly contentType: string;
}

/** p8-preview-tunnels: a Cloudflare Tunnel (`token` only in the create answer of a remotely-managed tunnel). */
export interface CfTunnel {
  readonly id: string;
  readonly name: string;
  /** inactive | degraded | healthy | down */
  readonly status: string;
  readonly connections: number;
  readonly token: string | null;
}

/** p10-site-upload: Direct Upload asset batches (files per request, base64 bytes per request) and their time-out. */
const ASSET_BATCH_FILES = 50;
const ASSET_BATCH_BYTES = 30 * 1024 * 1024;
const ASSET_UPLOAD_TIMEOUT_MS = 120_000;

export class CloudflareClient {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: OpsFetch;
  readonly #account: string;

  constructor(o: {
    readonly apiBase: string;
    readonly token: string;
    readonly accountId: string;
    readonly fetch: OpsFetch;
  }) {
    this.#base = o.apiBase.replace(/\/+$/, '');
    this.#token = o.token;
    this.#account = o.accountId;
    this.#fetch = o.fetch;
  }

  async #call(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    what: string,
    body?: { json: unknown } | { raw: Buffer; contentType: string },
    bearer: string = this.#token,
    timeoutMs?: number,
  ): Promise<{ result: unknown; info: Json }> {
    let res: OpsHttpResponse;
    try {
      res = await this.#fetch({
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        method,
        url: `${this.#base}${path}`,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: 'application/json',
          ...(body === undefined
            ? {}
            : { 'content-type': 'json' in body ? 'application/json' : body.contentType }),
        },
        ...(body === undefined ? {} : { body: 'json' in body ? JSON.stringify(body.json) : body.raw }),
      });
    } catch (err) {
      throw new ProviderCallError(
        'cloudflare',
        0,
        'network',
        `Cloudflare unreachable${err instanceof OpsHttpError ? `: ${err.message}` : ''}`,
      );
    }
    const env = obj(jsonOf(res));
    if (res.status >= 300 && res.status < 400) {
      throw new ProviderCallError('cloudflare', res.status, 'redirect', `${what}: redirect not followed`);
    }
    if (res.status === 200 && env.success !== false) {
      return { result: env.result, info: obj(env.result_info) };
    }
    const first = obj(arr(env.errors)[0]);
    const m = `${what}: ${str(first.message).slice(0, 300) || `HTTP ${String(res.status)}`}`;
    switch (res.status) {
      case 401:
        throw new ProviderCallError('cloudflare', 401, 'unauthorized', m);
      case 403:
        throw new ProviderCallError('cloudflare', 403, 'forbidden', m);
      case 404:
        throw new ProviderCallError('cloudflare', 404, 'not_found', m);
      case 429: {
        const ra = Number.parseInt(res.headers['retry-after'] ?? '', 10);
        throw new ProviderCallError('cloudflare', 429, 'rate_limited', m, Number.isFinite(ra) ? ra : null);
      }
      default:
        throw new ProviderCallError(
          'cloudflare',
          res.status,
          res.status >= 500 ? 'unavailable' : 'invalid',
          m,
        );
    }
  }

  /** `GET /accounts/{account_id}/tokens/verify` (account-owned token), else `GET /user/tokens/verify`. */
  async verify(): Promise<{ status: string; expiresOn: string | null; kind: 'account' | 'user' }> {
    try {
      const { result } = await this.#call('GET', `/accounts/${this.#account}/tokens/verify`, 'verify token');
      const r = obj(result);
      return { status: str(r.status), expiresOn: str(r.expires_on) || null, kind: 'account' };
    } catch (err) {
      if (!(err instanceof ProviderCallError) || err.status === 0 || err.code === 'rate_limited') throw err;
      const { result } = await this.#call('GET', '/user/tokens/verify', 'verify token');
      const r = obj(result);
      return { status: str(r.status), expiresOn: str(r.expires_on) || null, kind: 'user' };
    }
  }

  /** `GET /zones?account.id=…&per_page=50` (first pages; the token sees only its permitted zones). */
  async zones(): Promise<Zone[]> {
    const out: Zone[] = [];
    for (let page = 1; page <= 5; page++) {
      const { result, info } = await this.#call(
        'GET',
        `/zones?account.id=${encodeURIComponent(this.#account)}&per_page=50&page=${String(page)}`,
        'list zones',
      );
      for (const z of arr(result)) {
        const x = obj(z);
        if (str(x.id) !== '')
          out.push({ id: str(x.id), name: str(x.name).toLowerCase(), status: str(x.status) });
      }
      const total = typeof info.total_pages === 'number' ? info.total_pages : 1;
      if (page >= total) break;
    }
    return out;
  }

  static #record(v: unknown): DnsRecord {
    const r = obj(v);
    return {
      id: str(r.id),
      type: str(r.type),
      name: str(r.name).toLowerCase(),
      content: str(r.content),
      ttl: typeof r.ttl === 'number' ? r.ttl : 1,
      proxied: r.proxied === true,
    };
  }

  /** `GET /zones/{zone_id}/dns_records?name.exact=…[&type=…]`. */
  async records(zoneId: string, name: string, type?: string): Promise<DnsRecord[]> {
    const q = `name.exact=${encodeURIComponent(name)}${type === undefined ? '' : `&type=${encodeURIComponent(type)}`}&per_page=100`;
    const { result } = await this.#call('GET', `/zones/${zoneId}/dns_records?${q}`, 'list DNS records');
    return arr(result).map((r) => CloudflareClient.#record(r));
  }

  /**
   * p10-publish-bundle: "Test connection" — can the token read this zone's DNS records? `GET
   * /zones/{zone_id}/dns_records?per_page=1` (needs Zone → DNS → Read/Edit for the zone).
   */
  async dnsProbe(zoneId: string): Promise<void> {
    await this.#call('GET', `/zones/${zoneId}/dns_records?per_page=1`, 'list DNS records');
  }

  /** `POST /zones/{zone_id}/dns_records`. */
  async createRecord(zoneId: string, rec: DnsRecordInput): Promise<DnsRecord> {
    const { result } = await this.#call('POST', `/zones/${zoneId}/dns_records`, 'create DNS record', {
      json: { type: rec.type, name: rec.name, content: rec.content, ttl: rec.ttl, proxied: rec.proxied },
    });
    return CloudflareClient.#record(result);
  }

  /** `PATCH /zones/{zone_id}/dns_records/{dns_record_id}`. */
  async updateRecord(zoneId: string, id: string, rec: DnsRecordInput): Promise<DnsRecord> {
    const { result } = await this.#call('PATCH', `/zones/${zoneId}/dns_records/${id}`, 'update DNS record', {
      json: { type: rec.type, name: rec.name, content: rec.content, ttl: rec.ttl, proxied: rec.proxied },
    });
    return CloudflareClient.#record(result);
  }

  /** `DELETE /zones/{zone_id}/dns_records/{dns_record_id}`. */
  async deleteRecord(zoneId: string, id: string): Promise<void> {
    await this.#call('DELETE', `/zones/${zoneId}/dns_records/${id}`, 'delete DNS record');
  }

  static #project(v: unknown): PagesProject {
    const p = obj(v);
    return {
      name: str(p.name),
      subdomain: str(p.subdomain),
      domains: arr(p.domains)
        .map(str)
        .filter((d) => d !== ''),
      productionBranch: str(p.production_branch) || 'main',
    };
  }

  /** `GET /accounts/{account_id}/pages/projects`. */
  async pagesProjects(): Promise<PagesProject[]> {
    const { result } = await this.#call(
      'GET',
      `/accounts/${this.#account}/pages/projects`,
      'list Pages projects',
    );
    return arr(result).map((p) => CloudflareClient.#project(p));
  }

  /** `GET /accounts/{account_id}/pages/projects/{project_name}`. */
  async pagesProject(name: string): Promise<PagesProject> {
    const { result } = await this.#call(
      'GET',
      `/accounts/${this.#account}/pages/projects/${encodeURIComponent(name)}`,
      'Pages project',
    );
    return CloudflareClient.#project(result);
  }

  /**
   * p6-pages-create: `POST /accounts/{account_id}/pages/projects` `{name, production_branch}` — no `source`, so a
   * Direct Upload project (deployments come from `pagesDirectUpload`). Token: Account → Cloudflare Pages → Edit.
   */
  async createPagesProject(name: string, productionBranch: string): Promise<PagesProject> {
    const { result } = await this.#call(
      'POST',
      `/accounts/${this.#account}/pages/projects`,
      'create Pages project',
      { json: { name, production_branch: productionBranch } },
    );
    return CloudflareClient.#project(result);
  }

  static #domain(v: unknown): PagesDomain {
    const d = obj(v);
    const val = obj(d.validation_data);
    const ver = obj(d.verification_data);
    return {
      id: str(d.id),
      name: str(d.name).toLowerCase(),
      status: str(d.status),
      validation: {
        method: str(val.method),
        status: str(val.status),
        errorMessage: str(val.error_message) || null,
        txtName: str(val.txt_name) || null,
        txtValue: str(val.txt_value) || null,
      },
      verification: { status: str(ver.status), errorMessage: str(ver.error_message) || null },
    };
  }

  /** p6-pages-create: `GET …/pages/projects/{project_name}/domains`. */
  async pagesDomains(name: string): Promise<PagesDomain[]> {
    const { result } = await this.#call(
      'GET',
      `/accounts/${this.#account}/pages/projects/${encodeURIComponent(name)}/domains`,
      'list Pages domains',
    );
    return arr(result).map((d) => CloudflareClient.#domain(d));
  }

  /** p6-pages-create: `POST …/pages/projects/{project_name}/domains` `{name}`. */
  async addPagesDomain(name: string, domain: string): Promise<PagesDomain> {
    const { result } = await this.#call(
      'POST',
      `/accounts/${this.#account}/pages/projects/${encodeURIComponent(name)}/domains`,
      'add Pages domain',
      { json: { name: domain } },
    );
    return CloudflareClient.#domain(result);
  }

  /** p6-pages-create: `GET …/pages/projects/{project_name}/domains/{domain_name}` (validation status). */
  async pagesDomain(name: string, domain: string): Promise<PagesDomain> {
    const { result } = await this.#call(
      'GET',
      `/accounts/${this.#account}/pages/projects/${encodeURIComponent(name)}/domains/${encodeURIComponent(domain)}`,
      'Pages domain',
    );
    return CloudflareClient.#domain(result);
  }

  static #deployment(v: unknown): PagesDeployment {
    const d = obj(v);
    const stage = obj(d.latest_stage);
    return {
      id: str(d.id),
      url: str(d.url),
      environment: str(d.environment),
      stage: str(stage.name),
      stageStatus: str(stage.status),
    };
  }

  /** `GET …/pages/projects/{project_name}/deployments?env=production&per_page=…` (newest first). */
  async pagesDeployments(name: string, env: 'production' | 'preview'): Promise<PagesDeployment[]> {
    const { result } = await this.#call(
      'GET',
      `/accounts/${this.#account}/pages/projects/${encodeURIComponent(name)}/deployments?env=${env}&per_page=5`,
      'list Pages deployments',
    );
    return arr(result).map((d) => CloudflareClient.#deployment(d));
  }

  /** `GET …/deployments/{deployment_id}`. */
  async pagesDeployment(name: string, id: string): Promise<PagesDeployment> {
    const { result } = await this.#call(
      'GET',
      `/accounts/${this.#account}/pages/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(id)}`,
      'Pages deployment',
    );
    return CloudflareClient.#deployment(result);
  }

  /**
   * p12-deploy-feedback: the stages of one Pages deployment (`GET …/deployments/{id}` → `stages[]`, `latest_stage`).
   */
  async pagesDeploymentStages(
    name: string,
    id: string,
  ): Promise<{
    readonly stages: { name: string; status: string; startedOn: string | null; endedOn: string | null }[];
    readonly url: string;
  }> {
    const { result } = await this.#call(
      'GET',
      `/accounts/${this.#account}/pages/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(id)}`,
      'Pages deployment',
    );
    const d = obj(result);
    const stages = arr(d.stages).map((s) => {
      const x = obj(s);
      return {
        name: str(x.name).slice(0, 64),
        status: str(x.status).slice(0, 64),
        startedOn: typeof x.started_on === 'string' ? x.started_on.slice(0, 64) : null,
        endedOn: typeof x.ended_on === 'string' ? x.ended_on.slice(0, 64) : null,
      };
    });
    if (stages.length === 0) {
      const l = obj(d.latest_stage);
      if (str(l.name) !== '')
        stages.push({ name: str(l.name), status: str(l.status), startedOn: null, endedOn: null });
    }
    return { stages: stages.slice(0, 20), url: str(d.url) };
  }

  /**
   * p12-deploy-feedback: `GET …/deployments/{id}/history/logs` (Pages Read) → `{data: [{ts, line}], total}`.
   */
  async pagesDeploymentLogs(
    name: string,
    id: string,
  ): Promise<{ readonly lines: { ts: string; line: string }[]; readonly total: number }> {
    const { result } = await this.#call(
      'GET',
      `/accounts/${this.#account}/pages/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(id)}/history/logs`,
      'Pages deployment logs',
    );
    const r = obj(result);
    const lines = arr(r.data).map((l) => {
      const x = obj(l);
      return { ts: str(x.ts).slice(0, 64), line: str(x.line) };
    });
    return { lines, total: typeof r.total === 'number' ? r.total : lines.length };
  }

  /** `POST …/deployments/{deployment_id}/rollback`. */
  async pagesRollback(name: string, id: string): Promise<PagesDeployment> {
    const { result } = await this.#call(
      'POST',
      `/accounts/${this.#account}/pages/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(id)}/rollback`,
      'Pages rollback',
    );
    return CloudflareClient.#deployment(result);
  }

  /**
   * Direct Upload: `GET …/upload-token` → `POST /pages/assets/check-missing` → `POST /pages/assets/upload` (JWT) →
   * `POST /pages/assets/upsert-hashes` → `POST …/deployments` (multipart: manifest, branch). Asset keys are
   * 32-hex content hashes computed here (see docs/compat/cloudflare.md for the UNVERIFIED-LIVE note).
   */
  async pagesDirectUpload(
    name: string,
    files: readonly PagesFile[],
    meta: { readonly branch: string; readonly commitMessage?: string },
  ): Promise<PagesDeployment> {
    const keyed = files.map((f) => ({
      ...f,
      key: createHash('sha256')
        .update(f.content.toString('base64'))
        .update(f.path.includes('.') ? f.path.slice(f.path.lastIndexOf('.') + 1) : '')
        .digest('hex')
        .slice(0, 32),
    }));
    const tokenRes = await this.#call(
      'GET',
      `/accounts/${this.#account}/pages/projects/${encodeURIComponent(name)}/upload-token`,
      'Pages upload token',
    );
    const jwt = str(obj(tokenRes.result).jwt);
    if (jwt === '') throw new ProviderCallError('cloudflare', 200, 'bad_response', 'no upload token');
    const hashes = [...new Set(keyed.map((f) => f.key))];
    const missingRes = await this.#call(
      'POST',
      '/pages/assets/check-missing',
      'Pages check missing',
      { json: { hashes } },
      jwt,
    );
    const missing = new Set(arr(missingRes.result).map(str));
    const toUpload = keyed.filter(
      (f, i) => missing.has(f.key) && keyed.findIndex((g) => g.key === f.key) === i,
    );
    // p10-site-upload: batches of at most 50 files and ~30 MiB of base64 (a single larger file goes alone; one file
    // is ≤ 25 MiB, ≈ 33.4 MiB as base64), with a longer time-out than the 15 s of an ordinary API call.
    const batches: (typeof toUpload)[] = [];
    let cur: typeof toUpload = [];
    let curBytes = 0;
    for (const f of toUpload) {
      const b64 = Math.ceil(f.content.length / 3) * 4;
      if (cur.length > 0 && (cur.length >= ASSET_BATCH_FILES || curBytes + b64 > ASSET_BATCH_BYTES)) {
        batches.push(cur);
        cur = [];
        curBytes = 0;
      }
      cur.push(f);
      curBytes += b64;
    }
    if (cur.length > 0) batches.push(cur);
    for (const b of batches) {
      const batch = b.map((f) => ({
        key: f.key,
        value: f.content.toString('base64'),
        metadata: { contentType: f.contentType },
        base64: true,
      }));
      await this.#call(
        'POST',
        '/pages/assets/upload',
        'Pages upload',
        { json: batch },
        jwt,
        ASSET_UPLOAD_TIMEOUT_MS,
      );
    }
    await this.#call('POST', '/pages/assets/upsert-hashes', 'Pages upsert hashes', { json: { hashes } }, jwt);
    const manifest = Object.fromEntries(keyed.map((f) => [`/${f.path}`, f.key]));
    const boundary = `----remyral${randomBytes(12).toString('hex')}`;
    const parts: string[] = [];
    const field = (k: string, v: string) =>
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    field('manifest', JSON.stringify(manifest));
    field('branch', meta.branch);
    if (meta.commitMessage !== undefined)
      field('commit_message', meta.commitMessage.replace(/[\r\n]+/g, ' '));
    field('commit_dirty', 'false');
    parts.push(`--${boundary}--\r\n`);
    const { result } = await this.#call(
      'POST',
      `/accounts/${this.#account}/pages/projects/${encodeURIComponent(name)}/deployments`,
      'Pages deploy',
      { raw: Buffer.from(parts.join(''), 'utf8'), contentType: `multipart/form-data; boundary=${boundary}` },
    );
    return CloudflareClient.#deployment(result);
  }

  // ------------------------------------------------------------------ p8-preview-tunnels (ADR-0032)
  // Cloudflare Tunnel (remotely managed) and Access — docs/compat/cloudflare.md §Preview tunnels pins each call.
  // Token permissions: Account → Cloudflare Tunnel → Edit; Account → Access: Apps and Policies → Edit; for
  // service-token protection also Account → Access: Service Tokens → Edit.

  /** `POST /accounts/{account_id}/cfd_tunnel` `{name, config_src: "cloudflare"}` — a remotely-managed tunnel. */
  async createTunnel(name: string): Promise<CfTunnel> {
    const { result } = await this.#call('POST', `/accounts/${this.#account}/cfd_tunnel`, 'create tunnel', {
      json: { name, config_src: 'cloudflare' },
    });
    return CloudflareClient.#tunnel(result);
  }

  /** `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}` (status: inactive | degraded | healthy | down). */
  async tunnel(id: string): Promise<CfTunnel> {
    const { result } = await this.#call('GET', `/accounts/${this.#account}/cfd_tunnel/${id}`, 'tunnel');
    return CloudflareClient.#tunnel(result);
  }

  /** `GET /accounts/{account_id}/cfd_tunnel?per_page=1&is_deleted=false` — the Test connection probe. */
  async listTunnelsProbe(): Promise<void> {
    await this.#call(
      'GET',
      `/accounts/${this.#account}/cfd_tunnel?per_page=1&is_deleted=false`,
      'list tunnels',
    );
  }

  /**
   * `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations` — exactly one ingress rule (the preview
   * hostname to the worker's loopback port, Host header rewritten so dev servers' host checks accept it) and the
   * mandatory catch-all `http_status:404`.
   */
  async configureTunnel(id: string, hostname: string, port: number): Promise<void> {
    await this.#call(
      'PUT',
      `/accounts/${this.#account}/cfd_tunnel/${id}/configurations`,
      'configure tunnel',
      {
        json: {
          config: {
            ingress: [
              {
                hostname,
                service: `http://localhost:${String(port)}`,
                originRequest: { httpHostHeader: `localhost:${String(port)}` },
              },
              { service: 'http_status:404' },
            ],
          },
        },
      },
    );
  }

  /** `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token` — the connector token (`result` is the string). */
  async tunnelToken(id: string): Promise<string> {
    const { result } = await this.#call(
      'GET',
      `/accounts/${this.#account}/cfd_tunnel/${id}/token`,
      'tunnel token',
    );
    const token = str(result);
    if (token === '') throw new ProviderCallError('cloudflare', 200, 'bad_response', 'tunnel token: empty');
    return token;
  }

  /**
   * `PATCH /accounts/{account_id}/cfd_tunnel/{tunnel_id}` `{tunnel_secret}` — a new secret (32 random bytes,
   * base64) invalidates every earlier connector token of the tunnel (stable tunnels re-attached to another job).
   */
  async rotateTunnelSecret(id: string): Promise<void> {
    await this.#call('PATCH', `/accounts/${this.#account}/cfd_tunnel/${id}`, 'rotate tunnel secret', {
      json: { tunnel_secret: randomBytes(32).toString('base64') },
    });
  }

  /** `DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections` — drops every connector of the tunnel. */
  async cleanupTunnelConnections(id: string): Promise<void> {
    await this.#call(
      'DELETE',
      `/accounts/${this.#account}/cfd_tunnel/${id}/connections`,
      'clean up tunnel connections',
    );
  }

  /** `DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}` — also revokes its token. */
  async deleteTunnel(id: string): Promise<void> {
    await this.#call('DELETE', `/accounts/${this.#account}/cfd_tunnel/${id}`, 'delete tunnel');
  }

  static #tunnel(v: unknown): CfTunnel {
    const t = obj(v);
    return {
      id: str(t.id),
      name: str(t.name),
      status: str(t.status),
      connections: arr(t.connections).length,
      token: str(t.token) || null,
    };
  }

  /** `GET /accounts/{account_id}/access/apps?per_page=1` — the Test connection probe. */
  async listAccessAppsProbe(): Promise<void> {
    await this.#call('GET', `/accounts/${this.#account}/access/apps?per_page=1`, 'list Access applications');
  }

  /** `GET /accounts/{account_id}/access/service_tokens?per_page=1` — the Test connection probe. */
  async listServiceTokensProbe(): Promise<void> {
    await this.#call(
      'GET',
      `/accounts/${this.#account}/access/service_tokens?per_page=1`,
      'list service tokens',
    );
  }

  /**
   * `POST /accounts/{account_id}/access/apps` — a self-hosted application for exactly `domain` with one inline policy:
   * `allow` for the listed e-mails (one-time PIN, if the account offers it) or `non_identity` for one service token.
   */
  async createAccessApp(o: {
    readonly name: string;
    readonly domain: string;
    readonly policy:
      | { readonly kind: 'emails'; readonly emails: readonly string[] }
      | { readonly kind: 'service_token'; readonly tokenId: string };
    readonly sessionDuration: string;
  }): Promise<{ id: string }> {
    const policy =
      o.policy.kind === 'emails'
        ? {
            name: 'Remyral preview: allowed e-mails',
            decision: 'allow',
            include: o.policy.emails.map((email) => ({ email: { email } })),
          }
        : {
            name: 'Remyral preview: service token',
            decision: 'non_identity',
            include: [{ service_token: { token_id: o.policy.tokenId } }],
          };
    const { result } = await this.#call(
      'POST',
      `/accounts/${this.#account}/access/apps`,
      'create Access application',
      {
        json: {
          type: 'self_hosted',
          name: o.name,
          domain: o.domain,
          session_duration: o.sessionDuration,
          policies: [policy],
        },
      },
    );
    const id = str(obj(result).id);
    if (id === '')
      throw new ProviderCallError('cloudflare', 200, 'bad_response', 'Access application: no id');
    return { id };
  }

  /** `DELETE /accounts/{account_id}/access/apps/{app_id}`. */
  async deleteAccessApp(id: string): Promise<void> {
    await this.#call('DELETE', `/accounts/${this.#account}/access/apps/${id}`, 'delete Access application');
  }

  /**
   * `POST /accounts/{account_id}/access/service_tokens` `{name, duration}` — the only time Cloudflare returns the
   * client secret.
   */
  async createServiceToken(
    name: string,
    duration: string,
  ): Promise<{ id: string; clientId: string; clientSecret: string }> {
    const { result } = await this.#call(
      'POST',
      `/accounts/${this.#account}/access/service_tokens`,
      'create service token',
      { json: { name, duration } },
    );
    const r = obj(result);
    const out = { id: str(r.id), clientId: str(r.client_id), clientSecret: str(r.client_secret) };
    if (out.id === '' || out.clientId === '' || out.clientSecret === '') {
      throw new ProviderCallError('cloudflare', 200, 'bad_response', 'service token: incomplete answer');
    }
    return out;
  }

  /** `DELETE /accounts/{account_id}/access/service_tokens/{service_token_id}`. */
  async deleteServiceToken(id: string): Promise<void> {
    await this.#call(
      'DELETE',
      `/accounts/${this.#account}/access/service_tokens/${id}`,
      'delete service token',
    );
  }
}
