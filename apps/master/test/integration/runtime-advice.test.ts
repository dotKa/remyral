import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { RuntimeAdviceService } from '../../src/runtime-advice/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p11-runtime-advice (docs/design/p11-runtime-advice.md): classification and outcome rows written by the job store,
 * later quality signals (rating, rerun), advice API, settings API, auto routing with constraints and bounded
 * exploration, explicit runtimes never overridden, the runtime × area matrix and the history back-fill. Real Postgres.
 */

const PW = 'quartz-meadow-lantern-7';
const USER: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const worker = (id: string): JobActor => ({ type: 'worker', id });
const TTL = 3_600_000;
const FRONTEND = 'Fix the dark mode toggle in the settings page layout';

function spec(runtime: string, prompt: string, extra: Record<string, unknown> = {}) {
  return {
    runtime,
    prompt,
    repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/test' },
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 3600 },
    ...extra,
  };
}

interface Advice {
  mode: string;
  classification: { area: string | null; signals: { source: string }[] };
  advice: { recommended: string | null; text: string; options: { runtime: string; n: number }[] } | null;
}

describeIntegration('runtime advice (integration, p11-runtime-advice)', () => {
  let h: Harness;
  let admin: Client;
  let viewer: Client;
  let secret: string;
  let store: JobStore;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function run(
    project: string,
    runtime: string,
    prompt: string,
    ok: boolean,
    touched?: string[],
  ): Promise<string> {
    const { job } = await store.create({ project, spec: spec(runtime, prompt), actor: USER, submit: true });
    const { lease } = await store.acquireLease(job.id, 'w-1', TTL);
    await store.transition(job.id, 'lease_acked', { actor: worker('w-1'), epoch: lease.epoch });
    await store.transition(job.id, 'runtime_started', { actor: worker('w-1'), epoch: lease.epoch });
    if (touched !== undefined) {
      await h.db.pool.query(
        `INSERT INTO job_git (job_id, project, provider, target_branch, changes, created_at, updated_at)
         VALUES ($1, $2, 'git', 'main', $3, $4, $4)`,
        [
          job.id,
          project,
          JSON.stringify({ files: touched.map((path) => ({ path, status: 'M' })) }),
          h.clock.now(),
        ],
      );
    }
    h.clock.advance(60_000);
    if (ok) {
      await store.transition(job.id, 'run_finished', { actor: worker('w-1'), epoch: lease.epoch });
      await store.transition(job.id, 'verification_passed_no_approval', {
        actor: { type: 'system', id: 's' },
      });
    } else {
      await store.transition(job.id, 'attempt_failed', {
        actor: worker('w-1'),
        epoch: lease.epoch,
        reason: 'boom',
      });
    }
    h.clock.advance(1_000);
    return job.id;
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    const viewerId = await h.createUser('viewer1', PW, 'viewer');
    viewer = await fullLogin(h, 'viewer1', PW, (await enroll(h, 'viewer1', PW)).secret);
    for (const p of ['web', 'other', 'fresh']) {
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
        p,
        h.clock.now(),
      ]);
    }
    await h.grant(viewerId, ['web'], 'viewer');
    store = new JobStore({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
    });
    // web: Claude Code does frontend well (6/6), Codex poorly (2/6).
    for (let i = 0; i < 6; i++) await run('web', 'claude-code', `${FRONTEND} #${String(i)}`, true);
    for (let i = 0; i < 6; i++) await run('web', 'codex', `${FRONTEND} variant ${String(i)}`, i < 2);
  });
  afterAll(async () => {
    await h.stop();
  });

  describe('job store rows', () => {
    it('classifies at submission and again at the end (touched paths), and writes the outcome row', async () => {
      const id = await run('other', 'codex', 'Make it better', true, ['server/a.go', 'server/b.go']);
      const c = await h.db.pool.query(
        'SELECT area, area_source, stage FROM job_classifications WHERE job_id = $1',
        [id],
      );
      expect(c.rows[0]).toEqual({ area: 'backend', area_source: 'touched-paths', stage: 'final' });
      const o = await h.db.pool.query(
        'SELECT runtime, area, kind, classified, succeeded, duration_sec FROM job_outcomes WHERE job_id = $1',
        [id],
      );
      expect(o.rows[0]).toMatchObject({
        runtime: 'codex',
        area: 'backend',
        classified: true,
        succeeded: true,
      });
      expect((o.rows[0] as { duration_sec: number }).duration_sec).toBe(60);
    });

    it('a cancelled job has a classification but no outcome', async () => {
      const { job } = await store.create({
        project: 'other',
        spec: spec('codex', 'Write unit tests for x'),
        actor: USER,
        submit: true,
      });
      const c = await h.db.pool.query('SELECT area, stage FROM job_classifications WHERE job_id = $1', [
        job.id,
      ]);
      expect(c.rows[0]).toEqual({ area: 'tests', stage: 'submitted' });
      await store.acquireLease(job.id, 'w-1', TTL);
      await store.transition(job.id, 'cancel_requested', { actor: USER, reason: 'x' });
      await store.transition(job.id, 'cancel_confirmed', { actor: { type: 'system', id: 'r' } });
      expect((await h.db.pool.query('SELECT 1 FROM job_outcomes WHERE job_id = $1', [job.id])).rowCount).toBe(
        0,
      );
    });
  });

  describe('advice', () => {
    it('recommends the runtime with the better record for the area, with evidence (operator+)', async () => {
      const res = await admin.req('POST', '/routing/advice', {
        project: 'web',
        prompt: 'Polish the navbar layout and the button styling',
      });
      expect(res.statusCode).toBe(200);
      const a = res.json<Advice>();
      expect(a.mode).toBe('advice');
      expect(a.classification.area).toBe('frontend');
      expect(a.advice?.recommended).toBe('claude-code');
      expect(a.advice?.text).toMatch(
        /^Recommended runtime for this project's frontend jobs: Claude Code — \d+% good outcomes \(n=6\) vs Codex \d+% \(n=6\)/u,
      );
      expect((await viewer.req('POST', '/routing/advice', { project: 'web', prompt: 'x' })).statusCode).toBe(
        403,
      );
    });

    it('no history: insufficient, no recommendation', async () => {
      const a = (
        await admin.req('POST', '/routing/advice', { project: 'fresh', prompt: FRONTEND })
      ).json<Advice>();
      expect(a.advice?.recommended).toBeNull();
    });
  });

  describe('later signals', () => {
    it('a 👎 makes a succeeded job a bad outcome; only finished jobs can be rated; viewers cannot rate', async () => {
      const id = await run('other', 'pi', 'Update the README', true);
      let view = (await admin.req('GET', `/jobs/${id}/runtime-outcome`)).json<{
        outcome: { good: boolean };
      }>();
      expect(view.outcome.good).toBe(true);
      expect((await admin.req('PUT', `/jobs/${id}/rating`, { rating: -1 })).statusCode).toBe(200);
      view = (await admin.req('GET', `/jobs/${id}/runtime-outcome`)).json();
      expect(view.outcome).toMatchObject({ good: false, reasons: ['rated 👎'] });
      const audit = await h.db.pool.query("SELECT 1 FROM audit_events WHERE action = 'job.rating.set'");
      expect(audit.rowCount).toBe(1);
      const { job } = await store.create({
        project: 'other',
        spec: spec('pi', 'x'),
        actor: USER,
        submit: true,
      });
      expect((await admin.req('PUT', `/jobs/${job.id}/rating`, { rating: 1 })).statusCode).toBe(409);
      const webJob = (
        await h.db.pool.query<{ job_id: string }>(
          "SELECT job_id FROM job_outcomes WHERE project = 'web' LIMIT 1",
        )
      ).rows[0];
      expect(
        (await viewer.req('PUT', `/jobs/${webJob?.job_id ?? ''}/rating`, { rating: 1 })).statusCode,
      ).toBe(403);
      expect((await viewer.req('GET', `/jobs/${webJob?.job_id ?? ''}/runtime-outcome`)).statusCode).toBe(200);
    });

    it('the same prompt submitted again within the rerun window marks the earlier job as corrected', async () => {
      const first = await run('other', 'pi', 'Regenerate the API client', true);
      await store.create({ project: 'other', spec: spec('pi', 'Regenerate the API client'), actor: USER });
      const view = (await admin.req('GET', `/jobs/${first}/runtime-outcome`)).json<{
        outcome: { good: boolean; reasons: string[] };
      }>();
      expect(view.outcome).toMatchObject({ good: false, reasons: ['rerun soon after (corrected)'] });
    });
  });

  describe('settings', () => {
    it('owner/admin with step-up; validated; audited; viewers refused', async () => {
      expect(
        (await admin.req('GET', '/projects/web/runtime-advice')).json<{ settings: { mode: string } }>()
          .settings.mode,
      ).toBe('advice');
      expect((await viewer.req('GET', '/projects/web/runtime-advice')).statusCode).toBe(403);
      await stepUp();
      const bad = await admin.req('PUT', '/projects/web/runtime-advice', { settings: { mode: 'auto' } });
      expect(bad.statusCode).toBe(400);
      const ok = await admin.req('PUT', '/projects/other/runtime-advice', {
        settings: {
          mode: 'auto',
          explorationPct: 10,
          minSamples: 3,
          allowedRuntimes: ['codex', 'pi'],
          allowPaid: false,
          halfLifeDays: 60,
          rerunWindowDays: 3,
          areaRules: [{ area: 'frontend', globs: ['packages/ui/**'] }],
        },
      });
      expect(ok.statusCode).toBe(200);
      const audit = await h.db.pool.query(
        "SELECT 1 FROM audit_events WHERE action = 'project.runtime_advice.update'",
      );
      expect(audit.rowCount).toBe(1);
    });
  });

  describe('auto mode', () => {
    it('POST /jobs runtime "auto" is refused unless the project opted in', async () => {
      const res = await admin.req('POST', '/jobs', { project: 'web', spec: spec('auto', FRONTEND) });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('runtime_auto_not_enabled');
    });

    it('POST /jobs runtime "auto" with no machine able to run anything: refused with the reasons, no job', async () => {
      const before = (
        await h.db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE project = 'other'")
      ).rows[0];
      const res = await admin.req('POST', '/jobs', { project: 'other', spec: spec('auto', FRONTEND) });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string; message: string }>().message).toContain('no machine can run it');
      const after = (
        await h.db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE project = 'other'")
      ).rows[0];
      expect(after).toEqual(before);
    });

    it('an explicit runtime is never overridden in an auto project', async () => {
      const res = await admin.req('POST', '/jobs', { project: 'other', spec: spec('claude-code', FRONTEND) });
      expect(res.statusCode).toBe(201);
      const id = res.json<{ job: { id: string } }>().job.id;
      const row = await h.db.pool.query<{ runtime: string }>(
        "SELECT spec->>'runtime' AS runtime FROM jobs WHERE id = $1",
        [id],
      );
      expect(row.rows[0]?.runtime).toBe('claude-code');
      expect(
        (await h.db.pool.query('SELECT 1 FROM job_runtime_decisions WHERE job_id = $1', [id])).rowCount,
      ).toBe(0);
    });

    it('chooses by expected outcome within the constraints, explains it, explores only within bounds', async () => {
      // `other` allows codex + pi, minSamples 3. Seed: codex frontend 3/3, pi frontend 1/3.
      for (let i = 0; i < 3; i++) await run('other', 'codex', `${FRONTEND} c${String(i)}`, true);
      for (let i = 0; i < 3; i++) await run('other', 'pi', `${FRONTEND} p${String(i)}`, i === 0);
      // claude-code is the best in the fleet but not allowed here.
      const svc = (random: () => number) =>
        new RuntimeAdviceService({
          pool: h.db.pool,
          audit: new AuditLog(h.db.pool, h.clock.now),
          clock: h.clock.now,
          random,
        });
      const r = await svc(() => 0.99).resolveAuto('other', spec('auto', FRONTEND), {
        allowExploration: true,
      });
      expect(r.runtime).toBe('codex');
      expect(r.decision.how).toBe('best');
      expect(r.decision.reasons).toContain('Claude Code skipped: not allowed for auto mode in this project');
      // Production deploy jobs never explore, whatever the draw.
      const p = await svc(() => 0).resolveAuto('other', spec('auto', FRONTEND), { allowExploration: false });
      expect(p.decision.how).toBe('best');
      // A usage limit takes a runtime out.
      await h.db.pool.query(
        `INSERT INTO usage_limit_episodes (scope_key, scope, pause_scope, runtime, account_id, resume_at, started_at, last_hit_at)
         VALUES ('acct:codex:x', 'subscription', 'account', 'codex', 'acct-1', $1, $2, $2)`,
        [new Date(h.clock.now().getTime() + 3_600_000), h.clock.now()],
      );
      const l = await svc(() => 0.99).resolveAuto('other', spec('auto', FRONTEND), {
        allowExploration: true,
      });
      expect(l.runtime).toBe('pi');
      expect(l.decision.reasons.some((x) => x.startsWith('Codex skipped: at its usage limit'))).toBe(true);
      await h.db.pool.query("UPDATE usage_limit_episodes SET ended_at = $1 WHERE runtime = 'codex'", [
        h.clock.now(),
      ]);
      // Recorded with the job.
      const { job } = await store.create({ project: 'other', spec: spec(r.runtime, FRONTEND), actor: USER });
      await svc(() => 0.99).recordDecision(h.db.pool, job.id, 'other', r);
      const view = (await admin.req('GET', `/jobs/${job.id}/runtime-outcome`)).json<{
        decision: { runtime: string; how: string; reasons: string[] };
      }>();
      expect(view.decision).toMatchObject({ runtime: 'codex', how: 'best' });
      expect(view.decision.reasons[0]).toMatch(/^best expected outcome: Codex/u);
    });
  });

  describe('insights and back-fill', () => {
    it('GET /usage/runtime-outcomes: runtime × area with evidence; hidden projects are 404', async () => {
      const res = await viewer.req('GET', '/usage/runtime-outcomes?project=web');
      expect(res.statusCode).toBe(200);
      const m = res.json<{
        runtimes: string[];
        cells: { area: string | null; runtime: string; n: number; rawRate: number; models: unknown[] }[];
        advice: { area: string | null; recommended: string | null }[];
      }>();
      expect(m.runtimes).toEqual(['claude-code', 'codex']);
      expect(m.cells.find((c) => c.area === 'frontend' && c.runtime === 'codex')).toMatchObject({
        n: 6,
        rawRate: 0.3333,
      });
      expect(m.advice.find((a) => a.area === 'frontend')?.recommended).toBe('claude-code');
      expect((await viewer.req('GET', '/usage/runtime-outcomes?project=other')).statusCode).toBe(404);
    });

    it('classifies history the migration back-filled', async () => {
      const id = await run('other', 'codex', 'Do the thing', true);
      await h.db.pool.query('UPDATE job_outcomes SET classified = false, area = NULL WHERE job_id = $1', [
        id,
      ]);
      await h.db.pool.query('DELETE FROM job_classifications WHERE job_id = $1', [id]);
      await h.db.pool.query(
        `INSERT INTO job_git (job_id, project, provider, target_branch, changes, created_at, updated_at)
         VALUES ($1, 'other', 'git', 'main', $2, $3, $3)`,
        [id, JSON.stringify({ files: [{ path: 'docs/a.md' }, { path: 'docs/b.md' }] }), h.clock.now()],
      );
      const svc = new RuntimeAdviceService({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
      expect(await svc.backfill()).toBeGreaterThanOrEqual(1);
      const o = await h.db.pool.query('SELECT area, classified FROM job_outcomes WHERE job_id = $1', [id]);
      expect(o.rows[0]).toEqual({ area: 'docs', classified: true });
      const c = await h.db.pool.query<{ stage: string }>(
        'SELECT stage FROM job_classifications WHERE job_id = $1',
        [id],
      );
      expect(c.rows[0]?.stage).toBe('backfill');
    });
  });
});
