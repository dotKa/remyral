import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p18-leftovers (docs/design/p18-leftovers.md) on real Postgres and the real routes:
 *
 * - automation groups: "Projeye ekle" creates the group's automation in a new project (refusals listed, already in the
 *   group refused), the whole group paused / resumed / deleted in one action with the siblings the caller may not
 *   change listed; audited `automation.group.add_projects` / `.pause` / `.resume` / `.delete`;
 * - the chat group card: a webhook trigger stays one project at a time, a GitHub trigger needs worker 1.2.2;
 * - budgets through the chat (`draft_budget_change`, worker feature assistant-budgets-v1): refused on an older worker,
 *   a card confirmed by an administrator with a fresh code writes through the console's store (audited
 *   `usage.budget.create` / `usage.budget.update`), raising a limit is a card by default;
 * - plans: a "ready for review" notification once per new plan, and the plan's text in the owner's meaning search
 *   (`GET /chat/search`, keyword fallback here).
 */
const PW = 'saffron-harbor-crane-31';
const A = 'lo-alpha';
const B = 'lo-beta';
const C = 'lo-gamma';
const D = 'lo-delta';

const SPEC = {
  runtime: 'codex',
  prompt: 'Summarise the notes of the week.',
  sandboxProfile: 'container',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
};

interface Group {
  members: { id: string; project: string; state: string; canEdit: boolean }[];
  hidden: number;
}

describeIntegration('p18 leftovers (integration)', { timeout: 300_000 }, () => {
  const h = new Harness();
  let owner: Client;
  let ownerSecret = '';
  let ownerId = '';
  let op: Client;
  let opSecret = '';
  let opId = '';

  const stepUp = async (c: Client, secret: string): Promise<void> => {
    h.clock.advance(31_000);
    const res = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
    expect(res.statusCode, res.body).toBe(200);
  };
  const audits = async (action: string) =>
    (
      await h.db.pool.query<{ metadata: Record<string, unknown>; outcome: string }>(
        'SELECT metadata, outcome FROM audit_events WHERE action = $1 ORDER BY id',
        [action],
      )
    ).rows;

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0 } });
    ownerId = await h.createUser('owner.lo', PW);
    ownerSecret = (await enroll(h, 'owner.lo', PW)).secret;
    owner = await fullLogin(h, 'owner.lo', PW, ownerSecret);
    // op: operator in A, B and C, viewer in D.
    opId = await h.createUser('op.lo', PW, 'operator');
    await h.grant(opId, [A, B, C], 'operator');
    await h.grant(opId, [D], 'viewer');
    opSecret = (await enroll(h, 'op.lo', PW)).secret;
    op = await fullLogin(h, 'op.lo', PW, opSecret);
    for (const p of [A, B, C, D]) {
      await h.db.pool.query(
        `INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING`,
        [p],
      );
      await h.db.pool.query(`UPDATE projects SET kind = 'workspace' WHERE id = $1`, [p]);
      await h.db.pool.query(
        `INSERT INTO project_workspaces (project, egress, updated_at) VALUES ($1, 'none', now()) ON CONFLICT DO NOTHING`,
        [p],
      );
    }
  });
  afterAll(async () => {
    await h.stop();
  });

  describe('automation groups', () => {
    let groupId = '';

    it('adds the group’s automation to a new project; the others are listed with their reason', async () => {
      await stepUp(owner, ownerSecret);
      const made = await owner.req('POST', '/automation-groups', {
        projects: [A, D],
        name: 'Weekly notes',
        trigger: { kind: 'cron', cron: '0 3 * * 1' },
        target: { kind: 'job', spec: SPEC },
        maxRunsPerHour: 5,
      });
      expect(made.statusCode, made.body).toBe(201);
      groupId = made.json<{ groupId: string }>().groupId;

      await stepUp(op, opSecret);
      const res = await op.req('POST', `/automation-groups/${groupId}/projects`, {
        projects: [B, A, 'lo-nowhere'],
      });
      expect(res.statusCode, res.body).toBe(201);
      const out = res.json<{
        group: Group;
        created: {
          project: string;
          automation: { id: string; maxRunsPerHour: number; group: { id: string } };
        }[];
        refused: { project: string; code: string }[];
      }>();
      expect(out.created.map((c) => c.project)).toEqual([B]);
      expect(out.created[0]?.automation).toMatchObject({ maxRunsPerHour: 5, group: { id: groupId } });
      expect(out.refused.map((r) => `${r.project}:${r.code}`)).toEqual([
        `${A}:already_in_group`,
        'lo-nowhere:project_not_found',
      ]);
      expect(out.group.members.map((m) => m.project).sort()).toEqual([A, B, D]);
      expect((await audits('automation.group.add_projects')).at(-1)?.metadata).toMatchObject({
        created: [out.created[0]?.automation.id],
      });
    });

    it('pauses, resumes and deletes the whole group; a sibling the caller may not change is listed', async () => {
      await stepUp(op, opSecret);
      const paused = await op.req('POST', `/automation-groups/${groupId}/pause`, {});
      expect(paused.statusCode, paused.body).toBe(200);
      const p = paused.json<{
        done: { project: string; state: string }[];
        skipped: { project: string; code: string }[];
      }>();
      expect(p.done.map((d) => `${d.project}:${d.state}`).sort()).toEqual([`${A}:paused`, `${B}:paused`]);
      expect(p.skipped).toEqual([expect.objectContaining({ project: D, code: 'forbidden' })]);
      expect((await audits('automation.group.pause')).at(-1)?.metadata).toMatchObject({
        skipped: [`${D}:forbidden`],
      });

      const resumed = await op.req('POST', `/automation-groups/${groupId}/resume`, {});
      expect(resumed.statusCode, resumed.body).toBe(200);
      expect(resumed.json<{ done: unknown[] }>().done).toHaveLength(2);

      const deleted = await op.req('DELETE', `/automation-groups/${groupId}`);
      expect(deleted.statusCode, deleted.body).toBe(200);
      const d = deleted.json<{ done: { state: string }[]; group: Group | null }>();
      expect(d.done.every((x) => x.state === 'deleted')).toBe(true);
      // D's sibling stays (the operator may only read it).
      expect(d.group?.members.map((m) => m.project)).toEqual([D]);
      expect((await audits('automation.group.delete')).at(-1)?.metadata).toMatchObject({
        skipped: [`${D}:forbidden`],
      });
    });
  });

  describe('the chat', () => {
    const tools = (): ChatTools => {
      const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      const app = h.app;
      return new ChatTools({
        db: h.db.pool,
        store,
        clock: h.clock.now,
        automations: () => app.automations,
        threadProjects: () => app.threadProjects,
        opsTools: () => app.chatOpsTools,
      } as unknown as ChatToolsDeps);
    };
    const ctx = async (userId: string, role: 'owner' | 'operator', extra: Record<string, unknown> = {}) => {
      const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      return {
        userId,
        subject: await loadSubject(h.db.pool, { id: userId, role }),
        threadId: (await store.createThread(userId, 'leftovers')).id,
        turnId: randomUUID(),
        ...extra,
      };
    };

    it('a group card keeps webhook triggers one project at a time; GitHub needs worker 1.2.2', async () => {
      const c = await ctx(opId, 'operator', { projects: [A, B], projectRules: true });
      const base = { projects: [A, B], name: 'Hooks', prompt: 'Do it.', runtime: 'codex' };
      const hook = await tools().run(c, 'draft_automation', { ...base, trigger: { kind: 'webhook' } });
      expect(!hook.ok && hook.message).toMatch(/one project at a time/);
      const gh = { kind: 'github', repository: 'acme/app', event: 'push' };
      const legacy = await tools().run(c, 'draft_automation', { ...base, trigger: gh });
      expect(!legacy.ok && legacy.message).toMatch(/one project at a time/);
      // On 1.2.2 the trigger is taken, but an operator is no admin of these projects: every project is refused.
      const newer = await tools().run({ ...c, budgetTools: true }, 'draft_automation', {
        ...base,
        trigger: gh,
      });
      expect(newer.ok).toBe(false);
      expect(!newer.ok && newer.message).toMatch(/admin role/);
    });

    it('budgets: refused on an older worker; a confirmed card writes through the store, raising is a card', async () => {
      const c = await ctx(ownerId, 'owner');
      const create = {
        action: 'create',
        name: 'Alpha daily',
        metric: 'cost_usd',
        limit: 10,
        window: 'day',
        scope: { type: 'project', value: A },
      };
      const legacy = await tools().run(c, 'draft_budget_change', create);
      expect(!legacy.ok && legacy.code).toBe('unavailable');
      const out = await tools().run({ ...c, budgetTools: true }, 'draft_budget_change', create);
      expect(out.ok, JSON.stringify(out)).toBe(true);
      const draftId = out.ok ? (out.draft?.id ?? '') : '';
      await stepUp(owner, ownerSecret);
      const confirmed = await owner.req('POST', `/chat/drafts/${draftId}/confirm`, {});
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      const budgetId = confirmed.json<{ result: { budgetId: string } }>().result.budgetId;
      const read = await owner.req('GET', `/budgets/${budgetId}`);
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json<{ budget: { name: string; limit: number } }>().budget).toMatchObject({
        name: 'Alpha daily',
        limit: 10,
      });
      expect((await audits('usage.budget.create')).at(-1)?.outcome).toBe('success');

      // Raising the limit is a card by default (payload cardOnly: default); lowering is not.
      const raise = await tools().run({ ...c, budgetTools: true }, 'draft_budget_change', {
        action: 'update',
        budgetId,
        limit: 50,
      });
      expect(raise.ok, JSON.stringify(raise)).toBe(true);
      const payload = (
        await h.db.pool.query<{ payload: Record<string, unknown> }>(
          'SELECT payload FROM chat_drafts WHERE id = $1',
          [raise.ok ? raise.draft?.id : null],
        )
      ).rows[0]?.payload;
      expect(payload).toMatchObject({ op: 'budget.update', cardOnly: 'default', expectedVersion: 1 });
      await stepUp(owner, ownerSecret);
      const ok = await owner.req(
        'POST',
        `/chat/drafts/${raise.ok ? (raise.draft?.id ?? '') : ''}/confirm`,
        {},
      );
      expect(ok.statusCode, ok.body).toBe(200);
      expect(
        (await owner.req('GET', `/budgets/${budgetId}`)).json<{ budget: { limit: number } }>().budget.limit,
      ).toBe(50);
      // An operator may not change budgets through the chat either.
      const opCtx = await ctx(opId, 'operator', { budgetTools: true });
      const denied = await tools().run(opCtx, 'draft_budget_change', { action: 'delete', budgetId });
      expect(!denied.ok && denied.code).toBe('forbidden');
    });

    it('plans: a ready-for-review notification once, and the plan in the meaning search', async () => {
      const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      const threadId = (await store.createThread(ownerId, 'leftovers plan')).id;
      const created = await h.app.chatPlans.create(
        { userId: ownerId, threadId, turnId: randomUUID(), planMode: true },
        {
          title: 'Kuzey deposu taşıma planı',
          goal: 'Arşiv dosyaları yeni depoya geçsin',
          phases: [
            {
              title: 'Hazırlık',
              items: [{ key: 'inventory', title: 'Zümrüt envanteri çıkar', owner: 'assistant' }],
            },
          ],
        },
      );
      expect(created.ok, JSON.stringify(created)).toBe(true);
      const planId = (created as { plan: { id: string } }).plan.id;
      const notes = (
        await h.db.pool.query<{ recipient_id: string; dedupe_key: string; link: string }>(
          `SELECT recipient_id::text AS recipient_id, dedupe_key, link FROM notifications
            WHERE kind = 'chat.plan' AND dedupe_key LIKE $1`,
          [`chat.plan:${planId}:ready:%`],
        )
      ).rows;
      expect(notes).toEqual([
        { recipient_id: ownerId, dedupe_key: `chat.plan:${planId}:ready:v1`, link: `/chat/${threadId}` },
      ]);
      const found = await owner.req('GET', `/chat/search?q=${encodeURIComponent('kuzey deposu')}`);
      expect(found.statusCode, found.body).toBe(200);
      const hits = found.json<{ items: { messageId: string; plan: { id: string } | null }[] }>().items;
      expect(hits.find((x) => x.plan?.id === planId)).toMatchObject({ messageId: `plan:${planId}` });
      // Another user never finds it.
      const theirs = await op.req('GET', `/chat/search?q=${encodeURIComponent('kuzey deposu')}`);
      expect(theirs.json<{ items: { plan: unknown }[] }>().items.some((x) => x.plan != null)).toBe(false);
    });
  });
});
