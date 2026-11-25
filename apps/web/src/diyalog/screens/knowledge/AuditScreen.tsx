import { type ReactNode, type SubmitEvent, useState } from 'react';
import {
  ACTOR_TYPES,
  type ActorType,
  type AuditEvent,
  type AuditFilter,
  exportAudit,
  listAudit,
  OUTCOMES,
  type Outcome,
  verifyAuditChain,
  type VerifyResult,
} from '../../../api/audit';
import type { ApiError } from '../../../api/client';
import type { ExportResult } from '../../../api/download';
import { DyPager } from '../../common/pager';
import { toApiError } from '../../../components/ui';
import { useCursorList } from '../../../lib/pager';
import { type AuditDraft, EMPTY_AUDIT_DRAFT, toAuditFilter } from '../../../screens/auditFilter';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyIcon, type IconName } from '../../icons';
import { INK, type Tone } from '../../tone';
import { DyApiError, DyDetails, DyField, DyNotice } from '../forms';
import { DyButton, DySelect, EmptyLine, Panel, SkeletonRows } from '../parts';
import { DyAbsoluteTime, DyExportResult, DyFields, DyJson, DySheet, DyTime } from '../records';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';

type AuditWords = Messages['knowledge']['audit'];
import { ScreenFrame } from '../ScreenFrame';

/**
 * p12-diyalog wave 2 (W3) — Denetim (`/audit`) in the Diyalog language. Same requests and rules as the classic
 * explorer (docs/design/p5-search-audit.md §6): the filter draft becomes the classic `AuditFilter`
 * (`toAuditFilter`), keyset pages of 50 (`useCursorList`, position in the URL), chain verification, export through
 * step-up with "continue" for truncated exports, owners and admins only (the master answers 403 to everyone else).
 * Every value can be attacker-influenced and renders as React text.
 */

const OUTCOME_LOOK: Readonly<Record<string, { tone: Tone; icon: IconName }>> = {
  success: { tone: 'green', icon: 'checkc' },
  failure: { tone: 'amber', icon: 'xc' },
  denied: { tone: 'red', icon: 'shield' },
  error: { tone: 'red', icon: 'xc' },
};

function outcomeWord(t: AuditWords, outcome: string): string {
  const words: Readonly<Record<string, string>> = t.outcome;
  return words[outcome] ?? outcome;
}

function actorWord(t: AuditWords, type: string): string {
  const words: Readonly<Record<string, string>> = t.actor;
  return words[type] ?? type;
}

function OutcomeMark(props: { readonly outcome: string }): ReactNode {
  const t = useT().knowledge.audit;
  const look = {
    ...(OUTCOME_LOOK[props.outcome] ?? { tone: 'neutral' as const, icon: 'flag' as const }),
    word: outcomeWord(t, props.outcome),
  };
  return (
    <span
      data-outcome={props.outcome}
      className={`inline-flex items-center gap-1 text-[0.8125rem] font-bold whitespace-nowrap ${INK[look.tone]}`}
    >
      <DyIcon name={look.icon} className="size-3.5 shrink-0" />
      {look.word}
    </span>
  );
}

function actorText(t: AuditWords, e: AuditEvent): string {
  const type = actorWord(t, e.actor.type);
  return e.actor.id ? `${type} ${e.actor.id}` : type;
}

function FilterBar(props: { readonly onApply: (d: AuditDraft) => void }): ReactNode {
  const t = useT().knowledge.audit;
  const [d, setD] = useState<AuditDraft>(EMPTY_AUDIT_DRAFT);
  const set =
    <K extends keyof AuditDraft>(k: K) =>
    (v: AuditDraft[K]): void => {
      setD((prev) => ({ ...prev, [k]: v }));
    };
  function submit(e: SubmitEvent<HTMLFormElement>): void {
    e.preventDefault();
    props.onApply(d);
  }
  return (
    <form
      role="search"
      aria-label={t.filterLabel}
      onSubmit={submit}
      className="mb-4 flex flex-col gap-3 rounded-[14px] border border-dy-line bg-dy-card p-3.5 shadow-dy sm:p-4"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <DyField
          label={t.search}
          type="search"
          value={d.q}
          maxLength={400}
          placeholder={t.searchPlaceholder}
          onChange={set('q')}
          wrapClassName="flex-1"
        />
        <div className="flex gap-2">
          <DyButton type="submit" variant="primary">
            {t.apply}
          </DyButton>
          <DyButton
            onClick={() => {
              setD(EMPTY_AUDIT_DRAFT);
              props.onApply(EMPTY_AUDIT_DRAFT);
            }}
          >
            {t.reset}
          </DyButton>
        </div>
      </div>
      <DyDetails summary={t.moreFilters} testId="audit-more-filters">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DyField label={t.from} type="datetime-local" value={d.from} onChange={set('from')} />
          <DyField label={t.to} type="datetime-local" value={d.to} onChange={set('to')} />
          <DySelect
            label={t.actorType}
            value={d.actorType}
            options={[['', t.all], ...ACTOR_TYPES.map((a) => [a, actorWord(t, a)] as const)]}
            onChange={(v) => {
              set('actorType')(v as ActorType | '');
            }}
          />
          <DyField label={t.actorId} value={d.actorId} maxLength={200} mono onChange={set('actorId')} />
          <DyField
            label={t.actionPrefix}
            value={d.action}
            maxLength={100}
            placeholder="auth." // i18n-ignore: example value
            mono
            onChange={set('action')}
          />
          <DyField
            label={t.target}
            value={d.target}
            maxLength={500}
            placeholder="job:…" // i18n-ignore: example value
            mono
            onChange={set('target')}
          />
          <DySelect
            label={t.result}
            value={d.outcome}
            options={[['', t.all], ...OUTCOMES.map((o) => [o, outcomeWord(t, o)] as const)]}
            onChange={(v) => {
              set('outcome')(v as Outcome | '');
            }}
          />
        </div>
      </DyDetails>
    </form>
  );
}

const TH = 'px-3 py-2 text-left text-[0.78125rem] font-bold text-dy-muted';

function Results(props: {
  readonly items: readonly AuditEvent[];
  readonly onOpen: (e: AuditEvent) => void;
}): ReactNode {
  const t = useT().knowledge.audit;
  return (
    <>
      <div className="hidden overflow-hidden rounded-[14px] border border-dy-line bg-dy-card shadow-dy md:block">
        <table className="w-full table-fixed border-collapse text-[0.875rem]" data-testid="audit-table">
          <caption className="sr-only">{t.caption}</caption>
          <thead className="border-b border-dy-line">
            <tr>
              <th scope="col" className={`${TH} w-20`}>
                #
              </th>
              <th scope="col" className={`${TH} w-32`}>
                {t.time}
              </th>
              <th scope="col" className={`${TH} w-52`}>
                {t.actorCol}
              </th>
              <th scope="col" className={TH}>
                {t.action}
              </th>
              <th scope="col" className={TH}>
                {t.target}
              </th>
              <th scope="col" className={`${TH} w-32`}>
                {t.result}
              </th>
            </tr>
          </thead>
          <tbody>
            {props.items.map((e) => (
              <tr
                key={e.id}
                className="border-t border-dy-line first:border-t-0 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk/60"
              >
                <td className="px-3 py-2.5 font-dy-mono text-[0.78125rem] text-dy-muted tabular-nums">
                  {e.id}
                </td>
                <td className="px-3 py-2.5 text-dy-muted">
                  <DyTime iso={e.occurredAt} />
                </td>
                <td className="truncate px-3 py-2.5" title={actorText(t, e)}>
                  {actorText(t, e)}
                </td>
                <td className="truncate px-3 py-2.5">
                  <button
                    type="button"
                    className="max-w-full truncate font-dy-mono text-[0.8125rem] font-medium text-dy-teal-ink [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                    onClick={() => {
                      props.onOpen(e);
                    }}
                  >
                    {e.action}
                  </button>
                </td>
                <td className="truncate px-3 py-2.5 font-dy-mono text-[0.8125rem]" title={e.target ?? ''}>
                  {e.target ?? '—'}
                </td>
                <td className="px-3 py-2.5">
                  <OutcomeMark outcome={e.outcome} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden" aria-label={t.records}>
        {props.items.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => {
                props.onOpen(e);
              }}
              className="dy-press block w-full rounded-[12px] border border-dy-line bg-dy-card p-3 text-left"
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 truncate font-dy-mono text-[0.8125rem] font-bold">{e.action}</span>
                <span className="ml-auto shrink-0">
                  <OutcomeMark outcome={e.outcome} />
                </span>
              </span>
              <span className="mt-1 block truncate font-dy-mono text-[0.8125rem] text-dy-muted">
                {e.target ?? t.noTarget}
              </span>
              <span className="mt-1 flex flex-wrap gap-x-3 text-[0.78125rem] text-dy-muted">
                <span>{actorText(t, e)}</span>
                <DyTime iso={e.occurredAt} />
                <span className="font-dy-mono">#{e.id}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function EventDetail(props: { readonly event: AuditEvent }): ReactNode {
  const e = props.event;
  const t = useT().knowledge.audit;
  return (
    <div className="flex flex-col gap-5" data-testid="audit-detail">
      <DyFields
        rows={[
          { k: t.record, v: `#${e.id}`, mono: true },
          { k: t.time, v: <DyAbsoluteTime iso={e.occurredAt} /> },
          { k: t.actorCol, v: actorText(t, e) },
          { k: t.action, v: e.action, mono: true },
          { k: t.target, v: e.target ?? '—', mono: true },
          { k: t.result, v: <OutcomeMark outcome={e.outcome} /> },
          { k: t.ip, v: e.ip ?? '—', mono: true },
          { k: t.browser, v: e.userAgent ?? '—' },
        ]}
      />
      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-[0.9375rem] font-bold">{t.metadata}</h3>
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.redacted}</p>
        <DyJson value={e.metadata} label={t.metadataLabel} />
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-[0.9375rem] font-bold">{t.chain}</h3>
        <DyFields
          rows={[
            { k: t.prev, v: e.prevHash, mono: true },
            { k: t.thisRecord, v: e.hash, mono: true },
          ]}
        />
      </section>
    </div>
  );
}

function VerifyLine(props: { readonly result: VerifyResult }): ReactNode {
  const r = props.result;
  const t = useT().knowledge.audit;
  if (r.ok)
    return (
      <DyNotice tone="green" live>
        <span data-testid="verify-result">
          {t.chainOk({ n: r.checked, genesis: r.anchored === 'genesis' })}
        </span>
      </DyNotice>
    );
  return (
    <DyNotice tone="red" live title={t.chainBrokenTitle}>
      <span data-testid="verify-result">
        {t.chainBroken({
          id: String(r.brokenAtId),
          reason: r.reason === 'hash_mismatch' ? t.hashMismatch : t.linkBroken,
          n: r.checked,
        })}
      </span>
    </DyNotice>
  );
}

export function AuditScreen(): ReactNode {
  const stepUp = useStepUp();
  const t = useT().knowledge.audit;
  const [filter, setFilter] = useState<AuditFilter>(() => toAuditFilter(EMPTY_AUDIT_DRAFT));
  const list = useCursorList<AuditEvent>({
    key: JSON.stringify(filter),
    label: t.pages,
    defaultSize: 50,
    fetchPage: (cursor, limit) => listAudit(filter, cursor, { limit }),
  });
  const [open, setOpen] = useState<AuditEvent | null>(null);
  const [format, setFormat] = useState<'jsonl' | 'csv'>('jsonl');
  const [busy, setBusy] = useState<'verify' | 'export' | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  async function runVerify(): Promise<void> {
    setBusy('verify');
    setActionError(null);
    try {
      setVerify(await verifyAuditChain({}));
    } catch (err) {
      setActionError(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function runExport(cursor: string | null): Promise<void> {
    setBusy('export');
    setActionError(null);
    try {
      const result = await stepUp.run(() => exportAudit(filter, format, cursor), t.exportStepUp);
      setExported(result);
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setActionError(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  const forbidden = list.error?.code === 'forbidden';

  return (
    <ScreenFrame
      title={t.title}
      purpose={t.purpose}
      testId="dy-audit"
      actions={
        forbidden ? undefined : (
          <>
            <DyButton
              icon="shield"
              busy={busy === 'verify'}
              disabled={busy !== null}
              onClick={() => void runVerify()}
            >
              {t.verify}
            </DyButton>
            <span className="flex items-end gap-2">
              <label className="sr-only" htmlFor="dy-audit-format">
                {t.exportFormat}
              </label>
              <select
                id="dy-audit-format"
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value === 'csv' ? 'csv' : 'jsonl');
                }}
                className="min-h-10 rounded-[9px] border border-dy-line-2 bg-dy-card px-2.5 text-[0.875rem] text-dy-ink sm:min-h-9"
              >
                <option value="jsonl">JSON Lines</option>
                {/* i18n-ignore: format name */}
                <option value="csv">CSV</option>
                {/* i18n-ignore: format name */}
              </select>
              <DyButton
                variant="primary"
                icon="tray"
                busy={busy === 'export'}
                disabled={busy !== null}
                onClick={() => void runExport(null)}
              >
                {t.export}
              </DyButton>
            </span>
          </>
        )
      }
    >
      {forbidden ? (
        <Panel title={t.forbiddenTitle}>
          <p className="m-0 max-w-[60ch] text-[0.9375rem] text-dy-muted" data-testid="forbidden">
            {t.forbidden}
          </p>
        </Panel>
      ) : (
        <>
          <FilterBar
            onApply={(d) => {
              setFilter(toAuditFilter(d));
              setExported(null);
              list.reset();
            }}
          />
          <div className="mb-4 flex flex-col gap-2 empty:hidden">
            {verify ? <VerifyLine result={verify} /> : null}
            {exported ? (
              <>
                <DyExportResult result={exported} />
                {exported.truncated && exported.nextCursor ? (
                  <div>
                    <DyButton disabled={busy !== null} onClick={() => void runExport(exported.nextCursor)}>
                      {t.continueExport}
                    </DyButton>
                  </div>
                ) : null}
              </>
            ) : null}
            <DyApiError error={actionError} />
          </div>
          <section aria-label={t.records} aria-busy={list.loading || undefined}>
            {list.error ? (
              <div className="flex flex-col items-start gap-2">
                <DyApiError error={list.error} />
                <DyButton onClick={list.reload}>{t.retry}</DyButton>
              </div>
            ) : !list.loaded ? (
              <Panel title={t.listTitle} flush>
                <SkeletonRows label={t.loading} rows={5} />
              </Panel>
            ) : list.items.length === 0 ? (
              <Panel title={t.emptyTitle} flush>
                <EmptyLine testId="empty-state">{t.empty}</EmptyLine>
              </Panel>
            ) : (
              <>
                <Results items={list.items} onOpen={setOpen} />
                <DyPager {...list.pagination} />
              </>
            )}
          </section>
        </>
      )}
      <DySheet
        open={open !== null}
        title={open ? t.sheetId({ id: open.id }) : t.sheet}
        onClose={() => {
          setOpen(null);
        }}
      >
        {open ? <EventDetail event={open} /> : null}
      </DySheet>
    </ScreenFrame>
  );
}
