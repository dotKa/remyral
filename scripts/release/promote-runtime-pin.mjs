#!/usr/bin/env node
// Promote a verified runtime candidate into the release pins (p16-runtime-updates, docs/design/p16-runtime-updates.md §3):
//
//   node scripts/release/promote-runtime-pin.mjs --runtime <rt> --version <v> --lock <package-lock.json> [--write]
//
// <v> is the version the runtime reports (Claude Code: the CLI version; its agent SDK version is derived from the
// pinned SDK line, 0.3.<cli patch>, exactly as the master resolves it). <package-lock.json> is the lockfile of that
// release as the console offers it (Araçlar ve sürümler → Doğrulama adayları → Kilit dosyası; GET
// /fleet/tools/runtime-candidates/<rt>/<v>/lock): the tree the verification and the unverified installs used.
//
// Without --write it prints the plan. With --write it rewrites the mechanical pin sources that
// `pnpm security:pins` checks — packages/protocol/src/runtime-pins.ts, infra/worker/images/runtime-checksums.json,
// the image package.json + package-lock.json, the previous-pin snapshot (infra/worker/runtimes/<rt>/previous/), the
// adapter pin constant, the dev runtimes image ARG and the doc table rows — regenerates the worker's install manifest
// and runs the pin check. It never commits, pushes or releases: what stays human is printed at the end (ADR-0012
// note, the compat checklist, SDK dependencies + `pnpm install`, CHANGELOG, a worker release).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNTIMES = ['claude-code', 'codex', 'pi', 'opencode'];
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const REGISTRY = 'https://registry.npmjs.org/';
const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** The adapter constant that names the pin, per runtime ([file, constant, which value]). */
const ADAPTER_CONSTS = {
  'claude-code': [
    ['packages/agent-adapters/src/runtimes/claude-code/pins.ts', 'CLAUDE_CODE_CLI_PIN', 'version'],
    ['packages/agent-adapters/src/runtimes/claude-code/pins.ts', 'CLAUDE_AGENT_SDK_PIN', 'packageVersion'],
  ],
  codex: [['packages/agent-adapters/src/runtimes/codex/pins.ts', 'CODEX_PIN', 'version']],
  pi: [['packages/agent-adapters/src/runtimes/pi/capabilities.ts', 'PI_PINNED_VERSION', 'version']],
  opencode: [
    ['packages/agent-adapters/src/runtimes/opencode/capabilities.ts', 'OPENCODE_PINNED_VERSION', 'version'],
  ],
};
const DEV_ARG = {
  'claude-code': ['CLAUDE_AGENT_SDK_VERSION', 'packageVersion'],
  codex: ['CODEX_VERSION', 'version'],
  pi: ['PI_VERSION', 'version'],
  opencode: ['OPENCODE_VERSION', 'version'],
};
const DOC_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi', opencode: 'OpenCode' };
const DOCS = [
  'docs/compat/README.md',
  'docs/adr/0012-runtime-integration-surfaces.md',
  'docs/ops/runtime-setup.md',
];

export class PromoteError extends Error {}

/** Claude Code's SDK version for a CLI version on the pinned line (null: another line — not promotable here). */
export function sdkVersionFor(pin, version) {
  const cli = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const pinned = /^(\d+)\.(\d+)\.(\d+)$/.exec(pin.version);
  const sdk = /^(\d+)\.(\d+)\.\d+$/.exec(pin.packageVersion);
  if (!cli || !pinned || !sdk || cli[1] !== pinned[1] || cli[2] !== pinned[2]) return null;
  return `${sdk[1]}.${sdk[2]}.${cli[3]}`;
}

/** The checks the worker applies to a received lock (npm v3, registry tarballs, sha512, no links, the root pinned). */
export function checkLock(lock, rt, pkg, packageVersion) {
  if (lock?.lockfileVersion !== 3) throw new PromoteError('the lockfile must be package-lock.json v3');
  const root = lock.packages?.[''];
  if (root?.name !== `remyral-runtime-${rt}`)
    throw new PromoteError(`the lockfile root must be remyral-runtime-${rt} (the worker's resolve manifest)`);
  const deps = root.dependencies ?? {};
  if (Object.keys(deps).length !== 1 || deps[pkg] !== packageVersion)
    throw new PromoteError(`the lockfile root must require exactly ${pkg}@${packageVersion}`);
  for (const [path, p] of Object.entries(lock.packages)) {
    if (path === '') continue;
    if (!path.startsWith('node_modules/')) throw new PromoteError(`${path}: not under node_modules`);
    if (p.link) throw new PromoteError(`${path}: linked package`);
    if (p.inBundle) continue;
    if (typeof p.resolved !== 'string' || !p.resolved.startsWith(REGISTRY))
      throw new PromoteError(`${path}: not a registry.npmjs.org tarball`);
    if (typeof p.integrity !== 'string' || !SRI.test(p.integrity))
      throw new PromoteError(`${path}: no sha512 integrity`);
  }
  const top = lock.packages[`node_modules/${pkg}`];
  if (top?.version !== packageVersion) throw new PromoteError(`the lockfile locks ${pkg}@${top?.version}`);
  return top.integrity;
}

/** Replaces `field: 'old'` inside the `<rt>: { … }` block of runtime-pins.ts. */
function editPinsTs(text, rt, next) {
  const key = rt.includes('-') ? `'${rt}'` : rt;
  const start = text.indexOf(`  ${key}: {`);
  if (start === -1) throw new PromoteError(`runtime-pins.ts has no ${rt} block`);
  const end = text.indexOf('\n  },', start);
  let block = text.slice(start, end);
  const set = (field, value) => {
    const re = new RegExp(`(\\n\\s+${field}: )'[^']*'`);
    if (!re.test(block)) throw new PromoteError(`runtime-pins.ts ${rt}.${field} not found`);
    block = block.replace(re, `$1'${value}'`);
  };
  set('version', next.version);
  set('packageVersion', next.packageVersion);
  set(
    'install',
    rt === 'claude-code'
      ? `npm: ${next.package}@${next.packageVersion} (bundles Claude Code CLI ${next.version})`
      : `npm: ${next.package}@${next.packageVersion}`,
  );
  if (rt === 'claude-code')
    block = block.replace(
      /\/\/ The adapter uses [^\n]*\n/,
      `// The adapter uses ${next.package}@${next.packageVersion}, which bundles CLI ${next.version}.\n`,
    );
  return text.slice(0, start) + block + text.slice(end);
}

function replaceConst(text, name, value, file) {
  const re = new RegExp(`(export const ${name}\\s*=\\s*\\n?\\s*)'[^']+'`);
  if (!re.test(text)) throw new PromoteError(`${file}: ${name} not found`);
  return text.replace(re, `$1'${value}'`);
}

/**
 * The plan: every file the promotion rewrites with its new content, plus what stays human. Pure apart from reading
 * the repository (`read(rel)`, default: this checkout).
 */
export function planPromotion({
  runtime,
  version,
  lock,
  pins,
  read = (rel) => readFileSync(join(REPO, rel), 'utf8'),
}) {
  if (!RUNTIMES.includes(runtime)) throw new PromoteError(`unknown runtime ${runtime}`);
  if (!VERSION.test(version)) throw new PromoteError(`not an exact version: ${version}`);
  const pin = pins[runtime];
  if (version === pin.version) throw new PromoteError(`${runtime} ${version} is already the pin`);
  const packageVersion = runtime === 'claude-code' ? sdkVersionFor(pin, version) : version;
  if (packageVersion === null)
    throw new PromoteError(
      `${runtime} ${version} is not on the pinned ${pin.version} line (SDK ${pin.packageVersion})`,
    );
  const integrity = checkLock(lock, runtime, pin.package, packageVersion);
  const next = { version, package: pin.package, packageVersion, integrity };
  const files = new Map();
  const get = (rel) => files.get(rel) ?? read(rel);
  const put = (rel, text) => files.set(rel, text);

  put(
    'packages/protocol/src/runtime-pins.ts',
    editPinsTs(get('packages/protocol/src/runtime-pins.ts'), runtime, next),
  );

  const checksums = JSON.parse(get('infra/worker/images/runtime-checksums.json'));
  const human = [];
  checksums[runtime].version = version;
  checksums[runtime].npm = { name: pin.package, version: packageVersion, integrity };
  if (checksums[runtime].optionalCli !== undefined) {
    const cli = lock.packages[`node_modules/${checksums[runtime].optionalCli.name}`];
    if (cli?.version === version && SRI.test(cli.integrity ?? '')) {
      checksums[runtime].optionalCli = {
        ...checksums[runtime].optionalCli,
        version,
        integrity: cli.integrity,
      };
    } else {
      human.push(
        `runtime-checksums.json ${runtime}.optionalCli: record ${checksums[runtime].optionalCli.name}@${version} and its registry integrity (not in the lock).`,
      );
    }
  }
  put('infra/worker/images/runtime-checksums.json', `${JSON.stringify(checksums, null, 2)}\n`);

  const dir = `infra/worker/images/${runtime}`;
  const oldLock = get(`${dir}/package-lock.json`);
  const pkg = JSON.parse(get(`${dir}/package.json`));
  pkg.dependencies = { [pin.package]: packageVersion };
  put(`${dir}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);
  put(`${dir}/package-lock.json`, `${JSON.stringify(lock, null, 2)}\n`);
  // The old pin stays installable as the one allowed downgrade (runtime-install-manifest.mjs reads the snapshot).
  put(`infra/worker/runtimes/${runtime}/previous/version.txt`, `${pin.version}\n`);
  put(`infra/worker/runtimes/${runtime}/previous/package-lock.json`, oldLock);

  for (const [file, name, which] of ADAPTER_CONSTS[runtime])
    put(file, replaceConst(get(file), name, next[which], file));

  const devFile = 'infra/dev/docker-worker/Dockerfile.runtimes';
  const [arg, which] = DEV_ARG[runtime];
  const dev = get(devFile);
  const devRe = new RegExp(`^(ARG ${arg}=)\\S+`, 'm');
  if (!devRe.test(dev)) throw new PromoteError(`${devFile}: ARG ${arg} not found`);
  put(devFile, dev.replace(devRe, `$1${next[which]}`));

  const oldRef = `${pin.package}@${pin.packageVersion}`;
  const newRef = `${pin.package}@${packageVersion}`;
  for (const doc of DOCS) {
    const lines = get(doc).split('\n');
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith(`| ${DOC_LABEL[runtime]}`) && l.includes(oldRef)) {
        let n = l.split(oldRef).join(newRef);
        if (runtime === 'claude-code')
          n = n.split(`bundles CLI ${pin.version}`).join(`bundles CLI ${version}`);
        lines[i] = n;
        changed = true;
      } else if (l.includes(`--save-exact ${oldRef}`)) {
        lines[i] = l.split(`--save-exact ${oldRef}`).join(`--save-exact ${newRef}`);
        changed = true;
      }
    }
    if (changed) put(doc, lines.join('\n'));
  }

  human.push(
    'ADR-0012: add a dated note that the pin moved (old → new) and which verification run passed (console: Doğrulama adayları).',
    `docs/compat/${runtime}.md / docs/compat/README.md §2: re-check the capability rows; a version the contract suites did not run against stays unverified (ADR-0008).`,
    'CHANGELOG.md: the pin change under the next worker release.',
    'A worker release (docs/ops/worker-updates.md): machines install the new pin through the normal pinned path; the unverified label disappears there.',
  );
  if (runtime === 'claude-code')
    human.push(
      `packages/agent-adapters/package.json: ${pin.package} → ${packageVersion}, then \`pnpm install\` (pnpm-lock.yaml integrity must equal runtime-checksums.json).`,
    );
  if (runtime === 'codex')
    human.push(
      'The @openai/codex-sdk dependency and its compat row: move it with the CLI when the SDK is used.',
    );
  if (runtime === 'opencode')
    human.push('The @opencode-ai/sdk dependency and its compat row: move it with the server.');
  return { next, from: { version: pin.version, packageVersion: pin.packageVersion }, files, human };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      runtime: { type: 'string' },
      version: { type: 'string' },
      lock: { type: 'string' },
      write: { type: 'boolean', default: false },
    },
  });
  if (!values.runtime || !values.version || !values.lock) {
    console.error(
      'usage: promote-runtime-pin.mjs --runtime <rt> --version <v> --lock <package-lock.json> [--write]',
    );
    process.exit(2);
  }
  const { RUNTIME_PINS } = await import(
    pathToFileURL(join(REPO, 'packages/protocol/src/runtime-pins.ts')).href
  );
  let plan;
  try {
    plan = planPromotion({
      runtime: values.runtime,
      version: values.version,
      lock: JSON.parse(readFileSync(values.lock, 'utf8')),
      pins: RUNTIME_PINS,
    });
  } catch (err) {
    console.error(`refused: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(
    `${values.runtime}: ${plan.from.version} (${plan.from.packageVersion}) → ${plan.next.version} (${plan.next.package}@${plan.next.packageVersion}, ${plan.next.integrity.slice(0, 19)}…)`,
  );
  for (const f of plan.files.keys()) console.log(`  ${values.write ? 'write' : 'would write'} ${f}`);
  if (values.write) {
    for (const [rel, text] of plan.files) {
      const abs = join(REPO, rel);
      if (!existsSync(dirname(abs))) mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
    execFileSync(process.execPath, ['scripts/security/runtime-install-manifest.mjs', '--write'], {
      cwd: REPO,
      stdio: 'inherit',
    });
    try {
      execFileSync(process.execPath, ['scripts/security/runtime-pins.mjs'], { cwd: REPO, stdio: 'inherit' });
    } catch {
      console.log(
        '  the pin check still fails — finish the human steps below and run `pnpm security:pins` again',
      );
    }
  }
  console.log('\nStill to do by hand (never automated):');
  for (const h of plan.human) console.log(`  - ${h}`);
}
