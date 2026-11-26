import { type LeaseKey, type MasterToWorker, verifyOpsCommand } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p17-worker-managed Parts 3 and 4 against the real master (Postgres): removing a worker from the panel — authz,
 * always-fresh step-up, audit, an older worker refused, the signed `worker.uninstall` sent at once or queued for an
 * offline machine (cancellable until sent), the worker revoked only after its helper accepted, a refusal keeping the
 * worker with the manual command — and the owner-only machine-admin helper install.
 */

const PW = 'quartz-meadow-lantern-7';

type OpsCommand = Extract<MasterToWorker, { type: 'OPS_COMMAND' }>;

interface RemovalBody {
  supported: boolean;
  connected: boolean;
  revoked: boolean;
  removal: { state: string; purge: boolean; reason: string | null; opId: string | null } | null;
  manual: string[];
}

const CAPS = { runtimes: [], sandboxProfiles: ['container'], maxParallelJobs: 1, tools: [] };
const FEATURES = ['worker-config-v1', 'remote-ops-v1', 'worker-managed-v1'];

describeIntegration(
  'worker removal and helper management from the panel (integration, p17-worker-managed)',
  () => {
    let h: Harness;
    let url: string;
    let owner: Client;
    let ownerSecret: string;
    let admin: Client;
    let adminSecret: string;
    let operator: Client;
    let leaseKeys: LeaseKey[] = [];
    const open: RawWorker[] = [];

    async function stepUp(c: Client, secret: string): Promise<void> {
      h.clock.advance(30_000);
      expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    }

    async function pair(code: string, features = FEATURES): Promise<{ worker: RawWorker; id: string }> {
      const worker = await RawWorker.connect(url, new TestKey());
      open.push(worker);
      const pending = await worker.handshake({ pairingCode: code });
      const id = pending.workerId ?? '';
      await stepUp(owner, ownerSecret);
      expect((await owner.req('POST', `/workers/${id}/approve`, { pairingCode: code })).statusCode).toBe(200);
      const established = await worker.next('SESSION_ESTABLISHED');
      leaseKeys = established.payload.leaseKeys ?? leaseKeys;
      worker.sendJson(worker.envelope('CAPABILITIES', { ...CAPS, features }, { workerId: id }));
      await expect
        .poll(async () => (await admin.req('GET', `/workers/${id}/remove`)).json<RemovalBody>().supported, {
          timeout: 10_000,
        })
        .toBe(features.includes('worker-managed-v1'));
      return { worker, id };
    }

    async function view(id: string): Promise<RemovalBody> {
      const res = await admin.req('GET', `/workers/${id}/remove`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<RemovalBody>();
    }

    function update(
      worker: RawWorker,
      id: string,
      cmd: OpsCommand,
      seq: number,
      payload: Record<string, unknown>,
    ) {
      worker.sendJson(
        worker.envelope(
          'OPS_UPDATE',
          { commandId: cmd.payload.commandId, seq, kind: cmd.payload.op.kind, ...payload },
          { workerId: id },
        ),
      );
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
      await h.createUser('admin1', PW, 'admin');
      ({ secret: adminSecret } = await enroll(h, 'admin1', PW));
      admin = await fullLogin(h, 'admin1', PW, adminSecret);
      await h.createUser('op1', PW, 'operator');
      const op = await enroll(h, 'op1', PW);
      operator = await fullLogin(h, 'op1', PW, op.secret);
    });

    afterAll(async () => {
      for (const w of open) w.close();
      await h.stop();
    });

    it('authz, always-fresh step-up and an older worker are refused (and audited)', async () => {
      const old = await pair('OLDR-ABCD', ['worker-config-v1', 'remote-ops-v1']);
      expect((await operator.req('POST', `/workers/${old.id}/remove`, { purge: false })).statusCode).toBe(
        403,
      );
      await stepUp(admin, adminSecret);
      h.clock.advance(11 * 60_000);
      expect((await admin.req('POST', `/workers/${old.id}/remove`, { purge: false })).statusCode).toBe(403);
      await stepUp(admin, adminSecret);
      const res = await admin.req('POST', `/workers/${old.id}/remove`, { purge: false });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toBe('worker_update_required');
      const v = await view(old.id);
      expect(v.supported).toBe(false);
      expect(v.manual.join('\n')).toContain('uninstall');
      const denied = await h.db.pool.query(
        "SELECT 1 FROM audit_events WHERE action = 'worker.remove.request' AND outcome = 'denied' AND target = $1",
        [old.id],
      );
      expect(denied.rowCount).toBe(1);
    });

    it('a connected worker gets the signed uninstall; it is revoked once its helper accepted', async () => {
      const { worker, id } = await pair('REMV-ABCD');
      await stepUp(admin, adminSecret);
      const res = await admin.req('POST', `/workers/${id}/remove`, { purge: true });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<RemovalBody>().removal).toMatchObject({ state: 'sent', purge: true });
      expect((await worker.next('DRAIN')).payload.reason).toContain('removal');
      const cmd = await worker.next('OPS_COMMAND');
      expect(cmd.payload.op).toEqual({ kind: 'worker.uninstall', purge: true });
      const p = cmd.payload;
      expect(
        verifyOpsCommand(
          { workerId: id, commandId: p.commandId, issuedAt: p.issuedAt, expiresAt: p.expiresAt, op: p.op },
          p.signature,
          leaseKeys,
        ),
      ).toBe('ok');
      // A second request while one is open is refused.
      await stepUp(admin, adminSecret);
      expect((await admin.req('POST', `/workers/${id}/remove`, { purge: false })).statusCode).toBe(409);

      update(worker, id, cmd, 1, { state: 'running', progress: { step: 'helper_request' } });
      update(worker, id, cmd, 2, {
        state: 'succeeded',
        detail: 'the worker is removed in about 15 s',
        manage: {
          steps: [
            { id: 'helper_request', state: 'done' },
            { id: 'service_stop', state: 'pending' },
          ],
        },
      });
      await expect.poll(async () => (await view(id)).removal?.state, { timeout: 10_000 }).toBe('done');
      await expect.poll(async () => (await view(id)).revoked, { timeout: 10_000 }).toBe(true);
      await expect.poll(() => worker.isClosed, { timeout: 10_000 }).toBe(true);
      const audit = await h.db.pool.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE target = $1 AND action IN
         ('worker.remove.request', 'worker.ops.worker.uninstall', 'worker.remove.result', 'worker.revoke')
       ORDER BY occurred_at, id`,
        [id],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining(['worker.remove.request', 'worker.remove.result', 'worker.revoke']),
      );
      const op = await h.db.pool.query<{ result: { manage?: unknown } }>(
        'SELECT result FROM worker_ops WHERE id = $1',
        [p.commandId],
      );
      expect(op.rows[0]?.result.manage).toBeDefined();
    });

    it('an offline worker gets it when it connects; cancellable until then; a refusal keeps the worker', async () => {
      const { worker, id } = await pair('OFFL-ABCD');
      const key = worker.key;
      worker.close();
      await worker.closed;
      await expect.poll(async () => (await view(id)).connected, { timeout: 10_000 }).toBe(false);

      await stepUp(admin, adminSecret);
      const queued = await admin.req('POST', `/workers/${id}/remove`, { purge: false });
      expect(queued.statusCode, queued.body).toBe(200);
      expect(queued.json<RemovalBody>().removal?.state).toBe('requested');
      await stepUp(admin, adminSecret);
      const cancelled = await admin.req('DELETE', `/workers/${id}/remove`);
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json<RemovalBody>().removal?.state).toBe('cancelled');
      await stepUp(admin, adminSecret);
      expect((await admin.req('POST', `/workers/${id}/remove`, { purge: false })).statusCode).toBe(200);

      const back = await RawWorker.connect(url, key);
      open.push(back);
      expect((await back.handshake()).type).toBe('SESSION_ESTABLISHED');
      back.sendJson(back.envelope('CAPABILITIES', { ...CAPS, features: FEATURES }, { workerId: id }));
      const cmd = await back.next('OPS_COMMAND', 10_000);
      expect(cmd.payload.op).toEqual({ kind: 'worker.uninstall', purge: false });
      await expect.poll(async () => (await view(id)).removal?.state, { timeout: 10_000 }).toBe('sent');
      // Too late to cancel: it reached the machine.
      await stepUp(admin, adminSecret);
      expect((await admin.req('DELETE', `/workers/${id}/remove`)).statusCode).toBe(409);

      update(back, id, cmd, 1, {
        state: 'refused',
        reason: 'helper_unavailable',
        detail: 'no privileged updater installed',
      });
      await expect.poll(async () => (await view(id)).removal?.state, { timeout: 10_000 }).toBe('refused');
      const v = await view(id);
      expect(v.removal?.reason).toBe('helper_unavailable');
      expect(v.revoked).toBe(false);
      expect(v.manual[0]).toContain('uninstall');
      expect(back.isClosed).toBe(false);
    });

    it('installing the machine-admin helper is owner-only and always-fresh; the signed op reaches the worker', async () => {
      const { worker, id } = await pair('HELP-ABCD');
      await stepUp(admin, adminSecret);
      expect(
        (await admin.req('POST', `/workers/${id}/machine-admin/helper`, { action: 'install' })).statusCode,
      ).toBe(403);
      await stepUp(owner, ownerSecret);
      const res = await owner.req('POST', `/workers/${id}/machine-admin/helper`, { action: 'install' });
      expect(res.statusCode, res.body).toBe(200);
      expect((await worker.next('OPS_COMMAND')).payload.op).toEqual({
        kind: 'helper.manage',
        action: 'admin_helper.install',
      });
    });

    it('rootless Docker is a fixed machine-admin task (Linux only), its elevated commands approved per command', async () => {
      const { id } = await pair('DOCK-ABCD', [...FEATURES, 'machine-admin-v1']);
      await stepUp(owner, ownerSecret);
      const on = await owner.req('PUT', `/workers/${id}/machine-admin`, {
        enabled: true,
        autoApprove: false,
        expectedGeneration: 0,
      });
      expect(on.statusCode, on.body).toBe(200);
      // The raw test worker reports macOS: make it a Linux machine.
      await h.db.pool.query(`UPDATE workers SET facts = jsonb_set(facts, '{os}', '"linux"') WHERE id = $1`, [
        id,
      ]);
      await stepUp(admin, adminSecret);
      const res = await admin.req('POST', `/workers/${id}/machine-admin/tasks`, { setup: 'rootless-docker' });
      expect(res.statusCode, res.body).toBe(201);
      const { jobId } = res.json<{ jobId: string }>();
      const job = await h.db.pool.query<{ spec: { prompt: string; approvalPolicy: string; kind: string } }>(
        'SELECT spec FROM jobs WHERE id = $1',
        [jobId],
      );
      const spec = job.rows[0]?.spec;
      expect(spec?.kind).toBe('machine-admin');
      expect(spec?.approvalPolicy).toBe('ask-all');
      expect(spec?.prompt).toContain('dockerd-rootless-setuptool.sh install');
      expect(spec?.prompt).toContain('loginctl enable-linger remyral-worker');
      // On a machine that is not Linux the setup is refused.
      await h.db.pool.query(`UPDATE workers SET facts = jsonb_set(facts, '{os}', '"win32"') WHERE id = $1`, [
        id,
      ]);
      await h.db.pool.query("UPDATE jobs SET state = 'CANCELLED', version = version + 1 WHERE id = $1", [
        jobId,
      ]);
      await stepUp(admin, adminSecret);
      const win = await admin.req('POST', `/workers/${id}/machine-admin/tasks`, { setup: 'rootless-docker' });
      expect(win.statusCode).toBe(409);
      expect(win.json<{ error: string }>().error).toBe('setup_unsupported_os');
    });
  },
);
