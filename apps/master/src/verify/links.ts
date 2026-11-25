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

const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]{0,4000})>/g;
const ATTR = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]{0,200000}?)<\/style>/gi;
/** Comments and script bodies are skipped (a URL inside a script is not a link the page shows). */
const SKIPPED = /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>/gi;

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
const LINK_SKIP_REL = /\b(canonical|alternate|next|prev|dns-prefetch|preconnect)\b/i;

/** `href` / `src` / `srcset` / CSS `url()` references of an HTML document, in document order, at most `max`. */
export function extractHtmlRefs(html: string, max = MAX_REFS_PER_DOCUMENT): ExtractedRef[] {
  const out: ExtractedRef[] = [];
  const push = (raw: string | undefined, kind: RefKind): void => {
    if (raw === undefined || out.length >= max) return;
    const v = decodeEntities(raw).trim();
    if (v !== '') out.push({ raw: v.slice(0, 2_000), kind });
  };
  // Script bodies, but not the tag itself (its src counts): keep `<script src=…>` by re-adding the opening tags.
  const text = html.replace(SKIPPED, (m) =>
    m.startsWith('<script') ? (/^<script\b[^>]*>/i.exec(m)?.[0] ?? '') : '',
  );
  for (const m of text.matchAll(TAG)) {
    if (out.length >= max) break;
    const tag = (m[1] ?? '').toLowerCase();
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? '').matchAll(ATTR)) {
      const name = (a[1] ?? '').toLowerCase();
      if (!(name in attrs)) attrs[name] = a[2] ?? a[3] ?? a[4] ?? '';
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
  for (const m of text.matchAll(STYLE_BLOCK)) {
    for (const u of cssUrls(m[1] ?? '')) push(u, 'asset');
  }
  return out;
}

/** `url(...)` references of a CSS text (data: URLs included; the classifier skips them). */
export function cssUrls(css: string, max = MAX_REFS_PER_DOCUMENT): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(CSS_URL)) {
    if (out.length >= max) break;
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (v !== '') out.push(v.slice(0, 2_000));
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
