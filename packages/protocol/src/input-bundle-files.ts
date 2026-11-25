/**
 * p16-zip-job-input (docs/design/p16-zip-job-input.md, ADR-0060): a job input bundle — the files of a .zip the owner
 * dropped into the chat (or the job composer), unpacked in the browser, uploaded to the master and pulled by the
 * worker into the job's `in/` before the agent runs. Pure (no zod) so the console applies the same rules before it
 * sends anything; the master re-checks every rule (`@remyral/protocol/input-bundle-files`).
 *
 * File types (ADR-0060): every type is allowed — source, text, documents, office files, PDF, images, media and nested
 * archives (stored as files, never extracted) — EXCEPT native executables and libraries, recognised by their magic
 * bytes (ELF, PE, Mach-O) and by their extension. Those are refused unless the owner's security policy allows them
 * (`inputs.executables`).
 */

export const INPUT_BUNDLE_LIMITS = Object.freeze({
  maxFiles: 2000,
  maxTotalBytes: 100 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  /** The .zip itself (compressed), read whole in the browser. */
  maxArchiveBytes: 128 * 1024 * 1024,
  /** Directory depth: at most 16 path segments (the workfiles rule). */
  maxSegments: 16,
  maxPathLength: 300,
  maxSegmentLength: 120,
  /** One upload request carries at most this many bytes (chunked upload, like site uploads). */
  partBytes: 4 * 1024 * 1024,
  minPartBytes: 64 * 1024,
  /** A ready bundle is kept this long after it was last used (or completed); never while a job still needs it. */
  retentionDays: 14,
  /** Ready bundles a project keeps at most (the oldest unused one is removed first). */
  keptPerProject: 20,
  /** Unfinished uploads per person. */
  receivingPerUser: 2,
  /** Paths of a bundle the assistant sees in the turn's context (the rest is paged by a tool). */
  contextFiles: 25,
  /** Entries of one INPUT_BUNDLE_DATA list answer. */
  listPage: 500,
  /** Raw bytes of one INPUT_BUNDLE_DATA read answer (base64 stays far below MAX_FRAME_BYTES). */
  chunkBytes: 192 * 1024,
  /** Bundles per chat message. */
  maxPerMessage: 2,
});

/** The folder of the job's working directory the bundle lands in (repository jobs: a scratch folder next to the checkout). */
export const INPUT_BUNDLE_DIR = 'in';

/** Folders the console leaves out of a bundle (version control metadata, dependency trees, OS litter). */
export const INPUT_BUNDLE_SKIPPED_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', '__MACOSX']);
export const INPUT_BUNDLE_LITTER: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Extensions of native executables and libraries (refused like their magic bytes, unless the policy allows them). */
export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe',
  'dll',
  'sys',
  'scr',
  'com',
  'msi',
  'msp',
  'cpl',
  'ocx',
  'so',
  'dylib',
]);

// eslint-disable-next-line no-control-regex -- control characters are refused in bundle paths
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Characters Windows refuses in file names (a bundle must land on every worker OS). */
const WINDOWS_INVALID = /[<>:"|?*]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Why `path` cannot be a file of a job input bundle, or null when it can: relative, `/`-separated, Unicode NFC, at
 * most {@link INPUT_BUNDLE_LIMITS.maxSegments} segments and {@link INPUT_BUNDLE_LIMITS.maxPathLength} characters, no
 * `.` / `..` / empty segments, no control characters, backslashes or characters Windows refuses, no segment ending in
 * a dot or a space, no Windows device names, no `.git` folder. Hidden files (`.gitignore`, `.env.example`) are allowed:
 * a source tree has them. Any file type passes this rule; {@link executableProblem} decides the content.
 */
export function inputBundlePathProblem(path: string): string | null {
  const L = INPUT_BUNDLE_LIMITS;
  if (path.length === 0) return 'empty path';
  if (path.length > L.maxPathLength) return 'path too long';
  if (path.normalize('NFC') !== path) return 'name is not in Unicode NFC form';
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return 'not a relative path';
  if (CONTROL.test(path)) return 'name has control characters';
  const segs = path.split('/');
  if (segs.length > L.maxSegments) return 'nested too deep';
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return 'unsafe path segment';
    if (s.length > L.maxSegmentLength) return 'name too long';
    if (WINDOWS_INVALID.test(s)) return 'name has characters that are not allowed';
    if (s.endsWith('.') || s.endsWith(' ')) return 'name ends with a dot or a space';
    const stem = s.includes('.') ? s.slice(0, s.indexOf('.')) : s;
    if (WINDOWS_RESERVED.test(stem)) return 'reserved device name';
    if (s === '.git') return 'git metadata folder';
  }
  return null;
}

/** The key two paths collide on (case-insensitive file systems: macOS, Windows). */
export function inputBundlePathKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/** The extension of a path (lower case, without the dot), or '' when it has none. */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

const starts = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);

/**
 * The kind of native executable the first bytes of a file are (ELF, PE, Mach-O / universal binary), or null. A PE is
 * recognised by `MZ` **and** its `PE\0\0` header (a text that happens to start with "MZ" is not refused); `head`
 * should hold at least the first 4 KiB.
 */
export function executableKind(head: Uint8Array): string | null {
  if (starts(head, [0x7f, 0x45, 0x4c, 0x46])) return 'ELF executable or library';
  if (
    starts(head, [0xfe, 0xed, 0xfa, 0xce]) ||
    starts(head, [0xfe, 0xed, 0xfa, 0xcf]) ||
    starts(head, [0xce, 0xfa, 0xed, 0xfe]) ||
    starts(head, [0xcf, 0xfa, 0xed, 0xfe])
  ) {
    return 'Mach-O executable or library';
  }
  if (starts(head, [0xca, 0xfe, 0xba, 0xbe])) return 'Mach-O universal binary or Java class';
  if (starts(head, [0x4d, 0x5a]) && head.length >= 0x40) {
    const off =
      (head[0x3c] ?? 0) | ((head[0x3d] ?? 0) << 8) | ((head[0x3e] ?? 0) << 16) | ((head[0x3f] ?? 0) << 24);
    if (off >= 0x40 && off + 4 <= head.length && starts(head, [0x50, 0x45, 0x00, 0x00], off)) {
      return 'Windows executable or library (PE)';
    }
  }
  return null;
}

/** Bytes of a file's start {@link executableKind} needs. */
export const EXECUTABLE_HEAD_BYTES = 4096;

/**
 * Why a file may not be part of a bundle because it is a native executable / library (by magic bytes or extension), or
 * null. `allowExecutables`: the owner's security policy `inputs.executables`.
 */
export function executableProblem(path: string, head: Uint8Array, allowExecutables: boolean): string | null {
  if (allowExecutables) return null;
  const kind = executableKind(head);
  if (kind !== null) return `${kind} (executables are not allowed as job inputs)`;
  if (EXECUTABLE_EXTENSIONS.has(extensionOf(path))) {
    return `.${extensionOf(path)} file (executables are not allowed as job inputs)`;
  }
  return null;
}

/** Why a bundle as a whole cannot be sent (after left-out files): no files, too many files, too large. */
export const INPUT_BUNDLE_PROBLEMS = ['unreadable', 'no_files', 'too_many_files', 'too_large'] as const;
export type InputBundleProblem = (typeof INPUT_BUNDLE_PROBLEMS)[number];

export function inputBundleProblems(
  files: readonly { readonly path: string; readonly size: number }[],
): InputBundleProblem[] {
  if (files.length === 0) return ['no_files'];
  const out: InputBundleProblem[] = [];
  if (files.length > INPUT_BUNDLE_LIMITS.maxFiles) out.push('too_many_files');
  if (files.reduce((n, f) => n + f.size, 0) > INPUT_BUNDLE_LIMITS.maxTotalBytes) out.push('too_large');
  return out;
}

/** A secret finding of one file (never the value). */
export interface InputBundleFinding {
  readonly path: string;
  readonly rule: string;
  readonly line: number;
}
