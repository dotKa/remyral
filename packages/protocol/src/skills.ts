import { createHash, type KeyObject, sign } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import { Ed25519PublicKey, Ed25519Signature, Sha256Hex, Timestamp } from './common.js';
import { RuntimeKind, runtimeKindList } from './common.js';
import { ReleaseVersion } from './release.js';

/**
 * Signed, versioned skills (p6-skills, docs/design/p6-skills.md).
 *
 * A skill version is a set of UTF-8 text files — `SKILL.md` plus optional `scripts/`, `references/`,
 * `resources/` and `assets/` files — described by a manifest (JSON, the *exact bytes* are signed) and a
 * detached Ed25519 signature made with the **skills key**. The skills key is neither the release key nor
 * the lease-signing key nor a device key: it is kept offline by the owner (`scripts/skills/sign.mjs`).
 * The master verifies on upload and stores; every worker verifies again, with the keys from its own
 * (root-owned) config, before a skill is materialised — a compromised master cannot inject a skill.
 *
 * Shared by the signing script (same rules re-implemented there without dependencies, pinned by a test),
 * the master and the worker so the rules can never diverge.
 */

/** Domain separation: a skill signature can never be confused with a release, AUTH or lease signature. */
export const SKILL_SIGNATURE_CONTEXT = 'remana-skill/v1\n';
export const MAX_SKILL_MANIFEST_BYTES = 16 * 1024;
export const MAX_SKILL_FILES = 32;
export const MAX_SKILL_FILE_BYTES = 64 * 1024;
export const MAX_SKILL_TOTAL_BYTES = 128 * 1024;
/** All skills delivered with one ASSIGN_JOB together (the frame limit is 512 KiB). */
export const MAX_JOB_SKILLS = 8;
export const MAX_JOB_SKILL_BYTES = 160 * 1024;
export const MAX_TRUSTED_SKILL_KEYS = 2;

/**
 * p14-skill-catalogs (ADR-0054 decision 6, docs/design/p14-mcp-skills.md §3.4): the wider skill layout **v2** — any
 * safe relative text path (top-level `reference.md`, `templates/`, `examples/`, …) of at most four directories, ≤ 64
 * files, ≤ 128 KiB per file, ≤ 512 KiB per skill, ≤ 640 KiB per job, text only. A v2 manifest says `schema: 2`; only
 * workers advertising {@link SKILLS_LAYOUT_V2_FEATURE} parse it, so the master sends such skills (and job skill sets
 * above the v1 job total) only to them and keeps v1 bundles (`schema: 1`) for everything that fits the old layout.
 */
export const SKILLS_LAYOUT_V2_FEATURE = 'skills-layout-v2';
export const MAX_SKILL_FILES_V2 = 64;
export const MAX_SKILL_FILE_BYTES_V2 = 128 * 1024;
export const MAX_SKILL_TOTAL_BYTES_V2 = 512 * 1024;
/** 64 entries with long paths no longer fit 16 KiB of pretty-printed manifest. */
export const MAX_SKILL_MANIFEST_BYTES_V2 = 32 * 1024;
export const MAX_JOB_SKILL_BYTES_V2 = 640 * 1024;
/** Directories a v2 path may have (`a/b/c/d/file.md`). */
export const MAX_SKILL_PATH_DEPTH_V2 = 4;
/**
 * Skill file bytes that travel inside one ASSIGN_JOB (frames are capped at 512 KiB). A v2 worker gets the rest out of
 * band: the signed manifest rides in ASSIGN_JOB `skills.deferred`, the files are pulled by manifest hash and path with
 * SKILL_FILE_REQUEST over the worker's authenticated session and checked against the signed manifest.
 */
export const MAX_INLINE_JOB_SKILL_BYTES = 160 * 1024;
/** Raw bytes per SKILL_FILE_DATA answer (base64 stays far below MAX_FRAME_BYTES). */
export const SKILL_FILE_CHUNK_BYTES = 192 * 1024;
export type SkillLayout = 1 | 2;
/** p5-machine-admin (ADR-0021): the worker trusts the panel skills key delivered in its managed configuration. */
export const PANEL_SKILLS_FEATURE = 'panel-skills-v1';
/** p14-skill-import (ADR-0054): the worker honours ASSIGN_JOB `execution.skillTrust` (see worker-features.ts). */
export const SKILL_TRUST_FEATURE = 'skill-trust-v1';
/**
 * p14-skill-import: a project's skill trust level. `offline-only`: only versions signed with the owner's offline
 * skills key reach its jobs — never a panel-signed (imported or chat-written) one.
 */
export const SkillTrust = z.enum(['any', 'offline-only']);
export type SkillTrust = z.infer<typeof SkillTrust>;

/**
 * Skill id: lowercase letters, digits and hyphens, ≤ 64 chars — the strictest of the runtimes' skill-name
 * rules (Claude Code / Codex / OpenCode `name`), so the id can be the directory name everywhere.
 */
export const SkillId = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and single hyphens')
  .max(64);
export type SkillId = z.infer<typeof SkillId>;

export const SKILL_FILE_DIRS = ['scripts', 'references', 'resources', 'assets'] as const;

/**
 * Relative POSIX path inside the skill: `SKILL.md`, or `<dir>/<name>` / `<dir>/<sub>/<name>` with `<dir>` one
 * of {@link SKILL_FILE_DIRS}. Segments are `[A-Za-z0-9_-]` with an optional `.ext`; no `..`, no hidden files,
 * no backslashes, no absolute paths — a path can never leave the skill directory on any OS.
 */
export const SkillFilePath = z
  .string()
  .max(160)
  .refine(
    (p) =>
      p === 'SKILL.md' ||
      new RegExp(
        `^(${SKILL_FILE_DIRS.join('|')})(/[A-Za-z0-9_-]{1,64}){0,2}/[A-Za-z0-9_-]{1,64}(\\.[A-Za-z0-9]{1,16})?$`,
      ).test(p),
    'SKILL.md or scripts|references|resources|assets/<name>[.ext] (max two sub-directories)',
  );

/** Windows device names (a file `con.md` cannot be created there). */
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const V2_SEGMENT = /^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,32}){0,3}$/;

/** True for a layout-v2 path: ≤ 160 characters, ≤ {@link MAX_SKILL_PATH_DEPTH_V2} directories, safe segments. */
export function isSkillPathV2(p: string): boolean {
  if (p.length === 0 || p.length > 160) return false;
  const segs = p.split('/');
  if (segs.length > MAX_SKILL_PATH_DEPTH_V2 + 1) return false;
  return segs.every((s) => V2_SEGMENT.test(s) && !RESERVED_SEGMENT.test(s));
}

/**
 * p14-skill-catalogs: a layout-v2 path — relative POSIX, segments `[A-Za-z0-9_-]` with up to three `.ext` parts, no
 * hidden files, no `..`, no backslashes, no Windows device names, ≤ 4 directories. Every v1 path is a v2 path.
 */
export const SkillFilePathV2 = z
  .string()
  .max(160)
  .refine(
    (p) => isSkillPathV2(p),
    'a relative path of safe segments ([A-Za-z0-9_-] with up to three .ext parts), at most four directories',
  );

/** Layout limits per version (shown in the console, enforced by the importer and the manifests). */
export const SKILL_LAYOUT_LIMITS = {
  1: {
    maxFiles: MAX_SKILL_FILES,
    maxFileBytes: MAX_SKILL_FILE_BYTES,
    maxTotalBytes: MAX_SKILL_TOTAL_BYTES,
    maxJobBytes: MAX_JOB_SKILL_BYTES,
  },
  2: {
    maxFiles: MAX_SKILL_FILES_V2,
    maxFileBytes: MAX_SKILL_FILE_BYTES_V2,
    maxTotalBytes: MAX_SKILL_TOTAL_BYTES_V2,
    maxJobBytes: MAX_JOB_SKILL_BYTES_V2,
  },
} as const;

/** The layout a set of files needs: 1 when it fits today's layout, 2 when only v2 holds it, null when neither does. */
export function skillLayoutOf(
  files: readonly { readonly path: string; readonly size: number }[],
): SkillLayout | null {
  const total = files.reduce((n, f) => n + f.size, 0);
  const fitsV1 =
    files.length <= MAX_SKILL_FILES &&
    total <= MAX_SKILL_TOTAL_BYTES &&
    files.every((f) => f.size <= MAX_SKILL_FILE_BYTES && SkillFilePath.safeParse(f.path).success);
  if (fitsV1) return 1;
  const fitsV2 =
    files.length <= MAX_SKILL_FILES_V2 &&
    total <= MAX_SKILL_TOTAL_BYTES_V2 &&
    files.every((f) => f.size <= MAX_SKILL_FILE_BYTES_V2 && isSkillPathV2(f.path));
  return fitsV2 ? 2 : null;
}

export const SkillFileEntry = z.strictObject({
  path: SkillFilePath,
  sha256: Sha256Hex,
  size: z.number().int().min(0).max(MAX_SKILL_FILE_BYTES),
  /** Materialised with the executable bit (scripts). Only allowed under `scripts/`. */
  executable: z.boolean(),
});
export type SkillFileEntry = z.infer<typeof SkillFileEntry>;

/** p14-skill-catalogs: a layout-v2 file entry (any safe path, ≤ 128 KiB). */
export const SkillFileEntryV2 = z.strictObject({
  path: SkillFilePathV2,
  sha256: Sha256Hex,
  size: z.number().int().min(0).max(MAX_SKILL_FILE_BYTES_V2),
  executable: z.boolean(),
});

const manifestBase = {
  kind: z.literal('remana.skill'),
  id: SkillId,
  /** Human-readable name (the runtimes' `name` field is the id). */
  title: z.string().min(1).max(120),
  version: ReleaseVersion,
  /** What the skill does and when to use it (SKILL.md frontmatter `description`). */
  description: z.string().min(1).max(1024),
  /**
   * Runtimes the skill was written and tested for. ADR-0023: a retired runtime in a signed manifest is dropped
   * when parsed (the signature covers the raw bytes); a skill only for retired runtimes no longer validates.
   */
  runtimes: runtimeKindList(RuntimeKind.options.length, 1),
  createdAt: Timestamp,
};

type ManifestShape = {
  readonly runtimes: readonly string[];
  readonly files: readonly { readonly path: string; readonly size: number; readonly executable: boolean }[];
};

function manifestRules(maxTotal: number): (m: ManifestShape, ctx: z.RefinementCtx) => void {
  return (m, ctx) => {
    if (new Set(m.runtimes).size !== m.runtimes.length) {
      ctx.addIssue({ code: 'custom', path: ['runtimes'], message: 'must not contain duplicates' });
    }
    const paths = m.files.map((f) => f.path);
    const lower = paths.map((p) => p.toLowerCase());
    if (new Set(lower).size !== paths.length) {
      ctx.addIssue({ code: 'custom', path: ['files'], message: 'duplicate path (case-insensitive)' });
    }
    if (!paths.includes('SKILL.md')) {
      ctx.addIssue({ code: 'custom', path: ['files'], message: 'SKILL.md is required' });
    }
    // A file and a directory of the same name (`a` and `a/b`) cannot both be materialised.
    const files = new Set(lower);
    for (const p of lower) {
      const segs = p.split('/');
      for (let i = 1; i < segs.length; i++) {
        if (files.has(segs.slice(0, i).join('/'))) {
          ctx.addIssue({
            code: 'custom',
            path: ['files'],
            message: `a path is below the file ${segs[0] ?? ''}`,
          });
        }
      }
    }
    for (const [i, f] of m.files.entries()) {
      if (f.executable && !f.path.startsWith('scripts/')) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', i, 'executable'],
          message: 'only scripts/ may be executable',
        });
      }
    }
    if (m.files.reduce((n, f) => n + f.size, 0) > maxTotal) {
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: `total size above ${String(maxTotal)} bytes`,
      });
    }
  };
}

/** Layout v1 (`schema: 1`): SKILL.md + scripts/ references/ resources/ assets/, ≤ 32 files / 64 KiB each / 128 KiB. */
export const SkillManifestV1 = z
  .strictObject({
    schema: z.literal(1),
    ...manifestBase,
    files: z.array(SkillFileEntry).min(1).max(MAX_SKILL_FILES),
  })
  .superRefine(manifestRules(MAX_SKILL_TOTAL_BYTES));

/** p14-skill-catalogs: layout v2 (`schema: 2`), parsed only by `skills-layout-v2` workers. */
export const SkillManifestV2 = z
  .strictObject({
    schema: z.literal(2),
    ...manifestBase,
    files: z.array(SkillFileEntryV2).min(1).max(MAX_SKILL_FILES_V2),
  })
  .superRefine(manifestRules(MAX_SKILL_TOTAL_BYTES_V2));

export const SkillManifest = z.union([SkillManifestV1, SkillManifestV2]);
export type SkillManifest = z.infer<typeof SkillManifest>;

export const SkillKeyId = z.string().regex(/^[a-f0-9]{16}$/, '16 lowercase hex characters');

export const SkillSignature = z.strictObject({ keyId: SkillKeyId, signature: Ed25519Signature });
export type SkillSignature = z.infer<typeof SkillSignature>;

export const TrustedSkillKeys = z
  .array(Ed25519PublicKey)
  .min(1)
  .max(MAX_TRUSTED_SKILL_KEYS)
  .refine((k) => new Set(k).size === k.length, 'must not contain duplicates');

/** Short, stable id of a skills public key: first 16 hex characters of SHA-256 of the raw key. */
export function skillKeyId(publicKeyB64Url: string): string {
  const raw = Buffer.from(Ed25519PublicKey.parse(publicKeyB64Url), 'base64url');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** Bytes the skills key signs: context prefix + the manifest file exactly as distributed. */
export function skillSigningPayload(manifestBytes: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(SKILL_SIGNATURE_CONTEXT, 'utf8'), manifestBytes]);
}

export function skillSha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The upload / delivery form of one skill version: manifest bytes (base64, exact), the detached signature
 * and every file's UTF-8 content keyed by path. Used by `POST /skills` and inside ASSIGN_JOB.
 */
export const SignedSkillBundle = z.strictObject({
  manifest: z.base64().max(Math.ceil(MAX_SKILL_MANIFEST_BYTES_V2 / 3) * 4),
  signature: SkillSignature,
  files: z.record(SkillFilePathV2, z.string().max(MAX_SKILL_FILE_BYTES_V2)),
});
export type SignedSkillBundle = z.infer<typeof SignedSkillBundle>;

export type SkillRefusal =
  | 'no_trusted_keys'
  | 'manifest_too_large'
  | 'invalid_signature_document'
  | 'unknown_key'
  | 'bad_signature'
  | 'invalid_manifest'
  | 'files_mismatch'
  | 'file_hash_mismatch'
  | 'file_not_utf8'
  | 'layout_unsupported';

export type SkillVerification =
  | {
      readonly ok: true;
      readonly manifest: SkillManifest;
      readonly keyId: string;
      /** sha256 hex of the exact manifest bytes (pins the whole version: files are hashed inside). */
      readonly manifestSha256: string;
    }
  | { readonly ok: false; readonly reason: SkillRefusal; readonly detail?: string };

/**
 * Verifies the signature over the raw manifest bytes with one of the trusted keys, only then parses the
 * manifest, then checks that `files` is exactly the manifest's file set with matching sizes and SHA-256.
 * Never throws.
 */
export function verifySkillBundle(
  bundle: unknown,
  trustedKeys: readonly string[],
  options: {
    /** false: a layout-v2 manifest (`schema: 2`) is refused with `layout_unsupported`. Default: accepted. */
    readonly layoutV2?: boolean;
    /**
     * p14-skill-catalogs: check the signature and the manifest only — a deferred skill whose files are fetched out of
     * band. The assembled bundle must be verified again with a full call before anything is materialised.
     */
    readonly manifestOnly?: boolean;
  } = {},
): SkillVerification {
  const keys = trustedKeys.filter((k) => Ed25519PublicKey.safeParse(k).success);
  if (keys.length === 0) return { ok: false, reason: 'no_trusted_keys' };
  if (typeof bundle !== 'object' || bundle === null) return { ok: false, reason: 'invalid_manifest' };
  const b = bundle as Record<string, unknown>;
  if (typeof b.manifest !== 'string')
    return { ok: false, reason: 'invalid_manifest', detail: 'manifest missing' };
  const manifestBytes = Buffer.from(b.manifest, 'base64');
  if (manifestBytes.byteLength > MAX_SKILL_MANIFEST_BYTES_V2)
    return { ok: false, reason: 'manifest_too_large' };
  const sig = SkillSignature.safeParse(b.signature);
  if (!sig.success) return { ok: false, reason: 'invalid_signature_document' };
  const key = keys.find((k) => skillKeyId(k) === sig.data.keyId);
  if (key === undefined) return { ok: false, reason: 'unknown_key', detail: sig.data.keyId };
  if (!verifyEd25519(key, skillSigningPayload(manifestBytes), sig.data.signature)) {
    return { ok: false, reason: 'bad_signature' };
  }
  let json: unknown;
  try {
    json = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_manifest', detail: 'not JSON' };
  }
  const schema =
    typeof json === 'object' && json !== null ? (json as { schema?: unknown }).schema : undefined;
  if (schema !== 2 && manifestBytes.byteLength > MAX_SKILL_MANIFEST_BYTES) {
    return { ok: false, reason: 'manifest_too_large' };
  }
  if (schema === 2 && options.layoutV2 === false) return { ok: false, reason: 'layout_unsupported' };
  const parsed = (schema === 2 ? SkillManifestV2 : SkillManifestV1).safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_manifest',
      detail: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
    };
  }
  const manifest: SkillManifest = parsed.data;
  if (options.manifestOnly === true) {
    return { ok: true, manifest, keyId: sig.data.keyId, manifestSha256: skillSha256(manifestBytes) };
  }
  const files = b.files;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    return { ok: false, reason: 'files_mismatch', detail: 'files missing' };
  }
  const given = Object.keys(files).sort();
  const expected = manifest.files.map((f) => f.path).sort();
  if (given.length !== expected.length || given.some((p, i) => p !== expected[i])) {
    return { ok: false, reason: 'files_mismatch', detail: 'file set differs from the manifest' };
  }
  for (const entry of manifest.files) {
    const content = (files as Record<string, unknown>)[entry.path];
    if (typeof content !== 'string') return { ok: false, reason: 'files_mismatch', detail: entry.path };
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.toString('utf8') !== content || content.includes('\u0000')) {
      return { ok: false, reason: 'file_not_utf8', detail: entry.path };
    }
    if (bytes.byteLength !== entry.size || skillSha256(bytes) !== entry.sha256) {
      return { ok: false, reason: 'file_hash_mismatch', detail: entry.path };
    }
  }
  return { ok: true, manifest, keyId: sig.data.keyId, manifestSha256: skillSha256(manifestBytes) };
}

/**
 * p5-machine-admin (ADR-0021): builds and signs a skill version from its files — what the panel skills key does when
 * an administrator confirms a chat-authored skill. The same rules as `scripts/skills/sign.mjs pack`: the manifest
 * lists every file with size and SHA-256, the signature covers the exact manifest bytes. Throws on an invalid
 * manifest (the caller validated the input already).
 */
export function packSkillBundle(
  input: {
    readonly id: string;
    readonly title: string;
    readonly version: string;
    readonly description: string;
    readonly runtimes: readonly RuntimeKind[];
    readonly files: Readonly<Record<string, string>>;
    readonly createdAt: string;
  },
  privateKey: KeyObject,
  publicKeyB64Url: string,
): {
  readonly bundle: SignedSkillBundle;
  readonly manifestSha256: string;
  readonly layout: SkillLayout;
} {
  const paths = Object.keys(input.files).sort();
  // p14-skill-catalogs: a skill that fits today's layout stays `schema: 1` (every worker takes it); larger ones are v2.
  const layout =
    skillLayoutOf(paths.map((p) => ({ path: p, size: Buffer.byteLength(input.files[p] ?? '', 'utf8') }))) ??
    2;
  const manifest = (layout === 1 ? SkillManifestV1 : SkillManifestV2).parse({
    schema: layout,
    kind: 'remana.skill',
    id: input.id,
    title: input.title,
    version: input.version,
    description: input.description,
    runtimes: [...input.runtimes],
    files: paths.map((path) => {
      const bytes = Buffer.from(input.files[path] ?? '', 'utf8');
      return {
        path,
        sha256: skillSha256(bytes),
        size: bytes.byteLength,
        executable: path.startsWith('scripts/'),
      };
    }),
    createdAt: input.createdAt,
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const signature = sign(null, skillSigningPayload(manifestBytes), privateKey).toString('base64url');
  const bundle: SignedSkillBundle = {
    manifest: manifestBytes.toString('base64'),
    signature: { keyId: skillKeyId(publicKeyB64Url), signature },
    files: Object.fromEntries(paths.map((p) => [p, input.files[p] ?? ''])),
  };
  return { bundle, manifestSha256: skillSha256(manifestBytes), layout };
}

/** A skill pinned for a job: id, version and the manifest hash the master recorded. */
export const SkillPin = z.strictObject({ id: SkillId, version: ReleaseVersion, manifestSha256: Sha256Hex });
export type SkillPin = z.infer<typeof SkillPin>;

/**
 * Hash of a job's skill set: sha256 over `remana.skills/v1` + one `id@version:manifestSha256` line per skill,
 * sorted by id. Order-independent; any version or content change changes it.
 */
export function skillSetHash(pins: readonly SkillPin[]): string {
  const lines = [...pins]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => `${p.id}@${p.version}:${p.manifestSha256}\n`);
  return `sha256:${skillSha256(`remana.skills/v1\n${lines.join('')}`)}`;
}

/**
 * Skills delivered with ASSIGN_JOB (additive in 1.0): the signed bundles, pinned per job by the master
 * (first issue wins, later attempts get exactly the same versions) and identified by `setHash`.
 */
/**
 * p14-skill-catalogs: a skill whose files are not inside ASSIGN_JOB — its signed manifest only. The worker verifies the
 * signature and the manifest at admission, pulls every file by `(manifest sha256, path)` with SKILL_FILE_REQUEST and
 * verifies the assembled bundle (size + SHA-256 of every file) before anything is materialised.
 */
export const DeferredSkill = z.strictObject({
  manifest: z.base64().max(Math.ceil(MAX_SKILL_MANIFEST_BYTES_V2 / 3) * 4),
  signature: SkillSignature,
});
export type DeferredSkill = z.infer<typeof DeferredSkill>;

export const AssignedSkills = z
  .strictObject({
    setHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    bundles: z.array(SignedSkillBundle).max(MAX_JOB_SKILLS),
    /** p14-skill-catalogs (`skills-layout-v2` workers only): skills delivered out of band (manifest only here). */
    deferred: z.array(DeferredSkill).min(1).max(MAX_JOB_SKILLS).optional(),
  })
  .refine((a) => a.bundles.length + (a.deferred?.length ?? 0) >= 1, 'at least one skill')
  .refine(
    (a) => a.bundles.length + (a.deferred?.length ?? 0) <= MAX_JOB_SKILLS,
    `at most ${String(MAX_JOB_SKILLS)} skills`,
  );
export type AssignedSkills = z.infer<typeof AssignedSkills>;
