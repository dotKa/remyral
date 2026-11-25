import { isRepoPath } from '../gitflow/types.js';

/**
 * p19-ide W1 (docs/design/p19-ide.md §6): a `code` chat reference — lines of a file the sender selected in the code
 * viewer or a diff. It travels as an ordinary mention ref (`type: 'code'`, `project`, `id`) so the message keeps it
 * like every other mention (edit, resend, history); the id carries where the lines are:
 *
 *   `repo:<commit sha>:<start>-<end>:<path>`     a repository file at a pinned commit
 *   `workfiles:<job id>:<start>-<end>:<path>`    a kept working file of a workspace job
 *   `ide:<workspace id>:<start>-<end>:<path>`    a file of a Tam IDE workspace (p19-ide W2; read from the machine at
 *                                               send time, the owner's own workspaces only)
 *
 * The browser never sends the text: the master re-reads the range at send time with the sender's current rights.
 */
export type CodeRefSource = 'repo' | 'workfiles' | 'ide';

export interface CodeRef {
  readonly source: CodeRefSource;
  /** Commit sha (repo), job id (workfiles) or IDE workspace id (ide). */
  readonly ref: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly path: string;
}

/** Lines one reference carries at most, and its bytes (within the turn's 96 KiB context). */
export const MAX_REFERENCE_LINES = 400;
export const MAX_REFERENCE_BYTES = 24 * 1024;
/** The highest line number a reference may name. */
const MAX_LINE = 1_000_000;

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^(repo|workfiles|ide):([0-9a-f-]{36,40}):(\d{1,7})-(\d{1,7}):(.+)$/s;

/** The id of a reference (inverse of {@link parseCodeRef}). */
export function codeRefId(r: CodeRef): string {
  return `${r.source}:${r.ref}:${String(r.startLine)}-${String(r.endLine)}:${r.path}`;
}

/** A well-formed reference id, or null (unknown source, bad sha / job id, bad range or path). */
export function parseCodeRef(id: string): CodeRef | null {
  if (id.length > 320) return null;
  const m = ID.exec(id);
  if (m === null) return null;
  const source = m[1] as CodeRefSource;
  const ref = m[2] ?? '';
  if (source === 'repo' ? !SHA.test(ref) : !UUID.test(ref)) return null;
  const startLine = Number(m[3]);
  const endLine = Number(m[4]);
  const path = m[5] ?? '';
  if (startLine < 1 || endLine < startLine || endLine > MAX_LINE || !isRepoPath(path)) return null;
  return { source, ref, startLine, endLine, path };
}

/** Chip label: `src/app.ts:40-58 · a1b2c3d` (the file name only when the path is long). */
export function codeRefLabel(r: CodeRef): string {
  const name = r.path.length > 60 ? `…/${r.path.split('/').pop() ?? r.path}` : r.path;
  const lines =
    r.startLine === r.endLine ? String(r.startLine) : `${String(r.startLine)}-${String(r.endLine)}`;
  return `${name}:${lines}${r.source === 'repo' ? ` · ${r.ref.slice(0, 7)}` : r.source === 'ide' ? ' · IDE' : ''}`;
}

/**
 * Lines `start..end` of `text` (1-based, inclusive), cut to {@link MAX_REFERENCE_LINES} lines and
 * {@link MAX_REFERENCE_BYTES} bytes. `endLine` is the last line actually included.
 */
export function sliceLines(
  text: string,
  start: number,
  end: number,
): { text: string; endLine: number; truncated: boolean; totalLines: number } {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const totalLines = lines.length;
  const last = Math.min(end, totalLines, start + MAX_REFERENCE_LINES - 1);
  let truncated = last < end;
  const out: string[] = [];
  let bytes = 0;
  for (let i = start; i <= last; i++) {
    const line = lines[i - 1] ?? '';
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > MAX_REFERENCE_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    out.push(line);
  }
  return { text: out.join('\n'), endLine: start + out.length - 1, truncated, totalLines };
}

/** A language tag for a path (the fence and the viewer's highlighting), or null. */
export function languageOf(path: string): string | null {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return LANG[ext] ?? null;
}

const LANG: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  svg: 'xml',
  ini: 'ini',
};
