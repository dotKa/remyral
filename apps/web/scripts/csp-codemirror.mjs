#!/usr/bin/env node
/* global document, window, getComputedStyle -- page.evaluate / addInitScript bodies run in the browser */
// p19-ide W1 (docs/design/p19-ide.md §2.1, "Implementation (W1)"): CodeMirror under the console's Content-Security-Policy.
//
//   node apps/web/scripts/csp-codemirror.mjs
//
// Builds a small page (scripts/csp-codemirror/) that mounts the console's real code viewer and both diff views
// (src/diyalog/code/cm.ts), serves it with the master's exact CSP header (read from apps/master/src/app.ts), opens it in
// headless Chromium (Playwright, `pnpm --filter @remyral/web e2e:install` once) and checks:
//   1. no CSP violation from the console's editors (they mount in a shadow root: constructable stylesheets);
//   2. the editors are styled (CodeMirror's base theme applied: `.cm-editor` is a flex column, the gutter is there)
//      and syntax colours apply (a keyword token has the theme's colour);
//   3. the control — a plain EditorView mounted in the document — IS refused (`style-src`), so the check can fail.
// Exit 1 when any of this does not hold. No master, database or network needed.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const pageRoot = join(webRoot, 'scripts/csp-codemirror');
const appTs = readFileSync(join(webRoot, '../master/src/app.ts'), 'utf8');

/** `CONTENT_SECURITY_POLICY` of the master, as the header string it sends. */
function masterCsp() {
  const block = /export const CONTENT_SECURITY_POLICY = \{([\s\S]*?)\} as const;/.exec(appTs);
  if (block === null) throw new Error('CONTENT_SECURITY_POLICY not found in apps/master/src/app.ts');
  const parts = [];
  for (const m of block[1].matchAll(/'([a-z-]+)':\s*\[([^\]]*)\]/g)) {
    const values = [...m[2].matchAll(/"([^"]*)"|'([^']*)'/g)].map((v) => v[1] ?? v[2]);
    parts.push(`${m[1]} ${values.join(' ')}`);
  }
  return parts.join('; ');
}

const csp = masterCsp();
if (!csp.includes("style-src 'self'") || csp.includes('unsafe-inline'))
  throw new Error(`unexpected CSP: ${csp}`);

const out = await mkdtemp(join(tmpdir(), 'remyral-csp-cm-'));
await build({
  root: pageRoot,
  configFile: false,
  logLevel: 'warn',
  base: './',
  build: { outDir: out, emptyOutDir: true, modulePreload: { polyfill: false } },
});

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(out, path === '/' ? 'index.html' : path);
  readFile(file).then(
    (body) => {
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'content-security-policy': csp,
      });
      res.end(body);
    },
    () => {
      res.writeHead(404, { 'content-security-policy': csp });
      res.end();
    },
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const browser = await chromium.launch();
const failures = [];
const report = {};

/** Opens the page (`#control`: only the naive editor) and returns its CSP violations and what `probe` reads. */
async function visit(hash, probe) {
  const page = await browser.newPage();
  const violations = [];
  await page.exposeFunction('reportCsp', (v) => {
    violations.push(v);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      void window.reportCsp(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violations.push(`console: ${msg.text()}`);
  });
  await page.goto(`http://127.0.0.1:${String(port)}/${hash}`);
  await page.waitForFunction(() => window.cmReady === true);
  await page.waitForTimeout(500);
  const read = await page.evaluate(probe);
  await page.close();
  return { violations, read };
}

try {
  const main = await visit('', () => {
    const inShadow = (id) => document.getElementById(id)?.shadowRoot ?? null;
    const style = (root, sel) => {
      const el = root?.querySelector(sel) ?? null;
      return el === null ? null : getComputedStyle(el);
    };
    const viewer = inShadow('viewer');
    const keyword = [...(viewer?.querySelectorAll('.cm-line span') ?? [])].find(
      (s) => s.textContent === 'export',
    );
    const side = inShadow('side');
    const inline = inShadow('inline');
    return {
      viewerEditor: style(viewer, '.cm-editor')?.display ?? null,
      viewerDirection: style(viewer, '.cm-editor')?.flexDirection ?? null,
      viewerGutter: style(viewer, '.cm-gutters')?.display ?? null,
      keywordColor: keyword === undefined ? null : getComputedStyle(keyword).color,
      sideEditors: side?.querySelectorAll('.cm-mergeView .cm-editor').length ?? 0,
      sideChanged: side?.querySelectorAll('.cm-changedLine').length ?? 0,
      inlineDeleted: inline?.querySelectorAll('.cm-deletedChunk').length ?? 0,
      adoptedSheets: [viewer, side, inline].map((r) => r?.adoptedStyleSheets.length ?? 0),
      styleElements:
        document.querySelectorAll('style').length +
        [viewer, side, inline].reduce((n, r) => n + (r?.querySelectorAll('style').length ?? 0), 0),
    };
  });
  const control = await visit('#control', () => {
    const el = document.querySelector('#control .cm-editor');
    return { controlDisplay: el === null ? null : getComputedStyle(el).display };
  });
  Object.assign(report, { csp, console: main, control });
  if (main.violations.length > 0)
    failures.push(`CSP violations from the console editors: ${main.violations.join(' | ')}`);
  const r = main.read;
  if (r.viewerEditor !== 'flex' || r.viewerDirection !== 'column')
    failures.push('the viewer is not styled (CodeMirror base theme missing)');
  if (r.viewerGutter !== 'flex') failures.push('the viewer gutter is not styled');
  if (r.keywordColor !== 'rgb(120, 60, 200)')
    failures.push(`syntax colours did not apply (${String(r.keywordColor)})`);
  if (r.sideEditors !== 2 || r.sideChanged === 0) failures.push('the side-by-side diff did not render');
  if (r.inlineDeleted === 0) failures.push('the inline diff did not render');
  if (r.styleElements > 0) failures.push('a <style> element was written');
  if (!control.violations.some((v) => v.includes('style-src')))
    failures.push('the control was not refused: the check could not tell a broken editor apart');
  if (control.read.controlDisplay === 'flex')
    failures.push('the control got its styles: is the CSP header applied?');
} finally {
  await browser.close();
  server.close();
  await rm(out, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`CodeMirror CSP check FAILED:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('CodeMirror CSP check passed: the console editors run under the master CSP without a violation.');
