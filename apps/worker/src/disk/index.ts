import { DiskHygieneRun, Timestamp } from '@remyral/protocol';
import { z } from 'zod';
import { pathApi } from '../config/paths.js';
import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import type { HygieneState, HygieneStatePort } from './hygiene.js';

export { DiskHygiene, hygieneSettings, notOurs, type HygieneSettings, type HygieneState } from './hygiene.js';
export { nodeHygieneFs, type HygieneFs, type DiskEntry } from './fs.js';
export * from './sources.js';
export { measureUsage } from './usage.js';

export const DISK_HYGIENE_STATE_FILE = 'disk-hygiene.json';

const StoredState = z.object({
  v: z.literal(1),
  lastRun: DiskHygieneRun.nullable(),
  lastDailyAt: Timestamp.nullable(),
  lastLowDiskAt: Timestamp.nullable(),
});

/** `<dataDir>/disk-hygiene.json` (0600, atomic): the last run and when the daily / low-disk runs last happened. */
export function fileHygieneState(ops: FileOps, dataDir: string): HygieneStatePort {
  const file = pathApi(ops.platform).join(dataDir, DISK_HYGIENE_STATE_FILE);
  return {
    async load(): Promise<HygieneState | null> {
      const raw = await ops.readFile(file, 64 * 1024).catch(() => null);
      if (raw === null) return null;
      try {
        const parsed = StoredState.safeParse(JSON.parse(raw.toString('utf8')));
        if (!parsed.success) return null;
        const { v: _v, ...state } = parsed.data;
        return state;
      } catch {
        return null;
      }
    },
    async save(state) {
      await atomicWriteFile(ops, file, `${JSON.stringify({ v: 1, ...state })}\n`, { mode: 0o600 });
    },
  };
}
