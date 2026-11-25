/**
 * p15-merge-approvals item 2: under git flow (ASSIGN_JOB `execution.pushResult`) the worker commits and pushes the
 * attempt branch itself after a successful run, and under the sandbox the agent cannot write the `.git` directory
 * ("cannot lock ref 'HEAD'"). Agents that try to commit anyway report "I couldn't commit" in their summary, which
 * reads like a failure. The preamble tells every runtime (Claude Code, Codex, Pi, OpenCode — the prompt is shared) not
 * to commit; the note on the reported summary says what the platform did.
 */
export const GIT_FLOW_PREAMBLE =
  '[Remyral git] Do not run git commit/push; leave your changes in the working tree — the platform commits and ' +
  'pushes them after the run. (It pushes them to its own attempt branch; then a person or the project policy ' +
  'decides the merge.) The .git directory may be read-only here (e.g. "cannot lock ref"): that is expected, not a ' +
  'problem to report. Do not create branches or tags either.';

/** Matches an agent summary that reports a failed or skipped commit/push (EN and TR, case-insensitive). */
const COMMIT_TROUBLE =
  /(could ?n[o']?t|can ?n[o']?t|unable to|failed to|did ?n[o']?t|not able to)\s+(git\s+)?(commit|push)|cannot lock ref|commit(le)?(yemedim|edemedim|lenemedi|yapamadım)|push(layamadım| edemedim)/i;

/**
 * The summary reported in JOB_RESULT after the platform pushed `pushed`: the agent's text plus one line that says the
 * changes were committed and pushed by the platform — so "I couldn't commit" is not read as a failure.
 */
export function withPlatformCommitNote(
  summary: string,
  pushed: { readonly branch: string; readonly sha: string } | null,
): string {
  if (pushed === null) return summary;
  const note = COMMIT_TROUBLE.test(summary)
    ? `Note: the agent cannot commit under git flow by design; the platform committed and pushed the changes as ${pushed.branch}@${pushed.sha.slice(0, 12)}.`
    : `The platform committed and pushed the changes as ${pushed.branch}@${pushed.sha.slice(0, 12)}.`;
  return summary.trim() === '' ? note : `${summary.trimEnd()}\n\n${note}`;
}
