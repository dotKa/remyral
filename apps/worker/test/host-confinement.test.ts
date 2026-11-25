import { describe, expect, it } from 'vitest';
import type { AdminExecSpec } from '../src/update/helper/admin.js';
import { assessHostConfinement, type HostConfinementDeps } from '../src/update/helper/host-confinement.js';
import { hostFallback } from '../src/sandbox/host/fallback.js';
import type { SandboxRunners } from '../src/sandbox/factory.js';

/** Security fix: root's own view of host-job confinement (helper) and the worker's fallback report. */

const ok = { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false };

/** Matches an unconfined verdict whose detail contains `part`. */
function unconfined(part: string): { confined: false; detail: string } {
  return { confined: false, detail: expect.stringContaining(part) as string };
}

function linux(over: Partial<HostConfinementDeps> & { userns?: boolean } = {}) {
  const calls: AdminExecSpec[] = [];
  const deps: HostConfinementDeps = {
    platform: 'linux',
    configDir: '/etc/remyral-worker',
    sandbox: { workerUser: 'remyral-worker', linuxHostIsolation: 'auto' },
    findBwrap: () => Promise.resolve('/usr/bin/bwrap'),
    bwrapTrusted: () => Promise.resolve(null),
    exec: (spec) => {
      calls.push(spec);
      if (spec.file === '/usr/bin/id')
        return Promise.resolve({ ...ok, stdout: spec.args[0] === '-u' ? '998\n' : '997\n' });
      return Promise.resolve(
        over.userns === false
          ? { ...ok, exitCode: 1, stderr: 'bwrap: setting up uid map: Permission denied\n' }
          : ok,
      );
    },
    ...over,
  };
  return { deps, calls };
}

describe('helper: host confinement (root-verifiable facts)', () => {
  it('Linux: bubblewrap must create a user namespace as the worker account (no new privileges)', async () => {
    const good = linux();
    expect(await assessHostConfinement(good.deps)).toEqual({ confined: true });
    const probe = good.calls.find((c) => c.file === '/usr/bin/setpriv');
    expect(probe?.args).toEqual([
      '--reuid=998',
      '--regid=997',
      '--clear-groups',
      '--no-new-privs',
      '--',
      '/usr/bin/bwrap',
      '--unshare-user',
      '--unshare-ipc',
      '--die-with-parent',
      '--ro-bind',
      '/',
      '/',
      '--',
      '/bin/true',
    ]);
    const refused = await assessHostConfinement(linux({ userns: false }).deps);
    expect(refused).toMatchObject({ confined: false });
    expect(refused.confined ? '' : refused.detail).toMatch(/uid map: Permission denied.*Ubuntu 24\.04/);
  });

  it('Linux: switched off, no bubblewrap, an untrusted one or an unknown account count as unconfined', async () => {
    const off = linux();
    expect(await assessHostConfinement({ ...off.deps, sandbox: { linuxHostIsolation: 'off' } })).toEqual(
      unconfined('"off"'),
    );
    expect(off.calls).toEqual([]);
    expect(await assessHostConfinement(linux({ findBwrap: () => Promise.resolve(null) }).deps)).toEqual(
      unconfined('not installed'),
    );
    expect(
      await assessHostConfinement(linux({ bwrapTrusted: () => Promise.resolve('not owned by root') }).deps),
    ).toEqual(unconfined('not owned by root'));
    const noUser = linux();
    expect(
      await assessHostConfinement({
        ...noUser.deps,
        exec: () => Promise.resolve({ ...ok, exitCode: 1, stdout: '' }),
      }),
    ).toEqual(unconfined('could not be resolved'));
  });

  it('Windows: per-job accounts provisioned (slots.json) and not switched off; macOS: always Seatbelt', async () => {
    const slots = JSON.stringify({
      v: 1,
      generation: '0f9f8a52-7a63-4c7f-9d8e-2d1c0b9a8f71',
      provisionedAt: '2026-10-12T00:00:00.000Z',
      group: { name: 'remyral-job-slots', sid: 'S-1-5-21-1-2-3-1010' },
      workerSid: 'S-1-5-80-1-2-3-4-5',
      slots: [{ index: 1, user: 'remyral-job-1', sid: 'S-1-5-21-1-2-3-1011' }],
    });
    const win = (readText: (p: string) => Promise<string>, windowsJobSlots?: number) =>
      assessHostConfinement({
        platform: 'win32',
        configDir: 'C:\\ProgramData\\RemyralWorker',
        sandbox: { windowsJobSlots },
        exec: () => Promise.reject(new Error('not used')),
        readText,
      });
    const seen: string[] = [];
    expect(
      await win((p) => {
        seen.push(p);
        return Promise.resolve(slots);
      }),
    ).toEqual({ confined: true });
    expect(seen[0]).toMatch(/job-slots[\\/]slots\.json$/);
    expect(await win(() => Promise.reject(new Error('ENOENT')))).toMatchObject({ confined: false });
    expect(await win(() => Promise.resolve('{"v":1}'))).toMatchObject({ confined: false });
    expect(await win(() => Promise.resolve(slots), 0)).toEqual(unconfined('windowsJobSlots: 0'));
    expect(
      await assessHostConfinement({
        platform: 'darwin',
        configDir: '/x',
        sandbox: {},
        exec: () => Promise.reject(new Error('not used')),
      }),
    ).toEqual({ confined: true });
  });
});

describe('worker: host fallback report', () => {
  const runners = (platform: NodeJS.Platform, fs: string, extra: Record<string, unknown> = {}) =>
    ({ platform, host: { filesystemConfinement: fs }, ...extra }) as unknown as SandboxRunners;

  it('only when host-restricted has no confinement; the cause and the fix follow the isolation state', () => {
    expect(hostFallback(null)).toBeNull();
    expect(hostFallback(runners('linux', 'bwrap'))).toBeNull();
    expect(hostFallback(runners('win32', 'job_user'))).toBeNull();
    const userns = hostFallback(
      runners('linux', 'none', {
        linuxIsolation: {
          status: () => ({
            active: false,
            code: 'host_isolation_userns_refused',
            detail: 'userns refused here',
          }),
        },
      }),
    );
    expect(userns).toMatchObject({
      code: 'host_unconfined_fallback',
      cause: 'userns refused here',
      fix: 'owner',
      pending: false,
    });
    expect(userns?.reason).toMatch(/device key/);
    expect(userns?.remedy).toMatch(/AppArmor/);
    expect(
      hostFallback(
        runners('linux', 'none', {
          linuxIsolation: {
            status: () => ({ active: false, code: 'host_isolation_unverified', detail: 'checking' }),
          },
        }),
      ),
    ).toMatchObject({ pending: true, fix: 'prepare' });
    expect(
      hostFallback(
        runners('win32', 'none', {
          windowsSlots: { status: () => ({ active: false, detail: 'not provisioned' }) },
        }),
      ),
    ).toMatchObject({ cause: 'not provisioned', fix: 'prepare_privileged' });
    expect(hostFallback(runners('win32', 'none'))).toMatchObject({ fix: 'owner' });
  });
});
