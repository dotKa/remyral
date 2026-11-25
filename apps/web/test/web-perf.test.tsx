import { act, render, screen } from '@testing-library/react';
import { type ReactNode, StrictMode, Suspense } from 'react';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fontPreloadTags, precompress, PRECOMPRESS } from '../perf-plugin';
import { apiRequest, inflightGetCount } from '../src/api/client';
import { isChunkLoadError, RouteBoundary } from '../src/lib/RouteBoundary';
import { lazyScreen } from '../src/lib/lazyScreen';
import { forgetRemembered, remember, remembered } from '../src/lib/remembered';
import { precacheList } from '../src/sw/logic';

/**
 * p14-web-perf (docs/design/p14-web-perf.md): route-level code splitting (lazy screens, preload, the route boundary),
 * GET dedupe, the remembered last answers and the build-time precompression / font preload.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Hello(props: { readonly name: string }): ReactNode {
  return <p>Hello {props.name}</p>;
}

describe('lazyScreen', () => {
  it('suspends until its chunk loads, then renders; once loaded it renders synchronously', async () => {
    const chunk = deferred<{ Hello: typeof Hello }>();
    const load = vi.fn(() => chunk.promise);
    const Lazy = lazyScreen(load, 'Hello');
    const first = render(
      <Suspense fallback={<p>loading</p>}>
        <Lazy name="Ada" />
      </Suspense>,
    );
    expect(screen.getByText('loading')).toBeTruthy();
    expect(Lazy.loaded()).toBe(false);
    await act(async () => {
      chunk.resolve({ Hello });
      await chunk.promise;
    });
    expect(await screen.findByText('Hello Ada')).toBeTruthy();
    first.unmount();
    // A second mount (a revisit) never shows the fallback and never loads again.
    render(
      <Suspense fallback={<p>loading again</p>}>
        <Lazy name="Grace" />
      </Suspense>,
    );
    expect(screen.getByText('Hello Grace')).toBeTruthy();
    expect(screen.queryByText('loading again')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('preload() starts the download once and a preloaded screen renders without its fallback', async () => {
    const load = vi.fn(() => Promise.resolve({ Hello }));
    const Lazy = lazyScreen(load, 'Hello');
    await Promise.all([Lazy.preload(), Lazy.preload()]);
    expect(load).toHaveBeenCalledTimes(1);
    render(
      <StrictMode>
        <Suspense fallback={<p>loading</p>}>
          <Lazy name="Lin" />
        </Suspense>
      </StrictMode>,
    );
    expect(screen.getByText('Hello Lin')).toBeTruthy();
  });

  it('a failed load is not cached: the next preload tries again', async () => {
    const load = vi
      .fn<() => Promise<{ Hello: typeof Hello }>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module: /assets/x.js'))
      .mockResolvedValueOnce({ Hello });
    const Lazy = lazyScreen(load, 'Hello');
    await expect(Lazy.preload()).rejects.toThrow(/dynamically imported/);
    await Lazy.preload();
    expect(Lazy.loaded()).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('RouteBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recognises the browsers’ chunk-load errors and nothing else', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /a.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });

  it('a chunk that cannot load shows the reload offer (not a blank page); intent + a new path try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const load = vi
      .fn<() => Promise<{ Hello: typeof Hello }>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module: /assets/y.js'))
      .mockResolvedValue({ Hello });
    const Lazy = lazyScreen(load, 'Hello');
    const ui = (path: string): ReactNode => (
      <RouteBoundary
        resetKey={path}
        loading={<p>loading</p>}
        failed={(reload) => (
          <button type="button" onClick={reload}>
            reload
          </button>
        )}
      >
        <Lazy name={path} />
      </RouteBoundary>
    );
    const r = render(ui('/a'));
    expect(await screen.findByRole('button', { name: 'reload' })).toBeTruthy();
    // The same path keeps saying so (no retry loop against a missing chunk) …
    r.rerender(ui('/a'));
    expect(screen.getByRole('button', { name: 'reload' })).toBeTruthy();
    // … a link's intent (hover / focus) loads it again, and the next navigation shows it.
    await act(async () => {
      await Lazy.preload();
    });
    r.rerender(ui('/b'));
    expect(await screen.findByText('Hello /b')).toBeTruthy();
  });

  it('an ordinary render error is not swallowed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Broken(): ReactNode {
      throw new Error('boom');
    }
    expect(() =>
      render(
        <RouteBoundary resetKey="/" loading={null} failed={() => <p>failed</p>}>
          <Broken />
        </RouteBoundary>,
      ),
    ).toThrow('boom');
  });
});

describe('GET dedupe (api/client.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(): { calls: string[]; answer: () => void } {
    const calls: string[] = [];
    const gate = deferred<null>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        await gate.promise;
        return new Response(JSON.stringify({ items: [{ id: 'a' }] }), { status: 200 });
      }),
    );
    return {
      calls,
      answer: () => {
        gate.resolve(null);
      },
    };
  }

  it('identical GETs in flight share one request; each caller gets its own copy; later calls fetch again', async () => {
    const f = stubFetch();
    const parse = (v: unknown): { items: { id: string }[] } => v as { items: { id: string }[] };
    const a = apiRequest('GET', '/workers', parse);
    const b = apiRequest('GET', '/workers', parse);
    const other = apiRequest('GET', '/approvals?status=pending', parse);
    expect(inflightGetCount()).toBe(2);
    f.answer();
    const [ra, rb] = await Promise.all([a, b, other]);
    expect(f.calls).toEqual(['/api/workers', '/api/approvals?status=pending']);
    expect(ra).toEqual(rb);
    expect(ra).not.toBe(rb);
    expect(inflightGetCount()).toBe(0);
    await apiRequest('GET', '/workers', parse);
    expect(f.calls.filter((u) => u === '/api/workers')).toHaveLength(2);
  });

  it('a GET with an abort signal, and every mutation, is never shared', async () => {
    const f = stubFetch();
    const parse = (v: unknown): unknown => v;
    const signal = new AbortController().signal;
    const a = apiRequest('GET', '/workers', parse, { signal });
    const b = apiRequest('GET', '/workers', parse);
    const c = apiRequest('POST', '/workers', parse, { body: {}, cookieString: '' });
    const d = apiRequest('POST', '/workers', parse, { body: {}, cookieString: '' });
    f.answer();
    await Promise.all([a, b, c, d]);
    expect(f.calls).toHaveLength(4);
  });
});

describe('remembered (stale-while-revalidate memory)', () => {
  it('keeps the last value per key, is cleared at once and stays bounded', () => {
    remember('a', 1);
    expect(remembered('a')).toBe(1);
    forgetRemembered();
    expect(remembered('a')).toBeUndefined();
    for (let i = 0; i < 250; i++) remember(`k${String(i)}`, i);
    expect(remembered('k0')).toBeUndefined();
    expect(remembered('k249')).toBe(249);
  });
});

describe('build: precompression and font preload (perf-plugin.ts)', () => {
  it('writes .br and .gz siblings that decode to the original, for JS/CSS/SVG under assets/ only', () => {
    const code = Buffer.from('export const x = 1;\n'.repeat(200));
    const { br, gz } = precompress(code);
    expect(brotliDecompressSync(br).equals(code)).toBe(true);
    expect(gunzipSync(gz).equals(code)).toBe(true);
    expect(br.length).toBeLessThan(code.length);
    expect(PRECOMPRESS.test('assets/index-abc.js')).toBe(true);
    expect(PRECOMPRESS.test('assets/index-abc.css')).toBe(true);
    expect(PRECOMPRESS.test('assets/font-abc.woff2')).toBe(false);
    expect(PRECOMPRESS.test('sw.js')).toBe(false);
    expect(PRECOMPRESS.test('index.html')).toBe(false);
  });

  it('never precaches the compressed siblings in the service worker', () => {
    const list = precacheList(['assets/a-1.js', 'assets/a-1.js.br', 'assets/a-1.js.gz'], []);
    expect(list).toEqual(['/assets/a-1.js']);
  });

  it('preloads only the Diyalog body font (Inter latin), not the other faces or subsets', () => {
    const tags = fontPreloadTags([
      'assets/inter-latin-wght-normal-FfmJh7DR.woff2',
      'assets/inter-latin-ext-wght-normal-x.woff2',
      'assets/plus-jakarta-sans-latin-wght-normal-y.woff2',
      'assets/jetbrains-mono-latin-wght-normal-z.woff2',
    ]);
    expect(tags).toBe(
      '<link rel="preload" href="/assets/inter-latin-wght-normal-FfmJh7DR.woff2" as="font" type="font/woff2" crossorigin>',
    );
  });
});
