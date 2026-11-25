import { OpsCommandPayload, PrepareStep } from '@remyral/protocol';
import { z } from 'zod';
import { join } from 'node:path';

/**
 * What the worker and the privileged helper exchange for `sandbox.prepare` (p5-sandbox-ops, ADR-0019).
 *
 *   <dataDir>/sandbox/prepare-request.json     worker → helper: the signed OPS_COMMAND, as received
 *   <install>/state/prepare-result.json        helper → worker: per-step results (root/admin-owned, world-readable)
 *
 * The request is a hint: the helper trusts nothing in it except what the master's signature covers (worker id,
 * command id, window, `{privileged, localLogin}`), and it runs only its own fixed allowlist of steps.
 */

/** Marker compiled into helper bundles that implement privileged prepare (the worker greps for it). */
export const PREPARE_HELPER_MARKER = 'remana-prepare-helper/v1';

export const PREPARE_REQUEST_FILE = 'prepare-request.json';
export const PREPARE_RESULT_FILE = 'prepare-result.json';
export const MAX_PREPARE_REQUEST_BYTES = 64 * 1024;

/** Native paths: worker and helper run on the machine whose files these are (`platform` documents the OS). */
export function prepareRequestPath(_platform: NodeJS.Platform, dataDir: string): string {
  return join(dataDir, 'sandbox', PREPARE_REQUEST_FILE);
}

export function prepareResultPath(_platform: NodeJS.Platform, installDir: string): string {
  return join(installDir, 'state', PREPARE_RESULT_FILE);
}

export const PrepareRequest = z.strictObject({
  v: z.literal(1),
  workerId: z.string().min(1).max(128),
  command: OpsCommandPayload,
});
export type PrepareRequest = z.infer<typeof PrepareRequest>;

export const PrepareResult = z.strictObject({
  v: z.literal(1),
  commandId: z.uuid(),
  state: z.enum(['running', 'done', 'refused']),
  /** Why the helper refused the request (bad signature, expired, replay, …). */
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  detail: z.string().max(300).optional(),
  steps: z.array(PrepareStep).max(24),
  /** The local config changed: the worker restarts to apply it. */
  restartRequired: z.boolean(),
  /**
   * The helper itself restarts the worker's service after this result (live finding 2026-10-17, Windows: privileges
   * granted to the service account reach it only with a new service logon). The worker then does not restart
   * itself. Optional: helpers before this change never write it.
   */
  serviceRestart: z.boolean().optional(),
  updatedAt: z.iso.datetime(),
});
export type PrepareResult = z.infer<typeof PrepareResult>;
