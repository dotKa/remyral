// p17-worker-managed Part 2 — the worker's local settings managed from the panel: what is laid over the local file at
// start (pins, the minVersion floor, telemetry only without a local one, runtime paths only with machine admin and
// valid paths), what is reported (values in effect, pins, pending restarts), the live log level, and the narrowing-only
// overlay of the privileged updater. Linux, macOS and Windows path shapes.
import { createLogger } from '@remyral/observability';
import {
  type WorkerConfigDelivery,
  type WorkerConfigDocument,
  workerConfigHash,
  workerConfigIssues,
  WorkerConfigReport,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { deriveCeiling } from '../src/config/ceiling.js';
import { type WorkerConfig, updateSettingsSchema, workerConfigSchema } from '../src/config/schema.js';
import { ManagedConfig } from '../src/managed-config/index.js';
import {
  changedSettingPaths,
  type PathStat,
  settingsOf,
  settingsPlan,
  verifyRuntimePaths,
  withSettings,
} from '../src/managed-config/settings.js';
import { readPanelUpdates, updaterPanelOverlay } from '../src/update/helper/config.js';
import { nodeOps, tempDir } from './helpers.js';

const logger = createLogger({ level: 'silent', sink: () => undefined });

function configFrom(
  raw: Record<string, unknown>,
  platform: NodeJS.Platform = 'linux',
  dirs: { workspaceRoot?: string; dataDir?: string } = {},
): WorkerConfig {
  const workspaceRoot = dirs.workspaceRoot ?? (platform === 'win32' ? 'C:\\RemyralWork' : '/srv/work');
  const parsed = workerConfigSchema(platform).parse({
    masterUrl: 'wss://m.example.com/v1/worker',
    workspaceRoot,
    ...raw,
  });
  const { dataDir: _d, $schema: _s, ...rest } = parsed;
  const base = {
    ...rest,
    dataDir: dirs.dataDir ?? (platform === 'win32' ? 'C:\\ProgramData\\RemyralWorker\\data' : '/var/lib/rw'),
    source: '/etc/remyral-worker/config.json',
  };
  return { ...base, ...deriveCeiling({ workspaceRoot, ...raw }, base) };
}

const BASE_DOC: WorkerConfigDocument = {
  schemaVersion: 1,
  projects: {},
  allowedRuntimes: ['pi', 'codex'],
  maxParallelJobs: 2,
  sandboxProfiles: ['container'],
  workspace: {},
  labels: {},
  runtimes: {},
};

function delivery(generation: number, doc: WorkerConfigDocument): WorkerConfigDelivery {
  return {
    generation,
    documentHash: workerConfigHash(doc),
    issuedAt: '2026-10-27T10:00:00.000Z',
    document: doc,
  };
}

const linux = { machineAdmin: false, platform: 'linux' as const };

describe('settings laid over the local file', () => {
  it('takes the panel values for keys the local file does not write', () => {
    const file = configFrom({});
    const plan = settingsPlan(
      file,
      {
        updates: { enabled: false, channel: 'canary', healthTimeoutSec: 300 },
        logLevel: 'debug',
        telemetry: { otlpEndpoint: 'https://otel.example.com/v1' },
        assistant: { maxSessions: 3, sandbox: 'required' },
        remoteOps: { npmRegistry: 'https://npm.example.com/', logFileBytes: 1024 * 1024 },
        packageCaches: { enabled: false },
        probes: { loginRecheckMinutes: 0, usageProbeMinutes: 5 },
      },
      linux,
    );
    expect(plan.blocked).toEqual([]);
    expect(plan.values.updates).toMatchObject({ enabled: false, channel: 'canary', healthTimeoutSec: 300 });
    const c = withSettings(file, plan.values);
    expect(c.logLevel).toBe('debug');
    expect(c.updates).toMatchObject({
      enabled: false,
      channel: 'canary',
      healthTimeoutSec: 300,
      catalog: true,
    });
    expect(c.telemetry).toEqual({ otlpEndpoint: 'https://otel.example.com/v1' });
    expect(c.assistant).toEqual({ disabled: false, maxSessions: 3, sandbox: 'required' });
    expect(c.remoteOps).toMatchObject({ npmRegistry: 'https://npm.example.com/', logFileBytes: 1024 * 1024 });
    expect(c.packageCaches).toMatchObject({ enabled: false });
    expect(c.loginRecheckMinutes).toBe(0);
    expect(c.usageProbeMinutes).toBe(5);
    expect(changedSettingPaths(plan.values, settingsOf(file))).toEqual(
      expect.arrayContaining(['updates.enabled', 'logLevel', 'telemetry', 'probes.usageProbeMinutes']),
    );
  });

  it('a key the local file writes pins it: the panel value is blocked, the local one stays', () => {
    const file = configFrom({
      logLevel: 'warn',
      updates: { channel: 'stable' },
      assistant: { disabled: true },
      remoteOps: { disabled: ['restart'] },
      loginRecheckMinutes: 30,
    });
    expect(file.pins?.settings).toEqual(
      expect.arrayContaining([
        'logLevel',
        'updates.channel',
        'assistant.disabled',
        'probes.loginRecheckMinutes',
      ]),
    );
    const plan = settingsPlan(
      file,
      {
        logLevel: 'debug',
        updates: { channel: 'canary' },
        assistant: { disabled: false },
        probes: { loginRecheckMinutes: 5 },
      },
      linux,
    );
    expect(plan.values.logLevel).toBe('warn');
    expect(plan.values.updates.channel).toBe('stable');
    // The machine owner's assistant veto stays.
    expect(plan.values.assistant.disabled).toBe(true);
    expect(plan.values.probes.loginRecheckMinutes).toBe(30);
    expect(plan.blocked.map((b) => b.path).sort()).toEqual([
      'settings.assistant.disabled',
      'settings.logLevel',
      'settings.probes.loginRecheckMinutes',
      'settings.updates.channel',
    ]);
    expect(plan.blocked.every((b) => b.code === 'blocked_by_local_ceiling')).toBe(true);
    // The local remote-ops veto is not a panel setting at all.
    expect(withSettings(file, plan.values).remoteOps.disabled).toEqual(['restart']);
  });

  it('minVersion is a floor: the panel may raise it, never lower it', () => {
    const file = configFrom({ updates: { minVersion: '1.1.0' } });
    expect(settingsPlan(file, { updates: { minVersion: '1.2.0' } }, linux).values.updates.minVersion).toBe(
      '1.2.0',
    );
    const low = settingsPlan(file, { updates: { minVersion: '1.0.0' } }, linux);
    expect(low.values.updates.minVersion).toBe('1.1.0');
    expect(low.blocked[0]).toMatchObject({
      path: 'settings.updates.minVersion',
      code: 'blocked_by_local_ceiling',
    });
  });

  it('telemetry from the panel only without a local telemetry section (its headers never reach another endpoint)', () => {
    const local = configFrom({
      telemetry: { otlpEndpoint: 'https://local.example.com', otlpHeadersFile: '/etc/remyral-worker/otlp' },
    });
    const plan = settingsPlan(local, { telemetry: { otlpEndpoint: 'https://evil.example.com' } }, linux);
    expect(plan.blocked[0]).toMatchObject({ path: 'settings.telemetry' });
    expect(withSettings(local, plan.values).telemetry).toEqual({
      otlpEndpoint: 'https://local.example.com',
      otlpHeadersFile: '/etc/remyral-worker/otlp',
    });
    const off = configFrom({});
    expect(
      withSettings(off, settingsPlan(off, { telemetry: { otlpEndpoint: null } }, linux).values).telemetry,
    ).toBe(undefined);
  });

  it('runtime paths need machine administration in effect', () => {
    const file = configFrom({});
    const want = { runtimePaths: { codex: { binary: '/usr/local/bin/codex' } } };
    const off = settingsPlan(file, want, linux);
    expect(off.values.runtimePaths.codex).toBeUndefined();
    expect(off.blocked[0]).toMatchObject({ path: 'settings.runtimePaths.codex', code: 'invalid_value' });
    const on = settingsPlan(file, want, { ...linux, machineAdmin: true });
    expect(on.values.runtimePaths.codex).toEqual({ binary: '/usr/local/bin/codex' });
    expect(withSettings(file, on.values).runtimes.codex?.binary).toBe('/usr/local/bin/codex');
  });

  it.each([
    ['linux', '/srv/work/jobs/x/codex', 'inside the workspace root'],
    ['linux', '/usr/local/bin/node', 'not the codex executable'],
    ['linux', 'C:\\tools\\codex.exe', 'not an absolute path'],
    ['darwin', '/opt/homebrew/bin/../bin/codex', 'must not contain ..'],
    ['win32', '/usr/bin/codex', 'not an absolute path'],
    ['win32', 'C:\\RemyralWork\\codex.exe', 'inside the workspace root'],
  ] as const)('%s refuses %s (%s)', (platform, path, why) => {
    const file = configFrom({}, platform);
    const plan = settingsPlan(
      file,
      { runtimePaths: { codex: { binary: path } } },
      { machineAdmin: true, platform },
    );
    expect(plan.values.runtimePaths.codex).toBeUndefined();
    expect(plan.blocked[0]?.detail).toContain(why);
  });

  it('accepts a Windows executable with its extension and Pi extension files', () => {
    const file = configFrom({}, 'win32');
    const plan = settingsPlan(
      file,
      {
        runtimePaths: {
          codex: { binary: 'C:\\Program Files\\Codex\\codex.exe' },
          pi: { binary: 'C:\\tools\\pi.cmd', extensions: ['C:\\hooks\\gate.mjs'] },
        },
      },
      { machineAdmin: true, platform: 'win32' },
    );
    expect(plan.blocked).toEqual([]);
    expect(plan.values.runtimePaths.pi).toEqual({
      binary: 'C:\\tools\\pi.cmd',
      extensions: ['C:\\hooks\\gate.mjs'],
    });
  });

  it('a locally written runtime binary pins it', () => {
    const file = configFrom({ runtimes: { codex: { binary: '/opt/codex/codex' } } });
    const plan = settingsPlan(
      file,
      { runtimePaths: { codex: { binary: '/usr/local/bin/codex' } } },
      { ...linux, machineAdmin: true },
    );
    expect(plan.values.runtimePaths.codex?.binary).toBe('/opt/codex/codex');
    expect(plan.blocked[0]).toMatchObject({
      path: 'settings.runtimePaths.codex.binary',
      code: 'blocked_by_local_ceiling',
    });
  });

  it('documents with impossible runtime paths are inconsistent (master and worker refuse them alike)', () => {
    const doc: WorkerConfigDocument = {
      ...BASE_DOC,
      settings: { runtimePaths: { codex: { binary: '/bin/sh' }, opencode: { extensions: ['/x.js'] } } },
    };
    expect(
      workerConfigIssues(doc)
        .map((i) => i.code)
        .sort(),
    ).toEqual(['extensions_pi_only', 'not_the_runtime_executable']);
  });
});

describe('start-time check of runtime paths', () => {
  const files: Record<string, { isFile: boolean; mode: number }> = {
    '/usr/local/bin/codex': { isFile: true, mode: 0o100755 },
    '/home/u/bin/pi': { isFile: true, mode: 0o100775 },
    '/opt/pi': { isFile: false, mode: 0o40755 },
    'C:\\tools\\codex.exe': { isFile: true, mode: 0o100666 },
  };
  const fakeStat: PathStat = (p) => Promise.resolve(files[p] ?? null);

  it('keeps an existing regular file; drops a missing, group-writable or non-file path (POSIX)', async () => {
    const file = configFrom({});
    const plan = settingsPlan(
      file,
      {
        runtimePaths: {
          codex: { binary: '/usr/local/bin/codex' },
          pi: { binary: '/home/u/bin/pi' },
          opencode: { binary: '/nope/opencode' },
        },
      },
      { ...linux, machineAdmin: true },
    );
    const v = await verifyRuntimePaths(file, plan, 'linux', fakeStat);
    expect(v.values.runtimePaths).toEqual({ codex: { binary: '/usr/local/bin/codex' } });
    expect(v.blocked.map((b) => b.detail)).toEqual([
      '/home/u/bin/pi is writable by group or others',
      '/nope/opencode does not exist',
    ]);
  });

  it('on Windows the mode bits are not a signal (ACLs decide)', async () => {
    const file = configFrom({}, 'win32');
    const plan = settingsPlan(
      file,
      { runtimePaths: { codex: { binary: 'C:\\tools\\codex.exe' } } },
      { machineAdmin: true, platform: 'win32' },
    );
    const v = await verifyRuntimePaths(file, plan, 'win32', fakeStat);
    expect(v.blocked).toEqual([]);
    expect(v.values.runtimePaths.codex?.binary).toBe('C:\\tools\\codex.exe');
  });
});

describe('reported settings', () => {
  it('values in effect since the start, pins, pending restarts; the log level applies live', async () => {
    const dataDir = await tempDir();
    const file = configFrom({ logLevel: 'info', updates: { healthTimeoutSec: 120 } }, process.platform, {
      dataDir,
    });
    const boot = settingsOf(file);
    const { managed } = await ManagedConfig.open(
      nodeOps(),
      file,
      () => ({ keys: [], pinned: false }),
      logger,
      () => new Date('2026-10-27T10:00:00.000Z'),
      { file, boot, bootBlocked: [], platform: process.platform },
    );
    const doc: WorkerConfigDocument = {
      ...BASE_DOC,
      settings: { logLevel: 'debug', updates: { enabled: false, healthTimeoutSec: 300 } },
    };
    const r = await managed.apply('wrk_1', delivery(1, doc));
    expect(r.status.outcome).toBe('applied');
    const report = WorkerConfigReport.parse(managed.report());
    expect(report.effective.settings?.values.updates).toMatchObject({ enabled: true, healthTimeoutSec: 120 });
    expect(report.effective.settings?.pinned).toEqual(['updates.healthTimeoutSec', 'logLevel']);
    expect(report.effective.settings?.pendingRestart).toEqual(['updates.enabled']);
    expect(report.blocked.map((b) => b.path)).toEqual(
      expect.arrayContaining(['settings.updates.healthTimeoutSec', 'settings.logLevel']),
    );
  });

  it('marks a live log level as in effect', async () => {
    const dataDir = await tempDir();
    const file = configFrom({}, process.platform, { dataDir });
    const { managed } = await ManagedConfig.open(
      nodeOps(),
      file,
      () => ({ keys: [], pinned: false }),
      logger,
      undefined,
      { file, boot: settingsOf(file), bootBlocked: [], platform: process.platform },
    );
    await managed.apply('wrk_1', delivery(1, { ...BASE_DOC, settings: { logLevel: 'debug' } }));
    expect(managed.desiredSettings()?.values.logLevel).toBe('debug');
    managed.markLive({ logLevel: 'debug' });
    const report = managed.report();
    expect(report.effective.settings?.values.logLevel).toBe('debug');
    expect(report.effective.settings?.pendingRestart).toEqual([]);
  });

  it('the shared logger changes level for its children', () => {
    const lines: string[] = [];
    const root = createLogger({ level: 'info', sink: (l) => lines.push(l) });
    const child = root.child({ component: 'x' });
    child.debug('hidden');
    root.setLevel?.('debug');
    child.debug('shown');
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['shown']);
  });
});

describe('the privileged updater takes the panel updates.* only in the narrowing direction', () => {
  const settings = (o: Record<string, unknown> = {}) => updateSettingsSchema('linux').parse(o);

  it('turns updates off, raises the floor, never the reverse', () => {
    const off = updaterPanelOverlay({}, settings(), { enabled: false, minVersion: '1.2.0' });
    expect(off.settings).toMatchObject({ enabled: false, minVersion: '1.2.0' });
    expect(off.applied).toEqual(['enabled', 'minVersion']);
    const on = updaterPanelOverlay(
      { enabled: false, minVersion: '1.3.0' },
      settings({ enabled: false, minVersion: '1.3.0' }),
      {
        enabled: true,
        minVersion: '1.0.0',
      },
    );
    expect(on.settings).toMatchObject({ enabled: false, minVersion: '1.3.0' });
    expect(on.applied).toEqual([]);
  });

  it('channel and health timeout only where the root-owned file does not write them', () => {
    const free = updaterPanelOverlay({}, settings(), { channel: 'canary', healthTimeoutSec: 300 });
    expect(free.settings).toMatchObject({ channel: 'canary', healthTimeoutSec: 300 });
    const written = updaterPanelOverlay(
      { channel: 'stable', healthTimeoutSec: 90 },
      settings({ channel: 'stable', healthTimeoutSec: 90 }),
      { channel: 'canary', healthTimeoutSec: 300 },
    );
    expect(written.settings).toMatchObject({ channel: 'stable', healthTimeoutSec: 90 });
  });

  it('reads the stored document only when its hash verifies', async () => {
    const doc: WorkerConfigDocument = { ...BASE_DOC, settings: { updates: { enabled: false } } };
    const good = delivery(1, doc);
    const file = (d: WorkerConfigDelivery) =>
      Buffer.from(
        JSON.stringify({
          schema: 1,
          applied: { appliedAt: '2026-10-27T10:00:00.000Z', delivery: d },
          lastRejection: null,
        }),
      );
    expect(await readPanelUpdates('/d', () => Promise.resolve(file(good)))).toEqual({ enabled: false });
    expect(
      await readPanelUpdates('/d', () => Promise.resolve(file({ ...good, documentHash: 'f'.repeat(64) }))),
    ).toBeNull();
    expect(await readPanelUpdates('/d', () => Promise.resolve(Buffer.from('{not json')))).toBeNull();
    expect(await readPanelUpdates('/d', () => Promise.reject(new Error('is a symbolic link')))).toBeNull();
  });
});
