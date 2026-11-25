import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import type { Role } from '../../src/auth/users.js';
import { ChatStore } from '../../src/chat/store.js';
import type { ChatTools, ToolCaller } from '../../src/chat/tools.js';
import type { WatchChecks } from '../../src/chat/watch-checks.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, Harness } from '../helpers/harness.js';

/**
 * p15-watch-autorun (docs/design/p15-watch-autorun.md) against a real master database: a Takip's `then` step
 * (`workflow_run`) runs by itself when the condition is met — for the user who created the watch, through the chat's
 * direct path (security policy `autonomy.chatDirect`, the step's code rule, the user's role re-checked), audited
 * `chat.direct_action` with `trigger: watch` — exactly once however many evaluations race; it stays a card when the
 * user asked to confirm first, when the policy keeps cards or wants a code, and nothing runs once the user lost the
 * permission. Plus the read-only `list_workflows` / `describe_workflow` tools with per-project visibility.
 */
const PW = 'saffron-harbor-quill-41';

const h = new Harness();
let store: ChatStore;
let tools: ChatTools;
let owner: Client;
let opId = '';
let viewerId = '';
let wfAlpha = '';
let wfBeta = '';

const engine = (): WatchChecks =>
  (h.app.chatWatches as unknown as { deps: { checks: WatchChecks } }).deps.checks;

async function caller(userId: string, role: Role, byUser = true): Promise<ToolCaller> {
  const thread = (await store.createThread(userId, 'takip')).id;
  return {
    userId,
    subject: await loadSubject(h.db.pool, { id: userId, role }),
    threadId: thread,
    turnId: randomUUID(),
    ...(byUser ? { turn: { byUser: true, proposeAware: () => Promise.resolve(true) } } : {}),
  };
}

async function insertJob(project: string): Promise<string> {
  const now = h.clock.now();
  const { rows } = await h.db.pool.query<{ id: string }>(
    `INSERT INTO jobs (project, spec, state, priority, version, lease_epoch, created_by_type, created_by_id,
                       created_at, updated_at, state_changed_at)
     VALUES ($1, $2, 'RUNNING', 0, 1, 0, 'user', 'test', $3, $3, $3) RETURNING id::text AS id`,
    [project, JSON.stringify({ runtime: 'codex', prompt: 'Prepare the report' }), now],
  );
  return rows[0]?.id ?? '';
}

const finish = async (jobId: string): Promise<void> => {
  await h.db.pool.query("UPDATE jobs SET state = 'SUCCEEDED', version = version + 1 WHERE id = $1", [jobId]);
};

const runsOf = async (workflowId: string): Promise<string[]> =>
  (
    await h.db.pool.query<{ id: string }>(
      'SELECT id::text AS id FROM workflow_runs WHERE definition_id = $1 ORDER BY created_at',
      [workflowId],
    )
  ).rows.map((r) => r.id);

const watchRow = async (id: string) =>
  (
    await h.db.pool.query<{
      state: string;
      end_reason: string | null;
      then_action: Record<string, unknown> | null;
    }>('SELECT state, end_reason, then_action FROM chat_watches WHERE id = $1', [id])
  ).rows[0];

const thenNotes = async (threadId: string) =>
  (await store.messages(threadId)).filter((m) => m.meta?.notice === 'chat-watch' && m.meta.event === 'then');

const drafts = async (threadId: string) =>
  (
    await h.db.pool.query<{ id: string; state: string; kind: string }>(
      'SELECT id::text AS id, state, kind FROM chat_drafts WHERE thread_id = $1 ORDER BY created_at',
      [threadId],
    )
  ).rows;

const directAudit = async (watchId: string) =>
  (
    await h.db.pool.query<{ actor_id: string; outcome: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, outcome, metadata FROM audit_events
        WHERE action = 'chat.direct_action' AND metadata->>'watchId' = $1 ORDER BY id`,
      [watchId],
    )
  ).rows;

interface Created {
  watchId: string;
  then: { action: string; mode: string; onMet: string };
}

function created(out: Awaited<ReturnType<ChatTools['run']>>): Created {
  expect(out.ok, JSON.stringify(out)).toBe(true);
  if (!out.ok) throw new Error('refused');
  return out.data as Created;
}

/** A watch on a running job of alpha whose `then` runs the workflow. */
async function watchThen(c: ToolCaller, workflowId: string, mode?: 'auto' | 'ask') {
  const jobId = await insertJob('alpha');
  const out = created(
    await tools.run(c, 'create_watch', {
      condition: { kind: 'job_state', jobId, states: ['succeeded'] },
      label: 'Rapor işi',
      then: {
        action: 'workflow_run',
        workflowId,
        inputs: { mesaj: 'Rapor hazır' },
        ...(mode === undefined ? {} : { mode }),
      },
    }),
  );
  return { jobId, out };
}

/** Fires the watch (the job succeeds) and waits until its `then` step was handled. */
async function fire(jobId: string, watchId: string, threadId: string): Promise<void> {
  await finish(jobId);
  await engine().evaluate(watchId, 'event');
  await engine().idle();
  await expect.poll(async () => (await thenNotes(threadId)).length, { timeout: 15_000 }).toBe(1);
}

async function defineWorkflow(project: string, name: string, description: string): Promise<string> {
  const res = await owner.req('POST', '/workflows', {
    project,
    definition: {
      name,
      description,
      inputs: { mesaj: { required: true, description: 'Gönderilecek metin' } },
      defaults: {
        runtime: 'codex',
        sandboxProfile: 'container',
        sourceTrust: 'trusted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
      },
      nodes: [{ id: 'send', role: 'executor', prompt: 'Send this message: {{inputs.mesaj}}' }],
      edges: [],
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

describeIntegration(
  'Takip then-steps run by themselves (integration, p15-watch-autorun)',
  { timeout: 300_000 },
  () => {
    beforeAll(async () => {
      await h.start({ securityPolicy: { preset: 'serbest' }, watchChecks: { dryWaitMs: 300 } });
      await h.createUser('owner.auto', PW);
      owner = (await enroll(h, 'owner.auto', PW)).client;
      opId = await h.createUser('op.auto', PW, 'operator');
      viewerId = await h.createUser('viewer.auto', PW, 'viewer');
      for (const p of ['alpha', 'beta', 'gamma'])
        await h.db.pool.query(
          "INSERT INTO projects (id, name, kind, created_at) VALUES ($1, $1, 'workspace', now()) ON CONFLICT (id) DO NOTHING",
          [p],
        );
      await h.grant(opId, ['alpha', 'gamma'], 'operator');
      await h.grant(viewerId, ['beta'], 'viewer');
      store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      // The master's own tools (the ones the watch engine prepares and runs `then` steps with).
      tools = (h.app.chat as unknown as { deps: { tools: ChatTools } }).deps.tools;
      wfAlpha = await defineWorkflow('alpha', 'whatsapp-mesaj-gonder', 'WhatsApp mesajı gönderir');
      wfBeta = await defineWorkflow('beta', 'rapor-hazirla', 'Haftalık raporu hazırlar');
      await engine().listen();
      for (let i = 0; i < 100 && !engine().listening; i++) await new Promise((r) => setTimeout(r, 100));
    });
    afterAll(async () => {
      await h.stop();
    });

    describe('then steps', () => {
      it('permissive policy: the user asked for it → runs once by itself, note with the run link, audited, bell', async () => {
        const c = await caller(opId, 'operator');
        const { jobId, out } = await watchThen(c, wfAlpha, 'auto');
        expect(out.then).toMatchObject({ action: 'workflow_run', mode: 'auto' });
        expect(out.then.onMet).toContain('runs by itself');
        expect((await watchRow(out.watchId))?.then_action).toMatchObject({ mode: 'auto' });
        expect(await runsOf(wfAlpha)).toHaveLength(0);

        await fire(jobId, out.watchId, c.threadId);
        // Racing evaluations and duplicate wake-ups after the fire change nothing.
        await Promise.all(Array.from({ length: 5 }, () => engine().evaluate(out.watchId, 'event')));
        engine().wakeSubject(`job:${jobId}`);
        await engine().idle();

        const runs = await runsOf(wfAlpha);
        expect(runs).toHaveLength(1);
        const note = (await thenNotes(c.threadId))[0];
        expect(note?.content).toContain('whatsapp-mesaj-gonder');
        expect(note?.meta).toMatchObject({ executed: true, link: `/jobs/workflows/${runs[0] ?? ''}` });
        const d = await drafts(c.threadId);
        expect(d).toEqual([expect.objectContaining({ kind: 'workflow_run', state: 'confirmed' })]);
        const audit = await directAudit(out.watchId);
        expect(audit).toEqual([expect.objectContaining({ actor_id: opId, outcome: 'success' })]);
        expect(audit[0]?.metadata).toMatchObject({
          trigger: 'watch',
          approvedBy: 'policy',
          kind: 'workflow_run',
          draftId: d[0]?.id,
        });
        const confirm = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
          "SELECT metadata FROM audit_events WHERE action = 'chat.draft.confirm' AND target = $1",
          [`chat-draft:${d[0]?.id ?? ''}`],
        );
        expect(confirm.rows[0]?.metadata).toMatchObject({ via: 'chat-direct' });
        const bell = await h.db.pool.query(
          "SELECT 1 FROM notifications WHERE recipient_id = $1 AND kind = 'chat.watch' AND dedupe_key = $2",
          [opId, `chat.watch:${out.watchId}:then`],
        );
        expect(bell.rowCount).toBe(1);
      });

      it('mode left out on a propose-aware user turn runs by itself; a turn no person started keeps a card', async () => {
        const c = await caller(opId, 'operator');
        const a = await watchThen(c, wfAlpha);
        expect(a.out.then.mode).toBe('auto');
        const sys = await caller(opId, 'operator', false);
        const b = await watchThen(sys, wfAlpha, 'auto');
        expect(b.out.then.mode).toBe('ask');
        expect(b.out.then.onMet).toContain('not started by the user');
        expect((await tools.run(c, 'cancel_watch', { watchId: a.out.watchId })).ok).toBe(true);
        expect((await tools.run(sys, 'cancel_watch', { watchId: b.out.watchId })).ok).toBe(true);
      });

      it('the user asked to confirm first → a card, nothing runs', async () => {
        const before = (await runsOf(wfAlpha)).length;
        const c = await caller(opId, 'operator');
        const { jobId, out } = await watchThen(c, wfAlpha, 'ask');
        expect(out.then).toMatchObject({ mode: 'ask' });
        expect(out.then.onMet).toContain('a card is prepared');
        await fire(jobId, out.watchId, c.threadId);
        expect(await runsOf(wfAlpha)).toHaveLength(before);
        expect(await drafts(c.threadId)).toEqual([expect.objectContaining({ state: 'proposed' })]);
        expect(await directAudit(out.watchId)).toEqual([]);
      });

      it('a policy that keeps cards → a card (audited as denied), nothing runs', async () => {
        await h.setSecurityPolicy({ preset: 'serbest', autonomy: { chatDirect: false } });
        try {
          const before = (await runsOf(wfAlpha)).length;
          const c = await caller(opId, 'operator');
          const { jobId, out } = await watchThen(c, wfAlpha, 'auto');
          expect(out.then.mode).toBe('auto');
          expect(out.then.onMet).toContain('keeps confirmation cards');
          await fire(jobId, out.watchId, c.threadId);
          expect(await runsOf(wfAlpha)).toHaveLength(before);
          expect(await drafts(c.threadId)).toEqual([expect.objectContaining({ state: 'proposed' })]);
          expect((await thenNotes(c.threadId))[0]?.content).toContain('security policy');
          const audit = await directAudit(out.watchId);
          expect(audit.map((a) => [a.outcome, a.metadata.reason, a.metadata.trigger])).toEqual([
            ['denied', 'cards_required', 'watch'],
          ]);
        } finally {
          await h.setSecurityPolicy({ preset: 'serbest' });
        }
      });

      it('a policy that wants an authenticator code for the step → a card that asks for it, nothing runs', async () => {
        await h.setSecurityPolicy({ preset: 'serbest', events: { 'chat.cards': true } });
        try {
          const before = (await runsOf(wfAlpha)).length;
          const c = await caller(opId, 'operator');
          const { jobId, out } = await watchThen(c, wfAlpha, 'auto');
          expect(out.then.onMet).toContain('authenticator code');
          await fire(jobId, out.watchId, c.threadId);
          expect(await runsOf(wfAlpha)).toHaveLength(before);
          expect(await drafts(c.threadId)).toEqual([expect.objectContaining({ state: 'proposed' })]);
          expect((await thenNotes(c.threadId))[0]?.content).toContain('authenticator code');
          const audit = await directAudit(out.watchId);
          expect(audit.map((a) => [a.outcome, a.metadata.reason, a.metadata.trigger])).toEqual([
            ['denied', 'needs_code', 'watch'],
          ]);
        } finally {
          await h.setSecurityPolicy({ preset: 'serbest' });
        }
      });

      it('permission lost before the condition is met → nothing runs, the note says why', async () => {
        const wfGamma = await defineWorkflow('gamma', 'gamma-akisi', 'Gamma');
        const c = await caller(opId, 'operator');
        const { jobId, out } = await watchThen(c, wfGamma, 'auto');
        // The operator becomes a viewer of gamma: reading stays, running is gone.
        await h.grant(opId, ['gamma'], 'viewer');
        await fire(jobId, out.watchId, c.threadId);
        expect(await runsOf(wfGamma)).toHaveLength(0);
        expect(await drafts(c.threadId)).toEqual([]);
        expect((await thenNotes(c.threadId))[0]?.content).toContain('could not be prepared');
        expect(await directAudit(out.watchId)).toEqual([]);
        await h.grant(opId, ['gamma'], 'operator');
      });

      it('create_watch refuses a then step on a workflow the user cannot see', async () => {
        const c = await caller(opId, 'operator');
        const jobId = await insertJob('alpha');
        expect(
          await tools.run(c, 'create_watch', {
            condition: { kind: 'job_state', jobId, states: ['succeeded'] },
            then: { action: 'workflow_run', workflowId: wfBeta, mode: 'auto' },
          }),
        ).toMatchObject({ ok: false, code: 'not_found' });
      });
    });

    describe('list_workflows / describe_workflow', () => {
      type Listed = {
        workflows: {
          id: string;
          name: string;
          project: string;
          inputs: { name: string; required: boolean }[];
        }[];
        total: number;
        nextOffset: number | null;
      };
      const listed = (out: Awaited<ReturnType<ChatTools['run']>>): Listed => {
        expect(out.ok, JSON.stringify(out)).toBe(true);
        return (out as { data: Listed }).data;
      };

      it('finds a workflow by words of its name, only in readable projects, with paging', async () => {
        const op = await caller(opId, 'operator');
        const all = listed(await tools.run(op, 'list_workflows', {}));
        expect(all.workflows.map((w) => w.project).sort()).toEqual(['alpha', 'gamma']);
        const hit = listed(await tools.run(op, 'list_workflows', { query: 'whatsapp mesaj' }));
        expect(hit.workflows).toEqual([
          expect.objectContaining({
            id: wfAlpha,
            name: 'whatsapp-mesaj-gonder',
            project: 'alpha',
            inputs: [{ name: 'mesaj', required: true }],
          }),
        ]);
        expect(listed(await tools.run(op, 'list_workflows', { query: 'rapor' })).workflows).toEqual([]);
        expect(await tools.run(op, 'list_workflows', { project: 'beta' })).toMatchObject({
          ok: false,
          code: 'not_found',
        });
        const page = listed(await tools.run(op, 'list_workflows', { limit: 1 }));
        expect(page).toMatchObject({ total: 2, nextOffset: 1 });
        expect(page.workflows).toHaveLength(1);
        const next = listed(await tools.run(op, 'list_workflows', { limit: 1, offset: 1 }));
        expect(next.nextOffset).toBeNull();
        expect(next.workflows[0]?.id).not.toBe(page.workflows[0]?.id);

        const viewer = await caller(viewerId, 'viewer');
        const v = listed(await tools.run(viewer, 'list_workflows', { query: 'rapor' }));
        expect(v.workflows.map((w) => w.id)).toEqual([wfBeta]);
      });

      it('describes inputs, steps, versions and recent runs; invisible is not found', async () => {
        const op = await caller(opId, 'operator');
        const out = await tools.run(op, 'describe_workflow', {
          project: 'alpha',
          name: 'whatsapp-mesaj-gonder',
        });
        expect(out.ok, JSON.stringify(out)).toBe(true);
        const data = (out as { data: Record<string, unknown> }).data as {
          workflow: Record<string, unknown>;
          versions: unknown[];
          recentRuns: { link: string }[];
        };
        expect(data.workflow).toMatchObject({
          id: wfAlpha,
          latestVersion: 1,
          canRun: true,
          inputs: [{ name: 'mesaj', required: true, description: 'Gönderilecek metin' }],
          schemaVersion: 1,
          nodes: 1,
          types: { 'ai.step': 1 },
          approvalGates: [],
          integrations: [],
          steps: [{ id: 'send', type: 'ai.step', role: 'executor' }],
        });
        expect(JSON.stringify(data)).not.toContain('Send this message');
        expect(data.versions).toHaveLength(1);
        expect(data.recentRuns.length).toBeGreaterThan(0);
        expect(data.recentRuns[0]?.link).toMatch(/^\/jobs\/workflows\//);
        expect(await tools.run(op, 'describe_workflow', { workflowId: wfBeta })).toMatchObject({
          ok: false,
          code: 'not_found',
        });
        expect(await tools.run(op, 'describe_workflow', { project: 'alpha' })).toMatchObject({
          ok: false,
          code: 'invalid',
        });
        const viewer = await caller(viewerId, 'viewer');
        expect(await tools.run(viewer, 'describe_workflow', { workflowId: wfBeta })).toMatchObject({
          ok: true,
          data: { workflow: { canRun: false } },
        });
      });
    });
  },
);
