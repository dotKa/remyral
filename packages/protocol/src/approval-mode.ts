import { type KeyObject, sign } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import { ApprovalPolicy, AttemptId, Ed25519Signature, Epoch, Identifier, Text, Timestamp } from './common.js';
import { LeaseKey } from './lease.js';

/**
 * p6-approval-mode-switch (docs/design/p6-approval-mode-switch.md): changing a running job's approval mode.
 *
 * - `SET_APPROVAL_POLICY` (master → worker, sequenced, job message, only to workers advertising
 *   `approval-mode-switch-v1`): the job's new mode, fenced by attempt + epoch, ordered by a per-job `seq` and signed
 *   with a master lease key over worker, job, attempt, epoch, change id, seq, mode, opt-in and issue time.
 * - `APPROVAL_POLICY_STATUS` (worker → master, control, job message): whether and how the worker applied it.
 *
 * Pure schemas and statements, shared by master and worker.
 */

export const APPROVAL_MODE_SWITCH_FEATURE = 'approval-mode-switch-v1';

export const ApprovalModeSignature = z.object({ kid: LeaseKey.shape.kid, signature: Ed25519Signature });
export type ApprovalModeSignature = z.infer<typeof ApprovalModeSignature>;

export const SetApprovalPolicyPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  /** The master's change row (`job_approval_mode_changes.id`). */
  changeId: z.uuid(),
  /** Per-job change number (1, 2, …): the worker applies only a higher seq than the last one it applied. */
  seq: z.number().int().min(1).max(1_000_000),
  approvalPolicy: ApprovalPolicy,
  /**
   * ADR-0020: the project allows `allow-all` (re-read at the change). The worker refuses `allow-all` without it,
   * like at admission (`execution.autoApproveOptIn`).
   */
  autoApproveOptIn: z.boolean(),
  /** Audit identity of the human who changed it (user id). */
  changedBy: Identifier,
  issuedAt: Timestamp,
  /** Absent only when the master has no lease-signing key; a worker with trusted keys then refuses it. */
  signature: ApprovalModeSignature.optional(),
});
export type SetApprovalPolicyPayload = z.infer<typeof SetApprovalPolicyPayload>;

/** How a worker applied a change: the runtime switched itself, the worker's gate enforces it, only partly, or later. */
export const ApprovalModeApplication = z.enum(['live', 'gate', 'partial', 'next_turn']);
export type ApprovalModeApplication = z.infer<typeof ApprovalModeApplication>;

export const ApprovalPolicyStatusPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  changeId: z.uuid(),
  seq: z.number().int().min(1).max(1_000_000),
  outcome: z.enum(['applied', 'refused']),
  /** With `applied`. */
  application: ApprovalModeApplication.optional(),
  /** Plain-language explanation (why partial / refused); never runtime output. */
  detail: Text,
});
export type ApprovalPolicyStatusPayload = z.infer<typeof ApprovalPolicyStatusPayload>;

export const APPROVAL_MODE_CONTEXT = 'remana-approval-mode/v1\n';

/** What a master signs for one SET_APPROVAL_POLICY. */
export interface ApprovalModeBinding {
  readonly workerId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly epoch: number;
  readonly changeId: string;
  readonly seq: number;
  readonly approvalPolicy: ApprovalPolicy;
  readonly autoApproveOptIn: boolean;
  readonly changedBy: string;
  readonly issuedAt: string;
}

/** Exact bytes a master signs for a SET_APPROVAL_POLICY (every field on its own line, fixed order). */
export function approvalModeStatement(b: ApprovalModeBinding): Buffer {
  return Buffer.from(
    [
      APPROVAL_MODE_CONTEXT.trimEnd(),
      b.workerId,
      b.jobId,
      b.attemptId,
      String(b.epoch),
      b.changeId,
      String(b.seq),
      b.approvalPolicy,
      b.autoApproveOptIn ? 'opt-in' : 'no-opt-in',
      b.changedBy,
      b.issuedAt,
    ].join('\n'),
    'utf8',
  );
}

export function signApprovalMode(
  b: ApprovalModeBinding,
  kid: string,
  privateKey: KeyObject,
): ApprovalModeSignature {
  return { kid, signature: sign(null, approvalModeStatement(b), privateKey).toString('base64url') };
}

/** Verifies a SET_APPROVAL_POLICY signature against trusted master keys. Never throws. */
export function verifyApprovalMode(
  b: ApprovalModeBinding,
  signature: ApprovalModeSignature | undefined,
  keys: readonly LeaseKey[],
): 'ok' | 'missing' | 'unknown_key' | 'bad_signature' {
  if (signature === undefined) return 'missing';
  const key = keys.find((k) => k.kid === signature.kid);
  if (key === undefined) return 'unknown_key';
  return verifyEd25519(key.publicKey, approvalModeStatement(b), signature.signature) ? 'ok' : 'bad_signature';
}

/** Codex / Claude / Pi / OpenCode adapters and the master share these words for the UI. */
export const APPROVAL_MODE_APPLICATION_TEXT: Readonly<Record<ApprovalModeApplication, string>> = {
  live: 'applied live by the runtime',
  gate: 'enforced by the worker’s approval gate',
  partial: 'only partly applied',
  next_turn: 'applies from the runtime’s next turn',
};
