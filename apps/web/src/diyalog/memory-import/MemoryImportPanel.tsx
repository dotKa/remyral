import { MEMORY_IMPORT_DESIGNED_FOR, MEMORY_IMPORT_PROMPTS, type Messages } from '@remyral/i18n';
import { type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { listProjects, type Project } from '../../api/directory';
import {
  type ApplyResult,
  applyImport,
  getImportOptions,
  IMPORT_ASSISTANTS,
  type ImportAssistant,
  type ImportBatch,
  type ImportOptions,
  type ImportPreview,
  type ImportRecordType,
  listImports,
  type PreviewItem,
  previewImport,
  typeFor,
  typesForScope,
  undoImport,
  unchecks,
} from '../../api/memoryImport';
import { cx } from '../../components/ui';
import { useFormat, useLocale, useT } from '../../i18n/I18nProvider';
import { useSubmit } from '../../screens/useSubmit';
import { DyConfirm, DyCopyButton } from '../common/actions';
import { DATE_TIME_NUMERIC } from '../common/time';
import { DyApiError, DyCheck, DyField, DyNotice, DyTextarea } from '../screens/forms';
import { DyButton, DyButtonLink, DySelect, EmptyLine, Panel, Pill, SkeletonRows } from '../screens/parts';

/**
 * p17-memory-import (docs/design/p17-memory-import.md §6): "Hafızanı içe aktar" — the export prompt (TR / EN, full /
 * short, copy), paste or read a file (in the browser, ≤ 256 KB), a preview that stores nothing, the review (include /
 * exclude, bulk selection, editable text, type and scope per item, the reasons a check flagged an item, duplicates and
 * twins), the import and "Bu içe aktarmayı geri al", and the person's earlier imports. Used by Ayarlar → Profil → İçe
 * aktar, the setup wizard's "Seni tanıyalım" step and (with `project`) the project Hafıza tab's link. Every imported text
 * comes from an outside assistant: rendered as plain text only.
 */

type Words = Messages['memoryImport'];

interface Row {
  include: boolean;
  text: string;
  type: ImportRecordType;
  scope: string;
}

const ACCEPT = '.md,.markdown,.txt,.json,.jsonl,text/plain,text/markdown,application/json';

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('read failed')); // i18n-ignore: never shown (badFile is)
    };
    reader.readAsText(file);
  });
}

/** Why an item was flagged, in the person's language (one line per flag). */
function flagText(t: Words, item: PreviewItem, flag: string, maxChars: number): string {
  const f = t.review.flags;
  if (flag.startsWith('instruction:')) {
    const k = flag.slice('instruction:'.length);
    return k in f.instruction ? f.instruction[k as keyof typeof f.instruction] : f.other({ flag });
  }
  switch (flag) {
    case 'secret':
      return f.secret;
    case 'personal_data':
      return f.personal_data;
    case 'sensitive':
      return f.sensitive;
    case 'too_long':
      return f.too_long({ max: maxChars });
    case 'too_short':
      return f.too_short;
    case 'duplicate':
      return f.duplicate({ title: item.duplicateOf?.title ?? '' });
    case 'duplicate_in_import':
      return f.duplicate_in_import({ n: (item.mergeInto ?? 0) + 1 });
    case 'similar':
      return f.similar({ title: item.similarTo?.title ?? '' });
    case 'contradicts':
      return f.contradicts({ title: item.contradicts?.title ?? '' });
    case 'time_bound':
      return f.time_bound;
    default:
      return f.other({ flag });
  }
}

function rowsOf(preview: ImportPreview): Row[] {
  return preview.items.map((it) => ({
    include: it.include && !it.blocked,
    text: it.text,
    type: it.proposedType,
    scope: it.proposedScope,
  }));
}

export function MemoryImportPanel(props: {
  /** Opened from a project's Hafıza tab: team items default to this project (when the person may write there). */
  readonly project?: string | null | undefined;
  /** The setup wizard: no list of earlier imports. */
  readonly compact?: boolean | undefined;
  /** After an import or an undo (the wizard re-reads its state). */
  readonly onChanged?: (() => void) | undefined;
}): ReactNode {
  const t = useT().memoryImport;
  const { locale } = useLocale();
  const project = props.project ?? null;
  const [options, setOptions] = useState<ImportOptions | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [promptLang, setPromptLang] = useState<'tr' | 'en'>(locale === 'en' ? 'en' : 'tr');
  const [variant, setVariant] = useState<'full' | 'short'>('full');
  const [assistant, setAssistant] = useState<ImportAssistant>('claude');
  const [otherLabel, setOtherLabel] = useState('');
  const [text, setText] = useState('');
  const [semantic, setSemantic] = useState(false);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [undone, setUndone] = useState<string | null>(null);
  const [historyTick, setHistoryTick] = useState(0);
  const load = useSubmit();
  const act = useSubmit();

  useEffect(() => {
    void load.run(async () => {
      const [o, ps] = await Promise.all([getImportOptions(), listProjects().catch(() => [] as Project[])]);
      setOptions(o);
      setProjects(ps);
    });
    // load.run is stable.
  }, []);

  const prompt = MEMORY_IMPORT_PROMPTS[promptLang][variant];
  const maxKb = Math.round((options?.maxBytes ?? 262144) / 1024);
  const maxChars = options?.maxItemChars ?? 1000;

  const scopeOptions = useMemo((): (readonly [string, string])[] => {
    if (options === null) return [];
    const out: (readonly [string, string])[] = [[options.personalScope, t.review.scopePersonal]];
    for (const p of projects) {
      if (p.myRole === 'viewer') continue;
      out.push([`project:${p.id}`, t.review.scopeProject({ project: p.name === '' ? p.id : p.name })]);
    }
    if (options.canGlobal) out.push(['global', t.review.scopeGlobal]);
    return out;
  }, [options, projects, t]);

  const setRow = (i: number, patch: Partial<Row>): void => {
    setRows((cur) => cur.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file === undefined) return;
    setLocalError(null);
    setFileNote(null);
    if (file.size > (options?.maxBytes ?? 262144)) {
      setLocalError(t.source.tooLarge({ kb: maxKb }));
      return;
    }
    readFile(file).then(
      (content) => {
        setText(content);
        setFileNote(t.source.fileRead({ name: file.name }));
      },
      () => {
        setLocalError(t.source.badFile);
      },
    );
  };

  const runPreview = (): void => {
    setLocalError(null);
    setResult(null);
    setUndone(null);
    if (byteLength(text) > (options?.maxBytes ?? 262144)) {
      setLocalError(t.source.tooLarge({ kb: maxKb }));
      return;
    }
    void act.run(async () => {
      const p = await previewImport({
        text,
        ...(project === null ? {} : { project }),
        semantic: semantic && options?.semanticAvailable === true,
      });
      setPreview(p);
      setRows(rowsOf(p));
    });
  };

  const selected = rows.filter((r, i) => r.include && preview?.items[i]?.blocked !== true).length;

  const runImport = (): void => {
    if (preview === null) return;
    const items = preview.items
      .map((it, i) => ({ it, row: rows[i] }))
      .filter(
        (x): x is { it: PreviewItem; row: Row } => x.row !== undefined && x.row.include && !x.it.blocked,
      )
      .map(({ it, row }) => ({
        kind: it.kind,
        text: row.text.trim(),
        type: typesForScope(row.scope).includes(row.type) ? row.type : typeFor(it.kind, row.scope),
        scope: row.scope,
        evidence: it.evidence,
        date: it.date,
      }));
    if (items.length === 0) return;
    void act.run(async () => {
      const out = await applyImport({
        assistant,
        ...(assistant === 'other'
          ? { assistantLabel: otherLabel.trim() === '' ? null : otherLabel.trim() }
          : {}),
        promptVersion: options?.promptVersion ?? null,
        format: preview.format,
        sha256: preview.sha256,
        bytes: preview.bytes,
        semantic: preview.semantic,
        items,
      });
      setResult(out);
      setPreview(null);
      setRows([]);
      setText('');
      setHistoryTick((n) => n + 1);
      props.onChanged?.();
    });
  };

  const undo = (batch: ImportBatch): void => {
    void act.run(async () => {
      const out = await undoImport(batch.id);
      setUndone(t.result.undone({ n: out.rejected }));
      setResult((cur) => (cur !== null && cur.import.id === batch.id ? { ...cur, import: out.import } : cur));
      setHistoryTick((n) => n + 1);
      props.onChanged?.();
    });
  };

  if (options === null)
    return load.error === null ? (
      <SkeletonRows label={t.loading} rows={2} />
    ) : (
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
    );

  return (
    <div className="flex flex-col gap-4" data-testid="dy-memory-import">
      <DyNotice tone="neutral" icon="shield">
        {t.untrusted}
      </DyNotice>

      <Panel title={t.prompt.title} sub={t.prompt.body} testId="memory-import-prompt">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 sm:max-w-[28rem]">
            <DySelect
              label={t.prompt.language}
              value={promptLang}
              options={[
                ['tr', t.prompt.languages.tr],
                ['en', t.prompt.languages.en],
              ]}
              onChange={(v) => {
                setPromptLang(v === 'en' ? 'en' : 'tr');
              }}
            />
            <DySelect
              label={t.prompt.variant}
              value={variant}
              options={[
                ['full', t.prompt.full],
                ['short', t.prompt.short],
              ]}
              onChange={(v) => {
                setVariant(v === 'short' ? 'short' : 'full');
              }}
            />
          </div>
          {variant === 'short' ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.prompt.shortHint}</p>
          ) : null}
          <DyTextarea
            label={t.prompt.textLabel}
            value={prompt}
            onChange={() => undefined}
            readOnly
            rows={variant === 'short' ? 5 : 10}
            mono
            data-testid="memory-import-prompt-text"
            className="text-[0.8125rem]"
          />
          <div className="flex flex-wrap items-center gap-3">
            <DyCopyButton text={prompt} label={t.prompt.copy} testId="memory-import-copy" />
            <span className="text-[0.8125rem] text-dy-muted" data-testid="memory-import-designed">
              {t.prompt.designedFor({ names: MEMORY_IMPORT_DESIGNED_FOR.join(', ') })}
            </span>
            <Pill tone="neutral">{t.prompt.version({ n: options.promptVersion })}</Pill>
          </div>
        </div>
      </Panel>

      <Panel title={t.source.title} testId="memory-import-source">
        <div className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-2 sm:max-w-[32rem]">
            <DySelect
              label={t.source.assistant}
              value={assistant}
              options={IMPORT_ASSISTANTS.map((a) => [a, t.source.assistants[a]] as const)}
              onChange={(v) => {
                const a = IMPORT_ASSISTANTS.find((x) => x === v);
                if (a !== undefined) setAssistant(a);
              }}
            />
            {assistant === 'other' ? (
              <DyField
                label={t.source.otherLabel}
                value={otherLabel}
                maxLength={40}
                onChange={setOtherLabel}
              />
            ) : null}
          </div>
          <DyTextarea
            label={t.source.text}
            placeholder={t.source.placeholder}
            value={text}
            rows={8}
            mono
            onChange={(v) => {
              setText(v);
              setFileNote(null);
            }}
            data-testid="memory-import-text"
          />
          <div className="flex flex-col gap-1">
            <label className="text-[0.8125rem] font-bold">
              {t.source.file}
              <input
                type="file"
                accept={ACCEPT}
                onChange={onFile}
                data-testid="memory-import-file"
                className="mt-1 block w-full text-[0.8125rem] font-normal"
              />
            </label>
            <p className="m-0 text-[0.78125rem] text-dy-muted">{t.source.fileHint({ kb: maxKb })}</p>
            {fileNote === null ? null : (
              <p className="m-0 text-[0.8125rem]" data-testid="memory-import-file-note">
                {fileNote}
              </p>
            )}
          </div>
          {options.semanticAvailable ? (
            <DyCheck
              label={t.source.semantic}
              hint={t.source.semanticHint}
              checked={semantic}
              onChange={setSemantic}
              testId="memory-import-semantic"
            />
          ) : (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.source.semanticUnavailable}</p>
          )}
          {localError === null ? null : (
            <DyNotice tone="red" live>
              <span data-testid="memory-import-local-error">{localError}</span>
            </DyNotice>
          )}
          <div>
            <DyButton
              variant="primary"
              busy={act.busy && preview === null}
              disabled={text.trim() === ''}
              onClick={runPreview}
              data-testid="memory-import-preview"
            >
              {t.source.preview}
            </DyButton>
          </div>
        </div>
      </Panel>

      <DyApiError error={act.error} retryLeft={act.retryLeft} />

      {result === null ? null : (
        <ResultNotice
          result={result}
          undone={undone}
          busy={act.busy}
          onUndo={() => {
            undo(result.import);
          }}
        />
      )}
      {undone !== null && result === null ? (
        <DyNotice tone="green" live>
          <span data-testid="memory-import-undone">{undone}</span>
        </DyNotice>
      ) : null}

      {preview === null ? null : (
        <Panel
          title={t.review.title}
          sub={t.review.summary({ n: preview.items.length, selected })}
          testId="memory-import-review"
        >
          <ReviewList
            t={t}
            preview={preview}
            rows={rows}
            setRow={setRow}
            setRows={setRows}
            scopeOptions={scopeOptions}
            maxChars={maxChars}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-dy-line pt-3">
            <DyButton
              variant="primary"
              busy={act.busy}
              disabled={selected === 0}
              onClick={runImport}
              data-testid="memory-import-apply"
            >
              {t.review.import({ n: selected })}
            </DyButton>
            <DyButton
              variant="ghost"
              onClick={() => {
                setPreview(null);
                setRows([]);
              }}
            >
              {t.review.startOver}
            </DyButton>
            {selected === 0 ? (
              <span className="text-[0.8125rem] text-dy-muted">{t.review.nothingSelected}</span>
            ) : null}
          </div>
        </Panel>
      )}

      {props.compact === true ? null : <History t={t} tick={historyTick} busy={act.busy} onUndo={undo} />}
    </div>
  );
}

function ResultNotice(props: {
  readonly result: ApplyResult;
  readonly undone: string | null;
  readonly busy: boolean;
  readonly onUndo: () => void;
}): ReactNode {
  const t = useT().memoryImport;
  const r = props.result;
  const failures = r.results.filter((x) => !x.ok);
  const codes = t.result.codes;
  return (
    <DyNotice
      tone={r.import.itemsImported > 0 ? 'green' : 'amber'}
      live
      testId="memory-import-result"
      title={t.result.done({ n: r.import.itemsImported, source: r.import.source })}
      action={
        r.import.undoneAt === null && r.import.activeRecords > 0 ? (
          <DyConfirm
            label={t.result.undo}
            confirmLabel={t.result.undoConfirm}
            question={t.result.undoQuestion}
            variant="warn"
            busy={props.busy}
            onConfirm={props.onUndo}
            testId="memory-import-undo"
          />
        ) : undefined
      }
    >
      {failures.length > 0 ? (
        <span className="block">
          {t.result.failed({ n: failures.length })}{' '}
          {failures
            .map((f) =>
              t.result.failure({
                n: f.index + 1,
                why: f.code !== null && f.code in codes ? codes[f.code as keyof typeof codes] : codes.other,
              }),
            )
            .join(' · ')}
        </span>
      ) : null}
      {props.undone === null ? null : (
        <span className="block" data-testid="memory-import-undone">
          {props.undone}
        </span>
      )}
      {r.import.scopes.some((s) => s.startsWith('user:')) && r.import.undoneAt === null ? (
        <span className="block">
          <DyButtonLink to="/settings/profile?tab=rules" variant="ghost">
            {t.result.openRules}
          </DyButtonLink>
        </span>
      ) : null}
    </DyNotice>
  );
}

function ReviewList(props: {
  readonly t: Words;
  readonly preview: ImportPreview;
  readonly rows: readonly Row[];
  readonly setRow: (i: number, patch: Partial<Row>) => void;
  readonly setRows: (fn: (cur: Row[]) => Row[]) => void;
  readonly scopeOptions: readonly (readonly [string, string])[];
  readonly maxChars: number;
}): ReactNode {
  const { t, preview } = props;
  const tr = t.review;
  const bulk = (pick: (it: PreviewItem) => boolean): void => {
    props.setRows((cur) =>
      cur.map((r, i) => ({
        ...r,
        include: !preview.items[i]?.blocked && pick(preview.items[i] as PreviewItem),
      })),
    );
  };
  if (preview.items.length === 0) return <EmptyLine testId="memory-import-empty">{tr.empty}</EmptyLine>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 text-[0.8125rem] text-dy-muted">
        {preview.semantic ? <span>{tr.semanticOn}</span> : null}
        {preview.semanticFailed ? <span>{tr.semanticFailed}</span> : null}
        {preview.truncated ? <span>{tr.truncated({ max: preview.items.length })}</span> : null}
        {preview.issues.length > 0 ? (
          <span data-testid="memory-import-issues">
            {tr.issues({ n: preview.issues.length })}{' '}
            {preview.issues
              .slice(0, 5)
              .map((i) =>
                tr.issueLine({
                  line: i.line,
                  what:
                    i.code in tr.issueCodes ? tr.issueCodes[i.code as keyof typeof tr.issueCodes] : i.code,
                }),
              )
              .join(' · ')}
          </span>
        ) : null}
        <span>{tr.flaggedNote}</span>
        <span>{tr.personalNote}</span>
      </div>
      <div role="group" aria-label={tr.bulk} className="flex flex-wrap gap-2">
        <DyButton
          onClick={() => {
            bulk(() => true);
          }}
        >
          {tr.selectAll}
        </DyButton>
        <DyButton
          onClick={() => {
            bulk(() => false);
          }}
        >
          {tr.selectNone}
        </DyButton>
        <DyButton
          onClick={() => {
            bulk((it) => !it.flags.some(unchecks));
          }}
        >
          {tr.selectClean}
        </DyButton>
      </div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0" data-testid="memory-import-items">
        {preview.items.map((it, i) => {
          const row = props.rows[i];
          if (row === undefined) return null;
          const types = typesForScope(row.scope);
          const flagged = it.flags.filter(unchecks);
          const notes = it.flags.filter((f) => !unchecks(f));
          return (
            <li
              key={it.index}
              data-testid="memory-import-item"
              data-flags={it.flags.join(' ')}
              className={cx(
                'flex flex-col gap-2 rounded-[12px] border p-3',
                row.include ? 'border-dy-teal bg-dy-card' : 'border-dy-line bg-dy-sunk/40',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <DyCheck
                  label={tr.include({ n: i + 1 })}
                  checked={row.include && !it.blocked}
                  disabled={it.blocked}
                  onChange={(v) => {
                    props.setRow(i, { include: v });
                  }}
                  testId={`memory-import-include-${String(i)}`}
                />
                <Pill tone="neutral">{tr.kind[it.kind]}</Pill>
                {it.guessed ? <span className="text-[0.75rem] text-dy-muted">{tr.guessed}</span> : null}
                {it.scopeHint === 'team' ? (
                  <span className="text-[0.75rem] text-dy-muted">{tr.teamHint}</span>
                ) : null}
              </div>
              <DyTextarea
                label={tr.text({ n: i + 1 })}
                value={row.text}
                rows={2}
                maxLength={props.maxChars}
                onChange={(v) => {
                  props.setRow(i, { text: v });
                }}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <DySelect
                  label={tr.scope}
                  value={row.scope}
                  options={props.scopeOptions}
                  onChange={(v) => {
                    props.setRow(i, {
                      scope: v,
                      type: typesForScope(v).includes(row.type) ? row.type : typeFor(it.kind, v),
                    });
                  }}
                />
                <DySelect
                  label={tr.type}
                  value={row.type}
                  options={types.map((x) => [x, tr.types[x]] as const)}
                  onChange={(v) => {
                    const next = types.find((x) => x === v);
                    if (next !== undefined) props.setRow(i, { type: next });
                  }}
                />
              </div>
              {it.evidence !== null || it.date !== null ? (
                <p className="m-0 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
                  {[
                    it.evidence === null ? null : tr.evidence({ text: it.evidence }),
                    it.date === null ? null : tr.date({ date: it.date }),
                  ]
                    .filter((x): x is string => x !== null)
                    .join(' · ')}
                </p>
              ) : null}
              {flagged.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="memory-import-flags">
                  {flagged.map((f) => (
                    <li
                      key={f}
                      className="text-[0.8125rem] font-medium text-dy-red-ink [overflow-wrap:anywhere]"
                    >
                      {flagText(t, it, f, props.maxChars)}
                    </li>
                  ))}
                </ul>
              ) : null}
              {notes.length > 0 || it.mergedFrom.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[0.8125rem] text-dy-muted">
                  {notes.map((f) => (
                    <li key={f} className="[overflow-wrap:anywhere]">
                      {flagText(t, it, f, props.maxChars)}
                    </li>
                  ))}
                  {it.mergedFrom.length > 0 ? (
                    <li data-testid="memory-import-merged">
                      {tr.flags.merged({ list: it.mergedFrom.map((m) => String(m + 1)).join(', ') })}
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function History(props: {
  readonly t: Words;
  readonly tick: number;
  readonly busy: boolean;
  readonly onUndo: (b: ImportBatch) => void;
}): ReactNode {
  const { t } = props;
  const fmt = useFormat();
  const [items, setItems] = useState<ImportBatch[] | null>(null);
  const load = useSubmit();
  const reload = useCallback(() => {
    void load.run(async () => {
      setItems(await listImports());
    });
    // load.run is stable.
  }, []);
  useEffect(() => {
    reload();
  }, [reload, props.tick]);
  return (
    <Panel title={t.history.title} testId="memory-import-history">
      {items === null ? (
        load.error === null ? (
          <SkeletonRows label={t.loading} rows={1} />
        ) : (
          <DyApiError error={load.error} retryLeft={load.retryLeft} />
        )
      ) : items.length === 0 ? (
        <EmptyLine testId="memory-import-history-empty">{t.history.empty}</EmptyLine>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((b) => (
            <li
              key={b.id}
              data-testid="memory-import-batch"
              className="flex flex-wrap items-center justify-between gap-2 border-t border-dy-line pt-2 first:border-t-0 first:pt-0"
            >
              <div className="min-w-0">
                <p className="m-0 font-medium [overflow-wrap:anywhere]">
                  {t.history.line({ source: b.source, imported: b.itemsImported, total: b.itemsTotal })}
                </p>
                <p className="m-0 text-[0.8125rem] text-dy-muted">
                  <time dateTime={b.createdAt}>{fmt.dateWith(b.createdAt, DATE_TIME_NUMERIC)}</time>
                  {' · '}
                  {b.undoneAt === null
                    ? t.history.active({ n: b.activeRecords })
                    : t.history.undoneAt({ when: fmt.dateWith(b.undoneAt, DATE_TIME_NUMERIC) })}
                </p>
              </div>
              {b.undoneAt === null && b.activeRecords > 0 ? (
                <DyConfirm
                  label={t.result.undo}
                  confirmLabel={t.result.undoConfirm}
                  question={t.result.undoQuestion}
                  variant="warn"
                  busy={props.busy}
                  onConfirm={() => {
                    props.onUndo(b);
                  }}
                  testId="memory-import-history-undo"
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
