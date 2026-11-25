// p22-sandbox-settings — the Linux host-sandbox switches (`sandbox.linuxLoginStoreView`, `sandbox.linuxPrivateNetwork`)
// managed from the panel: laid over the local file at start, pinned by a locally written key, reported, and waiting
// for a restart when changed.
import { WorkerSettings } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { deriveCeiling } from '../src/config/ceiling.js';
import { type WorkerConfig, workerConfigSchema } from '../src/config/schema.js';
import {
  changedSettingPaths,
  settingsOf,
  settingsPlan,
  withSettings,
} from '../src/managed-config/settings.js';

const linux = { machineAdmin: false, platform: 'linux' as const };

function configFrom(raw: Record<string, unknown>): WorkerConfig {
  const workspaceRoot = '/srv/work';
  const parsed = workerConfigSchema('linux').parse({
    masterUrl: 'wss://m.example.com/v1/worker',
    workspaceRoot,
    ...raw,
  });
  const { dataDir: _d, $schema: _s, ...rest } = parsed;
  const base = { ...rest, dataDir: '/var/lib/rw', source: '/etc/remyral-worker/config.json' };
  return { ...base, ...deriveCeiling({ workspaceRoot, ...raw }, base) };
}

describe('p22-sandbox-settings', () => {
  it('the panel turns the switches on for a machine whose local file does not write them', () => {
    const file = configFrom({ sandbox: { keepHome: true } });
    expect(settingsOf(file).sandbox).toEqual({ linuxLoginStoreView: false, linuxPrivateNetwork: 'off' });
    const plan = settingsPlan(
      file,
      { sandbox: { linuxLoginStoreView: true, linuxPrivateNetwork: 'auto' } },
      linux,
    );
    expect(plan.blocked).toEqual([]);
    const c = withSettings(file, plan.values);
    expect(c.sandbox.linuxLoginStoreView).toBe(true);
    expect(c.sandbox.linuxPrivateNetwork).toBe('auto');
    // Everything else of the local sandbox section stays as written.
    expect(c.sandbox.keepHome).toBe(true);
    expect(c.sandbox.linuxHostIsolation).toBe('auto');
    expect(changedSettingPaths(plan.values, settingsOf(file))).toEqual([
      'sandbox.linuxLoginStoreView',
      'sandbox.linuxPrivateNetwork',
    ]);
  });

  it('a locally written key pins it (the machine owner keeps the last word)', () => {
    const file = configFrom({ sandbox: { linuxLoginStoreView: false } });
    expect(file.pins?.settings).toContain('sandbox.linuxLoginStoreView');
    expect(file.pins?.settings).not.toContain('sandbox.linuxPrivateNetwork');
    const plan = settingsPlan(
      file,
      { sandbox: { linuxLoginStoreView: true, linuxPrivateNetwork: 'auto' } },
      linux,
    );
    expect(plan.values.sandbox).toEqual({ linuxLoginStoreView: false, linuxPrivateNetwork: 'auto' });
    expect(plan.blocked).toEqual([
      expect.objectContaining({
        path: 'settings.sandbox.linuxLoginStoreView',
        code: 'blocked_by_local_ceiling',
      }),
    ]);
  });

  it('no panel value keeps the local one; an equal pinned value is not reported blocked', () => {
    const file = configFrom({ sandbox: { linuxPrivateNetwork: 'auto' } });
    expect(settingsPlan(file, { logLevel: 'info' }, linux).values.sandbox.linuxPrivateNetwork).toBe('auto');
    const same = settingsPlan(file, { sandbox: { linuxPrivateNetwork: 'auto' } }, linux);
    expect(same.blocked).toEqual([]);
  });

  it('the protocol keeps the group (an older schema would strip it and fail the document hash)', () => {
    const parsed = WorkerSettings.parse({ sandbox: { linuxLoginStoreView: true } });
    expect(parsed.sandbox).toEqual({ linuxLoginStoreView: true });
    expect(WorkerSettings.safeParse({ sandbox: { linuxPrivateNetwork: 'on' } }).success).toBe(false);
  });
});
