/**
 * Metadata redaction for audit events. Audit metadata is meant for identifiers and reasons, never for
 * credentials; this is the safety net that keeps a careless caller from persisting one (T-SEC-1).
 * Over-redaction is acceptable, under-redaction is not.
 */
export const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|token|totp|otp|cookie|^authorization$|session_?id|csrf|^code$|recovery_?codes?|api_?key|private_?key|credential|^pem$/i;

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 5;
const MAX_STRING = 1000;
const MAX_ARRAY = 50;
const MAX_KEYS = 50;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function sanitizeString(s: string): string {
  // jsonb cannot store NUL; also cap length.
  const cleaned = s.replaceAll('\u0000', '');
  return cleaned.length > MAX_STRING ? `${cleaned.slice(0, MAX_STRING)}…` : cleaned;
}

function redactValue(value: unknown, depth: number): JsonValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return sanitizeString(value);
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'object': {
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
      if (depth >= MAX_DEPTH) return '[TRUNCATED]';
      if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY).map((v) => redactValue(v, depth + 1) ?? null);
      }
      return redactObject(value as Record<string, unknown>, depth + 1);
    }
    default:
      return undefined; // functions, symbols, undefined are dropped
  }
}

function redactObject(obj: Record<string, unknown>, depth: number): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(obj).slice(0, MAX_KEYS)) {
    const safeKey = sanitizeString(key);
    if (SENSITIVE_KEY.test(key)) {
      out[safeKey] = REDACTED;
      continue;
    }
    const v = redactValue(obj[key], depth);
    if (v !== undefined) out[safeKey] = v;
  }
  return out;
}

/** Returns a JSON-safe, size-bounded copy of `metadata` with sensitive keys replaced by `[REDACTED]`. */
export function redactMetadata(metadata: Readonly<Record<string, unknown>> | undefined): {
  [key: string]: JsonValue;
} {
  if (!metadata) return {};
  return redactObject(metadata, 0);
}
