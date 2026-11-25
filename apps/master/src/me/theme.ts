import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';

/**
 * p17-remyral-brand: the console colour theme of one user, `users.theme` (migration 0150). NULL means "system" (follow
 * the device's prefers-color-scheme). Presentation only; not a security boundary.
 */
export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

const stored = (v: unknown): Theme => (v === 'light' || v === 'dark' ? v : 'system');

export const userThemes = {
  async get(db: Queryable, userId: string): Promise<Theme> {
    const { rows } = await db.query<{ theme: string | null }>('SELECT theme FROM users WHERE id = $1', [
      userId,
    ]);
    return stored(rows[0]?.theme ?? null);
  },
};

export interface ThemeChangeMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export class UserThemeService {
  constructor(private readonly deps: { readonly pool: Pool; readonly audit: AuditRecorder }) {}

  async effective(userId: string): Promise<Theme> {
    return userThemes.get(this.deps.pool, userId);
  }

  /** Stores the choice; a real change is audited (`user.theme.change`, from → to) in the same transaction. */
  async change(userId: string, theme: Theme, meta: ThemeChangeMeta): Promise<{ changed: boolean }> {
    return withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ theme: string | null }>(
        'SELECT theme FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      const row = rows[0];
      if (row === undefined) return { changed: false }; // unreachable: the session's user exists
      const from = stored(row.theme);
      if (from === theme) return { changed: false };
      await tx.query('UPDATE users SET theme = $2, updated_at = now() WHERE id = $1', [
        userId,
        theme === 'system' ? null : theme,
      ]);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: userId },
          action: 'user.theme.change',
          target: `user:${userId}`,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          metadata: { from, to: theme },
        },
        tx,
      );
      return { changed: true };
    });
  }
}
