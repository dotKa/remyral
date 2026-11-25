import type { AutomationFile, ContinueFrom, StoredFile } from '../../api/automations';
import { formatBytes, MAX_INPUT_FILES, MAX_INPUT_TOTAL_BYTES } from '../../api/workspaces';
import { type InputFile, UUID } from '../composer/inputs';

/**
 * p5-research-workspace-next: what an automation on a workspace project hands to every run — stored input files and
 * a continue-from rule (a fixed job, its own last succeeded run, or the chained run that triggered it). The master
 * re-validates and re-scans every file and re-checks the run-as user's access at every run.
 */

export type ContinueKind = 'none' | 'last-run' | 'chain-source' | 'job';

export interface FilesState {
  /** Stored files kept (editing). */
  readonly keepFiles: readonly StoredFile[];
  /** New uploads. */
  readonly newFiles: readonly InputFile[];
  readonly continueKind: ContinueKind;
  readonly continueJob: string;
}

export const EMPTY_FILES: FilesState = { keepFiles: [], newFiles: [], continueKind: 'none', continueJob: '' };

export function filesFromDetail(files: readonly StoredFile[], cf: ContinueFrom | null): FilesState {
  return {
    keepFiles: files,
    newFiles: [],
    continueKind: cf === null ? 'none' : cf.kind,
    continueJob: cf?.kind === 'job' ? cf.jobId : '',
  };
}

/** The target fields (`files` is the full desired set: kept ids + uploads). */
export function filesTarget(s: FilesState): { files: AutomationFile[]; continueFrom: ContinueFrom | null } {
  const continueFrom: ContinueFrom | null =
    s.continueKind === 'none'
      ? null
      : s.continueKind === 'job'
        ? { kind: 'job', jobId: s.continueJob.trim() }
        : { kind: s.continueKind };
  return {
    files: [
      ...s.keepFiles.map((f) => ({ inputId: f.id })),
      ...s.newFiles.map((f) => ({ name: f.name, contentBase64: f.contentBase64 })),
    ],
    continueFrom,
  };
}

/** Field errors (key → sentence) for the files part of the form. */
export function validateFiles(
  s: FilesState,
  ctx: { readonly target: 'job' | 'workflow'; readonly trigger: string },
): Record<string, string> {
  const e: Record<string, string> = {};
  if (s.continueKind === 'job' && !UUID.test(s.continueJob.trim())) {
    e.continueJob = 'Enter a job id (a UUID such as 3f2b…-…).';
  }
  if (s.continueKind === 'last-run' && ctx.target !== 'job') {
    e.continueKind = '“Its last run” is for job automations.';
  }
  if (s.continueKind === 'chain-source' && ctx.trigger !== 'chain') {
    e.continueKind = '“The run that triggered it” needs the “After another automation” trigger.';
  }
  const count = s.keepFiles.length + s.newFiles.length;
  const bytes = [...s.keepFiles, ...s.newFiles].reduce((n, f) => n + f.sizeBytes, 0);
  if (count > MAX_INPUT_FILES) e.files = `At most ${String(MAX_INPUT_FILES)} files.`;
  else if (bytes > MAX_INPUT_TOTAL_BYTES)
    e.files = `All files together may be at most ${formatBytes(MAX_INPUT_TOTAL_BYTES)}.`;
  return e;
}
