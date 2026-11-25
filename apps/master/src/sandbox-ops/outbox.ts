import { SAFE_COMMANDS_MODES } from '@remyral/protocol/safe-commands';
import { z } from 'zod';

/**
 * p5-full-access (ADR-0020): a project's execution policy changed (host execution, unconfined, auto-approve). On the
 * shared outbox for the notification producer (owners/admins). Identifiers and booleans only; `job_id` stays NULL.
 */
export const OUTBOX_TOPIC_PROJECT_EXECUTION = 'project.execution';

const Flags = z.strictObject({
  hostExecution: z.boolean(),
  unconfined: z.boolean(),
  allowAutoApprove: z.boolean(),
  /** p6-safe-auto-approve (absent in rows written before it). */
  safeCommands: z.enum(SAFE_COMMANDS_MODES).optional(),
  /** p8-orchestration (absent in rows written before it). */
  subtasks: z.boolean().optional(),
  delegationRuntimes: z.array(z.string().max(32)).max(4).optional(),
});

export const ProjectExecutionOutboxPayload = z.strictObject({
  project: z.string().min(1).max(128),
  /** Audit-friendly id of the change (unique per change; the notification dedupe key). */
  changeId: z.string().min(1).max(64),
  userId: z.string().min(1).max(128),
  before: Flags,
  after: Flags,
});
export type ProjectExecutionOutboxPayload = z.infer<typeof ProjectExecutionOutboxPayload>;
