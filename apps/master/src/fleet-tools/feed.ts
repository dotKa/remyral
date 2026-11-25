import { compareVersions, normalizeVersion, VERSION_FEED_HOSTS } from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from '../db/pool.js';
import { CATALOG, type FeedSource, feedKey, feedUrl } from './catalog.js';

/**
 * p13-fleet-tools §2 (docs/design/p13-fleet-tools.md): the master reads the latest version of every catalog item from
 * its official source — npm registry, GitHub releases, NuGet flat container (python.org's Windows package), the
 * Node.js release index — on a schedule, and caches the answer in `tool_version_feed`.
 *
 * Boundaries: only https URLs on `VERSION_FEED_HOSTS` (checked before every request), no redirects, no credentials,
 * no cookies, a fixed User-Agent, a 10 s timeout and a 4 MiB body cap. A failure is stored as `ok = false` with a
 * short reason ("kontrol edilemedi" in the panel) and never hides the previous good value.
 */

export type FeedFetch = (url: string, init: RequestInit) => Promise<Response>;

export const FEED_TTL_MS = 6 * 3600_000;
const TIMEOUT_MS = 10_000;
const MAX_BODY = 4 * 1024 * 1024;

export interface FeedRow {
  readonly item: string;
  readonly source: string;
  readonly latest: string | null;
  readonly ok: boolean;
  readonly error: string | null;
  readonly checkedAt: Date;
}

export class FeedError extends Error {}

/** Refuses anything that is not https on an allowlisted host (no userinfo, no port). */
export function allowedFeedUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    u.username === '' &&
    u.password === '' &&
    u.port === '' &&
    VERSION_FEED_HOSTS.includes(u.hostname)
  );
}

async function readBounded(res: Response): Promise<string> {
  if (res.body === null) return '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      throw new FeedError('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The latest stable version in a feed response (null: none found). Pure, for tests. */
export function parseFeed(source: FeedSource, body: unknown): string | null {
  const o = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  switch (source.kind) {
    case 'npm': {
      const v = o(body).version;
      return typeof v === 'string' ? normalizeVersion(v) : null;
    }
    case 'github': {
      const r = o(body);
      if (r.draft === true || r.prerelease === true) return null;
      return typeof r.tag_name === 'string' ? normalizeVersion(r.tag_name) : null;
    }
    case 'nuget': {
      const versions = o(body).versions;
      if (!Array.isArray(versions)) return null;
      let best: string | null = null;
      for (const v of versions) {
        if (typeof v !== 'string' || v.includes('-')) continue;
        if (best === null || (compareVersions(v, best) ?? 0) > 0) best = v;
      }
      return normalizeVersion(best);
    }
    case 'node-lts': {
      if (!Array.isArray(body)) return null;
      for (const r of body as unknown[]) {
        const e = o(r);
        if (e.lts !== false && e.lts !== undefined && typeof e.version === 'string') {
          return normalizeVersion(e.version);
        }
      }
      return null;
    }
  }
}

export class VersionFeedService {
  #lastRun = 0;
  #running: Promise<number> | null = null;
  readonly #listeners = new Set<(items: readonly string[]) => void>();

  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly clock: () => Date;
      readonly log: FastifyBaseLogger;
      /** null: feeds are switched off (the panel then shows "henüz kontrol edilmedi"). */
      readonly fetch: FeedFetch | null;
      readonly ttlMs?: number;
    },
  ) {}

  get enabled(): boolean {
    return this.deps.fetch !== null;
  }

  /**
   * p16-runtime-updates: one bounded JSON read with exactly the feed's boundaries (allowlisted https host, no redirects,
   * no credentials, 10 s, 4 MiB) — the exact version document of a runtime release. Throws FeedError.
   */
  getJson(url: string): Promise<unknown> {
    return this.#get(url);
  }

  /** p16-runtime-updates: called with the catalog items whose latest version changed in a refresh. */
  onChange(listener: (items: readonly string[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async rows(): Promise<Map<string, FeedRow>> {
    const { rows } = await this.deps.pool.query<{
      item: string;
      source: string;
      latest: string | null;
      ok: boolean;
      error: string | null;
      checked_at: Date;
    }>('SELECT item, source, latest, ok, error, checked_at FROM tool_version_feed');
    return new Map(
      rows.map((r) => [
        r.item,
        {
          item: r.item,
          source: r.source,
          latest: r.latest,
          ok: r.ok,
          error: r.error,
          checkedAt: r.checked_at,
        },
      ]),
    );
  }

  async #get(url: string): Promise<unknown> {
    const f = this.deps.fetch;
    if (f === null) throw new FeedError('feeds are disabled');
    if (!allowedFeedUrl(url)) throw new FeedError('host not allowed');
    let res: Response;
    try {
      res = await f(url, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: { accept: 'application/json', 'user-agent': 'remyral-master (fleet tool versions)' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new FeedError(err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'request failed');
    }
    if (!res.ok) throw new FeedError(`HTTP ${String(res.status)}`);
    const text = await readBounded(res);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new FeedError('not JSON');
    }
  }

  /** Reads every feed now (one request per distinct source) and stores the results. Returns how many succeeded. */
  refresh(): Promise<number> {
    this.#running ??= this.#refresh().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #refresh(): Promise<number> {
    if (this.deps.fetch === null) return 0;
    const now = this.deps.clock();
    this.#lastRun = now.getTime();
    const before = await this.rows();
    const changed: string[] = [];
    const results = new Map<string, { latest: string | null; error: string | null }>();
    let ok = 0;
    for (const item of CATALOG) {
      if (item.feed === null) continue;
      const key = feedKey(item.feed);
      let r = results.get(key);
      if (r === undefined) {
        try {
          const latest = parseFeed(item.feed, await this.#get(feedUrl(item.feed)));
          r =
            latest === null ? { latest: null, error: 'no version in the response' } : { latest, error: null };
        } catch (err) {
          r = { latest: null, error: err instanceof FeedError ? err.message : 'failed' };
        }
        results.set(key, r);
      }
      if (r.error === null) ok += 1;
      if (r.latest !== null && r.latest !== (before.get(item.id)?.latest ?? null)) changed.push(item.id);
      // A failure keeps the last good version (shown with its age), marking the item unchecked now.
      await this.deps.pool.query(
        `INSERT INTO tool_version_feed (item, source, latest, ok, error, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (item) DO UPDATE SET source = EXCLUDED.source,
           latest = COALESCE(EXCLUDED.latest, tool_version_feed.latest), ok = EXCLUDED.ok,
           error = EXCLUDED.error, checked_at = EXCLUDED.checked_at`,
        [item.id, key, r.latest, r.error === null, r.error?.slice(0, 300) ?? null, now],
      );
    }
    this.deps.log.info(
      { ok, items: CATALOG.filter((c) => c.feed !== null).length, changed },
      'tool version feeds read',
    );
    if (changed.length > 0) {
      for (const l of this.#listeners) {
        try {
          l(changed);
        } catch (err) {
          this.deps.log.warn({ err }, 'version feed listener failed');
        }
      }
    }
    return ok;
  }

  /** Scheduler step: refreshes when the cache is older than the TTL (and at most once per TTL per process). */
  async tick(): Promise<void> {
    if (this.deps.fetch === null) return;
    const ttl = this.deps.ttlMs ?? FEED_TTL_MS;
    const now = this.deps.clock().getTime();
    if (now - this.#lastRun < ttl) return;
    const { rows } = await this.deps.pool.query<{ oldest: Date | null; n: string }>(
      'SELECT min(checked_at) AS oldest, count(*)::text AS n FROM tool_version_feed',
    );
    const oldest = rows[0]?.oldest ?? null;
    const n = Number(rows[0]?.n ?? '0');
    if (
      oldest !== null &&
      n >= CATALOG.filter((c) => c.feed !== null).length &&
      now - oldest.getTime() < ttl
    ) {
      this.#lastRun = oldest.getTime();
      return;
    }
    await this.refresh();
  }
}
