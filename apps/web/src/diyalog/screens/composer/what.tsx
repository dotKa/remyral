import { useErrorText } from '../../../i18n/errors';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import {
  type BundlePreview,
  getBundlePreview,
  type WorkflowDefinitionSummary,
  type WorkflowDefinitionView,
} from '../../../api/composer';
import type { ApiError } from '../../../api/client';
import type { Project } from '../../../api/directory';
import {
  ALLOWED_EXTENSIONS,
  formatBytes,
  MAX_INPUT_BYTES,
  MAX_INPUT_FILES,
  MAX_INPUT_TOTAL_BYTES,
} from '../../../api/workspaces';
import { useAuth } from '../../../auth/AuthProvider';
import { toApiError } from '../../../components/ui';
import { runtimeName } from '../../../lib/reasons';
import type { Draft, Errors } from '../../../screens/composer/draft';
import type { GitHint } from '../../../screens/composer/controller';
import { inputFileError, readInputFile } from '../../../screens/composer/inputs';
import { APPROVAL_TR } from '../../compose/labels';
import { DyIcon } from '../../icons';
import { DyButton } from '../parts';
import { DyArea, DyChoice, DySelectField, DyText, FieldError, LABEL, More, Note, Tag } from './fields';
import { sandboxTr } from './words';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { fill } from '@remyral/i18n';

/**
 * p12-diyalog-w1 "Ne": single job or workflow run, the project, the task (with its byte counter and the context
 * bundle preview), the repository filled from the project (base / work branch, who wrote the code) or a workspace's
 * input files and "continue from", and for a workflow run the workflow, its steps and inputs. Same fields and rules as
 * the classic `screens/composer/what.tsx`; every value from the API is rendered as text.
 */

interface Props {
  readonly draft: Draft;
  readonly set: (p: Partial<Draft>) => void;
  readonly errors: Errors;
}

function ApiNote(props: { readonly error: ApiError | null; readonly what: string }): ReactNode {
  const sayError = useErrorText();
  if (props.error === null) return null;
  return (
    <Note tone="danger">
      {props.what} okunamadı: {sayError(props.error)}
    </Note>
  );
}

/** Empty project list: admins are pointed at project creation, everyone else at an admin. */
function NoProjects(): ReactNode {
  const { state } = useAuth();
  const isAdmin = state.kind === 'signedIn' && (state.user.role === 'owner' || state.user.role === 'admin');
  return (
    <Note testId="dy-composer-no-projects">
      {isAdmin ? (
        <>
          Henüz proje yok; her iş bir projeye aittir.{' '}
          <Link to="/projects" className="font-bold text-dy-ink underline underline-offset-2">
            Proje oluştur
          </Link>
          , sonra buraya dön.
        </>
      ) : (
        'Hiçbir projede operatör değilsin. İş başlatmak için bir yöneticiden bir projede operatör yetkisi iste.'
      )}
    </Note>
  );
}

export function ModeAndProject(
  props: Props & { readonly projects: Project[] | null; readonly projectsError: ApiError | null },
): ReactNode {
  const { draft, set, projects } = props;
  const workspace = projects?.find((p) => p.id === draft.project)?.kind === 'workspace';
  return (
    <div className="grid gap-4">
      <DyChoice
        legend="Ne başlatmak istiyorsun?"
        name="mode"
        value={draft.mode}
        columns={2}
        testId="dy-composer-mode"
        onChange={(v) => {
          set({ mode: v === 'workflow' ? 'workflow' : 'job' });
        }}
        options={[
          { value: 'job', label: 'Tek bir iş', description: 'Bir ajan, bir görev.' },
          {
            value: 'workflow',
            label: 'Bir iş akışı',
            // p8-orchestration: workspace workflows hand each step's out/ files to the next step's in/.
            description: workspace
              ? 'Her adım senin dosyalarını ve önceki adımların dosyalarını alır.'
              : 'Kayıtlı adımlar sırayla ya da paralel çalışır.',
          },
        ]}
      />
      <ApiNote error={props.projectsError} what="Projeler" />
      {projects === null ? (
        <p role="status" className="m-0 text-[0.875rem] text-dy-muted">
          Projeler yükleniyor…
        </p>
      ) : projects.length === 0 ? (
        <NoProjects />
      ) : (
        <DySelectField
          label="Proje"
          value={draft.project}
          testId="dy-composer-project"
          options={[
            ['', 'Bir proje seç…'],
            ...projects.map(
              (p) =>
                [p.id, `${p.name} (${p.id})${p.kind === 'workspace' ? ' · çalışma alanı' : ''}`] as const,
            ),
          ]}
          onChange={(v) => {
            set({ project: v });
          }}
          error={props.errors.project ?? null}
          hint={
            props.errors.project
              ? undefined
              : workspace
                ? 'Çalışma alanının deposu yok: ajan senin eklediğin dosyalarla boş bir klasörde çalışır, sonuçlarını indirilebilir dosya olarak bırakır.'
                : 'İş başlatabildiğin projeler.'
          }
        />
      )}
    </div>
  );
}

export function TrustChoice(props: {
  readonly draft: Draft;
  readonly set: (p: Partial<Draft>) => void;
  readonly workspace: boolean;
}): ReactNode {
  const { draft, set } = props;
  return (
    <DyChoice
      legend={props.workspace ? 'Bu dosyaları kim verdi?' : 'Bu kodu kim yazdı?'}
      name="sourceTrust"
      value={draft.sourceTrust}
      columns={2}
      testId="dy-composer-trust"
      onChange={(v) => {
        const trust = v === 'trusted' ? 'trusted' : 'untrusted';
        // An untrusted source runs only in the container (the classic rule).
        set(
          trust === 'untrusted'
            ? { sourceTrust: trust, sandboxProfile: 'container' }
            : { sourceTrust: trust },
        );
      }}
      options={[
        {
          value: 'trusted',
          label: 'Güvenilir',
          description: props.workspace
            ? 'Kendi dosyaların. Proje izin veriyorsa iş makinede çalışabilir.'
            : 'Ekibinin kendi kodu. Proje izin veriyorsa iş makinede çalışabilir.',
        },
        {
          value: 'untrusted',
          label: 'Güvenilmeyen',
          description: props.workspace
            ? 'Ekip dışından dosyalar. Yalnızca konteynerde çalışır.'
            : 'Fork, dış katkı, bilinmeyen kod. Yalnızca konteynerde çalışır.',
        },
      ]}
    />
  );
}

export function SourceFields(props: Props & { readonly gitHint: GitHint }): ReactNode {
  const { draft, set, errors } = props;
  return (
    <div className="grid gap-4" data-testid="dy-composer-source">
      <div className="grid gap-3.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <DyText
          label="Depo adresi"
          value={draft.repoUrl}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          mono
          placeholder="https://github.com/acme/app.git"
          hint={
            props.gitHint === 'project'
              ? 'Projenin deposundan dolduruldu.'
              : props.gitHint === 'none'
                ? 'Bu projenin kayıtlı deposu yok; buraya yaz.'
                : undefined
          }
          error={errors.repoUrl ?? null}
          onChange={(v) => {
            set({ repoUrl: v });
          }}
        />
        <DyText
          label="Temel dal"
          value={draft.baseRef}
          autoComplete="off"
          spellCheck={false}
          mono
          placeholder="main"
          error={errors.baseRef ?? null}
          onChange={(v) => {
            set({ baseRef: v });
          }}
        />
      </div>
      <More summary="Çalışma dalı" open={errors.workBranch !== undefined}>
        <DyText
          label="Çalışma dalı"
          className="sm:max-w-80"
          value={draft.workBranch}
          autoComplete="off"
          spellCheck={false}
          mono
          hint="Ajanın yerel dalı. Sonuçlar rac/<iş>/<deneme> dalına gönderilir, temel dala asla."
          error={errors.workBranch ?? null}
          onChange={(v) => {
            set({ workBranch: v });
          }}
        />
      </More>
      <TrustChoice draft={draft} set={set} workspace={false} />
      <DeliveryChoice draft={draft} set={set} />
    </div>
  );
}

/**
 * p22-output-delivery: how a repository job delivers its result — a merge decision (default) or its files in Outputs
 * (no merge approval; for jobs that produce files such as reports or lead packages).
 */
export function DeliveryChoice(props: {
  readonly draft: Pick<Draft, 'delivery'>;
  readonly set: (p: Partial<Draft>) => void;
}): ReactNode {
  const w = useT().outputDelivery.choice;
  return (
    <DyChoice
      legend={w.legend}
      name="delivery"
      value={props.draft.delivery}
      columns={2}
      hint={w.hint}
      testId="dy-composer-delivery"
      onChange={(v) => {
        props.set({ delivery: v === 'outputs' ? 'outputs' : 'merge' });
      }}
      options={[
        { value: 'merge', label: w.merge },
        { value: 'outputs', label: w.outputs },
      ]}
    />
  );
}

/**
 * Workspace inputs (p5-research-workspace): files read in the browser after the master's limits are checked, and an
 * optional earlier job whose results are copied in as inputs. p19-repo-inputs-composer-workflows: the same field for a
 * REPOSITORY project's job or run (`repository`) — the files go to a scratch in/ next to the checkout, never committed;
 * `blocked`: no machine can take them yet (repo-inputs-v1), the field is off and says "makine güncellenmeli".
 */
export function InputsFields(
  props: Props & {
    readonly forWorkflow?: boolean;
    readonly repository?: boolean;
    readonly blocked?: boolean;
  },
): ReactNode {
  const { draft, set, errors } = props;
  const forWorkflow = props.forWorkflow === true;
  const repository = props.repository === true;
  const blocked = repository && props.blocked === true;
  const rt = useT().repoFiles.composer;
  const [problems, setProblems] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const total = draft.inputFiles.reduce((n, f) => n + f.sizeBytes, 0);

  async function add(files: readonly File[]): Promise<void> {
    const issues: string[] = [];
    let current = draft.inputFiles;
    setReading(true);
    try {
      for (const file of files) {
        const why = inputFileError(file, current);
        if (why !== null) {
          issues.push(why);
          continue;
        }
        try {
          current = [...current, await readInputFile(file)];
        } catch {
          issues.push(`${file.name}: dosya okunamadı.`);
        }
      }
    } finally {
      setReading(false);
    }
    setProblems(issues);
    set({ inputFiles: current });
  }

  return (
    <div className="grid gap-4" data-testid="dy-composer-inputs">
      <div className="min-w-0">
        <label htmlFor="dy-workspace-inputs" className={LABEL}>
          Girdi dosyaları
        </label>
        <input
          id="dy-workspace-inputs"
          type="file"
          multiple
          accept={ALLOWED_EXTENSIONS.join(',')}
          aria-describedby="dy-workspace-inputs-hint"
          disabled={blocked}
          className="w-full max-w-full text-[0.875rem] text-dy-muted file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-[9px] file:border file:border-dy-line-2 file:bg-dy-card file:px-3 file:text-[0.875rem] file:font-bold file:text-dy-ink"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            void add(files);
          }}
        />
        {repository ? (
          <p id="dy-workspace-inputs-hint" className="m-0 mt-1 text-[0.78125rem] text-dy-muted">
            {rt.limits({
              files: String(MAX_INPUT_FILES),
              each: formatBytes(MAX_INPUT_BYTES),
              total: formatBytes(MAX_INPUT_TOTAL_BYTES),
              types: ALLOWED_EXTENSIONS.join(' '),
            })}
          </p>
        ) : (
          <p id="dy-workspace-inputs-hint" className="m-0 mt-1 text-[0.78125rem] text-dy-muted">
            {forWorkflow ? 'Her adım alır, önceki adımların dosyalarının yanında. ' : ''}
            Ajan bunları <span className="font-dy-mono">in/</span> klasöründen okur, sonuçlarını{' '}
            <span className="font-dy-mono">out/</span> klasörüne yazar. En çok {MAX_INPUT_FILES} dosya, her
            biri {formatBytes(MAX_INPUT_BYTES)}, toplam {formatBytes(MAX_INPUT_TOTAL_BYTES)}; türler{' '}
            {ALLOWED_EXTENSIONS.join(' ')}. Gönderirken dosyalarda gizli bilgi aranır.
          </p>
        )}
        {reading ? (
          <p role="status" className="m-0 mt-1 text-[0.8125rem] text-dy-muted">
            Dosyalar okunuyor…
          </p>
        ) : null}
        {problems.length > 0 ? (
          <ul
            className="m-0 mt-1.5 grid list-none gap-0.5 p-0"
            data-testid="input-problems"
            aria-live="polite"
          >
            {problems.map((p) => (
              <li key={p} className="text-[0.8125rem] font-medium text-dy-red-ink">
                {p}
              </li>
            ))}
          </ul>
        ) : null}
        <FieldError id="dy-workspace-inputs-error" error={errors.inputFiles} />
      </div>
      {draft.inputFiles.length > 0 ? (
        <ul
          className="m-0 grid list-none divide-y divide-dy-line overflow-hidden rounded-[11px] border border-dy-line p-0"
          aria-label="Girdi dosyaları"
        >
          {draft.inputFiles.map((f) => (
            <li
              key={f.name}
              className="flex items-center gap-2 px-3 py-1.5 text-[0.875rem]"
              data-testid="input-file"
            >
              <DyIcon name="file" className="size-4 shrink-0 text-dy-muted" />
              <span className="min-w-0 flex-1 truncate font-dy-mono" translate="no">
                {f.name}
              </span>
              <span className="font-dy-mono text-[0.78125rem] text-dy-muted tabular-nums">
                {formatBytes(f.sizeBytes)}
              </span>
              <DyButton
                variant="ghost"
                aria-label={`${f.name} dosyasını çıkar`}
                onClick={() => {
                  set({ inputFiles: draft.inputFiles.filter((x) => x.name !== f.name) });
                }}
              >
                Çıkar
              </DyButton>
            </li>
          ))}
          <li
            className="px-3 py-1.5 font-dy-mono text-[0.75rem] text-dy-muted tabular-nums"
            data-testid="input-total"
          >
            {draft.inputFiles.length} / {MAX_INPUT_FILES} dosya · {formatBytes(total)} /{' '}
            {formatBytes(MAX_INPUT_TOTAL_BYTES)}
          </li>
        </ul>
      ) : null}
      <DyText
        label="Şu işten devam et (isteğe bağlı)"
        value={draft.continueFrom}
        autoComplete="off"
        spellCheck={false}
        mono
        placeholder="iş kimliği"
        disabled={blocked && draft.continueFrom === ''}
        hint={
          repository
            ? rt.continueHint
            : forWorkflow
              ? 'Bu önceki işin sonuçları çalıştırmaya dosya olarak kopyalanır.'
              : 'Bu önceki işin sonuçları girdi olarak kopyalanır; örneğin bir raporu geliştirmek için.'
        }
        error={errors.continueFrom ?? null}
        onChange={(v) => {
          set({ continueFrom: v });
        }}
      />
      {/* p19-repo-inputs-composer-workflows: where a repository job / step finds them, or why the field is off. */}
      {repository ? (
        blocked ? (
          <Note tone="warn" testId="dy-composer-repo-files-update">
            {rt.update}
          </Note>
        ) : (
          <Note testId="dy-composer-repo-files-note">{forWorkflow ? rt.runNote : rt.jobNote}</Note>
        )
      ) : null}
      {forWorkflow || repository ? null : <TrustChoice draft={draft} set={set} workspace />}
    </div>
  );
}

const LAYER_TR: Readonly<Record<string, string>> = {
  platform: 'platform',
  global: 'genel',
  user: 'kişisel',
  project: 'proje',
  memory: 'hafıza',
};

function BundleView(props: { readonly project: string; readonly runtime: string }): ReactNode {
  const [bundle, setBundle] = useState<BundlePreview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (): void => {
    setBusy(true);
    setError(null);
    getBundlePreview(props.project, props.runtime).then(
      (b) => {
        setBundle(b);
        setBusy(false);
      },
      (err: unknown) => {
        setError(toApiError(err));
        setBusy(false);
      },
    );
  };
  return (
    <div
      className="grid gap-2 rounded-[11px] border border-dy-line bg-dy-sunk/50 p-3"
      data-testid="bundle-preview"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="m-0 text-[0.875rem] font-bold">Bağlam paketi</h3>
          <p className="m-0 text-[0.78125rem] text-dy-muted">
            Ajanın görevinden önce okuduğu platform kuralları, proje talimatları ve hafıza.
          </p>
        </div>
        <DyButton busy={busy} disabled={props.runtime === '' || props.runtime === 'auto'} onClick={load}>
          {bundle === null ? 'Paketi göster' : 'Yenile'}
        </DyButton>
      </div>
      <ApiNote error={error} what="Bağlam paketi" />
      {bundle === null ? null : bundle.items.length === 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">Bu proje ve runtime için bağlam belgesi yok.</p>
      ) : (
        <>
          <p className="m-0 font-dy-mono text-[0.75rem] break-all text-dy-muted" translate="no">
            {bundle.bundleHash}
          </p>
          <ol className="m-0 grid list-none gap-1 p-0">
            {bundle.items.map((i) => (
              <li key={String(i.position)}>
                <details>
                  <summary className="cursor-pointer text-[0.8125rem]">
                    <span className="font-bold">{i.title}</span>{' '}
                    <span className="text-dy-muted">
                      · {LAYER_TR[i.layer] ?? i.layer} · {i.recordType ?? i.kind} v{i.version}
                      {i.withheld ? ' · senden gizli' : ''}
                    </span>
                  </summary>
                  {i.content !== null ? (
                    <pre className="mt-1 max-h-60 overflow-auto rounded-lg border border-dy-line bg-dy-card p-2 font-dy-mono text-[0.75rem] break-words whitespace-pre-wrap">
                      {i.content}
                    </pre>
                  ) : null}
                </details>
              </li>
            ))}
          </ol>
          {bundle.omitted > 0 ? (
            <p className="m-0 text-[0.78125rem] text-dy-amber-ink">
              {bundle.omitted} belge boyut sınırı yüzünden dışarıda kaldı.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

const MAX_PROMPT_BYTES = 262_144;

export function PromptField(props: Props): ReactNode {
  const fmt = useFormat();
  const { draft, set, errors } = props;
  const bytes = new TextEncoder().encode(draft.prompt).length;
  return (
    <div className="grid gap-3">
      <DyArea
        label="Ajanın görevi"
        value={draft.prompt}
        rows={7}
        className="min-h-40"
        spellCheck
        placeholder={'Ajan ne yapsın?\n\nBağlam, kabul ölçütleri, bakılacak dosyalar…'}
        hint={
          <>
            <span
              className={bytes > MAX_PROMPT_BYTES ? 'font-bold text-dy-red-ink' : undefined}
              data-testid="dy-composer-bytes"
            >
              {fmt.number(bytes)} / {fmt.number(MAX_PROMPT_BYTES)} bayt.
            </span>{' '}
            Depodaki talimatlar onayları asla geçersiz kılmaz.
          </>
        }
        error={errors.prompt ?? null}
        onChange={(v) => {
          set({ prompt: v });
        }}
      />
      {draft.project !== '' ? <BundleView project={draft.project} runtime={draft.runtime} /> : null}
    </div>
  );
}

/** The workflow's steps in order (a pure list: no graph library, readable on a phone). */
function stepOrder(def: WorkflowDefinitionView): WorkflowDefinitionView['nodes'][number][] {
  const indeg = new Map(def.nodes.map((n) => [n.id, 0]));
  for (const e of def.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const out: WorkflowDefinitionView['nodes'][number][] = [];
  const done = new Set<string>();
  let frontier = def.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0);
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const n of frontier) {
      if (done.has(n.id)) continue;
      done.add(n.id);
      out.push(n);
      for (const e of def.edges.filter((x) => x.from === n.id)) {
        indeg.set(e.to, (indeg.get(e.to) ?? 1) - 1);
        const to = def.nodes.find((x) => x.id === e.to);
        if (to !== undefined && (indeg.get(e.to) ?? 0) <= 0) next.push(to);
      }
    }
    frontier = next;
  }
  // A cycle (refused by the master) or a dangling node: still list everything.
  for (const n of def.nodes) if (!done.has(n.id)) out.push(n);
  return out;
}

function WorkflowSteps(props: { readonly def: WorkflowDefinitionView }): ReactNode {
  const { def } = props;
  const after = (id: string): string[] => def.edges.filter((e) => e.to === id).map((e) => e.from);
  return (
    <div className="rounded-[11px] border border-dy-line bg-dy-sunk/50 p-3" data-testid="workflow-preview">
      <ol className="m-0 grid list-none gap-1.5 p-0" aria-label="İş akışının adımları">
        {stepOrder(def).map((n, i) => {
          const deps = after(n.id);
          return (
            <li key={n.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.84375rem]">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-dy-card font-dy-mono text-[0.75rem] font-bold text-dy-muted tabular-nums">
                {i + 1}
              </span>
              <span className="font-bold" translate="no">
                {n.id}
              </span>
              <span className="text-dy-muted">{n.role}</span>
              <span className="text-dy-muted">· {runtimeName(n.runtime)}</span>
              {n.gate ? <Tag tone="amber">onay kapısı</Tag> : null}
              {n.dynamic ? <Tag tone="violet">dinamik</Tag> : null}
              {deps.length > 0 ? (
                <span className="text-[0.78125rem] text-dy-faint">← {deps.join(', ')}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="m-0 mt-2 text-[0.78125rem] text-dy-muted">
        Adım aksini söylemedikçe her adım {runtimeName(def.defaults.runtime)} ile,{' '}
        {sandboxTr(def.defaults.sandboxProfile)} yalıtımında,{' '}
        {(APPROVAL_TR[def.defaults.approvalPolicy]?.label ?? def.defaults.approvalPolicy).toLocaleLowerCase(
          'tr-TR',
        )}{' '}
        onay kuralıyla çalışır.
      </p>
    </div>
  );
}

export function WorkflowFields(
  props: Props & {
    readonly definitions: readonly WorkflowDefinitionSummary[] | null;
    readonly definition: WorkflowDefinitionView | null;
    readonly definitionError: ApiError | null;
    readonly workspace: boolean;
    /** p16-workflow-quality: the project's registered repository (the fallback when the fields stay empty). */
    readonly projectRepoUrl?: string | null;
  },
): ReactNode {
  const { draft, set, errors, definition } = props;
  const tr = useT().workflowQuality.run;
  const mine = (props.definitions ?? []).filter((d) => d.project === draft.project);
  if (draft.project === '') return null;
  return (
    <div className="grid gap-4" data-testid="dy-composer-workflow">
      {props.definitions === null ? (
        <p role="status" className="m-0 text-[0.875rem] text-dy-muted">
          İş akışları yükleniyor…
        </p>
      ) : mine.length === 0 ? (
        <Note>
          Bu projenin kayıtlı iş akışı yok.{' '}
          <Link
            to={`/workflows/new?project=${encodeURIComponent(draft.project)}`}
            className="font-bold text-dy-teal-ink underline-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
          >
            Workflow oluştur
          </Link>
        </Note>
      ) : (
        <DySelectField
          label="İş akışı"
          value={draft.workflowId}
          options={[
            ['', 'Bir iş akışı seç…'],
            ...mine.map((d) => [d.id, `${d.name} v${String(d.version)} · ${String(d.nodes)} adım`] as const),
          ]}
          onChange={(v) => {
            set({ workflowId: v, inputs: {} });
          }}
          error={errors.workflowId ?? null}
        />
      )}
      {/* p13-workflows-ui: the definitions themselves (graph editor) are one click away. */}
      {props.definitions === null ? null : (
        <p className="m-0 -mt-2 text-[0.8125rem] text-dy-muted">
          <Link
            to={
              draft.workflowId === ''
                ? `/workflows?project=${encodeURIComponent(draft.project)}`
                : `/workflows/${encodeURIComponent(draft.workflowId)}`
            }
            className="text-dy-teal-ink underline-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
            data-testid="composer-workflow-manage"
          >
            {draft.workflowId === '' ? 'Workflow’ları yönet' : 'Bu workflow’u grafikte aç'}
          </Link>
        </p>
      )}
      <ApiNote error={props.definitionError} what="İş akışı" />
      {definition !== null && definition.id === draft.workflowId ? (
        <>
          {definition.description ? (
            <p className="m-0 text-[0.875rem] text-dy-muted">{definition.description}</p>
          ) : null}
          <WorkflowSteps def={definition} />
          {definition.inputs.length > 0 ? (
            <div className="grid gap-3">
              <h3 className="m-0 text-[0.875rem] font-bold">Girdiler</h3>
              {definition.inputs.map((i) => (
                <DyArea
                  key={i.name}
                  label={`${i.name}${i.required ? ' (gerekli)' : ''}`}
                  rows={3}
                  className="min-h-20"
                  value={draft.inputs[i.name] ?? ''}
                  hint={i.description ?? undefined}
                  error={errors[`input.${i.name}`] ?? null}
                  onChange={(v) => {
                    set({ inputs: { ...draft.inputs, [i.name]: v } });
                  }}
                />
              ))}
            </div>
          ) : null}
          {props.workspace ? (
            <InputsFields draft={draft} set={set} errors={errors} forWorkflow />
          ) : (
            <div className="grid gap-3.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              {/* p16-workflow-quality: optional — the workflow's default, then the project's repository, else none. */}
              <DyText
                label={tr.repoUrl}
                value={draft.repoUrl}
                inputMode="url"
                spellCheck={false}
                mono
                data-testid="dy-run-repo"
                placeholder={definition.defaults.repository?.url ?? props.projectRepoUrl ?? 'https://…'}
                hint={
                  definition.defaults.repository
                    ? fill(tr.fromWorkflow, { url: definition.defaults.repository.url })
                    : props.projectRepoUrl != null
                      ? fill(tr.fromProject, { url: props.projectRepoUrl })
                      : tr.none
                }
                error={errors.repoUrl ?? null}
                onChange={(v) => {
                  set({ repoUrl: v });
                }}
              />
              <DyText
                label={tr.baseRef}
                value={draft.baseRef}
                spellCheck={false}
                mono
                placeholder={definition.defaults.repository?.baseRef ?? 'main'}
                error={errors.baseRef ?? null}
                onChange={(v) => {
                  set({ baseRef: v });
                }}
              />
            </div>
          )}
          {/* p19-repo-inputs-composer-workflows: run files of a repository project's run (every AI step). */}
          {props.workspace ? null : (
            <InputsFields
              draft={draft}
              set={set}
              errors={errors}
              forWorkflow
              repository
              blocked={definition.runFiles?.available === false}
            />
          )}
        </>
      ) : null}
    </div>
  );
}
