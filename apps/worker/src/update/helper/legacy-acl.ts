import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { Logger } from '@remyral/observability';
import { windowsServiceSid } from '../../sandbox/host/identity.js';
import type { Exec } from './prepare.js';

/**
 * p17-worker-managed Part 5 (stale NT SERVICE\RemanaWorker permission on the Windows data folder): machines migrated from the pre-rename build still carry an allow entry for the old service account on their
 * data folders. Harmless (no such service runs any more) but untidy and confusing in an audit. The privileged updater
 * (SYSTEM — the worker's own account may not change ACLs) removes exactly that entry during its normal run, once per
 * install: only the old service's SID (`NT SERVICE\RemanaWorker`, computed like `sc.exe showsid`), only allow entries
 * (`/remove:g`), only on the folders the installer set ACLs on (data root, data dir, logs, workspace root). A marker in
 * the install's state dir records that it ran; a folder that does not exist is skipped.
 */

export const LEGACY_SERVICE_NAME = 'RemanaWorker';
export const LEGACY_ACL_MARKER = 'legacy-acl-cleaned.json';

export function legacySid(): string {
  return windowsServiceSid(LEGACY_SERVICE_NAME);
}

/** Whether `icacls <dir>` output lists an entry of exactly the legacy account (by name or SID, not a longer name). */
export function hasLegacyEntry(icaclsOutput: string, sid = legacySid()): boolean {
  const esc = sid.replaceAll('-', '\\-');
  return (
    /(^|[\s"])NT SERVICE\\RemanaWorker:/im.test(icaclsOutput) ||
    new RegExp(`(^|[\\s"*])${esc}:`, 'm').test(icaclsOutput)
  );
}

export interface LegacyAclDeps {
  readonly installDir: string;
  /** Folders the installer set ACLs on (data root, data dir, logs, workspace root). */
  readonly dirs: readonly string[];
  readonly exec: Exec;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/** Runs once per install (marker); returns the folders it changed, or null when it had already run. */
export async function removeLegacyAcl(d: LegacyAclDeps): Promise<string[] | null> {
  const marker = nodePath.join(d.installDir, 'state', LEGACY_ACL_MARKER);
  if ((await readFile(marker, 'utf8').catch(() => null)) !== null) return null;
  const sid = legacySid();
  const changed: string[] = [];
  let failed = false;
  for (const dir of [...new Set(d.dirs)]) {
    const show = await d.exec('icacls.exe', [dir], { timeoutMs: 60_000 });
    // A folder that does not exist (custom layouts) is not an error.
    if (show.code !== 0) continue;
    if (!hasLegacyEntry(show.stdout, sid)) continue;
    const r = await d.exec('icacls.exe', [dir, '/remove:g', `*${sid}`, '/C', '/Q'], { timeoutMs: 600_000 });
    if (r.code === 0) changed.push(dir);
    else {
      failed = true;
      d.logger.warn('legacy RemanaWorker ACL entry could not be removed', {
        dir,
        detail: (r.stderr || r.stdout).trim().slice(0, 300),
      });
    }
  }
  if (!failed) {
    await mkdir(nodePath.dirname(marker), { recursive: true }).catch(() => undefined);
    await writeFile(
      marker,
      JSON.stringify({ v: 1, at: (d.now?.() ?? new Date()).toISOString(), changed }),
    ).catch(() => undefined);
  }
  if (changed.length > 0) d.logger.info('legacy RemanaWorker ACL entries removed', { dirs: changed });
  return changed;
}
