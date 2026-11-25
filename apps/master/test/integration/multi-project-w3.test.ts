import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller, type ToolOutcome } from '../../src/chat/tools.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p18-multi-project W3 + W5 (docs/design/p18-multi-project.md "Built: W3 + W5") on real Postgres and the real routes:
 *
 * - a conversation's working projects: set / read through `PUT|GET /chat/threads/:id/projects` and the thread view's
 *   knowledge (each member's own sharing switch), audited `chat.thread.projects`; at most 8; only readable projects;
 *   a member the user lost access to is dropped at the next turn (forTurn);
 * - the write rules of a turn on an `assistant-projects-v1` worker: a write outside the set → project_not_in_thread,
 *   a plan job item without a project in a 2-project set → project_required, set_thread_projects adds a project
 *   (a card confirmed through the normal route);
 * - acceptance W5: one submission to A, B (held), C → jobs in A and C (each its own project's ordinary job), B refused
 *   `project_held`; the batch page shows 2/3; the same through the chat's batch card.
 */
const PW = 'quartz-meadow-lantern-7';
const A = 'mp-alpha';
const B = 'mp-beta';
const C = 'mp-gamma';
const D = 'mp-delta';

describeIntegration(
  'working projects and job batches (integration, p18-multi-project W3 + W5)',
  { timeout: 300_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let ownerId = '';
    let op: Client;
    let opId = '';
    let store: ChatStore;
    let tools: ChatTools;

    const caller = async (
      id: string,
      role: 'owner' | 'operator',
      threadId: string,
      projects: string[],
    ): Promise<ToolCaller> => ({
      userId: id,
      subject: await loadSubject(h.db.pool, { id, role }),
      threadId,
      turnId: randomUUID(),
      projects,
      projectRules: true,
    });
    const audits = async (action: string) =>
      (
        await h.db.pool.query<{ actor_id: string; outcome: string; metadata: Record<string, unknown> }>(
          'SELECT actor_id, outcome, metadata FROM audit_events WHERE action = $1 ORDER BY id',
          [action],
        )
      ).rows;
    const ok = (o: ToolOutcome): Record<string, unknown> => {
      expect(o.ok, JSON.stringify(o)).toBe(true);
      return (o.ok ? o.data : {}) as Record<string, unknown>;
    };

    beforeAll(async () => {
      await h.start({ orchestration: { tickIntervalMs: 0 } });
      ownerId = await h.createUser('owner1', PW);
      const ownerSecret = (await enroll(h, 'owner1', PW)).secret;
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      opId = await h.createUser('op1', PW, 'operator');
      await h.grant(opId, [A, B, C], 'operator');
      const opSecret = (await enroll(h, 'op1', PW)).secret;
      op = await fullLogin(h, 'op1', PW, opSecret);
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
        [D],
      );
      // Workspace projects: no repository needed; each job runs in its own project's workspace.
      for (const p of [A, B, C, D]) {
        await h.db.pool.query(`UPDATE projects SET kind = 'workspace' WHERE id = $1`, [p]);
        await h.db.pool.query(
          `INSERT INTO project_workspaces (project, egress, updated_at) VALUES ($1, 'none', now()) ON CONFLICT DO NOTHING`,
          [p],
        );
      }
      store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      const app = h.app;
      tools = new ChatTools({
        db: h.db.pool,
        store,
        clock: h.clock.now,
        threadProjects: () => app.threadProjects,
        batches: () => app.jobBatches,
      } as unknown as ChatToolsDeps);
    });
    afterAll(async () => {
      await h.stop();
    });

    describe('the working projects of a conversation', () => {
      it('are set as a whole, read back with their switches, and audited', async () => {
        const t = await store.createThread(opId, 'two projects');
        const put = await op.req('PUT', `/chat/threads/${t.id}/projects`, {
          projects: [{ project: A }, { project: B, share: false }],
        });
        expect(put.statusCode, put.body).toBe(200);
        expect(put.json<{ projects: unknown[] }>().projects).toMatchObject([
          { project: A, primary: true, share: true, role: 'operator', kind: 'workspace' },
          { project: B, primary: false, share: false },
        ]);
        const view = await op.req('GET', `/chat/threads/${t.id}`);
        expect(
          view.json<{ knowledge: { project: string; projects: { project: string }[] } }>().knowledge,
        ).toMatchObject({
          project: A,
          projects: [{ project: A }, { project: B }],
        });
        const a = (await audits('chat.thread.projects')).at(-1);
        // The conversation had no project: both are added.
        expect(a?.metadata).toMatchObject({ source: 'console', added: [A, B] });
        // The primary moves; B's switch stays as it was.
        const again = await op.req('PUT', `/chat/threads/${t.id}/projects`, {
          projects: [{ project: B }, { project: A }],
        });
        expect(
          again.json<{ projects: { project: string; share: boolean; primary: boolean }[] }>().projects,
        ).toEqual([
          expect.objectContaining({ project: B, primary: true, share: false }),
          expect.objectContaining({ project: A, primary: false, share: true }),
        ]);
      });

      it('refuses more than 8, duplicates and projects the user cannot read', async () => {
        const t = await store.createThread(opId, 'limits');
        const nine = Array.from({ length: 9 }, (_, i) => ({ project: `p${String(i)}` }));
        expect((await op.req('PUT', `/chat/threads/${t.id}/projects`, { projects: nine })).statusCode).toBe(
          400,
        );
        const dup = await op.req('PUT', `/chat/threads/${t.id}/projects`, {
          projects: [{ project: A }, { project: A }],
        });
        expect(dup.json<{ error: string }>().error).toBe('bad_request');
        const hidden = await op.req('PUT', `/chat/threads/${t.id}/projects`, {
          projects: [{ project: A }, { project: D }],
        });
        expect(hidden.statusCode).toBe(404);
        // Another user's conversation is not found.
        const mine = await store.createThread(ownerId, 'owner');
        expect((await op.req('GET', `/chat/threads/${mine.id}/projects`)).statusCode).toBe(404);
      });

      it('drops a project the user lost access to at the next turn', async () => {
        const lose = await h.createUser('op2', PW, 'operator');
        await h.grant(lose, [A, C], 'operator');
        const t = await store.createThread(lose, 'losing C');
        await h.app.threadProjects.set(await loadSubject(h.db.pool, { id: lose, role: 'operator' }), t.id, [
          { project: C },
          { project: A },
        ]);
        await h.db.pool.query('DELETE FROM project_memberships WHERE user_id = $1 AND project_id = $2', [
          lose,
          C,
        ]);
        const turn = await h.app.threadProjects.forTurn(
          await loadSubject(h.db.pool, { id: lose, role: 'operator' }),
          t.id,
        );
        expect(turn.dropped).toEqual([C]);
        expect(turn.view.map((v) => [v.project, v.primary])).toEqual([[A, true]]);
        const { rows } = await h.db.pool.query<{ project: string | null }>(
          'SELECT project FROM chat_threads WHERE id = $1',
          [t.id],
        );
        expect(rows[0]?.project).toBe(A);
      });
    });

    describe('write rules of a turn with several working projects', () => {
      it('a write outside the set is refused; set_thread_projects adds the project through a confirmed card', async () => {
        const t = await store.createThread(opId, 'targeting');
        await h.app.threadProjects.set(await loadSubject(h.db.pool, { id: opId, role: 'operator' }), t.id, [
          { project: A },
          { project: B },
        ]);
        const c = await caller(opId, 'operator', t.id, [A, B]);
        const out = await tools.run(c, 'draft_job', {
          project: C,
          title: 'Elsewhere',
          prompt: 'Do it in C',
          runtime: 'codex',
          mode: 'workspace',
        });
        expect(out.ok).toBe(false);
        expect(!out.ok && out.code).toBe('project_not_in_thread');
        // The same call without the rules (an older worker) is not refused for the set.
        const legacy = await tools.run({ ...c, projectRules: false }, 'set_thread_projects', {
          projects: [{ project: A }, { project: B }, { project: C }],
        });
        const card = legacy.ok ? legacy.draft : undefined;
        expect(card?.kind).toBe('thread_projects');
        const confirmed = await op.req('POST', `/chat/drafts/${card?.id ?? ''}/confirm`, {});
        expect(confirmed.statusCode, confirmed.body).toBe(200);
        const view = await op.req('GET', `/chat/threads/${t.id}/projects`);
        expect(view.json<{ projects: { project: string }[] }>().projects.map((p) => p.project)).toEqual([
          A,
          B,
          C,
        ]);
        expect((await audits('chat.thread.projects')).at(-1)?.metadata).toMatchObject({
          source: 'chat',
          added: [C],
        });
      });

      it('plan job items need a project when the set has several (project_required)', async () => {
        const t = await store.createThread(opId, 'plan items');
        const c = { ...(await caller(opId, 'operator', t.id, [A, B])), planMode: true };
        const out = await tools.run(c, 'plan_create', {
          title: 'Two projects',
          goal: 'Ship both',
          phases: [{ title: 'Work', items: [{ key: 'a', title: 'Build it', owner: 'job' }] }],
        });
        expect(!out.ok && out.code).toBe('project_required');
      });
    });

    describe('job batches (acceptance W5)', () => {
      it('A, B (held), C → jobs in A and C, B refused project_held; the page shows 2/3', async () => {
        await h.db.pool.query(
          `INSERT INTO quota_project_holds (project, reason, held_by, held_at) VALUES ($1, 'test hold', $2, now())
         ON CONFLICT DO NOTHING`,
          [B, ownerId],
        );
        const res = await op.req('POST', '/jobs/batches', {
          projects: [A, B, C],
          spec: { title: 'Bump deps', prompt: 'Bump the dependencies of {{project.name}}', runtime: 'codex' },
        });
        expect(res.statusCode, res.body).toBe(201);
        const out = res.json<{
          batchId: string;
          created: { project: string; jobId: string }[];
          refused: { project: string; code: string }[];
        }>();
        expect(out.created.map((c) => c.project).sort()).toEqual([A, C]);
        expect(out.refused).toEqual([expect.objectContaining({ project: B, code: 'project_held' })]);
        // Each job is an ordinary job of its own project, with its own prompt.
        const { rows } = await h.db.pool.query<{ project: string; prompt: string }>(
          `SELECT project, spec->>'prompt' AS prompt FROM jobs WHERE id = ANY($1::uuid[]) ORDER BY project`,
          [out.created.map((c) => c.jobId)],
        );
        expect(rows).toEqual([
          { project: A, prompt: `Bump the dependencies of ${A}` },
          { project: C, prompt: `Bump the dependencies of ${C}` },
        ]);
        const page = await op.req('GET', `/jobs/batches/${out.batchId}`);
        expect(page.statusCode, page.body).toBe(200);
        const b = page.json<{
          counts: { total: number; created: number; refused: number };
          members: { project: string; job: unknown; refusal: { code: string } | null }[];
        }>();
        expect(b.counts).toMatchObject({ total: 3, created: 2, refused: 1 });
        expect(b.members.find((m) => m.project === B)?.refusal?.code).toBe('project_held');
        expect((await audits('job.batch.submit')).at(-1)?.metadata).toMatchObject({
          source: 'console',
          refused: [{ project: B, reason: 'project_held' }],
        });
        // Someone else's batch is not found; the list has it for its creator.
        expect((await owner.req('GET', `/jobs/batches/${out.batchId}`)).statusCode).toBe(200);
        const list = await op.req('GET', '/jobs/batches');
        expect(list.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toContain(out.batchId);
        await h.db.pool.query('DELETE FROM quota_project_holds WHERE project = $1', [B]);
      });

      it('the chat batch card leaves refused projects out and creates one job per project on confirm', async () => {
        const t = await store.createThread(opId, 'batch card');
        const c = await caller(opId, 'operator', t.id, [A, B, C]);
        const out = await tools.run(c, 'draft_job_batch', {
          projects: [A, C],
          title: 'Lint',
          prompt: 'Run the linter in {{project.id}}',
          runtime: 'codex',
        });
        const data = ok(out);
        expect(data.projects).toEqual([A, C]);
        const draftId = out.ok ? (out.draft?.id ?? '') : '';
        const confirmed = await op.req('POST', `/chat/drafts/${draftId}/confirm`, {});
        expect(confirmed.statusCode, confirmed.body).toBe(200);
        const result = confirmed.json<{ result: { batchId: string; created: unknown[] } }>().result;
        expect(result.created).toHaveLength(2);
        const { rows } = await h.db.pool.query<{ source: string; thread_id: string }>(
          'SELECT source, thread_id::text AS thread_id FROM job_batches WHERE id = $1',
          [result.batchId],
        );
        expect(rows[0]).toEqual({ source: 'chat', thread_id: t.id });
        // Outside the set: refused before any card.
        const outside = await tools.run(c, 'draft_job_batch', {
          projects: [A, D],
          title: 'Lint',
          prompt: 'x',
          runtime: 'codex',
        });
        expect(!outside.ok && outside.code).toBe('project_not_in_thread');
      });
    });
  },
);
