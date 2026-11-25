import type { PageFetcher } from '../uptime/probe.js';
import { classifyLink, extractHtmlRefs, linkKey, type RefKind } from './links.js';

/**
 * p10-verify-health (docs/design/p10-verify-health.md §5.3, security review §8): the bounded same-origin crawler the
 * master runs against a freshly deployed site.
 *
 * - Every request goes through the injected `PageFetcher` — in production the uptime probe's guarded `page()` (http /
 *   https on the allowed ports, public addresses only per hop, no credentials, fixed headers).
 * - Only the origin of the start page (after its redirects) is followed; other origins are counted, never fetched.
 * - Bounded: pages (`<a href>` targets, breadth first) up to `maxDepth` and `maxPages`; same-origin assets (`src`,
 *   `<link href>`, `srcset`, CSS `url()`) up to `maxAssets`, status-checked with HEAD (GET without body on 405/501);
 *   a total time budget; `concurrency` requests at a time; HTML bodies read up to `maxBytes`.
 * - The result is counts and the broken references with the page they were found on — never page content.
 */

export interface CrawlOptions {
  readonly start: string;
  readonly fetcher: PageFetcher;
  readonly maxPages?: number;
  readonly maxDepth?: number;
  readonly maxAssets?: number;
  readonly budgetMs?: number;
  readonly concurrency?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** Monotonic clock (ms); tests inject one. */
  readonly now?: () => number;
}

export interface BrokenRef {
  readonly url: string;
  readonly kind: RefKind;
  /** HTTP status (null: no response — see `error`). */
  readonly status: number | null;
  readonly error: string | null;
  /** The page the reference was found on (null: the start page itself). */
  readonly from: string | null;
}

export interface CrawlResult {
  readonly origin: string | null;
  /** The start page's answer. */
  readonly start: {
    readonly status: number | null;
    readonly error: string | null;
    readonly finalUrl: string | null;
  };
  readonly pages: number;
  readonly assets: number;
  readonly external: number;
  readonly broken: readonly BrokenRef[];
  /** More pages / assets existed than the bounds allowed. */
  readonly truncated: boolean;
  readonly budgetExhausted: boolean;
}

export const CRAWL_DEFAULTS = {
  maxPages: 25,
  maxDepth: 2,
  maxAssets: 100,
  budgetMs: 20_000,
  concurrency: 4,
  maxBytes: 512 * 1024,
  timeoutMs: 8_000,
  maxRedirects: 3,
  /** Broken references kept in the result. */
  maxBroken: 50,
} as const;

const HARD = { maxPages: 100, maxDepth: 4, maxAssets: 500, budgetMs: 60_000, concurrency: 8 } as const;

function clamp(v: number | undefined, def: number, max: number, min = 0): number {
  const n = v ?? def;
  return Math.min(Math.max(Number.isFinite(n) ? Math.floor(n) : def, min), max);
}

interface Pending {
  readonly url: string;
  readonly depth: number;
  readonly from: string | null;
}

export async function crawl(opts: CrawlOptions): Promise<CrawlResult> {
  const maxPages = clamp(opts.maxPages, CRAWL_DEFAULTS.maxPages, HARD.maxPages, 1);
  const maxDepth = clamp(opts.maxDepth, CRAWL_DEFAULTS.maxDepth, HARD.maxDepth);
  const maxAssets = clamp(opts.maxAssets, CRAWL_DEFAULTS.maxAssets, HARD.maxAssets);
  const budgetMs = clamp(opts.budgetMs, CRAWL_DEFAULTS.budgetMs, HARD.budgetMs, 1);
  const concurrency = clamp(opts.concurrency, CRAWL_DEFAULTS.concurrency, HARD.concurrency, 1);
  const maxBytes = clamp(opts.maxBytes, CRAWL_DEFAULTS.maxBytes, 2 * 1024 * 1024);
  const timeoutMs = clamp(opts.timeoutMs, CRAWL_DEFAULTS.timeoutMs, 30_000, 100);
  const now = opts.now ?? (() => performance.now());
  const began = now();
  const left = (): number => budgetMs - (now() - began);

  const broken: BrokenRef[] = [];
  const addBroken = (b: BrokenRef): void => {
    if (broken.length < CRAWL_DEFAULTS.maxBroken) broken.push(b);
  };
  // Set from inside the request pool's closures.
  const flags = { truncated: false, budgetExhausted: false };
  let external = 0;
  const externalSeen = new Set<string>();

  // 1. The start page decides the origin (after its redirects — the deployed site's own address).
  const first = await opts.fetcher.page(opts.start, {
    method: 'GET',
    timeoutMs: Math.min(timeoutMs, Math.max(1, left())),
    maxBytes,
    maxRedirects: CRAWL_DEFAULTS.maxRedirects,
  });
  const startInfo = { status: first.status, error: first.error, finalUrl: first.finalUrl };
  if (!first.ok || first.finalUrl === null) {
    return {
      origin: null,
      start: startInfo,
      pages: 0,
      assets: 0,
      external: 0,
      broken: [{ url: opts.start, kind: 'page', status: first.status, error: first.error, from: null }],
      truncated: false,
      budgetExhausted: false,
    };
  }
  const startUrl = new URL(first.finalUrl);
  const origin = startUrl.origin;
  const visitedPages = new Set<string>([linkKey(new URL(opts.start)), linkKey(startUrl)]);
  const assets = new Map<string, string>(); // key → page it was first found on
  let pages = 1;
  /** Pages fetched or queued (the start page counts). */
  let planned = 1;
  if (first.status === null || first.status >= 400) {
    addBroken({ url: startUrl.href, kind: 'page', status: first.status, error: first.error, from: null });
  }

  let level: Pending[] = [];
  const collect = (html: Buffer | null, pageUrl: URL, depth: number): void => {
    if (html === null) return;
    for (const ref of extractHtmlRefs(html.toString('utf8'))) {
      const c = classifyLink(ref.raw, pageUrl, origin);
      if (c.type === 'skip') continue;
      const key = linkKey(c.url);
      if (c.type === 'external') {
        if (!externalSeen.has(key) && externalSeen.size < 10_000) {
          externalSeen.add(key);
          external++;
        }
        continue;
      }
      if (ref.kind === 'page') {
        if (visitedPages.has(key)) continue;
        if (depth + 1 > maxDepth) continue;
        if (planned >= maxPages) {
          flags.truncated = true;
          continue;
        }
        planned++;
        visitedPages.add(key);
        level.push({ url: c.url.href, depth: depth + 1, from: pageUrl.href });
      } else {
        if (assets.has(key) || visitedPages.has(key)) continue;
        if (assets.size >= maxAssets) {
          flags.truncated = true;
          continue;
        }
        assets.set(key, pageUrl.href);
      }
    }
  };
  collect(first.status !== null && first.status < 300 ? first.body : null, startUrl, 0);

  // 2. Pages, breadth first, `concurrency` at a time.
  const runPool = async <T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> => {
    let i = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        if (left() <= 0) {
          flags.budgetExhausted = true;
          return;
        }
        const item = items[i++] as T;
        await fn(item);
      }
    });
    await Promise.all(workers);
  };

  while (level.length > 0) {
    const current = level;
    level = [];
    await runPool(current, async (p) => {
      const r = await opts.fetcher.page(p.url, {
        method: 'GET',
        timeoutMs: Math.min(timeoutMs, Math.max(1, left())),
        maxBytes,
        maxRedirects: CRAWL_DEFAULTS.maxRedirects,
      });
      pages++;
      if (!r.ok || r.status === null || r.status >= 400) {
        addBroken({ url: p.url, kind: 'page', status: r.status, error: r.error, from: p.from });
        return;
      }
      // A redirect off the site is not followed further (its content is not ours to crawl).
      const finalUrl = r.finalUrl === null ? null : new URL(r.finalUrl);
      if (finalUrl === null || finalUrl.origin !== origin) return;
      collect(r.body, finalUrl, p.depth);
    });
    if (flags.budgetExhausted) break;
  }

  // 3. Same-origin assets: status only.
  let assetCount = 0;
  if (!flags.budgetExhausted) {
    await runPool([...assets.entries()], async ([url, from]) => {
      let r = await opts.fetcher.page(url, {
        method: 'HEAD',
        timeoutMs: Math.min(timeoutMs, Math.max(1, left())),
        maxBytes: 0,
        maxRedirects: CRAWL_DEFAULTS.maxRedirects,
      });
      if (r.ok && (r.status === 405 || r.status === 501)) {
        r = await opts.fetcher.page(url, {
          method: 'GET',
          timeoutMs: Math.min(timeoutMs, Math.max(1, left())),
          maxBytes: 0,
          maxRedirects: CRAWL_DEFAULTS.maxRedirects,
        });
      }
      assetCount++;
      if (!r.ok || r.status === null || r.status >= 400) {
        addBroken({ url, kind: 'asset', status: r.status, error: r.error, from });
      }
    });
  }
  return {
    origin,
    start: startInfo,
    pages,
    assets: assetCount,
    external,
    broken,
    truncated: flags.truncated,
    budgetExhausted: flags.budgetExhausted,
  };
}
