import { DEFAULT_LOCALE, isLocale, type Locale } from '@remyral/i18n';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';

/**
 * p14-i18n-foundation (ADR-0053): the console language of one user, `users.locale` (migration 0101). NULL means
 * "never chose": the workspace default (Turkish) applies. The value only picks the language of text; it is not
 * a security boundary.
 */
export const userLocales = {
  async get(db: Queryable, userId: string): Promise<Locale | null> {
    const { rows } = await db.query<{ locale: string | null }>('SELECT locale FROM users WHERE id = $1', [
      userId,
    ]);
    const v = rows[0]?.locale ?? null;
    return isLocale(v) ? v : null;
  },
};

export interface LocaleChangeMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface UserLocaleServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
}

export class UserLocaleService {
  constructor(private readonly deps: UserLocaleServiceDeps) {}

  /** The language the user sees: their choice, else the workspace default. */
  async effective(userId: string): Promise<Locale> {
    return (await userLocales.get(this.deps.pool, userId)) ?? DEFAULT_LOCALE;
  }

  /**
   * Stores the user's choice. A real change is audited (`user.locale.change`, from → to) in the same
   * transaction; choosing the stored value again changes nothing and records nothing.
   */
  async change(userId: string, locale: Locale, meta: LocaleChangeMeta): Promise<{ changed: boolean }> {
    return withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ locale: string | null }>(
        'SELECT locale FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      const row = rows[0];
      if (row === undefined) return { changed: false }; // unreachable: the session's user exists
      const from = isLocale(row.locale) ? row.locale : null;
      if (from === locale) return { changed: false };
      await tx.query('UPDATE users SET locale = $2, updated_at = now() WHERE id = $1', [userId, locale]);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: userId },
          action: 'user.locale.change',
          target: `user:${userId}`,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          metadata: { from, to: locale },
        },
        tx,
      );
      return { changed: true };
    });
  }
}
