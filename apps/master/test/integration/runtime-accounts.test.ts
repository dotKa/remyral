import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FakeScript } from '@remyral/agent-adapters';
import type { CapabilitiesPayload } from '@remyral/worker';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Cluster, PW } from '../helpers/cluster.js';
import { enroll, fullLogin } from '../helpers/harness.js';
import { describeIntegration } from '../helpers/env.js';
import { JobQuery } from '../../src/jobs/query.js';
import { JobStore } from '../../src/jobs/store.js';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { RuntimeAccountService } from '../../src/runtime-accounts/service.js';
import { JOB_CAPS, jobSpec, PROJECT } from '../helpers/job-worker.js';

const HINT_DB = 13;
const T = 45_000;
const RESUME_NOTE = '[Remyral] This run stopped because the';
const FEATURES = [
  'runtime-accounts-v1' as const,
  'approval-pause-v1' as const,
  'usage-limit-park-v1' as const,
];

interface Detail {
  job: { state: string };
  transitions: { trigger: string; reason: string | null }[];
  orchestration: {
    schedule: { status: string; reasons: { code: string; message: string }[] } | null;
    runs: { runtimeChoice: { runtime: string; account?: string; accountLabel?: string } | null }[];
    accountPin: { workerId: string; runtime: string; account: string; label: string | null } | null;
  };
}

/** The machine's Codex accounts as the worker reports them (CAPABILITIES.runtimeAccounts). */
const REPORT = [
  {
    runtime: 'codex',
    id: 'default',
    kind: 'subscription',
    store: 'codex',
    login: 'logged_in',
    lendable: false,
  },
  { runtime: 'codex', id: 'a1', kind: 'subscription', store: 'codex-a1', login: 'logged_in', lendable: true },
  { runtime: 'codex', id: 'a2', kind: 'subscription', store: 'codex-a2', login: 'logged_in', lendable: true },
  { runtime: 'codex', id: 'k1', kind: 'api_key', ready: true },
] as const;

/**
 * p13-runtime-accounts (docs/design/p13-runtime-accounts.md) against a real master (Postgres, orchestrator loop) and a
 * real worker daemon (job runner, fake runtime) that reports three Codex subscriptions and an API key:
 *  - the accounts API (the configured login is the `default` account without any migration; labels; step-up; audit;
 *    an unmanaged machine cannot get added accounts; the default cannot be removed);
 *  - placement per account: two subscription jobs at once on two accounts of one machine (balanced), a paused account
 *    skipped, the paid switch authoritative (an API key only once the project allows paid use);
 *  - a usage limit of one account continues the job with another account of the same machine in the same workspace
 *    (timeline + audit), the limit holds only that account;
 *  - "Hesabı değiştir" on a waiting job pins it to the chosen account.
 */
describeIntegration('runtime accounts (integration, p13-runtime-accounts)', { timeout: 240_000 }, () => {
  const c = new Cluster();
  let loginRoot = '';

  const detail = async (id: string): Promise<Detail> => (await c.detail(id)) as unknown as Detail;
  const accountOf = async (id: string): Promise<string | undefined> =>
    (await detail(id)).orchestration.runs.at(-1)?.runtimeChoice?.account;

  function caps(slots: number): CapabilitiesPayload {
    return {
      ...JOB_CAPS,
      maxParallelJobs: slots,
      runtimeAccounts: REPORT.map((a) => ({ ...a })),
    };
  }

  function workerAccounts() {
    const sub = (id: string) => ({
      runtime: 'codex' as const,
      id,
      kind: 'subscription' as const,
      isDefault: false,
      auth: { mode: 'local-login' as const },
      store: `codex-${id}`,
      loginDir: join(loginRoot, id, '.codex'),
      folder: join(loginRoot, id),
    });
    return [
      {
        runtime: 'codex' as const,
        id: 'default',
        kind: 'subscription' as const,
        isDefault: true,
        auth: { mode: 'local-login' as const },
        store: 'codex',
      },
      sub('a1'),
      sub('a2'),
      {
        runtime: 'codex' as const,
        id: 'k1',
        kind: 'api_key' as const,
        isDefault: false,
        auth: { mode: 'secret-ref' as const, ref: 'secret:vault-openai-team' },
        credentialId: 'openai-team',
      },
    ];
  }

  async function worker(script: FakeScript, slots = 3): Promise<string> {
    const { id } = await c.newWorker({
      fake: { script },
      features: FEATURES,
      capabilities: caps(slots),
      runtimeAuth: { codex: { mode: 'local-login' } },
      accounts: () => workerAccounts(),
    });
    for (const [account, label, kind, credential, position] of [
      ['a1', 'Kişisel Max', 'subscription', null, 1],
      ['a2', 'Şirket Team', 'subscription', null, 2],
      ['k1', 'API — fatura X', 'api_key', 'openai-team', 3],
    ] as const) {
      await c.h.db.pool.query(
        `INSERT INTO runtime_accounts (worker_id, runtime, account_id, label, kind, credential_id, position,
                                       created_at, updated_at)
         VALUES ($1, 'codex', $2, $3, $4, $5, $6, now(), now())`,
        [id, account, label, kind, credential, position],
      );
    }
    return id;
  }

  const sleeper: FakeScript = (prompt) =>
    prompt.includes('quick') ? [{ kind: 'summary', text: 'done' }] : [{ kind: 'sleep', ms: 120_000 }];

  beforeAll(async () => {
    loginRoot = await mkdtemp(join(tmpdir(), 'rw-accounts-'));
    c.dirs.push(loginRoot);
    await c.start(HINT_DB);
  });
  afterEach(async () => {
    await c.cancelAll();
    await c.stopWorkers();
    await c.h.db.pool.query('DELETE FROM runtime_accounts');
    await c.h.db.pool.query('UPDATE projects SET usage_limit_policy = NULL, account_policy = NULL');
    await c.h.db.pool.query(
      "UPDATE usage_limit_episodes SET ended_at = now(), end_reason = 'test' WHERE ended_at IS NULL",
    );
  });
  afterAll(async () => {
    await c.stop();
  });

  it('lists the accounts (the configured login is the default account); writes need step-up and are audited', async () => {
    const workerId = await worker(sleeper);
    const res = await c.admin.req('GET', `/runtime-accounts?worker=${workerId}&runtime=codex`);
    expect(res.statusCode, res.body).toBe(200);
    const list = res.json<{
      accounts: {
        id: string;
        label: string;
        kind: string;
        state: string;
        isDefault: boolean;
        supported: boolean;
      }[];
    }>().accounts;
    expect(list.map((a) => [a.id, a.label, a.kind, a.state])).toEqual([
      ['default', 'Varsayılan', 'subscription', 'logged_in'],
      ['a1', 'Kişisel Max', 'subscription', 'logged_in'],
      ['a2', 'Şirket Team', 'subscription', 'logged_in'],
      ['k1', 'API — fatura X', 'api_key', 'logged_in'],
    ]);
    expect(list[0]).toMatchObject({ isDefault: true, supported: true });
    // Never a token or an identity in the answer.
    expect(res.body).not.toMatch(/token|email|@/i);
    // The API-key account's vault id only for those who manage accounts.
    const k1 = (id: string, list2: { id: string; credentialId: string | null }[]) =>
      list2.find((a) => a.id === id);
    expect(
      k1('k1', res.json<{ accounts: { id: string; credentialId: string | null }[] }>().accounts)
        ?.credentialId,
    ).toBe('openai-team');
    await c.h.grant(await c.h.createUser('viewer.ra', PW, 'viewer'), [PROJECT], 'viewer');
    const viewer = await fullLogin(c.h, 'viewer.ra', PW, (await enroll(c.h, 'viewer.ra', PW)).secret);
    const asViewer = await viewer.req('GET', `/runtime-accounts?worker=${workerId}&runtime=codex`);
    expect(asViewer.statusCode, asViewer.body).toBe(200);
    expect(
      k1('k1', asViewer.json<{ accounts: { id: string; credentialId: string | null }[] }>().accounts),
    ).toMatchObject({ label: 'API — fatura X', credentialId: null });

    await c.stepUp();
    const paused = await c.admin.req('PATCH', `/workers/${workerId}/runtime-accounts/codex/a1`, {
      paused: true,
      pausedReason: 'kişisel kullanım',
    });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json<{ account: { state: string } }>().account.state).toBe('paused');
    const renamed = await c.admin.req('PATCH', `/workers/${workerId}/runtime-accounts/codex/default`, {
      label: 'Ev',
    });
    expect(renamed.json<{ account: { label: string } }>().account.label).toBe('Ev');

    // Added accounts travel in the panel configuration: an unmanaged machine refuses them.
    const add = await c.admin.req('POST', `/workers/${workerId}/runtime-accounts`, {
      runtime: 'codex',
      label: 'Üçüncü',
      kind: 'subscription',
    });
    expect(add.statusCode, add.body).toBe(409);
    expect(add.json<{ error: string }>().error).toBe('worker_unmanaged');
    const del = await c.admin.req('DELETE', `/workers/${workerId}/runtime-accounts/codex/default`);
    expect([403, 409]).toContain(del.statusCode);

    const audit = await c.h.db.pool.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action LIKE 'runtime_account.%' ORDER BY id",
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['runtime_account.pause', 'runtime_account.update']),
    );
  });

  it('two subscription jobs run at once on two accounts of one machine; a paused account is skipped', async () => {
    const workerId = await worker(sleeper);
    const first = await c.submit(jobSpec({ prompt: 'first' }));
    await expect.poll(() => c.state(first), { timeout: T }).toBe('RUNNING');
    const second = await c.submit(jobSpec({ prompt: 'second' }));
    await expect.poll(() => c.state(second), { timeout: T }).toBe('RUNNING');
    // Balanced: the lent accounts first (a1, then a2 — a1 already runs one), never the API key (paid off).
    expect(await accountOf(first)).toBe('a1');
    expect(await accountOf(second)).toBe('a2');
    expect((await detail(second)).orchestration.runs.at(-1)?.runtimeChoice?.accountLabel).toBe('Şirket Team');

    // Pause the default: the third job goes to a subscription that still has room, never the API key.
    await c.stepUp();
    expect(
      (await c.admin.req('PATCH', `/workers/${workerId}/runtime-accounts/codex/default`, { paused: true }))
        .statusCode,
    ).toBe(200);
    const third = await c.submit(jobSpec({ prompt: 'third' }));
    await expect.poll(() => c.state(third), { timeout: T }).toBe('RUNNING');
    expect(await accountOf(third)).toBe('a1');
  });

  it('the paid switch is authoritative: the API-key account only once the project allows paid API use', async () => {
    const workerId = await worker(sleeper, 1);
    await c.stepUp();
    for (const a of ['default', 'a1', 'a2']) {
      expect(
        (await c.admin.req('PATCH', `/workers/${workerId}/runtime-accounts/codex/${a}`, { paused: true }))
          .statusCode,
      ).toBe(200);
    }
    const job = await c.submit(jobSpec({ prompt: 'quick paid' }));
    await expect.poll(() => c.waitingCodes(job), { timeout: T }).toContain('account_unavailable');
    const reasons = (await detail(job)).orchestration.schedule?.reasons ?? [];
    expect(reasons.find((r) => r.code === 'account_unavailable')?.message).toContain('billed per token');
    await c.stepUp();
    const policy = await c.admin.req('PUT', `/projects/${PROJECT}/usage-limit-policy`, {
      policy: { mode: 'auto', maxWaitHours: 6, fallbacks: [], allowPaidFallback: true },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    await c.h.app.orchestrator.dispatch(job);
    await expect.poll(() => accountOf(job), { timeout: T }).toBe('k1');
    // The project view says so.
    const view = await c.admin.req('GET', `/projects/${PROJECT}/account-policy`);
    expect(view.json<{ allowPaid: boolean; effective: { strategy: string } }>()).toMatchObject({
      allowPaid: true,
      effective: { strategy: 'balanced' },
    });
  });

  it('a usage limit of one account continues with another account of the same machine in the same workspace', async () => {
    // The worker checks a parked workspace's retention against its real clock: run the master near real time (the
    // harness's fixed start date may be more than the 7-day maximum retention in the past).
    const behind = Date.now() - c.h.clock.now().getTime();
    if (behind > 0) {
      c.h.clock.advance(behind);
      c.admin = await fullLogin(c.h, 'owner1', PW, c.secret);
    }
    const prompts: string[] = [];
    const reset = new Date(c.h.clock.now().getTime() + 3 * 3600_000).toISOString();
    let limits = 1;
    const workerId = await worker((prompt) => {
      prompts.push(prompt);
      if (prompt.includes(RESUME_NOTE)) return [{ kind: 'summary', text: 'finished with another account' }];
      if (limits > 0) {
        limits -= 1;
        return [
          { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'first half done' } },
          {
            kind: 'crash',
            code: 'provider_usage_limit',
            message: "You've hit your limit",
            resetAt: reset,
            usageLimit: { kind: 'session', message: "You've hit your limit" },
          },
        ];
      }
      return [{ kind: 'summary', text: 'done' }];
    });
    const job = await c.submit(jobSpec({ prompt: 'long task' }));
    await expect.poll(() => c.state(job), { timeout: T }).toBe('SUCCEEDED');
    const d = await detail(job);
    expect(d.transitions.find((t) => t.trigger === 'pause_confirmed')?.reason).toMatch(
      /usage limit on Codex \(account Kişisel Max on .*\), resets at .*; continuing with account Şirket Team in the same workspace/,
    );
    expect(d.transitions.find((t) => t.trigger === 'resume_paused')?.reason).toContain(
      'continued with account a2',
    );
    expect(d.orchestration.runs).toHaveLength(1);
    expect(d.orchestration.runs[0]?.runtimeChoice?.account).toBe('a2');
    // The resumed run got the continuation note in a fresh session (another account's config dir).
    expect(prompts.some((p) => p.includes('another Codex account'))).toBe(true);
    // Only that account is limited; the machine runtime is not paused.
    const ep = await c.h.db.pool.query<{ runtime_account: string | null; scope_key: string }>(
      'SELECT runtime_account, scope_key FROM usage_limit_episodes WHERE ended_at IS NULL',
    );
    expect(ep.rows).toEqual([{ runtime_account: 'a1', scope_key: `worker:${workerId}:codex@a1` }]);
    const pauses = await c.h.db.pool.query('SELECT 1 FROM quota_pauses WHERE resumed_at IS NULL');
    expect(pauses.rowCount).toBe(0);
    const list = (await c.admin.req('GET', `/runtime-accounts?worker=${workerId}`)).json<{
      accounts: { id: string; state: string }[];
    }>().accounts;
    expect(list.find((a) => a.id === 'a1')?.state).toBe('limited');
    const audit = await c.h.db.pool.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action = 'job.usage_limit.account_switch'",
    );
    expect(audit.rowCount).toBe(1);
    // The next job avoids the limited account.
    const next = await c.submit(jobSpec({ prompt: 'quick after' }));
    await expect.poll(() => c.state(next), { timeout: T }).toBe('SUCCEEDED');
    expect(await accountOf(next)).not.toBe('a1');
  });

  it('"Hesabı değiştir" pins a waiting job to the chosen account', async () => {
    const workerId = await worker(sleeper, 1);
    const first = await c.submit(jobSpec({ prompt: 'blocker' }));
    await expect.poll(() => c.state(first), { timeout: T }).toBe('RUNNING');
    const second = await c.submit(jobSpec({ prompt: 'quick second' }));
    await expect.poll(() => c.state(second), { timeout: T }).toBe('QUEUED');
    await c.stepUp();
    const res = await c.admin.req('POST', `/jobs/${second}/switch-account`, { workerId, account: 'default' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ result: string }>().result).toBe('pinned');
    expect((await detail(second)).orchestration.accountPin).toMatchObject({ workerId, account: 'default' });
    await c.admin.req('POST', `/jobs/${first}/cancel`, { reason: 'make room' });
    await expect.poll(() => c.state(second), { timeout: T }).toBe('SUCCEEDED');
    expect(await accountOf(second)).toBe('default');
    const audit = await c.h.db.pool.query<{ metadata: { result?: string } }>(
      "SELECT metadata FROM audit_events WHERE action = 'job.account.switch'",
    );
    expect(audit.rows[0]?.metadata.result).toBe('pinned');
  });

  it('"Hesabı değiştir" on a running job: paused on its machine and resumed with the chosen account', async () => {
    const behind = Date.now() - c.h.clock.now().getTime();
    if (behind > 0) {
      c.h.clock.advance(behind);
      c.admin = await fullLogin(c.h, 'owner1', PW, c.secret);
    }
    const prompts: string[] = [];
    const workerId = await worker((prompt) => {
      prompts.push(prompt);
      return prompt.includes('[Remyral] This run was stopped so it could continue with another')
        ? [{ kind: 'summary', text: 'finished with the other account' }]
        : [{ kind: 'sleep', ms: 120_000 }];
    });
    const job = await c.submit(jobSpec({ prompt: 'long running' }));
    await expect.poll(() => c.state(job), { timeout: T }).toBe('RUNNING');
    expect(await accountOf(job)).toBe('a1');
    await c.stepUp();
    const res = await c.admin.req('POST', `/jobs/${job}/switch-account`, { workerId, account: 'a2' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ result: string }>().result).toBe('pausing');
    await expect.poll(() => c.state(job), { timeout: T }).toBe('SUCCEEDED');
    const d = await detail(job);
    expect(d.orchestration.runs).toHaveLength(1);
    expect(d.orchestration.runs[0]?.runtimeChoice?.account).toBe('a2');
    expect(d.transitions.find((t) => t.trigger === 'pause_confirmed')?.reason).toBe(
      'account switch by a person: continuing with account Şirket Team in the same workspace',
    );
    expect(d.transitions.find((t) => t.trigger === 'resume_paused')?.reason).toContain('account a2');
    expect(prompts.some((p) => p.includes('continue with another Codex account'))).toBe(true);
  });

  it('chat: runtime_accounts says which account is free; draft_account_action proposes a pause the user confirms', async () => {
    const workerId = await worker(sleeper);
    const { rows: users } = await c.h.db.pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = 'owner1'",
    );
    const userId = users[0]?.id ?? '';
    const store = new ChatStore({ pool: c.h.db.pool, clock: c.h.clock.now });
    const accounts = new RuntimeAccountService({
      pool: c.h.db.pool,
      audit: new AuditLog(c.h.db.pool, c.h.clock.now),
      clock: c.h.clock.now,
    });
    const tools = new ChatTools({
      db: c.h.db.pool,
      clock: c.h.clock.now,
      store,
      accounts: () => accounts,
    } as unknown as ChatToolsDeps);
    const subject = await loadSubject(c.h.db.pool, { id: userId, role: 'owner' });
    const thread = await store.createThread(userId, 'accounts');
    const caller = { userId, subject, threadId: thread.id, turnId: '00000000-0000-4000-8000-000000000001' };
    const read = await tools.run(caller, 'runtime_accounts', {
      runtime: 'codex',
      workerId,
      project: PROJECT,
    });
    expect(read.ok).toBe(true);
    const data = (
      read as { data: { accounts: { account: string; free: boolean; kind: string }[]; policy: unknown } }
    ).data;
    expect(data.accounts.map((a) => [a.account, a.free])).toEqual([
      ['default', true],
      ['a1', true],
      ['a2', true],
      ['k1', true],
    ]);
    expect(data.policy).toMatchObject({ strategy: 'balanced', skipAtPercent: 90 });
    const draft = await tools.run(caller, 'draft_account_action', {
      action: 'pause',
      workerId,
      runtime: 'codex',
      account: 'a1',
      reason: 'kişisel kullanım',
    });
    expect(draft.ok, JSON.stringify(draft)).toBe(true);
    const draftId = (draft as { data: { draftId: string } }).data.draftId;
    // Nothing changed until the user confirms the card (step-up).
    expect((await accounts.get(workerId, 'codex', 'a1'))?.paused).toBe(false);
    await c.stepUp();
    const confirm = await c.admin.req('POST', `/chat/drafts/${draftId}/confirm`, {});
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect((await accounts.get(workerId, 'codex', 'a1'))?.paused).toBe(true);
  });

  it('p22-coolify-env-exists: no card to move a job to the account it runs with; a card that became true closes as done', async () => {
    const behind = Date.now() - c.h.clock.now().getTime();
    if (behind > 0) {
      c.h.clock.advance(behind);
      c.admin = await fullLogin(c.h, 'owner1', PW, c.secret);
    }
    const workerId = await worker(sleeper);
    const job = await c.submit(jobSpec({ prompt: 'long running for the card' }));
    await expect.poll(() => c.state(job), { timeout: T }).toBe('RUNNING');
    const current = await accountOf(job);
    const other = current === 'a1' ? 'a2' : 'a1';
    const { rows: users } = await c.h.db.pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = 'owner1'",
    );
    const userId = users[0]?.id ?? '';
    const store = new ChatStore({ pool: c.h.db.pool, clock: c.h.clock.now });
    const accounts = new RuntimeAccountService({
      pool: c.h.db.pool,
      audit: new AuditLog(c.h.db.pool, c.h.clock.now),
      clock: c.h.clock.now,
    });
    const tools = new ChatTools({
      db: c.h.db.pool,
      clock: c.h.clock.now,
      store,
      accounts: () => accounts,
      jobs: new JobQuery(
        c.h.db.pool,
        new JobStore({
          pool: c.h.db.pool,
          audit: new AuditLog(c.h.db.pool, c.h.clock.now),
          clock: c.h.clock.now,
        }),
      ),
    } as unknown as ChatToolsDeps);
    const subject = await loadSubject(c.h.db.pool, { id: userId, role: 'owner' });
    const thread = await store.createThread(userId, 'accounts-same');
    const caller = { userId, subject, threadId: thread.id, turnId: '00000000-0000-4000-8000-000000000002' };
    // 1. Already true: no card.
    const same = await tools.run(caller, 'draft_account_action', {
      action: 'switch_job',
      workerId,
      runtime: 'codex',
      account: current ?? 'default',
      jobId: job,
    });
    expect(same.ok).toBe(false);
    expect(JSON.stringify(same)).toContain('nothing to move');
    // 2. A card for the other account, made true by someone else before it is confirmed: done, not an error.
    const card = await tools.run(caller, 'draft_account_action', {
      action: 'switch_job',
      workerId,
      runtime: 'codex',
      account: other,
      jobId: job,
    });
    expect(card.ok, JSON.stringify(card)).toBe(true);
    const draftId = (card as { data: { draftId: string } }).data.draftId;
    await c.stepUp();
    const moved = await c.admin.req('POST', `/jobs/${job}/switch-account`, { workerId, account: other });
    expect(moved.statusCode, moved.body).toBe(200);
    await expect.poll(() => accountOf(job), { timeout: T }).toBe(other);
    await expect.poll(() => c.state(job), { timeout: T }).toBe('RUNNING');
    const confirm = await c.admin.req('POST', `/chat/drafts/${draftId}/confirm`, {});
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect(confirm.json()).toMatchObject({ result: { result: 'unchanged', account: other } });
    // 3. The job finishes before a card is confirmed (prod 2026-11-02: 500 from the immutable-job trigger): done.
    const late = await tools.run(caller, 'draft_account_action', {
      action: 'switch_job',
      workerId,
      runtime: 'codex',
      account: current ?? 'default',
      jobId: job,
    });
    expect(late.ok, JSON.stringify(late)).toBe(true);
    const lateId = (late as { data: { draftId: string } }).data.draftId;
    expect((await c.admin.req('POST', `/jobs/${job}/cancel`, { reason: 'test done' })).statusCode).toBe(200);
    await expect.poll(() => c.state(job), { timeout: T }).toBe('CANCELLED');
    const after = await c.admin.req('POST', `/chat/drafts/${lateId}/confirm`, {});
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json()).toMatchObject({ result: { result: 'job_finished' } });
    const api = await c.admin.req('POST', `/jobs/${job}/switch-account`, { workerId, account: other });
    expect(api.statusCode).toBe(409);
    expect(api.json()).toMatchObject({ error: 'job_finished' });
    const none = await tools.run(caller, 'draft_account_action', {
      action: 'switch_job',
      workerId,
      runtime: 'codex',
      account: other,
      jobId: job,
    });
    expect(JSON.stringify(none)).toContain('already finished');
  });
});
