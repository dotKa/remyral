import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { JobStore } from '../../src/jobs/store.js';
import { WorkflowService } from '../../src/workflows/engine.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p14-workflow-engine 14.1 (ADR-0055): engine 2 runs every control-flow, data and timer node on the master — real
 * Postgres, the expression sandbox thread pool, a fake clock. Covers every 14.1 node type, dead paths, joins, groups
 * (forEach with a concurrency limit, loop), timers persisted as rows across a simulated restart, approvals, sub-
 * workflows with cancel propagation, error ports, retries with backoff, timeouts, stop / fail, run outputs, history
 * redaction and payloads, and the new routes (catalog, expression preview, single-node test, node runs, node-run
 * approve / deny / cancel).
 */

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'wfc-alpha';
const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://git.example.test/acme/wfc.git', baseRef: 'main' },
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
  run: { id: string; state: string; engine: number; reason: string | null; outputs?: unknown };
  nodes: {
    id: string;
    type: string;
    state: string;
    nodeRunId: string;
    nodeRunState: string;
    waitKind: string | null;
    dueAt: string | null;
    outputPort: string | null;
    error: { code: string; message: string } | null;
    iterations: number;
    jobId: string | null;
  }[];
  edges: { from: string; to: string; fromPort?: string; state?: string }[];
}
interface NodeRun {
  id: string;
  node: string;
  scope: string;
  attempt: number;
  state: string;
  dueAt: string | null;
  input: { value?: unknown; config?: unknown };
  output: { ports?: Record<string, unknown>; return?: unknown } | null;
  error: { code: string } | null;
}

describeIntegration(
  'workflow engine 2 — control flow, data, timers (integration, p14 14.1)',
  { timeout: 300_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let secret: string;
    let viewer: Client;

    beforeAll(async () => {
      await h.start({ orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } } });
      await h.createUser('owner1', PW);
      secret = (await enroll(h, 'owner1', PW)).secret;
      owner = await fullLogin(h, 'owner1', PW, secret);
      const vid = await h.createUser('viewer1', PW, 'viewer');
      await h.grant(vid, [PROJECT], 'viewer');
      viewerSecret = (await enroll(h, 'viewer1', PW)).secret;
      viewer = await fullLogin(h, 'viewer1', PW, viewerSecret);
    });
    afterAll(async () => {
      await h.stop();
    });
    // Timer tests move the fake clock by hours: every test starts with fresh sessions (and a fresh step-up).
    let viewerSecret = '';
    beforeEach(async () => {
      owner = await fullLogin(h, 'owner1', PW, secret);
      if (viewerSecret !== '') viewer = await fullLogin(h, 'viewer1', PW, viewerSecret);
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
    async function nodeRuns(runId: string, q = ''): Promise<NodeRun[]> {
      const res = await owner.req('GET', `/workflows/runs/${runId}/node-runs?limit=100${q}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ nodeRuns: NodeRun[] }>().nodeRuns;
    }
    const progress = async (times = 3) => {
      for (let i = 0; i < times; i++) await h.app.workflows.progress();
    };
    const states = async (runId: string) =>
      Object.fromEntries((await view(runId)).nodes.map((x) => [x.id, x.nodeRunState]));
    const portValue = async (runId: string, node: string, port: string) => {
      const r = (await nodeRuns(runId, `&node=${node}`)).at(-1);
      return r?.output?.ports?.[port];
    };
    async function stepUp(): Promise<void> {
      h.clock.advance(30_000);
      const res = await owner.req('POST', '/auth/step-up', { code: h.code(secret) });
      expect(res.statusCode, res.body).toBe(200);
    }

    describe('control flow and data', () => {
      it('if / switch / set / transform / filter / aggregate / split / template / parse / validate / dateTime, with dead paths and run outputs', async () => {
        const id = await define(
          doc(
            'data-chain',
            [
              n('start', 'trigger.manual'),
              n('seed', 'data.set', {
                fields: {
                  items: ex('[{"team":"a","h":2},{"team":"b","h":1},{"team":"a","h":3}]'),
                  csv: 'x,y\n1,2',
                  when: '2026-10-20T10:00:00Z',
                },
              }),
              n('big', 'control.if', { condition: '{{ $count($input.items) > 2 }}' }),
              n('kind', 'control.switch', {
                value: ex('$input.items[0].team'),
                cases: [
                  { name: 'alpha', equals: 'a' },
                  { name: 'beta', equals: 'b' },
                  { name: 'many', match: ex('$count($input.items) > 99') },
                ],
              }),
              n('keep', 'data.filter', { items: ex('$input.items'), keep: ex('h > 1') }),
              n('sum', 'data.aggregate', {
                items: ex('$input.kept'),
                groupBy: ex('team'),
                operations: [
                  { name: 'n', op: 'count' },
                  { name: 'hours', op: 'sum', field: ex('h') },
                ],
              }),
              n('wrap', 'data.transform', { expression: ex('{"kept": $input}') }),
              n('parts', 'data.split', { mode: 'string', value: ex('$node.seed.out.csv'), separator: '\n' }),
              n('csv', 'data.parse', { format: 'csv', value: ex('$node.seed.out.csv') }),
              n('valid', 'data.validate', {
                schema: { type: 'array', items: { type: 'object', required: ['x'] } },
                value: ex('$input'),
              }),
              n('later', 'data.dateTime', {
                operation: 'add',
                value: ex('$node.seed.out.when'),
                amount: 2,
                unit: 'hours',
              }),
              n('text', 'data.template', {
                template: 'Teams: {{ $join($input.key, ",") }} from {{ $node.seed.out.when }}',
              }),
              n('small', 'data.set', { fields: { never: 1 } }),
            ],
            [
              { from: 'start', to: 'seed' },
              { from: 'seed', to: 'big' },
              { from: 'big', fromPort: 'true', to: 'kind' },
              { from: 'big', fromPort: 'false', to: 'small' },
              { from: 'kind', fromPort: 'alpha', to: 'keep' },
              { from: 'keep', fromPort: 'kept', to: 'wrap' },
              { from: 'wrap', to: 'sum' },
              { from: 'seed', to: 'parts' },
              { from: 'seed', to: 'csv' },
              { from: 'csv', to: 'valid' },
              { from: 'seed', to: 'later' },
              { from: 'sum', to: 'text' },
            ],
          ),
        );
        const runId = await start(id);
        await progress();
        const v = await view(runId);
        expect(v.run, JSON.stringify(v.nodes.map((x) => [x.id, x.nodeRunState, x.error]))).toMatchObject({
          engine: 2,
          state: 'succeeded',
        });
        const st = Object.fromEntries(v.nodes.map((x) => [x.id, x.nodeRunState]));
        expect(st).toMatchObject({
          big: 'succeeded',
          kind: 'succeeded',
          small: 'skipped',
          text: 'succeeded',
        });
        expect(v.nodes.find((x) => x.id === 'big')?.outputPort).toBe('true');
        // The skipped branch is a dead path on the edge (dashed in the run view).
        expect(v.edges.find((e) => e.from === 'big' && e.to === 'small')?.state).toBe('skip');
        expect(await portValue(runId, 'sum', 'out')).toEqual([{ key: 'a', n: 2, hours: 5 }]);
        expect(await portValue(runId, 'parts', 'items')).toEqual(['x,y', '1,2']);
        expect(await portValue(runId, 'valid', 'valid')).toEqual([{ x: '1', y: '2' }]);
        expect(await portValue(runId, 'later', 'out')).toBe('2026-10-20T12:00:00.000Z');
        expect(await portValue(runId, 'text', 'out')).toBe('Teams: a from 2026-10-20T10:00:00Z');
        // Run outputs: the top-level sinks' values.
        expect(v.run.outputs).toMatchObject({ text: 'Teams: a from 2026-10-20T10:00:00Z' });
        // Every node run recorded what it used (resolved config) and produced.
        const seed = (await nodeRuns(runId, '&node=keep'))[0];
        expect(Array.isArray((seed?.input.config as { items?: unknown } | undefined)?.items)).toBe(true);
      });

      it('merge joins: all, any, first (drops the slower branch) and at least N', async () => {
        const branches = (join: unknown): Node[] => [
          n('a', 'data.set', { fields: { v: 1 } }),
          n('b', 'control.delay', { duration: 120 }),
          n('c', 'data.set', { fields: { v: 3 } }),
          n('m', 'control.merge', { join, combine: 'object' }),
        ];
        const edges = [
          { from: 'a', to: 'm' },
          { from: 'b', to: 'm' },
          { from: 'c', to: 'm' },
        ];
        const all = await start(await define(doc('join-all', branches('all'), edges)));
        await progress();
        expect((await states(all)).m).toBe('pending');
        h.clock.advance(121_000);
        await progress();
        expect((await states(all)).m).toBe('succeeded');
        expect(Object.keys((await portValue(all, 'm', 'out')) as object).sort()).toEqual(['a', 'b', 'c']);

        const first = await start(await define(doc('join-first', branches('first'), edges)));
        await progress();
        const st = await states(first);
        expect(st.m).toBe('succeeded');
        // The waiting branch feeds only the merge: it is no longer needed.
        expect(st.b).toBe('skipped');
        expect((await view(first)).run.state).toBe('succeeded');

        const quorum = await start(await define(doc('join-two', branches({ atLeast: 2 }), edges)));
        await progress();
        expect((await states(quorum)).m).toBe('succeeded');
        expect(Object.keys((await portValue(quorum, 'm', 'out')) as object).sort()).toEqual(['a', 'c']);
      });

      it('error ports catch a failure (try / catch); without one the run fails; stop and fail end the run', async () => {
        const caught = await start(
          await define(
            doc(
              'catch',
              [
                n('bad', 'data.parse', { format: 'json', value: ex('"not json"') }),
                n('handler', 'data.set', { fields: { code: ex('$input.code'), node: ex('$input.node') } }),
              ],
              [{ from: 'bad', fromPort: 'error', to: 'handler' }],
            ),
          ),
        );
        await progress();
        expect((await view(caught)).run.state).toBe('succeeded');
        expect(await portValue(caught, 'handler', 'out')).toEqual({ code: 'parse_error', node: 'bad' });

        const uncaught = await start(
          await define(doc('nocatch', [n('bad', 'data.parse', { format: 'json', value: ex('"x"') })], [])),
        );
        await progress();
        const v = await view(uncaught);
        expect(v.run.state).toBe('failed');
        expect(v.run.reason).toContain('parse_error');

        const stopped = await start(
          await define(
            doc(
              'stopper',
              [
                n('s', 'control.stop', { outputs: ex('{"done": true}') }),
                n('slow', 'control.delay', { duration: 600 }),
              ],
              [],
            ),
          ),
        );
        await progress();
        const sv = await view(stopped);
        expect(sv.run).toMatchObject({ state: 'succeeded', outputs: { done: true } });
        expect(Object.fromEntries(sv.nodes.map((x) => [x.id, x.nodeRunState])).slow).toBe('cancelled');

        const failed = await start(
          await define(doc('failer', [n('f', 'control.fail', { reason: 'bad input {{ 1 + 1 }}' })], [])),
        );
        await progress();
        const fv = await view(failed);
        expect(fv.run.state).toBe('failed');
        expect(fv.run.reason).toContain('bad input 2');
      });

      it('retries with exponential backoff as retry_wait rows, then the error policy', async () => {
        const runId = await start(
          await define(
            doc(
              'retrier',
              [
                n(
                  'flaky',
                  'data.transform',
                  { expression: ex('$error("boom")') },
                  { retry: { max: 2, backoff: 'exponential', initialSec: 10 }, onError: 'continue' },
                ),
                n('after', 'data.set', { fields: { ok: true } }),
              ],
              [{ from: 'flaky', to: 'after' }],
            ),
          ),
        );
        await progress();
        let runs = await nodeRuns(runId, '&node=flaky');
        expect(runs.map((r) => [r.attempt, r.state])).toEqual([
          [1, 'failed'],
          [2, 'retry_wait'],
        ]);
        const due1 = Date.parse(runs[1]?.dueAt ?? '');
        expect(due1 - h.clock.now().getTime()).toBeGreaterThan(9_000);
        h.clock.advance(10_500);
        await progress();
        runs = await nodeRuns(runId, '&node=flaky');
        expect(runs.map((r) => r.state)).toEqual(['failed', 'failed', 'retry_wait']);
        // Exponential: the second wait is twice the first.
        expect(Date.parse(runs[2]?.dueAt ?? '') - h.clock.now().getTime()).toBeGreaterThan(19_000);
        h.clock.advance(20_500);
        await progress();
        runs = await nodeRuns(runId, '&node=flaky');
        expect(runs.map((r) => r.state)).toEqual(['failed', 'failed', 'failed']);
        // onError: continue — the run goes on with null on `out`.
        expect((await view(runId)).run.state).toBe('succeeded');
        expect((await states(runId)).after).toBe('succeeded');
      });
    });

    describe('groups', () => {
      it('forEach runs its body once per item with a concurrency limit and collects results in item order', async () => {
        const id = await define(
          doc(
            'each',
            [
              n('list', 'data.set', { fields: { xs: ex('[1,2,3,4,5]') } }),
              n('each', 'control.forEach', { items: ex('$input.xs'), concurrency: 2 }),
              n('wait', 'control.delay', { duration: 30 }, { parent: 'each' }),
              n('double', 'data.transform', { expression: ex('$item * 2') }, { parent: 'each' }),
              n('ret', 'control.return', { value: ex('{"i": $index, "v": $input}') }, { parent: 'each' }),
              n('total', 'data.transform', { expression: ex('$sum($input.v)') }),
            ],
            [
              { from: 'list', to: 'each' },
              { from: 'each', fromPort: 'item', to: 'wait' },
              { from: 'wait', to: 'double' },
              { from: 'double', to: 'ret' },
              { from: 'each', fromPort: 'results', to: 'total' },
            ],
          ),
        );
        const runId = await start(id);
        await progress();
        // Only two iterations at a time (each waits on a timer).
        let scopes = new Set((await nodeRuns(runId, '&node=wait')).map((r) => r.scope));
        expect([...scopes].sort()).toEqual(['each[0]', 'each[1]']);
        for (let i = 0; i < 3; i++) {
          h.clock.advance(31_000);
          await progress(4);
        }
        scopes = new Set((await nodeRuns(runId, '&node=wait')).map((r) => r.scope));
        expect(scopes.size).toBe(5);
        const v = await view(runId);
        expect(v.run.state).toBe('succeeded');
        expect(await portValue(runId, 'each', 'results')).toEqual([
          { i: 0, v: 2 },
          { i: 1, v: 4 },
          { i: 2, v: 6 },
          { i: 3, v: 8 },
          { i: 4, v: 10 },
        ]);
        expect(await portValue(runId, 'total', 'out')).toBe(30);
        expect(v.nodes.find((x) => x.id === 'double')?.iterations).toBe(5);
      });

      it('forEach onItemError: collect keeps going; fail cancels the other iterations and fails the group', async () => {
        const body = (policy: string): Node[] => [
          n('each', 'control.forEach', { items: ex('[1, 0, 2]'), concurrency: 3, onItemError: policy }),
          n(
            'inv',
            'data.transform',
            { expression: ex('$item = 0 ? $error("zero") : 1 / $item') },
            { parent: 'each' },
          ),
        ];
        const edges = [{ from: 'each', fromPort: 'item', to: 'inv' }];
        const collect = await start(await define(doc('each-collect', body('collect'), edges)));
        await progress(4);
        expect((await view(collect)).run.state).toBe('succeeded');
        expect(await portValue(collect, 'each', 'results')).toEqual([
          1,
          { error: { code: 'expr_error:D3137', message: expect.any(String) as unknown } },
          0.5,
        ]);
        expect(await portValue(collect, 'each', 'done')).toEqual({ count: 3, succeeded: 2, failed: 1 });

        const fail = await start(await define(doc('each-fail', body('fail'), edges)));
        await progress(4);
        const v = await view(fail);
        expect(v.run.state).toBe('failed');
        expect(v.nodes.find((x) => x.id === 'each')?.error?.code).toBe('item_failed');
      });

      it('a group that would push the run past 10 000 node runs fails limit_exceeded', async () => {
        const runId = await start(
          await define(
            doc(
              'too-many',
              [
                n('nap', 'control.delay', { duration: 60 }),
                n('each', 'control.forEach', { items: ex('[1, 2]') }),
                n('body', 'data.transform', { expression: ex('$item') }, { parent: 'each' }),
              ],
              [
                { from: 'nap', to: 'each' },
                { from: 'each', fromPort: 'item', to: 'body' },
              ],
            ),
          ),
        );
        await progress();
        // Pad the run with finished node runs (a long history), then let the group try to start.
        await h.db.pool.query(
          `INSERT INTO workflow_node_runs (run_id, node_id, node_type, scope, attempt, state, placement, input,
                                         idempotency_key, error, created_at, updated_at)
         SELECT $1, 'pad', 'data.set', 'pad[' || g || ']', 1, 'skipped', 'master', '{}'::jsonb,
                encode(sha256(g::text::bytea), 'hex'), '{"code": "dead_path"}'::jsonb, $2, $2
           FROM generate_series(1, 9998) g`,
          [runId, h.clock.now()],
        );
        h.clock.advance(61_000);
        await progress();
        const v = await view(runId);
        expect(v.nodes.find((x) => x.id === 'each')?.error?.code).toBe('limit_exceeded');
        expect(v.run.state).toBe('failed');
      });

      it('an AI step inside a forEach body gets one lazily created job per item with the item fenced as data', async () => {
        const runId = await start(
          await define(
            doc(
              'each-ai',
              [
                n('each', 'control.forEach', { items: ex('["alpha", "beta"]'), concurrency: 2 }),
                {
                  id: 'review',
                  type: 'ai.step',
                  role: 'reviewer',
                  prompt: 'Review this item.',
                  parent: 'each',
                },
              ],
              [{ from: 'each', fromPort: 'item', to: 'review' }],
            ),
          ),
        );
        await progress();
        const runs = await h.db.pool.query<{ scope: string; job_id: string; snapshot: { value: string }[] }>(
          `SELECT nr.scope, l.job_id, nr.input->'snapshot' AS snapshot FROM workflow_node_runs nr
           JOIN workflow_node_run_jobs l ON l.node_run_id = nr.id WHERE nr.run_id = $1 ORDER BY nr.scope`,
          [runId],
        );
        expect(runs.rows.map((r) => [r.scope, r.snapshot[0]?.value])).toEqual([
          ['each[0]', '"alpha"'],
          ['each[1]', '"beta"'],
        ]);
        for (const r of runs.rows) {
          await h.db.pool.query('UPDATE jobs SET state = $2, version = version + 1 WHERE id = $1', [
            r.job_id,
            'SUCCEEDED',
          ]);
        }
        await progress(4);
        expect((await view(runId)).run.state).toBe('succeeded');
        expect(((await portValue(runId, 'each', 'results')) as unknown[]).length).toBe(2);
      });

      it('loop repeats while its condition holds (bounded) and passes each result to the next iteration', async () => {
        const runId = await start(
          await define(
            doc(
              'repeat',
              [
                n('seed', 'data.set', { fields: { n: 1 } }),
                n('loop', 'control.loop', {
                  while: ex('$loop.index < 4 and $loop.last.n < 5'),
                  maxIterations: 10,
                }),
                n('inc', 'data.transform', { expression: ex('{"n": $item.n * 2}') }, { parent: 'loop' }),
              ],
              [
                { from: 'seed', to: 'loop' },
                { from: 'loop', fromPort: 'item', to: 'inc' },
              ],
            ),
          ),
        );
        await progress(12);
        expect((await view(runId)).run.state).toBe('succeeded');
        expect(await portValue(runId, 'loop', 'results')).toEqual([{ n: 2 }, { n: 4 }, { n: 8 }]);
      });
    });

    describe('timers, approvals, sub-workflows', () => {
      it('a delay timer is a row: it survives a master restart and fires once', async () => {
        const id = await define(
          doc(
            'sleeper',
            [
              n('nap', 'control.delay', { duration: 'PT1M' }),
              n('woke', 'data.set', { fields: { ok: true } }),
            ],
            [{ from: 'nap', to: 'woke' }],
          ),
        );
        const runId = await start(id);
        await progress();
        const v = await view(runId);
        const nap = v.nodes.find((x) => x.id === 'nap');
        expect(nap).toMatchObject({ nodeRunState: 'waiting', waitKind: 'timer' });
        expect(Date.parse(nap?.dueAt ?? '')).toBe(h.clock.now().getTime() + 60_000);
        // "Restart": a fresh service with no memory of the run (same database, same clock).
        const restarted = new WorkflowService({
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
        try {
          await restarted.progress();
          expect((await states(runId)).nap).toBe('waiting');
          h.clock.advance(61_000);
          await restarted.progress();
          await restarted.progress();
        } finally {
          await restarted.close();
        }
        expect(await states(runId)).toMatchObject({ nap: 'succeeded', woke: 'succeeded' });
        expect((await nodeRuns(runId, '&node=nap')).length).toBe(1);
        expect((await view(runId)).run.state).toBe('succeeded');
      });

      it('waitUntil: on time ⇒ out; fired late after an outage with late: skip ⇒ timeout', async () => {
        const at = new Date(h.clock.now().getTime() + 10_000).toISOString();
        const id = await define(
          doc(
            'until',
            [
              n('w', 'control.waitUntil', { at, late: 'skip' }),
              n('ontime', 'data.set', { fields: { x: 1 } }),
              n('late', 'data.set', { fields: { x: 2 } }),
            ],
            [
              { from: 'w', to: 'ontime' },
              { from: 'w', fromPort: 'timeout', to: 'late' },
            ],
          ),
        );
        const runId = await start(id);
        await progress();
        h.clock.advance(5 * 60_000);
        await progress();
        expect(await states(runId)).toMatchObject({ w: 'succeeded', ontime: 'skipped', late: 'succeeded' });
      });

      it('approval node: approve / deny are outcomes on ports (role + step-up); timeout fires its port', async () => {
        const id = await define(
          doc(
            'approve',
            [
              n('ask', 'control.approval', {
                approverRole: 'admin',
                title: 'Ship {{ $inputs.what }}?',
                timeoutSec: 3600,
              }),
              n('yes', 'data.set', { fields: { by: ex('$input.decidedBy') } }),
              n('no', 'data.set', { fields: { x: 1 } }),
              n('late', 'data.set', { fields: { x: 2 } }),
            ],
            [
              { from: 'ask', fromPort: 'approved', to: 'yes' },
              { from: 'ask', fromPort: 'denied', to: 'no' },
              { from: 'ask', fromPort: 'timeout', to: 'late' },
            ],
            { inputs: { what: { required: true } } },
          ),
        );
        const runId = await start(id, { what: 'v1' });
        await progress();
        const ask = (await view(runId)).nodes.find((x) => x.id === 'ask');
        expect(ask).toMatchObject({ state: 'awaiting_approval', waitKind: 'approval' });
        const nr = (await nodeRuns(runId, '&node=ask'))[0];
        expect(nr?.input.config).toMatchObject({ title: 'Ship v1?' });
        // A viewer may read but not decide.
        expect(
          (await viewer.req('POST', `/workflows/runs/${runId}/node-runs/${ask?.nodeRunId ?? ''}/approve`, {}))
            .statusCode,
        ).toBe(403);
        // No fresh step-up ⇒ refused.
        h.clock.advance(11 * 60_000);
        const refused = await owner.req(
          'POST',
          `/workflows/runs/${runId}/node-runs/${ask?.nodeRunId ?? ''}/approve`,
          {},
        );
        expect(refused.statusCode).toBe(403);
        await stepUp();
        const ok = await owner.req(
          'POST',
          `/workflows/runs/${runId}/node-runs/${ask?.nodeRunId ?? ''}/approve`,
          {
            reason: 'go',
          },
        );
        expect(ok.statusCode, ok.body).toBe(200);
        await progress();
        expect(await states(runId)).toMatchObject({ ask: 'succeeded', yes: 'succeeded', no: 'skipped' });
        expect((await view(runId)).run.state).toBe('succeeded');

        const denied = await start(id, { what: 'v2' });
        await progress();
        const ask2 = (await view(denied)).nodes.find((x) => x.id === 'ask');
        await stepUp();
        expect(
          (
            await owner.req('POST', `/workflows/runs/${denied}/node-runs/${ask2?.nodeRunId ?? ''}/deny`, {
              reason: 'no',
            })
          ).statusCode,
        ).toBe(200);
        await progress();
        expect(await states(denied)).toMatchObject({ no: 'succeeded', yes: 'skipped' });

        const timed = await start(id, { what: 'v3' });
        await progress();
        h.clock.advance(3601_000);
        await progress();
        owner = await fullLogin(h, 'owner1', PW, secret);
        expect(await states(timed)).toMatchObject({ ask: 'succeeded', late: 'succeeded', yes: 'skipped' });
      });

      it('a node timeout fails a waiting node (→ its error port); cancelling one node run applies its policy', async () => {
        const id = await define(
          doc(
            'timeouts',
            [
              n('ask', 'control.approval', { title: 'x' }, { timeoutSec: 60 }),
              n('caught', 'data.set', { fields: { code: ex('$input.code') } }),
            ],
            [{ from: 'ask', fromPort: 'error', to: 'caught' }],
          ),
        );
        const runId = await start(id);
        await progress();
        h.clock.advance(61_000);
        await progress();
        expect(await portValue(runId, 'caught', 'out')).toEqual({ code: 'timeout' });

        const second = await start(id);
        await progress();
        const nr = (await view(second)).nodes.find((x) => x.id === 'ask');
        const c = await owner.req(
          'POST',
          `/workflows/runs/${second}/node-runs/${nr?.nodeRunId ?? ''}/cancel`,
          {
            reason: 'not needed',
          },
        );
        expect(c.statusCode, c.body).toBe(200);
        await progress();
        expect(await portValue(second, 'caught', 'out')).toEqual({ code: 'cancelled' });
        expect((await view(second)).run.state).toBe('succeeded');
      });

      it('sub-workflow: the child runs on engine 2 with inputs, its outputs flow back; cancelling the parent cancels the child', async () => {
        await define(
          doc(
            'child',
            [
              n('calc', 'data.transform', { expression: ex('$number($inputs.n) * 10') }),
              n('wait', 'control.delay', { duration: 60 }),
            ],
            [{ from: 'calc', to: 'wait' }],
            { inputs: { n: { required: true, type: 'number' } } },
          ),
        );
        const parentId = await define(
          doc(
            'parent',
            [
              n('call', 'control.subWorkflow', { workflow: { name: 'child' }, inputs: { n: '{{ 4 }}' } }),
              n('use', 'data.transform', { expression: ex('$input.wait') }),
            ],
            [{ from: 'call', to: 'use' }],
          ),
        );
        const runId = await start(parentId);
        await progress();
        const call = (await view(runId)).nodes.find((x) => x.id === 'call');
        expect(call).toMatchObject({ nodeRunState: 'waiting', waitKind: 'child_run' });
        const child = await h.db.pool.query<{ id: string; engine: number; trigger_kind: string }>(
          'SELECT id, engine, trigger_kind FROM workflow_runs WHERE parent_run_id = $1',
          [runId],
        );
        expect(child.rows[0]).toMatchObject({ engine: 2, trigger_kind: 'subworkflow' });
        h.clock.advance(61_000);
        await progress(4);
        expect((await view(runId)).run.state).toBe('succeeded');
        expect(await portValue(runId, 'use', 'out')).toBe(40);

        const cancelled = await start(parentId);
        await progress();
        const res = await owner.req('POST', `/workflows/runs/${cancelled}/cancel`, { reason: 'stop' });
        expect(res.statusCode, res.body).toBe(200);
        const kid = await h.db.pool.query<{ state: string }>(
          'SELECT state FROM workflow_runs WHERE parent_run_id = $1',
          [cancelled],
        );
        expect(kid.rows[0]?.state).toBe('cancelled');
      });
    });

    describe('history, routes and validation', () => {
      it('stores values redacted, large ones as payloads readable by reference', async () => {
        const runId = await start(
          await define(
            doc(
              'history',
              [
                n('s', 'data.set', {
                  fields: {
                    key: ex('"sk-ant-api03-" & "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"'),
                    big: ex('$pad("", 40000, "x")'),
                  },
                }),
              ],
              [],
            ),
          ),
        );
        await progress();
        const nr = (await nodeRuns(runId))[0];
        const out = nr?.output?.ports?.out as { $payload: string; size: number };
        expect(out.$payload).toMatch(/^[a-f0-9]{64}$/);
        expect(out.size).toBeGreaterThan(40_000);
        const p = await owner.req('GET', `/workflows/runs/${runId}/payloads/${out.$payload}`);
        expect(p.statusCode).toBe(200);
        expect(p.headers['cache-control']).toBe('no-store');
        expect(p.body).not.toContain('sk-ant-api03-abcdefghij');
        expect(p.json<{ value: { big: string } }>().value.big.length).toBe(40_000);
      });

      it('validation at save: expression syntax, refused functions and regexes on the exact field path', async () => {
        const res = await owner.req('POST', '/workflows', {
          project: PROJECT,
          definition: doc(
            'badexpr',
            [
              n('a', 'data.transform', { expression: ex('$eval("1")') }),
              n('b', 'control.if', { condition: '{{ 1 + }}' }),
              n('c', 'data.filter', { items: ex('$input'), keep: ex('$match(x, /(a+)+$/)') }),
            ],
            [],
          ),
        });
        expect(res.statusCode).toBe(400);
        const issues = res.json<{ issues: { path: string; code: string }[] }>().issues;
        expect(issues).toContainEqual({
          path: 'nodes.0.config.expression',
          code: 'expr_function_not_allowed',
        });
        expect(issues).toContainEqual({ path: 'nodes.1.config.condition', code: 'expr_syntax' });
        expect(issues).toContainEqual({ path: 'nodes.2.config.keep', code: 'expr_regex_not_allowed' });
      });

      it('catalog, expression preview and single-node test (RBAC: viewer reads the catalog, cannot test)', async () => {
        const cat = await viewer.req('GET', '/workflows/catalog');
        expect(cat.statusCode).toBe(200);
        const c = cat.json<{
          engineV2: boolean;
          executable: string[];
          types: { type: string; testable: boolean; config: unknown }[];
        }>();
        expect(c.engineV2).toBe(true);
        expect(c.executable).toContain('control.forEach');
        // 14.3: the worker function nodes run on engine 2 too; 14.4 adds respond and the error trigger.
        expect(c.executable).toContain('http.request');
        expect(c.executable).toContain('control.respond');
        expect(c.executable).toContain('trigger.error');
        expect(c.types.find((t) => t.type === 'data.filter')).toMatchObject({ testable: true });
        expect(c.types.find((t) => t.type === 'ai.step')).toMatchObject({ testable: false });

        const ev = await owner.req('POST', '/workflows/expressions/evaluate', {
          project: PROJECT,
          expression: '$sum($input.xs) + $count($inputs.ys)',
          sample: { input: { xs: [1, 2] }, inputs: { ys: [1] } },
        });
        expect(ev.json()).toEqual({ ok: true, value: 4, type: 'number', bytes: 1, truncated: false });
        const refused = await owner.req('POST', '/workflows/expressions/evaluate', {
          project: PROJECT,
          expression: '$random()',
        });
        expect(refused.json()).toEqual({
          ok: false,
          error: { code: 'expr_function_not_allowed', position: expect.any(Number) as unknown },
        });
        const dos = await owner.req('POST', '/workflows/expressions/evaluate', {
          project: PROJECT,
          expression: '$match($input, /(a|a)*b/)',
          sample: { input: `${'a'.repeat(40)}!` },
        });
        expect(dos.json()).toMatchObject({ ok: false, error: { code: 'expr_timeout' } });
        expect(
          (await viewer.req('POST', '/workflows/expressions/evaluate', { project: PROJECT, expression: '1' }))
            .statusCode,
        ).toBe(403);

        const wf = await define(
          doc('testable', [n('f', 'data.filter', { items: ex('$input'), keep: ex('$ > 1') })], []),
        );
        const t = await owner.req('POST', `/workflows/${wf}/nodes/f/test`, { input: [1, 2, 3] });
        expect(t.statusCode, t.body).toBe(200);
        expect(t.json()).toMatchObject({ ok: true, outcome: 'value', ports: { kept: [2, 3], dropped: [1] } });
        // The editor's unsaved copy of the node.
        const unsaved = await owner.req('POST', `/workflows/${wf}/nodes/f/test`, {
          node: n('f', 'data.filter', { items: ex('$input'), keep: ex('$ > 2') }),
          input: [1, 2, 3],
        });
        expect(unsaved.json()).toMatchObject({ ports: { kept: [3] } });
        const delay = await owner.req('POST', `/workflows/${wf}/nodes/f/test`, {
          node: n('f', 'control.delay', { duration: 90 }),
        });
        expect(delay.json()).toMatchObject({ ok: true, outcome: 'wait', wait: { kind: 'timer' } });
        const bad = await owner.req('POST', `/workflows/${wf}/nodes/f/test`, {
          node: n('f', 'data.transform', { expression: ex('$eval("x")') }),
        });
        expect(bad.statusCode).toBe(400);
        expect(bad.json<{ issues: unknown[] }>().issues).toContainEqual({
          path: 'node.config.expression',
          code: 'expr_function_not_allowed',
        });
        expect((await viewer.req('POST', `/workflows/${wf}/nodes/f/test`, { input: [] })).statusCode).toBe(
          403,
        );
        const audit = await h.db.pool.query("SELECT 1 FROM audit_events WHERE action = 'workflow.test'");
        expect(audit.rowCount).toBeGreaterThanOrEqual(3);
      });

      it('a v2 definition up to 512 KiB is accepted by the define routes; larger bodies are refused', async () => {
        const big = doc(
          'bigdoc',
          Array.from({ length: 150 }, (_, i) =>
            n(`s${String(i)}`, 'data.template', { template: `${'t'.repeat(2500)} {{ 1 }}` }),
          ),
          [],
        );
        expect(JSON.stringify(big).length).toBeGreaterThan(300 * 1024);
        const ok = await owner.req('POST', '/workflows/validate', { project: PROJECT, definition: big });
        expect(ok.statusCode, ok.body.slice(0, 300)).toBe(200);
        const huge = doc('hugedoc', [n('a', 'data.template', { template: 't'.repeat(600 * 1024) })], []);
        const res = await owner.req('POST', '/workflows/validate', { project: PROJECT, definition: huge });
        expect(res.statusCode).toBe(413);
      });
    });
  },
);
