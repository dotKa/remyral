import { type ReactNode, type SubmitEvent, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  type DeletionReceipt,
  getPolicy,
  listDeletionReceipts,
  type NamespacePolicy,
  updatePolicy,
} from '../../../api/context';
import { DyPager } from '../../common/pager';
import { toApiError } from '../../../components/ui';
import { useClientPage } from '../../../lib/pager';
import { useSubmit } from '../../../screens/useSubmit';
import { DyIcon } from '../../icons';
import { DyApiError, DyCheck, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, EmptyLine, Panel, Row, Rows, SkeletonRows } from '../parts';
import { DyFields, DyTime } from '../records';
import { optionalInt, receiptText, short, usePrivileged } from './ContextShared';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Bağlam: the namespace retention policy (max age, max versions, legal hold, deletion
 * retention, agent memory write limits; owners / admins edit with step-up and the policy version, everyone else reads
 * a summary) and the deletion receipts (owners / admins; content hashes only, never content). Same calls and checks
 * as the classic `RetentionPanel` / `ReceiptsPanel`.
 */

interface PolicyForm {
  maxAgeDays: string;
  maxVersions: string;
  legalHold: boolean;
  deleteRetentionDays: string;
  memoryEnabled: boolean;
  maxBytes: string;
  maxPerJob: string;
  maxPerHour: string;
}

function toForm(p: NamespacePolicy): PolicyForm {
  return {
    maxAgeDays: p.maxAgeDays === null ? '' : String(p.maxAgeDays),
    maxVersions: p.maxVersions === null ? '' : String(p.maxVersions),
    legalHold: p.legalHold,
    deleteRetentionDays: String(p.deleteRetentionDays),
    memoryEnabled: p.memory.enabled,
    maxBytes: String(p.memory.maxBytes),
    maxPerJob: String(p.memory.maxPerJob),
    maxPerHour: String(p.memory.maxPerHour),
  };
}

function PolicySummary(props: { readonly policy: NamespacePolicy }): ReactNode {
  const p = props.policy;
  const t = useT().knowledge.context.retention;
  return (
    <div data-testid="context-policy">
      <DyFields
        rows={[
          { k: t.maxAge, v: p.maxAgeDays === null ? t.forever : t.days({ n: p.maxAgeDays }) },
          { k: t.maxVersions, v: p.maxVersions === null ? t.unlimited : String(p.maxVersions) },
          { k: t.legalHold, v: p.legalHold ? t.legalHoldOn : t.off },
          { k: t.deleteRetention, v: t.days({ n: p.deleteRetentionDays }) },
          {
            k: t.memoryWrites,
            v: p.memory.enabled
              ? t.memoryOn({
                  bytes: p.memory.maxBytes,
                  perJob: p.memory.maxPerJob,
                  perHour: p.memory.maxPerHour,
                })
              : t.off,
          },
        ]}
      />
    </div>
  );
}

export function ContextRetentionPanel(props: {
  readonly namespace: string;
  readonly isAdmin: boolean;
}): ReactNode {
  const t = useT().knowledge.context.retention;
  const [policy, setPolicy] = useState<NamespacePolicy | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { submit, run } = usePrivileged();

  useEffect(() => {
    let live = true;
    setPolicy(null);
    setForm(null);
    setLoadError(null);
    getPolicy(props.namespace).then(
      (p) => {
        if (!live) return;
        setPolicy(p);
        setForm(p === null ? null : toForm(p));
      },
      (err: unknown) => {
        if (live) setLoadError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [props.namespace]);

  const set = (patch: Partial<PolicyForm>): void => {
    setSaved(false);
    setForm((f) => (f === null ? f : { ...f, ...patch }));
  };

  function onSubmit(e: SubmitEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (policy === null || form === null) return;
    const maxAgeDays = optionalInt(form.maxAgeDays);
    const maxVersions = optionalInt(form.maxVersions);
    const [deleteRetentionDays, maxBytes, maxPerJob, maxPerHour] = [
      form.deleteRetentionDays,
      form.maxBytes,
      form.maxPerJob,
      form.maxPerHour,
    ].map((v) => optionalInt(v));
    if (
      maxAgeDays === undefined ||
      maxVersions === undefined ||
      deleteRetentionDays == null ||
      maxBytes == null ||
      maxPerJob == null ||
      maxPerHour == null
    ) {
      setInvalid(t.invalid);
      return;
    }
    setInvalid(null);
    setSaved(false);
    void run(async () => {
      const next = await updatePolicy({
        namespace: props.namespace,
        expectedVersion: policy.version,
        maxAgeDays,
        maxVersions,
        legalHold: form.legalHold,
        deleteRetentionDays,
        memory: { enabled: form.memoryEnabled, maxBytes, maxPerJob, maxPerHour },
      });
      setPolicy(next);
      setForm(toForm(next));
      setSaved(true);
    }, t.stepUp);
  }

  return (
    <Panel
      title={t.title}
      testId="dy-context-retention"
      sub={
        policy === null
          ? t.subLoading
          : policy.explicit
            ? t.subPolicy({ version: policy.version, by: policy.updatedBy ?? '' })
            : t.subDefaults
      }
    >
      {loadError === null ? null : <DyApiError error={loadError} />}
      {policy === null || form === null ? (
        loadError === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : null
      ) : !props.isAdmin ? (
        <PolicySummary policy={policy} />
      ) : (
        <form noValidate onSubmit={onSubmit} aria-label={t.form} className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <DyField
              label={t.maxAgeField}
              inputMode="numeric"
              value={form.maxAgeDays}
              hint={t.maxAgeHint}
              onChange={(v) => {
                set({ maxAgeDays: v });
              }}
            />
            <DyField
              label={t.maxVersions}
              inputMode="numeric"
              value={form.maxVersions}
              hint={t.maxVersionsHint}
              onChange={(v) => {
                set({ maxVersions: v });
              }}
            />
            <DyField
              label={t.deleteRetentionField}
              inputMode="numeric"
              value={form.deleteRetentionDays}
              hint={t.deleteRetentionHint}
              onChange={(v) => {
                set({ deleteRetentionDays: v });
              }}
            />
            <DyCheck
              className="self-center"
              label={t.legalHoldField}
              checked={form.legalHold}
              onChange={(v) => {
                set({ legalHold: v });
              }}
            />
          </div>
          <fieldset className="m-0 flex flex-col gap-3 border-0 border-t border-dy-line p-0 pt-3">
            <legend className="sr-only">{t.memory}</legend>
            <DyCheck
              label={t.memoryEnabled}
              checked={form.memoryEnabled}
              onChange={(v) => {
                set({ memoryEnabled: v });
              }}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <DyField
                label={t.maxBytes}
                inputMode="numeric"
                value={form.maxBytes}
                onChange={(v) => {
                  set({ maxBytes: v });
                }}
              />
              <DyField
                label={t.perJob}
                inputMode="numeric"
                value={form.maxPerJob}
                onChange={(v) => {
                  set({ maxPerJob: v });
                }}
              />
              <DyField
                label={t.perHour}
                inputMode="numeric"
                value={form.maxPerHour}
                onChange={(v) => {
                  set({ maxPerHour: v });
                }}
              />
            </div>
          </fieldset>
          {invalid !== null ? (
            <DyNotice tone="red" live>
              {invalid}
            </DyNotice>
          ) : null}
          <FormActions>
            <DyButton type="submit" variant="primary" busy={submit.busy} disabled={submit.blocked}>
              {t.save}
            </DyButton>
            {saved ? (
              <span role="status" className="text-[0.8125rem] font-medium text-dy-green">
                {t.saved}
              </span>
            ) : null}
          </FormActions>
          <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
        </form>
      )}
    </Panel>
  );
}

export function ContextReceiptsPanel(props: { readonly namespace: string }): ReactNode {
  const all = useT().knowledge.context;
  const t = all.receipts;
  const [open, setOpen] = useState(false);
  const [receipts, setReceipts] = useState<DeletionReceipt[] | null>(null);
  const load = useSubmit();
  // p9-pagination: receipts page in the browser (`?receiptsPage=`).
  const receiptPage = useClientPage(receipts ?? [], { label: t.pages, prefix: 'receipts' });

  if (!open)
    return (
      <div>
        <DyButton
          icon="file"
          onClick={() => {
            setOpen(true);
            void load.run(async () => {
              setReceipts(await listDeletionReceipts(props.namespace));
            });
          }}
        >
          {t.title}
        </DyButton>
      </div>
    );

  return (
    <Panel title={t.title} sub={t.sub} flush testId="dy-context-receipts">
      <div className="px-4 empty:hidden">
        <DyApiError error={load.error} retryLeft={load.retryLeft} />
      </div>
      {receipts === null ? (
        load.error === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : null
      ) : receipts.length === 0 ? (
        <EmptyLine>{t.none}</EmptyLine>
      ) : (
        <>
          <Rows label={t.title} testId="context-receipts">
            {receiptPage.pageItems.map((r) => (
              <Row
                key={r.id}
                testId="context-receipt-row"
                lead={<DyIcon name="trash" className="size-4" />}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{receiptText(all, r.action)}</span>
                    <span className="font-dy-mono text-[0.8125rem] font-normal" title={r.docId}>
                      {short(r.docId)}
                    </span>
                  </span>
                }
                meta={
                  <>
                    <DyTime iso={r.occurredAt} />
                    <span className="font-dy-mono">{r.versions.map((v) => `v${String(v)}`).join(', ')}</span>
                    <span>{r.actor.id === null ? r.actor.type : `${r.actor.type} ${short(r.actor.id)}`}</span>
                    {r.reason === null ? null : <span className="w-full">“{r.reason}”</span>}
                  </>
                }
              />
            ))}
          </Rows>
          <div className="px-4">
            <DyPager {...receiptPage.pagination} />
          </div>
        </>
      )}
    </Panel>
  );
}
