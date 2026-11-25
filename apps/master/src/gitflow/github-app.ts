import { createHash, createPrivateKey, createPublicKey, createSign, type KeyObject } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { ProviderError } from './types.js';

/**
 * GitHub App authentication (ADR-0006 §3, docs/ops/github-app.md). **UNVERIFIED-LIVE**: implemented
 * against the documented REST API (`POST /app/installations/{installation_id}/access_tokens`) and tested
 * with recorded fixtures only — the owner has no GitHub repository yet.
 *
 * - The App's private key is read from a file on the master (mode 0600, never logged, never stored in the
 *   database); the project configuration names only the installation id and a key reference.
 * - Each installation token is minted for exactly one repository with explicit permissions and lives at
 *   most one hour (GitHub's limit). Master tokens are cached in memory until five minutes before expiry;
 *   worker tokens are minted per request and never cached or persisted.
 */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export type InstallationPermissions = Readonly<Record<string, 'read' | 'write'>>;

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface GitHubAppAuthOptions {
  readonly appId: string;
  readonly privateKey: KeyObject;
  /** `https://api.github.com` or a GitHub Enterprise Server `https://<host>/api/v3`. */
  readonly apiBaseUrl?: string;
  readonly fetch?: FetchFn;
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
  /**
   * p17-chat-github: whether an installation may be used (panel Apps: accepted in the panel). Checked before every
   * installation token, cached or not; absent: every installation (Apps from the environment).
   */
  readonly allowInstallation?: (installationId: number) => Promise<boolean>;
}

export class GitHubAppKeyError extends Error {
  override name = 'GitHubAppKeyError';
}

/** Permissions of the master's own token (PR, merge, checks). */
export const MASTER_PERMISSIONS: InstallationPermissions = {
  contents: 'write',
  pull_requests: 'write',
  checks: 'read',
  metadata: 'read',
};

/** Permissions of a worker's push token: push its attempt branch, nothing else the App could do. */
export const WORKER_PERMISSIONS: InstallationPermissions = { contents: 'write', metadata: 'read' };

/** p6-automations-next (ADR-0026): fetch-only token of a pinned pull request head job (untrusted, never pushes). */
export const WORKER_READ_PERMISSIONS: InstallationPermissions = { contents: 'read', metadata: 'read' };

/** Permissions of the master's repository-listing token (p5-github-connect picker): names and metadata only. */
export const LIST_PERMISSIONS: InstallationPermissions = { metadata: 'read' };

const REFRESH_BEFORE_MS = 5 * 60_000;

export class GitHubAppAuth {
  readonly appId: string;
  readonly apiBaseUrl: string;
  readonly #key: KeyObject;
  readonly #fetch: FetchFn;
  readonly #clock: () => Date;
  readonly #timeoutMs: number;
  readonly #cache = new Map<string, InstallationToken>();
  readonly #allow: ((installationId: number) => Promise<boolean>) | undefined;

  constructor(opts: GitHubAppAuthOptions) {
    if (!/^[A-Za-z0-9.]{1,64}$/.test(opts.appId)) throw new GitHubAppKeyError('invalid GitHub App id');
    if (opts.privateKey.asymmetricKeyType !== 'rsa') {
      throw new GitHubAppKeyError('GitHub App private key must be an RSA key');
    }
    this.appId = opts.appId;
    this.#key = opts.privateKey;
    this.apiBaseUrl = (opts.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#clock = opts.clock ?? (() => new Date());
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
    this.#allow = opts.allowInstallation;
  }

  /** Reads the PEM key file (refused when group/other-readable). The content is never logged. */
  static async fromFile(
    appId: string,
    path: string,
    opts: Omit<GitHubAppAuthOptions, 'appId' | 'privateKey'> = {},
  ): Promise<GitHubAppAuth> {
    let pem: string;
    try {
      const st = await stat(path);
      if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
        throw new GitHubAppKeyError('GitHub App key file must not be readable by group/others (chmod 600)');
      }
      pem = await readFile(path, 'utf8');
    } catch (err) {
      if (err instanceof GitHubAppKeyError) throw err;
      throw new GitHubAppKeyError(
        `cannot read the GitHub App key file: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
      );
    }
    return GitHubAppAuth.fromPem(appId, pem, opts, 'GitHub App key file is not a PEM private key');
  }

  /**
   * p5-github-connect: an App whose key the panel stores encrypted (ADR-0022). The PEM text is parsed here and
   * never logged; error messages never contain it.
   */
  static fromPem(
    appId: string,
    pem: string,
    opts: Omit<GitHubAppAuthOptions, 'appId' | 'privateKey'> = {},
    notPem = 'not a PEM private key',
  ): GitHubAppAuth {
    let key: KeyObject;
    try {
      key = createPrivateKey(pem);
    } catch {
      throw new GitHubAppKeyError(notPem);
    }
    return new GitHubAppAuth({ appId, privateKey: key, ...opts });
  }

  /** Non-secret identity of the key: `SHA256:<base64>` of its public key (SPKI DER), as GitHub shows it. */
  keyFingerprint(): string {
    const der = createPublicKey(this.#key).export({ type: 'spki', format: 'der' });
    return `SHA256:${createHash('sha256').update(der).digest('base64')}`;
  }

  /**
   * A request authenticated as the App itself (JWT): `GET /app`, `GET /app/installations`, … Answers status
   * and parsed JSON; network errors throw a transient {@link ProviderError}.
   */
  async appRequest(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.apiBaseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.jwt()}`,
          'user-agent': 'remyral-gitflow',
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new ProviderError(`GitHub ${method} ${path.split('?')[0] ?? ''} failed (network)`, true);
    }
    const json: unknown = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, json };
  }

  /** App JWT (RS256): `iat` 60 s in the past against clock drift, `exp` 9 minutes ahead (max 10). */
  jwt(): string {
    const now = Math.floor(this.#clock().getTime() / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: this.appId })}`;
    const sig = createSign('RSA-SHA256').update(input).sign(this.#key).toString('base64url');
    return `${input}.${sig}`;
  }

  /**
   * An installation token for exactly one repository. `cache: true` (master's own calls) reuses a token
   * until five minutes before it expires.
   */
  async installationToken(
    installationId: number,
    /** One repository (`repo` name), or null for every repository of the installation (repository listing). */
    repository: string | null,
    permissions: InstallationPermissions,
    opts: { readonly cache?: boolean } = {},
  ): Promise<InstallationToken> {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new ProviderError('invalid installation id', false);
    }
    if (this.#allow !== undefined && !(await this.#allow(installationId))) {
      throw new ProviderError(
        'This GitHub App installation is not accepted in Settings → Integrations → GitHub',
        false,
        403,
      );
    }
    const key = `${String(installationId)}\u0000${repository ?? '*'}\u0000${JSON.stringify(permissions)}`;
    const cached = opts.cache === true ? this.#cache.get(key) : undefined;
    if (cached !== undefined && cached.expiresAt.getTime() - REFRESH_BEFORE_MS > this.#clock().getTime()) {
      return cached;
    }
    let res: Response;
    try {
      res = await this.#fetch(
        `${this.apiBaseUrl}/app/installations/${String(installationId)}/access_tokens`,
        {
          method: 'POST',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${this.jwt()}`,
            'content-type': 'application/json',
            'user-agent': 'remyral-gitflow',
            'x-github-api-version': '2022-11-28',
          },
          body: JSON.stringify(
            repository === null ? { permissions } : { repositories: [repository], permissions },
          ),
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch {
      throw new ProviderError('GitHub token request failed (network)', true);
    }
    if (res.status !== 201) {
      throw new ProviderError(
        `GitHub refused the installation token request (HTTP ${String(res.status)})`,
        res.status >= 500 || res.status === 429,
        res.status,
      );
    }
    const body = (await res.json().catch(() => null)) as { token?: unknown; expires_at?: unknown } | null;
    const token = typeof body?.token === 'string' ? body.token : '';
    const expiresAt = typeof body?.expires_at === 'string' ? new Date(body.expires_at) : new Date(NaN);
    if (token.length < 8 || Number.isNaN(expiresAt.getTime())) {
      throw new ProviderError('GitHub returned a malformed installation token response', false, 201);
    }
    const out = { token, expiresAt };
    if (opts.cache === true) this.#cache.set(key, out);
    return out;
  }

  toJSON(): unknown {
    return { appId: this.appId, apiBaseUrl: this.apiBaseUrl };
  }
}
