import { type ReactNode, type SubmitEvent, useEffect, useId, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  type ContextDoc,
  deleteDoc,
  type DocWithCurrent,
  getVersion,
  listVersions,
  rollbackDoc,
  type VersionMeta,
} from '../../../api/context';
import { DyPager } from '../../common/pager';
import { cx, toApiError } from '../../../components/ui';
import { type DiffOp, diffLines } from '../../../lib/diff';
import { useClientPage } from '../../../lib/pager';
import { useSubmit } from '../../../screens/useSubmit';
import { DyDialog } from '../../DyDialog';
import { DyIcon } from '../../icons';
import { ConfirmButton, DyApiError, DyField, DyNotice } from '../forms';
import { DyButton, DySelect, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { DyTime } from '../records';
import { kindText, provenanceText, roleText, usePrivileged } from './ContextShared';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from '../../common/time';

/**
 * p12-diyalog wave 2 (W3) — Bağlam: one context document in the Diyalog language — its versions (who, change note,
 * when) with "v… sürümüne geri al" (operators+, step-up), a line diff between any two versions, and deletion with a
 * reason and a retention window (owners / admins, step-up). Same calls as the classic `DocumentPanel`.
 */

function DiffView(props: { readonly ops: readonly DiffOp[] }): ReactNode {
  const t = useT().knowledge.context.doc;
  if (props.ops.every((o) => o.type === 'same'))
    return <p className="m-0 text-[0.8125rem] text-dy-muted">{t.noDiff}</p>;
  return (
    <div
      data-testid="diff"
      aria-label={t.diff}
      role="region"
      className="max-h-96 overflow-auto rounded-[10px] border border-dy-line bg-dy-sunk p-2 font-dy-mono text-[0.78125rem] leading-relaxed"
    >
      {props.ops.map((op, i) => (
        <div
          // Lines have no identity of their own; the position in this diff is stable.
          key={i}
          data-op={op.type}
          className={cx(
            'rounded-[3px] px-1 whitespace-pre-wrap [overflow-wrap:anywhere]',
            op.type === 'add'
              ? 'bg-dy-green-soft text-dy-green'
              : op.type === 'del'
                ? 'bg-dy-red-soft text-dy-red-ink'
                : 'text-dy-muted',
          )}
        >
          {op.type === 'add' ? '+ ' : op.type === 'del' ? '- ' : '  '}
          {op.text}
        </div>
      ))}
    </div>
  );
}

function DeleteForm(props: {
  readonly doc: ContextDoc;
  readonly title: string;
  readonly onDeleted: (doc: ContextDoc) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const t = useT().knowledge.context.doc;
  const { submit, run } = usePrivileged();
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const formId = useId();

  function onSubmit(e: SubmitEvent<HTMLFormElement>): void {
    e.preventDefault();
    const v = days.trim();
    const retentionDays = v === '' ? null : /^\d+$/.test(v) ? Number(v) : undefined;
    if (retentionDays === undefined) {
      setInvalid(t.invalidDays);
      return;
    }
    setInvalid(null);
    void run(
      async () => {
        const doc = await deleteDoc(props.doc.id, {
          reason: reason.trim() === '' ? null : reason.trim(),
          retentionDays,
        });
        props.onDeleted(doc);
      },
      t.deleteStepUp({ title: props.title }),
    );
  }

  // p18-confirm-dialog: the deletion (reason, retention) is confirmed in a dialog, not a form on the page.
  return (
    <DyDialog
      open
      onClose={props.onCancel}
      title={t.deleteForm}
      description={t.deleteHint}
      size="sm"
      backdropClose={false}
      testId="context-doc-delete"
      footer={
        <>
          <DyButton variant="ghost" onClick={props.onCancel}>
            {t.cancel}
          </DyButton>
          <DyButton
            type="submit"
            form={formId}
            variant="danger"
            icon="trash"
            busy={submit.busy}
            disabled={submit.blocked}
          >
            {t.confirmDelete}
          </DyButton>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={onSubmit}
        noValidate
        aria-label={t.deleteForm}
        className="flex flex-col gap-3"
      >
        <DyField label={t.reason} value={reason} maxLength={500} autoComplete="off" onChange={setReason} />
        <DyField
          label={t.retentionField}
          inputMode="numeric"
          value={days}
          error={invalid}
          hint={t.retentionHint}
          autoComplete="off"
          onChange={setDays}
        />
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </form>
    </DyDialog>
  );
}

export function ContextDocumentPanel(props: {
  readonly entry: DocWithCurrent;
  readonly canWrite: boolean;
  readonly isAdmin: boolean;
  readonly onChanged: (message: string) => void;
}): ReactNode {
  const fmt = useFormat();
  const all = useT().knowledge.context;
  const t = all.doc;
  const { document: doc, current } = props.entry;
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  // p9-pagination: a long document history pages (`?versionsPage=`).
  const versionPage = useClientPage(versions ?? [], { label: t.versionPages, prefix: 'versions' });
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [diff, setDiff] = useState<{ from: number; to: number; ops: DiffOp[] } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const diffLoad = useSubmit();
  const { submit: act, run } = usePrivileged();

  useEffect(() => {
    let live = true;
    setLoadError(null);
    listVersions(doc.id).then(
      (list) => {
        if (!live) return;
        setVersions(list);
        setTo(list[0] ? String(list[0].version) : '');
        setFrom(list[1] ? String(list[1].version) : list[0] ? String(list[0].version) : '');
      },
      (err: unknown) => {
        if (live) setLoadError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [doc.id, doc.currentVersion]);

  const showDiff = (): void => {
    const a = Number(from);
    const b = Number(to);
    void diffLoad.run(async () => {
      const [va, vb] = await Promise.all([getVersion(doc.id, a), getVersion(doc.id, b)]);
      setDiff({ from: a, to: b, ops: diffLines(va.content, vb.content) });
    });
  };

  const rollback = (toVersion: number): void => {
    void run(async () => {
      await rollbackDoc(doc.id, doc.currentVersion, toVersion);
      setDiff(null);
      props.onChanged(t.rolledBack({ title: current.title, version: toVersion }));
    }, t.rollbackStepUp);
  };

  const options = (versions ?? []).map((v) => [String(v.version), `v${String(v.version)}`] as const);
  const deleted = doc.deletedAt !== null;

  return (
    <Panel
      testId="dy-context-doc"
      title={<span data-testid="context-doc-title">{current.title}</span>}
      sub={
        <>
          <span className="font-dy-mono">{doc.id}</span>
          {t.meta({
            kind: kindText(all, doc.kind),
            version: doc.currentVersion,
            read: roleText(all, doc.readRole),
            write: roleText(all, doc.writeRole),
          })}
        </>
      }
      aside={
        props.isAdmin && !deleted ? (
          <DyButton
            variant="danger"
            icon="trash"
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            {t.delete}
          </DyButton>
        ) : undefined
      }
      flush
    >
      <div className="flex flex-col gap-3 px-4 pb-3 empty:hidden">
        {deleted ? (
          <DyNotice tone="amber" icon="trash">
            {t.deletedLine({ reason: doc.deleteReason ?? '' })}{' '}
            {doc.purgeAfter === null ? null : (
              <>
                {t.purgeLead}
                <DyTime iso={doc.purgeAfter} />
                {t.purgeTail({ date: fmt.dateWith(doc.purgeAfter, DATE_TIME_NUMERIC) })}
              </>
            )}
          </DyNotice>
        ) : null}
        {confirmDelete ? (
          <DeleteForm
            doc={doc}
            title={current.title}
            onCancel={() => {
              setConfirmDelete(false);
            }}
            onDeleted={(d) => {
              setConfirmDelete(false);
              props.onChanged(
                d.purgeAfter === null
                  ? t.deletedDone({ title: current.title })
                  : t.deletedPurge({
                      title: current.title,
                      date: fmt.dateWith(d.purgeAfter, DATE_TIME_NUMERIC),
                    }),
              );
            }}
          />
        ) : null}
      </div>

      <h3 className="m-0 border-t border-dy-line px-4 pt-3 text-[0.875rem] font-bold">{t.versions}</h3>
      {loadError === null ? null : (
        <div className="px-4 pt-2">
          <DyApiError error={loadError} />
        </div>
      )}
      {versions === null ? (
        loadError === null ? (
          <SkeletonRows label={t.versionsLoading} rows={2} />
        ) : null
      ) : (
        <>
          <Rows label={t.versionsLabel({ title: current.title })} testId="context-versions">
            {versionPage.pageItems.map((v) => (
              <Row
                key={v.version}
                testId="context-version-row"
                lead={<DyIcon name="file" className="size-4" />}
                tone={v.version === doc.currentVersion ? 'green' : undefined}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-dy-mono">{`v${String(v.version)}`}</span>
                    {v.version === doc.currentVersion ? (
                      <Pill tone="green" icon="checkc">
                        {t.current}
                      </Pill>
                    ) : null}
                    <span className="font-normal">{v.title}</span>
                  </span>
                }
                meta={
                  <>
                    <span>{provenanceText(all, v.provenance)}</span>
                    <DyTime iso={v.createdAt} />
                    {v.changeNote === null ? null : <span className="w-full">“{v.changeNote}”</span>}
                  </>
                }
                actions={
                  props.canWrite && !deleted && v.version !== doc.currentVersion ? (
                    <ConfirmButton
                      label={t.rollback({ version: v.version })}
                      icon="retry"
                      variant="warn"
                      question={t.rollbackQuestion({ version: v.version })}
                      confirmLabel={t.rollbackConfirm}
                      busy={act.busy}
                      testId={`context-rollback-${String(v.version)}`}
                      onConfirm={() => {
                        rollback(v.version);
                      }}
                    />
                  ) : undefined
                }
              />
            ))}
          </Rows>
          <div className="px-4">
            <DyPager {...versionPage.pagination} />
          </div>
        </>
      )}
      <div className="px-4 empty:hidden">
        <DyApiError error={act.error} retryLeft={act.retryLeft} />
      </div>

      {versions !== null && versions.length > 0 ? (
        <div className="flex flex-col gap-3 border-t border-dy-line px-4 py-3.5">
          <h3 className="m-0 text-[0.875rem] font-bold">{t.compare}</h3>
          <div className="grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap">
            <DySelect label={t.from} value={from} options={options} onChange={setFrom} />
            <DySelect label={t.to} value={to} options={options} onChange={setTo} />
            <DyButton
              className="col-span-2"
              busy={diffLoad.busy}
              disabled={from === '' || to === ''}
              onClick={showDiff}
            >
              {t.showDiff}
            </DyButton>
          </div>
          <DyApiError error={diffLoad.error} retryLeft={diffLoad.retryLeft} />
          {diff !== null ? (
            <>
              <p className="m-0 font-dy-mono text-[0.8125rem] text-dy-muted">
                {`v${String(diff.from)} → v${String(diff.to)}`}
                {/* i18n-ignore: version numbers */}
              </p>
              <DiffView ops={diff.ops} />
            </>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
