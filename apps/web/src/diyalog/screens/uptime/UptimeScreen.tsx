import { type ReactNode, type SubmitEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ApiError } from '../../../api/client';
import { listProjects, type Project } from '../../../api/directory';
import {
  listMonitorsPage,
  type Monitor,
  type MonitorFilter,
  pct,
  type StatusFilter,
  targetText,
  updateMonitor,
} from '../../../api/uptime';
import { cx, toApiError } from '../../../components/ui';
import { useOffsetList } from '../../../lib/pager';
import { DyIcon } from '../../icons';
import { INK } from '../../tone';
import { DyPager } from '../kit';
import { ScreenFrame } from '../ScreenFrame';
import {
  DyButton,
  DySearch,
  DySelect,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
} from '../parts';
import { MonitorFormDialog } from './MonitorFormDialog';
import { Ago, causeTr, LatencyLine, providerTr, shownOf, STATE, TYPE_WORD, WRITE_ROLES } from './shared';

/**
 * p12-diyalog Faz 4 (docs/design/p12-diyalog.md §12): Uptime in the Diyalog language — every monitor of the visible
 * projects with its state (icon + word + tone), uptime over 24 h / 7 d / 30 d, the 24 h latency line and the last
 * check or open incident; down first (the master's order). Same requests as the classic page (`GET
 * /uptime/monitors` pages, the per-status totals, refreshed every 30 s); "Yeni monitör" is the Diyalog monitor form
 * and the name opens the Diyalog monitor page (`/uptime/:id`, p12-diyalog-w2). Pause / resume is the classic detail page's `PATCH { paused }`, offered on the row
 * to operators. Names, targets and details are untrusted text: rendered as text.
 */

const REFRESH_MS = 30_000;
const STATUSES = ['down', 'up', 'pending', 'paused'] as const;

interface StatusCounts {
  readonly down: number;
  readonly up: number;
  readonly pending: number;
  readonly paused: number;
}

function countLocal(list: readonly Monitor[]): StatusCounts {
  return {
    down: list.filter((m) => !m.paused && m.status === 'down').length,
    up: list.filter((m) => !m.paused && m.status === 'up').length,
    pending: list.filter((m) => !m.paused && m.status === 'pending').length,
    paused: list.filter((m) => m.paused).length,
  };
}

/** The classic page's status summary: from the rows when they all fit, else one `limit=1` total per status. */
function useStatusCounts(
  filter: MonitorFilter,
  items: readonly Monitor[] | null,
  total: number | null,
  page: number,
): StatusCounts {
  const whole = items !== null && page === 1 && total !== null && total <= items.length;
  const [remote, setRemote] = useState<StatusCounts | null>(null);
  const key = JSON.stringify(filter);
  useEffect(() => {
    if (items === null || whole) return;
    let live = true;
    const base: MonitorFilter = { ...filter };
    delete (base as { status?: unknown }).status;
    Promise.all(
      STATUSES.map((s) =>
        filter.status !== undefined && filter.status !== s
          ? Promise.resolve(0)
          : listMonitorsPage({ ...base, status: s }, { offset: 0, limit: 1 }).then((r) => r.total),
      ),
    ).then(
      ([down = 0, up = 0, pending = 0, paused = 0]) => {
        if (live) setRemote({ down, up, pending, paused });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // `filter` is captured through `key`; `items` only matters when it changes from loading to loaded.
  }, [key, whole, items === null, total]);
  if (whole) return countLocal(items);
  return remote ?? countLocal(items ?? []);
}

function latencySummary(m: Monitor): string {
  const known = m.sparkline.filter((v): v is number => v !== null);
  if (known.length === 0) return `${m.name}: son 24 saatte gecikme ölçümü yok`;
  return `${m.name}, son 24 saatte gecikme: en düşük ${String(Math.round(Math.min(...known)))} ms, en yüksek ${String(Math.round(Math.max(...known)))} ms, ortalama ${m.latencyAvg24h === null ? '—' : `${String(m.latencyAvg24h)} ms`}`;
}

export function UptimeScreen(): ReactNode {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState('');
  const [status, setStatus] = useState<StatusFilter | ''>('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const filter = useMemo(
    () => ({
      ...(project === '' ? {} : { project }),
      ...(status === '' ? {} : { status }),
      ...(q === '' ? {} : { q }),
    }),
    [project, status, q],
  );
  const list = useOffsetList<Monitor>({
    key: JSON.stringify(filter),
    label: 'Monitör sayfaları',
    fetchPage: (offset, limit) => listMonitorsPage(filter, { offset, limit }),
  });
  const items = list.loaded && list.error === null ? list.items : null;
  const { reload, reset } = list;

  useEffect(() => {
    listProjects().then(setProjects, () => undefined);
  }, []);
  useEffect(() => {
    const t = setInterval(reload, REFRESH_MS);
    return () => {
      clearInterval(t);
    };
  }, [reload]);

  const writable = useMemo(() => projects.filter((p) => WRITE_ROLES.has(p.myRole)), [projects]);
  const writableIds = useMemo(() => new Set(writable.map((p) => p.id)), [writable]);
  const counts = useStatusCounts(filter, items, list.pagination.total ?? null, list.pagination.page);

  async function togglePause(m: Monitor): Promise<void> {
    setBusy(m.id);
    setActionError(null);
    try {
      await updateMonitor(m.id, { paused: !m.paused });
      reload();
    } catch (err) {
      setActionError(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  const pickStatus = (s: StatusFilter | ''): void => {
    setStatus(s);
    reset();
  };

  return (
    <ScreenFrame
      title="Uptime"
      purpose="Yayınladıkların erişilebilir mi? Master sitelerini, servislerini, Cloudflare Pages ve Coolify uygulamalarını yoklar; biri düşünce haber verir."
      live={list.error === null ? 'live' : 'error'}
      testId="dy-uptime"
      actions={
        writable.length > 0 ? (
          <DyButton
            variant="primary"
            icon="plus"
            onClick={() => {
              setCreating(true);
            }}
          >
            Yeni monitör
          </DyButton>
        ) : undefined
      }
    >
      {/* p12-diyalog-default (visual tour): the summary is drawn from the start ("—" until the list is read), so the
          filters and the list below do not jump down when it arrives. */}
      <ul aria-label="Durum özeti" className="m-0 mb-5 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4">
        {STATUSES.map((s) => {
          const st = STATE[s];
          const n = counts[s];
          const active = status === s;
          return (
            <li key={s} data-testid={`uptime-count-${s}`}>
              <button
                type="button"
                aria-pressed={active}
                disabled={items === null}
                onClick={() => {
                  pickStatus(active ? '' : s);
                }}
                className={cx(
                  'dy-press block w-full min-w-0 rounded-[12px] border bg-dy-card px-3.5 py-2.5 text-left',
                  active
                    ? 'border-dy-ink'
                    : 'border-dy-line [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-line-2',
                )}
              >
                <span className={cx('flex items-center gap-1.5 text-[0.8125rem] font-bold', INK[st.tone])}>
                  <DyIcon name={st.icon} className="size-3.5" />
                  {st.word}
                </span>
                <span
                  className={cx(
                    'mt-0.5 block text-[1.375rem] leading-tight font-extrabold tracking-[-0.015em]',
                    s === 'down' && n > 0 && 'text-dy-red-ink',
                  )}
                >
                  {items === null ? '—' : n}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <form
        aria-label="Süzgeçler"
        className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3"
        onSubmit={(e: SubmitEvent<HTMLFormElement>) => {
          e.preventDefault();
          setQ(search.trim());
          reset();
        }}
      >
        <DySearch
          label="Ara"
          placeholder="Ad, URL, host"
          value={search}
          onChange={(v) => {
            setSearch(v);
            if (v === '') {
              setQ('');
              reset();
            }
          }}
        />
        <DySelect
          label="Proje"
          value={project}
          options={[['', 'Tüm projeler'], ...projects.map((p) => [p.id, p.name] as const)]}
          onChange={(v) => {
            setProject(v);
            reset();
          }}
        />
        <DySelect
          label="Durum"
          value={status}
          options={[
            ['', 'Her durum'],
            ['down', 'Çalışmıyor'],
            ['up', 'Çalışıyor'],
            ['pending', 'Bekliyor'],
            ['paused', 'Duraklatıldı'],
          ]}
          onChange={(v) => {
            pickStatus(v as StatusFilter | '');
          }}
        />
        <button type="submit" className="sr-only">
          Ara
        </button>
      </form>
      <ErrorLine error={list.error} what="Monitörler" onRetry={reload} />
      <ErrorLine error={actionError} what="Monitör güncellemesi" />
      <Panel
        title="Monitörler"
        count={items === null ? undefined : String(list.pagination.total ?? items.length)}
        flush
      >
        {items === null ? (
          list.error === null ? (
            <SkeletonRows label="Monitörler yükleniyor" rows={4} />
          ) : null
        ) : items.length === 0 ? (
          <EmptyLine testId="uptime-empty">
            Henüz monitör yok. “Yeni monitör” ile ekle ya da Çıktılar’da bir site açıp “Monitor this” seç.
          </EmptyLine>
        ) : (
          <Rows label="Monitör listesi" testId="uptime-list">
            {items.map((m) => (
              <MonitorRow
                key={m.id}
                monitor={m}
                writable={writableIds.has(m.project)}
                busy={busy === m.id}
                onPause={() => void togglePause(m)}
              />
            ))}
          </Rows>
        )}
        {items !== null ? <DyPager {...list.pagination} /> : null}
      </Panel>
      <MonitorFormDialog
        open={creating}
        monitor={null}
        projects={writable}
        defaultProject={project !== '' && writableIds.has(project) ? project : (writable[0]?.id ?? '')}
        onClose={() => {
          setCreating(false);
        }}
        onSaved={(m) => {
          setCreating(false);
          void navigate(`/uptime/${encodeURIComponent(m.id)}`);
        }}
      />
    </ScreenFrame>
  );
}

function MonitorRow(props: {
  readonly monitor: Monitor;
  readonly writable: boolean;
  readonly busy: boolean;
  readonly onPause: () => void;
}): ReactNode {
  const m = props.monitor;
  const s = STATE[shownOf(m)];
  const provider = providerTr(m.type, m.lastCheck?.detail ?? null, m.status);
  return (
    <Row
      testId="monitor-row"
      tone={s.tone}
      lead={<DyIcon name={s.icon} className="size-[18px]" />}
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            to={`/uptime/${encodeURIComponent(m.id)}`}
            className="min-w-0 font-bold [overflow-wrap:anywhere] text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
          >
            {m.name}
          </Link>
          <Pill tone={s.tone} icon={s.icon} className="font-bold">
            <span data-testid="monitor-state">{s.word}</span>
          </Pill>
          {m.flapping ? (
            <Pill tone="amber" icon="retry" title="Kararlı olana kadar değişiklikler bildirilmez">
              dalgalı
            </Pill>
          ) : null}
        </span>
      }
      meta={
        <>
          <span translate="no">{m.project}</span>
          <span>{TYPE_WORD[m.type]}</span>
          <span className="min-w-0 font-dy-mono text-[0.75rem] break-all">
            {targetText(m.type, m.config)}
          </span>
          {provider !== null ? <span className="w-full">{provider}</span> : null}
          {m.openIncident !== null ? (
            <span className="w-full font-bold text-dy-red-ink" data-testid="open-incident">
              Kesinti <Ago iso={m.openIncident.startedAt} /> başladı — {causeTr(m.openIncident.cause)}
            </span>
          ) : m.lastCheck !== null ? (
            <span className="w-full">
              Son kontrol <Ago iso={m.lastCheck.at} />
              {m.lastCheck.latencyMs !== null ? (
                <>
                  {' · '}
                  <span className="font-dy-mono">{m.lastCheck.latencyMs} ms</span>
                </>
              ) : null}
              {m.lastCheck.ok === false && m.lastCheck.error !== null
                ? ` · ${causeTr(m.lastCheck.error)}`
                : ''}
            </span>
          ) : (
            <span className="w-full">Henüz kontrol edilmedi</span>
          )}
        </>
      }
      trail={
        <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <dl className="m-0 grid grid-cols-3 gap-x-3 text-[0.78125rem]" aria-label="Erişilebilirlik">
            <div>
              <dt className="text-dy-muted">24 sa</dt>
              <dd className="m-0 font-dy-mono font-medium tabular-nums" data-testid="uptime-24h">
                {pct(m.uptime.h24)}
              </dd>
            </div>
            <div>
              <dt className="text-dy-muted">7 gün</dt>
              <dd className="m-0 font-dy-mono tabular-nums">{pct(m.uptime.d7)}</dd>
            </div>
            <div>
              <dt className="text-dy-muted">30 gün</dt>
              <dd className="m-0 font-dy-mono tabular-nums">{pct(m.uptime.d30)}</dd>
            </div>
          </dl>
          <span className="flex items-center gap-2">
            <LatencyLine values={m.sparkline} label={latencySummary(m)} />
            <span className="w-14 text-right font-dy-mono text-[0.78125rem] text-dy-muted tabular-nums">
              {m.latencyAvg24h === null ? '—' : `${String(m.latencyAvg24h)} ms`}
            </span>
          </span>
        </span>
      }
      actions={
        props.writable ? (
          <DyButton
            variant="ghost"
            icon={m.paused ? 'retry' : 'pause'}
            busy={props.busy}
            aria-label={m.paused ? `${m.name}: sürdür` : `${m.name}: duraklat`}
            onClick={props.onPause}
          >
            {m.paused ? 'Sürdür' : 'Duraklat'}
          </DyButton>
        ) : null
      }
    />
  );
}
