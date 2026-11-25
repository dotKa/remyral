#!/usr/bin/env node
// Builds the ADR-0007 container-profile images (docs/design/p3-sandbox.md):
//   node infra/worker/images/build.mjs [--engine docker|podman] [--only base,pi,egress-proxy]
// Images are tagged remyral/<name>:<IMAGE_VERSION>. The worker config pins them
// (by digest in production: `docker image inspect --format '{{.Id}}'`).
// Runtime images are optional per worker; build the ones the worker runs.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE_VERSION = '0.1.0';
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');

export const IMAGES = {
  base: { tag: `remyral/runtime-base:${IMAGE_VERSION}`, dir: 'base' },
  'egress-proxy': { tag: `remyral/egress-proxy:${IMAGE_VERSION}`, dir: 'egress-proxy', bundle: true },
  pi: { tag: `remyral/runtime-pi:${IMAGE_VERSION}`, dir: 'pi' },
  codex: { tag: `remyral/runtime-codex:${IMAGE_VERSION}`, dir: 'codex' },
  'claude-code': { tag: `remyral/runtime-claude-code:${IMAGE_VERSION}`, dir: 'claude-code' },
  opencode: { tag: `remyral/runtime-opencode:${IMAGE_VERSION}`, dir: 'opencode' },
  // p14-workflow-engine 14.3 (K3): code node images, FROM the digests of FUNCTION_CODE_BASE_IMAGES (not runtime-base).
  'code-js': { tag: `remyral/code-js:${IMAGE_VERSION}`, dir: 'code-js' },
  'code-python': { tag: `remyral/code-python:${IMAGE_VERSION}`, dir: 'code-python' },
};

/** Bundles the egress proxy entry (TypeScript, node built-ins only) into one .mjs file. */
export async function bundleEgressProxy(outfile) {
  const requireFromWorker = createRequire(join(repo, 'apps', 'worker', 'package.json'));
  const { build } = await import(requireFromWorker.resolve('esbuild'));
  await build({
    absWorkingDir: join(repo, 'apps', 'worker'),
    entryPoints: ['src/sandbox/egress/main.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    conditions: ['@remyral/source'],
    legalComments: 'none',
    logLevel: 'warning',
  });
}

/**
 * Builds one image. `base` is used as build arg BASE for the others, so a test can
 * build `remyral/runtime-base:test` and derive the rest from it.
 */
export async function buildImage(name, { engine = 'docker', tag, base, quiet = true } = {}) {
  const spec = IMAGES[name];
  if (!spec) throw new Error(`unknown image ${name}`);
  const dir = join(here, spec.dir);
  let context = dir;
  let tmp;
  if (spec.bundle) {
    tmp = mkdtempSync(join(tmpdir(), 'remyral-img-'));
    copyFileSync(join(dir, 'Dockerfile'), join(tmp, 'Dockerfile'));
    await bundleEgressProxy(join(tmp, 'egress-proxy.mjs'));
    context = tmp;
  }
  try {
    const args = ['build', '--tag', tag ?? spec.tag, '--file', join(context, 'Dockerfile')];
    if (base) args.push('--build-arg', `BASE=${base}`);
    if (quiet) args.push('--quiet');
    args.push(context);
    execFileSync(engine, args, { stdio: quiet ? 'pipe' : 'inherit', timeout: 20 * 60_000 });
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  return tag ?? spec.tag;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const engine = opt('--engine') ?? 'docker';
  const only = (opt('--only') ?? 'base,egress-proxy').split(',');
  for (const name of only) {
    const tag = await buildImage(name, { engine, quiet: false });
    console.log(`built ${tag}`);
  }
}
