#!/usr/bin/env node
// Bundles the worker CLI into one ESM file that needs only Node 24 (Claude Code jobs load the Agent SDK of the
// Claude Code runtime installed on the machine; it is never bundled):
//   node dist/remyral-worker.mjs probe --json > probe-<hostname>.json
// and the privileged updater (p2-signed-updates) into dist/remyral-worker-updater.mjs.
// Workspace packages are bundled from source via the `@remyral/source` condition.
//
// Release builds (scripts/release/sign.mjs) set, through the environment:
//   REMYRAL_BUILD_VERSION   semantic version compiled into both bundles (WORKER_VERSION)
//   REMYRAL_RELEASE_KEYS    comma-separated release public keys pinned into both bundles
//   REMYRAL_CATALOG_KEYS    comma-separated version-catalog public keys pinned into the worker (p17-update-channel)
//   REMYRAL_BUNDLE_OUTDIR   output directory (default: apps/worker/dist)
//
// oss-sdk-external: the proprietary Claude Agent SDK stays external (loaded at run time from the installed Claude
// Code runtime); the build fails if anything from node_modules/@anthropic-ai/ is bundled. The licence texts of the
// third-party packages that are bundled are appended to each bundle as `//` comments, before sign.mjs hashes it.
import { appendFileSync, chmodSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { bundledPackages, forbiddenInputs, licenseNotice } from './third-party.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const outdir = resolve(
  process.env.REMYRAL_BUNDLE_OUTDIR ?? fileURLToPath(new URL('../dist/', import.meta.url)),
);
const version = process.env.REMYRAL_BUILD_VERSION;
const keys = process.env.REMYRAL_RELEASE_KEYS;
// p17-update-channel (ADR-0065): catalog public keys pinned into the worker bundle (one or two).
const catalogKeys = process.env.REMYRAL_CATALOG_KEYS;
if (version !== undefined && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`REMYRAL_BUILD_VERSION is not a semantic version: ${version}`);
}
if (keys !== undefined && !/^([A-Za-z0-9_-]{43})(,[A-Za-z0-9_-]{43})?$/.test(keys)) {
  throw new Error('REMYRAL_RELEASE_KEYS must be one or two base64url Ed25519 public keys, comma-separated');
}
if (catalogKeys !== undefined && !/^([A-Za-z0-9_-]{43})(,[A-Za-z0-9_-]{43})?$/.test(catalogKeys)) {
  throw new Error('REMYRAL_CATALOG_KEYS must be one or two base64url Ed25519 public keys, comma-separated');
}
const define = {
  ...(catalogKeys === undefined ? {} : { __REMYRAL_CATALOG_KEYS__: JSON.stringify(catalogKeys) }),
  ...(version === undefined ? {} : { __REMYRAL_WORKER_VERSION__: JSON.stringify(version) }),
  ...(keys === undefined ? {} : { __REMYRAL_RELEASE_KEYS__: JSON.stringify(keys) }),
};

for (const [entry, name] of [
  ['src/bin.ts', 'remyral-worker.mjs'],
  ['src/update/helper/bin.ts', 'remyral-worker-updater.mjs'],
]) {
  const outfile = join(outdir, name);
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    conditions: ['@remyral/source'],
    define,
    // `ws` is CommonJS and require()s Node built-ins; give the ESM bundle a real `require` for them.
    // Its optional native addons (bufferutil, utf-8-validate) stay unresolved and ws falls back to JS.
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __remyralCreateRequire } from 'node:module';\nconst require = __remyralCreateRequire(import.meta.url);",
    },
    // The Claude Agent SDK is proprietary: never bundled (loaded from the machine's Claude Code runtime).
    external: ['bufferutil', 'utf-8-validate', '@anthropic-ai/claude-agent-sdk'],
    legalComments: 'none',
    sourcemap: false,
    metafile: true,
    logLevel: 'warning',
  });
  const forbidden = forbiddenInputs(result.metafile);
  if (forbidden.length > 0) {
    throw new Error(`${name}: proprietary code must not be bundled: ${forbidden.slice(0, 5).join(', ')}`);
  }
  const packages = bundledPackages(result.metafile, root);
  appendFileSync(outfile, licenseNotice(name, packages));
  chmodSync(outfile, 0o755);
  console.log(
    `worker: bundled ${outfile} (${String(Math.round(statSync(outfile).size / 1024))} KiB, ${String(packages.length)} third-party packages)`,
  );
}
