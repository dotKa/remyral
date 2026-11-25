import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import { precacheList } from './src/sw/logic';

/**
 * p8-pwa (docs/design/p8-pwa.md §2): builds `/sw.js` from src/sw/sw.ts as a separate chunk and injects
 * the build manifest — a version derived from the emitted file names (content-hashed) and the list of
 * shell files to precache. Production builds only; the dev server never registers a worker.
 *
 * The worker must be a classic script: the build fails if the chunk imports anything (a shared chunk would
 * also put worker code into the app bundle).
 */
export const SW_ENTRY = 'src/sw/sw.ts';
export const SW_FILE = 'sw.js';
const PLACEHOLDER = /(["'`])__REMYRAL_SW_MANIFEST__\1/;

/** Static files from public/ that belong to the shell (always present, not content-hashed). */
export const SHELL_FILES = [
  '/offline.html',
  '/offline.css',
  '/icon-192.png',
  '/badge-96.png',
  '/favicon.svg',
  // p17-remyral-brand: the lock-ups of the offline page.
  '/brand/logo-on-light.png',
  '/brand/logo-on-dark.png',
  // p17-remyral-brand: the theme mark before the first paint (index.html, offline page).
  '/theme-boot.js',
];

export function swManifest(files: readonly string[]): { version: string; precache: string[] } {
  const precache = precacheList(files, SHELL_FILES);
  // The hashed names change with any content change; SHELL_FILES content is versioned with the repo.
  const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 16);
  return { version, precache };
}

export function injectManifest(code: string, manifest: { version: string; precache: string[] }): string {
  if (!PLACEHOLDER.test(code)) throw new Error('pwa: manifest placeholder not found in sw.js');
  // JSON inside a JS string literal: stringify twice.
  return code.replace(PLACEHOLDER, () => JSON.stringify(JSON.stringify(manifest)));
}

export function pwaPlugin(): Plugin {
  return {
    name: 'remyral-pwa',
    apply: 'build',
    buildStart() {
      this.emitFile({ type: 'chunk', id: SW_ENTRY, fileName: SW_FILE });
    },
    generateBundle(_options, bundle) {
      const sw = bundle[SW_FILE];
      if (sw?.type !== 'chunk') throw new Error('pwa: sw.js chunk missing');
      if (sw.imports.length > 0 || sw.dynamicImports.length > 0 || /^\s*(import|export)\b/m.test(sw.code)) {
        throw new Error(`pwa: sw.js must be self-contained, it imports ${sw.imports.join(', ')}`);
      }
      const files = Object.keys(bundle).filter((f) => f !== SW_FILE);
      sw.code = injectManifest(sw.code, swManifest(files));
    },
  };
}
