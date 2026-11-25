import { subjectOf } from './refs.js';
import type { CiCheck, CiStatus, Comparison, GitProvider, MergeCheck } from './types.js';

/**
 * p16-git-providers: the parts of a test merge every REST provider does the same way (GitHub's own copy stays in
 * github-provider.ts). The target branch must still contain the base the job started from; the conflicting files a
 * provider does not name are approximated by the files changed on both sides since the merge base (a superset).
 */
export async function targetStillContainsBase(
  provider: Pick<GitProvider, 'branchHead' | 'compare'>,
  input: { readonly targetBranch: string; readonly headSha: string; readonly baseAtStart: string },
): Promise<{ readonly base: string } | { readonly check: MergeCheck }> {
  const base = await provider.branchHead(input.targetBranch);
  if (base === null) {
    return {
      check: {
        state: 'base_moved',
        baseSha: input.baseAtStart,
        headSha: input.headSha,
        reason: `target branch ${input.targetBranch} does not exist on the remote`,
      },
    };
  }
  const history = await provider.compare(input.baseAtStart, base);
  if (history.status !== 'ahead' && history.status !== 'identical') {
    return {
      check: {
        state: 'base_moved',
        baseSha: base,
        headSha: input.headSha,
        reason: `${input.targetBranch} was rewritten: the base at job start is no longer in its history`,
      },
    };
  }
  return { base };
}

/**
 * p22-output-delivery §1: a merge check from history alone, for when the provider has no answer — no pull request
 * (it could not be opened, or the job has none) or the provider is still computing (GitHub `mergeable: null`, GitLab
 * `checking`). `clean` when the target already contains the head or the head contains the target (a fast-forward), or
 * when the two sides since their merge base changed disjoint sets of paths (renames counted on both paths) — a
 * three-way merge of disjoint paths cannot conflict. Otherwise `unknown` (overlapping paths need a real test merge,
 * which only the provider can do; the refresh loop asks it again). Truncated comparisons are never trusted.
 */
export async function mergeabilityFromHistory(
  provider: Pick<GitProvider, 'compare'>,
  base: string,
  head: string,
): Promise<MergeCheck> {
  const unknown: MergeCheck = { state: 'unknown', baseSha: base, headSha: head };
  const ours = await provider.compare(base, head);
  if (ours.status !== 'diverged') return { state: 'clean', baseSha: base, headSha: head };
  const theirs = await provider.compare(head, base);
  if (ours.truncated || theirs.truncated) return unknown;
  const paths = (c: Comparison): Set<string> =>
    new Set(c.files.flatMap((f) => (f.previousPath === undefined ? [f.path] : [f.path, f.previousPath])));
  const theirPaths = paths(theirs);
  for (const p of paths(ours)) if (theirPaths.has(p)) return unknown;
  return { state: 'clean', baseSha: base, headSha: head };
}

export async function conflictsBetween(
  provider: Pick<GitProvider, 'compare'>,
  base: string,
  head: string,
  exactFiles: readonly string[] | null,
): Promise<MergeCheck> {
  const ours = await provider.compare(base, head);
  const theirs = await provider.compare(head, base);
  const theirFiles = new Set(theirs.files.map((f) => f.path));
  const files = exactFiles ?? ours.files.map((f) => f.path).filter((p) => theirFiles.has(p));
  return {
    state: 'conflicts',
    baseSha: base,
    headSha: head,
    files: [...files].slice(0, 300),
    headCommits: ours.commits.slice(-50).map((c) => ({ sha: c.sha, subject: subjectOf(c.message) })),
    baseCommits: theirs.commits.slice(-50).map((c) => ({ sha: c.sha, subject: subjectOf(c.message) })),
    precision: exactFiles === null ? 'approximate' : 'exact',
  };
}

/** `ahead` / `identical` / `behind` / `diverged` from the merge base of base and head. */
export function comparisonStatus(base: string, head: string, mergeBase: string): Comparison['status'] {
  if (base === head) return 'identical';
  if (mergeBase === base) return 'ahead';
  if (mergeBase === head) return 'behind';
  return 'diverged';
}

const PASSING = new Set(['success', 'neutral', 'skipped']);

/** Failure wins; then anything unfinished; success needs at least one signal (the GitHub rule). */
export function hostedCiState(checks: readonly CiCheck[]): CiStatus['state'] {
  if (checks.length === 0) return 'none';
  if (checks.some((c) => c.status === 'completed' && c.conclusion !== null && !PASSING.has(c.conclusion))) {
    return 'failure';
  }
  if (checks.some((c) => c.status !== 'completed')) return 'pending';
  return 'success';
}
