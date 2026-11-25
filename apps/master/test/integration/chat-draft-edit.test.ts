import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Role } from '../../src/auth/users.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore, payloadHash } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { PROJECT, REPO_URL } from '../helpers/job-worker.js';

/**
 * p12-diyalog-f3 (docs/design/p12-diyalog.md §11): `PATCH /chat/drafts/:id` edits an open job card in place. The card
 * is rebuilt by draft_job's own checks for the editing person (project role and visibility, full-access policy,
 * strict input schema), replaces the earlier version (payload + hash, so confirming still checks integrity), is
 * audited and noted in the conversation — and nothing runs until the card is confirmed with a step-up.
 */

const PW = 'quartz-meadow-lantern-7';
const OTHER = 'draft-edit-other';

interface DraftJson {
  id: string;
  kind: string;
  title: string;
  project: string | null;
  state: string;
  payload: {
    spec: Record<string, unknown>;
    priorityClass?: string;
    review?: { projectDefaults?: string[] };
  };
}

describeIntegration('chat job draft edit (integration)', { timeout: 180_000 }, () => {
  const h = new Harness();
  const users: Record<'op' | 'other', { id: string; secret: string; client: Client }> = {} as never;
  let tools: ChatTools;
  let store: ChatStore;

  beforeAll(async () => {
    await h.start();
    await h.db.pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()), ($2, $2, now()) ON CONFLICT DO NOTHING',
      [PROJECT, OTHER],
    );
    for (const [key, role] of [
      ['op', 'operator'],
      ['other', 'operator'],
    ] as const) {
      const name = `${key}.draftedit`;
      const id = await h.createUser(name, PW, role);
      await h.grant(id, [PROJECT], role);
      const { secret } = await enroll(h, name, PW);
      users[key] = { id, secret, client: await fullLogin(h, name, PW, secret) };
    }
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method, require_ci,
                                        ci_timeout_sec, updated_by, updated_at)
       VALUES ($1, 1, 'git', $2, 'main', 'merge', false, 3600, $3, now())
       ON CONFLICT (project) DO NOTHING`,
      [PROJECT, REPO_URL, users.op.id],
    );
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    tools = new ChatTools({ db: h.db.pool, store, clock: h.clock.now } as unknown as ChatToolsDeps);
  });
  afterAll(async () => {
    await h.stop();
  });

  async function caller(key: keyof typeof users, role: Role): Promise<ToolCaller> {
    const userId = users[key].id;
    const thread = await store.createThread(userId, 'draft edit');
    return {
      userId,
      subject: await loadSubject(h.db.pool, { id: userId, role }),
      threadId: thread.id,
      turnId: randomUUID(),
    };
  }

  async function draft(input: Record<string, unknown> = {}): Promise<{ id: string; threadId: string }> {
    const c = await caller('op', 'operator');
    const out = await tools.run(c, 'draft_job', {
      project: PROJECT,
      title: 'Speed up invoice PDFs',
      prompt: 'Make invoice PDF generation take under 2 seconds.',
      runtime: 'claude-code',
      ...input,
    });
    if (!out.ok || out.draft === undefined) throw new Error(JSON.stringify(out));
    return { id: out.draft.id, threadId: c.threadId };
  }

  const patch = (key: keyof typeof users, id: string, body: unknown) =>
    users[key].client.req('PATCH', `/chat/drafts/${id}`, body);

  it('rebuilds the card with the edits, keeps it unconfirmed, audits and notes it', async () => {
    const { id, threadId } = await draft();
    const res = await patch('op', id, {
      title: 'Invoice PDFs under 2 s',
      runtime: 'codex',
      priorityClass: 'background',
      approvalPolicy: 'ask-all',
      prompt: 'Make invoice PDF generation take under 2 seconds.\n- p95 under 2 s on a 10 page invoice',
    });
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json<DraftJson>();
    expect(d).toMatchObject({
      id,
      kind: 'job',
      title: 'Invoice PDFs under 2 s',
      project: PROJECT,
      state: 'proposed',
    });
    expect(d.payload.spec).toMatchObject({ runtime: 'codex', approvalPolicy: 'ask-all' });
    expect(String(d.payload.spec.prompt)).toContain('p95 under 2 s');
    expect(d.payload.priorityClass).toBe('background');
    // Fields the first card took from the project's defaults are still shown as such (not the edited one).
    expect(d.payload.review?.projectDefaults).toEqual(expect.arrayContaining(['sandboxProfile', 'limits']));
    expect(d.payload.review?.projectDefaults).not.toContain('approvalPolicy');
    // The stored hash is the new payload's: confirming checks integrity as before.
    const row = await h.db.pool.query<{
      payload: Record<string, unknown>;
      payload_hash: string;
      state: string;
    }>('SELECT payload, payload_hash, state FROM chat_drafts WHERE id = $1', [id]);
    expect(row.rows[0]?.payload_hash).toBe(payloadHash(row.rows[0]?.payload ?? {}));
    expect(row.rows[0]?.state).toBe('proposed');
    expect(
      (await h.db.pool.query("SELECT 1 FROM jobs WHERE spec->>'prompt' LIKE $1", ['%p95 under 2 s%']))
        .rowCount,
    ).toBe(0);
    const audit = await h.db.pool.query<{ metadata: { fields: string[] } }>(
      `SELECT metadata FROM audit_events WHERE action = 'chat.draft.edit' AND outcome = 'success' AND target = $1`,
      [`chat-draft:${id}`],
    );
    expect(audit.rows[0]?.metadata.fields).toEqual([
      'approvalPolicy',
      'priorityClass',
      'prompt',
      'runtime',
      'title',
    ]);
    const notes = await h.db.pool.query<{ content: string }>(
      `SELECT content FROM chat_messages WHERE thread_id = $1 AND role = 'tool'`,
      [threadId],
    );
    expect(notes.rows.some((m) => m.content.includes('edited draft'))).toBe(true);

    // Confirming the edited card (step-up) runs exactly what it now shows.
    h.clock.advance(30_000);
    const s = await users.op.client.req('POST', '/auth/step-up', { code: h.code(users.op.secret) });
    expect(s.statusCode, s.body).toBe(200);
    const ok = await users.op.client.req('POST', `/chat/drafts/${id}/confirm`);
    expect(ok.statusCode, ok.body).toBe(200);
    const jobId = ok.json<{ result: { jobId: string } }>().result.jobId;
    const job = await h.db.pool.query<{ runtime: string; policy: string; priority: number }>(
      "SELECT spec->>'runtime' AS runtime, spec->>'approvalPolicy' AS policy, priority FROM jobs WHERE id = $1",
      [jobId],
    );
    expect(job.rows[0]).toMatchObject({ runtime: 'codex', policy: 'ask-all', priority: -50 });
    // A decided card is not editable any more.
    expect((await patch('op', id, { title: 'late' })).statusCode).toBe(409);
  });

  it('applies the same rules as drafting: no hidden project, no full access the project does not allow', async () => {
    const { id } = await draft();
    const hidden = await patch('op', id, { project: OTHER });
    expect(hidden.statusCode, hidden.body).toBe(404);
    const full = await patch('op', id, { approvalPolicy: 'allow-all' });
    expect(full.statusCode, full.body).toBe(403);
    const denied = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'chat.draft.edit' AND outcome = 'denied' AND target = $1`,
      [`chat-draft:${id}`],
    );
    expect(denied.rowCount).toBeGreaterThanOrEqual(1);
    // Nothing changed.
    const row = await h.db.pool.query<{ project: string; policy: string }>(
      "SELECT project, payload->'spec'->>'approvalPolicy' AS policy FROM chat_drafts WHERE id = $1",
      [id],
    );
    expect(row.rows[0]).toEqual({ project: PROJECT, policy: 'ask-sensitive' });
  });

  it("refuses another user's card, bad bodies, other kinds and a card changed meanwhile", async () => {
    const { id } = await draft();
    expect((await patch('other', id, { title: 'mine now' })).statusCode).toBe(404);
    expect((await patch('op', id, {})).statusCode).toBe(400);
    expect((await patch('op', id, { spec: { runtime: 'codex' } })).statusCode).toBe(400);
    expect((await patch('op', id, { runtime: 'openhands' })).statusCode).toBe(400);
    // A row changed behind the card is refused, not merged (a concurrent edit or decision: the conditional update).
    await h.db.pool.query('UPDATE chat_drafts SET payload_hash = $2 WHERE id = $1', [id, '0'.repeat(64)]);
    const changed = await patch('op', id, { title: 'too late' });
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json<{ error: string }>().error).toBe('draft_tampered');
    // Only job cards are edited here.
    const c = await caller('op', 'operator');
    const other = await store.createDraft({
      threadId: c.threadId,
      userId: users.op.id,
      turnId: c.turnId,
      kind: 'job_message',
      title: 'Tell the agent',
      payload: { jobId: randomUUID(), text: 'hi' },
      project: PROJECT,
    });
    const kind = await patch('op', other.id, { title: 'x' });
    expect(kind.statusCode).toBe(400);
    expect(kind.json<{ error: string }>().error).toBe('not_editable');
  });

  it('dropping the deploy / input files and pinning a machine go through the same rebuild', async () => {
    const { id } = await draft();
    const res = await patch('op', id, { workers: ['no-such-machine'], verifyOnSuccess: 'off', inputs: null });
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json<DraftJson & { payload: { verifyOnSuccess?: string } }>();
    expect(d.payload.spec.requirements).toMatchObject({ workers: ['no-such-machine'] });
    expect(d.payload.verifyOnSuccess).toBe('off');
    const back = await patch('op', id, { workers: null });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json<DraftJson>().payload.spec.requirements).toBeUndefined();
  });
});
