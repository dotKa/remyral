import { pathApi } from '../config/paths.js';

/**
 * File layout of signed updates (docs/design/p2-signed-updates.md "Layout").
 *
 * Install dir (root/admin-owned, read-only for the service account):
 *   remyral-worker.mjs              the active bundle — the path every service definition executes;
 *                                  switched only by an atomic rename of verified bytes
 *   remyral-worker-updater.mjs      the privileged updater (installed by the installers, never auto-updated)
 *   versions/<version>/            verified copies: remyral-worker.mjs, manifest.json, manifest.sig.json
 *   state/active.json              which version the active bundle is (+ its SHA-256)
 *   state/update.json              updater state: last processed attempt, health-check in progress
 *   state/last-result.json         outcome of the last attempt (read by the daemon, reported to the master)
 *   state/last-diagnostics.json    p6-worker-boot-diagnostics: evidence of the last failed attempt (separate file:
 *                                  older daemons parse last-result.json strictly)
 *   state/updater.log              p6-worker-boot-diagnostics: the updater's own redacted JSON log (two generations)
 *
 * Data dir (owned by the service account): only *requests* and *staged downloads* — never trusted.
 *   updates/request.json           activation request written by the daemon
 *   updates/staged/<version>/      downloaded manifest, signature and artifact
 *   update-health.json             written by the daemon after SESSION_ESTABLISHED + first HEARTBEAT
 */
export interface InstallLayout {
  readonly installDir: string;
  readonly bundle: string;
  readonly helper: string;
  readonly versionsDir: string;
  readonly stateDir: string;
  readonly activeFile: string;
  readonly stateFile: string;
  readonly resultFile: string;
  readonly diagnosticsFile: string;
  readonly updaterLog: string;
  readonly lockFile: string;
}

export interface DataLayout {
  readonly dataDir: string;
  readonly updatesDir: string;
  readonly requestFile: string;
  readonly stagedDir: string;
  readonly healthFile: string;
  readonly reportedFile: string;
}

export const BUNDLE_NAME = 'remyral-worker.mjs';
export const HELPER_NAME = 'remyral-worker-updater.mjs';
export const MANIFEST_NAME = 'manifest.json';
export const SIGNATURE_NAME = 'manifest.sig.json';
export const UPDATER_LOG_NAME = 'updater.log';

/** The bundle file name of this installation (what the installed updater stages and activates). */
export function bundleName(): string {
  return BUNDLE_NAME;
}
/** The privileged updater's file name of this installation. */
export function helperName(): string {
  return HELPER_NAME;
}

/** Default install dir per OS — the directory that holds `remyral-worker.mjs` (p2-service-install). */
export function defaultInstallDir(
  platform: NodeJS.Platform,
  env: (name: string) => string | undefined,
): string {
  switch (platform) {
    case 'darwin':
      return '/Library/Application Support/RemyralWorker/bin';
    case 'win32': {
      const programFiles = env('ProgramFiles') ?? env('PROGRAMFILES') ?? 'C:\\Program Files';
      return pathApi('win32').join(programFiles, 'RemyralWorker');
    }
    default:
      return '/opt/remyral-worker';
  }
}

export function installLayout(platform: NodeJS.Platform, installDir: string): InstallLayout {
  const p = pathApi(platform);
  const stateDir = p.join(installDir, 'state');
  return {
    installDir,
    bundle: p.join(installDir, bundleName()),
    helper: p.join(installDir, helperName()),
    versionsDir: p.join(installDir, 'versions'),
    stateDir,
    activeFile: p.join(stateDir, 'active.json'),
    stateFile: p.join(stateDir, 'update.json'),
    resultFile: p.join(stateDir, 'last-result.json'),
    diagnosticsFile: p.join(stateDir, 'last-diagnostics.json'),
    updaterLog: p.join(stateDir, UPDATER_LOG_NAME),
    lockFile: p.join(stateDir, 'lock'),
  };
}

export function dataLayout(platform: NodeJS.Platform, dataDir: string): DataLayout {
  const p = pathApi(platform);
  const updatesDir = p.join(dataDir, 'updates');
  return {
    dataDir,
    updatesDir,
    requestFile: p.join(updatesDir, 'request.json'),
    stagedDir: p.join(updatesDir, 'staged'),
    healthFile: p.join(dataDir, 'update-health.json'),
    reportedFile: p.join(updatesDir, 'reported.json'),
  };
}

export function versionDir(platform: NodeJS.Platform, base: string, version: string): string {
  return pathApi(platform).join(base, version);
}
