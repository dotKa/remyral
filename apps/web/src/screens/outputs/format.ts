import type { OutputItem } from '../../api/outputs';

/** The person's title, else the item's own name. */
export function displayName(item: Pick<OutputItem, 'title' | 'name'>): string {
  return item.title !== null && item.title !== '' ? item.title : item.name;
}

/** "a, b , a" → ["a", "b"] (trimmed, deduplicated, at most 20). */
export function parseTagText(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
    ),
  ].slice(0, 20);
}

/** One line per https link (anything else is reported, not sent). */
export function parseLinks(text: string): { links: string[]; bad: string | null } {
  const lines = text
    .split(/\s+/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  for (const l of lines) {
    let ok: boolean;
    try {
      const u = new URL(l);
      ok = u.protocol === 'https:' && u.username === '' && u.password === '';
    } catch {
      ok = false;
    }
    if (!ok) return { links: [], bad: l };
  }
  return { links: [...new Set(lines)].slice(0, 20), bad: null };
}
