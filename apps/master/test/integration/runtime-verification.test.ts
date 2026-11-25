import { sign } from 'node:crypto';
import {
  type CapabilityEvidence,
  capabilityEvidenceStatement,
  DEFAULT_VERIFICATION_BUDGET,
  type MasterToWorker,
} from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CapabilityEvidenceService } from '../../src/capability-evidence/service.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p17-runtime-verify (integration): "Doğrula" end to end against the master — authz, step-up, feature gate, audit, the
 * signed OPS_COMMAND, progress, evidence storage only with a valid device-key signature, the precedence rules
 * (fleet-wide for the exact tuple, never for another version / adapter revision), placement facts, the policy count,
 * platforms, the catalog mark and the per (machine, runtime) rate limit.
 */

const PW = 'quartz-meadow-lantern-7';
const REV = 'pi-adapter/1+pin1.4.0';
type OpsCommand = Extract<MasterToWorker, { type: 'OPS_COMMAND' }>;

const DECLARED = {
  streaming: 'supported',
  interactive_prompt: 'supported',
  approval: 'degraded',
  cancel: 'supported',
  safe_cancel: 'degraded',
  resume: 'degraded',
  cost_reporting: 'degraded',
  artifacts: 'unsupported',
} as const;

const UNVERIFIED = Object.fromEntries(
  Object.keys(DECLARED).map((c) => [
    c,
    c === 'artifacts'
      ? { status: 'unsupported', note: 'no artifact API' }
      : { status: 'unverified', note: 'Pi 1.4.0 not contract-tested on darwin-arm64 yet' },
  ]),
);

type Outcome = 'passed' | 'failed' | 'skipped';
function results(over: Partial<Record<keyof typeof DECLARED, Outcome>> = {}) {
  return (Object.keys(DECLARED) as (keyof typeof DECLARED)[]).map((capability) => {
    const status: Outcome =
      over[capability] ?? (DECLARED[capability] === 'unsupported' ? 'skipped' : 'passed');
    return {
      capability,
      status,
      reason: status === 'failed' ? `${capability} did not hold` : 'ok',
      durationMs: 10,
    };
  });
}

interface Op {
  id: string;
  kind: string;
  state: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

interface Status {
  supported: boolean;
  runtimes: {
    runtime: string;
    version: string;
    state: string;
    capabilities: {
      capability: string;
      reported: string;
      effective: string;
      verified: boolean;
      decided: { outcome: string; reason: string } | null;
    }[];
    lastRun: { machine: string; passed: number; failed: number } | null;
    history: { id: string; applies: boolean }[];
    running: { opId: string } | null;
    estimate: { tokens: number; maxTokens: number };
  }[];
}

describeIntegration(
  'runtime capability verification from the panel (integration, p17-runtime-verify)',
  () => {
    let h: Harness;
    let url: string;
    let admin: Client;
    let viewer: Client;
    let secret: string;
    const workers: { raw: RawWorker; id: string; key: TestKey; modern: boolean }[] = [];
    let seq = 0;

    async function stepUp(): Promise<void> {
      h.clock.advance(30_000);
      expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    }

    const w = (i: number) => {
      const x = workers[i];
      if (x === undefined) throw new Error('no worker');
      return x;
    };

    function capabilities(i: number, opts: { version?: string; adapterVersion?: string } = {}): void {
      const x = w(i);
      x.raw.sendJson(
        x.raw.envelope(
          'CAPABILITIES',
          {
            runtimes: [
              {
                runtime: 'pi',
                version: opts.version ?? '1.4.0',
                installed: true,
                authenticated: 'yes',
                capabilities: UNVERIFIED,
                pinnedVersion: '1.4.0',
                pinStatus: (opts.version ?? '1.4.0') === '1.4.0' ? 'match' : 'mismatch',
                ...(x.modern
                  ? { verification: { adapterVersion: opts.adapterVersion ?? REV, declared: DECLARED } }
                  : {}),
              },
            ],
            sandboxProfiles: ['host-restricted'],
            maxParallelJobs: 1,
            tools: [],
            features: [
              'worker-config-v1',
              'remote-ops-v1',
              ...(x.modern ? ['runtime-capability-verify-v1'] : []),
            ],
            remoteOps: {
              runtimes: [],
              login: [],
              service: { manager: 'launchd', restartable: true },
              logs: { available: false, bytes: 0 },
            },
          },
          { workerId: x.id },
        ),
      );
    }

    function evidence(i: number, cmd: OpsCommand, res = results()): CapabilityEvidence {
      return {
        runtime: 'pi',
        runtimeVersion: '1.4.0',
        adapterVersion: REV,
        os: 'darwin',
        arch: 'arm64',
        workerId: w(i).id,
        workerVersion: '1.3.0',
        opId: cmd.payload.commandId,
        startedAt: '2026-10-27T10:00:00.000Z',
        finishedAt: new Date(h.clock.now().getTime()).toISOString(),
        durationMs: 120_000,
        authMode: 'local-login',
        sandboxProfile: 'host-restricted',
        budget: DEFAULT_VERIFICATION_BUDGET,
        usage: { inputTokens: 20_000, outputTokens: 3_000 },
        declared: DECLARED,
        results: res,
      };
    }

    function signWith(key: TestKey, workerId: string, e: CapabilityEvidence): string {
      return sign(
        null,
        capabilityEvidenceStatement({ workerId, opId: e.opId, evidence: e }),
        key.privateKey,
      ).toString('base64url');
    }

    function update(i: number, cmd: OpsCommand, payload: Record<string, unknown>): void {
      w(i).raw.sendJson(
        w(i).raw.envelope(
          'OPS_UPDATE',
          { commandId: cmd.payload.commandId, seq: ++seq, kind: cmd.payload.op.kind, ...payload },
          { workerId: w(i).id },
        ),
      );
    }

    async function op(i: number, id: string): Promise<Op> {
      const res = await admin.req('GET', `/workers/${w(i).id}/ops/${id}`);
      expect(res.statusCode).toBe(200);
      return res.json<Op>();
    }

    async function status(i: number): Promise<Status> {
      const res = await admin.req('GET', `/workers/${w(i).id}/runtime-verification`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Status>();
    }

    const effective = (s: Status, cap: string) =>
      s.runtimes.find((r) => r.runtime === 'pi')?.capabilities.find((c) => c.capability === cap);

    async function startRun(i: number): Promise<{ op: Op; cmd: OpsCommand }> {
      await stepUp();
      const res = await admin.req('POST', `/workers/${w(i).id}/runtimes/pi/verify`, {});
      expect(res.statusCode, res.body).toBe(200);
      const cmd = await w(i).raw.next('OPS_COMMAND');
      return { op: res.json<Op>(), cmd };
    }

    beforeAll(async () => {
      h = new Harness();
      await h.start({
        workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
        remoteOpsLimits: {
          perWorker: { max: 1000, windowMs: 60_000 },
          heavyPerWorker: { max: 1000, windowMs: 60_000 },
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
      for (const [code, modern] of [
        ['RVFA-ABCD', true],
        ['RVFB-ABCD', true],
        ['RVFC-ABCD', false],
      ] as const) {
        const key = new TestKey();
        const raw = await RawWorker.connect(url, key);
        const pending = await raw.handshake({ pairingCode: code });
        const id = pending.workerId ?? '';
        await stepUp();
        expect((await admin.req('POST', `/workers/${id}/approve`, { pairingCode: code })).statusCode).toBe(
          200,
        );
        await raw.next('SESSION_ESTABLISHED');
        workers.push({ raw, id, key, modern });
      }
      for (let i = 0; i < workers.length; i++) capabilities(i);
      for (let tries = 0; tries < 100; tries++) {
        const { rows } = await h.db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM worker_runtimes WHERE runtime = 'pi' AND present`,
        );
        if (rows[0]?.n === 3) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    });

    afterAll(async () => {
      for (const x of workers) x.raw.close();
      await h.stop();
    });

    it('owners / admins only, with step-up; older workers have no button; the runtime must be installed', async () => {
      expect((await viewer.req('GET', `/workers/${w(0).id}/runtime-verification`)).statusCode).toBe(403);
      await stepUp();
      expect((await viewer.req('POST', `/workers/${w(0).id}/runtimes/pi/verify`, {})).statusCode).toBe(403);
      h.clock.advance(11 * 60_000);
      const stale = await admin.req('POST', `/workers/${w(0).id}/runtimes/pi/verify`, {});
      expect(stale.statusCode).toBe(403);
      expect(stale.json<{ error: string }>().error).toBe('step_up_required');

      const old = await status(2);
      expect(old.supported).toBe(false);
      await stepUp();
      const refused = await admin.req('POST', `/workers/${w(2).id}/runtimes/pi/verify`, {});
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ error: string; params?: { reason?: string } }>()).toMatchObject({
        error: 'worker_update_required',
      });
      const missing = await admin.req('POST', `/workers/${w(0).id}/runtimes/codex/verify`, {});
      expect(missing.statusCode).toBe(409);
      expect(missing.json<{ error: string }>().error).toBe('runtime_not_installed');

      const s = await status(0);
      expect(s.supported).toBe(true);
      expect(s.runtimes[0]).toMatchObject({
        runtime: 'pi',
        version: '1.4.0',
        state: 'unverified',
        lastRun: null,
      });
      expect(s.runtimes[0]?.estimate.tokens).toBeLessThan(s.runtimes[0]?.estimate.maxTokens ?? 0);
      expect(w(0).raw.received.some((m) => m.type === 'OPS_COMMAND')).toBe(false);
    });

    it('a run is a signed, audited op; evidence with a valid device-key signature is stored and proves the tuple fleet-wide', async () => {
      const { op: created, cmd } = await startRun(0);
      expect(created).toMatchObject({ kind: 'runtime.capabilities.verify', state: 'sent' });
      expect(cmd.payload.op).toEqual({
        kind: 'runtime.capabilities.verify',
        runtime: 'pi',
        version: '1.4.0',
        budget: DEFAULT_VERIFICATION_BUDGET,
      });
      // One open run per (machine, runtime).
      await stepUp();
      const again = await admin.req('POST', `/workers/${w(0).id}/runtimes/pi/verify`, {});
      expect(again.statusCode).toBe(409);
      expect(again.json<{ error: string }>().error).toBe('verification_running');
      expect((await status(0)).runtimes[0]?.running?.opId).toBe(cmd.payload.commandId);

      update(0, cmd, { state: 'accepted' });
      update(0, cmd, {
        state: 'running',
        progress: { step: 'streaming' },
        capabilityVerify: { final: false, results: results().slice(0, 1) },
      });
      await expect
        .poll(async () => (await op(0, created.id)).result?.capabilityVerify)
        .toMatchObject({ final: false });

      const e = evidence(0, cmd, results({ safe_cancel: 'failed' }));
      update(0, cmd, {
        state: 'succeeded',
        detail: 'pi 1.4.0: 6 passed, 1 failed',
        capabilityVerify: { final: true, signed: { evidence: e, signature: signWith(w(0).key, w(0).id, e) } },
      });
      await expect.poll(async () => (await op(0, created.id)).state).toBe('succeeded');
      expect((await op(0, created.id)).result?.capabilityVerify).toMatchObject({
        final: true,
        evidenceStored: true,
      });
      const { rows } = await h.db.pool.query<{ passed: number; failed: number; signature: string }>(
        'SELECT passed, failed, signature FROM runtime_capability_evidence WHERE id = $1',
        [created.id],
      );
      expect(rows[0]).toMatchObject({ passed: 6, failed: 1 });
      const audit = await h.db.pool.query<{ action: string; outcome: string }>(
        `SELECT action, outcome FROM audit_events WHERE target = $1 AND action IN
         ('runtime.capabilities.verify.start', 'worker.ops.runtime.capabilities.verify', 'runtime.capabilities.evidence')
       ORDER BY id`,
        [`worker:${w(0).id}`],
      );
      expect(audit.rows.map((r) => `${r.action}:${r.outcome}`)).toEqual([
        'runtime.capabilities.verify.start:success',
        'worker.ops.runtime.capabilities.verify:success',
        'runtime.capabilities.evidence:success',
      ]);

      // Precedence on this machine: passed → the declared status; failed → stays unverified with the reason;
      // declared unsupported → unsupported.
      const s0 = await status(0);
      expect(effective(s0, 'streaming')).toMatchObject({
        reported: 'unverified',
        effective: 'supported',
        verified: true,
      });
      expect(effective(s0, 'approval')).toMatchObject({ effective: 'degraded', verified: true });
      expect(effective(s0, 'safe_cancel')).toMatchObject({
        effective: 'unverified',
        verified: false,
        decided: { outcome: 'failed', reason: 'safe_cancel did not hold' },
      });
      expect(effective(s0, 'artifacts')).toMatchObject({ effective: 'unsupported' });
      expect(s0.runtimes[0]?.state).toBe('partial');
      expect(s0.runtimes[0]?.history[0]).toMatchObject({ id: created.id, applies: true });

      // Fleet-wide: the other machine with the same tuple is proven too.
      const s1 = await status(1);
      expect(effective(s1, 'streaming')).toMatchObject({ effective: 'supported', verified: true });
      expect(s1.runtimes[0]?.lastRun?.passed).toBe(6);

      // Placement facts and the compatibility matrix use it.
      const candidates = await h.app.orchestrator.candidates('demo');
      for (const id of [w(0).id, w(1).id]) {
        expect(candidates.find((c) => c.id === id)?.runtimes[0]?.capabilities).toMatchObject({
          streaming: 'supported',
          cancel: 'supported',
          approval: 'degraded',
          safe_cancel: 'unverified',
        });
      }
      expect(candidates.find((c) => c.id === w(2).id)?.runtimes[0]?.capabilities?.streaming).toBe(
        'unverified',
      );
      const overview = await admin.req('GET', '/fleet/overview');
      const cell = (id: string) =>
        overview
          .json<{ workers: { id: string; compatibility: { runtime: string; status: string }[] }[] }>()
          .workers.find((x) => x.id === id)
          ?.compatibility.find((c) => c.runtime === 'pi');
      expect(cell(w(1).id)?.status).not.toBe('unverified');
      expect(cell(w(2).id)?.status).toBe('unverified');

      // ASSIGN_JOB facts for the modern machines only.
      const svc = new CapabilityEvidenceService({
        pool: h.db.pool,
        audit: { record: () => Promise.resolve() } as never,
        clock: () => h.clock.now(),
        log: { warn: () => undefined, error: () => undefined, info: () => undefined } as never,
        limiter: { hit: () => Promise.resolve({ allowed: true, retryAfterMs: 0 }) },
        remoteOps: () => {
          throw new Error('unused');
        },
        connected: () => true,
      });
      expect(await svc.verifiedFor(w(1).id, 'pi')).toMatchObject({
        runtime: 'pi',
        runtimeVersion: '1.4.0',
        os: 'darwin',
        arch: 'arm64',
        adapterVersion: REV,
        capabilities: ['streaming', 'interactive_prompt', 'approval', 'cancel', 'resume', 'cost_reporting'],
      });
      expect(await svc.verifiedFor(w(2).id, 'pi')).toBeUndefined();

      // Platforms and the policy dependence count.
      const platforms = await admin.req('GET', '/runtime-verification/platforms');
      expect(
        platforms.json<{
          items: {
            runtime: string;
            platform: string;
            version: string;
            verified: string[];
            current: boolean;
          }[];
        }>().items,
      ).toEqual([
        expect.objectContaining({ runtime: 'pi', platform: 'darwin-arm64', version: '1.4.0', current: true }),
      ]);
      const policy = await admin.req('GET', '/runtime-verification/policy');
      expect(
        policy.json<{
          total: number;
          dependent: number;
          items: { workerId: string; canVerify: boolean }[];
        }>(),
      ).toMatchObject({
        total: 3,
        dependent: 1,
        items: [expect.objectContaining({ workerId: w(2).id, canVerify: false })],
      });
    });

    it('another runtime version or adapter revision is unverified again (the version gate still applies)', async () => {
      capabilities(1, { version: '1.5.0' });
      await expect.poll(async () => effective(await status(1), 'streaming')?.effective).toBe('unverified');
      capabilities(1, { adapterVersion: 'pi-adapter/2+pin1.4.0' });
      await expect.poll(async () => (await status(1)).runtimes[0]?.version).toBe('1.4.0');
      expect(effective(await status(1), 'streaming')).toMatchObject({
        effective: 'unverified',
        verified: false,
      });
      expect(
        (await admin.req('GET', '/runtime-verification/policy')).json<{ dependent: number }>().dependent,
      ).toBe(2);
      capabilities(1);
      await expect.poll(async () => effective(await status(1), 'streaming')?.effective).toBe('supported');
    });

    it('a worker cannot forge evidence: another key, another machine or another tuple is refused and audited', async () => {
      const { op: created, cmd } = await startRun(0);
      const e = evidence(0, cmd, results({ safe_cancel: 'passed' }));
      // Signed by machine B's key although machine A answers.
      update(0, cmd, {
        state: 'succeeded',
        capabilityVerify: { final: true, signed: { evidence: e, signature: signWith(w(1).key, w(0).id, e) } },
      });
      await expect.poll(async () => (await op(0, created.id)).state).toBe('succeeded');
      expect((await op(0, created.id)).result?.capabilityVerify).toMatchObject({
        evidenceStored: false,
        evidenceRefused: 'bad_signature',
      });
      const stored = await h.db.pool.query('SELECT 1 FROM runtime_capability_evidence WHERE id = $1', [
        created.id,
      ]);
      expect(stored.rowCount).toBe(0);
      const refused = await h.db.pool.query<{ outcome: string }>(
        `SELECT outcome FROM audit_events WHERE action = 'runtime.capabilities.evidence' AND target = $1 ORDER BY id DESC LIMIT 1`,
        [`worker:${w(0).id}`],
      );
      expect(refused.rows[0]?.outcome).toBe('failure');
      // safe_cancel stays unverified (the forged pass changed nothing).
      expect(effective(await status(0), 'safe_cancel')?.effective).toBe('unverified');
    });

    it('the catalog mark needs a passed run; a later passing run is markable and a newer failure revokes a pass', async () => {
      await stepUp();
      const early = await admin.req('POST', '/runtime-verification/catalog/pi/1.4.0/mark', {});
      expect(early.statusCode).toBe(409);
      expect(early.json<{ error: string }>().error).toBe('verification_not_passed');

      const { op: created, cmd } = await startRun(0);
      const e = evidence(0, cmd, results({ safe_cancel: 'passed' }));
      update(0, cmd, {
        state: 'succeeded',
        capabilityVerify: { final: true, signed: { evidence: e, signature: signWith(w(0).key, w(0).id, e) } },
      });
      await expect.poll(async () => (await op(0, created.id)).state).toBe('succeeded');
      await expect.poll(async () => (await status(0)).runtimes[0]?.state).toBe('verified');
      await stepUp();
      const mark = await admin.req('POST', '/runtime-verification/catalog/pi/1.4.0/mark', {});
      expect(mark.statusCode, mark.body).toBe(204);
      const catalog = await admin.req('GET', '/runtime-verification/catalog');
      expect(
        catalog.json<{ items: { runtime: string; version: string; evidence: string; marked: unknown }[] }>()
          .items,
      ).toEqual([
        expect.objectContaining({
          runtime: 'pi',
          version: '1.4.0',
          evidence: 'passed',
          marked: expect.objectContaining({ at: expect.any(String) as unknown }) as unknown,
        }),
      ]);

      // Rate limit: four runs per (machine, runtime) and hour — the fourth is allowed (and refused by the worker here),
      // the fifth is not.
      const fourth = await startRun(0);
      update(0, fourth.cmd, {
        state: 'refused',
        reason: 'sandbox_not_ready',
        detail: 'no host sandbox profile',
      });
      await expect.poll(async () => (await op(0, fourth.op.id)).state).toBe('refused');
      await stepUp();
      const limited = await admin.req('POST', `/workers/${w(0).id}/runtimes/pi/verify`, {});
      expect(limited.statusCode).toBe(429);
      expect(limited.json<{ error: string }>().error).toBe('rate_limited');
      // Another machine has its own budget; a newer failure there revokes the pass for the tuple.
      const { op: other, cmd: cmd2 } = await startRun(1);
      h.clock.advance(1000);
      const failing = evidence(1, cmd2, results({ cancel: 'failed', safe_cancel: 'skipped' }));
      update(1, cmd2, {
        state: 'succeeded',
        capabilityVerify: {
          final: true,
          signed: { evidence: failing, signature: signWith(w(1).key, w(1).id, failing) },
        },
      });
      await expect.poll(async () => (await op(1, other.id)).state).toBe('succeeded');
      await expect.poll(async () => effective(await status(0), 'cancel')?.effective).toBe('unverified');
      // A skipped check changes nothing: safe_cancel stays proven from the earlier pass.
      expect(effective(await status(0), 'safe_cancel')?.effective).toBe('degraded');
    });

    it('an op the worker stopped answering (restarted mid-run) no longer blocks a new run', async () => {
      // A run sent before the worker restarted: never finished, no news for longer than the remote-ops window.
      const staleId = '6f1d2b7e-7c55-4b0e-9a51-0d5f1c1a9e01';
      const long = new Date(h.clock.now().getTime() - 41 * 60_000);
      await h.db.pool.query(
        `INSERT INTO worker_ops (id, worker_id, kind, params, state, requested_at, updated_at)
         VALUES ($1, $2, 'runtime.capabilities.verify', $3, 'running', $4, $4)`,
        [staleId, w(1).id, JSON.stringify({ runtime: 'pi', version: '1.4.0' }), long],
      );
      expect((await status(1)).runtimes[0]?.running).toBeNull();
      const { op: created, cmd } = await startRun(1);
      expect(created.state).toBe('sent');
      const { rows } = await h.db.pool.query<{ state: string; reason: string }>(
        'SELECT state, reason FROM worker_ops WHERE id = $1',
        [staleId],
      );
      expect(rows[0]).toEqual({ state: 'lost', reason: 'no_answer' });
      // Finish it so the next case starts from no open run.
      update(1, cmd, { state: 'refused', reason: 'sandbox_not_ready', detail: 'test' });
      await expect.poll(async () => (await op(1, created.id)).state).toBe('refused');
    });

    it('two quick clicks send one op: the second waits for the first and gets 409', async () => {
      await stepUp();
      const [a, b] = await Promise.all([
        admin.req('POST', `/workers/${w(1).id}/runtimes/pi/verify`, {}),
        admin.req('POST', `/workers/${w(1).id}/runtimes/pi/verify`, {}),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      expect([a, b].find((r) => r.statusCode === 409)?.json<{ error: string }>().error).toBe(
        'verification_running',
      );
      const { rows } = await h.db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM worker_ops
          WHERE worker_id = $1 AND kind = 'runtime.capabilities.verify'
            AND state IN ('sent', 'accepted', 'running', 'waiting_for_user')`,
        [w(1).id],
      );
      expect(rows[0]?.n).toBe(1);
      await w(1).raw.next('OPS_COMMAND');
      await new Promise((r) => setTimeout(r, 200));
      expect(w(1).raw.received.some((m) => m.type === 'OPS_COMMAND')).toBe(false);
    });

    it('Claude Code on a non-pinned agent SDK: the op, the evidence and ASSIGN_JOB use the probe version', async () => {
      const CC_REV = 'claude-code-adapter/1+sdk0.3.310';
      const PROBE = '2.1.320+sdk.0.3.320';
      const x = w(1);
      x.raw.sendJson(
        x.raw.envelope(
          'CAPABILITIES',
          {
            runtimes: [
              {
                runtime: 'claude-code',
                version: '2.1.320',
                evidenceVersion: PROBE,
                installed: true,
                authenticated: 'yes',
                capabilities: UNVERIFIED,
                pinnedVersion: '2.1.310',
                pinStatus: 'mismatch',
                verification: { adapterVersion: CC_REV, declared: DECLARED },
              },
            ],
            sandboxProfiles: ['host-restricted'],
            maxParallelJobs: 1,
            tools: [],
            features: ['worker-config-v1', 'remote-ops-v1', 'runtime-capability-verify-v1'],
            remoteOps: {
              runtimes: [],
              login: [],
              service: { manager: 'launchd', restartable: true },
              logs: { available: false, bytes: 0 },
            },
          },
          { workerId: x.id },
        ),
      );
      await expect
        .poll(async () => (await status(1)).runtimes.find((r) => r.runtime === 'claude-code')?.version)
        .toBe('2.1.320');
      await stepUp();
      const res = await admin.req('POST', `/workers/${x.id}/runtimes/claude-code/verify`, {});
      expect(res.statusCode, res.body).toBe(200);
      const cmd = await x.raw.next('OPS_COMMAND');
      expect(cmd.payload.op).toMatchObject({ kind: 'runtime.capabilities.verify', version: PROBE });
      const e: CapabilityEvidence = {
        ...evidence(1, cmd),
        runtime: 'claude-code',
        runtimeVersion: PROBE,
        adapterVersion: CC_REV,
      };
      update(1, cmd, {
        state: 'succeeded',
        capabilityVerify: { final: true, signed: { evidence: e, signature: signWith(x.key, x.id, e) } },
      });
      await expect
        .poll(async () => (await op(1, res.json<Op>().id)).result?.capabilityVerify)
        .toMatchObject({ evidenceStored: true });
      const cc = (await status(1)).runtimes.find((r) => r.runtime === 'claude-code');
      expect(cc?.capabilities.find((c) => c.capability === 'streaming')).toMatchObject({
        effective: 'supported',
        verified: true,
      });
      const svc = new CapabilityEvidenceService({
        pool: h.db.pool,
        audit: { record: () => Promise.resolve() } as never,
        clock: () => h.clock.now(),
        log: { warn: () => undefined, error: () => undefined, info: () => undefined } as never,
        limiter: { hit: () => Promise.resolve({ allowed: true, retryAfterMs: 0 }) },
        remoteOps: () => {
          throw new Error('unused');
        },
        connected: () => true,
      });
      expect(await svc.verifiedFor(x.id, 'claude-code')).toMatchObject({
        runtime: 'claude-code',
        runtimeVersion: PROBE,
        adapterVersion: CC_REV,
      });
    });
  },
);
