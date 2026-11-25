import { type OriginInput, originOf } from '../console-domain/origin.js';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { SecretBox } from '../auth/secret-box.js';
import { withTransaction } from '../db/pool.js';
import { GitFlowError } from './errors.js';
import { type FetchFn, GitHubAppAuth, GitHubAppKeyError, LIST_PERMISSIONS } from './github-app.js';
import { githubRepo } from './refs.js';
import { ProviderError } from './types.js';

/**
 * p5-github-connect (ADR-0022, docs/design/p5-github-connect.md): the GitHub App is created and connected from
 * Settings → Integrations with GitHub's App Manifest flow instead of a key file on the master host.
 *
 * - The master builds the manifest (name, console URLs, the git flow's permissions, no events, private App); the
 *   owner's browser posts it to GitHub from a master-served page (the console CSP allows forms to `'self'` only).
 * - GitHub redirects back with a one-hour `code`; the master exchanges it (`POST /app-manifests/{code}/conversions`)
 *   for the App id, slug, client id/secret, webhook secret and private key (PEM).
 * - PEM and secrets are encrypted at rest (AES-256-GCM, HKDF sub-key `github-app` of the master key, AAD bound to the
 *   App id); they are never returned, logged or audited. The decrypted key lives in memory as a {@link GitHubAppAuth}
 *   under the key reference `panel`, next to the file-based `default` (which keeps working).
 * - Installations are discovered with the App JWT (`GET /app/installations`); the setup callback's
 *   `installation_id` is only a hint (it is spoofable) and is accepted only when GitHub lists it.
 */

export const PANEL_KEY_REF = 'panel';

/**
 * p17-chat-github Part 3 (ADR-0022 amendment 2026-10-27): several connections, each its own (private) App — a private
 * App can only be installed on the account that owns it. The first keeps the key reference `panel` (existing projects
 * point at it); the others are `panel-<id>`. Installations are an allowlist: only accepted ones are used.
 */
export const MAX_CONNECTIONS = 10;
const LABEL = /^[^\p{Cc}]{1,60}$/u;

/** Whether a key reference names a panel connection (`panel`, `panel-<id>`). */
export function isPanelKeyRef(keyRef: string): boolean {
  return /^panel(-[0-9]{1,5})?$/.test(keyRef);
}

/** Exactly what the git flow uses (docs/ops/github-app.md §1); `statuses: read` for legacy commit statuses. */
export const MANIFEST_PERMISSIONS: Readonly<Record<string, 'read' | 'write'>> = {
  contents: 'write',
  pull_requests: 'write',
  checks: 'read',
  statuses: 'read',
  metadata: 'read',
};

/**
 * p6-automations (ADR-0024): webhook events the App delivers to `/v1/hooks/github`, and the extra permission they
 * need (`issues` / `issue_comment` events). Not part of {@link MANIFEST_PERMISSIONS}: the git flow does not need them,
 * so an App without them is not reported as missing permissions — its GitHub triggers for issues simply never fire.
 */
export const WEBHOOK_EVENTS = [
  'pull_request',
  'push',
  'issues',
  'issue_comment',
  // p6-automations-next (design §18.5): `actions: read` for workflow_run; the others use existing permissions.
  'pull_request_review',
  'release',
  'workflow_run',
  'check_suite',
] as const;
export const EVENT_PERMISSIONS: Readonly<Record<string, 'read' | 'write'>> = {
  issues: 'read',
  actions: 'read',
};
export const GITHUB_HOOK_PATH = '/v1/hooks/github';

const STATE_TTL_MS = 60 * 60_000; // GitHub's manifest code is valid for one hour.
const REPO_CACHE_MS = 60_000;
const MAX_PAGES = 10;
const ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const CODE = /^[A-Za-z0-9_.-]{1,200}$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
/** GitHub App names are at most 34 characters. */
const MAX_APP_NAME = 34;

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

export interface ConnectActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface PanelAppView {
  readonly appId: string;
  readonly slug: string;
  readonly name: string;
  readonly owner: { readonly login: string; readonly type: string };
  readonly htmlUrl: string;
  /** Where the owner installs the App on accounts/repositories. */
  readonly installUrl: string;
  /** The App's settings page on GitHub (generate/delete keys, delete the App). */
  readonly settingsUrl: string;
  readonly permissions: Readonly<Record<string, string>>;
  /** Permissions the git flow needs that the App does not have (the owner changed them on GitHub). */
  readonly missingPermissions: readonly string[];
  readonly keyFingerprint: string;
  readonly keyCreatedAt: Date;
  /** The stored key could be decrypted and loaded (false: the master key changed — rotate or reconnect). */
  readonly keyUsable: boolean;
  readonly connectedAt: Date;
}

export interface InstallationView {
  /** p17-chat-github: the App and key reference (connection) the installation belongs to. */
  readonly appId: string;
  readonly keyRef: string;
  /** p17-chat-github: accepted in the panel (only accepted installations are used); false = pending. */
  readonly accepted: boolean;
  readonly acceptedAt: Date | null;
  readonly installationId: number;
  readonly account: string;
  readonly accountType: string;
  readonly repositorySelection: 'all' | 'selected';
  readonly suspended: boolean;
  readonly htmlUrl: string | null;
  readonly updatedAt: Date;
  /** p15-github-create-repo: permissions the installation accepted (null: not read yet — sync installations). */
  readonly permissions: Readonly<Record<string, string>> | null;
}

/** p15-github-create-repo: the panel App's OAuth client (user authorization) — never returned by a route. */
export interface PanelOAuthClient {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string | null;
  /** The App's callback URL GitHub sends the user back to (registered by the manifest). */
  readonly redirectUrl: string | null;
}

/** p17-chat-github: one GitHub App connection — a panel App, or (read-only) an App from the environment. */
export interface ConnectionView {
  /** Panel connection id; null for an App from the environment (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_FILE). */
  readonly id: number | null;
  readonly keyRef: string;
  readonly label: string | null;
  readonly source: 'panel' | 'env';
  /** Environment Apps cannot be renamed, re-keyed or removed in the panel. */
  readonly readOnly: boolean;
  readonly appId: string;
  readonly app: PanelAppView | null;
  /** A webhook secret is stored (deliveries of this App are accepted). */
  readonly webhook: boolean;
  readonly installations: readonly InstallationView[];
  readonly projects: readonly ProjectUse[];
}

export interface ProjectUse {
  readonly project: string;
  readonly repositoryUrl: string;
  readonly baseBranch: string;
  readonly installationId: number;
}

export interface ConnectionStatus {
  /** The manifest flow needs the console's public origin (PUBLIC_ORIGIN). */
  readonly available: boolean;
  readonly consoleOrigin: string | null;
  /** keyRef a project configuration gets when it names none (`panel` when connected: it takes precedence). */
  readonly defaultKeyRef: string;
  /** File-based Apps (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_FILE), still honoured. */
  readonly fileApps: readonly { readonly keyRef: string; readonly appId: string }[];
  readonly app: PanelAppView | null;
  readonly installations: readonly InstallationView[];
  /** Projects whose repository uses the panel App. */
  readonly projects: readonly ProjectUse[];
  /** p17-chat-github: every connection (panel Apps first, by id; then Apps from the environment). */
  readonly connections: readonly ConnectionView[];
  readonly maxConnections: number;
}

export interface RepositoryView {
  /** p17-chat-github: the connection the repository is reached through (a project stores it as `github.keyRef`). */
  readonly keyRef: string;
  readonly appId: string;
  readonly installationId: number;
  readonly account: string;
  readonly fullName: string;
  readonly cloneUrl: string;
  readonly htmlUrl: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly archived: boolean;
}

export interface GitHubConnectOptions {
  readonly pool: pg.Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  /** The master's SecretBox; this service uses only its `github-app` sub-key. */
  readonly box: SecretBox;
  /** Shared, live `keyRef` → App map (provider factory, worker credentials, config validation). */
  readonly apps: Map<string, GitHubAppAuth>;
  readonly log: FastifyBaseLogger;
  /** `https://api.github.com` or a GitHub Enterprise Server `https://<host>/api/v3`. */
  readonly apiBaseUrl: string;
  /** `https://github.com` or the GHES web origin (where the manifest is posted and Apps are installed). */
  readonly webBaseUrl: string;
  /**
   * The console's public origin (redirect/setup URLs; p17-domain-wizard: live — the saved address wins); null = the
   * manifest flow is unavailable.
   */
  readonly consoleOrigin: OriginInput;
  readonly fetch?: FetchFn;
  readonly timeoutMs?: number;
}

interface ConnectionRow {
  id: number;
  key_ref: string;
  label: string | null;
  app_id: string;
  slug: string;
  name: string;
  owner_login: string;
  owner_type: string;
  html_url: string;
  client_id: string;
  permissions: Record<string, string>;
  secrets: Buffer;
  key_fingerprint: string;
  key_created_at: Date;
  created_at: Date;
}

interface InstallationRow {
  installation_id: string;
  app_id: string;
  accepted_at: Date | null;
  account_login: string;
  account_type: string;
  repository_selection: 'all' | 'selected';
  suspended: boolean;
  html_url: string | null;
  updated_at: Date;
  permissions: Record<string, string> | null;
}

interface StoredSecrets {
  readonly pem: string;
  readonly clientSecret: string | null;
  readonly webhookSecret: string | null;
}

const err = (status: number, code: string, message: string) => new GitFlowError(status, code, message);

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const cspHash = (body: string): string =>
  `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

export class GitHubConnectService {
  readonly #box: SecretBox;
  readonly #fetch: FetchFn;
  readonly #timeoutMs: number;
  readonly #api: string;
  readonly #web: string;
  readonly #repoCache = new Map<number, { at: number; items: RepositoryView[] }>();
  /** Panel connections whose stored key could not be loaded (decryption or key parse failed). */
  readonly #broken = new Set<number>();

  constructor(private readonly deps: GitHubConnectOptions) {
    this.#box = new SecretBox(deps.box.deriveKey('github-app'));
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = deps.timeoutMs ?? 15_000;
    this.#api = deps.apiBaseUrl.replace(/\/+$/, '');
    this.#web = deps.webBaseUrl.replace(/\/+$/, '');
  }

  /**
   * keyRef a configuration without one gets: the first panel App takes precedence over the key file
   * (p17-chat-github: `panel`, else the lowest `panel-<id>` loaded).
   */
  defaultKeyRef(): string {
    if (this.deps.apps.has(PANEL_KEY_REF)) return PANEL_KEY_REF;
    const panels = [...this.deps.apps.keys()]
      .filter(isPanelKeyRef)
      .sort((a, b) => Number(a.slice(6) || 0) - Number(b.slice(6) || 0));
    return panels[0] ?? 'default';
  }

  appIdOf(keyRef: string): string | undefined {
    return this.deps.apps.get(keyRef)?.appId;
  }

  /** Loads every stored panel App into the live map (startup). A broken blob is reported, never thrown. */
  async load(): Promise<void> {
    const rows = await this.#rows();
    const live = new Set(rows.map((r) => r.key_ref));
    for (const ref of [...this.deps.apps.keys()]) {
      if (isPanelKeyRef(ref) && !live.has(ref)) this.deps.apps.delete(ref);
    }
    this.#broken.clear();
    for (const row of rows) {
      try {
        const secrets = this.#decrypt(row);
        this.deps.apps.set(row.key_ref, this.#auth(row.app_id, secrets.pem));
      } catch {
        this.deps.apps.delete(row.key_ref);
        this.#broken.add(row.id);
        this.deps.log.warn(
          { appId: row.app_id, connection: row.id },
          'github connect: the stored App key cannot be loaded (master key changed?) — rotate the key or reconnect',
        );
      }
    }
  }

  /**
   * For `PUT /projects/:id/git`: is the installation an accepted, active installation of the panel App behind
   * `keyRef`? Null for Apps from the environment (not managed in the panel; unchanged behaviour).
   */
  async checkInstallation(keyRef: string, installationId: number): Promise<boolean | null> {
    if (!isPanelKeyRef(keyRef)) return null;
    const appId = this.appIdOf(keyRef);
    if (appId === undefined) return false;
    return this.#accepted(appId, installationId);
  }

  async status(): Promise<ConnectionStatus> {
    const rows = await this.#rows();
    const first = this.#firstOf(rows);
    const connections: ConnectionView[] = [];
    for (const row of rows) {
      connections.push({
        id: row.id,
        keyRef: row.key_ref,
        label: row.label,
        source: 'panel',
        readOnly: false,
        appId: row.app_id,
        app: this.#view(row),
        webhook: this.#hasWebhook(row),
        installations: await this.#installations(row.app_id, row.key_ref),
        projects: await this.#projects(row.key_ref),
      });
    }
    for (const [keyRef, auth] of this.#envApps()) {
      connections.push({
        id: null,
        keyRef,
        label: null,
        source: 'env',
        readOnly: true,
        appId: auth.appId,
        app: null,
        webhook: false,
        installations: await this.#installations(auth.appId, keyRef),
        projects: await this.#projects(keyRef),
      });
    }
    const firstView = first === null ? null : connections.find((c) => c.id === first.id);
    const consoleOrigin = originOf(this.deps.consoleOrigin);
    return {
      available: consoleOrigin !== null,
      consoleOrigin,
      defaultKeyRef: this.defaultKeyRef(),
      fileApps: this.#envApps().map(([keyRef, a]) => ({ keyRef, appId: a.appId })),
      app: firstView?.app ?? null,
      installations: firstView?.installations ?? [],
      projects: firstView?.projects ?? [],
      connections,
      maxConnections: MAX_CONNECTIONS,
    };
  }

  // ------------------------------------------------------------------------------------------- manifest flow

  /**
   * The manifest the master asks GitHub to create (no secret; also shown to the owner on GitHub). GitHub App names
   * are unique on GitHub: the first App is "Remyral <console host>", later ones name their account too.
   */
  manifest(target = 'user', existing = 0): Record<string, unknown> {
    const origin = this.#origin();
    const host = new URL(origin).hostname;
    const name =
      existing === 0
        ? `Remyral ${host}`
        : target.startsWith('org:')
          ? `Remyral ${target.slice(4)} ${host}`
          : `Remyral ${host} ${String(existing + 1)}`;
    return {
      name: name.slice(0, MAX_APP_NAME).trim(),
      url: origin,
      description: 'Remyral: pushes agent branches, opens pull requests and merges after approval.',
      public: false,
      redirect_url: `${origin}/settings/integrations/github/callback`,
      callback_urls: [`${origin}/settings/integrations/github/callback`],
      setup_url: `${origin}/settings/integrations/github/installed`,
      setup_on_update: true,
      request_oauth_on_install: false,
      // p6-automations: deliveries for automation triggers (signature-checked with the App's webhook secret).
      hook_attributes: { url: `${origin}${GITHUB_HOOK_PATH}`, active: true },
      default_events: [...WEBHOOK_EVENTS],
      default_permissions: { ...EVENT_PERMISSIONS, ...MANIFEST_PERMISSIONS },
    };
  }

  /**
   * Starts the flow: a single-use state token bound to the user (1 h). p17-chat-github: another connection may be
   * added (one private App per account / organization) up to {@link MAX_CONNECTIONS}; an organization that already
   * has a connection is refused.
   */
  async start(
    actor: ConnectActor,
    target: { readonly kind: 'user' } | { readonly kind: 'organization'; readonly organization: string },
    label?: string,
  ): Promise<{ readonly formPath: string; readonly expiresAt: Date }> {
    this.#origin();
    const rows = await this.#rows();
    if (rows.length >= MAX_CONNECTIONS) {
      throw err(
        409,
        'github_connection_limit',
        `At most ${String(MAX_CONNECTIONS)} GitHub App connections. Remove one first.`,
      );
    }
    if (target.kind === 'organization' && !ORG.test(target.organization)) {
      throw err(400, 'invalid_organization', 'Organization must be a GitHub organization login.');
    }
    if (
      target.kind === 'organization' &&
      rows.some((r) => r.owner_login.toLowerCase() === target.organization.toLowerCase())
    ) {
      throw err(
        409,
        'github_already_connected',
        `A GitHub App of ${target.organization} is already connected.`,
      );
    }
    const cleanLabel = label === undefined ? null : label.trim();
    if (cleanLabel !== null && !LABEL.test(cleanLabel)) {
      throw err(400, 'invalid_label', 'A connection name is 1–60 characters on one line.');
    }
    const state = randomBytes(32).toString('base64url');
    const now = this.deps.clock();
    const expiresAt = new Date(now.getTime() + STATE_TTL_MS);
    const targetText = target.kind === 'user' ? 'user' : `org:${target.organization}`;
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('DELETE FROM github_manifest_states WHERE expires_at < $1', [now]);
      await tx.query(
        `INSERT INTO github_manifest_states (state_hash, user_id, target, created_at, expires_at, label)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sha256(state), actor.userId, targetText, now, expiresAt, cleanLabel],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'github.connect.start',
          target: 'github-app',
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { target: targetText, connections: rows.length },
        },
        tx,
      );
    });
    return { formPath: `/integrations/github/manifest/form?state=${state}`, expiresAt };
  }

  /**
   * The page that posts the manifest to GitHub (served by the master with its own CSP: the console's
   * `form-action 'self'` cannot post to github.com). Checks the state without consuming it.
   */
  async form(userId: string, state: string): Promise<{ readonly html: string; readonly csp: string }> {
    const row = await this.#state(userId, state);
    if (row === null) {
      throw err(400, 'invalid_state', 'This GitHub connection link is invalid or has expired. Start again.');
    }
    const action =
      row.target === 'user'
        ? `${this.#web}/settings/apps/new?state=${encodeURIComponent(state)}`
        : `${this.#web}/organizations/${encodeURIComponent(row.target.slice(4))}/settings/apps/new?state=${encodeURIComponent(state)}`;
    const manifest = JSON.stringify(this.manifest(row.target, (await this.#rows()).length));
    const style =
      'body{font:15px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#111}' +
      'button{font:inherit;padding:.5rem 1rem;border-radius:.4rem;border:1px solid #333;background:#111;color:#fff;cursor:pointer}' +
      'code{font-size:.9em}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111}}';
    const script = "document.getElementById('f').submit();";
    const html =
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect GitHub · Remyral</title>' +
      `<style>${style}</style></head><body><main><h1>Create the Remyral GitHub App</h1>` +
      `<p>GitHub will show the App (${htmlEscape(row.target === 'user' ? 'on your account' : `in organization ${row.target.slice(4)}`)}) ` +
      'with its permissions: contents and pull requests read/write; checks, commit statuses, issues and metadata read; ' +
      'webhook events (pull requests, pushes, issues, comments) for automations. ' +
      'Confirm there; GitHub then sends you back to the console.</p>' +
      `<form id="f" method="post" action="${htmlEscape(action)}">` +
      `<input type="hidden" name="manifest" value="${htmlEscape(manifest)}">` +
      '<button type="submit">Continue to GitHub</button></form>' +
      '<p><a href="/settings/integrations">Cancel</a></p></main>' +
      `<script>${script}</script></body></html>`;
    const csp = [
      "default-src 'none'",
      `style-src ${cspHash(style)}`,
      `script-src ${cspHash(script)}`,
      `form-action ${new URL(this.#web).origin}`,
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
    return { html, csp };
  }

  /**
   * GitHub came back with `code` + `state`: consume the state (single use, same user, unexpired), exchange the
   * code, store the App encrypted as a new connection, load it, and discover installations (best effort; new
   * installations are pending until accepted).
   */
  async complete(
    actor: ConnectActor,
    input: { readonly code: string; readonly state: string },
  ): Promise<ConnectionStatus> {
    const fail = async (reason: string, extra: Record<string, unknown> = {}) =>
      this.deps.audit.record({
        actor: { type: 'user', id: actor.userId },
        action: 'github.connect.complete',
        target: 'github-app',
        outcome: 'failure',
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: { reason, ...extra },
      });
    const consumed = await this.#consume(actor.userId, input.state);
    if (consumed === null) {
      await fail('invalid_state');
      throw err(
        400,
        'invalid_state',
        'This GitHub connection link is invalid, used or expired. Start again.',
      );
    }
    if (!CODE.test(input.code)) {
      await fail('invalid_code');
      throw err(400, 'invalid_code', 'GitHub returned an invalid code. Start again.');
    }
    if ((await this.#rows()).length >= MAX_CONNECTIONS) {
      await fail('connection_limit');
      throw err(
        409,
        'github_connection_limit',
        `At most ${String(MAX_CONNECTIONS)} GitHub App connections. Remove one first.`,
      );
    }
    let res: Response;
    try {
      res = await this.#fetch(`${this.#api}/app-manifests/${encodeURIComponent(input.code)}/conversions`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'remyral-gitflow',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      await fail('network');
      throw err(502, 'github_unreachable', 'GitHub could not be reached. Start again in a moment.');
    }
    if (res.status !== 201) {
      await fail('conversion_refused', { status: res.status });
      throw err(
        502,
        'github_conversion_failed',
        `GitHub refused to finish creating the App (HTTP ${String(res.status)}). The code is valid for one hour and only once — start again.`,
      );
    }
    const body = obj(await res.json().catch(() => null));
    const appId = typeof body.id === 'number' && Number.isSafeInteger(body.id) ? String(body.id) : '';
    const slug = str(body.slug);
    const owner = obj(body.owner);
    const pem = str(body.pem);
    const ownerType = str(owner.type);
    if (
      !/^[0-9]{1,20}$/.test(appId) ||
      !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug) ||
      str(owner.login) === '' ||
      !['User', 'Organization', 'Enterprise'].includes(ownerType)
    ) {
      await fail('malformed_response');
      throw err(502, 'github_conversion_failed', 'GitHub answered with an unexpected App description.');
    }
    let auth: GitHubAppAuth;
    try {
      auth = this.#auth(appId, pem);
    } catch {
      await fail('bad_key', { appId });
      throw err(502, 'github_conversion_failed', 'GitHub returned a private key the master cannot use.');
    }
    const secrets: StoredSecrets = {
      pem,
      clientSecret: str(body.client_secret) || null,
      webhookSecret: str(body.webhook_secret) || null,
    };
    const permissions = Object.fromEntries(
      Object.entries(obj(body.permissions)).filter(
        (e): e is [string, string] => typeof e[1] === 'string' && /^[a-z_]{1,64}$/.test(e[0]),
      ),
    );
    const now = this.deps.clock();
    const fingerprint = auth.keyFingerprint();
    const inserted = await withTransaction(this.deps.pool, async (tx) => {
      // The first connection keeps id 1 and keyRef `panel` (an older master reads it; existing projects point at
      // it); later ones take ids from the sequence and keyRef `panel-<id>`.
      const r = await tx.query<{ id: number; key_ref: string }>(
        `WITH n AS (
           SELECT COALESCE((SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM github_app_connection WHERE id = 1)),
                           nextval('github_app_connection_id_seq'))::smallint AS id
         )
         INSERT INTO github_app_connection (id, key_ref, label, app_id, slug, name, owner_login, owner_type, html_url,
           client_id, permissions, secrets, key_fingerprint, key_created_at, created_by, created_at, updated_at)
         SELECT n.id,
                CASE WHEN EXISTS (SELECT 1 FROM github_app_connection WHERE key_ref = 'panel')
                     THEN 'panel-' || n.id::text ELSE 'panel' END,
                $13, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11, $11
           FROM n
         ON CONFLICT DO NOTHING
         RETURNING id, key_ref`,
        [
          appId,
          slug,
          (str(body.name) || slug).slice(0, 200),
          str(owner.login).slice(0, 100),
          ownerType,
          str(body.html_url).slice(0, 512),
          str(body.client_id).slice(0, 100),
          JSON.stringify(permissions),
          this.#encrypt(appId, secrets),
          fingerprint,
          now,
          actor.userId,
          consumed.label,
        ],
      );
      const created = r.rows[0];
      if (created === undefined) return null;
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'github.connect.complete',
          target: `github-app:${appId}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: {
            appId,
            slug,
            owner: str(owner.login),
            ownerType,
            connection: created.id,
            keyRef: created.key_ref,
            keyFingerprint: fingerprint,
            permissions,
            missingPermissions: missing(permissions),
          },
        },
        tx,
      );
      return created;
    });
    if (inserted === null) {
      await fail('already_connected', { appId });
      throw err(409, 'github_already_connected', 'This GitHub App is already connected.');
    }
    this.deps.apps.set(inserted.key_ref, auth);
    this.#broken.delete(inserted.id);
    try {
      await this.#discover(appId, auth);
    } catch (e) {
      this.deps.log.warn(
        { appId, err: e instanceof Error ? e.message.slice(0, 200) : 'error' },
        'github connect: installation discovery after connect failed',
      );
    }
    return this.status();
  }

  // ------------------------------------------------------------------------------------------- installations

  /**
   * Re-reads the installations from GitHub (App JWT) and mirrors them — of one connection (`connectionId`), else of
   * every connection (panel Apps and Apps from the environment). With `installationId` (the setup callback's hint)
   * the call fails when no App lists it — a forged callback cannot add anything. New installations are pending.
   */
  async sync(actor: ConnectActor, installationId?: number, connectionId?: number): Promise<ConnectionStatus> {
    const targets: { appId: string; auth: GitHubAppAuth; ref: string }[] = [];
    if (connectionId !== undefined) {
      const { row, auth } = this.#require(await this.#select(connectionId));
      targets.push({ appId: row.app_id, auth, ref: row.key_ref });
    } else {
      const rows = await this.#rows();
      if (rows.length === 0 && this.#envApps().length === 0) {
        throw err(409, 'github_not_connected', 'No GitHub App is connected.');
      }
      for (const row of rows) {
        const auth = this.deps.apps.get(row.key_ref);
        if (auth?.appId === row.app_id) targets.push({ appId: row.app_id, auth, ref: row.key_ref });
      }
      for (const [ref, auth] of this.#envApps()) targets.push({ appId: auth.appId, auth, ref });
      if (targets.length === 0) {
        throw err(
          409,
          'github_key_unusable',
          'The stored GitHub App key cannot be used. Rotate the key or reconnect.',
        );
      }
    }
    const all: number[] = [];
    const added: number[] = [];
    const removed: number[] = [];
    const failed: string[] = [];
    for (const t of targets) {
      try {
        const out = await this.#discover(t.appId, t.auth);
        all.push(...out.ids);
        added.push(...out.added);
        removed.push(...out.removed);
      } catch (e) {
        // One App's failure does not hide the others (single-connection calls keep the error).
        if (targets.length === 1) throw e;
        failed.push(t.ref);
      }
    }
    const found = installationId === undefined || all.includes(installationId);
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'github.installations.sync',
      target: targets.length === 1 ? `github-app:${targets[0]?.appId ?? ''}` : 'github-app',
      outcome: found ? 'success' : 'failure',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        appIds: targets.map((t) => t.appId),
        installations: all.length,
        added,
        removed,
        ...(failed.length === 0 ? {} : { failed }),
        ...(installationId === undefined ? {} : { hint: installationId, found }),
      },
    });
    if (!found) {
      throw err(404, 'installation_not_found', 'GitHub does not list this installation for a connected App.');
    }
    return this.status();
  }

  /**
   * p17-chat-github: accepts an installation (it is used from now on: repository listing, project configuration,
   * installation tokens) or takes the acceptance back (pending again: nothing new uses it and panel Apps mint no more
   * tokens for it). Audited with the projects that use it.
   */
  async setAccepted(
    actor: ConnectActor,
    installationId: number,
    accepted: boolean,
  ): Promise<ConnectionStatus> {
    const now = this.deps.clock();
    const result = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ app_id: string; account_login: string }>(
        `UPDATE github_app_installations
            SET accepted_at = CASE WHEN $2 THEN COALESCE(accepted_at, $3) ELSE NULL END,
                accepted_by = CASE WHEN $2 THEN COALESCE(accepted_by, $4::uuid) ELSE NULL END
          WHERE installation_id = $1
          RETURNING app_id, account_login`,
        [installationId, accepted, now, actor.userId],
      );
      const row = rows[0];
      if (row === undefined) return null;
      const projects = (
        await tx.query<{ project: string }>(
          `SELECT project FROM project_git_configs
            WHERE provider = 'github' AND github_installation_id = $1 ORDER BY project`,
          [installationId],
        )
      ).rows.map((r) => r.project);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: accepted ? 'github.installation.accept' : 'github.installation.revoke',
          target: `github-app:${row.app_id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { appId: row.app_id, installationId, account: row.account_login, projects },
        },
        tx,
      );
      return row;
    });
    if (result === null) {
      throw err(404, 'installation_not_found', 'This installation is not known. Re-read the installations.');
    }
    this.#repoCache.delete(installationId);
    return this.status();
  }

  async #discover(
    appId: string,
    auth: GitHubAppAuth,
  ): Promise<{ added: number[]; removed: number[]; ids: number[] }> {
    const seen: Json[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await auth.appRequest('GET', `/app/installations?per_page=100&page=${String(page)}`);
      if (r.status === 401) {
        throw err(409, 'github_key_rejected', 'GitHub rejected the App key. Rotate the key or reconnect.');
      }
      if (r.status !== 200) {
        throw err(
          502,
          'github_unavailable',
          `GitHub answered HTTP ${String(r.status)} listing installations.`,
        );
      }
      const items = arr(r.json).map(obj);
      seen.push(...items);
      if (items.length < 100) break;
    }
    const now = this.deps.clock();
    const ids: number[] = [];
    return withTransaction(this.deps.pool, async (tx) => {
      const before = new Set(
        (
          await tx.query<{ installation_id: string }>(
            'SELECT installation_id FROM github_app_installations WHERE app_id = $1 FOR UPDATE',
            [appId],
          )
        ).rows.map((x) => Number(x.installation_id)),
      );
      for (const i of seen) {
        const id = i.id;
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue;
        const owner = typeof i.app_id === 'number' || typeof i.app_id === 'string' ? String(i.app_id) : appId;
        if (owner !== appId) continue;
        const account = obj(i.account);
        const login = str(account.login).slice(0, 100);
        if (login === '') continue;
        const selection = str(i.repository_selection) === 'all' ? 'all' : 'selected';
        ids.push(id);
        // p15-github-create-repo: the accepted permissions (administration: write lets an organization
        // installation create repositories). Only `name: read|write|admin` pairs are kept.
        const perms = Object.fromEntries(
          Object.entries(obj(i.permissions))
            .filter(
              (e): e is [string, string] =>
                /^[a-z_]{1,60}$/.test(e[0]) && typeof e[1] === 'string' && /^(read|write|admin)$/.test(e[1]),
            )
            .slice(0, 80),
        );
        // p17-chat-github: a new installation is pending (accepted_at NULL); an update keeps the decision — unless
        // the installation moved to another App (impossible on GitHub; then it is pending again).
        await tx.query(
          `INSERT INTO github_app_installations (installation_id, app_id, account_login, account_type,
             repository_selection, suspended, html_url, discovered_at, updated_at, permissions)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
           ON CONFLICT (installation_id) DO UPDATE SET app_id = EXCLUDED.app_id,
             account_login = EXCLUDED.account_login, account_type = EXCLUDED.account_type,
             repository_selection = EXCLUDED.repository_selection, suspended = EXCLUDED.suspended,
             html_url = EXCLUDED.html_url, updated_at = EXCLUDED.updated_at, permissions = EXCLUDED.permissions,
             accepted_at = CASE WHEN github_app_installations.app_id = EXCLUDED.app_id
                                THEN github_app_installations.accepted_at END,
             accepted_by = CASE WHEN github_app_installations.app_id = EXCLUDED.app_id
                                THEN github_app_installations.accepted_by END`,
          [
            id,
            appId,
            login,
            str(account.type).slice(0, 40) || 'User',
            selection,
            i.suspended_at !== null && i.suspended_at !== undefined,
            str(i.html_url).slice(0, 512) || null,
            now,
            JSON.stringify(perms),
          ],
        );
      }
      const removed = [...before].filter((id) => !ids.includes(id));
      if (removed.length > 0) {
        await tx.query(
          'DELETE FROM github_app_installations WHERE app_id = $1 AND installation_id = ANY($2::bigint[])',
          [appId, removed],
        );
      }
      for (const id of removed) this.#repoCache.delete(id);
      return { added: ids.filter((id) => !before.has(id)), removed, ids };
    });
  }

  // -------------------------------------------------------------------------------------------- repositories

  /**
   * Repositories reachable through the accepted installations of every connection (panel Apps and Apps from the
   * environment), filtered and paginated by the master. Each names the connection (`keyRef`) it goes through.
   */
  async repositories(query: {
    readonly q?: string;
    readonly installationId?: number;
    readonly page?: number;
    readonly pageSize?: number;
    readonly refresh?: boolean;
  }): Promise<{ items: RepositoryView[]; total: number; page: number; pageSize: number; errors: string[] }> {
    const sources = await this.#usable();
    if (sources.length === 0) {
      // As before: no App at all is "not connected", a panel App whose key cannot be used says so.
      this.#require(this.#firstOf(await this.#rows()));
    }
    const all: RepositoryView[] = [];
    const errors: string[] = [];
    for (const src of sources) {
      const installations = (await this.#installations(src.appId, src.keyRef)).filter(
        (i) =>
          i.accepted &&
          !i.suspended &&
          (query.installationId === undefined || i.installationId === query.installationId),
      );
      for (const inst of installations) {
        try {
          all.push(...(await this.#repos(src.auth, inst, query.refresh === true)));
        } catch (e) {
          errors.push(
            `${inst.account}: ${e instanceof GitFlowError || e instanceof ProviderError ? e.message.slice(0, 200) : 'unavailable'}`,
          );
        }
      }
    }
    const q = (query.q ?? '').trim().toLowerCase();
    const filtered = all
      .filter((r) => q === '' || r.fullName.toLowerCase().includes(q))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    const pageSize = Math.min(Math.max(query.pageSize ?? 30, 1), 100);
    const page = Math.max(query.page ?? 1, 1);
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
      errors,
    };
  }

  async #repos(auth: GitHubAppAuth, inst: InstallationView, refresh: boolean): Promise<RepositoryView[]> {
    const now = this.deps.clock().getTime();
    const hit = this.#repoCache.get(inst.installationId);
    if (!refresh && hit !== undefined && now - hit.at < REPO_CACHE_MS) return hit.items;
    const { token } = await auth.installationToken(inst.installationId, null, LIST_PERMISSIONS, {
      cache: true,
    });
    const items: RepositoryView[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      let res: Response;
      try {
        res = await this.#fetch(`${this.#api}/installation/repositories?per_page=100&page=${String(page)}`, {
          method: 'GET',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'user-agent': 'remyral-gitflow',
            'x-github-api-version': '2022-11-28',
          },
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch {
        throw new ProviderError('GitHub repository listing failed (network)', true);
      }
      if (res.status !== 200) {
        throw new ProviderError(
          `GitHub answered HTTP ${String(res.status)} listing repositories`,
          false,
          res.status,
        );
      }
      const list = arr(obj(await res.json().catch(() => null)).repositories).map(obj);
      for (const r of list) {
        const cloneUrl = str(r.clone_url);
        if (githubRepo(cloneUrl) === null) continue;
        items.push({
          keyRef: inst.keyRef,
          appId: inst.appId,
          installationId: inst.installationId,
          account: inst.account,
          fullName: str(r.full_name).slice(0, 200),
          cloneUrl,
          htmlUrl: str(r.html_url).slice(0, 512),
          defaultBranch: str(r.default_branch).slice(0, 200) || 'main',
          private: r.private === true,
          archived: r.archived === true,
        });
      }
      if (list.length < 100) break;
    }
    this.#repoCache.set(inst.installationId, { at: now, items });
    return items;
  }

  // ------------------------------------------------------------------------ p15-github-create-repo helpers

  /**
   * The first connected App, its live auth and its installations (the user authorization of repository creation
   * belongs to it). Throws `github_not_connected` / `github_key_unusable` like the other App calls.
   */
  async panel(): Promise<{
    readonly appId: string;
    readonly auth: GitHubAppAuth;
    readonly installations: readonly InstallationView[];
    readonly permissions: Readonly<Record<string, string>>;
  }> {
    const { row, auth } = this.#require(this.#firstOf(await this.#rows()));
    return {
      appId: row.app_id,
      auth,
      installations: await this.#installations(row.app_id, row.key_ref),
      permissions: row.permissions,
    };
  }

  /** p17-chat-github: the accepted installations of every usable connection (repository creation's owners). */
  async acceptedInstallations(): Promise<InstallationView[]> {
    const out: InstallationView[] = [];
    for (const src of await this.#usable()) {
      out.push(...(await this.#installations(src.appId, src.keyRef)).filter((i) => i.accepted));
    }
    return out;
  }

  /**
   * p17-chat-github: the connection an installation belongs to and its live auth — the token of a repository goes
   * through the App that owns the installation. Null when no usable connection has it accepted.
   */
  async installationAuth(
    installationId: number,
  ): Promise<{ readonly keyRef: string; readonly appId: string; readonly auth: GitHubAppAuth } | null> {
    const found = (await this.acceptedInstallations()).find((i) => i.installationId === installationId);
    if (found === undefined) return null;
    const auth = this.deps.apps.get(found.keyRef);
    return auth === undefined ? null : { keyRef: found.keyRef, appId: found.appId, auth };
  }

  /** The first App's OAuth client for the user authorization (null when none is connected or it cannot be read). */
  async oauthClient(): Promise<PanelOAuthClient | null> {
    const row = this.#firstOf(await this.#rows());
    if (row === null) return null;
    let clientSecret: string | null;
    try {
      clientSecret = this.#decrypt(row).clientSecret;
    } catch {
      return null;
    }
    const consoleOrigin = originOf(this.deps.consoleOrigin);
    return {
      appId: row.app_id,
      clientId: row.client_id,
      clientSecret,
      redirectUrl:
        consoleOrigin === null
          ? null
          : `${consoleOrigin.replace(/\/+$/, '')}/settings/integrations/github/callback`,
    };
  }

  /** Forgets the cached repository list of an installation (a repository was just created / added). */
  forgetRepositories(installationId: number): void {
    this.#repoCache.delete(installationId);
  }

  // ------------------------------------------------------------------------------------ webhook (p6-automations)

  /** The first panel App's webhook secret; null when there is none (whether deliveries are received at all). */
  async webhookSecret(): Promise<string | null> {
    for (const row of await this.#rows()) {
      try {
        const s = this.#decrypt(row).webhookSecret;
        if (s !== null) return s;
      } catch {
        // next connection
      }
    }
    return null;
  }

  /**
   * p17-chat-github: the webhook secrets a delivery is checked against — the secret of the App the delivery names
   * (`X-GitHub-Hook-Installation-Target-ID`), none for an unknown App (refused like a bad signature); without the
   * header, every connection's secret (at most {@link MAX_CONNECTIONS}).
   */
  async webhookSecrets(appId: string | null): Promise<string[]> {
    const rows = await this.#rows();
    const out: string[] = [];
    for (const row of appId === null ? rows : rows.filter((r) => r.app_id === appId)) {
      try {
        const s = this.#decrypt(row).webhookSecret;
        if (s !== null) out.push(s);
      } catch {
        // a broken blob cannot verify anything
      }
    }
    return out;
  }

  /**
   * Points the App's webhook at this master with a fresh secret (`PATCH /app/hook/config`, App JWT; content type
   * JSON). GitHub has no API to activate the hook or choose its events: the owner ticks *Active* and the events on
   * the App's settings page (returned). The secret is stored encrypted like the others and never returned.
   */
  async configureWebhook(
    actor: ConnectActor,
    connectionId?: number,
  ): Promise<{ readonly url: string; readonly settingsUrl: string; readonly events: readonly string[] }> {
    const { row, auth } = this.#require(await this.#select(connectionId));
    const url = `${this.#origin()}${GITHUB_HOOK_PATH}`;
    const secret = randomBytes(32).toString('base64url');
    const audit = async (outcome: 'success' | 'failure', metadata: Record<string, unknown>) =>
      this.deps.audit.record({
        actor: { type: 'user', id: actor.userId },
        action: 'github.webhook.configure',
        target: `github-app:${row.app_id}`,
        outcome,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: { appId: row.app_id, connection: row.id, url, ...metadata },
      });
    let res: { status: number; json: unknown };
    try {
      res = await auth.appRequest('PATCH', '/app/hook/config', {
        url,
        content_type: 'json',
        secret,
        insecure_ssl: '0',
      });
    } catch {
      await audit('failure', { reason: 'unreachable' });
      throw err(502, 'github_unreachable', 'GitHub could not be reached. Try again.');
    }
    if (res.status !== 200) {
      await audit('failure', { reason: `http_${String(res.status)}` });
      throw err(
        502,
        'github_unavailable',
        `GitHub answered HTTP ${String(res.status)} updating the App webhook.`,
      );
    }
    const previous = this.#decrypt(row);
    await this.deps.pool.query(
      'UPDATE github_app_connection SET secrets = $1, updated_at = $2 WHERE id = $4 AND app_id = $3',
      [
        this.#encrypt(row.app_id, { ...previous, webhookSecret: secret }),
        this.deps.clock(),
        row.app_id,
        row.id,
      ],
    );
    await audit('success', { events: [...WEBHOOK_EVENTS] });
    return { url, settingsUrl: this.#settingsUrl(row), events: WEBHOOK_EVENTS };
  }

  // --------------------------------------------------------------------------- rename, key rotation, disconnect

  /** p17-chat-github: names a connection in the panel (null: no name — the App's account is shown). Audited. */
  async rename(actor: ConnectActor, connectionId: number, label: string | null): Promise<ConnectionStatus> {
    const row = await this.#select(connectionId);
    const clean = label === null ? null : label.trim();
    if (clean !== null && !LABEL.test(clean)) {
      throw err(400, 'invalid_label', 'A connection name is 1–60 characters on one line.');
    }
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('UPDATE github_app_connection SET label = $2, updated_at = $3 WHERE id = $1', [
        row.id,
        clean,
        this.deps.clock(),
      ]);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'github.connection.rename',
          target: `github-app:${row.app_id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { appId: row.app_id, connection: row.id, from: row.label, to: clean },
        },
        tx,
      );
    });
    return this.status();
  }

  /**
   * Replaces the App's private key with one the owner generated on GitHub (GitHub has no API to create App
   * keys). The key must authenticate as the connected App (`GET /app` with its JWT answers this App id).
   */
  async rotateKey(actor: ConnectActor, pem: string, connectionId?: number): Promise<ConnectionStatus> {
    const row = await this.#select(connectionId);
    const refuse = async (reason: string, message: string): Promise<never> => {
      await this.deps.audit.record({
        actor: { type: 'user', id: actor.userId },
        action: 'github.key.rotate',
        target: `github-app:${row.app_id}`,
        outcome: 'failure',
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: { appId: row.app_id, connection: row.id, reason },
      });
      throw err(400, 'invalid_key', message);
    };
    let auth: GitHubAppAuth;
    try {
      auth = this.#auth(row.app_id, pem);
    } catch (e) {
      return refuse(
        'not_a_key',
        e instanceof GitHubAppKeyError && e.message.includes('RSA')
          ? 'This is not an RSA private key. Upload the .pem file GitHub generated for the App.'
          : 'This is not a PEM private key. Upload the .pem file GitHub generated for the App.',
      );
    }
    const fingerprint = auth.keyFingerprint();
    let check: { status: number; json: unknown };
    try {
      check = await auth.appRequest('GET', '/app');
    } catch {
      throw err(502, 'github_unreachable', 'GitHub could not be reached to check the key. Try again.');
    }
    if (check.status !== 200 || String(obj(check.json).id) !== row.app_id) {
      return refuse(
        'not_this_app',
        `GitHub does not accept this key for App ${row.slug} (HTTP ${String(check.status)}). Generate it in that App's settings.`,
      );
    }
    let previous: StoredSecrets | null = null;
    try {
      previous = this.#decrypt(row);
    } catch {
      previous = null;
    }
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `UPDATE github_app_connection SET secrets = $1, key_fingerprint = $2, key_created_at = $3, updated_at = $3
          WHERE id = $5 AND app_id = $4`,
        [
          this.#encrypt(row.app_id, {
            pem,
            clientSecret: previous?.clientSecret ?? null,
            webhookSecret: previous?.webhookSecret ?? null,
          }),
          fingerprint,
          now,
          row.app_id,
          row.id,
        ],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'github.key.rotate',
          target: `github-app:${row.app_id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: {
            appId: row.app_id,
            connection: row.id,
            previousFingerprint: row.key_fingerprint,
            keyFingerprint: fingerprint,
          },
        },
        tx,
      );
    });
    this.deps.apps.set(row.key_ref, auth);
    this.#broken.delete(row.id);
    return this.status();
  }

  /**
   * Forgets a panel App (key, secrets, installations) — the first one when `connectionId` is left out. The App
   * itself stays on GitHub until the owner deletes it there (no API can). Projects that used it stop getting tokens
   * until they are pointed elsewhere.
   */
  async disconnect(
    actor: ConnectActor,
    connectionId?: number,
  ): Promise<{ readonly affectedProjects: string[]; readonly settingsUrl: string }> {
    const row = await this.#select(connectionId);
    const affected = await withTransaction(this.deps.pool, async (tx) => {
      const projects = (
        await tx.query<{ project: string }>(
          "SELECT project FROM project_git_configs WHERE provider = 'github' AND github_key_ref = $1 ORDER BY project",
          [row.key_ref],
        )
      ).rows.map((r) => r.project);
      await tx.query('DELETE FROM github_app_installations WHERE app_id = $1', [row.app_id]);
      await tx.query('DELETE FROM github_app_connection WHERE id = $1', [row.id]);
      const left = await tx.query('SELECT 1 FROM github_app_connection LIMIT 1');
      if (left.rowCount === 0) await tx.query('DELETE FROM github_manifest_states');
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'github.disconnect',
          target: `github-app:${row.app_id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: {
            appId: row.app_id,
            slug: row.slug,
            connection: row.id,
            keyRef: row.key_ref,
            keyFingerprint: row.key_fingerprint,
            affectedProjects: projects,
          },
        },
        tx,
      );
      return projects;
    });
    this.deps.apps.delete(row.key_ref);
    this.#repoCache.clear();
    this.#broken.delete(row.id);
    return { affectedProjects: affected, settingsUrl: this.#settingsUrl(row) };
  }

  // ------------------------------------------------------------------------------------------------ helpers

  #origin(): string {
    const consoleOrigin = originOf(this.deps.consoleOrigin);
    if (consoleOrigin === null) {
      throw err(
        409,
        'public_origin_unset',
        'The console origin is not configured (PUBLIC_ORIGIN); GitHub needs it to send you back.',
      );
    }
    return consoleOrigin.replace(/\/+$/, '');
  }

  /**
   * A panel App's auth. p17-chat-github: its installation tokens are minted only for installations accepted in
   * the panel (checked in the database on every mint, so every replica sees an acceptance at once).
   */
  #auth(appId: string, pem: string): GitHubAppAuth {
    return GitHubAppAuth.fromPem(appId, pem, {
      apiBaseUrl: this.#api,
      fetch: this.#fetch,
      clock: this.deps.clock,
      timeoutMs: this.#timeoutMs,
      allowInstallation: (installationId) => this.#accepted(appId, installationId),
    });
  }

  async #accepted(appId: string, installationId: number): Promise<boolean> {
    const { rowCount } = await this.deps.pool.query(
      `SELECT 1 FROM github_app_installations
        WHERE installation_id = $1 AND app_id = $2 AND NOT suspended AND accepted_at IS NOT NULL`,
      [installationId, appId],
    );
    return rowCount === 1;
  }

  /** Apps from the environment (key files): every live entry that is not a panel connection. */
  #envApps(): [string, GitHubAppAuth][] {
    return [...this.deps.apps].filter(([ref]) => !isPanelKeyRef(ref));
  }

  /** Connections whose key is loaded: panel Apps (by id), then Apps from the environment. */
  async #usable(): Promise<{ keyRef: string; appId: string; auth: GitHubAppAuth }[]> {
    const out: { keyRef: string; appId: string; auth: GitHubAppAuth }[] = [];
    for (const row of await this.#rows()) {
      const auth = this.deps.apps.get(row.key_ref);
      if (auth?.appId === row.app_id) out.push({ keyRef: row.key_ref, appId: row.app_id, auth });
    }
    for (const [keyRef, auth] of this.#envApps()) out.push({ keyRef, appId: auth.appId, auth });
    return out;
  }

  #encrypt(appId: string, s: StoredSecrets): Buffer {
    return this.#box.encrypt(Buffer.from(JSON.stringify(s), 'utf8'), `github-app:${appId}`);
  }

  #decrypt(row: ConnectionRow): StoredSecrets {
    const o = obj(
      JSON.parse(this.#box.decrypt(row.secrets, `github-app:${row.app_id}`).toString('utf8')) as unknown,
    );
    return {
      pem: str(o.pem),
      clientSecret: typeof o.clientSecret === 'string' ? o.clientSecret : null,
      webhookSecret: typeof o.webhookSecret === 'string' ? o.webhookSecret : null,
    };
  }

  #hasWebhook(row: ConnectionRow): boolean {
    try {
      return this.#decrypt(row).webhookSecret !== null;
    } catch {
      return false;
    }
  }

  #require(row: ConnectionRow | null): { row: ConnectionRow; auth: GitHubAppAuth } {
    if (row === null) throw err(409, 'github_not_connected', 'No GitHub App is connected.');
    const auth = this.deps.apps.get(row.key_ref);
    if (auth?.appId !== row.app_id) {
      throw err(
        409,
        'github_key_unusable',
        'The stored GitHub App key cannot be used. Rotate the key or reconnect.',
      );
    }
    return { row, auth };
  }

  async #rows(): Promise<ConnectionRow[]> {
    const { rows } = await this.deps.pool.query<ConnectionRow>(
      `SELECT id, key_ref, label, app_id, slug, name, owner_login, owner_type, html_url, client_id, permissions,
              secrets, key_fingerprint, key_created_at, created_at
         FROM github_app_connection ORDER BY id`,
    );
    return rows;
  }

  /** The first connection: the one with keyRef `panel`, else the lowest id. */
  #firstOf(rows: readonly ConnectionRow[]): ConnectionRow | null {
    return rows.find((r) => r.key_ref === PANEL_KEY_REF) ?? rows[0] ?? null;
  }

  /** A panel connection by id (the first one when left out); 409 when none is connected, 404 for an unknown id. */
  async #select(connectionId: number | undefined): Promise<ConnectionRow> {
    const rows = await this.#rows();
    if (connectionId === undefined) {
      const first = this.#firstOf(rows);
      if (first === null) throw err(409, 'github_not_connected', 'No GitHub App is connected.');
      return first;
    }
    const row = rows.find((r) => r.id === connectionId);
    if (row === undefined) throw err(404, 'github_connection_not_found', 'GitHub connection not found.');
    return row;
  }

  async #projects(keyRef: string): Promise<ProjectUse[]> {
    const { rows } = await this.deps.pool.query<{
      project: string;
      repository_url: string;
      base_branch: string;
      github_installation_id: string;
    }>(
      `SELECT project, repository_url, base_branch, github_installation_id FROM project_git_configs
        WHERE provider = 'github' AND github_key_ref = $1 ORDER BY project`,
      [keyRef],
    );
    return rows.map((r) => ({
      project: r.project,
      repositoryUrl: r.repository_url,
      baseBranch: r.base_branch,
      installationId: Number(r.github_installation_id),
    }));
  }

  async #installations(appId: string, keyRef: string): Promise<InstallationView[]> {
    const { rows } = await this.deps.pool.query<InstallationRow>(
      `SELECT installation_id, app_id, accepted_at, account_login, account_type, repository_selection, suspended,
              html_url, updated_at, permissions
         FROM github_app_installations WHERE app_id = $1 ORDER BY account_login, installation_id`,
      [appId],
    );
    return rows.map((r) => ({
      appId: r.app_id,
      keyRef,
      accepted: r.accepted_at !== null,
      acceptedAt: r.accepted_at,
      installationId: Number(r.installation_id),
      account: r.account_login,
      accountType: r.account_type,
      repositorySelection: r.repository_selection,
      suspended: r.suspended,
      htmlUrl: r.html_url,
      updatedAt: r.updated_at,
      permissions: r.permissions,
    }));
  }

  async #state(userId: string, state: string): Promise<{ target: string } | null> {
    if (!STATE.test(state)) return null;
    const { rows } = await this.deps.pool.query<{ target: string }>(
      `SELECT target FROM github_manifest_states
        WHERE state_hash = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > $3`,
      [sha256(state), userId, this.deps.clock()],
    );
    return rows[0] ?? null;
  }

  /** Marks the state used (exactly once, same user, unexpired); returns its label, null when refused. */
  async #consume(userId: string, state: string): Promise<{ label: string | null } | null> {
    if (!STATE.test(state)) return null;
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{ label: string | null }>(
      `UPDATE github_manifest_states SET used_at = $3
        WHERE state_hash = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > $3
        RETURNING label`,
      [sha256(state), userId, now],
    );
    return rows[0] ?? null;
  }

  #settingsUrl(row: ConnectionRow): string {
    return row.owner_type === 'Organization'
      ? `${this.#web}/organizations/${encodeURIComponent(row.owner_login)}/settings/apps/${row.slug}`
      : `${this.#web}/settings/apps/${row.slug}`;
  }

  #view(row: ConnectionRow): PanelAppView {
    const auth = this.deps.apps.get(row.key_ref);
    return {
      appId: row.app_id,
      slug: row.slug,
      name: row.name,
      owner: { login: row.owner_login, type: row.owner_type },
      htmlUrl: row.html_url,
      installUrl: `${this.#web}/apps/${row.slug}/installations/new`,
      settingsUrl: this.#settingsUrl(row),
      permissions: row.permissions,
      missingPermissions: missing(row.permissions),
      keyFingerprint: row.key_fingerprint,
      keyCreatedAt: row.key_created_at,
      keyUsable: !this.#broken.has(row.id) && auth?.appId === row.app_id,
      connectedAt: row.created_at,
    };
  }
}

const LEVEL: Readonly<Record<string, number>> = { read: 1, write: 2, admin: 3 };

/** Needed permissions the App lacks (or has at a lower level), e.g. `pull_requests:write`. */
function missing(have: Readonly<Record<string, string>>): string[] {
  return Object.entries(MANIFEST_PERMISSIONS)
    .filter(([k, v]) => (LEVEL[have[k] ?? ''] ?? 0) < (LEVEL[v] ?? 0))
    .map(([k, v]) => `${k}:${v}`);
}
