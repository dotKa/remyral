import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import { maxAgeFor, sessionStepUp, type StepUpPolicy, stepUpFreshAt } from '../auth/step-up.js';
import type { SessionRecord } from '../auth/sessions.js';
import type { Role } from '../auth/users.js';
import { authorize as authorizeAction, type Subject } from '../authz/model.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { type OidcProviderConfig, issuerOf } from './config.js';
import { atHash } from './keys.js';
import { type Sealer } from './sealed.js';

/**
 * Minimal OpenID Connect provider for one confidential client (Coolify): authorization code flow with
 * mandatory PKCE (S256), RS256 ID tokens, userinfo. Behaviour and order of checks:
 * docs/design/p5-coolify-sso.md §2.
 */
export const CODE_TTL_MS = 60_000;
export const ACCESS_TOKEN_TTL_MS = 5 * 60_000;
export const ID_TOKEN_TTL_MS = 5 * 60_000;
/** Lifetime of a sealed authorize request waiting for sign-in / step-up (Coolify's own flow state: 10 min). */
export const RESUME_TTL_MS = 10 * 60_000;
export const SUPPORTED_SCOPES = ['openid', 'email', 'profile'] as const;
/** RBAC action for both halves of the feature (owner/admin; src/authz/model.ts). */
export const SSO_ACTION = 'sso.coolify';

export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** The validated authorize parameters (also the sealed payload of a resumed request). */
export interface AuthorizeParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly state: string | null;
  readonly nonce: string | null;
  readonly codeChallenge: string;
  readonly prompt: string | null;
}

/** What the HTTP layer does with an authorize request. */
export type AuthorizeOutcome =
  | {
      readonly kind: 'page';
      readonly status: 400 | 404;
      readonly error: string;
      readonly description: string;
    }
  | { readonly kind: 'redirect'; readonly location: string };

type Query = Readonly<Record<string, unknown>>;

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const PRINTABLE = /^[!-~]{1,512}$/;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function epoch(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

export class OidcError extends Error {
  constructor(
    readonly status: 400 | 401,
    readonly error: string,
    readonly description: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(description);
    this.name = 'OidcError';
  }
}

interface UserRow {
  id: string;
  username: string;
  role: Role;
  disabled_at: Date | null;
}

export class OidcProvider {
  readonly issuer: string;

  constructor(
    private readonly deps: {
      readonly config: OidcProviderConfig;
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly sealer: Sealer;
      readonly clock: () => Date;
      /** p5-stepup-window: the console's step-up windows (default: 10 min / whole long-lived session). */
      readonly stepUp?: StepUpPolicy;
    },
  ) {
    this.issuer = issuerOf(deps.config.consoleOrigin);
  }

  discovery(): Record<string, unknown> {
    const i = this.issuer;
    return {
      issuer: i,
      authorization_endpoint: `${i}/authorize`,
      token_endpoint: `${i}/token`,
      userinfo_endpoint: `${i}/userinfo`,
      jwks_uri: `${i}/jwks`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [...SUPPORTED_SCOPES],
      claims_supported: [
        'sub',
        'iss',
        'aud',
        'exp',
        'iat',
        'auth_time',
        'nonce',
        'amr',
        'at_hash',
        'email',
        'email_verified',
        'name',
        'preferred_username',
      ],
      claims_parameter_supported: false,
      request_parameter_supported: false,
      request_uri_parameter_supported: false,
      authorization_response_iss_parameter_supported: true,
    };
  }

  jwks(): { keys: unknown[] } {
    return { keys: [this.deps.config.signingKey.jwk] };
  }

  // ------------------------------------------------------------------------------------------- authorize

  /**
   * Validates an authorize request. Returns either the parameters, or an outcome that ends the request
   * (an error page for client/redirect problems — never a redirect — or an error redirect to the
   * registered redirect URI).
   */
  parseAuthorize(query: Query): AuthorizeParams | AuthorizeOutcome {
    for (const value of Object.values(query)) {
      if (Array.isArray(value)) {
        return page(400, 'invalid_request', 'A parameter was sent more than once.');
      }
    }
    const str = (k: string): string | null => {
      const v = query[k];
      return typeof v === 'string' && v !== '' ? v : null;
    };
    const client = this.deps.config.client;
    const clientId = str('client_id');
    if (clientId === null || clientId !== client.id) {
      return page(400, 'invalid_client', 'Unknown client.');
    }
    const redirectUri = str('redirect_uri');
    if (redirectUri === null || !client.redirectUris.includes(redirectUri)) {
      return page(400, 'invalid_request', 'The redirect URI is not registered for this client.');
    }
    const state = str('state');
    const fail = (error: string, description: string): AuthorizeOutcome =>
      this.errorRedirect(
        redirectUri,
        state !== null && PRINTABLE.test(state) ? state : null,
        error,
        description,
      );
    if (state !== null && !PRINTABLE.test(state)) return fail('invalid_request', 'Invalid state.');
    if (str('request') !== null || str('request_uri') !== null) {
      return fail('request_not_supported', 'Request objects are not supported.');
    }
    if (str('response_type') !== 'code') {
      return fail('unsupported_response_type', 'Only the authorization code flow is supported.');
    }
    const responseMode = str('response_mode');
    if (responseMode !== null && responseMode !== 'query') {
      return fail('invalid_request', 'Only response_mode=query is supported.');
    }
    const requested = (str('scope') ?? '').split(' ').filter((s) => s !== '');
    if (!requested.includes('openid')) return fail('invalid_scope', 'The openid scope is required.');
    const scope = SUPPORTED_SCOPES.filter((s) => requested.includes(s)).join(' ');
    const nonce = str('nonce');
    if (nonce !== null && !PRINTABLE.test(nonce)) return fail('invalid_request', 'Invalid nonce.');
    const challenge = str('code_challenge');
    if (challenge === null || str('code_challenge_method') !== 'S256' || !CHALLENGE.test(challenge)) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    const prompt = str('prompt');
    if (prompt !== null && !/^[a-z_ ]{1,64}$/.test(prompt)) return fail('invalid_request', 'Invalid prompt.');
    return { clientId, redirectUri, scope, state, nonce, codeChallenge: challenge, prompt };
  }

  /** Seals validated parameters for the console round trip (`/sso/continue?flow=oidc&r=…`). */
  sealRequest(params: AuthorizeParams): string {
    return this.deps.sealer.seal('oidc', params, new Date(this.deps.clock().getTime() + RESUME_TTL_MS));
  }

  /** Opens a sealed request and re-validates it like a fresh one (the configuration may have changed). */
  openRequest(sealed: unknown): AuthorizeParams | AuthorizeOutcome {
    const data = this.deps.sealer.open('oidc', sealed, this.deps.clock());
    if (data === null || typeof data !== 'object') {
      return page(400, 'invalid_request', 'This sign-in request has expired. Start again from Coolify.');
    }
    const p = data as Partial<AuthorizeParams>;
    return this.parseAuthorize({
      client_id: p.clientId,
      redirect_uri: p.redirectUri,
      response_type: 'code',
      scope: p.scope,
      ...(p.state === null || p.state === undefined ? {} : { state: p.state }),
      ...(p.nonce === null || p.nonce === undefined ? {} : { nonce: p.nonce }),
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      ...(p.prompt === null || p.prompt === undefined ? {} : { prompt: p.prompt }),
    });
  }

  /**
   * The session/authorization half of authorize (steps 3–7 of the design note). `session` is the full
   * console session of the request, or null.
   */
  async decide(
    params: AuthorizeParams,
    session: SessionRecord | null,
    meta: RequestMeta,
  ): Promise<AuthorizeOutcome> {
    const now = this.deps.clock();
    const promptNone = params.prompt?.split(' ').includes('none') === true;
    const fail = (error: string, description: string): AuthorizeOutcome =>
      this.errorRedirect(params.redirectUri, params.state, error, description);
    if (session === null) {
      if (promptNone) return fail('login_required', 'Sign in to the console first.');
      return this.toConsole(params);
    }
    const user = session.user;
    const subject: Subject = { userId: user.id, role: user.role, memberships: new Map() };
    const audit = (outcome: 'denied' | 'success', metadata: Record<string, unknown>, tx?: Queryable) =>
      this.deps.audit.record(
        {
          actor: { type: 'user', id: user.id },
          action: 'oidc.authorize',
          target: `oidc-client:${params.clientId}`,
          outcome,
          ip: meta.ip,
          userAgent: meta.userAgent,
          metadata: { clientId: params.clientId, ...metadata },
        },
        tx,
      );
    if (!authorizeAction(subject, SSO_ACTION).allow) {
      await audit('denied', { reason: 'role', role: user.role });
      return fail('access_denied', 'Coolify sign-in needs the owner or admin role.');
    }
    const email = this.deps.config.emails.get(user.username);
    if (email === undefined) {
      await audit('denied', { reason: 'no_email_mapping' });
      return fail('access_denied', 'No e-mail address is mapped for this account (OIDC_EMAIL_MAP).');
    }
    // p5-stepup-window: the same rule as the console's privileged actions — the standard window, or, on a
    // remember-me / trusted-device session, one TOTP for the rest of the session ("Open Coolify" then does
    // not ask again).
    const mfaAt = session.mfaAt;
    if (mfaAt === null || !stepUpFreshAt(mfaAt, now, maxAgeFor(sessionStepUp(session, this.deps.stepUp)))) {
      if (promptNone) return fail('interaction_required', 'A fresh authenticator confirmation is required.');
      return this.toConsole(params);
    }
    const code = token();
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('DELETE FROM oidc_authorization_codes WHERE expires_at < $1', [
        new Date(now.getTime() - 60 * 60_000),
      ]);
      await tx.query(
        `INSERT INTO oidc_authorization_codes (code_hash, client_id, user_id, redirect_uri, scope, nonce,
           code_challenge, code_challenge_method, auth_time, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'S256', $8, $9, $10)`,
        [
          sha256(code),
          params.clientId,
          user.id,
          params.redirectUri,
          params.scope,
          params.nonce,
          params.codeChallenge,
          mfaAt,
          now,
          new Date(now.getTime() + CODE_TTL_MS),
        ],
      );
      await audit('success', { scope: params.scope, event: 'code_issued' }, tx);
    });
    const location = new URL(params.redirectUri);
    location.searchParams.set('code', code);
    if (params.state !== null) location.searchParams.set('state', params.state);
    location.searchParams.set('iss', this.issuer);
    return { kind: 'redirect', location: location.href };
  }

  private toConsole(params: AuthorizeParams): AuthorizeOutcome {
    const r = this.sealRequest(params);
    // Relative: resolved against the console origin the request came through (/api/oidc/authorize).
    return { kind: 'redirect', location: `/sso/continue?flow=oidc&r=${r}` };
  }

  private errorRedirect(
    redirectUri: string,
    state: string | null,
    error: string,
    description: string,
  ): AuthorizeOutcome {
    const location = new URL(redirectUri);
    location.searchParams.set('error', error);
    location.searchParams.set('error_description', description);
    if (state !== null) location.searchParams.set('state', state);
    location.searchParams.set('iss', this.issuer);
    return { kind: 'redirect', location: location.href };
  }

  // ----------------------------------------------------------------------------------------------- token

  /**
   * The token endpoint. `form` is the parsed form body (repeated parameters already rejected by the
   * caller), `authorization` the raw Authorization header. Throws {@link OidcError}.
   */
  async token(
    form: ReadonlyMap<string, string>,
    authorization: string | undefined,
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const now = this.deps.clock();
    const client = this.deps.config.client;
    const auditFailure = (reason: string, userId: string | null = null) =>
      this.deps.audit.record({
        actor: userId === null ? { type: 'anonymous' } : { type: 'user', id: userId },
        action: 'oidc.token',
        target: `oidc-client:${client.id}`,
        outcome: 'failure',
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata: { reason },
      });

    // Client authentication: exactly one of client_secret_basic / client_secret_post.
    const basic = parseBasic(authorization);
    const postSecret = form.get('client_secret');
    if (basic === 'malformed' || (basic !== null && postSecret !== undefined)) {
      throw new OidcError(400, 'invalid_request', 'Use exactly one client authentication method.');
    }
    const clientId = basic?.id ?? form.get('client_id');
    const secret = basic?.secret ?? postSecret;
    if (basic !== null && form.has('client_id') && form.get('client_id') !== basic.id) {
      throw new OidcError(400, 'invalid_request', 'client_id does not match the authenticated client.');
    }
    if (clientId !== client.id || secret === undefined || !secretEquals(secret, client.secret)) {
      await auditFailure('invalid_client');
      throw new OidcError(
        401,
        'invalid_client',
        'Client authentication failed.',
        basic === null ? {} : { 'www-authenticate': 'Basic realm="remyral-oidc"' },
      );
    }
    if (form.get('grant_type') !== 'authorization_code') {
      throw new OidcError(400, 'unsupported_grant_type', 'Only authorization_code is supported.');
    }
    const code = form.get('code');
    const redirectUri = form.get('redirect_uri');
    const verifier = form.get('code_verifier');
    if (code === undefined || !/^[A-Za-z0-9_-]{43}$/.test(code)) {
      await auditFailure('malformed_code');
      throw new OidcError(400, 'invalid_grant', 'The authorization code is invalid.');
    }
    const codeHash = sha256(code);

    const result = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{
        client_id: string;
        user_id: string;
        redirect_uri: string;
        scope: string;
        nonce: string | null;
        code_challenge: string;
        auth_time: Date;
        expires_at: Date;
      }>(
        `UPDATE oidc_authorization_codes SET used_at = $2
          WHERE code_hash = $1 AND used_at IS NULL
          RETURNING client_id, user_id, redirect_uri, scope, nonce, code_challenge, auth_time, expires_at`,
        [codeHash, now],
      );
      const row = rows[0];
      if (!row) {
        // Unknown, or already used: a replay revokes what the first use obtained (RFC 6749 §4.1.2).
        const { rows: used } = await tx.query<{ user_id: string }>(
          'SELECT user_id FROM oidc_authorization_codes WHERE code_hash = $1 AND used_at IS NOT NULL',
          [codeHash],
        );
        const replayed = used[0];
        if (replayed) {
          const { rowCount } = await tx.query('DELETE FROM oidc_access_tokens WHERE code_hash = $1', [
            codeHash,
          ]);
          await this.deps.audit.record(
            {
              actor: { type: 'user', id: replayed.user_id },
              action: 'oidc.code.replay',
              target: `oidc-client:${client.id}`,
              outcome: 'denied',
              ip: meta.ip,
              userAgent: meta.userAgent,
              metadata: { revokedGrants: rowCount ?? 0 },
            },
            tx,
          );
          return { error: 'replayed' as const };
        }
        return { error: 'unknown_code' as const };
      }
      if (row.expires_at <= now) return { error: 'expired_code' as const, userId: row.user_id };
      if (row.client_id !== client.id) return { error: 'client_mismatch' as const, userId: row.user_id };
      if (redirectUri !== row.redirect_uri)
        return { error: 'redirect_uri_mismatch' as const, userId: row.user_id };
      if (verifier === undefined || !VERIFIER.test(verifier)) {
        return { error: 'missing_verifier' as const, userId: row.user_id };
      }
      if (createHash('sha256').update(verifier, 'ascii').digest('base64url') !== row.code_challenge) {
        return { error: 'pkce_mismatch' as const, userId: row.user_id };
      }
      const { rows: users } = await tx.query<UserRow>(
        'SELECT id, username, role, disabled_at FROM users WHERE id = $1',
        [row.user_id],
      );
      const user = users[0];
      if (!user || user.disabled_at !== null) return { error: 'user_inactive' as const, userId: row.user_id };
      const subject: Subject = { userId: user.id, role: user.role, memberships: new Map() };
      if (!authorizeAction(subject, SSO_ACTION).allow) return { error: 'role' as const, userId: user.id };
      const email = this.deps.config.emails.get(user.username);
      if (email === undefined) return { error: 'no_email_mapping' as const, userId: user.id };

      const accessToken = token();
      await tx.query('DELETE FROM oidc_access_tokens WHERE expires_at < $1', [now]);
      await tx.query(
        `INSERT INTO oidc_access_tokens (token_hash, code_hash, client_id, user_id, scope, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sha256(accessToken),
          codeHash,
          client.id,
          user.id,
          row.scope,
          now,
          new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
        ],
      );
      const scopes = row.scope.split(' ');
      const idToken = this.deps.config.signingKey.signJwt({
        iss: this.issuer,
        sub: user.id,
        aud: client.id,
        iat: epoch(now),
        exp: epoch(now) + ID_TOKEN_TTL_MS / 1000,
        auth_time: epoch(row.auth_time),
        ...(row.nonce === null ? {} : { nonce: row.nonce }),
        at_hash: atHash(accessToken),
        amr: ['pwd', 'otp', 'mfa'],
        ...this.claims(user, email, scopes),
      });
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: user.id },
          action: 'oidc.token',
          target: `oidc-client:${client.id}`,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          metadata: { clientId: client.id, scope: row.scope },
        },
        tx,
      );
      return {
        response: {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: ACCESS_TOKEN_TTL_MS / 1000,
          id_token: idToken,
          scope: row.scope,
        },
      };
    });
    if ('response' in result) return result.response;
    await auditFailure(result.error, 'userId' in result ? result.userId : null);
    throw new OidcError(400, 'invalid_grant', 'The authorization code is invalid, expired or already used.');
  }

  private claims(
    user: { id: string; username: string },
    email: string,
    scopes: readonly string[],
  ): Record<string, unknown> {
    return {
      ...(scopes.includes('email') ? { email, email_verified: true } : {}),
      ...(scopes.includes('profile') ? { name: user.username, preferred_username: user.username } : {}),
    };
  }

  // -------------------------------------------------------------------------------------------- userinfo

  async userinfo(authorization: string | undefined): Promise<Record<string, unknown>> {
    const invalid = () =>
      new OidcError(401, 'invalid_token', 'The access token is invalid or expired.', {
        'www-authenticate': 'Bearer realm="remyral-oidc", error="invalid_token"',
      });
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    const presented = m?.[1];
    if (presented === undefined) {
      throw new OidcError(401, 'invalid_token', 'A bearer access token is required.', {
        'www-authenticate': 'Bearer realm="remyral-oidc"',
      });
    }
    const { rows } = await this.deps.pool.query<UserRow & { scope: string; expires_at: Date }>(
      `SELECT u.id, u.username, u.role, u.disabled_at, t.scope, t.expires_at
         FROM oidc_access_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1`,
      [sha256(presented)],
    );
    const row = rows[0];
    if (!row || row.expires_at <= this.deps.clock() || row.disabled_at !== null) throw invalid();
    const email = this.deps.config.emails.get(row.username);
    if (email === undefined) throw invalid();
    return { sub: row.id, ...this.claims(row, email, row.scope.split(' ')) };
  }
}

function page(status: 400 | 404, error: string, description: string): AuthorizeOutcome {
  return { kind: 'page', status, error, description };
}

/** RFC 6749 §2.3.1: Basic with form-urlencoded id and secret. null = no Basic header. */
function parseBasic(header: string | undefined): { id: string; secret: string } | null | 'malformed' {
  if (header === undefined) return null;
  const m = /^Basic ([A-Za-z0-9+/=]{1,1024})$/i.exec(header);
  if (!m?.[1]) return 'malformed';
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return 'malformed';
  try {
    const plus = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));
    return { id: plus(decoded.slice(0, colon)), secret: plus(decoded.slice(colon + 1)) };
  } catch {
    return 'malformed';
  }
}

export function isOutcome(v: AuthorizeParams | AuthorizeOutcome): v is AuthorizeOutcome {
  return 'kind' in v;
}
