import { MachineAdminReport } from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { machineAdminFinding } from '../src/doctor/doctor.js';
import {
  adminHelperAvailable,
  type HelperProbeDeps,
  machineAdminReport,
  probeAdminHelper,
  resetHelperProbeCache,
} from '../src/machine-admin/report.js';
import { ADMIN_BINDING_MARKER } from '../src/machine-admin/binding.js';
import { ADMIN_HELPER_MARKER } from '../src/machine-admin/shared.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

/**
 * p17-worker-1-1-1: the root/SYSTEM helper readiness probe (fakes per OS; real-OS behaviour of `schtasks /Query` by
 * the Windows service account is UNVERIFIED).
 */

type Exec = HelperProbeDeps['exec'];

function host(
  platform: NodeJS.Platform,
  installDir: string | undefined,
  o: {
    files?: Record<string, string>;
    paths?: string[];
    closed?: string[];
    exec?: Exec;
  } = {},
): HelperProbeDeps & { calls: string[] } {
  const files = o.files ?? {};
  const paths = new Set([...(o.paths ?? []), ...Object.keys(files)]);
  const calls: string[] = [];
  return {
    calls,
    platform,
    installDir,
    fileKey: (p) => Promise.resolve(p in files ? `${String(files[p]?.length ?? 0)}:1` : null),
    readText: (p) => Promise.resolve(files[p] ?? ''),
    exists: (p) => Promise.resolve(paths.has(p)),
    traversable: (p) => Promise.resolve(!(o.closed ?? []).includes(p)),
    exec: (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      return (o.exec ?? (() => Promise.resolve({ code: 0, stdout: '', stderr: '' })))(file, args);
    },
    env: () => undefined,
  };
}

const HELPER = `// updater\n${ADMIN_HELPER_MARKER}\n`;

afterEach(() => {
  resetHelperProbeCache();
});

// Simulates a Linux host (POSIX paths in the commands).
describePosix('Linux', () => {
  const install = '/opt/remyral-worker';
  const ready = {
    files: { [`${install}/remyral-worker-updater.mjs`]: HELPER },
    paths: [
      '/etc/systemd/system/remyral-worker-admin.path',
      '/etc/systemd/system/multi-user.target.wants/remyral-worker-admin.path',
      `${install}/state`,
      `${install}/state/machine-admin`,
    ],
  };

  it('available: marker, unit installed and enabled (symlink), answer dir traversable — no process started', async () => {
    const h = host('linux', install, ready);
    expect(await probeAdminHelper(h)).toEqual({ available: 'available' });
    expect(h.calls).toEqual([]);
  });

  it('a binding-aware helper: unbound and bound to another worker are definite findings with the command', async () => {
    const bindingHelper = { [`${install}/remyral-worker-updater.mjs`]: `${HELPER}${ADMIN_BINDING_MARKER}\n` };
    const at = (bound: string | null, workerId: string | null = 'wrk_a') => ({
      ...host('linux', install, { ...ready, files: bindingHelper }),
      workerId,
      nodePath: '/usr/bin/node',
      boundWorkerId: () => Promise.resolve(bound),
    });
    expect(await probeAdminHelper(at(null))).toEqual({
      available: 'missing',
      reason: 'helper_not_bound',
      detail: 'sudo "/usr/bin/node" "/opt/remyral-worker/remyral-worker-updater.mjs" admin-bind',
    });
    expect(await probeAdminHelper(at('wrk_b'))).toMatchObject({
      available: 'missing',
      reason: 'helper_bound_elsewhere',
      detail: expect.stringMatching(/admin-bind --replace$/) as string,
    });
    expect(await probeAdminHelper(at('wrk_a'))).toEqual({ available: 'available' });
    // Older helpers (no binding marker) are not asked for a binding: no change for installs not yet re-run.
    expect(
      await probeAdminHelper({
        ...host('linux', install, ready),
        boundWorkerId: () => Promise.resolve(null),
      }),
    ).toEqual({ available: 'available' });
  });

  it('the 0750 answer dir of the 1.1.0 helper is a definite finding', async () => {
    const h = host('linux', install, { ...ready, closed: [`${install}/state/machine-admin`] });
    expect(await probeAdminHelper(h)).toMatchObject({
      available: 'missing',
      reason: 'state_dir_not_traversable',
    });
  });

  it('no answer dir yet: `state` itself must be traversable; neither: fine', async () => {
    const paths = ready.paths.filter((p) => !p.endsWith('/machine-admin'));
    expect(await probeAdminHelper(host('linux', install, { ...ready, paths }))).toEqual({
      available: 'available',
    });
    expect(
      await probeAdminHelper(host('linux', install, { ...ready, paths, closed: [`${install}/state`] })),
    ).toMatchObject({ reason: 'state_dir_not_traversable' });
  });

  it('no wants symlink: asks `systemctl is-enabled` (no root needed)', async () => {
    const paths = ready.paths.filter((p) => !p.includes('multi-user.target.wants'));
    const enabled = host('linux', install, {
      ...ready,
      paths,
      exec: () => Promise.resolve({ code: 0, stdout: 'enabled\n', stderr: '' }),
    });
    expect(await probeAdminHelper(enabled)).toEqual({ available: 'available' });
    expect(enabled.calls).toEqual(['systemctl is-enabled remyral-worker-admin.path']);
    const disabled = host('linux', install, {
      ...ready,
      paths,
      exec: () => Promise.resolve({ code: 1, stdout: 'disabled\n', stderr: '' }),
    });
    expect(await probeAdminHelper(disabled)).toMatchObject({
      available: 'missing',
      reason: 'admin_unit_disabled',
    });
    const noSystemctl = host('linux', install, {
      ...ready,
      paths,
      exec: () => Promise.resolve({ code: null, stdout: '', stderr: '' }),
    });
    expect(await probeAdminHelper(noSystemctl)).toMatchObject({
      available: 'unknown',
      reason: 'probe_failed',
    });
  });

  it('unit missing, helper outdated, no helper, unknown install dir', async () => {
    expect(await probeAdminHelper(host('linux', install, { files: ready.files, paths: [] }))).toMatchObject({
      available: 'missing',
      reason: 'admin_unit_missing',
    });
    expect(
      await probeAdminHelper(
        host('linux', install, { ...ready, files: { [`${install}/remyral-worker-updater.mjs`]: '// old' } }),
      ),
    ).toMatchObject({ available: 'missing', reason: 'helper_outdated' });
    expect(await probeAdminHelper(host('linux', install, { paths: ready.paths }))).toMatchObject({
      available: 'missing',
      reason: 'helper_missing',
    });
    expect(await probeAdminHelper(host('linux', undefined))).toMatchObject({
      available: 'unknown',
      reason: 'install_dir_unknown',
    });
  });
});

describe('macOS', () => {
  const install = '/Library/Application Support/RemyralWorker/bin';
  const files = { [`${install}/remyral-worker-updater.mjs`]: HELPER };

  it('available with the LaunchDaemon plist; missing without it', async () => {
    expect(
      await probeAdminHelper(
        host('darwin', install, { files, paths: ['/Library/LaunchDaemons/com.remyral.worker.admin.plist'] }),
      ),
    ).toEqual({ available: 'available' });
    expect(await probeAdminHelper(host('darwin', install, { files }))).toMatchObject({
      available: 'missing',
      reason: 'admin_plist_missing',
    });
    expect(
      await probeAdminHelper(
        host('darwin', install, {
          files,
          paths: ['/Library/LaunchDaemons/com.remyral.worker.admin.plist', `${install}/state/machine-admin`],
          closed: [`${install}/state/machine-admin`],
        }),
      ),
    ).toMatchObject({ reason: 'state_dir_not_traversable' });
  });
});

describe('Windows', () => {
  const install = 'C:\\Program Files\\RemyralWorker';
  const files = { [`${install}\\remyral-worker-updater.mjs`]: HELPER };

  it('the scheduled task answers schtasks /Query: available', async () => {
    const h = host('win32', install, { files });
    expect(await probeAdminHelper(h)).toEqual({ available: 'available' });
    expect(h.calls).toEqual(['C:\\Windows\\System32\\schtasks.exe /Query /TN RemyralWorkerAdmin']);
  });

  it('not found (English / Turkish Windows) or unreadable: unknown with a reason — never blocks machine tasks', async () => {
    const answer =
      (stderr: string): Exec =>
      () =>
        Promise.resolve({ code: 1, stdout: '', stderr });
    expect(
      await probeAdminHelper(
        host('win32', install, { files, exec: answer('ERROR: The system cannot find the file specified.') }),
      ),
    ).toMatchObject({ available: 'unknown', reason: 'admin_task_missing' });
    expect(
      await probeAdminHelper(
        host('win32', install, { files, exec: answer('HATA: Sistem belirtilen dosyayı bulamıyor.') }),
      ),
    ).toMatchObject({ available: 'unknown', reason: 'admin_task_missing' });
    expect(
      await probeAdminHelper(host('win32', install, { files, exec: answer('ERROR: Access is denied.') })),
    ).toMatchObject({ available: 'unknown', reason: 'admin_task_unreadable' });
  });

  it('the task is hidden from the service account but the helper has run a session: available', async () => {
    const seen = { ...files, [`${install}\\state\\admin-seen.json`]: '{}' };
    const exec: Exec = () =>
      Promise.resolve({ code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' });
    expect(await probeAdminHelper(host('win32', install, { files: seen, exec }))).toEqual({
      available: 'available',
    });
  });
});

describe('report and doctor', () => {
  it('CAPABILITIES carry the reason code (valid protocol); the probe is cached for a minute', async () => {
    const h = host('linux', '/opt/remyral-worker', {
      files: { '/opt/remyral-worker/remyral-worker-updater.mjs': HELPER },
    });
    const report = await machineAdminReport({
      enabled: true,
      autoApprove: false,
      localVeto: false,
      installDir: '/opt/remyral-worker',
      active: undefined,
      probe: h,
    });
    expect(MachineAdminReport.parse(report)).toMatchObject({
      helper: 'missing',
      helperReason: 'admin_unit_missing',
    });
    expect(report.helperDetail).toMatch(/systemd trigger/);
    const again = await adminHelperAvailable('/opt/remyral-worker', {
      ...h,
      exists: () => Promise.reject(new Error('must not be called')),
    });
    expect(again.reason).toBe('admin_unit_missing');
  });

  it('security fix: an otherwise ready helper is reported unavailable while host jobs run unconfined', async () => {
    const install = '/opt/remyral-worker';
    const h = host('linux', install, {
      files: { [`${install}/remyral-worker-updater.mjs`]: HELPER },
      paths: [
        '/etc/systemd/system/remyral-worker-admin.path',
        '/etc/systemd/system/multi-user.target.wants/remyral-worker-admin.path',
      ],
    });
    const report = await machineAdminReport({
      enabled: true,
      autoApprove: false,
      localVeto: false,
      installDir: install,
      active: undefined,
      hostUnconfined: 'bubblewrap cannot create a user namespace',
      probe: h,
    });
    expect(MachineAdminReport.parse(report)).toMatchObject({
      helper: 'missing',
      helperReason: 'host_unconfined',
    });
    expect(report.helperDetail).toContain('user namespace');
    resetHelperProbeCache();
    expect(
      await machineAdminReport({
        enabled: true,
        autoApprove: false,
        localVeto: false,
        installDir: install,
        active: undefined,
        hostUnconfined: null,
        probe: h,
      }),
    ).toMatchObject({ helper: 'available' });
  });

  it('a probe that throws is unknown / probe_failed', async () => {
    const h = host('linux', '/opt/remyral-worker');
    expect(await probeAdminHelper({ ...h, fileKey: () => Promise.reject(new Error('EIO')) })).toMatchObject({
      available: 'unknown',
      reason: 'probe_failed',
    });
  });

  it('Doctor: ok, warning for a definite finding, info when there is no helper or the probe cannot tell', () => {
    expect(machineAdminFinding({ available: 'available' })).toMatchObject({
      check: 'machine_admin',
      code: 'ok',
      severity: 'ok',
    });
    expect(
      machineAdminFinding({ available: 'missing', reason: 'state_dir_not_traversable', detail: 'x' }),
    ).toMatchObject({
      code: 'state_dir_not_traversable',
      severity: 'warning',
      fix: expect.any(String) as unknown,
    });
    expect(machineAdminFinding({ available: 'missing', reason: 'helper_missing' }).severity).toBe('info');
    expect(machineAdminFinding({ available: 'unknown', reason: 'admin_task_unreadable' })).toMatchObject({
      severity: 'info',
    });
    expect(
      machineAdminFinding({ available: 'unknown', reason: 'admin_task_unreadable' }).fix,
    ).toBeUndefined();
  });
});
