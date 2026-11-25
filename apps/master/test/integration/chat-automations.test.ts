import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import type { Role } from '../../src/auth/users.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { PROJECT } from '../helpers/job-worker.js';

/**
 * p6-automations × ops chat (ADR-0018, ADR-0024): the assistant's automation tools run as the turn's user with the
 * console's authorization; writes are draft cards; confirming runs the same service with step-up, and a webhook
 * secret appears only in the confirmation's HTTP answer — never in the stored draft, the thread or the audit log.
 */

const PW = 'quartz-meadow-lantern-7';

describeIntegration('ops chat automation tools and drafts (integration)', { timeout: 180_000 }, () => {
  const h = new Harness();
  let owner: Client;
  let ownerSecret = '';
  let ownerId = '';
  let opId = '';
  let viewerId = '';
  let tools: ChatTools;
  let store: ChatStore;
  let jobs: JobStore;

  beforeAll(async () => {
    await h.start({ installers: { publicOrigin: 'https://console.example.test' } });
    ownerId = await h.createUser('owner1', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    await h.db.pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
      [PROJECT],
    );
    opId = await h.createUser('op.chat', PW, 'operator');
    await h.grant(opId, [PROJECT], 'operator');
    viewerId = await h.createUser('viewer.chat', PW, 'viewer');
    await h.grant(viewerId, [PROJECT], 'viewer');
    // The project has a registered repository, so job drafts are built for it.
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method, require_ci,
                                        ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', 'https://git.example.test/acme/app.git', 'main', 'merge', false, 3600, $2, now())
       ON CONFLICT (project) DO NOTHING`,
      [PROJECT, ownerId],
    );
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
    // Only what the automation tools touch is real; the other tool dependencies are never called here.
    tools = new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      automations: () => h.app.automations,
    } as unknown as ChatToolsDeps);
  });
  afterAll(async () => {
    await h.stop();
  });

  async function caller(userId: string, role: Role): Promise<ToolCaller> {
    const thread = await store.createThread(userId, 'automations');
    return {
      userId,
      subject: await loadSubject(h.db.pool, { id: userId, role }),
      threadId: thread.id,
      turnId: randomUUID(),
    };
  }

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    const res = await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function confirm(draftId: string) {
    await stepUp();
    return owner.req('POST', `/chat/drafts/${draftId}/confirm`);
  }

  const count = async () =>
    (await h.db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM automations')).rows[0]?.n ?? 0;

  it('drafts a cron automation (nothing is created until the user confirms with step-up)', async () => {
    const c = await caller(ownerId, 'owner');
    const before = await count();
    const out = await tools.run(c, 'draft_automation', {
      project: PROJECT,
      name: 'Nightly dependency check',
      trigger: { kind: 'cron', cron: '0 3 * * *' },
      prompt: 'Check for outdated dependencies and open a report.',
      runtime: 'codex',
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok || out.draft === undefined) throw new Error('no draft');
    expect(out.data).toMatchObject({ kind: 'automation', schedule: 'Every day at 03:00 UTC' });
    expect(await count()).toBe(before);
    expect(out.draft.payload).toMatchObject({
      action: 'create',
      input: {
        target: {
          kind: 'job',
          spec: { runtime: 'codex', sourceTrust: 'trusted', sandboxProfile: 'container' },
        },
      },
    });
    // Confirmation needs a fresh step-up.
    h.clock.advance(11 * 60_000);
    expect((await owner.req('POST', `/chat/drafts/${out.draft.id}/confirm`)).statusCode).toBe(403);
  });

  it('p17-embeddings: the identical card proposed again in the same conversation is the open one, not a second card', async () => {
    const c = await caller(ownerId, 'owner');
    const input = {
      project: PROJECT,
      name: 'Weekly licence check',
      trigger: { kind: 'cron', cron: '0 4 * * 1' },
      prompt: 'Check the licences of the dependencies.',
      runtime: 'codex',
    };
    const first = await tools.run(c, 'draft_automation', input);
    if (!first.ok || first.draft === undefined) throw new Error('no draft');
    const again = await tools.run(c, 'draft_automation', input);
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('refused');
    expect(again.draft).toBeUndefined();
    expect(again.data).toMatchObject({ draftId: first.draft.id });
    expect(JSON.stringify(again.data)).toContain('already proposed');
    const cards = async (thread: string) =>
      (
        await h.db.pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM chat_drafts WHERE thread_id = $1',
          [thread],
        )
      ).rows[0]?.n;
    expect(await cards(c.threadId)).toBe(1);
    // A different card, or the same one with execute, or another conversation: a card of its own.
    const other = await tools.run(c, 'draft_automation', { ...input, name: 'Weekly licence check (EU)' });
    expect(other.ok && other.draft !== undefined).toBe(true);
    const run = await tools.run(c, 'draft_automation', { ...input, execute: true });
    expect(run.ok && run.draft !== undefined).toBe(true);
    const elsewhere = await caller(ownerId, 'owner');
    const there = await tools.run(elsewhere, 'draft_automation', input);
    expect(there.ok && there.draft !== undefined).toBe(true);
  });

  it('refuses what the console refuses: viewers, operators with webhook triggers, invalid crons', async () => {
    const viewer = await caller(viewerId, 'viewer');
    const v = await tools.run(viewer, 'draft_automation', {
      project: PROJECT,
      name: 'x',
      trigger: { kind: 'cron', cron: '0 3 * * *' },
      workflowId: randomUUID(),
    });
    expect(v).toMatchObject({ ok: false, code: 'forbidden' });
    const op = await caller(opId, 'operator');
    const hook = await tools.run(op, 'draft_automation', {
      project: PROJECT,
      name: 'x',
      trigger: { kind: 'webhook' },
      workflowId: randomUUID(),
    });
    expect(hook).toMatchObject({ ok: false, code: 'forbidden' });
    const bad = await tools.run(await caller(ownerId, 'owner'), 'draft_automation', {
      project: PROJECT,
      name: 'x',
      trigger: { kind: 'cron', cron: '* * * * *' },
      workflowId: randomUUID(),
    });
    expect(bad).toMatchObject({ ok: false, code: 'invalid' });
    const strict = await tools.run(await caller(ownerId, 'owner'), 'draft_automation', { shell: 'rm -rf /' });
    expect(strict).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('confirming a webhook draft shows the secret once, and only in the HTTP answer', async () => {
    const c = await caller(ownerId, 'owner');
    const out = await tools.run(c, 'draft_automation', {
      project: PROJECT,
      name: 'Deploy hook',
      trigger: { kind: 'webhook' },
      prompt: 'Smoke-test the deployment named in the event.',
      runtime: 'codex',
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok || out.draft === undefined) throw new Error('no draft');
    const res = await confirm(out.draft.id);
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json<{ result: { automationId: string; webhook: { url: string; secret: string } } }>()
      .result;
    expect(result.webhook.url).toBe(`https://console.example.test/v1/hooks/${result.automationId}`);
    const secret = result.webhook.secret;
    expect(secret).toMatch(/^rwh_/);
    const stored = await h.db.pool.query<{ r: string }>(
      'SELECT result::text AS r FROM chat_drafts WHERE id = $1',
      [out.draft.id],
    );
    expect(stored.rows[0]?.r).toContain(result.automationId);
    expect(stored.rows[0]?.r).not.toContain(secret);
    const audit = await h.db.pool.query<{ m: string }>('SELECT metadata::text AS m FROM audit_events');
    expect(audit.rows.map((r) => r.m).join('\n')).not.toContain(secret);
    const messages = await store.messages(c.threadId);
    expect(JSON.stringify(messages)).toContain('confirmed draft');
    expect(JSON.stringify(messages)).not.toContain(secret);
    // Confirmed once: a second confirmation is refused.
    expect((await confirm(out.draft.id)).statusCode).toBe(409);
  });

  it('answers "what ran, what failed, why" and drafts pause / run now / changes', async () => {
    const c = await caller(ownerId, 'owner');
    const created = await tools.run(c, 'draft_automation', {
      project: PROJECT,
      name: 'Weekly report',
      trigger: { kind: 'cron', cron: '0 6 * * 1' },
      prompt: 'Summarise the week.',
      runtime: 'codex',
      concurrency: 'parallel',
    });
    if (!created.ok || created.draft === undefined) throw new Error(JSON.stringify(created));
    const id = (await confirm(created.draft.id)).json<{ result: { automationId: string } }>().result
      .automationId;

    const runNow = await tools.run(c, 'draft_automation_change', { automationId: id, action: 'run_now' });
    if (!runNow.ok || runNow.draft === undefined) throw new Error(JSON.stringify(runNow));
    const ran = await confirm(runNow.draft.id);
    expect(ran.statusCode, ran.body).toBe(200);
    const jobId = ran.json<{ result: { jobId: string; runState: string } }>().result.jobId;
    await jobs.transition(jobId, 'infeasible', {
      actor: { type: 'system', id: 'test' },
      reason: 'no worker fits',
    });
    await h.app.automations.tick();

    const described = await tools.run(c, 'describe_automation', { automationId: id });
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    const data = described.data as {
      automation: { name: string; stats: { failed: number }; triggerSummary: string };
      runs: { state: string; reason: string; jobId: string; jobState: string }[];
    };
    expect(data.automation).toMatchObject({
      name: 'Weekly report',
      triggerSummary: 'Every day at 06:00 UTC, on Monday',
    });
    expect(data.automation.stats.failed).toBe(1);
    expect(data.runs[0]).toMatchObject({ state: 'failed', jobId, jobState: 'FAILED' });
    expect(data.runs[0]?.reason).toContain('failed');

    const listed = await tools.run(c, 'list_automations', { project: PROJECT });
    expect(listed.ok && JSON.stringify(listed.data)).toContain('Weekly report');
    // A viewer may read; a non-member sees nothing.
    expect(
      (await tools.run(await caller(viewerId, 'viewer'), 'describe_automation', { automationId: id })).ok,
    ).toBe(true);
    const outsiderId = await h.createUser('outsider.chat', PW, 'operator');
    expect(
      await tools.run(await caller(outsiderId, 'operator'), 'describe_automation', { automationId: id }),
    ).toMatchObject({ ok: false, code: 'not_found' });

    const change = await tools.run(c, 'draft_automation', {
      automationId: id,
      trigger: { kind: 'cron', cron: '30 7 * * 1-5' },
    });
    if (!change.ok || change.draft === undefined) throw new Error(JSON.stringify(change));
    expect((await confirm(change.draft.id)).statusCode).toBe(200);
    const pause = await tools.run(c, 'draft_automation_change', { automationId: id, action: 'pause' });
    if (!pause.ok || pause.draft === undefined) throw new Error(JSON.stringify(pause));
    expect((await confirm(pause.draft.id)).json()).toMatchObject({ result: { state: 'paused' } });
    const detail = (await owner.req('GET', `/automations/${id}`)).json<{
      state: string;
      triggerSummary: string;
    }>();
    expect(detail).toMatchObject({
      state: 'paused',
      triggerSummary: 'Every day at 07:30 UTC, on Monday to Friday',
    });
    expect(
      await tools.run(c, 'draft_automation_change', { automationId: id, action: 'pause' }),
    ).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});
