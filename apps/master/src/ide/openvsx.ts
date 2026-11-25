import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';
import {
  IDE_EXTENSION_LIMITS,
  IdeExtensionId,
  IdeExtensionVersion,
  type IdeTargetPlatform,
} from '@remyral/protocol';
import { createGuardedWebFetch } from '../ops/web-fetch.js';
import { readZip, ZipReadError } from '../skills/zip-read.js';

/**
 * p19-ide W3 (docs/design/p19-ide.md §4): the master's Open VSX client — the only place that talks to the registry.
 * Workers and the IDE never reach Open VSX; they get what the admin allowed from the master's cache.
 *
 * What Open VSX offers for integrity (read from the live registry 2026-10-29, `GET /api/<ns>/<name>/<version>`):
 *  - `files.download` — the VSIX; `files.sha256` — a text file with the VSIX's hex SHA-256;
 *  - `files.signature` — a `.sigzip` (zip with `.signature.manifest`, `.signature.sig`, an empty `.signature.p7s`):
 *    `.signature.sig` is a 64-byte **Ed25519 signature over the raw VSIX bytes**; `.signature.manifest` is JSON with
 *    the package's size and base64 SHA-256 plus per-entry digests;
 *  - `files.publicKey` — `/api/-/public-key/<id>`, a PEM SPKI Ed25519 key. open-vsx.org signs every extension with one
 *    registry key (id `14ccb407-…`, the same for every namespace we read).
 * Verified by hand on redhat.vscode-yaml 2.1.2026102308: the signature checks over the VSIX (not over the manifest)
 * and the manifest's digest equals the VSIX's SHA-256.
 *
 * So the master accepts a VSIX only when: its size ≤ 100 MB and equals the registry's; its SHA-256 equals the `.sha256`
 * file and the signed manifest's digest; and the Ed25519 signature verifies with the registry key. For open-vsx.org
 * the key compiled in below is used (the registry's published key is not trusted on first sight); for another
 * registry, or an open-vsx.org key id this release does not know (a rotation), the key the registry publishes is used
 * and the blob is marked `keyPinned: false` (the admin page shows it). This proves the bytes are the ones the registry
 * signed — it does not prove the registry or the publisher is benign; that is what the allowlist is for.
 */

export const DEFAULT_REGISTRY = 'https://open-vsx.org';

/** open-vsx.org's signing keys known to this release: key id → base64 SPKI DER (Ed25519). */
export const OPEN_VSX_PINNED_KEYS: Readonly<Record<string, string>> = {
  '14ccb407-4e79-41ed-be5a-6d608325c45a': 'MCowBQYDK2VwAyEAje+vAaSS1zHV5WHCJSa5UXvxRo6+yerEU3IEmtuEuF4=',
};

/** The platform builds the master caches when an extension has no `universal` one (W2b: macOS and Windows too). */
const BUILD_TARGETS: readonly IdeTargetPlatform[] = [
  'linux-x64',
  'linux-arm64',
  'linux-armhf',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
];

export class OpenVsxError extends Error {
  constructor(
    readonly reason:
      | 'not_found'
      | 'unreachable'
      | 'bad_answer'
      | 'too_large'
      | 'platform'
      | 'unsigned'
      | 'signature'
      | 'digest',
    message: string,
  ) {
    super(message);
    this.name = 'OpenVsxError';
  }
}

export type Fetch = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly url?: string;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface OpenVsxSearchHit {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly verified: boolean;
  readonly deprecated: boolean;
  readonly downloadCount: number;
}

export interface OpenVsxMeta {
  readonly id: string;
  readonly version: string;
  readonly targetPlatform: string;
  readonly displayName: string;
  readonly description: string;
  readonly verified: boolean;
  readonly deprecated: boolean;
  readonly license: string | null;
  readonly engine: string | null;
  /** `extensionDependencies` + `extensionPack` ids (lower-cased). */
  readonly dependencies: readonly string[];
  /** Target platform → VSIX URL. */
  readonly downloads: Readonly<Record<string, string>>;
  readonly downloadSizes: Readonly<Record<string, number>>;
  readonly files: {
    readonly download: string | null;
    readonly signature: string | null;
    readonly sha256: string | null;
    readonly publicKey: string | null;
  };
}

export interface VerifiedVsix {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly keyId: string;
  /** SHA-256 (hex) of the raw 32-byte public key. */
  readonly keyFingerprint: string;
  readonly keyPinned: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** `https://host[:port][/path]` without a trailing slash; throws for anything else. */
export function normalizeRegistry(url: string): string {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
    throw new Error('registry URL must be a plain https URL');
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Splits `publisher.name` (both parts URL-safe by the id pattern). */
export function splitId(id: string): { ns: string; name: string } {
  const parsed = IdeExtensionId.parse(id.toLowerCase());
  const dot = parsed.indexOf('.');
  return { ns: parsed.slice(0, dot), name: parsed.slice(dot + 1) };
}

/** The targets the master caches for an extension: `universal` when published, else every machine build (W2b). */
export function cacheTargets(meta: Pick<OpenVsxMeta, 'targetPlatform' | 'downloads'>): IdeTargetPlatform[] {
  const published = new Set([meta.targetPlatform, ...Object.keys(meta.downloads)]);
  if (published.has('universal')) return ['universal'];
  return BUILD_TARGETS.filter((t) => published.has(t));
}

/** The raw 32-byte Ed25519 public key's SHA-256 (hex). */
export function keyFingerprint(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' });
  return createHash('sha256')
    .update(der.subarray(der.length - 32))
    .digest('hex');
}

/**
 * Checks a VSIX against its `.sigzip` and `.sha256`: size, SHA-256 (the `.sha256` file and the signed manifest's
 * digest) and the Ed25519 signature over the VSIX bytes. Throws {@link OpenVsxError}.
 */
export function verifyVsix(input: {
  readonly vsix: Buffer;
  readonly sigzip: Buffer;
  readonly sha256Text: string | null;
  readonly key: KeyObject;
  readonly expectedSize?: number | undefined;
}): string {
  const { vsix } = input;
  if (vsix.length > IDE_EXTENSION_LIMITS.vsixMaxBytes)
    throw new OpenVsxError('too_large', 'VSIX over 100 MB');
  if (input.expectedSize !== undefined && input.expectedSize !== vsix.length) {
    throw new OpenVsxError('digest', 'the VSIX size differs from the registry’s');
  }
  const sha = createHash('sha256').update(vsix).digest('hex');
  if (input.sha256Text !== null) {
    const want = input.sha256Text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    if (want !== sha)
      throw new OpenVsxError('digest', 'the VSIX SHA-256 differs from the registry’s .sha256');
  }
  let entries;
  try {
    entries = readZip(input.sigzip, {
      maxEntries: 8,
      maxFileBytes: 4 * 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
      maxRatio: 200,
    });
  } catch (err) {
    throw new OpenVsxError(
      'signature',
      `unreadable signature archive (${err instanceof ZipReadError ? err.message : 'zip'})`,
    );
  }
  const sig = entries.find((e) => e.path === '.signature.sig')?.data ?? null;
  const manifestRaw = entries.find((e) => e.path === '.signature.manifest')?.data ?? null;
  if (sig?.length !== 64 || manifestRaw === null) {
    throw new OpenVsxError('signature', 'the signature archive has no Ed25519 signature / manifest');
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = rec(JSON.parse(manifestRaw.toString('utf8')));
  } catch {
    throw new OpenVsxError('signature', 'the signature manifest is not JSON');
  }
  const pkg = rec(manifest.package);
  const digest = str(rec(pkg.digests).sha256);
  if (pkg.size !== vsix.length || digest !== createHash('sha256').update(vsix).digest('base64')) {
    throw new OpenVsxError('digest', 'the signed manifest names another package');
  }
  if (!verify(null, vsix, input.key, sig)) {
    throw new OpenVsxError('signature', 'the registry signature does not verify');
  }
  return sha;
}

export class OpenVsxClient {
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;

  constructor(
    deps: {
      readonly fetch?: Fetch;
      readonly timeoutMs?: number;
      /** Exact origins allowed over a private address (the operator's `ops.internalOrigins`). */
      readonly internalOrigins?: ReadonlySet<string>;
    } = {},
  ) {
    // The registry URL is set by an administrator: every hop (redirects to a CDN included) goes through the egress
    // guard; nothing credentialed is sent.
    const guarded = createGuardedWebFetch({
      redirects: 'follow',
      maxBytes: 128 * 1024 * 1024,
      ...(deps.internalOrigins === undefined ? {} : { internalOrigins: deps.internalOrigins }),
    });
    this.#fetch = deps.fetch ?? ((url, init) => guarded(url, init ?? {}));
    this.#timeoutMs = deps.timeoutMs ?? 60_000;
  }

  async #get(url: string, maxBytes: number): Promise<Buffer> {
    if (!url.startsWith('https://')) throw new OpenVsxError('bad_answer', 'registry link is not https');
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.#fetch(url, {
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { accept: '*/*', 'user-agent': 'remyral-master' },
      });
    } catch {
      throw new OpenVsxError('unreachable', 'the extension registry could not be reached');
    }
    if (res.url !== undefined && res.url !== '' && !res.url.startsWith('https://')) {
      throw new OpenVsxError('bad_answer', 'the registry redirected off https');
    }
    if (res.status === 404) throw new OpenVsxError('not_found', 'not found in the extension registry');
    if (!res.ok)
      throw new OpenVsxError('unreachable', `the extension registry answered ${String(res.status)}`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) throw new OpenVsxError('too_large', 'the registry file is too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new OpenVsxError('too_large', 'the registry file is too large');
    return buf;
  }

  async #json(url: string): Promise<Record<string, unknown>> {
    const buf = await this.#get(url, 4 * 1024 * 1024);
    try {
      return rec(JSON.parse(buf.toString('utf8')));
    } catch {
      throw new OpenVsxError('bad_answer', 'the registry answer is not JSON');
    }
  }

  async search(registry: string, query: string, size = 20): Promise<OpenVsxSearchHit[]> {
    const q = new URLSearchParams({ query: query.slice(0, 100), size: String(Math.min(size, 50)) });
    const body = await this.#json(`${registry}/api/-/search?${q.toString()}`);
    const list = Array.isArray(body.extensions) ? body.extensions : [];
    const out: OpenVsxSearchHit[] = [];
    for (const raw of list) {
      const e = rec(raw);
      const id = `${str(e.namespace)}.${str(e.name)}`.toLowerCase();
      if (!IdeExtensionId.safeParse(id).success || !IdeExtensionVersion.safeParse(e.version).success)
        continue;
      out.push({
        id,
        version: str(e.version),
        displayName: (str(e.displayName) || id).slice(0, 200),
        description: str(e.description).slice(0, 500),
        verified: e.verified === true,
        deprecated: e.deprecated === true,
        downloadCount: typeof e.downloadCount === 'number' ? e.downloadCount : 0,
      });
    }
    return out;
  }

  /** Metadata of one version (`latest` when none) for one target (the default answer when none). */
  async meta(
    registry: string,
    id: string,
    version?: string,
    target?: IdeTargetPlatform,
  ): Promise<OpenVsxMeta> {
    const { ns, name } = splitId(id);
    const v = version === undefined ? 'latest' : IdeExtensionVersion.parse(version);
    const path =
      target === undefined || target === 'universal' ? `${ns}/${name}/${v}` : `${ns}/${name}/${target}/${v}`;
    const e = await this.#json(`${registry}/api/${path}`);
    const ver = str(e.version);
    if (!IdeExtensionVersion.safeParse(ver).success)
      throw new OpenVsxError('bad_answer', 'no version in the answer');
    if (`${str(e.namespace)}.${str(e.name)}`.toLowerCase() !== `${ns}.${name}`)
      throw new OpenVsxError('bad_answer', 'the registry answered for another extension');
    const files = rec(e.files);
    const ids = (v: unknown): string[] =>
      (Array.isArray(v) ? v : [])
        .map((x) => str(x).toLowerCase())
        .filter((x) => IdeExtensionId.safeParse(x).success);
    const downloads: Record<string, string> = {};
    for (const [k, u] of Object.entries(rec(e.downloads))) if (typeof u === 'string') downloads[k] = u;
    const sizes: Record<string, number> = {};
    for (const [k, n] of Object.entries(rec(e.downloadSizes))) if (typeof n === 'number') sizes[k] = n;
    const link = (k: string): string | null => {
      const u = files[k];
      return typeof u === 'string' && u.startsWith('https://') ? u : null;
    };
    return {
      id: `${ns}.${name}`,
      version: ver,
      targetPlatform: str(e.targetPlatform) || 'universal',
      displayName: (str(e.displayName) || `${ns}.${name}`).slice(0, 200),
      description: str(e.description).slice(0, 500),
      verified: e.verified === true,
      deprecated: e.deprecated === true,
      license: str(e.license).slice(0, 200) || null,
      engine: str(rec(e.engines).vscode).slice(0, 64) || null,
      dependencies: [...new Set([...ids(e.dependencies), ...ids(e.bundledExtensions)])]
        .filter((d) => d !== `${ns}.${name}`)
        .slice(0, 64),
      downloads,
      downloadSizes: sizes,
      files: {
        download: link('download'),
        signature: link('signature'),
        sha256: link('sha256'),
        publicKey: link('publicKey'),
      },
    };
  }

  /** The signing key of a registry answer (pinned for open-vsx.org when this release knows its id). */
  async key(
    registry: string,
    publicKeyUrl: string,
  ): Promise<{ key: KeyObject; id: string; pinned: boolean }> {
    const m = /\/api\/-\/public-key\/([A-Za-z0-9-]{1,100})$/.exec(publicKeyUrl);
    const id = m?.[1];
    if (id === undefined || !publicKeyUrl.startsWith(`${registry}/`)) {
      throw new OpenVsxError('unsigned', 'the registry names no signing key of its own');
    }
    const pinned = registry === DEFAULT_REGISTRY ? OPEN_VSX_PINNED_KEYS[id] : undefined;
    if (pinned !== undefined) {
      return {
        key: createPublicKey({ key: Buffer.from(pinned, 'base64'), format: 'der', type: 'spki' }),
        id,
        pinned: true,
      };
    }
    const pem = (await this.#get(publicKeyUrl, 16 * 1024)).toString('utf8');
    let key: KeyObject;
    try {
      key = createPublicKey(pem);
    } catch {
      throw new OpenVsxError('unsigned', 'the registry signing key is not a public key');
    }
    if (key.asymmetricKeyType !== 'ed25519')
      throw new OpenVsxError('unsigned', 'the registry key is not Ed25519');
    return { key, id, pinned: false };
  }

  /** Downloads one target's VSIX with its signature and digest, and verifies them. */
  async fetchVerified(registry: string, meta: OpenVsxMeta): Promise<VerifiedVsix> {
    const f = meta.files;
    if (f.download === null) throw new OpenVsxError('not_found', 'the registry offers no download');
    if (f.signature === null || f.publicKey === null)
      throw new OpenVsxError('unsigned', 'the registry has no signature for this version');
    const expected = meta.downloadSizes[meta.targetPlatform];
    if (expected !== undefined && expected > IDE_EXTENSION_LIMITS.vsixMaxBytes)
      throw new OpenVsxError('too_large', 'VSIX over 100 MB');
    const key = await this.key(registry, f.publicKey);
    const vsix = await this.#get(f.download, IDE_EXTENSION_LIMITS.vsixMaxBytes);
    const sigzip = await this.#get(f.signature, 16 * 1024 * 1024);
    const sha256Text = f.sha256 === null ? null : (await this.#get(f.sha256, 1024)).toString('utf8');
    const sha256 = verifyVsix({ vsix, sigzip, sha256Text, key: key.key, expectedSize: expected });
    return {
      bytes: vsix,
      sha256,
      keyId: key.id,
      keyFingerprint: keyFingerprint(key.key),
      keyPinned: key.pinned,
    };
  }
}
