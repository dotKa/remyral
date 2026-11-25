/** Lines shown before "Show all" (keeps a huge diff from freezing a phone). */
export const DIFF_PREVIEW_LINES = 3_000;

type DiffKind = 'file' | 'hunk' | 'add' | 'del' | 'ctx' | 'meta';

export function classifyDiffLine(line: string): DiffKind {
  if (line.startsWith('diff --git ')) return 'file';
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}
