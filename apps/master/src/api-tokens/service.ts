import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { forbidden } from '../http/route-authz.js';
import { type Role, roleAtLeast } from '../authz/model.js';
import { USERNAME_PATTERN } from '../auth/users.js';
import { stepUpRequiredError } from '../auth/hooks.js';
import { STEP_UP_ALWAYS_FRESH_MS, stepUpFreshAt } from '../auth/step-up.js';
import {
  isStepUpEvent,
  STEP_UP_EVENT_IDS,
  STEP_UP_EVENTS,
  type StepUpEvent,
} from '../security-policy/events.js';
import type { SecurityPolicyReader } from '../security-policy/service.js';
import { formatCidr, MAX_CIDRS, parseCidr } from './cidr.js';
import { generateToken, hashToken, type TokenKind, tokenHint } from './format.js';
import { reachableScopes, TOKEN_SCOPES, type TokenScope } from './scopes.js';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md, ADR-0058): API tokens and service accounts — storage, lifecycle and
 * the lookup the bearer authenticator uses. Secrets are returned once by `create` / `rotate` and never stored: the
 * table holds `HMAC-SHA256(k, token)` only (format.ts).
 */

export const TOKEN_STATES = ['active', 'expired', 'revoked'] as const;
export type TokenState = (typeof TOKEN_STATES)[number];

/** Live (not revoked, not expired) tokens a principal may hold. */
export const MAX_LIVE_TOKENS = 50;
/** Default and maximum rotation overlap (minutes) during which the previous secret still works. */
export const DEFAULT_OVERLAP_MINUTES = 60;
export const MAX_OVERLAP_MINUTES = 24 * 60;
/** The lifetime the console proposes (capped by the policy's maximum). */
export const DEFAULT_TOKEN_DAYS = 90;
/** Notice before expiry. */
export const EXPIRY_NOTICE_MS = 7 * 24 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApiTokenRecord {
  readonly id: string;
  readonly kind: TokenKind;
  readonly principal: { readonly id: string; readonly username: string; readonly role: Role };
  readonly name: string;
  readonly scopes: readonly TokenScope[];
  readonly grantedEvents: readonly string[];
  readonly allowedCidrs: readonly string[];
  readonly hint: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly createdBy: { readonly id: string; readonly username: string } | null;
  readonly rotatedAt: Date | null;
  /** The previous secret works until then (rotation overlap); null when none. */
  readonly previousValidUntil: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedBy: { readonly id: string; readonly username: string } | null;
  readonly lastUsedAt: Date | null;
  readonly lastUsedIp: string | null;
  readonly useCount: number;
  readonly state: TokenState;
}

export interface ServiceAccountRecord {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly description: string | null;
  readonly disabled: boolean;
  readonly createdAt: Date;
  readonly createdBy: { readonly id: string; readonly username: string } | null;
  readonly memberships: readonly { readonly project: string; readonly role: string }[];
  readonly tokens: readonly ApiTokenRecord[];
}

/** Who acts (a person with a session; tokens never reach these endpoints). */
export interface TokenActor {
  readonly userId: string;
  readonly role: Role;
  /** The session's real authenticator time (not a waived one): event grants need a code from the last 10 minutes. */
  readonly realMfaAt: Date | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface CreateTokenInput {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly expiresInDays: number;
  readonly allowedCidrs?: readonly string[] | undefined;
  readonly grantedEvents?: readonly string[] | undefined;
}

export interface RotateTokenInput {
  readonly overlapMinutes?: number | undefined;
  /** New lifetime from now; default: the token's previous lifetime (capped by the policy). */
  readonly expiresInDays?: number | undefined;
}

export interface IssuedToken {
  readonly token: ApiTokenRecord;
  /** The secret — returned once, never stored or logged. */
  readonly secret: string;
}

/** What the authenticator needs about a presented token. */
export interface TokenLookup {
  readonly id: string;
  readonly kind: TokenKind;
  readonly name: string;
  readonly scopes: readonly TokenScope[];
  readonly grantedEvents: readonly StepUpEvent[];
  readonly allowedCidrs: readonly string[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  /** The presented secret is the previous one; it works until this time (null: it is the current one). */
  readonly previousUntil: Date | null;
  readonly principal: {
    readonly id: string;
    readonly username: string;
    readonly role: Role;
    readonly kind: 'human' | 'service';
    readonly disabled: boolean;
  };
}

/** The events an admin may grant a token (never the safe core). */
export const GRANTABLE_EVENTS: readonly StepUpEvent[] = STEP_UP_EVENT_IDS.filter(
  (e) => !STEP_UP_EVENTS[e].core,
);

interface TokenRow {
  id: string;
  kind: TokenKind;
  principal_id: string;
  principal_username: string;
  principal_role: Role;
  name: string;
  scopes: string[];
  granted_events: string[];
  allowed_cidrs: string[];
  hint: string;
  expires_at: Date;
  created_at: Date;
  created_by: string | null;
  created_by_username: string | null;
  rotated_at: Date | null;
  previous_valid_until: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoked_by_username: string | null;
  last_used_at: Date | null;
  last_used_ip: string | null;
  use_count: string;
}

const SELECT_TOKEN = `
  SELECT t.id, t.kind, t.principal_id, p.username AS principal_username, p.role AS principal_role, t.name, t.scopes,
         t.granted_events, t.allowed_cidrs, t.hint, t.expires_at, t.created_at, t.created_by,
         c.username AS created_by_username, t.rotated_at, t.previous_valid_until, t.revoked_at, t.revoked_by,
         r.username AS revoked_by_username, t.last_used_at, t.last_used_ip, t.use_count::text AS use_count
    FROM api_tokens t
    JOIN users p ON p.id = t.principal_id
    LEFT JOIN users c ON c.id = t.created_by
    LEFT JOIN users r ON r.id = t.revoked_by`;

function scopesOf(values: readonly string[]): TokenScope[] {
  return TOKEN_SCOPES.filter((s) => values.includes(s));
}

export function tokenState(t: { revokedAt: Date | null; expiresAt: Date }, now: Date): TokenState {
  if (t.revokedAt !== null) return 'revoked';
  return t.expiresAt <= now ? 'expired' : 'active';
}

function toRecord(r: TokenRow, now: Date): ApiTokenRecord {
  const revokedAt = r.revoked_at;
  return {
    id: r.id,
    kind: r.kind,
    principal: { id: r.principal_id, username: r.principal_username, role: r.principal_role },
    name: r.name,
    scopes: scopesOf(r.scopes),
    grantedEvents: r.granted_events,
    allowedCidrs: r.allowed_cidrs,
    hint: r.hint,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    createdBy: r.created_by === null ? null : { id: r.created_by, username: r.created_by_username ?? '' },
    rotatedAt: r.rotated_at,
    previousValidUntil:
      revokedAt === null && r.previous_valid_until !== null && r.previous_valid_until > now
        ? r.previous_valid_until
        : null,
    revokedAt,
    revokedBy: r.revoked_by === null ? null : { id: r.revoked_by, username: r.revoked_by_username ?? '' },
    lastUsedAt: r.last_used_at,
    lastUsedIp: r.last_used_ip,
    useCount: Number(r.use_count),
    state: tokenState({ revokedAt, expiresAt: r.expires_at }, now),
  };
}

function badRequest(code: string, message: string, params: Record<string, unknown> = {}): HttpError {
  return new HttpError(400, code, message, {}, {}, params);
}

function tokenNotFound(): HttpError {
  return new HttpError(404, 'not_found', 'Not found.', {}, {}, { reason: 'api_token' });
}

function accountNotFound(): HttpError {
  return new HttpError(404, 'not_found', 'Not found.', {}, {}, { reason: 'service_account' });
}

/**
 * An unusable password hash for a service account: the `$scrypt$` prefix the users table requires, but not a decodable
 * hash — `verifyPassword` answers false for it without work, and the login lookup never returns service accounts anyway.
 */
export const SERVICE_ACCOUNT_PASSWORD_HASH = '$scrypt$service-account$no-login';

export interface ApiTokenServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  /** HMAC key of token hashes (`SecretBox.deriveKey('api-token')`). */
  readonly hashKey: Buffer;
  readonly securityPolicy: SecurityPolicyReader;
  readonly clock?: () => Date;
}

export class ApiTokenService {
  readonly #pool: Pool;
  readonly #audit: AuditRecorder;
  readonly #key: Buffer;
  readonly #policy: SecurityPolicyReader;
  readonly #now: () => Date;

  constructor(deps: ApiTokenServiceDeps) {
    this.#pool = deps.pool;
    this.#audit = deps.audit;
    this.#key = deps.hashKey;
    this.#policy = deps.securityPolicy;
    this.#now = deps.clock ?? (() => new Date());
  }

  hash(token: string): Buffer {
    return hashToken(this.#key, token);
  }

  /** What the create form needs: the policy's limits, the scopes the caller can give, grantable events. */
  async creationRules(role: Role): Promise<{
    personal: boolean;
    maxDays: number;
    defaultDays: number;
    eventGrants: boolean;
    scopes: TokenScope[];
    grantableEvents: StepUpEvent[];
  }> {
    const p = await this.#policy.current();
    return {
      personal: p.apiTokens.personal,
      maxDays: p.apiTokens.maxDays,
      defaultDays: Math.min(DEFAULT_TOKEN_DAYS, p.apiTokens.maxDays),
      eventGrants: p.apiTokens.eventGrants,
      scopes: reachableScopes(role),
      grantableEvents: p.apiTokens.eventGrants && roleAtLeast(role, 'admin') ? [...GRANTABLE_EVENTS] : [],
    };
  }

  // ------------------------------------------------------------------ reads

  async list(filter: { principalId?: string; kind?: TokenKind } = {}): Promise<ApiTokenRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.principalId !== undefined) {
      params.push(filter.principalId);
      where.push(`t.principal_id = $${String(params.length)}`);
    }
    if (filter.kind !== undefined) {
      params.push(filter.kind);
      where.push(`t.kind = $${String(params.length)}`);
    }
    const { rows } = await this.#pool.query<TokenRow>(
      `${SELECT_TOKEN} ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
        ORDER BY (t.revoked_at IS NULL) DESC, t.created_at DESC, t.id LIMIT 1000`,
      params,
    );
    const now = this.#now();
    return rows.map((r) => toRecord(r, now));
  }

  async get(db: Queryable, id: string): Promise<ApiTokenRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await db.query<TokenRow>(`${SELECT_TOKEN} WHERE t.id = $1`, [id]);
    return rows[0] ? toRecord(rows[0], this.#now()) : null;
  }

  /**
   * The token a presented secret belongs to (current secret, or the previous one of a rotation — its overlap end is
   * returned for the caller to judge), with its principal. Null: no such token.
   */
  async lookup(token: string): Promise<TokenLookup | null> {
    const h = this.hash(token);
    const { rows } = await this.#pool.query<{
      id: string;
      kind: TokenKind;
      name: string;
      scopes: string[];
      granted_events: string[];
      allowed_cidrs: string[];
      expires_at: Date;
      revoked_at: Date | null;
      is_previous: boolean;
      previous_valid_until: Date | null;
      principal_id: string;
      username: string;
      role: Role;
      principal_kind: 'human' | 'service';
      disabled_at: Date | null;
    }>(
      `SELECT t.id, t.kind, t.name, t.scopes, t.granted_events, t.allowed_cidrs, t.expires_at, t.revoked_at,
              (t.secret_hash <> $1) AS is_previous, t.previous_valid_until, t.principal_id, u.username, u.role,
              u.kind AS principal_kind, u.disabled_at
         FROM api_tokens t JOIN users u ON u.id = t.principal_id
        WHERE t.secret_hash = $1 OR t.previous_hash = $1
        LIMIT 1`,
      [h],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      scopes: scopesOf(r.scopes),
      grantedEvents: r.granted_events.filter(isStepUpEvent),
      allowedCidrs: r.allowed_cidrs,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      previousUntil: r.is_previous ? (r.previous_valid_until ?? new Date(0)) : null,
      principal: {
        id: r.principal_id,
        username: r.username,
        role: r.role,
        kind: r.principal_kind,
        disabled: r.disabled_at !== null,
      },
    };
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Issues a token for `principal` (the actor themself for a personal token, a service account for a service token).
   * Validates scopes against the principal's role, the lifetime against the policy, the IP ranges, and event grants
   * (policy switch, admin, a real code from the last 10 minutes, never the safe core). Audited.
   */
  async create(
    actor: TokenActor,
    kind: TokenKind,
    principalId: string,
    input: CreateTokenInput,
  ): Promise<IssuedToken> {
    const policy = await this.#policy.current();
    const now = this.#now();
    const target = `api-token:new:${kind}`;
    const refuse = async (err: HttpError): Promise<never> => {
      await this.#record(actor, 'api_token.create', target, 'denied', {
        kind,
        principal: principalId,
        reason: err.code,
      });
      throw err;
    };
    if (kind === 'personal' && !policy.apiTokens.personal) {
      await refuse(
        new HttpError(
          403,
          'personal_tokens_disabled',
          'Personal API tokens are switched off in the security policy.',
        ),
      );
    }
    const name = input.name.trim();
    if (name.length === 0 || name.length > 80) {
      await refuse(badRequest('invalid_token_name', 'A token name has 1-80 characters.'));
    }
    const principal = await this.#principal(this.#pool, principalId);
    if (principal === null || principal.kind !== (kind === 'personal' ? 'human' : 'service')) {
      await refuse(kind === 'service' ? accountNotFound() : tokenNotFound());
      throw new Error('unreachable');
    }
    if (principal.disabled) {
      await refuse(
        new HttpError(
          409,
          'principal_disabled',
          'This account is disabled; it cannot get tokens.',
          {},
          {},
          {
            reason: 'issue',
          },
        ),
      );
    }
    // A service account above the actor's own role is not theirs to arm.
    if (kind === 'service' && !roleAtLeast(actor.role, principal.role)) await refuse(forbidden());
    const scopes = await this.#scopes(input.scopes, principal.role, refuse);
    const days = input.expiresInDays;
    if (!Number.isInteger(days) || days < 1 || days > policy.apiTokens.maxDays) {
      await refuse(
        badRequest(
          'token_expiry_invalid',
          `Choose a lifetime between 1 and ${String(policy.apiTokens.maxDays)} days.`,
          { max: policy.apiTokens.maxDays },
        ),
      );
    }
    const cidrs = await this.#cidrs(input.allowedCidrs ?? [], refuse);
    const grants = await this.#grants(
      actor,
      input.grantedEvents ?? [],
      policy.apiTokens.eventGrants,
      now,
      refuse,
    );

    const secret = generateToken(kind);
    const expiresAt = new Date(now.getTime() + days * DAY_MS);
    const id = await withTransaction(this.#pool, async (tx) => {
      // Serialise per principal so the live-token cap cannot be raced.
      await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [principalId]);
      const { rows: live } = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM api_tokens WHERE principal_id = $1 AND revoked_at IS NULL AND expires_at > $2',
        [principalId, now],
      );
      if ((live[0]?.n ?? 0) >= MAX_LIVE_TOKENS) return null;
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO api_tokens (kind, principal_id, name, scopes, granted_events, allowed_cidrs, hint, secret_hash,
                                 expires_at, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          kind,
          principalId,
          name,
          scopes,
          grants,
          cidrs,
          tokenHint(secret),
          this.hash(secret),
          expiresAt,
          now,
          actor.userId,
        ],
      );
      const newId = rows[0]?.id;
      if (newId === undefined) throw new Error('api token insert returned no id');
      await this.#record(
        actor,
        'api_token.create',
        `api-token:${newId}`,
        'success',
        {
          kind,
          principal: principalId,
          principalName: principal.username,
          name,
          scopes,
          grantedEvents: grants,
          allowedCidrs: cidrs,
          expiresAt: expiresAt.toISOString(),
        },
        tx,
      );
      return newId;
    });
    if (id === null) {
      await refuse(
        new HttpError(
          409,
          'token_limit',
          `This account already has ${String(MAX_LIVE_TOKENS)} live tokens; revoke one first.`,
          {},
          {},
          { max: MAX_LIVE_TOKENS },
        ),
      );
      throw new Error('unreachable');
    }
    const token = await this.get(this.#pool, id);
    if (token === null) throw new Error('created api token vanished');
    return { token, secret };
  }

  /**
   * A new secret for a live token. The previous secret keeps working for `overlapMinutes` (default 60, 0–1440); a
   * rotation inside an overlap ends the earlier overlap. `principalId` restricts to the caller's own / one service
   * account's token. Audited.
   */
  async rotate(
    actor: TokenActor,
    tokenId: string,
    scope: { principalId: string; kind: TokenKind },
    input: RotateTokenInput,
  ): Promise<IssuedToken> {
    const policy = await this.#policy.current();
    const now = this.#now();
    const target = `api-token:${tokenId.slice(0, 64)}`;
    const refuse = async (err: HttpError): Promise<never> => {
      await this.#record(actor, 'api_token.rotate', target, 'denied', { reason: err.code });
      throw err;
    };
    const overlap = input.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES;
    if (!Number.isInteger(overlap) || overlap < 0 || overlap > MAX_OVERLAP_MINUTES) {
      await refuse(
        badRequest('invalid_overlap', `The overlap is 0-${String(MAX_OVERLAP_MINUTES)} minutes.`, {
          max: MAX_OVERLAP_MINUTES,
        }),
      );
    }
    const days = input.expiresInDays;
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > policy.apiTokens.maxDays)) {
      await refuse(
        badRequest(
          'token_expiry_invalid',
          `Choose a lifetime between 1 and ${String(policy.apiTokens.maxDays)} days.`,
          { max: policy.apiTokens.maxDays },
        ),
      );
    }
    if (scope.kind === 'personal' && !policy.apiTokens.personal) {
      await refuse(
        new HttpError(
          403,
          'personal_tokens_disabled',
          'Personal API tokens are switched off in the security policy.',
        ),
      );
    }
    const secret = generateToken(scope.kind);
    const result = await withTransaction(this.#pool, async (tx) => {
      const { rows } = await tx.query<{
        principal_id: string;
        kind: TokenKind;
        created_at: Date;
        expires_at: Date;
        rotated_at: Date | null;
        revoked_at: Date | null;
        disabled_at: Date | null;
        role: Role;
      }>(
        `SELECT t.principal_id, t.kind, t.created_at, t.expires_at, t.rotated_at, t.revoked_at, u.disabled_at, u.role
           FROM api_tokens t JOIN users u ON u.id = t.principal_id
          WHERE t.id = $1 FOR UPDATE OF t`,
        [UUID.test(tokenId) ? tokenId : '00000000-0000-0000-0000-000000000000'],
      );
      const t = rows[0];
      if (t === undefined || t.principal_id !== scope.principalId || t.kind !== scope.kind) {
        return { error: tokenNotFound() };
      }
      if (t.revoked_at !== null || t.expires_at <= now) {
        return {
          error: new HttpError(409, 'token_inactive', 'This token is revoked or expired; create a new one.'),
        };
      }
      if (t.disabled_at !== null) {
        return {
          error: new HttpError(
            409,
            'principal_disabled',
            'This account is disabled; it cannot get tokens.',
            {},
            {},
            {
              reason: 'issue',
            },
          ),
        };
      }
      if (scope.kind === 'service' && !roleAtLeast(actor.role, t.role)) return { error: forbidden() };
      // Default lifetime: as long as before (from its last issue), capped by the policy.
      const issuedAt = t.rotated_at ?? t.created_at;
      const previousDays = Math.max(1, Math.round((t.expires_at.getTime() - issuedAt.getTime()) / DAY_MS));
      const lifetime = days ?? Math.min(previousDays, policy.apiTokens.maxDays);
      const expiresAt = new Date(now.getTime() + lifetime * DAY_MS);
      const until = new Date(now.getTime() + overlap * 60_000);
      await tx.query(
        `UPDATE api_tokens
            SET previous_hash = CASE WHEN $3 THEN secret_hash ELSE NULL END,
                previous_valid_until = CASE WHEN $3 THEN $4::timestamptz ELSE NULL END,
                secret_hash = $2, hint = $5, rotated_at = $6, expires_at = $7
          WHERE id = $1`,
        [tokenId, this.hash(secret), overlap > 0, until, tokenHint(secret), now, expiresAt],
      );
      await this.#record(
        actor,
        'api_token.rotate',
        target,
        'success',
        {
          kind: t.kind,
          principal: t.principal_id,
          overlapMinutes: overlap,
          previousValidUntil: overlap > 0 ? until.toISOString() : null,
          expiresAt: expiresAt.toISOString(),
        },
        tx,
      );
      return { error: null };
    });
    if (result.error !== null) await refuse(result.error);
    const token = await this.get(this.#pool, tokenId);
    if (token === null) throw new Error('rotated api token vanished');
    return { token, secret };
  }

  /**
   * Revokes a token at once (its overlap secret too). `ownerId`: only the caller's own token (personal screen); absent:
   * any token (admins). Revoking a revoked token answers its record again. Audited.
   */
  async revoke(
    actor: TokenActor,
    tokenId: string,
    opts: { ownerId?: string; reason?: string } = {},
  ): Promise<ApiTokenRecord> {
    const now = this.#now();
    const target = `api-token:${tokenId.slice(0, 64)}`;
    const reason = opts.reason ?? (opts.ownerId === undefined ? 'admin' : 'owner');
    const outcome = await withTransaction(this.#pool, async (tx) => {
      const current = await this.get(tx, tokenId);
      if (current === null || (opts.ownerId !== undefined && current.principal.id !== opts.ownerId))
        return null;
      if (current.revokedAt !== null) return current;
      await tx.query(
        `UPDATE api_tokens SET revoked_at = $2, revoked_by = $3, revoke_reason = $4, previous_hash = NULL,
                               previous_valid_until = NULL
          WHERE id = $1`,
        [tokenId, now, actor.userId, reason],
      );
      await this.#record(
        actor,
        'api_token.revoke',
        target,
        'success',
        { kind: current.kind, principal: current.principal.id, reason },
        tx,
      );
      return this.get(tx, tokenId);
    });
    if (outcome === null) {
      await this.#record(actor, 'api_token.revoke', target, 'denied', { reason: 'not_found' });
      throw tokenNotFound();
    }
    return outcome;
  }

  // ------------------------------------------------------------------ service accounts

  async listServiceAccounts(): Promise<ServiceAccountRecord[]> {
    const { rows } = await this.#pool.query<{
      id: string;
      username: string;
      role: Role;
      description: string | null;
      disabled_at: Date | null;
      created_at: Date;
      created_by: string | null;
      created_by_username: string | null;
      memberships: { project: string; role: string }[] | null;
    }>(
      `SELECT u.id, u.username, u.role, u.description, u.disabled_at, u.created_at, u.created_by,
              c.username AS created_by_username,
              (SELECT json_agg(json_build_object('project', m.project_id, 'role', m.role) ORDER BY m.project_id)
                 FROM project_memberships m WHERE m.user_id = u.id) AS memberships
         FROM users u LEFT JOIN users c ON c.id = u.created_by
        WHERE u.kind = 'service'
        ORDER BY u.username LIMIT 500`,
    );
    const tokens = await this.list({ kind: 'service' });
    return rows.map((r) => ({
      id: r.id,
      name: r.username,
      role: r.role,
      description: r.description,
      disabled: r.disabled_at !== null,
      createdAt: r.created_at,
      createdBy: r.created_by === null ? null : { id: r.created_by, username: r.created_by_username ?? '' },
      memberships: r.memberships ?? [],
      tokens: tokens.filter((t) => t.principal.id === r.id),
    }));
  }

  async serviceAccount(id: string): Promise<ServiceAccountRecord | null> {
    if (!UUID.test(id)) return null;
    return (await this.listServiceAccounts()).find((a) => a.id === id) ?? null;
  }

  /** A service account (role ≤ the creator's, never owner). Audited `service_account.create`. */
  async createServiceAccount(
    actor: TokenActor,
    input: { name: string; role: Role; description?: string | null | undefined },
  ): Promise<ServiceAccountRecord> {
    const name = input.name.trim().toLowerCase();
    const target = `service-account:${name.slice(0, 64)}`;
    const refuse = async (err: HttpError): Promise<never> => {
      await this.#record(actor, 'service_account.create', target, 'denied', { reason: err.code });
      throw err;
    };
    if (!USERNAME_PATTERN.test(name)) {
      await refuse(
        badRequest(
          'invalid_username',
          'Username must be 3-32 characters: a-z first, then a-z, 0-9, ".", "_" or "-".',
        ),
      );
    }
    if (input.role === 'owner' || !roleAtLeast(actor.role, input.role)) await refuse(forbidden());
    const description = input.description?.trim() || null;
    const id = await withTransaction(this.#pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO users (username, role, password_hash, created_by, kind, description, totp_enabled)
         VALUES ($1, $2, $3, $4, 'service', $5, false)
         ON CONFLICT (username) DO NOTHING RETURNING id`,
        [name, input.role, SERVICE_ACCOUNT_PASSWORD_HASH, actor.userId, description],
      );
      const created = rows[0]?.id;
      if (created === undefined) return null;
      await this.#record(
        actor,
        'service_account.create',
        `user:${created}`,
        'success',
        { name, role: input.role, kind: 'service' },
        tx,
      );
      return created;
    });
    if (id === null) {
      await refuse(new HttpError(409, 'user_exists', 'A user with this username already exists.'));
      throw new Error('unreachable');
    }
    const account = await this.serviceAccount(id);
    if (account === null) throw new Error('created service account vanished');
    return account;
  }

  /** Role / description / disabled of a service account. Audited `service_account.update`. */
  async updateServiceAccount(
    actor: TokenActor,
    id: string,
    patch: {
      role?: Role | undefined;
      description?: string | null | undefined;
      disabled?: boolean | undefined;
    },
  ): Promise<ServiceAccountRecord> {
    const target = `user:${id.slice(0, 64)}`;
    const refuse = async (err: HttpError): Promise<never> => {
      await this.#record(actor, 'service_account.update', target, 'denied', { reason: err.code });
      throw err;
    };
    if (patch.role !== undefined && (patch.role === 'owner' || !roleAtLeast(actor.role, patch.role))) {
      await refuse(forbidden());
    }
    const now = this.#now();
    const done = await withTransaction(this.#pool, async (tx) => {
      const { rows } = await tx.query<{ role: Role; kind: string; disabled_at: Date | null }>(
        'SELECT role, kind, disabled_at FROM users WHERE id = $1 FOR UPDATE',
        [UUID.test(id) ? id : '00000000-0000-0000-0000-000000000000'],
      );
      const cur = rows[0];
      if (cur === undefined || cur.kind !== 'service') return false;
      // An admin cannot take over (or lock out) a service account above their own role.
      if (!roleAtLeast(actor.role, cur.role)) return 'forbidden' as const;
      const changes: string[] = [];
      if (patch.role !== undefined && patch.role !== cur.role) changes.push('role');
      if (patch.description !== undefined) changes.push('description');
      if (patch.disabled !== undefined && patch.disabled !== (cur.disabled_at !== null))
        changes.push('disabled');
      await tx.query(
        `UPDATE users SET role = COALESCE($2, role),
                          description = CASE WHEN $3 THEN $4 ELSE description END,
                          disabled_at = CASE WHEN $5::boolean IS NULL THEN disabled_at
                                             WHEN $5 THEN COALESCE(disabled_at, $6) ELSE NULL END,
                          updated_at = now()
          WHERE id = $1`,
        [
          id,
          patch.role ?? null,
          patch.description !== undefined,
          patch.description?.trim() || null,
          patch.disabled ?? null,
          now,
        ],
      );
      await this.#record(
        actor,
        'service_account.update',
        target,
        'success',
        {
          changes,
          ...(patch.role === undefined ? {} : { role: patch.role, previousRole: cur.role }),
          ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }),
        },
        tx,
      );
      return true;
    });
    if (done === false) await refuse(accountNotFound());
    if (done === 'forbidden') await refuse(forbidden());
    const account = await this.serviceAccount(id);
    if (account === null) throw accountNotFound();
    return account;
  }

  // ------------------------------------------------------------------ usage

  /** Adds `count` uses (the usage counter's flush). */
  async addUses(
    entries: readonly { id: string; count: number; lastAt: Date; lastIp: string | null }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.#pool.query(
      `UPDATE api_tokens t
          SET use_count = t.use_count + e.n,
              last_used_at = GREATEST(COALESCE(t.last_used_at, e.at), e.at),
              last_used_ip = CASE WHEN t.last_used_at IS NULL OR e.at >= t.last_used_at THEN e.ip ELSE t.last_used_ip END
         FROM unnest($1::uuid[], $2::bigint[], $3::timestamptz[], $4::text[]) AS e(id, n, at, ip)
        WHERE t.id = e.id`,
      [
        entries.map((e) => e.id),
        entries.map((e) => e.count),
        entries.map((e) => e.lastAt),
        entries.map((e) => e.lastIp?.slice(0, 64) ?? null),
      ],
    );
  }

  // ------------------------------------------------------------------ helpers

  async #principal(
    db: Queryable,
    id: string,
  ): Promise<{
    id: string;
    username: string;
    role: Role;
    kind: 'human' | 'service';
    disabled: boolean;
  } | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await db.query<{
      id: string;
      username: string;
      role: Role;
      kind: 'human' | 'service';
      disabled_at: Date | null;
    }>('SELECT id, username, role, kind, disabled_at FROM users WHERE id = $1', [id]);
    const r = rows[0];
    return r === undefined
      ? null
      : { id: r.id, username: r.username, role: r.role, kind: r.kind, disabled: r.disabled_at !== null };
  }

  async #scopes(
    values: readonly string[],
    role: Role,
    refuse: (e: HttpError) => Promise<never>,
  ): Promise<TokenScope[]> {
    if (values.length === 0) await refuse(badRequest('scope_required', 'Choose at least one scope.'));
    const reachable = reachableScopes(role);
    for (const v of values) {
      if (!(TOKEN_SCOPES as readonly string[]).includes(v) || !reachable.includes(v as TokenScope)) {
        await refuse(
          badRequest('scope_not_allowed', `The scope ${v.slice(0, 40)} is not available for this account.`, {
            scope: v.slice(0, 40),
          }),
        );
      }
    }
    return scopesOf(values);
  }

  async #cidrs(values: readonly string[], refuse: (e: HttpError) => Promise<never>): Promise<string[]> {
    if (values.length > MAX_CIDRS) {
      await refuse(
        badRequest('too_many_cidrs', `At most ${String(MAX_CIDRS)} IP ranges.`, { max: MAX_CIDRS }),
      );
    }
    const out: string[] = [];
    for (const v of values) {
      const c = parseCidr(v);
      if (c === null) {
        await refuse(
          badRequest('invalid_cidr', `Not an IP address or range: ${v.slice(0, 64)}`, {
            value: v.slice(0, 64),
          }),
        );
        throw new Error('unreachable');
      }
      const text = formatCidr(c);
      if (!out.includes(text)) out.push(text);
    }
    return out;
  }

  async #grants(
    actor: TokenActor,
    values: readonly string[],
    allowed: boolean,
    now: Date,
    refuse: (e: HttpError) => Promise<never>,
  ): Promise<StepUpEvent[]> {
    if (values.length === 0) return [];
    if (!allowed) {
      await refuse(
        new HttpError(
          403,
          'event_grants_disabled',
          'The security policy does not allow granting step-up events to API tokens.',
        ),
      );
    }
    if (!roleAtLeast(actor.role, 'admin')) await refuse(forbidden());
    const out: StepUpEvent[] = [];
    for (const v of values) {
      if (!isStepUpEvent(v) || STEP_UP_EVENTS[v].core) {
        await refuse(
          badRequest('event_not_grantable', `The event ${v.slice(0, 64)} cannot be granted to a token.`, {
            event: v.slice(0, 64),
          }),
        );
        throw new Error('unreachable');
      }
      if (!out.includes(v)) out.push(v);
    }
    // A grant is never made without a code: a real authenticator time from the last 10 minutes, even when the
    // policy waives the `api.tokens` event itself.
    if (!stepUpFreshAt(actor.realMfaAt, now, STEP_UP_ALWAYS_FRESH_MS)) await refuse(stepUpRequiredError());
    return out;
  }

  async #record(
    actor: TokenActor,
    action: string,
    target: string,
    outcome: 'success' | 'denied',
    metadata: Record<string, unknown>,
    tx?: Queryable,
  ): Promise<void> {
    await this.#audit.record(
      {
        actor: { type: 'user', id: actor.userId },
        action,
        target,
        outcome,
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata,
      },
      tx,
    );
  }
}

/**
 * Time-based notification producer (p5-notifications sweep): live tokens expiring within 7 days, once per expiry date
 * (a rotation with a new expiry re-arms it). Personal tokens notify their owner; service-account tokens their
 * creator, or every admin when the creator is gone or disabled.
 */
export async function expiringTokens(
  db: Queryable,
  now: Date,
): Promise<
  {
    id: string;
    recipients: string[];
    draft: { title: string; body: string; link: string; dedupeKey: string };
  }[]
> {
  const { rows } = await db.query<{
    id: string;
    kind: TokenKind;
    name: string;
    expires_at: Date;
    principal_id: string;
    principal_username: string;
    principal_kind: string;
    creator_ok: boolean;
    created_by: string | null;
  }>(
    `SELECT t.id, t.kind, t.name, t.expires_at, t.principal_id, p.username AS principal_username,
            p.kind AS principal_kind, t.created_by,
            (c.id IS NOT NULL AND c.disabled_at IS NULL AND c.kind = 'human') AS creator_ok
       FROM api_tokens t
       JOIN users p ON p.id = t.principal_id
       LEFT JOIN users c ON c.id = t.created_by
      WHERE t.revoked_at IS NULL AND p.disabled_at IS NULL
        AND t.expires_at > $1 AND t.expires_at <= $1::timestamptz + make_interval(secs => $2::double precision / 1000)
        AND (t.expiry_notified_for IS NULL OR t.expiry_notified_for <> t.expires_at)
      ORDER BY t.expires_at LIMIT 500`,
    [now, EXPIRY_NOTICE_MS],
  );
  const out: {
    id: string;
    recipients: string[];
    draft: { title: string; body: string; link: string; dedupeKey: string };
  }[] = [];
  for (const r of rows) {
    let recipients: string[];
    if (r.kind === 'personal') recipients = [r.principal_id];
    else if (r.creator_ok && r.created_by !== null) recipients = [r.created_by];
    else {
      const { rows: admins } = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE disabled_at IS NULL AND kind = 'human' AND role IN ('owner', 'admin') ORDER BY id`,
      );
      recipients = admins.map((a) => a.id);
    }
    const days = Math.max(1, Math.ceil((r.expires_at.getTime() - now.getTime()) / DAY_MS));
    const whose =
      r.kind === 'personal' ? 'Your API token' : `The API token of service account ${r.principal_username}`;
    out.push({
      id: r.id,
      recipients,
      draft: {
        title: `API token "${r.name}" expires in ${String(days)} day${days === 1 ? '' : 's'}`,
        body: `${whose} "${r.name}" expires at ${r.expires_at.toISOString()}. Rotate it (new secret, new expiry) before then, or automation that uses it stops working.`,
        link: r.kind === 'personal' ? '/settings/api-tokens' : '/settings/service-accounts',
        dedupeKey: `api_token.expiring:${r.id}:${r.expires_at.toISOString()}`,
      },
    });
    await db.query('UPDATE api_tokens SET expiry_notified_for = expires_at WHERE id = $1', [r.id]);
  }
  return out;
}
