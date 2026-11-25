import type { PageFetcher } from '../uptime/probe.js';
import { bundleCandidates, classifyLink, cssUrls, extractHtmlRefs, extractMarkdownLinks } from './links.js';
import { type Check, type Finding, LIMITS } from './model.js';

/**
 * p10-verify-health (docs/design/p10-verify-health.md §3): the deterministic checks the master runs on what it already
 * holds — no worker, no network for the bundle.
 *
 *  - `checkSiteBundle`: the job's static site bundle (the exact files a Pages deploy would publish). `index.html`
 *    must exist; every same-site reference of the HTML pages (`href`, `src`, `srcset`, inline / `<style>` CSS) and of
 *    the CSS files (`url()`) must resolve to a bundle file the way Cloudflare Pages serves paths. Bounded.
 *  - `checkDocs`: Markdown files of a workspace job — relative links must name another file of the job; external
 *    http(s) links are checked (HEAD, then GET without body) through the guarded fetcher, at most `maxExternal`.
 */

const SITE = 'https://site.invalid';

export interface BundleFile {
  readonly path: string;
  readonly contentType: string;
  readonly content: Buffer;
}

export interface CheckOutcome {
  readonly checks: Check[];
  readonly findings: Finding[];
}

export function checkSiteBundle(files: readonly BundleFile[]): CheckOutcome {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const findings: Finding[] = [];
  const checks: Check[] = [];
  const hasIndex = byPath.has('index.html');
  checks.push({
    source: 'master',
    id: 'bundle-index',
    status: hasIndex ? 'pass' : 'fail',
    detail: hasIndex ? 'index.html present' : 'The site has no index.html at its root.',
  });
  if (!hasIndex) {
    findings.push({
      source: 'master',
      severity: 'fail',
      kind: 'link',
      message: 'The site has no index.html at its root: its address would answer 404.',
    });
  }
  let refs = 0;
  let pages = 0;
  let broken = 0;
  let truncated = false;
  const reported = new Set<string>();
  const resolve = (raw: string, from: string): void => {
    if (refs >= LIMITS.bundleRefs) {
      truncated = true;
      return;
    }
    refs++;
    const base = new URL(`/${from}`, SITE);
    const c = classifyLink(raw, base, SITE);
    if (c.type !== 'internal') return;
    const candidates = bundleCandidates(c.url.pathname);
    if (candidates !== null && candidates.some((p) => byPath.has(p))) return;
    broken++;
    const key = `${from}\u0000${c.url.pathname}`;
    if (reported.has(key) || findings.length >= LIMITS.findings) return;
    reported.add(key);
    findings.push({
      source: 'master',
      severity: 'fail',
      kind: 'link',
      message: `${from} links to ${c.url.pathname}, which is not in the site.`.slice(0, LIMITS.text),
    });
  };
  for (const f of files) {
    const isHtml = f.contentType === 'text/html';
    const isCss = f.contentType === 'text/css';
    if (!isHtml && !isCss) continue;
    if (isHtml) {
      if (pages >= LIMITS.bundlePages) {
        truncated = true;
        continue;
      }
      pages++;
      for (const r of extractHtmlRefs(f.content.toString('utf8'))) resolve(r.raw, f.path);
    } else {
      for (const u of cssUrls(f.content.toString('utf8'))) resolve(u, f.path);
    }
  }
  checks.push({
    source: 'master',
    id: 'bundle-links',
    status: broken > 0 ? 'fail' : 'pass',
    detail:
      `${String(pages)} page(s), ${String(refs)} reference(s) checked, ${String(broken)} broken` +
      (truncated ? ' (bounded: not every page or reference was checked)' : ''),
  });
  return { checks, findings };
}

export interface DocFile {
  readonly name: string;
  readonly content: Buffer;
}

export async function checkDocs(
  files: readonly DocFile[],
  allNames: readonly string[],
  fetcher: PageFetcher | null,
  opts: { readonly maxExternal?: number; readonly timeoutMs?: number } = {},
): Promise<CheckOutcome> {
  const names = new Set(allNames);
  const findings: Finding[] = [];
  const checks: Check[] = [];
  const external = new Map<string, string>(); // url → file it was found in
  let relative = 0;
  let brokenRelative = 0;
  for (const f of files.slice(0, LIMITS.docsFiles)) {
    const base = new URL(`/${f.name}`, SITE);
    for (const raw of extractMarkdownLinks(f.content.toString('utf8'))) {
      const c = classifyLink(raw, base, SITE);
      if (c.type === 'skip') continue;
      if (c.type === 'external') {
        if (!external.has(c.url.href)) external.set(c.url.href, f.name);
        continue;
      }
      relative++;
      let path: string;
      try {
        path = decodeURIComponent(c.url.pathname).replace(/^\/+/, '');
      } catch {
        path = c.url.pathname;
      }
      if (path === '' || names.has(path)) continue;
      brokenRelative++;
      if (findings.length < LIMITS.findings) {
        findings.push({
          source: 'master',
          severity: 'warn',
          kind: 'link',
          message: `${f.name} links to ${path}, which is not a file of this job.`.slice(0, LIMITS.text),
        });
      }
    }
  }
  checks.push({
    source: 'master',
    id: 'docs-relative-links',
    status: brokenRelative > 0 ? 'warn' : 'pass',
    detail: `${String(relative)} relative link(s), ${String(brokenRelative)} broken`,
  });
  const max = Math.max(0, Math.min(opts.maxExternal ?? LIMITS.docsExternalLinks, LIMITS.docsExternalLinks));
  const targets = [...external.entries()].slice(0, max);
  if (fetcher === null || targets.length === 0) {
    checks.push({
      source: 'master',
      id: 'docs-external-links',
      status: 'skipped',
      detail: targets.length === 0 ? 'no external links' : 'external links are not checked here',
    });
    return { checks, findings };
  }
  let brokenExternal = 0;
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < targets.length) {
      const [url, from] = targets[i++] as [string, string];
      const req = { timeoutMs: opts.timeoutMs ?? 5_000, maxBytes: 0, maxRedirects: 3 };
      let r = await fetcher.page(url, { ...req, method: 'HEAD' });
      if (r.ok && (r.status === 405 || r.status === 501 || r.status === 403)) {
        r = await fetcher.page(url, { ...req, method: 'GET' });
      }
      if (!r.ok || r.status === null || r.status >= 400) {
        brokenExternal++;
        if (findings.length < LIMITS.findings) {
          findings.push({
            source: 'master',
            severity: 'warn',
            kind: 'link',
            message:
              `${from}: external link answered ${r.status === null ? (r.error ?? 'no response') : `HTTP ${String(r.status)}`}.`.slice(
                0,
                LIMITS.text,
              ),
            url: url.slice(0, LIMITS.url),
          });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
  checks.push({
    source: 'master',
    id: 'docs-external-links',
    status: brokenExternal > 0 ? 'warn' : 'pass',
    detail:
      `${String(targets.length)} external link(s) checked, ${String(brokenExternal)} broken` +
      (external.size > targets.length ? ` (${String(external.size - targets.length)} more not checked)` : ''),
  });
  return { checks, findings };
}
