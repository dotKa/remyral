import type { OutputItem } from './service.js';

/**
 * p15-chat-cards-scroll (job result card, "Raporu aç"): the one output of a job a person most likely wants to read
 * first, chosen deterministically from the job's items:
 *
 * 1. a report-like Markdown file — the job's summary artifact, or a name with report / rapor / summary / özet / README /
 *    analysis / analiz (earlier words win, then a shallower path, then the newest, then the key);
 * 2. else the newest readable document (Markdown, PDF, text; then the key);
 * 3. else none.
 *
 * Only files whose content is still there and previewable count (no removed, run-only or binary files).
 */
const REPORT_WORDS = ['report', 'rapor', 'summary', 'özet', 'ozet', 'readme', 'analysis', 'analiz'] as const;
const DOCUMENTS: ReadonlySet<string> = new Set(['markdown', 'pdf', 'text']);

function basename(name: string): string {
  const parts = name.split('/');
  return (parts.at(-1) ?? name).toLocaleLowerCase('tr-TR');
}

function reportRank(item: OutputItem): number | null {
  if (item.file?.kind === 'summary') return -1;
  const base = basename(item.name);
  const at = REPORT_WORDS.findIndex((w) => base.includes(w));
  return at < 0 ? null : at;
}

function newestFirst(a: OutputItem, b: OutputItem): number {
  const t = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (t !== 0) return t;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function primaryOutputKey(items: readonly OutputItem[]): string | null {
  const docs = items.filter(
    (i) =>
      i.type === 'file' &&
      i.file !== null &&
      i.file.removed === null &&
      i.file.download !== null &&
      DOCUMENTS.has(i.file.preview),
  );
  const reports = docs
    .filter((i) => i.file?.preview === 'markdown')
    .map((i) => ({ i, rank: reportRank(i) }))
    .filter((x): x is { i: OutputItem; rank: number } => x.rank !== null)
    .sort(
      (a, b) =>
        a.rank - b.rank || a.i.name.split('/').length - b.i.name.split('/').length || newestFirst(a.i, b.i),
    );
  const report = reports[0];
  if (report !== undefined) return report.i.key;
  return [...docs].sort(newestFirst)[0]?.key ?? null;
}
