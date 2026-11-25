import type { Redactor, Revealable, SecretSet } from '@remyral/observability';
import { commitSubject, DEFAULT_GIT_IDENTITY } from '@remyral/protocol';
import type { GitAuthSource } from './git-auth.js';
import type { CommitRequest, PushRequest, PushResult, Workspace } from './manager.js';

/** The part of WorkspaceManager that records and publishes an attempt (p4-git-flow). */
export interface PublishPort {
  commit(ws: Workspace, req: CommitRequest): Promise<string>;
  push(ws: Workspace, req: PushRequest): Promise<PushResult>;
}

export interface PublishInput {
  /** Summary of the run (untrusted runtime text; only the first line is used as the subject). */
  readonly summary: string;
  readonly jobPrompt: string;
  /** p15-job-titles: the job's title (ASSIGN_JOB spec.title) — the commit subject. Absent (older master): the summary. */
  readonly jobTitle?: string | undefined;
  readonly gitToken?: Revealable;
  readonly gitTokenUsername?: string;
  /** p15-git-central: a fresh credential requested right before the push (wins over `gitToken`). */
  readonly gitAuth?: GitAuthSource;
  /** Daemon secret set: every injected value is refused in pushed content (pre-push scan). */
  readonly secrets?: SecretSet;
  readonly redactor?: Redactor;
  /**
   * p5-git-identity: author and committer of the publish commit (ASSIGN_JOB.gitIdentity). Absent (older master):
   * Remyral Agent <agent@remyral.invalid>.
   */
  readonly author?: { readonly name: string; readonly email: string };
}

/**
 * Records the attempt's final tree as one worker commit carrying `Remyral-Attempt: <attemptId>/<epoch>`
 * (ADR-0004 §3; agent commits inside a sandbox git view are scratch, p3-sandbox decision 1) and pushes
 * exactly `rac/<jobId>/<attemptId>` with `--force-with-lease` (expected: absent — an attempt publishes
 * once) after the pre-push secret scan. Called only after `assertTrustedGitUnchanged` passed. The master
 * verifies the result on the remote independently; this report is a claim.
 */
export async function publishAttempt(
  port: PublishPort,
  ws: Workspace,
  input: PublishInput,
): Promise<PushResult> {
  // p15-job-titles: with a job title (current masters) the subject is the title (≤ 72) and the summary's first line
  // follows in the body; without one (older master) the subject stays "remyral: <summary / prompt first line>".
  const firstSummary = (input.summary.split('\n', 1)[0] ?? '').trim();
  const message =
    input.jobTitle === undefined
      ? `remyral: ${commitSubject(undefined, firstSummary || (input.jobPrompt.split('\n', 1)[0] ?? '').trim())}\n\nJob ${ws.jobId}, attempt ${ws.attemptId}.`
      : `${commitSubject(input.jobTitle, firstSummary)}\n\n${firstSummary === '' ? '' : `${firstSummary.slice(0, 500)}\n\n`}Remyral job ${ws.jobId}, attempt ${ws.attemptId}.`;
  await port.commit(ws, {
    message,
    author: { ...(input.author ?? DEFAULT_GIT_IDENTITY) },
  });
  return port.push(ws, {
    expectedRemoteSha: null,
    ...(input.gitAuth === undefined ? {} : { gitAuth: input.gitAuth }),
    ...(input.gitToken === undefined ? {} : { gitToken: input.gitToken }),
    ...(input.gitTokenUsername === undefined ? {} : { gitTokenUsername: input.gitTokenUsername }),
    ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
    ...(input.redactor === undefined ? {} : { redactor: input.redactor }),
  });
}
