import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { gateId } from '../../src/chat/flow-model.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller, type ToolOutcome } from '../../src/chat/tools.js';
import type { BlobRead, GitProvider, OpenPullRequest } from '../../src/gitflow/types.js';
import { classifyBlob } from '../../src/gitflow/types.js';
import { JobStore } from '../../src/jobs/store.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p18-last-gaps (docs/design/p18-last-gaps.md) against a real master database:
 *
 *  1. Engine-1 workflow gates in the chat (a v1 document's step approval, `v2ForV1` off): the card once in the
 *     conversation that started the run (stable step id, `engine: 1`), the live view through the approval route, the
 *     deciders' notification, "Senden bekleyen", the decision through engine 1's gate route (step-up, role) — one
 *     decision wins —, the decided state pushed once (`gatedone:` claim), and the assistant's describe_workflow_run /
 *     draft_workflow_approval_decision on the same gate.
 *  2. Comments on compare views: rights (viewer reads, cannot comment; another project's member sees nothing), CRUD,
 *     outdated when the head ref moves, and "Değişiklik iste" — a job's branch → that job (a message), an open pull
 *     request of the repository → a new job on its branch, anything else → 409 with the reason.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'gaps-alpha';
const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const NEXT = '3'.repeat(40);

const FILES: Record<string, Record<string, string>> = {
  [BASE]: { 'src/app.ts': 'export const a = 1;\nexport const b = 2;\n' },
  [HEAD]: { 'src/app.ts': 'export const a = 1;\nexport const b = 3;\n' },
  [NEXT]: { 'src/app.ts': 'export const a = 1;\nexport const b = 4;\n' },
};

class MemoryProvider implements GitProvider {
  readonly kind = 'git' as const;
  heads: Record<string, string> = { main: BASE, 'feature/billing': HEAD, develop: HEAD };
  pulls: OpenPullRequest[] = [
    {
      number: 12,
      title: 'Billing',
      url: 'https://example.com/acme/app/pull/12',
      author: 'dev',
      draft: false,
      baseBranch: 'main',
      headBranch: 'feature/billing',
      headSha: null,
      sameRepository: true,
      updatedAt: null,
    },
  ];
  branchHead(b: string): Promise<string | null> {
    return Promise.resolve(this.heads[b] ?? null);
  }
  tree(): Promise<null> {
    return Promise.resolve(null);
  }
  blob(sha: string, path: string, maxBytes: number): Promise<BlobRead | null> {
    const c = FILES[sha]?.[path];
    if (c === undefined) return Promise.resolve(null);
    const buf = Buffer.from(c);
    return Promise.resolve(classifyBlob(buf, buf.length, maxBytes));
  }
  openPullRequests(): Promise<readonly OpenPullRequest[]> {
    return Promise.resolve(this.pulls);
  }
  commit(): never {
    throw new Error('unused');
  }
  compare(base: string) {
    return Promise.resolve({
      status: 'ahead' as const,
      mergeBase: base,
      commits: [],
      files: [{ path: 'src/app.ts', status: 'modified' as const, additions: 1, deletions: 1 }],
      truncated: false,
    });
  }
  testMerge(): never {
    throw new Error('unused');
  }
  ensurePullRequest(): never {
    throw new Error('unused');
  }
  checks(): never {
    throw new Error('unused');
  }
  merge(): never {
    throw new Error('unused');
  }
  findMerge(): never {
    throw new Error('unused');
  }
  deleteBranch(): never {
    throw new Error('unused');
  }
}

describeIntegration('p18-last-gaps (integration)', { timeout: 300_000 }, () => {
  const h = new Harness();
  const provider = new MemoryProvider();
  let ownerId = '';
  let ownerSecret = '';
  let owner: Client;
  let opId = '';
  let opSecret = '';
  let op: Client;
  let viewerId = '';
  let viewer: Client;
  let outsider: Client;
  let store: ChatStore;
  let jobs: JobStore;
  let tools: ChatTools;

  const stepUp = async (c: Client, secret: string): Promise<void> => {
    h.clock.advance(30_000);
    const res = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
    expect(res.statusCode, res.body).toBe(200);
  };

  beforeAll(async () => {
    await h.start({
      orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } },
      gitflow: { providers: () => provider },
    });
    ownerId = await h.createUser('owner.gaps', PW, 'owner');
    ownerSecret = (await enroll(h, 'owner.gaps', PW)).secret;
    owner = await fullLogin(h, 'owner.gaps', PW, ownerSecret);
    opId = await h.createUser('op.gaps', PW, 'operator');
    await h.grant(opId, [PROJECT], 'operator');
    opSecret = (await enroll(h, 'op.gaps', PW)).secret;
    op = await fullLogin(h, 'op.gaps', PW, opSecret);
    viewerId = await h.createUser('viewer.gaps', PW, 'viewer');
    await h.grant(viewerId, [PROJECT], 'viewer');
    viewer = await fullLogin(h, 'viewer.gaps', PW, (await enroll(h, 'viewer.gaps', PW)).secret);
    const outsiderId = await h.createUser('outsider.gaps', PW, 'operator');
    await h.grant(outsiderId, ['gaps-beta'], 'operator');
    outsider = await fullLogin(h, 'outsider.gaps', PW, (await enroll(h, 'outsider.gaps', PW)).secret);
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                        require_ci, ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', 'https://example.com/acme/app.git', 'main', 'merge', false, 1800, $2, $3)`,
      [PROJECT, ownerId, h.clock.now()],
    );
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
    const app = h.app;
    tools = new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      opsTools: () => app.chatOpsTools,
      admin: () => app.chatAdmin,
    } as unknown as ChatToolsDeps);
  });
  afterAll(async () => {
    await h.stop();
  });

  // ------------------------------------------------------------------------------------------ 1. engine-1 gates

  describe('engine-1 workflow gates in the chat', () => {
    async function gatedRun(name: string, approverRole = 'operator'): Promise<string> {
      const def = await owner.req('POST', '/workflows', {
        project: PROJECT,
        definition: {
          name,
          description: 'gated v1 workflow',
          defaults: {
            runtime: 'codex',
            sandboxProfile: 'container',
            approvalPolicy: 'ask-sensitive',
            limits: { maxDurationSec: 600 },
          },
          nodes: [
            {
              id: 'build',
              role: 'executor',
              title: 'Build the release',
              prompt: 'Build the release notes',
              approval: { approverRole },
            },
          ],
          edges: [],
        },
      });
      expect(def.statusCode, def.body).toBe(201);
      const res = await owner.req('POST', `/workflows/${def.json<{ id: string }>().id}/runs`, { inputs: {} });
      expect(res.statusCode, res.body).toBe(201);
      const runId = res.json<{ runId: string }>().runId;
      for (let i = 0; i < 3; i++) await h.app.workflows.progress();
      const { rows } = await h.db.pool.query<{ state: string; engine: number }>(
        `SELECT n.state, r.engine FROM workflow_nodes n JOIN workflow_runs r ON r.id = n.run_id
          WHERE n.run_id = $1 AND n.node_id = 'build'`,
        [runId],
      );
      expect(rows[0]).toMatchObject({ state: 'awaiting_approval', engine: 1 });
      return runId;
    }
    async function cardThread(runId: string): Promise<string> {
      const thread = await store.createThread(ownerId, 'gated run');
      const at = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO chat_drafts (id, thread_id, user_id, turn_id, kind, title, payload, payload_hash, project, state,
                                  result, created_at, expires_at, decided_at)
         VALUES ($1, $2, $3, $4, 'workflow_run', 'card', '{}', $5, $6, 'confirmed', $7, $8, $8, $8)`,
        [
          randomUUID(),
          thread.id,
          ownerId,
          randomUUID(),
          'a'.repeat(64),
          PROJECT,
          JSON.stringify({ runId }),
          at,
        ],
      );
      return thread.id;
    }
    const cards = async (threadId: string) =>
      (await store.messages(threadId)).filter((m) => m.meta?.notice === 'workflow-approval');

    it('the card reaches the conversation once; view, notification, Senden bekleyen; decided once through engine 1', async () => {
      const runId = await gatedRun('gated-release');
      const thread = await cardThread(runId);
      await h.app.chatFlow.tick();
      await h.app.chatFlow.tick();
      const posted = await cards(thread);
      expect(posted).toHaveLength(1);
      const id = gateId(runId, 'build');
      expect(posted[0]?.meta).toMatchObject({
        engine: 1,
        runId,
        nodeRunId: id,
        node: 'build',
        workflow: 'gated-release',
        project: PROJECT,
      });
      const claims = await h.db.pool.query<{ key: string }>(
        "SELECT key FROM chat_flow_events WHERE key LIKE 'gate:%'",
      );
      expect(claims.rows.map((r) => r.key)).toContain(`gate:${runId}:build`);

      // The live view through the same route as an engine-2 step.
      const view = await owner.req('GET', `/workflows/runs/${runId}/node-runs/${id}/approval`);
      expect(view.statusCode, view.body).toBe(200);
      expect(view.json()).toMatchObject({
        engine: 1,
        state: 'waiting',
        node: 'build',
        title: 'Build the release',
        details: 'Build the release notes',
        approverRole: 'operator',
        canDecide: true,
      });
      expect(
        (await viewer.req('GET', `/workflows/runs/${runId}/node-runs/${id}/approval`)).json(),
      ).toMatchObject({ canDecide: false });
      expect(
        (await outsider.req('GET', `/workflows/runs/${runId}/node-runs/${id}/approval`)).statusCode,
      ).toBe(404);

      // Deciders were notified; the operator's "Senden bekleyen" has it, the viewer's does not.
      const notes = await h.db.pool.query<{ link: string }>(
        "SELECT link FROM notifications WHERE recipient_id = $1 AND kind = 'workflow.approval'",
        [opId],
      );
      expect(notes.rows).toEqual([{ link: `/jobs/workflows/${runId}` }]);
      const page = (await op.req('GET', '/ops-thread')).json<{
        items: { id: string; type: string; payload: Record<string, unknown> | null }[];
      }>();
      expect(page.items.find((i) => i.id === `workflow:${id}`)).toMatchObject({
        type: 'workflow:approval',
        payload: { engine: 1, runId, node: 'build', state: 'waiting' },
      });
      const vpage = (await viewer.req('GET', '/ops-thread')).json<{ items: { id: string }[] }>();
      expect(vpage.items.some((i) => i.id === `workflow:${id}`)).toBe(false);

      // The card decides through engine 1's gate route (step-up); one decision wins.
      expect((await viewer.req('POST', `/workflows/runs/${runId}/nodes/build/approve`, {})).statusCode).toBe(
        403,
      );
      await stepUp(op, opSecret);
      const ok = await op.req('POST', `/workflows/runs/${runId}/nodes/build/approve`, { reason: 'go' });
      expect(ok.statusCode, ok.body).toBe(200);
      const late = await op.req('POST', `/workflows/runs/${runId}/nodes/build/deny`, { reason: 'late' });
      expect(late.statusCode).toBe(409);
      expect(
        (await owner.req('GET', `/workflows/runs/${runId}/node-runs/${id}/approval`)).json(),
      ).toMatchObject({ state: 'approved', decidedBy: 'op.gaps', canDecide: false });
      const after = (await op.req('GET', '/ops-thread')).json<{ items: { id: string }[] }>();
      expect(after.items.some((i) => i.id === `workflow:${id}`)).toBe(false);

      // The decided state is pushed to the conversation showing the card (once through the tick's claim).
      expect(await h.app.chatFlow.gateDecided(runId, 'build')).toBe(1);
      await h.app.chatFlow.tick();
      await h.app.chatFlow.tick();
      const done = await h.db.pool.query<{ key: string }>('SELECT key FROM chat_flow_events WHERE key = $1', [
        `gatedone:${runId}:build`,
      ]);
      expect(done.rows).toHaveLength(1);
      expect(await cards(thread)).toHaveLength(1);
    });

    it('the assistant describes the gate and decides it through a card with engine 1’s checks', async () => {
      const runId = await gatedRun('gated-assist', 'admin');
      const caller = async (id: string, role: 'owner' | 'operator'): Promise<ToolCaller> => ({
        userId: id,
        subject: await loadSubject(h.db.pool, { id, role }),
        threadId: (await store.createThread(id, 'ops tools')).id,
        turnId: randomUUID(),
        opsTools: true,
      });
      const data = (o: ToolOutcome): Record<string, unknown> => {
        expect(o.ok, JSON.stringify(o)).toBe(true);
        return (o.ok ? o.data : {}) as Record<string, unknown>;
      };
      const opc = await caller(opId, 'operator');
      const described = data(await tools.run(opc, 'describe_workflow_run', { runId }));
      const approvals = described.approvals as { nodeRunId: string; node: string; canDecide: boolean }[];
      expect(approvals).toEqual([
        expect.objectContaining({ nodeRunId: gateId(runId, 'build'), node: 'build', canDecide: false }),
      ]);
      // An admin gate: the operator may not decide it.
      expect(
        await tools.run(opc, 'draft_workflow_approval_decision', {
          runId,
          nodeRunId: gateId(runId, 'build'),
          decision: 'approve',
        }),
      ).toMatchObject({ ok: false, code: 'forbidden' });
      const own = await caller(ownerId, 'owner');
      const card = await tools.run(own, 'draft_workflow_approval_decision', {
        runId,
        nodeRunId: gateId(runId, 'build'),
        decision: 'deny',
        reason: 'not this week',
      });
      expect(card.ok && card.draft?.payload).toMatchObject({ op: 'workflow.decide_node', node: 'build' });
      await stepUp(owner, ownerSecret);
      const res = await owner.req(
        'POST',
        `/chat/drafts/${card.ok ? (card.draft?.id ?? '') : ''}/confirm`,
        {},
      );
      expect(res.statusCode, res.body).toBe(200);
      const { rows } = await h.db.pool.query<{ gate_decision: string }>(
        `SELECT gate_decision FROM workflow_nodes WHERE run_id = $1 AND node_id = 'build'`,
        [runId],
      );
      expect(rows[0]?.gate_decision).toBe('denied');
      // Decided: the tool reports it instead of deciding again.
      expect(
        await tools.run(own, 'draft_workflow_approval_decision', {
          runId,
          nodeRunId: gateId(runId, 'build'),
          decision: 'approve',
        }),
      ).toMatchObject({ ok: false, code: 'invalid' });
      const gate = await h.db.pool.query<{ actor_id: string; outcome: string }>(
        `SELECT actor_id, outcome FROM audit_events WHERE action = 'workflow.gate.deny' ORDER BY id`,
      );
      expect(gate.rows.at(-1)).toMatchObject({ actor_id: ownerId, outcome: 'success' });
    });
  });

  // -------------------------------------------------------------------------------------- 2. compare comments

  describe('comments on compare views', () => {
    let jobId = '';
    beforeAll(async () => {
      jobId = (
        await jobs.create({
          project: PROJECT,
          actor: { type: 'user', id: opId },
          submit: true,
          spec: {
            runtime: 'codex',
            prompt: 'Change b',
            repository: { url: 'https://example.com/acme/app.git', baseRef: 'main', workBranch: 'w/b' },
            sandboxProfile: 'container',
            approvalPolicy: 'ask-sensitive',
            limits: { maxDurationSec: 3600 },
          },
        })
      ).job.id;
      await h.db.pool.query(
        `INSERT INTO job_git (job_id, project, provider, target_branch, base_sha, branch, head_sha, verification,
                              changes, created_at, updated_at)
         VALUES ($1, $2, 'git', 'main', $3, $4, $5, 'passed', $6, now(), now())`,
        [
          jobId,
          PROJECT,
          BASE,
          `rac/${jobId}/a1`,
          HEAD,
          JSON.stringify({
            commits: [],
            files: [],
            totals: { files: 0, additions: 0, deletions: 0 },
            truncated: false,
          }),
        ],
      );
    });
    const q = (base: string, head: string) =>
      `/projects/${PROJECT}/code/compare/comments?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`;
    const comment = (base: string, head: string, extra: Record<string, unknown> = {}) => ({
      base,
      head,
      baseSha: BASE,
      headSha: HEAD,
      path: 'src/app.ts',
      side: 'new',
      startLine: 2,
      endLine: 2,
      body: 'b should stay 2',
      ...extra,
    });

    it('rights, threads and outdated comments', async () => {
      expect((await outsider.req('GET', q('main', 'develop'))).statusCode).toBe(404);
      const empty = await viewer.req('GET', q('main', 'develop'));
      expect(empty.statusCode, empty.body).toBe(200);
      expect(empty.json()).toMatchObject({
        comments: [],
        headSha: HEAD,
        target: { mode: 'none', reason: 'no_target' },
      });
      expect(
        (await viewer.req('POST', `/projects/${PROJECT}/code/compare/comments`, comment('main', 'develop')))
          .statusCode,
      ).toBe(403);
      const made = await op.req(
        'POST',
        `/projects/${PROJECT}/code/compare/comments`,
        comment('main', 'develop'),
      );
      expect(made.statusCode, made.body).toBe(201);
      const root = made.json<{ comment: { id: string; mine: boolean; outdated: boolean } }>().comment;
      expect(root).toMatchObject({ mine: true, outdated: false });
      const reply = await owner.req(
        'POST',
        `/projects/${PROJECT}/code/compare/comments`,
        comment('main', 'develop', { parentId: root.id, body: 'agreed', startLine: 9, endLine: 9 }),
      );
      expect(reply.statusCode, reply.body).toBe(201);
      // A reply sits on its thread's anchor.
      expect(reply.json<{ comment: { startLine: number } }>().comment.startLine).toBe(2);
      // Only the author edits; anyone reviewing resolves; owners delete any.
      const replyId = reply.json<{ comment: { id: string } }>().comment.id;
      expect(
        (await op.req('PATCH', `/projects/${PROJECT}/code/compare/comments/${replyId}`, { body: 'x' }))
          .statusCode,
      ).toBe(403);
      const resolved = await op.req('PATCH', `/projects/${PROJECT}/code/compare/comments/${root.id}`, {
        resolved: true,
      });
      expect(resolved.json<{ comment: { resolved: boolean } }>().comment.resolved).toBe(true);
      await op.req('PATCH', `/projects/${PROJECT}/code/compare/comments/${root.id}`, { resolved: false });
      expect(
        (await op.req('DELETE', `/projects/${PROJECT}/code/compare/comments/${replyId}`)).statusCode,
      ).toBe(403);
      expect(
        (await owner.req('DELETE', `/projects/${PROJECT}/code/compare/comments/${replyId}`)).statusCode,
      ).toBe(204);
      // Another view's comments are not this view's.
      expect(
        (await viewer.req('GET', q('main', 'feature/billing'))).json<{ comments: unknown[] }>().comments,
      ).toEqual([]);
      // The head moved: the comment is outdated.
      provider.heads.develop = NEXT;
      const moved = await viewer.req('GET', q('main', 'develop'));
      expect(moved.json<{ comments: { outdated: boolean }[]; headSha: string }>()).toMatchObject({
        headSha: NEXT,
        comments: [{ outdated: true }],
      });
      provider.heads.develop = HEAD;
      // Bad refs are refused.
      expect((await viewer.req('GET', q('main', '--upload-pack=x'))).statusCode).toBe(400);
    });

    it('"Değişiklik iste": a job’s branch → its agent, a pull request → a new job on its branch, else 409', async () => {
      // Nobody to send it to.
      const none = await op.req('POST', `/projects/${PROJECT}/code/compare/request-changes`, {
        base: 'main',
        head: 'develop',
        note: 'x',
      });
      expect(none.statusCode).toBe(409);
      expect(none.json()).toMatchObject({ error: 'review_no_target' });

      // A job's attempt branch: the job's own path (queued → a message to its agent).
      const branch = `rac/${jobId}/a1`;
      provider.heads[branch] = HEAD;
      const target = await viewer.req('GET', q('main', branch));
      expect(target.json<{ target: unknown }>().target).toMatchObject({ mode: 'job', jobId, branch });
      await op.req('POST', `/projects/${PROJECT}/code/compare/comments`, comment('main', branch));
      const msg = await op.req('POST', `/projects/${PROJECT}/code/compare/request-changes`, {
        base: 'main',
        head: branch,
        note: 'Keep b at 2.',
        hunks: [{ path: 'src/app.ts', oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 }],
      });
      expect(msg.statusCode, msg.body).toBe(200);
      expect(msg.json()).toMatchObject({ mode: 'message', target: 'job', comments: 1 });
      const { rows: m } = await h.db.pool.query<{ text: string }>(
        'SELECT text FROM job_messages WHERE job_id = $1',
        [jobId],
      );
      const text = m.at(-1)?.text ?? '';
      expect(text).toContain('Keep b at 2.');
      expect(text).toContain('src/app.ts:2 (after the change): b should stay 2');
      expect(text).toContain('export const b = 2;');
      expect(text).toContain('export const b = 3;');
      const sent = await viewer.req('GET', q('main', branch));
      expect(sent.json<{ comments: { sentAt: string | null }[] }>().comments[0]?.sentAt).not.toBeNull();

      // An open pull request of the repository: a new job on its branch, its pull request into that branch.
      const pr = await viewer.req('GET', q('main', 'feature/billing'));
      expect(pr.json<{ target: unknown }>().target).toMatchObject({
        mode: 'pull',
        number: 12,
        headBranch: 'feature/billing',
      });
      expect(
        (
          await viewer.req('POST', `/projects/${PROJECT}/code/compare/request-changes`, {
            base: 'main',
            head: 'feature/billing',
            note: 'x',
          })
        ).statusCode,
      ).toBe(403);
      const started = await op.req('POST', `/projects/${PROJECT}/code/compare/request-changes`, {
        base: 'main',
        head: 'feature/billing',
        note: 'Rename a to alpha.',
      });
      expect(started.statusCode, started.body).toBe(200);
      const out = started.json<{ mode: string; target: string; jobId: string }>();
      expect(out).toMatchObject({ mode: 'job', target: 'pull' });
      const { rows: j } = await h.db.pool.query<{
        spec: { prompt: string; repository: { baseRef: string; targetBranch: string; url: string } };
        project: string;
      }>('SELECT spec, project FROM jobs WHERE id = $1', [out.jobId]);
      expect(j[0]?.project).toBe(PROJECT);
      expect(j[0]?.spec.repository).toMatchObject({
        baseRef: HEAD,
        targetBranch: 'feature/billing',
        url: 'https://example.com/acme/app.git',
      });
      expect(j[0]?.spec.prompt).toContain('pull request #12');
      expect(j[0]?.spec.prompt).toContain('Rename a to alpha.');

      // A fork's pull request cannot be worked on here.
      provider.pulls = [
        {
          ...(provider.pulls[0] as OpenPullRequest),
          number: 13,
          headBranch: 'develop',
          sameRepository: false,
          headSha: NEXT,
        },
      ];
      h.clock.advance(120_000); // past the 60 s listing cache
      const fork = await op.req('POST', `/projects/${PROJECT}/code/compare/request-changes`, {
        base: 'main',
        head: NEXT,
        note: 'x',
      });
      expect(fork.statusCode).toBe(409);

      const a = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'code.review.request_changes' AND metadata ? 'source'
          ORDER BY id`,
      );
      expect(a.rows.map((r) => r.metadata.reason)).toEqual(['job_branch', 'pull_request']);
      for (const r of a.rows) expect(Object.keys(r.metadata)).not.toContain('code');
    });
  });
});
