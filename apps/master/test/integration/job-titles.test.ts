import { afterAll, beforeAll, expect, it } from 'vitest';
import { JobTitles } from '../../src/jobs/titles.js';
import { jobName } from '../../src/notifications/job-name.js';
import { latestRunSummary, prBody, prTitle } from '../../src/gitflow/pr-text.js';
import { Cluster, PW } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin } from '../helpers/harness.js';
import { jobSpec, PROJECT } from '../helpers/job-worker.js';

/**
 * p15-job-titles (docs/design/p15-job-titles.md) against a real master and Postgres:
 *  - a submitted title is kept ('given'); without one the master derives a short one from the prompt ('derived');
 *  - the list, the detail and the job's spec (what ASSIGN_JOB carries) show the current title;
 *  - PUT /jobs/:id/title: operators rename (finished jobs too), viewers are refused, bad titles are 400, audited;
 *  - the back-fill gives older jobs (no job_titles row) a derived title;
 *  - notifications and pull requests name the job by its title.
 */
describeIntegration('job titles (integration, p15-job-titles)', { timeout: 120_000 }, () => {
  const c = new Cluster();
  let operator: Client;
  let viewer: Client;
  const OWNER_PROMPT =
    'Bu işin dalı, SampleWebApp uygulamasının Coolify DEPLOY DALI olacak. Uygulamayı Coolify üzerinde yayınla, sağlık kontrolünü ekle ve sonucu raporla.';

  const detail = async (id: string) =>
    (await c.admin.req('GET', `/jobs/${id}`)).json<{
      job: { title: string; titleSource: string; spec: { title?: string; prompt: string } };
    }>().job;

  beforeAll(async () => {
    await c.start(14);
    const op = await c.h.createUser('titleop', PW, 'operator');
    await c.h.grant(op, [PROJECT], 'operator');
    operator = await fullLogin(c.h, 'titleop', PW, (await enroll(c.h, 'titleop', PW)).secret);
    const vw = await c.h.createUser('titleview', PW, 'viewer');
    await c.h.grant(vw, [PROJECT], 'viewer');
    viewer = await fullLogin(c.h, 'titleview', PW, (await enroll(c.h, 'titleview', PW)).secret);
  });
  afterAll(async () => {
    await c.stop();
  });

  it('keeps a given title and derives one when none is given; list, detail and spec agree', async () => {
    const given = await c.submit(
      jobSpec({ prompt: OWNER_PROMPT, title: 'SampleWebApp: Coolify deploy dalı hazırla' }),
    );
    const derived = await c.submit(jobSpec({ prompt: OWNER_PROMPT }));
    expect(await detail(given)).toMatchObject({
      title: 'SampleWebApp: Coolify deploy dalı hazırla',
      titleSource: 'given',
      spec: { title: 'SampleWebApp: Coolify deploy dalı hazırla' },
    });
    const d = await detail(derived);
    expect(d).toMatchObject({
      title: 'Bu işin dalı, SampleWebApp uygulamasının Coolify DEPLOY…',
      titleSource: 'derived',
    });
    // The worker receives the stored title in the spec (the store overlays it like the time limit).
    expect(d.spec.title).toBe(d.title);
    expect(d.spec.prompt).toBe(OWNER_PROMPT);
    const list = (await c.admin.req('GET', `/jobs?project=${PROJECT}`)).json<{
      items: { id: string; title: string }[];
    }>().items;
    expect(list.find((j) => j.id === given)?.title).toBe('SampleWebApp: Coolify deploy dalı hazırla');
    expect(list.find((j) => j.id === derived)?.title.length).toBeLessThanOrEqual(60);
    // A multi-line or over-long submitted title is refused like any invalid spec field.
    const bad = await c.admin.req('POST', '/jobs', { project: PROJECT, spec: jobSpec({ title: 'a\nb' }) });
    expect(bad.statusCode).toBe(400);
    const long = await c.admin.req('POST', '/jobs', {
      project: PROJECT,
      spec: jobSpec({ title: 'x'.repeat(61) }),
    });
    expect(long.statusCode).toBe(400);
  });

  it('renames: operators (finished jobs too), not viewers; bad titles 400; audited', async () => {
    const id = await c.submit(jobSpec({ prompt: 'Fix the login redirect. Users land on /home.' }));
    const put = (who: Client, title: string) => who.req('PUT', `/jobs/${id}/title`, { title });
    expect((await put(viewer, 'Nope')).statusCode).toBe(403);
    expect((await put(operator, '   ')).statusCode).toBe(400);
    expect((await put(operator, 'x'.repeat(61))).statusCode).toBe(400);
    const ok = await put(operator, '  Login yönlendirmesini düzelt ');
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ title: 'Login yönlendirmesini düzelt', source: 'edited' });
    expect(await detail(id)).toMatchObject({
      title: 'Login yönlendirmesini düzelt',
      titleSource: 'edited',
      spec: { title: 'Login yönlendirmesini düzelt' },
    });
    // A finished job keeps its immutable spec in the table but can still be renamed.
    await c.cancelAll();
    expect((await put(operator, 'Login fix (eski)')).statusCode).toBe(200);
    expect((await detail(id)).title).toBe('Login fix (eski)');
    expect((await c.admin.req('GET', `/jobs/${id}/title`)).json()).toMatchObject({
      title: 'Login fix (eski)',
      source: 'edited',
    });
    const { rows } = await c.h.db.pool.query<{ outcome: string; metadata: { from?: string; to?: string } }>(
      "SELECT outcome, metadata FROM audit_events WHERE action = 'job.title.update' AND target = $1 ORDER BY id",
      [`job:${id}`],
    );
    expect(rows.map((r) => r.outcome)).toEqual(['denied', 'success', 'success']);
    expect(rows[1]?.metadata).toMatchObject({
      from: 'Fix the login redirect',
      to: 'Login yönlendirmesini düzelt',
    });
  });

  it('back-fills jobs created before titles existed (migration 0130)', async () => {
    const a = await c.submit(
      jobSpec({ prompt: '## Görev\n- Landing sayfasını yeniden tasarla\n- Testleri ekle' }),
    );
    const b = await c.submit(
      jobSpec({ prompt: 'Research vector indexes', title: 'Vektör indeks araştırması' }),
    );
    await c.h.db.pool.query('DELETE FROM job_titles WHERE job_id = ANY($1::uuid[])', [[a, b]]);
    // Before the back-fill readers still show a derived title, never the prompt.
    expect((await detail(a)).title).toBe('Landing sayfasını yeniden tasarla');
    const titles = new JobTitles({
      pool: c.h.db.pool,
      audit: { record: () => Promise.reject(new Error('no')) },
      clock: () => new Date(),
    });
    expect(await titles.backfill(1)).toBeGreaterThanOrEqual(2);
    const { rows } = await c.h.db.pool.query<{ job_id: string; title: string; source: string }>(
      'SELECT job_id::text AS job_id, title, source FROM job_titles WHERE job_id = ANY($1::uuid[]) ORDER BY title',
      [[a, b]],
    );
    expect(rows).toEqual([
      { job_id: a, title: 'Landing sayfasını yeniden tasarla', source: 'derived' },
      { job_id: b, title: 'Vektör indeks araştırması', source: 'given' },
    ]);
    // Idempotent.
    expect(await titles.backfill()).toBe(0);
  });

  it('notifications and pull requests name the job by its title', async () => {
    const id = await c.submit(
      jobSpec({ prompt: 'Long description\nwith details', title: 'Ödeme modülünü sadeleştir' }),
    );
    expect(await jobName(c.h.db.pool, id)).toEqual({
      id: id.slice(0, 8),
      title: 'Ödeme modülünü sadeleştir',
      ref: `${id.slice(0, 8)} “Ödeme modülünü sadeleştir”`,
    });
    const job = {
      id,
      spec: {
        prompt: 'Long description\nwith details @octocat',
        runtime: 'codex' as const,
        title: 'Ödeme modülünü sadeleştir',
      },
    };
    expect(prTitle(job)).toBe('Ödeme modülünü sadeleştir');
    const body = prBody(job, {
      totals: { files: 2, additions: 10, deletions: 3 },
      summary: 'Simplified the module; token ghp_' + 'a'.repeat(36),
      consoleOrigin: 'https://remyral.example',
    });
    expect(body).toContain('## Description\n\nLong description\nwith details @\u200boctocat');
    expect(body).toContain('## Agent summary');
    expect(body).not.toContain('a'.repeat(36));
    expect(body).toContain(`[${id.slice(0, 8)}](https://remyral.example/jobs/${id})`);
    expect(await latestRunSummary(c.h.db.pool, id)).toBeNull();
  });
});
