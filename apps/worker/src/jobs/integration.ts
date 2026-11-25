import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Redactor } from '@remyral/observability';
import {
  type ConflictFileDetail,
  INTEGRATION_LIMITS,
  type IntegrationPlan,
  type IntegrationReport,
  type IntegrationStep,
} from '@remyral/protocol';
import type { GitRunner } from '../workspace/git.js';

/**
 * p11-merge-pipeline (ADR-0041, docs/design/p11-merge-pipeline.md §4): the deterministic integration step on a worker.
 * No agent runs. In the attempt's worktree (checked out at the integration head the master planned from), each plan
 * step's verified commit is merged in order with real git (`merge --no-ff`); a step that carries a conflict-resolution
 * result takes exactly the resolution's version of the conflicting files. The first conflict stops the round: the merge
 * is aborted and the conflicting files are reported with bounded conflict markers and both sides' diffs.
 *
 * Hardening beyond the workspace's git (hooks, global/system config, filters off — workspace/git.ts): attributes are read
 * from the empty tree (a branch that adds `* merge=union` / `-merge` / a custom driver cannot turn a conflict into a
 * silent clean merge or run anything), no rerere, no signature verification, no editor.
 */

/** The empty tree: attributes are never read from the repository (same rule as the master's git, git-exec.ts). */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const CONFLICT_LINE = /^(<{7}|>{7}|={7}|\|{7})( |$)/m;

export interface IntegrationRunInput {
  readonly git: Pick<GitRunner, 'run'>;
  /** The attempt's worktree (on `rac/<job>/<attempt>` at the planned integration head). */
  readonly cwd: string;
  readonly plan: IntegrationPlan;
  /** Author / committer of the merge commits (the project's git identity). */
  readonly author: { readonly name: string; readonly email: string };
  readonly redactor: Redactor;
  readonly signal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
}

export interface IntegrationRunResult {
  readonly report: IntegrationReport;
  /** One line for JOB_RESULT.summary. */
  readonly summary: string;
}

export class IntegrationAborted extends Error {
  constructor() {
    super('integration step cancelled');
  }
}

/** The `-c` pairs every integration git call adds to the workspace hardening. */
export function integrationGitConfig(
  author: { readonly name: string; readonly email: string },
  platform: NodeJS.Platform = process.platform,
): [string, string][] {
  return [
    ['user.name', author.name],
    ['user.email', author.email],
    ['attr.tree', EMPTY_TREE],
    ['core.attributesFile', platform === 'win32' ? 'NUL' : '/dev/null'],
    ['merge.conflictStyle', 'diff3'],
    ['merge.renames', 'true'],
    ['merge.verifySignatures', 'false'],
    ['merge.log', 'false'],
    ['rerere.enabled', 'false'],
    ['core.editor', 'true'],
    ['commit.gpgSign', 'false'],
    ['core.autocrlf', 'false'],
  ];
}

/** Runs one integration round. Never pushes (the runner publishes the attempt branch afterwards). */
export async function runIntegrationPlan(i: IntegrationRunInput): Promise<IntegrationRunResult> {
  const config = integrationGitConfig(i.author, i.platform);
  const git = (args: readonly string[], extra: { okCodes?: number[]; input?: string } = {}) => {
    if (i.signal?.aborted === true) throw new IntegrationAborted();
    return i.git.run({
      cwd: i.cwd,
      ceiling: dirname(i.cwd),
      args,
      config,
      redactor: i.redactor,
      ...extra,
    });
  };
  const steps: IntegrationReport['steps'][number][] = [];
  let stopped = false;
  for (const step of [...i.plan.steps].sort((a, b) => a.position - b.position)) {
    if (stopped) {
      steps.push({ position: step.position, outcome: 'skipped' });
      continue;
    }
    const out = await mergeStep(git, i, step);
    steps.push(out);
    if (out.outcome === 'conflict' || out.outcome === 'missing') stopped = true;
  }
  const report: IntegrationReport = {
    version: 1,
    integrationId: i.plan.integrationId,
    round: i.plan.round,
    steps,
  };
  return { report, summary: summarise(report) };
}

type Git = (
  args: readonly string[],
  extra?: { okCodes?: number[]; input?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

async function mergeStep(
  git: Git,
  i: IntegrationRunInput,
  step: IntegrationStep,
): Promise<IntegrationReport['steps'][number]> {
  const has = async (sha: string) =>
    (await git(['cat-file', '-e', '--end-of-options', `${sha}^{commit}`], { okCodes: [1, 128] })).code === 0;
  if (!(await has(step.sha))) {
    return {
      position: step.position,
      outcome: 'missing',
      detail: `commit ${step.sha.slice(0, 12)} of ${step.branch} is not on the remote`,
    };
  }
  if (step.resolution !== undefined && !(await has(step.resolution.sha))) {
    return {
      position: step.position,
      outcome: 'missing',
      detail: `the resolution commit ${step.resolution.sha.slice(0, 12)} is not on the remote`,
    };
  }
  const contained = await git(['merge-base', '--is-ancestor', step.sha, 'HEAD'], { okCodes: [1] });
  if (contained.code === 0) return { position: step.position, outcome: 'already' };
  const message = mergeMessage(i.plan, step);
  const merge = await git(['merge', '--no-ff', '--no-commit', '--no-verify', '-q', step.sha], {
    okCodes: [1, 2],
  });
  const conflicted = await unmerged(git);
  if (merge.code !== 0 && conflicted.length === 0) {
    // Not a content conflict (e.g. the merge refused to start): abort and report it as a stop.
    await git(['merge', '--abort'], { okCodes: [128] });
    return {
      position: step.position,
      outcome: 'conflict',
      conflictFiles: [],
      detail: clip(`git merge failed: ${i.redactor.redact(merge.stderr.trim())}`, 500),
    };
  }
  if (conflicted.length > 0) {
    const res = step.resolution;
    const unresolved = res === undefined ? conflicted : conflicted.filter((f) => !res.files.includes(f));
    if (res !== undefined && unresolved.length === 0) {
      const applied = await applyResolution(git, i, conflicted, res.sha);
      if (applied === null) {
        await commitMerge(git, message);
        return { position: step.position, outcome: 'resolved', mergeSha: await headSha(git) };
      }
      const details = await conflictDetails(git, i, step.sha, conflicted);
      await git(['merge', '--abort'], { okCodes: [128] });
      return {
        position: step.position,
        outcome: 'conflict',
        conflictFiles: conflicted.slice(0, INTEGRATION_LIMITS.maxConflictFiles),
        details,
        detail: clip(applied, 500),
      };
    }
    const details = await conflictDetails(git, i, step.sha, unresolved);
    await git(['merge', '--abort'], { okCodes: [128] });
    return {
      position: step.position,
      outcome: 'conflict',
      conflictFiles: unresolved.slice(0, INTEGRATION_LIMITS.maxConflictFiles),
      details,
      ...(res === undefined
        ? {}
        : { detail: 'the resolution did not cover every conflicting file of this merge' }),
    };
  }
  await commitMerge(git, message);
  return { position: step.position, outcome: 'merged', mergeSha: await headSha(git) };
}

function mergeMessage(plan: IntegrationPlan, step: IntegrationStep): string {
  const label = step.label.replace(/[\r\n]+/g, ' ').slice(0, 120);
  return (
    `Merge ${label} into ${plan.integrationBranch}\n\n` +
    `Integration ${plan.integrationId}, round ${String(plan.round)}, step ${String(step.position)}: ` +
    `${step.branch} @ ${step.sha.slice(0, 12)}` +
    (step.resolution === undefined
      ? ''
      : `, conflicts resolved by ${step.resolution.branch} @ ${step.resolution.sha.slice(0, 12)}`) +
    `.\n\nRemyral-Integration: ${plan.integrationId}/${String(step.position)}\n`
  );
}

async function commitMerge(git: Git, message: string): Promise<void> {
  await git(['commit', '--no-verify', '--cleanup=verbatim', '-q', '-F', '-'], { input: message });
}

async function headSha(git: Git): Promise<string> {
  return (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
}

/** Paths with unmerged entries (NUL-separated, so any file name is exact). */
async function unmerged(git: Git): Promise<string[]> {
  const r = await git(['diff', '--name-only', '--diff-filter=U', '-z']);
  return [...new Set(r.stdout.split('\0').filter((p) => p !== ''))].sort();
}

/**
 * Takes the resolution commit's version of every conflicting file (or removes it when the resolution deleted it).
 * Returns null on success, else why the resolution cannot be used (markers left, a file it does not have …).
 */
async function applyResolution(
  git: Git,
  i: IntegrationRunInput,
  files: readonly string[],
  resolutionSha: string,
): Promise<string | null> {
  for (const f of files) {
    const exists = await git(['cat-file', '-e', `${resolutionSha}:${f}`], { okCodes: [1, 128] });
    if (exists.code === 0) {
      await git(['checkout', resolutionSha, '--', f]);
      const text = await readWorktreeFile(i.cwd, f, 'latin1');
      if (typeof text === 'string' && CONFLICT_LINE.test(text))
        return `the resolution left conflict markers in ${f}`;
      await git(['add', '--', f]);
    } else {
      await git(['rm', '-q', '-f', '--ignore-unmatch', '--', f]);
    }
  }
  const left = await unmerged(git);
  return left.length === 0 ? null : `still unmerged after the resolution: ${left.slice(0, 5).join(', ')}`;
}

async function conflictDetails(
  git: Git,
  i: IntegrationRunInput,
  theirs: string,
  files: readonly string[],
): Promise<ConflictFileDetail[]> {
  const base = (await git(['merge-base', 'HEAD', theirs], { okCodes: [1] })).stdout.trim();
  const out: ConflictFileDetail[] = [];
  for (const f of files.slice(0, INTEGRATION_LIMITS.maxDetailedFiles)) {
    const raw = await readWorktreeFile(i.cwd, f, 'utf8');
    const binary = typeof raw === 'string' && raw.slice(0, 8000).includes('\0');
    const ex =
      raw === null
        ? { text: '(the file was deleted on one side: modify/delete conflict)', cut: false }
        : raw === SPECIAL
          ? { text: '(not a regular file, or too large for an excerpt)', cut: false }
          : binary
            ? { text: '(binary file)', cut: false }
            : markerExcerpt(raw, INTEGRATION_LIMITS.maxMarkerChars);
    const diff = async (to: string) => {
      if (base === '') return { text: '', cut: false };
      const r = await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', base, to, '--', f], {
        okCodes: [1],
      });
      return capText(r.stdout, INTEGRATION_LIMITS.maxDiffChars);
    };
    const ours = await diff('HEAD');
    const theirsDiff = await diff(theirs);
    out.push({
      path: f,
      markers: i.redactor.redact(ex.text).slice(0, INTEGRATION_LIMITS.maxMarkerChars),
      oursDiff: i.redactor.redact(ours.text).slice(0, INTEGRATION_LIMITS.maxDiffChars),
      theirsDiff: i.redactor.redact(theirsDiff.text).slice(0, INTEGRATION_LIMITS.maxDiffChars),
      truncated: ex.cut || ours.cut || theirsDiff.cut,
    });
  }
  return out;
}

/** Larger files get no excerpt (memory bound). */
const MAX_EXCERPT_SOURCE_BYTES = 2 * 1024 * 1024;
const SPECIAL = Symbol('special');

/**
 * A worktree file for an excerpt / marker check: null when absent; SPECIAL when it is not a regular file (a merge can
 * bring in a symbolic link — it is never followed, so nothing outside the worktree is read) or larger than 2 MiB.
 */
async function readWorktreeFile(
  cwd: string,
  path: string,
  encoding: 'utf8' | 'latin1',
): Promise<string | null | typeof SPECIAL> {
  const full = join(cwd, path);
  const st = await lstat(full).catch(() => null);
  if (st === null) return null;
  if (!st.isFile() || st.size > MAX_EXCERPT_SOURCE_BYTES) return SPECIAL;
  return readFile(full, encoding).catch(() => null);
}

/** The conflict regions of a file (markers plus 3 lines of context each), bounded. */
export function markerExcerpt(text: string, max: number): { text: string; cut: boolean } {
  const lines = text.split('\n');
  const keep = new Set<number>();
  let open = -1;
  for (const [n, line] of lines.entries()) {
    if (line.startsWith('<<<<<<<')) open = n;
    else if (line.startsWith('>>>>>>>') && open >= 0) {
      for (let k = Math.max(0, open - 3); k <= Math.min(lines.length - 1, n + 3); k++) keep.add(k);
      open = -1;
    }
  }
  if (keep.size === 0) return capText(text, max);
  const parts: string[] = [];
  let last = -2;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n !== last + 1) parts.push(`@@ line ${String(n + 1)}`);
    parts.push(lines[n] ?? '');
    last = n;
  }
  return capText(parts.join('\n'), max);
}

function capText(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const marker = '\n… (truncated)';
  return { text: text.slice(0, max - marker.length) + marker, cut: true };
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function summarise(r: IntegrationReport): string {
  const count = (o: string) => r.steps.filter((s) => s.outcome === o).length;
  const stop = r.steps.find((s) => s.outcome === 'conflict' || s.outcome === 'missing');
  const merged = count('merged') + count('resolved');
  return (
    `integration round ${String(r.round)}: merged ${String(merged)}` +
    (count('already') > 0 ? `, already contained ${String(count('already'))}` : '') +
    (stop === undefined
      ? ''
      : stop.outcome === 'conflict'
        ? `, conflict at step ${String(stop.position)} (${String(stop.conflictFiles?.length ?? 0)} file(s))`
        : `, missing commit at step ${String(stop.position)}`)
  );
}
