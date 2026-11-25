import { randomUUID } from 'node:crypto';
import { MEMORY_PROPOSAL_NOTE } from '@remyral/memory';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import type { Role } from '../../src/auth/users.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { ContextStore } from '../../src/context/index.js';
import { JobStore } from '../../src/jobs/index.js';
import { ServiceEffects, StoreContextProvider } from '../../src/orchestration/effects.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { jobSpec } from '../helpers/job-worker.js';

/**
 * p11-memory-layers (docs/design/p11-memory-layers.md, ADR-0043) end to end against Postgres: typed records over REST,
 * scope precedence in the job bundle (global → the creator's personal rules → project → runtime lessons), budget
 * priority, superseded / expired / rejected never injected (while pinned bundles stay reproducible), conflict
 * suggestions, review-by reminders, agents' LESSON: / MEMORY: lines landing in the inbox (never accepted by
 * themselves), identical rendering for every runtime, and the chat's memory_change card.
 */

const PW = 'quartz-meadow-lantern-7';
const P = 'memlayers';

interface RecordJson {
  id: string;
  type: string;
  scope: string;
  status: string;
  title: string;
  content: string;
  version: number;
  supersedes: string | null;
  supersededBy: string | null;
  reviewDue: boolean;
  author: string;
  canWrite: boolean;
}
interface ConflictJson {
  id: string;
  record: { id: string };
  other: { id: string };
  reason: string;
}

describeIntegration('memory layers (integration)', { timeout: 180_000 }, () => {
  const h = new Harness();
  const users: Record<
    'owner' | 'admin' | 'op' | 'op2' | 'viewer',
    { id: string; secret: string; client: Client }
  > = {} as never;
  let jobs: JobStore;
  let context: ContextStore;
  let chatStore: ChatStore;

  beforeAll(async () => {
    // p17-auto-learning is covered by memory-autolearn.test.ts; here agent proposals wait for a person.
    await h.start({ memorySuggestions: { autoLearn: false } });
    for (const [key, role] of [
      ['owner', 'owner'],
      ['admin', 'admin'],
      ['op', 'operator'],
      ['op2', 'operator'],
      ['viewer', 'viewer'],
    ] as const) {
      const name = `${key}.memlayers`;
      const id = await h.createUser(name, PW, role);
      if (role === 'operator' || role === 'viewer') await h.grant(id, [P], role);
      const { secret } = await enroll(h, name, PW);
      users[key] = { id, secret, client: await fullLogin(h, name, PW, secret) };
    }
    const audit = new AuditLog(h.db.pool, h.clock.now);
    jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    context = new ContextStore({ pool: h.db.pool, audit, clock: h.clock.now });
    chatStore = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
  });
  afterAll(async () => {
    await h.stop();
  });

  type Key = keyof typeof users;
  async function create(key: Key, body: Record<string, unknown>, status = 200) {
    const res = await users[key].client.req('POST', '/memory-records', body);
    expect(res.statusCode, res.body).toBe(status);
    return res.json<{ record: RecordJson; conflicts: ConflictJson[] }>();
  }
  async function job(
    runtime: string,
    creator: Key = 'op',
    prompt = 'fix the flaky deploy test',
  ): Promise<string> {
    const { job: j } = await jobs.create({
      project: P,
      spec: jobSpec({ runtime, prompt, projectId: P }),
      actor: { type: 'user', id: users[creator].id },
      submit: true,
    });
    return j.id;
  }
  async function issued(jobId: string, worker = 'w-1') {
    return context.issueForJob(jobId, { type: 'worker', id: worker });
  }

  const ids: Record<string, string> = {};

  it('typed records over REST: operators write project records, viewers read, global needs an admin', async () => {
    ids.rule = (
      await create('op', {
        scope: `project:${P}`,
        type: 'rule',
        statement: 'Run pnpm test before every commit.',
      })
    ).record.id;
    const d = await create('op', {
      scope: `project:${P}`,
      type: 'decision',
      statement: 'Deploy staging with Coolify',
      rationale: 'One host is cheaper than two clouds.',
      consequences: 'No Vercel previews.',
      decidedOn: '2026-10-19',
      decidedBy: 'Alex',
      evidence: [{ kind: 'adr', ref: 'docs/adr/0028-master-held-deploy-tokens-and-ops-actions.md' }],
    });
    ids.decision = d.record.id;
    expect(d.record.content).toBe(
      'Decision: Deploy staging with Coolify\nContext: One host is cheaper than two clouds.\nConsequences: No Vercel previews.\nDecided: 2026-10-19 by Alex',
    );
    ids.fact = (
      await create('op', {
        scope: `project:${P}`,
        type: 'fact',
        statement: 'The brand primary colour is #FF5A1F.',
      })
    ).record.id;
    ids.lesson = (
      await create('op', {
        scope: `project:${P}+runtime:codex`,
        type: 'lesson',
        statement: 'Codex needs the sandbox network flag for pnpm install.',
      })
    ).record.id;
    await create('viewer', { scope: `project:${P}`, type: 'fact', statement: 'x is y' }, 403);
    await create('op', { scope: 'global', type: 'rule', statement: 'Never force-push.' }, 403);
    ids.global = (
      await create('admin', { scope: 'global', type: 'rule', statement: 'Never force-push to main.' })
    ).record.id;
    await create(
      'op',
      { scope: `project:${P}`, type: 'fact', statement: 'decided', consequences: 'nope' },
      400,
    );
    await create(
      'op',
      { scope: `project:${P}+runtime:codex`, type: 'decision', statement: 'no runtime decisions' },
      400,
    );
    const secret = ['sk', 'ant', 'api03', 'Qw7Er9Ty2Ui4Op6As8Df1Gh3Jk5Lz0Xc'].join('-');
    await create('op', { scope: `project:${P}`, type: 'fact', statement: `key ${secret}` }, 400);

    const list = await users.viewer.client.req(
      'GET',
      `/memory-records?scope=project&project=${P}&type=decision,fact`,
    );
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json<{ items: RecordJson[] }>().items;
    expect(items.map((r) => r.type).sort()).toEqual(['decision', 'fact']);
    expect(items.every((r) => !r.canWrite)).toBe(true);
    const decisions = await users.viewer.client.req('GET', `/memory-records/decisions?project=${P}`);
    expect(decisions.json<{ items: RecordJson[] }>().items.map((r) => r.id)).toEqual([ids.decision]);
  });

  it('personal rules: only their owner sees and changes them (viewers too)', async () => {
    const add = await users.op.client.req('POST', '/memory-records/personal', {
      statement: 'Write commit messages in English.',
    });
    expect(add.statusCode, add.body).toBe(200);
    ids.personal = add.json<{ record: RecordJson }>().record.id;
    const other = await users.op2.client.req('POST', '/memory-records/personal', {
      statement: 'Answer me in Turkish.',
    });
    expect(other.statusCode).toBe(200);
    ids.otherPersonal = other.json<{ record: RecordJson }>().record.id;
    const viewerOwn = await users.viewer.client.req('POST', '/memory-records/personal', {
      statement: 'Be brief.',
    });
    expect(viewerOwn.statusCode, viewerOwn.body).toBe(200);
    const mine = await users.op.client.req('GET', '/memory-records/personal');
    expect(mine.json<{ items: RecordJson[] }>().items.map((r) => r.id)).toEqual([ids.personal]);
    for (const key of ['admin', 'owner', 'op2'] as const) {
      expect((await users[key].client.req('GET', `/memory-records/${ids.personal}`)).statusCode).toBe(404);
    }
    // A personal rule cannot be written into someone else's scope, nor be anything but a rule.
    await create('admin', { scope: `user:${users.op.id}`, type: 'rule', statement: 'smuggled' }, 403);
    await create('op', { scope: `user:${users.op.id}`, type: 'fact', statement: 'not a rule' }, 400);
  });

  it('bundle precedence: global rules → the creator’s personal rules → project rules → decisions → facts → runtime lessons; identical text for every runtime', async () => {
    const codexJob = await job('codex', 'op');
    const b = (await issued(codexJob)).bundle;
    expect(b.items.map((i) => [i.layer, i.recordType ?? null, i.docId])).toEqual([
      ['platform', null, 'platform-policy'],
      ['global', 'rule', ids.global],
      ['user', 'rule', ids.personal],
      ['project', 'rule', ids.rule],
      ['memory', 'decision', ids.decision],
      ['memory', 'fact', ids.fact],
      ['memory', 'lesson', ids.lesson],
    ]);
    expect(b.items.some((i) => i.docId === ids.otherPersonal)).toBe(false);
    // A job op2 creates gets op2's rules, not op's.
    const op2Job = (await issued(await job('codex', 'op2'))).bundle;
    expect(op2Job.items.filter((i) => i.layer === 'user').map((i) => i.docId)).toEqual([ids.otherPersonal]);
    // Claude Code / Pi / OpenCode jobs of the same creator: no codex lesson, otherwise byte-identical text.
    const provider = new StoreContextProvider(context);
    const texts = [];
    for (const runtime of ['claude-code', 'pi', 'opencode'])
      texts.push((await provider.issue(await job(runtime), 'w-2')).rendered);
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toContain(MEMORY_PROPOSAL_NOTE);
    expect(texts[0]).not.toContain('sandbox network flag');
    expect((await provider.issue(codexJob, 'w-1')).rendered).toContain('sandbox network flag');
    ids.pinnedJob = codexJob;
  });

  it('superseded, expired and rejected records are never injected; pinned bundles stay reproducible; the job page shows what was pinned', async () => {
    const first = await issued(ids.pinnedJob ?? '');
    const repl = await create('op', {
      scope: `project:${P}`,
      type: 'rule',
      statement: 'Run pnpm verify before every commit.',
      supersedes: ids.rule,
    });
    expect(repl.record.supersedes).toBe(ids.rule);
    const old = await users.op.client.req('GET', `/memory-records/${ids.rule ?? ''}`);
    expect(old.json<{ record: RecordJson; related: RecordJson[] }>()).toMatchObject({
      record: { status: 'superseded', supersededBy: repl.record.id },
      related: [{ id: repl.record.id }],
    });
    const expire = await users.op.client.req('POST', `/memory-records/${ids.fact ?? ''}/status`, {
      status: 'expired',
      reason: 'rebrand',
    });
    expect(expire.statusCode, expire.body).toBe(200);
    const rejected = await create('op', {
      scope: `project:${P}`,
      type: 'fact',
      statement: 'Staging lives in Frankfurt.',
    });
    await users.op.client.req('POST', `/memory-records/${rejected.record.id}/status`, { status: 'rejected' });
    const timed = await create('op', {
      scope: `project:${P}`,
      type: 'fact',
      statement: 'The release freeze lasts until Friday.',
      expiresAt: new Date(h.clock.now().getTime() + 60_000).toISOString(),
    });
    h.clock.advance(120_000);
    // Past expiry: excluded at once (even before the sweep marks it).
    const fresh = (await issued(await job('codex'))).bundle.items.map((i) => i.docId);
    expect(fresh).toContain(repl.record.id);
    for (const gone of [ids.rule, ids.fact, rejected.record.id, timed.record.id])
      expect(fresh).not.toContain(gone);
    expect(await h.app.memoryRecords.sweep()).toMatchObject({ expired: 1 });
    expect(
      (await users.op.client.req('GET', `/memory-records/${timed.record.id}`)).json<{ record: RecordJson }>()
        .record.status,
    ).toBe('expired');
    // The earlier job keeps exactly what it was given.
    const again = await issued(ids.pinnedJob ?? '', 'w-other');
    expect(again.bundle.bundleHash).toBe(first.bundle.bundleHash);
    const injected = await users.viewer.client.req('GET', `/memory-records/jobs/${ids.pinnedJob ?? ''}`);
    expect(injected.statusCode, injected.body).toBe(200);
    const items = injected.json<{
      pinned: boolean;
      items: {
        docId: string;
        recordType: string | null;
        statusNow: string | null;
        title: string | null;
        layer: string;
      }[];
    }>();
    expect(items.pinned).toBe(true);
    expect(items.items.find((i) => i.docId === ids.rule)).toMatchObject({
      recordType: 'rule',
      statusNow: 'superseded',
    });
    // The creator's personal rule is visible to its owner only: others see that one existed.
    const userItem = items.items.find((i) => i.layer === 'user');
    expect(userItem).toMatchObject({ docId: '', title: null });
    const asOwner = await users.op.client.req('GET', `/memory-records/jobs/${ids.pinnedJob ?? ''}`);
    expect(
      asOwner.json<{ items: { layer: string; docId: string }[] }>().items.find((i) => i.layer === 'user')
        ?.docId,
    ).toBe(ids.personal);
    // A superseded record cannot simply be reactivated.
    expect(
      (await users.op.client.req('POST', `/memory-records/${ids.rule ?? ''}/status`, { status: 'active' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await users.op.client.req('POST', `/memory-records/${ids.fact ?? ''}/status`, { status: 'active' }))
        .statusCode,
    ).toBe(200);
  });

  it('conflicts: a contradicting record of the same type becomes "this may replace" for a person', async () => {
    const a = await create('op', {
      scope: `project:${P}`,
      type: 'fact',
      statement: 'This repository uses pnpm for installs.',
    });
    expect(a.conflicts).toEqual([]);
    const b = await create('op', {
      scope: `project:${P}`,
      type: 'fact',
      statement: 'This repository uses yarn for installs.',
    });
    expect(b.conflicts).toHaveLength(1);
    expect(b.conflicts[0]).toMatchObject({
      record: { id: b.record.id },
      other: { id: a.record.id },
      reason: 'different_choice',
    });
    const list = await users.viewer.client.req('GET', `/memory-records/conflicts?project=${P}`);
    expect(list.json<{ items: ConflictJson[] }>().items.map((c) => c.id)).toContain(b.conflicts[0]?.id);
    expect(
      (
        await users.viewer.client.req(
          'POST',
          `/memory-records/conflicts/${b.conflicts[0]?.id ?? ''}/resolve`,
          { decision: 'supersede' },
        )
      ).statusCode,
    ).toBe(403);
    const res = await users.op.client.req(
      'POST',
      `/memory-records/conflicts/${b.conflicts[0]?.id ?? ''}/resolve`,
      {
        decision: 'supersede',
      },
    );
    expect(res.statusCode, res.body).toBe(204);
    const old = await users.op.client.req('GET', `/memory-records/${a.record.id}`);
    expect(old.json<{ record: RecordJson }>().record).toMatchObject({
      status: 'superseded',
      supersededBy: b.record.id,
    });
    expect(
      (await users.viewer.client.req('GET', `/memory-records/conflicts?project=${P}`)).json<{
        items: ConflictJson[];
      }>().items,
    ).toEqual([]);
  });

  it('review-by: one reminder per date (outbox → notification), Needs you, mark reviewed', async () => {
    const today = h.clock.now().toISOString().slice(0, 10);
    const r = await create('op', {
      scope: `project:${P}`,
      type: 'decision',
      statement: 'Keep the monolith for now',
      reviewBy: today,
    });
    expect(r.record.reviewDue).toBe(true);
    expect(await h.app.memoryRecords.sweep()).toMatchObject({ reviewDue: 1 });
    expect(await h.app.memoryRecords.sweep()).toMatchObject({ reviewDue: 0 });
    const { rows } = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE topic = 'memory_review' AND payload->>'docId' = $1`,
      [r.record.id],
    );
    expect(rows[0]?.n).toBe(1);
    const due = await users.op.client.req('GET', '/memory-records/review-due');
    expect(due.json<{ items: RecordJson[] }>().items.map((x) => x.id)).toContain(r.record.id);
    const next = new Date(h.clock.now().getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    const ok = await users.op.client.req('POST', `/memory-records/${r.record.id}/reviewed`, {
      reviewBy: next,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(
      (await users.op.client.req('GET', '/memory-records/review-due'))
        .json<{ items: RecordJson[] }>()
        .items.map((x) => x.id),
    ).not.toContain(r.record.id);
    const hist = await users.op.client.req('GET', `/memory-records/${r.record.id}`);
    expect(hist.json<{ events: { action: string }[] }>().events.map((e) => e.action)).toEqual([
      'reviewed',
      'review_due',
      'created',
    ]);
  });

  it('agents: LESSON: / MEMORY: lines of a running job’s output become typed suggestions — never context by themselves', async () => {
    const jobId = await job('codex');
    const grant = await jobs.acquireLease(jobId, 'worker-mem', 3_600_000);
    const effects = new ServiceEffects({
      usage: {} as never,
      approvals: {} as never,
      context,
      replay: () => ({}) as never,
      log: h.app.log,
      db: h.db.pool,
      suggestions: h.app.memorySuggestions,
    });
    const event = (text: string) =>
      ({
        type: 'EVENT',
        jobId,
        messageId: randomUUID(),
        payload: {
          attemptId: grant.attempt.id,
          epoch: grant.lease.epoch,
          event: { kind: 'message', role: 'assistant', text },
        },
      }) as never;
    const answer = [
      'All tests pass.',
      'LESSON: Codex sandbox — pnpm install needs the network flag in this repository.',
      'MEMORY: Package manager — this repository uses npm for installs.',
    ].join('\n');
    const before = (await h.db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM memory_records'))
      .rows[0]?.n;
    await effects.run('inbox-1', 'worker-mem', event(answer));
    await effects.run('inbox-1', 'worker-mem', event(answer)); // a retried effect: no duplicates
    const inbox = await users.viewer.client.req('GET', `/memory-suggestions?project=${P}`);
    const items = inbox
      .json<{
        items: {
          id: string;
          source: string;
          recordType: string;
          runtime: string | null;
          title: string;
          replaces: { documentId: string; reason: string } | null;
        }[];
      }>()
      .items.filter((s) => s.source === 'agent');
    expect(items.map((s) => [s.recordType, s.runtime, s.title]).sort()).toEqual([
      ['fact', null, 'Package manager'],
      ['lesson', 'codex', 'Codex sandbox'],
    ]);
    // npm vs the active "uses yarn" fact: offered as a replacement, not applied.
    const pm = items.find((s) => s.recordType === 'fact');
    expect(pm?.replaces).toMatchObject({ reason: 'different_choice' });
    expect(
      (await h.db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM memory_records')).rows[0]?.n,
    ).toBe(before);
    // A stale worker (not the current attempt's) is refused.
    await effects.run(
      'inbox-2',
      'worker-other',
      event('LESSON: Spoofed — a worker that does not run the job'),
    );
    expect(
      (
        await h.db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM memory_suggestions WHERE title = 'Spoofed'`,
        )
      ).rows[0]?.n,
    ).toBe(0);
    // Accepting: a lesson scoped to project + codex, authored by the runtime, with the job as evidence.
    const lesson = items.find((s) => s.recordType === 'lesson');
    const acc = await users.op.client.req('POST', `/memory-suggestions/${lesson?.id ?? ''}/accept`, {});
    expect(acc.statusCode, acc.body).toBe(200);
    expect(acc.json<{ record: RecordJson }>().record).toMatchObject({
      type: 'lesson',
      scope: `project:${P}+runtime:codex`,
      author: 'runtime',
    });
    const acc2 = await users.op.client.req('POST', `/memory-suggestions/${pm?.id ?? ''}/accept`, {
      supersedes: pm?.replaces?.documentId,
    });
    expect(acc2.statusCode, acc2.body).toBe(200);
    const replaced = await users.op.client.req('GET', `/memory-records/${pm?.replaces?.documentId ?? ''}`);
    expect(replaced.json<{ record: RecordJson }>().record.status).toBe('superseded');
  });

  it('chat: draft_memory_change makes a card; nothing changes until the user confirms it', async () => {
    const tools = new ChatTools({
      db: h.db.pool,
      store: chatStore,
      clock: h.clock.now,
      memoryRecords: h.app.memoryRecords,
    } as unknown as ChatToolsDeps);
    const caller = async (key: Key, role: Role): Promise<ToolCaller> => ({
      userId: users[key].id,
      subject: await loadSubject(h.db.pool, { id: users[key].id, role }),
      threadId: (await chatStore.createThread(users[key].id, 'memory')).id,
      turnId: randomUUID(),
    });
    const op = await caller('op', 'operator');
    const out = await tools.run(op, 'draft_memory_change', {
      action: 'add',
      scope: `project:${P}`,
      type: 'rule',
      statement: 'Always open a pull request; never push to main.',
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const draftId = (out as { draft: { id: string } }).draft.id;
    const count = async () =>
      (
        await h.db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM memory_records WHERE statement LIKE 'Always open a pull request%'`,
        )
      ).rows[0]?.n;
    expect(await count()).toBe(0);
    expect(
      await tools.run(await caller('viewer', 'viewer'), 'draft_memory_change', {
        action: 'add',
        scope: `project:${P}`,
        type: 'rule',
        statement: 'viewer rule',
      }),
    ).toMatchObject({ ok: false, code: 'forbidden' });
    expect(
      await tools.run(op, 'draft_memory_change', {
        action: 'add',
        scope: 'user:me',
        type: 'fact',
        statement: 'x is a fact',
      }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    h.clock.advance(30_000);
    const s = await users.op.client.req('POST', '/auth/step-up', { code: h.code(users.op.secret) });
    expect(s.statusCode, s.body).toBe(200);
    const confirmed = await users.op.client.req('POST', `/chat/drafts/${draftId}/confirm`);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await count()).toBe(1);
    const personal = await tools.run(op, 'draft_memory_change', {
      action: 'add',
      scope: 'user:me',
      type: 'rule',
      statement: 'Summaries in Turkish please.',
    });
    expect(personal).toMatchObject({ ok: true, data: { scope: `user:${users.op.id}` } });
  });
});
