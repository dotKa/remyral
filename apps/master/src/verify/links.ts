/**
 * p10-verify-health (docs/design/p10-verify-health.md §3, §5): link extraction and classification — pure, no I/O.
 *
 * Used by the post-deploy crawler (live site), the static site-bundle check (files the master holds) and the docs link
 * check (Markdown files of a job). The extraction is a bounded scan over the markup (no DOM, no script execution):
 * it finds `href` / `src` / `srcset` attribute values and CSS `url(...)` references, decodes the few entities that
 * matter in URLs and never returns more than `max` references. Page content is data: nothing here interprets it beyond
 * collecting URL strings.
 */

export type RefKind = 'page' | 'asset';

export interface ExtractedRef {
  readonly raw: string;
  readonly kind: RefKind;
}

/** At most this many references are taken from one document. */
export const MAX_REFS_PER_DOCUMENT = 2_000;

const ENTITY: Readonly<Record<string, string>> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  '#39': "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|quot|apos|lt|gt|#39);/g, (_m, e: string) => ENTITY[e] ?? '');
}

const ATTR =
  /(?<![a-zA-Z0-9_:.-])[0-9.-]*([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const LINK_SKIP_REL = /\b(canonical|alternate|next|prev|dns-prefetch|preconnect)\b/i;

/*
 * The markup is untrusted (a crawled page or a bundle file, up to megabytes), so the scans below are linear: the
 * openings are found by regexes without unbounded backtracking and every closing delimiter by an index search whose
 * result is reused while it is still ahead (`aheadFinder`). The equivalent single regexes (`/<!--[\s\S]*?-->/`,
 * `/<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]{0,4000})>/`, `/url\(\s*(?:"…"|'…'|[^)\s]*)\s*\)/` …) rescan to the end of the
 * text from every unclosed opening, which is quadratic (a 200 KB stylesheet of `url("` took over 20 s).
 */

/** Max length of the attribute text of one tag (a longer one is not read as a tag). */
const MAX_TAG_ATTRS = 4_000;
/** Max length of one `<style>` body. */
const MAX_STYLE_BODY = 200_000;

/** `find(from)` (first index ≥ from, -1 for none) for non-decreasing `from`s, reusing a result that is still ahead. */
function aheadFinder(find: (from: number) => number): (from: number) => number {
  let lastFrom = -1;
  let last = -1;
  return (from) => {
    if (lastFrom >= 0 && from >= lastFrom && (last === -1 || last >= from)) return last;
    lastFrom = from;
    last = find(from);
    return last;
  };
}

/** First match index of the global/sticky-free `re` at or after `from` (-1 for none). */
function searchFrom(re: RegExp, text: string, from: number): number {
  re.lastIndex = from;
  return re.exec(text)?.index ?? -1;
}

const SKIP_OPEN = /<!--|<script\b/gi;
/** A script end tag as the HTML tokenizer reads it: `</script` then whitespace, `/` or `>` (`</script >` too). */
const SCRIPT_CLOSE = /<\/script[\t\n\f\r />]/gi;

/**
 * Comments and script bodies removed (a URL inside a script is not a link the page shows); a script's opening tag is
 * kept, so its `src` still counts. An unclosed comment or script is left as it is.
 */
function withoutSkipped(html: string): string {
  const open = new RegExp(SKIP_OPEN);
  const scriptClose = new RegExp(SCRIPT_CLOSE);
  const commentEnd = aheadFinder((f) => html.indexOf('-->', f));
  const tagEnd = aheadFinder((f) => html.indexOf('>', f));
  const closeAt = aheadFinder((f) => searchFrom(scriptClose, html, f));
  const closeTagEnd = aheadFinder((f) => html.indexOf('>', f));
  let out = '';
  let copied = 0;
  for (let m = open.exec(html); m !== null; m = open.exec(html)) {
    const at = m.index;
    let keep: number;
    let resume: number;
    if (m[0] === '<!--') {
      const end = commentEnd(at + 4);
      keep = at;
      resume = end < 0 ? -1 : end + 3;
    } else {
      const gt = tagEnd(at + 7);
      const close = gt < 0 ? -1 : closeAt(gt + 1);
      const closeGt = close < 0 ? -1 : closeTagEnd(close + 8);
      keep = gt + 1;
      resume = closeGt < 0 ? -1 : closeGt + 1;
    }
    if (resume < 0) {
      open.lastIndex = at + 1;
      continue;
    }
    out += html.slice(copied, keep);
    copied = resume;
    open.lastIndex = resume;
  }
  return copied === 0 ? html : out + html.slice(copied);
}

const TAG_OPEN = /<([a-zA-Z][a-zA-Z0-9-]*)\b/g;

/** Start tags as `[name, attribute text]`: a `>` within {@link MAX_TAG_ATTRS} characters closes each. */
function* tags(text: string): Generator<[string, string]> {
  const open = new RegExp(TAG_OPEN);
  const tagEnd = aheadFinder((f) => text.indexOf('>', f));
  for (let m = open.exec(text); m !== null; m = open.exec(text)) {
    const attrsAt = m.index + m[0].length;
    const gt = tagEnd(attrsAt);
    if (gt < 0) return;
    if (gt - attrsAt > MAX_TAG_ATTRS) {
      open.lastIndex = m.index + 1;
      continue;
    }
    yield [m[1] ?? '', text.slice(attrsAt, gt)];
    open.lastIndex = gt + 1;
  }
}

const STYLE_OPEN = /<style\b/gi;
const STYLE_CLOSE = /<\/style>/gi;

/** Bodies of the `<style>` blocks (each at most {@link MAX_STYLE_BODY} characters). */
function* styleBodies(text: string): Generator<string> {
  const open = new RegExp(STYLE_OPEN);
  const styleClose = new RegExp(STYLE_CLOSE);
  const tagEnd = aheadFinder((f) => text.indexOf('>', f));
  const closeAt = aheadFinder((f) => searchFrom(styleClose, text, f));
  for (let m = open.exec(text); m !== null; m = open.exec(text)) {
    const gt = tagEnd(m.index + 6);
    if (gt < 0) return;
    const close = closeAt(gt + 1);
    if (close < 0) return;
    if (close - (gt + 1) > MAX_STYLE_BODY) {
      open.lastIndex = m.index + 1;
      continue;
    }
    yield text.slice(gt + 1, close);
    open.lastIndex = close + 8;
  }
}

const ASSET_TAGS = new Set([
  'img',
  'script',
  'source',
  'video',
  'audio',
  'track',
  'embed',
  'input',
  'iframe',
]);

/** `href` / `src` / `srcset` / CSS `url()` references of an HTML document, in document order, at most `max`. */
export function extractHtmlRefs(html: string, max = MAX_REFS_PER_DOCUMENT): ExtractedRef[] {
  const out: ExtractedRef[] = [];
  const push = (raw: string | undefined, kind: RefKind): void => {
    if (raw === undefined || out.length >= max) return;
    const v = decodeEntities(raw).trim();
    if (v !== '') out.push({ raw: v.slice(0, 2_000), kind });
  };
  const text = withoutSkipped(html);
  for (const [name, attrText] of tags(text)) {
    if (out.length >= max) break;
    const tag = name.toLowerCase();
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(ATTR)) {
      const attr = (a[1] ?? '').toLowerCase();
      if (!(attr in attrs)) attrs[attr] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    if (tag === 'a' || tag === 'area') push(attrs.href, 'page');
    else if (tag === 'link') {
      if (attrs.href !== undefined && !LINK_SKIP_REL.test(attrs.rel ?? '')) push(attrs.href, 'asset');
    } else if (ASSET_TAGS.has(tag)) {
      push(attrs.src, tag === 'iframe' ? 'page' : 'asset');
    }
    if (attrs.srcset !== undefined) {
      for (const part of attrs.srcset.split(',')) push(part.trim().split(/\s+/)[0], 'asset');
    }
    if (attrs.poster !== undefined) push(attrs.poster, 'asset');
    if (attrs.style !== undefined) for (const u of cssUrls(attrs.style)) push(u, 'asset');
  }
  for (const body of styleBodies(text)) {
    for (const u of cssUrls(body)) push(u, 'asset');
  }
  return out;
}

const URL_OPEN = /url\(/gi;
const SPACE = /\s/;
const BARE_STOP = /[)\s]/g;

/** `url(...)` references of a CSS text (data: URLs included; the classifier skips them). */
export function cssUrls(css: string, max = MAX_REFS_PER_DOCUMENT): string[] {
  const out: string[] = [];
  const open = new RegExp(URL_OPEN);
  const quoteAt = {
    '"': aheadFinder((f) => css.indexOf('"', f)),
    "'": aheadFinder((f) => css.indexOf("'", f)),
  };
  const bareStop = new RegExp(BARE_STOP);
  const bareEnd = aheadFinder((f) => searchFrom(bareStop, css, f));
  const skipSpace = (i: number): number => {
    let j = i;
    while (j < css.length && SPACE.test(css.charAt(j))) j += 1;
    return j;
  };
  // `\s*\)` after an unquoted value: many openings can share one value end, so its answer is kept.
  let bareFrom = -1;
  let bareClose = -1;
  // Same match as `url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)`: quoted value, else the unquoted run.
  const valueAt = (q: number): { value: string; end: number } | null => {
    const c = css.charAt(q);
    if (c === '"' || c === "'") {
      const j = quoteAt[c](q + 1);
      if (j >= 0) {
        const k = skipSpace(j + 1);
        if (css.charAt(k) === ')') return { value: css.slice(q + 1, j), end: k + 1 };
      }
    }
    const e = bareEnd(q);
    const k = e < 0 ? css.length : e;
    if (k !== bareFrom) {
      bareFrom = k;
      const after = skipSpace(k);
      bareClose = css.charAt(after) === ')' ? after : -1;
    }
    return bareClose < 0 ? null : { value: css.slice(q, k), end: bareClose + 1 };
  };
  for (let m = open.exec(css); m !== null && out.length < max; m = open.exec(css)) {
    const found = valueAt(skipSpace(m.index + 4));
    if (found === null) {
      open.lastIndex = m.index + 1;
      continue;
    }
    const v = found.value.trim();
    if (v !== '') out.push(v.slice(0, 2_000));
    open.lastIndex = found.end;
  }
  return out;
}

const MD_INLINE = /!?\[[^\]\n]{0,500}\]\(\s*<?([^)\s>]{1,2000})>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const MD_REF_DEF = /^\s{0,3}\[[^\]\n]{1,200}\]:\s*<?(\S{1,2000}?)>?(?:\s+.*)?$/gm;
const MD_AUTOLINK = /<(https?:\/\/[^\s<>]{1,2000})>/g;
const MD_FENCE = /^(```|~~~)[\s\S]*?^\1/gm;
const MD_CODE = /`[^`\n]*`/g;

/** Link targets of a Markdown document (inline links and images, reference definitions, autolinks); code skipped. */
export function extractMarkdownLinks(md: string, max = 500): string[] {
  const text = md.replace(MD_FENCE, '').replace(MD_CODE, '');
  const out: string[] = [];
  const push = (v: string | undefined): void => {
    if (v !== undefined && v !== '' && out.length < max) out.push(v);
  };
  for (const m of text.matchAll(MD_INLINE)) push(m[1]);
  for (const m of text.matchAll(MD_REF_DEF)) push(m[1]);
  for (const m of text.matchAll(MD_AUTOLINK)) push(m[1]);
  return out;
}

export type SkipReason =
  'empty' | 'anchor' | 'mailto' | 'tel' | 'javascript' | 'data' | 'other-scheme' | 'invalid';

export type Classified =
  | { readonly type: 'internal'; readonly url: URL }
  | { readonly type: 'external'; readonly url: URL }
  | { readonly type: 'skip'; readonly reason: SkipReason };

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Classifies one reference found on `base` (the page's URL) against `origin` (scheme://host:port of the site):
 * `internal` (same origin, hash removed), `external` (another http(s) origin) or `skip` with why (in-page anchor,
 * mailto / tel / javascript / data / other schemes, unparsable).
 */
export function classifyLink(raw: string, base: URL, origin: string): Classified {
  const v = raw.trim();
  if (v === '') return { type: 'skip', reason: 'empty' };
  if (v.startsWith('#')) return { type: 'skip', reason: 'anchor' };
  const scheme = SCHEME.exec(v)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
    if (scheme === 'mailto') return { type: 'skip', reason: 'mailto' };
    if (scheme === 'tel') return { type: 'skip', reason: 'tel' };
    if (scheme === 'javascript') return { type: 'skip', reason: 'javascript' };
    if (scheme === 'data' || scheme === 'blob') return { type: 'skip', reason: 'data' };
    return { type: 'skip', reason: 'other-scheme' };
  }
  let u: URL;
  try {
    u = new URL(v, base);
  } catch {
    return { type: 'skip', reason: 'invalid' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { type: 'skip', reason: 'other-scheme' };
  if (u.username !== '' || u.password !== '') return { type: 'skip', reason: 'invalid' };
  u.hash = '';
  return u.origin === origin ? { type: 'internal', url: u } : { type: 'external', url: u };
}

/** The key two references share when they name the same resource (hash removed; query kept). */
export function linkKey(u: URL): string {
  const c = new URL(u.href);
  c.hash = '';
  return c.href;
}

/**
 * The bundle files a site path may be served from, in the order Cloudflare Pages tries them: `/` → `index.html`;
 * `/dir/` → `dir/index.html`; `/page` → `page`, `page.html`, `page/index.html`. Percent-decoded; null when the path
 * cannot be decoded.
 */
export function bundleCandidates(pathname: string): string[] | null {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  p = p.replace(/^\/+/, '');
  if (p === '' || p.endsWith('/')) return [`${p}index.html`];
  return [p, `${p}.html`, `${p}/index.html`];
}
