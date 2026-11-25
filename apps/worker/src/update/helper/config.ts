import { ConfigError, MAX_CONFIG_BYTES, resolveConfigPath } from '../../config/load.js';
import { configLocations, type PathHost, pathApi } from '../../config/paths.js';
import { type UpdateSettings, updateSettingsSchema, workerConfigSchema } from '../../config/schema.js';
import type { FileOps } from '../../fs/ops.js';
import {
  compareReleaseVersions,
  type LeaseKey,
  WorkerConfigDelivery,
  workerConfigHash,
  type WorkerSettings,
} from '@remyral/protocol';
import { join } from 'node:path';
import { z } from 'zod';
import { readUntrustedFile } from '../files.js';
import { WORKER_CONFIG_FILE } from '../../managed-config/store.js';

export interface UpdaterConfig {
  readonly path: string | null;
  readonly dataDir: string;
  readonly settings: UpdateSettings;
  /** p5-sandbox-ops: the master (lease keys for privileged prepare) and pinned keys, when configured. */
  readonly masterUrl?: string;
  readonly masterLeaseKeys?: readonly LeaseKey[];
  /** p5-machine-admin (ADR-0021): false when the root-owned config vetoes machine administration. */
  readonly allowMachineAdmin?: boolean;
  /**
   * `localCeiling.allowMachineAdmin: true` written explicitly: the owner opted in, also while host jobs on this machine
   * run without filesystem confinement (absent = the default: refused in that state).
   */
  readonly machineAdminOptIn?: boolean;
  /** The sandbox keys the helper's host-confinement check reads (host-confinement.ts). */
  readonly sandbox?: {
    readonly workerUser?: string | undefined;
    readonly linuxHostIsolation?: 'auto' | 'off' | undefined;
    readonly windowsJobSlots?: number | undefined;
  };
  /** p17-worker-managed: the panel's `updates.*` keys the updater took over (for its log). */
  readonly panelUpdates?: readonly string[];
  /** p17-worker-managed: the workspace root (the legacy ACL cleanup on Windows covers it too). */
  readonly workspaceRoot?: string;
}

type Raw = Record<string, unknown>;
const objOf = (v: unknown): Raw | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;

/**
 * p17-worker-managed: the panel's `updates.*` as the privileged updater takes them. The panel document lives in the
 * service account's data dir (`worker-config.json`), so the updater treats it as a hint that may only:
 *  - turn updates off (`enabled: false`) — never on when the root-owned file says `false`;
 *  - raise the floor (`minVersion`: the higher of both) — never lower it;
 *  - choose `channel` / `healthTimeoutSec` when the root-owned file does not set them (a written key wins).
 * A forged file can therefore at worst refuse updates or accept canary builds — still only releases signed with the
 * trusted release keys (docs/design/p17-worker-managed.md §2).
 */
export function updaterPanelOverlay(
  rootUpdates: unknown,
  settings: UpdateSettings,
  panel: NonNullable<WorkerSettings['updates']> | undefined,
): { settings: UpdateSettings; applied: string[] } {
  if (panel === undefined) return { settings, applied: [] };
  const written = objOf(rootUpdates) ?? {};
  const applied: string[] = [];
  let next: UpdateSettings = settings;
  if (panel.enabled === false && next.enabled) {
    next = { ...next, enabled: false };
    applied.push('enabled');
  }
  if (
    panel.minVersion !== undefined &&
    (next.minVersion === undefined || compareReleaseVersions(panel.minVersion, next.minVersion) > 0)
  ) {
    next = { ...next, minVersion: panel.minVersion };
    applied.push('minVersion');
  }
  if (panel.channel !== undefined && !Object.hasOwn(written, 'channel') && panel.channel !== next.channel) {
    next = { ...next, channel: panel.channel };
    applied.push('channel');
  }
  if (
    panel.healthTimeoutSec !== undefined &&
    !Object.hasOwn(written, 'healthTimeoutSec') &&
    panel.healthTimeoutSec !== next.healthTimeoutSec
  ) {
    next = { ...next, healthTimeoutSec: panel.healthTimeoutSec };
    applied.push('healthTimeoutSec');
  }
  return { settings: next, applied };
}

const StoredPanel = z.object({
  applied: z.object({ delivery: WorkerConfigDelivery }).nullable(),
});

/** The panel's `updates.*` from the worker's stored document (null: none, unreadable, unsafe or hand-edited). */
export async function readPanelUpdates(
  dataDir: string,
  read: (path: string, max: number) => Promise<Buffer | null> = readUntrustedFile,
): Promise<NonNullable<WorkerSettings['updates']> | null> {
  try {
    const raw = await read(join(dataDir, WORKER_CONFIG_FILE), 512 * 1024);
    if (raw === null) return null;
    const parsed = StoredPanel.safeParse(JSON.parse(raw.toString('utf8')));
    const d = parsed.success ? parsed.data.applied?.delivery : undefined;
    if (d === undefined || workerConfigHash(d.document) !== d.documentHash) return null;
    return d.document.settings?.updates ?? null;
  } catch {
    // Unsafe (a link, not a regular file), unreadable or not JSON: the root-owned settings alone apply.
    return null;
  }
}

/**
 * Reads the worker config for the **privileged** updater. Unlike the daemon's `loadConfig` it creates
 * nothing (a root process must not create the service account's data dir) and it insists that the
 * file is root/admin-owned and not writable by anyone else — the service account must not be able to
 * steer the updater (trusted keys, channel, floor) through it.
 */
export async function loadUpdaterConfig(
  ops: FileOps,
  host: PathHost,
  explicitPath: string | undefined,
  options: {
    optional?: boolean;
    /** Test seam; default 0 (root). */ ownerUid?: number;
    /** p17-worker-managed: read the panel's `updates.*` from the worker's stored document (apply / rollback). */
    panel?: boolean;
    /** Test seam for reading the stored document. */
    readPanel?: (path: string, max: number) => Promise<Buffer | null>;
  } = {},
): Promise<UpdaterConfig> {
  let resolved: { path: string; defaultDataDir: string };
  try {
    resolved = await resolveConfigPath(ops, host, { explicitPath });
  } catch (error) {
    if (options.optional === true && error instanceof ConfigError) {
      const fallback = configLocations(host)[0]?.defaultDataDir ?? '';
      return { path: null, dataDir: fallback, settings: updateSettingsSchema(host.platform).parse({}) };
    }
    throw error;
  }
  const { path } = resolved;
  const st = await ops.stat(path);
  if (st === null) {
    if (options.optional === true) {
      return {
        path: null,
        dataDir: resolved.defaultDataDir,
        settings: updateSettingsSchema(host.platform).parse({}),
      };
    }
    throw new ConfigError(`config file ${path} does not exist`, path);
  }
  if (host.platform !== 'win32') {
    if (st.uid !== (options.ownerUid ?? 0))
      throw new ConfigError(`${path} must be owned by root for the updater`, path);
    if ((st.mode & 0o022) !== 0) throw new ConfigError(`${path} must not be group/world-writable`, path);
  }
  const raw = await ops.readFile(path, MAX_CONFIG_BYTES);
  if (raw === null) throw new ConfigError(`config file ${path} does not exist`, path);
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`, path);
  }
  const parsed = workerConfigSchema(host.platform).safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(
      `invalid config ${path}:`,
      path,
      parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`),
    );
  }
  const dataDir = pathApi(host.platform).resolve(parsed.data.dataDir ?? resolved.defaultDataDir);
  const overlay =
    options.panel === true
      ? updaterPanelOverlay(
          objOf(json)?.updates,
          parsed.data.updates,
          (await readPanelUpdates(dataDir, options.readPanel)) ?? undefined,
        )
      : { settings: parsed.data.updates, applied: [] };
  return {
    path,
    dataDir,
    settings: overlay.settings,
    ...(overlay.applied.length === 0 ? {} : { panelUpdates: overlay.applied }),
    workspaceRoot: parsed.data.workspaceRoot,
    masterUrl: parsed.data.masterUrl,
    ...(parsed.data.masterLeaseKeys === undefined ? {} : { masterLeaseKeys: parsed.data.masterLeaseKeys }),
    allowMachineAdmin: parsed.data.localCeiling?.allowMachineAdmin !== false,
    machineAdminOptIn: parsed.data.localCeiling?.allowMachineAdmin === true,
    sandbox: {
      workerUser: parsed.data.sandbox.workerUser,
      linuxHostIsolation: parsed.data.sandbox.linuxHostIsolation,
      windowsJobSlots: parsed.data.sandbox.windowsJobSlots,
    },
  };
}
