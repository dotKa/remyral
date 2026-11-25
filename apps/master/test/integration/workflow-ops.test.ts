import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { signRemyralWebhook } from '../../src/automations/webhook-signature.js';
import { JobStore } from '../../src/jobs/store.js';
import { WorkflowService } from '../../src/workflows/engine.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p14-workflow-engine 14.4 (design §20): workflow operations on engine 2 — real Postgres, the real notification
 * service, a fake clock. Pause / resume (timers keep their instants, timeouts shift, nothing new starts, state survives
 * a restart), re-run from a node (upstream side effects never repeat, dry-run plan, refusals, latest version),
 * concurrency (queue / skip / cancelOldest, keys, racing starts), run timeout without paused time, error workflows and
 * failure-streak alerts, retention pruning (never open runs), respond to a held webhook, metrics.
 */

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'wfo-alpha';
const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://git.example.test/acme/wfo.git', baseRef: 'main' },
};
type Node = Record<string, unknown>;
const n = (id: string, type: string, config: Record<string, unknown> = {}, extra: Node = {}): Node => ({
  id,
  type,
  config,
  ...extra,
});
const ex = (s: string) => ({ $expr: s });

interface View {
  run: {
    id: string;
    state: string;
    reason: string | null;
    engineState?: string;
    queuePosition?: number | null;
    pausedBy?: string | null;
    rerunOf?: string | null;
    rerunFromNode?: string | null;
    errorOf?: string | null;
    triggerKind?: string | null;
    sourceTrust?: string | null;
    dataPrunedAt?: string | null;
    concurrencyKey?: string | null;
  };
  nodes: { id: string; nodeRunState: string; copiedFrom: string | null; dueAt: string | null }[];
}
interface NodeRun {
  node: string;
  state: string;
  copiedFrom: string | null;
  output: { ports?: Record<string, unknown>; $pruned?: boolean } | null;
}
interface Plan {
  fromNode: string | null;
  version: number;
  copied: string[];
  fresh: string[];
  sideEffects: string[];
  aiSteps: string[];
}

describeIntegration('workflow engine 2 — operations (integration, p14 14.4)', { timeout: 300_000 }, () => {
  const h = new Harness();
  let owner: Client;
  let ownerId: string;
  let secret: string;
  let viewer: Client;
  let viewerSecret: string;

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } } });
    ownerId = await h.createUser('owner1', PW);
    secret = (await enroll(h, 'owner1', PW)).secret;
    const vid = await h.createUser('viewer1', PW, 'viewer');
    await h.grant(vid, [PROJECT], 'viewer');
    viewerSecret = (await enroll(h, 'viewer1', PW)).secret;
  });
  afterAll(async () => {
    await h.stop();
  });
  beforeEach(async () => {
    owner = await fullLogin(h, 'owner1', PW, secret);
    viewer = await fullLogin(h, 'viewer1', PW, viewerSecret);
  });

  const doc = (name: string, nodes: Node[], edges: Node[], extra: Node = {}) => ({
    schemaVersion: 2,
    name,
    defaults: DEFAULTS,
    nodes,
    edges,
    ...extra,
  });
  async function define(d: Record<string, unknown>): Promise<string> {
    const res = await owner.req('POST', '/workflows', { project: PROJECT, definition: d });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }
  async function update(id: string, d: Record<string, unknown>, baseVersion: number): Promise<string> {
    const res = await owner.req('PUT', `/workflows/${id}`, { definition: d, baseVersion });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ id: string }>().id;
  }
  async function start(id: string, inputs: Record<string, string> = {}): Promise<string> {
    const res = await owner.req('POST', `/workflows/${id}/runs`, { inputs });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ runId: string }>().runId;
  }
  async function view(runId: string): Promise<View> {
    const res = await owner.req('GET', `/workflows/runs/${runId}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<View>();
  }
  async function nodeRuns(runId: string, node?: string): Promise<NodeRun[]> {
    const res = await owner.req(
      'GET',
      `/workflows/runs/${runId}/node-runs?limit=100${node === undefined ? '' : `&node=${node}`}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ nodeRuns: NodeRun[] }>().nodeRuns;
  }
  const progress = async (times = 3) => {
    for (let i = 0; i < times; i++) await h.app.workflows.progress();
  };
  const states = async (runId: string) =>
    Object.fromEntries((await view(runId)).nodes.map((x) => [x.id, x.nodeRunState]));
  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    const res = await owner.req('POST', '/auth/step-up', { code: h.code(secret) });
    expect(res.statusCode, res.body).toBe(200);
  }
  const restarted = () =>
    new WorkflowService({
      pool: h.db.pool,
      jobs: new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      }),
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
      log: h.app.log,
      cancel: () => ({ sendCancel: () => Promise.resolve(true) }),
      engine: { v2: true },
    });

  describe('pause / resume', () => {
    it('nothing starts while paused, timers fire on resume, timeouts shift, state survives a restart', async () => {
      const id = await define(
        doc(
          'pausy',
          [
            n('start', 'trigger.manual'),
            n('nap', 'control.delay', { duration: 60 }),
            n('ask', 'control.approval', { title: 'ok?', approverRole: 'admin', timeoutSec: 100 }),
            n('after', 'data.set', { fields: { done: true } }),
          ],
          [
            { from: 'start', to: 'nap' },
            { from: 'start', to: 'ask' },
            { from: 'nap', to: 'after' },
          ],
        ),
      );
      const runId = await start(id);
      await progress();
      expect(await states(runId)).toMatchObject({ nap: 'waiting', ask: 'waiting', after: 'pending' });
      const askDue = Date.parse((await view(runId)).nodes.find((x) => x.id === 'ask')?.dueAt ?? '');
      // A viewer cannot pause.
      expect((await viewer.req('POST', `/workflows/runs/${runId}/pause`, {})).statusCode).toBe(403);
      const p = await owner.req('POST', `/workflows/runs/${runId}/pause`, { reason: 'maintenance' });
      expect(p.statusCode, p.body).toBe(200);
      expect((await view(runId)).run).toMatchObject({ state: 'paused', engineState: 'paused' });
      const again = await owner.req('POST', `/workflows/runs/${runId}/pause`, {});
      expect(again.statusCode).toBe(409);
      expect(again.json<{ error: string }>().error).toBe('run_not_active');
      // While paused the delay comes due and the approval's own timeout passes: nothing moves.
      h.clock.advance(200_000);
      await progress();
      const svc = restarted();
      try {
        await svc.progress();
      } finally {
        await svc.close();
      }
      expect(await states(runId)).toMatchObject({ nap: 'waiting', ask: 'waiting', after: 'pending' });
      expect((await view(runId)).run.engineState).toBe('paused');
      const r = await owner.req('POST', `/workflows/runs/${runId}/resume`, {});
      expect(r.statusCode, r.body).toBe(200);
      await progress();
      // The timer fired on resume; the approval's timeout moved by the paused time (still waiting).
      expect(await states(runId)).toMatchObject({ nap: 'succeeded', after: 'succeeded', ask: 'waiting' });
      const shifted = Date.parse((await view(runId)).nodes.find((x) => x.id === 'ask')?.dueAt ?? '');
      expect(shifted - askDue).toBeGreaterThanOrEqual(200_000);
      expect((await owner.req('POST', `/workflows/runs/${runId}/resume`, {})).statusCode).toBe(409);
      const audit = await h.db.pool.query<{ action: string }>(
        "SELECT action FROM audit_events WHERE target = $1 AND outcome = 'success' AND action IN ('workflow.run.pause', 'workflow.run.resume')",
        [`workflow-run:${runId}`],
      );
      expect(audit.rows.map((x) => x.action).sort()).toEqual(['workflow.run.pause', 'workflow.run.resume']);
    });

    it('the run timeout excludes paused time', async () => {
      const id = await define(
        doc(
          'slowpoke',
          [n('start', 'trigger.manual'), n('nap', 'control.delay', { duration: 3000 })],
          [{ from: 'start', to: 'nap' }],
          { settings: { timeoutSec: 120 } },
        ),
      );
      const runId = await start(id);
      await progress();
      expect((await owner.req('POST', `/workflows/runs/${runId}/pause`, {})).statusCode).toBe(200);
      h.clock.advance(600_000);
      expect((await owner.req('POST', `/workflows/runs/${runId}/resume`, {})).statusCode).toBe(200);
      await progress();
      expect((await view(runId)).run.engineState).toBe('active');
      h.clock.advance(130_000);
      await progress();
      const v = await view(runId);
      expect(v.run.state).toBe('failed');
      expect(v.run.reason).toContain('timed out');
    });
  });

  describe('re-run from a node', () => {
    it('takes upstream results over (no side effect repeats), plans, refuses, re-runs with the latest version', async () => {
      const v1 = doc(
        'retry-me',
        [
          n('start', 'trigger.manual'),
          n('ping', 'notify.users', { recipients: { creator: true }, title: 'hello' }),
          n('seed', 'data.set', { fields: { x: 1 } }),
          n('boom', 'data.transform', { expression: ex('$error("broken")') }),
          n('after', 'data.set', { fields: { y: 2 } }),
        ],
        [
          { from: 'start', to: 'ping' },
          { from: 'ping', to: 'seed' },
          { from: 'seed', to: 'boom' },
          { from: 'boom', to: 'after' },
        ],
      );
      const id = await define(v1);
      const src = await start(id);
      await progress();
      expect((await view(src)).run.state).toBe('failed');
      const pings = async () =>
        (
          await h.db.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM notifications WHERE kind = 'workflow.notify' AND title = 'hello'",
          )
        ).rows[0]?.n ?? 0;
      expect(await pings()).toBe(1);
      // Refusals: a node downstream of the failure; an unknown node; an open run.
      const late = await owner.req('POST', `/workflows/runs/${src}/rerun`, {
        fromNode: 'after',
        dryRun: true,
      });
      expect(late.statusCode).toBe(409);
      expect(late.json<{ error: string }>().error).toBe('rerun_upstream_incomplete');
      const unknown = await owner.req('POST', `/workflows/runs/${src}/rerun`, {
        fromNode: 'nope',
        dryRun: true,
      });
      expect(unknown.json<{ error: string }>().error).toBe('rerun_node_unknown');
      // The plan of a full re-run lists the notification as a side effect that happens again.
      const full = await owner.req('POST', `/workflows/runs/${src}/rerun`, { dryRun: true });
      expect(full.statusCode, full.body).toBe(200);
      expect(full.json<{ plan: Plan }>().plan.sideEffects).toEqual(['ping']);
      // Fix the workflow (boom becomes a data node) and re-run from boom with the latest version.
      const v2doc = {
        ...v1,
        nodes: v1.nodes.map((x) =>
          x.id === 'boom' ? n('boom', 'data.set', { fields: { fixed: ex('$input.x + 1') } }) : x,
        ),
      };
      await update(id, v2doc, 1);
      const dry = await owner.req('POST', `/workflows/runs/${src}/rerun`, {
        fromNode: 'boom',
        latestVersion: true,
        dryRun: true,
      });
      expect(dry.statusCode, dry.body).toBe(200);
      const plan = dry.json<{ plan: Plan }>().plan;
      expect(plan).toMatchObject({ fromNode: 'boom', version: 2, sideEffects: [], aiSteps: [] });
      expect([...plan.copied].sort()).toEqual(['ping', 'seed', 'start']);
      expect([...plan.fresh].sort()).toEqual(['after', 'boom']);
      const go = await owner.req('POST', `/workflows/runs/${src}/rerun`, {
        fromNode: 'boom',
        latestVersion: true,
      });
      expect(go.statusCode, go.body).toBe(201);
      const rerun = go.json<{ runId: string }>().runId;
      await progress();
      const v = await view(rerun);
      expect(v.run).toMatchObject({
        state: 'succeeded',
        rerunOf: src,
        rerunFromNode: 'boom',
        triggerKind: 'rerun',
      });
      expect(v.nodes.find((x) => x.id === 'ping')?.copiedFrom).not.toBeNull();
      expect(v.nodes.find((x) => x.id === 'boom')?.copiedFrom).toBeNull();
      // The fixed node used the taken-over upstream value; the notification was not sent again.
      expect((await nodeRuns(rerun, 'boom')).at(-1)?.output?.ports?.out).toEqual({ fixed: 2 });
      expect(await pings()).toBe(1);
      const effects = await h.db.pool.query(
        `SELECT 1 FROM workflow_side_effects s JOIN workflow_node_runs nr ON nr.id = s.node_run_id
          WHERE nr.run_id = $1`,
        [rerun],
      );
      expect(effects.rowCount).toBe(0);
      // Re-running twice from the same node never touches the upstream effect either.
      const twice = await owner.req('POST', `/workflows/runs/${rerun}/rerun`, { fromNode: 'boom' });
      expect(twice.statusCode, twice.body).toBe(201);
      await progress();
      expect(await pings()).toBe(1);
      // A running run cannot be re-run.
      const openId = await define(
        doc(
          'open-one',
          [n('start', 'trigger.manual'), n('nap', 'control.delay', { duration: 600 })],
          [{ from: 'start', to: 'nap' }],
        ),
      );
      const open = await start(openId);
      await progress();
      const notDone = await owner.req('POST', `/workflows/runs/${open}/rerun`, { dryRun: true });
      expect(notDone.json<{ error: string }>().error).toBe('run_not_finished');
      expect((await owner.req('POST', `/workflows/runs/${open}/cancel`, { reason: 'done' })).statusCode).toBe(
        200,
      );
    });
  });

  describe('concurrency', () => {
    const slow = (name: string, settings: Record<string, unknown>) =>
      doc(
        name,
        [n('start', 'trigger.manual'), n('nap', 'control.delay', { duration: 60 })],
        [{ from: 'start', to: 'nap' }],
        { inputs: { customer: { required: false } }, settings },
      );

    it('queue: one at a time in order; the next starts when a slot frees', async () => {
      const id = await define(slow('one-at-a-time', { concurrency: { max: 1, onLimit: 'queue' } }));
      // Queue order is by start time (the fake clock moves 1 ms between starts, as real time does).
      const a = await start(id);
      h.clock.advance(1);
      const b = await start(id);
      h.clock.advance(1);
      const c = await start(id);
      expect((await view(a)).run.engineState).toBe('active');
      expect((await view(b)).run).toMatchObject({
        engineState: 'queued',
        queuePosition: 1,
        state: 'starting',
      });
      expect((await view(c)).run.queuePosition).toBe(2);
      h.clock.advance(61_000);
      await progress();
      expect((await view(a)).run.state).toBe('succeeded');
      expect((await view(b)).run.engineState).toBe('active');
      expect((await view(c)).run.queuePosition).toBe(1);
      // A queued run can be cancelled.
      expect((await owner.req('POST', `/workflows/runs/${c}/cancel`, { reason: 'no' })).statusCode).toBe(200);
      h.clock.advance(61_000);
      await progress();
      expect((await view(b)).run.state).toBe('succeeded');
    });

    it('skip and cancelOldest; keys make separate groups; racing starts never over-admit', async () => {
      const skip = await define(slow('skipper', { concurrency: { max: 1, onLimit: 'skip' } }));
      await start(skip);
      const skipped = await start(skip);
      const sv = await view(skipped);
      expect(sv.run.state).toBe('cancelled');
      expect(sv.run.reason).toContain('concurrency_skipped');

      const newest = await define(slow('newest-wins', { concurrency: { max: 1, onLimit: 'cancelOldest' } }));
      const old = await start(newest);
      const fresh = await start(newest);
      expect((await view(old)).run.state).toBe('cancelled');
      expect((await view(old)).run.reason).toContain('concurrency_replaced');
      expect((await view(fresh)).run.engineState).toBe('active');

      const keyed = await define(
        slow('per-customer', { concurrency: { max: 1, onLimit: 'queue', key: ex('$inputs.customer') } }),
      );
      const k1 = await start(keyed, { customer: 'acme' });
      const k2 = await start(keyed, { customer: 'globex' });
      const k3 = await start(keyed, { customer: 'acme' });
      expect((await view(k1)).run).toMatchObject({ engineState: 'active', concurrencyKey: 'acme' });
      expect((await view(k2)).run.engineState).toBe('active');
      expect((await view(k3)).run.engineState).toBe('queued');

      const race = await define(slow('racers', { concurrency: { max: 2, onLimit: 'queue' } }));
      const ids = await Promise.all([1, 2, 3, 4, 5].map(() => start(race)));
      const engine = await Promise.all(ids.map(async (x) => (await view(x)).run.engineState));
      expect(engine.filter((s) => s === 'active')).toHaveLength(2);
      expect(engine.filter((s) => s === 'queued')).toHaveLength(3);
      // Two masters promoting at once still admit only the free slots.
      h.clock.advance(61_000);
      const other = restarted();
      try {
        await Promise.all([h.app.workflows.progress(), other.progress()]);
      } finally {
        await other.close();
      }
      const open = await h.db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM workflow_runs WHERE name = 'racers' AND state IN ('active', 'paused')",
      );
      expect(open.rows[0]?.n).toBeLessThanOrEqual(2);
    });
  });

  describe('error workflow and alerts', () => {
    it('a failed run starts its error workflow once with the failure as untrusted data; N failures in a row notify', async () => {
      const handlerId = await define(
        doc(
          'on-fail',
          [n('err', 'trigger.error'), n('note', 'data.set', { fields: { failed: ex('$trigger.run.id') } })],
          [{ from: 'err', to: 'note' }],
        ),
      );
      // A workflow cannot be its own error workflow.
      const self = await owner.req('POST', '/workflows', {
        project: PROJECT,
        definition: doc('selfish', [n('start', 'trigger.manual')], [], {
          settings: { onFailure: { workflow: 'selfish' } },
        }),
      });
      expect(self.statusCode).toBe(400);
      expect(self.body).toContain('on_failure_self');
      const flaky = await define(
        doc(
          'flaky',
          [n('start', 'trigger.manual'), n('boom', 'control.fail', { reason: 'nope' })],
          [{ from: 'start', to: 'boom' }],
          { settings: { onFailure: { workflow: 'on-fail' }, alerts: { failuresInARow: 2 } } },
        ),
      );
      const r1 = await start(flaky);
      await progress();
      const errRuns = await h.db.pool.query<{ id: string }>(
        'SELECT id FROM workflow_runs WHERE error_of = $1',
        [r1],
      );
      expect(errRuns.rowCount).toBe(1);
      const errRun = errRuns.rows[0]?.id ?? '';
      await progress();
      const ev = await view(errRun);
      expect(ev.run).toMatchObject({
        errorOf: r1,
        triggerKind: 'error',
        sourceTrust: 'untrusted',
        state: 'succeeded',
      });
      expect((await nodeRuns(errRun, 'note')).at(-1)?.output?.ports?.out).toEqual({ failed: r1 });
      // Exactly once, even when the follow-up step runs again on another master.
      const other = restarted();
      try {
        await other.v2.followups();
      } finally {
        await other.close();
      }
      expect((await h.db.pool.query('SELECT 1 FROM workflow_runs WHERE error_of = $1', [r1])).rowCount).toBe(
        1,
      );
      const alerts = async () =>
        (
          await h.db.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM notifications WHERE kind = 'workflow.failed' AND recipient_id = $1",
            [ownerId],
          )
        ).rows[0]?.n ?? 0;
      expect(await alerts()).toBe(0);
      await start(flaky);
      await progress();
      expect(await alerts()).toBe(1);
      // The streak goes on: no second alert for the same streak.
      await start(flaky);
      await progress();
      expect(await alerts()).toBe(1);
      expect(handlerId).not.toBe('');
      // The error runs do not chain (the handler has no error workflow, and error runs never start one).
      const chains = await h.db.pool.query(
        "SELECT 1 FROM workflow_runs WHERE error_of IN (SELECT id FROM workflow_runs WHERE trigger_kind = 'error')",
      );
      expect(chains.rowCount).toBe(0);
    });
  });

  describe('retention', () => {
    it('prunes finished runs after their retention, never open ones; a pruned run cannot be re-run', async () => {
      const id = await define(
        doc(
          'short-memory',
          [n('start', 'trigger.manual'), n('seed', 'data.set', { fields: { secretish: 'v' } })],
          [{ from: 'start', to: 'seed' }],
          { settings: { retentionDays: 1 } },
        ),
      );
      const done = await start(id);
      const openId = await define(
        doc(
          'long-wait',
          [n('start', 'trigger.manual'), n('nap', 'control.delay', { duration: 'P20D' })],
          [{ from: 'start', to: 'nap' }],
          { settings: { retentionDays: 1 } },
        ),
      );
      const open = await start(openId);
      await progress();
      expect((await view(done)).run.state).toBe('succeeded');
      h.clock.advance(2 * 86_400_000);
      expect(await h.app.workflows.v2.pruneData({ force: true })).toBeGreaterThanOrEqual(1);
      owner = await fullLogin(h, 'owner1', PW, secret);
      const v = await view(done);
      expect(v.run.dataPrunedAt).not.toBeNull();
      expect((await nodeRuns(done, 'seed')).at(-1)?.output).toMatchObject({ $pruned: true });
      expect((await view(open)).run.dataPrunedAt ?? null).toBeNull();
      expect((await nodeRuns(open, 'start')).at(-1)?.output?.ports).toBeDefined();
      const again = await owner.req('POST', `/workflows/runs/${done}/rerun`, {
        fromNode: 'seed',
        dryRun: true,
      });
      expect(again.json<{ error: string }>().error).toBe('rerun_data_pruned');
      expect((await owner.req('POST', `/workflows/runs/${open}/cancel`, { reason: 'x' })).statusCode).toBe(
        200,
      );
    });
  });

  describe('respond to a held webhook', () => {
    it('answers the webhook call with the respond node’s status, body and allowlisted headers', async () => {
      await stepUp();
      const id = await define(
        doc(
          'answerer',
          [
            n('hook', 'trigger.webhook', { responseMode: 'wait', responseTimeoutSec: 10 }),
            n('reply', 'control.respond', {
              status: 201,
              body: ex('{"got": $trigger.body.x}'),
              headers: { 'x-request-id': 'req-{{ $trigger.body.x }}' },
            }),
          ],
          [{ from: 'hook', to: 'reply' }],
        ),
      );
      await stepUp();
      const on = await owner.req('PUT', `/workflows/${id}/activation`, { enabled: true });
      expect(on.statusCode, on.body).toBe(200);
      const a = on.json<{
        triggers: { nodeId: string; automationId: string | null }[];
        webhookSecrets: { nodeId: string; secret: string }[];
      }>();
      const automation = a.triggers.find((t) => t.nodeId === 'hook')?.automationId ?? '';
      const hookSecret = a.webhookSecrets.find((s) => s.nodeId === 'hook')?.secret ?? '';
      const fire = (nonce: string, body: string) => {
        const ts = String(Math.floor(h.clock.now().getTime() / 1000));
        return h.app.inject({
          method: 'POST',
          url: `/v1/hooks/${automation}`,
          headers: {
            'content-type': 'application/json',
            'x-remyral-timestamp': ts,
            'x-remyral-nonce': nonce,
            'x-remyral-signature': signRemyralWebhook(hookSecret, ts, nonce, body),
          },
          payload: body,
        });
      };
      // Drive the automation runtime and the engine while the request is held.
      const drive = async (pending: Promise<unknown>) => {
        const st = { settled: false };
        void pending.finally(() => {
          st.settled = true;
        });
        for (let i = 0; i < 50 && !st.settled; i++) {
          await h.app.automations.idle();
          await h.app.automations.startQueued();
          await h.app.workflows.progress();
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      const held = fire('nonce-0000000000000101', JSON.stringify({ x: 5 }));
      await drive(held);
      const res = await held;
      expect(res.statusCode, res.body).toBe(201);
      expect(JSON.parse(res.body)).toEqual({ got: 5 });
      expect(res.headers['x-request-id']).toBe('req-5');
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(String(res.headers['content-security-policy'])).toContain('sandbox');
    });

    it('refuses active content types (the run fails and the held call gets 500)', async () => {
      await stepUp();
      const id = await define(
        doc(
          'html-answer',
          [
            n('hook', 'trigger.webhook', { responseMode: 'wait', responseTimeoutSec: 10 }),
            n('reply', 'control.respond', {
              body: '<script>x</script>',
              headers: { 'content-type': 'text/html' },
            }),
          ],
          [{ from: 'hook', to: 'reply' }],
        ),
      );
      await stepUp();
      const on = await owner.req('PUT', `/workflows/${id}/activation`, { enabled: true });
      const a = on.json<{
        triggers: { nodeId: string; automationId: string | null }[];
        webhookSecrets: { nodeId: string; secret: string }[];
      }>();
      const automation = a.triggers.find((t) => t.nodeId === 'hook')?.automationId ?? '';
      const hookSecret = a.webhookSecrets.find((s) => s.nodeId === 'hook')?.secret ?? '';
      const ts = String(Math.floor(h.clock.now().getTime() / 1000));
      const body = '{}';
      const held = h.app.inject({
        method: 'POST',
        url: `/v1/hooks/${automation}`,
        headers: {
          'content-type': 'application/json',
          'x-remyral-timestamp': ts,
          'x-remyral-nonce': 'nonce-0000000000000201',
          'x-remyral-signature': signRemyralWebhook(hookSecret, ts, 'nonce-0000000000000201', body),
        },
        payload: body,
      });
      const st = { settled: false };
      void held.finally(() => {
        st.settled = true;
      });
      for (let i = 0; i < 50 && !st.settled; i++) {
        await h.app.automations.idle();
        await h.app.automations.startQueued();
        await h.app.workflows.progress();
        await new Promise((r) => setTimeout(r, 100));
      }
      const res = await held;
      expect(res.statusCode, res.body).toBe(500);
      expect(res.json<{ error: string }>().error).toBe('workflow_failed');
      expect(res.body).not.toContain('<script>');
    });
  });

  describe('metrics', () => {
    it('runs by state, node durations and failures of a workflow (viewer+)', async () => {
      const id = await define(
        doc(
          'measured',
          [n('start', 'trigger.manual'), n('seed', 'data.set', { fields: { a: 1 } })],
          [{ from: 'start', to: 'seed' }],
        ),
      );
      await start(id);
      await start(id);
      await progress();
      const res = await viewer.req('GET', `/workflows/${id}/metrics?days=7`);
      expect(res.statusCode, res.body).toBe(200);
      const m = res.json<{
        days: number;
        runs: Record<string, number>;
        nodes: { node: string; runs: number; failed: number }[];
        alertAfter: number;
      }>();
      expect(m.days).toBe(7);
      expect(m.runs.succeeded).toBe(2);
      expect(m.alertAfter).toBe(3);
      expect(m.nodes.find((x) => x.node === 'seed')).toMatchObject({ runs: 2, failed: 0 });
      // The OTel tailer reads the same facts (positions first, then counts new rows).
      const metrics = h.app.metrics;
      if (metrics !== null) {
        await metrics.tailWorkflows();
        await start(id);
        await progress();
        expect(await metrics.tailWorkflows()).toBeGreaterThan(0);
      }
    });
  });
});
