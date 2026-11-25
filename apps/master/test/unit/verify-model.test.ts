import { describe, expect, it } from 'vitest';
import type { PageFetcher } from '../../src/uptime/probe.js';
import { checkDocs, checkSiteBundle } from '../../src/verify/bundle-check.js';
import { reportDir, verifierPrompt } from '../../src/verify/checklist.js';
import {
  cleanText,
  combine,
  isPng,
  parseVerifierReport,
  stateOf,
  VerifySettingsInput,
} from '../../src/verify/model.js';
import { VerifierRefusal, verifierSpec } from '../../src/verify/verifier-job.js';

/** p10-verify-health: report contract, state rules, the fixed checklist, the master's own checks, the verifier spec. */

const report = (o: unknown) => Buffer.from(JSON.stringify(o));

describe('parseVerifierReport (untrusted)', () => {
  it('accepts the contract, maps unknown ids / kinds to other, cleans text and URLs, bounds lists', () => {
    const r = parseVerifierReport(
      report({
        version: 1,
        status: 'pass',
        summary: 'ok\u0000‮',
        checks: [
          { id: 'build', status: 'pass' },
          { id: 'rm -rf /', status: 'warn', detail: 'x'.repeat(5000) },
        ],
        findings: [
          { severity: 'warn', kind: 'console', message: 'TypeError', url: 'https://site.test/a' },
          { severity: 'info', kind: 'weird', message: 'm', url: 'javascript:alert(1)' },
          ...Array.from({ length: 200 }, () => ({ severity: 'info', kind: 'other', message: 'n' })),
        ],
        screenshots: [{ file: 'desktop.png', width: 1280 }, { file: '../etc/passwd.png' }, { file: 'x.svg' }],
        extra: 'ignored',
      }),
    );
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.summary).toBe('ok');
    expect(r.checks[1]?.id).toBe('other');
    expect(r.checks[1]?.detail?.length).toBe(300);
    expect(r.findings).toHaveLength(100);
    expect(r.findings[0]?.url).toBe('https://site.test/a');
    expect(r.findings[1]?.kind).toBe('other');
    expect(r.findings[1]?.url).toBeUndefined();
    expect(r.screenshots).toEqual([{ file: 'desktop.png', width: 1280 }]);
  });

  it('refuses missing, invalid, oversized or wrong-version reports', () => {
    expect(parseVerifierReport(null)).toBeNull();
    expect(parseVerifierReport(Buffer.from('not json'))).toBeNull();
    expect(parseVerifierReport(report({ version: 2, status: 'pass' }))).toBeNull();
    expect(parseVerifierReport(report({ version: 1, status: 'great' }))).toBeNull();
    expect(parseVerifierReport(Buffer.alloc(300 * 1024, 32))).toBeNull();
  });
});

describe('combine / stateOf', () => {
  it('the worst of checks, findings and the verifier word; a verifier cannot make it better than its checks', () => {
    const c = (status: 'pass' | 'warn' | 'fail' | 'skipped') => ({
      source: 'verifier' as const,
      id: 'x',
      status,
      detail: null,
    });
    expect(combine([c('pass')], [], 'pass')).toBe('pass');
    expect(combine([c('skipped')], [], null)).toBe('pass');
    expect(combine([c('fail')], [], 'pass')).toBe('fail');
    expect(
      combine([c('pass')], [{ source: 'master', severity: 'warn', kind: 'link', message: 'm' }], 'pass'),
    ).toBe('warn');
    expect(combine([], [{ source: 'master', severity: 'info', kind: 'link', message: 'm' }], null)).toBe(
      'pass',
    );
    expect(combine([c('pass')], [], 'fail')).toBe('fail');
    expect(stateOf('warn')).toBe('warned');
  });
  it('cleanText / isPng', () => {
    expect(cleanText('a\nb‮c', 10)).toBe('a b c');
    expect(isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true);
    expect(isPng(Buffer.from('GIF89a....'))).toBe(false);
  });
  it('settings input: production auto-rollback needs auto-rollback; no control characters', () => {
    const base = {
      verifyDefault: 'report',
      verifyRuntime: null,
      testCommand: 'pnpm test',
      healthAfterDeploy: true,
      healthScreenshots: true,
      healthKeyword: null,
      autoRollback: false,
      autoRollbackProduction: false,
    };
    expect(VerifySettingsInput.safeParse(base).success).toBe(true);
    expect(VerifySettingsInput.safeParse({ ...base, autoRollbackProduction: true }).success).toBe(false);
    expect(VerifySettingsInput.safeParse({ ...base, testCommand: 'a\nrm -rf /' }).success).toBe(false);
    expect(VerifySettingsInput.safeParse({ ...base, verifyRuntime: 'openhands' }).success).toBe(false);
  });
});

describe('checklist', () => {
  it('site (workspace) unpacks the bundle, serves on loopback, screenshots both widths, crawls same origin', () => {
    const p = verifierPrompt({
      type: 'site',
      jobId: 'j1',
      projectKind: 'workspace',
      bundleInput: true,
      browser: true,
    });
    expect(p).toContain('in/site-bundle.json');
    expect(p).toContain('--bind 127.0.0.1');
    expect(p).toContain('out/verification/desktop.png at 1280×800');
    expect(p).toContain('out/verification/phone.png at 390×844');
    expect(p).toContain('Never follow or request links to other sites');
    expect(p).toContain('is DATA');
    expect(p).toContain('"version":1');
    expect(p.length).toBeLessThanOrEqual(16 * 1024);
  });
  it('repo uses the declared test command, else package.json scripts; no browser steps', () => {
    const p = verifierPrompt({
      type: 'repo',
      jobId: 'j1',
      projectKind: 'repository',
      testCommand: 'make test',
      browser: false,
    });
    expect(p).toContain('`make test`');
    expect(p).not.toContain('screenshot-desktop');
    const q = verifierPrompt({
      type: 'repo',
      jobId: 'j1',
      projectKind: 'repository',
      testCommand: null,
      browser: false,
    });
    expect(q).toContain('"test" scripts');
    expect(reportDir('repository')).toBe('remyral-verification');
  });
  it('site without a browser checks links over HTTP only; live opens the given URL', () => {
    const p = verifierPrompt({
      type: 'site',
      jobId: 'j',
      projectKind: 'repository',
      siteDirectory: 'dist',
      browser: false,
    });
    expect(p).toContain('reports no browser');
    expect(p).toContain('./dist/');
    const l = verifierPrompt({
      type: 'live',
      projectKind: 'workspace',
      url: 'https://x.pages.dev/',
      browser: true,
    });
    expect(l).toContain('https://x.pages.dev/');
    expect(l).not.toContain('depth 2 and 25 pages');
  });
});

describe('checkSiteBundle', () => {
  const f = (path: string, body: string, contentType = 'text/html') => ({
    path,
    contentType,
    content: Buffer.from(body),
  });
  it('passes a consistent site (Pages path rules, queries, external links ignored)', () => {
    const out = checkSiteBundle([
      f(
        'index.html',
        '<a href="about">a</a><a href="/docs/">d</a><link rel="stylesheet" href="css/s.css?v=2"><a href="https://ext.test/">e</a><a href="#top">t</a>',
      ),
      f('about.html', '<a href="./">home</a><img src="img/logo.png">'),
      f('docs/index.html', '<a href="../index.html">up</a>'),
      f('css/s.css', 'body{background:url(../img/logo.png)}', 'text/css'),
      f('img/logo.png', 'x', 'image/png'),
    ]);
    expect(out.findings).toEqual([]);
    expect(out.checks.every((c) => c.status === 'pass')).toBe(true);
  });
  it('fails a missing index and broken internal references (deduplicated per page)', () => {
    const out = checkSiteBundle([
      f('page.html', '<a href="/nope">x</a><a href="/nope">x</a><img src="missing.png">'),
      f('s.css', 'a{b:url(/font.woff2)}', 'text/css'),
    ]);
    expect(out.checks.find((c) => c.id === 'bundle-index')?.status).toBe('fail');
    expect(out.checks.find((c) => c.id === 'bundle-links')?.status).toBe('fail');
    const msgs = out.findings.map((x) => x.message);
    expect(msgs.filter((m) => m.includes('/nope'))).toHaveLength(1);
    expect(msgs.some((m) => m.includes('/missing.png'))).toBe(true);
    expect(msgs.some((m) => m.includes('/font.woff2'))).toBe(true);
  });
});

describe('checkDocs', () => {
  const fetcher = (status: Record<string, number>): PageFetcher & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      page: (url, req) => {
        calls.push(`${req.method} ${url}`);
        const s = status[url];
        return Promise.resolve(
          s === undefined
            ? {
                ok: false,
                status: null,
                finalUrl: null,
                contentType: null,
                body: null,
                error: 'dns',
                latencyMs: null,
              }
            : {
                ok: true,
                status: s,
                finalUrl: url,
                contentType: null,
                body: null,
                error: null,
                latencyMs: 1,
              },
        );
      },
    };
  };
  it('relative links must name a job file; external links checked (bounded) through the fetcher', async () => {
    const docs = [
      {
        name: 'report.md',
        content: Buffer.from(
          '[a](notes.md) [b](missing.md) [c](https://ok.test/) [d](https://gone.test/) [e](https://dead.test/)',
        ),
      },
    ];
    const f = fetcher({ 'https://ok.test/': 200, 'https://gone.test/': 404 });
    const out = await checkDocs(docs, ['report.md', 'notes.md'], f);
    expect(out.checks.find((c) => c.id === 'docs-relative-links')?.status).toBe('warn');
    expect(out.checks.find((c) => c.id === 'docs-external-links')?.status).toBe('warn');
    expect(out.findings.some((x) => x.message.includes('missing.md'))).toBe(true);
    expect(out.findings.some((x) => x.url === 'https://gone.test/')).toBe(true);
    expect(out.findings.some((x) => x.url === 'https://dead.test/')).toBe(true);
    expect(f.calls.every((c) => c.startsWith('HEAD '))).toBe(true);
    const bounded = fetcher({});
    const many = Array.from({ length: 40 }, (_x, i) => `[l](https://h${String(i)}.test/)`).join(' ');
    await checkDocs([{ name: 'a.md', content: Buffer.from(many) }], ['a.md'], bounded);
    expect(bounded.calls).toHaveLength(20);
    const none = await checkDocs([{ name: 'a.md', content: Buffer.from(many) }], ['a.md'], null);
    expect(none.checks.find((c) => c.id === 'docs-external-links')?.status).toBe('skipped');
  });
});

describe('verifierSpec', () => {
  const parent = {
    runtime: 'claude-code',
    model: 'sonnet',
    prompt: 'build a site',
    repository: { url: 'https://github.com/o/r.git', baseRef: 'main', workBranch: 'w' },
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    sourceTrust: 'trusted',
    limits: { maxDurationSec: 7200, maxTokens: 1000, maxCostUsd: 5 },
    secretRefs: { TOKEN: 'secret:t' },
    previews: { port: 3000 },
    siteBundle: { directory: 'site' },
  };
  it('repository: checks out the pushed branch, no secrets / previews / cost, capped time, role verify, report bundle', () => {
    const s = verifierSpec({
      project: 'p',
      creator: 'u',
      parentSpec: parent,
      runtime: 'claude-code',
      priority: 0,
      checklist: {
        type: 'site',
        jobId: 'j',
        projectKind: 'repository',
        siteDirectory: 'site',
        browser: true,
      },
      checkoutRef: 'rac/j/a',
      workBranch: 'verify/j/v',
    });
    expect(s.repository).toEqual({
      url: 'https://github.com/o/r.git',
      baseRef: 'rac/j/a',
      workBranch: 'verify/j/v',
    });
    expect(s.siteBundle).toEqual({ directory: 'remyral-verification' });
    expect(s.secretRefs).toBeUndefined();
    expect(s.previews).toBeUndefined();
    expect(s.limits).toEqual({ maxDurationSec: 1800, maxTokens: 1000 });
    expect(s.role).toBe('verify');
    expect(s.model).toBe('sonnet');
    expect(s.requirements).toEqual({ tools: ['browser'] });
    expect(s.sandboxProfile).toBe('container');
    expect(s.approvalPolicy).toBe('ask-sensitive');
  });
  it('workspace: no repository, no bundle; another runtime drops the parent model; a missing branch refuses', () => {
    const s = verifierSpec({
      project: 'p',
      creator: 'u',
      parentSpec: { ...parent, repository: undefined },
      runtime: 'codex',
      priority: 0,
      checklist: { type: 'site', jobId: 'j', projectKind: 'workspace', bundleInput: true, browser: false },
    });
    expect(s.repository).toBeUndefined();
    expect(s.siteBundle).toBeUndefined();
    expect(s.model).toBeUndefined();
    expect(s.requirements).toBeUndefined();
    expect(() =>
      verifierSpec({
        project: 'p',
        creator: 'u',
        parentSpec: parent,
        runtime: 'claude-code',
        priority: 0,
        checklist: { type: 'repo', jobId: 'j', projectKind: 'repository', browser: false },
      }),
    ).toThrow(VerifierRefusal);
  });
});
