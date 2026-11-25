import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ChatStore } from '../../src/chat/store.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';
import { PROJECT } from '../helpers/job-worker.js';

/**
 * p22-workflow-draft-supersede: a new workflow card replaces the caller's open card of the same workflow (project and
 * name) in the conversation; other workflows, other conversations and other kinds are left alone.
 */
describeIntegration('workflow draft supersede (integration)', { timeout: 120_000 }, () => {
  const h = new Harness();
  let store: ChatStore;
  let userId: string;

  beforeAll(async () => {
    await h.start();
    await h.db.pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
      [PROJECT],
    );
    userId = await h.createUser('op.wfsupersede', 'quartz-meadow-lantern-7', 'operator');
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
  });
  afterAll(async () => {
    await h.stop();
  });

  const wf = (threadId: string, name: string) =>
    store.createDraft({
      threadId,
      userId,
      turnId: randomUUID(),
      kind: 'workflow',
      title: `Workflow ${name} v8`,
      payload: { name, baseVersion: 7, nonce: randomUUID() },
      project: PROJECT,
    });
  const stateOf = async (id: string) =>
    (
      await h.db.pool.query<{ state: string; result: Record<string, unknown> | null }>(
        'SELECT state, result FROM chat_drafts WHERE id = $1',
        [id],
      )
    ).rows[0];

  it('the newer card of the same workflow closes the older one as superseded', async () => {
    const thread = await store.createThread(userId, 'wf supersede');
    const other = await store.createThread(userId, 'wf supersede other');
    const old = await wf(thread.id, 'gunluk-lead-teklif');
    const sibling = await wf(thread.id, 'lead-wa-kontrol');
    const elsewhere = await wf(other.id, 'gunluk-lead-teklif');
    const job = await store.createDraft({
      threadId: thread.id,
      userId,
      turnId: randomUUID(),
      kind: 'job',
      title: 'job',
      payload: { name: 'gunluk-lead-teklif' },
      project: PROJECT,
    });
    const fresh = await wf(thread.id, 'gunluk-lead-teklif');
    expect(await stateOf(old.id)).toEqual({
      state: 'dismissed',
      result: { reason: 'superseded', supersededBy: fresh.id },
    });
    for (const d of [sibling, elsewhere, job, fresh]) expect((await stateOf(d.id))?.state).toBe('proposed');
  });
});
