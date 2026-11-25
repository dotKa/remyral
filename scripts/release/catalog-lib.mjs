// Pure logic of the version catalog and the worker release feed (p17-update-channel, ADR-0065,
// docs/ops/update-channel.md). No I/O: the source templates (the same as packages/protocol/src/update-channel.ts —
// scripts/test/update-channel-release.test.mjs pins that), the draft → catalog step, promotion rules, the structural
// checks the vendor runs before signing, and the worker release feed. scripts/release/catalog.mjs and
// `sign.mjs feed` do the I/O. Signatures: Ed25519 over context ‖ exact bytes (control-plane-lib.mjs).
import { createHash } from 'node:crypto';
import { compareSemver, ReleaseError, SEMVER, summaryOf } from './control-plane-lib.mjs';

export const CATALOG_CONTEXT = 'remyral-version-catalog/v1\n';
export const WORKER_FEED_CONTEXT = 'remyral-worker-feed/v1\n';
export const CATALOG_NAME = 'remyral-version-catalog';
export const DRAFT_NAME = 'remyral-version-catalog-draft';
export const FEED_NAME = 'remyral-worker-feed';
export const MAX_CATALOG_BYTES = 384 * 1024;
export const RUNTIMES = Object.freeze(['claude-code', 'codex', 'pi', 'opencode']);
export const TOOLS = Object.freeze(['browser', 'git', 'python', 'ffmpeg', 'cloudflared', 'uv', 'node']);
export const PLATFORMS = Object.freeze([
  'win32-x64',
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
]);
/** The npm root package per runtime (packages/protocol/src/runtime-pins.ts). */
export const RUNTIME_PACKAGES = Object.freeze({
  'claude-code': '@anthropic-ai/claude-agent-sdk',
  codex: '@openai/codex',
  pi: '@earendil-works/pi-coding-agent',
  opencode: 'opencode-ai',
});
export const TOOL_HOSTS = Object.freeze({
  browser: 'cdn.playwright.dev',
  git: 'github.com',
  python: 'api.nuget.org',
  ffmpeg: 'github.com',
  cloudflared: 'github.com',
  uv: 'github.com',
  node: 'nodejs.org',
});
const VERSION = Object.freeze({
  browser: /^\d{3,6}$/,
  git: /^\d{1,3}\.\d{1,3}\.\d{1,3}(\.\d{1,3})?$/,
  python: /^3\.\d{1,2}\.\d{1,3}$/,
  ffmpeg: /^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/,
  cloudflared: /^\d{4}\.\d{1,2}\.\d{1,3}$/,
  uv: /^\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  node: /^\d{2}\.\d{1,3}\.\d{1,3}$/,
});
const BUILD = /^\d{1,4}\.\d{1,4}\.\d{1,5}\.\d{1,4}$/;
const CFT = {
  'win32-x64': 'win64/chrome-win64.zip',
  'linux-x64': 'linux64/chrome-linux64.zip',
  'linux-arm64': 'linux-arm64/chrome-linux-arm64.zip',
  'darwin-arm64': 'mac-arm64/chrome-mac-arm64.zip',
  'darwin-x64': 'mac-x64/chrome-mac-x64.zip',
};
const CLOUDFLARED = {
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
  'win32-x64': 'cloudflared-windows-amd64.exe',
};
const UV = {
  'linux-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz',
  'linux-arm64': 'uv-aarch64-unknown-linux-gnu.tar.gz',
  'darwin-x64': 'uv-x86_64-apple-darwin.tar.gz',
  'darwin-arm64': 'uv-aarch64-apple-darwin.tar.gz',
  'win32-x64': 'uv-x86_64-pc-windows-msvc.zip',
};
const NODE = {
  'linux-x64': 'linux-x64.tar.gz',
  'linux-arm64': 'linux-arm64.tar.gz',
  'darwin-x64': 'darwin-x64.tar.gz',
  'darwin-arm64': 'darwin-arm64.tar.gz',
  'win32-x64': 'win-x64.zip',
};

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function toolVersionValid(tool, version, build) {
  if (!VERSION[tool]?.test(version ?? '')) return false;
  if (tool === 'browser') return typeof build === 'string' && BUILD.test(build);
  return build === undefined;
}

/** The asset URL of a tool version for a platform (null: none). The only place a tool source exists. */
export function toolAssetUrl(tool, platform, version, build) {
  if (!toolVersionValid(tool, version, build)) return null;
  switch (tool) {
    case 'browser':
      return CFT[platform] ? `https://cdn.playwright.dev/builds/cft/${build}/${CFT[platform]}` : null;
    case 'git': {
      if (platform !== 'win32-x64') return null;
      const parts = version.split('.');
      return `https://github.com/git-for-windows/git/releases/download/v${parts.slice(0, 3).join('.')}.windows.${parts[3] ?? '1'}/MinGit-${version}-64-bit.zip`;
    }
    case 'python':
      return platform === 'win32-x64'
        ? `https://api.nuget.org/v3-flatcontainer/python/${version}/python.${version}.nupkg`
        : null;
    case 'ffmpeg':
      return platform === 'win32-x64'
        ? `https://github.com/GyanD/codexffmpeg/releases/download/${version}/ffmpeg-${version}-essentials_build.zip`
        : null;
    case 'cloudflared':
      return CLOUDFLARED[platform]
        ? `https://github.com/cloudflare/cloudflared/releases/download/${version}/${CLOUDFLARED[platform]}`
        : null;
    case 'uv':
      return UV[platform]
        ? `https://github.com/astral-sh/uv/releases/download/${version}/${UV[platform]}`
        : null;
    case 'node':
      return NODE[platform] ? `https://nodejs.org/dist/v${version}/node-v${version}-${NODE[platform]}` : null;
    default:
      return null;
  }
}

export function npmTarballUrl(name, version) {
  const base = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

/** Numeric dotted comparison (`2.56.0.3` vs `2.56.0`). */
export function compareDotted(a, b) {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/**
 * Claude Code: the agent SDK version that bundles CLI `version` on the pinned SDK line (`2.1.312` with SDK pin
 * `0.3.310` → `0.3.312`); the other runtimes: the version itself.
 */
export function runtimePackageVersion(runtime, version, pins) {
  if (runtime !== 'claude-code') return version;
  const cli = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const pin = /^(\d+)\.(\d+)\.(\d+)$/.exec(pins.version);
  const sdk = /^(\d+)\.(\d+)\.\d+$/.exec(pins.packageVersion);
  if (!cli || !pin || !sdk || cli[1] !== pin[1] || cli[2] !== pin[2]) return null;
  return `${sdk[1]}.${sdk[2]}.${cli[3]}`;
}

// ------------------------------------------------------------------------------------------ draft → catalog

const DRAFT_ONLY = ['tests', 'canary', 'lock', 'hashed'];
const strip = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !DRAFT_ONLY.includes(k)));

export function emptyDraft(createdAt) {
  return { schema: 1, name: DRAFT_NAME, createdAt, runtimes: {}, tools: {} };
}

/** The signed document of a draft: draft-only fields (test results, canary notes, raw locks) removed. */
export function catalogFromDraft(draft, { sequence, generatedAt }) {
  if (draft?.name !== DRAFT_NAME) throw new ReleaseError('not a version catalog draft (catalog.mjs build)');
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 2_147_483_647)
    throw new ReleaseError('sequence must be a positive integer');
  const runtimes = {};
  for (const [rt, list] of Object.entries(draft.runtimes ?? {})) {
    if (list.length > 0) runtimes[rt] = list.map(strip);
  }
  const tools = {};
  for (const [tool, list] of Object.entries(draft.tools ?? {})) {
    if (list.length > 0) tools[tool] = list.map(strip);
  }
  return { schema: 1, name: CATALOG_NAME, sequence, generatedAt, runtimes, tools };
}

/**
 * Marks one draft entry verified (`runtime:codex@0.165.0` / `tool:uv@0.13.6`) after its canary. A runtime needs a
 * passed contract run (`catalog.mjs test`), a tool its downloaded-and-hashed assets (`catalog.mjs build`).
 */
export function promoteEntry(draft, spec, { canary, now }) {
  const m = /^(runtime|tool):([a-z-]+)@([0-9A-Za-z.+-]+)$/.exec(spec ?? '');
  if (!m)
    throw new ReleaseError(`--entry must be runtime:<rt>@<version> or tool:<tool>@<version> (got ${spec})`);
  if (typeof canary !== 'string' || canary.trim().length < 3)
    throw new ReleaseError(
      '--canary "<what ran where>" is required: the verified flag needs canary evidence',
    );
  const [, kind, item, version] = m;
  const list = (kind === 'runtime' ? draft.runtimes : draft.tools)?.[item] ?? [];
  const entry = list.find((e) => e.version === version);
  if (!entry) throw new ReleaseError(`${spec} is not in the draft`);
  if (kind === 'runtime' && entry.tests?.status !== 'passed') {
    throw new ReleaseError(
      `${spec}: the contract tests did not pass (${entry.tests?.status ?? 'not run'}; catalog.mjs test)`,
    );
  }
  if (kind === 'tool' && entry.hashed !== true)
    throw new ReleaseError(`${spec}: assets were not downloaded and hashed`);
  entry.verified = true;
  entry.verifiedAt = now;
  entry.canary = { note: canary.trim().slice(0, 300), at: now };
  return draft;
}

function highestVerified(list, cmp) {
  let best = null;
  for (const e of list ?? []) if (e.verified && (best === null || cmp(e.version, best) > 0)) best = e.version;
  return best;
}

/**
 * Structural checks before signing (the worker's full rules are in the protocol; the scripts test runs both): sequence
 * monotonic, every source from a template, every tarball the registry's, no verified downgrade.
 */
export function checkCatalog(catalog, { previous = null, pins = {} } = {}) {
  if (previous !== null && catalog.sequence <= previous.sequence)
    throw new ReleaseError(`sequence ${catalog.sequence} is not above the published ${previous.sequence}`);
  for (const [rt, list] of Object.entries(catalog.runtimes)) {
    const pkg = RUNTIME_PACKAGES[rt];
    if (!pkg) throw new ReleaseError(`unknown runtime ${rt}`);
    for (const e of list) {
      const root = e.packages.find((p) => p.path === `node_modules/${pkg}`);
      if (!root || root.version !== e.packageVersion || root.integrity !== e.integrity)
        throw new ReleaseError(`${rt}@${e.version}: the lock's root is not ${pkg}@${e.packageVersion}`);
      for (const p of e.packages) {
        if (p.resolved !== npmTarballUrl(p.name, p.version))
          throw new ReleaseError(`${rt}@${e.version}: ${p.name} is not a registry tarball`);
      }
    }
    const before = highestVerified(previous?.runtimes?.[rt], compareSemver);
    const now = highestVerified(list, compareSemver);
    if (before && now && compareSemver(now, before) < 0 && now !== pins[rt])
      throw new ReleaseError(`${rt}: verified ${now} is below the published ${before}`);
  }
  for (const [tool, list] of Object.entries(catalog.tools)) {
    if (!TOOLS.includes(tool)) throw new ReleaseError(`unknown tool ${tool}`);
    for (const e of list) {
      for (const [p, a] of Object.entries(e.assets)) {
        const want = toolAssetUrl(tool, p, e.version, e.build);
        if (a.url !== want) throw new ReleaseError(`${tool}@${e.version} ${p}: ${a.url} is not ${want}`);
      }
    }
    const before = highestVerified(previous?.tools?.[tool], compareDotted);
    const now = highestVerified(list, compareDotted);
    if (before && now && compareDotted(now, before) < 0)
      throw new ReleaseError(`${tool}: verified ${now} is below the published ${before}`);
  }
  return catalog;
}

// ------------------------------------------------------------------------------------------ worker release feed

/** One feed entry from a verified release manifest and the bytes of its release.json. */
export function feedRelease({ manifest, bundleBytes, notes = '' }) {
  if (!SEMVER.test(manifest.version)) throw new ReleaseError(`bad version ${manifest.version}`);
  return {
    version: manifest.version,
    channel: manifest.channel,
    publishedAt: manifest.createdAt,
    protocolVersions: manifest.protocolVersions,
    minNode: manifest.minNode,
    sha256: manifest.sha256,
    size: manifest.size,
    bundle: {
      path: `${manifest.version}/release.json`,
      sha256: sha256(bundleBytes),
      size: bundleBytes.length,
    },
    summary: summaryOf(notes),
    notes: notes.slice(0, 8000),
  };
}

/** The worker release feed of a channel (newest first); `stable` lists stable-signed releases only. */
export function makeWorkerFeed({ channel, generatedAt, catalogKeys = [], releases }) {
  if (channel !== 'stable' && channel !== 'canary')
    throw new ReleaseError('--channel must be stable or canary');
  if (catalogKeys.length > 4 || catalogKeys.some((k) => !/^[A-Za-z0-9_-]{43}$/.test(k)))
    throw new ReleaseError('catalog keys must be at most four base64url Ed25519 public keys');
  const list = releases
    .filter((r) => channel === 'canary' || r.channel === 'stable')
    .sort((a, b) => compareSemver(b.version, a.version));
  return { schema: 1, name: FEED_NAME, channel, generatedAt, catalogKeys, releases: list };
}
