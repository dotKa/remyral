import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  type AutomationDetail,
  type AutomationRun,
  type AutomationRunDetail,
  deleteAutomation,
  endWebhookOverlap,
  getAutomation,
  getAutomationRun,
  listAutomationRunsPage,
  pauseAutomation,
  resumeAutomation,
  rotateWebhookSecret,
  runAutomationNow,
  type WebhookSecret,
} from '../../../api/automations';
import type { ApiError } from '../../../api/client';
import { formatBytes } from '../../../api/workspaces';
import { toApiError } from '../../../components/ui';
import { useCursorList } from '../../../lib/pager';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { APPROVAL_TR, SANDBOX_TR } from '../../compose/labels';
import { DyIcon } from '../../icons';
import { KeyValue, type KeyValueRow } from '../../KeyValue';
import { DyApiError, DyChoice, DyConfirm, DyDialog, DyNotice, DyPager } from '../kit';
import { ScreenFrame, SegTabs } from '../ScreenFrame';
import { BindingEditLink, BindingNotice, BindingPill } from './WorkflowBinding';
import { GroupPanel, GroupPill } from './GroupParts';
import {
  agoText,
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
  ThreadLink,
} from '../parts';
import {
  CATCH_UP_TR,
  CONCURRENCY_TR,
  durationTr,
  eventLineTr,
  OUTCOME_TR,
  percentText,
  RUN_TR,
  timeoutTr,
  TRIGGER_TR,
  whenText,
} from './labels';
import { AutomationPill, CurlExample, RunPill, SecretPanel, UnattendedNote, WaitingPill } from './shared';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { toast } from '../../toast/store';
import { SolvedBefore } from '../../related/RelatedWork';
import type { Messages } from '@remyral/i18n';
import { scheduleSummary } from '../../../lib/schedule';

/**
 * p12-diyalog-w2: one automation (/automations/:id) in the Diyalog language. Tabs keep the classic ids
 * (`?tab=overview|runs|trigger|settings`). Every action is the classic call with the classic step-up: Run now,
 * replace the webhook secret (step-up, one-time secret + curl), end the overlap, pause, resume (step-up), delete.
 */

const TABS = [
  { id: 'overview', label: 'Genel bakış' },
  { id: 'runs', label: 'Çalıştırmalar' },
  { id: 'trigger', label: 'Tetik' },
  { id: 'settings', label: 'Ayarlar' },
] as const;

function createdNotice(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('created' in state)) return null;
  return 'Otomasyon oluşturuldu.';
}

export function AutomationScreen(props: { readonly id: string }): ReactNode {
  const { id } = props;
  const location = useLocation();
  const [a, setA] = useState<AutomationDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [runsKey, setRunsKey] = useState(0);
  const created = createdNotice(location.state);

  const load = useCallback(() => {
    getAutomation(id).then(
      (x) => {
        setA(x);
        setError(null);
      },
      (err: unknown) => {
        setError(toApiError(err));
      },
    );
  }, [id]);
  useEffect(load, [load]);
  const refresh = (): void => {
    load();
    setRunsKey((k) => k + 1);
  };
  const live = a !== null && (a.state === 'active' || a.state === 'paused');

  return (
    <ScreenFrame
      title={a?.name ?? 'Otomasyon'}
      back={{ to: '/automations', label: 'Otomasyonlar' }}
      purpose={a?.triggerSummary}
      testId="dy-automation"
      facts={
        a === null ? undefined : (
          <>
            <AutomationPill state={a.state} />
            <BindingPill automation={a} />
            <GroupPill automation={a} />
            <Pill tone="neutral">{a.project}</Pill>
            {a.waiting !== null ? <WaitingPill waiting={a.waiting} /> : null}
          </>
        )
      }
      actions={
        live ? (
          <>
            {a.workflowBinding === null ? (
              <DyButtonLink to={`/automations/${encodeURIComponent(a.id)}/edit`} icon="pen">
                Düzenle
              </DyButtonLink>
            ) : (
              <BindingEditLink automation={a} />
            )}
            <RunNow id={a.id} onDone={refresh} />
          </>
        ) : undefined
      }
    >
      {a === null ? null : <BindingNotice automation={a} />}
      {created !== null ? (
        <DyNotice tone="green" live className="mb-4">
          {created}
        </DyNotice>
      ) : null}
      <ErrorLine error={error} what="Otomasyon" onRetry={load} />
      {a === null && error === null ? <SkeletonRows label="Otomasyon yükleniyor" rows={4} /> : null}
      {a !== null ? (
        <SegTabs label="Otomasyon" items={TABS}>
          {(tab) =>
            tab === 'runs' ? (
              <Runs key={runsKey} automation={a} />
            ) : tab === 'trigger' ? (
              <TriggerTab automation={a} />
            ) : tab === 'settings' ? (
              <SettingsTab automation={a} onChanged={refresh} />
            ) : (
              <Overview automation={a} onChanged={refresh} />
            )
          }
        </SegTabs>
      ) : null}
    </ScreenFrame>
  );
}

/** Where "Çalıştırmayı aç" goes: the run's job, its workflow run, else the automation's run list. */
function runTarget(run: AutomationRunDetail, pathname: string): string {
  if (run.jobId !== null) return `/jobs/${encodeURIComponent(run.jobId)}`;
  if (run.workflowRunId !== null) return `/jobs/workflows/${encodeURIComponent(run.workflowRunId)}`;
  return `${pathname}?tab=runs`;
}

function RunNow(props: { readonly id: string; readonly onDone: () => void }): ReactNode {
  const submit = useSubmit();
  const stepUp = useStepUp();
  const { pathname } = useLocation();
  const w = useT().shared.actionToast;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <DyButton
        variant="primary"
        icon="send"
        busy={submit.busy}
        disabled={submit.blocked}
        onClick={() => {
          void submit
            .run(async () => {
              try {
                const run = await stepUp.run(
                  () => runAutomationNow(props.id),
                  'Otomasyonu şimdi çalıştırmak için güncel bir doğrulama kodu gir.',
                );
                // p17-toasts-shortcuts: the result is a toast with the way to the run (not a line under the button).
                if (run.state === 'skipped')
                  toast.info(w.runSkipped({ reason: run.reason ?? '' }), { testId: 'run-now-note' });
                else
                  toast.success(w.runStarted, {
                    testId: 'run-now-note',
                    actions: [{ label: w.openRun, to: runTarget(run, pathname), testId: 'run-now-open' }],
                  });
              } catch (err) {
                if (!(err instanceof StepUpCancelledError)) throw err;
              }
            })
            .then((ok) => {
              if (ok) props.onDone();
            });
        }}
      >
        Şimdi çalıştır
      </DyButton>
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </span>
  );
}

function runsText(a: AutomationDetail): ReactNode {
  if (a.target.kind === 'job') {
    const rt = a.target.runtime ?? 'runtime';
    return `Bir iş (${rt})${a.target.title === null ? '' : `: ${a.target.title}`}`;
  }
  if (a.target.kind === 'deploy') {
    const d = a.target.deployAction;
    const env = d?.params.env === 'production' ? 'production' : 'preview';
    const verb = d?.kind === 'coolify.restart' ? 'yeniden başlat' : 'deploy et';
    return (
      <span data-testid="automation-deploy-target">
        {d === null
          ? 'Bir deploy'
          : `Coolify ${env} ${verb}${d.params.force === true ? ', önbelleksiz' : ''}`}
        {env === 'production' ? ' — her çalıştırma bir onay bekler' : ''} (
        <Link to="/deploys" className="text-dy-teal-ink">
          Deploy’lar
        </Link>
        )
      </span>
    );
  }
  return 'Bir iş akışı çalıştırması';
}

/** A failed step's error in words where the code is known (expression errors, workflow issues), else as reported. */
function failureWords(w: Messages['workflows'], code: string | null, message: string | null): string | null {
  const key = (code ?? message ?? '').split(':')[0] ?? '';
  return (
    (w.expr.errors as Record<string, string>)[key] ??
    (w.issues as Record<string, string>)[key] ??
    message ??
    code
  );
}

/**
 * The last failed run: when, why, and a way in. A workflow run's own reason is generic, so the failed step and its
 * error (in words where the code is known) are shown, with a link to the run.
 */
function LastFailure(props: {
  readonly failure: NonNullable<AutomationDetail['stats']['lastFailure']>;
}): ReactNode {
  const w = useT().workflows;
  const f = props.failure;
  const step = f.failedStep;
  const why = step === null ? f.reason : failureWords(w, step.code, step.message);
  return (
    <>
      <DyNotice
        tone="red"
        className="mt-3"
        testId="last-failure"
        action={
          f.jobId !== null ? (
            <ThreadLink target={{ kind: 'job', id: f.jobId }} about="Son başarısız iş" />
          ) : f.workflowRunId !== null ? (
            <Link
              to={`/jobs/workflows/${encodeURIComponent(f.workflowRunId)}`}
              className="font-bold text-current"
              data-testid="last-failure-run"
            >
              {w.lastFailure.openRun}
            </Link>
          ) : undefined
        }
      >
        Son hata {agoText(f.at)}
        {step === null ? '' : w.lastFailure.step({ step: step.label ?? step.nodeId })}
        {why === null ? '' : `: ${why}`}
      </DyNotice>
      {/* p17-embeddings: "Benzer hata daha önce şöyle çözüldü" (nothing when nothing similar was solved). */}
      <SolvedBefore jobId={f.jobId} workflowRunId={f.workflowRunId} />
    </>
  );
}

function Overview(props: {
  readonly automation: AutomationDetail;
  readonly onChanged: () => void;
}): ReactNode {
  const fmt = useFormat();
  const a = props.automation;
  const s = a.stats;
  const cf = a.targetSpec.continueFrom;
  const rows: KeyValueRow[] = [
    { k: 'Durum', v: <AutomationPill state={a.state} /> },
    {
      k: 'Proje',
      v: (
        <Link to={`/projects/${encodeURIComponent(a.project)}`} className="text-dy-teal-ink">
          {a.project}
        </Link>
      ),
    },
    { k: 'Çalıştırır', v: runsText(a) },
    ...(a.target.kind === 'job'
      ? [
          {
            k: 'Onaylar',
            v: (
              <span data-testid="automation-approval">
                {a.target.approvalPolicy === null
                  ? '—'
                  : (APPROVAL_TR[a.target.approvalPolicy]?.label ?? a.target.approvalPolicy)}
              </span>
            ),
          },
          ...(a.target.sandboxProfile === null
            ? []
            : [
                { k: 'Kum havuzu', v: SANDBOX_TR[a.target.sandboxProfile]?.label ?? a.target.sandboxProfile },
              ]),
        ]
      : []),
    ...(a.targetSpec.files.length > 0 || cf !== null
      ? [
          {
            k: 'Girdiler',
            v: (
              <span data-testid="automation-inputs">
                {a.targetSpec.files.length > 0
                  ? a.targetSpec.files.map((f) => `${f.name} (${formatBytes(f.sizeBytes)})`).join(', ')
                  : 'Dosya yok'}
                {cf === null ? null : (
                  <>
                    {' · devam: '}
                    {cf.kind === 'job' ? (
                      <Link
                        to={`/jobs/${encodeURIComponent(cf.jobId)}`}
                        className="font-dy-mono text-dy-teal-ink"
                      >
                        {cf.jobId.slice(0, 8)}
                      </Link>
                    ) : cf.kind === 'last-run' ? (
                      'son başarılı çalıştırmasından'
                    ) : (
                      'onu başlatan çalıştırmadan'
                    )}
                  </>
                )}
              </span>
            ),
          },
        ]
      : []),
    { k: 'Sıradaki', v: whenText(a.nextRunAt, fmt) },
    {
      k: 'Son çalıştırma',
      v:
        a.lastRun === null ? (
          'Hiç'
        ) : (
          <span className="inline-flex items-center gap-2">
            <RunPill state={a.lastRun.state} /> {agoText(a.lastRun.at)}
          </span>
        ),
    },
    { k: 'Kimin adına', v: a.runAs, mono: true },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {a.waiting !== null ? (
        <div className="lg:col-span-2" data-testid="automation-waiting">
          <DyNotice
            tone="amber"
            action={
              <DyButtonLink
                to={`/approvals/${encodeURIComponent(a.waiting.approvalId)}`}
                variant="warn"
                icon="shield"
              >
                Şimdi karar ver
              </DyButtonLink>
            }
          >
            Bir çalıştırma {agoText(a.waiting.since)} onay bekliyor ({a.waiting.action})
            {a.waiting.cancelsAt === null
              ? ''
              : `; karar verilmezse ${whenText(a.waiting.cancelsAt, fmt)} iptal edilir`}
            .
          </DyNotice>
        </div>
      ) : null}
      <Panel title="Durum">
        <KeyValue rows={rows} />
        {a.target.kind === 'job' ? (
          <div className="mt-3">
            <UnattendedNote policy={a.target.approvalPolicy} timeoutMinutes={a.approvalTimeoutMinutes} />
          </div>
        ) : null}
        {a.state === 'failed' ? (
          <DyNotice tone="red" className="mt-3">
            Durduruldu: adına çalıştığı kişi artık bu işi başlatamıyor olabilir. Ayarlar’dan sürdürerek kendi
            adına çalıştır ya da sil.
          </DyNotice>
        ) : null}
      </Panel>
      <Panel title="Nasıl gitti" sub="Başarı oranı: son 20 biten çalıştırma">
        <div data-testid="automation-stats">
          <StatTiles label="Çalıştırma sayıları">
            <StatTile label="Başarı" value={percentText(a.successRate)} />
            <StatTile label="Biten" value={s.finished} />
            <StatTile label="Başarılı" value={s.succeeded} tone="green" />
            <StatTile label="Başarısız" value={s.failed} tone={s.failed > 0 ? 'red' : undefined} />
            <StatTile label="Atlanan" value={s.skipped} />
          </StatTiles>
        </div>
        {s.lastFailure !== null ? <LastFailure failure={s.lastFailure} /> : null}
      </Panel>
      {a.github !== null ? (
        <Panel title="GitHub teslimatları" className="lg:col-span-2">
          {a.github.receiving ? (
            <p className="m-0 text-[0.875rem] text-dy-muted">
              GitHub olayları <code className="font-dy-mono break-all">{a.github.hookUrl}</code> adresine
              gelir.
            </p>
          ) : (
            <DyNotice tone="amber">
              <span data-testid="github-not-receiving">
                Henüz hiçbir GitHub olayı gelemez: GitHub App’i bağla ve webhook’unu{' '}
                <Link to="/settings/integrations" className="font-bold text-current">
                  Ayarlar → Entegrasyonlar
                </Link>
                ’da kur.
              </span>
            </DyNotice>
          )}
        </Panel>
      ) : null}
      {a.group !== null && a.group.size > 1 ? (
        <div className="lg:col-span-2">
          <GroupPanel automation={a} onChanged={props.onChanged} />
        </div>
      ) : null}
      {a.webhook !== null ? <WebhookPanel automation={a} onChanged={props.onChanged} /> : null}
      {a.chainSource !== null || a.chainedBy.length > 0 ? (
        <Panel title="Zincirler" className="lg:col-span-2" flush>
          <Rows label="Zincirler" testId="automation-chains">
            {a.chainSource !== null ? (
              <Row
                lead={<DyIcon name="merge" className="size-[18px]" />}
                title={
                  <>
                    <ChainLink
                      id={a.chainSource.id}
                      name={a.chainSource.name}
                      project={a.chainSource.project}
                      own={a.project}
                    />{' '}
                    bitince başlar
                  </>
                }
              />
            ) : null}
            {a.chainedBy.map((c, i) => (
              <Row
                key={c.id ?? `hidden-${String(i)}`}
                lead={<DyIcon name="send" className="size-[18px]" />}
                title={
                  <>
                    Bu otomasyon {c.on.map((o) => OUTCOME_TR[o] ?? o).join(' ya da ')}{' '}
                    <ChainLink id={c.id} name={c.name} project={c.project} own={a.project} /> başlar
                  </>
                }
              />
            ))}
          </Rows>
        </Panel>
      ) : null}
    </div>
  );
}

function ChainLink(props: {
  readonly id: string | null;
  readonly name: string | null;
  readonly project: string | null;
  readonly own: string;
}): ReactNode {
  if (props.id === null || props.name === null)
    return <span className="text-dy-muted">başka bir projedeki bir otomasyon</span>;
  return (
    <>
      <Link to={`/automations/${encodeURIComponent(props.id)}`} className="text-dy-teal-ink">
        {props.name}
      </Link>
      {props.project !== null && props.project !== props.own ? (
        <span className="text-dy-muted"> (proje {props.project})</span>
      ) : null}
    </>
  );
}

const GRACE: readonly (readonly [string, string])[] = [
  ['24', 'Eski sır 24 saat daha çalışsın'],
  ['1', '1 saat çalışsın'],
  ['72', '3 gün çalışsın'],
  ['168', '7 gün çalışsın'],
  ['0', 'Eski sırrı hemen durdur (sızdı)'],
];

function WebhookPanel(props: {
  readonly automation: AutomationDetail;
  readonly onChanged: () => void;
}): ReactNode {
  const fmt = useFormat();
  const a = props.automation;
  const stepUp = useStepUp();
  const submit = useSubmit();
  const ending = useSubmit();
  const [secret, setSecret] = useState<WebhookSecret | null>(null);
  const [asking, setAsking] = useState(false);
  const [grace, setGrace] = useState('24');
  if (a.webhook === null) return null;
  const prev = a.webhook.previous;
  return (
    <Panel title="Webhook" className="lg:col-span-2" testId="automation-webhook">
      <KeyValue
        rows={[
          {
            k: 'URL',
            mono: true,
            v: (
              <code data-testid="webhook-url" className="break-all">
                {a.webhook.url}
              </code>
            ),
          },
          {
            k: 'Sır',
            v: (
              <>
                parmak izi <code className="font-dy-mono">{a.webhook.secretHint}</code>,{' '}
                {agoText(a.webhook.rotatedAt)} ayarlandı
              </>
            ),
          },
          ...(prev === null
            ? []
            : [
                {
                  k: 'Önceki sır',
                  v: (
                    <span data-testid="webhook-previous">
                      parmak izi <code className="font-dy-mono">{prev.secretHint}</code>{' '}
                      {whenText(prev.expiresAt, fmt)}’e kadar kabul ediliyor — çağıran sistemi o zamana kadar
                      güncelle.
                    </span>
                  ),
                },
              ]),
          {
            k: 'İzinli çağıranlar',
            v: a.webhook.allowIps === null ? 'Her adres' : a.webhook.allowIps.join(', '),
          },
        ]}
      />
      <div className="mt-3">
        {secret !== null ? <SecretPanel webhook={secret} /> : <CurlExample url={a.webhook.url} />}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <DyButton
          icon="key"
          onClick={() => {
            setAsking(true);
          }}
        >
          Sırrı değiştir
        </DyButton>
        {prev !== null ? (
          <DyConfirm
            label="Örtüşmeyi şimdi bitir"
            question="Eski sır hemen reddedilsin mi?"
            confirmLabel="Bitir"
            variant="warn"
            busy={ending.busy}
            testId="end-overlap"
            onConfirm={() => {
              void ending.run(async () => {
                await endWebhookOverlap(a.id);
                props.onChanged();
              });
            }}
          />
        ) : null}
      </div>
      <div className="mt-2">
        <DyApiError error={ending.error} retryLeft={ending.retryLeft} />
      </div>
      <DyDialog
        open={asking}
        onClose={() => {
          setAsking(false);
        }}
        size="sm"
        title="Webhook sırrı değişsin mi?"
        description="Yeni sırrı bir kez görürsün. Çağıran sistem güncellenene kadar eski sırla imzalanan çağrıların ne kadar çalışacağını seç."
        footer={
          <>
            <DyButton
              variant="ghost"
              onClick={() => {
                setAsking(false);
              }}
            >
              Vazgeç
            </DyButton>
            <DyButton
              variant="warn"
              busy={submit.busy}
              disabled={submit.blocked}
              onClick={() => {
                void submit.run(async () => {
                  try {
                    const out = await stepUp.run(
                      () => rotateWebhookSecret(a.id, Number(grace)),
                      'Webhook sırrını değiştirmek için güncel bir doğrulama kodu gir.',
                    );
                    setSecret(out.webhook);
                    setAsking(false);
                    props.onChanged();
                  } catch (err) {
                    if (!(err instanceof StepUpCancelledError)) throw err;
                  }
                });
              }}
            >
              Değiştir
            </DyButton>
          </>
        }
      >
        <DyChoice label="Şimdiki sır" value={grace} options={GRACE} onChange={setGrace} />
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </DyDialog>
    </Panel>
  );
}

function Runs(props: { readonly automation: AutomationDetail }): ReactNode {
  const fmt = useFormat();
  const a = props.automation;
  const [open, setOpen] = useState<string | null>(null);
  const list = useCursorList<AutomationRun>({
    key: a.id,
    label: 'Çalıştırma sayfaları',
    prefix: 'runs',
    fetchPage: (cursor, limit) => listAutomationRunsPage(a.id, { cursor, limit }),
  });
  const runs = list.loaded && list.error === null ? list.items : null;
  return (
    <Panel title="Çalıştırmalar" flush>
      <div className="px-4">
        <ErrorLine error={list.error} what="Çalıştırmalar" />
      </div>
      {runs === null && list.error === null ? <SkeletonRows label="Çalıştırmalar yükleniyor" /> : null}
      {runs !== null && runs.length === 0 ? (
        <EmptyLine>
          Henüz çalıştırma yok. Tetik çalışınca ya da “Şimdi çalıştır” deyince burada görünür.
        </EmptyLine>
      ) : null}
      {runs !== null && runs.length > 0 ? (
        <Rows label="Çalıştırmalar" testId="automation-runs">
          {runs.map((r) => (
            <Row
              key={r.id}
              testId="run-row"
              tone={RUN_TR[r.state].tone === 'neutral' ? undefined : RUN_TR[r.state].tone}
              lead={<DyIcon name={RUN_TR[r.state].icon} className="size-[18px]" />}
              title={
                <button
                  type="button"
                  className="dy-press cursor-pointer rounded text-left font-medium text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                  onClick={() => {
                    setOpen(r.id);
                  }}
                >
                  {whenText(r.startedAt ?? r.createdAt, fmt)}
                </button>
              }
              meta={
                <>
                  <span>{TRIGGER_TR[r.triggerKind] ?? r.triggerKind}</span>
                  {eventLineTr(r) === (TRIGGER_TR[r.triggerKind] ?? r.triggerKind) ? null : (
                    <span className="[overflow-wrap:anywhere]">{eventLineTr(r)}</span>
                  )}
                  {r.sourceTrust === 'untrusted' ? (
                    <Pill tone="amber" icon="shield">
                      Güvenilmeyen kaynak
                    </Pill>
                  ) : null}
                  {r.reason === null ? null : <span>{r.reason}</span>}
                </>
              }
              trail={
                <span className="flex flex-wrap items-center gap-2 sm:justify-end">
                  {r.waitingApproval !== null ? (
                    <WaitingPill waiting={r.waitingApproval} />
                  ) : (
                    <RunPill state={r.state} />
                  )}
                  <span className="font-dy-mono text-[0.8125rem] text-dy-muted tabular-nums">
                    {durationTr(r)}
                  </span>
                  <RunTarget run={r} />
                </span>
              }
            />
          ))}
        </Rows>
      ) : null}
      {runs !== null ? <DyPager {...list.pagination} /> : null}
      <RunDialog
        automationId={a.id}
        runId={open}
        onClose={() => {
          setOpen(null);
        }}
      />
    </Panel>
  );
}

function RunTarget(props: { readonly run: AutomationRun }): ReactNode {
  const r = props.run;
  const cls =
    'dy-press inline-flex min-h-8 items-center gap-1 rounded-lg px-2 font-dy-mono text-[0.8125rem] text-dy-teal-ink no-underline';
  if (r.jobId !== null)
    return <ThreadLink target={{ kind: 'job', id: r.jobId }} about={`İş ${r.jobId.slice(0, 8)}`} />;
  if (r.reusedJobId !== null)
    return (
      <Link
        to={`/jobs/${encodeURIComponent(r.reusedJobId)}`}
        className={cls}
        data-testid="run-reused-job"
        title="Atlandı: bu özdeş iş başarılı olmuştu"
      >
        özdeş {r.reusedJobId.slice(0, 8)}
      </Link>
    );
  if (r.workflowRunId !== null)
    return (
      <Link to={`/jobs/workflows/${encodeURIComponent(r.workflowRunId)}`} className={cls}>
        akış {r.workflowRunId.slice(0, 8)}
      </Link>
    );
  return null;
}

function RunDialog(props: {
  readonly automationId: string;
  readonly runId: string | null;
  readonly onClose: () => void;
}): ReactNode {
  const wf = useT().workflows;
  const [run, setRun] = useState<AutomationRunDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    setRun(null);
    setError(null);
    if (props.runId === null) return;
    getAutomationRun(props.automationId, props.runId).then(setRun, (err: unknown) => {
      setError(toApiError(err));
    });
  }, [props.automationId, props.runId]);
  return (
    <DyDialog open={props.runId !== null} onClose={props.onClose} title="Çalıştırma" size="lg">
      <ErrorLine error={error} what="Çalıştırma" />
      {run === null && error === null ? <SkeletonRows label="Çalıştırma yükleniyor" rows={2} /> : null}
      {run !== null ? (
        <div className="grid gap-3" data-testid="run-detail">
          <KeyValue
            rows={[
              {
                k: 'Sonuç',
                v:
                  run.waitingApproval !== null ? (
                    <WaitingPill waiting={run.waitingApproval} />
                  ) : (
                    <RunPill state={run.state} />
                  ),
              },
              ...(run.failedStep !== null
                ? [
                    {
                      k: 'Başarısız adım',
                      v: (
                        <span data-testid="run-failed-step">
                          {run.failedStep.label ?? run.failedStep.nodeId}
                          {(() => {
                            const why = failureWords(wf, run.failedStep.code, run.failedStep.message);
                            return why === null ? '' : `: ${why}`;
                          })()}
                        </span>
                      ),
                    },
                  ]
                : run.reason === null
                  ? []
                  : [{ k: 'Neden', v: run.reason }]),
              ...(run.workflowRunId === null
                ? []
                : [
                    {
                      k: 'Akış',
                      v: (
                        <Link
                          to={`/jobs/workflows/${encodeURIComponent(run.workflowRunId)}`}
                          className="font-bold text-current"
                          data-testid="run-open-workflow"
                        >
                          {wf.lastFailure.openRun}
                        </Link>
                      ),
                    },
                  ]),
              ...(run.reusedJobId === null
                ? []
                : [
                    {
                      k: 'Özdeş sonuç',
                      v: (
                        <Link
                          to={`/jobs/${encodeURIComponent(run.reusedJobId)}`}
                          className="text-dy-teal-ink"
                        >
                          İşi aç {run.reusedJobId.slice(0, 8)}
                        </Link>
                      ),
                    },
                  ]),
              { k: 'Tetik', v: eventLineTr(run) },
              {
                k: 'Kaynak',
                v: run.sourceTrust === 'untrusted' ? 'Güvenilmeyen (yalnızca konteyner)' : 'Güvenilen',
              },
              ...(run.checkoutRef === null ? [] : [{ k: 'Checkout', v: run.checkoutRef, mono: true }]),
              ...(run.checkoutPullRequest === null
                ? []
                : [
                    {
                      k: 'Checkout',
                      v: `pull request #${String(run.checkoutPullRequest.number)} @ ${run.checkoutPullRequest.headSha.slice(0, 12)} (güvenilmeyen kod: yalnızca konteyner, sır yok, asla push edilmez)`,
                    },
                  ]),
              ...(run.payloadDigest === null ? [] : [{ k: 'Gövde özeti', v: run.payloadDigest, mono: true }]),
            ]}
          />
          {run.eventData !== null ? (
            <>
              <p className="m-0 text-[0.8125rem] text-dy-muted">
                Ajanın aldığı olay verisi — güvenilmeyen veri, asla talimat değil.
              </p>
              <pre
                aria-label="Olay verisi"
                data-testid="json-block"
                className="m-0 max-h-80 overflow-auto rounded-[10px] bg-dy-sunk p-3 font-dy-mono text-[0.78125rem] break-words whitespace-pre-wrap"
              >
                {JSON.stringify(run.eventData, null, 2)}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </DyDialog>
  );
}

function TriggerTab(props: { readonly automation: AutomationDetail }): ReactNode {
  const fmt = useFormat();
  const tz = useT().workflowQuality.schedule;
  const a = props.automation;
  const t = a.trigger;
  const rows: KeyValueRow[] = [
    { k: 'Tür', v: TRIGGER_TR[t.kind] ?? t.kind },
    // p16-workflow-quality: the schedule in words with its zone ("her saat başı · Europe/Istanbul").
    { k: 'Özet', v: scheduleSummary(a, tz) },
  ];
  if (t.kind === 'cron') rows.push({ k: tz.expression, v: t.cron, mono: true });
  if (t.kind === 'cron' || t.kind === 'at') rows.push({ k: tz.zone, v: a.timeZone, mono: true });
  if (t.kind === 'at') rows.push({ k: 'Zaman', v: whenText(t.at, fmt) });
  if (t.kind === 'github') {
    rows.push({ k: 'Depo', v: t.repository, mono: true });
    rows.push({ k: 'Olay', v: [t.event, ...(t.additionalEvents ?? [])].join(', ') });
    if (t.actions !== undefined) rows.push({ k: 'Eylemler', v: t.actions.join(', ') });
    if (t.branches !== undefined) rows.push({ k: 'Dallar', v: t.branches.join(', ') });
    if (t.labels !== undefined) rows.push({ k: 'Etiketler', v: t.labels.join(', ') });
    if (t.command !== undefined) rows.push({ k: 'Komut', v: t.command, mono: true });
    rows.push({
      k: 'Dışarıdakiler',
      v:
        t.allowUntrusted === true
          ? 'Fork’lar ve dışarıdakiler için de çalışır (güvenilmeyen, yalnızca konteyner)'
          : 'Yok sayılır (fork’lar ve depo dışındaki kişiler)',
    });
    rows.push({ k: 'Checkout', v: t.checkout === 'event' ? 'Olayın dalı' : 'Taban dalı' });
  }
  if (t.kind === 'chain')
    rows.push({
      k: 'Sonra',
      v: `${a.chainSource?.name ?? t.automationId} ${t.on.map((o) => OUTCOME_TR[o] ?? o).join(' ya da ')}`,
    });
  if (t.kind === 'webhook' && a.webhook !== null) rows.push({ k: 'URL', v: a.webhook.url, mono: true });
  return (
    <Panel
      title="Ne başlatır"
      aside={
        a.state === 'deleted' ? undefined : (
          <DyButtonLink to={`/automations/${encodeURIComponent(a.id)}/edit`} icon="pen">
            Tetiği değiştir
          </DyButtonLink>
        )
      }
    >
      <div data-testid="trigger-summary">
        <KeyValue rows={rows} />
      </div>
    </Panel>
  );
}

function SettingsTab(props: {
  readonly automation: AutomationDetail;
  readonly onChanged: () => void;
}): ReactNode {
  const a = props.automation;
  const navigate = useNavigate();
  const stepUp = useStepUp();
  const submit = useSubmit();
  const act = (fn: () => Promise<unknown>): void => {
    void submit
      .run(async () => {
        try {
          await fn();
        } catch (err) {
          if (!(err instanceof StepUpCancelledError)) throw err;
        }
      })
      .then((ok) => {
        if (ok) props.onChanged();
      });
  };
  return (
    <div className="grid gap-4">
      <Panel
        title="Kurallar"
        aside={
          a.state === 'deleted' ? undefined : (
            <DyButtonLink to={`/automations/${encodeURIComponent(a.id)}/edit`} icon="pen">
              Değiştir
            </DyButtonLink>
          )
        }
      >
        <div data-testid="automation-policies">
          <KeyValue
            rows={[
              { k: 'Örtüşen çalıştırmalar', v: CONCURRENCY_TR[a.concurrency] ?? a.concurrency },
              { k: 'Kaçırılan zamanlar', v: CATCH_UP_TR[a.catchUp] ?? a.catchUp },
              { k: 'Hız sınırı', v: `Saatte en çok ${String(a.maxRunsPerHour)} çalıştırma` },
              {
                k: 'Hata olunca',
                v: a.notifyOnFailure ? 'Projenin operatörlerine bildir' : 'Bildirim yok',
              },
              { k: 'Onay zaman aşımı', v: timeoutTr(a.approvalTimeoutMinutes) },
              ...(a.target.kind === 'job'
                ? [
                    {
                      k: 'Özdeş sonuçlar',
                      v:
                        a.reuseWithinHours === null
                          ? 'Her zaman çalıştır'
                          : `Özdeş bir iş ${String(a.reuseWithinHours)} saat içinde başarılıysa atla`,
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </Panel>
      <Panel title="Aç ya da kapat" sub="Silmek çalıştırma geçmişini korur; çalışan işler etkilenmez.">
        <div className="flex flex-wrap gap-2">
          {a.state === 'active' ? (
            <DyButton
              icon="pause"
              busy={submit.busy}
              onClick={() => {
                act(() => pauseAutomation(a.id));
              }}
            >
              Duraklat
            </DyButton>
          ) : null}
          {a.state === 'paused' || a.state === 'failed' ? (
            <DyButton
              icon="retry"
              busy={submit.busy}
              onClick={() => {
                act(() =>
                  stepUp.run(
                    () => resumeAutomation(a.id),
                    'Dışarıdan başlayan bir otomasyonu sürdürmek için güncel bir doğrulama kodu gir.',
                  ),
                );
              }}
            >
              Sürdür
            </DyButton>
          ) : null}
          {a.state !== 'deleted' && a.workflowBinding === null ? (
            <DyConfirm
              label="Sil"
              icon="trash"
              question={`${a.name} silinsin mi?`}
              confirmLabel="Otomasyonu sil"
              testId="delete-automation"
              busy={submit.busy}
              onConfirm={() => {
                void submit
                  .run(async () => {
                    await deleteAutomation(a.id);
                  })
                  .then((ok) => {
                    if (ok) void navigate('/automations');
                  });
              }}
            />
          ) : null}
        </div>
        <div className="mt-3">
          <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
        </div>
      </Panel>
    </div>
  );
}
