import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import {
  checkUpdateChannel,
  getUpdateChannel,
  installChannelRelease,
  setUpdatePolicy,
  type UpdateChannelOverview,
  type UpdatePolicy,
} from '../../../api/updateChannel';
import { useAuth } from '../../../auth/AuthProvider';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyIcon } from '../../icons';
import type { Tone } from '../../tone';
import { DyApiError } from '../forms';
import { agoText, DyButton, DySelect, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { CatalogProofLine, useCatalogProofs } from './runtimes-verification';

/**
 * p17-update-channel (ADR-0065, docs/design/p17-update-channel.md §6): Ayarlar → Sürümler → Güncelleme kanalı — the
 * signed worker release feed (source, last check, problem), the owner's automatic update policy, the releases of the
 * feed with "Güncelle", the last canary-first rollout and the version catalog with each machine's acceptance.
 */

const STATE_TONE: Readonly<Record<string, Tone>> = {
  awaiting_approval: 'amber',
  rolling_out: 'teal',
  done: 'green',
  import_failed: 'red',
  canary_failed: 'red',
};

export function UpdateChannelPanel(): ReactNode {
  const all = useT();
  const t = all.updateChannel;
  const w = all.screenKit.time;
  const { state } = useAuth();
  const owner = state.kind === 'signedIn' && state.user.role === 'owner';
  const admin = state.kind === 'signedIn' && (state.user.role === 'owner' || state.user.role === 'admin');
  // p17-runtime-verify: verification runs of catalog runtime versions and the owner's local mark.
  const catalogProofs = useCatalogProofs();
  const stepUp = useStepUp();
  const load = useSubmit();
  const act = useSubmit();
  const [data, setData] = useState<UpdateChannelOverview | null>(null);
  const [policy, setPolicy] = useState<UpdatePolicy>('patch_auto');
  const [soak, setSoak] = useState('30');
  const [done, setDone] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const soakId = useId();

  const apply = useCallback((d: UpdateChannelOverview) => {
    setData(d);
    setPolicy(d.policy);
    setSoak(String(d.soakMinutes));
  }, []);

  useEffect(() => {
    void load.run(async () => {
      apply(await getUpdateChannel());
    });
  }, []);

  const guarded = async (fn: () => Promise<UpdateChannelOverview>, reason: string, message: string) => {
    setDone(null);
    await act.run(async () => {
      try {
        apply(await stepUp.run(fn, reason));
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
      setDone(message);
    });
  };

  if (data === null) {
    return load.error === null ? (
      <SkeletonRows label={t.loading} rows={3} />
    ) : (
      <DyApiError error={load.error} />
    );
  }
  const soakN = Number(soak);
  const soakOk = Number.isInteger(soakN) && soakN >= 0 && soakN <= 10_080;
  const feedError =
    data.feed.error === null
      ? null
      : t.feedError({ reason: t.feedErrors[data.feed.error] ?? data.feed.error });
  return (
    <div className="flex flex-col gap-4" data-testid="dy-update-channel">
      <Panel
        title={t.title}
        sub={t.sub}
        testId="dy-channel-feed"
        aside={
          <DyButton
            variant="ghost"
            icon="retry"
            busy={act.busy}
            onClick={() => {
              void act.run(async () => {
                apply(await checkUpdateChannel());
              });
            }}
          >
            {t.check}
          </DyButton>
        }
      >
        {!data.configured ? <p className="m-0 text-[0.875rem]">{t.notConfigured}</p> : null}
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.875rem]">
          <dt className="font-bold">{t.source}</dt>
          <dd className="m-0">
            {data.feed.source === 'url'
              ? t.sourceUrl
              : data.feed.source === 'file'
                ? t.sourceFile
                : t.sourceNone}
            {data.feed.keyId === null ? '' : ` · ${t.keyId({ keyId: data.feed.keyId })}`}
          </dd>
          <dt className="font-bold">{t.lastCheck}</dt>
          <dd className="m-0">
            {data.feed.checkedAt === null ? t.never : agoText(data.feed.checkedAt, Date.now(), w)}
          </dd>
          <dt className="font-bold">{t.stable}</dt>
          <dd className="m-0 font-dy-mono">{data.stableVersion ?? '—'}</dd>
        </dl>
        {feedError !== null ? (
          <p role="alert" className="m-0 mt-2 text-[0.875rem] text-dy-red">
            {feedError}
          </p>
        ) : null}
        <form
          aria-label={t.policy}
          className="mt-3 grid gap-3 border-t border-dy-line pt-3 sm:grid-cols-[1.6fr_9rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void guarded(() => setUpdatePolicy(policy, soakN), t.policyStepUp, t.saved);
          }}
        >
          <DySelect
            label={t.policy}
            value={policy}
            options={(['patch_auto', 'manual', 'auto'] as const).map((p) => [p, t.policies[p] ?? p] as const)}
            onChange={(v) => {
              setPolicy(v as UpdatePolicy);
            }}
          />
          <label htmlFor={soakId} className="flex min-w-0 flex-col gap-1 text-[0.8125rem] font-bold">
            {t.soak}
            <input
              id={soakId}
              inputMode="numeric"
              value={soak}
              disabled={!owner}
              onChange={(e) => {
                setSoak(e.target.value);
              }}
              className="min-h-10 w-full rounded-[9px] border border-dy-line-2 bg-dy-card px-3 font-dy-mono text-[0.9375rem] font-normal sm:min-h-9 sm:text-[0.875rem]"
            />
          </label>
          <DyButton
            type="submit"
            variant="primary"
            icon="checkc"
            disabled={!owner || !soakOk}
            busy={act.busy}
          >
            {t.save}
          </DyButton>
          <p className="m-0 text-[0.8125rem] text-dy-ink-3 sm:col-span-3">
            {owner ? t.policyHint : t.ownerOnly}
          </p>
        </form>
        <div className="mt-2 flex flex-col gap-2">
          <DyApiError error={act.error} retryLeft={act.retryLeft} />
          {done !== null ? (
            <p role="status" className="m-0 flex items-center gap-1.5 text-[0.875rem] text-dy-green">
              <DyIcon name="checkc" className="size-4" />
              {done}
            </p>
          ) : null}
        </div>
      </Panel>

      <Panel title={t.releases} flush testId="dy-channel-releases">
        {data.releases.length === 0 ? (
          <EmptyLine>{t.noReleases}</EmptyLine>
        ) : (
          <Rows label={t.releases}>
            {data.releases.map((r) => {
              const waiting =
                r.state === 'awaiting_approval' || r.state === 'import_failed' || r.state === 'canary_failed';
              const canaryOpen = data.rollout?.version === r.version && data.rollout.stage === 'canary';
              return (
                <Row
                  key={r.version}
                  testId="dy-channel-release"
                  title={
                    <span className="flex flex-wrap items-baseline gap-2">
                      <b className="font-dy-mono">{r.version}</b>
                      <span className="text-[0.8125rem] text-dy-ink-3">{t.bump[r.bump] ?? r.bump}</span>
                    </span>
                  }
                  meta={
                    <>
                      <span>{r.summary}</span>
                      <span>{agoText(r.publishedAt, Date.now(), w)}</span>
                      {open === r.version ? (
                        <span className="w-full whitespace-pre-wrap">{r.notes}</span>
                      ) : null}
                    </>
                  }
                  trail={
                    <>
                      <Pill tone={STATE_TONE[r.state] ?? 'neutral'}>
                        {t.state[r.state] ?? r.state}
                        {r.error === null ? '' : ` (${r.error})`}
                      </Pill>
                      {r.notes !== '' ? (
                        <DyButton
                          variant="ghost"
                          aria-expanded={open === r.version}
                          onClick={() => {
                            setOpen(open === r.version ? null : r.version);
                          }}
                        >
                          {open === r.version ? t.hideNotes : t.notes}
                        </DyButton>
                      ) : null}
                      {waiting || canaryOpen ? (
                        <DyButton
                          variant="primary"
                          icon="rocket"
                          busy={act.busy}
                          onClick={() => {
                            void guarded(
                              () => installChannelRelease(r.version),
                              t.updateStepUp({ version: r.version }),
                              t.started({ version: r.version }),
                            );
                          }}
                        >
                          {canaryOpen ? t.toFleet : t.update}
                        </DyButton>
                      ) : null}
                    </>
                  }
                />
              );
            })}
          </Rows>
        )}
        {data.rollout !== null ? (
          <div className="border-t border-dy-line px-4 py-3 text-[0.875rem]" data-testid="dy-channel-rollout">
            <b>{t.rollout}: </b>
            <span className="font-dy-mono">{data.rollout.version}</span> ·{' '}
            {t.stages[data.rollout.stage] ?? data.rollout.stage} (
            {t.trigger[data.rollout.trigger] ?? data.rollout.trigger})
            {data.rollout.canary.length === 0 && data.rollout.stage === 'done' ? (
              <p className="m-0 mt-1 text-dy-ink-3">{t.noCanary}</p>
            ) : (
              <ul className="m-0 mt-1 list-none p-0">
                {data.rollout.canary.map((c) => (
                  <li key={c.workerId}>
                    <span translate="no" className="font-dy-mono">
                      {c.workerId}
                    </span>{' '}
                    — {t.canaryStatus[c.status] ?? c.status}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </Panel>

      <Panel title={t.catalog} sub={t.catalogSub} flush testId="dy-channel-catalog">
        {!data.catalog.enabled ? (
          <EmptyLine>{t.catalogOff}</EmptyLine>
        ) : data.catalog.sequence === null ? (
          <EmptyLine>{t.catalogNone}</EmptyLine>
        ) : (
          <Rows label={t.catalogSequence({ n: data.catalog.sequence })}>
            {data.catalog.items.map((i) => (
              <Row
                key={`${i.kind}:${i.item}:${i.version}`}
                title={
                  <span className="flex flex-wrap items-baseline gap-2">
                    <b>{i.item}</b>
                    <span className="font-dy-mono">{i.version}</span>
                  </span>
                }
                trail={
                  <span className="flex flex-wrap items-center justify-end gap-2">
                    {i.kind === 'runtime' && !i.verified && catalogProofs.proofs !== null ? (
                      <CatalogProofLine
                        runtime={i.item}
                        version={i.version}
                        proofs={catalogProofs.proofs}
                        canMark={admin}
                        onMarked={catalogProofs.reload}
                      />
                    ) : null}
                    <Pill tone={i.verified ? 'green' : 'amber'}>
                      {i.verified ? t.verified : t.unverified}
                    </Pill>
                  </span>
                }
              />
            ))}
          </Rows>
        )}
        {data.catalog.error !== null ? (
          <p role="alert" className="m-0 px-4 py-2 text-[0.875rem] text-dy-red">
            {t.catalogError({ reason: data.catalog.error })}
          </p>
        ) : null}
        {catalogProofs.proofs !== null &&
        data.catalog.items.some((i) => i.kind === 'runtime' && !i.verified) ? (
          <p
            className="m-0 border-t border-dy-line px-4 py-2 text-[0.8125rem] text-dy-muted"
            data-testid="catalog-vendor-note"
          >
            {all.runtimeVerify.catalog.vendorNote}
          </p>
        ) : null}
        <div className="border-t border-dy-line px-4 py-3 text-[0.875rem]">
          <b>{t.machines}</b>
          {data.catalog.workers.length === 0 ? (
            <p className="m-0 mt-1 text-dy-ink-3">{t.noMachines}</p>
          ) : (
            <ul className="m-0 mt-1 list-none p-0" data-testid="dy-channel-catalog-workers">
              {data.catalog.workers.map((m) => (
                <li key={m.workerId}>
                  <span translate="no" className="font-dy-mono">
                    {m.workerId}
                  </span>{' '}
                  —{' '}
                  {!m.enabled
                    ? t.machineDisabled
                    : m.keys === 0
                      ? t.machineNoKeys
                      : m.lastOutcome === 'refused'
                        ? t.machineRefused({ reason: m.lastReason ?? '?' })
                        : t.machineAccepted({ n: m.sequence })}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
    </div>
  );
}
