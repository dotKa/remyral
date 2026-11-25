import { CHAT_SITE_ZIP, type ChatZipProblem, siteProblems } from '@remyral/protocol/site-files';
import type { Project } from '../../api/directory';
import { type InputBundlePlan, planInputBundle } from '../../lib/inputBundle';
import { planSite, type SiteFile } from '../../lib/siteUpload';
import { INPUT_ZIP_LIMITS, readZip, ZipError } from '../../lib/siteZip';

/**
 * p15-chat-zip (docs/design/p15-chat-zip.md): a .zip dropped into the chat composer. Everything here runs in the
 * browser with the "Upload a site" code (p10-site-upload): `readZip` (caps, CRC, no symlinks, no ZIP64) and `planSite`
 * (the one top folder every file shares is removed — so index.html inside it lands at the root — OS litter is skipped,
 * the master's path / type / size rules refuse single files). A plan with no problems is a site: the composer uploads
 * it on send. Anything else becomes a note only (nothing of it leaves the browser but the name, counts and reasons).
 */

export interface ChatZipPlan {
  readonly name: string;
  /** The .zip's own size (compressed). */
  readonly zipBytes: number;
  readonly files: readonly SiteFile[];
  readonly totalBytes: number;
  /** Single files left out (unsafe path, other type, too large, symlink, encrypted …). */
  readonly refused: readonly { readonly path: string; readonly reason: string }[];
  readonly skipped: number;
  readonly strippedRoot: string | null;
  /** Why it is not a publishable site (empty: it is one). */
  readonly problems: readonly ChatZipProblem[];
  /** The reader's own words for an unreadable archive. */
  readonly error: string | null;
  /**
   * p16-zip-job-input: the same archive planned as a job's input files (null: unreadable). Its `problems` empty: it
   * can be sent as an input bundle ("İş girdisi").
   */
  readonly input: InputBundlePlan | null;
}

/** Whether a picked / dropped file is a .zip archive. */
export function isZipFile(file: { readonly name: string; readonly type: string }): boolean {
  return (
    /\.zip$/i.test(file.name) ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed'
  );
}

/** A display name the master accepts for a note (no path, no line breaks, ≤ 100 characters). */
export function zipDisplayName(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const clean = base.replace(/[\0\r\n]/g, ' ').trim();
  return (clean === '' ? 'archive.zip' : clean).slice(0, 100);
}

/** Unpacks and plans a .zip from the chat (never throws: an unreadable archive is a plan with `unreadable`). */
export async function planChatZip(file: Blob & { readonly name: string }): Promise<ChatZipPlan> {
  const name = zipDisplayName(file.name);
  try {
    // p16-zip-job-input: read once with the input bundle's caps (larger than a site's); the site rules still apply.
    const zip = await readZip(file, INPUT_ZIP_LIMITS);
    const plan = planSite(zip.entries);
    const input = planInputBundle(zip.entries, zip.skipped.length);
    return {
      name,
      zipBytes: file.size,
      files: plan.files,
      totalBytes: plan.totalBytes,
      refused: [...zip.refused, ...plan.refused],
      skipped: plan.skipped + zip.skipped.length,
      strippedRoot: plan.strippedRoot,
      problems: siteProblems(plan.files),
      error: null,
      input: { ...input, refused: [...zip.refused, ...input.refused] },
    };
  } catch (err) {
    if (!(err instanceof ZipError)) throw err;
    // The reader stops early at the caps: name them as the site limits they are.
    const problem: ChatZipProblem = /larger than/.test(err.message)
      ? 'too_large'
      : /more than \d+ entries/.test(err.message)
        ? 'too_many_files'
        : 'unreadable';
    return {
      name,
      zipBytes: file.size,
      files: [],
      totalBytes: 0,
      refused: [],
      skipped: 0,
      strippedRoot: null,
      problems: [problem],
      error: err.message,
      input: null,
    };
  }
}

/** The note a message carries for a .zip that is not a site (`archives` of the send body). */
export function archiveNote(plan: ChatZipPlan): {
  name: string;
  fileCount: number;
  totalBytes: number;
  problems: ChatZipProblem[];
} {
  return {
    name: plan.name,
    fileCount: plan.files.length + plan.refused.length,
    totalBytes: plan.totalBytes,
    problems: [...plan.problems],
  };
}

/** Projects the person may upload a site into (deploy.request: operator and above). */
export function uploadProjects(projects: readonly Project[]): Project[] {
  return projects.filter((p) => p.myRole !== 'viewer');
}

/** The project a new chip starts with: the remembered one if still allowed, else the first allowed one. */
/**
 * The project a new .zip chip starts with: p16-chat-complete — the conversation's own project when the person may
 * upload there, then the one they picked last, then the first.
 */
export function defaultProject(
  projects: readonly Project[],
  remembered: string | null,
  threadProject: string | null = null,
): string | null {
  if (threadProject !== null && projects.some((p) => p.id === threadProject)) return threadProject;
  if (remembered !== null && projects.some((p) => p.id === remembered)) return remembered;
  return projects[0]?.id ?? null;
}

export const MAX_ZIPS = CHAT_SITE_ZIP.maxPerMessage;

/** p16-zip-job-input: what a chip sends — the site upload, the input bundle, or both (the message decides). */
export type ZipMode = 'site' | 'input' | 'both';

/** Whether the plan can be sent as a site / as job input files. */
export function zipCan(plan: ChatZipPlan): { site: boolean; input: boolean } {
  return {
    site: plan.problems.length === 0,
    input: plan.input !== null && plan.input.problems.length === 0,
  };
}

/** The mode a new chip starts with: both when it can be both (the message and the assistant decide), else the one. */
export function defaultMode(plan: ChatZipPlan): ZipMode | null {
  const can = zipCan(plan);
  return can.site && can.input ? 'both' : can.site ? 'site' : can.input ? 'input' : null;
}
