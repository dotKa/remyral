import { createHash, randomBytes } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import { idleExpiry, SESSION_TIMEOUTS, type SessionRecord } from '../auth/sessions.js';
import type { Role } from '../auth/users.js';
import { authorize as authorizeAction } from '../authz/model.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { API_PREFIX, type CoolifyGateConfig } from './config.js';
import { type RequestMeta, SSO_ACTION } from './provider.js';
import { safeRelativePath, type Sealer } from './sealed.js';

/**
 * The forward-auth gate in front of the Coolify host (docs/design/p5-coolify-sso.md §3): a host-only
 * gate cookie on the Coolify host, obtained through a one-time ticket issued on the console host, valid
 * only while the console session lineage (user, sessions.created_at) is alive and the user is owner/admin.
 */
export const GATE_COOKIE = '__Host-rcs';
export const STATE_COOKIE_PREFIX = '__Host-rcs-state-';
export const TICKET_TTL_MS = 60_000;
export const GATE_REQUEST_TTL_MS = 5 * 60_000;
export const DEFAULT_GATE_CACHE_MS = 5_000;
/**
 * The gate session's own limits, independent of the console session's (a remembered console session may
 * live for weeks): 30 min idle, 12 h absolute. When they run out, a navigation silently re-enters the
 * ticket flow while the console session is alive.
 */
export const GATE_IDLE_MS = SESSION_TIMEOUTS.idleMs;
export const GATE_ABSOLUTE_MS = SESSION_TIMEOUTS.absoluteMs;
/** Callback path on the gate host (Traefik rewrites it to the master's /coolify-sso/callback). */
// Frozen (p17-remyral-rebrand): the installed Coolify SSO Traefik configuration (infra/coolify-sso) routes this path.
export const CALLBACK_PATH = '/_remana/sso/callback';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SID = /^[a-f0-9]{16}$/;

interface GateRequest {
  /** Path (and query) on the gate host to continue with. */
  readonly next: string;
  /** Name suffix of the state cookie. */
  readonly sid: string;
  /** base64url SHA-256 of the state cookie value. */
  readonly sh: string;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function isPrivileged(userId: string, role: Role): boolean {
  return authorizeAction({ userId, role, memberships: new Map() }, SSO_ACTION).allow;
}

export type ForwardAuthDecision =
  | { readonly kind: 'allow'; readonly username: string }
  | { readonly kind: 'wrong_host' }
  | { readonly kind: 'deny' }
  | {
      readonly kind: 'login';
      readonly location: string;
      readonly stateCookie: { readonly name: string; readonly value: string };
    };

export type TicketOutcome =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'console'; readonly location: string }
  | { readonly kind: 'redirect'; readonly location: string };

export type CallbackOutcome =
  | { readonly kind: 'invalid'; readonly clearState: string | null }
  | {
      readonly kind: 'session';
      readonly token: string;
      readonly expiresAt: Date;
      readonly location: string;
      readonly clearState: string;
    };

interface LineageRow {
  idle_timeout_s: number;
  user_id: string;
  username: string;
  role: Role;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  id_hash: Buffer;
}

export class CoolifyGate {
  readonly #cache = new Map<string, { username: string; until: number }>();

  constructor(
    private readonly deps: {
      readonly config: CoolifyGateConfig;
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly sealer: Sealer;
      readonly clock: () => Date;
      readonly cacheMs?: number;
    },
  ) {}

  get host(): string {
    return this.deps.config.host;
  }

  /** The URL the console button opens: Coolify's OIDC entry point behind the gate. */
  get launchUrl(): string {
    return `https://${this.deps.config.host}/auth/oidc/redirect`;
  }

  // ------------------------------------------------------------------------------------- forward-auth

  async forwardAuth(req: {
    readonly forwardedHost: string | undefined;
    readonly forwardedMethod: string | undefined;
    readonly forwardedUri: string | undefined;
    readonly gateCookie: string | undefined;
    readonly navigation: boolean;
  }): Promise<ForwardAuthDecision> {
    const host = (req.forwardedHost ?? '').split(',')[0]?.trim().toLowerCase().replace(/:\d+$/, '');
    if (host !== this.deps.config.host) return { kind: 'wrong_host' };
    const now = this.deps.clock();
    if (req.gateCookie !== undefined && TOKEN.test(req.gateCookie)) {
      const allowed = await this.check(req.gateCookie, now);
      if (allowed !== null) return { kind: 'allow', username: allowed };
    }
    const method = (req.forwardedMethod ?? 'GET').toUpperCase();
    if ((method !== 'GET' && method !== 'HEAD') || !req.navigation) return { kind: 'deny' };
    const next = safeRelativePath(req.forwardedUri) ?? '/';
    const sid = randomBytes(8).toString('hex');
    const nonce = newToken();
    const request: GateRequest = { next, sid, sh: sha256(nonce).toString('base64url') };
    const r = this.deps.sealer.seal('gate', request, new Date(now.getTime() + GATE_REQUEST_TTL_MS));
    return {
      kind: 'login',
      location: `${this.deps.config.consoleOrigin}${API_PREFIX}/coolify-sso/ticket?r=${r}`,
      stateCookie: { name: `${STATE_COOKIE_PREFIX}${sid}`, value: nonce },
    };
  }

  /** The username behind a valid gate token, or null. Positive answers are cached for a few seconds. */
  private async check(gateToken: string, now: Date): Promise<string | null> {
    const key = sha256(gateToken).toString('hex');
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.until > now.getTime()) return cached.username;
    this.#cache.delete(key);
    const { rows } = await this.deps.pool.query<
      LineageRow & { gate_expires_at: Date; gate_last_seen_at: Date; stage: string }
    >(
      `SELECT g.expires_at AS gate_expires_at, g.last_seen_at AS gate_last_seen_at,
              s.id_hash, s.stage, s.created_at, s.last_seen_at, s.expires_at, s.idle_timeout_s,
              u.id AS user_id, u.username, u.role
         FROM coolify_sso_sessions g
         JOIN users u ON u.id = g.user_id AND u.disabled_at IS NULL
         JOIN sessions s ON s.user_id = g.user_id AND s.created_at = g.console_created_at AND s.stage = 'full'
        WHERE g.id_hash = $1
        ORDER BY s.last_seen_at DESC
        LIMIT 1`,
      [sha256(gateToken)],
    );
    const row = rows[0];
    if (!row || row.gate_expires_at <= now || !isPrivileged(row.user_id, row.role)) return null;
    if (now.getTime() - row.gate_last_seen_at.getTime() >= GATE_IDLE_MS) return null;
    if (
      now >=
      idleExpiry({
        stage: 'full',
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        idleTimeoutMs: row.idle_timeout_s * 1000,
      })
    )
      return null;
    // Coolify activity is console activity: keep the console session (and the gate row) from idling out.
    if (now.getTime() - row.last_seen_at.getTime() >= SESSION_TIMEOUTS.touchIntervalMs) {
      await this.deps.pool.query('UPDATE sessions SET last_seen_at = $2 WHERE id_hash = $1', [
        row.id_hash,
        now,
      ]);
    }
    if (now.getTime() - row.gate_last_seen_at.getTime() >= SESSION_TIMEOUTS.touchIntervalMs) {
      await this.deps.pool.query('UPDATE coolify_sso_sessions SET last_seen_at = $2 WHERE id_hash = $1', [
        sha256(gateToken),
        now,
      ]);
    }
    const ttl = this.deps.cacheMs ?? DEFAULT_GATE_CACHE_MS;
    if (ttl > 0) {
      if (this.#cache.size >= 1_000) this.#cache.clear();
      this.#cache.set(key, { username: row.username, until: now.getTime() + ttl });
    }
    return row.username;
  }

  // --------------------------------------------------------------------------------------------- ticket

  /** Console side: `session` is the request's full console session (or null). */
  async ticket(sealed: unknown, session: SessionRecord | null, meta: RequestMeta): Promise<TicketOutcome> {
    const now = this.deps.clock();
    const request = this.openRequest(sealed, now);
    if (request === null) return { kind: 'invalid' };
    if (session === null) {
      return { kind: 'console', location: `/sso/continue?flow=coolify&r=${String(sealed)}` };
    }
    const user = session.user;
    if (!isPrivileged(user.id, user.role)) {
      await this.deps.audit.record({
        actor: { type: 'user', id: user.id },
        action: 'sso.coolify.ticket',
        target: `host:${this.deps.config.host}`,
        outcome: 'denied',
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata: { reason: 'role', role: user.role },
      });
      return { kind: 'console', location: '/sso/continue?flow=coolify&error=forbidden' };
    }
    const ticket = newToken();
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query('DELETE FROM coolify_sso_tickets WHERE expires_at < $1', [
        new Date(now.getTime() - 60 * 60_000),
      ]);
      await tx.query(
        `INSERT INTO coolify_sso_tickets (ticket_hash, user_id, console_created_at, state_hash, next_path,
                                          created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sha256(ticket),
          user.id,
          session.createdAt,
          Buffer.from(request.sh, 'base64url'),
          request.next,
          now,
          new Date(now.getTime() + TICKET_TTL_MS),
        ],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: user.id },
          action: 'sso.coolify.ticket',
          target: `host:${this.deps.config.host}`,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });
    const url = new URL(`https://${this.deps.config.host}${CALLBACK_PATH}`);
    url.searchParams.set('ticket', ticket);
    url.searchParams.set('r', String(sealed));
    return { kind: 'redirect', location: url.href };
  }

  private openRequest(sealed: unknown, now: Date): GateRequest | null {
    const data = this.deps.sealer.open('gate', sealed, now);
    if (data === null || typeof data !== 'object') return null;
    const r = data as Partial<GateRequest>;
    const next = safeRelativePath(r.next);
    if (next === null || typeof r.sid !== 'string' || !SID.test(r.sid) || typeof r.sh !== 'string')
      return null;
    if (!/^[A-Za-z0-9_-]{43}$/.test(r.sh)) return null;
    return { next, sid: r.sid, sh: r.sh };
  }

  // ------------------------------------------------------------------------------------------- callback

  /** Gate-host side: redeems a ticket for a gate session. `cookies` are the request's cookies. */
  async callback(
    req: {
      readonly host: string;
      readonly ticket: unknown;
      readonly sealed: unknown;
      readonly cookies: Readonly<Record<string, string | undefined>>;
    },
    meta: RequestMeta,
  ): Promise<CallbackOutcome | null> {
    if (req.host.toLowerCase().replace(/:\d+$/, '') !== this.deps.config.host) return null;
    const now = this.deps.clock();
    const request = this.openRequest(req.sealed, now);
    if (request === null) return { kind: 'invalid', clearState: null };
    const stateName = `${STATE_COOKIE_PREFIX}${request.sid}`;
    const state = req.cookies[stateName];
    const invalid: CallbackOutcome = { kind: 'invalid', clearState: stateName };
    if (state === undefined || !TOKEN.test(state) || sha256(state).toString('base64url') !== request.sh) {
      return invalid;
    }
    if (typeof req.ticket !== 'string' || !TOKEN.test(req.ticket)) return invalid;
    const ticketHash = sha256(req.ticket);
    const gateToken = newToken();
    const created = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ user_id: string; console_created_at: Date; next_path: string }>(
        `UPDATE coolify_sso_tickets SET used_at = $2
          WHERE ticket_hash = $1 AND used_at IS NULL AND expires_at > $2 AND state_hash = $3
          RETURNING user_id, console_created_at, next_path`,
        [ticketHash, now, Buffer.from(request.sh, 'base64url')],
      );
      const t = rows[0];
      if (!t) return null;
      const { rows: lineage } = await tx.query<LineageRow>(
        `SELECT s.id_hash, s.created_at, s.last_seen_at, s.expires_at, s.idle_timeout_s,
                u.id AS user_id, u.username, u.role
           FROM sessions s JOIN users u ON u.id = s.user_id AND u.disabled_at IS NULL
          WHERE s.user_id = $1 AND s.created_at = $2 AND s.stage = 'full'
          ORDER BY s.last_seen_at DESC LIMIT 1`,
        [t.user_id, t.console_created_at],
      );
      const s = lineage[0];
      if (!s || !isPrivileged(s.user_id, s.role)) return null;
      const idle = { stage: 'full' as const, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at };
      if (now >= idleExpiry({ ...idle, idleTimeoutMs: s.idle_timeout_s * 1000 })) return null;
      // Never longer than the console session, and never longer than the gate's own absolute limit.
      const cap = new Date(now.getTime() + GATE_ABSOLUTE_MS);
      const expiresAt = s.expires_at < cap ? s.expires_at : cap;
      await tx.query('DELETE FROM coolify_sso_sessions WHERE expires_at < $1', [now]);
      await tx.query(
        `INSERT INTO coolify_sso_sessions (id_hash, user_id, console_created_at, created_at, last_seen_at, expires_at)
         VALUES ($1, $2, $3, $4, $4, $5)`,
        [sha256(gateToken), s.user_id, s.created_at, now, expiresAt],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: s.user_id },
          action: 'sso.coolify.session',
          target: `host:${this.deps.config.host}`,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return { expiresAt, next: t.next_path };
    });
    if (created === null) {
      await this.deps.audit.record({
        actor: { type: 'anonymous' },
        action: 'sso.coolify.session',
        target: `host:${this.deps.config.host}`,
        outcome: 'denied',
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata: { reason: 'ticket_invalid_or_session_gone' },
      });
      return invalid;
    }
    const next = safeRelativePath(created.next) ?? '/';
    return {
      kind: 'session',
      token: gateToken,
      expiresAt: created.expiresAt,
      location: `https://${this.deps.config.host}${next}`,
      clearState: stateName,
    };
  }

  /** Test seam: forget cached decisions. */
  clearCache(): void {
    this.#cache.clear();
  }
}
