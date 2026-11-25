import { scanText } from '@remyral/observability';
import {
  EXECUTABLE_EXTENSIONS,
  EXECUTABLE_HEAD_BYTES,
  executableProblem,
  extensionOf,
  INPUT_BUNDLE_LIMITS,
  type InputBundleFinding,
  inputBundlePathKey,
  inputBundlePathProblem,
} from '@remyral/protocol/input-bundle-files';

/**
 * p16-zip-job-input (ADR-0060): the pure checks of a job input bundle — the declared file list (before any byte is
 * sent) and each file's content once assembled (size, SHA-256, native executables by magic bytes, secret scan of text
 * files). A refusal names the file and the reason; a secret finding names the file, the rule and the line, never the
 * matched value. Unlike a site upload, a secret finding is not a refusal by itself: the uploader may send the bundle
 * anyway (an explicit, audited override).
 */

export interface DeclaredFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface Refusal {
  readonly path: string;
  readonly reason: string;
}

const SHA = /^[0-9a-f]{64}$/;
/** Findings kept per bundle (the rest is counted). */
export const MAX_FINDINGS = 200;

/**
 * Checks the declared files: count, safe relative paths, no two paths that collide on a case-insensitive file system,
 * per-file and total size, SHA-256 syntax and — unless the security policy allows them — no executable extension.
 */
export function checkManifest(
  files: readonly DeclaredFile[],
  allowExecutables: boolean,
): { ok: true; manifest: DeclaredFile[]; totalBytes: number } | { ok: false; refused: Refusal[] } {
  const L = INPUT_BUNDLE_LIMITS;
  if (files.length === 0) return { ok: false, refused: [{ path: '', reason: 'no files' }] };
  if (files.length > L.maxFiles) {
    return {
      ok: false,
      refused: [{ path: '', reason: `more than ${String(L.maxFiles)} files (${String(files.length)})` }],
    };
  }
  const refused: Refusal[] = [];
  const seen = new Set<string>();
  const manifest: DeclaredFile[] = [];
  let total = 0;
  for (const f of files) {
    const problem = inputBundlePathProblem(f.path);
    if (problem !== null) {
      refused.push({ path: f.path.slice(0, 300), reason: problem });
      continue;
    }
    const key = inputBundlePathKey(f.path);
    if (seen.has(key)) {
      refused.push({ path: f.path, reason: 'listed twice (names differ only in upper / lower case)' });
      continue;
    }
    seen.add(key);
    if (!Number.isSafeInteger(f.size) || f.size < 0) {
      refused.push({ path: f.path, reason: 'invalid size' });
      continue;
    }
    if (f.size > L.maxFileBytes) {
      refused.push({ path: f.path, reason: `larger than ${String(L.maxFileBytes / 1024 / 1024)} MiB` });
      continue;
    }
    if (!SHA.test(f.sha256)) {
      refused.push({ path: f.path, reason: 'invalid SHA-256' });
      continue;
    }
    if (!allowExecutables && EXECUTABLE_EXTENSIONS.has(extensionOf(f.path))) {
      refused.push({
        path: f.path,
        reason: `.${extensionOf(f.path)} file (executables are not allowed as job inputs)`,
      });
      continue;
    }
    total += f.size;
    manifest.push({ path: f.path, size: f.size, sha256: f.sha256 });
  }
  if (refused.length > 0) return { ok: false, refused };
  if (total > L.maxTotalBytes) {
    return {
      ok: false,
      refused: [
        {
          path: '',
          reason: `the files are ${String(total)} bytes together; at most ${String(L.maxTotalBytes / 1024 / 1024)} MiB`,
        },
      ],
    };
  }
  if (total === 0) return { ok: false, refused: [{ path: '', reason: 'every file is empty' }] };
  return { ok: true, manifest, totalBytes: total };
}

/** Whether a file's bytes are text (no NUL byte): only text files are secret-scanned (ADR-0060 §3). */
export function isText(content: Buffer): boolean {
  return !content.includes(0);
}

/**
 * Checks one file's assembled content against its declared entry: size, SHA-256 (`sha256` is the master's own hash of
 * the bytes) and native executables by magic bytes (unless allowed) are refusals; secrets in a text file are findings
 * (rule + line). Binary files (images, PDF, office documents, archives) are not scanned: their text is compressed or
 * encoded and a scan would only produce noise (residual risk, ADR-0060).
 */
export function checkContent(
  f: DeclaredFile,
  content: Buffer,
  sha256: string,
  allowExecutables: boolean,
): { refused: Refusal[]; findings: InputBundleFinding[] } {
  if (content.length !== f.size) {
    return { refused: [{ path: f.path, reason: 'size differs from the declared size' }], findings: [] };
  }
  if (sha256 !== f.sha256) {
    return { refused: [{ path: f.path, reason: 'content does not match its SHA-256' }], findings: [] };
  }
  const exe = executableProblem(f.path, content.subarray(0, EXECUTABLE_HEAD_BYTES), allowExecutables);
  if (exe !== null) return { refused: [{ path: f.path, reason: exe }], findings: [] };
  if (!isText(content)) return { refused: [], findings: [] };
  // Pattern rules (keys, tokens, private keys, credential assignments); no high-entropy heuristic: lock files and
  // minified code are full of hashes the owner has no reason to hide.
  const findings = scanText(content.toString('utf8'), { highEntropy: false }).map((s) => ({
    path: f.path,
    rule: s.rule,
    line: s.line,
  }));
  return { refused: [], findings };
}

/** "a.txt (reason); b.js line 3 (rule)" — for messages and the audit log (no values). */
export function describeRefusals(refused: readonly Refusal[], max = 10): string {
  const head = refused.slice(0, max).map((r) => `${r.path === '' ? '' : `${r.path}: `}${r.reason}`);
  return `${head.join('; ')}${refused.length > max ? `; and ${String(refused.length - max)} more` : ''}`;
}

export function describeFindings(findings: readonly InputBundleFinding[], max = 10): string {
  const head = findings.slice(0, max).map((x) => `${x.path} line ${String(x.line)} (${x.rule})`);
  return `${head.join('; ')}${findings.length > max ? `; and ${String(findings.length - max)} more` : ''}`;
}
