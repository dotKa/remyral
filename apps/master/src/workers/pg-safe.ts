/**
 * Makes worker-supplied values storable in Postgres. `text` rejects NUL bytes and `jsonb` rejects the
 * `\u0000` escape and lone surrogates ("unsupported Unicode escape sequence"); a single such character in
 * agent output (common in Windows console output) used to fail the inbox transaction, close the socket,
 * and loop forever as the worker re-sent the same message. Each NUL becomes U+FFFD and lone surrogates
 * are replaced, so the message is stored instead of poisoning the connection.
 */
// eslint-disable-next-line no-control-regex -- NUL is exactly what this module removes
const NEEDS_FIX = /[\u0000\uD800-\uDFFF]/;

function fixString(value: string): string {
  if (!NEEDS_FIX.test(value)) return value;
  return value.replaceAll('\u0000', '�').toWellFormed();
}

/** Returns `value` unchanged when nothing needs fixing (no copy), otherwise a fixed structural copy. */
export function pgSafe<T>(value: T): T {
  return fix(value) as T;
}

function fix(value: unknown): unknown {
  if (typeof value === 'string') return fixString(value);
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const next = fix(value[i]);
      if (next !== value[i]) {
        out ??= value.slice();
        out[i] = next;
      }
    }
    return out ?? value;
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries: [string, unknown][] = [];
    let changed = false;
    for (const [key, item] of Object.entries(value)) {
      const fixedKey = fixString(key);
      const next = fix(item);
      changed ||= next !== item || fixedKey !== key;
      entries.push([fixedKey, next]);
    }
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}
