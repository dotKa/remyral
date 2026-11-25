import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { type ChatThread, listThreads } from '../../../api/chat';
import {
  getReport,
  getReportSettings,
  listReports,
  previewReport,
  putReportSettings,
  type ReportContent,
} from '../../../api/efficiency';
import { toApiError } from '../../../components/ui';
import { browserTimeZone } from '../../../screens/usage/budgets';
import { DyIcon } from '../../icons';
import { KeyValue } from '../../KeyValue';
import { RuntimeMark } from '../../RuntimeMark';
import { DyApiError, DyCheck, DyChoice, DyInput } from '../kit';
import { toast } from '../../toast/store';
import {
  DyButton,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
  StatTile,
  StatTiles,
  ThreadLink,
} from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import { useGuarded, useLoad } from './common';
import type { Formatter } from '@remyral/i18n';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useUsageFormat } from './format';

/**
 * p12-diyalog-w2: Kullanım → Raporlar and `/usage/reports/:id` in the Diyalog language — one's own weekly reports
 * (`GET /reports`, `/reports/:id`, the preview), the report settings (`PUT /reports/settings`, no step-up, as in the
 * classic form). The report content is the master's numbers, codes and names, rendered as text.
 */

/** A text for a master-sent word, or the word itself when the catalog does not know it. */
function known(map: Readonly<Record<string, string>>, id: string): string {
  return Object.hasOwn(map, id) ? (map[id] ?? id) : id;
}

function longDate(iso: string, f: Formatter): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : f.dateWith(d, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** The content of a weekly report: tiles, then one panel per section. */
export function ReportContentDy(props: { readonly c: ReportContent }): ReactNode {
  const { spendText } = useUsageFormat();
  const { formatUsd, formatCount, formatDurationMs, formatPercent } = useUsageFormat();
  const all = useT().usage;
  const t = all.reports;
  const c = props.c;
  const s = c.spend;
  const sav = c.savings;
  return (
    <div className="flex flex-col gap-4" data-testid="report-content">
      <StatTiles label={t.weekSummary}>
        <StatTile
          label={t.finished}
          value={formatCount(c.ran.finished)}
          note={t.ranNote({
            ok: formatCount(c.ran.succeeded),
            failed: formatCount(c.ran.failed),
            cancelled: formatCount(c.ran.cancelled),
          })}
          tone={c.ran.failed > 0 ? 'red' : undefined}
        />
        <StatTile
          label={t.apiSpend}
          value={spendText(s)}
          note={t.previousWeek({ usd: formatUsd(s.previousWeekCostUsd) })}
        />
        <StatTile
          label={t.subscriptionEstimate}
          value={s.subscriptionRecords > 0 ? `≈ ${formatUsd(s.apiEquivalentUsd)}` : '—'}
          note={t.subscriptionNote}
        />
        <StatTile
          label={t.deploys}
          value={formatCount(c.deployed.total)}
          note={t.deployNote({
            ok: formatCount(c.deployed.succeeded),
            failed: formatCount(c.deployed.failed),
          })}
        />
      </StatTiles>

      {c.ran.byProject.length === 0 ? null : (
        <Panel title={t.byProject} count={String(c.ran.byProject.length)} flush>
          <Rows label={t.byProjectRows}>
            {c.ran.byProject.map((p) => (
              <Row
                key={p.project}
                lead={<DyIcon name="folder" className="size-4" />}
                title={<span className="font-dy-mono">{p.project}</span>}
                trail={
                  <span className="font-dy-mono text-[0.8125rem] tabular-nums">
                    {t.ranNote({
                      ok: String(p.succeeded),
                      failed: String(p.failed),
                      cancelled: String(p.cancelled),
                    })}
                  </span>
                }
              />
            ))}
          </Rows>
        </Panel>
      )}

      {c.budgets.length === 0 ? null : (
        <Panel title={t.budgets} count={String(c.budgets.length)} flush>
          <Rows label={t.budgets}>
            {c.budgets.map((b) => (
              <Row
                key={b.id}
                lead={<DyIcon name="gauge" className="size-4" />}
                tone={b.status === 'over' ? 'red' : b.status === 'under' ? 'green' : 'amber'}
                title={b.name}
                meta={
                  <>
                    <span>{b.scope}</span>
                    <span>{b.policy}</span>
                    <span>{t.windowEnd({ end: b.windowEnd })}</span>
                  </>
                }
                trail={
                  <span className="font-dy-mono text-[0.8125rem] tabular-nums">
                    {t.budgetUse({
                      used: b.used,
                      limit: b.limit,
                      pct: formatPercent(b.ratio),
                      state: known(all.budgetState, b.status),
                    })}
                  </span>
                }
              />
            ))}
          </Rows>
        </Panel>
      )}

      {c.deployed.items.length === 0 ? null : (
        <Panel title={t.deployList} count={String(c.deployed.total)} flush>
          <Rows label={t.deployList}>
            {c.deployed.items.slice(0, 10).map((d) => (
              <Row
                key={d.id}
                lead={<DyIcon name="rocket" className="size-4" />}
                tone={d.state === 'succeeded' ? 'green' : d.state === 'failed' ? 'red' : undefined}
                title={
                  <Link to={`/deploys/${encodeURIComponent(d.id)}`} className="no-underline hover:underline">
                    {d.project}: {d.kind}
                    {d.env === null ? '' : ` (${d.env})`}
                  </Link>
                }
                trail={<span className="text-[0.8125rem]">{known(t.states, d.state)}</span>}
              />
            ))}
          </Rows>
        </Panel>
      )}

      {c.failures.length === 0 ? null : (
        <Panel title={t.failures} count={String(c.failures.length)} flush>
          <Rows label={t.failedJobs}>
            {c.failures.map((f) => (
              <Row
                key={f.jobId}
                lead={<DyIcon name="xc" className="size-4" />}
                tone="red"
                title={
                  <Link
                    to={`/jobs/${encodeURIComponent(f.jobId)}`}
                    className="font-dy-mono no-underline hover:underline"
                  >
                    {f.jobId.slice(0, 8)}
                  </Link>
                }
                meta={
                  <>
                    <span>{f.project}</span>
                    <RuntimeMark runtime={f.runtime} />
                    {f.errorCode === null ? null : <span className="font-dy-mono">{f.errorCode}</span>}
                  </>
                }
                actions={
                  <ThreadLink
                    target={{ kind: 'job', id: f.jobId }}
                    about={all.jobAbout({ id: f.jobId.slice(0, 8) })}
                  />
                }
              />
            ))}
          </Rows>
        </Panel>
      )}

      {c.topCostly.length + c.slowest.length === 0 ? null : (
        <Panel title={t.costlySlow} flush>
          <Rows label={t.costlySlowRows}>
            {c.topCostly.map((j) => (
              <Row
                key={`c${j.jobId}`}
                lead={<Pill tone="neutral">$</Pill>}
                title={
                  <Link
                    to={`/jobs/${encodeURIComponent(j.jobId)}`}
                    className="font-dy-mono no-underline hover:underline"
                  >
                    {j.jobId.slice(0, 8)}
                  </Link>
                }
                meta={<span>{j.project}</span>}
                trail={
                  <span className="font-dy-mono text-[0.8125rem] tabular-nums">
                    {spendText(j)}
                    {j.apiEquivalentUsd > 0 ? t.apiEquivalent({ usd: formatUsd(j.apiEquivalentUsd) }) : ''}
                  </span>
                }
              />
            ))}
            {c.slowest.map((j) => (
              <Row
                key={`s${j.jobId}`}
                lead={<DyIcon name="clock" className="size-4" />}
                title={
                  <Link
                    to={`/jobs/${encodeURIComponent(j.jobId)}`}
                    className="font-dy-mono no-underline hover:underline"
                  >
                    {j.jobId.slice(0, 8)}
                  </Link>
                }
                meta={<span>{j.project}</span>}
                trail={
                  <span className="font-dy-mono text-[0.8125rem] tabular-nums">
                    {j.durationSec === null ? '—' : formatDurationMs(j.durationSec * 1000)}
                  </span>
                }
              />
            ))}
          </Rows>
        </Panel>
      )}

      <Panel title={t.savings}>
        <KeyValue
          rows={[
            {
              k: t.reuse,
              v: t.reuseValue({
                n: sav.reuse.hits,
                time: formatDurationMs(sav.reuse.estimatedSeconds * 1000),
              }),
            },
            {
              k: t.autoApprove,
              v: t.autoApproveValue({
                n: sav.safeAutoApprove.approvals,
                time: formatDurationMs(sav.safeAutoApprove.estimatedSecondsSaved * 1000),
              }),
            },
            { k: t.warm, v: t.warmValue({ n: sav.warmCaches.runs }) },
          ]}
        />
      </Panel>

      {c.suggestions.length === 0 ? null : (
        <Panel
          title={t.suggestions}
          count={String(c.suggestions.length)}
          aside={
            <Link
              to="/usage?tab=suggestions"
              className="text-[0.8125rem] font-medium text-dy-teal-ink no-underline hover:underline"
            >
              {t.toSuggestions}
            </Link>
          }
          flush
        >
          <Rows label={t.suggestionRows}>
            {c.suggestions.map((x) => (
              <Row
                key={x.id}
                lead={<DyIcon name="brain" className="size-4" />}
                title={x.title}
                meta={<span>{x.detail}</span>}
              />
            ))}
          </Rows>
        </Panel>
      )}
    </div>
  );
}

function SettingsPanel(): ReactNode {
  const t = useT().usage.reports.settings;
  const [zone, setZone] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [thread, setThread] = useState('');
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const g = useGuarded();
  const settings = useLoad(getReportSettings);
  useEffect(() => {
    const v = settings.data;
    if (v === null) return;
    setZone(v.timeZone);
    setEnabled(v.weeklyEnabled);
    setThread(v.chatThreadId ?? '');
  }, [settings.data]);
  useEffect(() => {
    listThreads().then(setThreads, () => {
      setThreads([]);
    });
  }, []);
  return (
    <Panel title={t.title} sub={t.sub} testId="dy-report-settings">
      {settings.data === null ? (
        settings.error === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : (
          <DyApiError error={settings.error} />
        )
      ) : (
        <form
          aria-label={t.form}
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void g
              .run(
                async () => {
                  settings.set(
                    await putReportSettings({
                      timeZone: zone.trim(),
                      weeklyEnabled: enabled,
                      chatThreadId: thread === '' ? null : thread,
                    }),
                  );
                },
                '',
                false,
              )
              .then((ok) => {
                // p17-toasts-rest: a save result → toast.
                if (ok)
                  toast.success(t.saved, { id: 'report-settings-saved', testId: 'report-settings-saved' });
              });
          }}
        >
          <DyCheck label={t.weekly} checked={enabled} onChange={setEnabled} />
          <div className="grid gap-2 sm:grid-cols-[minmax(0,320px)_auto] sm:items-end">
            <DyInput
              label={t.zone}
              value={zone}
              maxLength={64}
              onChange={(e) => {
                setZone(e.target.value);
              }}
            />
            <DyButton
              variant="ghost"
              onClick={() => {
                setZone(browserTimeZone());
              }}
            >
              {t.useBrowser}
            </DyButton>
          </div>
          <DyChoice
            label={t.chat}
            value={thread}
            onChange={setThread}
            className="max-w-[420px]"
            options={[['', t.no], ...threads.filter((x) => !x.archived).map((x) => [x.id, x.title] as const)]}
          />
          <DyApiError error={g.error} />
          <div>
            <DyButton type="submit" variant="primary" busy={g.busy}>
              {t.save}
            </DyButton>
          </div>
        </form>
      )}
    </Panel>
  );
}

export function ReportsView(): ReactNode {
  const fmt = useFormat();
  const t = useT().usage.reports;
  const list = useLoad(listReports);
  const [preview, setPreview] = useState<ReportContent | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewError, setPreviewError] = useState<ReturnType<typeof toApiError> | null>(null);
  return (
    <section aria-label={t.section} className="flex flex-col gap-4" data-testid="dy-reports">
      <SettingsPanel />
      <ErrorLine error={list.error} what={t.what} onRetry={list.reload} />
      <Panel
        title={t.mine}
        count={list.data === null ? undefined : String(list.data.length)}
        aside={
          <DyButton
            icon="clock"
            busy={busy}
            onClick={() => {
              setBusy(true);
              setPreviewError(null);
              previewReport('current')
                .then(setPreview, (err: unknown) => {
                  setPreviewError(toApiError(err));
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            {t.preview}
          </DyButton>
        }
        flush
      >
        {list.data === null ? (
          list.error === null ? (
            <SkeletonRows label={t.loading} rows={2} />
          ) : null
        ) : list.data.length === 0 ? (
          <EmptyLine>{t.empty}</EmptyLine>
        ) : (
          <Rows label={t.mine} testId="report-list">
            {list.data.map((r) => (
              <Row
                key={r.id}
                lead={<DyIcon name="file" className="size-4" />}
                title={
                  <Link
                    to={`/usage/reports/${encodeURIComponent(r.id)}`}
                    className="no-underline hover:underline"
                  >
                    {t.week({ date: longDate(r.periodStart, fmt) })}
                  </Link>
                }
                meta={
                  <>
                    <span>{r.summary}</span>
                    <span className="font-dy-mono">{r.timeZone}</span>
                  </>
                }
              />
            ))}
          </Rows>
        )}
      </Panel>
      <DyApiError error={previewError} />
      {preview === null ? null : (
        <section aria-label={t.preview} className="flex flex-col gap-3">
          <h2 className="m-0 text-[1.125rem] font-extrabold">{t.soFar({ label: preview.period.label })}</h2>
          <ReportContentDy c={preview} />
        </section>
      )}
    </section>
  );
}

/** `/usage/reports/:id`: one of one's own stored weekly reports. */
export function ReportScreen(props: { readonly id: string }): ReactNode {
  const { id } = props;
  const t = useT().usage.reports.screen;
  const r = useLoad(() => getReport(id));
  const title = r.data === null ? t.title : t.titleWith({ label: r.data.content.period.label });
  return (
    <ScreenFrame
      title={title}
      purpose={r.data === null ? t.purpose : t.purposeWith({ zone: r.data.content.period.timeZone })}
      back={{ to: '/usage?tab=reports', label: t.back }}
      testId="dy-report"
    >
      <ErrorLine error={r.error} what={t.what} onRetry={r.reload} />
      {r.data === null ? (
        r.error === null ? (
          <SkeletonRows label={t.loading} rows={4} />
        ) : null
      ) : (
        <ReportContentDy c={r.data.content} />
      )}
    </ScreenFrame>
  );
}
