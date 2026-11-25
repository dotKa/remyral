import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p18-multi-project W4 (docs/design/p18-multi-project.md "Built: W4") on real Postgres and the real routes:
 *
 * - acceptance: a cron automation for A, B, C where the user lacks C → two created (one ordinary automation per
 *   project, linked as a group), C listed refused; audited `automation.group.create`;
 * - acceptance: "Tümüne uygula" skips a sibling the editor cannot change and marks it diverged; a sibling changed on
 *   its own diverges, the next apply-to-all aligns it again; audited `automation.group.apply`;
 * - acceptance: a shared template appears in B's library, hidden in C's; it is read and rendered through B, never
 *   through its owner project; copying it into B; full-access templates are never shared; audited `template.share` /
 *   `template.hide`;
 * - the chat's group card (draft_automation `projects` on an assistant-projects-v1 turn): refused projects are left
 *   out of the card, confirming creates one automation per project linked as a group.
 */
const PW = 'quartz-meadow-lantern-7';
const A = 'w4-alpha';
const B = 'w4-beta';
const C = 'w4-gamma';
const D = 'w4-delta';

const SPEC = {
  runtime: 'codex',
  prompt: 'Summarise the notes of the week.',
  sandboxProfile: 'container',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
};

interface Automation {
  id: string;
  project: string;
  maxRunsPerHour: number;
  group: { id: string; name: string; size: number; diverged: boolean } | null;
}

interface Template {
  id: string;
  project: string | null;
  scope: string;
  sharedTo: string[];
  hidden: boolean;
}

describeIntegration(
  'automation groups and the template library (integration, p18-multi-project W4)',
  { timeout: 300_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let ownerSecret = '';
    let op: Client;
    let opSecret = '';
    let other: Client;
    let opId = '';

    const stepUp = async (c: Client, secret: string): Promise<void> => {
      h.clock.advance(31_000);
      const res = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
      expect(res.statusCode, res.body).toBe(200);
    };
    const audits = async (action: string) =>
      (
        await h.db.pool.query<{ metadata: Record<string, unknown> }>(
          'SELECT metadata FROM audit_events WHERE action = $1 ORDER BY id',
          [action],
        )
      ).rows;
    const automation = async (c: Client, id: string): Promise<Automation> => {
      const res = await c.req('GET', `/automations/${id}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Automation>();
    };

    beforeAll(async () => {
      await h.start({ orchestration: { tickIntervalMs: 0 } });
      await h.createUser('owner1', PW);
      ownerSecret = (await enroll(h, 'owner1', PW)).secret;
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      // op: operator in A and B, viewer in D, nothing in C.
      opId = await h.createUser('op1', PW, 'operator');
      await h.grant(opId, [A, B], 'operator');
      await h.grant(opId, [D], 'viewer');
      opSecret = (await enroll(h, 'op1', PW)).secret;
      op = await fullLogin(h, 'op1', PW, opSecret);
      // other: operator in B only.
      const otherId = await h.createUser('other1', PW, 'operator');
      await h.grant(otherId, [B], 'operator');
      other = await fullLogin(h, 'other1', PW, (await enroll(h, 'other1', PW)).secret);
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
      it('acceptance: A, B and C where the user lacks C → two automations, C refused', async () => {
        await stepUp(op, opSecret);
        const res = await op.req('POST', '/automation-groups', {
          projects: [A, B, C],
          name: 'Weekly notes',
          trigger: { kind: 'cron', cron: '0 3 * * 1' },
          target: { kind: 'job', spec: SPEC },
        });
        expect(res.statusCode, res.body).toBe(201);
        const out = res.json<{
          groupId: string;
          created: { project: string; automation: Automation }[];
          refused: { project: string; code: string }[];
        }>();
        expect(out.created.map((c) => c.project)).toEqual([A, B]);
        expect(out.refused).toEqual([expect.objectContaining({ project: C, code: 'project_not_found' })]);
        for (const c of out.created) {
          expect(c.automation.project).toBe(c.project);
          expect(c.automation.group).toMatchObject({ id: out.groupId, size: 2, diverged: false });
        }
        const group = await op.req('GET', `/automation-groups/${out.groupId}`);
        expect(group.statusCode, group.body).toBe(200);
        expect(group.json<{ members: { project: string }[]; hidden: number }>()).toMatchObject({
          members: [{ project: A }, { project: B }],
          hidden: 0,
        });
        const listed = await op.req('GET', `/automations?group=${out.groupId}`);
        expect(listed.json<{ items: unknown[] }>().items).toHaveLength(2);
        expect((await audits('automation.group.create')).at(-1)?.metadata).toMatchObject({
          projects: [A, B, C],
          refused: [`${C}:project_not_found`],
        });
        // A user of B alone sees B's sibling; A's is a count.
        const forOther = await other.req('GET', `/automation-groups/${out.groupId}`);
        expect(forOther.statusCode, forOther.body).toBe(200);
        expect(forOther.json<{ members: { project: string }[]; hidden: number }>()).toMatchObject({
          members: [{ project: B }],
          hidden: 1,
        });
      });

      it('nothing created → 409 group_refused', async () => {
        await stepUp(op, opSecret);
        const res = await op.req('POST', '/automation-groups', {
          projects: [C, D],
          name: 'Nowhere',
          trigger: { kind: 'cron', cron: '0 4 * * 1' },
          target: { kind: 'job', spec: SPEC },
        });
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json<{ error: string }>().error).toBe('group_refused');
      });

      it('acceptance: apply-to-all skips a sibling the editor cannot change and marks it diverged', async () => {
        await stepUp(owner, ownerSecret);
        const made = await owner.req('POST', '/automation-groups', {
          projects: [A, B, D],
          name: 'Daily digest',
          trigger: { kind: 'cron', cron: '0 6 * * *' },
          target: { kind: 'job', spec: SPEC },
          maxRunsPerHour: 3,
        });
        expect(made.statusCode, made.body).toBe(201);
        const { groupId, created } = made.json<{
          groupId: string;
          created: { project: string; automation: Automation }[];
        }>();
        const idOf = (p: string): string => created.find((c) => c.project === p)?.automation.id ?? '';

        await stepUp(op, opSecret);
        const applied = await op.req('PATCH', `/automation-groups/${groupId}`, {
          patch: { maxRunsPerHour: 7 },
        });
        expect(applied.statusCode, applied.body).toBe(200);
        const body = applied.json<{
          applied: { project: string }[];
          skipped: { project: string; code: string }[];
          hiddenSkipped: number;
          group: { members: { project: string; diverged: boolean; canEdit: boolean }[] };
        }>();
        expect(body.applied.map((a) => a.project).sort()).toEqual([A, B]);
        expect(body.skipped).toEqual([expect.objectContaining({ project: D, code: 'forbidden' })]);
        expect(body.hiddenSkipped).toBe(0);
        expect(body.group.members.find((m) => m.project === D)).toMatchObject({
          diverged: true,
          canEdit: false,
        });
        expect((await automation(op, idOf(A))).maxRunsPerHour).toBe(7);
        expect(await automation(owner, idOf(D))).toMatchObject({
          maxRunsPerHour: 3,
          group: { diverged: true },
        });
        expect((await audits('automation.group.apply')).at(-1)?.metadata).toMatchObject({
          fields: ['maxRunsPerHour'],
          skipped: [`${D}:forbidden`],
        });

        // A sibling changed on its own diverges; the owner's next apply-to-all aligns every sibling again.
        await stepUp(op, opSecret);
        const one = await op.req('PATCH', `/automations/${idOf(A)}`, { maxRunsPerHour: 9 });
        expect(one.statusCode, one.body).toBe(200);
        expect((await automation(op, idOf(A))).group?.diverged).toBe(true);
        await stepUp(owner, ownerSecret);
        const all = await owner.req('PATCH', `/automation-groups/${groupId}`, {
          patch: { maxRunsPerHour: 4 },
        });
        expect(all.statusCode, all.body).toBe(200);
        for (const p of [A, B, D]) {
          expect(await automation(owner, idOf(p))).toMatchObject({
            maxRunsPerHour: 4,
            group: { diverged: false },
          });
        }
      });
    });

    describe('the template library', () => {
      let tpl = '';

      it('acceptance: a template shared to every project appears in B, hidden in C', async () => {
        const created = await op.req('POST', '/templates', {
          project: A,
          title: 'Weekly summary',
          prompt: 'Summarise {{topic}} for the week.',
          defaults: { runtime: 'codex' },
        });
        expect(created.statusCode, created.body).toBe(201);
        tpl = created.json<Template>().id;
        // Not shared yet: B cannot see it.
        expect((await other.req('GET', `/templates/${tpl}?project=${B}`)).statusCode).toBe(404);
        const listedBefore = await other.req('GET', `/templates?project=${B}`);
        expect(listedBefore.json<{ items: Template[] }>().items.some((t) => t.id === tpl)).toBe(false);

        expect((await op.req('PUT', `/templates/${tpl}/shares`, { projects: ['*', B] })).statusCode).toBe(
          400,
        );
        expect((await op.req('PUT', `/templates/${tpl}/shares`, { projects: [A] })).statusCode).toBe(400);
        const shared = await op.req('PUT', `/templates/${tpl}/shares`, { projects: ['*'] });
        expect(shared.statusCode, shared.body).toBe(200);
        expect(shared.json<Template>()).toMatchObject({ sharedTo: ['*'], scope: 'project' });
        expect((await audits('template.share')).at(-1)?.metadata).toMatchObject({
          project: A,
          projects: ['*'],
        });

        const inB = await other.req('GET', `/templates?project=${B}`);
        expect(inB.json<{ items: Template[] }>().items.find((t) => t.id === tpl)).toMatchObject({
          scope: 'shared',
          project: A,
        });
        // Read and rendered through B; never through its owner project (B's user cannot read A).
        expect((await other.req('GET', `/templates/${tpl}?project=${B}`)).statusCode).toBe(200);
        expect((await other.req('GET', `/templates/${tpl}`)).statusCode).toBe(404);
        expect((await other.req('GET', `/templates/${tpl}/versions?project=${B}`)).statusCode).toBe(200);
        const rendered = await other.req('POST', `/templates/${tpl}/render`, {
          project: B,
          values: { topic: 'releases' },
        });
        expect(rendered.statusCode, rendered.body).toBe(200);
        expect(rendered.json<{ project: string; prompt: string }>()).toMatchObject({ project: B });

        // C hides it: gone from C's library, still in B's.
        const hidden = await owner.req('PUT', `/templates/${tpl}/hidden`, { project: C, hidden: true });
        expect(hidden.statusCode, hidden.body).toBe(200);
        expect(hidden.json<Template>().hidden).toBe(true);
        const inC = await owner.req('GET', `/templates?project=${C}`);
        expect(inC.json<{ items: Template[] }>().items.some((t) => t.id === tpl)).toBe(false);
        const inCAll = await owner.req('GET', `/templates?project=${C}&hidden=include`);
        expect(inCAll.json<{ items: Template[] }>().items.find((t) => t.id === tpl)).toMatchObject({
          hidden: true,
        });
        const inBAgain = await other.req('GET', `/templates?project=${B}`);
        expect(inBAgain.json<{ items: Template[] }>().items.some((t) => t.id === tpl)).toBe(true);
        expect((await audits('template.hide')).at(-1)?.metadata).toMatchObject({ project: C, hidden: true });
        // The owner project's own template is archived, not hidden; B's user cannot touch A's library.
        expect(
          (await op.req('PUT', `/templates/${tpl}/hidden`, { project: A, hidden: true })).statusCode,
        ).toBe(400);
        expect(
          (await other.req('PUT', `/templates/${tpl}/hidden`, { project: A, hidden: true })).statusCode,
        ).toBe(404);
      });

      it('a shared template is copied into the reader’s project; editing and sharing stay with the owner', async () => {
        const copy = await other.req('POST', `/templates/${tpl}/duplicate`, { project: B });
        expect(copy.statusCode, copy.body).toBe(201);
        expect(copy.json<Template>()).toMatchObject({ project: B, scope: 'project' });
        expect(
          (await other.req('PATCH', `/templates/${tpl}`, { expectedVersion: 1, title: 'Mine now' }))
            .statusCode,
        ).toBe(404);
        expect((await other.req('PUT', `/templates/${tpl}/shares`, { projects: [] })).statusCode).toBe(404);
      });

      it('a full-access template is never shared', async () => {
        await h.db.pool.query('UPDATE projects SET auto_approve_execution = true WHERE id = $1', [A]);
        const full = await op.req('POST', '/templates', {
          project: A,
          title: 'Trusted cleanup',
          prompt: 'Clean the build cache.',
          defaults: { runtime: 'codex', approvalPolicy: 'allow-all' },
        });
        expect(full.statusCode, full.body).toBe(201);
        const res = await op.req('PUT', `/templates/${full.json<Template>().id}/shares`, { projects: [B] });
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json<{ error: string }>().error).toBe('full_access_shared');
      });
    });

    describe('the chat’s automation group card', () => {
      it('leaves refused projects out and creates one automation per project on confirm', async () => {
        const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
        const app = h.app;
        const tools = new ChatTools({
          db: h.db.pool,
          store,
          clock: h.clock.now,
          automations: () => app.automations,
          threadProjects: () => app.threadProjects,
        } as unknown as ChatToolsDeps);
        const t = await store.createThread(opId, 'group card');
        const c = {
          userId: opId,
          subject: await loadSubject(h.db.pool, { id: opId, role: 'operator' }),
          threadId: t.id,
          turnId: randomUUID(),
          projects: [A, B, D],
          projectRules: true,
        };
        const input = {
          projects: [A, B, D],
          name: 'Chat digest',
          trigger: { kind: 'cron', cron: '0 7 * * *', timeZone: 'UTC' },
          prompt: 'Write the morning digest.',
          runtime: 'codex',
        };
        // An older assistant worker (no assistant-projects-v1) gets no group card.
        const legacy = await tools.run({ ...c, projectRules: false }, 'draft_automation', input);
        expect(legacy.ok).toBe(false);
        const out = await tools.run(c, 'draft_automation', input);
        expect(out.ok, JSON.stringify(out)).toBe(true);
        const draft = out.ok ? out.draft : undefined;
        expect(draft?.kind).toBe('automation');
        const payload = (
          await h.db.pool.query<{ payload: Record<string, unknown> }>(
            'SELECT payload FROM chat_drafts WHERE id = $1',
            [draft?.id],
          )
        ).rows[0]?.payload;
        expect(payload).toMatchObject({ action: 'create_group', projects: [A, B] });
        expect(payload?.refused).toEqual([expect.objectContaining({ project: D, code: 'forbidden' })]);
        // Outside the working projects: refused before any card.
        const outside = await tools.run(c, 'draft_automation', { ...input, projects: [A, C] });
        expect(!outside.ok && outside.code).toBe('project_not_in_thread');

        await stepUp(op, opSecret);
        const confirmed = await op.req('POST', `/chat/drafts/${draft?.id ?? ''}/confirm`, {});
        expect(confirmed.statusCode, confirmed.body).toBe(200);
        const result = confirmed.json<{
          result: { groupId: string; projects: string[]; automationIds: string[] };
        }>().result;
        expect(result.projects).toEqual([A, B]);
        for (const id of result.automationIds) {
          expect((await automation(op, id)).group).toMatchObject({ id: result.groupId, size: 2 });
        }
      });
    });
  },
);
