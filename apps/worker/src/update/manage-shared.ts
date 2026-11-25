import { join } from 'node:path';
import { ManageStep, MANAGE_HELPER_MARKER } from '@remyral/protocol';
import { z } from 'zod';

/**
 * What the worker and the privileged helper exchange for `worker.uninstall` / `helper.manage` (p17-worker-managed).
 *
 *   <dataDir>/sandbox/prepare-request.json     worker → helper: the signed OPS_COMMAND (the same trigger as
 *                                              sandbox.prepare: no new OS unit or task is needed)
 *   <install>/state/manage-result.json         helper → worker: accepted / done / refused and the steps
 *
 * Like prepare, the request is only a hint: the helper trusts nothing in it beyond what the master's signature covers
 * and runs only its own fixed, per-OS steps.
 */

export { MANAGE_HELPER_MARKER };

export const MANAGE_RESULT_FILE = 'manage-result.json';

export function manageResultPath(installDir: string): string {
  return join(installDir, 'state', MANAGE_RESULT_FILE);
}

export const ManageResult = z.strictObject({
  v: z.literal(1),
  commandId: z.uuid(),
  /** `accepted`: an uninstall is scheduled (the machine goes away while it runs); `done`: a helper.manage finished. */
  state: z.enum(['accepted', 'running', 'done', 'refused']),
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  detail: z.string().max(300).optional(),
  steps: z.array(ManageStep).max(16),
  updatedAt: z.iso.datetime(),
});
export type ManageResult = z.infer<typeof ManageResult>;
