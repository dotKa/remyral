import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import type { PreviewDeps } from '../../src/composer/preview.js';
import { Cluster } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { PROJECT, REPO_URL } from '../helpers/job-worker.js';

/**
 * p6-chat-job-defaults (docs/design/p6-automations.md §2b) against a real master, Postgres and a real worker daemon
 * that has only `host-restricted` ready (like the owner's Windows machine without a container runtime): the
 * assistant's one-off `draft_job` takes the project's defaults exactly like the composer and automations, keeps
 * explicit values, and the card reports the machines that can run it or a warning when none can; a
 * `draft_workflow_run` reports its steps' sandbox, approval policy and placement.
 */

interface Review {
  projectDefaults?: string[];
  placement: { verdict: string; machines: string[]; warning: string | null; note: string | null } | null;
}

describeIntegration(
  'chat job drafts take the project defaults and check placement (integration)',
  { timeout: 240_000 },
  () => {
    const c = new Cluster();
    let ownerId = '';
    let tools: ChatTools;
    let store: ChatStore;
    let worker = '';

    beforeAll(async () => {
      await c.start(0, { loop: false });
      ownerId =
        (await c.h.db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'owner1'")).rows[0]
          ?.id ?? '';
      await c.h.db.pool.query('UPDATE projects SET host_execution = true WHERE id = $1', [PROJECT]);
      await c.h.db.pool.query(
        `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method, require_ci,
                                        ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', $2, 'main', 'merge', false, 3600, $3, now())
       ON CONFLICT (project) DO NOTHING`,
        [PROJECT, REPO_URL, ownerId],
      );
      store = new ChatStore({ pool: c.h.db.pool, clock: c.h.clock.now });
      const app = c.h.app;
      // The composer's placement preview over the real fleet (as compose.ts wires it for the chat tools).
      const preview = (): PreviewDeps => ({
        db: c.h.db.pool,
        candidates: (project) => app.orchestrator.candidates(project),
        quotas: (project, runtime) => app.quotas.preview(project, runtime),
        policyOf: () => Promise.resolve(null),
      });
      tools = new ChatTools({
        db: c.h.db.pool,
        store,
        clock: c.h.clock.now,
        preview,
      } as unknown as ChatToolsDeps);
    });
    afterAll(async () => {
      await c.stop();
    });

    async function caller(): Promise<ToolCaller> {
      if (worker === '') ({ id: worker } = await c.newWorker());
      const thread = await store.createThread(ownerId, 'chat job defaults');
      return {
        userId: ownerId,
        subject: await loadSubject(c.h.db.pool, { id: ownerId, role: 'owner' }),
        threadId: thread.id,
        turnId: randomUUID(),
      };
    }

    async function draftJob(input: Record<string, unknown>) {
      const out = await tools.run(await caller(), 'draft_job', {
        project: PROJECT,
        title: 'List processes',
        prompt: 'List the running processes and report anything unusual.',
        runtime: 'codex',
        ...input,
      });
      if (!out.ok || out.draft === undefined) throw new Error(JSON.stringify(out));
      const payload = out.draft.payload as { spec: Record<string, unknown>; review: Review };
      return { out, payload, data: out.data as Record<string, unknown> };
    }

    it('draft_job without a sandbox takes the best ready host profile and names the machine that can run it', async () => {
      const { payload, data } = await draftJob({});
      expect(payload.spec).toMatchObject({
        sourceTrust: 'trusted',
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 3600 },
      });
      expect(payload.spec.model).toBeUndefined(); // the project's default model, resolved at submission
      expect(payload.review.projectDefaults).toEqual(['sandboxProfile', 'approvalPolicy', 'limits']);
      expect(payload.review.placement).toMatchObject({ verdict: 'placed', warning: null, note: null });
      expect(payload.review.placement?.machines).toHaveLength(1);
      // The model sees the same facts in the tool result.
      expect(data).toMatchObject({
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        placement: { verdict: 'placed', warning: null },
      });
    });

    it('without the host-execution opt-in the default is container — and the card warns that no machine can run it', async () => {
      await c.h.db.pool.query('UPDATE projects SET host_execution = false WHERE id = $1', [PROJECT]);
      try {
        const { payload, data } = await draftJob({});
        expect(payload.spec).toMatchObject({ sandboxProfile: 'container', approvalPolicy: 'ask-sensitive' });
        expect(payload.review.placement?.verdict).toBe('infeasible');
        expect(payload.review.placement?.machines).toEqual([]);
        expect(payload.review.placement?.warning).toContain(
          'No machine can run this target (codex, container sandbox)',
        );
        expect(data).toMatchObject({ placement: { verdict: 'infeasible' } });
      } finally {
        await c.h.db.pool.query('UPDATE projects SET host_execution = true WHERE id = $1', [PROJECT]);
      }
    });

    it('keeps explicitly requested values (and still checks them)', async () => {
      const { payload } = await draftJob({
        sandboxProfile: 'container',
        approvalPolicy: 'deny-sensitive',
        maxDurationSec: 900,
      });
      expect(payload.spec).toMatchObject({
        sandboxProfile: 'container',
        approvalPolicy: 'deny-sensitive',
        limits: { maxDurationSec: 900 },
      });
      expect(payload.review.projectDefaults).toBeUndefined();
      expect(payload.review.placement?.warning).toContain('container sandbox');
    });

    it('draft_workflow_run reports the steps’ sandbox, approval policy and where they can run', async () => {
      await caller(); // pairs the worker
      const define = async (sandboxProfile: string): Promise<string> => {
        const res = await c.admin.req('POST', '/workflows', {
          project: PROJECT,
          definition: {
            name: `wf-${sandboxProfile}-${randomUUID().slice(0, 4)}`,
            defaults: {
              runtime: 'codex',
              sandboxProfile,
              sourceTrust: 'trusted',
              approvalPolicy: 'deny-sensitive',
              limits: { maxDurationSec: 600 },
              repository: { url: REPO_URL, baseRef: 'main' },
            },
            nodes: [
              { id: 'build', role: 'executor', prompt: 'Build it.' },
              { id: 'check', role: 'verifier', prompt: 'Check it.' },
            ],
            edges: [{ from: 'build', to: 'check' }],
          },
        });
        expect(res.statusCode, res.body).toBe(201);
        return res.json<{ id: string }>().id;
      };
      const host = await tools.run(await caller(), 'draft_workflow_run', {
        workflowId: await define('host-restricted'),
      });
      if (!host.ok || host.draft === undefined) throw new Error(JSON.stringify(host));
      expect(host.draft.payload).toMatchObject({
        sandboxProfiles: ['host-restricted'],
        approvalPolicy: 'deny-sensitive',
        review: { placement: { verdict: 'placed', warning: null } },
      });
      const boxed = await tools.run(await caller(), 'draft_workflow_run', {
        workflowId: await define('container'),
      });
      if (!boxed.ok || boxed.draft === undefined) throw new Error(JSON.stringify(boxed));
      const review = (boxed.draft.payload as { review: Review }).review;
      expect(review.placement?.verdict).toBe('infeasible');
      expect(review.placement?.warning).toContain('container sandbox');
    });

    it('p9-queue-priority: Acil only when the user asked for urgency in this turn; otherwise Normal with a note', async () => {
      async function turnWith(text: string): Promise<ToolCaller> {
        const base = await caller();
        await store.addMessage(base.threadId, { role: 'user', content: text });
        c.h.clock.advance(1_000);
        const turnId = randomUUID();
        await store.createTurn({
          id: turnId,
          threadId: base.threadId,
          userId: ownerId,
          workerId: worker,
          runtime: 'claude-code',
          model: undefined,
        });
        return { ...base, turnId };
      }
      const input = {
        project: PROJECT,
        title: 'Call the endpoint',
        prompt: 'Send a request to the endpoint and report the status.',
        runtime: 'codex',
        priorityClass: 'urgent',
      };
      const asked = await tools.run(await turnWith('ACİL: şu endpointe istek at'), 'draft_job', input);
      if (!asked.ok || asked.draft === undefined) throw new Error(JSON.stringify(asked));
      expect(asked.draft.payload).toMatchObject({ priorityClass: 'urgent' });
      expect(asked.data).toMatchObject({ priorityClass: 'urgent' });
      expect((asked.data as Record<string, unknown>).priorityNote).toBeUndefined();
      // The model asks for urgent, but the user did not: the card is Normal and the model is told why.
      const notAsked = await tools.run(await turnWith('şu endpointe istek at'), 'draft_job', input);
      if (!notAsked.ok || notAsked.draft === undefined) throw new Error(JSON.stringify(notAsked));
      expect(notAsked.draft.payload).toMatchObject({ priorityClass: 'normal' });
      expect((notAsked.data as Record<string, unknown>).priorityNote).toMatch(/does not ask for urgency/);
      // Background needs no guard; no class = Normal.
      const bg = await tools.run(await turnWith('run it when idle'), 'draft_job', {
        ...input,
        priorityClass: 'background',
      });
      expect(bg.ok && bg.draft?.payload).toMatchObject({ priorityClass: 'background' });
      const plain = await tools.run(await turnWith('acil'), 'draft_job', {
        ...input,
        priorityClass: undefined,
      });
      expect(plain.ok && plain.draft?.payload).toMatchObject({ priorityClass: 'normal' });
    });
  },
);
