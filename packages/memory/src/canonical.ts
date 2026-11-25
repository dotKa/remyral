import { createHash } from 'node:crypto';

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order, no whitespace, `undefined` members
 * omitted, only finite numbers. The same value always serialises to the same bytes, independent of key
 * insertion order, process or platform — the basis of the bundle hash.
 */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${(value as readonly CanonicalValue[]).map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as { readonly [key: string]: CanonicalValue | undefined };
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k] as CanonicalValue)}`).join(',')}}`;
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** `sha256:<hex>` of the UTF-8 bytes of `content`. */
export function contentHash(content: string): string {
  return `sha256:${sha256Hex(content)}`;
}

export const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;
