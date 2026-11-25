import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, Redactor } from '@remyral/observability';
import type { UpdateDiagnostics } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { updateSettingsSchema } from '../src/config/schema.js';
import { WINDOWS_SERVICE } from '../src/service/definitions.js';
import { osServiceControl } from '../src/update/helper/service-control.js';
import { type ServiceControl, Updater } from '../src/update/helper/updater.js';
import { dataLayout, installLayout } from '../src/update/layout.js';
import { UpdateAgent } from '../src/update/agent.js';
import { FakeSystem, fail, ok } from './fake-system.js';
import { nodeOps, tempDir } from './helpers.js';
import { releaseKey, signedRelease } from './release-fixtures.js';

// p6-worker-boot-diagnostics: the privileged updater records why a version failed its health check, the daemon
// forwards it with UPDATE_STATUS (or collects it itself next to an older updater), and the Windows restart no
// longer starts the service while it is still stopping.

const key = releaseKey();

async function setup(collect: boolean) {
  const root = await tempDir('rw-updiag-');
  const install = installLayout(process.platform, join(root, 'opt'));
  const data = dataLayout(process.platform, join(root, 'data'));
  await mkdir(install.installDir, { recursive: true });
  await mkdir(data.dataDir, { recursive: true });
  const clock = { t: Date.parse('2026-10-16T09:00:00.000Z') };
  const events: string[] = [];
  let restarts = 0;
  const service: ServiceControl = {
    restart: () => {
      restarts += 1;
      events.push(`restart#${String(restarts)}`);
      // The first restart (into the new version) fails like `net start` against a STOP_PENDING service.
      return restarts === 1
        ? Promise.reject(
            new Error('net.exe start RemyralWorker failed (2): The service is starting or stopping.'),
          )
        : writeFile(
            data.healthFile,
            JSON.stringify({
              schema: 1,
              version: '1.0.21',
              pid: 4242,
              sessionEstablishedAt: new Date(clock.t).toISOString(),
              heartbeatAt: new Date(clock.t + 1).toISOString(),
            }),
          );
    },
    mainPid: () => Promise.resolve(4242),
  };
  const seen: { version: string; restartErrors: readonly string[] }[] = [];
  const updater = new Updater({
    ops: nodeOps(),
    install,
    data,
    settings: updateSettingsSchema(process.platform).parse({ healthTimeoutSec: 20 }),
    trustedKeys: [key.publicKey],
    service,
    logger: createLogger({ sink: () => undefined }),
    nodeVersion: '24.21.0',
    now: () => new Date(clock.t),
    sleep: (ms) => {
      clock.t += ms;
      return Promise.resolve();
    },
    healthPollMs: 1000,
    ...(collect
      ? {
          collectDiagnostics: (input: { version: string; since: Date; restartErrors: readonly string[] }) => {
            events.push('collect');
            seen.push(input);
            const d: UpdateDiagnostics = {
              collectedBy: 'updater',
              verdict: 'never_started',
              bootLog: ['{"event":"start","version":"1.0.21"}'],
              redacted: true,
            };
            return Promise.resolve(d);
          },
        }
      : {}),
  });
  return { root, install, data, updater, events, seen };
}

async function stage(s: Awaited<ReturnType<typeof setup>>, version: string): Promise<string> {
  const r = signedRelease(key, version);
  const dir = join(s.data.stagedDir, version);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'remyral-worker.mjs'), r.artifact);
  await writeFile(join(dir, 'manifest.json'), r.manifest);
  await writeFile(join(dir, 'manifest.sig.json'), JSON.stringify(r.signature));
  const attemptId = randomUUID();
  await mkdir(s.data.updatesDir, { recursive: true });
  await writeFile(
    s.data.requestFile,
    JSON.stringify({
      schema: 1,
      attemptId,
      version,
      rollback: false,
      requestedAt: '2026-10-16T09:00:00.000Z',
    }),
  );
  return attemptId;
}

describe('privileged updater: evidence of a failed health check', () => {
  it('collects before switching back, records the restart error, writes last-diagnostics.json; last-result.json keeps its shape', async () => {
    const s = await setup(true);
    const v1 = signedRelease(key, '1.0.21');
    await s.updater.adopt({
      manifest: v1.manifest,
      signature: v1.signature,
      artifact: v1.artifact,
      allowDowngrade: false,
    });
    const attemptId = await stage(s, '1.0.22');
    const out = await s.updater.apply();
    expect(out).toMatchObject({
      kind: 'done',
      result: { outcome: 'rolled_back', reason: 'health_check_failed' },
    });
    // Evidence is collected after the failed start and BEFORE the restart into the previous version.
    expect(s.events).toEqual(['restart#1', 'collect', 'restart#2']);
    expect(s.seen[0]).toMatchObject({ version: '1.0.22' });
    expect(s.seen[0]?.restartErrors[0]).toContain('net.exe start RemyralWorker failed');
    const file = JSON.parse(await readFile(s.install.diagnosticsFile, 'utf8')) as Record<string, unknown>;
    expect(file).toMatchObject({
      schema: 1,
      attemptId,
      diagnostics: { verdict: 'never_started', collectedBy: 'updater' },
    });
    expect((file.diagnostics as UpdateDiagnostics).restartErrors?.[0]).toContain('starting or stopping');
    const result = JSON.parse(await readFile(s.install.resultFile, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(
      ['activeVersion', 'attemptId', 'detail', 'finishedAt', 'outcome', 'reason', 'schema', 'version'].sort(),
    );
  });

  it('without a collector nothing extra is written', async () => {
    const s = await setup(false);
    const v1 = signedRelease(key, '1.0.21');
    await s.updater.adopt({
      manifest: v1.manifest,
      signature: v1.signature,
      artifact: v1.artifact,
      allowDowngrade: false,
    });
    await stage(s, '1.0.22');
    await s.updater.apply();
    await expect(readFile(s.install.diagnosticsFile)).rejects.toThrow();
  });
});

describe('daemon: UPDATE_STATUS carries the evidence', () => {
  function agent(
    s: { install: ReturnType<typeof installLayout>; data: ReturnType<typeof dataLayout> },
    read?: (p: string) => string | null,
  ) {
    const sent: unknown[] = [];
    const a = new UpdateAgent({
      ops: nodeOps(),
      data: s.data,
      install: s.install,
      settings: updateSettingsSchema(process.platform).parse({}),
      currentVersion: '1.0.23',
      trustedKeys: [key.publicKey],
      download: () => Promise.reject(new Error('unused')),
      logger: createLogger({ sink: () => undefined }),
      redactor: new Redactor(),
      env: () => undefined,
      ...(read === undefined ? {} : { readTail: (p: string) => Promise.resolve(read(p)) }),
    });
    a.attach({
      send: (p) => {
        sent.push(p);
        return Promise.resolve();
      },
      runningJobs: () => 0,
      beginLocalDrain: () => undefined,
      endLocalDrain: () => undefined,
      updateStarted: () => true,
      updateFailed: () => undefined,
    });
    return { a, sent };
  }

  async function result(
    install: ReturnType<typeof installLayout>,
    attemptId: string,
    outcome = 'rolled_back',
  ) {
    await mkdir(install.stateDir, { recursive: true });
    await writeFile(
      install.resultFile,
      JSON.stringify({
        schema: 1,
        attemptId,
        version: '1.0.22',
        outcome,
        reason: outcome === 'succeeded' ? null : 'health_check_failed',
        detail: '1.0.22 did not connect and heartbeat within 90 s; 1.0.21 restored and healthy',
        activeVersion: '1.0.21',
        finishedAt: '2026-10-16T09:02:55.000Z',
      }),
    );
  }

  it("forwards the updater's diagnostics of the same attempt", async () => {
    const root = await tempDir('rw-updiag-');
    const install = installLayout(process.platform, join(root, 'opt'));
    const data = dataLayout(process.platform, join(root, 'data'));
    await mkdir(data.dataDir, { recursive: true });
    const attemptId = randomUUID();
    await result(install, attemptId);
    await writeFile(
      install.diagnosticsFile,
      JSON.stringify({
        schema: 1,
        attemptId,
        diagnostics: { collectedBy: 'updater', verdict: 'crashed', bootLog: ['x'], redacted: true },
      }),
    );
    const { a, sent } = agent({ install, data });
    await a.reportResult();
    expect(sent).toEqual([
      expect.objectContaining({
        attemptId,
        phase: 'rolled_back',
        diagnostics: { collectedBy: 'updater', verdict: 'crashed', bootLog: ['x'], redacted: true },
      }),
    ]);
  });

  it('next to an older updater (no / stale diagnostics file) collects the boot log itself; success carries none', async () => {
    const root = await tempDir('rw-updiag-');
    const install = installLayout(process.platform, join(root, 'opt'));
    const data = dataLayout(process.platform, join(root, 'data'));
    await mkdir(data.dataDir, { recursive: true });
    const attemptId = randomUUID();
    await result(install, attemptId);
    await writeFile(
      install.diagnosticsFile,
      JSON.stringify({
        schema: 1,
        attemptId: randomUUID(),
        diagnostics: { collectedBy: 'updater', verdict: 'crashed', redacted: true },
      }),
    );
    const boot = [
      JSON.stringify({ ts: '2026-10-16T09:01:04.000Z', event: 'start', version: '1.0.22' }),
      JSON.stringify({ ts: '2026-10-16T09:01:04.500Z', event: 'ready', version: '1.0.22' }),
    ].join('\n');
    const { a, sent } = agent({ install, data }, (p) => (p.endsWith('boot.log') ? boot : null));
    await a.reportResult();
    expect(sent[0]).toMatchObject({ attemptId, diagnostics: { collectedBy: 'worker', verdict: 'started' } });

    const ok2 = randomUUID();
    await result(install, ok2, 'succeeded');
    await a.reportResult();
    expect(sent[1]).toMatchObject({ attemptId: ok2, phase: 'succeeded' });
    expect((sent[1] as { diagnostics?: unknown }).diagnostics).toBeUndefined();
  });
});

const SC = (state: string) =>
  `SERVICE_NAME: RemyralWorker\n        TYPE               : 10  WIN32_OWN_PROCESS\n        STATE              : ${state}\n        WIN32_EXIT_CODE    : 0  (0x0)\n        SERVICE_EXIT_CODE  : 0  (0x0)\n        PID                : 0\n`;

describe('Windows service restart (updater)', () => {
  it('waits for STOPPED after `net stop` gave up (exit 2) before `net start`', async () => {
    const states = ['3  STOP_PENDING', '3  STOP_PENDING', '1  STOPPED'];
    const sys = new FakeSystem({
      platform: 'win32',
      exec: (file, args) => {
        if (file === 'net.exe' && args[0] === 'stop') return fail(2, 'The service could not be stopped.');
        if (file === 'net.exe' && args[0] === 'start')
          return ok('The RemyralWorker service was started successfully.');
        if (file === 'sc.exe' && args[0] === 'queryex') return ok(SC(states.shift() ?? '4  RUNNING'));
        if (file === 'sc.exe' && args[0] === 'qc') return ok('');
        return undefined;
      },
    });
    await osServiceControl(sys, WINDOWS_SERVICE, { sleep: () => Promise.resolve(), pollMs: 1 }).restart();
    const calls = sys.execCalls.map((c) => `${c.file} ${c.args[0] ?? ''}`).filter((c) => !c.endsWith(' qc'));
    expect(calls).toEqual([
      'net.exe stop',
      'sc.exe queryex',
      'sc.exe queryex',
      'sc.exe queryex',
      'net.exe start',
    ]);
  });

  it('refuses to start while still stopping after the wait, and retries a failed start once', async () => {
    const stuck = new FakeSystem({
      platform: 'win32',
      exec: (file, args) =>
        file === 'net.exe' ? fail(2, 'x') : args[0] === 'queryex' ? ok(SC('3  STOP_PENDING')) : ok(''),
    });
    await expect(
      osServiceControl(stuck, WINDOWS_SERVICE, {
        sleep: () => Promise.resolve(),
        pollMs: 1,
        stopWaitMs: 0,
      }).restart(),
    ).rejects.toThrow(/did not reach STOPPED/);
    expect(stuck.execCalls.some((c) => c.file === 'net.exe' && c.args[0] === 'start')).toBe(false);

    let starts = 0;
    const flaky = new FakeSystem({
      platform: 'win32',
      exec: (file, args) => {
        if (file === 'net.exe' && args[0] === 'stop') return ok('stopped');
        if (file === 'net.exe' && args[0] === 'start')
          return ++starts === 1 ? fail(2, 'The service is starting or stopping.') : ok('started');
        return args[0] === 'queryex' ? ok(SC('1  STOPPED')) : ok('');
      },
    });
    await osServiceControl(flaky, WINDOWS_SERVICE, { sleep: () => Promise.resolve(), pollMs: 1 }).restart();
    expect(starts).toBe(2);

    const broken = new FakeSystem({
      platform: 'win32',
      exec: (file, args) =>
        file === 'net.exe' && args[0] === 'start'
          ? fail(2, 'System error 1053 has occurred.')
          : args[0] === 'queryex'
            ? ok(SC('1  STOPPED'))
            : ok(''),
    });
    await expect(
      osServiceControl(broken, WINDOWS_SERVICE, { sleep: () => Promise.resolve(), pollMs: 1 }).restart(),
    ).rejects.toThrow(/System error 1053.*retry: .*System error 1053/);
  });
});
