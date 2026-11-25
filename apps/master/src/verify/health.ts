import { RuntimeKind } from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { JobStore } from '../jobs/store.js';
import { OpsError } from '../ops/model.js';
import { liveUrl } from '../ops/on-success.js';
import type { OpsService } from '../ops/service.js';
import type { PageFetcher, Probe } from '../uptime/probe.js';
import { crawl, type CrawlOptions } from './crawler.js';
import { cleanUrl, type Finding, type Screenshot } from './model.js';
import { OUTBOX_TOPIC_VERIFY } from './outbox.js';
import { readVerifierFiles } from './report.js';
import type { VerifySettingsStore } from './settings.js';
import {
  browserAvailable,
  closeReportJobGate,
  createVerifierJob,
  mayCreateJobs,
  VerifierRefusal,
} from './verifier-job.js';

/**
 * p10-verify-health (docs/design/p10-verify-health.md §5): the health check the master runs right after every
 * successful deploy / rollback ops action and every preview tunnel that became active.
 *
 * 1. Discovery (tick): new rows for such actions / previews of the last 30 minutes (project setting, default on).
 * 2. Probe through the uptime guard (status 200–399, latency, TLS expiry, the project's optional keyword); a failure is
 *    retried before it counts (the site may still be propagating).
 * 3. Same-origin crawl of the live site (bounded; `crawler.ts`), broken pages / assets as findings.
 * 4. A screenshot job on a machine with a browser (requester re-authorised), else "master-side check only".
 * 5. Result on the row (Deploys, Outputs), `deploy.unhealthy` + chat note on failure, optional auto-rollback.
 * The checks run outside the tick (`drain()` waits for them).
 */

export type HealthState =
  'pending' | 'checking' | 'browser' | 'passed' | 'warned' | 'failed' | 'error' | 'skipped';

export interface HealthView {
  readonly id: string;
  readonly project: string;
  readonly opsActionId: string | null;
  readonly previewId: string | null;
  readonly kind: string;
  readonly env: string | null;
  readonly url: string | null;
  readonly protected: boolean;
  readonly state: HealthState;
  readonly probe: Record<string, unknown> | null;
  readonly links: Record<string, unknown> | null;
  readonly findings: Finding[];
  readonly browserJobId: string | null;
  readonly browserNote: string | null;
  readonly screenshots: Screenshot[];
  readonly rollbackActionId: string | null;
  readonly rollbackNote: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** For Outputs site cards. */
export interface SiteHealth {
  readonly id: string;
  readonly state: HealthState;
  readonly checkedAt: string;
  readonly statusCode: number | null;
  readonly latencyMs: number | null;
  readonly broken: number;
  readonly screenshot: { readonly jobId: string; readonly artifactId: string } | null;
}

export interface HealthTiming {
  /** Probe failures before the check counts as failed (the first try included). */
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly probeTimeoutMs: number;
  readonly crawl: Omit<CrawlOptions, 'start' | 'fetcher'>;
  /** Minimum time between manual rechecks of one check. */
  readonly recheckGapMs: number;
}

export const DEFAULT_HEALTH_TIMING: HealthTiming = {
  maxAttempts: 4,
  retryDelayMs: 20_000,
  probeTimeoutMs: 10_000,
  crawl: {},
  recheckGapMs: 30_000,
};

const DISCOVERY_WINDOW_MS = 30 * 60_000;
const CLAIM_TIMEOUT_MS = 5 * 60_000;
const DEPLOY_KINDS = ['pages.deploy', 'pages.rollback', 'coolify.deploy', 'coolify.rollback'];
const ROLLBACKABLE = new Set(['pages.deploy', 'coolify.deploy']);
/** p11-fixes-a: AWAITING_APPROVAL = an older screenshot job that went through git flow (its run is over). */
const SCREENSHOT_JOB_DONE = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'AWAITING_APPROVAL'];
const TLS_WARN_DAYS = 14;

interface Row {
  id: string;
  project: string;
  ops_action_id: string | null;
  preview_id: string | null;
  kind: string;
  env: string | null;
  url: string | null;
  protected: boolean;
  state: HealthState;
  probe: Record<string, unknown> | null;
  links: Record<string, unknown> | null;
  findings: Finding[];
  browser_job_id: string | null;
  browser_state: string | null;
  browser_note: string | null;
  screenshots: Screenshot[];
  rollback_action_id: string | null;
  rollback_note: string | null;
  attempts: number;
  created_at: Date;
  finished_at: Date | null;
  rechecked_at: Date | null;
}

const COLS = `h.id::text AS id, h.project, h.ops_action_id::text AS ops_action_id, h.preview_id::text AS preview_id,
  h.kind, h.env, h.url, h.protected, h.state, h.probe, h.links, h.findings, h.browser_job_id::text AS browser_job_id,
  (SELECT j.state::text FROM jobs j WHERE j.id = h.browser_job_id) AS browser_state, h.browser_note, h.screenshots,
  h.rollback_action_id::text AS rollback_action_id, h.rollback_note, h.attempts, h.created_at, h.finished_at,
  h.rechecked_at`;

export interface DeployHealthDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly probe: Probe & PageFetcher;
  readonly ops: () => OpsService | null;
  readonly jobs: JobStore;
  readonly dispatch: (jobId: string) => Promise<unknown>;
  readonly settings: VerifySettingsStore;
  readonly chatNote?: (threadId: string, text: string, meta: Record<string, unknown>) => Promise<void>;
  readonly timing?: Partial<HealthTiming>;
}

export class DeployHealthService {
  readonly #running = new Set<Promise<void>>();
  readonly #timing: HealthTiming;

  constructor(private readonly deps: DeployHealthDeps) {
    this.#timing = { ...DEFAULT_HEALTH_TIMING, ...(deps.timing ?? {}) };
  }

  step(): { name: string; run: () => Promise<number> } {
    return { name: 'deploy-health', run: () => this.tick() };
  }

  async drain(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
  }

  #spawn(fn: () => Promise<void>): void {
    const p = fn()
      .catch((err: unknown) => {
        this.deps.log.error({ err }, 'deploy health check failed unexpectedly');
      })
      .finally(() => {
        this.#running.delete(p);
      });
    this.#running.add(p);
  }

  // --------------------------------------------------------------------------------------------- reads

  async get(id: string): Promise<HealthView | null> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM deploy_health_checks h WHERE h.id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : view(rows[0]);
  }

  async forAction(actionId: string): Promise<HealthView | null> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM deploy_health_checks h WHERE h.ops_action_id = $1`,
      [actionId],
    );
    return rows[0] === undefined ? null : view(rows[0]);
  }

  async list(
    project: string,
    filter: {
      readonly actions?: readonly string[];
      readonly previews?: readonly string[];
      readonly limit?: number;
    },
  ): Promise<HealthView[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM deploy_health_checks h
        WHERE h.project = $1
          AND ($2::uuid[] IS NULL OR h.ops_action_id = ANY($2::uuid[]) OR h.preview_id = ANY($3::uuid[]))
        ORDER BY h.created_at DESC LIMIT $4`,
      [
        project,
        filter.actions === undefined && filter.previews === undefined ? null : [...(filter.actions ?? [])],
        [...(filter.previews ?? [])],
        limit,
      ],
    );
    return rows.map(view);
  }

  /** Outputs: the check of each site item's latest action / preview (keys: ops action id or preview id). */
  async badges(
    project: string,
    actionIds: readonly string[],
    previewIds: readonly string[],
  ): Promise<Map<string, SiteHealth>> {
    const out = new Map<string, SiteHealth>();
    if (actionIds.length === 0 && previewIds.length === 0) return out;
    const { rows } = await this.deps.pool.query<{
      id: string;
      key: string;
      state: HealthState;
      updated_at: Date;
      probe: Record<string, unknown> | null;
      links: Record<string, unknown> | null;
      screenshots: Screenshot[];
    }>(
      `SELECT h.id::text AS id, coalesce(h.ops_action_id, h.preview_id)::text AS key, h.state, h.updated_at, h.probe,
              h.links, h.screenshots
         FROM deploy_health_checks h
        WHERE h.project = $1 AND (h.ops_action_id = ANY($2::uuid[]) OR h.preview_id = ANY($3::uuid[]))`,
      [project, [...actionIds], [...previewIds]],
    );
    for (const r of rows) {
      const shot = r.screenshots[0];
      const broken = Array.isArray(r.links?.broken) ? r.links.broken.length : 0;
      out.set(r.key, {
        id: r.id,
        state: r.state,
        checkedAt: r.updated_at.toISOString(),
        statusCode: typeof r.probe?.statusCode === 'number' ? r.probe.statusCode : null,
        latencyMs: typeof r.probe?.latencyMs === 'number' ? r.probe.latencyMs : null,
        broken,
        screenshot: shot === undefined ? null : { jobId: shot.jobId, artifactId: shot.artifactId },
      });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------- recheck

  async recheck(
    actor: { readonly userId: string; readonly ip?: string | null; readonly userAgent?: string | null },
    id: string,
  ): Promise<HealthView> {
    const now = this.deps.clock();
    const r = await this.get(id);
    if (r === null) throw new HttpError(404, 'health_not_found', 'Health check not found.');
    if (r.state === 'pending' || r.state === 'checking' || r.state === 'browser') {
      throw new HttpError(409, 'health_running', 'The health check is running.');
    }
    const { rowCount } = await this.deps.pool.query(
      `UPDATE deploy_health_checks SET state = 'pending', attempts = 0, next_attempt_at = NULL, probe = NULL,
              links = NULL, findings = '[]'::jsonb, browser_job_id = NULL, browser_note = NULL, finished_at = NULL,
              notified_at = NULL, claimed_at = NULL, rechecked_at = $2, updated_at = $2
        WHERE id = $1 AND state NOT IN ('pending', 'checking', 'browser')
          AND (rechecked_at IS NULL OR rechecked_at <= $3)`,
      [id, now, new Date(now.getTime() - this.#timing.recheckGapMs)],
    );
    if (rowCount === 0) {
      throw new HttpError(
        429,
        'recheck_too_soon',
        'This check was re-run moments ago; try again in half a minute.',
        {
          'retry-after': String(Math.ceil(this.#timing.recheckGapMs / 1000)),
        },
      );
    }
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'deploy.health.recheck',
      target: r.opsActionId === null ? `preview:${String(r.previewId)}` : `ops-action:${r.opsActionId}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { id, project: r.project },
    });
    return (await this.get(id)) as HealthView;
  }

  // ------------------------------------------------------------------------------------------- the tick

  async tick(): Promise<number> {
    const now = this.deps.clock();
    const since = new Date(now.getTime() - DISCOVERY_WINDOW_MS);
    await this.deps.pool.query(
      `INSERT INTO deploy_health_checks (project, ops_action_id, kind, env, state, created_at, updated_at)
       SELECT o.project, o.id, o.kind, o.env, 'pending', $1, $1 FROM ops_actions o
         LEFT JOIN project_verify_settings s ON s.project = o.project
        WHERE o.state = 'succeeded' AND o.kind = ANY($3::text[]) AND o.finished_at > $2
          AND coalesce(s.health_after_deploy, true)
          AND NOT EXISTS (SELECT 1 FROM deploy_health_checks h WHERE h.ops_action_id = o.id)
        ORDER BY o.finished_at LIMIT 20
       ON CONFLICT DO NOTHING`,
      [now, since, DEPLOY_KINDS],
    );
    await this.deps.pool.query(
      `INSERT INTO deploy_health_checks (project, preview_id, kind, env, url, protected, state, created_at, updated_at)
       SELECT pt.project, pt.id, 'tunnel', 'preview', 'https://' || pt.hostname, pt.protection <> 'none', 'pending', $1, $1
         FROM preview_tunnels pt LEFT JOIN project_verify_settings s ON s.project = pt.project
        WHERE pt.state = 'active' AND pt.connector_state = 'running' AND pt.connector_at > $2
          AND coalesce(s.health_after_deploy, true)
          AND NOT EXISTS (SELECT 1 FROM deploy_health_checks h WHERE h.preview_id = pt.id)
        ORDER BY pt.connector_at LIMIT 20
       ON CONFLICT DO NOTHING`,
      [now, since],
    );
    await this.deps.pool.query(
      `UPDATE deploy_health_checks SET state = 'pending', claimed_at = NULL, updated_at = $1
        WHERE state = 'checking' AND claimed_at < $2`,
      [now, new Date(now.getTime() - CLAIM_TIMEOUT_MS)],
    );
    let n = 0;
    const claimed = await this.deps.pool.query<{ id: string }>(
      `WITH c AS (SELECT id FROM deploy_health_checks
                   WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
                   ORDER BY created_at LIMIT 8 FOR UPDATE SKIP LOCKED)
       UPDATE deploy_health_checks h SET state = 'checking', claimed_at = $1, updated_at = $1
         FROM c WHERE h.id = c.id RETURNING h.id::text AS id`,
      [now],
    );
    for (const c of claimed.rows) {
      this.#spawn(() => this.#check(c.id));
      n++;
    }
    const ended = await this.deps.pool.query<{ id: string }>(
      `UPDATE deploy_health_checks h SET claimed_at = $1, updated_at = $1
        WHERE h.id IN (SELECT h2.id FROM deploy_health_checks h2 JOIN jobs j ON j.id = h2.browser_job_id
                        WHERE h2.state = 'browser' AND j.state = ANY($3::job_state[])
                          AND (h2.claimed_at IS NULL OR h2.claimed_at < $2)
                        LIMIT 10 FOR UPDATE OF h2 SKIP LOCKED)
       RETURNING h.id::text AS id`,
      [now, new Date(now.getTime() - CLAIM_TIMEOUT_MS), SCREENSHOT_JOB_DONE],
    );
    for (const e of ended.rows) {
      this.#spawn(() => this.#collectBrowser(e.id));
      n++;
    }
    return n;
  }

  async #row(id: string): Promise<Row | null> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM deploy_health_checks h WHERE h.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async #action(id: string): Promise<{
    kind: string;
    env: string | null;
    project: string;
    result: Record<string, unknown> | null;
    target: Record<string, unknown>;
    requested_by_type: string;
    requested_by_id: string;
    finished_at: Date | null;
  } | null> {
    const { rows } = await this.deps.pool.query<{
      kind: string;
      env: string | null;
      project: string;
      result: Record<string, unknown> | null;
      target: Record<string, unknown>;
      requested_by_type: string;
      requested_by_id: string;
      finished_at: Date | null;
    }>(
      `SELECT kind, env, project, result, target, requested_by_type, requested_by_id, finished_at
         FROM ops_actions WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async #check(id: string): Promise<void> {
    const r = await this.#row(id);
    if (r?.state !== 'checking') return;
    const settings = await this.deps.settings.get(r.project);
    let url = r.url;
    let requester: string | null = null;
    if (r.ops_action_id !== null) {
      const a = await this.#action(r.ops_action_id);
      if (a === null) {
        await this.#finish(id, 'skipped', { note: 'The ops action no longer exists.' });
        return;
      }
      url = cleanUrl(liveUrl({ result: a.result, target: a.target }));
      if (a.requested_by_type === 'user') requester = a.requested_by_id;
    } else if (r.preview_id !== null) {
      const p = await this.deps.pool.query<{ opened_by_type: string; opened_by_id: string; state: string }>(
        'SELECT opened_by_type, opened_by_id, state FROM preview_tunnels WHERE id = $1',
        [r.preview_id],
      );
      const pr = p.rows[0];
      if (pr === undefined || pr.state === 'closed' || pr.state === 'closing') {
        await this.#finish(id, 'skipped', {
          note: 'The preview link was closed before it could be checked.',
        });
        return;
      }
      if (pr.opened_by_type === 'user') requester = pr.opened_by_id;
    }
    if (url === null) {
      await this.#finish(id, 'skipped', { note: 'The deploy has no live address to check.' });
      return;
    }
    await this.deps.pool.query('UPDATE deploy_health_checks SET url = $2 WHERE id = $1', [id, url]);
    // 1. Probe (the uptime guard).
    const res = await this.deps.probe.http(
      {
        url,
        method: 'GET',
        expectStatus: { min: 200, max: 399 },
        keyword:
          r.protected || settings.healthKeyword === null
            ? null
            : { text: settings.healthKeyword, mode: 'present' },
        maxLatencyMs: null,
        maxRedirects: r.protected ? 0 : 3,
        tlsWarnDays: TLS_WARN_DAYS,
      },
      this.#timing.probeTimeoutMs,
    );
    const probe = {
      ok: res.ok,
      statusCode: res.statusCode,
      latencyMs: res.latencyMs,
      error: res.error,
      detail: res.detail,
      tlsExpiresAt: res.tlsExpiresAt?.toISOString() ?? null,
    };
    const attempts = r.attempts + 1;
    if (res.ok !== true) {
      if (attempts < this.#timing.maxAttempts) {
        await this.deps.pool.query(
          `UPDATE deploy_health_checks SET state = 'pending', attempts = $2, probe = $3, claimed_at = NULL,
                  next_attempt_at = $4, updated_at = $5 WHERE id = $1 AND state = 'checking'`,
          [
            id,
            attempts,
            JSON.stringify(probe),
            new Date(this.deps.clock().getTime() + this.#timing.retryDelayMs),
            this.deps.clock(),
          ],
        );
        return;
      }
      const findings: Finding[] = [
        {
          source: 'master',
          severity: 'fail',
          kind: 'request',
          message:
            `The site did not answer correctly after ${String(attempts)} tries: ${res.detail ?? res.error ?? 'failed'}.`.slice(
              0,
              300,
            ),
          url,
        },
      ];
      await this.deps.pool.query('UPDATE deploy_health_checks SET attempts = $2, probe = $3 WHERE id = $1', [
        id,
        attempts,
        JSON.stringify(probe),
      ]);
      await this.#finish(id, 'failed', { findings });
      return;
    }
    const findings: Finding[] = [];
    if (res.tlsExpiresAt !== null) {
      const days = Math.floor((res.tlsExpiresAt.getTime() - this.deps.clock().getTime()) / 86_400_000);
      if (days <= TLS_WARN_DAYS) {
        findings.push({
          source: 'master',
          severity: 'warn',
          kind: 'other',
          message: `The TLS certificate expires in ${String(Math.max(0, days))} day(s).`,
        });
      }
    }
    if (r.protected) {
      findings.push({
        source: 'master',
        severity: 'info',
        kind: 'other',
        message:
          'The preview is protected (Cloudflare Access): reachable, content not checked (no credentials are used).',
      });
      await this.deps.pool.query('UPDATE deploy_health_checks SET attempts = $2, probe = $3 WHERE id = $1', [
        id,
        attempts,
        JSON.stringify(probe),
      ]);
      await this.#finish(id, 'passed', { findings, note: 'Protected preview: no crawl, no screenshots.' });
      return;
    }
    // 2. Crawl (same origin, bounded).
    const c = await crawl({ start: url, fetcher: this.deps.probe, ...this.#timing.crawl });
    const links = {
      origin: c.origin,
      pages: c.pages,
      assets: c.assets,
      external: c.external,
      broken: c.broken,
      truncated: c.truncated,
      budgetExhausted: c.budgetExhausted,
    };
    for (const b of c.broken.slice(0, 30)) {
      const startPage = b.from === null;
      findings.push({
        source: 'master',
        severity: startPage ? 'fail' : 'warn',
        kind: 'link',
        message:
          `${b.kind === 'page' ? 'Page' : 'Asset'} ${b.status === null ? `failed (${b.error ?? 'no response'})` : `answered HTTP ${String(b.status)}`}${b.from === null ? '' : ` — linked from ${b.from}`}`.slice(
            0,
            300,
          ),
        url: b.url.slice(0, 500),
      });
    }
    await this.deps.pool.query(
      'UPDATE deploy_health_checks SET attempts = $2, probe = $3, links = $4, findings = $5 WHERE id = $1',
      [id, attempts, JSON.stringify(probe), JSON.stringify(links), JSON.stringify(findings)],
    );
    // 3. Screenshots on a machine with a browser.
    let note: string | null = null;
    if (!settings.healthScreenshots) note = 'Screenshots are switched off for this project.';
    else if (requester === null) note = 'The deploy was not requested by a person: master-side check only.';
    else if (!(await browserAvailable(this.deps.pool))) {
      note = 'No machine reports a browser: master-side link check only.';
    } else if (!(await mayCreateJobs(this.deps.pool, requester, r.project))) {
      note = 'The requester may not create jobs in this project: master-side check only.';
    }
    if (note === null && requester !== null) {
      try {
        const base = await this.#baseSpec(r.project);
        if (base === null) {
          note = 'The project has no job settings to run a screenshot job: master-side check only.';
        } else {
          const jobId = await createVerifierJob(
            {
              pool: this.deps.pool,
              jobs: this.deps.jobs,
              dispatch: this.deps.dispatch,
              clock: this.deps.clock,
            },
            {
              purpose: 'health',
              // p19-verifier-jobs: "Sağlık kontrolü: <host>".
              subject: hostOf(url),
              project: r.project,
              creator: requester,
              parentSpec: base.spec,
              runtime: base.runtime,
              priority: 0,
              checklist: { type: 'live', projectKind: base.kind, url, browser: true },
              ...(base.kind === 'repository'
                ? { checkoutRef: base.baseRef, workBranch: `health/${id.slice(0, 8)}` }
                : {}),
            },
          );
          await this.deps.pool.query(
            `UPDATE deploy_health_checks SET state = 'browser', browser_job_id = $2, claimed_at = NULL, updated_at = $3
              WHERE id = $1 AND state = 'checking'`,
            [id, jobId, this.deps.clock()],
          );
          return;
        }
      } catch (err) {
        note =
          err instanceof VerifierRefusal
            ? `Screenshot job not started: ${err.reason}`
            : err instanceof HttpError
              ? `Screenshot job not started: ${err.publicMessage}`
              : 'Screenshot job not started (see the master log).';
        if (!(err instanceof VerifierRefusal) && !(err instanceof HttpError)) {
          this.deps.log.warn({ err, id }, 'health screenshot job could not be created');
        }
      }
    }
    await this.#finish(id, decide(findings), { findings, note });
  }

  /**
   * The spec a screenshot job of `project` starts from: the newest job of the project that a person started (its
   * runtime, sandbox profile, approval policy, trust and repository), so the job runs the way the project's jobs run.
   */
  async #baseSpec(project: string): Promise<{
    spec: Record<string, unknown>;
    runtime: RuntimeKind;
    kind: 'repository' | 'workspace';
    baseRef: string;
  } | null> {
    const { rows } = await this.deps.pool.query<{ spec: Record<string, unknown>; kind: string | null }>(
      `SELECT j.spec, p.kind FROM jobs j LEFT JOIN projects p ON p.id = j.project
        WHERE j.project = $1 AND j.created_by_type = 'user' AND j.spec->>'kind' IS NULL
          AND coalesce(j.spec->>'role', '') <> 'verify'
        ORDER BY j.created_at DESC LIMIT 1`,
      [project],
    );
    const j = rows[0];
    if (j === undefined) return null;
    const runtime = j.spec.runtime;
    if (typeof runtime !== 'string') return null;
    const rt = RuntimeKind.safeParse(runtime);
    if (!rt.success) return null;
    const kind = j.kind === 'workspace' ? 'workspace' : 'repository';
    const repo = j.spec.repository as { baseRef?: unknown } | undefined;
    if (kind === 'repository' && typeof repo?.baseRef !== 'string') return null;
    return {
      spec: j.spec,
      runtime: rt.data,
      kind,
      baseRef: typeof repo?.baseRef === 'string' ? repo.baseRef : '',
    };
  }

  async #collectBrowser(id: string): Promise<void> {
    const r = await this.#row(id);
    if (r?.state !== 'browser' || r.browser_job_id === null) return;
    const findings = [...r.findings];
    let note: string | null = null;
    let screenshots: Screenshot[] = [];
    if (r.browser_state !== 'SUCCEEDED' && r.browser_state !== 'AWAITING_APPROVAL') {
      note = `The screenshot job ended ${String(r.browser_state).toLowerCase()}.`;
    } else {
      if (r.browser_state === 'AWAITING_APPROVAL') {
        await closeReportJobGate(
          this.deps.jobs,
          r.browser_job_id,
          'Platform screenshot job: its report was collected; its branch is never merged.',
        );
      }
      const files = await readVerifierFiles(this.deps.pool, r.browser_job_id);
      if (files.report === null) note = files.problem ?? 'The screenshot job returned no report.';
      else {
        screenshots = files.screenshots;
        // The probe decides up / down; the browser's findings can only warn.
        for (const f of files.report.findings.slice(0, 30)) {
          findings.push({ ...f, severity: f.severity === 'fail' ? 'warn' : f.severity });
        }
      }
    }
    await this.#finish(id, decide(findings), { findings, note, screenshots });
  }

  async #finish(
    id: string,
    state: 'passed' | 'warned' | 'failed' | 'skipped' | 'error',
    extra: {
      readonly findings?: readonly Finding[];
      readonly note?: string | null;
      readonly screenshots?: readonly Screenshot[];
    },
  ): Promise<void> {
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `UPDATE deploy_health_checks SET state = $2, findings = COALESCE($3::jsonb, findings),
              browser_note = COALESCE($4, browser_note), screenshots = COALESCE($5::jsonb, screenshots),
              finished_at = $6, notified_at = $6, claimed_at = NULL, updated_at = $6
        WHERE id = $1 AND state IN ('pending', 'checking', 'browser') RETURNING id::text AS id`,
      [
        id,
        state,
        extra.findings === undefined ? null : JSON.stringify(extra.findings),
        extra.note ?? null,
        extra.screenshots === undefined ? null : JSON.stringify(extra.screenshots),
        now,
      ],
    );
    if (rows[0] === undefined) return;
    const r = await this.#row(id);
    if (r === null) return;
    await this.deps.audit.record({
      actor: { type: 'system', id: 'deploy-health' },
      action: 'deploy.health.finish',
      target: r.ops_action_id === null ? `preview:${String(r.preview_id)}` : `ops-action:${r.ops_action_id}`,
      outcome: state === 'failed' || state === 'error' ? 'failure' : 'success',
      metadata: {
        id,
        state,
        url: r.url,
        statusCode: r.probe?.statusCode ?? null,
        broken: Array.isArray(r.links?.broken) ? r.links.broken.length : 0,
        screenshots: r.screenshots.length,
      },
    });
    if (state !== 'failed') return;
    await this.deps.pool.query(
      'INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)',
      [OUTBOX_TOPIC_VERIFY, JSON.stringify({ kind: 'health', id }), now],
    );
    await this.#chat(r);
    await this.#autoRollback(r);
  }

  async #chat(r: Row): Promise<void> {
    if (this.deps.chatNote === undefined || r.ops_action_id === null) return;
    const { rows } = await this.deps.pool.query<{ thread: string | null }>(
      `SELECT coalesce((SELECT d.source->>'chatThreadId' FROM job_deploy_on_success d WHERE d.ops_action_id = o.id),
                       o.source->>'chatThreadId') AS thread
         FROM ops_actions o WHERE o.id = $1`,
      [r.ops_action_id],
    );
    const thread = rows[0]?.thread ?? null;
    if (thread === null || !/^[0-9a-f-]{36}$/.test(thread)) return;
    try {
      await this.deps.chatNote(
        thread,
        `The health check after the deploy failed${r.url === null ? '' : ` for ${r.url}`}. [Open the deploy](/deploys/${r.ops_action_id}?logs=health) · [Düzeltme işi başlat](/deploys/${r.ops_action_id}?fix=1), or ask me “düzeltme işi taslakla” and I draft a fix job with the findings and the logs.`,
        {
          notice: 'deploy-health',
          opsActionId: r.ops_action_id,
          state: 'failed',
          fixActionId: r.ops_action_id,
        },
      );
    } catch (err) {
      this.deps.log.debug({ err, id: r.id }, 'deploy health: chat note not posted');
    }
  }

  /**
   * Opt-in auto-rollback (project setting; production only with its own switch): a failed check of a deploy that has a
   * rollback and is still the newest succeeded deploy of its kind and environment is rolled back through the ops
   * service as the system actor `deploy-health` — the project's deploy policy decides as for any request.
   */
  async #autoRollback(r: Row): Promise<void> {
    if (r.ops_action_id === null || !ROLLBACKABLE.has(r.kind)) return;
    const settings = await this.deps.settings.get(r.project);
    if (!settings.autoRollback) return;
    const note = async (text: string, actionId: string | null): Promise<void> => {
      await this.deps.pool.query(
        'UPDATE deploy_health_checks SET rollback_note = $2, rollback_action_id = COALESCE($3::uuid, rollback_action_id) WHERE id = $1',
        [r.id, text.slice(0, 500), actionId],
      );
    };
    if (r.env === 'production' && !settings.autoRollbackProduction) {
      await note('Not rolled back: auto-rollback for production is off for this project.', null);
      return;
    }
    const newer = await this.deps.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops_actions o, ops_actions a
        WHERE a.id = $1 AND o.project = a.project AND o.kind IN ('pages.deploy', 'pages.rollback', 'coolify.deploy',
              'coolify.rollback') AND split_part(o.kind, '.', 1) = split_part(a.kind, '.', 1)
          AND o.env IS NOT DISTINCT FROM a.env AND o.state = 'succeeded' AND o.id <> a.id
          -- p10-site-upload: a project may deploy to several Pages projects; only the same site counts.
          AND o.target->>'project' IS NOT DISTINCT FROM a.target->>'project'
          AND o.finished_at > a.finished_at`,
      [r.ops_action_id],
    );
    if ((newer.rows[0]?.n ?? 0) > 0) {
      await note('Not rolled back: a newer deploy of this site already happened.', null);
      return;
    }
    const ops = this.deps.ops();
    if (ops === null) {
      await note('Not rolled back: deploy integrations are not available.', null);
      return;
    }
    try {
      const out = await ops.rollback(
        { type: 'system', id: 'deploy-health' },
        r.ops_action_id,
        `health-rb-${r.id}`,
        'automation',
        { deployHealth: r.id },
      );
      const a = out.action;
      await note(
        a.state === 'awaiting_approval'
          ? 'Rollback requested; it waits for an approval (the project’s deploy policy).'
          : a.state === 'refused'
            ? `Rollback refused by the deploy policy: ${a.policy.reason}`.slice(0, 500)
            : `Rollback requested (${a.state}).`,
        a.id,
      );
      await this.deps.audit.record({
        actor: { type: 'system', id: 'deploy-health' },
        action: 'deploy.health.rollback',
        target: `ops-action:${r.ops_action_id}`,
        outcome: a.state === 'refused' ? 'denied' : 'success',
        metadata: { id: r.id, rollbackActionId: a.id, state: a.state, env: r.env },
      });
    } catch (err) {
      const msg = err instanceof OpsError ? err.message : 'internal error';
      if (!(err instanceof OpsError)) this.deps.log.warn({ err, id: r.id }, 'auto-rollback failed');
      await note(`Not rolled back: ${msg}`, null);
      await this.deps.audit.record({
        actor: { type: 'system', id: 'deploy-health' },
        action: 'deploy.health.rollback',
        target: `ops-action:${r.ops_action_id}`,
        outcome: 'failure',
        metadata: { id: r.id, error: msg.slice(0, 300) },
      });
    }
  }
}

/** failed when a `fail` finding exists, warned with a `warn` finding, else passed. */
function decide(findings: readonly Finding[]): 'passed' | 'warned' | 'failed' {
  if (findings.some((f) => f.severity === 'fail')) return 'failed';
  if (findings.some((f) => f.severity === 'warn')) return 'warned';
  return 'passed';
}

function view(r: Row): HealthView {
  return {
    id: r.id,
    project: r.project,
    opsActionId: r.ops_action_id,
    previewId: r.preview_id,
    kind: r.kind,
    env: r.env,
    url: r.url,
    protected: r.protected,
    state: r.state,
    probe: r.probe,
    links: r.links,
    findings: r.findings,
    browserJobId: r.browser_job_id,
    browserNote: r.browser_note,
    screenshots: r.screenshots,
    rollbackActionId: r.rollback_action_id,
    rollbackNote: r.rollback_note,
    attempts: r.attempts,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

/** p19-verifier-jobs: the host of a checked address for the screenshot job's title (the whole text when unparsable). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
