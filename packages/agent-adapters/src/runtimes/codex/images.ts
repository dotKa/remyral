import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * p8-codex-images (docs/design/p8-orchestration.md §5): Codex saves a generated image under
 * `$CODEX_HOME/generated_images/<thread>/<call>.png` (observed with codex-cli 0.162.1; 0.164.0 keeps `savedPath`) — outside the workspace, so a
 * workspace job's `out/` collection never saw it. {@link saveGeneratedImage} copies a finished image into
 * `<workspace>/out/generated-images/` of a workspace job (`out/` exists). Never throws: the job never fails because
 * of a copy.
 */

/** Upper bound of one generated image copied into the workspace. */
export const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
/** Directory below `out/` that generated images are copied into. */
export const GENERATED_IMAGES_DIR = 'generated-images';

export interface GeneratedImageItem {
  readonly id: string;
  readonly status: string;
  /**
   * Base64 image bytes (Responses API `image_generation_call.result`). Absent since codex-cli 0.164.0 when the image
   * went to Codex's attachment store (the item names a `fileId` instead); `savedPath` is then the only local source.
   */
  readonly result?: string | undefined;
  readonly savedPath?: string | undefined;
}

export interface SavedImage {
  readonly ok: boolean;
  /** Workspace-relative path of the copy (`out/generated-images/<id>.png`), when copied. */
  readonly path?: string;
  /** Plain-language outcome for the job's events (no image bytes). */
  readonly text: string;
}

/** The image type from its magic bytes (PNG, JPEG, WebP), else null. */
export function imageExtension(b: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP')
    return 'webp';
  return null;
}

/** A file-name segment from the call id (`ig_123…` → itself; anything else reduced to safe characters). */
export function safeImageName(id: string): string {
  const s = id
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 80);
  return s === '' ? 'image' : s;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

/** Bytes from `savedPath` when it is a regular file inside the session's CODEX_HOME (realpath), else null. */
async function fromSavedPath(
  savedPath: string | undefined,
  codexHome: string | undefined,
): Promise<Buffer | null> {
  if (savedPath === undefined || codexHome === undefined || codexHome === '') return null;
  try {
    const home = await realpath(codexHome);
    const real = await realpath(savedPath);
    if (!inside(home, real)) return null;
    const st = await stat(real);
    if (!st.isFile() || st.size > MAX_GENERATED_IMAGE_BYTES) return null;
    return await readFile(real);
  } catch {
    return null;
  }
}

function fromBase64(result: string | undefined): Buffer | null {
  const t = (result ?? '').trim();
  // Base64 grows by 4/3; refuse anything that cannot decode to ≤ the limit before decoding it.
  if (t === '' || t.length > Math.ceil((MAX_GENERATED_IMAGE_BYTES * 4) / 3) + 4) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  return Buffer.from(t, 'base64');
}

/**
 * Copies one completed generated image into `<workspaceRoot>/out/generated-images/<id>.<ext>`. Only when `out/` is a
 * real directory (workspace jobs; repository worktrees get nothing written). Source: `savedPath` inside `codexHome`,
 * else the base64 result. The destination directory must not be a symlink; the file is created exclusively (never
 * overwritten, never through a link).
 */
export async function saveGeneratedImage(input: {
  readonly item: GeneratedImageItem;
  readonly workspaceRoot: string;
  readonly codexHome: string | undefined;
  /** A workspace job (`SpawnContext.workspaceJob`); repository jobs get nothing written. Default true. */
  readonly workspaceJob?: boolean;
}): Promise<SavedImage> {
  const { item } = input;
  const where = item.savedPath === undefined ? '' : ` (Codex saved it at ${item.savedPath})`;
  if (item.status !== 'completed') return { ok: false, text: `image generation ${item.status}` };
  if (input.workspaceJob === false) {
    return {
      ok: true,
      text: `image generated${where}; not copied: a repository job keeps its worktree unchanged`,
    };
  }
  const outDir = join(input.workspaceRoot, 'out');
  const outStat = await lstat(outDir).catch(() => null);
  if (outStat === null || !outStat.isDirectory()) {
    return { ok: true, text: `image generated${where}; not copied: this job has no out/ directory` };
  }
  const bytes = (await fromSavedPath(item.savedPath, input.codexHome)) ?? fromBase64(item.result);
  if (bytes === null || bytes.length === 0) {
    return { ok: false, text: `image generated${where}; not copied: no readable image data` };
  }
  if (bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    return { ok: false, text: `image generated${where}; not copied: larger than 20 MiB` };
  }
  const ext = imageExtension(bytes);
  if (ext === null)
    return { ok: false, text: `image generated${where}; not copied: not a PNG, JPEG or WebP image` };
  const dir = join(outDir, GENERATED_IMAGES_DIR);
  try {
    await mkdir(dir, { mode: 0o700 }).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    });
    const d = await lstat(dir);
    if (!d.isDirectory() || d.isSymbolicLink()) {
      return {
        ok: false,
        text: `image generated${where}; not copied: out/${GENERATED_IMAGES_DIR} is not a directory`,
      };
    }
    const base = safeImageName(item.id);
    for (let i = 1; i <= 50; i++) {
      const name = i === 1 ? `${base}.${ext}` : `${base}-${String(i)}.${ext}`;
      try {
        const fh = await open(
          join(dir, name),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        try {
          await fh.writeFile(bytes);
        } finally {
          await fh.close();
        }
        const path = `out/${GENERATED_IMAGES_DIR}/${name}`;
        return { ok: true, path, text: `image saved to ${path}` };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    return { ok: false, text: `image generated${where}; not copied: too many files with that name` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error';
    return { ok: false, text: `image generated${where}; not copied (${code})` };
  }
}
