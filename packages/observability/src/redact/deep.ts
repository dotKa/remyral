import { marker, type Redactor } from './redactor.js';

/** Key names whose string values are always replaced, whatever they look like. */
export const SENSITIVE_KEY =
  /(?:password|passwd|passphrase|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|authorization|cookie|credential|session[-_]?key)$/i;

export interface SerializeOptions {
  /** Max characters per string after redaction; longer strings are truncated. Default 8192. */
  maxStringLength?: number;
  /** Max nesting depth. Default 8. */
  maxDepth?: number;
  /** Max array items / object keys kept. Default 100. */
  maxEntries?: number;
  /** `redacted` (default) keeps redacted stacks, `omit` drops them. Stacks are never emitted raw. */
  stacks?: 'redacted' | 'omit';
}

/**
 * Converts an arbitrary value into a JSON-safe value with every string (keys
 * included) passed through the redactor. Errors become `{type, message, code,
 * stack?, cause?}` with redacted message and stack; binary data is summarised,
 * never dumped; cycles, depth and size are bounded.
 */
export function redactDeep(value: unknown, redactor: Redactor, options: SerializeOptions = {}): unknown {
  const ctx: Ctx = {
    redactor,
    maxString: options.maxStringLength ?? 8192,
    maxDepth: options.maxDepth ?? 8,
    maxEntries: options.maxEntries ?? 100,
    stacks: options.stacks ?? 'redacted',
    seen: new WeakSet(),
  };
  return walk(value, ctx, 0);
}

interface Ctx {
  redactor: Redactor;
  maxString: number;
  maxDepth: number;
  maxEntries: number;
  stacks: 'redacted' | 'omit';
  seen: WeakSet<object>;
}

function str(text: string, ctx: Ctx): string {
  const redacted = ctx.redactor.redact(text);
  if (redacted.length <= ctx.maxString) return redacted;
  return `${redacted.slice(0, ctx.maxString)}…[truncated ${String(redacted.length - ctx.maxString)} chars]`;
}

function walk(value: unknown, ctx: Ctx, depth: number): unknown {
  switch (typeof value) {
    case 'string':
      return str(value, ctx);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
      return undefined;
    case 'symbol':
      return str(value.toString(), ctx);
    case 'function':
      return '[Function]';
    case 'object':
      break;
  }
  if (value === null) return null;
  if (ctx.seen.has(value)) return '[Circular]';
  if (depth >= ctx.maxDepth) return '[MaxDepth]';
  if (value instanceof Error) return serializeError(value, ctx, depth);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[binary ${String(value.byteLength)} bytes]`;
  }
  ctx.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, ctx.maxEntries).map((v: unknown) => walk(v, ctx, depth + 1) ?? null);
      if (value.length > ctx.maxEntries) items.push(`…[${String(value.length - ctx.maxEntries)} more]`);
      return items;
    }
    if (value instanceof Map) return walk(Object.fromEntries(value), ctx, depth);
    if (value instanceof Set) return walk([...value], ctx, depth);
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      // e.g. SecretValue (returns "[REDACTED]"), URL, Buffer-likes.
      return walk((toJSON as () => unknown).call(value), ctx, depth + 1);
    }
    return walkObject(value as Record<string, unknown>, ctx, depth);
  } finally {
    ctx.seen.delete(value);
  }
}

function walkObject(obj: Record<string, unknown>, ctx: Ctx, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  for (const key of keys.slice(0, ctx.maxEntries)) {
    const raw = obj[key];
    const safeKey = str(key, ctx);
    if (typeof raw === 'string' && SENSITIVE_KEY.test(key) && raw.length > 0) {
      out[safeKey] = marker('key');
      continue;
    }
    const v = walk(raw, ctx, depth + 1);
    if (v !== undefined) out[safeKey] = v;
  }
  if (keys.length > ctx.maxEntries) out['…'] = `${String(keys.length - ctx.maxEntries)} more keys`;
  return out;
}

function serializeError(error: Error, ctx: Ctx, depth: number): Record<string, unknown> {
  ctx.seen.add(error);
  try {
    const out: Record<string, unknown> = { type: str(error.name, ctx), message: str(error.message, ctx) };
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') out['code'] = walk(code, ctx, depth + 1);
    if (ctx.stacks === 'redacted' && typeof error.stack === 'string') out['stack'] = str(error.stack, ctx);
    if (error.cause !== undefined) out['cause'] = walk(error.cause, ctx, depth + 1);
    if (error instanceof AggregateError) {
      out['errors'] = walk(error.errors, ctx, depth + 1);
    }
    return out;
  } finally {
    ctx.seen.delete(error);
  }
}
