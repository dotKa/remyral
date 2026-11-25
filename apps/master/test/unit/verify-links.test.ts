import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProbe, type PageFetcher, type PageRequest, type PageResult } from '../../src/uptime/probe.js';
import { crawl } from '../../src/verify/crawler.js';
import {
  bundleCandidates,
  classifyLink,
  cssUrls,
  extractHtmlRefs,
  extractMarkdownLinks,
} from '../../src/verify/links.js';

/** p10-verify-health: link extraction / classification and the bounded same-origin crawler. */

describe('extractHtmlRefs', () => {
  it('finds href, src, srcset, poster, inline and <style> CSS urls; skips comments and script bodies', () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="/a.css"><link rel="canonical" href="https://x.test/">
      <style>body{background:url('/bg.png')}</style>
      <script src="/app.js"></script><script>var u = "/never.html";</script>
      </head><body>
      <!-- <a href="/commented.html">x</a> -->
      <a href="/about">About</a><a href='rel.html'>r</a><a href=plain.html>p</a>
      <img src="/i.png" srcset="/i-1x.png 1x, /i-2x.png 2x">
      <video poster="/p.jpg"></video><div style="background-image: url(/s.png)"></div>
      <a href="&amp;q=1">amp</a>
      </body></html>`;
    const refs = extractHtmlRefs(html);
    const raws = refs.map((r) => r.raw);
    expect(raws).toContain('/a.css');
    expect(raws).not.toContain('https://x.test/');
    expect(raws).toContain('/bg.png');
    expect(raws).toContain('/app.js');
    expect(raws).not.toContain('/never.html');
    expect(raws).not.toContain('/commented.html');
    expect(raws).toEqual(
      expect.arrayContaining(['/about', 'rel.html', 'plain.html', '/i.png', '/i-1x.png', '/i-2x.png']),
    );
    expect(raws).toContain('/p.jpg');
    expect(raws).toContain('/s.png');
    expect(raws).toContain('&q=1');
    expect(refs.find((r) => r.raw === '/about')?.kind).toBe('page');
    expect(refs.find((r) => r.raw === '/app.js')?.kind).toBe('asset');
  });

  it('is bounded', () => {
    const html = '<a href="/x">x</a>'.repeat(5000);
    expect(extractHtmlRefs(html, 100)).toHaveLength(100);
  });

  it('css urls', () => {
    expect(cssUrls(`a{b:url("x.png")} c{d:url( 'y.woff2' )} e{f:url(z.svg)}`)).toEqual([
      'x.png',
      'y.woff2',
      'z.svg',
    ]);
  });
});

describe('classifyLink', () => {
  const base = new URL('https://site.test/docs/page.html');
  const origin = 'https://site.test';
  it('internal (relative, absolute path, same origin), hash removed', () => {
    const a = classifyLink('other.html#top', base, origin);
    expect(a.type).toBe('internal');
    expect(a.type === 'internal' && a.url.href).toBe('https://site.test/docs/other.html');
    expect(classifyLink('/x', base, origin).type).toBe('internal');
    expect(classifyLink('https://site.test/y', base, origin).type).toBe('internal');
  });
  it('external: other origin, other scheme of the same host, protocol-relative other host', () => {
    expect(classifyLink('https://other.test/', base, origin).type).toBe('external');
    expect(classifyLink('http://site.test/', base, origin).type).toBe('external');
    expect(classifyLink('https://site.test:8443/', base, origin).type).toBe('external');
    expect(classifyLink('//cdn.test/a.js', base, origin).type).toBe('external');
  });
  it('skips anchors, mailto, tel, javascript, data, other schemes, credentials', () => {
    const reason = (raw: string) => {
      const c = classifyLink(raw, base, origin);
      return c.type === 'skip' ? c.reason : c.type;
    };
    expect(reason('#top')).toBe('anchor');
    expect(reason('mailto:a@b.c')).toBe('mailto');
    expect(reason('tel:+1')).toBe('tel');
    expect(reason('JavaScript:alert(1)')).toBe('javascript');
    expect(reason('data:image/png;base64,AAA')).toBe('data');
    expect(reason('ftp://x/')).toBe('other-scheme');
    expect(reason('file:///etc/passwd')).toBe('other-scheme');
    expect(reason('https://u:p@site.test/')).toBe('invalid');
    expect(reason('   ')).toBe('empty');
  });
});

describe('extractMarkdownLinks / bundleCandidates', () => {
  it('markdown links, images, reference definitions, autolinks; code skipped', () => {
    const md = [
      '[a](a.md) ![img](img/x.png "t") <https://auto.test/x>',
      '[ref]: https://ref.test/page',
      '`[not](code.md)`',
      '```',
      '[fenced](fenced.md)',
      '```',
    ].join('\n');
    const links = extractMarkdownLinks(md);
    expect(links).toEqual(
      expect.arrayContaining(['a.md', 'img/x.png', 'https://auto.test/x', 'https://ref.test/page']),
    );
    expect(links).not.toContain('code.md');
    expect(links).not.toContain('fenced.md');
  });
  it('Pages path resolution', () => {
    expect(bundleCandidates('/')).toEqual(['index.html']);
    expect(bundleCandidates('/docs/')).toEqual(['docs/index.html']);
    expect(bundleCandidates('/about')).toEqual(['about', 'about.html', 'about/index.html']);
    expect(bundleCandidates('/a%20b.html')).toEqual(['a b.html', 'a b.html.html', 'a b.html/index.html']);
    expect(bundleCandidates('/%E0%A4%A')).toBeNull();
  });
});

/** A scripted site: path → {status, html?, type?}. */
function fakeSite(
  pages: Record<string, { status: number; html?: string; location?: string }>,
): PageFetcher & {
  readonly calls: { url: string; method: string }[];
} {
  const calls: { url: string; method: string }[] = [];
  return {
    calls,
    page(url: string, req: PageRequest): Promise<PageResult> {
      calls.push({ url, method: req.method });
      const u = new URL(url);
      const p = pages[u.pathname];
      if (p === undefined) {
        return Promise.resolve({
          ok: true,
          status: 404,
          finalUrl: url,
          contentType: 'text/html',
          body: null,
          error: null,
          latencyMs: 1,
        });
      }
      const html = p.html !== undefined && req.method === 'GET';
      return Promise.resolve({
        ok: true,
        status: p.status,
        finalUrl: p.location ?? url,
        contentType: p.html !== undefined ? 'text/html' : 'application/octet-stream',
        body: html ? Buffer.from(p.html ?? '') : null,
        error: null,
        latencyMs: 1,
      });
    },
  };
}

describe('crawl (bounded, same origin)', () => {
  it('finds broken pages and assets with the referring page; never requests other origins', async () => {
    const site = fakeSite({
      '/': {
        status: 200,
        html: '<a href="/a">a</a><a href="/missing">m</a><a href="https://other.test/x">x</a><img src="/ok.png"><img src="/gone.png">',
      },
      '/a': { status: 200, html: '<a href="/">home</a><link rel="stylesheet" href="/s.css">' },
      '/ok.png': { status: 200 },
      '/s.css': { status: 200 },
    });
    const r = await crawl({ start: 'https://site.test/', fetcher: site });
    expect(r.origin).toBe('https://site.test');
    expect(r.pages).toBe(3);
    expect(r.assets).toBe(3);
    expect(r.external).toBe(1);
    expect(r.broken.map((b) => [b.url, b.kind, b.status, b.from])).toEqual(
      expect.arrayContaining([
        ['https://site.test/missing', 'page', 404, 'https://site.test/'],
        ['https://site.test/gone.png', 'asset', 404, 'https://site.test/'],
      ]),
    );
    expect(site.calls.every((c) => c.url.startsWith('https://site.test/'))).toBe(true);
    // Assets: HEAD only.
    expect(site.calls.filter((c) => c.url.endsWith('.png')).every((c) => c.method === 'HEAD')).toBe(true);
  });

  it('respects maxDepth and maxPages (truncated)', async () => {
    const pages: Record<string, { status: number; html: string }> = {};
    for (let i = 0; i < 50; i++) {
      pages[i === 0 ? '/' : `/p${String(i)}`] = {
        status: 200,
        html: Array.from({ length: 50 }, (_x, j) => `<a href="/p${String(j + 1)}">x</a>`).join(''),
      };
    }
    const site = fakeSite(pages);
    const r = await crawl({ start: 'https://site.test/', fetcher: site, maxPages: 10, maxDepth: 1 });
    expect(r.pages).toBe(10);
    expect(r.truncated).toBe(true);
    expect(site.calls.length).toBe(10);
    const deep = fakeSite({
      '/': { status: 200, html: '<a href="/1">1</a>' },
      '/1': { status: 200, html: '<a href="/2">2</a>' },
      '/2': { status: 200, html: '<a href="/3">3</a>' },
      '/3': { status: 200, html: '' },
    });
    const d = await crawl({ start: 'https://site.test/', fetcher: deep, maxDepth: 2 });
    expect(deep.calls.map((c) => new URL(c.url).pathname)).toEqual(['/', '/1', '/2']);
    expect(d.pages).toBe(3);
  });

  it('respects maxAssets and the time budget', async () => {
    const html = Array.from({ length: 30 }, (_x, i) => `<img src="/i${String(i)}.png">`).join('');
    const site = fakeSite({ '/': { status: 200, html } });
    const r = await crawl({ start: 'https://site.test/', fetcher: site, maxAssets: 5 });
    expect(r.assets).toBe(5);
    expect(r.truncated).toBe(true);
    let t = 0;
    const slow = fakeSite({ '/': { status: 200, html: '<a href="/a">a</a><a href="/b">b</a>' } });
    const b = await crawl({
      start: 'https://site.test/',
      fetcher: slow,
      budgetMs: 1,
      now: () => (t += 10),
    });
    expect(b.budgetExhausted).toBe(true);
  });

  it('a start page that fails is the only finding; the origin follows its redirect', async () => {
    const down = await crawl({
      start: 'https://site.test/',
      fetcher: {
        page: () =>
          Promise.resolve({
            ok: false,
            status: null,
            finalUrl: null,
            contentType: null,
            body: null,
            error: 'dns',
            latencyMs: null,
          }),
      },
    });
    expect(down.origin).toBeNull();
    expect(down.broken).toEqual([
      { url: 'https://site.test/', kind: 'page', status: null, error: 'dns', from: null },
    ]);
    const moved = fakeSite({
      '/': { status: 200, html: '<a href="/x">x</a>', location: 'https://www.site.test/' },
    });
    const m = await crawl({ start: 'https://site.test/', fetcher: moved });
    expect(m.origin).toBe('https://www.site.test');
  });
});

describe('createProbe().page (guarded)', () => {
  let server: Server;
  let origin = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redir') {
        res.writeHead(302, { location: '/page' });
        res.end();
        return;
      }
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<a href="/x">x</a>'.repeat(1000));
        return;
      }
      if (req.url === '/bin') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.alloc(1000));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => {
      server.close(() => {
        r();
      });
    });
  });

  it('refuses loopback without an exception (SSRF guard)', async () => {
    const probe = createProbe();
    const r = await probe.page(`${origin}/page`, {
      method: 'GET',
      timeoutMs: 2000,
      maxBytes: 100,
      maxRedirects: 3,
    });
    expect(r.ok).toBe(false);
    expect(['url_refused', 'address_refused']).toContain(r.error);
  });

  it('follows redirects, reports the final URL and content type, reads HTML only up to maxBytes', async () => {
    const probe = createProbe({ allowOrigins: [origin] });
    const r = await probe.page(`${origin}/redir`, {
      method: 'GET',
      timeoutMs: 2000,
      maxBytes: 100,
      maxRedirects: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(`${origin}/page`);
    expect(r.contentType).toBe('text/html');
    expect(r.body?.length).toBe(100);
    const bin = await probe.page(`${origin}/bin`, {
      method: 'GET',
      timeoutMs: 2000,
      maxBytes: 100,
      maxRedirects: 3,
    });
    expect(bin.body).toBeNull();
    const head = await probe.page(`${origin}/page`, {
      method: 'HEAD',
      timeoutMs: 2000,
      maxBytes: 100,
      maxRedirects: 0,
    });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    const missing = await probe.page(`${origin}/nope`, {
      method: 'GET',
      timeoutMs: 2000,
      maxBytes: 100,
      maxRedirects: 0,
    });
    expect(missing.ok).toBe(true);
    expect(missing.status).toBe(404);
  });

  it('a redirect from an allowed origin to an internal address is refused', async () => {
    const s2 = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const o2 = `http://127.0.0.1:${String((s2.address() as AddressInfo).port)}`;
    const probe = createProbe({ allowOrigins: [o2] });
    const r = await probe.page(`${o2}/`, { method: 'GET', timeoutMs: 2000, maxBytes: 100, maxRedirects: 3 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('address_refused');
    await new Promise<void>((r2) => {
      s2.close(() => {
        r2();
      });
    });
  });
});
