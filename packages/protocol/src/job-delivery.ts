import { z } from 'zod';

/**
 * p22-output-delivery (docs/design/p22-output-delivery.md): how a repository job delivers its result — `merge` (the
 * verified attempt branch waits for the protected merge decision; the default) or `outputs` (the files the attempt
 * added or changed become the job's outputs and the job succeeds without a merge). JobSpec `delivery`.
 */
export const JOB_DELIVERIES = ['merge', 'outputs'] as const;
export const JobDelivery = z.enum(JOB_DELIVERIES);
export type JobDelivery = z.infer<typeof JobDelivery>;
