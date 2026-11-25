import { REPO_INPUTS_FEATURE } from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';

/**
 * p19-repo-job-inputs (docs/design/p19-repo-job-inputs.md): input files of a REPOSITORY job (chat attachments, earlier
 * job outputs, continueFrom) reach only machines with `repo-inputs-v1` (placement reason `repo_inputs_unsupported`).
 * Before a job or a chat card with such files is accepted, at least one approved machine of the fleet must advertise
 * it — otherwise the request is refused with a clear "update the machine" message instead of a job that can never be
 * placed.
 */
export async function repoInputsMachines(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM workers
      WHERE features ? $1 AND approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL`,
    [REPO_INPUTS_FEATURE],
  );
  return rows[0]?.n ?? 0;
}

/** The refusal (400 `invalid_job`, reason `inputs_worker_update`) when no machine can take repository job inputs. */
export function repoInputsUpdateError(): HttpError {
  return new HttpError(
    400,
    'invalid_job',
    'Input files for a repository job need a machine with the repo-inputs-v1 feature, and none has it yet: the machines must be updated first (makine güncellenmeli). Until then, use a workspace project or describe the files in the prompt.',
    {},
    {},
    { reason: 'inputs_worker_update' },
  );
}

/** Throws {@link repoInputsUpdateError} when no approved machine advertises `repo-inputs-v1`. */
export async function assertRepoInputsReady(db: Queryable): Promise<void> {
  if ((await repoInputsMachines(db)) === 0) throw repoInputsUpdateError();
}

/** p19-repo-inputs-composer-workflows: may the composer offer input files / run files for this project right now? */
export interface InputFilesAvailability {
  readonly available: boolean;
  /** Why not: `inputs_worker_update` (repository project, no `repo-inputs-v1` machine), `inputs_project`. */
  readonly reason: 'inputs_worker_update' | 'inputs_project' | null;
}

/**
 * The composer's view of the gate above (job file field and workflow run files): a workspace project always takes
 * files; a repository project while a machine advertises `repo-inputs-v1`; anything else never. The API enforces the
 * same rule again on submission.
 */
export async function inputFilesAvailability(
  db: Queryable,
  kind: string | null,
): Promise<InputFilesAvailability> {
  if (kind === 'workspace') return { available: true, reason: null };
  if (kind !== 'repository') return { available: false, reason: 'inputs_project' };
  return (await repoInputsMachines(db)) > 0
    ? { available: true, reason: null }
    : { available: false, reason: 'inputs_worker_update' };
}
