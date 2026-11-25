import { spawn } from 'node:child_process';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { Logger } from '@remyral/observability';
import type { HelperManageAction, ManageStep, ManageStepId } from '@remyral/protocol';
import { INSTALLER_WORKER_USERS } from '../../sandbox/host/identity.js';
import { powershellExe } from '../../sandbox/host/windows-jobrun.js';
import { MANAGE_HELPER_MARKER, type ManageResult, manageResultPath } from '../manage-shared.js';
import { LINUX_ADMIN_PATH_UNIT, LINUX_ADMIN_SERVICE_UNIT, MACOS_ADMIN_PLIST } from './admin-trigger.js';
import { type Exec, nodeExec } from './prepare.js';

/**
 * p17-worker-managed (docs/design/p17-worker-managed.md §3, §4) — the privileged helper's part of `worker.uninstall` and
 * `helper.manage`, reached through the same signed request and OS trigger as `sandbox.prepare` (prepare.ts verifies the
 * master's signature, the validity window and replay before it calls this).
 *
 * Nothing here comes from the request beyond `purge` / the action: service names, unit / task / plist names and every
 * path are the installer's constants or the root-owned config's (install dir, config file, data dir).
 *
 * - **Uninstall**: the helper writes `accepted` with the planned steps, then starts a detached script (Linux through
 *   `systemd-run`, so the end of the oneshot prepare unit does not kill it; macOS in a new session; Windows a detached
 *   PowerShell) that waits 15 s — long enough for the worker to relay `accepted` — and then does what the kit's
 *   uninstaller does: stop and remove the service, the updater / prepare / admin triggers, the program files and, with
 *   `purge`, the config, the data dir with the device key and (Linux / macOS) the service user. A custom workspace root
 *   outside the data root is kept, as the kit's uninstaller keeps it. The machine is gone while the script runs, so
 *   no later result can be reported; the master revokes the worker once `accepted` arrived.
 * - **helper.manage**: installs or removes the machine-admin helper's trigger with the kit's own units (admin-trigger.ts)
 *   — refused while the root-owned config vetoes machine administration (`localCeiling.allowMachineAdmin: false`).
 *
 * Marker for the worker: remana-manage-helper/v1 (MANAGE_HELPER_MARKER).
 */
export const MANAGE_HELPER = MANAGE_HELPER_MARKER;

export const UNINSTALL_DELAY_SEC = 15;

export interface ManageHelperDeps {
  readonly platform: NodeJS.Platform;
  /** Root-owned worker config (its directory is the config / data root). */
  readonly configPath: string;
  readonly dataDir: string;
  readonly installDir: string;
  /** The Node binary the helper runs with (written into the admin trigger like the kits do). */
  readonly nodePath: string;
  /** false when the root-owned config vetoes machine administration. */
  readonly allowMachineAdmin: boolean;
  readonly logger: Logger;
  readonly exec?: Exec;
  /** Starts the uninstall script detached (default: systemd-run / setsid / a detached PowerShell). */
  readonly spawnDetached?: (file: string, args: readonly string[]) => Promise<void>;
  readonly writeText?: (path: string, text: string, mode: number) => Promise<void>;
  readonly remove?: (path: string) => Promise<void>;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seams for the OS locations. */
  readonly systemdDir?: string;
  readonly launchDaemonsDir?: string;
}

type StepOut = Omit<ManageStep, 'id'>;

/** POSIX shell single-quoting. */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** PowerShell single-quoting. */
export function psQuote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/** A directory the helper may delete recursively: absolute and at least two levels deep (never `/`, `C:\`, `/opt`). */
export function safeToRemove(platform: NodeJS.Platform, p: string): boolean {
  const api = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  if (!api.isAbsolute(p)) return false;
  const parts = api
    .resolve(p)
    .split(/[\\/]/)
    .filter((x) => x !== '' && !/^[A-Za-z]:$/.test(x));
  return parts.length >= 2;
}

export interface UninstallLayout {
  readonly installDir: string;
  /** The config file's directory (Linux /etc/remyral-worker, macOS / Windows the data root). */
  readonly configDir: string;
  readonly dataDir: string;
}

/** The steps an uninstall reports (the plan; the detached script runs them after the worker relayed it). */
export function uninstallSteps(platform: NodeJS.Platform, purge: boolean): ManageStepId[] {
  const steps: ManageStepId[] = ['service_stop', 'triggers_remove', 'service_remove', 'program_remove'];
  if (purge) {
    steps.push('data_purge');
    if (platform !== 'win32') steps.push('user_remove');
  }
  return steps;
}

const LINUX_UNITS = [
  'remyral-worker-admin.path',
  'remyral-worker-admin.service',
  'remyral-worker-update.path',
  'remyral-worker-update.service',
  'remyral-worker-prepare.path',
  'remyral-worker-prepare.service',
] as const;

/** Linux: infra/worker/linux/uninstall.sh as one fixed script (idempotent, every step tolerates "already gone"). */
export function linuxUninstallScript(
  l: UninstallLayout,
  purge: boolean,
  systemdDir = '/etc/systemd/system',
): string {
  const user = INSTALLER_WORKER_USERS.linux ?? 'remyral-worker';
  const unitFiles = ['remyral-worker.service', 'remyral-worker.service.d', ...LINUX_UNITS].map((u) =>
    shQuote(nodePath.posix.join(systemdDir, u)),
  );
  const lines = [
    '#!/bin/sh',
    '# Remyral worker removal from the panel (p17-worker-managed), written by the privileged helper.',
    `sleep ${String(UNINSTALL_DELAY_SEC)}`,
    'systemctl stop remyral-worker.service 2>/dev/null || true',
    'systemctl disable remyral-worker.service 2>/dev/null || true',
    ...LINUX_UNITS.filter((u) => u !== 'remyral-worker-prepare.service').map(
      (u) => `systemctl disable --now ${u} 2>/dev/null || true`,
    ),
    `rm -rf ${unitFiles.join(' ')}`,
    'systemctl daemon-reload 2>/dev/null || true',
    'systemctl reset-failed remyral-worker.service 2>/dev/null || true',
    `rm -rf ${shQuote(l.installDir)} /usr/local/bin/remyral-worker`,
  ];
  if (purge) {
    lines.push(
      `rm -rf ${shQuote(l.configDir)} ${shQuote(l.dataDir)}`,
      `pkill -KILL -u ${user} 2>/dev/null || true`,
      `userdel ${user} 2>/dev/null || true`,
      `groupdel ${user} 2>/dev/null || true`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** macOS: infra/worker/macos/uninstall.sh as one fixed script (the updater job, our own trigger, goes last). */
export function macosUninstallScript(
  l: UninstallLayout,
  purge: boolean,
  daemonsDir = '/Library/LaunchDaemons',
): string {
  const user = INSTALLER_WORKER_USERS.darwin ?? '_remyralworker';
  const plist = (label: string): string => shQuote(nodePath.posix.join(daemonsDir, `${label}.plist`));
  const base = l.configDir;
  const lines = [
    '#!/bin/sh',
    '# Remyral worker removal from the panel (p17-worker-managed), written by the privileged helper.',
    `sleep ${String(UNINSTALL_DELAY_SEC)}`,
    'launchctl bootout system/com.remyral.worker.admin 2>/dev/null || true',
    `rm -f ${plist('com.remyral.worker.admin')}`,
    // bootout sends SIGTERM and waits up to ExitTimeOut: running jobs are cancelled gracefully.
    'launchctl bootout system/com.remyral.worker 2>/dev/null || true',
    `rm -f ${plist('com.remyral.worker')}`,
    `rm -rf ${shQuote(l.installDir)} ${shQuote(nodePath.posix.join(base, 'node'))} ${shQuote(nodePath.posix.join(base, 'installer'))}`,
    "if grep -q 'infra/worker/macos/install.sh' /usr/local/bin/remyral-worker 2>/dev/null; then rm -f /usr/local/bin/remyral-worker; fi",
  ];
  if (purge) {
    lines.push(
      `rm -rf ${shQuote(base)} ${shQuote(l.dataDir)} /Library/Logs/RemyralWorker`,
      `pkill -KILL -u ${user} 2>/dev/null || true`,
      `dscl . -delete /Users/${user} 2>/dev/null || true`,
      `dscl . -delete /Groups/${user} 2>/dev/null || true`,
    );
  }
  lines.push(
    `rm -f ${plist('com.remyral.worker.updater')}`,
    'launchctl bootout system/com.remyral.worker.updater 2>/dev/null || true',
  );
  return `${lines.join('\n')}\n`;
}

/** Windows: infra/worker/windows/uninstall.ps1 as one fixed script (ASCII, PowerShell 5.1). */
export function windowsUninstallScript(l: UninstallLayout, purge: boolean): string {
  const lines = [
    '# Remyral worker removal from the panel (p17-worker-managed), written by the privileged helper.',
    "$ErrorActionPreference = 'Continue'",
    `Start-Sleep -Seconds ${String(UNINSTALL_DELAY_SEC)}`,
    '& schtasks.exe /Delete /TN RemyralWorkerAdmin /F 2>$null | Out-Null',
    // Stop-Service waits while shawl sends Ctrl-C and the daemon cancels its jobs.
    "Stop-Service -Name 'RemyralWorker' -Force -ErrorAction SilentlyContinue",
    '& sc.exe delete RemyralWorker 2>$null | Out-Null',
    '& schtasks.exe /Delete /TN RemyralWorkerUpdater /F 2>$null | Out-Null',
    // The helper's own node.exe may still be exiting: a few tries.
    `for ($i = 0; $i -lt 6; $i++) { if (-not (Test-Path -LiteralPath ${psQuote(l.installDir)})) { break }; Remove-Item -LiteralPath ${psQuote(l.installDir)} -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 5 }`,
  ];
  if (purge) {
    lines.push(
      `for ($i = 0; $i -lt 6; $i++) { if (-not (Test-Path -LiteralPath ${psQuote(l.configDir)})) { break }; Remove-Item -LiteralPath ${psQuote(l.configDir)} -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 5 }`,
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export class ManageHelper {
  readonly #d: ManageHelperDeps;

  constructor(d: ManageHelperDeps) {
    this.#d = d;
  }

  #now(): string {
    return (this.#d.now?.() ?? new Date()).toISOString();
  }

  get #exec(): Exec {
    return this.#d.exec ?? nodeExec;
  }

  async #writeText(path: string, text: string, mode: number): Promise<void> {
    if (this.#d.writeText !== undefined) {
      await this.#d.writeText(path, text, mode);
      return;
    }
    await mkdir(nodePath.dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, text, { mode });
    if (this.#d.platform !== 'win32') await chmod(tmp, mode);
    await rename(tmp, path);
  }

  async writeResult(r: ManageResult): Promise<void> {
    await this.#writeText(manageResultPath(this.#d.installDir), `${JSON.stringify(r)}\n`, 0o644);
  }

  /** A refusal before anything ran (bad signature, expired, replay, veto …). */
  async refuse(commandId: string, reason: string, detail: string): Promise<ManageResult> {
    const r: ManageResult = {
      v: 1,
      commandId,
      state: 'refused',
      reason,
      detail: detail.slice(0, 300),
      steps: [],
      updatedAt: this.#now(),
    };
    await this.writeResult(r);
    this.#d.logger.warn('privileged manage request refused', { commandId, reason });
    return r;
  }

  layout(): UninstallLayout {
    return {
      installDir: this.#d.installDir,
      configDir: (this.#d.platform === 'win32' ? nodePath.win32 : nodePath.posix).dirname(this.#d.configPath),
      dataDir: this.#d.dataDir,
    };
  }

  async uninstall(commandId: string, purge: boolean): Promise<ManageResult> {
    const p = this.#d.platform;
    const l = this.layout();
    const dirs = purge ? [l.installDir, l.configDir, l.dataDir] : [l.installDir];
    if (dirs.some((d) => !safeToRemove(p, d))) {
      return this.refuse(
        commandId,
        'unsafe_layout',
        `refusing to delete ${dirs.join(', ')}: not a dedicated directory`,
      );
    }
    let script: string;
    let file: string;
    let args: string[];
    const scriptPath = (name: string): string =>
      (p === 'win32' ? nodePath.win32 : nodePath.posix).join(l.installDir, 'state', name);
    if (p === 'linux') {
      script = linuxUninstallScript(l, purge, this.#d.systemdDir);
      const path = scriptPath('uninstall.sh');
      file = 'systemd-run';
      args = [
        '--unit',
        `remyral-worker-uninstall-${commandId.slice(0, 8)}`,
        '--collect',
        '--quiet',
        '/bin/sh',
        path,
      ];
      await this.#writeText(path, script, 0o700);
    } else if (p === 'darwin') {
      script = macosUninstallScript(l, purge, this.#d.launchDaemonsDir);
      const path = scriptPath('uninstall.sh');
      file = '/bin/sh';
      args = [path];
      await this.#writeText(path, script, 0o700);
    } else if (p === 'win32') {
      script = windowsUninstallScript(l, purge);
      const path = scriptPath('uninstall.ps1');
      file = powershellExe(this.#d.env ?? process.env);
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path];
      await this.#writeText(path, script, 0o700);
    } else {
      return this.refuse(commandId, 'unsupported_os', `no uninstall for ${p}`);
    }
    const steps: ManageStep[] = uninstallSteps(p, purge).map((id) => ({ id, state: 'pending' }));
    const accepted: ManageResult = {
      v: 1,
      commandId,
      state: 'accepted',
      detail: `the worker is removed in about ${String(UNINSTALL_DELAY_SEC)} s${purge ? ' (with its data and device key)' : ''}`,
      steps,
      updatedAt: this.#now(),
    };
    // The result first: the worker relays it before the script stops the service.
    await this.writeResult(accepted);
    try {
      await (this.#d.spawnDetached ?? spawnDetached)(file, args);
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      this.#d.logger.error('worker removal could not be started', { commandId, detail });
      const failed: ManageResult = {
        ...accepted,
        state: 'done',
        reason: 'start_failed',
        detail,
        steps: steps.map((s) => ({ ...s, state: 'failed' })),
        updatedAt: this.#now(),
      };
      await this.writeResult(failed);
      return failed;
    }
    this.#d.logger.warn('worker removal started; the service stops shortly', { commandId, purge });
    return accepted;
  }

  async helper(commandId: string, action: HelperManageAction): Promise<ManageResult> {
    if (action === 'admin_helper.install' && !this.#d.allowMachineAdmin) {
      return this.refuse(
        commandId,
        'disabled_locally',
        'the local config forbids machine administration (localCeiling.allowMachineAdmin: false)',
      );
    }
    const id: ManageStepId =
      action === 'admin_helper.install' ? 'admin_helper_install' : 'admin_helper_remove';
    let out: StepOut;
    try {
      out = action === 'admin_helper.install' ? await this.#installAdmin() : await this.#removeAdmin();
    } catch (err) {
      out = {
        state: 'failed',
        code: 'step_error',
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      };
    }
    const r: ManageResult = {
      v: 1,
      commandId,
      state: 'done',
      ...(out.state === 'failed' ? { reason: out.code ?? 'step_failed' } : {}),
      steps: [{ id, ...out }],
      updatedAt: this.#now(),
    };
    await this.writeResult(r);
    this.#d.logger.info('privileged manage step', { commandId, step: id, state: out.state });
    return r;
  }

  async #run(file: string, args: readonly string[], what: string): Promise<StepOut | null> {
    const r = await this.#exec(file, args, { timeoutMs: 120_000 });
    if (r.code === 0) return null;
    return {
      state: 'failed',
      code: 'command_failed',
      detail: `${what}: ${(r.stderr || r.stdout).trim()}`.slice(0, 300),
    };
  }

  async #installAdmin(): Promise<StepOut> {
    const p = this.#d.platform;
    const node = this.#d.nodePath;
    if (p === 'linux') {
      const dir = this.#d.systemdDir ?? '/etc/systemd/system';
      await this.#writeText(
        nodePath.posix.join(dir, 'remyral-worker-admin.service'),
        LINUX_ADMIN_SERVICE_UNIT.replaceAll('@NODE@', node),
        0o644,
      );
      await this.#writeText(
        nodePath.posix.join(dir, 'remyral-worker-admin.path'),
        LINUX_ADMIN_PATH_UNIT,
        0o644,
      );
      return (
        (await this.#run('systemctl', ['daemon-reload'], 'systemctl daemon-reload')) ??
        (await this.#run(
          'systemctl',
          ['enable', '--now', 'remyral-worker-admin.path'],
          'systemctl enable',
        )) ?? {
          state: 'done',
          detail: 'remyral-worker-admin.path enabled',
        }
      );
    }
    if (p === 'darwin') {
      const plist = nodePath.posix.join(
        this.#d.launchDaemonsDir ?? '/Library/LaunchDaemons',
        'com.remyral.worker.admin.plist',
      );
      await this.#exec('launchctl', ['bootout', 'system/com.remyral.worker.admin']);
      await this.#writeText(plist, MACOS_ADMIN_PLIST.replaceAll('@NODE@', node), 0o644);
      return (
        (await this.#run('launchctl', ['bootstrap', 'system', plist], 'launchctl bootstrap')) ?? {
          state: 'done',
          detail: 'com.remyral.worker.admin loaded',
        }
      );
    }
    if (p === 'win32') {
      const updater = nodePath.win32.join(this.#d.installDir, 'remyral-worker-updater.mjs');
      const script = windowsAdminTaskScript(node, updater, this.#d.configPath);
      const r = await this.#exec(
        powershellExe(this.#d.env ?? process.env),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeoutMs: 120_000 },
      );
      return r.code === 0
        ? { state: 'done', detail: 'scheduled task RemyralWorkerAdmin registered (SYSTEM, every minute)' }
        : {
            state: 'failed',
            code: 'task_register_failed',
            detail: (r.stderr || r.stdout).trim().slice(0, 300),
          };
    }
    return { state: 'skipped', code: 'unsupported_os' };
  }

  async #removeAdmin(): Promise<StepOut> {
    const p = this.#d.platform;
    const rmf = this.#d.remove ?? ((path: string) => rm(path, { force: true }));
    if (p === 'linux') {
      const dir = this.#d.systemdDir ?? '/etc/systemd/system';
      await this.#exec('systemctl', ['disable', '--now', 'remyral-worker-admin.path']);
      await rmf(nodePath.posix.join(dir, 'remyral-worker-admin.path'));
      await rmf(nodePath.posix.join(dir, 'remyral-worker-admin.service'));
      return (
        (await this.#run('systemctl', ['daemon-reload'], 'systemctl daemon-reload')) ?? {
          state: 'done',
          detail: 'removed',
        }
      );
    }
    if (p === 'darwin') {
      await this.#exec('launchctl', ['bootout', 'system/com.remyral.worker.admin']);
      await rmf(
        nodePath.posix.join(
          this.#d.launchDaemonsDir ?? '/Library/LaunchDaemons',
          'com.remyral.worker.admin.plist',
        ),
      );
      return { state: 'done', detail: 'removed' };
    }
    if (p === 'win32') {
      const r = await this.#exec('schtasks.exe', ['/Delete', '/TN', 'RemyralWorkerAdmin', '/F']);
      // Already absent is fine (schtasks exits 1 with "cannot find").
      return r.code === 0 || /cannot find|bulunam/i.test(`${r.stderr}${r.stdout}`)
        ? { state: 'done', detail: 'removed' }
        : {
            state: 'failed',
            code: 'task_delete_failed',
            detail: (r.stderr || r.stdout).trim().slice(0, 300),
          };
    }
    return { state: 'skipped', code: 'unsupported_os' };
  }
}

/** The kit's RemyralWorkerAdmin task (install.ps1 'Task' action), as one fixed PowerShell command. */
export function windowsAdminTaskScript(node: string, updater: string, configPath: string): string {
  const arg = `"${updater}" admin-session --config "${configPath}"`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute ${psQuote(node)} -Argument ${psQuote(arg)}`,
    '$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)',
    "$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest",
    '$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 780) -StartWhenAvailable',
    "Register-ScheduledTask -TaskName 'RemyralWorkerAdmin' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null",
  ].join('; ');
}

/** Starts a process that outlives the helper (Linux callers wrap it in systemd-run themselves). */
async function spawnDetached(file: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, [...args], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
