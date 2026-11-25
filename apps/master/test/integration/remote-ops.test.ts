import { type LeaseKey, type MasterToWorker, verifyOpsCommand } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';
/** What the owner pastes into a login: must never be stored, logged or audited by the master. */
const PASTE = 'PASTED-AUTH-CODE-0123456789abcdef#state-xyz';
type OpsCommand = Extract<MasterToWorker, { type: 'OPS_COMMAND' }>;

interface Op {
  id: string;
  kind: string;
  state: string;
  reason: string | null;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  login: { url: string | null; userCode: string | null; expectsCode: boolean; codeSent: boolean } | null;
  logs: { lines: string[]; next: number; complete: boolean } | null;
}

const REPORT = {
  runtimes: [
    {
      runtime: 'codex',
      method: 'npm',
      supported: true,
      pinned: '0.162.1',
      available: ['0.162.1'],
      installed: [],
      active: null,
    },
  ],
  login: [{ runtime: 'claude-code', status: 'logged_out' }],
  service: { manager: 'systemd', restartable: false },
  logs: { available: true, bytes: 1000 },
};

describeIntegration('remote operations (integration, p5-remote-ops)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let viewer: Client;
  let secret: string;
  let worker: RawWorker;
  let workerId = '';
  let leaseKeys: LeaseKey[] = [];
  let seq = 0;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  function capabilities(features: string[], remoteOps?: unknown): void {
    worker.sendJson(
      worker.envelope(
        'CAPABILITIES',
        {
          runtimes: [],
          sandboxProfiles: ['container'],
          maxParallelJobs: 1,
          tools: [],
          features,
          ...(remoteOps === undefined ? {} : { remoteOps }),
        },
        { workerId },
      ),
    );
  }

  function update(cmd: OpsCommand, payload: Record<string, unknown>, at = ++seq): void {
    worker.sendJson(
      worker.envelope(
        'OPS_UPDATE',
        { commandId: cmd.payload.commandId, seq: at, kind: cmd.payload.op.kind, ...payload },
        { workerId },
      ),
    );
  }

  async function op(id: string, after = 0): Promise<Op> {
    const res = await admin.req('GET', `/workers/${workerId}/ops/${id}?after=${String(after)}`);
    expect(res.statusCode).toBe(200);
    return res.json<Op>();
  }

  async function command(): Promise<OpsCommand> {
    const cmd = await worker.next('OPS_COMMAND');
    // Every command is signed by the master lease key, bound to this worker.
    expect(
      verifyOpsCommand(
        {
          workerId,
          commandId: cmd.payload.commandId,
          issuedAt: cmd.payload.issuedAt,
          expiresAt: cmd.payload.expiresAt,
          op: cmd.payload.op,
        },
        cmd.payload.signature,
        leaseKeys,
      ),
    ).toBe('ok');
    return cmd;
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      remoteOpsLimits: {
        perWorker: { max: 1000, windowMs: 60_000 },
        heavyPerWorker: { max: 4, windowMs: 60_000 },
        perUser: { max: 1000, windowMs: 60_000 },
      },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    await h.createUser('viewer1', PW, 'viewer');
    const v = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, v.secret);
    worker = await RawWorker.connect(url, new TestKey());
    const pending = await worker.handshake({ pairingCode: 'RMOP-ABCD' });
    workerId = pending.workerId ?? '';
    await stepUp();
    expect(
      (await admin.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'RMOP-ABCD' })).statusCode,
    ).toBe(200);
    leaseKeys = (await worker.next('SESSION_ESTABLISHED')).payload.leaseKeys ?? [];
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
  });

  it('refuses workers without remote-ops-v1, viewers, and requests without step-up', async () => {
    capabilities(['worker-config-v1']);
    await expect
      .poll(
        async () =>
          (await admin.req('GET', `/workers/${workerId}/ops`)).json<{ supported: boolean }>().supported,
      )
      .toBe(false);
    await stepUp();
    const old = await admin.req('POST', `/workers/${workerId}/diagnostics`, {});
    expect(old.statusCode).toBe(409);
    expect(old.json<{ error: string }>().error).toBe('worker_update_required');
    expect((await viewer.req('GET', `/workers/${workerId}/ops`)).statusCode).toBe(403);
    capabilities(['worker-config-v1', 'remote-ops-v1'], REPORT);
    await expect
      .poll(
        async () =>
          (await admin.req('GET', `/workers/${workerId}/ops`)).json<{ supported: boolean }>().supported,
      )
      .toBe(true);
    h.clock.advance(11 * 60_000);
    const stale = await admin.req('POST', `/workers/${workerId}/diagnostics`, {});
    expect(stale.statusCode).toBe(403);
    expect(stale.json<{ error: string }>().error).toBe('step_up_required');
    expect(worker.received.some((m) => m.type === 'OPS_COMMAND')).toBe(false);
  });

  it('installs only versions of the pinned set, sends a signed command and tracks progress idempotently', async () => {
    await stepUp();
    const status = await admin.req('GET', `/workers/${workerId}/ops`);
    expect(status.json<{ report: typeof REPORT }>().report.runtimes[0]?.available).toEqual(['0.162.1']);
    const unpinned = await admin.req('POST', `/workers/${workerId}/runtimes/codex/install`, {
      version: '0.170.0',
    });
    expect(unpinned.statusCode).toBe(409);
    expect(unpinned.json<{ error: string }>().error).toBe('version_not_available');
    const bad = await admin.req('POST', `/workers/${workerId}/runtimes/codex/install`, { version: 'latest' });
    expect(bad.statusCode).toBe(400);

    const res = await admin.req('POST', `/workers/${workerId}/runtimes/codex/install`, {
      version: '0.162.1',
    });
    expect(res.statusCode).toBe(200);
    const created = res.json<Op>();
    expect(created).toMatchObject({
      kind: 'runtime.install',
      state: 'sent',
      params: { runtime: 'codex', version: '0.162.1' },
    });
    const cmd = await command();
    expect(cmd.payload.op).toEqual({ kind: 'runtime.install', runtime: 'codex', version: '0.162.1' });
    expect(cmd.payload.commandId).toBe(created.id);
    update(cmd, { state: 'accepted' });
    update(cmd, { state: 'running', progress: { step: 'download', done: 3, total: 7 } });
    const done = ++seq;
    update(cmd, { state: 'succeeded', runtime: { ...REPORT.runtimes[0], active: '0.162.1' } }, done);
    // A late duplicate of an older update changes nothing.
    update(cmd, { state: 'running', progress: { step: 'download', done: 1, total: 7 } }, done - 1);
    await expect.poll(async () => (await op(created.id)).state).toBe('succeeded');
    await new Promise((r) => setTimeout(r, 100));
    const final = await op(created.id);
    expect(final.state).toBe('succeeded');
    expect(final.result).toMatchObject({ runtime: { active: '0.162.1' } });
    const audit = await h.db.pool.query<{ action: string; outcome: string }>(
      `SELECT action, outcome FROM audit_events WHERE target = $1 AND action LIKE 'worker.ops.%' ORDER BY id`,
      [`worker:${workerId}`],
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        { action: 'worker.ops.runtime.install', outcome: 'success' },
        { action: 'worker.ops.result', outcome: 'success' },
      ]),
    );
  });

  it('login relay: URL / code shown from memory, pasted code relayed once and never stored, logged or audited', async () => {
    await stepUp();
    const res = await admin.req('POST', `/workers/${workerId}/runtimes/claude-code/login`, {});
    expect(res.statusCode).toBe(200);
    const login = res.json<Op>();
    const cmd = await command();
    expect(cmd.payload.op).toEqual({ kind: 'login.start', runtime: 'claude-code' });
    // A second login on the same worker waits for the first.
    const twice = await admin.req('POST', `/workers/${workerId}/runtimes/claude-code/login`, {});
    expect(twice.statusCode).toBe(409);
    // Too early for a code.
    expect(
      (await admin.req('POST', `/workers/${workerId}/ops/${login.id}/input`, { code: PASTE })).statusCode,
    ).toBe(409);

    const signIn = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=state-xyz';
    update(cmd, { state: 'running', login: { runtime: 'claude-code', expectsCode: true } });
    update(cmd, {
      state: 'waiting_for_user',
      login: { runtime: 'claude-code', expectsCode: true, url: signIn },
    });
    await expect.poll(async () => (await op(login.id)).login?.url).toBe(signIn);
    // The URL is relayed from memory only.
    const row = await h.db.pool.query<{ j: string }>(
      'SELECT row_to_json(o)::text AS j FROM worker_ops o WHERE id = $1',
      [login.id],
    );
    expect(row.rows[0]?.j).not.toContain('claude.com');

    const pasted = await admin.req('POST', `/workers/${workerId}/ops/${login.id}/input`, { code: PASTE });
    expect(pasted.statusCode).toBe(200);
    expect(pasted.json<Op>().login?.codeSent).toBe(true);
    const relay = await command();
    expect(relay.payload.op).toEqual({ kind: 'login.input', target: login.id, code: PASTE });
    // Only once.
    expect(
      (await admin.req('POST', `/workers/${workerId}/ops/${login.id}/input`, { code: PASTE })).statusCode,
    ).toBe(409);
    update(relay, { state: 'succeeded' });
    update(cmd, {
      state: 'succeeded',
      login: { runtime: 'claude-code', expectsCode: false, status: 'logged_in' },
    });
    await expect.poll(async () => (await op(login.id)).state).toBe('succeeded');
    expect((await op(login.id)).login).toBeNull();

    // The pasted code exists nowhere on the master.
    for (const table of ['worker_ops', 'audit_events', 'workers']) {
      const dump = await h.db.pool.query<{ j: string }>(
        `SELECT coalesce(json_agg(t)::text, '') AS j FROM ${table} t`,
      );
      expect(dump.rows[0]?.j, table).not.toContain('PASTED-AUTH-CODE');
    }
    expect(h.logs.text).not.toContain('PASTED-AUTH-CODE');
  });

  it('logs: chunks are redacted again on the master and paged by cursor', async () => {
    await stepUp();
    const res = await admin.req('POST', `/workers/${workerId}/logs`, { lines: 100 });
    expect(res.statusCode).toBe(200);
    const id = res.json<Op>().id;
    const cmd = await command();
    expect(cmd.payload.op).toEqual({ kind: 'logs.tail', lines: 100, maxBytes: 128 * 1024 });
    const token = 'ghp_0123456789abcdefghijABCDEFGHIJ0123456789';
    update(cmd, {
      state: 'running',
      logs: {
        lines: ['{"msg":"a"}', `{"msg":"token ${token}"}`],
        truncated: false,
        redacted: true,
        last: false,
      },
    });
    update(cmd, {
      state: 'succeeded',
      logs: { lines: ['{"msg":"c"}'], truncated: true, redacted: true, last: true },
    });
    await expect.poll(async () => (await op(id)).logs?.complete).toBe(true);
    const all = await op(id);
    expect(all.logs?.lines).toHaveLength(3);
    expect(all.logs?.lines.join('\n')).not.toContain(token);
    const rest = await op(id, 2);
    expect(rest.logs?.lines).toEqual(['{"msg":"c"}']);
    expect(rest.logs?.next).toBe(3);
  });

  it('p6-worker-boot-diagnostics: logs source boot / updater needs logs-source-v1; worker stays the wire default', async () => {
    await stepUp();
    // This worker does not advertise logs-source-v1: a boot/updater request is refused, worker still works.
    const refused = await admin.req('POST', `/workers/${workerId}/logs`, { lines: 50, source: 'boot' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toBe('worker_update_required');
    const bad = await admin.req('POST', `/workers/${workerId}/logs`, { lines: 50, source: '/etc/shadow' });
    expect(bad.statusCode).toBe(400);
    expect(
      (await viewer.req('POST', `/workers/${workerId}/logs`, { lines: 50, source: 'boot' })).statusCode,
    ).toBe(403);
    const explicitWorker = await admin.req('POST', `/workers/${workerId}/logs`, {
      lines: 50,
      source: 'worker',
    });
    expect(explicitWorker.statusCode).toBe(200);
    // The default source is not put on the wire: an older worker verifies exactly the command it always got.
    const plain = await command();
    expect(plain.payload.op).toEqual({ kind: 'logs.tail', lines: 50, maxBytes: 128 * 1024 });
    update(plain, { state: 'succeeded', logs: { lines: [], truncated: false, redacted: true, last: true } });

    capabilities(['worker-config-v1', 'remote-ops-v1', 'logs-source-v1'], REPORT);
    await expect
      .poll(async () => {
        const r = await admin.req('POST', `/workers/${workerId}/logs`, { lines: 50, source: 'updater' });
        return r.statusCode;
      })
      .toBe(200);
    const cmd = await command();
    expect(cmd.payload.op).toEqual({ kind: 'logs.tail', lines: 50, maxBytes: 128 * 1024, source: 'updater' });
    update(cmd, {
      state: 'succeeded',
      logs: { lines: ['{"msg":"rolling back"}'], truncated: false, redacted: true, last: true },
    });
    capabilities(['worker-config-v1', 'remote-ops-v1'], REPORT);
  });

  it('diagnostics are stored redacted; restart is refused when the worker is not restartable', async () => {
    await stepUp();
    const res = await admin.req('POST', `/workers/${workerId}/diagnostics`, {});
    const id = res.json<Op>().id;
    const cmd = await command();
    const key = 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRETSECRET0123456789';
    update(cmd, {
      state: 'succeeded',
      diagnostics: {
        collectedAt: new Date().toISOString(),
        workerVersion: '0.1.0',
        node: { version: '24.11.0', ok: true, requiredMajor: 24 },
        os: { platform: 'linux', release: '6.1', arch: 'x64' },
        uptimeSec: 10,
        memory: { freeBytes: 1, totalBytes: 2 },
        disk: [{ name: 'dataDir', freeBytes: 10, totalBytes: 20 }],
        sandbox: [{ profile: 'container', ready: false, reason: `docker said ${key}` }],
        runtimes: [],
        service: { manager: 'systemd' },
        problems: [],
      },
    });
    await expect.poll(async () => (await op(id)).state).toBe('succeeded');
    const stored = await h.db.pool.query<{ j: string }>(
      'SELECT result::text AS j FROM worker_ops WHERE id = $1',
      [id],
    );
    expect(stored.rows[0]?.j).toContain('docker said');
    expect(stored.rows[0]?.j).not.toContain(key);

    const restart = await admin.req('POST', `/workers/${workerId}/restart`, { drain: true });
    expect(restart.statusCode).toBe(409);
    expect(restart.json<{ error: string }>().error).toBe('not_restartable');
  });

  it('p14-code-images: code.images.prepare needs code-images-v1, admin and step-up; the result and readiness are shown', async () => {
    h.clock.advance(2 * 60_000);
    await stepUp();
    const status = async () =>
      (await admin.req('GET', `/workers/${workerId}/ops`)).json<{
        codeImages: { supported: boolean; ready: boolean };
      }>().codeImages;
    expect(await status()).toEqual({ supported: false, ready: false });
    const old = await admin.req('POST', `/workers/${workerId}/code-images/prepare`, {});
    expect(old.statusCode).toBe(409);
    expect(old.json<{ error: string }>().error).toBe('worker_update_required');
    expect((await viewer.req('POST', `/workers/${workerId}/code-images/prepare`, {})).statusCode).toBe(403);

    capabilities(['worker-config-v1', 'remote-ops-v1', 'code-images-v1'], REPORT);
    await expect.poll(status).toEqual({ supported: true, ready: false });
    const res = await admin.req('POST', `/workers/${workerId}/code-images/prepare`, {});
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json<Op>().id;
    let cmd = await command();
    while (cmd.payload.op.kind !== 'code.images.prepare') cmd = await command();
    // No parameter: images, digests and contexts are fixed by the worker's release.
    expect(cmd.payload.op).toEqual({ kind: 'code.images.prepare' });
    update(cmd, { state: 'running', progress: { step: 'pull', done: 0, total: 4 } });
    const codeImages = {
      ready: true,
      images: [
        {
          language: 'js',
          tag: 'remyral/code-js:0.1.0',
          base: `node:24-bookworm-slim@sha256:${'d'.repeat(64)}`,
          id: `sha256:${'a'.repeat(64)}`,
        },
      ],
    };
    update(cmd, { state: 'succeeded', detail: 'built', codeImages });
    await expect.poll(async () => (await op(id)).state).toBe('succeeded');
    expect((await op(id)).result).toEqual({ codeImages });
    capabilities(['worker-config-v1', 'remote-ops-v1', 'code-images-v1', 'function-code-v1'], REPORT);
    await expect.poll(status).toEqual({ supported: true, ready: true });
    const audit = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'worker.ops.code.images.prepare' AND outcome = 'success'`,
    );
    expect(audit.rowCount).toBe(1);
    capabilities(['worker-config-v1', 'remote-ops-v1'], REPORT);
  });

  it('p17-disk-selfclean: disk.clean needs disk-hygiene-v1, admin and step-up; audited; the run reaches the machine page', async () => {
    h.clock.advance(2 * 60_000);
    await stepUp();
    const overview = async () =>
      (await admin.req('GET', '/fleet/overview'))
        .json<{
          workers: {
            id: string;
            diskHygiene: { supported: boolean; report: Record<string, unknown> | null };
          }[];
        }>()
        .workers.find((w) => w.id === workerId)?.diskHygiene;
    expect(await overview()).toEqual({ supported: false, report: null });
    const old = await admin.req('POST', `/workers/${workerId}/disk/clean`, {});
    expect(old.statusCode).toBe(409);
    expect(old.json<{ error: string; params?: { reason?: string } }>().error).toBe('worker_update_required');
    expect((await viewer.req('POST', `/workers/${workerId}/disk/clean`, {})).statusCode).toBe(403);

    // A worker with the feature reports its hygiene in CAPABILITIES (stored, shown with the time it came).
    const report = {
      enabled: true,
      thresholdBytes: 2 * 1024 ** 3,
      marginBytes: 1024 ** 3,
      targetBytes: 3 * 1024 ** 3,
      freeBytes: 512 * 1024 ** 2,
      checkedAt: '2026-10-25T10:00:00.000Z',
      running: false,
      lastRun: null,
      nextLowDiskAt: null,
      nextDailyAt: '2026-10-26T10:00:00.000Z',
      usage: null,
    };
    worker.sendJson(
      worker.envelope(
        'CAPABILITIES',
        {
          runtimes: [],
          sandboxProfiles: ['container'],
          maxParallelJobs: 1,
          tools: [],
          features: ['worker-config-v1', 'remote-ops-v1', 'disk-hygiene-v1'],
          remoteOps: REPORT,
          diskHygiene: report,
        },
        { workerId },
      ),
    );
    await expect.poll(async () => (await overview())?.supported).toBe(true);
    expect((await overview())?.report).toMatchObject(report);
    expect(typeof (await overview())?.report?.reportedAt).toBe('string');

    // Step-up is required (a stale one is refused).
    h.clock.advance(11 * 60_000);
    const noStep = await admin.req('POST', `/workers/${workerId}/disk/clean`, {});
    expect(noStep.statusCode).toBe(403);
    expect(noStep.json<{ error: string }>().error).toBe('step_up_required');
    await stepUp();
    const res = await admin.req('POST', `/workers/${workerId}/disk/clean`, {});
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json<Op>().id;
    let cmd = await command();
    while (cmd.payload.op.kind !== 'disk.clean') cmd = await command();
    // No parameter: what may be deleted is fixed by the worker.
    expect(cmd.payload.op).toEqual({ kind: 'disk.clean' });
    update(cmd, { state: 'running', progress: { step: 'clean' } });
    const run = {
      trigger: 'manual',
      startedAt: '2026-10-25T10:05:00.000Z',
      finishedAt: '2026-10-25T10:05:09.000Z',
      freeBefore: 512 * 1024 ** 2,
      freeAfter: 4 * 1024 ** 3,
      freedBytes: 3.5 * 1024 ** 3,
      freed: [
        { category: 'temp', bytes: 512 * 1024 ** 2, items: 3 },
        { category: 'packageCaches', bytes: 3 * 1024 ** 3, items: 2 },
      ],
      stillLow: false,
      errors: 0,
    };
    update(cmd, { state: 'succeeded', diskClean: run });
    await expect.poll(async () => (await op(id)).state).toBe('succeeded');
    expect((await op(id)).result).toEqual({ diskClean: run });
    // The machine page sees the run at once (before the next CAPABILITIES).
    await expect.poll(async () => (await overview())?.report?.lastRun).toEqual(run);
    const audit = await h.db.pool.query<{ action: string; outcome: string }>(
      `SELECT action, outcome FROM audit_events
        WHERE action IN ('worker.ops.disk.clean', 'worker.ops.result') AND target = $1
          AND (action = 'worker.ops.disk.clean' OR metadata->>'kind' = 'disk.clean')`,
      [`worker:${workerId}`],
    );
    expect(audit.rows.map((r) => r.action).sort()).toEqual(['worker.ops.disk.clean', 'worker.ops.result']);
    capabilities(['worker-config-v1', 'remote-ops-v1'], REPORT);
  });

  it('rate-limits heavy operations per worker and audits the refusal', async () => {
    await stepUp();
    let last = 200;
    for (let n = 0; n < 6 && last === 200; n++) {
      last = (await admin.req('POST', `/workers/${workerId}/runtimes/pi/restart`, {})).statusCode;
    }
    expect(last).toBe(429);
    const denied = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'worker.ops.runtime.restart' AND outcome = 'denied'`,
    );
    expect(denied.rowCount).toBeGreaterThan(0);
  });

  it('p5-claude-auth-health: a finished Check updates the stored login state at once (was: Unknown)', async () => {
    capabilities(['worker-config-v1', 'remote-ops-v1'], REPORT);
    await expect
      .poll(async () => {
        const r = await admin.req('GET', `/workers/${workerId}/ops`);
        return (r.json<{ report: { login: { status: string }[] } | null }>().report?.login ?? [])[0]?.status;
      })
      .toBe('logged_out');
    await stepUp();
    const res = await admin.req('POST', `/workers/${workerId}/runtimes/claude-code/login-status`, {});
    expect(res.statusCode).toBe(200);
    const id = res.json<Op>().id;
    // Earlier tests may have left commands in the socket's queue: take the one for this operation.
    let cmd = await command();
    while (cmd.payload.commandId !== id) cmd = await command();
    update(cmd, {
      state: 'succeeded',
      login: { runtime: 'claude-code', expectsCode: false, status: 'expired', reason: 'login_expired' },
    });
    await expect.poll(async () => (await op(id)).state).toBe('succeeded');
    expect((await op(id)).result).toEqual({
      login: { runtime: 'claude-code', status: 'expired', reason: 'login_expired' },
    });
    const status = await admin.req('GET', `/workers/${workerId}/ops`);
    const login = status.json<{ report: { login: Record<string, unknown>[] } }>().report.login;
    expect(login).toHaveLength(1);
    expect(login[0]).toMatchObject({ runtime: 'claude-code', status: 'expired', reason: 'login_expired' });
    expect(typeof login[0]?.checkedAt).toBe('string');
  });

  it('p13-fix-login-auth: the login routes take no body (older clients), `{}`, `default`, or an account id', async () => {
    const routes = ['login', 'login-status', 'logout'] as const;
    const kinds = { login: 'login.start', 'login-status': 'login.status', logout: 'login.logout' } as const;
    async function run(route: (typeof routes)[number], body?: unknown): Promise<OpsCommand['payload']['op']> {
      await stepUp();
      const res = await admin.req('POST', `/workers/${workerId}/runtimes/claude-code/${route}`, body);
      expect(res.statusCode, `${route} ${JSON.stringify(body)}: ${res.body}`).toBe(200);
      const id = res.json<Op>().id;
      let cmd = await command();
      while (cmd.payload.commandId !== id) cmd = await command();
      const account = 'account' in cmd.payload.op ? cmd.payload.op.account : undefined;
      update(cmd, {
        state: 'succeeded',
        login: {
          runtime: 'claude-code',
          expectsCode: false,
          status: 'logged_in',
          ...(account === undefined ? {} : { account }),
        },
      });
      await expect.poll(async () => (await op(id)).state).toBe('succeeded');
      return cmd.payload.op;
    }
    // Legacy path: a worker without runtime-accounts-v1; no body (curl / API clients before ADR-0049), `{}` (the
    // panel) and the `default` account are all the machine's configured login.
    capabilities(['worker-config-v1', 'remote-ops-v1'], REPORT);
    for (const route of routes) {
      for (const body of [undefined, {}, { account: 'default' }]) {
        expect(await run(route, body)).toEqual({ kind: kinds[route], runtime: 'claude-code' });
      }
    }
    // An added account needs a worker that knows accounts; a malformed id or an unknown field is refused.
    await stepUp();
    const old = await admin.req('POST', `/workers/${workerId}/runtimes/claude-code/login`, { account: 'a1' });
    expect(old.statusCode).toBe(409);
    expect(old.json<{ error: string }>().error).toBe('worker_update_required');
    for (const bad of [{ account: 'Not-An-Id' }, { account: 'a1', extra: true }]) {
      await stepUp();
      expect(
        (await admin.req('POST', `/workers/${workerId}/runtimes/claude-code/login`, bad)).statusCode,
      ).toBe(400);
    }
    // Account path: the command carries the account.
    capabilities(['worker-config-v1', 'remote-ops-v1', 'runtime-accounts-v1'], REPORT);
    // Wait until the master has the new CAPABILITIES (a refused request starts nothing).
    await expect
      .poll(async () => {
        await stepUp();
        return (
          await admin.req('POST', `/workers/${workerId}/runtimes/claude-code/login-status`, { account: 'zz' })
        ).statusCode;
      })
      .toBe(200);
    {
      let cmd = await command();
      while (cmd.payload.op.kind !== 'login.status') cmd = await command();
      update(cmd, {
        state: 'succeeded',
        login: { runtime: 'claude-code', expectsCode: false, status: 'logged_out', account: 'zz' },
      });
    }
    for (const route of routes) {
      expect(await run(route, { account: 'a1' })).toEqual({
        kind: kinds[route],
        runtime: 'claude-code',
        account: 'a1',
      });
    }
  });

  it('ignores updates for unknown operations and marks silent ones lost', async () => {
    worker.sendJson(
      worker.envelope(
        'OPS_UPDATE',
        {
          commandId: '00000000-0000-4000-8000-00000000dead',
          seq: 1,
          kind: 'diagnostics.run',
          state: 'succeeded',
        },
        { workerId },
      ),
    );
    await stepUp();
    const res = await admin.req('POST', `/workers/${workerId}/runtimes/claude-code/login-status`, {});
    const id = res.json<Op>().id;
    await command();
    h.clock.advance(11 * 60_000);
    expect((await op(id)).state).toBe('lost');
  });
});
