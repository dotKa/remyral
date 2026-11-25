import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import { Ed25519PublicKey, RuntimeKind, Sha256Hex, Timestamp } from './common.js';
import { ToolPlatform } from './fleet-tools.js';
import {
  compareReleaseVersions,
  NodeVersion,
  ReleaseChannel,
  releaseKeyId,
  ReleaseSignature,
  ReleaseVersion,
} from './release.js';
import { NpmIntegrity, RuntimeVersion } from './remote-ops.js';
import { RUNTIME_PINS, runtimePackageVersion } from './runtime-pins.js';
import { ProtocolVersion } from './version.js';

/**
 * p17-update-channel (ADR-0065, docs/design/p17-update-channel.md): the signed worker release feed and the signed
 * version catalog.
 *
 * - **Worker release feed** (`<release URL>/workers/feed.json` + `feed.sig.json`): signed with the vendor's offline
 *   release key under `remyral-worker-feed/v1`. The master reads it, downloads a release's `release.json` and imports
 *   it through the manual upload's verification. It also names the catalog keys the release key vouches for.
 * - **Version catalog** (`<release URL>/catalog/catalog.json` + `catalog.sig.json`): runtime and tool versions with
 *   their integrity, signed with the separate, narrow catalog key under `remyral-version-catalog/v1`. It can change
 *   versions and hashes only: every source is built here from fixed templates ({@link toolAssetUrl}, the npm registry
 *   tarball form) and the schema is strict. {@link checkVersionCatalog} is the one acceptance function of the worker,
 *   the master and the vendor tool.
 */

// ------------------------------------------------------------------------------------------ signatures

export const WORKER_FEED_CONTEXT = 'remyral-worker-feed/v1\n';
export const WORKER_FEED_NAME = 'remyral-worker-feed';
export const MAX_WORKER_FEED_BYTES = 1024 * 1024;
/** The upload document of one release (the master's limit for `POST /releases`). */
export const MAX_RELEASE_BUNDLE_BYTES = 48 * 1024 * 1024;

export const CATALOG_CONTEXT = 'remyral-version-catalog/v1\n';
export const CATALOG_NAME = 'remyral-version-catalog';
/** One catalog, so that APPLY_VERSION_CATALOG (base64) stays below the frame limit. */
export const MAX_CATALOG_BYTES = 384 * 1024;
/** A worker trusts at most two catalog keys (current + next during a rotation). */
export const MAX_TRUSTED_CATALOG_KEYS = 2;
/** The master's catalog keys (configured ∪ the verified feed's), at most four. */
export const MAX_MASTER_CATALOG_KEYS = 4;
/** A catalog dated further ahead than this is refused (clock skew allowance). */
export const CATALOG_FUTURE_SKEW_MS = 24 * 60 * 60_000;

/** Feature: understands APPLY_VERSION_CATALOG, answers VERSION_CATALOG_STATUS, reports CAPABILITIES.versionCatalog. */
export const VERSION_CATALOG_FEATURE = 'version-catalog-v1';

export type SignedDocumentRefusal =
  'no_trusted_keys' | 'too_large' | 'invalid_signature_document' | 'unknown_key' | 'bad_signature';

/** Signature over context ‖ exact bytes with one of `keys` (base64url raw Ed25519). Never throws. */
export function verifySignedBytes(
  context: string,
  bytes: Uint8Array,
  signatureDocument: unknown,
  keys: readonly string[],
  maxBytes: number,
): { ok: true; keyId: string } | { ok: false; reason: SignedDocumentRefusal; detail?: string } {
  const trusted = keys.filter((k) => Ed25519PublicKey.safeParse(k).success);
  if (trusted.length === 0) return { ok: false, reason: 'no_trusted_keys' };
  if (bytes.byteLength > maxBytes) return { ok: false, reason: 'too_large' };
  const sig = ReleaseSignature.safeParse(signatureDocument);
  if (!sig.success) return { ok: false, reason: 'invalid_signature_document' };
  const key = trusted.find((k) => releaseKeyId(k) === sig.data.keyId);
  if (key === undefined) return { ok: false, reason: 'unknown_key', detail: sig.data.keyId };
  const payload = Buffer.concat([Buffer.from(context, 'utf8'), bytes]);
  if (!verifyEd25519(key, payload, sig.data.signature)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, keyId: sig.data.keyId };
}

const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------------------------------ worker release feed

export const WorkerFeedRelease = z
  .object({
    version: ReleaseVersion,
    channel: ReleaseChannel,
    publishedAt: Timestamp,
    protocolVersions: z.array(ProtocolVersion).min(1).max(16),
    minNode: NodeVersion,
    /** The worker artifact (`remyral-worker.mjs`) as its signed manifest names it. */
    sha256: Sha256Hex,
    size: z
      .number()
      .int()
      .min(1)
      .max(32 * 1024 * 1024),
    /** The upload document, relative to the feed's directory: always `<version>/release.json`. */
    bundle: z.object({
      path: z.string().max(80),
      sha256: Sha256Hex,
      size: z.number().int().min(1).max(MAX_RELEASE_BUNDLE_BYTES),
    }),
    summary: z.string().max(300),
    notes: z.string().max(8000),
  })
  .refine((r) => r.bundle.path === `${r.version}/release.json`, {
    message: 'bundle.path must be <version>/release.json',
    path: ['bundle', 'path'],
  });
export type WorkerFeedRelease = z.infer<typeof WorkerFeedRelease>;

export const WorkerReleaseFeed = z.object({
  schema: z.literal(1),
  name: z.literal(WORKER_FEED_NAME),
  channel: ReleaseChannel,
  generatedAt: Timestamp,
  /** Catalog public keys the release key vouches for (rotation / revocation of the catalog key). */
  catalogKeys: z.array(Ed25519PublicKey).max(MAX_MASTER_CATALOG_KEYS).default([]),
  releases: z.array(WorkerFeedRelease).max(200),
});
export type WorkerReleaseFeed = z.infer<typeof WorkerReleaseFeed>;

export type WorkerFeedRefusal = SignedDocumentRefusal | 'malformed';

export function verifyWorkerReleaseFeed(
  bytes: Uint8Array,
  signatureDocument: unknown,
  releaseKeys: readonly string[],
):
  | { ok: true; feed: WorkerReleaseFeed; keyId: string }
  | { ok: false; reason: WorkerFeedRefusal; detail?: string } {
  const sig = verifySignedBytes(
    WORKER_FEED_CONTEXT,
    bytes,
    signatureDocument,
    releaseKeys,
    MAX_WORKER_FEED_BYTES,
  );
  if (!sig.ok) return sig;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed', detail: 'not JSON' };
  }
  const feed = WorkerReleaseFeed.safeParse(json);
  if (!feed.success) {
    return {
      ok: false,
      reason: 'malformed',
      detail: feed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; '),
    };
  }
  return { ok: true, feed: feed.data, keyId: sig.keyId };
}

/** How a release relates to the one the fleet runs (`from`; null: nothing rolled out yet). */
export type ReleaseBump = 'first' | 'same' | 'older' | 'patch' | 'minor' | 'major' | 'prerelease';

export function releaseBump(from: string | null, to: string): ReleaseBump {
  if (to.includes('-')) return 'prerelease';
  if (from === null || !ReleaseVersion.safeParse(from).success) return 'first';
  const c = compareReleaseVersions(to, from);
  if (c === 0) return 'same';
  if (c < 0) return 'older';
  const [a, b] = [from.split('-')[0] ?? '', to.split('-')[0] ?? ''].map((v) => v.split('.').map(Number));
  if (a?.[0] !== b?.[0]) return 'major';
  if (a?.[1] !== b?.[1]) return 'minor';
  return 'patch';
}

// ------------------------------------------------------------------------------------------ tools and sources

/** Tools the catalog may name (the worker's recipe tools + Node, which is listed for the matrix and the kits only). */
export const CatalogTool = z.enum(['browser', 'git', 'python', 'ffmpeg', 'cloudflared', 'uv', 'node']);
export type CatalogTool = z.infer<typeof CatalogTool>;

/** The one host each tool's assets come from. */
export const TOOL_SOURCE_HOSTS: Readonly<Record<CatalogTool, string>> = {
  browser: 'cdn.playwright.dev',
  git: 'github.com',
  python: 'api.nuget.org',
  ffmpeg: 'github.com',
  cloudflared: 'github.com',
  uv: 'github.com',
  node: 'nodejs.org',
};

/** Version grammar per tool (checked before a version is put into a URL). */
export const TOOL_VERSION_PATTERNS: Readonly<Record<CatalogTool, RegExp>> = {
  // Playwright's Chromium revision.
  browser: /^\d{3,6}$/,
  // MinGit: 2.56.0 (windows.1) or 2.56.0.3 (windows.3).
  git: /^\d{1,3}\.\d{1,3}\.\d{1,3}(\.\d{1,3})?$/,
  python: /^3\.\d{1,2}\.\d{1,3}$/,
  ffmpeg: /^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/,
  cloudflared: /^\d{4}\.\d{1,2}\.\d{1,3}$/,
  uv: /^\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  node: /^\d{2}\.\d{1,3}\.\d{1,3}$/,
};
/** Chrome for Testing build behind a Chromium revision (`156.0.8078.4`). */
export const BROWSER_BUILD_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,5}\.\d{1,4}$/;

const CFT_FILES: Readonly<Partial<Record<ToolPlatform, string>>> = {
  'win32-x64': 'win64/chrome-win64.zip',
  'linux-x64': 'linux64/chrome-linux64.zip',
  'linux-arm64': 'linux-arm64/chrome-linux-arm64.zip',
  'darwin-arm64': 'mac-arm64/chrome-mac-arm64.zip',
  'darwin-x64': 'mac-x64/chrome-mac-x64.zip',
};
const CLOUDFLARED_FILES: Readonly<Partial<Record<ToolPlatform, string>>> = {
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
  'win32-x64': 'cloudflared-windows-amd64.exe',
};
const UV_FILES: Readonly<Partial<Record<ToolPlatform, string>>> = {
  'linux-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz',
  'linux-arm64': 'uv-aarch64-unknown-linux-gnu.tar.gz',
  'darwin-x64': 'uv-x86_64-apple-darwin.tar.gz',
  'darwin-arm64': 'uv-aarch64-apple-darwin.tar.gz',
  'win32-x64': 'uv-x86_64-pc-windows-msvc.zip',
};
const NODE_FILES: Readonly<Partial<Record<ToolPlatform, string>>> = {
  'linux-x64': 'linux-x64.tar.gz',
  'linux-arm64': 'linux-arm64.tar.gz',
  'darwin-x64': 'darwin-x64.tar.gz',
  'darwin-arm64': 'darwin-arm64.tar.gz',
  'win32-x64': 'win-x64.zip',
};

/** Whether `version` (and the browser's `build`) fit the tool's grammar. */
export function toolVersionValid(tool: CatalogTool, version: string, build?: string): boolean {
  if (!TOOL_VERSION_PATTERNS[tool].test(version)) return false;
  if (tool === 'browser') return build !== undefined && BROWSER_BUILD_PATTERN.test(build);
  return build === undefined;
}

/**
 * The asset URL of `tool` `version` for `platform` — the only place a tool source exists (fixed host, fixed
 * repository, fixed file name pattern). Null: no asset for that platform, or a version that does not fit the grammar.
 * The worker's built-in recipes are built from the same templates.
 */
export function toolAssetUrl(
  tool: CatalogTool,
  platform: ToolPlatform,
  version: string,
  build?: string,
): string | null {
  if (!toolVersionValid(tool, version, build)) return null;
  switch (tool) {
    case 'browser': {
      const f = CFT_FILES[platform];
      return f === undefined ? null : `https://cdn.playwright.dev/builds/cft/${build ?? ''}/${f}`;
    }
    case 'git': {
      if (platform !== 'win32-x64') return null;
      const parts = version.split('.');
      const core = parts.slice(0, 3).join('.');
      const rev = parts[3] ?? '1';
      return `https://github.com/git-for-windows/git/releases/download/v${core}.windows.${rev}/MinGit-${version}-64-bit.zip`;
    }
    case 'python':
      return platform === 'win32-x64'
        ? `https://api.nuget.org/v3-flatcontainer/python/${version}/python.${version}.nupkg`
        : null;
    case 'ffmpeg':
      return platform === 'win32-x64'
        ? `https://github.com/GyanD/codexffmpeg/releases/download/${version}/ffmpeg-${version}-essentials_build.zip`
        : null;
    case 'cloudflared': {
      const f = CLOUDFLARED_FILES[platform];
      return f === undefined
        ? null
        : `https://github.com/cloudflare/cloudflared/releases/download/${version}/${f}`;
    }
    case 'uv': {
      const f = UV_FILES[platform];
      return f === undefined ? null : `https://github.com/astral-sh/uv/releases/download/${version}/${f}`;
    }
    case 'node': {
      const f = NODE_FILES[platform];
      return f === undefined ? null : `https://nodejs.org/dist/v${version}/node-v${version}-${f}`;
    }
  }
}

/** Numeric dotted comparison (`2.56.0.3` vs `2.56.0`, `1248` vs `1250`). -1 / 0 / 1. */
export function compareDotted(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The registry tarball URL of an npm package version (the only form a catalog lock may use). */
export function npmTarballUrl(name: string, version: string): string {
  const base = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

// ------------------------------------------------------------------------------------------ catalog schema

const NPM_NAME = /^(@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const NPM_PATH_SEGMENT = '(?:@[A-Za-z0-9][A-Za-z0-9._~-]*/)?[A-Za-z0-9][A-Za-z0-9._~-]*';
const NPM_PATH = new RegExp(`^node_modules/${NPM_PATH_SEGMENT}(?:/node_modules/${NPM_PATH_SEGMENT})*$`);
const Filter = z.array(z.string().regex(/^!?[A-Za-z0-9_.-]{1,32}$/)).max(32);

/** One package of a runtime's lock (the form of the worker's install manifest). */
export const CatalogNpmPackage = z.strictObject({
  path: z.string().max(512).regex(NPM_PATH, 'node_modules path'),
  name: z.string().max(214).regex(NPM_NAME, 'npm package name'),
  version: z.string().regex(/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][0-9A-Za-z.-]{1,64})?$/, 'exact version'),
  resolved: z.string().max(1024),
  integrity: NpmIntegrity,
  optional: z.boolean().optional(),
  os: Filter.optional(),
  cpu: Filter.optional(),
  libc: Filter.optional(),
});
export type CatalogNpmPackage = z.infer<typeof CatalogNpmPackage>;

export const CatalogRuntimeEntry = z.strictObject({
  /** The version the runtime reports (Claude Code: the CLI version). */
  version: RuntimeVersion,
  /** The release's own npm root package at this version (Claude Code: the agent SDK). */
  packageVersion: RuntimeVersion,
  integrity: NpmIntegrity,
  /** Set by the vendor only after the contract tests and a canary passed. */
  verified: z.boolean(),
  verifiedAt: Timestamp.optional(),
  packages: z.array(CatalogNpmPackage).min(1).max(4000),
  /** Packages of this lock that have an install script (never run by the worker). */
  scripts: z.array(z.string().max(214).regex(NPM_NAME)).max(64).optional(),
});
export type CatalogRuntimeEntry = z.infer<typeof CatalogRuntimeEntry>;

export const CatalogToolAsset = z.strictObject({
  url: z.string().max(512),
  sha256: Sha256Hex,
  size: z
    .number()
    .int()
    .min(1)
    .max(2 * 1024 * 1024 * 1024),
});
export type CatalogToolAsset = z.infer<typeof CatalogToolAsset>;

export const CatalogToolEntry = z.strictObject({
  version: z.string().max(32),
  verified: z.boolean(),
  verifiedAt: Timestamp.optional(),
  /** browser: the Chrome for Testing build behind the revision. */
  build: z.string().max(32).optional(),
  /** browser: the Playwright release that uses this revision (what the matrix compares with npm). */
  playwright: ReleaseVersion.optional(),
  assets: z.partialRecord(ToolPlatform, CatalogToolAsset),
});
export type CatalogToolEntry = z.infer<typeof CatalogToolEntry>;

const entries = <T extends z.ZodType>(t: T) => z.array(t).min(1).max(4);

export const VersionCatalog = z.strictObject({
  schema: z.literal(1),
  name: z.literal(CATALOG_NAME),
  /** Monotonic: a worker accepts only a higher sequence than the one it holds. */
  sequence: z.number().int().min(1).max(2_147_483_647),
  generatedAt: Timestamp,
  runtimes: z.partialRecord(RuntimeKind, entries(CatalogRuntimeEntry)),
  tools: z.partialRecord(CatalogTool, entries(CatalogToolEntry)),
});
export type VersionCatalog = z.infer<typeof VersionCatalog>;

// ------------------------------------------------------------------------------------------ acceptance

export type CatalogRefusal =
  | SignedDocumentRefusal
  | 'invalid_catalog'
  | 'future_dated'
  | 'not_newer'
  | 'unknown_package'
  | 'version_mismatch'
  | 'unknown_host'
  | 'unknown_source'
  | 'install_script_refused'
  | 'unknown_tool'
  | 'version_downgrade';

export const CATALOG_REFUSALS: readonly CatalogRefusal[] = [
  'no_trusted_keys',
  'too_large',
  'invalid_signature_document',
  'unknown_key',
  'bad_signature',
  'invalid_catalog',
  'future_dated',
  'not_newer',
  'unknown_package',
  'version_mismatch',
  'unknown_host',
  'unknown_source',
  'install_script_refused',
  'unknown_tool',
  'version_downgrade',
];

/** The release's built-in pins: the floor of every catalog entry (and the way back). */
export interface CatalogFloor {
  readonly runtimes: Readonly<
    Partial<
      Record<
        RuntimeKind,
        {
          readonly version: string;
          /** Install-script packages of the release's own lock; null = not checked (the master). */
          readonly scripts: readonly string[] | null;
        }
      >
    >
  >;
  /** Built-in recipe versions (absent tool: no floor known here). */
  readonly tools?: Readonly<Partial<Record<CatalogTool, string>>>;
}

/** The release floor from the protocol's runtime pins only (the master; scripts unchecked). */
export function runtimePinFloor(): CatalogFloor {
  const runtimes: Partial<Record<RuntimeKind, { version: string; scripts: null }>> = {};
  for (const rt of RuntimeKind.options) runtimes[rt] = { version: RUNTIME_PINS[rt].version, scripts: null };
  return { runtimes };
}

export const CatalogSkip = z.object({
  kind: z.enum(['runtime', 'tool']),
  item: z.string().max(32),
  version: z.string().max(64),
  reason: z.enum(['below_release_pin']),
});
export type CatalogSkip = z.infer<typeof CatalogSkip>;

export interface AcceptedCatalog {
  readonly sequence: number;
  readonly catalog: VersionCatalog;
  readonly sha256: string;
}

export type CatalogCheck =
  | {
      readonly ok: true;
      readonly catalog: VersionCatalog;
      readonly keyId: string;
      readonly sha256: string;
      /** The same bytes as the previous accepted catalog (idempotent re-delivery). */
      readonly alreadyCurrent: boolean;
      /** Entries below the release floor: ignored, not a refusal (mixed worker versions). */
      readonly skipped: readonly CatalogSkip[];
    }
  | { readonly ok: false; readonly reason: CatalogRefusal; readonly detail?: string };

function refuse(reason: CatalogRefusal, detail?: string): CatalogCheck {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail: detail.slice(0, 300) };
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.username === '' && u.password === '' && u.port === ''
      ? u.hostname
      : null;
  } catch {
    return null;
  }
}

/** The highest verified version of an item (null: none). */
function highestVerified(
  list: readonly { version: string; verified: boolean }[] | undefined,
  cmp: (a: string, b: string) => number,
): string | null {
  let best: string | null = null;
  for (const e of list ?? []) {
    if (!e.verified) continue;
    if (best === null || cmp(e.version, best) > 0) best = e.version;
  }
  return best;
}

function checkRuntime(
  runtime: RuntimeKind,
  e: CatalogRuntimeEntry,
  floor: CatalogFloor,
): { reason: CatalogRefusal; detail: string } | null {
  const pkg = RUNTIME_PINS[runtime].package;
  const at = `${runtime}@${e.version}`;
  if (runtimePackageVersion(runtime, e.version) !== e.packageVersion) {
    return {
      reason: 'version_mismatch',
      detail: `${at}: ${pkg}@${e.packageVersion} does not bring ${e.version}`,
    };
  }
  const root = e.packages.find((p) => p.path === `node_modules/${pkg}`);
  if (
    root === undefined ||
    root.name !== pkg ||
    root.version !== e.packageVersion ||
    root.integrity !== e.integrity
  ) {
    return { reason: 'unknown_package', detail: `${at}: the lock's root is not ${pkg}@${e.packageVersion}` };
  }
  const paths = new Set<string>();
  for (const p of e.packages) {
    if (paths.has(p.path)) return { reason: 'invalid_catalog', detail: `${at}: duplicate ${p.path}` };
    paths.add(p.path);
    const last = p.path.slice(p.path.lastIndexOf('node_modules/') + 13);
    if (last !== p.name) return { reason: 'unknown_package', detail: `${at}: ${p.path} is not ${p.name}` };
    if (hostOf(p.resolved) !== 'registry.npmjs.org') {
      return {
        reason: 'unknown_host',
        detail: `${at}: ${p.name} from ${hostOf(p.resolved) ?? 'an invalid URL'}`,
      };
    }
    if (p.resolved !== npmTarballUrl(p.name, p.version)) {
      return {
        reason: 'unknown_source',
        detail: `${at}: ${p.name} is not the registry tarball of ${p.version}`,
      };
    }
  }
  const allowed = floor.runtimes[runtime]?.scripts;
  if (allowed !== null && allowed !== undefined) {
    const extra = (e.scripts ?? []).filter((s) => !allowed.includes(s));
    if (extra.length > 0) {
      return { reason: 'install_script_refused', detail: `${at}: install scripts in ${extra.join(', ')}` };
    }
  }
  return null;
}

function checkTool(
  tool: CatalogTool,
  e: CatalogToolEntry,
): { reason: CatalogRefusal; detail: string } | null {
  const at = `${tool}@${e.version}`;
  if (!toolVersionValid(tool, e.version, e.build))
    return { reason: 'invalid_catalog', detail: `${at}: version` };
  if (tool !== 'browser' && e.playwright !== undefined) {
    return { reason: 'invalid_catalog', detail: `${at}: playwright is for the browser only` };
  }
  const platforms = Object.keys(e.assets) as ToolPlatform[];
  if (platforms.length === 0) return { reason: 'invalid_catalog', detail: `${at}: no assets` };
  for (const platform of platforms) {
    const asset = e.assets[platform];
    if (asset === undefined) continue;
    const want = toolAssetUrl(tool, platform, e.version, e.build);
    if (want === null)
      return { reason: 'unknown_source', detail: `${at}: no ${platform} build of this tool` };
    const host = hostOf(asset.url);
    if (host !== TOOL_SOURCE_HOSTS[tool]) {
      return { reason: 'unknown_host', detail: `${at} ${platform}: ${host ?? 'an invalid URL'}` };
    }
    if (asset.url !== want) return { reason: 'unknown_source', detail: `${at} ${platform}: not ${want}` };
  }
  return null;
}

/**
 * Whether a worker (or the master, or the vendor tool) accepts a catalog: signature with a trusted catalog key, strict
 * schema, not dated in the future, newer than the accepted one, fixed packages and sources only, no install scripts
 * beyond the release's own, no verified version lower than the previously accepted one (except back to the release
 * pin). Entries below the release floor are reported in `skipped`, not refused. Never throws.
 */
export function checkVersionCatalog(
  bytes: Uint8Array,
  signatureDocument: unknown,
  opts: {
    readonly keys: readonly string[];
    readonly previous: AcceptedCatalog | null;
    readonly floor: CatalogFloor;
    readonly now: Date;
  },
): CatalogCheck {
  const sig = verifySignedBytes(CATALOG_CONTEXT, bytes, signatureDocument, opts.keys, MAX_CATALOG_BYTES);
  if (!sig.ok) return refuse(sig.reason, sig.detail);
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return refuse('invalid_catalog', 'not JSON');
  }
  // Specific reasons before the strict schema: an unknown runtime or tool name.
  if (json !== null && typeof json === 'object') {
    const o = json as { runtimes?: unknown; tools?: unknown };
    if (o.runtimes !== null && typeof o.runtimes === 'object') {
      const bad = Object.keys(o.runtimes).find((k) => !RuntimeKind.safeParse(k).success);
      if (bad !== undefined) return refuse('unknown_package', `runtime ${bad}`);
    }
    if (o.tools !== null && typeof o.tools === 'object') {
      const bad = Object.keys(o.tools).find((k) => !CatalogTool.safeParse(k).success);
      if (bad !== undefined) return refuse('unknown_tool', bad);
    }
  }
  const parsed = VersionCatalog.safeParse(json);
  if (!parsed.success) {
    return refuse(
      'invalid_catalog',
      parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; '),
    );
  }
  const catalog = parsed.data;
  if (Date.parse(catalog.generatedAt) > opts.now.getTime() + CATALOG_FUTURE_SKEW_MS) {
    return refuse('future_dated', catalog.generatedAt);
  }
  const digest = sha256Hex(bytes);
  const prev = opts.previous;
  if (prev !== null) {
    if (catalog.sequence === prev.sequence && digest === prev.sha256) {
      return { ok: true, catalog, keyId: sig.keyId, sha256: digest, alreadyCurrent: true, skipped: [] };
    }
    if (catalog.sequence <= prev.sequence) {
      return refuse('not_newer', `sequence ${String(catalog.sequence)} ≤ ${String(prev.sequence)}`);
    }
  }
  const skipped: CatalogSkip[] = [];
  for (const runtime of RuntimeKind.options) {
    const list = catalog.runtimes[runtime] ?? [];
    const versions = new Set<string>();
    for (const e of list) {
      if (versions.has(e.version)) return refuse('invalid_catalog', `${runtime}@${e.version} twice`);
      versions.add(e.version);
      const bad = checkRuntime(runtime, e, opts.floor);
      if (bad !== null) return refuse(bad.reason, bad.detail);
      const pin = opts.floor.runtimes[runtime]?.version;
      if (pin !== undefined && compareReleaseVersions(e.version, pin) < 0) {
        skipped.push({ kind: 'runtime', item: runtime, version: e.version, reason: 'below_release_pin' });
      }
    }
    const before = highestVerified(prev?.catalog.runtimes[runtime], compareReleaseVersions);
    const now = highestVerified(list, compareReleaseVersions);
    const pin = opts.floor.runtimes[runtime]?.version;
    if (before !== null && now !== null && compareReleaseVersions(now, before) < 0 && now !== pin) {
      return refuse('version_downgrade', `${runtime}: ${now} < ${before}`);
    }
  }
  for (const tool of CatalogTool.options) {
    const list = catalog.tools[tool] ?? [];
    const versions = new Set<string>();
    for (const e of list) {
      if (versions.has(e.version)) return refuse('invalid_catalog', `${tool}@${e.version} twice`);
      versions.add(e.version);
      const bad = checkTool(tool, e);
      if (bad !== null) return refuse(bad.reason, bad.detail);
      const pin = opts.floor.tools?.[tool];
      if (pin !== undefined && compareDotted(e.version, pin) < 0) {
        skipped.push({ kind: 'tool', item: tool, version: e.version, reason: 'below_release_pin' });
      }
    }
    const before = highestVerified(prev?.catalog.tools[tool], compareDotted);
    const now = highestVerified(list, compareDotted);
    const pin = opts.floor.tools?.[tool];
    if (before !== null && now !== null && compareDotted(now, before) < 0 && now !== pin) {
      return refuse('version_downgrade', `${tool}: ${now} < ${before}`);
    }
  }
  return { ok: true, catalog, keyId: sig.keyId, sha256: digest, alreadyCurrent: false, skipped };
}

/** What a catalog means for one runtime on a worker with `floor`: the verified pin and the unverified offers. */
export interface EffectiveRuntimeCatalog {
  /** The highest verified entry at or above the release pin (null: the release pin applies). */
  readonly pinned: CatalogRuntimeEntry | null;
  /** Unverified entries above the effective pin (newest first). */
  readonly unverified: readonly CatalogRuntimeEntry[];
}

export function effectiveRuntimeCatalog(
  catalog: VersionCatalog | null,
  runtime: RuntimeKind,
  releasePin: string,
): EffectiveRuntimeCatalog {
  const list = [...(catalog?.runtimes[runtime] ?? [])].filter(
    (e) => compareReleaseVersions(e.version, releasePin) >= 0,
  );
  list.sort((a, b) => compareReleaseVersions(b.version, a.version));
  const pinned = list.find((e) => e.verified && e.version !== releasePin) ?? null;
  const floor = pinned?.version ?? releasePin;
  const unverified = list.filter((e) => !e.verified && compareReleaseVersions(e.version, floor) > 0);
  return { pinned, unverified };
}

export interface EffectiveToolCatalog {
  readonly verified: CatalogToolEntry | null;
  readonly unverified: readonly CatalogToolEntry[];
}

export function effectiveToolCatalog(
  catalog: VersionCatalog | null,
  tool: CatalogTool,
  releasePin: string | null,
): EffectiveToolCatalog {
  const list = [...(catalog?.tools[tool] ?? [])].filter(
    (e) => releasePin === null || compareDotted(e.version, releasePin) >= 0,
  );
  list.sort((a, b) => compareDotted(b.version, a.version));
  const verified = list.find((e) => e.verified && e.version !== releasePin) ?? null;
  const floor = verified?.version ?? releasePin;
  const unverified = list.filter(
    (e) => !e.verified && (floor === null || compareDotted(e.version, floor) > 0),
  );
  return { verified, unverified };
}

// ------------------------------------------------------------------------------------------ messages

const Base64 = (maxBytes: number) =>
  z
    .string()
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64');

/** APPLY_VERSION_CATALOG (master → worker, control): the exact catalog bytes and the catalog-key signature. */
export const ApplyVersionCatalogPayload = z.object({
  sequence: z.number().int().min(1).max(2_147_483_647),
  catalog: Base64(MAX_CATALOG_BYTES),
  signature: ReleaseSignature,
});
export type ApplyVersionCatalogPayload = z.infer<typeof ApplyVersionCatalogPayload>;

/** VERSION_CATALOG_STATUS (worker → master, control): the outcome of one APPLY_VERSION_CATALOG. */
export const VersionCatalogStatusPayload = z.object({
  sequence: z.number().int().min(1).max(2_147_483_647),
  outcome: z.enum(['accepted', 'already_current', 'refused']),
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  detail: z.string().max(300).optional(),
  skipped: z.array(CatalogSkip).max(64).optional(),
});
export type VersionCatalogStatusPayload = z.infer<typeof VersionCatalogStatusPayload>;

/** CAPABILITIES.versionCatalog (with `version-catalog-v1`). */
export const VersionCatalogReport = z.object({
  /** Accepting catalogs at all (`updates.catalog`) and how many catalog keys this worker trusts. */
  enabled: z.boolean(),
  keys: z.number().int().min(0).max(MAX_TRUSTED_CATALOG_KEYS),
  /** The accepted catalog (0: none — the release pins apply). */
  sequence: z.number().int().min(0).max(2_147_483_647),
  keyId: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .optional(),
  generatedAt: Timestamp.optional(),
  skipped: z.array(CatalogSkip).max(64).optional(),
  /** The last refused delivery (sequence and reason). */
  lastRefusal: z
    .object({ sequence: z.number().int().min(1), reason: z.string().regex(/^[a-z0-9_]{1,64}$/) })
    .optional(),
});
export type VersionCatalogReport = z.infer<typeof VersionCatalogReport>;
