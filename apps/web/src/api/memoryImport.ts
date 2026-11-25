import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p17-memory-import (docs/design/p17-memory-import.md): import what a person's own AI assistant knows about them —
 * options, a preview that stores nothing (candidates with proposed type and scope, checks, duplicates), the import
 * of the reviewed items, the person's imports and "Bu içe aktarmayı geri al". Typed wrappers over
 * apps/master/src/memory-import/routes.ts. Every text comes from an outside assistant: plain text only.
 */

type Opts = Omit<RequestOptions, 'body'>;

export const ITEM_KINDS = [
  'preference',
  'working_style',
  'fact',
  'project',
  'rule',
  'tool',
  'avoid',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const IMPORT_ASSISTANTS = ['claude', 'chatgpt', 'gemini', 'copilot', 'other'] as const;
export type ImportAssistant = (typeof IMPORT_ASSISTANTS)[number];
export type ImportRecordType = 'rule' | 'fact' | 'lesson';
export type ImportFormat = 'jsonl' | 'json' | 'markdown' | 'text';

export interface ImportOptions {
  readonly promptVersion: number;
  readonly maxBytes: number;
  readonly maxItems: number;
  readonly maxItemChars: number;
  readonly semanticAvailable: boolean;
  readonly canGlobal: boolean;
  readonly personalScope: string;
}

export interface RecordMatch {
  readonly id: string;
  readonly title: string;
  readonly scope: string;
  readonly score: number;
  readonly method: 'semantic' | 'lexical';
}

export interface PreviewItem {
  readonly index: number;
  readonly kind: ItemKind;
  readonly guessed: boolean;
  readonly scopeHint: 'personal' | 'team' | null;
  readonly text: string;
  readonly evidence: string | null;
  readonly date: string | null;
  readonly line: number;
  readonly proposedScope: string;
  readonly proposedType: ImportRecordType;
  /** `secret`, `instruction:<flag>`, `personal_data`, `sensitive`, `too_long`, `too_short`, `duplicate`, … */
  readonly flags: readonly string[];
  readonly include: boolean;
  readonly blocked: boolean;
  readonly duplicateOf: RecordMatch | null;
  readonly similarTo: RecordMatch | null;
  readonly contradicts: RecordMatch | null;
  readonly mergeInto: number | null;
  readonly mergedFrom: readonly number[];
}

export interface ImportPreview {
  readonly format: ImportFormat;
  readonly sha256: string;
  readonly bytes: number;
  readonly items: readonly PreviewItem[];
  readonly issues: readonly { readonly line: number; readonly code: string }[];
  readonly truncated: boolean;
  readonly semantic: boolean;
  readonly semanticFailed: boolean;
  readonly language: 'tr' | 'en';
}

export interface ImportBatch {
  readonly id: string;
  readonly assistant: ImportAssistant;
  readonly assistantLabel: string | null;
  readonly source: string;
  readonly promptVersion: number | null;
  readonly format: string;
  readonly itemsTotal: number;
  readonly itemsImported: number;
  readonly itemsFailed: number;
  readonly flaggedImported: number;
  readonly scopes: readonly string[];
  readonly semantic: boolean;
  readonly createdAt: string;
  readonly undoneAt: string | null;
  readonly activeRecords: number;
}

export interface ApplyItem {
  readonly kind: ItemKind;
  readonly text: string;
  readonly type: ImportRecordType;
  readonly scope: string;
  readonly evidence?: string | null;
  readonly date?: string | null;
}

export interface ApplyBody {
  readonly assistant: ImportAssistant;
  readonly assistantLabel?: string | null;
  readonly promptVersion?: number | null;
  readonly format: ImportFormat | 'edited';
  readonly sha256?: string | null;
  readonly bytes?: number | null;
  readonly semantic?: boolean;
  readonly items: readonly ApplyItem[];
}

export interface ApplyResult {
  readonly import: ImportBatch;
  readonly results: readonly {
    readonly index: number;
    readonly ok: boolean;
    readonly recordId: string | null;
    readonly code: string | null;
  }[];
}

function oneOf<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const v = o[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v))
    throw new ShapeError(`unexpected ${key}`);
  return v as T;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function match(v: unknown): RecordMatch | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return {
    id: str(o, 'id'),
    title: str(o, 'title'),
    scope: str(o, 'scope'),
    score: typeof o.score === 'number' ? o.score : 0,
    method: o.method === 'semantic' ? 'semantic' : 'lexical',
  };
}

function parseItem(v: unknown): PreviewItem {
  const o = obj(v);
  const type = o.proposedType;
  return {
    index: int(o, 'index'),
    kind: oneOf(o, 'kind', ITEM_KINDS),
    guessed: o.guessed === true,
    scopeHint: o.scopeHint === 'personal' || o.scopeHint === 'team' ? o.scopeHint : null,
    text: str(o, 'text'),
    evidence: nullableStr(o, 'evidence'),
    date: nullableStr(o, 'date'),
    line: int(o, 'line'),
    proposedScope: str(o, 'proposedScope'),
    proposedType: type === 'fact' || type === 'lesson' ? type : 'rule',
    flags: strings(o.flags),
    include: o.include === true,
    blocked: o.blocked === true,
    duplicateOf: match(o.duplicateOf),
    similarTo: match(o.similarTo),
    contradicts: match(o.contradicts),
    mergeInto: typeof o.mergeInto === 'number' ? o.mergeInto : null,
    mergedFrom: Array.isArray(o.mergedFrom)
      ? o.mergedFrom.filter((x): x is number => typeof x === 'number')
      : [],
  };
}

function parsePreview(v: unknown): ImportPreview {
  const o = obj(v);
  if (!Array.isArray(o.items)) throw new ShapeError('expected items');
  return {
    format: oneOf(o, 'format', ['jsonl', 'json', 'markdown', 'text'] as const),
    sha256: str(o, 'sha256'),
    bytes: int(o, 'bytes'),
    items: o.items.map(parseItem),
    issues: Array.isArray(o.issues)
      ? o.issues.map((x) => {
          const i = obj(x);
          return { line: int(i, 'line'), code: str(i, 'code') };
        })
      : [],
    truncated: o.truncated === true,
    semantic: o.semantic === true,
    semanticFailed: o.semanticFailed === true,
    language: o.language === 'en' ? 'en' : 'tr',
  };
}

export function parseBatch(v: unknown): ImportBatch {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    assistant: oneOf(o, 'assistant', IMPORT_ASSISTANTS),
    assistantLabel: nullableStr(o, 'assistantLabel'),
    source: str(o, 'source'),
    promptVersion: typeof o.promptVersion === 'number' ? o.promptVersion : null,
    format: str(o, 'format'),
    itemsTotal: int(o, 'itemsTotal'),
    itemsImported: int(o, 'itemsImported'),
    itemsFailed: int(o, 'itemsFailed'),
    flaggedImported: int(o, 'flaggedImported'),
    scopes: strings(o.scopes),
    semantic: o.semantic === true,
    createdAt: str(o, 'createdAt'),
    undoneAt: nullableStr(o, 'undoneAt'),
    activeRecords: int(o, 'activeRecords'),
  };
}

function parseOptions(v: unknown): ImportOptions {
  const o = obj(v);
  return {
    promptVersion: int(o, 'promptVersion'),
    maxBytes: int(o, 'maxBytes'),
    maxItems: int(o, 'maxItems'),
    maxItemChars: int(o, 'maxItemChars'),
    semanticAvailable: o.semanticAvailable === true,
    canGlobal: o.canGlobal === true,
    personalScope: str(o, 'personalScope'),
  };
}

export function getImportOptions(opts: Opts = {}): Promise<ImportOptions> {
  return apiRequest('GET', '/memory-imports/options', parseOptions, opts);
}

export function previewImport(
  body: { readonly text: string; readonly project?: string | null; readonly semantic?: boolean },
  opts: Opts = {},
): Promise<ImportPreview> {
  return apiRequest('POST', '/memory-imports/preview', parsePreview, { ...opts, body });
}

export function applyImport(body: ApplyBody, opts: Opts = {}): Promise<ApplyResult> {
  return apiRequest(
    'POST',
    '/memory-imports',
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.results)) throw new ShapeError('expected results');
      return {
        import: parseBatch(o.import),
        results: o.results.map((x) => {
          const r = obj(x);
          return {
            index: int(r, 'index'),
            ok: r.ok === true,
            recordId: nullableStr(r, 'recordId'),
            code: nullableStr(r, 'code'),
          };
        }),
      };
    },
    { ...opts, body },
  );
}

export function listImports(opts: Opts = {}): Promise<ImportBatch[]> {
  return apiRequest(
    'GET',
    '/memory-imports',
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.items)) throw new ShapeError('expected items');
      return o.items.map(parseBatch);
    },
    opts,
  );
}

export function undoImport(
  id: string,
  opts: Opts = {},
): Promise<{ import: ImportBatch; rejected: number; failed: number }> {
  return apiRequest(
    'POST',
    `/memory-imports/${encodeURIComponent(id)}/undo`,
    (v) => {
      const o = obj(v);
      return { import: parseBatch(o.import), rejected: int(o, 'rejected'), failed: int(o, 'failed') };
    },
    { ...opts, body: {} },
  );
}

/** Allowed record types per scope (personal: rules only — ADR-0043). */
export function typesForScope(scope: string): readonly ImportRecordType[] {
  return scope.startsWith('user:') ? ['rule'] : ['rule', 'fact', 'lesson'];
}

/** The default record type of an item kind in a scope (mirrors apps/master/src/memory-import/review.ts). */
export function typeFor(kind: ItemKind, scope: string): ImportRecordType {
  if (scope.startsWith('user:')) return 'rule';
  if (kind === 'rule' || kind === 'avoid') return 'rule';
  if (kind === 'working_style') return 'lesson';
  return 'fact';
}

/** Flags that leave an item unchecked by default (mirrors the master; the others are notes). */
export function unchecks(flag: string): boolean {
  return !(flag === 'time_bound' || flag === 'contradicts' || flag === 'similar');
}
