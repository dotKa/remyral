import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import type { Role } from '../../src/auth/users.js';
import { ChatStore } from '../../src/chat/store.js';
import type { ChatTools, ToolCaller } from '../../src/chat/tools.js';
import type { WatchChecks } from '../../src/chat/watch-checks.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCoolify } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p19-watch-deploy against a real master database: "merge olunca deploy et" — a Takip on `job_state merged` whose
 * `then` step is `deploy` requests the project's Coolify deploy by itself (the draft_deploy card confirmed through the
 * chat's direct path, the deploy policy deciding), once; a job that ends without a merge never fires it; a user
 * without deploy rights cannot create it.
 */
const PW = 'cobalt-river-lantern-58';
const PROJECT = 'boxing';

describeIntegration(
  'Takip then deploy after a merge (integration, p19-watch-deploy)',
  { timeout: 300_000 },
  () => {
    const h = new Harness();
    const coolify = new FakeCoolify();
    let owner: Client;
    let ownerSecret = '';
    let opId = '';
    let viewerId = '';
    let store: ChatStore;
    let tools: ChatTools;

    const engine = (): WatchChecks =>
      (h.app.chatWatches as unknown as { deps: { checks: WatchChecks } }).deps.checks;

    async function caller(userId: string, role: Role): Promise<ToolCaller> {
      const thread = (await store.createThread(userId, 'deploy')).id;
      return {
        userId,
        subject: await loadSubject(h.db.pool, { id: userId, role }),
        threadId: thread,
        turnId: randomUUID(),
        turn: { byUser: true, proposeAware: () => Promise.resolve(true) },
      };
    }

    async function insertJob(): Promise<string> {
      const now = h.clock.now();
      const { rows } = await h.db.pool.query<{ id: string }>(
        `INSERT INTO jobs (project, spec, state, priority, version, lease_epoch, created_by_type, created_by_id,
                         created_at, updated_at, state_changed_at)
       VALUES ($1, $2, 'AWAITING_APPROVAL', 0, 1, 0, 'user', 'test', $3, $3, $3) RETURNING id::text AS id`,
        [PROJECT, JSON.stringify({ runtime: 'codex', prompt: 'Make the game playable' }), now],
      );
      const id = rows[0]?.id ?? '';
      await h.db.pool.query(
        `INSERT INTO job_git (job_id, project, provider, target_branch, head_sha, verification, created_at, updated_at)
       VALUES ($1, $2, 'git', 'main', $3, 'passed', now(), now())`,
        [id, PROJECT, 'a'.repeat(40)],
      );
      return id;
    }

    /** What the merge does: merged_sha and SUCCEEDED in one transaction. */
    async function merge(jobId: string, merged: boolean): Promise<void> {
      if (merged)
        await h.db.pool.query('UPDATE job_git SET merged_sha = $2, merged_at = now() WHERE job_id = $1', [
          jobId,
          'b'.repeat(40),
        ]);
      await h.db.pool.query("UPDATE jobs SET state = 'SUCCEEDED', version = version + 1 WHERE id = $1", [
        jobId,
      ]);
    }

    const thenNotes = async (threadId: string) =>
      (await store.messages(threadId)).filter(
        (m) => m.meta?.notice === 'chat-watch' && m.meta.event === 'then',
      );

    beforeAll(async () => {
      await coolify.start();
      await h.start({
        securityPolicy: { preset: 'serbest' },
        watchChecks: { dryWaitMs: 300 },
        ops: { internalOrigins: [coolify.base] },
      });
      await h.createUser('owner.wd', PW);
      ({ secret: ownerSecret } = await enroll(h, 'owner.wd', PW));
      owner = await fullLogin(h, 'owner.wd', PW, ownerSecret);
      opId = await h.createUser('op.wd', PW, 'operator');
      viewerId = await h.createUser('viewer.wd', PW, 'viewer');
      await h.db.pool.query(
        "INSERT INTO projects (id, name, kind, created_at) VALUES ($1, $1, 'workspace', now()) ON CONFLICT (id) DO NOTHING",
        [PROJECT],
      );
      await h.grant(opId, [PROJECT], 'operator');
      await h.grant(viewerId, [PROJECT], 'viewer');
      coolify.addApp({ uuid: 'boxprev01', name: 'boxing-preview' });
      coolify.addApp({ uuid: 'boxprod01', name: 'boxing-prod' });
      h.clock.advance(30_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
      expect(
        (await owner.req('PUT', '/integrations/ops/coolify', { url: coolify.base, token: coolify.token }))
          .statusCode,
      ).toBe(200);
      const t = await owner.req('PUT', `/projects/${PROJECT}/deploy-targets`, {
        targets: { coolify: { preview: { uuids: ['boxprev01'] }, production: { uuids: ['boxprod01'] } } },
      });
      expect(t.statusCode, t.body).toBe(200);
      store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      tools = (h.app.chat as unknown as { deps: { tools: ChatTools } }).deps.tools;
      await engine().listen();
      for (let i = 0; i < 100 && !engine().listening; i++) await new Promise((r) => setTimeout(r, 100));
    });
    afterAll(async () => {
      await h.stop();
      await coolify.stop();
    });

    it('merged → the preview deploy is requested by itself, once, with a note and the deploy link', async () => {
      coolify.reset();
      const c = await caller(opId, 'operator');
      const jobId = await insertJob();
      const out = await tools.run(c, 'create_watch', {
        condition: { kind: 'job_state', jobId, states: ['merged'] },
        label: 'Oyun işi',
        then: { action: 'deploy', project: PROJECT, env: 'preview', mode: 'auto' },
      });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok) return;
      const data = out.data as { watchId: string; then: { action: string; mode: string; onMet: string } };
      expect(data.then).toMatchObject({ action: 'deploy', mode: 'auto' });
      expect(data.then.onMet).toContain('runs by itself');
      expect(coolify.calls(/POST/)).toEqual([]);

      await merge(jobId, true);
      await engine().evaluate(data.watchId, 'event');
      await engine().idle();
      await expect.poll(async () => (await thenNotes(c.threadId)).length, { timeout: 15_000 }).toBe(1);
      await Promise.all(Array.from({ length: 3 }, () => engine().evaluate(data.watchId, 'event')));
      await engine().idle();

      expect(coolify.calls(/POST/)).toEqual(['POST /api/v1/deploy?uuid=boxprev01']);
      const note = (await thenNotes(c.threadId))[0];
      expect(note?.content).toContain(PROJECT);
      expect(note?.meta).toMatchObject({ executed: true });
      expect(String((note?.meta as { link?: unknown } | undefined)?.link)).toMatch(/^\/deploys\//);
      const d = await h.db.pool.query<{ kind: string; state: string }>(
        'SELECT kind, state FROM chat_drafts WHERE thread_id = $1',
        [c.threadId],
      );
      expect(d.rows).toEqual([{ kind: 'ops_action', state: 'confirmed' }]);
    });

    it('a job that ends without a merge never deploys (the watch ends)', async () => {
      coolify.reset();
      const c = await caller(opId, 'operator');
      const jobId = await insertJob();
      const out = await tools.run(c, 'create_watch', {
        condition: { kind: 'job_state', jobId, states: ['merged'] },
        then: { action: 'deploy', project: PROJECT, env: 'preview', mode: 'auto' },
      });
      if (!out.ok) throw new Error(JSON.stringify(out));
      const watchId = (out.data as { watchId: string }).watchId;
      await merge(jobId, false);
      await engine().evaluate(watchId, 'event');
      await engine().idle();
      await expect
        .poll(
          async () =>
            (
              await h.db.pool.query<{ state: string }>('SELECT state FROM chat_watches WHERE id = $1', [
                watchId,
              ])
            ).rows[0]?.state,
          { timeout: 15_000 },
        )
        .not.toBe('active');
      expect(await thenNotes(c.threadId)).toEqual([]);
      expect(coolify.calls(/POST/)).toEqual([]);
    });

    it('a viewer cannot attach a deploy step', async () => {
      const c = await caller(viewerId, 'viewer');
      const jobId = await insertJob();
      const out = await tools.run(c, 'create_watch', {
        condition: { kind: 'job_state', jobId, states: ['merged'] },
        then: { action: 'deploy', project: PROJECT, mode: 'auto' },
      });
      expect(out.ok).toBe(false);
    });
  },
);
