import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { type DeployFailure, type DeployLogKind, getDeployFailure } from '../../../api/deployFeedback';
import type { ApiError } from '../../../api/client';
import {
  approveOpsAction,
  denyOpsAction,
  getOpsAction,
  idempotencyKey,
  kindText,
  listOpsActions,
  listOpsActionsPage,
  type OpsAction,
  refreshOpsAction,
  rollbackOpsAction,
} from '../../../api/deploy';
import { listDeployHealth } from '../../../api/verify';
import { useAuth } from '../../../auth/AuthProvider';
import { toApiError } from '../../../components/ui';
import { useNow } from '../../../lib/now';
import { useCursorList } from '../../../lib/pager';
import { DySortBar, sortRows, useSortParam } from '../../common/sort';
import { sourceLink, targetText } from '../../../screens/deploy/DeploysPage';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { Countdown } from '../../Countdown';
import { DyIcon, type IconName } from '../../icons';
import { KeyValue, type KeyValueRow } from '../../KeyValue';
import { DecisionPanel, useFreshStepUp } from '../../ops/DecisionPanel';
import type { Tone } from '../../tone';
import { absoluteText as absoluteTr } from '../../common/time';
import { DyApiError, DyConfirm, DyNotice, DyPager } from '../kit';
import {
  agoText,
  DyButton,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
  ThreadLink,
} from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import { DyDeployDiff, DyPublishSteps, DyResult } from './diff';
import { HealthPanel, HealthPill } from './health';
import { DeployLogsPanel, FixJobButton } from './feedback';
import { useFormat } from '../../../i18n/I18nProvider';

/** p12-deploy-feedback: kinds that have build / runtime / health logs. */
const LOG_KINDS = new Set([
  'coolify.deploy',
  'coolify.restart',
  'coolify.rollback',
  'pages.deploy',
  'pages.rollback',
  'pages.publish',
]);

/**
 * p12-diyalog-w2 (docs/design/p12-diyalog.md §14): Yayınlar (`/deploys`, `/deploys/:id`) in the Diyalog language —
 * every ops action (deploy, restart, Pages, DNS, preview tunnel, rollback) with who asked, what the master decided
 * and what happened. Same calls, URL state (`?cursor=&page=&pageSize=`) and rules as the classic `DeploysPage`; the
 * approval asks for the authenticator code in place when the policy says so or the master answers
 * `step_up_required`.
 */

export const OPS_STATE_TR: Readonly<Record<string, { label: string; tone: Tone; icon: IconName }>> = {
  awaiting_approval: { label: 'Onay bekliyor', tone: 'amber', icon: 'shield' },
  refused: { label: 'Reddedildi (politika)', tone: 'red', icon: 'xc' },
  denied: { label: 'Reddedildi', tone: 'neutral', icon: 'xc' },
  expired: { label: 'Süresi doldu', tone: 'neutral', icon: 'clock' },
  executing: { label: 'Çalışıyor', tone: 'teal', icon: 'retry' },
  deploying: { label: 'Yayınlanıyor', tone: 'teal', icon: 'retry' },
  succeeded: { label: 'Başarılı', tone: 'green', icon: 'checkc' },
  failed: { label: 'Başarısız', tone: 'red', icon: 'xc' },
};

export function OpsStatePill(props: { readonly state: string }): ReactNode {
  const s = OPS_STATE_TR[props.state] ?? {
    label: props.state,
    tone: 'neutral' as const,
    icon: 'clock' as const,
  };
  return (
    <span data-testid="ops-state" className="inline-flex">
      <Pill tone={s.tone} icon={s.icon}>
        {s.label}
      </Pill>
    </span>
  );
}

const KIND_TR: Readonly<Record<string, string>> = {
  'coolify.deploy': 'Coolify yayını',
  'coolify.restart': 'Coolify yeniden başlatma',
  'coolify.rollback': 'Coolify geri alma',
  'pages.deploy': 'Pages yayını',
  'pages.rollback': 'Pages geri alma',
  'dns.upsert': 'DNS değişikliği',
  'dns.delete': 'DNS silme',
  'pages.create_project': 'Pages projesi',
  'pages.add_domain': 'Pages alan adı',
  'pages.publish': 'Site yayını',
  'tunnel.open': 'Önizleme açma',
  'tunnel.close': 'Önizleme kapatma',
  'tunnel.extend': 'Önizleme uzatma',
};

export function kindTr(kind: string): string {
  return KIND_TR[kind] ?? kindText(kind);
}

function kindIcon(kind: string): IconName {
  if (kind.startsWith('dns.') || kind === 'pages.add_domain') return 'globe';
  if (kind.startsWith('tunnel.')) return 'term';
  if (kind.endsWith('.rollback')) return 'back';
  if (kind === 'coolify.restart') return 'retry';
  return 'rocket';
}

function titleOf(a: OpsAction): string {
  return `${kindTr(a.kind)}${a.env === null ? '' : ` · ${a.env}`}`;
}

function who(a: OpsAction): string {
  if (a.via === 'automation') return 'bir otomasyon';
  if (a.via === 'workflow') return 'bir iş akışı';
  if (a.via === 'job') return 'bir iş';
  const name = a.requestedBy.username ?? a.requestedBy.id;
  return a.via === 'api' ? name : `${name} (${a.via === 'chat' ? 'sohbet' : a.via})`;
}

const SOURCE_TR: Readonly<Record<string, string>> = {
  'Open the automation': 'Otomasyonu aç',
  'Open the job': 'İşi aç',
};

function sourceLabel(label: string): string {
  if (label.startsWith('Open the workflow run'))
    return label.replace('Open the workflow run', 'İş akışını aç').replace('(step ', '(adım ');
  return SOURCE_TR[label] ?? label;
}

function SourceLink(props: { readonly action: OpsAction }): ReactNode {
  const l = sourceLink(props.action);
  if (l === null) return null;
  return (
    <Link
      to={l.href}
      data-testid="ops-source"
      className="dy-press inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[0.8125rem] font-medium whitespace-nowrap text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-teal-soft"
    >
      <DyIcon name="branch" className="size-3.5" />
      {sourceLabel(l.label)}
    </Link>
  );
}

function decisionTr(decision: string, reason: string): string {
  switch (decision) {
    case 'auto':
      return 'Hemen çalışır (önizleme)';
    case 'approval':
      return 'Onay bekliyor';
    case 'approval_step_up':
      return 'Onay ve authenticator kodu bekliyor';
    case 'refused':
      return `Reddedildi${reason === '' ? '' : `: ${reason}`}`;
    default:
      return decision;
  }
}

function statusTr(a: OpsAction): string {
  if (a.state === 'awaiting_approval') return decisionTr(a.policy.decision, a.policy.reason);
  if (a.state === 'refused')
    return `Politika reddetti${a.policy.reason === '' ? '' : `: ${a.policy.reason}`}`;
  return OPS_STATE_TR[a.state]?.label ?? a.state;
}

// ------------------------------------------------------------------------------------------------ list

const DEPLOY_SORT_KEYS = ['created'] as const;
const DEPLOY_SORT_LABEL = { created: 'Oluşturulma' } as const;
const DEPLOY_COMPARE = {
  created: (x: OpsAction, y: OpsAction): number => Date.parse(x.createdAt) - Date.parse(y.createdAt),
} as const;

function DeploysList(): ReactNode {
  const fmt = useFormat();
  const list = useCursorList<OpsAction>({
    key: 'all',
    label: 'Yayın sayfaları',
    fetchPage: (cursor, limit) => listOpsActionsPage({ cursor, limit }),
  });
  // The classic table's sortable "Created" column over the loaded page, kept in the URL.
  const [sort, setSort] = useSortParam(DEPLOY_SORT_KEYS);
  const actions = list.loaded && list.error === null ? sortRows(list.items, sort, DEPLOY_COMPARE) : null;
  const now = useNow();
  const [waiting, setWaiting] = useState<number>(0);
  useEffect(() => {
    listOpsActions({ state: 'awaiting_approval', limit: 100 }).then(
      (w) => {
        setWaiting(w.length);
      },
      () => undefined,
    );
  }, []);
  const [health, setHealth] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (actions === null) return;
    const ctl = new AbortController();
    const byProject = new Map<string, string[]>();
    for (const a of actions) {
      if (a.state !== 'succeeded' || !/^(pages|coolify)\.(deploy|rollback)$/.test(a.kind)) continue;
      byProject.set(a.project, [...(byProject.get(a.project) ?? []), a.id]);
    }
    void Promise.all(
      [...byProject].map(([project, ids]) =>
        listDeployHealth(project, ids, { signal: ctl.signal }).catch(() => []),
      ),
    ).then((lists) => {
      if (ctl.signal.aborted) return;
      const m = new Map<string, string>();
      for (const h of lists.flat()) if (h.opsActionId !== null) m.set(h.opsActionId, h.state);
      setHealth(m);
    });
    return () => {
      ctl.abort();
    };
  }, [actions]);

  return (
    <ScreenFrame
      title="Yayınlar"
      purpose="Master’ın insanlar, sohbet ve otomasyonlar için çalıştırdığı (ya da reddettiği) yayınlar, yeniden başlatmalar, Pages yayınları ve DNS değişiklikleri."
      testId="dy-deploys"
      facts={
        waiting > 0 ? (
          <span data-testid="deploys-waiting">
            <Pill tone="amber" icon="shield">
              {waiting === 1 ? '1 eylem onay bekliyor' : `${String(waiting)} eylem onay bekliyor`}
            </Pill>
          </span>
        ) : undefined
      }
    >
      <Panel title="Eylemler" flush testId="ops-actions">
        {actions === null ? (
          list.error === null ? (
            <SkeletonRows label="Yayınlar yükleniyor" rows={4} />
          ) : (
            <div className="px-4 pb-3">
              <ErrorLine error={list.error} what="Yayınlar" onRetry={list.reload} />
            </div>
          )
        ) : actions.length === 0 ? (
          <EmptyLine testId="deploys-empty">
            Henüz yayın ya da DNS değişikliği yok. Bir projenin Yayın sekmesinden, sohbetten ya da bir
            otomasyondan istenenler burada listelenir.
          </EmptyLine>
        ) : (
          <>
            <DySortBar
              keys={DEPLOY_SORT_KEYS}
              labels={DEPLOY_SORT_LABEL}
              sort={sort}
              onSort={setSort}
              defaultNote="Sunucu sırası: en yeni önce"
              sortedNote="Bu sayfanın içinde sıralı"
              className="border-b border-dy-line"
              testId="deploy-sort"
            />
            <Rows label="Yayınlar ve DNS değişiklikleri">
              {actions.map((a) => {
                const st = OPS_STATE_TR[a.state];
                const h = health.get(a.id);
                return (
                  <Row
                    key={a.id}
                    testId="ops-row"
                    flipKey={a.id}
                    tone={st?.tone}
                    lead={<DyIcon name={kindIcon(a.kind)} className="size-[18px]" />}
                    title={
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Link
                          to={`/deploys/${encodeURIComponent(a.id)}`}
                          className="text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                        >
                          {titleOf(a)}
                        </Link>
                        <OpsStatePill state={a.state} />
                        {h === undefined ? null : <HealthPill state={h} />}
                      </span>
                    }
                    meta={
                      <>
                        <span>{a.project}</span>
                        <span className="min-w-0 [overflow-wrap:anywhere]">{targetText(a)}</span>
                        <span>{who(a)}</span>
                        <time dateTime={a.createdAt} title={absoluteTr(a.createdAt, fmt)}>
                          {agoText(a.createdAt, now)}
                        </time>
                      </>
                    }
                    actions={
                      <>
                        <SourceLink action={a} />
                        {a.state === 'awaiting_approval' ? (
                          <ThreadLink target={{ kind: 'deploy', id: a.id }} about={titleOf(a)} />
                        ) : null}
                      </>
                    }
                  />
                );
              })}
            </Rows>
          </>
        )}
        {actions === null ? null : <DyPager {...list.pagination} />}
      </Panel>
    </ScreenFrame>
  );
}

// ------------------------------------------------------------------------------------------------ detail

function useCanDecide(): boolean {
  const { state } = useAuth();
  return state.kind === 'signedIn' && state.user.role !== 'viewer';
}

function DeployDetail(props: { readonly id: string }): ReactNode {
  const fmt = useFormat();
  const navigate = useNavigate();
  const stepUp = useStepUp();
  const fresh = useFreshStepUp('deploy.production');
  const canDecide = useCanDecide();
  const now = useNow();
  const [action, setAction] = useState<OpsAction | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [intent, setIntent] = useState<'approve' | 'deny' | null>(null);
  const [search] = useSearchParams();
  const wantedLogs = search.get('logs');
  const [logs, setLogs] = useState<DeployLogKind | null>(
    wantedLogs === 'build' || wantedLogs === 'runtime' || wantedLogs === 'health' ? wantedLogs : null,
  );
  const [failure, setFailure] = useState<DeployFailure | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setAction(await getOpsAction(props.id));
    } catch (err) {
      setError(toApiError(err));
    }
  }, [props.id]);
  useEffect(() => {
    setAction(null);
    void load();
  }, [load]);
  // p12-deploy-feedback: what failed (the action or the health check after it) — the fix job button follows it.
  const settled = action !== null && (action.state === 'failed' || action.state === 'succeeded');
  useEffect(() => {
    setFailure(null);
    if (!settled || !LOG_KINDS.has(action.kind)) return;
    void getDeployFailure(action.id)
      .then(setFailure)
      .catch(() => undefined);
  }, [settled, action?.id, action?.kind]);

  const landed = (out: OpsAction): void => {
    if (out.id !== props.id) void navigate(`/deploys/${encodeURIComponent(out.id)}`);
    else setAction(out);
  };

  const act = async (name: string, fn: () => Promise<OpsAction | null>): Promise<void> => {
    setBusy(name);
    setError(null);
    try {
      const out = await fn();
      if (out !== null) landed(out);
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  };

  const back = { to: '/deploys', label: 'Yayınlar' };
  if (action === null)
    return (
      <ScreenFrame title="Yayın" back={back} testId="dy-deploy">
        {error === null ? (
          <Panel title="Eylem">
            <SkeletonRows label="Eylem yükleniyor" rows={4} />
          </Panel>
        ) : (
          <ErrorLine error={error} what="Eylem" onRetry={() => void load()} />
        )}
      </ScreenFrame>
    );

  const a = action;
  const waiting = a.state === 'awaiting_approval';
  const stepUpPolicy = a.policy.decision === 'approval_step_up';
  const needsCode = stepUpPolicy && !fresh;
  const facts: KeyValueRow[] = [
    { k: 'Durum', v: <span data-testid="ops-policy">{statusTr(a)}</span> },
    ...(waiting ? [] : [{ k: 'Politika', v: a.policy.reason === '' ? '—' : a.policy.reason }]),
    { k: 'Hedef', v: targetText(a), mono: true },
    { k: 'İsteyen', v: `${who(a)} · ${absoluteTr(a.createdAt, fmt)}` },
    ...(a.note === null ? [] : [{ k: 'Not', v: a.note }]),
    ...(a.decidedBy === null
      ? []
      : [
          {
            k: 'Karar',
            v: `${a.decidedBy.username ?? a.decidedBy.id}${a.decidedAt === null ? '' : ` · ${absoluteTr(a.decidedAt, fmt)}`}${
              a.decisionReason === null ? '' : ` · “${a.decisionReason}”`
            }`,
          },
        ]),
    ...(a.finishedAt === null ? [] : [{ k: 'Bitti', v: absoluteTr(a.finishedAt, fmt) }]),
  ];
  return (
    <ScreenFrame
      title={titleOf(a)}
      back={back}
      testId="dy-deploy"
      live={a.state === 'deploying' || a.state === 'executing' ? 'live' : undefined}
      purpose={
        <>
          Proje{' '}
          <Link to={`/projects/${encodeURIComponent(a.project)}?tab=deploy`} className="text-dy-teal-ink">
            {a.project}
          </Link>{' '}
          · {who(a)} istedi · {agoText(a.createdAt, now)}
        </>
      }
      facts={
        <>
          <OpsStatePill state={a.state} />
          <SourceLink action={a} />
          {waiting ? <ThreadLink target={{ kind: 'deploy', id: a.id }} about={titleOf(a)} /> : null}
        </>
      }
      actions={
        <>
          {a.state === 'deploying' ? (
            <DyButton
              icon="retry"
              busy={busy === 'refresh'}
              disabled={busy !== null}
              onClick={() => void act('refresh', () => refreshOpsAction(a.id))}
            >
              Durumu yenile
            </DyButton>
          ) : null}
          {LOG_KINDS.has(a.kind) && canDecide ? (
            <DyButton
              icon="term"
              disabled={busy !== null}
              aria-expanded={logs !== null}
              onClick={() => {
                setLogs(logs === null ? (failure?.failure === 'health' ? 'health' : 'build') : null);
              }}
            >
              Loglar
            </DyButton>
          ) : null}
          {failure?.failure != null && canDecide ? <FixJobButton actionId={a.id} /> : null}
          {a.rollbackAvailable ? (
            <DyConfirm
              label="Geri al"
              icon="back"
              variant="warn"
              question="Önceki sürüme geri dönülsün mü?"
              confirmLabel="Evet, geri al"
              busy={busy === 'rollback'}
              disabled={busy !== null}
              testId="rollback"
              onConfirm={() =>
                void act('rollback', () =>
                  stepUp.run(
                    () => rollbackOpsAction(a.id, idempotencyKey('rollback')),
                    'Geri alma güncel bir authenticator kodu ister.',
                  ),
                )
              }
            />
          ) : null}
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-4">
          {waiting ? (
            <Panel
              title="Karar"
              testId="ops-decision"
              sub={
                stepUpPolicy
                  ? 'Bu eylem onay ve authenticator kodu ister. Yalnızca bu eylem, bir kez; denetim kaydına girer.'
                  : 'Bu eylem onay ister. Yalnızca bu eylem, bir kez; denetim kaydına girer.'
              }
            >
              <div className="grid gap-3">
                {a.expiresAt === null ? null : (
                  <Countdown
                    until={a.expiresAt}
                    from={a.createdAt}
                    label="Karar verilmezse süresi doluyor"
                    tone="amber"
                  />
                )}
                {canDecide ? (
                  <>
                    <div className="flex flex-wrap gap-2">
                      <DyButton
                        variant="primary"
                        icon="rocket"
                        aria-expanded={intent === 'approve'}
                        onClick={() => {
                          setIntent('approve');
                        }}
                      >
                        Onayla ve çalıştır
                      </DyButton>
                      <DyButton
                        variant="danger"
                        icon="xc"
                        aria-expanded={intent === 'deny'}
                        onClick={() => {
                          setIntent('deny');
                        }}
                      >
                        Reddet
                      </DyButton>
                    </div>
                    {intent === null ? null : (
                      <DecisionPanel
                        key={intent}
                        intent={intent}
                        needsCode={intent === 'approve' && needsCode}
                        submitLabel={
                          intent === 'approve'
                            ? needsCode
                              ? 'Kodu gönder ve çalıştır'
                              : 'Onayla ve çalıştır'
                            : 'Reddet'
                        }
                        reason={{
                          required: false,
                          placeholder:
                            intent === 'approve'
                              ? 'Denetim kaydına girer (isteğe bağlı)…'
                              : 'İsteyen görür (isteğe bağlı)…',
                        }}
                        onSubmit={async (reason) => {
                          const out =
                            intent === 'approve'
                              ? await approveOpsAction(a.id, reason)
                              : await denyOpsAction(a.id, reason);
                          setIntent(null);
                          landed(out);
                        }}
                        onCancel={() => {
                          setIntent(null);
                        }}
                      />
                    )}
                  </>
                ) : (
                  <p className="m-0 text-[0.8125rem] text-dy-muted">Bu kararı verme yetkin yok.</p>
                )}
              </div>
            </Panel>
          ) : null}
          <Panel title="Değişiklik" sub="Master’ın hesapladığı fark (isteyenin değil).">
            <DyDeployDiff diff={a.diff} />
          </Panel>
          {a.result !== null || a.error !== null ? (
            <Panel title="Sonuç">
              <div className="grid gap-3">
                {a.error === null ? null : (
                  <DyNotice tone="red">
                    <span className="[overflow-wrap:anywhere]">{a.error}</span>
                  </DyNotice>
                )}
                {a.result !== null && a.kind === 'pages.publish' ? (
                  <DyPublishSteps result={a.result} />
                ) : null}
                {a.result === null ? null : <DyResult result={a.result} />}
              </div>
            </Panel>
          ) : null}
          {failure?.failure == null ? null : (
            <DyNotice tone="red" testId="deploy-failure">
              <span className="[overflow-wrap:anywhere]">{failure.summary}</span>
            </DyNotice>
          )}
          {logs === null ? null : <DeployLogsPanel actionId={a.id} kind={a.kind} initial={logs} />}
        </div>
        <div className="grid min-w-0 gap-4">
          <DyApiError error={error} />
          <Panel title="Ayrıntılar">
            <KeyValue rows={facts} />
            {a.rollbackOf === null ? null : (
              <p className="m-0 mt-2 text-[0.875rem]">
                <Link to={`/deploys/${encodeURIComponent(a.rollbackOf)}`} className="text-dy-teal-ink">
                  Geri aldığı eylemi aç
                </Link>
              </p>
            )}
          </Panel>
          {a.state === 'succeeded' ? <HealthPanel actionId={a.id} /> : null}
        </div>
      </div>
    </ScreenFrame>
  );
}

export function DeploysScreen(props: { readonly id: string | null }): ReactNode {
  return props.id === null ? <DeploysList /> : <DeployDetail id={props.id} />;
}
