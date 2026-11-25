#!/usr/bin/env node
// The version catalog (p17-update-channel, ADR-0065, docs/ops/update-channel.md): runtime and tool versions with their
// integrity, signed with the narrow CATALOG key (never the release key) and published at <release URL>/catalog/.
//
//   node scripts/release/catalog.mjs keygen  --out <dir>
//       New Ed25519 catalog key: <dir>/catalog-key.pem (0600; the weekly runner's secret) + catalog-key.pub.
//   node scripts/release/catalog.mjs build   --out <draft.json> [--runtime <rt>=<version>]… [--tool <tool>=<version>]…
//                                            [--skip <item>[,<item>]] [--previous <catalog.json>]
//       Online. Resolves the newest upstream release of every runtime and tool (the master's version feed sources:
//       npm, GitHub releases, NuGet, Playwright, nodejs.org — never a range), exact version documents and integrity:
//       runtimes get their full npm lock (`npm install --package-lock-only --ignore-scripts`, every tarball's sha512),
//       tools get every platform asset downloaded and SHA-256-hashed (GitHub's asset digest must agree; Node's
//       SHASUMS256.txt signature is verified with the vendored keys). Everything starts `verified: false`.
//   node scripts/release/catalog.mjs test    --draft <draft.json> [--runtime <rt>]
//       Installs each runtime candidate from its lock (`npm ci --ignore-scripts`) and runs the repository's
//       real-binary contract suites against it (scripted providers, no credentials). Claude Code's suites need the
//       adapter's SDK at that version: reported `unsupported` (cannot be promoted here).
//   node scripts/release/catalog.mjs promote --draft <draft.json> --entry runtime:<rt>@<v>|tool:<tool>@<v> --canary "<evidence>"
//       Sets `verified` after the canary (the vendor's own canary machine installed it as an unverified catalog entry
//       and ran jobs). Runtimes need passed contract tests.
//   node scripts/release/catalog.mjs sign    --draft <draft.json> --key <catalog-key.pem> --site <release site dir>
//       Writes <site>/catalog/catalog.json + catalog.sig.json (domain remyral-version-catalog/v1) with the next
//       sequence after the one already in the site, after the structural checks (templates, registry tarballs, no
//       verified downgrade, ≤ 384 KiB).
//   node scripts/release/catalog.mjs verify  --site <dir> --public-key <pub>[,<pub>]
//   node scripts/release/catalog.mjs publish --site <dir> --to <dir>
//       Verifies and copies catalog/ into the release location's working directory (atomic rename); syncing that
//       directory to the release URL is the same step as for the control-plane bundle (docs/ops/selfhost-release.md §4).
/* global fetch, AbortSignal */
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CATALOG_CONTEXT,
  catalogFromDraft,
  checkCatalog,
  compareDotted,
  emptyDraft,
  MAX_CATALOG_BYTES,
  PLATFORMS,
  promoteEntry,
  RUNTIME_PACKAGES,
  RUNTIMES,
  runtimePackageVersion,
  TOOLS,
  toolAssetUrl,
} from './catalog-lib.mjs';
import {
  jsonBytes,
  keyIdOf,
  publicB64u,
  ReleaseError,
  signBytes,
  verifySigned,
} from './control-plane-lib.mjs';
import { npmPackages, scriptPackages } from '../security/runtime-install-manifest.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function die(message) {
  process.stderr.write(`catalog: ${message}\n`);
  process.exit(1);
}
const out = (line) => process.stdout.write(`${line}\n`);

let values;
let positionals;
try {
  ({ values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      draft: { type: 'string' },
      runtime: { type: 'string', multiple: true, default: [] },
      tool: { type: 'string', multiple: true, default: [] },
      skip: { type: 'string', default: '' },
      previous: { type: 'string' },
      entry: { type: 'string' },
      canary: { type: 'string' },
      key: { type: 'string' },
      site: { type: 'string' },
      to: { type: 'string' },
      'public-key': { type: 'string' },
      sequence: { type: 'string' },
    },
  }));
} catch (err) {
  die(err instanceof Error ? err.message : String(err));
}

const now = () => new Date().toISOString();
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pins = () => readJson(join(ROOT, 'infra/worker/images/runtime-checksums.json'));

function loadKey(path) {
  if (path === undefined) die('--key <catalog-key.pem> is required');
  const st = statSync(path);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0)
    die(`${path} is readable by group/others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== 'ed25519') die(`${path} is not an Ed25519 key`);
  return key;
}

// ------------------------------------------------------------------------------------------ upstream reads

async function getJson(url) {
  if (!url.startsWith('https://')) throw new ReleaseError(`refusing ${url}`);
  const res = await fetch(url, {
    redirect: 'error',
    headers: { accept: 'application/json', 'user-agent': 'remyral-catalog' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new ReleaseError(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Downloads `url` (GitHub assets redirect to their CDN), returning the SHA-256 and size of the bytes. */
async function hashUrl(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || res.body === null) throw new ReleaseError(`${url}: HTTP ${res.status}`);
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of res.body) {
    h.update(chunk);
    size += chunk.length;
  }
  return { sha256: h.digest('hex'), size };
}

const npmDoc = (pkg, version) =>
  getJson(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/${encodeURIComponent(version)}`);

async function resolveRuntime(rt, wanted) {
  const pin = pins()[rt];
  let version = wanted;
  if (version === undefined) {
    // The feed the master reads: the CLI package for Claude Code, the runtime's own package otherwise.
    const feedPkg = rt === 'claude-code' ? '@anthropic-ai/claude-code' : RUNTIME_PACKAGES[rt];
    version = (await npmDoc(feedPkg, 'latest')).version;
  }
  const packageVersion = runtimePackageVersion(rt, version, {
    version: pin.version,
    packageVersion: pin.npm.version,
  });
  if (packageVersion === null) throw new ReleaseError(`${rt} ${version} is not on the pinned SDK line`);
  const pkg = RUNTIME_PACKAGES[rt];
  const doc = await npmDoc(pkg, packageVersion);
  const integrity = doc?.dist?.integrity;
  if (!/^sha512-/.test(integrity ?? ''))
    throw new ReleaseError(`${pkg}@${packageVersion}: no sha512 integrity`);
  if (rt === 'claude-code' && doc.claudeCodeVersion !== undefined && doc.claudeCodeVersion !== version)
    throw new ReleaseError(`${pkg}@${packageVersion} bundles CLI ${doc.claudeCodeVersion}, not ${version}`);
  const dir = mkdtempSync(join(tmpdir(), 'remyral-catalog-'));
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'catalog-candidate', private: true, dependencies: { [pkg]: packageVersion } }),
    );
    writeFileSync(join(dir, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
    execFileSync(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'],
      {
        cwd: dir,
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, npm_config_userconfig: join(dir, '.npmrc') },
      },
    );
    const lock = readJson(join(dir, 'package-lock.json'));
    const scripts = scriptPackages(lock);
    return {
      version,
      packageVersion,
      integrity,
      verified: false,
      packages: npmPackages(lock, pkg, integrity),
      ...(scripts.length === 0 ? {} : { scripts }),
      lock,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GITHUB = {
  git: 'git-for-windows/git',
  ffmpeg: 'GyanD/codexffmpeg',
  cloudflared: 'cloudflare/cloudflared',
  uv: 'astral-sh/uv',
};

async function latestToolVersion(tool) {
  if (tool in GITHUB) {
    const rel = await getJson(`https://api.github.com/repos/${GITHUB[tool]}/releases/latest`);
    const tag = String(rel.tag_name ?? '');
    if (tool === 'git') {
      const m = /^v(\d+\.\d+\.\d+)\.windows\.(\d+)$/.exec(tag);
      if (!m) throw new ReleaseError(`git: unexpected tag ${tag}`);
      return { version: m[2] === '1' ? m[1] : `${m[1]}.${m[2]}`, digests: assetDigests(rel) };
    }
    return { version: tag.replace(/^v/, ''), digests: assetDigests(rel) };
  }
  if (tool === 'python') {
    const idx = await getJson('https://api.nuget.org/v3-flatcontainer/python/index.json');
    const line = readFileSync(join(ROOT, 'apps/worker/src/tools/recipes.ts'), 'utf8').match(
      /version: '(3\.\d+)\.\d+'/,
    )?.[1];
    const same = (idx.versions ?? []).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && v.startsWith(`${line}.`));
    return { version: same.sort(compareDotted).at(-1), digests: {} };
  }
  if (tool === 'node') {
    const list = await getJson('https://nodejs.org/dist/index.json');
    const major = /^NODE_VERSION=(\d+)\./m.exec(
      readFileSync(join(ROOT, 'infra/worker/node/pin.env'), 'utf8'),
    )?.[1];
    const hit = list.find((r) => r.lts && r.version.startsWith(`v${major}.`));
    return { version: hit.version.slice(1), digests: {} };
  }
  if (tool === 'browser') {
    const pw = await npmDoc('playwright-core', 'latest');
    const tgz = Buffer.from(
      await (await fetch(pw.dist.tarball, { signal: AbortSignal.timeout(60_000) })).arrayBuffer(),
    );
    const dir = mkdtempSync(join(tmpdir(), 'remyral-pw-'));
    try {
      writeFileSync(join(dir, 'p.tgz'), tgz);
      execFileSync('tar', ['-xzf', 'p.tgz', 'package/browsers.json'], { cwd: dir });
      const chromium = readJson(join(dir, 'package', 'browsers.json')).browsers.find(
        (b) => b.name === 'chromium',
      );
      return {
        version: String(chromium.revision),
        build: chromium.browserVersion,
        playwright: pw.version,
        digests: {},
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new ReleaseError(`unknown tool ${tool}`);
}

function assetDigests(rel) {
  const out = {};
  for (const a of rel.assets ?? [])
    if (/^sha256:[0-9a-f]{64}$/.test(a.digest ?? '')) out[a.browser_download_url] = a.digest.slice(7);
  return out;
}

async function nodeShasums(version) {
  const { verifySignature, hashesFrom } = await import('../security/node-pin.mjs');
  const base = `https://nodejs.org/dist/v${version}/`;
  const sums = Buffer.from(await (await fetch(`${base}SHASUMS256.txt`)).arrayBuffer());
  const sig = Buffer.from(await (await fetch(`${base}SHASUMS256.txt.sig`)).arrayBuffer());
  verifySignature(sums, sig);
  return hashesFrom(sums, version);
}

async function resolveTool(tool, wanted) {
  const latest = wanted === undefined ? await latestToolVersion(tool) : { version: wanted, digests: {} };
  if (tool === 'browser' && latest.build === undefined)
    throw new ReleaseError('browser: pass no version (it is read from Playwright)');
  const assets = {};
  const nodeHashes = tool === 'node' ? await nodeShasums(latest.version) : null;
  for (const p of PLATFORMS) {
    const url = toolAssetUrl(tool, p, latest.version, latest.build);
    if (url === null) continue;
    const got = await hashUrl(url);
    const published = latest.digests[url];
    if (published !== undefined && published !== got.sha256)
      throw new ReleaseError(`${url}: downloaded ${got.sha256}, GitHub says ${published}`);
    const nodeKey = {
      'linux-x64': 'linux-x64',
      'linux-arm64': 'linux-arm64',
      'darwin-x64': 'darwin-x64',
      'darwin-arm64': 'darwin-arm64',
      'win32-x64': 'win-x64',
    }[p];
    if (nodeHashes !== null && nodeHashes[nodeKey] !== got.sha256)
      throw new ReleaseError(`${url}: does not match the signed SHASUMS256.txt`);
    assets[p] = { url, sha256: got.sha256, size: got.size };
    out(`  ${tool} ${latest.version} ${p}  sha256 ${got.sha256}`);
  }
  return {
    version: latest.version,
    verified: false,
    ...(latest.build === undefined ? {} : { build: latest.build }),
    ...(latest.playwright === undefined ? {} : { playwright: latest.playwright }),
    assets,
    hashed: true,
  };
}

const parsePairs = (list) =>
  Object.fromEntries(
    list.map((s) => {
      const i = s.indexOf('=');
      if (i < 1) die(`expected <name>=<version>, got ${s}`);
      return [s.slice(0, i), s.slice(i + 1)];
    }),
  );

async function cmdBuild() {
  const dest = values.out ?? die('--out <draft.json> is required');
  const wantRt = parsePairs(values.runtime);
  const wantTool = parsePairs(values.tool);
  const skip = new Set(values.skip.split(',').filter(Boolean));
  const draft = emptyDraft(now());
  for (const rt of RUNTIMES) {
    if (skip.has(rt)) continue;
    out(`runtime ${rt} …`);
    const e = await resolveRuntime(rt, wantRt[rt]);
    if (compareDotted(e.version, pins()[rt].version) <= 0) {
      out(`  ${rt} ${e.version} is not above the release pin ${pins()[rt].version}; left out`);
      continue;
    }
    draft.runtimes[rt] = [e];
    out(`  ${rt} ${e.version} (${RUNTIME_PACKAGES[rt]}@${e.packageVersion}, ${e.packages.length} packages)`);
  }
  for (const tool of TOOLS) {
    if (skip.has(tool)) continue;
    out(`tool ${tool} …`);
    draft.tools[tool] = [await resolveTool(tool, wantTool[tool])];
  }
  writeFileSync(dest, `${JSON.stringify(draft, null, 2)}\n`);
  out(`draft → ${dest} (every entry unverified: run test, the canary, promote)`);
}

const SUITES = {
  codex: {
    env: 'REMYRAL_CODEX_BIN',
    expect: 'REMYRAL_CODEX_EXPECT_VERSION',
    files: ['test/runtimes/codex'],
    bin: 'node_modules/.bin/codex',
  },
  pi: {
    env: 'REMYRAL_PI_BIN',
    files: ['test/pi-real.test.ts', 'test/pi-subtasks-real.test.ts'],
    bin: 'node_modules/.bin/pi',
  },
  opencode: {
    env: 'REMYRAL_OPENCODE_BIN',
    files: ['test/opencode-real.test.ts', 'test/opencode-subtasks-real.test.ts'],
    bin: 'node_modules/.bin/opencode',
  },
};

function cmdTest() {
  const path = values.draft ?? die('--draft is required');
  const draft = readJson(path);
  for (const [rt, list] of Object.entries(draft.runtimes)) {
    if (values.runtime.length > 0 && !values.runtime.includes(rt)) continue;
    for (const e of list) {
      const suite = SUITES[rt];
      if (suite === undefined) {
        e.tests = {
          status: 'unsupported',
          at: now(),
          detail: 'the adapter suites need the SDK at this version (a release)',
        };
        out(`${rt} ${e.version}: unsupported here`);
        continue;
      }
      const dir = mkdtempSync(join(tmpdir(), 'remyral-candidate-'));
      try {
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify(e.lock.packages[''] ?? { name: 'c', private: true }),
        );
        writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(e.lock));
        execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
          cwd: dir,
          stdio: 'inherit',
        });
        const report = join(dir, 'vitest.json');
        const r = spawnSync(
          'pnpm',
          [
            '--filter',
            '@remyral/agent-adapters',
            'exec',
            'vitest',
            'run',
            ...suite.files,
            '--maxWorkers=1',
            '--reporter=json',
            `--outputFile=${report}`,
          ],
          {
            cwd: ROOT,
            stdio: ['ignore', 'inherit', 'inherit'],
            env: {
              ...process.env,
              [suite.env]: join(dir, suite.bin),
              ...(suite.expect ? { [suite.expect]: e.version } : {}),
            },
          },
        );
        const res = existsSync(report) ? readJson(report) : null;
        const passed = res?.numPassedTests ?? 0;
        const failed = res?.numFailedTests ?? 1;
        e.tests = {
          status: r.status === 0 && passed > 0 && failed === 0 ? 'passed' : 'failed',
          at: now(),
          detail: `${passed} passed, ${failed} failed, ${res?.numPendingTests ?? 0} skipped`,
        };
        out(`${rt} ${e.version}: ${e.tests.status} (${e.tests.detail})`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  writeFileSync(path, `${JSON.stringify(draft, null, 2)}\n`);
}

function previousCatalog(site) {
  const p = join(site, 'catalog', 'catalog.json');
  return existsSync(p) ? readJson(p) : null;
}

function cmdSign() {
  const key = loadKey(values.key);
  const site = resolve(values.site ?? die('--site <release site dir> is required'));
  const draft = readJson(values.draft ?? die('--draft is required'));
  const previous = values.previous === undefined ? previousCatalog(site) : readJson(values.previous);
  const sequence = values.sequence === undefined ? (previous?.sequence ?? 0) + 1 : Number(values.sequence);
  const p = pins();
  const catalog = checkCatalog(catalogFromDraft(draft, { sequence, generatedAt: now() }), {
    previous,
    pins: Object.fromEntries(RUNTIMES.map((rt) => [rt, p[rt].version])),
  });
  const bytes = jsonBytes(catalog);
  if (bytes.length > MAX_CATALOG_BYTES)
    die(`the catalog is ${bytes.length} bytes; at most ${MAX_CATALOG_BYTES}`);
  const sig = signBytes(CATALOG_CONTEXT, bytes, key);
  const dir = join(site, 'catalog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'catalog.json.tmp'), bytes);
  writeFileSync(join(dir, 'catalog.sig.json.tmp'), `${JSON.stringify(sig, null, 2)}\n`);
  renameSync(join(dir, 'catalog.sig.json.tmp'), join(dir, 'catalog.sig.json'));
  renameSync(join(dir, 'catalog.json.tmp'), join(dir, 'catalog.json'));
  out(`signed catalog ${sequence} (${bytes.length} bytes) with ${sig.keyId} → ${dir}`);
}

function verifySite(site, keys) {
  const dir = join(site, 'catalog');
  const bytes = readFileSync(join(dir, 'catalog.json'));
  const keyId = verifySigned(CATALOG_CONTEXT, bytes, readJson(join(dir, 'catalog.sig.json')), keys);
  const catalog = JSON.parse(bytes.toString('utf8'));
  checkCatalog(catalog);
  return { catalog, keyId };
}

try {
  switch (positionals[0]) {
    case 'keygen': {
      const dir = resolve(values.out ?? die('--out <dir> is required'));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const pem = join(dir, 'catalog-key.pem');
      if (existsSync(pem)) die(`${pem} exists; refusing to overwrite a catalog key`);
      const { privateKey } = generateKeyPairSync('ed25519');
      writeFileSync(pem, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
      chmodSync(pem, 0o600);
      const pub = publicB64u(privateKey);
      writeFileSync(join(dir, 'catalog-key.pub'), `${pub}\n`, { mode: 0o644 });
      out(
        `catalog public key: ${pub}\nkey id:             ${keyIdOf(pub)}\nprivate key:        ${pem} (the catalog runner's secret; never the release key)`,
      );
      break;
    }
    case 'build':
      await cmdBuild();
      break;
    case 'test':
      cmdTest();
      break;
    case 'promote': {
      const path = values.draft ?? die('--draft is required');
      const draft = promoteEntry(readJson(path), values.entry, { canary: values.canary, now: now() });
      writeFileSync(path, `${JSON.stringify(draft, null, 2)}\n`);
      out(`verified ${values.entry}`);
      break;
    }
    case 'sign':
      cmdSign();
      break;
    case 'verify': {
      const keys = (values['public-key'] ?? die('--public-key is required')).split(',');
      const { catalog, keyId } = verifySite(resolve(values.site ?? die('--site is required')), keys);
      out(`OK version catalog ${catalog.sequence} signed by ${keyId}`);
      break;
    }
    case 'publish': {
      const site = resolve(values.site ?? die('--site is required'));
      const to = resolve(values.to ?? die('--to <dir> is required'));
      const keys = (values['public-key'] ?? process.env.REMYRAL_CATALOG_PUBLIC_KEYS ?? '')
        .split(',')
        .filter(Boolean);
      if (keys.length === 0)
        die('--public-key (or REMYRAL_CATALOG_PUBLIC_KEYS) is required: nothing unverified is published');
      const { catalog } = verifySite(site, keys);
      const published = previousCatalog(to);
      if (published !== null && catalog.sequence <= published.sequence)
        die(`the destination already has sequence ${published.sequence}; refusing ${catalog.sequence}`);
      const dest = join(to, 'catalog');
      mkdirSync(dest, { recursive: true });
      for (const f of ['catalog.sig.json', 'catalog.json']) {
        copyFileSync(join(site, 'catalog', f), join(dest, `${f}.tmp`));
        renameSync(join(dest, `${f}.tmp`), join(dest, f));
      }
      out(`published catalog ${catalog.sequence} → ${dest} (${readdirSync(dest).length} files)`);
      break;
    }
    default:
      die('usage: catalog.mjs keygen|build|test|promote|sign|verify|publish … (see the header of this file)');
  }
} catch (err) {
  if (err instanceof ReleaseError) die(err.message);
  throw err;
}
