import { createHash } from 'node:crypto';
import { MEMORY_IMPORT_PROMPT_VERSION } from '@remyral/i18n';
import { parseRecordScope, projectNamespace, type RecordType, roleAtLeast } from '@remyral/memory';
import type { AuditRecorder } from '../audit/audit.js';
import { ContextError, ContextForbiddenError, InvalidContextInputError } from '../context/errors.js';
import { auditActorOf, type ContextActor, type RequestMeta, roleIn } from '../context/store.js';
import type { Pool } from '../db/pool.js';
import type { MemoryRecordService, RecordView } from '../memory-records/service.js';
import {
  type ImportFormat,
  type ItemKind,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ITEMS,
  MAX_ITEM_CHARS,
  parseImport,
  type ParseIssue,
  type ScopeHint,
} from './parse.js';
import {
  allowedTypes,
  dedupe,
  type ExistingRecord,
  type ImportFlag,
  type ImportScopeKind,
  itemsLanguage,
  type RecordMatch,
  recordTypeFor,
  textFlags,
  unchecks,
} from './review.js';

/**
 * p17-memory-import (docs/design/p17-memory-import.md): a person imports what their own AI assistant knows about them.
 *
 * - `preview` parses the pasted / uploaded text (strict block or tolerant), maps every item to a record type and a
 *   scope (personal by default), runs the checks (secret scan, the auto-learning instruction heuristic, other people's
 *   data, sensitive categories, length) and de-duplicates against the person's existing records and inside the import
 *   (by meaning only with the person's explicit consent and a provider; lexical otherwise). Nothing is stored.
 * - `apply` creates the items the person kept — possibly edited — as ordinary memory records through
 *   `MemoryRecordService.create` (write roles, secret scan, versions, audit, conflict detection), with provenance
 *   `import: <assistant>` on the first version, the person as author, the batch id on the record. Audited `memory.import`.
 * - `undo` rejects the batch's still-active records (`MemoryRecordService.setStatus`, history kept). Once.
 *
 * Scopes need exactly the permission of writing the record by hand: personal — the person themself; a project —
 * operator or more in it (and the document write role); global — an admin. The imported text is untrusted data: it is
 * parsed and shown as plain text, never executed or followed, and reaches agents only through the fenced memory bundle.
 */

export const IMPORT_ASSISTANTS = ['claude', 'chatgpt', 'gemini', 'copilot', 'other'] as const;
export type ImportAssistant = (typeof IMPORT_ASSISTANTS)[number];
const ASSISTANT_NAMES: Readonly<Record<Exclude<ImportAssistant, 'other'>, string>> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  copilot: 'Copilot',
};

/** Existing records compared against, per family (personal, project, global). */
const MAX_COMPARED = 300;

abstract class ImportError extends ContextError {}

export class ImportNotFoundError extends ImportError {
  override name = 'ImportNotFoundError';
  readonly code = 'memory_import_not_found';
  readonly httpStatus = 404;
  readonly publicMessage = 'Memory import not found.';
}

export class ImportUndoneError extends ImportError {
  override name = 'ImportUndoneError';
  readonly code = 'memory_import_already_undone';
  readonly httpStatus = 409;
  readonly publicMessage = 'This import was already undone.';
}

export class ImportTooLargeError extends ImportError {
  override name = 'ImportTooLargeError';
  readonly code = 'memory_import_too_large';
  readonly httpStatus = 400;
  readonly publicMessage = `The text is too large to import (at most ${String(MAX_IMPORT_BYTES / 1024)} KB).`;
}

export class ImportScopeError extends ImportError {
  override name = 'ImportScopeError';
  readonly code = 'memory_import_scope_forbidden';
  readonly httpStatus = 403;
  readonly publicMessage =
    'You may not write records in one of the chosen scopes (a project needs operator or more, global needs an admin).';
  constructor(readonly scope: string) {
    super(`import scope refused: ${scope.slice(0, 140)}`);
  }
}

export interface ImportOptions {
  readonly promptVersion: number;
  readonly maxBytes: number;
  readonly maxItems: number;
  readonly maxItemChars: number;
  /** An embedding provider is configured (the "compare by meaning" box can be offered). */
  readonly semanticAvailable: boolean;
  /** The caller may write global records (admin or owner). */
  readonly canGlobal: boolean;
  /** The caller's personal scope (`user:<id>`). */
  readonly personalScope: string;
}

export interface PreviewItem {
  readonly index: number;
  readonly kind: ItemKind;
  /** The type was guessed (no prefix in free text, or an unknown type in the strict block). */
  readonly guessed: boolean;
  readonly scopeHint: ScopeHint;
  readonly text: string;
  readonly evidence: string | null;
  readonly date: string | null;
  readonly line: number;
  readonly proposedScope: string;
  readonly proposedType: RecordType;
  readonly flags: readonly ImportFlag[];
  /** Checked by default (no flag that asks for a second look). */
  readonly include: boolean;
  /** Secret-looking: can never be imported (remove the value and preview again). */
  readonly blocked: boolean;
  readonly duplicateOf: RecordMatch | null;
  readonly similarTo: RecordMatch | null;
  readonly contradicts: RecordMatch | null;
  readonly mergeInto: number | null;
  readonly mergedFrom: readonly number[];
}

export interface PreviewResult {
  readonly format: ImportFormat;
  readonly sha256: string;
  readonly bytes: number;
  readonly items: readonly PreviewItem[];
  readonly issues: readonly ParseIssue[];
  readonly truncated: boolean;
  /** Meaning-based comparison ran (consent given, a provider configured, the call succeeded). */
  readonly semantic: boolean;
  /** Consent was given but the provider failed: lexical comparison only. */
  readonly semanticFailed: boolean;
  readonly language: 'tr' | 'en';
}

export interface ApplyItem {
  readonly kind: ItemKind;
  readonly text: string;
  readonly type: RecordType;
  readonly scope: string;
  readonly evidence?: string | null | undefined;
  readonly date?: string | null | undefined;
}

export interface ApplyInput {
  readonly assistant: ImportAssistant;
  readonly assistantLabel?: string | null | undefined;
  readonly promptVersion?: number | null | undefined;
  readonly format: ImportFormat | 'edited';
  readonly sha256?: string | null | undefined;
  readonly bytes?: number | null | undefined;
  readonly semantic?: boolean | undefined;
  readonly items: readonly ApplyItem[];
}

export interface ItemResult {
  readonly index: number;
  readonly ok: boolean;
  readonly recordId: string | null;
  /** Why it was not imported (an error code: `secret_detected`, `forbidden`, `invalid_input`, …). */
  readonly code: string | null;
}

export interface ImportView {
  readonly id: string;
  readonly assistant: ImportAssistant;
  readonly assistantLabel: string | null;
  /** "Claude", "ChatGPT", … or the label of `other`. */
  readonly source: string;
  readonly promptVersion: number | null;
  readonly format: string;
  readonly itemsTotal: number;
  readonly itemsImported: number;
  readonly itemsFailed: number;
  readonly flaggedImported: number;
  readonly scopes: readonly string[];
  readonly semantic: boolean;
  readonly createdAt: Date;
  readonly undoneAt: Date | null;
  /** Records of the batch that are still active (what an undo would reject). */
  readonly activeRecords: number;
}

export interface MemoryImportDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly records: MemoryRecordService;
  /** The embedding provider (SearchService); null / absent: lexical comparison only. */
  readonly search?: {
    readonly embedder: unknown;
    embedConsented(texts: readonly string[]): Promise<{ vectors: (Float32Array | null)[] } | null>;
    captureOn(namespace: string): Promise<boolean>;
  } | null;
  readonly clock?: () => Date;
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

interface ImportRow {
  id: string;
  assistant: ImportAssistant;
  assistant_label: string | null;
  prompt_version: number | null;
  format: string;
  items_total: number;
  items_imported: number;
  items_failed: number;
  flagged_imported: number;
  scopes: string[];
  semantic: boolean;
  created_at: Date;
  undone_at: Date | null;
  active_records: string;
}

/** "import: Claude" — the provenance of an imported record's first version. */
export function sourceName(assistant: ImportAssistant, label: string | null | undefined): string {
  if (assistant === 'other') {
    const l = (label ?? '').replace(/\s+/gu, ' ').trim();
    return l === '' ? 'other assistant' : l.slice(0, 40);
  }
  return ASSISTANT_NAMES[assistant];
}

function scopeKind(scope: string): ImportScopeKind {
  if (scope.startsWith('user:')) return 'personal';
  if (scope === 'global') return 'global';
  return 'project';
}

export class MemoryImportService {
  private readonly pool: Pool;
  private readonly audit: AuditRecorder;
  private readonly records: MemoryRecordService;
  private readonly search: MemoryImportDeps['search'];
  private readonly clock: () => Date;
  private readonly log: MemoryImportDeps['log'];

  constructor(deps: MemoryImportDeps) {
    this.pool = deps.pool;
    this.audit = deps.audit;
    this.records = deps.records;
    this.search = deps.search ?? null;
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.log;
  }

  options(user: ContextActor): ImportOptions {
    return {
      promptVersion: MEMORY_IMPORT_PROMPT_VERSION,
      maxBytes: MAX_IMPORT_BYTES,
      maxItems: MAX_IMPORT_ITEMS,
      maxItemChars: MAX_ITEM_CHARS,
      semanticAvailable: this.search != null && this.search.embedder != null,
      canGlobal: roleAtLeast(user.role, 'admin'),
      personalScope: `user:${user.id.toLowerCase()}`,
    };
  }

  /** May the caller write records in this scope (the permission of creating one by hand)? */
  private canWriteScope(user: ContextActor, scope: string): boolean {
    const s = parseRecordScope(scope);
    if (s === null) return false;
    if (s.type === 'user') return s.user === user.id.toLowerCase();
    if (s.type === 'global') return s.runtime === null && roleAtLeast(user.role, 'admin');
    if (s.runtime !== null) return false;
    const role = roleIn(user, projectNamespace(s.project));
    return role !== null && roleAtLeast(role, 'operator');
  }

  /** Active records the person's import is compared with: their own, the target project's, the global ones. */
  private async existing(user: ContextActor, project: string | null): Promise<RecordView[]> {
    const mine = await this.records.list(user, { scope: 'mine', statuses: ['active'], limit: MAX_COMPARED });
    const proj =
      project === null
        ? []
        : await this.records.list(user, {
            scope: 'project',
            project,
            statuses: ['active'],
            limit: MAX_COMPARED,
          });
    const global = await this.records.list(user, {
      scope: 'global',
      statuses: ['active'],
      limit: MAX_COMPARED,
    });
    return [...mine, ...proj, ...global];
  }

  async preview(
    user: ContextActor,
    input: {
      readonly text: string;
      readonly project?: string | null | undefined;
      readonly semantic?: boolean | undefined;
    },
  ): Promise<PreviewResult> {
    const bytes = Buffer.byteLength(input.text, 'utf8');
    if (bytes > MAX_IMPORT_BYTES) throw new ImportTooLargeError('too large');
    const project = input.project ?? null;
    if (project !== null) {
      if (!PROJECT.test(project))
        throw new InvalidContextInputError([{ field: 'project', code: 'invalid_format' }]);
      if (roleIn(user, projectNamespace(project)) === null) throw new ContextForbiddenError('not_visible');
    }
    const parsed = parseImport(input.text);
    const records = await this.existing(user, project);
    const personalScope = `user:${user.id.toLowerCase()}`;
    const projectScope = project === null ? null : `project:${project}`;
    const projectWritable = projectScope !== null && this.canWriteScope(user, projectScope);

    // Meaning-based comparison: only with the person's consent (their own texts and personal records), project records
    // only when the project's capture is consented; global records stay lexical.
    let semantic = false;
    let semanticFailed = false;
    let itemVectors: (Float32Array | null)[] = parsed.items.map(() => null);
    const recordVectors = new Map<string, Float32Array>();
    if (input.semantic === true && this.search != null && this.search.embedder != null) {
      try {
        const sendable = records.filter((r) => r.scope === personalScope);
        if (project !== null && (await this.search.captureOn(projectNamespace(project)))) {
          sendable.push(...records.filter((r) => r.project === project));
        }
        const out = await this.search.embedConsented([
          ...parsed.items.map((it) => it.text),
          ...sendable.map((r) => r.statement),
        ]);
        if (out !== null) {
          semantic = true;
          itemVectors = out.vectors.slice(0, parsed.items.length);
          sendable.forEach((r, i) => {
            const v = out.vectors[parsed.items.length + i];
            if (v != null) recordVectors.set(r.id, v);
          });
        }
      } catch (err) {
        semanticFailed = true;
        this.log?.warn(
          { errName: err instanceof Error ? err.name : 'error' },
          'memory import: semantic comparison failed, lexical only',
        );
      }
    }
    const existing: ExistingRecord[] = records.map((r) => ({
      id: r.id,
      title: r.title,
      statement: r.statement,
      scope: r.scope,
      type: r.type,
      vector: recordVectors.get(r.id) ?? null,
    }));
    const lang = itemsLanguage(parsed.items);
    const dd = dedupe(
      parsed.items.map((it, i) => ({ index: i, text: it.text, vector: itemVectors[i] ?? null })),
      existing,
      lang,
    );
    const items = parsed.items.map((it, i): PreviewItem => {
      const d = dd.get(i);
      const flags = textFlags(it.text, it.evidence, it.hidden);
      if (d?.duplicateOf != null) flags.push('duplicate');
      if (d?.mergeInto != null) flags.push('duplicate_in_import');
      if (d?.contradicts != null) flags.push('contradicts');
      if (d?.similarTo != null) flags.push('similar');
      const proposedScope = it.scopeHint === 'team' && projectWritable ? projectScope : personalScope;
      return {
        index: i,
        kind: it.kind,
        guessed: it.guessed,
        scopeHint: it.scopeHint,
        text: it.text,
        evidence: it.evidence,
        date: it.date,
        line: it.line,
        proposedScope,
        proposedType: recordTypeFor(it.kind, scopeKind(proposedScope)),
        flags,
        include: !flags.some(unchecks),
        blocked: flags.includes('secret'),
        duplicateOf: d?.duplicateOf ?? null,
        similarTo: d?.similarTo ?? null,
        contradicts: d?.contradicts ?? null,
        mergeInto: d?.mergeInto ?? null,
        mergedFrom: d?.mergedFrom ?? [],
      };
    });
    return {
      format: parsed.format,
      sha256: createHash('sha256').update(input.text, 'utf8').digest('hex'),
      bytes,
      items,
      issues: parsed.issues,
      truncated: parsed.truncated,
      semantic,
      semanticFailed,
      language: lang,
    };
  }

  /** Creates the kept items as records (one batch); per-item failures are reported, the rest is imported. */
  async apply(
    user: ContextActor,
    input: ApplyInput,
    meta: RequestMeta = {},
  ): Promise<{ import: ImportView; results: ItemResult[] }> {
    const actor = auditActorOf(user);
    const deny = async (code: string, extra: Record<string, unknown> = {}): Promise<void> => {
      await this.audit.record({
        actor,
        action: 'memory.import',
        target: `memory-import:${user.id}`,
        outcome: 'denied',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: { code, ...extra },
      });
    };
    if (input.items.length === 0 || input.items.length > MAX_IMPORT_ITEMS) {
      throw new InvalidContextInputError([{ field: 'items', code: 'count' }]);
    }
    // Scopes and types first: one refused scope refuses the whole import (nothing half-written).
    const issues: { field: string; code: string }[] = [];
    for (const [i, it] of input.items.entries()) {
      if (!this.canWriteScope(user, it.scope)) {
        await deny('memory_import_scope_forbidden', { scope: it.scope.slice(0, 140) });
        throw new ImportScopeError(it.scope);
      }
      if (!allowedTypes(scopeKind(it.scope)).includes(it.type)) {
        issues.push({ field: `items.${String(i)}.type`, code: 'not_allowed_for_scope' });
      }
      if (it.text.trim() === '' || it.text.length > MAX_ITEM_CHARS) {
        issues.push({ field: `items.${String(i)}.text`, code: 'length' });
      }
    }
    if (issues.length > 0) {
      await deny('invalid_input');
      throw new InvalidContextInputError(issues);
    }
    const name = sourceName(input.assistant, input.assistantLabel);
    const label =
      input.assistant === 'other'
        ? (input.assistantLabel ?? '').replace(/\s+/gu, ' ').trim().slice(0, 40)
        : '';
    const now = this.clock();
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO memory_imports (user_id, assistant, assistant_label, prompt_version, format, source_sha256,
                                   source_bytes, items_total, semantic, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text AS id`,
      [
        user.id,
        input.assistant,
        label === '' ? null : label,
        input.promptVersion ?? null,
        input.format,
        input.sha256 != null && /^[0-9a-f]{64}$/u.test(input.sha256) ? input.sha256 : null,
        input.bytes != null && input.bytes >= 0 && input.bytes <= MAX_IMPORT_BYTES ? input.bytes : null,
        input.items.length,
        input.semantic === true,
        now,
      ],
    );
    const importId = rows[0]?.id;
    if (importId === undefined) throw new Error('memory import: no id');

    const results: ItemResult[] = [];
    const scopes = new Set<string>();
    let flagged = 0;
    for (const [index, it] of input.items.entries()) {
      const text = it.text.replace(/\s+/gu, ' ').trim();
      const evidence = it.evidence?.replace(/\s+/gu, ' ').trim().slice(0, 300) ?? '';
      const date = it.date != null && /^\d{4}-\d{2}(?:-\d{2})?$/u.test(it.date) ? it.date : null;
      const flags = textFlags(text, evidence === '' ? null : evidence);
      if (flags.includes('secret')) {
        results.push({ index, ok: false, recordId: null, code: 'secret_detected' });
        continue;
      }
      // The assistant's "how I know it" becomes the record's rationale (rendered as "Why: …").
      const rationale = evidence === '' ? null : date === null ? evidence : `${evidence} (${date})`;
      const tags = ['import', `kind:${it.kind}`];
      if (date !== null) tags.push(`date:${date}`);
      try {
        const out = await this.records.create(
          user,
          { scope: it.scope, type: it.type, statement: text, rationale, tags },
          meta,
          {
            author: 'human',
            authorRef: user.id,
            suggestionId: null,
            importSource: `import: ${name}`,
            changeNote: `Imported from ${name}`,
            importId,
          },
        );
        scopes.add(out.record.scope);
        if (flags.some(unchecks)) flagged += 1;
        results.push({ index, ok: true, recordId: out.record.id, code: null });
      } catch (err) {
        if (!(err instanceof ContextError)) throw err;
        results.push({ index, ok: false, recordId: null, code: err.code });
      }
    }
    const imported = results.filter((r) => r.ok).length;
    await this.pool.query(
      `UPDATE memory_imports SET items_imported = $2, items_failed = $3, scopes = $4, flagged_imported = $5
        WHERE id = $1`,
      [importId, imported, results.length - imported, [...scopes].sort(), flagged],
    );
    await this.audit.record({
      actor,
      action: 'memory.import',
      target: `memory-import:${importId}`,
      outcome: 'success',
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      metadata: {
        importId,
        assistant: input.assistant,
        promptVersion: input.promptVersion ?? null,
        format: input.format,
        sha256: input.sha256 ?? null,
        items: input.items.length,
        imported,
        failed: results.length - imported,
        flaggedImported: flagged,
        scopes: [...scopes].sort(),
        semantic: input.semantic === true,
        failures: results.filter((r) => !r.ok).map((r) => r.code),
      },
    });
    const view = await this.one(user, importId);
    return { import: view, results };
  }

  private async rows(where: string, params: unknown[]): Promise<ImportRow[]> {
    const { rows } = await this.pool.query<ImportRow>(
      `SELECT i.id::text AS id, i.assistant, i.assistant_label, i.prompt_version, i.format, i.items_total,
              i.items_imported, i.items_failed, i.flagged_imported, i.scopes, i.semantic, i.created_at, i.undone_at,
              (SELECT count(*) FROM memory_records r WHERE r.import_id = i.id AND r.status = 'active')::text
                AS active_records
         FROM memory_imports i WHERE ${where}
        ORDER BY i.created_at DESC, i.id LIMIT 50`,
      params,
    );
    return rows;
  }

  private view(r: ImportRow): ImportView {
    return {
      id: r.id,
      assistant: r.assistant,
      assistantLabel: r.assistant_label,
      source: sourceName(r.assistant, r.assistant_label),
      promptVersion: r.prompt_version,
      format: r.format,
      itemsTotal: r.items_total,
      itemsImported: r.items_imported,
      itemsFailed: r.items_failed,
      flaggedImported: r.flagged_imported,
      scopes: r.scopes,
      semantic: r.semantic,
      createdAt: r.created_at,
      undoneAt: r.undone_at,
      activeRecords: Number(r.active_records),
    };
  }

  private async one(user: ContextActor, id: string): Promise<ImportView> {
    if (!UUID.test(id)) throw new ImportNotFoundError('id');
    const r = (await this.rows('i.id = $1 AND i.user_id = $2', [id, user.id]))[0];
    if (r === undefined) throw new ImportNotFoundError('id');
    return this.view(r);
  }

  /** The caller's own imports, newest first (at most 50). */
  async list(user: ContextActor): Promise<ImportView[]> {
    return (await this.rows('i.user_id = $1', [user.id])).map((r) => this.view(r));
  }

  /** "Bu içe aktarmayı geri al": the batch's active records become `rejected` (history kept). Once. */
  async undo(
    user: ContextActor,
    id: string,
    meta: RequestMeta = {},
  ): Promise<{ import: ImportView; rejected: number; failed: number }> {
    await this.one(user, id);
    const claimed = await this.pool.query(
      `UPDATE memory_imports SET undone_at = $3, undone_by = $2 WHERE id = $1 AND user_id = $2 AND undone_at IS NULL`,
      [id, user.id, this.clock()],
    );
    if ((claimed.rowCount ?? 0) === 0) throw new ImportUndoneError('undone');
    const { rows } = await this.pool.query<{ doc_id: string }>(
      `SELECT doc_id::text AS doc_id FROM memory_records WHERE import_id = $1 AND status = 'active' ORDER BY created_at`,
      [id],
    );
    let rejected = 0;
    const failures: string[] = [];
    for (const r of rows) {
      try {
        await this.records.setStatus(
          user,
          r.doc_id,
          { status: 'rejected', reason: 'Import undone (Bu içe aktarmayı geri al)' },
          meta,
        );
        rejected += 1;
      } catch (err) {
        if (!(err instanceof ContextError)) throw err;
        failures.push(err.code);
      }
    }
    await this.audit.record({
      actor: auditActorOf(user),
      action: 'memory.import.undo',
      target: `memory-import:${id}`,
      outcome: 'success',
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      metadata: { importId: id, rejected, failed: failures.length, failures },
    });
    return { import: await this.one(user, id), rejected, failed: failures.length };
  }
}
