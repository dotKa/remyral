import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readFile, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { AdminHelperReason, MachineAdminReport } from '@remyral/protocol';
import { helperName } from '../update/layout.js';
import { ADMIN_BINDING_MARKER, adminBindCommand, readAdminBinding } from './binding.js';
import { ADMIN_HELPER_MARKER } from './shared.js';

/**
 * Whether the root/SYSTEM helper can really start admin sessions on this machine (p5-machine-admin, ADR-0021;
 * readiness probe p17-worker-1-1-1). "The updater file carries the marker" alone misled the console: the Linux helper
 * of 1.1.0 created `<install>/state/machine-admin` as 0750 and every session ended in `helper_not_started`. So,
 * without root and read-only:
 *
 *  1. the installed updater carries remana-admin-helper/v1 (cached per size + mtime);
 *  2. the OS trigger exists — Linux: `remyral-worker-admin.path` installed and enabled (the `multi-user.target.wants`
 *     symlink, else `systemctl is-enabled`); macOS: the `com.remyral.worker.admin` LaunchDaemon plist; Windows: the
 *     `RemyralWorkerAdmin` scheduled task (`schtasks /Query`, or the helper's `state\\admin-seen.json` when the
 *     service account cannot see the SYSTEM task);
 *  3. POSIX: the worker account can pass through `<install>/state/machine-admin` (X_OK), where the broker answers.
 *
 * `missing` (the master refuses new machine tasks) only for definite findings; anything the probe cannot tell —
 * including a Windows task the service account cannot query (real-OS behaviour UNVERIFIED) — is `unknown` with a
 * reason code. The helper is never auto-updated (p2-signed-updates): fixes need the installer kit re-run once.
 */

export interface HelperReadiness {
  readonly available: MachineAdminReport['helper'];
  readonly reason?: AdminHelperReason;
  /** English, one line (the console translates `reason`). */
  readonly detail?: string;
}

export interface HelperProbeDeps {
  readonly platform: NodeJS.Platform;
  readonly installDir: string | undefined;
  /** Size + mtime of a file (null: it does not exist / cannot be read). */
  readonly fileKey: (path: string) => Promise<string | null>;
  readonly readText: (path: string) => Promise<string>;
  /** The path exists (lstat: a symlink counts, its target is not followed). */
  readonly exists: (path: string) => Promise<boolean>;
  /** This process may traverse the directory (access X_OK). */
  readonly traversable: (path: string) => Promise<boolean>;
  readonly exec: (
    file: string,
    args: readonly string[],
  ) => Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>;
  readonly env: (name: string) => string | undefined;
  /** This worker's enrolled id (a binding-aware helper serves exactly one; null: not enrolled). */
  readonly workerId?: string | null;
  /** The binding's worker id as the helper recorded it (null: none / unreadable). Default: read the file. */
  readonly boundWorkerId?: (installDir: string) => Promise<string | null>;
  /** The Node binary for the owner's `admin-bind` command line (default: this process's). */
  readonly nodePath?: string;
}

const SYSTEMD = '/etc/systemd/system';
const LAUNCH_DAEMONS = '/Library/LaunchDaemons';
export const ADMIN_TRIGGERS = {
  linux: 'remyral-worker-admin.path',
  darwin: 'com.remyral.worker.admin',
  win32: 'RemyralWorkerAdmin',
} as const;

const DETAIL: Readonly<Record<AdminHelperReason, string>> = {
  install_dir_unknown: 'the worker does not know its install dir',
  helper_missing: 'no privileged helper (installed without the signed updater?)',
  helper_outdated:
    'the installed root/SYSTEM helper predates machine administration; re-run the installer kit of this release once (as admin/root)',
  admin_unit_missing:
    'the systemd trigger of admin sessions is not installed; re-run the installer kit once (as root)',
  admin_unit_disabled:
    'the systemd trigger of admin sessions is not enabled; re-run the installer kit once (as root)',
  state_dir_not_traversable:
    'the worker account cannot reach the helper’s answer directory (state/machine-admin); re-run the installer kit of this release once (as root)',
  admin_task_missing:
    'the scheduled task of admin sessions was not found; re-run the installer kit once (as Administrator)',
  admin_task_unreadable: 'the scheduled task of admin sessions could not be queried',
  admin_plist_missing:
    'the LaunchDaemon of admin sessions is not installed; re-run the installer kit once (as admin)',
  probe_failed: 'the readiness probe failed',
  helper_not_bound:
    'machine administration is not bound to this worker yet (the helper refuses sessions until it is); run once as root / Administrator',
  helper_bound_elsewhere:
    'the helper serves another worker id (was the machine paired again?); after comparing the fingerprint with the console run as root / Administrator',
  host_unconfined:
    'host jobs on this machine run without filesystem confinement; machine administration is refused unless the owner sets localCeiling.allowMachineAdmin: true',
};

function finding(
  available: HelperReadiness['available'],
  reason: AdminHelperReason,
  path?: string,
): HelperReadiness {
  return {
    available,
    reason,
    detail: `${DETAIL[reason]}${path === undefined ? '' : ` (${path})`}`.slice(0, 300),
  };
}

let markerCache: { key: string; ok: boolean; binding: boolean } | null = null;

/** The trigger names of this installation. */
function triggers(): { linux: string; darwin: string; win32: string } {
  return ADMIN_TRIGGERS;
}

/** POSIX: the worker can pass through to its session dirs (an absent dir is created 0711 by the helper). */
async function stateDirFinding(d: HelperProbeDeps, installDir: string): Promise<HelperReadiness | null> {
  const state = posix.join(installDir, 'state');
  for (const dir of [posix.join(state, 'machine-admin'), state]) {
    if (!(await d.exists(dir))) continue;
    return (await d.traversable(dir)) ? null : finding('missing', 'state_dir_not_traversable', dir);
  }
  return null;
}

export async function probeAdminHelper(d: HelperProbeDeps): Promise<HelperReadiness> {
  if (d.installDir === undefined) return finding('unknown', 'install_dir_unknown');
  const path = d.platform === 'win32' ? win32 : posix;
  const file = path.join(d.installDir, helperName());
  try {
    const key = await d.fileKey(file);
    if (key === null) return finding('missing', 'helper_missing', file);
    const cacheKey = `${file}:${key}`;
    if (markerCache?.key !== cacheKey) {
      const text = await d.readText(file);
      markerCache = {
        key: cacheKey,
        ok: text.includes(ADMIN_HELPER_MARKER),
        binding: text.includes(ADMIN_BINDING_MARKER),
      };
    }
    if (!markerCache.ok) return finding('missing', 'helper_outdated');
    // A binding-aware helper refuses every session until root recorded this worker's id (older helpers do not).
    if (markerCache.binding) {
      const bound = await (d.boundWorkerId ?? defaultBoundWorkerId(d.platform))(d.installDir);
      const cmd = adminBindCommand(d.platform, d.nodePath ?? process.execPath, d.installDir);
      // The detail is the command itself: the console shows it after the translated reason.
      if (bound === null)
        return { available: 'missing', reason: 'helper_not_bound', detail: cmd.slice(0, 300) };
      if (d.workerId != null && bound !== d.workerId)
        return {
          available: 'missing',
          reason: 'helper_bound_elsewhere',
          detail: `${cmd} --replace`.slice(0, 300),
        };
    }
    const names = triggers();
    switch (d.platform) {
      case 'linux': {
        const unit = names.linux;
        if (!(await d.exists(posix.join(SYSTEMD, unit))))
          return finding('missing', 'admin_unit_missing', unit);
        if (!(await d.exists(posix.join(SYSTEMD, 'multi-user.target.wants', unit)))) {
          const r = await d.exec('systemctl', ['is-enabled', unit]);
          const state = r.stdout.trim().split('\n')[0] ?? '';
          if (r.code === null && state === '')
            return finding('unknown', 'probe_failed', 'systemctl is-enabled');
          if (state !== 'enabled' && state !== 'enabled-runtime')
            return finding('missing', 'admin_unit_disabled', unit);
        }
        return (await stateDirFinding(d, d.installDir)) ?? { available: 'available' };
      }
      case 'darwin': {
        const plist = posix.join(LAUNCH_DAEMONS, `${names.darwin}.plist`);
        if (!(await d.exists(plist))) return finding('missing', 'admin_plist_missing', plist);
        return (await stateDirFinding(d, d.installDir)) ?? { available: 'available' };
      }
      case 'win32': {
        const root = d.env('SystemRoot') ?? d.env('SYSTEMROOT') ?? 'C:\\Windows';
        const r = await d.exec(win32.join(root, 'System32', 'schtasks.exe'), ['/Query', '/TN', names.win32]);
        if (r.code === 0) return { available: 'available' };
        // The SYSTEM task is hidden from the worker's service account (its security descriptor admits only
        // SYSTEM and Administrators), so schtasks answers "not found" although it exists. The helper writes
        // `state\admin-seen.json` after its first session: proof the task has run on this install.
        if (await d.exists(win32.join(d.installDir, 'state', 'admin-seen.json')))
          return { available: 'available' };
        const text = `${r.stdout}\n${r.stderr}`;
        // English and Turkish Windows; any other answer (access denied, another language) stays "unreadable".
        return /cannot find|not found|does not exist|bulam/i.test(text)
          ? finding('unknown', 'admin_task_missing', names.win32)
          : finding('unknown', 'admin_task_unreadable', names.win32);
      }
      default:
        return { available: 'available' };
    }
  } catch {
    return finding('unknown', 'probe_failed');
  }
}

function defaultBoundWorkerId(platform: NodeJS.Platform): (installDir: string) => Promise<string | null> {
  return async (installDir) => {
    const r = await readAdminBinding(installDir, { platform, rootOnly: false });
    return r.state === 'bound' ? r.binding.workerId : null;
  };
}

/** The real host behind {@link probeAdminHelper} (read-only, no root). */
export function nodeHelperProbeDeps(installDir: string | undefined): HelperProbeDeps {
  return {
    platform: process.platform,
    installDir,
    fileKey: async (p) => {
      try {
        const st = await stat(p);
        return `${String(st.size)}:${String(st.mtimeMs)}`;
      } catch {
        return null;
      }
    },
    readText: (p) => readFile(p, 'utf8'),
    exists: async (p) => {
      try {
        await lstat(p);
        return true;
      } catch {
        return false;
      }
    },
    traversable: async (p) => {
      try {
        await access(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    exec: (file, args) =>
      new Promise((resolve) => {
        execFile(file, [...args], { timeout: 5_000, windowsHide: true }, (err, stdout, stderr) => {
          const code =
            err === null
              ? 0
              : typeof (err as { code?: unknown }).code === 'number'
                ? (err as { code: number }).code
                : null;
          resolve({ code, stdout, stderr });
        });
      }),
    env: (n) => process.env[n],
  };
}

/** The probe result, cached for a minute (CAPABILITIES are sent often; the probe may start a process). */
let probeCache: { key: string; at: number; value: HelperReadiness } | null = null;
export const HELPER_PROBE_TTL_MS = 60_000;

export async function adminHelperAvailable(
  installDir: string | undefined,
  deps: HelperProbeDeps = nodeHelperProbeDeps(installDir),
  now: number = Date.now(),
): Promise<HelperReadiness> {
  const key = `${deps.platform}:${installDir ?? ''}:${deps.workerId ?? ''}`;
  if (probeCache?.key === key && now - probeCache.at < HELPER_PROBE_TTL_MS) return probeCache.value;
  const value = await probeAdminHelper({ ...deps, installDir });
  probeCache = { key, at: now, value };
  return value;
}

/** Tests: forget the cached probe and marker results. */
export function resetHelperProbeCache(): void {
  probeCache = null;
  markerCache = null;
}

export async function machineAdminReport(input: {
  readonly enabled: boolean;
  readonly autoApprove: boolean;
  readonly localVeto: boolean;
  readonly installDir: string | undefined;
  readonly active: { jobId: string; attemptId: string; sessionId: string; since: string } | undefined;
  /** This worker's enrolled id (the helper's binding must name it). */
  readonly workerId?: string | null;
  /**
   * Security fix: why host jobs here have no filesystem confinement, when the owner has not opted in locally (null:
   * confined, or opted in). Machine administration is refused in that state (worker and helper).
   */
  readonly hostUnconfined?: string | null;
  /** Tests: the probe host. */
  readonly probe?: HelperProbeDeps;
}): Promise<MachineAdminReport> {
  const probed = await adminHelperAvailable(input.installDir, {
    ...(input.probe ?? nodeHelperProbeDeps(input.installDir)),
    workerId: input.workerId ?? null,
  });
  const helper: HelperReadiness =
    probed.available === 'available' && input.hostUnconfined != null
      ? finding('missing', 'host_unconfined', input.hostUnconfined.slice(0, 120))
      : probed;
  return {
    enabled: input.enabled && !input.localVeto,
    autoApprove: input.enabled && !input.localVeto && input.autoApprove,
    localVeto: input.localVeto,
    helper: helper.available,
    ...(helper.detail === undefined ? {} : { helperDetail: helper.detail.slice(0, 300) }),
    ...(helper.reason === undefined ? {} : { helperReason: helper.reason }),
    runtimes: ['claude-code'],
    ...(input.active === undefined
      ? {}
      : { activeSession: input.active as NonNullable<MachineAdminReport['activeSession']> }),
  };
}
