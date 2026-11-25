import { API_PREFIX } from '../api/client';

/**
 * p6-logs-ui (docs/design/p6-logs-ui.md §3): the master's clock, measured as an offset to the browser
 * clock. One request to `GET /api/time` (`{"now": ISO}`, millisecond precision); the offset is taken against
 * the midpoint of the request, so half the round trip is the error bound. A master without that route (older
 * release) still answers with an HTTP `Date` header (whole seconds) — used then, marked approximate.
 */

/** Re-measure this often while the page is open (and when the tab becomes visible / the network returns). */
export const CLOCK_SYNC_MS = 5 * 60_000;
/** A browser clock further off than this gets a warning in the header. */
export const CLOCK_SKEW_WARN_MS = 2_000;

export interface ClockSync {
  /** server time − browser time (ms). */
  readonly offsetMs: number;
  /** Round trip of the measurement (ms). */
  readonly rttMs: number;
  /** false: from the whole-second `Date` header. */
  readonly precise: boolean;
}

export async function measureServerClock(
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<ClockSync> {
  const t0 = now();
  const res = await fetchImpl(`${API_PREFIX}/time`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  });
  const t1 = now();
  const mid = (t0 + t1) / 2;
  const rttMs = Math.max(0, t1 - t0);
  if (res.ok) {
    try {
      const body: unknown = await res.json();
      const iso = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).now : null;
      const server = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
      if (!Number.isNaN(server)) return { offsetMs: server - mid, rttMs, precise: true };
    } catch {
      // fall through to the Date header
    }
  }
  const date = res.headers.get('date');
  const server = date === null ? Number.NaN : Date.parse(date);
  if (Number.isNaN(server)) throw new Error('no server time');
  // The header truncates to the second: the true time is in [server, server + 1000).
  return { offsetMs: server + 500 - mid, rttMs, precise: false };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "3.2 s" / "4 min 05 s" for a skew. */
export function formatSkew(ms: number): string {
  const a = Math.abs(ms);
  if (a < 60_000) return `${(a / 1000).toFixed(1)} s`;
  const s = Math.round(a / 1000);
  if (s < 3600) return `${String(Math.floor(s / 60))} min ${pad(s % 60)} s`;
  return `${String(Math.floor(s / 3600))} h ${pad(Math.floor(s / 60) % 60)} min`;
}
