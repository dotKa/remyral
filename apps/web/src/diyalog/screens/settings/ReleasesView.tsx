import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import {
  type AttemptInfo,
  getReleaseAttempts,
  getReleases,
  promoteRelease,
  type ReleasesOverview,
} from '../../../api/releases';
import { DyPager } from '../../common/pager';
import { useCursorList } from '../../../lib/pager';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyTabs } from '../../formkit';
import { DyIcon, type IconName } from '../../icons';
import { DyApiError } from '../forms';
import { DyAttemptDiagnostics, DyReleaseUpload } from './settings-admin-release';
import { BreakerPanel } from './releases-breaker';
import { UpdateChannelPanel } from './releases-channel';
import { ServerUpdatePanel } from './ServerUpdatePanel';
import { useIsOwner } from '../../onboarding/useOnboarding';
import type { Tone } from '../../tone';
import {
  agoText,
  DyButton,
  DySelect,
  EmptyLine,
  Meter,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
} from '../parts';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog Faz 4 — Ayarlar → Worker sürümleri: the classic release routes (`GET /releases`, keyset attempt pages,
 * `POST /releases/channels/:channel` through `promoteRelease`) in the Diyalog language. Channels as rows with their
 * rollout meter, the roll-out form (always through step-up — the master refuses it without), uploaded releases, and
 * update attempts with the failure detail and their diagnostics. The signed upload (hashing, parts, resume, cancel,
 * step-up) and the diagnostics view are Diyalog too (`settings-admin-release.tsx`, over the classic
 * `uploadReleaseInParts` / `getAttemptDiagnostics`).
 *
 * p17-settings-tabs: three tabs — Yayılım (upload, the circuit breaker, channels and the roll-out form; the clean URL,
 * where the breaker's notifications land), Yüklenen sürümler and Güncelleme denemeleri.
 * p17-host-actions: owners also get Sunucu — the control plane's own update / rollback (`?tab=server`).
 */

const ATTEMPT: Readonly<Record<string, { tone: Tone; icon: IconName }>> = {
  succeeded: { tone: 'green', icon: 'checkc' },
  rolled_back: { tone: 'red', icon: 'retry' },
  failed: { tone: 'red', icon: 'xc' },
  refused: { tone: 'red', icon: 'xc' },
  pending: { tone: 'neutral', icon: 'clock' },
  downloading: { tone: 'teal', icon: 'retry' },
  installing: { tone: 'teal', icon: 'retry' },
};

function attemptState(
  t: Messages['settings']['releases'],
  status: string,
): { tone: Tone; icon: IconName; text: string } {
  const words: Readonly<Record<string, string>> = t.attempt;
  return { ...(ATTEMPT[status] ?? { tone: 'neutral', icon: 'clock' }), text: words[status] ?? status };
}

function AttemptRow(props: { readonly a: AttemptInfo }): ReactNode {
  const { a } = props;
  const all = useT();
  const t = all.settings.releases;
  const [open, setOpen] = useState(false);
  const panel = useId();
  const st = attemptState(t, a.status);
  const failed = a.status === 'rolled_back' || a.status === 'failed';
  return (
    <>
      <Row
        testId="dy-attempt"
        lead={<DyIcon name={st.icon} className="size-4" />}
        tone={st.tone}
        title={
          <span className="font-dy-mono text-[0.875rem] tabular-nums">
            {a.fromVersion} → {a.toVersion}
          </span>
        }
        meta={
          <>
            <span translate="no" className="font-dy-mono">
              {a.workerId}
            </span>
            <span>{agoText(a.updatedAt, Date.now(), all.screenKit.time)}</span>
            {failed && a.detail !== null ? <span className="w-full">{a.detail}</span> : null}
          </>
        }
        trail={
          <>
            <Pill tone={st.tone} icon={st.icon}>
              {st.text}
              {a.reason === null ? '' : ` (${a.reason})`}
            </Pill>
            {failed ? (
              <DyButton
                variant="ghost"
                aria-expanded={open}
                aria-controls={panel}
                onClick={() => {
                  setOpen(!open);
                }}
              >
                {open
                  ? t.hideDetail
                  : a.hasDiagnostics
                    ? t.whyVerdict({ verdict: a.verdict ?? t.detail })
                    : t.why}
              </DyButton>
            ) : null}
          </>
        }
      />
      {open ? (
        <li id={panel} className="border-t border-dy-line px-4 py-3">
          <DyAttemptDiagnostics attemptId={a.id} />
        </li>
      ) : null}
    </>
  );
}

export function ReleasesView(): ReactNode {
  const all = useT();
  const t = all.settings.releases;
  const tt = all.forms.tabs.releases;
  const owner = useIsOwner();
  const w = all.screenKit.time;
  const [data, setData] = useState<ReleasesOverview | null>(null);
  const [channel, setChannel] = useState('stable');
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState('100');
  const [done, setDone] = useState<string | null>(null);
  const load = useSubmit();
  const act = useSubmit();
  const stepUp = useStepUp();
  const pctId = useId();

  const attempts = useCursorList<AttemptInfo>({
    key: 'attempts',
    label: t.attemptPages,
    prefix: 'attempts',
    fetchPage: (cursor, limit) => getReleaseAttempts({ cursor, limit }),
  });
  const reloadAttempts = attempts.reload;
  const refresh = useCallback(async () => {
    await load.run(async () => {
      setData(await getReleases());
    });
    reloadAttempts();
  }, [load, reloadAttempts]);

  useEffect(() => {
    void refresh();
  }, []);

  const pct = Number(percent);
  const canPromote = version !== '' && Number.isInteger(pct) && pct >= 0 && pct <= 100;

  const rollOut = async (): Promise<void> => {
    setDone(null);
    const ok = await act.run(async () => {
      try {
        await stepUp.run(() => promoteRelease(channel, version, pct), t.rollOutStepUp({ version, channel }));
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
      setDone(t.rolledOut({ channel, version, pct }));
    });
    if (ok) await refresh();
  };

  // While the overview loads (an error shows in the upload card, as before).
  const loading = load.error === null ? <SkeletonRows label={t.loading} rows={3} /> : null;
  return (
    <div className="flex flex-col gap-4" data-testid="dy-releases">
      <DyTabs
        label={tt.label}
        testId="releases-tabs"
        items={[
          { id: 'rollout', label: tt.rollout },
          // p17-update-channel: the signed worker release feed, the automatic update policy, the version catalog.
          { id: 'channel', label: all.updateChannel.tab },
          { id: 'releases', label: tt.releases },
          { id: 'attempts', label: tt.attempts },
          // p17-host-actions: the server (control plane) update and rollback — owners only.
          ...(owner ? [{ id: 'server', label: all.hostActions.tab }] : []),
        ]}
      >
        {(tab) =>
          tab === 'server' ? (
            <ServerUpdatePanel />
          ) : tab === 'channel' ? (
            <UpdateChannelPanel />
          ) : tab === 'attempts' ? (
            <Panel title={t.attempts} flush testId="dy-attempts">
              {attempts.loaded && attempts.items.length === 0 ? (
                <EmptyLine>{t.noAttempts}</EmptyLine>
              ) : !attempts.loaded ? (
                <SkeletonRows label={t.attemptsLoading} rows={2} />
              ) : (
                <Rows label={t.attempts}>
                  {attempts.items.map((a) => (
                    <AttemptRow key={a.id} a={a} />
                  ))}
                </Rows>
              )}
              <div className="px-4 pb-3">
                <DyApiError error={attempts.error} />
                <DyPager {...attempts.pagination} />
              </div>
            </Panel>
          ) : tab === 'releases' ? (
            data === null ? (
              loading
            ) : (
              <Panel
                title={t.uploaded}
                count={String(data.releases.length)}
                countLabel={t.releaseCount({ n: data.releases.length })}
                flush
              >
                {data.releases.length === 0 ? (
                  <EmptyLine>{t.noReleases}</EmptyLine>
                ) : (
                  <Rows label={t.uploaded}>
                    {data.releases.map((r) => (
                      <Row
                        key={`${r.version}-${r.channel}`}
                        title={<span className="font-dy-mono text-[0.9375rem]">{r.version}</span>}
                        meta={
                          <>
                            <span>{r.channel}</span>
                            <span>{`${(r.sizeBytes / 1024 / 1024).toFixed(1)} MB`}</span>
                            <span translate="no" className="font-dy-mono">
                              {t.key({ keyId: r.keyId })}
                            </span>
                            <span>{agoText(r.uploadedAt, Date.now(), w)}</span>
                          </>
                        }
                      />
                    ))}
                  </Rows>
                )}
              </Panel>
            )
          ) : (
            <div className="flex flex-col gap-4">
              <Panel
                title={t.uploadTitle}
                sub={
                  <>
                    {t.uploadSubA}
                    <code>release.json</code>
                    {/* i18n-ignore: file / setting name */}
                    {t.uploadSubB}
                  </>
                }
              >
                <DyReleaseUpload onChanged={refresh} />
                <div className="mt-3 flex flex-col gap-2">
                  <DyApiError error={load.error ?? act.error} retryLeft={act.retryLeft} />
                  {done !== null ? (
                    <p
                      role="status"
                      className="m-0 flex items-center gap-1.5 rounded-[10px] bg-dy-green-soft px-3 py-2 text-[0.875rem] text-dy-green"
                    >
                      <DyIcon name="checkc" className="size-4" />
                      {done}
                    </p>
                  ) : null}
                </div>
              </Panel>
              {data === null ? (
                loading
              ) : (
                <>
                  {/* p16-ops-safety: the rollout circuit breaker (held rollouts: resume / roll back). */}
                  <BreakerPanel onChanged={() => void refresh()} />
                  <Panel
                    title={t.channels}
                    count={String(data.channels.length)}
                    countLabel={t.channelCount({ n: data.channels.length })}
                    sub={t.channelsSub}
                    flush
                    testId="dy-channels"
                  >
                    {data.channels.length === 0 ? (
                      <EmptyLine>{t.noChannels}</EmptyLine>
                    ) : (
                      <Rows label={t.channels}>
                        {data.channels.map((c) => (
                          <Row
                            key={c.channel}
                            lead={<DyIcon name="branch" className="size-4" />}
                            title={
                              <span className="flex flex-wrap items-baseline gap-2">
                                <b className="font-bold">{c.channel}</b>
                                <span className="font-dy-mono text-[0.875rem]">{c.version}</span>
                              </span>
                            }
                            meta={<span>{t.updated({ ago: agoText(c.updatedAt, Date.now(), w) })}</span>}
                            trail={
                              <Meter
                                className="w-40"
                                label={t.rollout({ channel: c.channel })}
                                value={c.rolloutPercent}
                                text={t.percent({ n: c.rolloutPercent })}
                                tone={c.rolloutPercent >= 100 ? 'green' : 'teal'}
                              />
                            }
                          />
                        ))}
                      </Rows>
                    )}
                    <form
                      aria-label={t.rollOutForm}
                      className="grid gap-3 border-t border-dy-line bg-dy-sunk px-4 py-3.5 sm:grid-cols-[1fr_1.4fr_7rem_auto] sm:items-end"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void rollOut();
                      }}
                    >
                      <DySelect
                        label={t.channel}
                        value={channel}
                        options={[
                          ['stable', 'stable'],
                          ['canary', 'canary'],
                        ]}
                        onChange={setChannel}
                      />
                      <DySelect
                        label={t.version}
                        value={version}
                        options={[
                          ['', t.choose],
                          ...data.releases.map((r) => [r.version, `${r.version} (${r.channel})`] as const),
                        ]}
                        onChange={setVersion}
                      />
                      <label
                        htmlFor={pctId}
                        className="flex min-w-0 flex-col gap-1 text-[0.8125rem] font-bold"
                      >
                        {t.rolloutPercent}
                        <input
                          id={pctId}
                          inputMode="numeric"
                          value={percent}
                          onChange={(e) => {
                            setPercent(e.target.value);
                          }}
                          className="min-h-10 w-full rounded-[9px] border border-dy-line-2 bg-dy-card px-3 font-dy-mono text-[0.9375rem] font-normal sm:min-h-9 sm:text-[0.875rem]"
                        />
                      </label>
                      <DyButton
                        type="submit"
                        variant="primary"
                        icon="rocket"
                        disabled={!canPromote}
                        busy={act.busy}
                      >
                        {t.rollOut}
                      </DyButton>
                    </form>
                  </Panel>
                </>
              )}
            </div>
          )
        }
      </DyTabs>
    </div>
  );
}
