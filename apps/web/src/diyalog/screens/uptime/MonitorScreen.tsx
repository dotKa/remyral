import { type ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ApiError } from '../../../api/client';
import { listProjects, type Project } from '../../../api/directory';
import {
  type Check,
  checkNow,
  deleteMonitor,
  getMonitor,
  type Incident,
  type Monitor,
  monitorChecksPage,
  monitorIncidentsPage,
  monitorSeries,
  pct,
  type SeriesPoint,
  type SeriesRange,
  SERIES_RANGES,
  targetText,
  updateMonitor,
} from '../../../api/uptime';
import { cx, toApiError } from '../../../components/ui';
import { useCursorList } from '../../../lib/pager';
import { useSubmit } from '../../../screens/useSubmit';
import { DyIcon } from '../../icons';
import { KeyValue } from '../../KeyValue';
import { INK } from '../../tone';
import { ScreenFrame } from '../ScreenFrame';
import { DyApiError, DyConfirm, DyNotice, DyPager } from '../kit';
import {
  DyButton,
  DyButtonLink,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
  StatTile,
  StatTiles,
} from '../parts';
import { LatencyChart } from './LatencyChart';
import { MonitorFormDialog } from './MonitorFormDialog';
import {
  absTr,
  Ago,
  causeTr,
  durationTr,
  providerTr,
  shownOf,
  STATE,
  TYPE_WORD,
  Until,
  WRITE_ROLES,
} from './shared';
import { useFormat } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog-w2 (docs/design/p12-diyalog.md §12): one monitor (`/uptime/:id`) in the Diyalog language — state
 * (icon + word + tone), flapping, provider status, open incident, certificate, last / next check, schedule, uptime
 * tiles, the latency / uptime chart (24 h · 7 d · 30 d · 90 d), incidents and recent checks as keyset pages with
 * their own URL position (`?incidentsCursor=&incidentsPage=` / `?checksCursor=&checksPage=`, the classic prefixes).
 * Operators check now, pause / resume, edit (the Diyalog monitor form) and delete (two-step confirm). Same requests
 * as the classic `MonitorDetailPage`; names, targets and details are untrusted text, rendered as text.
 */

const RANGE_WORD: Readonly<Record<SeriesRange, string>> = {
  '24h': '24 saat',
  '7d': '7 gün',
  '30d': '30 gün',
  '90d': '90 gün',
};
const RANGE_SHORT: Readonly<Record<SeriesRange, string>> = {
  '24h': '24 sa',
  '7d': '7 gün',
  '30d': '30 gün',
  '90d': '90 gün',
};

export function MonitorScreen(props: { readonly id: string }): ReactNode {
  const fmt = useFormat();
  const { id } = props;
  const navigate = useNavigate();
  const [monitor, setMonitor] = useState<Monitor | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [range, setRange] = useState<SeriesRange>('24h');
  const [points, setPoints] = useState<SeriesPoint[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [reload, setReload] = useState(0);
  const [doing, setDoing] = useState<'check' | 'pause' | 'delete' | null>(null);
  const action = useSubmit();
  const incidentList = useCursorList<Incident>({
    key: `${id}:${String(reload)}`,
    label: 'Kesinti sayfaları',
    prefix: 'incidents',
    fetchPage: (cursor, limit) => monitorIncidentsPage(id, { cursor, limit }),
  });
  const checkList = useCursorList<Check>({
    key: `${id}:${String(reload)}`,
    label: 'Kontrol sayfaları',
    prefix: 'checks',
    fetchPage: (cursor, limit) => monitorChecksPage(id, { cursor, limit }),
  });
  const incidents = incidentList.loaded ? incidentList.items : null;
  const checks = checkList.loaded ? checkList.items : null;

  useEffect(() => {
    listProjects().then(setProjects, () => undefined);
  }, []);
  useEffect(() => {
    const ctl = new AbortController();
    getMonitor(id, { signal: ctl.signal }).then(
      (m) => {
        setMonitor(m);
        setError(null);
      },
      (err: unknown) => {
        if (!ctl.signal.aborted) setError(toApiError(err));
      },
    );
    return () => {
      ctl.abort();
    };
  }, [id, reload]);
  useEffect(() => {
    const ctl = new AbortController();
    setPoints(null);
    monitorSeries(id, range, { signal: ctl.signal }).then(setPoints, () => {
      if (!ctl.signal.aborted) setPoints([]);
    });
    return () => {
      ctl.abort();
    };
  }, [id, range, reload]);

  const back = { to: '/uptime', label: 'Uptime' };

  if (monitor === null) {
    return (
      <ScreenFrame title="Monitör" back={back} testId="dy-monitor">
        {error === null ? (
          <Panel title="Monitör" flush>
            <SkeletonRows label="Monitör yükleniyor" rows={4} />
          </Panel>
        ) : error.status === 404 ? (
          <Panel title="Monitör bulunamadı" flush testId="monitor-not-found">
            <EmptyLine
              action={
                <DyButtonLink to="/uptime" icon="back">
                  Uptime’a dön
                </DyButtonLink>
              }
            >
              Silinmiş olabilir ya da projesini göremiyorsun.
            </EmptyLine>
          </Panel>
        ) : (
          <ErrorLine
            error={error}
            what="Monitör"
            onRetry={() => {
              setReload((n) => n + 1);
            }}
          />
        )}
      </ScreenFrame>
    );
  }

  const m = monitor;
  const canWrite = WRITE_ROLES.has(projects.find((p) => p.id === m.project)?.myRole ?? '');
  const st = STATE[shownOf(m)];
  const provider = providerTr(m.type, m.lastCheck?.detail ?? null, m.status);

  const run = (what: 'check' | 'pause', fn: () => Promise<Monitor>): void => {
    setDoing(what);
    void action
      .run(async () => {
        setMonitor(await fn());
        setReload((n) => n + 1);
      })
      .finally(() => {
        setDoing(null);
      });
  };

  const facts = (
    <>
      <Pill tone={st.tone} icon={st.icon}>
        <span data-testid="monitor-state">{st.word}</span>
      </Pill>
      {m.statusChangedAt === null ? null : (
        <span className="text-[0.8125rem] text-dy-muted">
          <Ago iso={m.statusChangedAt} /> beri
        </span>
      )}
      {m.flapping ? (
        <Pill tone="amber" icon="retry">
          <span data-testid="flapping">dalgalı</span>
        </Pill>
      ) : null}
      {m.createdBy.type === 'system' ? <Pill tone="neutral">otomatik monitör</Pill> : null}
    </>
  );

  const lc = m.lastCheck;
  const rows = [
    { k: 'Proje', v: <span translate="no">{m.project}</span> },
    { k: 'Tür', v: TYPE_WORD[m.type] },
    { k: 'Hedef', v: targetText(m.type, m.config), mono: true },
    ...(provider === null
      ? []
      : [{ k: 'Sağlayıcı', v: <span data-testid="provider-status">{provider}</span> }]),
    {
      k: 'Son kontrol',
      v:
        lc === null ? (
          'Henüz kontrol edilmedi'
        ) : (
          <span>
            <Ago iso={lc.at} />
            {lc.statusCode !== null ? ` · HTTP ${String(lc.statusCode)}` : ''}
            {lc.latencyMs !== null ? ` · ${String(lc.latencyMs)} ms` : ''}
            {lc.ok === false ? ` · ${causeTr(lc.error)}` : ''}
            {lc.ok === null ? ` · karar verilemedi (${causeTr(lc.error)})` : ''}
          </span>
        ),
    },
    ...(m.paused
      ? []
      : [
          {
            k: 'Sonraki kontrol',
            v: (
              <span data-testid="next-check">
                <Until iso={m.nextCheckAt} />
              </span>
            ),
          },
        ]),
    ...(m.tls === null
      ? []
      : [
          {
            k: 'Sertifika',
            v: (
              <span data-testid="certificate">
                {absTr(m.tls.expiresAt, fmt)} tarihinde bitiyor ({m.tls.daysLeft} gün)
              </span>
            ),
          },
        ]),
    {
      k: 'Zamanlama',
      v: `her ${String(m.intervalSec)} sn · zaman aşımı ${String(m.timeoutMs)} ms · üst üste ${String(m.retries + 1)} hatalı kontrolde kapalı · master’dan`,
    },
    ...(m.outputKey === null
      ? []
      : [
          {
            k: 'Çıktı',
            v: (
              <Link
                to={`/outputs?item=${encodeURIComponent(m.outputKey)}`}
                className="font-medium text-dy-teal-ink"
                data-testid="monitor-output-link"
              >
                Siteyi Çıktılar’da aç
              </Link>
            ),
          },
        ]),
    {
      k: 'Oluşturuldu',
      v: (
        <span>
          <Ago iso={m.createdAt} />
          {m.createdBy.type === 'system' ? ' · otomatik (auto-monitor)' : ''}
        </span>
      ),
    },
  ];

  return (
    <ScreenFrame
      title={m.name}
      back={back}
      purpose={
        <>
          {TYPE_WORD[m.type]} ·{' '}
          <span className="font-dy-mono text-[0.84375rem] break-all">{targetText(m.type, m.config)}</span>
        </>
      }
      facts={facts}
      testId="dy-monitor"
      actions={
        canWrite ? (
          <>
            <DyButton
              icon="retry"
              busy={doing === 'check'}
              disabled={action.blocked || doing !== null}
              onClick={() => {
                run('check', () => checkNow(m.id));
              }}
            >
              Şimdi kontrol et
            </DyButton>
            <DyButton
              icon={m.paused ? 'retry' : 'pause'}
              busy={doing === 'pause'}
              disabled={doing !== null}
              onClick={() => {
                run('pause', () => updateMonitor(m.id, { paused: !m.paused }));
              }}
            >
              {m.paused ? 'Sürdür' : 'Duraklat'}
            </DyButton>
            <DyButton
              icon="pen"
              onClick={() => {
                setEditing(true);
              }}
            >
              Düzenle
            </DyButton>
            <DyConfirm
              label="Sil"
              icon="trash"
              testId="monitor-delete"
              question="Kontrolleri ve kesintileriyle silinsin mi?"
              busy={doing === 'delete'}
              onConfirm={() => {
                setDoing('delete');
                void action
                  .run(async () => {
                    await deleteMonitor(m.id);
                  })
                  .then((ok) => {
                    setDoing(null);
                    if (ok) void navigate('/uptime');
                  });
              }}
            />
          </>
        ) : undefined
      }
    >
      <div className="grid gap-5">
        <DyApiError error={action.error} retryLeft={action.retryLeft} />
        {m.openIncident === null ? null : (
          <DyNotice tone="red" testId="open-incident">
            <strong>Kesinti sürüyor:</strong> {absTr(m.openIncident.startedAt, fmt)} tarihinden beri —{' '}
            {causeTr(m.openIncident.cause)}
          </DyNotice>
        )}
        {m.flapping ? (
          <DyNotice tone="amber" testId="flapping-note">
            Durum sık değişiyor (dalgalı): 30 dakika kararlı kalana kadar değişiklikler bildirilmez.
          </DyNotice>
        ) : null}
        {m.tls !== null && m.tls.warning ? (
          <DyNotice tone="amber" testId="tls-warning">
            TLS sertifikası {m.tls.daysLeft} gün içinde bitiyor ({absTr(m.tls.expiresAt, fmt)}).
          </DyNotice>
        ) : null}

        <StatTiles label="Erişilebilirlik ve gecikme">
          <StatTile label="Ayakta, 24 sa" value={<span data-testid="tile-24h">{pct(m.uptime.h24)}</span>} />
          <StatTile label="Ayakta, 7 gün" value={pct(m.uptime.d7)} />
          <StatTile label="Ayakta, 30 gün" value={pct(m.uptime.d30)} />
          <StatTile
            label="Ortalama gecikme, 24 sa"
            value={m.latencyAvg24h === null ? '—' : `${String(m.latencyAvg24h)} ms`}
          />
        </StatTiles>

        <Panel
          title="Gecikme ve erişilebilirlik"
          aside={
            <div
              role="group"
              aria-label="Aralık"
              className="flex gap-0.5 rounded-[10px] border border-dy-line bg-dy-sunk p-[3px]"
            >
              {SERIES_RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={range === r}
                  aria-label={`Son ${RANGE_WORD[r]}`}
                  onClick={() => {
                    setRange(r);
                  }}
                  className={cx(
                    'inline-flex min-h-8 items-center rounded-[7px] px-2.5 text-[0.8125rem] font-medium whitespace-nowrap',
                    range === r
                      ? 'bg-dy-card text-dy-ink shadow-dy-seg'
                      : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
                  )}
                >
                  {RANGE_SHORT[r]}
                </button>
              ))}
            </div>
          }
        >
          {points === null ? (
            <SkeletonRows label="Grafik yükleniyor" rows={3} />
          ) : points.length === 0 ? (
            <p className="m-0 py-4 text-[0.875rem] text-dy-muted" data-testid="chart-empty">
              Son {RANGE_WORD[range]} içinde kontrol yok.
            </p>
          ) : (
            <LatencyChart points={points} range={range} rangeWord={RANGE_WORD[range]} />
          )}
        </Panel>

        <div className="grid gap-5 min-[1000px]:grid-cols-2">
          <Panel title="Durum" testId="monitor-facts">
            <KeyValue rows={rows} />
          </Panel>
          <Panel title="Kesintiler" flush testId="incidents-panel">
            {incidents === null ? (
              <SkeletonRows label="Kesintiler yükleniyor" />
            ) : incidents.length === 0 ? (
              <EmptyLine>Kesinti yok.</EmptyLine>
            ) : (
              <Rows label="Kesintiler" testId="incidents">
                {incidents.map((i) => (
                  <Row
                    key={i.id}
                    testId="incident"
                    tone={i.endedAt === null ? 'red' : 'neutral'}
                    lead={<DyIcon name={i.endedAt === null ? 'xc' : 'checkc'} className="size-[18px]" />}
                    title={
                      <span>
                        {causeTr(i.cause)}
                        {i.detail === null ? null : (
                          <span className="font-normal text-dy-muted"> — {i.detail}</span>
                        )}
                      </span>
                    }
                    meta={
                      <>
                        <span>{absTr(i.startedAt, fmt)}</span>
                        <span>{i.endedAt === null ? 'sürüyor' : `bitti ${absTr(i.endedAt, fmt)}`}</span>
                        {i.suppressed ? (
                          <span className="font-medium text-dy-amber-ink" data-testid="suppressed">
                            bildirilmedi: dalgalı
                          </span>
                        ) : null}
                      </>
                    }
                    trail={
                      <span className="font-dy-mono text-[0.8125rem] text-dy-muted tabular-nums">
                        {durationTr(i.durationMs)}
                      </span>
                    }
                  />
                ))}
              </Rows>
            )}
            {incidents === null ? null : (
              <DyPager {...incidentList.pagination} data-testid="incidents-pager" />
            )}
          </Panel>
        </div>

        <Panel title="Son kontroller" flush testId="checks-panel">
          {checks === null ? (
            <SkeletonRows label="Kontroller yükleniyor" />
          ) : checks.length === 0 ? (
            <EmptyLine>Henüz kontrol yok.</EmptyLine>
          ) : (
            <Rows label="Son kontroller" testId="checks">
              {checks.map((c) => {
                const s = c.ok === true ? STATE.up : c.ok === false ? STATE.down : STATE.pending;
                return (
                  <li
                    key={c.id}
                    data-testid="check"
                    className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-dy-line px-4 py-2 text-[0.84375rem] first:border-t-0"
                  >
                    <span className={cx('flex items-center gap-1.5 font-bold sm:w-[7.5rem]', INK[s.tone])}>
                      <DyIcon name={s.icon} className="size-4 shrink-0" />
                      <span className="sr-only sm:not-sr-only">{c.ok === null ? 'Karar yok' : s.word}</span>
                    </span>
                    <span className="text-dy-muted sm:w-[6.5rem]">{absTr(c.at, fmt)}</span>
                    {c.statusCode === null ? null : (
                      <span className="font-dy-mono text-[0.8125rem]">HTTP {c.statusCode}</span>
                    )}
                    {c.ok !== true && c.error !== null ? (
                      <span className="text-dy-muted">{causeTr(c.error)}</span>
                    ) : null}
                    {c.detail === null ? null : <span className="break-all text-dy-muted">{c.detail}</span>}
                    <span className="ml-auto font-dy-mono text-[0.8125rem] text-dy-muted tabular-nums">
                      {c.latencyMs === null ? '—' : `${String(c.latencyMs)} ms`}
                    </span>
                  </li>
                );
              })}
            </Rows>
          )}
          {checks === null ? null : <DyPager {...checkList.pagination} data-testid="checks-pager" />}
        </Panel>
      </div>
      <MonitorFormDialog
        open={editing}
        monitor={m}
        projects={projects}
        defaultProject={m.project}
        onClose={() => {
          setEditing(false);
        }}
        onSaved={(saved) => {
          setEditing(false);
          setMonitor(saved);
          setReload((n) => n + 1);
        }}
      />
    </ScreenFrame>
  );
}
