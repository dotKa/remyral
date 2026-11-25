/**
 * Where "Senden bekleyen" lives (p14-web-perf: its own module, so the shell links to it without the page's chunk).
 *
 * p17-needs-page (docs/design/p17-needs-page.md): the decisions moved off the home onto their own page, `/needs`. The
 * section keeps its id (`#benden-bekleyen`) and a card its hash (`#kart=<kind>:<id>`); the home answers both by sending
 * the browser on to `/needs` with the same hash, so old bookmarks, notifications and "thread'de aç" links still land.
 */
export const NEEDS_PATH = '/needs';

/** The decisions section's id on the needs page (and the old home anchor). */
export const NEEDS_ANCHOR = 'benden-bekleyen';

/** `#kart=<card key>`: a card to bring into view and focus (`approval:<id>`, `deploy:<id>`, …). */
export const CARD_HASH_PREFIX = '#kart=';

/** The needs page with one card focused: `/needs#kart=approval:<id>` (the id part URL-encoded). */
export function needsCardHref(key: string): string {
  const at = key.indexOf(':');
  const kind = at < 0 ? key : key.slice(0, at);
  const id = at < 0 ? '' : key.slice(at + 1);
  return `${NEEDS_PATH}${CARD_HASH_PREFIX}${kind}:${encodeURIComponent(id)}`;
}

/** A hash that belongs to the needs page (the section anchor or a card), as old home links carry it. */
export function isNeedsHash(hash: string): boolean {
  return hash === `#${NEEDS_ANCHOR}` || hash.startsWith(CARD_HASH_PREFIX);
}
