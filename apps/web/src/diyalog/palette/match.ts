/**
 * p12-diyalog-cmdk (docs/design/p12-diyalog.md §17.1): Turkish-aware fuzzy matching for the command palette.
 *
 * `fold` lowercases with the Turkish rules (I → ı, İ → i) and then folds every letter to its plain Latin base —
 * ı/i, ş/s, ğ/g, ç/c, ö/o, ü/u, â/a, î/i, û/u — so "İşler", "isler" and "ISLER" are the same word, and an English
 * "INBOX" stays "inbox". `score` ranks one text for a query: every query word must occur (substring) or, failing
 * that, appear in order as a subsequence; word starts, early positions and short texts rank higher. null = no match.
 */

export function fold(s: string): string {
  return s.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
}

function isBoundary(text: string, at: number): boolean {
  if (at === 0) return true;
  const c = text[at - 1] ?? ' ';
  return !/[\p{L}\p{N}]/u.test(c);
}

function subsequence(text: string, word: string): number | null {
  let at = 0;
  let first = -1;
  let gaps = 0;
  for (const ch of word) {
    const i = text.indexOf(ch, at);
    if (i === -1) return null;
    if (first === -1) first = i;
    else gaps += i - at;
    at = i + 1;
  }
  // Letters scattered across a long text are noise, not a match.
  if (gaps > 3 * word.length + 3) return null;
  return Math.max(1, 30 - gaps - Math.min(first, 10));
}

/** Score of `text` (with optional extra `keywords`) for `query`; null when some query word does not match. */
export function score(query: string, text: string, keywords = ''): number | null {
  const words = fold(query)
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return 0;
  const t = fold(text);
  const k = keywords === '' ? '' : fold(keywords);
  let total = 0;
  for (const w of words) {
    const i = t.indexOf(w);
    if (i !== -1) {
      total += 100 - Math.min(i, 40) + (isBoundary(t, i) ? 40 : 0) + (t === w ? 60 : 0);
      continue;
    }
    const j = k === '' ? -1 : k.indexOf(w);
    if (j !== -1) {
      total += 50 + (isBoundary(k, j) ? 20 : 0);
      continue;
    }
    const s = subsequence(t, w);
    if (s === null) return null;
    total += s;
  }
  // Shorter labels win ties ("İşler" before "İşler · Kuyruk ayarları").
  return total - Math.min(t.length, 60) / 6;
}

/** Ranks `items` by `query` (stable for equal scores); every item when the query is empty. */
export function rank<T>(
  query: string,
  items: readonly T[],
  text: (t: T) => string,
  keywords: (t: T) => string = () => '',
): T[] {
  if (query.trim() === '') return [...items];
  const scored: { t: T; s: number; i: number }[] = [];
  items.forEach((t, i) => {
    const s = score(query, text(t), keywords(t));
    if (s !== null) scored.push({ t, s, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.t);
}
