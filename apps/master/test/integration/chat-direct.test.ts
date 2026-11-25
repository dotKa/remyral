import { FakeAssistantEngine } from '@remyral/agent-adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalService } from '../../src/approvals/index.js';
import { AuditLog } from '../../src/audit/audit.js';
import { JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeSmtpServer, TEST_CERT } from '../helpers/fake-smtp.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

/**
 * p15-autonomy (ADR-0056, docs/design/p15-autonomy.md §5): the assistant acts directly. Through the real transport
 * (master ↔ real worker daemon with the scripted fake engine): a draft tool called with `execute: true` runs at once
 * for the sender (settings, approvals, messages to a job's agent), with the sender's role (RBAC refusals), audited as
 * done through the chat; a card stays when the security policy wants a code (inline code on the card) or keeps cards.
 */
const PW = 'cobalt-lantern-meadow-58';
const MIN = 60_000;

interface Message {
  seq: number;
  role: string;
  content: string;
  meta: Record<string, unknown> | null;
}
interface Draft {
  id: string;
  kind: string;
  state: string;
  result: Record<string, unknown> | null;
}

describeIntegration('assistant direct actions (integration, p15-autonomy)', { timeout: 240_000 }, () => {
  const h = new Harness();
  const engine = new FakeAssistantEngine();
  const dirs: string[] = [];
  let worker: RunningWorker | undefined;
  let workerId = '';
  let owner: Client;
  let ownerSecret = '';
  let ownerId = '';
  let op: Client;
  let opId = '';
  let jobs: JobStore;
  let approvals: ApprovalService;
  let url = '';

  async function stepUp(c: Client, secret: string): Promise<void> {
    h.clock.advance(30_000);
    expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }
  async function thread(c: Client): Promise<string> {
    const r = await c.req('POST', '/chat/threads', {});
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ id: string }>().id;
  }
  async function detail(
    c: Client,
    id: string,
  ): Promise<{ messages: Message[]; drafts: Draft[]; turn: unknown }> {
    const r = await c.req('GET', `/chat/threads/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  }
  async function ask(c: Client, id: string, text: string): Promise<string> {
    const r = await c.req('POST', `/chat/threads/${id}/messages`, { text });
    expect(r.statusCode, r.body).toBe(202);
    const seq = r.json<{ message: Message }>().message.seq;
    let last: Message | undefined;
    await expect
      .poll(
        async () => {
          const d = await detail(c, id);
          last = d.messages
            .filter((m) => m.seq > seq && (m.role === 'assistant' || m.role === 'error'))
            .at(-1);
          return d.turn === null && last !== undefined;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    return (last as Message).content;
  }
  const tool = (name: string, input: Record<string, unknown>) => `[[tool ${name} ${JSON.stringify(input)}]]`;
  const directAudit = async (draftId: string) =>
    (
      await h.db.pool.query<{ actor_id: string; outcome: string; metadata: Record<string, unknown> }>(
        `SELECT actor_id, outcome, metadata FROM audit_events WHERE action = 'chat.direct_action'
            AND target = $1 ORDER BY id`,
        [`chat-draft:${draftId}`],
      )
    ).rows;

  beforeAll(async () => {
    await h.start({
      securityPolicy: { preset: 'serbest' },
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      // p16-doctor: the support SMTP trusts the fake server's test-only certificate.
      doctor: { smtpCa: TEST_CERT },
    });
    url = await h.listen();
    ownerId = await h.createUser('owner.direct', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner.direct', PW));
    owner = await fullLogin(h, 'owner.direct', PW, ownerSecret);
    opId = await h.createUser('op.direct', PW, 'operator');
    await h.grant(opId, ['alpha'], 'operator');
    const { secret: opSecret } = await enroll(h, 'op.direct', PW);
    op = await fullLogin(h, 'op.direct', PW, opSecret);
    const audit = new AuditLog(h.db.pool, h.clock.now);
    jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    approvals = new ApprovalService({ pool: h.db.pool, audit, jobs, clock: h.clock.now });
  });
  afterAll(async () => {
    await worker?.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  it('sets up the assistant machine (expect.poll works only inside a test)', async () => {
    const dataDir = await tempDataDir(dirs);
    workerId = await pairRealWorker(h, url, owner, ownerSecret, dataDir);
    worker = await runRealWorker(url, dataDir, {
      capabilities: CAPS,
      assistant: { engine, clock: h.clock.now },
    });
    await stepUp(owner, ownerSecret);
    const s = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId,
      runtime: 'claude-code',
      modelProfile: null,
      expectedVersion: 1,
    });
    expect(s.statusCode, s.body).toBe(200);
    await expect
      .poll(async () => (await op.req('GET', '/chat/status')).json<{ available: boolean }>().available, {
        timeout: 20_000,
      })
      .toBe(true);
  });

  describe('settings through the chat', () => {
    it('changes the security policy at once on an explicit instruction (core event, fresh code)', async () => {
      await stepUp(owner, ownerSecret);
      const t = await thread(owner);
      const reply = await ask(
        owner,
        t,
        tool('change_settings', {
          target: 'security_policy',
          securityPolicy: { stepUp: { windowMinutes: 60 } },
          execute: true,
        }),
      );
      expect(reply).toContain('executed');
      expect(reply).not.toContain('NOT executed');
      const d = (await detail(owner, t)).drafts[0];
      expect(d).toMatchObject({ kind: 'settings_change', state: 'confirmed' });
      const view = (await owner.req('GET', '/security/policy')).json<{
        effective: { stepUp: { windowMinutes: number } };
      }>();
      expect(view.effective.stepUp.windowMinutes).toBe(60);
      const a = await directAudit(d?.id ?? '');
      expect(a).toEqual([expect.objectContaining({ actor_id: ownerId, outcome: 'success' })]);
      expect(a[0]?.metadata).toMatchObject({
        via: 'chat',
        event: 'security.policy',
        kind: 'settings_change',
      });
      const upd = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'security.policy.update' AND outcome = 'success'
          ORDER BY id DESC LIMIT 1`,
      );
      expect(upd.rows[0]?.metadata).toMatchObject({ via: 'chat', changed: ['stepUp.windowMinutes'] });
      const confirm = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'chat.draft.confirm' AND target = $1`,
        [`chat-draft:${d?.id ?? ''}`],
      );
      expect(confirm.rows[0]?.metadata).toMatchObject({ via: 'chat-direct' });
    });

    it('keeps a card that asks for the code when the core event needs a fresh one', async () => {
      await h.setSecurityPolicy({ preset: 'serbest', stepUp: { windowMinutes: 5 } });
      await stepUp(owner, ownerSecret);
      h.clock.advance(6 * MIN);
      const t = await thread(owner);
      const reply = await ask(
        owner,
        t,
        tool('change_settings', {
          target: 'security_policy',
          securityPolicy: { events: { 'deploy.production': true } },
          execute: true,
        }),
      );
      expect(reply).toContain('needsCode');
      const d = (await detail(owner, t)).drafts[0];
      expect(d?.state).toBe('proposed');
      expect((await directAudit(d?.id ?? ''))[0]).toMatchObject({ outcome: 'denied' });
      // The card asks for the code: with it, the confirmation goes through.
      const without = await owner.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
      expect(without.statusCode).toBe(403);
      expect(without.json()).toMatchObject({ error: 'step_up_required' });
      await stepUp(owner, ownerSecret);
      const ok = await owner.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
      expect(ok.statusCode, ok.body).toBe(200);
      await h.setSecurityPolicy({ preset: 'serbest' });
    });

    it('refuses what the user may not change (RBAC), and drafts only without execute', async () => {
      const t = await thread(op);
      const refused = await ask(
        op,
        t,
        tool('change_settings', {
          target: 'security_policy',
          securityPolicy: { preset: 'siki' },
          execute: true,
        }),
      );
      expect(refused).toContain('refused');
      expect(refused).toContain('not allowed');
      expect((await detail(op, t)).drafts).toEqual([]);
      const exec = await ask(
        op,
        t,
        tool('change_settings', {
          target: 'project_execution',
          project: 'alpha',
          execution: { hostExecution: true },
          execute: true,
        }),
      );
      expect(exec).toContain('refused');
      // The assistant's own proposal (propose: true): a card, nothing changed.
      const t2 = await thread(owner);
      await ask(
        owner,
        t2,
        tool('change_settings', {
          target: 'project_execution',
          project: 'alpha',
          execution: { hostExecution: true },
          propose: true,
        }),
      );
      expect((await detail(owner, t2)).drafts[0]?.state).toBe('proposed');
    });

    it('a policy that keeps cards (chatDirect off) answers with a card', async () => {
      await h.setSecurityPolicy({ preset: 'serbest', autonomy: { chatDirect: false } });
      const t = await thread(owner);
      const reply = await ask(
        owner,
        t,
        tool('change_settings', {
          target: 'project_execution',
          project: 'alpha',
          execution: { allowAutoApprove: true },
          execute: true,
        }),
      );
      expect(reply).toContain('not executed');
      expect((await detail(owner, t)).drafts[0]?.state).toBe('proposed');
      await h.setSecurityPolicy({ preset: 'serbest' });
    });

    it('get_settings reads the policy for administrators only', async () => {
      const t = await thread(owner);
      expect(await ask(owner, t, tool('get_settings', { project: 'alpha' }))).toContain('eventsWithoutCode');
      const t2 = await thread(op);
      expect(await ask(op, t2, tool('get_settings', {}))).toContain('administrators only');
    });

    it('p16-api-tokens: list_api_tokens lists metadata only; every token for admins only', async () => {
      await stepUp(owner, ownerSecret);
      const created = await owner.req('POST', '/me/api-tokens', {
        name: 'chat-listed',
        scopes: ['read'],
        expiresInDays: 3,
      });
      expect(created.statusCode, created.body).toBe(201);
      const { secret, token } = created.json<{ secret: string; token: { hint: string } }>();
      const t = await thread(owner);
      const reply = await ask(owner, t, tool('list_api_tokens', {}));
      expect(reply).toContain('chat-listed');
      expect(reply).toContain(token.hint);
      expect(reply).toMatch(/"expiresSoon":\s*true/);
      expect(reply).not.toContain(secret.slice(12, -4));
      const t2 = await thread(op);
      expect(await ask(op, t2, tool('list_api_tokens', { all: true }))).toContain('not allowed');
      expect(await ask(op, t2, tool('list_api_tokens', {}))).not.toContain('chat-listed');
    });

    it('p16-webhooks-out: draft_webhook makes a card; the secret never passes the chat; list / pause', async () => {
      const t = await thread(owner);
      const refused = await ask(
        owner,
        t,
        tool('draft_webhook', {
          op: 'create',
          name: 'lan',
          url: 'https://192.168.1.10/hook',
          eventTypes: ['job.failed'],
        }),
      );
      expect(refused).toContain('internal');
      const reply = await ask(
        owner,
        t,
        tool('draft_webhook', {
          op: 'create',
          name: 'n8n',
          url: 'https://n8n.example.com/webhook/remyral',
          eventTypes: ['job.failed', 'deploy.succeeded'],
        }),
      );
      // Serbest: the integrations.webhooks event asks for no code, so the card runs at once (audited).
      expect(reply).toContain('executed');
      expect(reply).not.toMatch(/whsec_/);
      const d = (await detail(owner, t)).drafts.find((x) => x.kind === 'webhook');
      expect(d?.state).toBe('confirmed');
      expect(JSON.stringify(d?.result)).not.toMatch(/whsec_/);
      const list = (await owner.req('GET', '/webhooks')).json<{
        items: { id: string; name: string; secretRevealed: boolean; state: string }[];
      }>().items;
      const w = list.find((x) => x.name === 'n8n');
      expect(w).toMatchObject({ secretRevealed: false, state: 'active' });
      const listed = await ask(owner, t, tool('list_webhooks', { failures: true }));
      expect(listed).toContain('https://n8n.example.com');
      expect(listed).not.toContain('/webhook/remyral');
      expect(listed).not.toMatch(/whsec_/);
      // The console shows the secret once.
      await stepUp(owner, ownerSecret);
      const shown = await owner.req('POST', `/webhooks/${w?.id ?? ''}/secret`);
      expect(shown.statusCode, shown.body).toBe(200);
      expect(shown.json<{ secret: string }>().secret).toMatch(/^whsec_/);
      expect((await owner.req('POST', `/webhooks/${w?.id ?? ''}/secret`)).statusCode).toBe(409);
      // Pausing runs at once on an explicit instruction (Serbest; pausing never asks for a code).
      const paused = await ask(
        owner,
        t,
        tool('draft_webhook', { op: 'pause', webhookId: 'n8n', execute: true }),
      );
      expect(paused).toContain('executed');
      const after = (await owner.req('GET', `/webhooks/${w?.id ?? ''}`)).json<{
        webhook: { state: string };
      }>();
      expect(after.webhook.state).toBe('paused');
      // When the policy asks for a code on this event, resuming stays a card until it is confirmed with one.
      await h.setSecurityPolicy({
        preset: 'serbest',
        stepUp: { windowMinutes: 5 },
        events: { 'integrations.webhooks': true },
      });
      h.clock.advance(6 * MIN);
      const resumed = await ask(
        owner,
        t,
        tool('draft_webhook', { op: 'resume', webhookId: 'n8n', execute: true }),
      );
      expect(resumed).toContain('needsCode');
      const card = (await detail(owner, t)).drafts.filter((x) => x.kind === 'webhook').at(-1);
      expect(card?.state).toBe('proposed');
      expect((await owner.req('POST', `/chat/drafts/${card?.id ?? ''}/confirm`)).statusCode).toBe(403);
      await stepUp(owner, ownerSecret);
      const confirmed = await owner.req('POST', `/chat/drafts/${card?.id ?? ''}/confirm`);
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(
        (await owner.req('GET', `/webhooks/${w?.id ?? ''}`)).json<{ webhook: { state: string } }>().webhook
          .state,
      ).toBe('active');
      await h.setSecurityPolicy({ preset: 'serbest' });
      // An operator may not manage webhooks.
      const t2 = await thread(op);
      expect(await ask(op, t2, tool('list_webhooks', {}))).toContain('not allowed');
    });

    it('p16-doctor: run_diagnostics answers with the checks; draft_support_report e-mails the redacted report', async () => {
      const t = await thread(owner);
      const diag = await ask(owner, t, tool('run_diagnostics', {}));
      expect(diag).toContain('db.reachable');
      expect(diag).toContain('/settings/diagnostics');
      const smtp = new FakeSmtpServer({ mode: 'starttls' });
      const port = await smtp.start();
      try {
        // A fresh install has no support address: the tool says so and drafts nothing.
        expect(
          await ask(owner, t, tool('draft_support_report', { description: 'Jobs fail since Monday.' })),
        ).toContain('No support address is set');
        await stepUp(owner, ownerSecret);
        const set = await owner.req('PUT', '/support/settings', {
          email: 'support@vendor.example',
          smtp: { host: '127.0.0.1', port, security: 'starttls', from: 'remyral@customer.example' },
        });
        expect(set.statusCode, set.body).toBe(200);
        const reply = await ask(
          owner,
          t,
          tool('draft_support_report', { description: 'Jobs fail since Monday.', hours: 6 }),
        );
        // Serbest: the support.report event asks for no code, so the card runs at once (audited).
        expect(reply).toContain('executed');
        expect(reply).toContain('support@vendor.example');
        const d = (await detail(owner, t)).drafts.find((x) => x.kind === 'support_report');
        expect(d?.state).toBe('confirmed');
        expect(smtp.messages).toHaveLength(1);
        expect(smtp.messages[0]?.to).toEqual(['support@vendor.example']);
        // When the policy asks for a code on this event, the card waits for one.
        await h.setSecurityPolicy({
          preset: 'serbest',
          stepUp: { windowMinutes: 5 },
          events: { 'support.report': true },
        });
        h.clock.advance(6 * MIN);
        const waiting = await ask(
          owner,
          t,
          tool('draft_support_report', { description: 'Again.', execute: true }),
        );
        expect(waiting).toContain('needsCode');
        expect(smtp.messages).toHaveLength(1);
        await h.setSecurityPolicy({ preset: 'serbest' });
        // An operator may neither run the doctor nor send the report.
        const t2 = await thread(op);
        expect(await ask(op, t2, tool('run_diagnostics', {}))).toContain('not allowed');
        expect(await ask(op, t2, tool('draft_support_report', { description: 'x' }))).toContain(
          'not allowed',
        );
      } finally {
        await smtp.stop();
      }
    });
  });

  async function runningJob(): Promise<string> {
    const { job } = await jobs.create({
      project: 'alpha',
      actor: { type: 'user', id: opId },
      submit: true,
      spec: {
        runtime: 'claude-code',
        prompt: 'Work on it',
        repository: {
          url: 'https://example.com/acme/repo.git',
          baseRef: 'main',
          workBranch: `w/${String(Date.now())}`,
        },
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 3600 },
      },
    });
    const grant = await jobs.acquireLease(job.id, workerId, 3_600_000);
    for (const ev of ['lease_acked', 'runtime_started'] as const)
      await jobs.transition(job.id, ev, {
        actor: { type: 'worker', id: workerId },
        epoch: grant.lease.epoch,
      });
    return job.id;
  }

  describe('approvals and job messages', () => {
    it('approves a pending approval at once when told ("sen onayla"), as the operator, audited', async () => {
      const jobId = await runningJob();
      const { rows } = await h.db.pool.query<{ attempt: string; epoch: number }>(
        'SELECT current_attempt_id::text AS attempt, lease_epoch AS epoch FROM jobs WHERE id = $1',
        [jobId],
      );
      const ev = await approvals.evaluate({
        action: 'network.egress_non_allowlisted',
        jobId,
        summary: 'Reach registry.npmjs.org',
        approvalKey: 'k1',
        attemptId: rows[0]?.attempt ?? '',
        epoch: rows[0]?.epoch ?? 0,
        requestedBy: { type: 'worker', id: workerId },
      });
      if (ev.outcome !== 'pending') throw new Error(`expected a pending approval, got ${ev.outcome}`);
      const t = await thread(op);
      const reply = await ask(
        op,
        t,
        tool('suggest_approval_decision', {
          approvalId: ev.requestId,
          decision: 'approve',
          reason: 'sen onayla',
          execute: true,
        }),
      );
      expect(reply).toContain('executed');
      expect((await approvals.get(ev.requestId))?.request.status).toBe('approved');
      const d = (await detail(op, t)).drafts[0];
      expect((await directAudit(d?.id ?? ''))[0]).toMatchObject({ actor_id: opId, outcome: 'success' });
    });

    it('extends a running job’s time limit at once when told ("süreyi uzat")', async () => {
      const jobId = await runningJob();
      const t = await thread(op);
      const reply = await ask(op, t, tool('draft_time_limit', { jobId, addMinutes: 30, execute: true }));
      expect(reply).toContain('executed');
      const d = (await detail(op, t)).drafts[0];
      expect(d).toMatchObject({ kind: 'time_limit', state: 'confirmed' });
      const { rows } = await h.db.pool.query<{ to_sec: number; via: string }>(
        'SELECT to_sec, via FROM job_time_limit_changes WHERE job_id = $1',
        [jobId],
      );
      expect(rows).toEqual([{ to_sec: 3600 + 1800, via: 'chat' }]);
      // Exactly the security policy's maximum (Serbest: 7 days) is allowed.
      const t2 = await thread(op);
      const far = await ask(op, t2, tool('draft_time_limit', { jobId, minutes: 7 * 24 * 60, execute: true }));
      expect(far).toContain('executed');
    });

    it('sends a message to a running job’s agent at once through the job message service', async () => {
      const jobId = await runningJob();
      const t = await thread(op);
      const reply = await ask(
        op,
        t,
        tool('draft_job_message', { jobId, text: 'Also update the README', execute: true }),
      );
      const d = (await detail(op, t)).drafts[0];
      expect(d?.kind).toBe('job_message');
      const audit = await directAudit(d?.id ?? '');
      expect(audit).toHaveLength(1);
      if (d?.state === 'confirmed') {
        expect(reply).toContain('executed');
        expect(audit[0]?.outcome).toBe('success');
      } else {
        // The job message service refused (the delivery path belongs to that service): reported, card open.
        expect(reply).toContain('not executed');
        expect(audit[0]?.metadata).toMatchObject({ reason: 'failed' });
      }
    });
  });

  /**
   * p15-chat-execute-default (docs/design/p15-chat-execute-default.md): the platform decides. A draft the model creates
   * WITHOUT any flag in a turn the user started runs at once; `propose: true`, turns no person started, a policy that
   * keeps cards, an older assistant worker and events that need a code keep a card.
   */
  describe('default execution (p15-chat-execute-default)', () => {
    async function pendingApproval(key: string): Promise<string> {
      const jobId = await runningJob();
      const { rows } = await h.db.pool.query<{ attempt: string; epoch: number }>(
        'SELECT current_attempt_id::text AS attempt, lease_epoch AS epoch FROM jobs WHERE id = $1',
        [jobId],
      );
      const ev = await approvals.evaluate({
        action: 'network.egress_non_allowlisted',
        jobId,
        summary: 'Reach registry.npmjs.org',
        approvalKey: key,
        attemptId: rows[0]?.attempt ?? '',
        epoch: rows[0]?.epoch ?? 0,
        requestedBy: { type: 'worker', id: workerId },
      });
      if (ev.outcome !== 'pending') throw new Error(`expected a pending approval, got ${ev.outcome}`);
      return ev.requestId;
    }
    const approve = (approvalId: string, extra: Record<string, unknown> = {}) =>
      tool('suggest_approval_decision', { approvalId, decision: 'approve', reason: 'onayla', ...extra });
    const statusOf = async (id: string) => (await approvals.get(id))?.request.status;

    it('decides at once when the model passes no flag at all (the real models never passed execute)', async () => {
      const id = await pendingApproval('d1');
      const t = await thread(op);
      const reply = await ask(op, t, approve(id));
      expect(reply).toContain('executed');
      expect(reply).not.toContain('NOT executed');
      expect(await statusOf(id)).toBe('approved');
      const d = (await detail(op, t)).drafts[0];
      expect(d).toMatchObject({ kind: 'approval_decision', state: 'confirmed' });
      const a = await directAudit(d?.id ?? '');
      expect(a).toEqual([expect.objectContaining({ actor_id: opId, outcome: 'success' })]);
      expect(a[0]?.metadata).toMatchObject({ via: 'chat', trigger: 'default' });
    });

    it('the assistant’s own proposal (propose: true) stays a card, nothing decided, nothing audited as direct', async () => {
      const id = await pendingApproval('d2');
      const t = await thread(op);
      const reply = await ask(op, t, approve(id, { propose: true }));
      expect(reply).toContain('NOT executed');
      expect(await statusOf(id)).toBe('pending');
      const d = (await detail(op, t)).drafts[0];
      expect(d?.state).toBe('proposed');
      expect(await directAudit(d?.id ?? '')).toEqual([]);
      // The person confirms the card as before.
      const ok = await op.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await statusOf(id)).toBe('approved');
    });

    it('a turn no person started (a system-written message) never acts; execute there is refused and audited', async () => {
      const id = await pendingApproval('d3');
      const t = await thread(op);
      const sys = { userId: opId, ip: 'system', userAgent: null };
      const before = (await detail(op, t)).messages.length;
      await h.app.chat.send(sys, t, `${approve(id)} ${approve(id, { execute: true })}`);
      await expect
        .poll(
          async () => {
            const d = await detail(op, t);
            return d.turn === null && d.messages.length > before + 1;
          },
          { timeout: 20_000 },
        )
        .toBe(true);
      expect(await statusOf(id)).toBe('pending');
      const drafts = (await detail(op, t)).drafts;
      expect(drafts.map((x) => x.state)).toEqual(['proposed', 'proposed']);
      const audits = await Promise.all(drafts.map((x) => directAudit(x.id)));
      expect(audits.flat()).toMatchObject([{ outcome: 'denied', metadata: { reason: 'not_user_turn' } }]);
    });

    it('an answer to the assistant’s question is the person’s instruction: it acts', async () => {
      const id = await pendingApproval('d4');
      const t = await thread(op);
      await ask(op, t, tool('ask_user', { questions: [{ prompt: 'Ne yapayım?', kind: 'text' }] }));
      const q = (await detail(op, t)) as unknown as { questions: { id: string; state: string }[] };
      const qid = q.questions.at(-1)?.id ?? '';
      const r = await op.req('POST', `/chat/threads/${t}/questions/${qid}/answer`, {
        answers: [{ id: 'q1', text: approve(id) }],
      });
      expect(r.statusCode, r.body).toBe(200);
      await expect.poll(() => statusOf(id), { timeout: 20_000 }).toBe('approved');
    });

    it('needs_code: a protected event keeps a card that asks for the code (default path)', async () => {
      await h.setSecurityPolicy({ preset: 'serbest', stepUp: { windowMinutes: 5 } });
      await stepUp(owner, ownerSecret);
      h.clock.advance(6 * MIN);
      const t = await thread(owner);
      const reply = await ask(
        owner,
        t,
        tool('change_settings', {
          target: 'security_policy',
          securityPolicy: { events: { 'deploy.production': true } },
        }),
      );
      expect(reply).toContain('needsCode');
      const d = (await detail(owner, t)).drafts[0];
      expect(d?.state).toBe('proposed');
      expect((await directAudit(d?.id ?? ''))[0]).toMatchObject({
        outcome: 'denied',
        metadata: { reason: 'needs_code', trigger: 'default' },
      });
      await h.setSecurityPolicy({ preset: 'serbest' });
    });

    it('RBAC: what the user may not do is refused, whatever the default', async () => {
      const t = await thread(op);
      const refused = await ask(
        op,
        t,
        tool('change_settings', { target: 'security_policy', securityPolicy: { preset: 'siki' } }),
      );
      expect(refused).toContain('refused');
      expect((await detail(op, t)).drafts).toEqual([]);
      const view = (await owner.req('GET', '/security/policy')).json<{ effective: { preset?: string } }>();
      expect(JSON.stringify(view)).toContain('serbest');
    });

    it('chatDirect off keeps plain cards (no direct-action audit for the default path)', async () => {
      await h.setSecurityPolicy({ preset: 'serbest', autonomy: { chatDirect: false } });
      const id = await pendingApproval('d5');
      const t = await thread(op);
      const reply = await ask(op, t, approve(id));
      expect(reply).toContain('NOT executed');
      expect(await statusOf(id)).toBe('pending');
      const d = (await detail(op, t)).drafts[0];
      expect(await directAudit(d?.id ?? '')).toEqual([]);
      await h.setSecurityPolicy({ preset: 'serbest' });
    });

    it('an older assistant worker (no assistant-propose-v1) keeps cards unless execute is passed', async () => {
      await h.db.pool.query(`UPDATE workers SET features = features - 'assistant-propose-v1' WHERE id = $1`, [
        workerId,
      ]);
      try {
        const id = await pendingApproval('d6');
        const t = await thread(op);
        expect(await ask(op, t, approve(id))).toContain('NOT executed');
        expect(await statusOf(id)).toBe('pending');
        expect(await ask(op, t, approve(id, { execute: true }))).toContain('executed');
        expect(await statusOf(id)).toBe('approved');
      } finally {
        await h.db.pool.query(
          `UPDATE workers SET features = features || '["assistant-propose-v1"]'::jsonb WHERE id = $1`,
          [workerId],
        );
      }
    });
  });
});
