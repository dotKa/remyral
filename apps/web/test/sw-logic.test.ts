import { describe, expect, it } from 'vitest';
import { injectManifest, SHELL_FILES, swManifest } from '../pwa-plugin';
import * as page from '../src/pwa/serviceWorker';
import {
  BADGE_ICON,
  cacheName,
  clickTarget,
  MSG_NAVIGATE,
  MSG_PUSH,
  MSG_SKIP_WAITING,
  notificationFromPush,
  precacheList,
  routeRequest,
  safeLink,
  staleCaches,
} from '../src/sw/logic';

/** p8-pwa: the service worker's decisions (docs/design/p8-pwa.md §2) and the build-time manifest. */
const ORIGIN = 'https://remyral.example.com';
const PRECACHE = new Set(['/assets/index-abc.js', '/assets/index-def.css', '/offline.html']);
const get = (path: string, mode = 'cors') => ({ method: 'GET', url: `${ORIGIN}${path}`, mode });

describe('request routing (what the worker may intercept)', () => {
  it('never intercepts the API, worker/hook paths, other methods or other origins', () => {
    for (const path of [
      '/api/auth/session',
      '/api',
      '/api/notifications',
      '/v1/worker',
      '/v1/hooks/github',
    ]) {
      expect(routeRequest(get(path), ORIGIN, PRECACHE), path).toBe('bypass');
      expect(routeRequest(get(path, 'navigate'), ORIGIN, PRECACHE), `${path} navigate`).toBe('bypass');
    }
    expect(
      routeRequest({ method: 'POST', url: `${ORIGIN}/assets/index-abc.js`, mode: 'cors' }, ORIGIN, PRECACHE),
    ).toBe('bypass');
    expect(
      routeRequest(
        { method: 'GET', url: 'https://cdn.example.com/assets/index-abc.js', mode: 'cors' },
        ORIGIN,
        PRECACHE,
      ),
    ).toBe('bypass');
    // Not precached (e.g. a file of an older build, downloads, the manifest): network.
    expect(routeRequest(get('/assets/other.js'), ORIGIN, PRECACHE)).toBe('bypass');
    expect(routeRequest(get('/manifest.json'), ORIGIN, PRECACHE)).toBe('bypass');
    expect(routeRequest(get('/assets/index-abc.js?x=1'), ORIGIN, PRECACHE)).toBe('bypass');
    expect(routeRequest({ method: 'GET', url: 'not a url', mode: 'cors' }, ORIGIN, PRECACHE)).toBe('bypass');
  });

  it('serves navigations network-first and the precached shell cache-first', () => {
    expect(routeRequest(get('/jobs/123', 'navigate'), ORIGIN, PRECACHE)).toBe('navigate');
    expect(routeRequest(get('/', 'navigate'), ORIGIN, PRECACHE)).toBe('navigate');
    expect(routeRequest(get('/assets/index-abc.js'), ORIGIN, PRECACHE)).toBe('shell');
    expect(routeRequest(get('/offline.html'), ORIGIN, PRECACHE)).toBe('shell');
  });

  it('precaches only hashed bundles/fonts plus the shell files, never source maps or index.html', () => {
    const list = precacheList(
      [
        'index.html',
        'assets/index-abc.js',
        'assets/index-abc.js.map',
        'assets/font-x.woff2',
        'assets/index-def.css',
        'sw.js',
      ],
      ['/offline.html'],
    );
    expect(list).toEqual([
      '/assets/font-x.woff2',
      '/assets/index-abc.js',
      '/assets/index-def.css',
      '/offline.html',
    ]);
  });

  it('deletes only older Remyral caches on activate', () => {
    expect(staleCaches(['remyral-shell-old', cacheName('new'), 'other-app'], 'new')).toEqual([
      'remyral-shell-old',
    ]);
  });
});

describe('push → notification', () => {
  it('shows the payload’s title, text and console link, with tag = notification id', () => {
    const n = notificationFromPush(
      JSON.stringify({
        v: 1,
        id: '6f1c2b8e-9a55-4c7e-8a1d-0d3f5e7a9b21',
        kind: 'approval.requested',
        severity: 'warning',
        title: 'Approval requested',
        body: 'git.push on job 1234abcd',
        link: '/approvals/42',
        ts: 1_760_000_000_000,
      }),
    );
    expect(n.title).toBe('Approval requested');
    expect(n.options).toMatchObject({
      body: 'git.push on job 1234abcd',
      tag: '6f1c2b8e-9a55-4c7e-8a1d-0d3f5e7a9b21',
      badge: BADGE_ICON,
      requireInteraction: true,
      timestamp: 1_760_000_000_000,
      data: { link: '/approvals/42' },
    });
  });

  it('always shows something, never an off-origin link, and caps the text', () => {
    for (const raw of [null, 'not json', '{"v":2,"title":"x"}', '[]', 'x'.repeat(5000)]) {
      const n = notificationFromPush(raw);
      expect(n.title).toBe('Remyral');
      expect(n.options.data.link).toBe('/');
    }
    const evil = notificationFromPush(
      JSON.stringify({
        v: 1,
        title: `A\nB${'x'.repeat(200)}`,
        body: 'y'.repeat(500),
        link: '//evil.example/x',
      }),
    );
    expect(evil.title).not.toContain('\n');
    expect(Array.from(evil.title).length).toBeLessThanOrEqual(80);
    expect(Array.from(evil.options.body).length).toBeLessThanOrEqual(180);
    expect(evil.options.data.link).toBe('/');
    expect(safeLink('javascript:alert(1)')).toBe('/');
    expect(safeLink('https://evil.example/')).toBe('/');
    expect(clickTarget({ link: '/jobs/1' }, ORIGIN)).toBe(`${ORIGIN}/jobs/1`);
    expect(clickTarget({ link: '//evil.example' }, ORIGIN)).toBe(`${ORIGIN}/`);
    expect(clickTarget(null, ORIGIN)).toBe(`${ORIGIN}/`);
  });

  it('the page and the worker agree on message types', () => {
    expect(page.MSG_SKIP_WAITING).toBe(MSG_SKIP_WAITING);
    expect(page.MSG_PUSH).toBe(MSG_PUSH);
    expect(page.MSG_NAVIGATE).toBe(MSG_NAVIGATE);
  });
});

describe('build manifest injection', () => {
  it('versions by file names and replaces the placeholder in any quote style', () => {
    const a = swManifest(['assets/index-abc.js']);
    const b = swManifest(['assets/index-abd.js']);
    expect(a.version).not.toBe(b.version);
    expect(a.precache).toEqual(expect.arrayContaining([...SHELL_FILES, '/assets/index-abc.js']));
    for (const code of [
      "var m=JSON.parse('__REMYRAL_SW_MANIFEST__')",
      'var m=JSON.parse("__REMYRAL_SW_MANIFEST__")',
      'var m=JSON.parse(`__REMYRAL_SW_MANIFEST__`)',
    ]) {
      const out = injectManifest(code, a);
      const m = /JSON\.parse\((.*)\)$/.exec(out)?.[1] ?? '';
      expect(JSON.parse(JSON.parse(m) as string)).toEqual(a);
    }
    expect(() => injectManifest('var m = 1', a)).toThrow('placeholder');
  });
});
