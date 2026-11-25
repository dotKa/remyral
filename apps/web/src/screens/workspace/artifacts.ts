import { type JobArtifact } from '../../api/workspaces';

/**
 * A workspace job's deliverables and inputs (docs/design/p5-research-workspace.md §4): list, preview and
 * download. Previews never interpret content as HTML: text is rendered as text (Markdown through a tiny
 * element-building renderer), raster images straight from the master's same-origin inline route (served with
 * their own media type, nosniff and CORP same-origin; the console CSP has no `blob:` in `img-src`).
 */

/** Characters shown in a text preview (a 5 MiB log would freeze a phone). */
export const PREVIEW_CHARS = 200_000;

/** Summary first, then outputs by name. */
export function orderArtifacts(list: readonly JobArtifact[]): JobArtifact[] {
  return [...list].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'summary' ? -1 : 1,
  );
}
