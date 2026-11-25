import { randomUUID } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import { MIGRATE_KINDS, migrateBlobs } from '../blobs/migrate.js';
import { moveBlobs } from '../blobs/move.js';
import type { BlobKind, BlobService } from '../blobs/store.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { MemorySuggestionService } from '../memory-suggestions/service.js';
import type { RelatedWorkService } from '../related/service.js';
import { BACKFILL_KINDS, type BackfillKind, searchBackfill } from '../search/backfill.js';
import type { SearchService } from '../search/service.js';

/**
 * p17-panel-settings Part 7 (docs/design/p17-panel-settings.md §9): the maintenance commands as background jobs started
 * from Ayarlar → Sunucu ayarları → Bakım, over the command-line implementations (`blobs:migrate` → migrateBlobs /
 * moveBlobs, `search:backfill` → searchBackfill, `memory:autolearn` → autoLearnBackfill per project):
 *
 * - **Dry run first:** a real run of a kind is refused until a dry run of the same kind and parameters finished in the
 *   last hour (its report is what the owner saw).
 * - **One at a time per kind** (a unique index over running jobs); the master that started it runs it.
 * - **Progress** (counts, the current step, the last lines) is written every few seconds; it doubles as a heartbeat —
 *   an open job without one for two minutes (its master stopped) is failed "interrupted" by any instance's tick; the
 *   commands are idempotent, so starting again continues.
 * - **Cancel** sets a flag the running master reads at its next step (and aborts at once when it is the same instance).
 * - Audited: `maintenance.<kind>.start | done | failed | cancelled` (counts only).
 */

export const MAINTENANCE_KINDS = ['blobs-migrate', 'search-backfill', 'memory-autolearn'] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];
export const BLOB_MODES = ['to-store', 'to-db', 'move-local', 'move-s3'] as const;
export type BlobMode = (typeof BLOB_MODES)[number];

export interface MaintenanceParams {
  /** blobs-migrate: the CLI's mode (default `to-store`: rows still in Postgres into the store in use). */
  readonly mode?: BlobMode;
  /** blobs-migrate / search-backfill: kinds (default: all). */
  readonly kinds?: readonly string[];
  /** memory-autolearn: projects (default: every project with pending suggestions). */
  readonly projects?: readonly string[];
}

export interface MaintenanceJobView {
  readonly id: string;
  readonly kind: MaintenanceKind;
  readonly params: MaintenanceParams;
  readonly dryRun: boolean;
  readonly state: 'running' | 'done' | 'failed' | 'cancelled';
  readonly progress: {
    readonly done: number;
    readonly total: number | null;
    readonly step: string;
    readonly lines: readonly string[];
  };
  readonly report: unknown;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly startedBy: string | null;
}

interface Row {
  id: string;
  kind: MaintenanceKind;
  params: MaintenanceParams;
  dry_run: boolean;
  state: MaintenanceJobView['state'];
  progress: { done?: number; total?: number | null; step?: string; lines?: string[] };
  report: unknown;
  error: string | null;
  cancel_requested: boolean;
  started_at: Date;
  heartbeat_at: Date;
  finished_at: Date | null;
  username: string | null;
}

const COLS = `m.id, m.kind, m.params, m.dry_run, m.state, m.progress, m.report, m.error, m.cancel_requested, m.started_at,
  m.heartbeat_at, m.finished_at, u.username`;
const STALE_MS = 2 * 60_000;
const DRY_RUN_VALID_MS = 60 * 60_000;

function view(r: Row): MaintenanceJobView {
  return {
    id: r.id,
    kind: r.kind,
    params: r.params,
    dryRun: r.dry_run,
    state: r.state,
    progress: {
      done: r.progress.done ?? 0,
      total: r.progress.total ?? null,
      step: r.progress.step ?? '',
      lines: [...(r.progress.lines ?? [])],
    },
    report: r.report,
    error: r.error,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    startedBy: r.username,
  };
}

/** The params as stored and compared (sorted lists, defaults filled). */
function normalise(kind: MaintenanceKind, p: MaintenanceParams): MaintenanceParams {
  const bad = (msg: string): never => {
    throw new HttpError(400, 'invalid_maintenance_job', `Invalid maintenance job: ${msg}.`);
  };
  if (kind === 'blobs-migrate') {
    const mode = p.mode ?? 'to-store';
    if (!(BLOB_MODES as readonly string[]).includes(mode)) bad('mode');
    const kinds = [...new Set(p.kinds ?? MIGRATE_KINDS)].sort();
    if (kinds.some((k) => !(MIGRATE_KINDS as readonly string[]).includes(k))) bad('kinds');
    return { mode, kinds };
  }
  if (kind === 'search-backfill') {
    const kinds = [...new Set(p.kinds ?? BACKFILL_KINDS)].sort();
    if (kinds.some((k) => !(BACKFILL_KINDS as readonly string[]).includes(k))) bad('kinds');
    return { kinds };
  }
  const projects = [...new Set(p.projects ?? [])].sort();
  if (projects.some((x) => !/^[A-Za-z0-9_.:-]{1,128}$/.test(x))) bad('projects');
  return projects.length === 0 ? {} : { projects };
}

export class MaintenanceService {
  readonly #running = new Map<string, AbortController>();

  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly blobs: BlobService;
      readonly search: SearchService;
      readonly related: RelatedWorkService;
      readonly relatedEnabled: boolean;
      readonly memory: () => MemorySuggestionService | null;
      readonly log?: { warn(obj: unknown, msg: string): void };
      /** Progress write period (default 3 s). */
      readonly progressMs?: number;
    },
  ) {}

  async list(): Promise<MaintenanceJobView[]> {
    await this.tick();
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM maintenance_jobs m LEFT JOIN users u ON u.id = m.started_by
        ORDER BY m.started_at DESC LIMIT 20`,
    );
    return rows.map(view);
  }

  async get(id: string): Promise<MaintenanceJobView> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'not_found', 'Not found.');
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM maintenance_jobs m LEFT JOIN users u ON u.id = m.started_by WHERE m.id = $1`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'not_found', 'Not found.');
    return view(r);
  }

  /** Starts a job in the background (returns at once). A real run needs a recent dry run with the same parameters. */
  async start(
    actor: { readonly userId: string; readonly ip?: string | null; readonly userAgent?: string | null },
    kind: MaintenanceKind,
    raw: MaintenanceParams,
    dryRun: boolean,
  ): Promise<MaintenanceJobView> {
    const params = normalise(kind, raw);
    const now = this.deps.clock();
    if (!dryRun) {
      const { rows } = await this.deps.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM maintenance_jobs
          WHERE kind = $1 AND dry_run AND state = 'done' AND params = $2::jsonb AND finished_at > $3`,
        [kind, JSON.stringify(params), new Date(now.getTime() - DRY_RUN_VALID_MS)],
      );
      if ((rows[0]?.n ?? 0) === 0) {
        throw new HttpError(
          409,
          'maintenance_dry_run_required',
          'Run a dry run with the same settings first (valid for an hour).',
        );
      }
    }
    if (kind === 'memory-autolearn' && (await this.deps.memory()?.autoLearnProjects()) === null) {
      throw new HttpError(
        409,
        'maintenance_unavailable',
        'This maintenance job cannot run on this master (automatic learning is off or no embedding provider).',
      );
    }
    if (kind === 'search-backfill' && this.deps.search.embedder === null) {
      throw new HttpError(
        409,
        'maintenance_unavailable',
        'This maintenance job cannot run on this master (automatic learning is off or no embedding provider).',
      );
    }
    await this.tick();
    const id = randomUUID();
    try {
      await this.deps.pool.query(
        `INSERT INTO maintenance_jobs (id, kind, params, dry_run, state, progress, started_by, started_at, heartbeat_at)
         VALUES ($1, $2, $3, $4, 'running', '{}'::jsonb, $5, $6, $6)`,
        [id, kind, JSON.stringify(params), dryRun, actor.userId, now],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new HttpError(409, 'maintenance_running', 'A job of this kind is already running.');
      }
      throw err;
    }
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      action: `maintenance.${kind}.start`,
      target: `maintenance:${id}`,
      outcome: 'success',
      metadata: { ...params, dryRun },
    });
    const ctl = new AbortController();
    this.#running.set(id, ctl);
    void this.#run(id, kind, params, dryRun, ctl).finally(() => this.#running.delete(id));
    return this.get(id);
  }

  async cancel(
    actor: { readonly userId: string; readonly ip?: string | null; readonly userAgent?: string | null },
    id: string,
  ): Promise<MaintenanceJobView> {
    const { rowCount } = await this.deps.pool.query(
      "UPDATE maintenance_jobs SET cancel_requested = true WHERE id = $1 AND state = 'running'",
      [id],
    );
    if (rowCount === 0) throw new HttpError(409, 'maintenance_not_running', 'This job is not running.');
    this.#running.get(id)?.abort();
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      action: 'maintenance.cancel',
      target: `maintenance:${id}`,
      outcome: 'success',
    });
    return this.get(id);
  }

  /** Orchestrator tick: a job whose master stopped is failed "interrupted". Never throws. */
  async tick(): Promise<void> {
    try {
      const now = this.deps.clock();
      const { rows } = await this.deps.pool.query<{ id: string; kind: string }>(
        `UPDATE maintenance_jobs SET state = 'failed', error = 'interrupted: the master that ran it stopped',
                finished_at = $1
          WHERE state = 'running' AND heartbeat_at < $2 AND NOT (id = ANY($3::uuid[]))
          RETURNING id, kind`,
        [now, new Date(now.getTime() - STALE_MS), [...this.#running.keys()]],
      );
      for (const r of rows) {
        await this.deps.audit.record({
          actor: { type: 'system', id: 'maintenance' },
          action: `maintenance.${r.kind}.failed`,
          target: `maintenance:${r.id}`,
          outcome: 'failure',
          metadata: { reason: 'interrupted' },
        });
      }
    } catch (err) {
      this.deps.log?.warn({ err }, 'maintenance tick failed');
    }
  }

  async #run(
    id: string,
    kind: MaintenanceKind,
    params: MaintenanceParams,
    dryRun: boolean,
    ctl: AbortController,
  ): Promise<void> {
    const progress = { done: 0, total: null as number | null, step: '', lines: [] as string[] };
    let last = 0;
    const flush = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - last < (this.deps.progressMs ?? 3000)) return;
      last = now;
      const { rows } = await this.deps.pool.query<{ cancel_requested: boolean }>(
        `UPDATE maintenance_jobs SET progress = $2, heartbeat_at = $3 WHERE id = $1 RETURNING cancel_requested`,
        [id, JSON.stringify({ ...progress, lines: progress.lines.slice(-20) }), this.deps.clock()],
      );
      if (rows[0]?.cancel_requested === true) ctl.abort();
    };
    const say = (line: string): void => {
      progress.lines.push(line.slice(0, 300));
      if (progress.lines.length > 40) progress.lines.splice(0, progress.lines.length - 40);
      void flush().catch(() => undefined);
    };
    // A heartbeat while a long step runs without progress lines.
    const beat = setInterval(() => {
      void flush(true).catch(() => undefined);
    }, 30_000);
    beat.unref();
    let report: unknown = null;
    let error: string | null = null;
    try {
      if (kind === 'blobs-migrate') report = await this.#blobs(params, dryRun, ctl.signal, progress, say);
      else if (kind === 'search-backfill')
        report = await this.#search(params, dryRun, ctl.signal, progress, say);
      else report = await this.#memory(params, dryRun, ctl.signal, progress, say);
    } catch (err) {
      error = (err instanceof Error ? err.message : 'failed').slice(0, 500);
    } finally {
      clearInterval(beat);
    }
    const state = error !== null ? 'failed' : ctl.signal.aborted ? 'cancelled' : 'done';
    await this.deps.pool
      .query(
        `UPDATE maintenance_jobs SET state = $2, progress = $3, report = $4, error = $5, finished_at = $6, heartbeat_at = $6
          WHERE id = $1 AND state = 'running'`,
        [
          id,
          state,
          JSON.stringify({ ...progress, lines: progress.lines.slice(-20) }),
          report === null ? null : JSON.stringify(report),
          error,
          this.deps.clock(),
        ],
      )
      .catch((err: unknown) => {
        this.deps.log?.warn({ err, id }, 'recording the maintenance job result failed');
      });
    await this.deps.audit
      .record({
        actor: { type: 'system', id: 'maintenance' },
        action: `maintenance.${kind}.${state}`,
        target: `maintenance:${id}`,
        outcome: state === 'done' ? 'success' : 'failure',
        metadata: { dryRun, done: progress.done, ...(error === null ? {} : { error }) },
      })
      .catch(() => undefined);
  }

  async #blobs(
    params: MaintenanceParams,
    dryRun: boolean,
    signal: AbortSignal,
    progress: { done: number; total: number | null; step: string },
    say: (line: string) => void,
  ): Promise<unknown> {
    const kinds = (params.kinds ?? MIGRATE_KINDS) as BlobKind[];
    const mode = params.mode ?? 'to-store';
    const totals = new Map<string, { done: number; total: number }>();
    const onCount = (kind: BlobKind, processed: number, total: number): void => {
      totals.set(kind, { done: processed, total });
      progress.done = [...totals.values()].reduce((n, x) => n + x.done, 0);
      progress.total = [...totals.values()].reduce((n, x) => n + x.total, 0);
      progress.step = kind;
    };
    const d = { pool: this.deps.pool, blobs: this.deps.blobs, audit: this.deps.audit };
    if (mode === 'move-local' || mode === 'move-s3') {
      const to = mode === 'move-s3' ? 's3' : 'local';
      if (to === 's3' && (await this.deps.blobs.activeS3()) === null) {
        throw new Error('no usable bucket is configured (Settings → Integrations → Storage)');
      }
      return moveBlobs(d, { to, dryRun, kinds, onProgress: say, onCount, signal });
    }
    return migrateBlobs(d, { dryRun, kinds, toDb: mode === 'to-db', onProgress: say, onCount, signal });
  }

  async #search(
    params: MaintenanceParams,
    dryRun: boolean,
    signal: AbortSignal,
    progress: { done: number; total: number | null; step: string },
    say: (line: string) => void,
  ): Promise<unknown> {
    const kinds = (params.kinds ?? BACKFILL_KINDS) as BackfillKind[];
    const per = new Map<string, { done: number; total: number }>();
    const r = await searchBackfill(
      {
        pool: this.deps.pool,
        audit: this.deps.audit,
        search: this.deps.search,
        related: this.deps.related,
        relatedEnabled: this.deps.relatedEnabled,
        actor: { type: 'system', id: 'maintenance:search-backfill' },
      },
      {
        kinds,
        dryRun,
        signal,
        onProgress: (p) => {
          per.set(p.kind, { done: p.done, total: p.total });
          progress.done = [...per.values()].reduce((n, x) => n + x.done, 0);
          progress.total = [...per.values()].reduce((n, x) => n + x.total, 0);
          progress.step = p.kind;
          say(`${p.kind}: ${String(p.done)} / ${String(p.total)}`);
        },
      },
    );
    if (r === null) throw new Error('no embedding provider is configured');
    if (dryRun) {
      progress.total = Object.values(r.missingBefore).reduce((n, x) => n + x, 0);
      say(`missing: ${kinds.map((k) => `${k} ${String(r.missingBefore[k])}`).join(', ')}`);
    }
    return r;
  }

  async #memory(
    params: MaintenanceParams,
    dryRun: boolean,
    signal: AbortSignal,
    progress: { done: number; total: number | null; step: string },
    say: (line: string) => void,
  ): Promise<unknown> {
    const memory = this.deps.memory();
    if (memory === null) throw new Error('memory suggestions are not available');
    const projects = params.projects ?? (await memory.autoLearnProjects()) ?? [];
    progress.total = projects.length;
    const out: unknown[] = [];
    const totals: Record<string, number> = { merged: 0, known: 0, accepted: 0, expiring: 0, human: 0 };
    for (const p of projects) {
      if (signal.aborted) break;
      progress.step = p;
      const stats = await memory.autoLearnBackfill({
        projects: [p],
        dryRun,
        actor: { type: 'system', id: 'maintenance:memory-autolearn' },
      });
      for (const [k, v] of Object.entries(stats.totals) as [string, number][])
        totals[k] = (totals[k] ?? 0) + v;
      out.push(...stats.projects);
      progress.done += 1;
      say(
        `${p}: ${Object.entries(stats.totals)
          .map(([k, v]) => `${k} ${String(v)}`)
          .join(', ')}`,
      );
    }
    return { dryRun, projects: out, totals };
  }
}
