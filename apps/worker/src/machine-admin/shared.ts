import { join } from 'node:path';
import { AdminGrant, AdminOp, AdminSessionGrant, Identifier } from '@remyral/protocol';
import { z } from 'zod';

/**
 * Files shared by the worker (unprivileged) and the root/SYSTEM helper's elevated broker (p5-machine-admin,
 * ADR-0021). The direction of trust is one way:
 *
 *  - the worker may only **ask**: it writes requests into its own data dir (`<dataDir>/machine-admin/…`). The
 *    helper reads them defensively (no symlinks, size caps, strict schemas) and trusts nothing in them but what the
 *    master signed: the session grant and each command grant are verified with the master's lease keys the helper
 *    obtains itself.
 *  - the helper **answers** only in its own install dir (`<install>/state/machine-admin/<sessionId>/`), never in
 *    the worker's data dir (a SYSTEM/root process must not write where a lower-privileged account can plant links).
 *    The directory is readable by the worker's service account and nobody else (ACL / group).
 */

/** Marker in the updater bundle: this helper can run admin sessions. */
export const ADMIN_HELPER_MARKER = 'remana-admin-helper/v1';

export const MAX_ADMIN_REQUEST_BYTES = 1024 * 1024;
export const MAX_ADMIN_RESULT_BYTES = 256 * 1024;
/** The worker touches its heartbeat file this often; the broker ends a session whose heartbeat is older than 3×. */
export const ADMIN_HEARTBEAT_MS = 15_000;

/** Native paths: the worker and the helper run on the machine whose files these are. */
export function adminRequestRoot(dataDir: string): string {
  return join(dataDir, 'machine-admin');
}

export function sessionRequestPath(dataDir: string): string {
  return join(adminRequestRoot(dataDir), 'session-request.json');
}

export function sessionDir(dataDir: string, sessionId: string): string {
  return join(adminRequestRoot(dataDir), 'sessions', sessionId);
}

export function commandRequestDir(dataDir: string, sessionId: string): string {
  return join(sessionDir(dataDir, sessionId), 'requests');
}

export function heartbeatPath(dataDir: string, sessionId: string): string {
  return join(sessionDir(dataDir, sessionId), 'alive');
}

export function endMarkerPath(dataDir: string, sessionId: string): string {
  return join(sessionDir(dataDir, sessionId), 'end');
}

/** Helper-owned answers: `<install>/state/machine-admin/<sessionId>/`. */
export function brokerDir(installDir: string, sessionId: string): string {
  return join(installDir, 'state', 'machine-admin', sessionId);
}

export function brokerStatusPath(installDir: string, sessionId: string): string {
  return join(brokerDir(installDir, sessionId), 'status.json');
}

export function brokerResultPath(installDir: string, sessionId: string, requestId: string): string {
  return join(brokerDir(installDir, sessionId), `${requestId}.json`);
}

/** Working directory elevated commands start in when the agent names none. */
export function brokerWorkDir(installDir: string, sessionId: string): string {
  return join(brokerDir(installDir, sessionId), 'work');
}

/** What the worker writes to ask for an elevated session (the grant as the master signed it). */
export const AdminSessionRequest = z.strictObject({
  v: z.literal(1),
  workerId: Identifier,
  jobId: z.uuid(),
  attemptId: z.uuid(),
  epoch: z.number().int().min(0),
  session: AdminSessionGrant,
});
export type AdminSessionRequest = z.infer<typeof AdminSessionRequest>;

/** One elevated command as the worker hands it over (op + the master's grant). */
export const AdminCommandRequest = z.strictObject({
  v: z.literal(1),
  requestId: z.uuid(),
  op: AdminOp,
  grant: AdminGrant,
});
export type AdminCommandRequest = z.infer<typeof AdminCommandRequest>;

export const AdminSessionStatus = z.object({
  v: z.literal(1),
  sessionId: z.uuid(),
  state: z.enum(['ready', 'refused', 'ended']),
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  detail: z.string().max(500).optional(),
  pid: z.number().int().optional(),
  expiresAt: z.string().max(40).optional(),
  updatedAt: z.string().max(40),
});
export type AdminSessionStatus = z.infer<typeof AdminSessionStatus>;

export const AdminCommandResult = z.object({
  v: z.literal(1),
  requestId: z.uuid(),
  state: z.enum(['succeeded', 'failed', 'refused']),
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().int().min(0),
  /** Tail of stdout / stderr (bounded; the worker redacts before anything leaves it). */
  stdout: z.string().max(64 * 1024),
  stderr: z.string().max(64 * 1024),
  truncated: z.boolean(),
  file: z
    .object({
      path: z.string().max(1024),
      bytes: z.number().int().min(0),
      sha256Before: z.string().nullable(),
      sha256After: z.string().nullable(),
      /** read_file: base64 of the bytes read. */
      content: z
        .string()
        .max(400 * 1024)
        .optional(),
    })
    .optional(),
});
export type AdminCommandResult = z.infer<typeof AdminCommandResult>;
