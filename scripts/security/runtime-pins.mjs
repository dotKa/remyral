#!/usr/bin/env node
// Runtime pin consistency (p7-supply-chain, T-SUP-1; docs/design/p7-supply-chain.md §4):
//
//   node scripts/security/runtime-pins.mjs [--online] [--policy <runtime-policy.json>]
//
// The four agent runtimes are supply chain too (ADR-0023 removed OpenHands). This check fails (exit 1) unless every place that names
// a runtime version agrees with the compiled-in pins (packages/protocol/src/runtime-pins.ts — the default the
// worker uses when no runtime policy overrides it; the master's `default` policy carries no pins):
//   - the adapters' pinned constants (packages/agent-adapters/src/runtimes/*/{capabilities,pins}.ts) and the
//     Claude Agent SDK dependency of @remyral/agent-adapters (package.json + pnpm-lock.yaml integrity);
//   - docs/compat/README.md §1, ADR-0012's decision table and docs/ops/runtime-setup.md;
//   - the runtime images (infra/worker/images/<runtime>/package.json + package-lock.json + Dockerfile), and
//     the dev runtimes image (infra/dev/docker-worker/Dockerfile.runtimes);
//   - the Node.js pin of the worker installers (infra/worker/node/pin.env + vendored release keys,
//     scripts/security/node-pin.mjs), with --online re-verified against nodejs.org and its signature;
//   - the published checksums in infra/worker/images/runtime-checksums.json (npm integrity) — offline against
//     the lockfiles, and with --online against the npm registry (a republished or tampered artifact shows up as
//     a mismatch).
// --policy <file>: an exported runtime policy (GET /runtime-policies/:name) is compared too; a pin that
// differs from the compiled-in one is reported as a WARN (a staged upgrade is legitimate), never a failure.
/* global fetch, AbortSignal */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { REPO, readJson, readText } from './lib.mjs';
import { checkNodePin, checkNodePinOnline } from './node-pin.mjs';

const NPM_RUNTIMES = ['claude-code', 'codex', 'pi', 'opencode'];

/** Exact `X = 'value'` constant in a TypeScript source file. */
export function tsConst(text, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\n?\\s*'([^']+)'`).exec(text);
  return m ? m[1] : null;
}

/** The table row of a markdown document whose first cell starts with `label`. */
export function tableRow(text, label) {
  return text.split('\n').find((l) => l.startsWith(`| ${label}`)) ?? null;
}

/** Offline checks. `src` lets tests inject file contents; defaults read the repository. */
export function checkPins({ pins, checksums, read = readText, readJ = readJson }) {
  const fail = [];
  const need = (cond, msg) => {
    if (!cond) fail.push(msg);
  };
  const sdk = checksums['claude-code'].npm;

  // 1. compiled-in pins vs checksum manifest
  for (const [rt, c] of Object.entries(checksums)) {
    if (rt.startsWith('$')) continue;
    need(
      pins[rt]?.version === c.version,
      `runtime-checksums.json ${rt} ${c.version} != pins.ts ${pins[rt]?.version}`,
    );
    if (c.npm && rt !== 'claude-code')
      need(
        c.npm.version === pins[rt].version,
        `runtime-checksums.json ${rt} npm ${c.npm.version} != pin ${pins[rt].version}`,
      );
    if (c.npm)
      need(
        pins[rt].install.includes(`${c.npm.name}@${c.npm.version}`),
        `pins.ts ${rt}.install does not name ${c.npm.name}@${c.npm.version}`,
      );
  }

  // 2. adapter constants
  const adapters = 'packages/agent-adapters/src/runtimes';
  const consts = [
    [`${adapters}/claude-code/pins.ts`, 'CLAUDE_CODE_CLI_PIN', pins['claude-code'].version],
    [`${adapters}/claude-code/pins.ts`, 'CLAUDE_AGENT_SDK_PIN', sdk.version],
    [`${adapters}/codex/pins.ts`, 'CODEX_PIN', pins.codex.version],
    [`${adapters}/pi/capabilities.ts`, 'PI_PINNED_VERSION', pins.pi.version],
    [`${adapters}/opencode/capabilities.ts`, 'OPENCODE_PINNED_VERSION', pins.opencode.version],
  ];
  for (const [file, name, want] of consts) {
    const got = tsConst(read(file), name);
    need(got === want, `${file}: ${name} = ${got} != ${want}`);
  }

  // 3. the SDK the worker itself bundles
  const adapterPkg = readJ('packages/agent-adapters/package.json');
  need(
    adapterPkg.dependencies?.[sdk.name] === sdk.version,
    `@remyral/agent-adapters depends on ${sdk.name}@${adapterPkg.dependencies?.[sdk.name]} != ${sdk.version}`,
  );
  const lockLine = read('pnpm-lock.yaml')
    .split('\n')
    .findIndex((l) => l.trim() === `'${sdk.name}@${sdk.version}':`);
  const lockRes = lockLine === -1 ? '' : read('pnpm-lock.yaml').split('\n')[lockLine + 1];
  need(
    lockRes.includes(`integrity: ${sdk.integrity}`),
    `pnpm-lock.yaml: ${sdk.name}@${sdk.version} integrity differs from runtime-checksums.json`,
  );

  // 4. documentation
  const compat = read('docs/compat/README.md');
  const adr = read('docs/adr/0012-runtime-integration-surfaces.md');
  const setup = read('docs/ops/runtime-setup.md');
  const docLabel = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    pi: 'Pi',
    opencode: 'OpenCode',
  };
  for (const rt of Object.keys(docLabel)) {
    const c = checksums[rt];
    const want = [`${c.npm.name}@${c.npm.version}`];
    const row = tableRow(compat, docLabel[rt]);
    for (const w of want) need(row?.includes(w), `docs/compat/README.md §1 ${docLabel[rt]} row lacks ${w}`);
    const adrRow = tableRow(adr, docLabel[rt]);
    need(adrRow?.includes(want[0]), `ADR-0012 decision table ${docLabel[rt]} row lacks ${want[0]}`);
    const setupRow = tableRow(setup, docLabel[rt]);
    need(setupRow?.includes(want[0]), `docs/ops/runtime-setup.md §1 ${docLabel[rt]} row lacks ${want[0]}`);
  }
  if (rtRowMismatch(compat, 'claude-code', pins)) fail.push(rtRowMismatch(compat, 'claude-code', pins));
  for (const m of setup.matchAll(/--save-exact (\S+)@(\d[^\s]*)/g)) {
    const rt = NPM_RUNTIMES.find((r) => checksums[r].npm.name === m[1]);
    if (rt)
      need(
        m[2] === checksums[rt].npm.version,
        `docs/ops/runtime-setup.md installs ${m[1]}@${m[2]} != ${checksums[rt].npm.version}`,
      );
  }

  // 5. runtime images: package.json + lock + Dockerfile
  for (const rt of NPM_RUNTIMES) {
    const { name, version, integrity } = checksums[rt].npm;
    const dir = `infra/worker/images/${rt}`;
    const pkg = readJ(`${dir}/package.json`);
    need(
      pkg.dependencies?.[name] === version && Object.keys(pkg.dependencies).length === 1,
      `${dir}/package.json must depend on exactly ${name}@${version}`,
    );
    const lock = readJ(`${dir}/package-lock.json`);
    const top = lock.packages?.[`node_modules/${name}`];
    need(top?.version === version, `${dir}/package-lock.json locks ${name}@${top?.version} != ${version}`);
    need(
      top?.integrity === integrity,
      `${dir}/package-lock.json ${name} integrity differs from runtime-checksums.json`,
    );
    need(
      lock.packages?.['']?.dependencies?.[name] === version,
      `${dir}/package-lock.json root does not require ${name}@${version}`,
    );
    const docker = read(`${dir}/Dockerfile`);
    need(
      /npm ci\b[^\n]*--ignore-scripts/.test(docker),
      `${dir}/Dockerfile must install with npm ci --ignore-scripts`,
    );
    need(!/npm (install|i) /.test(docker), `${dir}/Dockerfile installs outside the lockfile`);
  }

  // 6. dev runtimes image ARGs
  const devImg = read('infra/dev/docker-worker/Dockerfile.runtimes');
  const args = {
    CLAUDE_AGENT_SDK_VERSION: sdk.version,
    CODEX_VERSION: pins.codex.version,
    PI_VERSION: pins.pi.version,
    OPENCODE_VERSION: pins.opencode.version,
  };
  for (const [arg, want] of Object.entries(args)) {
    const got = new RegExp(`^ARG ${arg}=(\\S+)`, 'm').exec(devImg)?.[1];
    need(got === want, `infra/dev/docker-worker/Dockerfile.runtimes ARG ${arg}=${got} != ${want}`);
  }
  return fail;
}

/** Claude Code's compat row must name the bundled CLI version, too. */
function rtRowMismatch(compat, rt, pins) {
  const row = tableRow(compat, 'Claude Code');
  return row?.includes(`bundles CLI ${pins[rt].version}`)
    ? null
    : `docs/compat/README.md §1 Claude Code row lacks "bundles CLI ${pins[rt].version}"`;
}

/** Compares an exported runtime policy with the compiled-in pins (warnings only). */
export function comparePolicy(policy, pins) {
  const warn = [];
  const rules = policy?.rules ?? policy?.document?.rules ?? policy?.version?.document?.rules ?? [];
  for (const r of Array.isArray(rules) ? rules : Object.values(rules)) {
    const rt = r.runtime;
    if (rt && r.pin && pins[rt] && r.pin !== pins[rt].version)
      warn.push(
        `policy pins ${rt}@${r.pin}, compiled-in pin is ${pins[rt].version} (staged upgrade? see p3-runtime-policy.md §7)`,
      );
  }
  return warn;
}

async function json(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Online: registries still publish exactly the recorded artifacts. */
export async function checkOnline(checksums) {
  const fail = [];
  const npmPkgs = [];
  for (const rt of NPM_RUNTIMES) {
    npmPkgs.push(checksums[rt].npm);
    if (checksums[rt].optionalCli) npmPkgs.push(checksums[rt].optionalCli);
  }
  for (const p of npmPkgs) {
    const meta = await json(`https://registry.npmjs.org/${p.name.replace('/', '%2F')}/${p.version}`);
    if (meta.dist?.integrity !== p.integrity)
      fail.push(`npm ${p.name}@${p.version}: registry integrity ${meta.dist?.integrity} != recorded`);
  }
  // every package in the runtime lockfiles (platform binaries included)
  for (const rt of NPM_RUNTIMES) {
    const lock = readJson(`infra/worker/images/${rt}/package-lock.json`);
    const entries = Object.entries(lock.packages).filter(([k]) => k);
    const queue = [...entries];
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let e = queue.shift(); e; e = queue.shift()) {
          const [path, p] = e;
          const name = path.slice(path.lastIndexOf('node_modules/') + 13);
          const ver = /\/-\/[^/]+-(\d[^/]*)\.tgz$/.exec(p.resolved ?? '')?.[1] ?? p.version;
          const realName = /^https:\/\/registry\.npmjs\.org\/(.+)\/-\//.exec(p.resolved ?? '')?.[1] ?? name;
          const meta = await json(`https://registry.npmjs.org/${realName.replace('/', '%2F')}/${ver}`);
          if (meta.dist?.integrity !== p.integrity)
            fail.push(`npm ${realName}@${ver} (${rt} lock): registry integrity differs from the lockfile`);
        }
      }),
    );
  }
  return fail;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { online: { type: 'boolean', default: false }, policy: { type: 'string' } },
  });
  const { RUNTIME_PINS } = await import(
    pathToFileURL(join(REPO, 'packages/protocol/src/runtime-pins.ts')).href
  );
  const checksums = readJson('infra/worker/images/runtime-checksums.json');
  const fail = checkPins({ pins: RUNTIME_PINS, checksums });
  // p5-worker-onboarding: the Node 24 the installers bootstrap (infra/worker/node/pin.env).
  fail.push(...checkNodePin());
  if (values.online) fail.push(...(await checkOnline(checksums)), ...(await checkNodePinOnline()));
  const warn = values.policy
    ? comparePolicy(JSON.parse(readFileSync(values.policy, 'utf8')), RUNTIME_PINS)
    : [];
  for (const [rt, p] of Object.entries(RUNTIME_PINS))
    console.log(`  ${rt.padEnd(12)} ${p.version.padEnd(10)} ${p.install}`);
  for (const w of warn) console.log(`  WARN ${w}`);
  for (const f of fail) console.log(`  FAIL ${f}`);
  console.log(
    fail.length === 0
      ? `runtime pins consistent${values.online ? ' (registries checked)' : ''}`
      : `${fail.length} problem(s)`,
  );
  process.exitCode = fail.length === 0 ? 0 : 1;
}
