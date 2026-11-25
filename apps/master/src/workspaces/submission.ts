import { MAX_INPUTS, MAX_INPUTS_TOTAL_BYTES } from '@remyral/protocol';
import { authorize, type Subject } from '../authz/model.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { PreparedInput, WorkspaceService } from './service.js';

/** Upload body of a file (`POST /jobs`, `POST /workflows/:id/runs`, automation targets). */
export interface UploadedFile {
  readonly name: unknown;
  readonly contentBase64: unknown;
}

/**
 * Input files of a submission (job, workflow run): uploads validated and scanned, plus the artifacts of a job to
 * continue from — which the caller must be able to read (`jobs.read` in its project; anything else is "not found").
 * Limits apply to the whole list. Throws HttpError 400/404/413/422 (names, rules, lines — never content).
 */
export async function prepareSubmissionInputs(deps: {
  readonly workspaces: WorkspaceService;
  readonly db: Queryable;
  readonly subject: Subject;
  readonly uploads: readonly UploadedFile[];
  readonly continueFrom: string | undefined;
}): Promise<PreparedInput[]> {
  let inputs = deps.workspaces.prepareUploads(deps.uploads);
  const from = deps.continueFrom;
  if (from === undefined) return inputs;
  await requireReadableJob(deps.db, deps.subject, from);
  inputs = [
    ...inputs,
    ...(await deps.workspaces.inputsFromJob(from, new Set(inputs.map((i) => i.ref.name)))),
  ];
  if (inputs.length > MAX_INPUTS) {
    throw new HttpError(
      400,
      'invalid_inputs',
      `At most ${String(MAX_INPUTS)} input files per job (uploads + continued artifacts).`,
      {},
      {},
      { reason: 'max_with_artifacts', max: MAX_INPUTS },
    );
  }
  const total = inputs.reduce((n, i) => n + i.ref.sizeBytes, 0);
  if (total > MAX_INPUTS_TOTAL_BYTES) {
    throw new HttpError(
      413,
      'input_too_large',
      `Inputs exceed ${String(MAX_INPUTS_TOTAL_BYTES)} bytes in total.`,
      {},
      {},
      { maxBytes: MAX_INPUTS_TOTAL_BYTES },
    );
  }
  return inputs;
}

/** 404 unless `subject` may read job `jobId` (any project it can see). Returns the job's project. */
export async function requireReadableJob(db: Queryable, subject: Subject, jobId: string): Promise<string> {
  const src = await db.query<{ project: string }>('SELECT project FROM jobs WHERE id = $1', [jobId]);
  const project = src.rows[0]?.project;
  if (project === undefined || !authorize(subject, 'jobs.read', { project }).allow) {
    throw new HttpError(
      404,
      'job_not_found',
      'continueFrom: job not found.',
      {},
      {},
      { reason: 'continue_from' },
    );
  }
  return project;
}
