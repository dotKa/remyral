import { describe, expect, it } from 'vitest';
import {
  AppliedWorkerSettings,
  manualUninstallCommands,
  OpsCommandPayload,
  OpsUpdatePayload,
  rootlessDockerPrompt,
  executableBaseName,
  PanelAbsolutePath,
  sameRuntimePaths,
  WORKER_MANAGED_FEATURE,
  WORKER_SETTING_PATHS,
  WorkerConfigDocument,
  WorkerFeature,
  WorkerFeatureList,
  WorkerSettings,
  workerSettingsIssues,
} from '../src/index.js';

describe('p17-worker-managed: panel-managed local settings', () => {
  it('the feature is known (master first: a closed enum) and the list has room', () => {
    expect(WorkerFeature.safeParse(WORKER_MANAGED_FEATURE).success).toBe(true);
    expect(WorkerFeatureList.safeParse(WorkerFeature.options).success).toBe(true);
  });

  it('accepts the managed keys and refuses what stays local or out of bounds', () => {
    expect(
      WorkerSettings.safeParse({
        updates: { enabled: false, channel: 'canary', minVersion: '1.1.3', healthTimeoutSec: 120 },
        logLevel: 'debug',
        telemetry: { otlpEndpoint: null },
        assistant: { disabled: true, maxSessions: 4, sandbox: 'required' },
        remoteOps: { npmRegistry: 'https://npm.example.com/', restartable: true, logFileBytes: 1024 * 1024 },
        packageCaches: { enabled: false },
        probes: { loginRecheckMinutes: 0, usageProbeMinutes: 0, claudeLockMaxAgeMinutes: 30 },
      }).success,
    ).toBe(true);
    // The assistant's host-native mode is a local-only choice.
    expect(WorkerSettings.safeParse({ assistant: { sandbox: 'off' } }).success).toBe(false);
    expect(WorkerSettings.safeParse({ updates: { healthTimeoutSec: 5 } }).success).toBe(false);
    expect(WorkerSettings.safeParse({ probes: { usageProbeMinutes: 1 } }).success).toBe(false);
    expect(
      WorkerSettings.safeParse({ telemetry: { otlpEndpoint: 'http://plain.example.com' } }).success,
    ).toBe(false);
    expect(
      WorkerSettings.safeParse({ telemetry: { otlpEndpoint: 'https://u:p@otel.example.com' } }).success,
    ).toBe(false);
    // Release / catalog keys and the install dir never travel here (stripped: unknown keys of a z.object).
    const parsed = WorkerSettings.parse({ updates: { releaseKeys: ['x'], installDir: '/tmp' } });
    expect(parsed.updates).toEqual({});
  });

  it('runtime paths are absolute on either OS, without .. or control characters', () => {
    for (const ok of ['/usr/local/bin/codex', 'C:\\Program Files\\Codex\\codex.exe', 'D:/tools/pi.cmd']) {
      expect(PanelAbsolutePath.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of [
      'codex',
      './codex',
      '/opt/../bin/codex',
      '\\\\server\\share\\codex.exe',
      '/bin/co\ndex',
    ]) {
      expect(PanelAbsolutePath.safeParse(bad).success, bad).toBe(false);
    }
    expect(executableBaseName('C:\\x\\Codex.EXE')).toBe('codex');
    expect(executableBaseName('/usr/bin/claude')).toBe('claude');
  });

  it('a runtime path must name the runtime; extensions are Pi-only script files', () => {
    expect(
      workerSettingsIssues({
        runtimePaths: {
          codex: { binary: '/bin/sh' },
          'claude-code': { binary: '/usr/local/bin/claude' },
          pi: { binary: '/opt/pi/pi', extensions: ['/etc/pi/gate.mjs', '/etc/pi/evil.sh'] },
          opencode: { extensions: ['/x.js'] },
        },
      }),
    ).toEqual([
      { path: 'settings.runtimePaths.codex.binary', code: 'not_the_runtime_executable' },
      { path: 'settings.runtimePaths.pi.extensions.1', code: 'not_an_extension' },
      { path: 'settings.runtimePaths.opencode.extensions', code: 'extensions_pi_only' },
    ]);
  });

  it('compares runtime paths ignoring empty entries and key order', () => {
    expect(
      sameRuntimePaths(
        { runtimePaths: { codex: { binary: '/a/codex' }, pi: {} } },
        { logLevel: 'info', runtimePaths: { codex: { binary: '/a/codex' } } },
      ),
    ).toBe(true);
    expect(sameRuntimePaths(undefined, { runtimePaths: { codex: { binary: '/a/codex' } } })).toBe(false);
  });

  it('the document carries settings; the report carries values, pins and pending restarts', () => {
    const doc = WorkerConfigDocument.parse({
      schemaVersion: 1,
      projects: {},
      allowedRuntimes: [],
      maxParallelJobs: 1,
      sandboxProfiles: [],
      workspace: {},
      labels: {},
      runtimes: {},
      settings: { logLevel: 'warn' },
    });
    expect(doc.settings).toEqual({ logLevel: 'warn' });
    expect(
      AppliedWorkerSettings.safeParse({
        values: { logLevel: 'warn', updates: { enabled: true, channel: 'stable', healthTimeoutSec: 90 } },
        pinned: ['updates.channel'],
        pendingRestart: ['logLevel'],
      }).success,
    ).toBe(true);
    expect(WORKER_SETTING_PATHS).toContain('runtimePaths.pi.extensions');
  });
});

describe('p17-worker-managed: removal and helper management ops', () => {
  const base = {
    commandId: '00000000-0000-4000-8000-000000000001',
    issuedAt: '2026-10-27T10:00:00.000Z',
    expiresAt: '2026-10-27T10:02:00.000Z',
  };

  it('worker.uninstall carries only purge; helper.manage only a closed action', () => {
    expect(
      OpsCommandPayload.safeParse({ ...base, op: { kind: 'worker.uninstall', purge: true } }).success,
    ).toBe(true);
    expect(OpsCommandPayload.safeParse({ ...base, op: { kind: 'worker.uninstall' } }).success).toBe(false);
    expect(
      OpsCommandPayload.safeParse({ ...base, op: { kind: 'helper.manage', action: 'admin_helper.install' } })
        .success,
    ).toBe(true);
    expect(
      OpsCommandPayload.safeParse({ ...base, op: { kind: 'helper.manage', action: 'rm -rf /' } }).success,
    ).toBe(false);
    // Unknown keys (a path, a command) are stripped, never carried to the helper.
    const parsed = OpsCommandPayload.parse({
      ...base,
      op: { kind: 'worker.uninstall', purge: false, path: '/etc' },
    });
    expect(parsed.op).toEqual({ kind: 'worker.uninstall', purge: false });
  });

  it('OPS_UPDATE carries the helper steps', () => {
    expect(
      OpsUpdatePayload.safeParse({
        commandId: base.commandId,
        seq: 2,
        kind: 'worker.uninstall',
        state: 'succeeded',
        manage: {
          steps: [
            { id: 'helper_request', state: 'done' },
            { id: 'data_purge', state: 'pending' },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it('manual uninstall commands per OS, with purge', () => {
    expect(manualUninstallCommands('linux', true)[0]).toContain('sudo ./uninstall.sh --purge');
    expect(manualUninstallCommands('win32', false)[0]).toContain('uninstall.ps1');
    expect(manualUninstallCommands('win32', true)[0]).toContain('-Purge');
    expect(manualUninstallCommands(null, false)).toHaveLength(2);
  });

  it('the rootless Docker task follows Docker’s guide and never touches the worker unit', () => {
    const p = rootlessDockerPrompt('remyral-worker');
    expect(p).toContain('docker-ce-rootless-extras');
    expect(p).toContain('dockerd-rootless-setuptool.sh install');
    expect(p).toContain('loginctl enable-linger remyral-worker');
    expect(p).toContain('Do not change the remyral-worker service unit');
  });
});
