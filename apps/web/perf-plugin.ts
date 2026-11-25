import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

/**
 * p14-web-perf (docs/design/p14-web-perf.md §3): build-time precompression of the content-hashed bundles. Every
 * `assets/*.{js,css,svg}` gets a `.br` (quality 11) and a `.gz` (level 9) sibling; the web image's nginx serves them
 * (`gzip_static` and the `.br` rewrite in apps/web/Dockerfile) with `Content-Encoding` and `Vary: Accept-Encoding`,
 * instead of gzipping each request at nginx's default level 1. Node's zlib only — no extra dependency.
 *
 * Every matching file always gets both siblings (also tiny ones): the nginx rule relies on the `.br` existing. They
 * are not part of the build manifest, so the service worker never precaches them (src/sw/logic.ts precacheList).
 */
export const PRECOMPRESS = /^assets\/[^/]+\.(js|css|svg)$/;

export function precompress(code: Uint8Array): { br: Buffer; gz: Buffer } {
  return {
    br: brotliCompressSync(code, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: code.byteLength,
      },
    }),
    gz: gzipSync(code, { level: 9 }),
  };
}

export function compressPlugin(): Plugin {
  return {
    name: 'remyral-precompress',
    apply: 'build',
    async writeBundle(options, bundle) {
      const dir = options.dir;
      if (dir === undefined) throw new Error('precompress: output dir missing');
      const jobs: Promise<void>[] = [];
      for (const [file, out] of Object.entries(bundle)) {
        if (!PRECOMPRESS.test(file)) continue;
        const code = out.type === 'chunk' ? Buffer.from(out.code) : Buffer.from(out.source);
        const { br, gz } = precompress(code);
        jobs.push(writeFile(join(dir, `${file}.br`), br), writeFile(join(dir, `${file}.gz`), gz));
      }
      await Promise.all(jobs);
    },
  };
}

/**
 * p14-web-perf (docs/design/p14-web-perf.md §5): `<link rel="preload">` for the one font file the default UI needs
 * for its first paint — Inter (variable), latin subset (body text; p17-remyral-brand). Every other face and subset stays
 * on demand through its `unicode-range` and `font-display: swap` (src/diyalog/diyalog.css, src/fonts.css), so the
 * Turkish latin-ext letters and the bold/mono faces load only when a page uses them.
 */
export const PRELOAD_FONTS = [/^assets\/inter-latin-wght-normal-[\w-]+\.woff2$/];

export function fontPreloadTags(files: readonly string[]): string {
  return files
    .filter((f) => PRELOAD_FONTS.some((re) => re.test(f)))
    .map((f) => `<link rel="preload" href="/${f}" as="font" type="font/woff2" crossorigin>`)
    .join('\n    ');
}

export function fontPreloadPlugin(): Plugin {
  return {
    name: 'remyral-font-preload',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const tags = fontPreloadTags(Object.keys(ctx.bundle ?? {}));
        if (tags === '') throw new Error('font preload: the Diyalog body font is missing from the bundle');
        return html.replace('</head>', `    ${tags}\n  </head>`);
      },
    },
  };
}
