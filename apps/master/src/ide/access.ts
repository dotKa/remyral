import { createHash, randomBytes } from 'node:crypto';
import type { Pool, Queryable } from '../db/pool.js';

/**
 * p19-ide W2 (docs/design/p19-ide.md §7 "Proxy session", ADR-0066): access to the IDE origin.
 *
 *  1. The console (full session, `ide.use`) asks for a **ticket**: 256 random bits, 60 s, single use, bound to the user,
 *     the workspace and the console session (`sessions.id_hash`).
 *  2. The browser navigates to `https://ide.<domain>/_ide/enter?w=<id>&t=<ticket>`; the IDE origin redeems the ticket
 *     (deleted in the same statement: a replay finds nothing) for a **cookie session**: another 256-bit value in a
 *     host-only `__Host-ide-<workspace>` cookie (Secure, HttpOnly, SameSite=Strict, Path=/), 15 min sliding, 8 h max.
 *  3. Every IDE request checks the cookie session, that the console session it came from is still alive (deleting /
 *     expiring it cascades), that the user is not disabled; the caller re-checks the workspace and the role.
 *
 * Only SHA-256 hashes are stored. Using the IDE keeps the console session alive (it is the user's activity).
 */

export const TICKET_TTL_MS = 60_000;
export const SESSION_IDLE_MS = 15 * 60_000;
export const SESSION_MAX_MS = 8 * 60 * 60_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const hash = (v: string): Buffer => createHash('sha256').update(v, 'utf8').digest();
const newToken = (): string => randomBytes(32).toString('base64url');

/** The IDE origin's cookie for one workspace (host-only; one cookie per workspace, so several can be open). */
export function ideCookieName(workspaceId: string): string {
  return `__Host-ide-${workspaceId.replace(/-/g, '')}`;
}

export interface IdeAccessGrant {
  readonly userId: string;
  readonly workspaceId: string;
  readonly expiresAt: Date;
  readonly maxExpiresAt: Date;
}

export class IdeAccess {
  constructor(private readonly deps: { readonly pool: Pool; readonly clock: () => Date }) {}

  /** A one-time ticket for `workspaceId` (the caller checked the workspace and the role). */
  async issueTicket(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly sessionHash: Buffer;
    readonly ip: string | null;
  }): Promise<{ ticket: string; expiresAt: Date }> {
    const now = this.deps.clock();
    const ticket = newToken();
    const expiresAt = new Date(now.getTime() + TICKET_TTL_MS);
    await this.deps.pool.query(
      `INSERT INTO ide_access (token_hash, kind, workspace_id, user_id, session_hash, ip, created_at, last_seen_at,
                               expires_at, max_expires_at)
       VALUES ($1, 'ticket', $2, $3, $4, $5, $6, $6, $7, $7)`,
      [
        hash(ticket),
        input.workspaceId,
        input.userId,
        input.sessionHash,
        input.ip?.slice(0, 64) ?? null,
        now,
        expiresAt,
      ],
    );
    // Opportunistic cleanup of dead rows (tickets never redeemed, sessions past their maximum).
    await this.deps.pool.query('DELETE FROM ide_access WHERE expires_at < $1', [
      new Date(now.getTime() - 60_000),
    ]);
    return { ticket, expiresAt };
  }

  /**
   * Redeems a ticket for a cookie session of the same user, workspace and console session. Null: unknown, used,
   * expired, another workspace, or the console session is gone.
   */
  async redeem(
    ticket: string,
    workspaceId: string,
    ip: string | null,
  ): Promise<(IdeAccessGrant & { readonly token: string }) | null> {
    if (!TOKEN.test(ticket)) return null;
    const now = this.deps.clock();
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ user_id: string; session_hash: Buffer; workspace_id: string }>(
        `DELETE FROM ide_access a
          USING sessions s, users u
          WHERE a.token_hash = $1 AND a.kind = 'ticket' AND a.expires_at > $2
            AND s.id_hash = a.session_hash AND s.stage = 'full' AND s.expires_at > $2
            AND u.id = a.user_id AND u.disabled_at IS NULL
        RETURNING a.user_id::text AS user_id, a.session_hash, a.workspace_id::text AS workspace_id`,
        [hash(ticket), now],
      );
      const row = rows[0];
      if (row?.workspace_id !== workspaceId) {
        await client.query('ROLLBACK');
        // A ticket presented for another workspace is spent all the same.
        await this.deps.pool.query(`DELETE FROM ide_access WHERE token_hash = $1 AND kind = 'ticket'`, [
          hash(ticket),
        ]);
        return null;
      }
      const token = newToken();
      const maxExpiresAt = new Date(now.getTime() + SESSION_MAX_MS);
      const expiresAt = new Date(Math.min(now.getTime() + SESSION_IDLE_MS, maxExpiresAt.getTime()));
      await client.query(
        `INSERT INTO ide_access (token_hash, kind, workspace_id, user_id, session_hash, ip, created_at, last_seen_at,
                                 expires_at, max_expires_at)
         VALUES ($1, 'session', $2, $3, $4, $5, $6, $6, $7, $8)`,
        [
          hash(token),
          workspaceId,
          row.user_id,
          row.session_hash,
          ip?.slice(0, 64) ?? null,
          now,
          expiresAt,
          maxExpiresAt,
        ],
      );
      await client.query('COMMIT');
      return { token, userId: row.user_id, workspaceId, expiresAt, maxExpiresAt };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * The cookie session of `token` for `workspaceId`, slid forward (at most once a minute) together with the console
   * session it belongs to; null when it is unknown, expired, of another workspace, or its console session ended.
   */
  async check(token: string, workspaceId: string): Promise<IdeAccessGrant | null> {
    if (!TOKEN.test(token)) return null;
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{
      user_id: string;
      session_hash: Buffer;
      last_seen_at: Date;
      expires_at: Date;
      max_expires_at: Date;
    }>(
      `SELECT a.user_id::text AS user_id, a.session_hash, a.last_seen_at, a.expires_at, a.max_expires_at
         FROM ide_access a
         JOIN sessions s ON s.id_hash = a.session_hash
         JOIN users u ON u.id = a.user_id
        WHERE a.token_hash = $1 AND a.kind = 'session' AND a.workspace_id = $2 AND a.expires_at > $3
          AND s.stage = 'full' AND s.expires_at > $3
          AND s.last_seen_at + make_interval(secs => s.idle_timeout_s) > $3
          AND u.disabled_at IS NULL`,
      [hash(token), workspaceId, now],
    );
    const r = rows[0];
    if (r === undefined) return null;
    let expiresAt = r.expires_at;
    if (now.getTime() - r.last_seen_at.getTime() >= 60_000) {
      expiresAt = new Date(Math.min(now.getTime() + SESSION_IDLE_MS, r.max_expires_at.getTime()));
      await this.#touch(this.deps.pool, hash(token), r.session_hash, now, expiresAt);
    }
    return { userId: r.user_id, workspaceId, expiresAt, maxExpiresAt: r.max_expires_at };
  }

  async #touch(
    db: Queryable,
    tokenHash: Buffer,
    sessionHash: Buffer,
    now: Date,
    expiresAt: Date,
  ): Promise<void> {
    await db.query('UPDATE ide_access SET last_seen_at = $2, expires_at = $3 WHERE token_hash = $1', [
      tokenHash,
      now,
      expiresAt,
    ]);
    await db.query('UPDATE sessions SET last_seen_at = $2 WHERE id_hash = $1 AND last_seen_at < $2', [
      sessionHash,
      now,
    ]);
  }

  /** Ends every ticket and cookie session of a workspace (stopped, deleted, owner changed). */
  async revokeWorkspace(workspaceId: string): Promise<number> {
    const { rowCount } = await this.deps.pool.query('DELETE FROM ide_access WHERE workspace_id = $1', [
      workspaceId,
    ]);
    return rowCount ?? 0;
  }

  /** Ends one cookie session (the IDE origin's sign-out). */
  async revokeToken(token: string): Promise<void> {
    if (!TOKEN.test(token)) return;
    await this.deps.pool.query('DELETE FROM ide_access WHERE token_hash = $1', [hash(token)]);
  }
}
