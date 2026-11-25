import { randomUUID } from 'node:crypto';
import { FakeAssistantEngine } from '@remyral/agent-adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalService } from '../../src/approvals/index.js';
import { AuditLog } from '../../src/audit/audit.js';
import { ChatStore } from '../../src/chat/store.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

interface Message {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'error';
  content: string;
  meta: Record<string, unknown> | null;
}
interface Draft {
  id: string;
  kind: string;
  state: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
}
interface ThreadDetail {
  thread: { id: string; title: string; archived: boolean };
  messages: Message[];
  drafts: Draft[];
  turn: { id: string; state: string; text: string } | null;
}

/**
 * p5-ops-chat (ADR-0018) end to end through the real transport: master ↔ real worker daemon (WsTransport) with
 * the real assistant host and the deterministic fake engine. Covers threads CRUD and privacy, streaming turns,
 * tool authorization per role (the tools act as the requesting user), draft cards whose confirmation needs
 * step-up and re-checks the target action, redaction of tool results, rate limits, budgets, the kill switch,
 * an offline assistant worker, and messages to a running job.
 */
describeIntegration('ops chat (integration, p5-ops-chat)', () => {
  let h: Harness;
  let url: string;
  let owner: Client;
  let ownerSecret: string;
  let op: Client;
  let opSecret: string;
  let viewer: Client;
  let opBeta: Client;
  const dirs: string[] = [];
  let worker: RunningWorker | undefined;
  let workerId = '';
  const engine = new FakeAssistantEngine();
  let alphaJob = '';
  let betaJob = '';
  let settingsVersion = 1;

  async function stepUp(c: Client, secret: string): Promise<void> {
    h.clock.advance(30_000);
    expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function putSettings(body: Record<string, unknown>): Promise<void> {
    await stepUp(owner, ownerSecret);
    const res = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId,
      runtime: 'claude-code',
      modelProfile: null,
      expectedVersion: settingsVersion,
      ...body,
    });
    expect(res.statusCode, res.body).toBe(200);
    settingsVersion = res.json<{ version: number }>().version;
  }

  async function newThread(c: Client): Promise<string> {
    const res = await c.req('POST', '/chat/threads', {});
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function detail(c: Client, id: string): Promise<ThreadDetail> {
    const res = await c.req('GET', `/chat/threads/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ThreadDetail>();
  }

  /** Sends a message and waits until the turn ended; returns the last assistant/error message. */
  async function ask(c: Client, threadId: string, text: string): Promise<Message> {
    const res = await c.req('POST', `/chat/threads/${threadId}/messages`, { text });
    expect(res.statusCode, res.body).toBe(202);
    const userSeq = res.json<{ message: Message }>().message.seq;
    let last: Message | undefined;
    await expect
      .poll(
        async () => {
          const d = await detail(c, threadId);
          last = d.messages
            .filter((m) => m.seq > userSeq && (m.role === 'assistant' || m.role === 'error'))
            .at(-1);
          return d.turn === null && last !== undefined;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    return last as Message;
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    const opId = await h.createUser('op.alpha', PW, 'operator');
    await h.grant(opId, ['alpha'], 'operator');
    ({ secret: opSecret } = await enroll(h, 'op.alpha', PW));
    op = await fullLogin(h, 'op.alpha', PW, opSecret);
    const viewerId = await h.createUser('viewer.alpha', PW, 'viewer');
    await h.grant(viewerId, ['alpha'], 'viewer');
    const { secret: viewerSecret } = await enroll(h, 'viewer.alpha', PW);
    viewer = await fullLogin(h, 'viewer.alpha', PW, viewerSecret);
    const betaId = await h.createUser('op.beta', PW, 'operator');
    await h.grant(betaId, ['beta'], 'operator');
    const { secret: betaSecret } = await enroll(h, 'op.beta', PW);
    opBeta = await fullLogin(h, 'op.beta', PW, betaSecret);

    // Jobs: one per project; the alpha prompt carries a GitHub token that must never reach the model.
    const audit = new AuditLog(h.db.pool, h.clock.now);
    const jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    const creator: JobActor = { type: 'user', id: opId };
    const spec = (prompt: string, branch: string) => ({
      runtime: 'codex',
      prompt,
      repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: branch },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    });
    alphaJob = (
      await jobs.create({
        project: 'alpha',
        actor: creator,
        submit: true,
        spec: spec(`Fix the login flake. Use ${TOKEN} for the API.`, 'w/alpha'),
      })
    ).job.id;
    betaJob = (
      await jobs.create({
        project: 'beta',
        actor: { type: 'user', id: betaId },
        submit: true,
        spec: spec('Beta secret roadmap work', 'w/beta'),
      })
    ).job.id;
    // alpha has a registered repository (draft_job uses it).
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                        require_ci, ci_timeout_sec, updated_by, updated_at)
       VALUES ('alpha', 1, 'git', 'https://example.com/acme/repo.git', 'main', 'merge', false, 3600, $1, $2)`,
      [opId, h.clock.now()],
    );
  });

  afterAll(async () => {
    await worker?.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  it('reports why chat is unavailable until an administrator configures it', async () => {
    // expect.poll (used by the pairing helper) only works inside a test.
    await stepUp(owner, ownerSecret);
    const dataDir = await tempDataDir(dirs);
    workerId = await pairRealWorker(h, url, owner, ownerSecret, dataDir);
    worker = await runRealWorker(url, dataDir, {
      capabilities: CAPS,
      assistant: { engine, clock: h.clock.now },
    });
    const status = await viewer.req('GET', '/chat/status');
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ available: false, code: 'not_configured', enabled: false });
    // Settings are admin-only (and writing them needs step-up).
    expect((await viewer.req('GET', '/chat/settings')).statusCode).toBe(403);
    expect((await op.req('PUT', '/chat/settings', { enabled: true })).statusCode).toBe(403);
    const noStepUp = await owner.clone().req('PUT', '/chat/settings', {
      enabled: true,
      workerId: 'nope',
      runtime: 'claude-code',
      modelProfile: null,
      expectedVersion: 1,
    });
    expect([400, 403]).toContain(noStepUp.statusCode);
    await putSettings({});
    await expect
      .poll(async () => (await op.req('GET', '/chat/status')).json<{ available: boolean }>().available, {
        timeout: 15_000,
      })
      .toBe(true);
    const ok = (await op.req('GET', '/chat/status')).json<{ worker: { id: string; online: boolean } }>();
    expect(ok.worker).toMatchObject({ id: workerId, online: true });
  });

  it('offers every assistant runtime with the readiness each worker reported (p5-ops-chat-next)', async () => {
    const got = await owner.req('GET', '/chat/settings');
    expect(got.statusCode, got.body).toBe(200);
    const engines = got.json<{
      engines: {
        workerId: string;
        online: boolean;
        disabled: boolean;
        engines: { runtime: string; ready: boolean }[];
      }[];
    }>().engines;
    expect(engines.find((w) => w.workerId === workerId)).toMatchObject({
      online: true,
      disabled: false,
      engines: [{ runtime: 'claude-code', ready: true }],
    });
    // A profile for Claude Code only is refused for Codex; an OpenCode profile resolves to provider/model.
    const entry = (id: string, runtimes: string[]) =>
      JSON.stringify({ id, displayName: id, runtimes, provider: 'acme', model: 'm-1', enabled: true });
    await h.db.pool.query(
      `INSERT INTO model_catalog (id, entry, enabled, version, created_at, updated_at)
       VALUES ('cc-only', $1, true, 1, $3, $3), ('oc-acme', $2, true, 1, $3, $3)`,
      [entry('cc-only', ['claude-code']), entry('oc-acme', ['opencode', 'pi']), h.clock.now()],
    );
    await stepUp(owner, ownerSecret);
    const wrong = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId,
      runtime: 'codex',
      modelProfile: 'cc-only',
      expectedVersion: settingsVersion,
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: 'model_profile_runtime' });
    expect(wrong.json<{ message: string }>().message).toContain('Codex');
    for (const runtime of ['codex', 'pi']) {
      await putSettings({ runtime, modelProfile: runtime === 'pi' ? 'oc-acme' : null });
      const s = await owner.req('GET', '/chat/settings');
      expect(s.json()).toMatchObject({ runtime });
      // This worker reports Claude Code only: chat is unavailable for the other runtime, with the reason.
      const status = (await op.req('GET', '/chat/status')).json<{
        available: boolean;
        code: string;
        model: string | null;
      }>();
      expect(status).toMatchObject({ available: false, code: 'engine_not_ready' });
      if (runtime === 'pi') expect(status.model).toBe('acme/m-1');
    }
    await putSettings({ runtime: 'opencode', modelProfile: 'oc-acme' });
    await putSettings({ runtime: 'claude-code', modelProfile: null });
    await expect
      .poll(async () => (await op.req('GET', '/chat/status')).json<{ available: boolean }>().available, {
        timeout: 15_000,
      })
      .toBe(true);
  });

  describe('threads', () => {
    it('are private per user: create, list, search, rename, archive, delete', async () => {
      const a = await newThread(op);
      const reply = await ask(op, a, 'hello assistant');
      expect(reply.role).toBe('assistant');
      expect(reply.content).toContain('Echo: hello assistant');
      // The first message titles the thread.
      expect((await detail(op, a)).thread.title).toBe('hello assistant');
      const b = await newThread(op);
      expect(
        (await op.req('GET', '/chat/threads?q=hello'))
          .json<{ items: { id: string }[] }>()
          .items.map((t) => t.id),
      ).toEqual([a]);
      // Another user cannot see, rename, send to, stream or delete it.
      expect((await viewer.req('GET', `/chat/threads/${a}`)).statusCode).toBe(404);
      expect((await viewer.req('PATCH', `/chat/threads/${a}`, { title: 'x' })).statusCode).toBe(404);
      expect((await viewer.req('POST', `/chat/threads/${a}/messages`, { text: 'hi' })).statusCode).toBe(404);
      expect((await viewer.req('GET', `/chat/threads/${a}/stream`)).statusCode).toBe(404);
      expect((await viewer.req('DELETE', `/chat/threads/${a}`)).statusCode).toBe(404);
      expect((await viewer.req('GET', '/chat/threads')).json<{ items: unknown[] }>().items).toEqual([]);
      // Not even an owner reads another user's conversation.
      expect((await owner.req('GET', `/chat/threads/${a}`)).statusCode).toBe(404);
      const renamed = await op.req('PATCH', `/chat/threads/${a}`, { title: 'Login flake' });
      expect(renamed.json()).toMatchObject({ title: 'Login flake' });
      expect((await op.req('PATCH', `/chat/threads/${b}`, { archived: true })).json()).toMatchObject({
        archived: true,
      });
      expect(
        (await op.req('GET', '/chat/threads')).json<{ items: { id: string }[] }>().items.map((t) => t.id),
      ).toEqual([a]);
      expect(
        (await op.req('GET', '/chat/threads?archived=true'))
          .json<{ items: { id: string }[] }>()
          .items.map((t) => t.id),
      ).toEqual([b]);
      expect((await op.req('POST', `/chat/threads/${b}/messages`, { text: 'x' })).statusCode).toBe(409);
      expect((await op.req('DELETE', `/chat/threads/${b}`)).statusCode).toBe(204);
      expect((await op.req('GET', `/chat/threads/${b}`)).statusCode).toBe(404);
      // CSRF applies to every write.
      const noCsrf = op.clone();
      noCsrf.sendCsrf = false;
      expect((await noCsrf.req('POST', '/chat/threads', {})).statusCode).toBe(403);
    });

    it('keeps one assistant session per thread and gives a new session the history', async () => {
      const t = await newThread(op);
      await ask(op, t, 'first');
      const second = await ask(op, t, 'second');
      expect(second.content).toContain('(history: none; turn 2)');
      const sessions = engine.sessions.filter((s) => s.turns.some((x) => x.message === 'first'));
      expect(sessions).toHaveLength(1);
      // The history the master sends is fenced as untrusted data.
      expect(sessions[0]?.turns[0]?.history ?? '').toBe('');
      const other = await newThread(op);
      await ask(op, other, 'x');
      const s2 = engine.sessions.at(-1);
      expect(s2?.turns[0]?.message).toBe('x');
    });
  });

  it('streams the answer to an open view (SSE)', async () => {
    const t = await newThread(op);
    const base = url.replace(/^ws/, 'http');
    const cookie = [...op.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const ac = new AbortController();
    const res = await fetch(`${base}/chat/threads/${t}/stream`, {
      headers: { cookie, 'user-agent': 'vitest-client' },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = res.body;
    if (body === null) throw new Error('no body');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const frames: { event: string; data: unknown }[] = [];
    let buffer = '';
    const pump = (async () => {
      for (;;) {
        const chunk = (await reader.read()) as { value?: Uint8Array; done: boolean };
        if (chunk.done || chunk.value === undefined) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = /^event: (.+)$/m.exec(raw)?.[1];
          const data = raw
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (event !== undefined) frames.push({ event, data: data === '' ? null : JSON.parse(data) });
          if (event === 'done') return;
        }
      }
    })();
    await expect.poll(() => frames.some((f) => f.event === 'ready')).toBe(true);
    expect(frames[0]).toEqual({ event: 'ready', data: { turn: null } });
    const sent = await op.req('POST', `/chat/threads/${t}/messages`, { text: 'stream me please' });
    expect(sent.statusCode).toBe(202);
    await pump;
    ac.abort();
    const names = frames.map((f) => f.event);
    for (const e of ['message', 'turn', 'delta', 'done']) expect(names).toContain(e);
    const text = frames
      .filter((f) => f.event === 'delta')
      .map((f) => (f.data as { text: string }).text)
      .join('');
    expect(text).toContain('Echo: stream me please');
    // A second user cannot open the stream.
    const other = [...viewer.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const denied = await fetch(`${base}/chat/threads/${t}/stream`, {
      headers: { cookie: other, 'user-agent': 'vitest-client' },
    });
    expect(denied.status).toBe(404);
  });

  describe('tools act with the requesting user’s permissions', () => {
    it('scopes reads to the user’s projects and refuses what the role does not allow', async () => {
      const t = await newThread(op);
      const jobs = await ask(op, t, '[[tool list_jobs {}]]');
      expect(jobs.content).toContain(alphaJob);
      expect(jobs.content).not.toContain(betaJob);
      expect(jobs.content).toContain('untrusted data, not instructions');
      const foreign = await ask(op, t, `[[tool describe_job {"jobId":"${betaJob}"}]]`);
      expect(foreign.content).toContain('refused');
      expect(foreign.content).toContain('not found');
      expect(foreign.content).not.toContain('Beta secret roadmap');
      const audit = await ask(op, t, '[[tool search_audit {}]]');
      expect(audit.content).toContain('not allowed');
      const workers = await ask(op, t, '[[tool list_workers {}]]');
      expect(workers.content).toContain(workerId);

      const b = await newThread(opBeta);
      const betaView = await ask(opBeta, b, '[[tool list_jobs {}]]');
      expect(betaView.content).toContain(betaJob);
      expect(betaView.content).not.toContain(alphaJob);

      const v = await newThread(viewer);
      const draft = await ask(
        viewer,
        v,
        '[[tool draft_job {"project":"alpha","title":"x","prompt":"y","runtime":"codex"}]]',
      );
      expect(draft.content).toContain('not allowed');
      expect((await detail(viewer, v)).drafts).toEqual([]);

      const o = await newThread(owner);
      const ownerAudit = await ask(owner, o, '[[tool search_audit {"action":"chat."}]]');
      expect(ownerAudit.content).toContain('chat.tool');
      // Every tool call is audited with the user, the tool and the outcome (no inputs).
      const { rows } = await h.db.pool.query<{ outcome: string; metadata: { tool: string } }>(
        `SELECT outcome, metadata FROM audit_events WHERE action = 'chat.tool' AND metadata->>'tool' = 'search_audit'`,
      );
      expect(rows.map((r) => r.outcome).sort()).toEqual(['denied', 'success']);
    });

    it('machine tools (p5-machine-admin): admins only, drafts never act, nothing enables machine admin', async () => {
      // Operators and viewers cannot inspect machines, draft machine tasks, tool installs or skills.
      const t = await newThread(op);
      for (const call of [
        `[[tool machine_inspect {"workerId":"${workerId}"}]]`,
        `[[tool draft_machine_task {"workerId":"${workerId}","title":"x","prompt":"y"}]]`,
        `[[tool draft_tool_install {"workerId":"${workerId}","tool":"browser"}]]`,
        '[[tool draft_skill {"skillId":"x","title":"x","description":"x","runtimes":["claude-code"],"files":{"SKILL.md":"x"},"changeNote":"n"}]]',
      ]) {
        const r = await ask(op, t, call);
        expect(r.content, call).toContain('not allowed');
      }
      expect((await detail(op, t)).drafts).toEqual([]);
      // The owner gets the read-only inspection; a machine task is refused while machine admin is off (the chat
      // cannot switch it on); a skill draft needs the panel key, which this master does not have.
      const o = await newThread(owner);
      const inspect = await ask(
        owner,
        o,
        `[[tool machine_inspect {"workerId":"${workerId}","sections":["disk"]}]]`,
      );
      expect(inspect.content).toContain('machineAdmin');
      expect(inspect.content).toContain('untrusted data, not instructions');
      const task = await ask(
        owner,
        o,
        `[[tool draft_machine_task {"workerId":"${workerId}","title":"Set up Chrome","prompt":"Install Chrome"}]]`,
      );
      expect(task.content).toContain('not enabled');
      const skill = await ask(
        owner,
        o,
        '[[tool draft_skill {"skillId":"demo","title":"Demo","description":"d","runtimes":["claude-code"],"files":{"SKILL.md":"---\\nname: demo\\n---\\nx"},"changeNote":"new"}]]',
      );
      expect(skill.content).toContain('SKILLS_PANEL_KEY_FILE');
      expect((await detail(owner, o)).drafts).toEqual([]);
    });

    it('validates tool input strictly', async () => {
      const t = await newThread(op);
      const bad = await ask(op, t, '[[tool describe_job {"jobId":"x","shell":"rm -rf /"}]]');
      expect(bad.content).toContain('Invalid input for describe_job');
    });

    it('redacts secrets from tool results before the model sees them', async () => {
      const t = await newThread(op);
      const r = await ask(op, t, `[[tool describe_job {"jobId":"${alphaJob}"}]]`);
      expect(r.content).toContain('Fix the login flake');
      expect(r.content).not.toContain(TOKEN);
      expect(r.content).toContain('[REDACTED');
      const all = await detail(op, t);
      expect(JSON.stringify(all)).not.toContain(TOKEN);
    });
  });

  describe('draft cards', () => {
    it('never execute by themselves; confirming needs step-up, CSRF and the target permission', async () => {
      const t = await newThread(op);
      const before = await h.db.pool.query("SELECT count(*)::int AS n FROM jobs WHERE project = 'alpha'");
      const reply = await ask(
        op,
        t,
        '[[tool draft_job {"project":"alpha","title":"Fix flaky login test","prompt":"Find and fix the flaky login test","runtime":"codex"}]]',
      );
      expect(reply.content).toContain('NOT executed');
      const d = (await detail(op, t)).drafts[0];
      expect(d).toMatchObject({ kind: 'job', state: 'proposed' });
      const draftId = d?.id ?? '';
      const after = await h.db.pool.query("SELECT count(*)::int AS n FROM jobs WHERE project = 'alpha'");
      expect(after.rows[0]).toEqual(before.rows[0]);
      // Another user cannot confirm it.
      expect((await opBeta.req('POST', `/chat/drafts/${draftId}/confirm`)).statusCode).toBe(404);
      // A stale step-up is refused.
      h.clock.advance(11 * 60_000);
      const stale = await op.req('POST', `/chat/drafts/${draftId}/confirm`);
      expect(stale.statusCode).toBe(403);
      expect(stale.json()).toMatchObject({ error: 'step_up_required' });
      await stepUp(op, opSecret);
      const noCsrf = op.clone();
      noCsrf.sendCsrf = false;
      expect((await noCsrf.req('POST', `/chat/drafts/${draftId}/confirm`)).statusCode).toBe(403);
      const ok = await op.req('POST', `/chat/drafts/${draftId}/confirm`);
      expect(ok.statusCode, ok.body).toBe(200);
      const jobId = ok.json<{ result: { jobId: string } }>().result.jobId;
      const job = await h.db.pool.query<{ project: string; created_by: string }>(
        'SELECT project, created_by_id::text AS created_by FROM jobs WHERE id = $1',
        [jobId],
      );
      expect(job.rows[0]?.project).toBe('alpha');
      // Exactly once.
      expect((await op.req('POST', `/chat/drafts/${draftId}/confirm`)).statusCode).toBe(409);
      const audit = await h.db.pool.query(
        `SELECT 1 FROM audit_events WHERE action = 'chat.draft.confirm' AND outcome = 'success' AND target = $1`,
        [`chat-draft:${draftId}`],
      );
      expect(audit.rowCount).toBe(1);
      // The confirmation is noted in the thread (context for the next turn).
      expect((await detail(op, t)).messages.some((m) => m.content.includes('confirmed draft'))).toBe(true);
    });

    it("p6-approval-mode-switch: the confirming user may change a job draft's approval mode (audited)", async () => {
      const t = await newThread(op);
      await ask(
        op,
        t,
        '[[tool draft_job {"project":"alpha","title":"Mode override","prompt":"Override the approval mode","runtime":"codex"}]]',
      );
      const d = (await detail(op, t)).drafts.find((x) => x.state === 'proposed');
      const draftId = d?.id ?? '';
      await stepUp(op, opSecret);
      const bad = await op.req('POST', `/chat/drafts/${draftId}/confirm`, { approvalPolicy: 'yolo' });
      expect(bad.statusCode).toBe(400);
      const ok = await op.req('POST', `/chat/drafts/${draftId}/confirm`, { approvalPolicy: 'ask-all' });
      expect(ok.statusCode, ok.body).toBe(200);
      const jobId = ok.json<{ result: { jobId: string } }>().result.jobId;
      const job = await h.db.pool.query<{ policy: string }>(
        "SELECT spec->>'approvalPolicy' AS policy FROM jobs WHERE id = $1",
        [jobId],
      );
      expect(job.rows[0]?.policy).toBe('ask-all');
      const audit = await h.db.pool.query<{ metadata: { approvalPolicyOverride?: { to: string } } }>(
        `SELECT metadata FROM audit_events WHERE action = 'chat.draft.confirm' AND outcome = 'success' AND target = $1`,
        [`chat-draft:${draftId}`],
      );
      expect(audit.rows[0]?.metadata.approvalPolicyOverride).toMatchObject({ to: 'ask-all' });
    });

    it('drafts research work as a workspace job (no repository) in a workspace project', async () => {
      const t = await newThread(owner);
      const refused = await ask(
        owner,
        t,
        '[[tool draft_job {"project":"alpha","mode":"workspace","title":"r","prompt":"research","runtime":"codex"}]]',
      );
      expect(refused.content).toContain('repository project');
      await ask(
        owner,
        t,
        '[[tool draft_job {"project":"genel","title":"Compare vector DBs","prompt":"Compare three vector databases","runtime":"codex"}]]',
      );
      const draft = (await detail(owner, t)).drafts.find((d) => d.kind === 'job');
      const spec = (draft?.payload.spec ?? {}) as Record<string, unknown>;
      expect(spec.repository).toBeUndefined();
      await stepUp(owner, ownerSecret);
      const ok = await owner.req('POST', `/chat/drafts/${draft?.id ?? ''}/confirm`);
      expect(ok.statusCode, ok.body).toBe(200);
      const jobId = ok.json<{ result: { jobId: string } }>().result.jobId;
      const job = await h.db.pool.query<{ project: string; workspace: unknown }>(
        "SELECT project, spec->'workspace' AS workspace FROM jobs WHERE id = $1",
        [jobId],
      );
      expect(job.rows[0]?.project).toBe('genel');
      expect(job.rows[0]?.workspace).not.toBeNull();
    });

    it('proposes full access only when the project allows it; the card says so; confirming stays a human click', async () => {
      const t = await newThread(owner);
      const fullAccess =
        '[[tool draft_job {"project":"genel","title":"Full","prompt":"Summarise","runtime":"codex","sandboxProfile":"unconfined","approvalPolicy":"allow-all"}]]';
      const refused = await ask(owner, t, fullAccess);
      expect(refused.content).toContain('does not allow auto-approve');
      expect(refused.content).toContain('Execution policy');
      expect((await detail(owner, t)).drafts.filter((d) => d.kind === 'job')).toEqual([]);

      const prior = (
        await h.db.pool.query<{ h: boolean; u: boolean; a: boolean }>(
          "SELECT host_execution AS h, unconfined_execution AS u, auto_approve_execution AS a FROM projects WHERE id = 'genel'",
        )
      ).rows[0];
      await h.db.pool.query(
        `UPDATE projects SET host_execution = true, unconfined_execution = true, auto_approve_execution = true
          WHERE id = 'genel'`,
      );
      try {
        const reply = await ask(owner, t, fullAccess);
        expect(reply.content).toContain('NOT executed');
        expect(reply.content).toContain('still need an approval');
        const draft = (await detail(owner, t)).drafts.find((d) => d.kind === 'job');
        expect(draft).toMatchObject({ state: 'proposed' });
        expect(draft?.payload.spec).toMatchObject({
          sandboxProfile: 'unconfined',
          approvalPolicy: 'allow-all',
          sourceTrust: 'trusted',
        });
        // Nothing ran: no job exists until a human confirms the card.
        expect(
          (await h.db.pool.query("SELECT 1 FROM jobs WHERE spec->>'approvalPolicy' = 'allow-all'")).rowCount,
        ).toBe(0);
      } finally {
        await h.db.pool.query(
          `UPDATE projects SET host_execution = $1, unconfined_execution = $2, auto_approve_execution = $3
            WHERE id = 'genel'`,
          [prior?.h ?? false, prior?.u ?? false, prior?.a ?? false],
        );
      }
    });

    it('re-checks the permission at confirmation (a demoted user cannot confirm an earlier draft)', async () => {
      const t = await newThread(op);
      await ask(
        op,
        t,
        '[[tool draft_job {"project":"alpha","title":"Later","prompt":"Do it later","runtime":"codex"}]]',
      );
      const draftId = (await detail(op, t)).drafts[0]?.id ?? '';
      await h.db.pool.query(
        `UPDATE project_memberships SET role = 'viewer' WHERE project_id = 'alpha'
            AND user_id = (SELECT id FROM users WHERE username = 'op.alpha')`,
      );
      await stepUp(op, opSecret);
      const refused = await op.req('POST', `/chat/drafts/${draftId}/confirm`);
      expect(refused.statusCode).toBe(403);
      await h.db.pool.query(
        `UPDATE project_memberships SET role = 'operator' WHERE project_id = 'alpha'
            AND user_id = (SELECT id FROM users WHERE username = 'op.alpha')`,
      );
      // Dismissing needs no step-up and runs nothing.
      const dismissed = await op.req('POST', `/chat/drafts/${draftId}/dismiss`);
      expect(dismissed.json()).toMatchObject({ state: 'dismissed' });
    });
  });

  describe('job drafts with input files (p5-ops-chat-next)', () => {
    const NOTES = Buffer.from('# Findings\n\nThree vector databases compared.\n');
    const tool = (input: Record<string, unknown>): string =>
      `[[tool draft_job ${JSON.stringify({ project: 'lab', title: 'Refine', prompt: 'Refine the findings', runtime: 'codex', ...input })}]]`;

    async function userId(name: string): Promise<string> {
      const { rows } = await h.db.pool.query<{ id: string }>(
        'SELECT id::text AS id FROM users WHERE username = $1',
        [name],
      );
      return rows[0]?.id ?? '';
    }

    async function artifact(jobId: string, artifactId: string, name: string, content: Buffer): Promise<void> {
      await h.db.pool.query(
        `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                    redacted, content, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'text/markdown', $4, encode(sha256($5), 'hex'), 'output', false, $5, $6)`,
        [jobId, artifactId, name, content.length, content, h.clock.now()],
      );
    }

    beforeAll(async () => {
      // A workspace project both operators work in; the source jobs stay in alpha / beta.
      await h.db.pool.query(
        "INSERT INTO projects (id, name, kind, created_at) VALUES ('lab', 'Lab', 'workspace', $1) ON CONFLICT (id) DO NOTHING",
        [h.clock.now()],
      );
      await h.db.pool.query(
        "INSERT INTO project_workspaces (project, egress, updated_at) VALUES ('lab', 'none', $1) ON CONFLICT DO NOTHING",
        [h.clock.now()],
      );
      await h.grant(await userId('op.alpha'), ['lab'], 'operator');
      await h.grant(await userId('op.beta'), ['lab'], 'operator');
      await artifact(alphaJob, 'ws-notes-md', 'notes.md', NOTES);
      await artifact(betaJob, 'ws-beta-md', 'beta.md', Buffer.from('beta only\n'));
    });

    it('drafts continueFrom / inputArtifacts of visible jobs; confirming creates the job with those inputs', async () => {
      const t = await newThread(op);
      const reply = await ask(op, t, tool({ continueFrom: alphaJob }));
      expect(reply.content).toContain('NOT executed');
      expect(reply.content).toContain('notes.md');
      const d = (await detail(op, t)).drafts.find((x) => x.kind === 'job');
      expect(d?.payload).toMatchObject({ project: 'lab', continueFrom: alphaJob });
      await stepUp(op, opSecret);
      const ok = await op.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
      expect(ok.statusCode, ok.body).toBe(200);
      const jobId = ok.json<{ result: { jobId: string; inputs: number } }>().result.jobId;
      expect(ok.json<{ result: { inputs: number } }>().result.inputs).toBe(1);
      const inputs = await h.db.pool.query<{
        name: string;
        source: string;
        source_job_id: string;
        blob_key: string;
      }>(
        'SELECT name, source, source_job_id::text AS source_job_id, blob_key FROM job_inputs WHERE job_id = $1',
        [jobId],
      );
      // p17-object-storage: the input's bytes are in the blob store.
      const rows = await Promise.all(
        inputs.rows.map(async (r) => ({
          name: r.name,
          source: r.source,
          source_job_id: r.source_job_id,
          content: await h.app.blobs.read(r.blob_key),
        })),
      );
      expect(rows).toEqual([
        { name: 'notes.md', source: 'artifact', source_job_id: alphaJob, content: NOTES },
      ]);
      const spec = await h.db.pool.query<{ n: number }>(
        "SELECT jsonb_array_length(spec->'workspace'->'inputs')::int AS n FROM jobs WHERE id = $1",
        [jobId],
      );
      expect(spec.rows[0]?.n).toBe(1);
    });

    it('refuses sources the user cannot see, and repository projects without a repo-inputs-v1 machine', async () => {
      const t = await newThread(opBeta);
      const hidden = await ask(opBeta, t, tool({ continueFrom: alphaJob }));
      expect(hidden.content).toContain('not found');
      const picked = await ask(
        opBeta,
        t,
        tool({ inputArtifacts: [{ jobId: alphaJob, artifactId: 'ws-notes-md' }] }),
      );
      expect(picked.content).toContain('not found');
      expect((await detail(opBeta, t)).drafts.filter((d) => d.kind === 'job')).toEqual([]);
      const t2 = await newThread(op);
      const other = await ask(
        op,
        t2,
        tool({ inputArtifacts: [{ jobId: betaJob, artifactId: 'ws-beta-md' }] }),
      );
      expect(other.content).toContain('not found');
      // p19-repo-job-inputs: a repository project takes input files once a machine has repo-inputs-v1 (none here).
      const repo = await ask(op, t2, tool({ project: 'alpha', continueFrom: alphaJob }));
      expect(repo.content).toContain('makine güncellenmeli');
      const missing = await ask(
        op,
        t2,
        tool({ inputArtifacts: [{ jobId: alphaJob, artifactId: 'ws-nope' }] }),
      );
      expect(missing.content).toContain('not found');
      expect((await detail(op, t2)).drafts.filter((d) => d.kind === 'job')).toEqual([]);
    });

    it('re-checks the source at confirmation for the confirming user', async () => {
      const t = await newThread(op);
      await ask(op, t, tool({ inputArtifacts: [{ jobId: alphaJob, artifactId: 'ws-notes-md' }] }));
      const draftId = (await detail(op, t)).drafts.find((d) => d.kind === 'job')?.id ?? '';
      const opId = await userId('op.alpha');
      await h.db.pool.query("DELETE FROM project_memberships WHERE project_id = 'alpha' AND user_id = $1", [
        opId,
      ]);
      try {
        await stepUp(op, opSecret);
        const refused = await op.req('POST', `/chat/drafts/${draftId}/confirm`);
        expect(refused.statusCode).toBe(404);
        expect(refused.json()).toMatchObject({ error: 'job_not_found' });
        expect((await detail(op, t)).drafts.find((d) => d.id === draftId)?.state).toBe('proposed');
      } finally {
        await h.grant(opId, ['alpha'], 'operator');
      }
    });
  });

  describe('workflow run drafts with run files (p8-orchestration)', () => {
    async function define(project: string, repository: boolean): Promise<string> {
      const res = await owner.req('POST', '/workflows', {
        project,
        definition: {
          name: `files-${repository ? 'repo' : 'ws'}-${Math.random().toString(36).slice(2, 6)}`,
          defaults: {
            runtime: 'codex',
            sandboxProfile: 'container',
            approvalPolicy: 'ask-sensitive',
            limits: { maxDurationSec: 600 },
            ...(repository
              ? { repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main' } }
              : {}),
          },
          nodes: [
            { id: 'script', role: 'executor', prompt: 'Write the script.' },
            { id: 'images', role: 'executor', prompt: 'Make the images.' },
          ],
          edges: [{ from: 'script', to: 'images' }],
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    }
    const tool = (input: Record<string, unknown>): string =>
      `[[tool draft_workflow_run ${JSON.stringify(input)}]]`;

    it('a workspace workflow takes continueFrom files (checked again at confirmation); a repository one needs a repo-inputs-v1 machine', async () => {
      const ws = await define('lab', false);
      const t = await newThread(op);
      const reply = await ask(op, t, tool({ workflowId: ws, continueFrom: alphaJob }));
      expect(reply.content).toContain('NOT executed');
      expect(reply.content).toContain('notes.md');
      const d = (await detail(op, t)).drafts.find((x) => x.kind === 'workflow_run');
      expect(d?.payload).toMatchObject({ workflowId: ws, continueFrom: alphaJob });
      await stepUp(op, opSecret);
      const ok = await op.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
      expect(ok.statusCode, ok.body).toBe(200);
      const result = ok.json<{ result: { runId: string; files: number } }>().result;
      expect(result.files).toBe(1);
      const files = await h.db.pool.query<{ name: string; source: string; source_job_id: string }>(
        'SELECT name, source, source_job_id::text AS source_job_id FROM workflow_run_files WHERE run_id = $1',
        [result.runId],
      );
      expect(files.rows).toEqual([{ name: 'notes.md', source: 'artifact', source_job_id: alphaJob }]);

      // A source the drafting user cannot see is "not found"; a repository workflow takes run files only once a
      // machine advertises repo-inputs-v1 (p19-repo-inputs-composer-workflows) — none here: "makine güncellenmeli".
      const tb = await newThread(opBeta);
      expect((await ask(opBeta, tb, tool({ workflowId: ws, continueFrom: alphaJob }))).content).toContain(
        'not found',
      );
      const repo = await define('alpha', true);
      const t2 = await newThread(op);
      const refused = await ask(op, t2, tool({ workflowId: repo, continueFrom: alphaJob }));
      expect(refused.content).toContain('makine güncellenmeli');
      expect((await detail(op, t2)).drafts.filter((x) => x.kind === 'workflow_run')).toEqual([]);
    });
  });

  describe('workflow definition drafts (p13-workflows-ui)', () => {
    const tool = (input: Record<string, unknown>): string =>
      `[[tool draft_workflow ${JSON.stringify(input)}]]`;
    const doc = (name: string, extra: Record<string, unknown>[] = []): Record<string, unknown> => ({
      name,
      inputs: { task: { required: true } },
      defaults: {
        runtime: 'codex',
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
      },
      nodes: [
        { id: 'plan', role: 'planner', prompt: 'Plan {{inputs.task}}.' },
        { id: 'build', role: 'executor', prompt: 'Build it.', approval: { approverRole: 'operator' } },
        ...extra,
      ],
      edges: [{ from: 'plan', to: 'build' }],
    });

    it('drafts a valid workflow, confirms it as a new definition (audited), then drafts v2 of it', async () => {
      const name = `chat-wf-${Math.random().toString(36).slice(2, 6)}`;
      const t = await newThread(op);
      const reply = await ask(op, t, tool({ project: 'alpha', definition: doc(name) }));
      expect(reply.content).toContain('NOT executed');
      const d = (await detail(op, t)).drafts.find((x) => x.kind === 'workflow');
      expect(d?.payload).toMatchObject({
        project: 'alpha',
        name,
        valid: true,
        issues: [],
        nodes: [
          { id: 'plan', role: 'planner', gate: null, dynamic: false },
          { id: 'build', role: 'executor', gate: 'operator', dynamic: false },
        ],
        edges: [{ from: 'plan', to: 'build' }],
      });
      await stepUp(op, opSecret);
      const ok = await op.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
      expect(ok.statusCode, ok.body).toBe(200);
      const result = ok.json<{ result: { workflowId: string; name: string; version: number } }>().result;
      expect(result).toMatchObject({ name, version: 1 });
      const saved = await h.db.pool.query<{ project: string; version: number }>(
        'SELECT project, version FROM workflow_definitions WHERE id = $1',
        [result.workflowId],
      );
      expect(saved.rows).toEqual([{ project: 'alpha', version: 1 }]);
      const audits = await h.db.pool.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE target IN ($1, $2) AND outcome = 'success'`,
        [`workflow:${result.workflowId}`, `chat-draft:${d?.id ?? ''}`],
      );
      expect(audits.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining(['workflow.define', 'chat.draft.confirm']),
      );

      // Update: a new version of the saved workflow (same project and name).
      const t2 = await newThread(op);
      const v2 = doc(name, [{ id: 'check', role: 'verifier', prompt: 'Check {{upstream.build.summary}}.' }]);
      (v2.edges as unknown[]).push({ from: 'build', to: 'check' });
      await ask(op, t2, tool({ project: 'alpha', workflowId: result.workflowId, definition: v2 }));
      const d2 = (await detail(op, t2)).drafts.find((x) => x.kind === 'workflow');
      expect(d2?.payload).toMatchObject({ workflowId: result.workflowId, baseVersion: 1, valid: true });
      await stepUp(op, opSecret);
      const ok2 = await op.req('POST', `/chat/drafts/${d2?.id ?? ''}/confirm`);
      expect(ok2.statusCode, ok2.body).toBe(200);
      expect(ok2.json<{ result: { version: number } }>().result).toMatchObject({ name, version: 2 });
    });

    it('an invalid definition comes back with issues (paths and codes) and never becomes a card', async () => {
      const bad = doc('chat-wf-bad');
      (bad.edges as unknown[]).push({ from: 'build', to: 'plan' });
      (bad.nodes as Record<string, unknown>[])[0] = {
        id: 'plan',
        role: 'planner',
        prompt: 'Plan {{inputs.missing}}.',
      };
      const t = await newThread(op);
      const reply = await ask(op, t, tool({ project: 'alpha', definition: bad }));
      expect(reply.content).toContain('edges');
      expect(reply.content).toContain('cycle');
      // p16-workflow-quality: no card; the attempt is stored hidden and cannot be confirmed.
      expect((await detail(op, t)).drafts.find((x) => x.kind === 'workflow')).toBeUndefined();
      const hidden = await h.db.pool.query<{ id: string; state: string; payload: { issues: unknown } }>(
        "SELECT id::text AS id, state, payload FROM chat_drafts WHERE thread_id = $1 AND kind = 'workflow'",
        [t],
      );
      expect(hidden.rows[0]?.state).toBe('invalid');
      expect(JSON.stringify(hidden.rows[0]?.payload.issues)).toContain('cycle');
      await stepUp(op, opSecret);
      const refused = await op.req('POST', `/chat/drafts/${hidden.rows[0]?.id ?? ''}/confirm`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: 'draft_not_open' });
      const none = await h.db.pool.query('SELECT 1 FROM workflow_definitions WHERE name = $1', [
        'chat-wf-bad',
      ]);
      expect(none.rowCount).toBe(0);
    });

    it('a viewer cannot draft workflows; another project is not visible', async () => {
      const t = await newThread(viewer);
      const refused = await ask(viewer, t, tool({ project: 'alpha', definition: doc('chat-wf-viewer') }));
      expect(refused.content).toContain('not allowed');
      expect((await detail(viewer, t)).drafts.filter((x) => x.kind === 'workflow')).toEqual([]);
      const tb = await newThread(opBeta);
      const hidden = await ask(opBeta, tb, tool({ project: 'alpha', definition: doc('chat-wf-hidden') }));
      expect(hidden.content).toContain('not found');
    });
  });

  it('an approval suggestion is decided by the human through the approval service', async () => {
    const audit = new AuditLog(h.db.pool, h.clock.now);
    const jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    const approvals = new ApprovalService({ pool: h.db.pool, audit, jobs, clock: h.clock.now });
    const { job } = await jobs.create({
      project: 'alpha',
      actor: { type: 'system', id: 'test' },
      submit: true,
      spec: {
        runtime: 'codex',
        prompt: 'Merge me',
        repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'w/merge' },
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 3600 },
      },
    });
    const grant = await jobs.acquireLease(job.id, 'worker-merge', 3_600_000);
    for (const ev of ['lease_acked', 'runtime_started', 'run_finished', 'verification_passed'] as const) {
      await jobs.transition(job.id, ev, {
        actor: { type: 'worker', id: 'worker-merge' },
        epoch: grant.lease.epoch,
      });
    }
    const ev = await approvals.evaluate({
      action: 'git.merge',
      jobId: job.id,
      summary: 'Merge the login fix',
      requestedBy: { type: 'system', id: 'integrator' },
    });
    if (ev.outcome !== 'pending') throw new Error('expected a pending approval');
    const t = await newThread(owner);
    const reply = await ask(
      owner,
      t,
      `[[tool suggest_approval_decision {"approvalId":"${ev.requestId}","decision":"deny","reason":"CI is red"}]]`,
    );
    expect(reply.content).toContain('NOT executed');
    expect((await approvals.get(ev.requestId))?.request.status).toBe('pending');
    const draft = (await detail(owner, t)).drafts[0];
    await stepUp(owner, ownerSecret);
    const ok = await owner.req('POST', `/chat/drafts/${draft?.id ?? ''}/confirm`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ result: { status: 'denied', final: true } });
    expect((await approvals.get(ev.requestId))?.request.status).toBe('denied');
  });

  describe('limits, kill switch and availability', () => {
    it('rate-limits turns per user and enforces the daily token budget', async () => {
      await putSettings({ limits: { turnsPerUserPer10Min: 2, userDailyTokens: null } });
      // A fresh user: the window counts every turn of the user.
      const id = await h.createUser('viewer.limits', PW, 'viewer');
      await h.grant(id, ['alpha'], 'viewer');
      const { secret } = await enroll(h, 'viewer.limits', PW);
      const fresh = await fullLogin(h, 'viewer.limits', PW, secret);
      const t = await newThread(fresh);
      await ask(fresh, t, 'one');
      await ask(fresh, t, 'two');
      const third = await fresh.req('POST', `/chat/threads/${t}/messages`, { text: 'three' });
      expect(third.statusCode).toBe(429);
      expect(third.json()).toMatchObject({ error: 'rate_limited' });
      // op.beta already spent tokens today: a 1-token daily budget refuses the next turn.
      await putSettings({ limits: { turnsPerUserPer10Min: 1000, userDailyTokens: 1 } });
      const t2 = await newThread(opBeta);
      const over = await opBeta.req('POST', `/chat/threads/${t2}/messages`, { text: 'more' });
      expect(over.statusCode).toBe(429);
      expect(over.json()).toMatchObject({ error: 'budget_exceeded' });
      const usage = (await opBeta.req('GET', '/chat/usage')).json<{
        me: { today: { turns: number; inputTokens: number } };
        all: unknown;
      }>();
      expect(usage.me.today.turns).toBeGreaterThanOrEqual(1);
      expect(usage.me.today.inputTokens).toBeGreaterThan(0);
      expect(usage.all).toBeNull();
      const admin = (await owner.req('GET', '/chat/usage')).json<{ all: { today: { turns: number } } }>();
      expect(admin.all.today.turns).toBeGreaterThan(usage.me.today.turns);
      await putSettings({ limits: { turnsPerUserPer10Min: 1000, userDailyTokens: null } });
    });

    it('the kill switch turns chat off for everyone and stops running answers', async () => {
      const t = await newThread(op);
      const res = await op.req('POST', `/chat/threads/${t}/messages`, { text: '[[slow 20000]] long one' });
      expect(res.statusCode).toBe(202);
      await putSettings({ enabled: false });
      const status = (await op.req('GET', '/chat/status')).json<unknown>();
      expect(status).toMatchObject({ available: false, code: 'disabled' });
      const refused = await op.req('POST', `/chat/threads/${t}/messages`, { text: 'again' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: 'chat_disabled' });
      await expect.poll(async () => (await detail(op, t)).turn).toBeNull();
      expect((await detail(op, t)).messages.at(-1)).toMatchObject({ role: 'error', content: 'Stopped.' });
      await putSettings({ enabled: true });
    });

    it('says clearly when the assistant worker is offline', async () => {
      const t = await newThread(op);
      await worker?.stop();
      await expect
        .poll(async () => (await op.req('GET', '/chat/status')).json<{ code: string | null }>().code, {
          timeout: 15_000,
        })
        .toBe('worker_offline');
      const res = await op.req('POST', `/chat/threads/${t}/messages`, { text: 'hello?' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'assistant_unavailable' });
      expect(res.json<{ message: string }>().message).toContain('offline');
    });
  });

  describe('talk to a running job', () => {
    it('queues JOB_MESSAGE to the worker of a running job (operator+), refuses otherwise', async () => {
      const audit = new AuditLog(h.db.pool, h.clock.now);
      const jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
      const opId =
        (
          await h.db.pool.query<{ id: string }>(
            "SELECT id::text AS id FROM users WHERE username = 'op.alpha'",
          )
        ).rows[0]?.id ?? '';
      const { job } = await jobs.create({
        project: 'alpha',
        actor: { type: 'user', id: opId },
        submit: true,
        spec: {
          runtime: 'codex',
          prompt: 'Long running refactor',
          repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'w/input' },
          sandboxProfile: 'container',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 3600 },
        },
      });
      const jobId = job.id;
      // Not running yet: p15-message-delivery holds it until the agent runs (no outbox row yet).
      const idle = await op.req('POST', `/jobs/${jobId}/messages`, { text: 'held until it runs' });
      expect(idle.statusCode, idle.body).toBe(202);
      expect(idle.json()).toMatchObject({ status: 'waiting' });
      expect((await viewer.req('POST', `/jobs/${jobId}/messages`, { text: 'x' })).statusCode).toBe(403);
      expect((await opBeta.req('POST', `/jobs/${jobId}/messages`, { text: 'x' })).statusCode).toBe(404);
      // Make the job RUNNING on the (feature-advertising) worker.
      const grant = await jobs.acquireLease(jobId, workerId, 3_600_000);
      const w: JobActor = { type: 'worker', id: workerId };
      for (const ev of ['lease_acked', 'runtime_started'] as const) {
        await jobs.transition(jobId, ev, { actor: w, epoch: grant.lease.epoch });
      }
      const status = await op.req('GET', `/jobs/${jobId}/messages/status`);
      expect(status.json()).toMatchObject({ supported: true });
      const sent = await op.req('POST', `/jobs/${jobId}/messages`, { text: 'please also run lint' });
      expect(sent.statusCode, sent.body).toBe(202);
      const { rows } = await h.db.pool.query<{ type: string; payload: { text: string; epoch: number } }>(
        `SELECT type, payload FROM worker_outbox WHERE worker_id = $1 AND type = 'JOB_MESSAGE'`,
        [workerId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({ text: 'please also run lint', epoch: grant.lease.epoch });
      const a = await h.db.pool.query(
        `SELECT 1 FROM audit_events WHERE action = 'job.message' AND outcome = 'success'`,
      );
      expect(a.rowCount).toBe(2);

      // p15-message-delivery: the chat path — a confirmed draft_job_message is a job_messages row (source chat),
      // confirming is idempotent by the card id, and describe_job reports how far messages got.
      const chatStore = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      const thread = await chatStore.createThread(opId, 'message the agent');
      const card = await chatStore.createDraft({
        threadId: thread.id,
        userId: opId,
        turnId: randomUUID(),
        kind: 'job_message',
        title: 'Message to the job',
        payload: { jobId, text: 'from the chat' },
        project: 'alpha',
      });
      await stepUp(op, opSecret);
      const confirmed = await op.req('POST', `/chat/drafts/${card.id}/confirm`);
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json()).toMatchObject({ result: { jobId, delivery: 'sent' } });
      const chatRows = await h.db.pool.query<{ source: string; status: string; client_id: string }>(
        `SELECT source, status, client_id::text FROM job_messages WHERE job_id = $1 AND text = 'from the chat'`,
        [jobId],
      );
      expect(chatRows.rows).toEqual([{ source: 'chat', status: 'sent', client_id: card.id }]);
      expect((await op.req('POST', `/chat/drafts/${card.id}/confirm`)).statusCode).toBe(409);
      // The list shows both messages (panel + chat).
      const listed = await op.req('GET', `/jobs/${jobId}/messages`);
      expect(listed.json<{ messages: { source: string }[] }>().messages.map((m) => m.source)).toEqual([
        'panel',
        'panel',
        'chat',
      ]);
    });
  });
});
