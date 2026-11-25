import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '../../src/auth/users.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { signRemyralWebhook } from '../../src/automations/webhook-signature.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { WORKFLOW_PATTERNS } from '../../src/chat/workflow-guide.js';
import { createMasterApp } from '../../src/compose.js';
import { createPool, type Pool } from '../../src/db/pool.js';
import { DEFAULT_REQUEST_LIMITS, scaleRequestLimits } from '../../src/http/rate-policy.js';
import { describeIntegration, uniquePrefix } from '../helpers/env.js';
import { type Client, enroll, FAST_SCRYPT, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p16-workflow-quality (docs/design/p16-workflow-quality.md) against real Postgres: invalid drafts never become cards
 * (hidden `invalid` rows, the issues go back to the model), drafted workflows / automations take the project's
 * defaults and the user's time zone, `validate_workflow` and `workflow_guide` (every guide pattern validates),
 * trigger nodes start runs — activated by the card, re-synced on save, a schedule fires ONCE across two master
 * replicas, a webhook starts a run, archiving pauses — and the repository fallback chain of a run (run input →
 * workflow default → project repository → none: scratch steps; code steps refused).
 */

const PW = 'quartz-meadow-lantern-7';
const REPO = 'wq-repo';
const BARE = 'wq-bare';
const REPO_URL = 'https://git.example.test/acme/wq-repo.git';

type Out = {
  ok: boolean;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
  draft?: { id: string; state: string; kind: string; payload: Record<string, unknown> };
};

const ai = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'ai.step',
  role: 'executor',
  prompt: `do ${id}`,
  ...extra,
});
const v2 = (name: string, nodes: Record<string, unknown>[], edges: Record<string, unknown>[] = []) => ({
  schemaVersion: 2,
  name,
  nodes,
  edges,
});

describeIntegration(
  'workflow drafting quality (integration, p16-workflow-quality)',
  { timeout: 240_000 },
  () => {
    const h = new Harness();
    let appB: FastifyInstance;
    let poolB: Pool;
    let owner: Client;
    let ownerSecret = '';
    let ownerId = '';
    let op: Client;
    let opSecret = '';
    let opId = '';
    let tools: ChatTools;
    let store: ChatStore;

    beforeAll(async () => {
      await h.start({ orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } } });
      ownerId = await h.createUser('owner1', PW);
      ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      for (const p of [REPO, BARE]) {
        await h.db.pool.query(
          'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
          [p],
        );
      }
      await h.db.pool.query(
        `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method, require_ci,
                                        ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', $2, 'trunk', 'merge', false, 3600, $3, now())`,
        [REPO, REPO_URL, ownerId],
      );
      opId = await h.createUser('op.wq', PW, 'operator');
      await h.grant(opId, [REPO, BARE], 'operator');
      opSecret = (await enroll(h, 'op.wq', PW)).secret;
      op = await fullLogin(h, 'op.wq', PW, opSecret);
      store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      tools = new ChatTools({
        db: h.db.pool,
        store,
        clock: h.clock.now,
        workflows: () => h.app.workflows,
        automations: () => h.app.automations,
      } as unknown as ChatToolsDeps);
      // Replica B: the same database and Redis, its own pool and scheduler.
      poolB = createPool({ connectionString: h.db.url, max: 4, applicationName: 'remyral-test-wq-b' });
      appB = await createMasterApp({
        pool: poolB,
        redis: h.redis,
        box: h.box,
        logLevel: 'warn',
        trustProxyHops: 0,
        requestLimits: scaleRequestLimits(DEFAULT_REQUEST_LIMITS, 1000),
        bodyLimitBytes: 64 * 1024,
        clock: h.clock.now,
        passwordParams: FAST_SCRYPT,
        rateLimitPrefix: uniquePrefix(),
        rateLimits: { perIp: 10_000, perAccount: 10_000, windowMs: 60_000 },
        workers: { sweepIntervalMs: 0 },
        orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } },
        metricsTailIntervalMs: 0,
      });
      await appB.ready();
    });
    afterAll(async () => {
      await appB.close();
      await poolB.end();
      await h.stop();
    });

    async function caller(userId: string, role: Role, timeZone?: string): Promise<ToolCaller> {
      const thread = await store.createThread(userId, 'workflow quality');
      return {
        userId,
        subject: await loadSubject(h.db.pool, { id: userId, role }),
        threadId: thread.id,
        turnId: randomUUID(),
        ...(timeZone === undefined ? {} : { timeZone }),
      };
    }
    const run = async (
      c: ToolCaller,
      tool: Parameters<ChatTools['run']>[1],
      input: Record<string, unknown>,
    ) => (await tools.run(c, tool, input)) as unknown as Out;
    async function stepUp(c: Client, secret: string): Promise<void> {
      h.clock.advance(30_000);
      const res = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
      expect(res.statusCode, res.body).toBe(200);
    }
    const confirm = (c: Client, id: string) => c.req('POST', `/chat/drafts/${id}/confirm`);
    /** After a long clock jump the sessions are idle-expired: sign in again. */
    async function relogin(): Promise<void> {
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      op = await fullLogin(h, 'op.wq', PW, opSecret);
    }

    describe('invalid drafts are never cards', () => {
      it('draft_workflow: hidden, the issues (with fix hints) go back to the model, confirming is refused', async () => {
        const c = await caller(opId, 'operator');
        const out = await run(c, 'draft_workflow', {
          project: REPO,
          definition: v2('broken', [{ id: 'x', type: 'magic.wand', config: {} }]),
        });
        expect(out.ok).toBe(false);
        expect(out.code).toBe('invalid');
        expect(out.message).toContain('NO card was shown');
        expect(out.message).toContain('nodes.0.type');
        expect(out.message).toContain('workflow_node_catalog');
        expect(out.draft).toMatchObject({ state: 'invalid', kind: 'workflow' });
        expect(out.draft?.payload.valid).toBe(false);
        expect(await store.drafts(c.threadId)).toEqual([]);
        expect((await store.turnDrafts(c.turnId)).map((d) => d.state)).toEqual(['invalid']);
        const res = await confirm(op, out.draft?.id ?? '');
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json<{ error: string }>().error).toBe('draft_not_open');
      });

      it('every draft kind goes through the same path (tool refusals and input schema failures)', async () => {
        const c = await caller(opId, 'operator');
        const cron = await run(c, 'draft_automation', {
          project: REPO,
          name: 'too often',
          trigger: { kind: 'cron', cron: '* * * * *' },
          prompt: 'x',
          runtime: 'codex',
        });
        expect(cron).toMatchObject({
          ok: false,
          code: 'invalid',
          draft: { state: 'invalid', kind: 'automation' },
        });
        const schema = await run(c, 'draft_job', { project: REPO });
        expect(schema).toMatchObject({
          ok: false,
          code: 'invalid',
          draft: { state: 'invalid', kind: 'job' },
        });
        // A refusal that is not a validation problem stores nothing.
        const hidden = await run(c, 'draft_workflow', {
          project: 'nope-project',
          definition: v2('x', [{ id: 'a', type: 'trigger.manual' }]),
        });
        expect(hidden.ok).toBe(false);
        expect((await store.turnDrafts(c.turnId)).map((d) => d.kind).sort()).toEqual(['automation', 'job']);
        expect(await store.drafts(c.threadId)).toEqual([]);
      });
    });

    describe('defaults and time zones', () => {
      it('a workflow without defaults takes the project defaults; schedules get the user’s zone', async () => {
        const c = await caller(opId, 'operator', 'Europe/Istanbul');
        const out = await run(c, 'draft_workflow', {
          project: REPO,
          definition: v2(
            'hourly-reminder',
            [{ id: 'every_hour', type: 'trigger.schedule', config: { cron: '0 9 * * *' } }, ai('write')],
            [{ from: 'every_hour', to: 'write' }],
          ),
        });
        expect(out.ok, JSON.stringify(out)).toBe(true);
        const p = out.draft?.payload as {
          definition: { defaults: Record<string, unknown>; nodes: { config?: Record<string, unknown> }[] };
          projectDefaults: string[];
          activate: boolean;
          schedules: { timeZone: string; nextRuns: string[]; summary: string }[];
        };
        expect(p.definition.defaults).toMatchObject({
          sandboxProfile: 'container',
          approvalPolicy: 'ask-sensitive',
          sourceTrust: 'trusted',
          limits: { maxDurationSec: 3600 },
        });
        expect(typeof p.definition.defaults.runtime).toBe('string');
        expect(p.projectDefaults).toEqual(
          expect.arrayContaining(['runtime', 'sandboxProfile', 'approvalPolicy', 'limits', 'timezone']),
        );
        expect(p.definition.nodes[0]?.config?.timezone).toBe('Europe/Istanbul');
        expect(p.activate).toBe(true);
        // 09:00 Istanbul = 06:00 UTC; the clock is 2026-10-12T12:00Z.
        expect(p.schedules[0]).toMatchObject({ timeZone: 'Europe/Istanbul' });
        expect(p.schedules[0]?.nextRuns[0]).toBe('2026-10-13T06:00:00.000Z');
        expect(p.schedules[0]?.summary).toContain('Europe/Istanbul');
        // An unknown zone is an issue, never a card.
        const bad = await run(c, 'draft_workflow', {
          project: REPO,
          definition: v2('bad-zone', [
            { id: 's', type: 'trigger.schedule', config: { cron: '0 9 * * *', timezone: 'Mars/Olympus' } },
          ]),
        });
        expect(bad).toMatchObject({ ok: false, code: 'invalid' });
        expect(bad.message).toContain('unknown_timezone');
      });

      it('draft_automation: the user’s zone by default; the schedule runs on that wall clock', async () => {
        const c = await caller(opId, 'operator', 'Europe/Istanbul');
        const out = await run(c, 'draft_automation', {
          project: REPO,
          name: 'morning',
          trigger: { kind: 'cron', cron: '0 9 * * *' },
          prompt: 'say good morning',
          runtime: 'codex',
        });
        expect(out.ok, JSON.stringify(out)).toBe(true);
        expect(out.data).toMatchObject({ timeZone: 'Europe/Istanbul' });
        expect((out.data?.nextRuns as string[])[0]).toBe('2026-10-13T06:00:00.000Z');
        expect((out.draft?.payload.input as { trigger: unknown }).trigger).toEqual({
          kind: 'cron',
          cron: '0 9 * * *',
          timeZone: 'Europe/Istanbul',
        });
        const ok = await confirm(op, out.draft?.id ?? '');
        expect(ok.statusCode, ok.body).toBe(200);
        const id = ok.json<{ result: { automationId: string } }>().result.automationId;
        const row = await h.db.pool.query<{ time_zone: string; next_run_at: Date }>(
          'SELECT time_zone, next_run_at FROM automations WHERE id = $1',
          [id],
        );
        expect(row.rows[0]?.time_zone).toBe('Europe/Istanbul');
        expect(row.rows[0]?.next_run_at.toISOString()).toBe('2026-10-13T06:00:00.000Z');
        const view = await op.req('GET', `/automations/${id}`);
        expect(view.json<{ timeZone: string; triggerSummary: string }>()).toMatchObject({
          timeZone: 'Europe/Istanbul',
          triggerSummary: 'Every day at 09:00 Europe/Istanbul',
        });
      });

      it('the scheduler fires on the zone’s wall clock across a daylight-saving change', async () => {
        const c = await caller(opId, 'operator', 'Europe/Istanbul');
        const out = await run(c, 'draft_automation', {
          project: REPO,
          name: 'ny nightly',
          trigger: { kind: 'cron', cron: '30 2 * * *', timeZone: 'America/New_York' },
          prompt: 'tick',
          runtime: 'codex',
        });
        expect(out.ok, JSON.stringify(out)).toBe(true);
        const ok = await confirm(op, out.draft?.id ?? '');
        expect(ok.statusCode, ok.body).toBe(200);
        const id = ok.json<{ result: { automationId: string } }>().result.automationId;
        // Pretend it is due on 8 March 2026 (02:30 does not exist in New York: it runs at 03:00 EDT = 07:00Z).
        await h.db.pool.query("UPDATE automations SET next_run_at = '2026-03-08T07:00:00Z' WHERE id = $1", [
          id,
        ]);
        await h.app.automations.fireDue();
        const after = await h.db.pool.query<{ next_run_at: Date }>(
          'SELECT next_run_at FROM automations WHERE id = $1',
          [id],
        );
        // The next run is computed in the zone from now (2026-10-12): 02:30 EDT on the 13th = 06:30Z.
        expect(after.rows[0]?.next_run_at.toISOString()).toBe('2026-10-13T06:30:00.000Z');
        await stepUp(op, opSecret);
        await op.req('DELETE', `/automations/${id}`);
      });
    });

    describe('validate_workflow and workflow_guide', () => {
      it('validates without a card; every guide pattern is a valid document', async () => {
        const c = await caller(ownerId, 'owner', 'Europe/Istanbul');
        const guide = await run(c, 'workflow_guide', {});
        expect(guide.ok).toBe(true);
        expect(Object.keys(guide.data ?? {})).toEqual(
          expect.arrayContaining(['rules', 'triggers', 'patterns', 'commonErrors', 'repository']),
        );
        const triggers = await run(c, 'workflow_guide', { topic: 'triggers' });
        expect(triggers.data?.patterns).toBeUndefined();
        for (const p of WORKFLOW_PATTERNS) {
          const v = await run(c, 'validate_workflow', { project: REPO, definition: p.definition });
          expect(v.ok).toBe(true);
          expect(v.data?.valid, `${p.id}: ${JSON.stringify(v.data?.issues)}`).toBe(true);
        }
        const bad = await run(c, 'validate_workflow', {
          project: REPO,
          definition: v2('bad', [
            { id: 'h', type: 'http.request', config: { origin: 'http://169.254.169.254' } },
          ]),
        });
        expect(bad.ok).toBe(true);
        expect(bad.data?.valid).toBe(false);
        expect(JSON.stringify(bad.data?.issues)).toContain('nodes.0.config.origin');
        const unknown = await run(c, 'validate_workflow', {
          project: REPO,
          definition: v2('bad', [{ id: 'x', type: 'magic.wand', config: {} }]),
        });
        expect(JSON.stringify(unknown.data?.issues)).toContain('workflow_node_catalog');
        // dryRun on draft_workflow answers the same way.
        const dry = await run(c, 'draft_workflow', {
          project: REPO,
          definition: WORKFLOW_PATTERNS[0]?.definition,
          dryRun: true,
        });
        expect(dry.ok).toBe(true);
        expect(dry.data?.valid).toBe(true);
        expect(await store.turnDrafts(c.turnId)).toEqual([]);
        // The node catalog says what starts a run.
        const cat = await run(c, 'workflow_node_catalog', {});
        const types = cat.data?.types as { type: string; runnable: boolean; needsActivation?: boolean }[];
        expect(types.find((t) => t.type === 'trigger.schedule')).toMatchObject({
          runnable: true,
          needsActivation: true,
        });
        expect(types.find((t) => t.type === 'trigger.manual')).toMatchObject({ needsActivation: false });
      });
    });

    describe('trigger nodes start runs', () => {
      it('the card activates its schedule; it fires ONCE across two master replicas and starts a run', async () => {
        const c = await caller(opId, 'operator', 'Europe/Istanbul');
        const out = await run(c, 'draft_workflow', {
          project: REPO,
          definition: v2(
            'hourly-tick',
            [
              { id: 'every_hour', type: 'trigger.schedule', config: { cron: '0 * * * *' } },
              { id: 'start', type: 'trigger.manual' },
              { id: 'either', type: 'control.merge', config: { join: 'any' } },
              { id: 'note', type: 'data.set', config: { fields: { n: 1 } } },
            ],
            [
              { from: 'every_hour', to: 'either' },
              { from: 'start', to: 'either' },
              { from: 'either', to: 'note' },
            ],
          ),
        });
        expect(out.ok, JSON.stringify(out)).toBe(true);
        expect(JSON.stringify(out.data?.startsRuns)).toContain('activates');
        const ok = await confirm(op, out.draft?.id ?? '');
        expect(ok.statusCode, ok.body).toBe(200);
        const result = ok.json<{ result: { workflowId: string; triggers: { state: string } } }>().result;
        expect(result.triggers.state).toBe('active');
        const a = await h.db.pool.query<{ id: string; state: string; time_zone: string; next_run_at: Date }>(
          `SELECT a.id, a.state, a.time_zone, a.next_run_at FROM automations a
           JOIN workflow_trigger_bindings b ON b.automation_id = a.id
          WHERE b.project = $1 AND b.name = 'hourly-tick'`,
          [REPO],
        );
        expect(a.rows).toHaveLength(1);
        expect(a.rows[0]).toMatchObject({ state: 'active', time_zone: 'Europe/Istanbul' });
        const due = a.rows[0]?.next_run_at ?? new Date();
        h.clock.advance(due.getTime() - h.clock.now().getTime() + 1_000);
        await relogin();
        const fired = await Promise.all([h.app.automations.fireDue(), appB.automations.fireDue()]);
        expect(fired.reduce((x, y) => x + y, 0)).toBe(1);
        const runs = await h.db.pool.query('SELECT 1 FROM automation_runs WHERE automation_id = $1', [
          a.rows[0]?.id,
        ]);
        expect(runs.rowCount).toBe(1);
        await h.app.automations.startQueued();
        await appB.automations.startQueued();
        const wr = await h.db.pool.query<{ trigger_kind: string }>(
          "SELECT trigger_kind FROM workflow_runs WHERE project = $1 AND name = 'hourly-tick'",
          [REPO],
        );
        expect(wr.rows.map((r) => r.trigger_kind)).toEqual(['schedule']);
        const audit = await h.db.pool.query("SELECT 1 FROM audit_events WHERE action = 'workflow.activate'");
        expect(audit.rowCount).toBeGreaterThanOrEqual(1);

        // A new version saved over REST re-syncs the followed triggers (new cron applies at once)…
        const upd = await op.req('PUT', `/workflows/${result.workflowId}`, {
          definition: {
            ...(out.draft?.payload.definition as Record<string, unknown>),
            nodes: [
              {
                id: 'every_hour',
                type: 'trigger.schedule',
                config: { cron: '30 * * * *', timezone: 'Europe/Istanbul' },
              },
              { id: 'start', type: 'trigger.manual' },
              { id: 'either', type: 'control.merge', config: { join: 'any' } },
              { id: 'note', type: 'data.set', config: { fields: { n: 2 } } },
            ],
          },
          baseVersion: 1,
        });
        expect(upd.statusCode, upd.body).toBe(200);
        expect(upd.json<{ triggers: { state: string } }>().triggers.state).toBe('active');
        const cron = await h.db.pool.query<{ cron: string }>('SELECT cron FROM automations WHERE id = $1', [
          a.rows[0]?.id,
        ]);
        expect(cron.rows[0]?.cron).toBe('30 * * * *');
        // … and archiving pauses them.
        const arch = await op.req('POST', `/workflows/${result.workflowId}/archive`, {});
        expect(arch.statusCode, arch.body).toBe(200);
        const st = await h.db.pool.query<{ state: string }>('SELECT state FROM automations WHERE id = $1', [
          a.rows[0]?.id,
        ]);
        expect(st.rows[0]?.state).toBe('paused');
      });

      it('a REST save of a never-activated workflow with a schedule says it does not start runs', async () => {
        const res = await op.req('POST', '/workflows', {
          project: REPO,
          definition: {
            ...v2(
              'not-active',
              [
                { id: 's', type: 'trigger.schedule', config: { cron: '0 * * * *' } },
                { id: 'n', type: 'data.set', config: { fields: { a: 1 } } },
              ],
              [{ from: 's', to: 'n' }],
            ),
            defaults: { runtime: 'codex', sandboxProfile: 'container', limits: { maxDurationSec: 600 } },
          },
        });
        expect(res.statusCode, res.body).toBe(201);
        const t = res.json<{ triggers: { state: string; warning: string } }>().triggers;
        expect(t.state).toBe('inactive');
        expect(t.warning).toContain('do not start runs');
      });

      it('a webhook trigger: the card needs a project admin + fresh code; the secret is shown once; a call starts a run', async () => {
        const c = await caller(ownerId, 'owner');
        const out = await run(c, 'draft_workflow', {
          project: REPO,
          definition: v2(
            'on-hook',
            [
              { id: 'hook', type: 'trigger.webhook' },
              { id: 'note', type: 'data.set', config: { fields: { got: { $expr: '$trigger.body.x' } } } },
            ],
            [{ from: 'hook', to: 'note' }],
          ),
        });
        expect(out.ok, JSON.stringify(out)).toBe(true);
        expect(out.draft?.payload).toMatchObject({
          activate: true,
          activateExternal: true,
          needsStepUp: true,
        });
        expect(out.draft?.payload.privileged).toContain('automations.external');
        // An operator may not confirm it.
        const refused = await confirm(op, out.draft?.id ?? '');
        expect(refused.statusCode).toBeGreaterThanOrEqual(400);
        await stepUp(owner, ownerSecret);
        const ok = await confirm(owner, out.draft?.id ?? '');
        expect(ok.statusCode, ok.body).toBe(200);
        const body = ok.json<{
          result: { triggers: { state: string }; webhook?: { url: string; secret: string } };
        }>();
        expect(body.result.triggers.state).toBe('active');
        const secret = body.result.webhook?.secret ?? '';
        expect(body.result.webhook?.url).toContain('/v1/hooks/');
        expect(secret).toMatch(/^rwh_/);
        // Never stored on the draft.
        const stored = await h.db.pool.query<{ result: unknown }>(
          'SELECT result FROM chat_drafts WHERE id = $1',
          [out.draft?.id],
        );
        expect(JSON.stringify(stored.rows[0]?.result)).not.toContain(secret);
        const auto = await h.db.pool.query<{ id: string }>(
          `SELECT b.automation_id AS id FROM workflow_trigger_bindings b WHERE b.project = $1 AND b.name = 'on-hook'`,
          [REPO],
        );
        const hookId = auto.rows[0]?.id ?? '';
        const payload = JSON.stringify({ x: 42 });
        const ts = String(Math.floor(h.clock.now().getTime() / 1000));
        const fire = await h.app.inject({
          method: 'POST',
          url: `/v1/hooks/${hookId}`,
          headers: {
            'content-type': 'application/json',
            'x-remyral-timestamp': ts,
            'x-remyral-nonce': 'nonce-wq-000000000001',
            'x-remyral-signature': signRemyralWebhook(secret, ts, 'nonce-wq-000000000001', payload),
          },
          payload,
        });
        expect(fire.statusCode, fire.body).toBe(202);
        await h.app.automations.idle();
        await h.app.automations.startQueued();
        const runs = await h.db.pool.query(
          "SELECT 1 FROM workflow_runs WHERE project = $1 AND name = 'on-hook' AND trigger_kind = 'webhook'",
          [REPO],
        );
        expect(runs.rowCount).toBe(1);
      });
    });

    describe('repository is not mandatory', () => {
      const v1 = (name: string, nodes: Record<string, unknown>[], edges: Record<string, unknown>[] = []) => ({
        name,
        defaults: { runtime: 'codex', sandboxProfile: 'container', limits: { maxDurationSec: 600 } },
        nodes,
        edges,
      });
      const step = (id: string, extra: Record<string, unknown> = {}) => ({
        id,
        role: 'executor',
        prompt: `do ${id}`,
        ...extra,
      });
      async function define(project: string, d: Record<string, unknown>): Promise<string> {
        const res = await op.req('POST', '/workflows', { project, definition: d });
        expect(res.statusCode, res.body).toBe(201);
        return res.json<{ id: string }>().id;
      }
      async function specsOf(runId: string) {
        const { rows } = await h.db.pool.query<{ node_id: string; spec: Record<string, unknown> }>(
          `SELECT n.node_id, j.spec FROM workflow_nodes n JOIN jobs j ON j.id = n.job_id WHERE n.run_id = $1
          ORDER BY n.node_id`,
          [runId],
        );
        return rows;
      }

      it('run input → workflow default → the project’s registered repository', async () => {
        const id = await define(REPO, v1('fallback', [step('a')]));
        const r1 = await op.req('POST', `/workflows/${id}/runs`, { inputs: {} });
        expect(r1.statusCode, r1.body).toBe(201);
        const run1 = await h.db.pool.query<{ repository: { url: string; baseRef: string } }>(
          'SELECT repository FROM workflow_runs WHERE id = $1',
          [r1.json<{ runId: string }>().runId],
        );
        expect(run1.rows[0]?.repository).toEqual({ url: REPO_URL, baseRef: 'trunk' });
        const own = { url: 'https://git.example.test/acme/other.git', baseRef: 'dev' };
        const withDefault = await define(REPO, {
          ...v1('fallback-own', [step('a')]),
          defaults: {
            runtime: 'codex',
            sandboxProfile: 'container',
            limits: { maxDurationSec: 600 },
            repository: own,
          },
        });
        const r2 = await op.req('POST', `/workflows/${withDefault}/runs`, { inputs: {} });
        expect(r2.statusCode, r2.body).toBe(201);
        const given = { url: 'https://git.example.test/acme/given.git', baseRef: 'feature' };
        const r3 = await op.req('POST', `/workflows/${withDefault}/runs`, { inputs: {}, repository: given });
        expect(r3.statusCode, r3.body).toBe(201);
        const repos = await h.db.pool.query<{ id: string; repository: unknown }>(
          'SELECT id, repository FROM workflow_runs WHERE id = ANY($1)',
          [[r2.json<{ runId: string }>().runId, r3.json<{ runId: string }>().runId]],
        );
        const byId = new Map(repos.rows.map((r) => [r.id, r.repository]));
        expect(byId.get(r2.json<{ runId: string }>().runId)).toEqual(own);
        expect(byId.get(r3.json<{ runId: string }>().runId)).toEqual(given);
      });

      it('no repository anywhere: AI steps run in scratch folders; code steps are refused with a clear message', async () => {
        const id = await define(BARE, v1('repo-less', [step('write')]));
        const r = await op.req('POST', `/workflows/${id}/runs`, { inputs: {} });
        expect(r.statusCode, r.body).toBe(201);
        const runId = r.json<{ runId: string }>().runId;
        const specs = await specsOf(runId);
        expect(specs).toHaveLength(1);
        expect(specs[0]?.spec.repository).toBeUndefined();
        expect(specs[0]?.spec.workspace).toEqual({ egress: 'web', scratch: true });
        const integ = await define(
          BARE,
          v1(
            'needs-code',
            [step('a'), { id: 'merge', role: 'integrator', prompt: 'merge' }],
            [{ from: 'a', to: 'merge' }],
          ),
        );
        const refused = await op.req('POST', `/workflows/${integ}/runs`, { inputs: {} });
        expect(refused.statusCode).toBe(400);
        expect(refused.json<{ error: string; message: string }>()).toMatchObject({
          error: 'repository_required',
        });
        expect(refused.json<{ message: string }>().message).toContain('merge');
        const marked = await define(BARE, v1('marked', [step('code', { needsRepository: true })]));
        const refused2 = await op.req('POST', `/workflows/${marked}/runs`, { inputs: {} });
        expect(refused2.statusCode).toBe(400);
        expect(refused2.json<{ error: string }>().error).toBe('repository_required');
        // With a repository given at start, the same workflow runs on it.
        const given = await op.req('POST', `/workflows/${marked}/runs`, {
          inputs: {},
          repository: { url: 'https://git.example.test/acme/bare.git', baseRef: 'main' },
        });
        expect(given.statusCode, given.body).toBe(201);

        // The chat run card says where the code comes from, and refuses (hidden) what cannot run.
        const c = await caller(opId, 'operator');
        const card = await run(c, 'draft_workflow_run', { workflowId: id });
        expect(card.ok, JSON.stringify(card)).toBe(true);
        expect(card.draft?.payload.repository).toMatchObject({ source: 'none' });
        const no = await run(c, 'draft_workflow_run', { workflowId: marked });
        expect(no).toMatchObject({ ok: false, code: 'invalid', draft: { state: 'invalid' } });
        const repoCard = await run(c, 'draft_workflow_run', {
          workflowId: await define(REPO, v1('repo-card', [step('a')])),
        });
        expect(repoCard.draft?.payload.repository).toEqual({ source: 'project', url: REPO_URL });
      });
    });
  },
);
