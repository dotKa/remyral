import { describe, expect, it, vi } from 'vitest';
import { clearDecision, withinCooldown } from '../../src/alerts/index.js';
import type { Queryable } from '../../src/db/pool.js';
import { OpsError } from '../../src/ops/model.js';
import { isNotFound, POLL_BACKOFF_MAX_MS, pollBackoffMs } from '../../src/ops/service.js';
import { INBOX_RETENTION_DAYS, WorkerInboxRetention } from '../../src/orchestration/inbox-retention.js';
import { type CatalogServiceDeps, VersionCatalogService } from '../../src/update-channel/catalog.js';

/** p22-ops-hygiene: the pure parts — poll backoff, alert hysteresis, catalog refusal dedupe, inbox retention. */

const MIN = 60_000;

describe('deploy status poll backoff', () => {
  it('doubles from 15 s up to 5 min', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => pollBackoffMs(n))).toEqual([
      15_000,
      30_000,
      60_000,
      120_000,
      240_000,
      POLL_BACKOFF_MAX_MS,
      POLL_BACKOFF_MAX_MS,
    ]);
    expect(pollBackoffMs(0)).toBe(15_000);
    expect(pollBackoffMs(1_000)).toBe(POLL_BACKOFF_MAX_MS);
  });

  it('a provider "not found" is terminal; other provider errors are not', () => {
    expect(isNotFound(new OpsError(424, 'coolify_not_found', 'deployment x: not found'))).toBe(true);
    expect(isNotFound(new OpsError(424, 'cloudflare_not_found', 'gone'))).toBe(true);
    expect(isNotFound(new OpsError(424, 'coolify_unavailable', 'down'))).toBe(false);
    expect(isNotFound(new OpsError(429, 'coolify_rate_limited', 'slow down'))).toBe(false);
    expect(isNotFound(new Error('coolify_not_found'))).toBe(false);
  });
});

describe('alert resolve hysteresis', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('resolves only after the condition stayed clear for the hold', () => {
    expect(clearDecision(null, now, 15 * MIN)).toBe('start-clear');
    expect(clearDecision(ago(14 * MIN), now, 15 * MIN)).toBe('wait');
    expect(clearDecision(ago(15 * MIN), now, 15 * MIN)).toBe('resolve');
    // 0: the old behaviour (resolve on the first clear evaluation).
    expect(clearDecision(null, now, 0)).toBe('resolve');
  });

  it('a re-raise inside the cooldown after a resolve re-opens the episode silently', () => {
    expect(withinCooldown(ago(10 * MIN), now, 30 * MIN)).toBe(true);
    expect(withinCooldown(ago(30 * MIN), now, 30 * MIN)).toBe(false);
    expect(withinCooldown(null, now, 30 * MIN)).toBe(false);
  });
});

describe('version catalog refusals', () => {
  function service() {
    const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const audit = { record: vi.fn(() => Promise.resolve()) };
    const pool = { query: vi.fn(() => Promise.resolve({ rows: [], rowCount: 0 })) };
    const svc = new VersionCatalogService({
      pool,
      audit,
      hub: {},
      clock: () => new Date('2026-11-01T12:00:00Z'),
      log,
      enabled: true,
      keys: [],
      url: null,
      file: '/nonexistent',
    } as unknown as CatalogServiceDeps);
    return { svc, log, audit };
  }
  const doc = (text: string, source: 'url' | 'file' = 'file') => ({
    bytes: Buffer.from(text),
    signature: {},
    source,
  });

  it('the same document refused for the same reason again is a debug line, not another warning and audit', async () => {
    const { svc, log, audit } = service();
    for (let i = 0; i < 5; i++) expect(await svc.accept(doc('{"sequence":1}'))).toBe('no_trusted_keys');
    // The URL copy of the same bytes is the same refusal.
    expect(await svc.accept(doc('{"sequence":1}', 'url'))).toBe('no_trusted_keys');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledTimes(5);
    // Another document is reported again.
    await svc.accept(doc('{"sequence":2}'));
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(2);
  });
});

describe('worker_inbox retention', () => {
  function db(batches: number[]) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const query = vi.fn((sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return Promise.resolve({ rows: [], rowCount: batches[calls.length - 1] ?? 0 });
    });
    return { db: { query } as unknown as Queryable, calls };
  }
  const now = new Date('2026-11-01T12:00:00Z');

  it('deletes processed rows older than 7 days in bounded batches, keeping pending effects and refusals', async () => {
    const { db: d, calls } = db([3, 0]);
    const r = new WorkerInboxRetention({ db: d, clock: () => now, batch: 3 });
    expect(await r.prune()).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params).toEqual([new Date(now.getTime() - INBOX_RETENTION_DAYS * 24 * 60 * MIN), 3]);
    expect(calls[0]?.sql).toContain("effect_status IS NULL OR effect_status IN ('done', 'failed')");
    expect(calls[0]?.sql).toContain("NOT (type = 'ARTIFACT_REF' AND outcome = 'rejected')");
  });

  it('stops after the batch limit of a pass; runs at most hourly from the tick', async () => {
    const { db: d, calls } = db([2, 2, 2, 2, 2]);
    let t = now.getTime();
    const r = new WorkerInboxRetention({ db: d, clock: () => new Date(t), batch: 2, maxBatches: 3 });
    expect(await r.maybePrune()).toBe(6);
    expect(calls).toHaveLength(3);
    t += 30 * MIN;
    expect(await r.maybePrune()).toBe(0);
    expect(calls).toHaveLength(3);
    t += 31 * MIN;
    await r.maybePrune();
    expect(calls.length).toBeGreaterThan(3);
  });
});
