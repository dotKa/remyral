import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import type { Role } from '../../src/auth/users.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { TemplateService } from '../../src/templates/service.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p8-templates (docs/design/p8-templates.md): template CRUD with versions and authorization, rendering with parameters
 * as data, run attribution from the composer (POST /jobs), the chat card and automations, usage stats, deterministic
 * suggestions with feedback, and the assistant's template tools.
 */

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'tplproj';
const OTHER = 'tplother';
const REPO = 'https://git.example.test/acme/templates.git';

/** The fields these tests read from API answers. */
interface Body {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly state: string;
  readonly canEdit: boolean;
  readonly error: string;
  readonly message: string;
  readonly prompt: string;
  readonly diff: string;
  readonly automationId: string;
  readonly items: Body[];
  readonly current: { readonly parameters: { readonly name: string; readonly type: string }[] };
  readonly stats: { readonly automations: number; readonly runs: number };
  readonly job: { readonly id: string };
  readonly result: { readonly jobId: string };
  readonly candidates: Record<string, unknown>[];
}

describeIntegration('job templates (integration)', { timeout: 180_000 }, () => {
  const h = new Harness();
  let owner: Client;
  let ownerSecret = '';
  let ownerId = '';
  let op: Client;
  let opId = '';
  let viewer: Client;
  let viewerId = '';
  let outsider: Client;
  let jobs: JobStore;
  let store: ChatStore;
  let tools: ChatTools;

  beforeAll(async () => {
    await h.start();
    ownerId = await h.createUser('owner1', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    for (const p of [PROJECT, OTHER]) {
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
        [p],
      );
      await h.db.pool.query(
        `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                          require_ci, ci_timeout_sec, updated_by, updated_at)
         VALUES ($1, 1, 'git', $2, 'main', 'merge', false, 3600, $3, now()) ON CONFLICT (project) DO NOTHING`,
        [p, REPO, ownerId],
      );
    }
    const people: [string, Role, string | null][] = [
      ['op.tpl', 'operator', PROJECT],
      ['viewer.tpl', 'viewer', PROJECT],
      ['outsider.tpl', 'operator', OTHER],
    ];
    const clients: Client[] = [];
    const ids: string[] = [];
    for (const [name, role, project] of people) {
      const id = await h.createUser(name, PW, role);
      if (project !== null) await h.grant(id, [project], role === 'viewer' ? 'viewer' : 'operator');
      const { secret } = await enroll(h, name, PW);
      clients.push(await fullLogin(h, name, PW, secret));
      ids.push(id);
    }
    [op, viewer, outsider] = clients as [Client, Client, Client];
    [opId, viewerId] = ids as [string, string];
    const audit = new AuditLog(h.db.pool, h.clock.now);
    jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    tools = new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      templates: () => new TemplateService({ pool: h.db.pool, audit, clock: h.clock.now }),
      automations: () => h.app.automations,
    } as unknown as ChatToolsDeps);
  });
  afterAll(async () => {
    await h.stop();
  });

  const LANDING =
    'Hedef kitle analizi yap ve {{url:url}} için {{audience_count:int}} kişilik bir landing page hazırla.';
  let templateId = '';
  let globalId = '';

  async function stepUp(c: Client = owner, secret = ownerSecret): Promise<void> {
    h.clock.advance(30_000);
    const res = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
    expect(res.statusCode, res.body).toBe(200);
  }

  describe('CRUD, versions and authorization', () => {
    it('an operator creates a project template; placeholders become typed parameters', async () => {
      const res = await op.req('POST', '/templates', {
        project: PROJECT,
        title: 'Landing page',
        description: 'Audience analysis + landing page',
        tags: ['marketing', 'marketing', 'web'],
        prompt: LANDING,
        parameters: [{ name: 'audience_count', type: 'int', min: 1, max: 100000, default: 1000 }],
        defaults: { runtime: 'codex', approvalPolicy: 'ask-sensitive', limits: { maxDurationSec: 1800 } },
      });
      expect(res.statusCode, res.body).toBe(201);
      const t = res.json<Body>();
      templateId = t.id;
      expect(t).toMatchObject({
        project: PROJECT,
        version: 1,
        tags: ['marketing', 'web'],
        canEdit: true,
        stats: { runs: 0, successRate: null },
      });
      expect(t.current.parameters.map((p: { name: string; type: string }) => `${p.name}:${p.type}`)).toEqual([
        'audience_count:int',
        'url:url',
      ]);
      const audit = await h.db.pool.query("SELECT 1 FROM audit_events WHERE action = 'template.create'");
      expect(audit.rowCount).toBe(1);
    });

    it('refuses viewers, outsiders, global writes by non-admins and policy-looking or unsafe templates', async () => {
      const body = { title: 'X', prompt: 'Do {{thing}}', defaults: { runtime: 'codex' } };
      expect((await viewer.req('POST', '/templates', { ...body, project: PROJECT })).statusCode).toBe(403);
      expect((await outsider.req('POST', '/templates', { ...body, project: PROJECT })).statusCode).toBe(404);
      expect((await outsider.req('GET', `/templates/${templateId}`)).statusCode).toBe(404);
      expect((await op.req('POST', '/templates', body)).statusCode).toBe(403);
      const reserved = await op.req('POST', '/templates', {
        ...body,
        project: PROJECT,
        prompt: 'Run with {{approval_policy}}',
      });
      expect(reserved.statusCode).toBe(400);
      expect(reserved.json<Body>().error).toBe('invalid_template');
      const fullAccess = await op.req('POST', '/templates', {
        ...body,
        project: PROJECT,
        defaults: { runtime: 'codex', approvalPolicy: 'allow-all' },
      });
      expect(fullAccess.statusCode).toBe(400);
      expect(fullAccess.json<Body>().message).toMatch(/Never ask/);
    });

    it('owners create global templates, visible to every member', async () => {
      const res = await owner.req('POST', '/templates', {
        title: 'Weekly summary',
        prompt: 'Summarise the week of {{team}} in {{tone:enum(short|detailed)}} form.',
        defaults: { runtime: 'claude-code', watch: true },
      });
      expect(res.statusCode, res.body).toBe(201);
      globalId = res.json<Body>().id;
      const list = await viewer.req('GET', `/templates?project=${PROJECT}`);
      expect(
        list
          .json<Body>()
          .items.map((t: { id: string }) => t.id)
          .sort(),
      ).toEqual([globalId, templateId].sort());
      expect(list.json<Body>().items.find((t: { id: string }) => t.id === globalId)?.canEdit).toBe(false);
      expect((await outsider.req('GET', `/templates/${templateId}`)).statusCode).toBe(404);
      expect((await outsider.req('GET', `/templates/${globalId}`)).statusCode).toBe(200);
      expect(
        (await op.req('PATCH', `/templates/${globalId}`, { expectedVersion: 1, title: 'Mine' })).statusCode,
      ).toBe(403);
    });

    it('content changes make versions; stale edits conflict; diff, duplicate, archive and restore', async () => {
      const v2 = await op.req('PATCH', `/templates/${templateId}`, {
        expectedVersion: 1,
        prompt: `${LANDING} Ton: {{tone:enum(resmi|samimi)}}.`,
        changeNote: 'add tone',
      });
      expect(v2.statusCode, v2.body).toBe(200);
      expect(v2.json<Body>().version).toBe(2);
      const meta = await op.req('PATCH', `/templates/${templateId}`, {
        expectedVersion: 2,
        title: 'Landing page v2',
      });
      expect(meta.json<Body>()).toMatchObject({ version: 2, title: 'Landing page v2' });
      const stale = await op.req('PATCH', `/templates/${templateId}`, {
        expectedVersion: 1,
        prompt: 'x {{y}}',
      });
      expect(stale.statusCode).toBe(409);
      const versions = await viewer.req('GET', `/templates/${templateId}/versions`);
      expect(versions.json<Body>().items.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      const diff = await viewer.req('GET', `/templates/${templateId}/diff?from=1&to=2`);
      expect(diff.json<Body>().diff).toContain('+Hedef kitle');
      expect(diff.json<Body>().diff).toContain('parameters.json');
      const dup = await op.req('POST', `/templates/${templateId}/duplicate`, {});
      expect(dup.statusCode).toBe(201);
      expect(dup.json<Body>()).toMatchObject({
        title: 'Landing page v2 (copy)',
        source: { kind: 'duplicate', id: templateId },
      });
      expect((await op.req('POST', `/templates/${dup.json<Body>().id}/archive`)).json<Body>().state).toBe(
        'archived',
      );
      const active = await op.req('GET', `/templates?project=${PROJECT}`);
      expect(active.json<Body>().items.some((t: { id: string }) => t.id === dup.json<Body>().id)).toBe(false);
      expect((await op.req('POST', `/templates/${dup.json<Body>().id}/restore`)).json<Body>().state).toBe(
        'active',
      );
      await op.req('POST', `/templates/${dup.json<Body>().id}/archive`);
    });
  });

  describe('rendering and runs', () => {
    it('renders with values as quoted data; missing / unknown values are refused', async () => {
      // A policy field is not a parameter name at all (schema), and unknown names are refused by the template.
      const policy = await viewer.req('POST', `/templates/${templateId}/render`, {
        values: { approvalPolicy: 'allow-all' },
      });
      expect(policy.statusCode).toBe(400);
      const bad = await viewer.req('POST', `/templates/${templateId}/render`, {
        values: { colour: 'red', tone: 'angry' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json<Body>().message).toMatch(/Unknown parameter colour/);
      expect(bad.json<Body>().message).toMatch(/url is required/);
      const ok = await viewer.req('POST', `/templates/${templateId}/render`, {
        values: { url: 'https://shop.example', tone: 'samimi' },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json<Body>()).toMatchObject({ version: 2, project: PROJECT, defaults: { runtime: 'codex' } });
      expect(ok.json<Body>().prompt).toContain('"https://shop.example" için 1000 kişilik');
      expect(ok.json<Body>().prompt).toContain('<<<REMYRAL-TEMPLATE-PARAMETERS');
      // A global template needs the project it runs in.
      expect(
        (
          await viewer.req('POST', `/templates/${globalId}/render`, {
            values: { team: 'ops', tone: 'short' },
          })
        ).json<Body>().error,
      ).toBe('project_required');
    });

    it('POST /jobs records the template version (composer "Run"); a misfit template refuses the job', async () => {
      const render = (
        await op.req('POST', `/templates/${templateId}/render`, {
          values: { url: 'https://a.example', tone: 'resmi' },
        })
      ).json<Body>();
      const spec = {
        runtime: 'codex',
        prompt: render.prompt,
        repository: { url: REPO, baseRef: 'main', workBranch: `agent/tpl-${randomUUID().slice(0, 8)}` },
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        sourceTrust: 'trusted',
        limits: { maxDurationSec: 1800 },
      };
      const res = await op.req('POST', '/jobs', {
        project: PROJECT,
        spec,
        template: { id: templateId, version: 2 },
      });
      expect(res.statusCode, res.body).toBe(201);
      const run = await h.db.pool.query('SELECT version, via FROM job_template_runs WHERE job_id = $1', [
        res.json<Body>().job.id,
      ]);
      expect(run.rows).toEqual([{ version: 2, via: 'composer' }]);
      const before = await h.db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs');
      const misfit = await outsider.req('POST', '/jobs', {
        project: OTHER,
        spec,
        template: { id: templateId, version: 2 },
      });
      expect(misfit.statusCode).toBe(400);
      expect((await h.db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs')).rows[0]?.n).toBe(
        before.rows[0]?.n,
      );
      const t = await op.req('GET', `/templates/${templateId}`);
      expect(t.json<Body>().stats).toMatchObject({ runs: 1, finished: 0 });
    });

    it('an automation from a template needs a step-up and counts for the template', async () => {
      const body = {
        name: 'Weekly landing page',
        trigger: { kind: 'cron', cron: '0 3 * * 1' },
        values: { url: 'https://weekly.example', tone: 'resmi' },
      };
      h.clock.advance(11 * 60_000);
      expect((await owner.req('POST', `/templates/${templateId}/automations`, body)).statusCode).toBe(403);
      await stepUp();
      const res = await owner.req('POST', `/templates/${templateId}/automations`, body);
      expect(res.statusCode, res.body).toBe(201);
      const a = await h.db.pool.query<{ prompt: string; approval: string }>(
        "SELECT job_spec->>'prompt' AS prompt, job_spec->>'approvalPolicy' AS approval FROM automations WHERE id = $1",
        [res.json<Body>().automationId],
      );
      expect(a.rows[0]?.prompt).toContain('"https://weekly.example"');
      expect(a.rows[0]?.approval).toBe('ask-sensitive');
      expect((await owner.req('GET', `/templates/${templateId}`)).json<Body>().stats.automations).toBe(1);
    });
  });

  describe('suggestions', () => {
    async function finishedJob(prompt: string): Promise<string> {
      const creator: JobActor = { type: 'user', id: opId };
      const { job } = await jobs.create({
        project: PROJECT,
        actor: creator,
        submit: true,
        spec: {
          runtime: 'claude-code',
          prompt,
          repository: { url: REPO, baseRef: 'main', workBranch: `rac/${randomUUID().slice(0, 8)}` },
          sandboxProfile: 'container',
          approvalPolicy: 'ask-sensitive',
          sourceTrust: 'trusted',
          limits: { maxDurationSec: 3600 },
        },
      });
      const grant = await jobs.acquireLease(job.id, 'worker-1', 3_600_000);
      const w: JobActor = { type: 'worker', id: 'worker-1' };
      for (const ev of [
        'lease_acked',
        'runtime_started',
        'run_finished',
        'verification_passed_no_approval',
      ] as const) {
        await jobs.transition(job.id, ev, { actor: w, epoch: grant.lease.epoch });
      }
      return job.id;
    }
    const AUDIT = (site: string): string =>
      `Run an SEO audit of ${site} and write a short report with the ten most important fixes.`;

    it('a recurring prompt (3×) is suggested with an inferred url parameter; dismiss hides it', async () => {
      for (const site of ['https://one.example', 'https://two.example', 'https://three.example']) {
        await finishedJob(AUDIT(site));
      }
      await finishedJob('Upgrade the test runner and fix what breaks.');
      const res = await op.req('GET', `/template-suggestions?project=${PROJECT}`);
      expect(res.statusCode, res.body).toBe(200);
      const items = res.json<{
        items: {
          id: string;
          prompt: string;
          occurrences: number;
          parameters: { name: string; type: string }[];
          members: { kind: string; id: string }[];
          defaults: { runtime: string };
        }[];
      }>().items;
      const s = items.find((x) => x.prompt.includes('SEO audit'));
      expect(s).toMatchObject({
        occurrences: 3,
        prompt: AUDIT('{{url}}'),
        defaults: { runtime: 'claude-code' },
      });
      expect(s?.parameters.map((p) => `${p.name}:${p.type}`)).toEqual(['url:url']);
      // Outsiders do not see this project's jobs.
      expect((await outsider.req('GET', `/template-suggestions?project=${PROJECT}`)).statusCode).toBe(404);
      const fb = await op.req('POST', '/template-suggestions/feedback', {
        project: PROJECT,
        suggestionId: s?.id,
        kind: 'dismissed',
      });
      expect(fb.statusCode).toBe(204);
      const after = await op.req('GET', `/template-suggestions?project=${PROJECT}`);
      expect(after.json<Body>().items.some((x: { id: string }) => x.id === s?.id)).toBe(false);
      // Another user still sees it (feedback is per user).
      const own = await owner.req('GET', `/template-suggestions?project=${PROJECT}`);
      expect(own.json<Body>().items.some((x: { id: string }) => x.id === s?.id)).toBe(true);
      // "Save as template" from one of the jobs: an editor prefill with candidate parameters, nothing saved.
      const prefill = await op.req('POST', '/templates/from-job', { jobId: s?.members[0]?.id });
      expect(prefill.statusCode, prefill.body).toBe(200);
      expect(prefill.json<Body>()).toMatchObject({ project: PROJECT, source: { kind: 'job' } });
      expect(prefill.json<Body>().candidates[0]).toMatchObject({ type: 'url', name: 'url' });
    });
  });

  describe('assistant tools', () => {
    async function caller(userId: string, role: Role): Promise<ToolCaller> {
      const thread = await store.createThread(userId, 'templates');
      return {
        userId,
        subject: await loadSubject(h.db.pool, { id: userId, role }),
        threadId: thread.id,
        turnId: randomUUID(),
      };
    }

    it('list_templates shows what the user can run, with parameters and settings', async () => {
      const out = await tools.run(await caller(viewerId, 'viewer'), 'list_templates', { project: PROJECT });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      const ts = (out as { data: { templates: { id: string; parameters: { name: string }[] }[] } }).data
        .templates;
      expect(ts.map((t) => t.id).sort()).toEqual([globalId, templateId].sort());
      expect(ts.find((t) => t.id === templateId)?.parameters.map((p) => p.name)).toEqual([
        'audience_count',
        'url',
        'tone',
      ]);
    });

    it('draft_from_template drafts the normal job card with the template settings; confirming attributes it', async () => {
      const c = await caller(ownerId, 'owner');
      const refused = await tools.run(c, 'draft_from_template', {
        templateId,
        params: { url: 'https://chat.example', tone: 'resmi', sandbox_profile: 'unconfined' },
      });
      expect(refused).toMatchObject({ ok: false, code: 'invalid' });
      // A policy field is not even an input of the tool.
      expect(
        await tools.run(c, 'draft_from_template', { templateId, approvalPolicy: 'allow-all' }),
      ).toMatchObject({ ok: false, code: 'invalid' });
      const out = await tools.run(c, 'draft_from_template', {
        templateId,
        params: { url: 'https://chat.example', tone: 'resmi' },
      });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok || out.draft === undefined) throw new Error('no draft');
      expect(out.draft.kind).toBe('job');
      expect(out.draft.payload).toMatchObject({
        project: PROJECT,
        template: { id: templateId, version: 2 },
        spec: { runtime: 'codex', approvalPolicy: 'ask-sensitive', limits: { maxDurationSec: 1800 } },
      });
      expect(out.data).toMatchObject({ template: { title: 'Landing page v2', version: 2 } });
      await stepUp();
      const res = await owner.req('POST', `/chat/drafts/${out.draft.id}/confirm`);
      expect(res.statusCode, res.body).toBe(200);
      const run = await h.db.pool.query('SELECT via FROM job_template_runs WHERE job_id = $1', [
        res.json<Body>().result.jobId,
      ]);
      expect(run.rows).toEqual([{ via: 'chat' }]);
    });

    it('a global template runs in the named project; archived templates are refused', async () => {
      const c = await caller(ownerId, 'owner');
      const none = await tools.run(c, 'draft_from_template', {
        templateId: globalId,
        params: { team: 'ops', tone: 'short' },
      });
      expect(none).toMatchObject({ ok: false, code: 'invalid' });
      const ok = await tools.run(c, 'draft_from_template', {
        templateId: globalId,
        project: OTHER,
        params: { team: 'ops', tone: 'short' },
      });
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
      await owner.req('POST', `/templates/${globalId}/archive`);
      const archived = await tools.run(c, 'draft_from_template', {
        templateId: globalId,
        project: OTHER,
        params: { team: 'ops', tone: 'short' },
      });
      expect(archived).toMatchObject({ ok: false, code: 'invalid' });
    });

    it('draft_automation with a template takes its prompt and settings (job fields refused)', async () => {
      const c = await caller(ownerId, 'owner');
      const clash = await tools.run(c, 'draft_automation', {
        project: PROJECT,
        name: 'Nightly',
        trigger: { kind: 'cron', cron: '0 2 * * *' },
        prompt: 'something else',
        template: { templateId, params: { url: 'https://n.example', tone: 'resmi' } },
      });
      expect(clash).toMatchObject({ ok: false, code: 'invalid' });
      const out = await tools.run(c, 'draft_automation', {
        project: PROJECT,
        name: 'Nightly',
        trigger: { kind: 'cron', cron: '0 2 * * *' },
        template: { templateId, params: { url: 'https://n.example', tone: 'resmi' } },
      });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok || out.draft === undefined) throw new Error('no draft');
      expect(out.draft.payload).toMatchObject({
        template: { id: templateId, version: 2 },
        input: { target: { kind: 'job', spec: { runtime: 'codex' } } },
      });
      await stepUp();
      const res = await owner.req('POST', `/chat/drafts/${out.draft.id}/confirm`);
      expect(res.statusCode, res.body).toBe(200);
      expect((await owner.req('GET', `/templates/${templateId}`)).json<Body>().stats.automations).toBe(2);
    });
  });
});
