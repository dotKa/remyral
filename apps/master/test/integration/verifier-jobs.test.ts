import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, RULES } from '../../src/alerts/rules.js';
import { AuditLog } from '../../src/audit/audit.js';
import { JobStore } from '../../src/jobs/store.js';
import { OUTBOX_TOPIC_JOB_TRANSITION } from '../../src/jobs/outbox.js';
import { produce } from '../../src/notifications/producers.js';
import type { SecurityPolicyReader } from '../../src/security-policy/service.js';
import { AutoFixService } from '../../src/self-heal/auto-fix.js';
import { failureDigest } from '../../src/self-heal/service.js';
import { WorkspaceService } from '../../src/workspaces/service.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p19-verifier-jobs (docs/design/p19-verifier-jobs.md) against a real master (Postgres) and a "fake worker" (the test
 * moves the verifier like a worker would): a platform verifier job is titled from the job it checks, carries the
 * platform marker (purpose, checked job, outcome), and — when it cannot run (the production case: a private GitHub
 * repository fetched without a credential) — is NOT a failed job: no "job failed" notification, no auto-fix job, not
 * in the failure spike or the failure digest; the checked job's owner gets one "Doğrulama çalıştırılamadı: …"
 * notification with the cause in plain words, and "Doğrulamayı yeniden dene" starts the verification again.
 */
const PW = 'quartz-meadow-lantern-7';
const WS = 'genel';
const GIT_AUTH_FAILURE =
  "GitCommandError: git fetch failed (exit 128): fatal: could not read Username for 'https://github.com': terminal prompts disabled";

const h = new Harness();
let owner: Client;
let operator: Client;
let outsider: Client;
let operatorId = '';
let ws: WorkspaceService;

const wsSpec = (prompt: string) => ({
  runtime: 'codex',
  prompt,
  sandboxProfile: 'container',
  approvalPolicy: 'ask-sensitive',
  sourceTrust: 'trusted',
  limits: { maxDurationSec: 600 },
});

async function commitSite(jobId: string, html: string): Promise<void> {
  const content = Buffer.from(
    JSON.stringify({
      version: 1,
      directory: 'site',
      files: [
        {
          path: 'index.html',
          contentType: 'text/html',
          sha256: createHash('sha256').update(html).digest('hex'),
          base64: Buffer.from(html).toString('base64'),
        },
      ],
    }),
  );
  const attemptId = randomUUID();
  expect(
    await ws.stageChunk(
      h.db.pool,
      jobId,
      { attemptId, artifactId: 'ws-site-bundle', index: 0, data: content.toString('base64') },
      h.clock.now(),
    ),
  ).toBe('ok');
  expect(
    await ws.commitArtifact(
      h.db.pool,
      jobId,
      {
        attemptId,
        artifactId: 'ws-site-bundle',
        name: 'site-bundle.json',
        mediaType: 'application/json',
        sizeBytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      },
      h.clock.now(),
    ),
  ).toBe('ok');
}

/** Ends a job FAILED with a history row (what the orchestrator writes for a worker's failed result). */
async function failWith(jobId: string, reason: string): Promise<string> {
  const { rows } = await h.db.pool.query<{ version: number; state: string }>(
    'SELECT version, state::text AS state FROM jobs WHERE id = $1',
    [jobId],
  );
  const cur = rows[0];
  if (cur === undefined) throw new Error('no job');
  const t = await h.db.pool.query<{ id: string }>(
    `INSERT INTO job_transitions (job_id, version, from_state, to_state, trigger, actor_type, actor_id, reason,
                                  occurred_at)
     VALUES ($1, $2, $3, 'FAILED', 'attempt_failed', 'worker', 'wrk_abcdefghijklmnopqrstuvwxyz', $4, $5)
     RETURNING id::text AS id`,
    [jobId, cur.version + 1, cur.state, reason, h.clock.now()],
  );
  await h.db.pool.query('UPDATE jobs SET state = $2, version = $3, state_changed_at = $4 WHERE id = $1', [
    jobId,
    'FAILED',
    cur.version + 1,
    h.clock.now(),
  ]);
  return t.rows[0]?.id ?? '';
}

async function verifyTick(): Promise<void> {
  await h.app.verification.tick();
  await h.app.verification.drain();
}

async function verification(c: Client, jobId: string) {
  const res = await c.req('GET', `/jobs/${jobId}/verification`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ verification: Record<string, unknown> | null }>().verification;
}

describeIntegration('platform verifier jobs (integration, p19-verifier-jobs)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    await h.start();
    await h.createUser('owner1', PW);
    const { secret: ownerSecret } = await enroll(h, 'owner1', PW);
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    operatorId = await h.createUser('op1', PW, 'operator');
    const { secret: operatorSecret } = await enroll(h, 'op1', PW);
    operator = await fullLogin(h, 'op1', PW, operatorSecret);
    const outsiderId = await h.createUser('op.other', PW, 'operator');
    const { secret: outsiderSecret } = await enroll(h, 'op.other', PW);
    outsider = await fullLogin(h, 'op.other', PW, outsiderSecret);
    await h.db.pool.query("INSERT INTO projects (id, name, created_at) VALUES ('other', 'other', now())");
    await h.grant(operatorId, [WS], 'operator');
    await h.grant(outsiderId, ['other'], 'operator');
    ws = new WorkspaceService({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
      log: h.app.log,
    });
    expect(owner).toBeDefined();
  });
  afterAll(async () => {
    await h.stop();
  });

  it('a verifier that cannot read the repository: platform job, cause in plain words, no failure noise, retry', async () => {
    const res = await operator.req('POST', '/jobs', {
      project: WS,
      spec: { ...wsSpec('Build the landing page for the spring sale'), title: 'Bahar indirimi sayfası' },
      verifyOnSuccess: { mode: 'report' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const jobId = res.json<{ job: { id: string } }>().job.id;
    await commitSite(jobId, '<h1>Sale</h1>');
    await h.db.pool.query("UPDATE jobs SET state = 'SUCCEEDED', version = version + 1 WHERE id = $1", [
      jobId,
    ]);
    await verifyTick();
    const started = await verification(operator, jobId);
    expect(started).toMatchObject({ state: 'verifying' });
    const verifierId = String(started?.verifierJobId);

    // A readable title and the platform marker (the checked job, the outcome so far).
    const vd = await operator.req('GET', `/jobs/${verifierId}`);
    expect(vd.statusCode, vd.body).toBe(200);
    const vjob = vd.json<{ job: { title: string; platform: Record<string, unknown> | null } }>().job;
    expect(vjob.title).toBe('Doğrula: Bahar indirimi sayfası');
    expect(vjob.platform).toEqual({
      purpose: 'verify',
      checkedJobId: jobId,
      checkedTitle: 'Bahar indirimi sayfası',
      outcome: 'running',
      errorCause: null,
    });
    const marker = await h.db.pool.query<{ checked: string }>(
      'SELECT checked_job_id::text AS checked FROM report_only_jobs WHERE job_id = $1',
      [verifierId],
    );
    expect(marker.rows).toEqual([{ checked: jobId }]);
    // The checked job itself is an ordinary job.
    const cd = await operator.req('GET', `/jobs/${jobId}`);
    expect(cd.json<{ job: { platform: unknown } }>().job.platform).toBeNull();

    // The production failure: the verifier fetched a private repository without a credential.
    const transitionId = await failWith(verifierId, GIT_AUTH_FAILURE);
    await verifyTick();
    const done = await verification(operator, jobId);
    expect(done).toMatchObject({ state: 'error', errorCause: 'git_auth', verifierJobId: verifierId });

    // The list shows the verifier with the checked job's outcome, not a generic FAILED.
    const list = await operator.req('GET', `/jobs?project=${WS}`);
    const row = list
      .json<{ items: { id: string; state: string; platform: Record<string, unknown> | null }[] }>()
      .items.find((i) => i.id === verifierId);
    expect(row?.state).toBe('FAILED');
    expect(row?.platform).toMatchObject({ outcome: 'unverifiable', errorCause: 'git_auth' });

    // One notification to the checked job's owner, in plain words; no "job failed" for the verifier.
    expect(
      await produce(h.db.pool, {
        id: '1',
        topic: OUTBOX_TOPIC_JOB_TRANSITION,
        payload: {
          jobId: verifierId,
          transitionId,
          version: 3,
          from: 'QUEUED',
          to: 'FAILED',
          trigger: 'attempt_failed',
          attemptId: null,
          epoch: null,
        },
      }),
    ).toEqual([]);
    await h.app.notifications.runOnce();
    const notes = await h.db.pool.query<{ recipient_id: string; title: string; body: string; link: string }>(
      `SELECT recipient_id::text AS recipient_id, title, body, link FROM notifications WHERE kind = 'verify.failed'`,
    );
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]).toMatchObject({
      recipient_id: operatorId,
      title: 'Doğrulama çalıştırılamadı: Bahar indirimi sayfası',
      link: `/jobs/${jobId}`,
    });
    expect(notes.rows[0]?.body).toContain(
      'Doğrulama çalıştırılamadı: repo okunamadı (git kimlik bilgisi yok)',
    );
    expect(notes.rows[0]?.body).toContain('Doğrulamayı yeniden dene');
    const failedNotes = await h.db.pool.query(
      "SELECT 1 FROM notifications WHERE kind = 'job.failed' AND link = $1",
      [`/jobs/${verifierId}`],
    );
    expect(failedNotes.rowCount).toBe(0);

    // Not a failure spike, not in the failure digest.
    const spike = await RULES['jobs.failure_spike']({
      db: h.db.pool,
      now: new Date(h.clock.now().getTime() + 1000),
      t: { ...DEFAULT_THRESHOLDS, failureMinCount: 1, failureFactor: 0 },
      budgets: () => Promise.resolve([]),
    });
    expect(spike).toEqual([]);
    expect((await failureDigest(h.db.pool, null, h.clock.now())).failed).toBe(0);

    // Auto mode never opens a fix job for it.
    const autoFix = new AutoFixService({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      jobs: new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      }),
      securityPolicy: {
        current: () => Promise.resolve({ autonomy: { autoMode: true } }),
      } as unknown as SecurityPolicyReader,
      clock: h.clock.now,
      since: new Date(h.clock.now().getTime() - 60_000),
    });
    expect(await autoFix.openFixes()).toBe(0);
    const fixes = await h.db.pool.query<{ state: string; reason: string; fix_job_id: string | null }>(
      'SELECT state, reason, fix_job_id::text AS fix_job_id FROM job_auto_fixes WHERE source_job_id = $1',
      [verifierId],
    );
    expect(fixes.rows).toEqual([
      { state: 'skipped', reason: 'platform verifier jobs never get an auto-fix job', fix_job_id: null },
    ]);

    // "Doğrulamayı yeniden dene": RBAC (invisible project → 404), only from error, a new verifier on the next tick.
    expect((await outsider.req('POST', `/jobs/${jobId}/verification/retry`, {})).statusCode).toBe(404);
    const retry = await operator.req('POST', `/jobs/${jobId}/verification/retry`, {});
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json<{ verification: Record<string, unknown> }>().verification).toMatchObject({
      state: 'waiting',
      errorCause: null,
      verifierJobId: null,
    });
    const again = await operator.req('POST', `/jobs/${jobId}/verification/retry`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string }>().error).toBe('verification_not_retryable');
    await verifyTick();
    const restarted = await verification(operator, jobId);
    expect(restarted).toMatchObject({ state: 'verifying' });
    expect(restarted?.verifierJobId).not.toBe(verifierId);
    const audit = await h.db.pool.query<{ outcome: string }>(
      "SELECT outcome FROM audit_events WHERE action = 'verify.retry'",
    );
    expect(audit.rows.filter((r) => r.outcome === 'success')).toHaveLength(1);
    expect(audit.rows.some((r) => r.outcome === 'denied')).toBe(true);
    // The earlier verifier stays visible with its own outcome.
    const old = await operator.req('GET', `/jobs/${verifierId}`);
    expect(old.json<{ job: { platform: Record<string, unknown> } }>().job.platform).toMatchObject({
      outcome: 'unverifiable',
    });
  });
});
