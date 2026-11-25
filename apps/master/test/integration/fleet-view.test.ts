import { FakeRuntimeAdapter, type SpawnContext } from '@remyral/agent-adapters';
import { ProcessMemorySampler } from '@remyral/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { recordJobMemory } from '../../src/fleetview/memory-rollup.js';
import { Cluster, PW } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { enroll, fullLogin } from '../helpers/harness.js';
import { JOB_CAPS, jobSpec } from '../helpers/job-worker.js';

interface Overview {
  id: string;
  capacity: { running: number; max: number | null };
  sandboxReadiness: { profile: string; ready: boolean; reason: string | null }[];
  tools: { name: string }[];
  network: { key: string; label: string };
  runtimePolicy: { effective: string | null; inSync: boolean };
  release: { channel: string; lastAttempt: unknown };
  compatibility: { runtime: string; status: string; reason: string }[];
  parallelism: unknown;
  advice: unknown;
}

/**
 * p5-fleet-ui (docs/design/p5-fleet-ui.md): the fleet overview from a real worker's CAPABILITIES (sandbox
 * readiness persisted), capacity from the master's own leases, the compatibility matrix, and the worker
 * lifecycle timeline from the audit log — readable by a viewer, without IPs.
 */
describeIntegration('fleet overview and worker history (integration)', { timeout: 180_000 }, () => {
  const c = new Cluster();
  let id = '';

  beforeAll(async () => {
    await c.start(0, { loop: false });
  });
  afterAll(async () => {
    await c.stop();
  });

  it('reports capacity, readiness, tools, network and the compatibility matrix', async () => {
    ({ id } = await c.newWorker({
      capabilities: {
        ...JOB_CAPS,
        runtimes: JOB_CAPS.runtimes.map((r) => ({
          ...r,
          capabilities: { ...r.capabilities, streaming: { status: 'supported' } },
        })),
        sandboxReadiness: [
          { profile: 'host-restricted', ready: true },
          { profile: 'container', ready: false, reason: 'no rootless container engine' },
        ],
      },
    }));
    const jobId = await c.submit(jobSpec());
    await expect.poll(async () => (await c.detail(jobId)).attempts.length, { timeout: 30_000 }).toBe(1);

    const res = await c.admin.req('GET', '/fleet/overview');
    expect(res.statusCode, res.body).toBe(200);
    const w = res.json<{ workers: Overview[] }>().workers.find((x) => x.id === id);
    expect(w?.capacity).toEqual({ running: 1, max: 2 });
    expect(w?.sandboxReadiness).toContainEqual({
      profile: 'container',
      ready: false,
      runtimes: null,
      reason: 'no rootless container engine',
    });
    expect(w?.tools.map((t) => t.name)).toEqual(['git']);
    expect(w?.network.key).toBe('127.0.0.0/24');
    expect(res.body).not.toContain('127.0.0.1');
    expect(w?.release).toEqual({
      channel: 'stable',
      targetVersion: null,
      lastAttempt: null,
      previousVersion: null,
    });
    const byRuntime = Object.fromEntries((w?.compatibility ?? []).map((x) => [x.runtime, x.status]));
    expect(byRuntime).toEqual({
      'claude-code': 'not_installed',
      codex: 'ready',
      pi: 'not_installed',
      opencode: 'not_installed',
    });
    await c.cancelAll();
  });

  it('shows the worker timeline to a viewer, without user ids or addresses', async () => {
    const res = await c.admin.req('POST', `/workers/${id}/drain`, {});
    if (res.statusCode === 403) {
      await c.stepUp();
      expect((await c.admin.req('POST', `/workers/${id}/drain`, {})).statusCode).toBe(200);
    }
    await c.h.createUser('viewer.fleet', PW, 'viewer');
    const { secret } = await enroll(c.h, 'viewer.fleet', PW);
    c.h.clock.advance(30_000);
    const viewer = await fullLogin(c.h, 'viewer.fleet', PW, secret);
    const h = await viewer.req('GET', `/workers/${id}/history`);
    expect(h.statusCode, h.body).toBe(200);
    const items = h.json<{ items: { action: string; actor: { type: string; id: string | null } }[] }>().items;
    const actions = items.map((i) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'worker.pairing.request',
        'worker.approve',
        'worker.session.start',
        'worker.drain',
      ]),
    );
    expect(items.filter((i) => i.actor.type === 'user').every((i) => i.actor.id === null)).toBe(true);
    expect(h.body).not.toMatch(/127\.0\.0\.1|198\.51\.100/);
    expect((await viewer.req('GET', '/fleet/overview')).statusCode).toBe(200);
    expect((await viewer.req('GET', '/workers/wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa/history')).statusCode).toBe(404);
  });

  it('p6-capacity-advice: a measured JOB_RESULT feeds the rollup and the recommendation', async () => {
    const GiB = 2 ** 30;
    const sampler = new ProcessMemorySampler({
      read: () => Promise.resolve([{ pid: 4242, ppid: 1, rssBytes: 3 * GiB }]),
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    class MeasuredAdapter extends FakeRuntimeAdapter {
      override async spawn(ctx: SpawnContext) {
        ctx.onProcessSpawned?.(4242);
        await sampler.sample();
        return super.spawn(ctx);
      }
    }
    const { id: wid } = await c.newWorker({
      memory: sampler,
      adapter: new MeasuredAdapter({
        runtime: 'codex',
        script: () => [{ kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'done' } }],
      }),
    });
    const jobId = await c.submit(jobSpec());
    await expect.poll(() => c.state(jobId), { timeout: 30_000 }).toBe('SUCCEEDED');
    const attempt = (await c.detail(jobId)).attempts[0];
    expect(attempt?.workerId).toBe(wid);

    const res = await c.admin.req('GET', '/fleet/overview');
    expect(res.statusCode, res.body).toBe(200);
    const w = res.json<{ workers: Overview[] }>().workers.find((x) => x.id === wid);
    // FACTS: 8 CPUs, 16 GiB. reserve 3.2 GiB; codex measured 3 GiB x 1.25 = 3.75 GiB -> floor(12.8 / 3.75) = 3.
    expect(w?.advice).toMatchObject({
      recommended: 3,
      limitedBy: 'memory',
      cpuCount: 8,
      byCpu: 15,
      byMemory: 3,
      basis: { runtime: 'codex', peakBytes: 3 * GiB, source: 'measured', attempts: 1 },
    });
    expect(w?.parallelism).toEqual({
      effective: 2,
      configured: null,
      localCeiling: null,
      state: 'local_file',
    });

    // A replayed JOB_RESULT for the same attempt changes nothing.
    const again = await recordJobMemory(c.h.db.pool, {
      attemptId: attempt?.id ?? '',
      jobId,
      workerId: wid,
      resources: { peakMemoryBytes: 9 * GiB, samples: 1 },
      now: new Date(),
    });
    expect(again).toBe(false);
    const { rows } = await c.h.db.pool.query<{ attempts: number; recent_peak_bytes: string }>(
      'SELECT attempts, recent_peak_bytes FROM worker_runtime_memory WHERE worker_id = $1',
      [wid],
    );
    expect(rows).toEqual([{ attempts: 1, recent_peak_bytes: String(3 * GiB) }]);
  });
});
