import { z } from 'zod';
import { AttemptId, Epoch, NonNegativeInt, Sha256Hex } from './common.js';
import { INPUT_BUNDLE_LIMITS, inputBundlePathProblem } from './input-bundle-files.js';

export * from './input-bundle-files.js';

/**
 * p16-zip-job-input (docs/design/p16-zip-job-input.md, ADR-0060): the wire of a job input bundle (feature
 * `input-bundle-v1`; every message is a control job message, seq 0, never in a durable outbox).
 *
 *   ASSIGN_JOB execution.inputBundle {uploadId, files, totalBytes, bundleSha256}   pull these files into in/ first
 *   INPUT_BUNDLE_REQUEST {attemptId, epoch, requestId, op: list|read}             worker → master (job, leased)
 *   INPUT_BUNDLE_DATA {attemptId, epoch, requestId, status, …}                    master → worker: the answer
 *
 * The master answers only the holder of the job's live lease (attempt + epoch) and only from the bundle that job
 * recorded; the worker checks every file's size and SHA-256 against the listing and the listing against
 * `bundleSha256` (the SHA-256 over the paths and hashes) before the agent starts.
 */

export const INPUT_BUNDLE_FEATURE = 'input-bundle-v1';

export const InputBundlePath = z
  .string()
  .refine((p) => inputBundlePathProblem(p) === null, 'a safe relative path of a job input bundle');

/** ASSIGN_JOB `execution.inputBundle` (only to `input-bundle-v1` workers). */
export const AssignedInputBundle = z.object({
  uploadId: z.uuid(),
  files: z.number().int().min(1).max(INPUT_BUNDLE_LIMITS.maxFiles),
  totalBytes: z.number().int().min(0).max(INPUT_BUNDLE_LIMITS.maxTotalBytes),
  /** SHA-256 over the JSON array of [path, sha256] in bundle order (`bundleSha256`). */
  bundleSha256: Sha256Hex,
});
export type AssignedInputBundle = z.infer<typeof AssignedInputBundle>;

export const InputBundleOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), offset: NonNegativeInt }),
  z.object({
    op: z.literal('read'),
    index: z
      .number()
      .int()
      .min(0)
      .max(INPUT_BUNDLE_LIMITS.maxFiles - 1),
    offset: NonNegativeInt,
  }),
]);
export type InputBundleOp = z.infer<typeof InputBundleOp>;

/** worker → master `INPUT_BUNDLE_REQUEST` (job message; fenced by the attempt's live lease). */
export const InputBundleRequestPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  requestId: z.uuid(),
  op: InputBundleOp,
});
export type InputBundleRequestPayload = z.infer<typeof InputBundleRequestPayload>;

export const InputBundleEntry = z.object({
  index: z
    .number()
    .int()
    .min(0)
    .max(INPUT_BUNDLE_LIMITS.maxFiles - 1),
  path: InputBundlePath,
  size: z.number().int().min(0).max(INPUT_BUNDLE_LIMITS.maxFileBytes),
  sha256: Sha256Hex,
});
export type InputBundleEntry = z.infer<typeof InputBundleEntry>;

/** master → worker `INPUT_BUNDLE_DATA` (`requestId` of the request). */
export const InputBundleDataPayload = z.object({
  attemptId: AttemptId,
  epoch: Epoch,
  requestId: z.uuid(),
  status: z.enum(['ok', 'refused', 'not_found']),
  /** list: one page of entries and the total. */
  entries: z.array(InputBundleEntry).max(INPUT_BUNDLE_LIMITS.listPage).optional(),
  total: z.number().int().min(0).max(INPUT_BUNDLE_LIMITS.maxFiles).optional(),
  /** read: base64 of at most {@link INPUT_BUNDLE_LIMITS.chunkBytes} bytes from `offset`. */
  offset: NonNegativeInt.optional(),
  data: z
    .string()
    .max(Math.ceil(INPUT_BUNDLE_LIMITS.chunkBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64')
    .optional(),
  eof: z.boolean().optional(),
});
export type InputBundleDataPayload = z.infer<typeof InputBundleDataPayload>;
