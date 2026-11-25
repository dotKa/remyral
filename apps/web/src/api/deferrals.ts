import { apiRequest, int, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p20-decisions (docs/design/p20-decisions.md): the decisions the signed-in person put off ("Ertele", a day) or ignored
 * ("Yoksay", a week) on "Senden bekleyen" — kept by the master per person (`/me/deferrals`), so the sidebar badge, the
 * home and /needs show the same on every device. Keys are the card / row keys (`approval:<id>`, `plan:<id>` …).
 */

export type DeferralMode = 'snooze' | 'ignore';

export interface Deferral {
  readonly key: string;
  readonly mode: DeferralMode;
  readonly until: string;
}

export interface DeferralInput {
  readonly key: string;
  readonly mode: DeferralMode;
  /** Absent: a day (snooze) / a week (ignore) from now, decided by the master. */
  readonly until?: string | undefined;
}

function deferral(v: unknown): Deferral {
  const o = obj(v);
  const mode = str(o, 'mode');
  if (mode !== 'snooze' && mode !== 'ignore') throw new ShapeError('bad mode');
  return { key: str(o, 'key'), mode, until: str(o, 'until') };
}

export function listDeferrals(opts: RequestOptions = {}): Promise<Deferral[]> {
  return apiRequest(
    'GET',
    '/me/deferrals',
    (v) => {
      const items = obj(v).items;
      if (!Array.isArray(items)) throw new ShapeError('expected items');
      return items.map(deferral);
    },
    opts,
  );
}

export function putDeferrals(
  items: readonly DeferralInput[],
  opts: Omit<RequestOptions, 'body'> = {},
): Promise<{ stored: number }> {
  return apiRequest('PUT', '/me/deferrals', (v) => ({ stored: int(obj(v), 'stored') }), {
    ...opts,
    body: { items },
  });
}

/** Brings decisions back: one (`key`) or every one of a mode. */
export function deleteDeferrals(
  what: { readonly key: string } | { readonly mode: DeferralMode },
  opts: RequestOptions = {},
): Promise<{ removed: number }> {
  const q = 'key' in what ? `key=${encodeURIComponent(what.key)}` : `mode=${what.mode}`;
  return apiRequest('DELETE', `/me/deferrals?${q}`, (v) => ({ removed: int(obj(v), 'removed') }), opts);
}
