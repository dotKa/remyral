import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, verifyChain } from '../../src/audit/audit.js';
import type { Role } from '../../src/auth/users.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import {
  BudgetThresholdOutboxPayload,
  OUTBOX_TOPIC_BUDGET_THRESHOLD,
  UsageRejectedError,
  UsageStore,
} from '../../src/usage/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };

interface Person {
  readonly id: string;
  readonly secret: string;
  client: Client;
}

let h: Harness;
let jobs: JobStore;
let store: UsageStore;
const people = {} as Record<Role, Person>;
let eventSeq = 0;

async function person(username: string, role: Role): Promise<Person> {
  const id = await h.createUser(username, PW, role);
  // p5-rbac: per-project accounts are members of the projects these tests use.
  if (role === 'operator' || role === 'viewer') await h.grant(id, ['alpha', 'beta', 'gamma'], role);
  const { client, secret } = await enroll(h, username, PW);
  return { id, secret, client };
}

async function stepUp(p: Person): Promise<void> {
  h.clock.advance(30_000);
  const res = await p.client.req('POST', '/auth/step-up', { code: h.code(p.secret) });
  expect(res.statusCode, res.body).toBe(200);
}

interface Run {
  readonly jobId: string;
  readonly attemptId: string;
  readonly workerId: string;
}

async function startJob(
  project: string,
  workerId: string,
  runtime = 'claude-code',
  model?: string,
): Promise<Run> {
  const { job } = await jobs.create({
    project,
    actor: CREATOR,
    submit: true,
    spec: {
      runtime,
      ...(model === undefined ? {} : { model }),
      prompt: 'Fix the flaky test',
      repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/usage' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    },
  });
  const grant = await jobs.acquireLease(job.id, workerId, 3_600_000);
  return { jobId: job.id, attemptId: grant.attempt.id, workerId };
}

function usage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'usage', provenance: 'unknown', ...over };
}

async function record(run: Run, event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  eventSeq += 1;
  h.clock.advance(1_000);
  return store.recordUsage(event, {
    jobId: run.jobId,
    attemptId: run.attemptId,
    workerId: run.workerId,
    sourceEventId: `msg-${String(eventSeq)}`,
    ...extra,
  });
}

async function auditCount(action: string, outcome: string): Promise<number> {
  const { rows } = await h.db.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM audit_events WHERE action = $1 AND outcome = $2',
    [action, outcome],
  );
  return rows[0]?.n ?? 0;
}

interface GroupJson {
  key: string | null;
  records: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: { reported: number; estimated: number; total: number };
  coverage: { reported: number; estimated: number; unknown: number; subscription: number };
  missingPrices: { provider: string; model: string; reason: string; records: number }[];
  flags: {
    costComplete: boolean;
    hasSubscription: boolean;
    noPerRunCost: boolean;
    metricsIncomplete: boolean;
  };
}

async function summary(
  groupBy: string,
  p: Person = people.viewer,
  extra = '',
): Promise<{ groups: GroupJson[]; totals: GroupJson; priceTableVersion: number }> {
  const res = await p.client.req('GET', `/usage/summary?groupBy=${groupBy}${extra}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const byKey = (groups: GroupJson[], key: string | null): GroupJson => {
  const g = groups.find((x) => x.key === key);
  if (!g) throw new Error(`no group ${String(key)}`);
  return g;
};

/** Test prices: round numbers clearly not real provider prices. */
const PRICE_ENTRIES = [
  {
    provider: 'anthropic',
    model: 'test-model-a',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 10,
    cacheReadUsdPerMTok: null,
    cacheWriteUsdPerMTok: null,
    source: 'integration test fixture (not a real price)',
  },
];

describeIntegration('usage, prices and budgets (integration)', () => {
  let a1: Run; // project alpha, worker-mac, claude-code, anthropic/test-model-a
  let b1: Run; // project beta, worker-linux, codex, openai/test-model-b
  let s1: Run; // project alpha, worker-mac, claude-code, local-login subscription

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    const audit = new AuditLog(h.db.pool, h.clock.now);
    jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    store = new UsageStore({ pool: h.db.pool, audit, clock: h.clock.now });
    people.owner = await person('owner1', 'owner');
    people.admin = await person('admin1', 'admin');
    people.operator = await person('oper1', 'operator');
    people.viewer = await person('viewer1', 'viewer');
    a1 = await startJob('alpha', 'worker-mac', 'claude-code', 'test-model-a');
    b1 = await startJob('beta', 'worker-linux', 'codex', 'test-model-b');
    s1 = await startJob('alpha', 'worker-mac', 'claude-code');
  });
  afterAll(async () => {
    await h.stop();
  });

  describe('ingestion', () => {
    it('is idempotent per (attempt, source event id), also under concurrent replays', async () => {
      const ctx = { jobId: a1.jobId, attemptId: a1.attemptId, workerId: a1.workerId, sourceEventId: 'dup-1' };
      const ev = usage({
        inputTokens: 1000,
        outputTokens: 100,
        provenance: 'reported-by-runtime',
        costUsd: 0.25,
        provider: 'anthropic',
        turns: 2,
        durationMs: 5000,
      });
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => store.recordUsage(ev, ctx)));
      expect(results.filter((r) => r.status === 'recorded')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'duplicate' && !r.conflicting)).toHaveLength(4);
      const again = await store.recordUsage(ev, ctx);
      expect(again.status).toBe('duplicate');
      expect(again.record.id).toBe(results.find((r) => r.status === 'recorded')?.record.id);
      const { rows } = await h.db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM usage_records WHERE source_event_id = 'dup-1'",
      );
      expect(rows[0]?.n).toBe(1);
      expect(again.record).toMatchObject({
        project: 'alpha',
        runtime: 'claude-code',
        provider: 'anthropic',
        model: 'test-model-a', // from the job spec
        inputTokens: 1000,
        turns: 2,
        wallTimeMs: 5000,
        reportedCostUsd: 0.25,
        reportedProvenance: 'reported-by-runtime',
      });
    });

    it('a replay with different content is flagged and audited, never applied', async () => {
      const ctx = { jobId: a1.jobId, attemptId: a1.attemptId, workerId: a1.workerId, sourceEventId: 'dup-1' };
      const res = await store.recordUsage(usage({ inputTokens: 999_999, provenance: 'unknown' }), ctx);
      expect(res).toMatchObject({ status: 'duplicate', conflicting: true });
      expect(res.record.inputTokens).toBe(1000);
      expect(await auditCount('usage.record.conflict', 'denied')).toBe(1);
    });

    it('rejects another worker, a foreign attempt and non-usage events (audited)', async () => {
      const before = await auditCount('usage.record', 'denied');
      await expect(
        store.recordUsage(usage(), {
          jobId: a1.jobId,
          attemptId: a1.attemptId,
          workerId: 'worker-evil',
          sourceEventId: 'x-1',
        }),
      ).rejects.toMatchObject({ reason: 'worker_mismatch' });
      await expect(
        store.recordUsage(usage(), {
          jobId: a1.jobId,
          attemptId: b1.attemptId,
          workerId: b1.workerId,
          sourceEventId: 'x-2',
        }),
      ).rejects.toMatchObject({ reason: 'attempt_not_of_job' });
      await expect(
        store.recordUsage(
          { kind: 'message', role: 'assistant', text: 'hi' },
          { ...a1, sourceEventId: 'x-3' },
        ),
      ).rejects.toBeInstanceOf(UsageRejectedError);
      await expect(
        store.recordUsage(usage({ inputTokens: -1 }), { ...a1, sourceEventId: 'x-4' }),
      ).rejects.toMatchObject({ reason: 'invalid_event' });
      expect(await auditCount('usage.record', 'denied')).toBe(before + 4);
    });

    it('usage records are append-only', async () => {
      await expect(h.db.pool.query('UPDATE usage_records SET input_tokens = 0')).rejects.toMatchObject({
        code: 'RA000',
      });
      await expect(h.db.pool.query('DELETE FROM usage_records')).rejects.toMatchObject({ code: 'RA000' });
    });
  });

  describe('summaries and coverage', () => {
    beforeAll(async () => {
      // beta/codex: tokens only (Codex reports no dollars), price not yet known.
      await record(
        b1,
        usage({
          inputTokens: 2_000_000,
          outputTokens: 100_000,
          provenance: 'estimated-from-tokens',
          provider: 'openai',
          turns: 1,
        }),
      );
      // alpha: tokens only, model priced later.
      await record(
        a1,
        usage({ inputTokens: 1_000_000, outputTokens: 100_000, provider: 'anthropic', turns: 1 }),
      );
      // alpha: nothing but provenance -> unknown, tokens missing.
      await record(a1, usage());
      // alpha subscription run: tokens/time only.
      await record(
        s1,
        usage({
          inputTokens: 5000,
          outputTokens: 500,
          turns: 3,
          durationMs: 60_000,
          provider: 'anthropic',
          model: 'test-model-a',
          authMode: 'local-login',
          provenance: 'reported-by-runtime',
          costUsd: 9.99,
        }),
      );
    });

    it('groups by project with coverage counts, missing prices and subscription markers', async () => {
      const s = await summary('project');
      expect(s.priceTableVersion).toBe(0);
      const alpha = byKey(s.groups, 'alpha');
      expect(alpha.records).toBe(4);
      expect(alpha.coverage).toEqual({ reported: 1, estimated: 0, unknown: 2, subscription: 1 });
      expect(alpha.costUsd).toEqual({ reported: 0.25, estimated: 0, total: 0.25 });
      expect(alpha.flags).toMatchObject({ costComplete: false, hasSubscription: true, noPerRunCost: false });
      expect(alpha.missingPrices).toEqual([
        { provider: 'anthropic', model: 'test-model-a', reason: 'price_missing', records: 1 },
      ]);
      const beta = byKey(s.groups, 'beta');
      expect(beta.coverage).toEqual({ reported: 0, estimated: 0, unknown: 1, subscription: 0 });
      expect(beta.missingPrices).toEqual([
        { provider: 'openai', model: 'test-model-b', reason: 'price_missing', records: 1 },
      ]);
      expect(s.totals.records).toBe(5);
    });

    it('groups by worker, runtime, provider and model', async () => {
      const w = await summary('worker');
      expect(w.groups.map((g) => [g.key, g.records]).sort()).toEqual([
        ['worker-linux', 1],
        ['worker-mac', 4],
      ]);
      const r = await summary('runtime');
      expect(byKey(r.groups, 'codex').inputTokens).toBe(2_000_000);
      expect(byKey(r.groups, 'claude-code').records).toBe(4);
      const p = await summary('provider');
      expect(byKey(p.groups, null).records).toBe(1); // the event that reported nothing
      expect(byKey(p.groups, 'openai').records).toBe(1);
      const m = await summary('model');
      expect(byKey(m.groups, 'test-model-a').records).toBe(4);
      const sub = await summary('project', people.viewer, '&authMode=local-login');
      expect(byKey(sub.groups, 'alpha').flags).toMatchObject({ noPerRunCost: true, costComplete: true });
      expect(byKey(sub.groups, 'alpha').costUsd.total).toBe(0);
    });

    it('a price table version turns token-only records into estimates (and matches per-record costs)', async () => {
      await stepUp(people.admin);
      const put = await people.admin.client.req('PUT', '/usage/prices', {
        expectedVersion: 0,
        note: 'first',
        entries: PRICE_ENTRIES,
      });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json()).toMatchObject({
        version: 1,
        note: 'first',
        entries: [{ provider: 'anthropic', model: 'test-model-a' }],
      });

      const s = await summary('project');
      expect(s.priceTableVersion).toBe(1);
      const alpha = byKey(s.groups, 'alpha');
      expect(alpha.coverage).toEqual({ reported: 1, estimated: 1, unknown: 1, subscription: 1 });
      expect(alpha.costUsd.estimated).toBeCloseTo(1 + 1, 9); // 1M in @ $1 + 0.1M out @ $10
      expect(alpha.missingPrices).toEqual([]);

      const recs = await people.operator.client.req('GET', '/usage/records?project=alpha&limit=100');
      expect(recs.statusCode, recs.body).toBe(200);
      const items = recs.json<{
        items: { cost: { costClass: string; costUsd: number | null; provenance: string | null } }[];
      }>().items;
      const perRecord = items.reduce((sum, i) => sum + (i.cost.costUsd ?? 0), 0);
      expect(perRecord).toBeCloseTo(alpha.costUsd.total, 9);
      expect(items.map((i) => i.cost.costClass).sort()).toEqual([
        'estimated',
        'reported',
        'subscription',
        'unknown',
      ]);
      expect(items.find((i) => i.cost.costClass === 'subscription')?.cost).toMatchObject({
        costUsd: null,
        provenance: null,
      });
    });

    it('records paginate by keyset without gaps or repeats', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = `/usage/records?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await people.operator.client.req('GET', url);
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json<{ items: { id: string; recordedAt: string }[]; nextCursor: string | null }>();
        seen.push(...body.items.map((i) => i.id));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 20);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBe(5);
      const bad = await people.operator.client.req('GET', '/usage/records?cursor=bm9wZQ');
      expect(bad.statusCode).toBe(400);
    });

    it('p14-web-perf-2: `jobs` returns only those jobs’ records; a bad list is refused', async () => {
      const all = (await people.operator.client.req('GET', '/usage/records?limit=100')).json<{
        items: { id: string; jobId: string }[];
      }>().items;
      const jobs = [...new Set(all.map((i) => i.jobId))];
      expect(jobs.length).toBeGreaterThan(1);
      const pick = jobs.slice(0, 1);
      const res = await people.operator.client.req('GET', `/usage/records?jobs=${pick.join(',')}&limit=100`);
      expect(res.statusCode, res.body).toBe(200);
      const items = res.json<{ items: { id: string; jobId: string }[] }>().items;
      expect(items.length).toBe(all.filter((i) => i.jobId === pick[0]).length);
      expect(items.every((i) => i.jobId === pick[0])).toBe(true);
      const two = await people.operator.client.req('GET', `/usage/records?jobs=${jobs.join(',')}&limit=100`);
      expect(two.json<{ items: unknown[] }>().items.length).toBe(all.length);
      expect((await people.operator.client.req('GET', '/usage/records?jobs=not-a-uuid')).statusCode).toBe(
        400,
      );
    });
  });

  describe('authorization', () => {
    it('viewer: summaries yes, records no; writes need admin and a fresh step-up', async () => {
      expect((await people.viewer.client.req('GET', '/usage/summary')).statusCode).toBe(200);
      expect((await people.viewer.client.req('GET', '/usage/prices')).statusCode).toBe(200);
      expect((await people.viewer.client.req('GET', '/budgets')).statusCode).toBe(200);
      const recs = await people.viewer.client.req('GET', '/usage/records');
      expect(recs.statusCode).toBe(403);
      expect(recs.json()).toMatchObject({ error: 'forbidden' });

      await stepUp(people.operator);
      const op = await people.operator.client.req('PUT', '/usage/prices', {
        expectedVersion: 1,
        entries: [],
      });
      expect(op.statusCode).toBe(403);
      expect(op.json()).toMatchObject({ error: 'forbidden' });
      const opBudget = await people.operator.client.req('POST', '/budgets', {
        name: 'x',
        metric: 'tokens',
        limit: 10,
        scope: { type: 'global' },
        window: 'day',
      });
      expect(opBudget.statusCode).toBe(403);

      h.clock.advance(11 * 60_000);
      const stale = await people.admin.client.req('PUT', '/usage/prices', {
        expectedVersion: 1,
        entries: [],
      });
      expect(stale.statusCode).toBe(403);
      expect(stale.json()).toMatchObject({ error: 'step_up_required' });
      expect(await auditCount('usage.prices.update', 'denied')).toBeGreaterThanOrEqual(1);
    });
  });

  describe('price table versioning', () => {
    it('is optimistic, append-only, keeps history and validates entries', async () => {
      await stepUp(people.owner);
      const stale = await people.owner.client.req('PUT', '/usage/prices', {
        expectedVersion: 0,
        entries: [],
      });
      expect(stale.statusCode).toBe(409);
      const bad = await people.owner.client.req('PUT', '/usage/prices', {
        expectedVersion: 1,
        entries: [
          { ...PRICE_ENTRIES[0], source: '  ' },
          { ...PRICE_ENTRIES[0], inputUsdPerMTok: -1 },
        ],
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json<{ issues: { field: string; code: string }[] }>().issues).toEqual(
        expect.arrayContaining([
          { field: 'entries.0.source', code: 'required' },
          { field: 'entries.1.inputUsdPerMTok', code: 'out_of_range' },
          { field: 'entries.1', code: 'duplicate' },
        ]),
      );
      const v2 = await people.owner.client.req('PUT', '/usage/prices', {
        expectedVersion: 1,
        note: 'cleared',
        entries: [],
      });
      expect(v2.statusCode, v2.body).toBe(200);
      expect(v2.json()).toMatchObject({ version: 2, entries: [] });

      const v1 = await people.viewer.client.req('GET', '/usage/prices?version=1');
      expect(v1.json()).toMatchObject({ version: 1, entries: [{ model: 'test-model-a' }] });
      const versions = await people.viewer.client.req('GET', '/usage/prices/versions');
      expect(versions.json<{ items: { version: number }[] }>().items.map((v) => v.version)).toEqual([2, 1]);
      expect((await people.viewer.client.req('GET', '/usage/prices?version=9')).statusCode).toBe(404);
      // Estimates follow the current table: with v2 (empty) the alpha estimate is gone again.
      expect(byKey((await summary('project')).groups, 'alpha').coverage.estimated).toBe(0);
      await expect(h.db.pool.query('UPDATE usage_prices SET input_usd_per_mtok = 0')).rejects.toMatchObject({
        code: 'RA000',
      });
      await expect(h.db.pool.query('DELETE FROM usage_price_tables')).rejects.toMatchObject({
        code: 'RA000',
      });
      expect(await auditCount('usage.prices.update', 'success')).toBe(2);

      // Restore prices for the budget tests.
      const v3 = await people.owner.client.req('PUT', '/usage/prices', {
        expectedVersion: 2,
        entries: PRICE_ENTRIES,
      });
      expect(v3.statusCode).toBe(200);
    });
  });

  describe('budgets', () => {
    let budgetId = '';

    it('CRUD with optimistic versions, step-up and audit', async () => {
      await stepUp(people.admin);
      const created = await people.admin.client.req('POST', '/budgets', {
        name: 'Gamma tokens',
        metric: 'tokens',
        limit: 1000,
        scope: { type: 'project', value: 'gamma' },
        window: 'month',
        // p8-cost-efficiency: new budgets default to 50/80/100 %; this one keeps the p6 pair.
        thresholds: [80, 100],
      });
      expect(created.statusCode, created.body).toBe(201);
      const body = created.json<{
        budget: { id: string; version: number };
        evaluation: { status: string; used: number };
      }>();
      budgetId = body.budget.id;
      expect(body.evaluation).toMatchObject({ status: 'under', used: 0 });

      const invalid = await people.admin.client.req('POST', '/budgets', {
        name: '',
        metric: 'turns',
        limit: 1.5,
        scope: { type: 'runtime', value: 'emacs' },
        window: 'day',
      });
      expect(invalid.statusCode).toBe(400);
      expect(
        invalid
          .json<{ issues: { field: string }[] }>()
          .issues.map((i) => i.field)
          .sort(),
      ).toEqual(['limit', 'name', 'scopeValue']);

      const updated = await people.admin.client.req('PUT', `/budgets/${budgetId}`, {
        name: 'Gamma tokens',
        metric: 'tokens',
        limit: 2000,
        scope: { type: 'project', value: 'gamma' },
        window: 'month',
        expectedVersion: 1,
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json()).toMatchObject({ budget: { version: 2, limit: 2000 } });
      const conflict = await people.admin.client.req('PUT', `/budgets/${budgetId}`, {
        name: 'x',
        metric: 'tokens',
        limit: 5,
        scope: { type: 'global' },
        window: 'day',
        expectedVersion: 1,
      });
      expect(conflict.statusCode).toBe(409);

      const list = await people.viewer.client.req('GET', '/budgets');
      expect(list.json<{ items: { budget: { id: string } }[] }>().items.map((i) => i.budget.id)).toContain(
        budgetId,
      );
      const one = await people.viewer.client.req('GET', `/budgets/${budgetId}`);
      expect(one.statusCode).toBe(200);
      expect(
        (await people.viewer.client.req('GET', '/budgets/00000000-0000-4000-8000-00000000dead')).statusCode,
      ).toBe(404);

      expect(await auditCount('usage.budget.create', 'success')).toBe(1);
      expect(await auditCount('usage.budget.update', 'success')).toBe(1);
      expect(await auditCount('usage.budget.create', 'denied')).toBeGreaterThanOrEqual(2);
    });

    it('announces 80 % and 100 % crossings once each via outbox; replays do not re-announce', async () => {
      const g = await startJob('gamma', 'worker-pi', 'pi');
      const first = await record(
        g,
        usage({ inputTokens: 1000, outputTokens: 500, provider: 'anthropic', model: 'test-model-a' }),
      );
      expect(first.alerts).toEqual([]);
      const second = await record(
        g,
        usage({ inputTokens: 100, outputTokens: 100, provider: 'anthropic', model: 'test-model-a' }),
      );
      expect(second.alerts.map((a) => a.level)).toEqual(['warning']);
      expect(second.alerts[0]?.evaluation).toMatchObject({ used: 1700, status: 'warning', complete: true });
      const third = await record(
        g,
        usage({ inputTokens: 400, outputTokens: 0, provider: 'anthropic', model: 'test-model-a' }),
      );
      expect(third.alerts.map((a) => a.level)).toEqual(['exceeded']);
      const replay = await store.recordUsage(
        usage({ inputTokens: 400, outputTokens: 0, provider: 'anthropic', model: 'test-model-a' }),
        {
          ...g,
          sourceEventId: `msg-${String(eventSeq)}`,
        },
      );
      expect(replay).toMatchObject({ status: 'duplicate', alerts: [] });
      const fourth = await record(g, usage({ inputTokens: 1, outputTokens: 1 }));
      expect(fourth.alerts).toEqual([]);

      const { rows } = await h.db.pool.query<{ payload: unknown; job_id: string }>(
        'SELECT payload, job_id FROM outbox WHERE topic = $1 ORDER BY id',
        [OUTBOX_TOPIC_BUDGET_THRESHOLD],
      );
      expect(rows).toHaveLength(2);
      const payloads = rows.map((r) => BudgetThresholdOutboxPayload.parse(r.payload));
      expect(payloads.map((p) => [p.budgetId, p.level, p.status, p.jobId])).toEqual([
        [budgetId, 'warning', 'warning', g.jobId],
        [budgetId, 'exceeded', 'over', g.jobId],
      ]);
      expect(await auditCount('usage.budget.threshold', 'success')).toBe(2);
      const evaluation = await store.evaluateBudget(budgetId);
      expect(evaluation).toMatchObject({ status: 'over', used: 2102, records: 4 });
    });

    it('a dollar budget with unknown-cost records evaluates to unknown, never under', async () => {
      await stepUp(people.owner);
      const res = await people.owner.client.req('POST', '/budgets', {
        name: 'Beta dollars',
        metric: 'cost_usd',
        limit: 1000,
        scope: { type: 'project', value: 'beta' },
        window: 'month',
      });
      expect(res.statusCode, res.body).toBe(201);
      // beta has one token-only codex record with no price for openai/test-model-b.
      expect(res.json()).toMatchObject({
        evaluation: { status: 'unknown', complete: false, unknownRecords: 1, used: 0 },
      });
      const forBeta = await store.evaluateBudgetsFor({
        project: 'beta',
        runtime: 'codex',
        worker: 'worker-linux',
        provider: 'openai',
      });
      expect(forBeta.map((b) => b.evaluation.status)).toEqual(['unknown']);
    });

    it('soft delete with expectedVersion; deleted budgets are immutable and hidden', async () => {
      await stepUp(people.admin);
      const del = await people.admin.client.req('DELETE', `/budgets/${budgetId}?expectedVersion=2`);
      expect(del.statusCode, del.body).toBe(200);
      expect(del.json()).toMatchObject({ budget: { version: 3 } });
      const list = await people.viewer.client.req('GET', '/budgets');
      expect(
        list.json<{ items: { budget: { id: string } }[] }>().items.map((i) => i.budget.id),
      ).not.toContain(budgetId);
      const again = await people.admin.client.req('DELETE', `/budgets/${budgetId}?expectedVersion=3`);
      expect(again.statusCode).toBe(404);
      await expect(h.db.pool.query('DELETE FROM usage_budgets')).rejects.toMatchObject({ code: 'RA000' });
      await expect(
        h.db.pool.query(
          "UPDATE usage_budgets SET name = 'z', version = version + 1 WHERE deleted_at IS NOT NULL",
        ),
      ).rejects.toMatchObject({ code: 'RA000' });
      expect(await auditCount('usage.budget.delete', 'success')).toBe(1);
      expect((await verifyChain(h.db.pool)).ok).toBe(true);
    });
  });
});
