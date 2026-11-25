import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INSTALLER_WORKER_USERS } from '../../sandbox/host/identity.js';
import { bwrapTrusted } from '../../sandbox/host/linux-isolation.js';
import { SLOTS_FILE, SlotState, slotStateDir } from '../../sandbox/host/windows-slots.js';
import { findBwrap } from '../../probe/bwrap.js';
import type { AdminExec } from './admin.js';

/**
 * Security fix (host profile without confinement): the root/SYSTEM helper's own view of whether `host-restricted` jobs
 * on this machine can have filesystem confinement. Without it, job code runs as the worker's service account and can
 * read the device key and write the machine-admin request directory — together with machine administration that is
 * a path to root. The helper must not take the worker's word for it (job code runs as that account), so it checks
 * facts only root can vouch for, conservatively (anything it cannot verify counts as unconfined):
 *
 *  - macOS: Seatbelt is mandatory for host jobs (no fallback) → confined.
 *  - Linux: `sandbox.linuxHostIsolation` is not `off`, a root-owned bubblewrap exists, and bubblewrap can create a user
 *    namespace **as the worker's account** (`setpriv` to its uid/gid, no new privileges — the worker unit's setting).
 *    Ubuntu 24.04's default AppArmor restriction of unprivileged user namespaces fails exactly this.
 *  - Windows: `sandbox.windowsJobSlots` is not 0 and the per-job accounts are provisioned (the admin-owned
 *    `job-slots\slots.json` the privileged Prepare writes).
 *
 * What it cannot see: the worker's own cross-attempt self-check (it may still fall back on a machine that passes
 * these checks); the worker refuses machine-admin jobs itself in that case.
 */
export type HostConfinement =
  { readonly confined: true } | { readonly confined: false; readonly detail: string };

export interface HostConfinementDeps {
  readonly platform: NodeJS.Platform;
  /** The root-owned config's directory (Windows: where `job-slots\` lives). */
  readonly configDir: string;
  readonly sandbox: {
    readonly workerUser?: string | undefined;
    readonly linuxHostIsolation?: 'auto' | 'off' | undefined;
    readonly windowsJobSlots?: number | undefined;
  };
  readonly exec: AdminExec;
  /** Test seams. */
  readonly findBwrap?: () => Promise<string | null>;
  readonly bwrapTrusted?: (path: string) => Promise<string | null>;
  readonly readText?: (path: string) => Promise<string>;
}

const ROOT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export async function assessHostConfinement(d: HostConfinementDeps): Promise<HostConfinement> {
  if (d.platform === 'darwin') return { confined: true };
  if (d.platform === 'win32') {
    if (d.sandbox.windowsJobSlots === 0) {
      return {
        confined: false,
        detail: 'per-job accounts are off on this machine (sandbox.windowsJobSlots: 0)',
      };
    }
    try {
      const text = await (d.readText ?? ((p) => readFile(p, 'utf8')))(
        join(slotStateDir(d.configDir), SLOTS_FILE),
      );
      if (SlotState.safeParse(JSON.parse(text.replace(/^\uFEFF/, ''))).success) return { confined: true };
    } catch {
      // absent or unreadable: not provisioned
    }
    return {
      confined: false,
      detail:
        'per-job Windows accounts are not provisioned, so host jobs run as the worker service account (Machines > Sandbox & policy > Prepare with the privileged helper)',
    };
  }
  if (d.platform !== 'linux') return { confined: false, detail: `no host confinement on ${d.platform}` };
  if (d.sandbox.linuxHostIsolation === 'off') {
    return {
      confined: false,
      detail: 'per-attempt isolation is off on this machine (sandbox.linuxHostIsolation: "off")',
    };
  }
  const bwrap = await (d.findBwrap ?? (() => findBwrap(ROOT_PATH)))();
  if (bwrap === null) {
    return {
      confined: false,
      detail:
        'bubblewrap is not installed (Debian/Ubuntu: apt install bubblewrap; Fedora: dnf install bubblewrap)',
    };
  }
  const untrusted = await (d.bwrapTrusted ?? bwrapTrusted)(bwrap);
  if (untrusted !== null)
    return { confined: false, detail: `bubblewrap at ${bwrap} is not used: ${untrusted}` };
  const user = d.sandbox.workerUser ?? INSTALLER_WORKER_USERS.linux ?? 'remyral-worker';
  const id = async (flag: '-u' | '-g'): Promise<string | null> => {
    const r = await d.exec({
      file: '/usr/bin/id',
      args: [flag, user],
      cwd: '/',
      timeoutMs: 10_000,
      env: { PATH: ROOT_PATH },
    });
    const v = r.stdout.trim();
    return r.exitCode === 0 && /^\d+$/.test(v) ? v : null;
  };
  const uid = await id('-u');
  const gid = await id('-g');
  if (uid === null || gid === null || uid === '0') {
    return { confined: false, detail: `the worker account ${user} could not be resolved` };
  }
  const r = await d.exec({
    file: '/usr/bin/setpriv',
    args: [
      `--reuid=${uid}`,
      `--regid=${gid}`,
      '--clear-groups',
      '--no-new-privs',
      '--',
      bwrap,
      '--unshare-user',
      '--unshare-ipc',
      '--die-with-parent',
      '--ro-bind',
      '/',
      '/',
      '--',
      '/bin/true',
    ],
    cwd: '/',
    timeoutMs: 15_000,
    env: { PATH: ROOT_PATH, LANG: 'C' },
  });
  if (r.exitCode === 0 && !r.timedOut) return { confined: true };
  const why = (r.spawnError ?? r.stderr.trim().split('\n').at(-1) ?? '').slice(0, 200);
  return {
    confined: false,
    detail: `bubblewrap cannot create a user namespace for ${user} (${why || `exit ${String(r.exitCode)}`}); Ubuntu 24.04: allow it for bwrap (an AppArmor profile for /usr/bin/bwrap with the userns rule, or kernel.apparmor_restrict_unprivileged_userns=0), docs/ops/worker-sandbox.md`,
  };
}
