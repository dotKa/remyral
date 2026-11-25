import {
  DISK_USAGE_NAMES,
  type DiskUsageEntry,
  type DiskUsageName,
  type DiskUsageReport,
} from '@remyral/protocol';
import { pathApi } from '../config/paths.js';
import type { HygieneFs } from './fs.js';

/**
 * p17-disk-selfclean: what uses the space at the top level of the data dir and of the workspace root — measured only
 * when a run could not reach its target, so the machine page can say where the space went. Only names the worker itself
 * creates are reported (DISK_USAGE_NAMES); every other entry (and any file at the top level) is summed into `other`,
 * so a user's file or directory name never leaves the machine. Links are never followed.
 */

const KNOWN: ReadonlySet<string> = new Set(DISK_USAGE_NAMES);

/** Entries walked per top-level directory before its size is reported as a lower bound. */
const MAX_ENTRIES = 2_000_000;

export async function measureUsage(
  fs: HygieneFs,
  dataDir: string,
  workspaceRoot: string,
  now: Date,
): Promise<DiskUsageReport> {
  const p = pathApi(fs.platform);
  const scan = { partial: false };
  const rel = p.relative(dataDir, workspaceRoot);
  // The data dir's top-level entry that holds the workspace root (when it lies inside the data dir).
  const holder =
    rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel) ? rel.split(/[\\/]/)[0] : undefined;

  const level = async (dir: string, isData: boolean): Promise<DiskUsageEntry[]> => {
    const sums = new Map<DiskUsageName, number>();
    for (const e of await fs.list(dir)) {
      let name: DiskUsageName = 'other';
      if (isData && holder !== undefined && e.name === holder) name = 'workspace-root';
      else if (e.kind === 'dir' && KNOWN.has(e.name) && e.name !== 'other' && e.name !== 'workspace-root')
        name = e.name as DiskUsageName;
      let bytes = e.size;
      if (e.kind === 'dir') {
        const t = await fs.treeSize(p.join(dir, e.name), MAX_ENTRIES);
        if (t.partial) scan.partial = true;
        bytes = t.bytes;
      }
      sums.set(name, (sums.get(name) ?? 0) + bytes);
    }
    return [...sums.entries()]
      .map(([name, bytes]) => ({ name, bytes: Math.min(bytes, Number.MAX_SAFE_INTEGER) }))
      .sort((a, b) => b.bytes - a.bytes);
  };

  const data = await level(dataDir, true);
  const ws = await level(workspaceRoot, false);
  return {
    at: now.toISOString(),
    dataDir: data,
    workspaceRoot: ws,
    ...(scan.partial ? { partial: true } : {}),
  };
}
