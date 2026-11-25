/** Version extraction and comparison helpers (no dependency on a semver library). */

const VERSION_RE = /(\d+)\.(\d+)(?:\.(\d+))?((?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/;

/**
 * Extracts the first dotted version from tool output, e.g.
 * `2.1.296 (Claude Code)` → `2.1.296`, `codex-cli 0.162.1` → `0.162.1`,
 * `v24.19.0` → `24.19.0`, `Python 3.12.13` → `3.12.13`.
 */
export function extractVersion(output: string): string | null {
  const match = VERSION_RE.exec(output);
  if (!match) return null;
  const [, major, minor, patch, suffix] = match;
  return `${major ?? '0'}.${minor ?? '0'}${patch !== undefined ? `.${patch}` : ''}${suffix ?? ''}`.slice(
    0,
    64,
  );
}

/** Numeric [major, minor, patch]; missing parts are 0. */
export function versionTuple(version: string): [number, number, number] | null {
  const match = VERSION_RE.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
}

/** true if `version` ≥ `minimum` (numeric major/minor/patch; prerelease suffix ignored). */
export function versionAtLeast(version: string, minimum: string): boolean {
  const a = versionTuple(version);
  const b = versionTuple(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** First non-empty line, trimmed and bounded — used when no version could be parsed. */
export function firstLine(output: string, max = 64): string {
  const line = output.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return line.trim().slice(0, max);
}

/** Some Windows tools (wsl.exe) write UTF-16LE; once decoded as UTF-8 the text is NUL-interleaved. */
export function stripNuls(text: string): string {
  return text.replaceAll('\u0000', '');
}
