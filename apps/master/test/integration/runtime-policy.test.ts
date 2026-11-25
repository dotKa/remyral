import type { RuntimeKind, RuntimePolicyDelivery, RuntimePolicyDocument } from '@remyral/protocol';
import { type CapabilitiesPayload, checkRuntimeForJob } from '@remyral/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';

function doc(codexPin: string, opts: { allowUnpinned?: boolean } = {}): RuntimePolicyDocument {
  return {
    runtimes: {
      codex: {
        version: codexPin,
        // p17-update-channel: the p3 staged pin flow is an owner hold (a following rule takes the release pin).
        pin: 'hold',
        authModes: ['secret-ref'],
        allowUnpinned: opts.allowUnpinned ?? false,
        modelProfiles: [
          { name: 'fast', provider: 'openai', model: 'gpt-5-mini', params: { reasoningEffort: 'low' } },
          { name: 'deep', provider: 'openai', model: 'gpt-5', params: { reasoningEffort: 'high' } },
        ],
        defaultProfile: 'fast',
      },
      opencode: {
        version: '1.19.0',
        pin: 'hold',
        authModes: ['secret-ref', 'local-login'],
        allowUnpinned: false,
        modelProfiles: [],
        defaultProfile: null,
      },
    },
    projectProfiles: { alpha: { codex: ['deep'] } },
  };
}

/** A simulated probe: installed versions per runtime, pins compared against the applied policy. */
function capsFor(installed: Partial<Record<RuntimeKind, string>>) {
  return (policy: RuntimePolicyDelivery | null): CapabilitiesPayload => ({
    runtimes: (Object.entries(installed) as [RuntimeKind, string][]).map(([runtime, version]) => {
      const pin = policy?.document.runtimes[runtime]?.version ?? version;
      return {
        runtime,
        version,
        installed: true,
        authenticated: 'unknown' as const,
        capabilities: {
          streaming: {
            status: 'unverified' as const,
            ...(pin === version ? {} : { note: `pinMismatch: ${version} != pin ${pin}` }),
          },
        },
        pinnedVersion: pin,
        pinStatus: pin === version ? ('match' as const) : ('mismatch' as const),
      };
    }),
    sandboxProfiles: ['host-restricted'],
    maxParallelJobs: 1,
    tools: [],
    // A current worker: it understands the p17-update-channel pin modes (older ones get the legacy document).
    features: ['version-catalog-v1' as const],
    ...(policy === null
      ? {}
      : { runtimePolicy: { name: policy.name, version: policy.version, documentHash: policy.documentHash } }),
  });
}

interface PolicyBody {
  name: string;
  activeVersion: number | null;
  canaryVersion: number | null;
  previousVersion: number | null;
}

interface WorkerPolicyBody {
  effective: { policy: string; version: number; stage: string } | null;
  applied: { version: number | null };
  inSync: boolean;
  canary: boolean;
  runtimes: { runtime: string; pinned: string; installed: string | null; status: string }[];
}

describeIntegration('runtime policy: delivery, staged upgrade, rollback (integration)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let viewer: Client;
  let secret: string;
  const dirs: string[] = [];
  const running: RunningWorker[] = [];

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    await h.createUser('viewer1', PW, 'viewer');
    const v = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, v.secret);
  });
  afterAll(async () => {
    for (const w of running) await w.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function workerPolicy(id: string): Promise<WorkerPolicyBody> {
    const res = await admin.req('GET', `/workers/${id}/runtime-policy`);
    expect(res.statusCode).toBe(200);
    return res.json<WorkerPolicyBody>();
  }

  async function start(
    dataDir: string,
    installed: Partial<Record<RuntimeKind, string>>,
  ): Promise<RunningWorker> {
    const w = await runRealWorker(url, dataDir, { runtimePolicy: true, capabilitiesFor: capsFor(installed) });
    running.push(w);
    return w;
  }

  let canaryId = '';
  let otherId = '';
  let canaryDir = '';
  let canary: RunningWorker;
  let other: RunningWorker;

  it('refuses writes without step-up and to viewers; rejects inconsistent or secret-bearing documents', async () => {
    const body = { document: doc('0.162.1'), stage: 'all', expectedVersion: 0 };
    expect((await viewer.req('PUT', '/runtime-policies/default', body)).statusCode).toBe(403);
    h.clock.advance(11 * 60_000); // the login's TOTP is no longer a fresh step-up
    const noStepUp = await admin.req('PUT', '/runtime-policies/default', body);
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json<{ error: string }>().error).toBe('step_up_required');
    await stepUp();
    const bad = doc('0.162.1');
    const codex = bad.runtimes.codex;
    if (codex === undefined) throw new Error('fixture');
    const inconsistent = {
      ...bad,
      runtimes: { ...bad.runtimes, codex: { ...codex, defaultProfile: 'nope' } },
    };
    const r1 = await admin.req('PUT', '/runtime-policies/default', { ...body, document: inconsistent });
    expect(r1.statusCode).toBe(400);
    expect(r1.json<{ issues: { path: string; code: string }[] }>().issues).toContainEqual({
      path: 'runtimes.codex.defaultProfile',
      code: 'unknown_profile',
    });
    const leaky = {
      ...bad,
      runtimes: {
        ...bad.runtimes,
        codex: {
          ...codex,
          modelProfiles: [
            {
              name: 'fast',
              provider: 'openai',
              model: 'gpt-5',
              params: { apiKey: 'sk-proj-' + 'a'.repeat(40) },
            },
          ],
        },
      },
    };
    const r2 = await admin.req('PUT', '/runtime-policies/default', { ...body, document: leaky });
    expect(r2.statusCode).toBe(400);
    expect(JSON.stringify(r2.json())).not.toContain('sk-proj-');
    const rows = await h.db.pool.query('SELECT count(*)::int AS n FROM runtime_policy_versions');
    expect(rows.rows[0]).toEqual({ n: 0 });
  });

  it('delivers the policy on change to a connected worker and on session start to a reconnecting one', async () => {
    canaryDir = await tempDataDir(dirs);
    canaryId = await pairRealWorker(h, url, admin, secret, canaryDir);
    const otherDir = await tempDataDir(dirs);
    otherId = await pairRealWorker(h, url, admin, secret, otherDir);
    canary = await start(canaryDir, { codex: '0.162.1', opencode: '1.19.0' });
    await expect.poll(() => h.app.workerHub.isConnected(canaryId)).toBe(true);

    // On change: the connected worker gets v1 right away.
    await stepUp();
    const put = await admin.req('PUT', '/runtime-policies/default', {
      document: doc('0.162.1'),
      stage: 'all',
      expectedVersion: 0,
      changeNote: 'initial pins from ADR-0012',
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<PolicyBody>()).toMatchObject({ name: 'default', activeVersion: 1, canaryVersion: null });
    await expect.poll(() => canary.policies?.policy?.version).toBe(1);
    await expect.poll(async () => (await workerPolicy(canaryId)).inSync).toBe(true);
    expect((await workerPolicy(canaryId)).runtimes).toContainEqual({
      runtime: 'codex',
      pinned: '0.162.1',
      pinMode: 'hold',
      installed: '0.162.1',
      status: 'match',
      allowUnpinned: false,
      authModes: ['secret-ref'],
      defaultProfile: 'fast',
      profiles: ['fast', 'deep'],
    });

    // On session start: the other worker was offline during the change.
    other = await start(otherDir, { codex: '0.162.1', opencode: '1.19.0' });
    await expect.poll(() => other.policies?.policy?.version).toBe(1);
    await expect.poll(async () => (await workerPolicy(otherId)).inSync).toBe(true);

    // The policy survives a worker restart (persisted, hash verified on open).
    await other.stop();
    other = await start(otherDir, { codex: '0.162.1', opencode: '1.19.0' });
    expect(other.policies?.policy?.version).toBe(1);

    const p = canary.policies?.policy ?? null;
    expect(
      checkRuntimeForJob({
        policy: p,
        runtime: 'codex',
        installedVersion: '0.162.1',
        authMode: 'secret-ref',
        project: 'alpha',
      }),
    ).toMatchObject({ ok: true, pinSource: 'policy', profile: { name: 'deep' } });
    expect(
      checkRuntimeForJob({
        policy: p,
        runtime: 'pi',
        installedVersion: '1.1.0',
        authMode: null,
        project: 'alpha',
      }),
    ).toMatchObject({ ok: false, code: 'runtime_not_allowed' });
    expect(
      checkRuntimeForJob({
        policy: p,
        runtime: 'codex',
        installedVersion: '0.162.1',
        authMode: 'local-login',
        project: 'x',
      }),
    ).toMatchObject({ ok: false, code: 'auth_mode_not_allowed' });
  });

  it('stages an upgrade on the canary only; the worker refuses a mismatching pin; promotion needs evidence', async () => {
    await stepUp();
    const assign = await admin.req('PUT', `/workers/${canaryId}/runtime-policy`, {
      policy: null,
      canary: true,
    });
    expect(assign.statusCode).toBe(200);
    expect(assign.json<WorkerPolicyBody>().canary).toBe(true);

    await stepUp();
    const staged = await admin.req('PUT', '/runtime-policies/default', {
      document: doc('0.163.0'),
      stage: 'canary',
      expectedVersion: 1,
      changeNote: 'codex 0.163.0',
    });
    expect(staged.statusCode).toBe(200);
    expect(staged.json<PolicyBody>()).toMatchObject({ activeVersion: 1, canaryVersion: 2 });
    await expect.poll(() => canary.policies?.policy?.version).toBe(2);
    expect(canary.policies?.policy?.stage).toBe('canary');
    // The rest of the group stays on v1.
    expect((await workerPolicy(otherId)).effective).toMatchObject({ version: 1, stage: 'active' });
    expect(other.policies?.policy?.version).toBe(1);

    // The canary still has codex 0.162.1 installed: the job runner check refuses it.
    expect(
      checkRuntimeForJob({
        policy: canary.policies?.policy ?? null,
        runtime: 'codex',
        installedVersion: '0.162.1',
        authMode: 'secret-ref',
        project: 'beta',
      }),
    ).toMatchObject({ ok: false, code: 'runtime_pin_mismatch' });
    await expect
      .poll(async () => (await workerPolicy(canaryId)).runtimes.find((r) => r.runtime === 'codex')?.status)
      .toBe('mismatch');

    // No canary evidence yet: promotion is refused.
    await stepUp();
    const refused = await admin.req('POST', '/runtime-policies/default/promote', { version: 2 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toBe('canary_not_verified');
  });

  it('rollback abandons the canary and the worker returns to the previous pin', async () => {
    await stepUp();
    const rb = await admin.req('POST', '/runtime-policies/default/rollback', {
      reason: 'canary pin mismatch',
    });
    expect(rb.statusCode).toBe(200);
    expect(rb.json<PolicyBody>()).toMatchObject({ activeVersion: 1, canaryVersion: null });
    await expect.poll(() => canary.policies?.policy?.version).toBe(1);
    expect(canary.policies?.policy?.stage).toBe('active');
    expect(
      checkRuntimeForJob({
        policy: canary.policies?.policy ?? null,
        runtime: 'codex',
        installedVersion: '0.162.1',
        authMode: 'secret-ref',
        project: 'beta',
      }),
    ).toMatchObject({ ok: true, pin: '0.162.1' });
  });

  it('allowUnpinned lets a mismatching runtime run (still flagged); promotion after the owner installs; rollback restores', async () => {
    await stepUp();
    const unpinned = await admin.req('PUT', '/runtime-policies/default', {
      document: doc('0.163.0', { allowUnpinned: true }),
      stage: 'canary',
      expectedVersion: 2,
    });
    expect(unpinned.statusCode).toBe(200);
    await expect.poll(() => canary.policies?.policy?.version).toBe(3);
    expect(
      checkRuntimeForJob({
        policy: canary.policies?.policy ?? null,
        runtime: 'codex',
        installedVersion: '0.162.1',
        authMode: 'secret-ref',
        project: 'beta',
      }),
    ).toMatchObject({ ok: true, pinMatches: false });

    // The owner installs codex 0.163.0 on the canary; its next CAPABILITIES report matches the pin.
    await canary.stop();
    canary = await start(canaryDir, { codex: '0.163.0', opencode: '1.19.0' });
    await expect
      .poll(async () => (await workerPolicy(canaryId)).runtimes.find((r) => r.runtime === 'codex')?.status)
      .toBe('match');
    await stepUp();
    const promoted = await admin.req('POST', '/runtime-policies/default/promote', { version: 3 });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json<PolicyBody>()).toMatchObject({
      activeVersion: 3,
      canaryVersion: null,
      previousVersion: 1,
    });
    await expect.poll(() => other.policies?.policy?.version).toBe(3);

    // Rollback to the previous pin for the whole group.
    await stepUp();
    const rb = await admin.req('POST', '/runtime-policies/default/rollback', {});
    expect(rb.statusCode).toBe(200);
    expect(rb.json<PolicyBody>()).toMatchObject({ activeVersion: 1, previousVersion: 3 });
    await expect.poll(() => other.policies?.policy?.version).toBe(1);
    await expect.poll(() => canary.policies?.policy?.version).toBe(1);
    expect(other.policies?.policy?.document.runtimes.codex?.version).toBe('0.162.1');

    const versions = await admin.req('GET', '/runtime-policies/default/versions');
    expect(versions.json<{ items: { version: number }[] }>().items.map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('audits every change (who, what, pins) and lets viewers read', async () => {
    const { rows } = await h.db.pool.query<{ action: string; outcome: string }>(
      `SELECT action, outcome FROM audit_events WHERE action LIKE 'runtime_policy.%' OR action = 'worker.runtime_policy.assign'
        ORDER BY occurred_at, id`,
    );
    expect(rows.map((r) => r.action)).toEqual([
      'runtime_policy.version',
      'worker.runtime_policy.assign',
      'runtime_policy.version',
      'runtime_policy.rollback',
      'runtime_policy.version',
      'runtime_policy.promote',
      'runtime_policy.rollback',
    ]);
    const list = await viewer.req('GET', '/runtime-policies');
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: PolicyBody[] }>().items[0]).toMatchObject({
      name: 'default',
      activeVersion: 1,
    });
    // Versions are append-only.
    await expect(h.db.pool.query('DELETE FROM runtime_policy_versions')).rejects.toThrow(/append-only/);
  });
});
