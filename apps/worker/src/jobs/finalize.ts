import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { Redactor } from '@remyral/observability';
import type { GitRunner } from '../workspace/git.js';
import type { Workspace } from '../workspace/manager.js';

/** Content address of an attempt's pushed change (what ARTIFACT_REF `attempt.diff` describes). */
export interface AttemptDiff {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly empty: boolean;
}

/**
 * `git diff --binary <base>..<pushed sha>` of the attempt worktree, hashed. The diff itself stays
 * retrievable from the attempt branch (p4-git-flow publishes it); null when git cannot produce it.
 */
export async function attemptDiff(
  git: GitRunner,
  ws: Workspace,
  sha: string,
  redactor: Redactor,
): Promise<AttemptDiff | null> {
  try {
    const r = await git.run({
      cwd: ws.path,
      ceiling: dirname(ws.path),
      args: ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', ws.baseCommit, sha, '--'],
      redactor,
    });
    const bytes = Buffer.from(r.stdout, 'utf8');
    return {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
      empty: bytes.length === 0,
    };
  } catch {
    return null;
  }
}
