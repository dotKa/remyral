/**
 * The worker build version. Its own module without imports, so the boot guard (src/boot/guard.ts) can name the
 * version before anything else of the worker is evaluated.
 */

/** Set by the release build (`scripts/release/sign.mjs` → esbuild `define`); absent in source runs. */
declare const __REMYRAL_WORKER_VERSION__: string | undefined;

export const WORKER_VERSION: string =
  typeof __REMYRAL_WORKER_VERSION__ === 'string' ? __REMYRAL_WORKER_VERSION__ : '0.1.0';
