import { type ReactNode, type SyntheticEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { projectHref } from '../../../lib/reasons';
import {
  type Automation,
  type AutomationDetail,
  type AutomationGroupApplied,
  type AutomationGroupCreated,
  type AutomationInput,
  applyAutomationGroup,
  type ChainOutcome,
  createAutomation,
  createAutomationGroup,
  DEFAULT_ACTIONS,
  getAutomation,
  GITHUB_EVENTS,
  type GitHubEvent,
  listAutomations,
  updateAutomation,
  type WebhookSecret,
} from '../../../api/automations';
import type { ApiError } from '../../../api/client';
import {
  getProjectGit,
  listWorkflowDefinitions,
  type ProjectGit,
  type WorkflowDefinitionSummary,
} from '../../../api/composer';
import { listProjects, type Project } from '../../../api/directory';
import { toApiError } from '../../../components/ui';
import {
  actionChoices,
  allowIpList,
  approvalTimeout,
  buildTarget,
  buildTrigger,
  EMPTY,
  type FormState,
  formPreviewDraft,
  fromDetail,
  KINDS,
  placementProblem,
  repoFromUrl,
  reusePolicy,
  selectedEvents,
  validate,
} from '../../../screens/automations/form';
import {
  APPROVAL_POLICIES,
  bestHostProfile,
  RUNTIMES,
  SANDBOX_PROFILES,
} from '../../../screens/composer/draft';
import { usePlacementPreview } from '../../../screens/composer/placement';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { APPROVAL_TR, SANDBOX_TR } from '../../compose/labels';
import { DyApiError, DyCheck, DyChoice, DyInput, DyNotice, DyTextarea } from '../kit';
import { ScreenFrame } from '../ScreenFrame';
import { DyButton, DyButtonLink, ErrorLine, Panel, SkeletonRows } from '../parts';
import {
  CheckGroup,
  ChoiceCards,
  ClassPicker,
  CronBuilder,
  DeployField,
  FilesFields,
  VerifyField,
} from './FormParts';
import { CATCH_UP_TR, CONCURRENCY_TR, errTr, OUTCOME_TR, TRIGGER_HINT_TR, TRIGGER_TR } from './labels';
import { SecretPanel, UnattendedNote } from './shared';
import { SimilarRecordNotice } from '../../related/RelatedWork';
import { useT } from '../../../i18n/I18nProvider';
import { GroupAppliedResult, GroupApplyToggle, GroupCreatedResult, GroupExtras } from './GroupParts';

/**
 * p12-diyalog-w2: the automation form (/automations/new, /automations/:id/edit) in the Diyalog language. State,
 * validation, the trigger and target builders, the project defaults (best host profile, run-limit cap) and the
 * placement check are the classic form's exported helpers; creating and changing go through the classic calls with
 * step-up. A webhook secret is shown once, right after it is created.
 */
export function AutomationFormScreen(props: { readonly id?: string | undefined }): ReactNode {
  const { id } = props;
  const editing = id !== undefined;
  const navigate = useNavigate();
  const stepUp = useStepUp();
  const submit = useSubmit();
  const [f, setF] = useState<FormState>(EMPTY);
  const [existing, setExisting] = useState<AutomationDetail | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [git, setGit] = useState<ProjectGit | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowDefinitionSummary[]>([]);
  const [others, setOthers] = useState<Automation[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [created, setCreated] = useState<{ id: string; webhook: WebhookSecret } | null>(null);
  // p18-multi-project W4: "Başka projelerde de oluştur" (create) and "Tümüne uygula" (edit a grouped automation).
  const groupWords = useT().multiProject.groups;
  const deliveryWords = useT().outputDelivery.choice;
  const [extras, setExtras] = useState<string[]>([]);
  const [applyAll, setApplyAll] = useState(false);
  const [groupCreated, setGroupCreated] = useState<AutomationGroupCreated | null>(null);
  const [groupApplied, setGroupApplied] = useState<AutomationGroupApplied | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]): void => {
    setF((prev) => ({ ...prev, [k]: v }));
  };
  const touched = useRef<{ project: string; sandbox: boolean; duration: boolean }>({
    project: '',
    sandbox: false,
    duration: false,
  });
  const pDraft = useMemo(() => formPreviewDraft(f), [f]);
  const { preview } = usePlacementPreview(pDraft);
  useEffect(() => {
    if (editing || preview === null || preview.project !== f.project) return;
    if (touched.current.project !== f.project) {
      touched.current = { project: f.project, sandbox: false, duration: false };
    }
    const t = touched.current;
    setF((prev) => {
      const sandboxProfile = t.sandbox ? prev.sandboxProfile : bestHostProfile(preview);
      const cap = preview.limits.maxWallTimeSec;
      const maxDurationMin =
        t.duration || cap === undefined || Number(prev.maxDurationMin) * 60 <= cap
          ? prev.maxDurationMin
          : String(Math.max(1, Math.floor(cap / 60)));
      return sandboxProfile === prev.sandboxProfile && maxDurationMin === prev.maxDurationMin
        ? prev
        : { ...prev, sandboxProfile, maxDurationMin };
    });
  }, [preview, editing, f.project]);
  const problem = placementProblem(preview, f);
  const autoApprove = preview?.project === f.project && preview.autoApproveExecution;

  useEffect(() => {
    listProjects().then(setProjects, () => {
      setProjects([]);
    });
    listWorkflowDefinitions().then(setWorkflows, () => undefined);
    listAutomations().then(setOthers, () => undefined);
  }, []);
  useEffect(() => {
    if (id === undefined) return;
    getAutomation(id).then(
      (a) => {
        setExisting(a);
        setF(fromDetail(a));
      },
      (err: unknown) => {
        setLoadError(toApiError(err));
      },
    );
  }, [id]);
  useEffect(() => {
    if (f.project === '') {
      setGit(null);
      return;
    }
    let live = true;
    getProjectGit(f.project).then(
      (g) => {
        if (!live) return;
        setGit(g);
        if (g !== null)
          setF((prev) =>
            prev.repository === '' ? { ...prev, repository: repoFromUrl(g.repositoryUrl) } : prev,
          );
      },
      () => {
        if (live) setGit(null);
      },
    );
    return () => {
      live = false;
    };
  }, [f.project]);

  const workspace = (projects ?? []).find((p) => p.id === f.project)?.kind === 'workspace';
  const errors = useMemo(() => validate(f, editing, workspace), [f, editing, workspace]);
  const shown: Readonly<Record<string, string>> = showErrors ? errors : {};
  const e = (k: string): string | null => errTr(shown[k]);
  const chainChoices = others
    .filter((o) => o.id !== id && o.state !== 'deleted')
    .sort((x, y) => Number(x.project !== f.project) - Number(y.project !== f.project));
  const projectWorkflows = workflows.filter((w) => w.project === f.project);

  async function onSubmit(ev: SyntheticEvent): Promise<void> {
    ev.preventDefault();
    setShowErrors(true);
    if (Object.keys(errors).length > 0) return;
    const trigger = buildTrigger(f);
    const target = buildTarget(f, git, existing?.targetSpec.spec ?? null, workspace);
    const policies = {
      concurrency: f.concurrency,
      catchUp: f.catchUp,
      maxRunsPerHour: Number(f.maxRunsPerHour),
      notifyOnFailure: f.notifyOnFailure,
      approvalTimeoutMinutes: approvalTimeout(f),
      reuseWithinHours: reusePolicy(f),
      ...(f.kind === 'webhook' ? { webhookAllowIps: allowIpList(f) } : {}),
    };
    await submit.run(async () => {
      try {
        if (existing !== null && applyAll && existing.group !== null) {
          const group = existing.group;
          const applied = await stepUp.run(
            () =>
              applyAutomationGroup(group.id, {
                name: f.name.trim(),
                description: f.description.trim() === '' ? null : f.description.trim(),
                trigger,
                target,
                ...policies,
              }),
            groupWords.stepUpApply,
          );
          setGroupApplied(applied);
          return;
        }
        if (existing !== null) {
          const out = await stepUp.run(
            () =>
              updateAutomation(existing.id, {
                name: f.name.trim(),
                description: f.description.trim() === '' ? null : f.description.trim(),
                trigger,
                target,
                ...policies,
              }),
            'Bir otomasyonu değiştirmek için güncel bir doğrulama kodu gir.',
          );
          if (out.webhook !== null) {
            setCreated({ id: existing.id, webhook: out.webhook });
            return;
          }
          void navigate(`/automations/${existing.id}`);
          return;
        }
        const input: AutomationInput = {
          project: f.project,
          name: f.name.trim(),
          ...(f.description.trim() === '' ? {} : { description: f.description.trim() }),
          trigger,
          target,
          enabled: f.enabled,
          ...policies,
        };
        const others = extras.filter((p) => p !== f.project);
        if (others.length > 0) {
          const { project: primary, ...rest } = input;
          const group = await stepUp.run(
            () => createAutomationGroup({ ...rest, projects: [primary, ...others] }),
            groupWords.stepUpCreate,
          );
          setGroupCreated(group);
          return;
        }
        const out = await stepUp.run(
          () => createAutomation(input),
          'Otomasyon ileride işleri senin adına başlatır — güncel bir doğrulama kodu gir.',
        );
        if (out.webhook !== null) {
          setCreated({ id: out.automation.id, webhook: out.webhook });
          return;
        }
        void navigate(`/automations/${out.automation.id}`, { state: { created: 'automation' } });
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  }

  const back = id === undefined ? '/automations' : `/automations/${encodeURIComponent(id)}`;
  const frame = (children: ReactNode): ReactNode => (
    <ScreenFrame
      title={editing ? `${existing?.name ?? 'Otomasyon'} düzenle` : 'Yeni otomasyon'}
      back={{ to: back, label: editing ? 'Otomasyon' : 'Otomasyonlar' }}
      purpose="Ne başlatır, ne çalıştırır, ne sıklıkla çalışabilir. Ajan tetikleyen olayı veri olarak alır, asla talimat olarak değil."
      width="narrow"
      testId="dy-automation-form"
    >
      {children}
    </ScreenFrame>
  );

  if (groupCreated !== null) return frame(<GroupCreatedResult out={groupCreated} />);
  if (groupApplied !== null && existing !== null)
    return frame(
      <GroupAppliedResult out={groupApplied} back={`/automations/${encodeURIComponent(existing.id)}`} />,
    );

  if (created !== null)
    return frame(
      <div className="grid gap-4">
        <DyNotice tone="green" live>
          {editing ? 'Otomasyon kaydedildi.' : 'Otomasyon oluşturuldu.'} Webhook’u hazır.
        </DyNotice>
        <SecretPanel webhook={created.webhook} />
        <div>
          <DyButtonLink to={`/automations/${encodeURIComponent(created.id)}`} variant="primary">
            Otomasyonu aç
          </DyButtonLink>
        </div>
      </div>,
    );

  if (editing && existing === null)
    return frame(
      <>
        <ErrorLine error={loadError} what="Otomasyon" />
        {loadError === null ? <SkeletonRows label="Otomasyon yükleniyor" rows={4} /> : null}
      </>,
    );

  return frame(
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(ev) => {
        void onSubmit(ev);
      }}
    >
      <Panel title="Ad ve proje">
        <div className="grid gap-3">
          {editing ? (
            <p className="m-0 text-[0.875rem] text-dy-muted">Proje: {f.project}</p>
          ) : (
            <DyChoice
              label="Proje"
              value={f.project}
              error={e('project')}
              options={[
                ['', projects === null ? 'Yükleniyor…' : 'Bir proje seç'],
                ...(projects ?? []).map((p) => [p.id, p.name] as const),
              ]}
              onChange={(v) => {
                setF((prev) => ({ ...prev, project: v, repository: '', chainSource: '', workflowId: '' }));
                setExtras((prev) => prev.filter((x) => x !== v));
              }}
            />
          )}
          {!editing && f.project !== '' ? (
            <GroupExtras projects={projects} primary={f.project} chosen={extras} onChange={setExtras} />
          ) : null}
          {existing === null ? null : (
            <GroupApplyToggle automation={existing} checked={applyAll} onChange={setApplyAll} />
          )}
          <DyInput
            label="Ad"
            value={f.name}
            error={e('name')}
            onChange={(ev) => {
              set('name', ev.target.value);
            }}
          />
          <DyInput
            label="Açıklama (isteğe bağlı)"
            value={f.description}
            onChange={(ev) => {
              set('description', ev.target.value);
            }}
          />
          {/* p17-embeddings: "Benzer bir kayıt var" — a live automation of the project that looks the same. */}
          <SimilarRecordNotice
            kind="automation"
            project={f.project}
            text={[f.name, f.description, f.target === 'job' ? f.prompt : '']
              .filter((x) => x.trim() !== '')
              .join('\n')}
            excludeId={existing?.id ?? null}
          />
        </div>
      </Panel>

      <Panel title="Ne zaman çalışır">
        <div className="grid gap-4">
          <ChoiceCards
            legend="Tetik"
            name="trigger-kind"
            value={f.kind}
            testId="trigger-kinds"
            options={KINDS.map((k) => ({
              value: k,
              label: TRIGGER_TR[k] ?? k,
              description: TRIGGER_HINT_TR[k],
            }))}
            onChange={(v) => {
              const k = KINDS.find((x) => x === v);
              if (k !== undefined) set('kind', k);
            }}
          />
          {f.kind === 'cron' ? (
            <CronBuilder
              value={f.cron}
              error={e('cron')}
              onChange={(v) => {
                set('cron', v);
              }}
              timeZone={f.timeZone}
              onTimeZone={(v) => {
                set('timeZone', v);
              }}
            />
          ) : null}
          {f.kind === 'at' ? (
            <DyInput
              label="Tarih ve saat"
              type="datetime-local"
              value={f.at}
              error={e('at')}
              hint="Kendi saatinle."
              onChange={(ev) => {
                set('at', ev.target.value);
              }}
            />
          ) : null}
          {f.kind === 'github' ? (
            <div className="grid gap-3" data-testid="github-trigger">
              <DyInput
                label="Depo"
                className="font-dy-mono"
                value={f.repository}
                error={e('repository')}
                placeholder="sahip/ad"
                hint={git === null ? 'sahip/ad' : 'Projenin deposu.'}
                onChange={(ev) => {
                  set('repository', ev.target.value);
                }}
              />
              <DyChoice
                label="Olay"
                value={f.event}
                options={GITHUB_EVENTS.map((ev) => [ev, ev.replace(/_/g, ' ')] as const)}
                onChange={(v) => {
                  const ev = v as GitHubEvent;
                  setF((prev) => ({
                    ...prev,
                    event: ev,
                    additionalEvents: prev.additionalEvents.filter((x) => x !== ev),
                    actions: ev === 'push' ? [] : [...DEFAULT_ACTIONS[ev]],
                  }));
                }}
              />
              <CheckGroup
                legend="Ayrıca şu olaylarda (isteğe bağlı)"
                options={GITHUB_EVENTS.filter((ev) => ev !== f.event)}
                value={f.additionalEvents}
                onChange={(more) => {
                  setF((prev) => {
                    const next = { ...prev, additionalEvents: more };
                    const choices = actionChoices(next);
                    const added = more
                      .filter((x) => !prev.additionalEvents.includes(x))
                      .filter((x): x is Exclude<GitHubEvent, 'push'> => x !== 'push')
                      .flatMap((x) => DEFAULT_ACTIONS[x]);
                    return {
                      ...next,
                      actions: [...new Set([...prev.actions, ...added])].filter((a) => choices.includes(a)),
                    };
                  });
                }}
              />
              {actionChoices(f).length > 0 ? (
                <CheckGroup
                  legend="Eylemler"
                  options={actionChoices(f)}
                  value={f.actions}
                  error={e('actions')}
                  onChange={(v) => {
                    set('actions', v);
                  }}
                />
              ) : null}
              {f.event === 'pull_request' || f.event === 'push' ? (
                <DyInput
                  label={f.event === 'push' ? 'Dallar (isteğe bağlı)' : 'Taban dallar (isteğe bağlı)'}
                  value={f.branches}
                  hint="Virgülle ayır; * ve ** çalışır, örneğin main, release/*"
                  onChange={(ev) => {
                    set('branches', ev.target.value);
                  }}
                />
              ) : null}
              {f.event === 'pull_request' || f.event === 'issues' ? (
                <DyInput
                  label="Etiketler (isteğe bağlı)"
                  value={f.labels}
                  hint="Virgülle ayır; yalnızca biri takılıyken (ya da yeni eklenince) çalışır."
                  onChange={(ev) => {
                    set('labels', ev.target.value);
                  }}
                />
              ) : null}
              {selectedEvents(f).includes('issue_comment') ? (
                <DyInput
                  label="Komut"
                  className="font-dy-mono"
                  value={f.command}
                  hint="Yalnızca bununla başlayan yorumlarda çalışır, örneğin /remyral bunu düzelt"
                  onChange={(ev) => {
                    set('command', ev.target.value);
                  }}
                />
              ) : null}
              <DyCheck
                label="Fork’lar ve depo dışındaki kişiler için de çalıştır"
                checked={f.allowUntrusted}
                onChange={(v) => {
                  set('allowUntrusted', v);
                }}
              />
              {f.allowUntrusted ? (
                <DyNotice tone="amber">
                  Bu çalıştırmalar güvenilmeyen kaynaklıdır: her zaman konteynerde, onaysız değil ve sırsız
                  çalışır. Pull request ya da issue açabilen herkes bir çalıştırma başlatabilir (saatlik
                  sınıra kadar).
                  {f.checkout === 'event'
                    ? ' “Checkout” olaya ayarlıyken fork’un pull request kodu olayın tam commit’inde checkout edilir — ajan bu kodu konteynerin içinde okuyabilir ve çalıştırabilir; asla push edilmez.'
                    : ' Fork’un kodu checkout edilmez.'}
                </DyNotice>
              ) : null}
              {f.event === 'pull_request' || f.event === 'push' ? (
                <DyChoice
                  label="Checkout"
                  value={f.checkout}
                  options={[
                    ['base', 'Taban dalı'],
                    [
                      'event',
                      f.allowUntrusted
                        ? 'Olayın gösterdiği (fork’larda pull request commit’i, güvenilmeyen)'
                        : 'Olayın gösterdiği (pull request / push edilen dal, etiket, commit)',
                    ],
                  ]}
                  onChange={(v) => {
                    set('checkout', v === 'event' ? 'event' : 'base');
                  }}
                />
              ) : null}
            </div>
          ) : null}
          {f.kind === 'webhook' ? (
            <div className="grid gap-3">
              <DyNotice tone="teal">
                Kaydedince URL’yi ve bir kez gösterilen sırrı curl örneğiyle alırsın. Çağrılar imzalı olmalı;
                her nonce bir kez geçer.
              </DyNotice>
              <DyInput
                label="İzinli çağıranlar (isteğe bağlı)"
                className="font-dy-mono"
                value={f.allowIps}
                error={e('allowIps')}
                placeholder="203.0.113.7, 198.51.100.0/24"
                hint="Virgülle ayrılmış adresler ya da CIDR’lar; başka yerden gelen çağrılar reddedilir. Boş: her adres."
                onChange={(ev) => {
                  set('allowIps', ev.target.value);
                }}
              />
            </div>
          ) : null}
          {f.kind === 'chain' ? (
            <div className="grid gap-3">
              <DyChoice
                label="Hangi otomasyondan sonra"
                value={f.chainSource}
                error={e('chainSource')}
                options={[
                  ['', chainChoices.length === 0 ? 'Başka otomasyon yok' : 'Seç'],
                  ...chainChoices.map(
                    (o) =>
                      [o.id, o.project === f.project ? o.name : `${o.name} (proje ${o.project})`] as const,
                  ),
                ]}
                onChange={(v) => {
                  set('chainSource', v);
                }}
              />
              <CheckGroup<ChainOutcome>
                legend="Onun çalıştırması"
                options={['succeeded', 'failed', 'cancelled']}
                label={(o) => OUTCOME_TR[o] ?? o}
                value={f.chainOn}
                error={e('chainOn')}
                onChange={(v) => {
                  set('chainOn', v);
                }}
              />
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title="Ne çalıştırır">
        <div className="grid gap-4">
          <ChoiceCards
            legend="Çalıştırır"
            name="target-kind"
            columns={3}
            value={f.target}
            options={[
              { value: 'job', label: 'Bir iş', description: 'Bir ajan görevi.' },
              { value: 'workflow', label: 'Bir iş akışı', description: 'Projenin bir akış tanımı.' },
              { value: 'deploy', label: 'Bir deploy', description: 'Coolify uygulaması.' },
            ]}
            onChange={(v) => {
              set('target', v === 'workflow' ? 'workflow' : v === 'deploy' ? 'deploy' : 'job');
            }}
          />
          {f.target === 'deploy' ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <DyChoice
                  label="Eylem"
                  value={f.deployAction}
                  error={e('deployAction')}
                  options={[
                    ['coolify.deploy', 'Coolify uygulamasını deploy et'],
                    ['coolify.restart', 'Coolify uygulamasını yeniden başlat'],
                  ]}
                  onChange={(v) => {
                    set('deployAction', v === 'coolify.restart' ? 'coolify.restart' : 'coolify.deploy');
                  }}
                />
                <DyChoice
                  label="Ortam"
                  value={f.deployEnv}
                  options={[
                    ['preview', 'Önizleme'],
                    ['production', 'Production'],
                  ]}
                  onChange={(v) => {
                    set('deployEnv', v === 'production' ? 'production' : 'preview');
                  }}
                />
              </div>
              {f.deployAction === 'coolify.deploy' ? (
                <DyCheck
                  label="Önbelleksiz yeniden derle"
                  checked={f.deployForce}
                  onChange={(v) => {
                    set('deployForce', v);
                  }}
                />
              ) : null}
              <DyNotice tone={f.deployEnv === 'production' ? 'amber' : 'teal'}>
                {f.deployEnv === 'production'
                  ? 'Production deploy’ları asla gözetimsiz çalışmaz: her çalıştırma Deploy’lar sayfasında bir proje yöneticisi doğrulama koduyla onaylayana kadar bekler. '
                  : 'Önizleme deploy’ları projenin deploy kuralına uyar (varsayılan: hemen çalışır). '}
                Hedefler Projeler › Deploy’dan gelir. Olay içeriği neyin yayınlandığını asla değiştirmez;
                fork’lardan ya da depo dışından gelen çalıştırmalar asla deploy etmez.
              </DyNotice>
            </>
          ) : f.target === 'job' ? (
            <>
              <DyTextarea
                label="Görev"
                rows={5}
                value={f.prompt}
                error={e('prompt')}
                hint="Ajanın talimatı. Olay ayrıntıları (pull request, issue, webhook gövdesi) veri olarak eklenir."
                onChange={(ev) => {
                  set('prompt', ev.target.value);
                }}
              />
              <div className="grid gap-3 sm:grid-cols-3">
                <DyChoice
                  label="Runtime"
                  value={f.runtime}
                  options={RUNTIMES.map((r) => [r, r] as const)}
                  onChange={(v) => {
                    set('runtime', v);
                  }}
                />
                <DyChoice
                  label="Kum havuzu"
                  value={f.sandboxProfile}
                  options={SANDBOX_PROFILES.map((s) => [s, SANDBOX_TR[s]?.label ?? s] as const)}
                  onChange={(v) => {
                    touched.current.sandbox = true;
                    set('sandboxProfile', v);
                  }}
                />
                <DyInput
                  label="En uzun süre (dakika)"
                  inputMode="numeric"
                  value={f.maxDurationMin}
                  onChange={(ev) => {
                    touched.current.duration = true;
                    set('maxDurationMin', ev.target.value);
                  }}
                />
              </div>
              {!editing ? (
                <p className="m-0 text-[0.78125rem] text-dy-muted" data-testid="automation-defaults-note">
                  Kum havuzu, model ve sınırlar projenin varsayılanlarından başlar (iş formundaki gibi);
                  model, runtime için projenin varsayılanıdır.
                </p>
              ) : null}
              {problem !== null ? (
                <DyNotice tone="red">
                  <span data-testid="automation-placement-warning">
                    Hiçbir makine bu işi bu ayarlarla çalıştıramaz: {problem}. Çalıştırmaları başlamaz — kum
                    havuzunu ya da runtime’ı değiştir veya önce bir makine hazırla.
                  </span>
                </DyNotice>
              ) : null}
              <ChoiceCards
                legend="Onaylar"
                name="automation-approval"
                value={f.approvalPolicy}
                hint="Çalıştırmalar kimse bakmıyorken başlar: ajan hassas bir şey yapmak isteyince ne olacağını seç."
                options={APPROVAL_POLICIES.map((p) => {
                  const blocked = p === 'allow-all' && !autoApprove && f.approvalPolicy !== p;
                  return {
                    value: p,
                    label: APPROVAL_TR[p]?.label ?? p,
                    description:
                      p === 'deny-sensitive'
                        ? 'Hassas adımlar birini beklemek yerine reddedilir. Gözetimsiz çalıştırmalar için önerilir.'
                        : APPROVAL_TR[p]?.text,
                    disabled: blocked,
                    aside: blocked ? (
                      <span
                        className="mt-1 block text-[0.75rem] text-dy-muted"
                        data-reason="auto_approve_not_allowed"
                      >
                        Bu proje hiç sormayan işlere izin vermiyor.{' '}
                        <Link to={projectHref(f.project, 'policy')} className="font-bold text-dy-teal-ink">
                          Proje politikası
                        </Link>
                      </span>
                    ) : undefined,
                  };
                })}
                onChange={(v) => {
                  set('approvalPolicy', v);
                }}
              />
              <UnattendedNote
                policy={f.approvalPolicy}
                timeoutMinutes={f.approvalTimeoutOn ? Number(f.approvalTimeoutMin) || null : null}
              />
              <div className="grid gap-2 sm:grid-cols-[1fr_14rem] sm:items-end">
                <DyCheck
                  label="Kimsenin onaylamadığı çalıştırmayı iptal et"
                  checked={f.approvalTimeoutOn}
                  onChange={(v) => {
                    set('approvalTimeoutOn', v);
                  }}
                />
                {f.approvalTimeoutOn ? (
                  <DyInput
                    label="kaç dakika sonra"
                    inputMode="numeric"
                    value={f.approvalTimeoutMin}
                    error={e('approvalTimeoutMin')}
                    onChange={(ev) => {
                      set('approvalTimeoutMin', ev.target.value);
                    }}
                  />
                ) : null}
              </div>
              {!workspace && (git !== null || editing) ? (
                <DyCheck
                  label={deliveryWords.outputs}
                  hint={deliveryWords.hint}
                  checked={f.delivery === 'outputs'}
                  onChange={(v) => {
                    set('delivery', v ? 'outputs' : 'merge');
                  }}
                />
              ) : null}
              {!editing && f.project !== '' && git === null ? (
                <p className="m-0 text-[0.78125rem] text-dy-muted">
                  Depo yok: depo olmadan bir çalışma alanı işi olarak çalışır.
                </p>
              ) : null}
            </>
          ) : (
            <DyChoice
              label="İş akışı"
              value={f.workflowId}
              error={e('workflowId')}
              options={[
                ['', projectWorkflows.length === 0 ? 'Bu projede iş akışı yok' : 'Seç'],
                ...projectWorkflows.map((w) => [w.id, `${w.name} v${String(w.version)}`] as const),
              ]}
              onChange={(v) => {
                set('workflowId', v);
              }}
            />
          )}
          {workspace && f.target !== 'deploy' ? (
            <FilesFields
              value={f.files}
              onChange={(v) => {
                set('files', v);
              }}
              target={f.target}
              trigger={f.kind}
              errors={shown}
            />
          ) : null}
        </div>
      </Panel>

      <Panel title="Kurallar">
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <DyChoice
              label="Örtüşen çalıştırmalar"
              value={f.concurrency}
              options={(['skip', 'queue', 'parallel'] as const).map(
                (c) => [c, CONCURRENCY_TR[c] ?? c] as const,
              )}
              onChange={(v) => {
                set('concurrency', v === 'queue' || v === 'parallel' ? v : 'skip');
              }}
            />
            {f.kind === 'cron' || f.kind === 'at' ? (
              <DyChoice
                label="Kaçırılan zamanlar"
                value={f.catchUp}
                options={(['skip', 'once', 'all'] as const).map((c) => [c, CATCH_UP_TR[c] ?? c] as const)}
                onChange={(v) => {
                  set('catchUp', v === 'skip' || v === 'all' ? v : 'once');
                }}
              />
            ) : null}
            <DyInput
              label="Saatte en çok çalıştırma"
              inputMode="numeric"
              value={f.maxRunsPerHour}
              error={e('maxRunsPerHour')}
              onChange={(ev) => {
                set('maxRunsPerHour', ev.target.value);
              }}
            />
          </div>
          {f.target === 'job' || f.target === 'workflow' ? (
            <ClassPicker
              value={f.priorityClass}
              onChange={(v) => {
                set('priorityClass', v);
              }}
            />
          ) : null}
          {f.target === 'job' && f.project !== '' ? (
            <DeployField
              project={f.project}
              workspace={workspace}
              value={f.deploy}
              onChange={(v) => {
                set('deploy', v);
              }}
              showErrors={shown.deploy !== undefined}
            />
          ) : null}
          {f.target === 'job' && f.project !== '' ? (
            <VerifyField
              value={f.verify}
              deploying={f.deploy.enabled}
              onChange={(v) => {
                set('verify', v);
              }}
            />
          ) : null}
          {f.target === 'job' ? (
            <div className="grid gap-2 sm:grid-cols-[1fr_14rem] sm:items-end">
              <DyCheck
                label="Özdeş bir iş yakın zamanda başarılıysa çalıştırmayı atla"
                checked={f.reuseOn}
                onChange={(v) => {
                  set('reuseOn', v);
                }}
              />
              {f.reuseOn ? (
                <DyInput
                  label="kaç saat içinde"
                  inputMode="numeric"
                  value={f.reuseHours}
                  error={e('reuseHours')}
                  onChange={(ev) => {
                    set('reuseHours', ev.target.value);
                  }}
                />
              ) : null}
            </div>
          ) : null}
          {f.target === 'job' && f.reuseOn ? (
            <p className="m-0 text-[0.78125rem] text-dy-muted" data-testid="reuse-policy-note">
              Aynı proje, runtime, model, görev ve taban commit (ya da girdi dosyaları). Çalıştırma o işe
              bağlantıyla “atlandı” olarak kaydedilir. Güvenilmeyen kaynaklardan, GitHub’dan, webhook’tan ve
              zincirden gelen çalıştırmalar (olayları girdinin parçası) ve “Şimdi çalıştır” her zaman çalışır.
            </p>
          ) : null}
          <DyCheck
            label="Bir çalıştırma başarısız olunca projenin operatörlerine bildir"
            checked={f.notifyOnFailure}
            onChange={(v) => {
              set('notifyOnFailure', v);
            }}
          />
          {!editing ? (
            <DyCheck
              label="Hemen açık olsun"
              checked={f.enabled}
              onChange={(v) => {
                set('enabled', v);
              }}
            />
          ) : null}
        </div>
      </Panel>

      {showErrors && Object.keys(errors).length > 0 ? (
        <DyNotice tone="red" live>
          Kaydetmeden önce işaretli alanları düzelt.
        </DyNotice>
      ) : null}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      <div className="flex flex-wrap gap-2">
        <DyButton type="submit" variant="primary" busy={submit.busy} disabled={submit.blocked}>
          {editing ? 'Değişiklikleri kaydet' : 'Otomasyonu oluştur'}
        </DyButton>
        <DyButtonLink to={back} variant="ghost">
          Vazgeç
        </DyButtonLink>
      </div>
    </form>,
  );
}
