import { z } from 'zod';
import { Identifier, NonNegativeInt, Sha256Hex } from './common.js';
import { siteFileType } from './site-files.js';

/**
 * Research workspaces (docs/design/p5-research-workspace.md): repository-less projects whose jobs run in an empty
 * per-attempt scratch directory, take uploaded input files and return artifacts. Shared limits and rules so the
 * master, the worker and the console judge the same things. Additive in protocol 1.0 (feature `workspace-v1`).
 */

/** Network egress of a workspace's jobs (model provider APIs are always reachable). */
export const WorkspaceEgress = z.enum(['none', 'allowlist', 'web']);
export type WorkspaceEgress = z.infer<typeof WorkspaceEgress>;

const EGRESS_RANK: Readonly<Record<WorkspaceEgress, number>> = { none: 0, allowlist: 1, web: 2 };

/** The stricter of two egress modes. */
export function minEgress(a: WorkspaceEgress, b: WorkspaceEgress): WorkspaceEgress {
  return EGRESS_RANK[a] <= EGRESS_RANK[b] ? a : b;
}

/** `host` or `host:port` (lower-case DNS name, at least one dot; never an IP literal). */
export const EgressHost = z
  .string()
  .max(260)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9](?::\d{1,5})?$/,
    'host name or host:port (lower-case, no IP literals)',
  );
export const MAX_ALLOW_HOSTS = 64;

export const MAX_INPUTS = 10;
export const MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const MAX_INPUTS_TOTAL_BYTES = 10 * 1024 * 1024;

export const MAX_ARTIFACTS = 20;
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const MAX_ARTIFACTS_TOTAL_BYTES = 15 * 1024 * 1024;
/** Raw bytes per ARTIFACT_CHUNK (base64 on the wire stays far below MAX_FRAME_BYTES). */
export const ARTIFACT_CHUNK_BYTES = 128 * 1024;
/** Raw bytes per JOB_INPUT_DATA answer. */
export const INPUT_CHUNK_BYTES = 192 * 1024;
/** Chunks one artifact may have (MAX_ARTIFACT_BYTES / ARTIFACT_CHUNK_BYTES, rounded up). */
export const MAX_ARTIFACT_CHUNKS = Math.ceil(MAX_ARTIFACT_BYTES / ARTIFACT_CHUNK_BYTES);

/**
 * p8-preview-tunnels: mobile app packages (`.apk`, `.aab`, `.ipa`) a workspace job may return for download — bigger
 * than ordinary outputs, never previewed, served only as an attachment with nosniff. Their own budget: at most
 * {@link MAX_PACKAGES} per job, each ≤ {@link MAX_PACKAGE_BYTES}; they do not count against the output totals above
 * (the project's storage quota still applies). The chunk count fits ARTIFACT_CHUNK's index bound (≤ 1024 chunks).
 */
export const MAX_PACKAGE_BYTES = 80 * 1024 * 1024;
export const MAX_PACKAGES = 2;
export const MAX_PACKAGE_CHUNKS = Math.ceil(MAX_PACKAGE_BYTES / ARTIFACT_CHUNK_BYTES);

/**
 * File types a workspace accepts as inputs and returns as artifacts (by extension). No HTML, SVG, scripts or
 * archives: everything here is either plain text (redacted / scanned as text) or a raster image / PDF checked by
 * magic bytes. `inline`: the console may preview it (text escaped, images as images).
 */
export interface WorkspaceFileType {
  readonly mediaType: string;
  readonly text: boolean;
  readonly inline: boolean;
  /** p8-preview-tunnels: a mobile app package (own size budget, download only). */
  readonly package?: true;
  /**
   * p17-object-storage: a large deliverable (installer, disk image, archive, video) — returned only through the blob
   * store (`blob-upload-v1` workers with `execution.blobUpload`), download only, never an input, never previewed.
   */
  readonly large?: true;
}

export const WORKSPACE_FILE_TYPES: Readonly<Record<string, WorkspaceFileType>> = Object.freeze({
  md: { mediaType: 'text/markdown', text: true, inline: true },
  markdown: { mediaType: 'text/markdown', text: true, inline: true },
  txt: { mediaType: 'text/plain', text: true, inline: true },
  log: { mediaType: 'text/plain', text: true, inline: true },
  csv: { mediaType: 'text/csv', text: true, inline: true },
  tsv: { mediaType: 'text/tab-separated-values', text: true, inline: true },
  json: { mediaType: 'application/json', text: true, inline: true },
  yaml: { mediaType: 'text/yaml', text: true, inline: true },
  yml: { mediaType: 'text/yaml', text: true, inline: true },
  png: { mediaType: 'image/png', text: false, inline: true },
  jpg: { mediaType: 'image/jpeg', text: false, inline: true },
  jpeg: { mediaType: 'image/jpeg', text: false, inline: true },
  gif: { mediaType: 'image/gif', text: false, inline: true },
  webp: { mediaType: 'image/webp', text: false, inline: true },
  pdf: { mediaType: 'application/pdf', text: false, inline: false },
  // p8-preview-tunnels: mobile app packages (ZIP containers, magic bytes checked), download only.
  apk: { mediaType: 'application/vnd.android.package-archive', text: false, inline: false, package: true },
  aab: { mediaType: 'application/x-android-app-bundle', text: false, inline: false, package: true },
  ipa: { mediaType: 'application/x-ios-app', text: false, inline: false, package: true },
  // p17-object-storage: large deliverables (magic bytes checked where the format has them), blob store only.
  exe: {
    mediaType: 'application/vnd.microsoft.portable-executable',
    text: false,
    inline: false,
    large: true,
  },
  msi: { mediaType: 'application/x-msi', text: false, inline: false, large: true },
  dmg: { mediaType: 'application/x-apple-diskimage', text: false, inline: false, large: true },
  pkg: { mediaType: 'application/x-xar', text: false, inline: false, large: true },
  zip: { mediaType: 'application/zip', text: false, inline: false, large: true },
  'tar.gz': { mediaType: 'application/gzip', text: false, inline: false, large: true },
  tgz: { mediaType: 'application/gzip', text: false, inline: false, large: true },
  mp4: { mediaType: 'video/mp4', text: false, inline: false, large: true },
  webm: { mediaType: 'video/webm', text: false, inline: false, large: true },
});

/** p17-object-storage: media types of large deliverables (blob store only, attachments only). */
export const LARGE_MEDIA_TYPES: ReadonlySet<string> = new Set(
  Object.values(WORKSPACE_FILE_TYPES)
    .filter((t) => t.large === true)
    .map((t) => t.mediaType),
);

/** p17-object-storage: download-only outputs (packages and large deliverables) — never inline, never inputs. */
export function downloadOnlyType(t: WorkspaceFileType): boolean {
  return t.package === true || t.large === true;
}

/** Media types of mobile app packages (served as attachments only, never inline). */
export const PACKAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(
  Object.values(WORKSPACE_FILE_TYPES)
    .filter((t) => t.package === true)
    .map((t) => t.mediaType),
);

/** Largest size of a stored output of this type. */
export function maxArtifactBytesFor(t: WorkspaceFileType): number {
  return t.package === true ? MAX_PACKAGE_BYTES : MAX_ARTIFACT_BYTES;
}

/** Media types that may be shown inline by the console (served with a sandbox CSP + nosniff). */
export const INLINE_MEDIA_TYPES: ReadonlySet<string> = new Set(
  Object.values(WORKSPACE_FILE_TYPES)
    .filter((t) => t.inline)
    .map((t) => t.mediaType),
);

/** Type of a file name by its extension, or null when not allowed. */
export function workspaceFileType(name: string): WorkspaceFileType | null {
  // p17-object-storage: the one double extension (`.tar.gz`).
  if (/[^/]\.tar\.gz$/i.test(name)) return WORKSPACE_FILE_TYPES['tar.gz'] ?? null;
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  if (m?.[1] === undefined) return null;
  return WORKSPACE_FILE_TYPES[m[1].toLowerCase()] ?? null;
}

/** True when the bytes start like the declared binary type (text types: valid UTF-8 without NUL). */
export function contentMatchesType(bytes: Uint8Array, mediaType: string): boolean {
  const starts = (sig: readonly number[], at = 0): boolean => sig.every((b, i) => bytes[at + i] === b);
  switch (mediaType) {
    case 'image/png':
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return starts([0xff, 0xd8, 0xff]);
    case 'image/gif':
      return starts([0x47, 0x49, 0x46, 0x38]);
    case 'image/webp':
      return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
    case 'application/pdf':
      return starts([0x25, 0x50, 0x44, 0x46, 0x2d]);
    // p8-preview-tunnels: APK / AAB / IPA are ZIP files (local file header `PK\x03\x04`).
    case 'application/vnd.android.package-archive':
    case 'application/x-android-app-bundle':
    case 'application/x-ios-app':
      return starts([0x50, 0x4b, 0x03, 0x04]);
    // p17-object-storage: large deliverables.
    case 'application/zip':
      return starts([0x50, 0x4b, 0x03, 0x04]) || starts([0x50, 0x4b, 0x05, 0x06]);
    case 'application/vnd.microsoft.portable-executable':
      return starts([0x4d, 0x5a]);
    case 'application/x-msi':
      return starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case 'application/x-xar':
      return starts([0x78, 0x61, 0x72, 0x21]);
    case 'application/gzip':
      return starts([0x1f, 0x8b]);
    case 'video/mp4':
      return starts([0x66, 0x74, 0x79, 0x70], 4);
    case 'video/webm':
      return starts([0x1a, 0x45, 0xdf, 0xa3]);
    // A UDIF disk image has its signature in a trailer at the end, not at the start: no prefix check.
    case 'application/x-apple-diskimage':
      return bytes.length > 0;
    default: {
      if (bytes.includes(0)) return false;
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return true;
      } catch {
        return false;
      }
    }
  }
}

/** An input file name: one safe segment with an allowlisted extension. */
export const InputName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,99}$/, 'file name [A-Za-z0-9 ._()+-], ≤ 100 characters')
  .refine((n) => {
    const t = workspaceFileType(n);
    // p8-preview-tunnels / p17-object-storage: packages and large deliverables are outputs only, never inputs.
    return !n.includes('..') && t !== null && !downloadOnlyType(t);
  }, 'file type not allowed');

/**
 * An artifact name: a relative path below `out/` (≤ 4 segments of safe characters, no `..`), allowlisted
 * extension. `summary.md` is the run's summary written by the worker.
 */
export const ArtifactName = z
  .string()
  .max(255)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,99}){0,3}$/,
    'relative path of safe segments',
  )
  .refine((n) => !n.split('/').some((s) => s === '..' || s.endsWith('.')), 'unsafe path segment')
  .refine((n) => workspaceFileType(n) !== null, 'file type not allowed');

/** Workspace artifact ids start with `ws-` (the pushed-diff artifact of repository jobs uses `diff-`). */
export const WorkspaceArtifactId = Identifier.refine(
  (id) => /^ws-[a-z0-9-]{1,100}$/.test(id),
  'ws- artifact id',
);

export const InputRef = z.object({
  inputId: z.string().regex(/^in-[a-z0-9]{1,32}$/, 'input id'),
  name: InputName,
  mediaType: z.string().regex(/^[a-z]+\/[A-Za-z0-9.+-]+$/),
  sizeBytes: NonNegativeInt.max(MAX_INPUT_BYTES),
  sha256: Sha256Hex,
});
export type InputRef = z.infer<typeof InputRef>;

/** `JobSpec.workspace`: set by the master for jobs of a workspace project (never trusted from a submitter). */
export const WorkspaceJobSpec = z.object({
  egress: WorkspaceEgress,
  allowHosts: z.array(EgressHost).max(MAX_ALLOW_HOSTS).optional(),
  inputs: z.array(InputRef).max(MAX_INPUTS).optional(),
  /**
   * p16-workflow-quality (additive in 1.0; only to `repo-scratch-v1` workers): a repository-less workflow step of a
   * REPOSITORY project (no repository known for the run, and the step needs no code). The worker runs it in a scratch
   * directory like a workspace job when the project is one of its repository projects (egress ceiling `web`). Set by
   * the master's workflow engine only; older workers strip it and refuse the job (they are never chosen for it).
   */
  scratch: z.literal(true).optional(),
});
export type WorkspaceJobSpec = z.infer<typeof WorkspaceJobSpec>;

/** Per-project entry of the managed config document (`WorkerConfigDocument.workspaces`). */
export const WorkspaceProjectConfig = z.object({
  egress: WorkspaceEgress,
  allowHosts: z.array(EgressHost).max(MAX_ALLOW_HOSTS).optional(),
});
export type WorkspaceProjectConfig = z.infer<typeof WorkspaceProjectConfig>;

export const WORKSPACE_FEATURE = 'workspace-v1';
/** p16-workflow-quality: runs `WorkspaceJobSpec.scratch` steps of repository projects. */
export const REPO_SCRATCH_FEATURE = 'repo-scratch-v1';

// ------------------------------------------------------------------------------------- p6-deploy-pipeline

/**
 * Static site bundles (p6-deploy-pipeline, ADR-0028): a job that declares `JobSpec.siteBundle` returns its built
 * site as ONE artifact `site-bundle.json` (id {@link SITE_BUNDLE_ARTIFACT_ID}) that the master can publish to
 * Cloudflare Pages through an ops action. The console never renders it (HTML would run on the console origin); only
 * the master's Pages upload reads it.
 */
export const SITE_BUNDLE_ARTIFACT_ID = 'ws-site-bundle';
export const SITE_BUNDLE_NAME = 'site-bundle.json';
/** Bytes of the JSON container (base64 inside), within one artifact's limit. */
export const SITE_BUNDLE_MAX_BYTES = MAX_ARTIFACT_BYTES;
export const SITE_BUNDLE_MAX_FILES = 500;

// The site file types live in `site-files.ts` (pure, shared with the console; p10-site-upload added mp4 / webm).
export { SITE_FILE_TYPES, siteFileType } from './site-files.js';

/** A relative path inside the site: safe segments, at most 8 deep, no `..`, no hidden files except `.well-known`. */
export const SitePath = z
  .string()
  .max(300)
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9 ._@()+-]{0,99}(\/[A-Za-z0-9_.][A-Za-z0-9 ._@()+-]{0,99}){0,7}$/,
    'site path',
  )
  .refine(
    (p) => !p.split('/').some((s) => s === '..' || s === '.' || (s.startsWith('.') && s !== '.well-known')),
    'unsafe path segment',
  )
  .refine((p) => siteFileType(p) !== null, 'file type not allowed in a site');

/** `JobSpec.siteBundle`: the directory holding the built site (relative; e.g. `dist`, `out`, `site/public`). */
export const SiteBundleRequest = z.object({
  directory: z
    .string()
    .regex(
      /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,63}){0,3}$/,
      'relative directory',
    )
    .refine((d) => !d.split('/').some((s) => s === '..' || s === '.'), 'unsafe directory'),
});
export type SiteBundleRequest = z.infer<typeof SiteBundleRequest>;

/** The content of `site-bundle.json`. */
export const SiteBundle = z.strictObject({
  version: z.literal(1),
  directory: z.string().max(300),
  files: z
    .array(
      z.strictObject({
        path: SitePath,
        contentType: z.string().regex(/^[a-z]+\/[A-Za-z0-9.+-]+$/),
        sha256: Sha256Hex,
        base64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
      }),
    )
    .min(1)
    .max(SITE_BUNDLE_MAX_FILES),
});
export type SiteBundle = z.infer<typeof SiteBundle>;
