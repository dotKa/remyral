import { z } from 'zod';

/**
 * p6-deploy-pipeline (ADR-0028): deploy notifications on the shared outbox — an ops action waits for an approval
 * (`waiting`: the project's approvers) or failed / was refused while nobody watched (`failed`: the project's
 * operators). Identifiers only; the producer reads names and enumerations, never provider error text.
 */
export const OUTBOX_TOPIC_OPS_ACTION = 'ops.action';

export const OpsActionOutboxPayload = z.strictObject({
  actionId: z.uuid(),
  event: z.enum(['waiting', 'failed']),
});
export type OpsActionOutboxPayload = z.infer<typeof OpsActionOutboxPayload>;

/**
 * p6-deploy-on-success (ADR-0030): a deploy on success ended (deployed, failed or refused) — the job's creator is
 * told. Identifiers only; the producer reads the row.
 */
export const OUTBOX_TOPIC_DEPLOY_ON_SUCCESS = 'ops.deploy_on_success';

export const DeployOnSuccessOutboxPayload = z.strictObject({ id: z.uuid() });
export type DeployOnSuccessOutboxPayload = z.infer<typeof DeployOnSuccessOutboxPayload>;
