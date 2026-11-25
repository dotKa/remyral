import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Feed, FeedError, type FeedRelease, FEED_MAX_BYTES, newerReleases, verifyFeed } from './feed.js';

/**
 * p16-selfhost-onboarding §4: what the owners' "Güncelleme mevcut" banner reads. Two sources of the same signed feed,
 * both optional, the newer (`generatedAt`) verified one wins:
 *
 * - `UPDATE_FEED_URL` — the master fetches `feed.json` + `feed.sig.json` every 6 h (10 s timeout, no redirects,
 *   ≤ 1 MiB). Off-line safe: a failure keeps the last good feed and is reported, never thrown.
 * - `UPDATE_FEED_FILE` — the copy `remyral-ctl upgrade --check` (daily timer) caches on the host, mounted read-only
 *   (`/run/remyral-update/feed.json`): masters without outbound internet still learn about releases.
 *
 * The master never upgrades itself (no Docker socket): the banner tells the owner the host command.
 */

export interface UpdateStatus {
  /** Release keys are set and at least one source is configured. */
  readonly configured: boolean;
  readonly currentVersion: string | null;
  readonly channel: string | null;
  readonly latest: FeedRelease | null;
  readonly updateAvailable: boolean;
  /** Newer releases than the installed one, newest first (at most 10). */
  readonly newer: readonly FeedRelease[];
  readonly checkedAt: string | null;
  readonly source: 'url' | 'file' | null;
  /** The last check's problem (`unreachable`, `bad_signature`, …); null when the last check succeeded. */
  readonly error: string | null;
}

export interface UpdateFeedDeps {
  readonly currentVersion: string | null;
  readonly keys: readonly string[];
  readonly feedUrl: string | null;
  readonly feedFile: string | null;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly clock?: () => Date;
  /** URL refresh period (default 6 h) and file re-read period (default 5 min). */
  readonly intervalMs?: number;
  readonly fileIntervalMs?: number;
}

const SIX_HOURS = 6 * 60 * 60_000;
const FIVE_MINUTES = 5 * 60_000;

export class UpdateFeedService {
  private feed: { doc: Feed; source: 'url' | 'file' } | null = null;
  private checkedAt: Date | null = null;
  private error: string | null = null;
  private lastUrl = 0;
  private lastFile = 0;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: UpdateFeedDeps) {}

  get configured(): boolean {
    return this.deps.keys.length > 0 && (this.deps.feedUrl !== null || this.deps.feedFile !== null);
  }

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  status(): UpdateStatus {
    const current = this.deps.currentVersion;
    const doc = this.feed?.doc ?? null;
    const all = doc === null ? [] : newerReleases(doc, null);
    const newer = doc === null || current === null ? [] : newerReleases(doc, current);
    return {
      configured: this.configured,
      currentVersion: current,
      channel: doc?.channel ?? null,
      latest: all[0] ?? null,
      updateAvailable: newer.length > 0,
      newer: newer.slice(0, 10),
      checkedAt: this.checkedAt?.toISOString() ?? null,
      source: this.feed?.source ?? null,
      error: this.error,
    };
  }

  /** p17-host-actions: a release of the verified feed by version (null: not in the feed, or no feed yet). */
  release(version: string): FeedRelease | null {
    return this.feed?.doc.releases.find((r) => r.version === version) ?? null;
  }

  /** Orchestrator tick step: refreshes what is due (cheap when nothing is). */
  tick(): Promise<void> {
    if (!this.configured) return Promise.resolve();
    const t = this.now().getTime();
    const urlDue = this.deps.feedUrl !== null && t - this.lastUrl >= (this.deps.intervalMs ?? SIX_HOURS);
    const fileDue =
      this.deps.feedFile !== null && t - this.lastFile >= (this.deps.fileIntervalMs ?? FIVE_MINUTES);
    if (!urlDue && !fileDue) return Promise.resolve();
    return this.refresh({ url: urlDue, file: fileDue });
  }

  /** Reads the due sources now (both by default). Never throws: problems end up in `status().error`. */
  refresh(which: { url?: boolean; file?: boolean } = { url: true, file: true }): Promise<void> {
    if (this.running) return this.running;
    this.running = this.doRefresh(which).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doRefresh(which: { url?: boolean; file?: boolean }): Promise<void> {
    if (!this.configured) return;
    const t = this.now();
    const found: { doc: Feed; source: 'url' | 'file' }[] = [];
    const problems: string[] = [];
    if (which.file === true && this.deps.feedFile !== null) {
      this.lastFile = t.getTime();
      try {
        const doc = await this.fromFile(this.deps.feedFile);
        if (doc !== null) found.push({ doc, source: 'file' });
      } catch (err) {
        problems.push(err instanceof FeedError ? err.code : 'unreadable');
      }
    }
    if (which.url === true && this.deps.feedUrl !== null) {
      this.lastUrl = t.getTime();
      try {
        found.push({ doc: await this.fromUrl(this.deps.feedUrl), source: 'url' });
      } catch (err) {
        problems.push(err instanceof FeedError ? err.code : 'unreachable');
      }
    }
    if (this.feed !== null) found.push(this.feed);
    found.sort((a, b) => b.doc.generatedAt.localeCompare(a.doc.generatedAt));
    this.feed = found[0] ?? null;
    this.checkedAt = t;
    this.error = problems[0] ?? null;
  }

  private async fromFile(path: string): Promise<Feed | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const sig = await readFile(join(dirname(path), 'feed.sig.json'), 'utf8');
    return verifyFeed(bytes, sig, this.deps.keys);
  }

  private async fromUrl(url: string): Promise<Feed> {
    const get = async (u: string): Promise<Buffer> => {
      const res = await (this.deps.fetch ?? fetch)(u, {
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength > FEED_MAX_BYTES) throw new FeedError('too_large');
      return bytes;
    };
    const sigUrl = new URL('feed.sig.json', url).toString();
    const [bytes, sig] = await Promise.all([get(url), get(sigUrl)]);
    return verifyFeed(bytes, sig.toString('utf8'), this.deps.keys);
  }
}
