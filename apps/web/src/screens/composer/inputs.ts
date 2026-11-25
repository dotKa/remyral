import {
  ALLOWED_EXTENSIONS,
  formatBytes,
  INPUT_NAME,
  MAX_INPUT_BYTES,
  MAX_INPUT_FILES,
  MAX_INPUT_TOTAL_BYTES,
} from '../../api/workspaces';

/**
 * Input files of a workspace job (docs/design/p5-research-workspace.md §2 Inputs): checked in the browser
 * against the same limits the master enforces (which stays authoritative, and also scans for secrets), then
 * read as base64 for `POST /v1/jobs` `inputs[]`.
 */

export interface InputFile {
  readonly name: string;
  readonly sizeBytes: number;
  readonly contentBase64: string;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/** Why one more file cannot be added to `current` (null = fine). */
export function inputFileError(
  file: { readonly name: string; readonly size: number },
  current: readonly { readonly name: string; readonly sizeBytes: number }[],
): string | null {
  if (!ALLOWED_EXTENSIONS.includes(extensionOf(file.name))) {
    return `${file.name}: this file type is not accepted (${ALLOWED_EXTENSIONS.join(' ')}).`;
  }
  if (!INPUT_NAME.test(file.name)) {
    return `${file.name}: rename the file — letters, digits, spaces and . _ ( ) + - only, at most 100 characters, starting with a letter or digit.`;
  }
  if (current.some((f) => f.name === file.name))
    return `${file.name}: a file with this name is already added.`;
  if (file.size > MAX_INPUT_BYTES) {
    return `${file.name}: ${formatBytes(file.size)} is larger than ${formatBytes(MAX_INPUT_BYTES)} per file.`;
  }
  if (current.length >= MAX_INPUT_FILES) return `${file.name}: at most ${String(MAX_INPUT_FILES)} files.`;
  const total = current.reduce((n, f) => n + f.sizeBytes, 0) + file.size;
  if (total > MAX_INPUT_TOTAL_BYTES) {
    return `${file.name}: all inputs together may be at most ${formatBytes(MAX_INPUT_TOTAL_BYTES)}.`;
  }
  return null;
}

/** Re-checks a whole list (draft validation). */
export function inputListError(files: readonly InputFile[]): string | null {
  if (files.length > MAX_INPUT_FILES) return `At most ${String(MAX_INPUT_FILES)} files.`;
  const total = files.reduce((n, f) => n + f.sizeBytes, 0);
  if (total > MAX_INPUT_TOTAL_BYTES)
    return `All inputs together may be at most ${formatBytes(MAX_INPUT_TOTAL_BYTES)}.`;
  return null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function readArrayBuffer(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      if (r.result instanceof ArrayBuffer) resolve(r.result);
      else reject(new Error('unexpected FileReader result'));
    };
    r.onerror = () => {
      reject(r.error ?? new Error('read failed'));
    };
    r.readAsArrayBuffer(file);
  });
}

export async function readInputFile(file: File): Promise<InputFile> {
  const bytes = new Uint8Array(await readArrayBuffer(file));
  return { name: file.name, sizeBytes: bytes.length, contentBase64: bytesToBase64(bytes) };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
