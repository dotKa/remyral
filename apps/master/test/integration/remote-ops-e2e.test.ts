import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNodeFileOps, type DaemonStopInfo, ManualSignals, runWorker } from '@remyral/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  codexFixture,
  codexManifest,
  fixtureServer,
  type Registry,
} from '../../../worker/test/remote-ops-fixtures.js';
import { hostPlatform } from '../../../worker/src/remote-ops/manifest.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';
import { FACTS } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';

interface Op {
  id: string;
  state: string;
  reason: string | null;
  result: Record<string, unknown> | null;
  logs: { lines: string[]; complete: boolean } | null;
}

/**
 * Panel → master → real worker for remote operations (p5-remote-ops): the real daemon (`runWorker`, WebSocket
 * transport) verifies the master's signed OPS_COMMAND, installs a pinned runtime from a local fixture registry
 * (checksums from its install set), reports it in CAPABILITIES, streams redacted log lines, runs diagnostics and
 * restarts (exit for the service manager) — all driven through the REST API an administrator uses.
 */
describeIntegration('remote operations with a real worker (integration, p5-remote-ops)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  const dirs: string[] = [];
  let workerId = '';
  let registry: Registry | undefined;
  let signals: ManualSignals | undefined;
  let running: Promise<DaemonStopInfo> | undefined;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function finished(id: string): Promise<Op> {
    let op: Op | undefined;
    await expect
      .poll(
        async () => {
          op = (await admin.req('GET', `/workers/${workerId}/ops/${id}`)).json<Op>();
          return ['succeeded', 'failed', 'refused', 'cancelled', 'lost'].includes(op.state);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    if (op === undefined) throw new Error('no op');
    return op;
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
  });

  afterAll(async () => {
    signals?.trigger('SIGTERM');
    await running?.catch(() => undefined);
    await registry?.close();
    await h.stop();
    await removeDirs(dirs);
  });

  it(
    'installs a pinned runtime, shows logs and diagnostics, and restarts the worker — all from the API',
    { timeout: 120_000 },
    async () => {
      const dataDir = await tempDataDir(dirs);
      workerId = await pairRealWorker(h, url, admin, secret, dataDir);
      const fx = codexFixture('9.1.0', hostPlatform());
      registry = await fixtureServer(fx.files);
      const work = join(dataDir, 'work');
      await mkdir(work, { recursive: true });
      await chmod(work, 0o700);
      const configPath = join(dataDir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          masterUrl: url.replace(/^http/, 'ws') + '/v1/worker',
          workspaceRoot: work,
          dataDir,
          allowedRuntimes: ['codex'],
        }),
        { mode: 0o600 },
      );
      signals = new ManualSignals();
      running = runWorker({
        ops: createNodeFileOps(),
        host: {
          platform: process.platform,
          env: () => undefined,
          homedir: () => dataDir,
          isPrivileged: false,
        },
        signals,
        facts: () => Promise.resolve({ ...FACTS, hostname: 'real-worker' }),
        configPath,
        logSink: () => undefined,
        heartbeatIntervalMs: 60_000,
        capabilities: (maxParallelJobs) =>
          // As the CLI probe reports it before the install (it lists every runtime, installed or not).
          Promise.resolve({
            runtimes: [
              {
                runtime: 'codex',
                version: 'not-installed',
                installed: false,
                authenticated: 'unknown',
                capabilities: {},
                pinnedVersion: '9.1.0',
                pinStatus: 'not-installed',
              },
            ],
            sandboxProfiles: [],
            maxParallelJobs,
            tools: [],
          }),
        locateRuntime: () => Promise.resolve(null),
        remoteOps: {
          manifest: codexManifest({ '9.1.0': fx.packages }, '9.1.0'),
          source: { npmRegistry: registry.base },
          restartable: true,
          restartDelayMs: 10,
          minFreeBytes: 1,
          clock: h.clock.now,
          env: { PATH: process.env.PATH ?? '', HOME: join(dataDir, 'home') },
        },
      });
      await expect
        .poll(
          async () =>
            (await admin.req('GET', `/workers/${workerId}/ops`)).json<{ supported: boolean }>().supported,
          {
            timeout: 15_000,
          },
        )
        .toBe(true);
      await stepUp();
      const install = await admin.req('POST', `/workers/${workerId}/runtimes/codex/install`, {
        version: '9.1.0',
      });
      expect(install.statusCode).toBe(200);
      const done = await finished(install.json<Op>().id);
      expect(done).toMatchObject({ state: 'succeeded' });
      await expect
        .poll(async () => {
          const s = (await admin.req('GET', `/workers/${workerId}/ops`)).json<{
            report: { runtimes: { runtime: string; active: string | null }[] } | null;
          }>();
          return s.report?.runtimes.find((r) => r.runtime === 'codex')?.active;
        })
        .toBe('9.1.0');
      // The master's runtime inventory (worker_runtimes) now shows the managed version.
      await expect
        .poll(async () => {
          const r = await h.db.pool.query<{ version: string }>(
            `SELECT version FROM worker_runtimes WHERE worker_id = $1 AND runtime = 'codex' AND present`,
            [workerId],
          );
          return r.rows[0]?.version;
        })
        .toBe('9.1.0');

      await stepUp();
      const logs = await admin.req('POST', `/workers/${workerId}/logs`, { lines: 200 });
      const tail = await finished(logs.json<Op>().id);
      expect(tail.state).toBe('succeeded');
      expect(tail.logs?.lines.join('\n')).toContain('runtime installed');

      await stepUp();
      const diag = await admin.req('POST', `/workers/${workerId}/diagnostics`, {});
      const d = await finished(diag.json<Op>().id);
      expect(JSON.stringify(d.result)).toContain('"source":"managed"');

      await stepUp();
      const restart = await admin.req('POST', `/workers/${workerId}/restart`, {
        drain: true,
        drainTimeoutSec: 30,
      });
      expect(restart.statusCode).toBe(200);
      expect((await finished(restart.json<Op>().id)).state).toBe('succeeded');
      const info = await running;
      expect(info.restart).toBe(true);
      running = undefined;
    },
  );
});
