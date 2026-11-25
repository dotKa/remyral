import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { Cluster } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { PROJECT, REPO_URL } from '../helpers/job-worker.js';

/**
 * p6-automation-defaults (docs/design/p6-automations.md §2a, §11a) against a real master, Postgres and a real worker
 * daemon that has only `host-restricted` ready (like the owner's Windows machine): an automation's job takes the
 * project's defaults exactly like the composer — REST create without a sandbox and the assistant's draft_automation
 * — and the draft reports the placement (no machine can run a container job here) and the unattended approval policy.
 */

describeIntegration(
  'automation project defaults and draft checks (integration)',
  { timeout: 240_000 },
  () => {
    const c = new Cluster();
    let ownerId = '';
    let tools: ChatTools;
    let store: ChatStore;

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
      tools = new ChatTools({
        db: c.h.db.pool,
        store,
        clock: c.h.clock.now,
        automations: () => c.h.app.automations,
      } as unknown as ChatToolsDeps);
    });
    afterAll(async () => {
      await c.stop();
    });

    let worker = '';
    /** Paired once, from a test (pairing uses expect.poll). */
    async function ensureWorker(): Promise<void> {
      if (worker === '') ({ id: worker } = await c.newWorker());
    }

    async function caller(): Promise<ToolCaller> {
      await ensureWorker();
      const thread = await store.createThread(ownerId, 'automation defaults');
      return {
        userId: ownerId,
        subject: await loadSubject(c.h.db.pool, { id: ownerId, role: 'owner' }),
        threadId: thread.id,
        turnId: randomUUID(),
      };
    }

    async function createBare(): Promise<Record<string, unknown>> {
      await ensureWorker();
      await c.stepUp();
      const res = await c.admin.req('POST', '/automations', {
        project: PROJECT,
        name: `defaults ${randomUUID().slice(0, 6)}`,
        trigger: { kind: 'cron', cron: '0 0 1 1 *' },
        target: {
          kind: 'job',
          spec: {
            runtime: 'codex',
            prompt: 'Summarise the open issues.',
            repository: { url: REPO_URL, baseRef: 'main', workBranch: 'agent/auto-x' },
          },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json<{ automation: { id: string } }>().automation.id;
      const detail = await c.admin.req('GET', `/automations/${id}`);
      return detail.json<{ targetSpec: { spec: Record<string, unknown> } }>().targetSpec.spec;
    }

    it('REST create without a sandbox: the best ready host profile when the project opted in, else container', async () => {
      expect(await createBare()).toMatchObject({
        sourceTrust: 'trusted',
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 3600 },
      });
      await c.h.db.pool.query('UPDATE projects SET host_execution = false WHERE id = $1', [PROJECT]);
      try {
        expect(await createBare()).toMatchObject({ sourceTrust: 'trusted', sandboxProfile: 'container' });
      } finally {
        await c.h.db.pool.query('UPDATE projects SET host_execution = true WHERE id = $1', [PROJECT]);
      }
    });

    it('draft_automation relies on the project defaults and reports placement and the approval policy', async () => {
      const out = await tools.run(await caller(), 'draft_automation', {
        project: PROJECT,
        name: 'Daily processes',
        trigger: { kind: 'cron', cron: '0 6 * * *' },
        prompt: 'List the running processes and report anything unusual.',
        runtime: 'codex',
      });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok || out.draft === undefined) throw new Error('no draft');
      expect(out.draft.payload).toMatchObject({
        action: 'create',
        input: { target: { spec: { sandboxProfile: 'host-restricted', approvalPolicy: 'ask-sensitive' } } },
        review: {
          sandboxProfile: 'host-restricted',
          approvalPolicy: 'ask-sensitive',
          approvalTimeoutMinutes: 60,
          placement: { verdict: 'placed', warning: null },
        },
      });
      const review = (
        out.draft.payload as { review: { approvalWarning: string; placement: { machines: string[] } } }
      ).review;
      expect(review.placement.machines).toHaveLength(1);
      expect(review.approvalWarning).toContain('Runs unattended — it will pause until someone approves.');
      expect(review.approvalWarning).toContain('60 minutes');
      // The model sees the same checks in the tool result.
      expect(out.data).toMatchObject({ approvalPolicy: 'ask-sensitive', sandboxProfile: 'host-restricted' });
    });

    it('warns when no machine can run the target (the live case: a container job, no container ready)', async () => {
      const out = await tools.run(await caller(), 'draft_automation', {
        project: PROJECT,
        name: 'In a container',
        trigger: { kind: 'cron', cron: '0 6 * * *' },
        prompt: 'Check the disk usage.',
        runtime: 'codex',
        sandboxProfile: 'container',
        approvalPolicy: 'deny-sensitive',
      });
      if (!out.ok || out.draft === undefined) throw new Error(JSON.stringify(out));
      const review = (
        out.draft.payload as {
          review: { approvalWarning: string | null; placement: { verdict: string; warning: string | null } };
        }
      ).review;
      expect(review.placement.verdict).toBe('infeasible');
      expect(review.placement.warning).toContain('No machine can run this target (codex, container sandbox)');
      // deny-sensitive refuses instead of waiting: nothing to warn about.
      expect(review.approvalWarning).toBeNull();
      // allow-all needs the project's auto-approve opt-in (the composer's rule).
      const never = await tools.run(await caller(), 'draft_automation', {
        project: PROJECT,
        name: 'Never asks',
        trigger: { kind: 'cron', cron: '0 6 * * *' },
        prompt: 'Check the disk usage.',
        runtime: 'codex',
        approvalPolicy: 'allow-all',
      });
      expect(never).toMatchObject({ ok: false, code: 'forbidden' });
    });
  },
);
