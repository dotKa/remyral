/**
 * The workflow expression sandbox (p14-workflow-engine §4, ADR-0055): everything that evaluates user expressions or
 * computes a master-pure node's value runs here, inside a `node:worker_threads` thread of the pool (pool.ts) that the
 * main thread terminates after a hard deadline. The main thread imports only the pure helpers (compile / scan).
 *
 * This module is deliberately self-contained (only `jsonata`, `yaml` and `node:` imports, erasable TypeScript only):
 * the pool starts it directly as a worker entry — the compiled `.js` in production, the `.ts` source (Node's type
 * stripping) under the test runner.
 *
 * Language: JSONata 2.2.2 (pinned exactly). Determinism: `$now()` / `$millis()` are bound to the node run's scheduled
 * time; `$eval`, `$random`, `$clone` and `$shuffle` are refused statically (AST scan, `expr_function_not_allowed`) and
 * bound to throwing stubs as a second line. Regular expression literals are bounded (≤ 200 characters, no nested
 * quantifiers); a catastrophic one that slips through is stopped by the pool's deadline, never by trusting JSONata's
 * own guardrails (they run between evaluation steps). Errors carry a code and a position only, never data.
 */
import { createHash } from 'node:crypto';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import jsonata from 'jsonata';
import { parse as parseYaml } from 'yaml';

// ===================================================================================================== limits

export const EXPR_LIMITS = {
  /** One expression (a `$expr` value or the inside of one `{{ }}`). */
  maxExpressionChars: 4096,
  /** A template string (several `{{ }}`). */
  maxTemplateChars: 16 * 1024,
  maxRegexChars: 200,
  /**
   * JSONata's own guardrails per evaluate call (the pool's hard deadline is the real bound). 50 ms failed simple
   * expressions on a busy 2-vCPU host at the top of the hour (scheduled runs all start then); 800 ms stays under the pool's 1 s deadline.
   */
  evaluateTimeoutMs: 800,
  stackDepth: 200,
  maxSequence: 1_000_000,
  /** Serialised context sent into the sandbox. */
  maxInputBytes: 1024 * 1024,
  /** Serialised result. */
  maxOutputBytes: 256 * 1024,
  forEachMaxItems: 1000,
  maxListItems: 10_000,
  maxParseBytes: 1024 * 1024,
  maxCsvRows: 10_000,
} as const;

/** Functions that are refused (non-deterministic or escape hatches). */
export const REFUSED_FUNCTIONS: readonly string[] = ['eval', 'random', 'clone', 'shuffle'];

/** Custom functions added to JSONata (deterministic, bounded). */
export const CUSTOM_FUNCTIONS: readonly { name: string; signature: string; description: string }[] = [
  { name: 'uuid5', signature: '<ss:s>', description: 'Deterministic UUID v5 of a name in a namespace UUID' },
  { name: 'hash', signature: '<s:s>', description: 'SHA-256 of a string (hex)' },
  { name: 'urlEncode', signature: '<s:s>', description: 'Percent-encodes a URL component' },
  { name: 'base64', signature: '<s:s>', description: 'UTF-8 string → base64' },
  { name: 'jsonParse', signature: '<s:x>', description: 'Parses a JSON text (≤ 1 MiB)' },
];

// ===================================================================================================== types

/** What an expression sees (§2.4). Every value is plain JSON. */
export interface ExprContext {
  /** ISO instant: the node run's scheduled time ($now / $millis). */
  readonly now: string;
  readonly input?: unknown;
  readonly node?: Readonly<Record<string, unknown>>;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly trigger?: unknown;
  readonly item?: unknown;
  readonly index?: number;
  readonly items?: unknown;
  readonly run?: unknown;
  readonly loop?: unknown;
}

export type FieldMode = 'static' | 'expr';

export type SandboxRequest =
  | {
      readonly op: 'eval';
      readonly source: string;
      readonly mode: 'expr' | 'template';
      readonly context: ExprContext;
    }
  | {
      readonly op: 'node';
      readonly type: string;
      readonly config: Readonly<Record<string, unknown>>;
      readonly fields: Readonly<Record<string, FieldMode>>;
      readonly context: ExprContext;
    }
  /** Test hooks (only honoured when the pool was created with `testHooks`). */
  | { readonly op: 'spin'; readonly ms: number }
  | { readonly op: 'allocate'; readonly mb: number };

export type SandboxResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly position: number | null };

/** What a master-pure node computed: values on ports, and the config with every expression field resolved. */
export interface NodeComputation {
  readonly config: Record<string, unknown>;
  readonly ports?: Record<string, unknown>;
  /** control.loop: whether another iteration runs. */
  readonly continue?: boolean;
}

export class ExprError extends Error {
  readonly code: string;
  readonly position: number | null;
  constructor(code: string, position: number | null = null) {
    super(code);
    this.code = code;
    this.position = position;
  }
}

// ===================================================================================================== static scan

/** A nested quantifier — `(…+)+`, `(…*)*`, `(…{n,})+` … — the classic catastrophic-backtracking shape. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/;
/** A quantified group of alternatives that overlap trivially (`(a|a)*`, `(a|ab)+`) is caught by the deadline only. */

export function regexAllowed(source: string): boolean {
  if (source.length > EXPR_LIMITS.maxRegexChars) return false;
  if (NESTED_QUANTIFIER.test(source)) return false;
  // Back-references can be exponential as well.
  if (/\\[1-9]/.test(source)) return false;
  return true;
}

/** A RegExp constructor that applies the same bounds at run time (defence in depth). */
function BoundedRegExp(pattern: string | RegExp, flags?: string): RegExp {
  const source = typeof pattern === 'string' ? pattern : pattern.source;
  if (!regexAllowed(source)) throw new ExprError('expr_regex_not_allowed');
  return new RegExp(pattern, flags);
}

function errorOf(err: unknown, fallback = 'expr_error'): ExprError {
  if (err instanceof ExprError) return err;
  const e = err as { code?: unknown; position?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : null;
  const position = typeof e?.position === 'number' ? e.position : null;
  if (code === null) return new ExprError(fallback, position);
  if (code.startsWith('expr_')) return new ExprError(code, position);
  if (code === 'D1012') return new ExprError('expr_timeout', position);
  if (code === 'D1011' || code === 'D2015' || code === 'D2014')
    return new ExprError('expr_resource_limit', position);
  if (code.startsWith('S0')) return new ExprError('expr_syntax', position);
  return new ExprError(`expr_error:${code.replace(/[^A-Z0-9]/g, '').slice(0, 8)}`, position);
}

type Ast = Record<string, unknown>;

function walkAst(node: unknown, visit: (n: Ast) => void, seen = new Set<unknown>(), depth = 0): void {
  if (node === null || typeof node !== 'object' || seen.has(node) || depth > 400) return;
  seen.add(node);
  if (node instanceof RegExp) return;
  if (Array.isArray(node)) {
    for (const x of node) walkAst(x, visit, seen, depth + 1);
    return;
  }
  const n = node as Ast;
  if (typeof n.type === 'string') visit(n);
  for (const v of Object.values(n)) walkAst(v, visit, seen, depth + 1);
}

/**
 * Compiles one expression and scans its AST: refused functions (also as values, `$f := $eval`), bounded regex
 * literals. Throws {@link ExprError}.
 */
export function compileChecked(source: string): ReturnType<typeof jsonata> {
  if (source.length > EXPR_LIMITS.maxExpressionChars) throw new ExprError('expr_too_long');
  if (source.trim() === '') throw new ExprError('expr_syntax', 0);
  let compiled: ReturnType<typeof jsonata>;
  try {
    compiled = jsonata(source, {
      timeout: EXPR_LIMITS.evaluateTimeoutMs,
      stack: EXPR_LIMITS.stackDepth,
      sequence: EXPR_LIMITS.maxSequence,
      RegexEngine: BoundedRegExp as unknown as RegExpConstructor,
    });
  } catch (err) {
    throw errorOf(err, 'expr_syntax');
  }
  walkAst(compiled.ast(), (n) => {
    const pos = typeof n.position === 'number' ? n.position : null;
    if (n.type === 'variable' && typeof n.value === 'string' && REFUSED_FUNCTIONS.includes(n.value))
      throw new ExprError('expr_function_not_allowed', pos);
    if (n.type === 'regex' || n.type === 'regexp') {
      const v: unknown = n.value;
      const src = v instanceof RegExp ? v.source : typeof v === 'string' ? v : '';
      if (!regexAllowed(src)) throw new ExprError('expr_regex_not_allowed', pos);
    }
  });
  return compiled;
}

/** The parts of a template string: literal text and `{{ expression }}` sources. */
export function templateParts(text: string): { literal: string; expr: string | null }[] {
  const parts: { literal: string; expr: string | null }[] = [];
  // Same split as `/\{\{([\s\S]*?)\}\}/g`, by index search: the lazy regex rescans to the end from every unclosed `{{`.
  let last = 0;
  for (;;) {
    const at = text.indexOf('{{', last);
    if (at < 0) break;
    const end = text.indexOf('}}', at + 2);
    if (end < 0) break; // no `}}` after this `{{`, so none after any later one either
    parts.push({ literal: text.slice(last, at), expr: text.slice(at + 2, end).trim() });
    last = end + 2;
  }
  parts.push({ literal: text.slice(last), expr: null });
  return parts;
}

/** Whether `s` holds a `{{ … }}` template (a `{{` with a `}}` after it). */
export const isTemplate = (s: string): boolean => {
  const at = s.indexOf('{{');
  return at >= 0 && s.indexOf('}}', at + 2) >= 0;
};

/** Static check of a template or `$expr` source (validation at save, without evaluating). Returns null when fine. */
export function checkSource(source: string, mode: 'expr' | 'template'): ExprError | null {
  try {
    if (mode === 'expr') compileChecked(source);
    else {
      if (source.length > EXPR_LIMITS.maxTemplateChars) return new ExprError('expr_too_long');
      for (const p of templateParts(source)) if (p.expr !== null) compileChecked(p.expr);
    }
    return null;
  } catch (err) {
    return errorOf(err, 'expr_syntax');
  }
}

/**
 * Every expression inside a config value (templates in strings, `{ $expr }` objects) with its path below the field —
 * the validator checks each one.
 */
export function expressionsIn(
  value: unknown,
  path: (string | number)[] = [],
  out: { path: (string | number)[]; source: string; mode: 'expr' | 'template' }[] = [],
  depth = 0,
): { path: (string | number)[]; source: string; mode: 'expr' | 'template' }[] {
  if (depth > 12 || out.length > 500) return out;
  if (typeof value === 'string') {
    if (isTemplate(value)) out.push({ path, source: value, mode: 'template' });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => expressionsIn(v, [...path, i], out, depth + 1));
  } else if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.$expr === 'string' && Object.keys(o).length === 1)
      out.push({ path, source: o.$expr, mode: 'expr' });
    else for (const [k, v] of Object.entries(o)) expressionsIn(v, [...path, k], out, depth + 1);
  }
  return out;
}

// ===================================================================================================== evaluation

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid5(ns: string, name: string): string {
  if (!UUID_RE.test(ns)) throw new ExprError('expr_error:uuid5');
  const nsBytes = Buffer.from(ns.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(nsBytes).update(name, 'utf8').digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

const refused = (): never => {
  throw new ExprError('expr_function_not_allowed');
};

/** JSONata `$fromMillis` used to render `$now(picture, tz)` from the fixed instant. */
const fromMillis = jsonata('$fromMillis($ms, $p, $tz)');

export function bindingsFor(ctx: ExprContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const ms = Date.parse(ctx.now);
  const fixed = Number.isFinite(ms) ? ms : 0;
  return {
    input: ctx.input,
    node: ctx.node ?? {},
    inputs: ctx.inputs ?? {},
    trigger: ctx.trigger,
    item: ctx.item,
    index: ctx.index,
    items: ctx.items,
    run: ctx.run ?? {},
    loop: ctx.loop,
    // Determinism: the node run's scheduled time, never the wall clock.
    now: (picture?: string, tz?: string) =>
      picture === undefined && tz === undefined
        ? new Date(fixed).toISOString()
        : fromMillis.evaluate({}, { ms: fixed, p: picture, tz }),
    millis: () => fixed,
    // Second line behind the static scan.
    eval: refused,
    random: refused,
    clone: refused,
    shuffle: refused,
    uuid5,
    hash: (s: unknown) => createHash('sha256').update(String(s), 'utf8').digest('hex'),
    urlEncode: (s: unknown) => encodeURIComponent(String(s)),
    base64: (s: unknown) => Buffer.from(String(s), 'utf8').toString('base64'),
    jsonParse: (s: unknown) => {
      const text = String(s);
      if (Buffer.byteLength(text, 'utf8') > EXPR_LIMITS.maxParseBytes)
        throw new ExprError('expr_input_too_large');
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ExprError('expr_error:jsonParse');
      }
    },
    ...extra,
  };
}

/** A JSON-clean copy (JSONata sequences, lambdas and `undefined` members removed). */
export function toJson(v: unknown): unknown {
  if (v === undefined) return undefined;
  const s = JSON.stringify(v, (_k, x: unknown) => (typeof x === 'function' ? undefined : x)) as
    string | undefined;
  return s === undefined ? undefined : (JSON.parse(s) as unknown);
}

async function evalCompiled(
  compiled: ReturnType<typeof jsonata>,
  root: unknown,
  bindings: Record<string, unknown>,
): Promise<unknown> {
  try {
    return toJson((await compiled.evaluate(root, bindings)) as unknown);
  } catch (err) {
    throw errorOf(err);
  }
}

/** Evaluates one `$expr` source. */
export async function evaluateExpr(
  source: string,
  ctx: ExprContext,
  root: unknown = ctx.input,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  return evalCompiled(compileChecked(source), root, bindingsFor(ctx, extra));
}

const textOf = (v: unknown): string =>
  v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);

/**
 * Evaluates a template string: exactly one `{{ expr }}` and nothing else ⇒ the raw value (a boolean condition stays a
 * boolean); otherwise text with each value inserted (strings as they are, other values as JSON).
 */
export async function evaluateTemplate(
  text: string,
  ctx: ExprContext,
  root: unknown = ctx.input,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  if (text.length > EXPR_LIMITS.maxTemplateChars) throw new ExprError('expr_too_long');
  const parts = templateParts(text);
  const exprs = parts.filter((p) => p.expr !== null);
  if (exprs.length === 1 && parts.every((p) => p.literal.trim() === '')) {
    return evaluateExpr(exprs[0]?.expr ?? '', ctx, root, extra);
  }
  let out = '';
  for (const p of parts) {
    out += p.literal;
    if (p.expr !== null) out += textOf(await evaluateExpr(p.expr, ctx, root, extra));
    if (out.length > EXPR_LIMITS.maxOutputBytes) throw new ExprError('expr_output_too_large');
  }
  return out;
}

/** Resolves every expression inside a value (templates, `$expr` objects); literals stay as they are. */
export async function resolveValue(
  value: unknown,
  ctx: ExprContext,
  root: unknown = ctx.input,
  extra: Record<string, unknown> = {},
  depth = 0,
): Promise<unknown> {
  if (depth > 12) return value;
  if (typeof value === 'string') return isTemplate(value) ? evaluateTemplate(value, ctx, root, extra) : value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await resolveValue(v, ctx, root, extra, depth + 1));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.$expr === 'string' && Object.keys(o).length === 1)
      return evaluateExpr(o.$expr, ctx, root, extra);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = await resolveValue(v, ctx, root, extra, depth + 1);
    return out;
  }
  return value;
}

/** An expression-capable value prepared for per-item evaluation (compiled once). */
function perItem(value: unknown): (ctx: ExprContext, item: unknown, index: number) => Promise<unknown> {
  return (ctx, item, index) => resolveValue(value, { ...ctx, item, index }, item, { item, index });
}

// ===================================================================================================== node computations

function asArray(v: unknown, code: string, max: number = EXPR_LIMITS.maxListItems): unknown[] {
  if (!Array.isArray(v)) throw new ExprError(code);
  if (v.length > max) throw new ExprError('limit_exceeded');
  return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface SchemaLike {
  type?: string;
  properties?: Record<string, SchemaLike>;
  required?: string[];
  items?: SchemaLike;
  enum?: unknown[];
  maxLength?: number;
  maxItems?: number;
}

/** Checks a value against the DataSchema subset; returns issues (path + code), at most 50. */
export function schemaIssues(
  value: unknown,
  schema: SchemaLike,
  path = '',
  out: { path: string; code: string }[] = [],
  depth = 0,
): { path: string; code: string }[] {
  if (out.length >= 50 || depth > 8) return out;
  const t = schema.type ?? 'any';
  const typeOk =
    t === 'any' || t === 'files'
      ? true
      : t === 'string' || t === 'text'
        ? typeof value === 'string'
        : t === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : t === 'integer'
            ? Number.isInteger(value)
            : t === 'boolean'
              ? typeof value === 'boolean'
              : t === 'null'
                ? value === null
                : t === 'array'
                  ? Array.isArray(value)
                  : t === 'object' || t === 'git-ref'
                    ? isPlainObject(value)
                    : false;
  if (!typeOk) {
    out.push({ path, code: `type:${t}` });
    return out;
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, value)))
    out.push({ path, code: 'enum' });
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength)
    out.push({ path, code: 'max_length' });
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      out.push({ path, code: 'max_items' });
    if (schema.items !== undefined)
      value.slice(0, 1000).forEach((v, i) => {
        schemaIssues(v, schema.items as SchemaLike, `${path}[${String(i)}]`, out, depth + 1);
      });
  }
  if (isPlainObject(value)) {
    for (const k of schema.required ?? [])
      if (!(k in value)) out.push({ path: path === '' ? k : `${path}.${k}`, code: 'required' });
    for (const [k, s] of Object.entries(schema.properties ?? {})) {
      if (k in value) schemaIssues(value[k], s, path === '' ? k : `${path}.${k}`, out, depth + 1);
    }
  }
  return out;
}

/** RFC 4180-ish CSV (quotes, doubled quotes, CRLF), bounded. */
export function parseCsv(text: string, delimiter: string, header: boolean): unknown[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      if (rows.length > EXPR_LIMITS.maxCsvRows + 1) throw new ExprError('limit_exceeded');
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (!header) return rows;
  const [head, ...body] = rows;
  if (head === undefined) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

function parseForm(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(text)) {
    const cur = out[k];
    if (cur === undefined) out[k] = v;
    else if (Array.isArray(cur)) cur.push(v);
    else out[k] = [cur, v];
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function aggregateOp(op: string, values: unknown[]): unknown {
  const nums = values.map(num).filter((x): x is number => x !== null);
  switch (op) {
    case 'count':
      return values.length;
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'min':
      return nums.length === 0 ? null : Math.min(...nums);
    case 'max':
      return nums.length === 0 ? null : Math.max(...nums);
    case 'avg':
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'concat':
      return values;
    case 'first':
      return values[0] ?? null;
    case 'last':
      return values[values.length - 1] ?? null;
    default:
      throw new ExprError('type_error');
  }
}

/** Fields that are evaluated per item / per iteration, not once with the node's input. */
const DEFERRED: Readonly<Record<string, readonly string[]>> = {
  'control.switch': ['cases'],
  'control.loop': ['while'],
  'data.filter': ['keep'],
  'data.aggregate': ['groupBy', 'operations'],
};

/** Computes a master-pure node from its config and context (the engine handles timers, waits, groups, runs). */
export async function computeNode(
  type: string,
  rawConfig: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, FieldMode>>,
  ctx: ExprContext,
): Promise<NodeComputation> {
  const deferred = DEFERRED[type] ?? [];
  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawConfig)) {
    config[k] = fields[k] === 'expr' && !deferred.includes(k) ? await resolveValue(v, ctx) : v;
  }
  const input = ctx.input;
  switch (type) {
    case 'control.if': {
      const c = config.condition;
      if (typeof c !== 'boolean') throw new ExprError('type_error');
      return { config, ports: { [c ? 'true' : 'false']: input ?? null } };
    }
    case 'control.switch': {
      const value = config.value;
      const cases = (rawConfig.cases ?? []) as { name: string; equals?: unknown; match?: unknown }[];
      const all = config.mode === 'all';
      const hits: string[] = [];
      for (const k of cases) {
        let hit: boolean;
        if (k.equals !== undefined) hit = deepEqual(k.equals, value);
        else {
          const m = await resolveValue(k.match, ctx, input, { value });
          if (typeof m !== 'boolean') throw new ExprError('type_error');
          hit = m;
        }
        if (hit) {
          hits.push(k.name);
          if (!all) break;
        }
      }
      const ports: Record<string, unknown> = {};
      for (const h of hits.length === 0 ? ['default'] : hits) ports[h] = input ?? null;
      return { config, ports };
    }
    case 'control.forEach': {
      const items = asArray(config.items, 'type_error', EXPR_LIMITS.forEachMaxItems);
      return { config: { ...config, items } };
    }
    case 'control.loop': {
      const w = await resolveValue(rawConfig.while, ctx);
      if (typeof w !== 'boolean') throw new ExprError('type_error');
      return { config, continue: w };
    }
    case 'data.set': {
      const fieldsOut = (config.fields ?? {}) as Record<string, unknown>;
      const base = config.keepInput === true && isPlainObject(input) ? input : {};
      return { config, ports: { out: { ...base, ...fieldsOut } } };
    }
    case 'data.transform':
      return { config, ports: { out: config.expression ?? null } };
    case 'data.filter': {
      const items = asArray(config.items, 'type_error');
      const keep = perItem(rawConfig.keep);
      const kept: unknown[] = [];
      const dropped: unknown[] = [];
      for (let i = 0; i < items.length; i++) {
        const k = await keep(ctx, items[i], i);
        if (typeof k !== 'boolean') throw new ExprError('type_error');
        (k ? kept : dropped).push(items[i]);
      }
      return { config, ports: { kept, dropped } };
    }
    case 'data.aggregate': {
      const items = asArray(config.items, 'type_error');
      const ops = (rawConfig.operations ?? []) as { name: string; op: string; field?: unknown }[];
      const groupBy = rawConfig.groupBy === undefined ? null : perItem(rawConfig.groupBy);
      const fieldFns = ops.map((o) => (o.field === undefined ? null : perItem(o.field)));
      const groups = new Map<string, { key: unknown; values: unknown[][] }>();
      for (let i = 0; i < items.length; i++) {
        const key = groupBy === null ? null : await groupBy(ctx, items[i], i);
        const k = JSON.stringify(key ?? null);
        let g = groups.get(k);
        if (g === undefined) {
          g = { key: key ?? null, values: ops.map(() => []) };
          groups.set(k, g);
        }
        for (let j = 0; j < ops.length; j++) {
          const f = fieldFns[j];
          g.values[j]?.push(f === null || f === undefined ? items[i] : await f(ctx, items[i], i));
        }
      }
      const summarise = (g: { values: unknown[][] }) =>
        Object.fromEntries(ops.map((o, j) => [o.name, aggregateOp(o.op, g.values[j] ?? [])]));
      if (groupBy === null) {
        const g = groups.get('null') ?? { key: null, values: ops.map(() => []) };
        return { config, ports: { out: summarise(g) } };
      }
      return { config, ports: { out: [...groups.values()].map((g) => ({ key: g.key, ...summarise(g) })) } };
    }
    case 'data.split': {
      if (config.mode === 'array') return { config, ports: { items: asArray(config.value, 'type_error') } };
      if (typeof config.value !== 'string') throw new ExprError('type_error');
      const sep = typeof config.separator === 'string' ? config.separator : ',';
      const parts = config.value.split(sep);
      if (parts.length > EXPR_LIMITS.maxListItems) throw new ExprError('limit_exceeded');
      return { config, ports: { items: parts } };
    }
    case 'data.template':
      return { config, ports: { out: textOf(config.template) } };
    case 'data.parse': {
      const v = config.value;
      if (typeof v !== 'string') throw new ExprError('type_error');
      if (Buffer.byteLength(v, 'utf8') > EXPR_LIMITS.maxParseBytes) throw new ExprError('limit_exceeded');
      let out: unknown;
      try {
        if (config.format === 'json') out = JSON.parse(v) as unknown;
        else if (config.format === 'yaml')
          out = parseYaml(v, {
            schema: 'core',
            maxAliasCount: 100,
            prettyErrors: false,
            uniqueKeys: true,
          }) as unknown;
        else if (config.format === 'form') out = parseForm(v);
        else {
          const csv = (config.csv ?? {}) as { header?: boolean; delimiter?: string };
          out = parseCsv(v, csv.delimiter ?? ',', csv.header ?? true);
        }
      } catch (err) {
        if (err instanceof ExprError) throw err;
        throw new ExprError('parse_error');
      }
      return { config, ports: { out: toJson(out) ?? null } };
    }
    case 'data.validate': {
      const issues = schemaIssues(config.value, rawConfig.schema as SchemaLike);
      return {
        config,
        ports:
          issues.length === 0
            ? { valid: config.value ?? null }
            : { invalid: { value: config.value ?? null, issues } },
      };
    }
    default:
      // Control nodes whose effect the engine applies (timers, waits, runs): the resolved config is the result.
      return { config };
  }
}

// ===================================================================================================== thread entry

function byteSize(v: unknown): number {
  const s = JSON.stringify(v) as string | undefined;
  return s === undefined ? 0 : Buffer.byteLength(s, 'utf8');
}

/** Handles one request inside the sandbox thread. */
export async function handle(req: SandboxRequest, testHooks: boolean): Promise<SandboxResult> {
  try {
    let value: unknown;
    if (req.op === 'eval') {
      value =
        req.mode === 'template'
          ? await evaluateTemplate(req.source, req.context)
          : await evaluateExpr(req.source, req.context);
    } else if (req.op === 'node') {
      value = await computeNode(req.type, req.config, req.fields, req.context);
    } else if (req.op === 'spin' && testHooks) {
      const until = Date.now() + req.ms;
      while (Date.now() < until) {
        /* busy */
      }
      value = null;
    } else if (req.op === 'allocate' && testHooks) {
      const hold: number[][] = [];
      for (let i = 0; i < req.mb; i++) hold.push(new Array<number>(262_144).fill(i));
      value = hold.length;
    } else throw new ExprError('expr_error');
    if (byteSize(value) > EXPR_LIMITS.maxOutputBytes) throw new ExprError('expr_output_too_large');
    return { ok: true, value };
  } catch (err) {
    const e = errorOf(err);
    return { ok: false, code: e.code, position: e.position };
  }
}

const data = workerData as { remyralExprSandbox?: boolean; testHooks?: boolean } | null;
if (!isMainThread && parentPort !== null && data?.remyralExprSandbox === true) {
  const port = parentPort;
  const testHooks = data.testHooks === true;
  port.on('message', (msg: { id: number; req: SandboxRequest }) => {
    void handle(msg.req, testHooks).then((res) => {
      port.postMessage({ id: msg.id, res });
    });
  });
  port.postMessage({ ready: true });
}
