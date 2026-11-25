import { readFile } from 'node:fs/promises';

/** Parses `name=value` lines (blank lines and `#` comments ignored). Values are secrets: never logged. */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    const name = i > 0 ? t.slice(0, i).trim() : '';
    // The error names the problem, never the line (it may contain the secret).
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name))
      throw new Error('OTLP headers file: every line must be name=value');
    out[name] = t.slice(i + 1).trim();
  }
  return out;
}

/** Reads an OTLP headers file (e.g. a collector API key). */
export async function readHeadersFile(file: string): Promise<Record<string, string>> {
  return parseHeaders(await readFile(file, 'utf8'));
}
