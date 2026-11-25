import { MAX_INPUTS, MAX_INPUTS_TOTAL_BYTES } from '@remyral/protocol';
import { authorize, type Subject } from '../authz/model.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { assertRepoInputsReady } from '../jobs/repo-inputs.js';
import { chatAttachmentInputs } from './attachments.js';
import {
  inputsFromArtifacts,
  inputsFromJobArtifacts,
  type PreparedInput,
  projectKind,
} from '../workspaces/service.js';

/**
 * Input files of a chat job draft (p5-ops-chat-next, design note §7): `continueFrom` (every committed artifact of a
 * previous job, like the composer's "Continue from") and `inputArtifacts` (chosen artifacts of jobs). Only ids travel
 * in the draft — the content is read from the master's own artifact store, validated and secret-scanned exactly like
 * `POST /jobs`, once when the draft is made (so the card is honest) and again at confirmation for the confirming
 * user (the source may have become invisible, or its artifacts changed).
 */
export interface ChatInputRefs {
  readonly continueFrom?: string;
  /** p8-chat-attachments-mentions: sent attachments of the draft's own conversation. */
  readonly chatAttachments?: readonly string[];
  readonly inputArtifacts?: readonly { readonly jobId: string; readonly artifactId: string }[];
}

export function hasInputRefs(r: ChatInputRefs): boolean {
  return (
    r.continueFrom !== undefined ||
    (r.inputArtifacts ?? []).length > 0 ||
    (r.chatAttachments ?? []).length > 0
  );
}

/** The refs of a tool input or a stored draft payload (anything else is ignored). */
export function inputRefsOf(v: Record<string, unknown>): ChatInputRefs {
  const out: {
    continueFrom?: string;
    inputArtifacts?: { jobId: string; artifactId: string }[];
    chatAttachments?: string[];
  } = {};
  if (typeof v.continueFrom === 'string') out.continueFrom = v.continueFrom;
  if (Array.isArray(v.chatAttachments)) {
    out.chatAttachments = v.chatAttachments.filter((a): a is string => typeof a === 'string');
  }
  if (Array.isArray(v.inputArtifacts)) {
    out.inputArtifacts = v.inputArtifacts
      .filter(
        (a): a is { jobId: string; artifactId: string } =>
          a !== null &&
          typeof a === 'object' &&
          typeof (a as { jobId?: unknown }).jobId === 'string' &&
          typeof (a as { artifactId?: unknown }).artifactId === 'string',
      )
      .map((a) => ({ jobId: a.jobId, artifactId: a.artifactId }));
  }
  return out;
}

/** The subject may read the job (any project it can see); otherwise "not found", like the normal API. */
async function readableJob(db: Queryable, subject: Subject, jobId: string): Promise<void> {
  const { rows } = await db.query<{ project: string }>('SELECT project FROM jobs WHERE id = $1', [jobId]);
  const project = rows[0]?.project;
  if (project === undefined || !authorize(subject, 'jobs.read', { project }).allow) {
    throw new HttpError(
      404,
      'job_not_found',
      `Job ${jobId} not found.`,
      {},
      {},
      { reason: 'id', job: jobId },
    );
  }
}

/**
 * Validates the refs for `subject` and returns the prepared inputs (throws 400 / 404 / 413 / 422 HttpErrors with
 * the same codes as `POST /jobs`). Workspace projects, and since p19-repo-job-inputs repository projects while at
 * least one machine advertises `repo-inputs-v1` (else 400 `inputs_worker_update`: "makine güncellenmeli").
 */
export async function prepareChatInputs(
  db: Queryable,
  subject: Subject,
  project: string,
  refs: ChatInputRefs,
  /** The conversation the draft belongs to (chat attachments must come from it). */
  threadId: string | null = null,
): Promise<PreparedInput[]> {
  if (!hasInputRefs(refs)) return [];
  const kind = await projectKind(db, project);
  if (kind === 'repository') {
    // p19-repo-job-inputs: a scratch in/ next to the checkout — only on machines that can do it.
    await assertRepoInputsReady(db);
  } else if (kind !== 'workspace') {
    throw new HttpError(
      400,
      'invalid_job',
      'Input files (continueFrom, inputArtifacts, chatAttachments) are only for workspace and repository projects.',
      {},
      {},
      { reason: 'inputs_project' },
    );
  }
  const artifacts = refs.inputArtifacts ?? [];
  const jobs = new Set([
    ...(refs.continueFrom === undefined ? [] : [refs.continueFrom]),
    ...artifacts.map((a) => a.jobId),
  ]);
  for (const id of jobs) await readableJob(db, subject, id);
  const seen = new Set<string>();
  for (const a of artifacts) {
    const key = `${a.jobId}/${a.artifactId}`;
    if (seen.has(key))
      throw new HttpError(
        400,
        'invalid_inputs',
        `Artifact ${a.artifactId} is listed twice.`,
        {},
        {},
        { reason: 'artifact_twice', artifact: a.artifactId },
      );
    seen.add(key);
  }
  let inputs = await inputsFromArtifacts(db, artifacts, new Set());
  if (refs.continueFrom !== undefined) {
    inputs = [
      ...inputs,
      ...(await inputsFromJobArtifacts(db, refs.continueFrom, new Set(inputs.map((i) => i.ref.name)))),
    ];
  }
  if ((refs.chatAttachments ?? []).length > 0) {
    inputs = [
      ...inputs,
      ...(await chatAttachmentInputs(
        db,
        subject.userId,
        threadId,
        refs.chatAttachments ?? [],
        new Set(inputs.map((i) => i.ref.name)),
      )),
    ];
  }
  if (inputs.length > MAX_INPUTS) {
    throw new HttpError(
      400,
      'invalid_inputs',
      `At most ${String(MAX_INPUTS)} input files per job.`,
      {},
      {},
      { reason: 'max_per_job', max: MAX_INPUTS },
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
