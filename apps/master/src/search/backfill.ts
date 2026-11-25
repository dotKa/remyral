import { setTimeout as sleep } from 'node:timers/promises';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import type { RelatedWorkService, WorkKind } from '../related/service.js';
import type { SearchService } from './service.js';

/**
 * p17-embeddings §7 `search:backfill`, shared by the command line (cli/search-backfill.ts) and the panel's maintenance
 * job (p17-panel-settings Part 7): embeds what the indexer has not reached yet, at a bounded rate. Only consented
 * projects, never secret-looking texts, only missing vectors (idempotent). `dryRun` counts and sends nothing.
 */

export const WORK_KINDS: readonly WorkKind[] = ['job_card', 'job_failure', 'workflow_failure', 'automation'];
export const BACKFILL_KINDS = ['job_summary', ...WORK_KINDS] as const;
export type BackfillKind = (typeof BACKFILL_KINDS)[number];

export interface BackfillReport {
  readonly dryRun: boolean;
  readonly model: string;
  readonly kinds: readonly BackfillKind[];
  readonly missingBefore: Readonly<Record<BackfillKind, number>>;
  readonly embedded: Readonly<Record<BackfillKind, number>>;
  readonly cancelled: boolean;
}

export async function searchBackfill(
  deps: {
    readonly pool: Pool;
    readonly audit: AuditRecorder;
    readonly search: SearchService;
    readonly related: RelatedWorkService;
    readonly relatedEnabled: boolean;
    readonly actor: { readonly type: 'system' | 'user'; readonly id: string };
  },
  opts: {
    readonly kinds: readonly BackfillKind[];
    readonly dryRun: boolean;
    readonly batch?: number;
    /** Texts per minute. */
    readonly rate?: number;
    readonly max?: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (p: {
      readonly kind: BackfillKind;
      readonly done: number;
      readonly total: number;
    }) => void;
  },
): Promise<BackfillReport | null> {
  const embedder = deps.search.embedder;
  if (embedder === null) return null;
  const batch = opts.batch ?? 32;
  const rate = opts.rate ?? 600;
  const max = opts.max ?? 1_000_000;
  const pending = await deps.related.pending();
  const { rows: js } = await deps.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (
       SELECT DISTINCT ON (r.job_id) r.job_id, r.attempt_id::text AS attempt_id
         FROM job_runs r JOIN jobs j ON j.id = r.job_id
         JOIN search_consent c ON c.namespace = 'project:' || j.project AND c.enabled
        WHERE jsonb_typeof(r.result->'summary') = 'string' AND length(r.result->>'summary') > 0
        ORDER BY r.job_id, r.result_received_at DESC NULLS LAST, r.created_at DESC) s
      LEFT JOIN search_embeddings e ON e.job_id = s.job_id
     WHERE e.id IS NULL OR e.source_version <> s.attempt_id OR e.model <> $1`,
    [embedder.model],
  );
  const before: Record<BackfillKind, number> = { job_summary: js[0]?.n ?? 0, ...pending };
  const done: Record<BackfillKind, number> = {
    job_summary: 0,
    job_card: 0,
    job_failure: 0,
    workflow_failure: 0,
    automation: 0,
  };
  let cancelled = false;
  const aborted = (): boolean => opts.signal?.aborted === true;
  if (!opts.dryRun) {
    let sent = 0;
    outer: for (const k of opts.kinds) {
      if (aborted()) {
        cancelled = true;
        break;
      }
      opts.onProgress?.({ kind: k, done: done[k], total: before[k] });
      if (k === 'job_summary') {
        const stats = await deps.search.sync();
        done.job_summary = stats.indexedJobs;
        sent += stats.indexedJobs + stats.indexedDocs;
        opts.onProgress?.({ kind: k, done: done[k], total: before[k] });
        continue;
      }
      if (!deps.relatedEnabled) continue;
      for (;;) {
        if (aborted()) {
          cancelled = true;
          break outer;
        }
        if (sent >= max) break;
        const started = Date.now();
        const n = (await deps.related.sync({ kinds: [k], limit: Math.min(batch, max - sent) }))[k];
        done[k] += n;
        sent += n;
        opts.onProgress?.({ kind: k, done: done[k], total: before[k] });
        if (deps.related.lastPicked(k) === 0) break;
        // Rate limit: `n` texts may take at most n / rate of a minute.
        const wait = Math.ceil((n / rate) * 60_000) - (Date.now() - started);
        if (wait > 0)
          await sleep(wait, undefined, opts.signal ? { signal: opts.signal } : {}).catch(() => undefined);
      }
    }
    await deps.audit.record({
      actor: deps.actor,
      action: 'search.backfill',
      target: 'search-index',
      outcome: 'success',
      metadata: { kinds: opts.kinds, model: embedder.model, embedded: done, cancelled },
    });
  }
  return {
    dryRun: opts.dryRun,
    model: embedder.model,
    kinds: opts.kinds,
    missingBefore: before,
    embedded: done,
    cancelled,
  };
}
