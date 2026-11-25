import { useErrorText } from '../../../../i18n/errors';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  type ConflictReason,
  type Created,
  createPersonal,
  createRecord,
  editPersonal,
  editRecord,
  type EditRecord,
  type Evidence,
  getRecord,
  listRecords,
  markReviewed,
  type MemoryRecord,
  RECORD_TYPES,
  type RecordConflict,
  type RecordHistory,
  type RecordStatus,
  type RecordType,
  recordHref,
  resolveConflict,
  RUNTIMES,
  runtimeName,
  setPersonalStatus,
  setRecordStatus,
  supersedeRecord,
} from '../../../../api/memoryRecords';
import { undoSuggestion } from '../../../../api/memorySuggestions';
import { cx } from '../../../../components/ui';
import { expiryIso, parseTags } from '../../../../screens/memory/recordFields';
import { useSubmit } from '../../../../screens/useSubmit';
import type { Tone } from '../../../tone';
import { DyApiError, DyDetails, DyField, DyNotice, DyTextarea, FormActions, FormGrid } from '../../forms';
import { DyButton, DySearch, DySelect, Pill, SkeletonRows } from '../../parts';
import type { Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from '../../../common/time';

/**
 * p12-diyalog wave 2 (W3) — the typed memory building blocks in the Diyalog language (p11-memory-layers): a record
 * with its actions (edit, supersede, expire, reject, reactivate, mark reviewed, history), the new-record form,
 * possible conflicts (supersede / keep both), the decision timeline and the filtered, grouped record list. Same
 * calls and bodies as the former classic record views (their field helpers: `screens/memory/recordFields.ts`); `api`
 * picks the project / global API or the caller's personal rules, so Settings → Context and Profile can reuse these.
 * Every text can come from an agent: plain React text only; evidence URLs only when http(s).
 */

export type RecordApi = 'records' | 'personal';

/** p14-i18n-screens-c: the words of the memory views (`projectTabs.memory`). */
export type MemoryWords = Messages['projectTabs']['memory'];

const STATUS_TONE: Readonly<Record<RecordStatus, Tone>> = {
  active: 'teal',
  superseded: 'neutral',
  expired: 'neutral',
  rejected: 'red',
};

/** Why two records may conflict, in the user's language. */
export function reasonText(t: MemoryWords, reason: ConflictReason): string {
  return t.reason[reason];
}

/** "Proje", "Proje · yalnız Codex", "Genel", "Codex (tüm projeler)", "Kişisel". */
export function scopeText(t: MemoryWords, scope: string): string {
  if (scope === 'global') return t.scope.global;
  if (scope.startsWith('user:')) return t.scope.personal;
  const plus = /^project:[^+]+\+runtime:(.+)$/.exec(scope);
  if (plus?.[1] !== undefined) return t.scope.projectRuntime({ runtime: runtimeName(plus[1]) });
  if (scope.startsWith('project:')) return t.scope.project;
  if (scope.startsWith('runtime:'))
    return t.scope.runtime({ runtime: runtimeName(scope.slice('runtime:'.length)) });
  return scope;
}

const ASSISTANT_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude', // i18n-ignore: product name
  chatgpt: 'ChatGPT', // i18n-ignore: product name
  gemini: 'Gemini', // i18n-ignore: product name
  copilot: 'Copilot', // i18n-ignore: product name
};

/** p17-memory-import: "Claude", "ChatGPT", … or the name the person gave for another assistant. */
function importSource(ti: Messages['memoryImport'], i: NonNullable<MemoryRecord['imported']>): string {
  return ASSISTANT_NAMES[i.assistant] ?? i.assistantLabel ?? ti.otherAssistant;
}

function isoDate(iso: string | null): string {
  if (iso === null) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const SAFE_URL = /^https?:\/\/[^\s]+$/i;
const LINK = 'text-dy-teal-ink [@media(hover:hover)_and_(pointer:fine)]:hover:underline';

function EvidenceItem(props: { readonly e: Evidence }): ReactNode {
  const { e } = props;
  const t = useT().projectTabs.memory;
  const label = e.label ?? '';
  switch (e.kind) {
    case 'job':
      return (
        <Link to={`/jobs/${encodeURIComponent(e.ref)}`} className={LINK}>
          {label === '' ? t.evidenceJob({ id: e.ref.slice(0, 8) }) : label}
        </Link>
      );
    case 'chat':
      return <span>{label === '' ? t.evidenceChat : t.evidenceChatLabel({ label })}</span>;
    case 'url':
      return SAFE_URL.test(e.ref) ? (
        <a href={e.ref} target="_blank" rel="noopener noreferrer" className={LINK}>
          {label === '' ? e.ref : label}
        </a>
      ) : (
        <span className="font-dy-mono break-all">{e.ref}</span>
      );
    default:
      return (
        <span>
          {label === '' ? null : `${label} `}
          <span className="font-dy-mono break-all">{e.ref}</span>
        </span>
      );
  }
}

function RecordLink(props: {
  readonly from: MemoryRecord;
  readonly id: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Link
      to={recordHref({ id: props.id, scope: props.from.scope, project: props.from.project })}
      className={LINK}
    >
      {props.children}
    </Link>
  );
}

type PanelKind = 'edit' | 'supersede' | 'expire' | 'reject' | 'reviewed' | 'history' | null;

function PanelBox(props: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <div
      className="mt-3 flex flex-col gap-3 border-t border-dy-line pt-3"
      role="group"
      aria-label={props.label}
    >
      {props.children}
    </div>
  );
}

export function RecordItem(props: {
  readonly record: MemoryRecord;
  readonly api: RecordApi;
  readonly candidates?: readonly MemoryRecord[];
  readonly highlight?: boolean;
  readonly onChanged: (notice: string) => void;
}): ReactNode {
  const r = props.record;
  const all = useT();
  const fmt = useFormat();
  const words = all.projectTabs;
  const t = words.memory;
  const ta = words.suggestions.auto;
  const ti = all.memoryImport;
  const [panel, setPanel] = useState<PanelKind>(null);
  const act = useSubmit();
  const ref = useRef<HTMLLIElement>(null);
  const writable = r.canWrite || props.api === 'personal';
  const personal = props.api === 'personal';

  useEffect(() => {
    const el = ref.current;
    if (props.highlight !== true || el === null || typeof el.scrollIntoView !== 'function') return;
    el.scrollIntoView({ block: 'center' });
  }, [props.highlight]);

  const toggle = (p: PanelKind): void => {
    act.clearError();
    setPanel((cur) => (cur === p ? null : p));
  };
  const done = (notice: string): void => {
    setPanel(null);
    props.onChanged(notice);
  };
  const reactivate = (): void => {
    void act.run(async () => {
      if (personal) await setPersonalStatus(r.id, 'active');
      else await setRecordStatus(r.id, 'active');
      done(t.reactivated({ title: r.title }));
    });
  };

  return (
    <li
      ref={ref}
      id={`record-${r.id}`}
      data-testid="memory-record"
      data-record-id={r.id}
      className={cx(
        'min-w-0 rounded-[12px] border bg-dy-card p-3.5',
        props.highlight === true ? 'border-dy-teal ring-2 ring-dy-teal/30' : 'border-dy-line',
        r.status !== 'active' && 'opacity-85',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-bold [overflow-wrap:anywhere]">{r.title}</span>
        <Pill tone="neutral">{t.type[r.type]}</Pill>
        <span data-testid="record-status">
          <Pill tone={STATUS_TONE[r.status]}>{t.status[r.status]}</Pill>
        </span>
        <span data-testid="record-scope">
          <Pill tone="neutral">{scopeText(t, r.scope)}</Pill>
        </span>
        {r.autoLearned !== null ? (
          <span data-testid="record-auto-badge">
            <Pill
              tone={r.status === 'active' ? 'violet' : 'neutral'}
              icon="brain"
              title={ta.badgeTitle({
                confidence: r.autoLearned.confidence.toFixed(2),
                sources: r.autoLearned.sources,
              })}
            >
              {ta.badge}
            </Pill>
          </span>
        ) : null}
        {r.imported !== null ? (
          <span data-testid="record-import-badge">
            <Pill
              tone="neutral"
              icon="inbox"
              title={ti.badgeTitle({ when: fmt.dateWith(r.imported.at, DATE_TIME_NUMERIC) })}
            >
              {ti.badge({ source: importSource(ti, r.imported) })}
            </Pill>
          </span>
        ) : null}
        {r.reviewDue && r.status === 'active' ? (
          <span data-testid="record-review-due">
            <Pill tone="amber" icon="clock">
              {t.reviewDue}
            </Pill>
          </span>
        ) : null}
      </div>
      <p
        className="m-0 mt-1.5 text-[0.9375rem] whitespace-pre-wrap [overflow-wrap:anywhere]"
        data-testid="record-statement"
      >
        {r.statement}
      </p>
      {r.rationale !== null ? (
        <p className="m-0 mt-1 text-[0.8125rem] whitespace-pre-wrap text-dy-muted [overflow-wrap:anywhere]">
          {t.why({ text: r.rationale })}
        </p>
      ) : null}
      {r.type === 'decision' && (r.consequences !== null || r.decidedOn !== null || r.decidedBy !== null) ? (
        <p className="m-0 mt-1 text-[0.8125rem] whitespace-pre-wrap text-dy-muted [overflow-wrap:anywhere]">
          {r.decidedOn !== null ? t.decidedOn({ date: r.decidedOn }) : t.decided}
          {r.decidedBy !== null ? ` (${r.decidedBy})` : ''}
          {r.consequences !== null ? t.consequencesLine({ text: r.consequences }) : ''}
        </p>
      ) : null}
      {r.content.trim() !== r.statement.trim() ? (
        <DyDetails summary={t.contentForAgents} className="mt-2">
          <pre className="m-0 max-h-48 overflow-auto font-dy-mono text-[0.78125rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {r.content}
          </pre>
        </DyDetails>
      ) : null}
      <p className="m-0 mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.78125rem] text-dy-muted">
        <span>
          {t.writtenBy({ author: t.author[r.author] })}
          {r.authorRef !== null && r.author !== 'human' ? ` (${r.authorRef})` : ''}
          {` · v${String(r.version)}`}
        </span>
        {r.reviewBy !== null ? (
          <span className={r.reviewDue ? 'font-bold text-dy-amber-ink' : undefined}>
            {t.reviewBy({ date: r.reviewBy })}
          </span>
        ) : null}
        {r.expiresAt !== null ? <span>{t.expires({ date: isoDate(r.expiresAt) })}</span> : null}
        {r.tags.length > 0 ? <span>{t.tags({ list: r.tags.join(', ') })}</span> : null}
      </p>
      {r.evidence.length > 0 ? (
        <p
          className="m-0 mt-1 flex flex-wrap gap-x-2 text-[0.78125rem] text-dy-muted"
          data-testid="record-evidence"
        >
          <span>{t.evidence}</span>
          {r.evidence.map((e, i) => (
            <span key={`${e.kind}:${e.ref}:${String(i)}`}>
              <EvidenceItem e={e} />
            </span>
          ))}
        </p>
      ) : null}
      {r.supersededBy !== null || r.supersedes !== null || r.statusReason !== null ? (
        <p className="m-0 mt-1 flex flex-wrap gap-x-3 text-[0.78125rem] text-dy-muted">
          {r.supersededBy !== null ? (
            <span>
              {t.replacedA}
              <RecordLink from={r} id={r.supersededBy}>
                {t.replacedLink}
              </RecordLink>
              {t.replacedB}
            </span>
          ) : null}
          {r.supersedes !== null ? (
            <span>
              <RecordLink from={r} id={r.supersedes}>
                {t.replacesLink}
              </RecordLink>
              {t.replacesB}
            </span>
          ) : null}
          {r.statusReason !== null && r.status !== 'active' ? (
            <span>{t.why({ text: r.statusReason })}</span>
          ) : null}
        </p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap gap-2">
        {writable &&
        r.status === 'active' &&
        r.autoLearned !== null &&
        r.suggestionId !== null &&
        !personal ? (
          <DyButton
            variant="danger"
            icon="retry"
            busy={act.busy}
            onClick={() => {
              const id = r.suggestionId;
              if (id === null) return;
              void act.run(async () => {
                await undoSuggestion(id);
                done(ta.undoneNotice({ title: r.title }));
              });
            }}
          >
            {ta.undo}
          </DyButton>
        ) : null}
        {writable && r.status === 'active' ? (
          <>
            <DyButton
              icon="pen"
              aria-expanded={panel === 'edit'}
              onClick={() => {
                toggle('edit');
              }}
            >
              {t.edit}
            </DyButton>
            {personal ? (
              <DyButton
                busy={act.busy}
                onClick={() => {
                  void act.run(async () => {
                    await setPersonalStatus(r.id, 'expired');
                    done(t.retired({ title: r.title }));
                  });
                }}
              >
                {t.retire}
              </DyButton>
            ) : (
              <>
                <DyButton
                  aria-expanded={panel === 'supersede'}
                  onClick={() => {
                    toggle('supersede');
                  }}
                >
                  {t.supersede}
                </DyButton>
                <DyButton
                  aria-expanded={panel === 'expire'}
                  onClick={() => {
                    toggle('expire');
                  }}
                >
                  {t.expire}
                </DyButton>
                <DyButton
                  variant="danger"
                  aria-expanded={panel === 'reject'}
                  onClick={() => {
                    toggle('reject');
                  }}
                >
                  {t.reject}
                </DyButton>
                <DyButton
                  aria-expanded={panel === 'reviewed'}
                  onClick={() => {
                    toggle('reviewed');
                  }}
                >
                  {t.reviewed}
                </DyButton>
              </>
            )}
          </>
        ) : null}
        {writable && (r.status === 'expired' || r.status === 'rejected') ? (
          <DyButton icon="retry" busy={act.busy} onClick={reactivate}>
            {t.reactivate}
          </DyButton>
        ) : null}
        {personal ? null : (
          <DyButton
            variant="ghost"
            aria-expanded={panel === 'history'}
            onClick={() => {
              toggle('history');
            }}
          >
            {t.history}
          </DyButton>
        )}
      </div>
      {panel === null ? <DyApiError error={act.error} retryLeft={act.retryLeft} className="mt-2" /> : null}
      {panel === 'edit' ? (
        <EditForm
          record={r}
          api={props.api}
          onDone={done}
          onCancel={() => {
            setPanel(null);
          }}
        />
      ) : null}
      {panel === 'supersede' ? (
        <SupersedePanel
          record={r}
          candidates={props.candidates ?? []}
          onDone={done}
          onCancel={() => {
            setPanel(null);
          }}
        />
      ) : null}
      {panel === 'expire' || panel === 'reject' ? (
        <StatusPanel
          record={r}
          status={panel === 'expire' ? 'expired' : 'rejected'}
          onDone={done}
          onCancel={() => {
            setPanel(null);
          }}
        />
      ) : null}
      {panel === 'reviewed' ? (
        <ReviewedPanel
          record={r}
          onDone={done}
          onCancel={() => {
            setPanel(null);
          }}
        />
      ) : null}
      {panel === 'history' ? <HistoryPanel record={r} /> : null}
    </li>
  );
}

function EditForm(props: {
  readonly record: MemoryRecord;
  readonly api: RecordApi;
  readonly onDone: (notice: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const r = props.record;
  const t = useT().projectTabs.memory;
  const [title, setTitle] = useState(r.title);
  const [statement, setStatement] = useState(r.statement);
  const [rationale, setRationale] = useState(r.rationale ?? '');
  const [consequences, setConsequences] = useState(r.consequences ?? '');
  const [decidedOn, setDecidedOn] = useState(r.decidedOn ?? '');
  const [decidedBy, setDecidedBy] = useState(r.decidedBy ?? '');
  const [tags, setTags] = useState(r.tags.join(', '));
  const [reviewBy, setReviewBy] = useState(r.reviewBy ?? '');
  const [expires, setExpires] = useState(isoDate(r.expiresAt));
  const act = useSubmit();
  const decision = r.type === 'decision';
  return (
    <form
      className="mt-3 flex flex-col gap-3 border-t border-dy-line pt-3"
      aria-label={t.editForm({ title: r.title })}
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(async () => {
          const body: EditRecord = {
            expectedVersion: r.version,
            statement: statement.trim(),
            ...(title.trim() === '' ? {} : { title: title.trim() }),
            rationale: rationale.trim() === '' ? null : rationale.trim(),
            tags: parseTags(tags),
            reviewBy: reviewBy === '' ? null : reviewBy,
            expiresAt: expiryIso(expires),
            ...(decision
              ? {
                  consequences: consequences.trim() === '' ? null : consequences.trim(),
                  decidedOn: decidedOn === '' ? null : decidedOn,
                  decidedBy: decidedBy.trim() === '' ? null : decidedBy.trim(),
                }
              : {}),
          };
          if (props.api === 'personal') await editPersonal(r.id, body);
          else await editRecord(r.id, body);
          props.onDone(t.saved({ title: title.trim() === '' ? r.title : title.trim() }));
        });
      }}
    >
      <DyField label={t.title} value={title} maxLength={200} onChange={setTitle} />
      <DyTextarea
        label={t.statement}
        value={statement}
        onChange={setStatement}
        rows={3}
        maxLength={2000}
        required
      />
      <DyTextarea label={t.rationale} value={rationale} onChange={setRationale} rows={2} maxLength={2000} />
      {decision ? (
        <>
          <DyTextarea
            label={t.consequences}
            value={consequences}
            onChange={setConsequences}
            rows={2}
            maxLength={2000}
          />
          <FormGrid>
            <DyField label={t.decidedOnField} type="date" value={decidedOn} onChange={setDecidedOn} />
            <DyField label={t.decidedBy} value={decidedBy} maxLength={120} onChange={setDecidedBy} />
          </FormGrid>
        </>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <DyField label={t.tagsField} hint={t.commaHint} value={tags} onChange={setTags} />
        <DyField label={t.reviewDate} type="date" value={reviewBy} onChange={setReviewBy} />
        <DyField label={t.expiresField} type="date" value={expires} onChange={setExpires} />
      </div>
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
      {act.error?.status === 409 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.conflict409}</p>
      ) : null}
      <FormActions>
        <DyButton type="submit" variant="primary" busy={act.busy} disabled={statement.trim() === ''}>
          {t.save}
        </DyButton>
        <DyButton variant="ghost" onClick={props.onCancel}>
          {t.cancel}
        </DyButton>
      </FormActions>
    </form>
  );
}

const NEW = '__new__';

function SupersedePanel(props: {
  readonly record: MemoryRecord;
  readonly candidates: readonly MemoryRecord[];
  readonly onDone: (notice: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const r = props.record;
  const t = useT().projectTabs.memory;
  const options = props.candidates.filter((c) => c.id !== r.id && c.type === r.type && c.status === 'active');
  const [by, setBy] = useState(options[0]?.id ?? NEW);
  const [reason, setReason] = useState('');
  const act = useSubmit();
  return (
    <PanelBox label={t.supersedeLabel({ title: r.title })}>
      <p className="m-0 text-[0.8125rem] text-dy-muted">{t.supersedeHint({ title: r.title })}</p>
      <DySelect
        label={t.replacement}
        value={by}
        options={[
          ...options.map((c) => [c.id, c.title] as const),
          [NEW, t.replaceWithNew({ type: t.typeLower[r.type] })] as const,
        ]}
        onChange={setBy}
      />
      {by === NEW ? (
        <NewRecordForm
          scopeMode={{ fixed: r.scope }}
          fixedType={r.type}
          supersedes={r.id}
          submitLabel={t.replace}
          onCreated={() => {
            props.onDone(t.replacedWithNew({ title: r.title, type: t.typeLower[r.type] }));
          }}
          onCancel={props.onCancel}
        />
      ) : (
        <>
          <DyField label={t.reasonOptional} value={reason} maxLength={500} onChange={setReason} />
          <DyApiError error={act.error} retryLeft={act.retryLeft} />
          <FormActions>
            <DyButton
              variant="primary"
              busy={act.busy}
              onClick={() => {
                void act.run(async () => {
                  const out = await supersedeRecord(r.id, by, reason.trim());
                  props.onDone(t.superseded({ title: r.title, by: out.replacement.title }));
                });
              }}
            >
              {t.supersede}
            </DyButton>
            <DyButton variant="ghost" onClick={props.onCancel}>
              {t.cancel}
            </DyButton>
          </FormActions>
        </>
      )}
    </PanelBox>
  );
}

function StatusPanel(props: {
  readonly record: MemoryRecord;
  readonly status: 'expired' | 'rejected';
  readonly onDone: (notice: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const r = props.record;
  const t = useT().projectTabs.memory;
  const [reason, setReason] = useState('');
  const act = useSubmit();
  const expire = props.status === 'expired';
  return (
    <PanelBox label={expire ? t.expireLabel({ title: r.title }) : t.rejectLabel({ title: r.title })}>
      <p className="m-0 text-[0.8125rem] text-dy-muted">{expire ? t.expireHint : t.rejectHint}</p>
      <DyField label={t.reasonOptional} value={reason} maxLength={500} onChange={setReason} />
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
      <FormActions>
        <DyButton
          variant="danger"
          busy={act.busy}
          onClick={() => {
            void act.run(async () => {
              await setRecordStatus(r.id, props.status, reason.trim());
              props.onDone(t.statusDone({ title: r.title, status: t.statusLower[props.status] }));
            });
          }}
        >
          {expire ? t.expire : t.reject}
        </DyButton>
        <DyButton variant="ghost" onClick={props.onCancel}>
          {t.cancel}
        </DyButton>
      </FormActions>
    </PanelBox>
  );
}

function ReviewedPanel(props: {
  readonly record: MemoryRecord;
  readonly onDone: (notice: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const r = props.record;
  const t = useT().projectTabs.memory;
  const [next, setNext] = useState('');
  const act = useSubmit();
  return (
    <PanelBox label={t.reviewedLabel({ title: r.title })}>
      <DyField label={t.nextReview} type="date" value={next} onChange={setNext} wrapClassName="max-w-xs" />
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
      <FormActions>
        <DyButton
          variant="primary"
          busy={act.busy}
          onClick={() => {
            void act.run(async () => {
              await markReviewed(r.id, next === '' ? null : next);
              props.onDone(
                next === '' ? t.reviewedDone({ title: r.title }) : t.reviewedNext({ title: r.title, next }),
              );
            });
          }}
        >
          {t.reviewed}
        </DyButton>
        <DyButton variant="ghost" onClick={props.onCancel}>
          {t.cancel}
        </DyButton>
      </FormActions>
    </PanelBox>
  );
}

function HistoryPanel(props: { readonly record: MemoryRecord }): ReactNode {
  const sayError = useErrorText();
  const fmt = useFormat();
  const t = useT().projectTabs.memory;
  const actions: Readonly<Record<string, string>> = t.action;
  const [data, setData] = useState<RecordHistory | null>(null);
  const load = useSubmit();
  const id = props.record.id;
  useEffect(() => {
    void load.run(async () => {
      setData(await getRecord(id));
    });
    // load.run is stable.
  }, [id]);
  return (
    <PanelBox label={t.historyLabel({ title: props.record.title })}>
      {load.error !== null ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="memory-load-error">
          {t.historyFailed({ reason: sayError(load.error) })}
        </p>
      ) : null}
      {data === null ? (
        load.error === null ? (
          <SkeletonRows label={t.historyLoading} rows={2} />
        ) : null
      ) : (
        <>
          <ol className="m-0 flex list-none flex-col gap-1 p-0 text-[0.8125rem]" data-testid="record-history">
            {data.events.map((e, i) => (
              <li key={`${e.at}:${String(i)}`}>
                <time dateTime={e.at} className="text-dy-muted">
                  {fmt.dateWith(e.at, DATE_TIME_NUMERIC)}
                </time>{' '}
                · {actions[e.action] ?? e.action}
                {e.version !== null ? ` (v${String(e.version)})` : ''}
                {e.actorType === 'system' ? t.system : ''}
                {e.note !== null ? ` — ${e.note}` : ''}
              </li>
            ))}
          </ol>
          {data.related.length > 1 ? (
            <div className="text-[0.8125rem]">
              <p className="m-0 font-bold">{t.chain}</p>
              <ol className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
                {data.related.map((x) => (
                  <li key={x.id}>
                    {x.id === id ? (
                      <span className="font-bold">{x.title}</span>
                    ) : (
                      <Link to={recordHref(x)} className={LINK}>
                        {x.title}
                      </Link>
                    )}{' '}
                    <span className="text-dy-muted">
                      · {t.status[x.status]} · {x.createdAt.slice(0, 10)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </>
      )}
    </PanelBox>
  );
}

export type ScopeMode =
  | { readonly project: string }
  | { readonly global: true }
  | { readonly fixed: string }
  | { readonly personal: true };

function scopeOf(mode: ScopeMode, perRuntime: boolean, runtime: string): string | null {
  if ('fixed' in mode) return mode.fixed;
  if ('personal' in mode) return null;
  if ('project' in mode)
    return perRuntime ? `project:${mode.project}+runtime:${runtime}` : `project:${mode.project}`;
  return perRuntime ? `runtime:${runtime}` : 'global';
}

/** The new-record form; conflicts the master found on create are shown with Supersede / Keep both. */
export function NewRecordForm(props: {
  readonly scopeMode: ScopeMode;
  readonly fixedType?: RecordType;
  readonly supersedes?: string;
  readonly submitLabel?: string;
  readonly onCreated: (c: Created) => void;
  readonly onCancel?: () => void;
}): ReactNode {
  const mode = props.scopeMode;
  const t = useT().projectTabs.memory;
  const personal = 'personal' in mode;
  const [type, setType] = useState<RecordType>(props.fixedType ?? 'rule');
  const [perRuntime, setPerRuntime] = useState(false);
  const [runtime, setRuntime] = useState(RUNTIMES[0] ?? 'claude-code');
  const [title, setTitle] = useState('');
  const [statement, setStatement] = useState('');
  const [rationale, setRationale] = useState('');
  const [consequences, setConsequences] = useState('');
  const [decidedOn, setDecidedOn] = useState('');
  const [decidedBy, setDecidedBy] = useState('');
  const [tags, setTags] = useState('');
  const [reviewBy, setReviewBy] = useState('');
  const [expires, setExpires] = useState('');
  const [conflicts, setConflicts] = useState<readonly RecordConflict[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const act = useSubmit();
  const decision = type === 'decision';
  const choosable = 'project' in mode || 'global' in mode;

  const reset = (): void => {
    setTitle('');
    setStatement('');
    setRationale('');
    setConsequences('');
    setDecidedOn('');
    setDecidedBy('');
    setTags('');
    setReviewBy('');
    setExpires('');
  };

  return (
    <form
      className="flex flex-col gap-3"
      aria-label={personal ? t.newPersonal : t.newRecord}
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(async () => {
          const common = {
            statement: statement.trim(),
            ...(title.trim() === '' ? {} : { title: title.trim() }),
            ...(rationale.trim() === '' ? {} : { rationale: rationale.trim() }),
            ...(parseTags(tags).length === 0 ? {} : { tags: parseTags(tags) }),
            ...(reviewBy === '' ? {} : { reviewBy }),
            ...(expires === '' ? {} : { expiresAt: expiryIso(expires) }),
            ...(props.supersedes === undefined ? {} : { supersedes: props.supersedes }),
          };
          let out: Created;
          const scope = scopeOf(mode, perRuntime, runtime);
          if (scope === null) {
            out = await createPersonal(common);
          } else {
            out = await createRecord({
              ...common,
              scope,
              type,
              ...(decision && consequences.trim() !== '' ? { consequences: consequences.trim() } : {}),
              ...(decision && decidedOn !== '' ? { decidedOn } : {}),
              ...(decision && decidedBy.trim() !== '' ? { decidedBy: decidedBy.trim() } : {}),
            });
          }
          reset();
          setCreated(out.record.title);
          setConflicts(out.conflicts);
          props.onCreated(out);
        });
      }}
    >
      {props.fixedType === undefined && !personal ? (
        <DySelect
          label={t.typeField}
          value={type}
          options={RECORD_TYPES.map((x) => [x, t.type[x]] as const)}
          onChange={(v) => {
            const next = RECORD_TYPES.find((x) => x === v);
            if (next !== undefined) setType(next);
          }}
          className="max-w-xs"
        />
      ) : null}
      {choosable ? (
        <FormGrid>
          <DySelect
            label={t.scopeField}
            value={perRuntime ? 'runtime' : 'all'}
            options={
              'project' in mode
                ? [
                    ['all', t.thisProjectAll],
                    ['runtime', t.thisProjectOne],
                  ]
                : [
                    ['all', t.everyProject],
                    ['runtime', t.oneRuntime],
                  ]
            }
            onChange={(v) => {
              setPerRuntime(v === 'runtime');
            }}
          />
          {perRuntime ? (
            <DySelect
              label="Runtime" // i18n-ignore: technical term, the same in both languages
              value={runtime}
              options={RUNTIMES.map((r) => [r, runtimeName(r)] as const)}
              onChange={setRuntime}
            />
          ) : null}
        </FormGrid>
      ) : null}
      <DyField label={t.titleOptional} value={title} maxLength={200} onChange={setTitle} />
      <DyTextarea
        label={t.statement}
        value={statement}
        onChange={setStatement}
        rows={3}
        maxLength={2000}
        required
        hint={personal ? t.personalHint : t.statementHint}
      />
      <DyTextarea
        label={t.rationaleOptional}
        value={rationale}
        onChange={setRationale}
        rows={2}
        maxLength={2000}
      />
      {decision ? (
        <>
          <DyTextarea
            label={t.consequencesOptional}
            value={consequences}
            onChange={setConsequences}
            rows={2}
            maxLength={2000}
          />
          <FormGrid>
            <DyField label={t.decidedOnField} type="date" value={decidedOn} onChange={setDecidedOn} />
            <DyField label={t.decidedBy} value={decidedBy} maxLength={120} onChange={setDecidedBy} />
          </FormGrid>
        </>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <DyField label={t.tagsOptional} hint={t.commaHint} value={tags} onChange={setTags} />
        <DyField label={t.reviewOptional} type="date" value={reviewBy} onChange={setReviewBy} />
        <DyField label={t.expiresOptional} type="date" value={expires} onChange={setExpires} />
      </div>
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
      <FormActions>
        <DyButton type="submit" variant="primary" busy={act.busy} disabled={statement.trim() === ''}>
          {props.submitLabel ?? (personal ? t.addRule : t.addRecord)}
        </DyButton>
        {props.onCancel !== undefined ? (
          <DyButton variant="ghost" onClick={props.onCancel}>
            {t.cancel}
          </DyButton>
        ) : null}
      </FormActions>
      {created !== null && conflicts.length > 0 ? (
        <DyNotice tone="amber" title={t.addedConflicts({ title: created })}>
          <div className="mt-2">
            <ConflictList
              conflicts={conflicts}
              canResolve
              onResolved={() => {
                setConflicts((cur) => cur.slice(1));
              }}
            />
          </div>
        </DyNotice>
      ) : null}
    </form>
  );
}

/** "Bu, şunun yerini alabilir" pairs with Yerine koy / İkisini de tut. */
export function ConflictList(props: {
  readonly conflicts: readonly RecordConflict[];
  readonly canResolve: boolean;
  readonly onResolved: (notice: string) => void;
}): ReactNode {
  const t = useT().projectTabs.memory;
  if (props.conflicts.length === 0)
    return <p className="m-0 text-[0.84375rem] text-dy-muted">{t.noConflicts}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="memory-conflicts">
      {props.conflicts.map((c) => (
        <ConflictRow key={c.id} conflict={c} canResolve={props.canResolve} onResolved={props.onResolved} />
      ))}
    </ul>
  );
}

function ConflictRow(props: {
  readonly conflict: RecordConflict;
  readonly canResolve: boolean;
  readonly onResolved: (notice: string) => void;
}): ReactNode {
  const c = props.conflict;
  const t = useT().projectTabs.memory;
  const act = useSubmit();
  const decide = (decision: 'supersede' | 'keep'): void => {
    void act.run(async () => {
      await resolveConflict(c.id, decision);
      props.onResolved(
        decision === 'supersede'
          ? t.conflictSuperseded({ other: c.other.title, record: c.record.title })
          : t.conflictKept({ record: c.record.title, other: c.other.title }),
      );
    });
  };
  return (
    <li
      className="rounded-[10px] border border-dy-line bg-dy-card p-3 text-[0.875rem] text-dy-ink"
      data-testid="memory-conflict"
    >
      <p className="m-0 [overflow-wrap:anywhere]">
        <b>“{c.record.title}”</b>
        {t.conflictMid}
        <b>“{c.other.title}”</b>
        {t.conflictTail}{' '}
        <span className="text-[0.78125rem] text-dy-muted">
          {`(${t.typeLower[c.other.type]}, ${reasonText(t, c.reason)}, ${c.method === 'semantic' ? t.semantic : t.lexical} ${c.score.toFixed(2)})`}
        </span>
      </p>
      <DyApiError error={act.error} retryLeft={act.retryLeft} className="mt-2" />
      {props.canResolve ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <DyButton
            variant="primary"
            busy={act.busy}
            onClick={() => {
              decide('supersede');
            }}
          >
            {t.supersede}
          </DyButton>
          <DyButton
            disabled={act.busy}
            onClick={() => {
              decide('keep');
            }}
          >
            {t.keepBoth}
          </DyButton>
        </div>
      ) : null}
    </li>
  );
}

/** Lightweight ADR timeline: every decision of a project, superseded ones included. */
export function DecisionTimeline(props: { readonly decisions: readonly MemoryRecord[] }): ReactNode {
  const t = useT().projectTabs.memory;
  if (props.decisions.length === 0)
    return <p className="m-0 text-[0.84375rem] text-dy-muted">{t.noDecisions}</p>;
  return (
    <ol
      className="m-0 flex list-none flex-col gap-4 border-l-2 border-dy-line py-0 pr-0 pl-4"
      data-testid="decision-history"
    >
      {props.decisions.map((d) => (
        <li key={d.id} className="relative" data-testid="decision-entry">
          <span
            aria-hidden="true"
            className={cx(
              'absolute top-1.5 -left-[1.4rem] size-2.5 rounded-full ring-2 ring-dy-card',
              d.status === 'active' ? 'bg-dy-teal' : 'bg-dy-line-2',
            )}
          />
          <p className="m-0 flex flex-wrap items-center gap-2 text-[0.78125rem] text-dy-muted">
            <span className="font-dy-mono">{d.decidedOn ?? d.createdAt.slice(0, 10)}</span>
            <span>· {d.decidedBy ?? t.writtenByLower({ author: t.author[d.author] })}</span>
            <Pill tone={STATUS_TONE[d.status]}>{t.status[d.status]}</Pill>
          </p>
          <p
            className={cx(
              'm-0 mt-0.5 font-bold [overflow-wrap:anywhere]',
              d.status !== 'active' && 'text-dy-muted line-through',
            )}
          >
            {d.title}
          </p>
          <p className="m-0 text-[0.875rem] whitespace-pre-wrap [overflow-wrap:anywhere]">{d.statement}</p>
          {d.rationale !== null ? (
            <p className="m-0 text-[0.8125rem] whitespace-pre-wrap text-dy-muted [overflow-wrap:anywhere]">
              {t.context({ text: d.rationale })}
            </p>
          ) : null}
          {d.consequences !== null ? (
            <p className="m-0 text-[0.8125rem] whitespace-pre-wrap text-dy-muted [overflow-wrap:anywhere]">
              {t.consequencesOf({ text: d.consequences })}
            </p>
          ) : null}
          {d.supersededBy !== null ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">
              {t.replacedA}
              <RecordLink from={d} id={d.supersededBy}>
                {t.newerDecision}
              </RecordLink>
              {t.replacedB}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

const TYPE_ORDER: readonly RecordType[] = ['rule', 'decision', 'fact', 'lesson'];

type StatusFilter = 'active' | 'all' | RecordStatus;

/**
 * Records of a project or the global scope: type toggles, status (Etkin by default), runtime and text search,
 * grouped by type. `highlight` (`?record=`) is scrolled to and outlined; when the Etkin filter hides it, the filter
 * switches to Tümü once (as classic).
 */
export function RecordsBrowser(props: {
  readonly scope: { readonly project: string } | { readonly global: true };
  readonly reload: number;
  readonly highlight: string | null;
  readonly onChanged: (notice: string) => void;
}): ReactNode {
  const sayError = useErrorText();
  const tm = useT().projectTabs.memory;
  const [types, setTypes] = useState<ReadonlySet<RecordType>>(new Set());
  const [status, setStatus] = useState<StatusFilter>('active');
  const [runtime, setRuntime] = useState('');
  const [q, setQ] = useState('');
  const [records, setRecords] = useState<MemoryRecord[] | null>(null);
  const load = useSubmit();
  const widened = useRef(false);
  const project = 'project' in props.scope ? props.scope.project : null;

  useEffect(() => {
    void load.run(async () => {
      setRecords(
        await listRecords({
          scope: project === null ? 'global' : 'project',
          ...(project === null ? {} : { project }),
          types: [...types],
          statuses: status === 'all' ? [] : [status],
          runtime,
          q,
          limit: 500,
        }),
      );
    });
    // load.run is stable.
  }, [project, types, status, runtime, q, props.reload]);

  useEffect(() => {
    if (props.highlight === null || records === null || widened.current || status === 'all') return;
    if (!records.some((r) => r.id === props.highlight)) {
      widened.current = true;
      setStatus('all');
    }
  }, [records, props.highlight, status]);

  const toggleType = (t: RecordType): void => {
    setTypes((cur) => {
      const next = new Set(cur);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };
  const candidates = (records ?? []).filter((r) => r.status === 'active');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3">
        <div role="group" aria-label={tm.recordTypes} className="flex flex-wrap gap-1.5">
          {TYPE_ORDER.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={types.has(t)}
              onClick={() => {
                toggleType(t);
              }}
              className={cx(
                'dy-press inline-flex min-h-9 items-center rounded-full border px-3 text-[0.8125rem] font-medium',
                types.has(t)
                  ? 'border-dy-ink bg-dy-ink text-dy-card'
                  : 'border-dy-line bg-dy-card text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
              )}
            >
              {tm.typePlural[t]}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(2,minmax(0,11rem))_minmax(0,1fr)]">
          <DySelect
            label={tm.statusField}
            value={status}
            options={[
              ['active', tm.status.active],
              ['all', tm.all],
              ['superseded', tm.status.superseded],
              ['expired', tm.status.expired],
              ['rejected', tm.status.rejected],
            ]}
            onChange={(v) => {
              if (v === 'active' || v === 'all' || v === 'superseded' || v === 'expired' || v === 'rejected')
                setStatus(v);
            }}
          />
          <DySelect
            label="Runtime" // i18n-ignore: technical term, the same in both languages
            value={runtime}
            options={[['', tm.everyRuntime], ...RUNTIMES.map((r) => [r, runtimeName(r)] as const)]}
            onChange={setRuntime}
          />
          <DySearch label={tm.search} value={q} onChange={setQ} className="col-span-2 sm:col-span-1" />
        </div>
      </div>
      {load.error !== null ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="memory-load-error">
          {tm.recordsFailed({ reason: sayError(load.error) })}
        </p>
      ) : null}
      {records === null ? (
        load.error === null ? (
          <SkeletonRows label={tm.recordsLoading} rows={5} />
        ) : null
      ) : records.length === 0 ? (
        <p className="m-0 text-[0.84375rem] text-dy-muted" data-testid="records-empty">
          {tm.noRecords}
        </p>
      ) : (
        <div className="flex flex-col gap-4" data-testid="memory-records">
          {TYPE_ORDER.map((t) => {
            const group = records.filter((r) => r.type === t);
            if (group.length === 0) return null;
            return (
              <section key={t} aria-label={tm.typePlural[t]} data-testid={`record-group-${t}`}>
                <h3 className="m-0 mb-2 flex items-baseline gap-2 text-[0.875rem] font-bold">
                  {tm.typePlural[t]}
                  <span className="font-dy-mono text-[0.78125rem] font-medium text-dy-muted tabular-nums">
                    {group.length}
                  </span>
                </h3>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {group.map((r) => (
                    <RecordItem
                      key={`${r.id}:${String(r.version)}:${r.status}`}
                      record={r}
                      api="records"
                      candidates={candidates}
                      highlight={r.id === props.highlight}
                      onChanged={props.onChanged}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
