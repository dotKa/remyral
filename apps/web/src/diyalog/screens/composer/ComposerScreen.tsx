import { useErrorText } from '../../../i18n/errors';
import { useT } from '../../../i18n/I18nProvider';
import { type ReactNode, useId } from 'react';
import type { ApiError } from '../../../api/client';
import { cx, formatDuration } from '../../../components/ui';
import { describeReason, runtimeName } from '../../../lib/reasons';
import { type ComposerTexts, useComposerController } from '../../../screens/composer/controller';
import { scheduleWhen } from '../../../screens/composer/draft';
import { DyIcon } from '../../icons';
import { DyButton, DyButtonLink } from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import { DeployWhenDone, PreviewWhenUp, VerifyWhenDone } from './done';
import { Note, Reason, Tag } from './fields';
import { PlacementPanel } from './placement';
import { ApprovalChoice, LimitsFields, PriorityField, ScheduleFields } from './rules';
import { InputsFields, ModeAndProject, PromptField, SourceFields, WorkflowFields } from './what';
import { ZipInputField } from './zip-input';
import { BatchProjectsField, useComposerBatch } from './batch';
import { SimilarRecordNotice } from '../../related/RelatedWork';
import {
  KindChoice,
  MachineRequirements,
  ModelField,
  RuntimeAdvice,
  RuntimeChoice,
  RuntimeFallbacks,
  RuntimeVersion,
  SandboxChoice,
} from './where';
import { NEEDED_TR, rulesSummaryTr, VERDICT_TR, whereSummaryTr } from './words';

/**
 * p12-diyalog-w1: the composer page (`/jobs/new`) in the Diyalog language (docs/design/p12-diyalog.md §14). One page,
 * three numbered sections — Ne (single job or workflow run, project, task, repository or files, what happens when it
 * is done), Nerede (runtime with readiness and limits, model, sandbox, machines) and Kurallar (limits, approvals,
 * class, when). Nerede and Kurallar start as one-line summaries of the project's defaults and open by themselves while
 * something in them blocks the job. "Nerede çalışır?" stays beside the form; the submit bar stays on screen and
 * Ctrl/Cmd+Enter submits. All rules — prefills, project defaults, validation, identical-result check, step-up for
 * schedules and production deploys — are the classic controller's (`screens/composer/controller.ts`).
 */

const TEXTS: ComposerTexts = {
  deployStepUp: 'Bu işi göndermek yayınını da onaylar — güncel bir authenticator kodu gir.',
  scheduleJobStepUp:
    'Bir işi zamanlamak, onu sonra senin adınla gönderir — güncel bir authenticator kodu gir.',
  scheduleWorkflowStepUp:
    'Bir iş akışını zamanlamak, onu sonra senin adınla başlatır — güncel bir authenticator kodu gir.',
};

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Submission issues the reason mapping does not cover (p5-full-access). */
const ISSUE_TR: Readonly<Record<string, string>> = {
  auto_approve_requires_trusted_source:
    '“Hiç sorma” yalnızca güvenilir kaynak için: kodu güvenilir işaretle ya da Kurallar’da başka bir onay kuralı seç.',
  untrusted_requires_container:
    'Güvenilmeyen kaynak yalnızca konteynerde çalışır: Nerede’de Konteyner’i seç.',
};

/** Refusals in plain words: a secret in an input, too large a request, field issues, rate limit wait. */
function SubmitError(props: { readonly error: ApiError | null; readonly retryLeft: number }): ReactNode {
  const sayError = useErrorText();
  const { error } = props;
  if (error === null) return null;
  const hint =
    error.code === 'input_secret_detected'
      ? 'Bir girdi dosyasında gizli bilgi var gibi görünüyor. Gizli bilgiyi (ya da dosyayı) çıkar ve yeniden gönder.'
      : error.status === 413
        ? 'İstek çok büyük: en çok 10 dosya, her biri 5 MiB, toplam 10 MiB.'
        : null;
  return (
    <div aria-live="assertive" className="grid gap-2" data-testid="dy-composer-error">
      {describeReason(error.code).known ? (
        <Reason reason={`${error.code}: ${error.message}`} tone="danger" />
      ) : (
        <Note tone="danger">
          <span className="block font-bold">{hint ?? 'İş reddedildi.'}</span>
          <span className="mt-0.5 block" data-testid="api-error">
            {sayError(error)}
          </span>
        </Note>
      )}
      {error.retryAfterSeconds !== null && props.retryLeft > 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{`${formatDuration(props.retryLeft)} sonra yeniden deneyebilirsin.`}</p>
      ) : null}
      {error.issues.length > 0 ? (
        <ul className="m-0 grid list-none gap-1.5 p-0" data-testid="api-issues">
          {error.issues.map((i) => (
            <li key={`${i.path}:${i.code}`}>
              {ISSUE_TR[i.code] !== undefined ? (
                <Note tone="danger">{ISSUE_TR[i.code]}</Note>
              ) : describeReason(i.code).known ? (
                <Reason reason={i.code} tone="danger" />
              ) : (
                <Note tone="danger">
                  <span className="font-dy-mono">{i.path}</span>: {i.code}
                </Note>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One numbered section; Nerede / Kurallar collapse to their summary unless something in them blocks the job. */
function Section(props: {
  readonly id: 'what' | 'where' | 'rules';
  readonly n: number;
  readonly title: string;
  readonly purpose: string;
  readonly summary?: string;
  readonly open: boolean;
  readonly forced?: boolean;
  readonly onToggle?: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const head = useId();
  const body = useId();
  const collapsible = props.summary !== undefined && props.onToggle !== undefined;
  return (
    <section
      aria-labelledby={head}
      data-testid={`composer-section-${props.id}`}
      data-open={props.open ? 'true' : 'false'}
      className={cx(
        'min-w-0 rounded-[14px] border bg-dy-card shadow-dy',
        props.forced === true ? 'border-dy-amber' : 'border-dy-line',
      )}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 pt-3.5 pb-3 sm:px-5">
        <span
          aria-hidden="true"
          className={cx(
            'mt-px grid size-7 shrink-0 place-items-center rounded-full font-dy-mono text-[0.8125rem] font-bold',
            props.forced === true ? 'bg-dy-amber-soft text-dy-amber-ink' : 'bg-dy-sunk text-dy-muted',
          )}
        >
          {props.n}
        </span>
        <div className="min-w-0 flex-[1_1_220px]">
          <h2 id={head} className="m-0 text-[1.0625rem] font-extrabold tracking-[-0.01em]">
            {props.title}
          </h2>
          <p className="m-0 mt-0.5 text-[0.84375rem] text-dy-muted">{props.purpose}</p>
          {collapsible && !props.open ? (
            <p
              className="m-0 mt-1.5 text-[0.875rem] font-medium [overflow-wrap:anywhere] text-dy-ink"
              data-testid={`${props.id}-summary`}
            >
              {props.summary}
            </p>
          ) : null}
        </div>
        {props.forced === true ? <Tag tone="amber">düzeltilecek alan var</Tag> : null}
        {collapsible && props.forced !== true ? (
          <DyButton
            variant="ghost"
            aria-expanded={props.open}
            aria-controls={body}
            data-testid={`composer-toggle-${props.id}`}
            onClick={props.onToggle}
          >
            {props.open ? 'Kapat' : 'Değiştir'}
            <DyIcon
              name="chev"
              className={cx('size-3.5 transition-transform duration-150', props.open && 'rotate-180')}
            />
          </DyButton>
        ) : null}
      </div>
      {props.open ? (
        <div id={body} className="grid gap-5 border-t border-dy-line px-4 pt-4 pb-5 sm:px-5">
          {props.children}
        </div>
      ) : (
        <div id={body} hidden />
      )}
    </section>
  );
}

export function ComposerScreen(): ReactNode {
  const sayError = useErrorText();
  const c = useComposerController(TEXTS);
  const { draft, set, shownErrors: errors, preview, workspace } = c;
  // p18-leftovers: "Başka projelerde de çalıştır" turns the job into a batch (one job per project).
  const batch = useComposerBatch(draft);
  const batchWords = useT().multiProject.composer;
  const job = draft.mode === 'job';
  const submitLabel =
    draft.when === 'now' ? (job ? 'İşi gönder' : 'Çalıştırmayı başlat') : 'Zamanlamayı oluştur';
  const needed = [
    ...new Set(
      Object.keys(c.errors)
        .map((k) => (k.startsWith('input.') ? 'iş akışı girdileri' : NEEDED_TR[k]))
        .filter((x): x is string => x !== undefined),
    ),
  ];
  const problems = Object.keys(c.errors).length;
  const verdict = c.placement === null ? null : (VERDICT_TR[c.placement.verdict] ?? null);
  const fullAccess =
    job && draft.approvalPolicy === 'allow-all' && draft.sandboxProfile === 'unconfined'
      ? 'Tam erişim'
      : job && draft.approvalPolicy === 'allow-all'
        ? 'Onay sorusu yok'
        : job && draft.sandboxProfile === 'unconfined'
          ? 'Sınırsız makine'
          : null;
  const src = c.prefillSource;
  const prefillNote =
    src === null
      ? null
      : src.kind === 'template'
        ? `“${src.title}” şablonunun v${String(src.version)} sürümünden dolduruldu. Göndermeden önce kontrol et.`
        : src.kind === 'job'
          ? `${src.id.slice(0, 8)}… işinden dolduruldu (yeni bir çalışma dalıyla). Göndermeden önce kontrol et.`
          : 'Asistanın taslağından dolduruldu. Göndermeden önce kontrol et.';

  return (
    <ScreenFrame
      title="Yeni iş"
      purpose="Ajanın ne yapacağını yaz. Nerede çalışacağı ve kuralları projeden gelir; gerekirse değiştir."
      back={{ to: '/jobs', label: 'İşler' }}
      testId="dy-composer"
      actions={
        <>
          <DyButtonLink to="/jobs/templates" variant="ghost" icon="file">
            Şablonlar
          </DyButtonLink>
          <DyButtonLink to="/automations" variant="ghost" icon="clock">
            Otomasyonlar
          </DyButtonLink>
        </>
      }
    >
      <div className="grid gap-3">
        {prefillNote === null ? null : <Note testId="composer-prefill">{prefillNote}</Note>}
        {c.prefillError === null ? null : (
          <Note tone="danger" testId="dy-composer-prefill-error">
            Önceki iş okunamadı: {sayError(c.prefillError)}
          </Note>
        )}
      </div>
      <form
        ref={c.formRef}
        noValidate
        aria-label="Yeni iş"
        className={prefillNote === null && c.prefillError === null ? '' : 'mt-4'}
        onSubmit={(e) => {
          // Enter in a field never submits a job: the button (or Ctrl/Cmd+Enter) does.
          e.preventDefault();
        }}
        onKeyDown={(e) => {
          // p18-leftovers: with other projects picked, Ctrl/Cmd+Enter sends the batch, never one job.
          if (batch.active && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            batch.submit();
            return;
          }
          c.onKeyDown(e);
        }}
      >
        <div
          className={cx(
            'grid grid-cols-[minmax(0,1fr)] items-start gap-4',
            job && 'lg:grid-cols-[minmax(0,1fr)_minmax(300px,22rem)]',
          )}
        >
          <div className="grid min-w-0 gap-4">
            <Section
              id="what"
              n={1}
              title="Ne"
              purpose={job ? 'Proje, kodu ve görev.' : 'Proje ve çalıştırılacak iş akışı.'}
              open
            >
              <ModeAndProject
                draft={draft}
                set={set}
                errors={errors}
                projects={c.projects}
                projectsError={c.projectsError}
              />
              {job ? <PromptField draft={draft} set={set} errors={errors} /> : null}
              {job ? <BatchProjectsField draft={draft} projects={c.projects} batch={batch} /> : null}
              {/* p17-embeddings: "Benzer bir kayıt var" — a similar open or recent job of the project (a warning). */}
              {job ? <SimilarRecordNotice kind="job" project={draft.project} text={draft.prompt} /> : null}
              {job ? (
                draft.project === '' ? null : workspace ? (
                  <InputsFields draft={draft} set={set} errors={errors} />
                ) : (
                  <>
                    <SourceFields draft={draft} set={set} errors={errors} gitHint={c.gitHint} />
                    {/* p19-repo-inputs-composer-workflows: a repository job's input files (scratch in/). */}
                    <InputsFields
                      draft={draft}
                      set={set}
                      errors={errors}
                      repository
                      blocked={c.repoFiles?.available === false}
                    />
                  </>
                )
              ) : (
                <WorkflowFields
                  workspace={workspace}
                  projectRepoUrl={c.projectRepoUrl}
                  draft={draft}
                  set={set}
                  errors={errors}
                  definitions={c.definitions}
                  definition={c.definition}
                  definitionError={c.definitionError}
                />
              )}
              {/* p16-zip-job-input: files from a .zip for workspace and repository jobs started now. */}
              {job && draft.project !== '' ? <ZipInputField draft={draft} set={set} errors={errors} /> : null}
              {job && draft.project !== '' ? (
                <div className="grid gap-3" data-testid="dy-composer-done">
                  <h3 className="m-0 text-[0.875rem] font-bold">Bitince</h3>
                  <DeployWhenDone
                    project={draft.project}
                    workspace={workspace}
                    value={c.deploy}
                    onChange={c.setDeploy}
                    showErrors={c.showErrors}
                  />
                  <VerifyWhenDone value={c.verify} onChange={c.setVerify} deploying={c.deploy.enabled} />
                  <PreviewWhenUp
                    value={c.previewChoice}
                    onChange={c.setPreviewChoice}
                    showErrors={c.showErrors}
                  />
                  {c.deploy.enabled && scheduleWhen(draft) !== null ? (
                    <Note>
                      “Bitince yayınla” hemen başlayan bir iş için geçerli; zamanlamada otomasyonda ayarla.
                    </Note>
                  ) : null}
                </div>
              ) : null}
            </Section>
            {job ? (
              <Section
                id="where"
                n={2}
                title="Nerede"
                purpose="Runtime ve model, yalıtım ve hangi makinelerin çalıştırabileceği."
                summary={whereSummaryTr(draft, preview)}
                open={c.whereOpen}
                forced={c.whereBlocked}
                onToggle={() => {
                  c.toggle('where');
                }}
              >
                <KindChoice draft={draft} set={set} errors={errors} preview={preview} />
                <RuntimeAdvice draft={draft} set={set} errors={errors} preview={preview} />
                <RuntimeChoice draft={draft} set={set} errors={errors} preview={preview} />
                <ModelField draft={draft} set={set} errors={errors} preview={preview} />
                <RuntimeVersion draft={draft} set={set} errors={errors} preview={preview} />
                <RuntimeFallbacks draft={draft} set={set} errors={errors} preview={preview} />
                <SandboxChoice
                  draft={draft}
                  set={set}
                  errors={errors}
                  preview={preview}
                  onFullAccess={c.onFullAccess}
                />
                <MachineRequirements draft={draft} set={set} errors={errors} preview={preview} />
              </Section>
            ) : null}
            <Section
              id="rules"
              n={job ? 3 : 2}
              title="Kurallar"
              purpose={
                job
                  ? 'Sınırlar, ne zaman sana sorulacağı, sınıf ve ne zaman başlayacağı.'
                  : 'Sınıf ve çalıştırmanın ne zaman başlayacağı.'
              }
              summary={rulesSummaryTr(draft)}
              open={c.rulesOpen}
              forced={c.rulesBlocked}
              onToggle={() => {
                c.toggle('rules');
              }}
            >
              {job ? (
                <>
                  <LimitsFields
                    draft={draft}
                    set={set}
                    errors={errors}
                    preview={preview}
                    budgets={c.budgets}
                  />
                  <ApprovalChoice draft={draft} set={set} errors={errors} preview={preview} />
                </>
              ) : null}
              <PriorityField draft={draft} set={set} errors={errors} />
              <ScheduleFields draft={draft} set={set} errors={errors} />
            </Section>
          </div>
          {job ? (
            <aside aria-label="Yerleşim önizlemesi" className="min-w-0 lg:sticky lg:top-[69px]">
              <PlacementPanel preview={preview} loading={c.loading} error={c.previewError} />
            </aside>
          ) : null}
        </div>
        <div className="mt-4 grid gap-3 empty:hidden">
          <SubmitError error={c.submit.error} retryLeft={c.submit.retryLeft} />
          {c.identical === null ? null : (
            <div
              role="status"
              data-testid="composer-identical"
              className="grid gap-2 rounded-[12px] bg-dy-amber-soft px-4 py-3 text-[0.875rem] text-dy-amber-ink"
            >
              <p className="m-0 font-bold">{`Aynı iş ${c.identical.age} başarıyla bitti.`}</p>
              <p className="m-0">
                {`Aynı proje, runtime ${runtimeName(c.identical.runtime)}${
                  c.identical.modelProfile === null ? '' : `, model ${c.identical.modelProfile}`
                }, aynı istem ve ${
                  c.identical.baseCommit === null
                    ? 'aynı girdi dosyaları'
                    : `aynı temel commit (${c.identical.baseCommit.slice(0, 12)})`
                }. Sonucunu aç ya da bu işi yine de çalıştır.`}
              </p>
              <div className="flex flex-wrap gap-2">
                <DyButtonLink to={`/jobs/${c.identical.jobId}`} variant="primary" icon="checkc">
                  <span data-testid="composer-open-result">Sonucu aç</span>
                </DyButtonLink>
                <DyButton
                  busy={c.submit.busy}
                  data-testid="composer-run-anyway"
                  onClick={() => void c.onSubmit({ runAnyway: true })}
                >
                  Yine de çalıştır
                </DyButton>
              </div>
            </div>
          )}
        </div>
        <div
          data-testid="composer-footer"
          className="sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-[4] mt-4 flex items-center justify-between gap-3 rounded-[14px] border border-dy-line bg-dy-card/95 px-4 py-3 shadow-dy backdrop-blur-[10px] md:bottom-4"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1 text-[0.84375rem]" aria-live="polite">
            {c.showErrors && problems > 0 ? (
              <span className="font-bold text-dy-red-ink" data-testid="composer-status">
                {needed.length > 0
                  ? `Eksik: ${needed.join(', ')}.`
                  : `Yukarıda ${String(problems)} alanı düzelt.`}
              </span>
            ) : needed.length > 0 ? (
              <span className="text-dy-muted" data-testid="composer-status">
                Eksik: {needed.join(', ')}.
              </span>
            ) : verdict !== null ? (
              <span className="flex min-w-0 flex-wrap items-center gap-2" data-testid="composer-status">
                <Tag tone={verdict.tone}>{verdict.label}</Tag>
                <span className="hidden min-w-0 truncate text-dy-muted sm:inline">{verdict.text}</span>
              </span>
            ) : (
              <span className="text-dy-muted" data-testid="composer-status">
                Göndermeye hazır.
              </span>
            )}
            {fullAccess === null ? null : (
              <span data-testid="full-access-badge">
                <Tag tone="red">{`⚠ ${fullAccess}`}</Tag>
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden text-[0.75rem] text-dy-muted md:inline">
              <kbd className="rounded border border-dy-line-2 bg-dy-sunk px-1 font-dy-mono">
                {isMac ? '⌘' : 'Ctrl'}
              </kbd>
              {' + '}
              <kbd className="rounded border border-dy-line-2 bg-dy-sunk px-1 font-dy-mono">Enter</kbd>
            </span>
            {batch.active ? (
              <DyButton
                variant="primary"
                icon="send"
                busy={batch.busy === 'submit'}
                disabled={batch.busy !== null || (batch.check !== null && batch.check.ready.length === 0)}
                data-testid="composer-batch-submit"
                onClick={batch.submit}
              >
                {batchWords.submit({ n: batch.check?.ready.length ?? batch.extra.length + 1 })}
              </DyButton>
            ) : (
              <DyButton
                variant="primary"
                icon={draft.when === 'now' ? 'send' : 'clock'}
                busy={c.submit.busy}
                data-testid="composer-submit"
                onClick={() => void c.onSubmit()}
              >
                {submitLabel}
              </DyButton>
            )}
          </div>
        </div>
      </form>
    </ScreenFrame>
  );
}
