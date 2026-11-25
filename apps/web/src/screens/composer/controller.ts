import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  createJob,
  createSchedule,
  getProjectGit,
  getWorkflowDefinition,
  type InputFilesAvailability,
  listWorkflowDefinitions,
  type PlacementPreview,
  startWorkflowRun,
  type WorkflowDefinitionSummary,
  type WorkflowDefinitionView,
} from '../../api/composer';
import type { ApiError } from '../../api/client';
import { listProjects, type Project } from '../../api/directory';
import { getJob } from '../../api/jobs';
import { getJobInputUpload } from '../../api/inputUploads';
import { uploadComposerZip } from './zip-input';
import { checkReuse, type IdenticalResult } from '../../api/reuse';
import { type BudgetView, listBudgets } from '../../api/usage';
import { toApiError } from '../../components/ui';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';
import { useSubmit } from '../useSubmit';
import {
  bestHostProfile,
  buildSpec,
  type Draft,
  emptyDraft,
  type Errors,
  FULL_ACCESS,
  isFullAccess,
  previewDraft,
  RUNTIMES,
  sameRepository,
  scheduleWhen,
  validateJob,
  validateSchedule,
  validateWorkflow,
  workspaceFiles,
  withLimitDefaults,
} from './draft';
import { UUID } from './inputs';
import { usePlacementPreview } from './placement';
import { type ComposerPrefill, draftFromPrefill, isPrefillState, templateOfPrefill } from './prefill';
import {
  type DeployChoice,
  deployError,
  deployRequest,
  NO_DEPLOY,
  type VerifyChoice,
  verifyChoiceOf,
} from './deploy';
import { NO_PREVIEW, type PreviewChoice, previewError as previewChoiceError, withPreviews } from './previews';

/**
 * The composer's controller (docs/design/p5-composer.md, p6-ui-composer), shared by the classic `ComposerPage` and
 * the Diyalog composer screen (p12-diyalog-w1): the draft, its prefill sources (`?project=`, `?continueFrom=`,
 * `?from=`, router state from a chat draft or a template), the project defaults (repository, trust, sandbox, limits,
 * runtime), validation and blockers per section, the placement preview, the identical-result check and the
 * submission by mode (job / workflow run / schedule, with step-up where the classic flow asks for it). Only the
 * words a person reads differ between the two UIs, so they come in through `texts`; the rules stay here once.
 */

const RANK: Record<string, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export type SectionId = 'what' | 'where' | 'rules';

const WHERE_FIELDS: ReadonlySet<string> = new Set([
  'runtime',
  'runtimeVersion',
  'model',
  'sandboxProfile',
  'os',
  'arch',
  'tools',
  'workers',
]);
const RULES_FIELDS: ReadonlySet<string> = new Set([
  'maxDurationMin',
  'maxCostUsd',
  'maxTokens',
  'maxTurns',
  'approvalPolicy',
  'priority',
  'when',
  'scheduleName',
  'at',
  'cron',
]);

export function sectionOf(key: string): SectionId {
  if (WHERE_FIELDS.has(key)) return 'where';
  if (RULES_FIELDS.has(key)) return 'rules';
  return 'what';
}

/** Fields that start empty: their "required" errors wait for the first submit instead of greeting the user. */
const WAIT_FOR_SUBMIT: ReadonlySet<string> = new Set([
  'project',
  'prompt',
  'runtime',
  'workflowId',
  'scheduleName',
  'at',
  'inputFiles',
]);

/** Where the draft was filled in from (each UI says it in its own words). */
export type PrefillSource =
  | { readonly kind: 'template'; readonly title: string; readonly version: number }
  | { readonly kind: 'assistant' }
  | { readonly kind: 'job'; readonly id: string };

/** What the project's git configuration said about the repository fields. */
export type GitHint = 'project' | 'none' | null;

/** The step-up reasons (shown in the authenticator dialog), in the UI's language. */
export interface ComposerTexts {
  readonly deployStepUp: string;
  readonly scheduleJobStepUp: string;
  readonly scheduleWorkflowStepUp: string;
}

function useProjects(): { projects: Project[] | null; error: ApiError | null } {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    listProjects().then(
      (p) => {
        setProjects(p.filter((x) => (RANK[x.myRole] ?? 0) >= 1));
      },
      (err: unknown) => {
        setError(toApiError(err));
        setProjects([]);
      },
    );
  }, []);
  return { projects, error };
}

/**
 * The runtime a blank draft starts with: the first one a machine can start now, else the first one that would
 * wait for a machine. Only from a preview computed for the draft's own project and sandbox.
 */
function autoRuntime(draft: Draft, preview: PlacementPreview | null): string | null {
  if (
    preview === null ||
    preview.project !== draft.project ||
    preview.sandboxProfile !== draft.sandboxProfile
  )
    return null;
  // p6-smart-routing: the runtime the kind's routing rule picks comes first.
  if (preview.routing.runtime !== null) return preview.routing.runtime;
  const by = new Map(preview.runtimes.map((r) => [r.runtime, r.verdict]));
  return (
    RUNTIMES.find((r) => by.get(r) === 'placed') ?? RUNTIMES.find((r) => by.get(r) === 'waiting') ?? null
  );
}

export function useComposerController(texts: ComposerTexts) {
  const navigate = useNavigate();
  const stepUp = useStepUp();
  const submit = useSubmit();
  const [params] = useSearchParams();
  const location = useLocation();
  // p5-chat-ux "Edit in composer": a chat draft's spec arrives in the router state (never in the URL).
  const statePrefill = useRef<Partial<Draft> | null>(
    isPrefillState(location.state) ? draftFromPrefill(location.state.prefill) : null,
  );
  // `?project=…&continueFrom=…`: the "General" quick action and "Continue in a new job" (p5-research-workspace).
  const [draft, setDraft] = useState<Draft>(() => {
    const d = emptyDraft();
    const project = params.get('project') ?? '';
    const continueFrom = params.get('continueFrom') ?? '';
    // p13-workflows-ui: "Çalıştır" on a workflow — `?mode=workflow&workflow=<definition id>&project=…`.
    const workflow = params.get('workflow') ?? '';
    return {
      ...d,
      ...(params.get('mode') === 'workflow' && UUID.test(workflow)
        ? { mode: 'workflow' as const, workflowId: workflow }
        : {}),
      project: /^[A-Za-z0-9_.:-]{1,128}$/.test(project) ? project : '',
      continueFrom: UUID.test(continueFrom) ? continueFrom : '',
      ...(statePrefill.current ?? {}),
    };
  });
  // p8-templates: "Run" on a template hands over its rendered prompt and settings; the job is attributed to it.
  const fromTemplate = useRef(
    isPrefillState(location.state) ? templateOfPrefill(location.state.prefill) : null,
  );
  const [prefillSource, setPrefillSource] = useState<PrefillSource | null>(
    statePrefill.current === null
      ? null
      : fromTemplate.current !== null
        ? { kind: 'template', title: fromTemplate.current.title, version: fromTemplate.current.version }
        : { kind: 'assistant' },
  );
  const [prefillError, setPrefillError] = useState<ApiError | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  // p6-result-reuse: an identical job finished recently — offered before submitting, never reused silently.
  const [identical, setIdentical] = useState<IdenticalResult | null>(null);
  const [submitTry, setSubmitTry] = useState(0);
  // p6-deploy-on-success: "Deploy when done" (off by default; jobs started now).
  const [deploy, setDeploy] = useState<DeployChoice>(() => {
    const d = isPrefillState(location.state) ? location.state.prefill.deployOnSuccess : undefined;
    // Router state is untrusted data: check the value, not only its type.
    const target: string | undefined = d?.target;
    if (d === undefined || (target !== 'pages' && target !== 'coolify')) return NO_DEPLOY;
    return {
      enabled: true,
      target: d.target,
      env: d.env === 'production' ? 'production' : 'preview',
      directory: typeof d.directory === 'string' && d.directory !== '' ? d.directory : NO_DEPLOY.directory,
    };
  });
  // p10-verify-health: "Verify when done" ('' = the project's default; a template's setting starts it).
  const [verify, setVerify] = useState<VerifyChoice>(() =>
    verifyChoiceOf(isPrefillState(location.state) ? location.state.prefill.verify : undefined),
  );
  // p8-preview-tunnels: open a preview when the job's dev server listens.
  const [previewChoice, setPreviewChoice] = useState<PreviewChoice>(NO_PREVIEW);
  const [opened, setOpened] = useState<{ where: boolean; rules: boolean }>({ where: false, rules: false });
  const { projects, error: projectsError } = useProjects();
  const [gitHint, setGitHint] = useState<GitHint>(null);
  const [budgets, setBudgets] = useState<readonly BudgetView[]>([]);
  const [definitions, setDefinitions] = useState<WorkflowDefinitionSummary[] | null>(null);
  const [definition, setDefinition] = useState<WorkflowDefinitionView | null>(null);
  const [definitionError, setDefinitionError] = useState<ApiError | null>(null);
  const autoRepo = useRef<{ url: string; base: string } | null>(null);
  // p5-live-fixes-2: the project's registered repository (null: none / not loaded) — its jobs default to trusted.
  const [projectRepo, setProjectRepo] = useState<{ project: string; url: string } | null>(null);
  // A prefilled job keeps its own limits (project defaults only fill a blank composer).
  const limitsApplied = useRef<string | null>(statePrefill.current?.project ?? null);
  const formRef = useRef<HTMLFormElement>(null);

  // p5-full-access: explicit user choices of trust and sandbox are never overridden by project defaults.
  const touched = useRef<{ project: string; trust: boolean; sandbox: boolean }>({
    project: statePrefill.current?.project ?? '',
    trust: statePrefill.current?.sourceTrust !== undefined,
    sandbox: statePrefill.current?.sandboxProfile !== undefined,
  });
  const beforeFullAccess = useRef<Pick<Draft, 'sandboxProfile' | 'approvalPolicy' | 'sourceTrust'> | null>(
    null,
  );
  const set = useCallback((p: Partial<Draft>) => {
    if (p.sourceTrust !== undefined) touched.current.trust = true;
    if (p.sandboxProfile !== undefined) touched.current.sandbox = true;
    setDraft((d) => ({ ...d, ...p }));
  }, []);
  const onFullAccess = (on: boolean): void => {
    if (on) {
      beforeFullAccess.current = {
        sandboxProfile: draft.sandboxProfile,
        approvalPolicy: draft.approvalPolicy,
        sourceTrust: draft.sourceTrust,
      };
      set({ ...FULL_ACCESS });
      return;
    }
    const prev = beforeFullAccess.current;
    beforeFullAccess.current = null;
    set(
      prev !== null && !isFullAccess(prev)
        ? prev
        : { sandboxProfile: 'container', approvalPolicy: 'ask-sensitive' },
    );
  };

  // p5-first-live-fixes "Run again": `?from=<jobId>` prefills from a finished job's stored spec.
  const fromJob = params.get('from') ?? '';
  useEffect(() => {
    if (statePrefill.current !== null || !UUID.test(fromJob)) return;
    let live = true;
    getJob(fromJob).then(
      (d) => {
        if (!live) return;
        const p: ComposerPrefill = { project: d.job.project, spec: d.job.spec };
        const fields = draftFromPrefill(p);
        touched.current = {
          project: fields.project ?? '',
          trust: fields.sourceTrust !== undefined,
          sandbox: fields.sandboxProfile !== undefined,
        };
        limitsApplied.current = fields.project ?? null;
        if (fields.repoUrl !== undefined) autoRepo.current = null;
        setDraft((cur) => ({ ...cur, ...fields }));
        setPrefillSource({ kind: 'job', id: fromJob });
        // p16-zip-job-input: "Run again" reuses the earlier job's input bundle while it is kept.
        getJobInputUpload(fromJob).then(
          (b) => {
            if (!live || b?.kept !== true) return;
            setDraft((cur) => ({
              ...cur,
              inputBundleReuse: {
                id: b.sourceId,
                label: b.label,
                fileCount: b.fileCount,
                totalBytes: b.totalBytes,
              },
            }));
          },
          () => undefined,
        );
      },
      (err: unknown) => {
        if (live) setPrefillError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [fromJob]);

  const projectKind = projects?.find((p) => p.id === draft.project)?.kind;
  const workspace = projectKind === 'workspace';

  // A preselected project (query string) the caller cannot compose for is dropped (p8-orchestration: workspace
  // projects run workflows too).
  useEffect(() => {
    if (projects === null) return;
    setDraft((d) => {
      if (d.project === '') return d;
      return projects.some((x) => x.id === d.project) ? d : { ...d, project: '', continueFrom: '' };
    });
  }, [projects]);

  // Project defaults: repository and base branch from the project's git configuration.
  useEffect(() => {
    // Workspaces have no repository (their git route answers 409); wait for the kind before asking.
    if (draft.project === '' || projectKind !== 'repository') return;
    let live = true;
    getProjectGit(draft.project).then(
      (g) => {
        if (!live) return;
        setProjectRepo(g === null ? null : { project: draft.project, url: g.repositoryUrl });
        setGitHint(g === null ? 'none' : 'project');
        setDraft((d) => {
          const auto = autoRepo.current;
          const untouched =
            (d.repoUrl === '' && d.baseRef === '') ||
            (auto !== null && d.repoUrl === auto.url && d.baseRef === auto.base);
          if (!untouched) return d;
          // Workflow mode: empty = the definition's default repository, so nothing is prefilled there.
          if (g === null || d.mode === 'workflow') {
            autoRepo.current = null;
            return { ...d, repoUrl: '', baseRef: '' };
          }
          autoRepo.current = { url: g.repositoryUrl, base: g.baseBranch };
          return { ...d, repoUrl: g.repositoryUrl, baseRef: g.baseBranch };
        });
      },
      () => {
        if (!live) return;
        setGitHint(null);
        setProjectRepo(null);
      },
    );
    return () => {
      live = false;
    };
  }, [draft.project, draft.mode, projectKind]);

  useEffect(() => {
    listBudgets().then(setBudgets, () => {
      setBudgets([]);
    });
  }, []);

  useEffect(() => {
    if (draft.mode !== 'workflow' || definitions !== null) return;
    listWorkflowDefinitions().then(setDefinitions, (err: unknown) => {
      setDefinitionError(toApiError(err));
      setDefinitions([]);
    });
  }, [draft.mode, definitions]);

  // p18-multi-project: the draft's project when it runs the chosen workflow through an attachment (else null).
  const sharedIn =
    definitions?.some(
      (d) => d.id === draft.workflowId && d.project === draft.project && d.shared === true,
    ) === true
      ? draft.project
      : null;
  useEffect(() => {
    if (draft.workflowId === '') {
      setDefinition(null);
      return;
    }
    let live = true;
    // p18-multi-project: a workflow the draft's project attached is read through that project.
    getWorkflowDefinition(draft.workflowId, sharedIn === null ? {} : { project: sharedIn }).then(
      (d) => {
        if (live) {
          setDefinition(d);
          setDefinitionError(null);
        }
      },
      (err: unknown) => {
        if (live) setDefinitionError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [draft.workflowId, sharedIn]);

  const pDraft = useMemo(() => (draft.mode === 'job' ? previewDraft(draft) : null), [draft]);
  const { preview, loading, error: previewError } = usePlacementPreview(pDraft);

  // Workspace jobs (p5-full-access): the prompt is the user's own and a chat-less composer job carries only the
  // user's files, so the source defaults to trusted, and the sandbox to the best host profile ready on some machine
  // when the project opted in to host execution. Explicit choices are kept; unconfined is never a default.
  // p5-live-fixes-2: repository jobs get the same defaults when the repository is the project's registered one
  // (Projects → Repository); another repository defaults to untrusted in the container.
  const registeredRepo =
    projectKind === 'repository' && projectRepo !== null && projectRepo.project === draft.project
      ? sameRepository(draft.repoUrl, projectRepo.url)
      : null;
  const defaultsFor = useCallback(
    (d: Draft): Pick<Draft, 'sourceTrust' | 'sandboxProfile'> | null => {
      if (d.mode !== 'job' || preview === null || preview.project !== d.project) return null;
      if (!workspace && registeredRepo === null) return null;
      const t = touched.current.project === d.project ? touched.current : { trust: false, sandbox: false };
      const own = workspace || registeredRepo === true;
      const trust = t.trust ? d.sourceTrust : own ? 'trusted' : 'untrusted';
      // An untrusted source runs only in the container; the user's own untrusted choice already set it.
      const sandbox =
        trust !== 'trusted'
          ? t.trust
            ? d.sandboxProfile
            : 'container'
          : t.sandbox
            ? d.sandboxProfile
            : bestHostProfile(preview);
      return { sourceTrust: trust, sandboxProfile: sandbox };
    },
    [preview, workspace, registeredRepo],
  );
  useEffect(() => {
    if (touched.current.project !== draft.project) {
      touched.current = { project: draft.project, trust: false, sandbox: false };
    }
    setDraft((d) => {
      const want = defaultsFor(d);
      return want === null || (want.sourceTrust === d.sourceTrust && want.sandboxProfile === d.sandboxProfile)
        ? d
        : { ...d, ...want };
    });
  }, [defaultsFor, draft.project]);
  // The project's defaults are still being applied (the next preview is for another sandbox).
  const defaults = defaultsFor(draft);
  const settling =
    defaults !== null &&
    (defaults.sourceTrust !== draft.sourceTrust || defaults.sandboxProfile !== draft.sandboxProfile);

  // Run-limit defaults: once per project, when the preview for it arrives.
  useEffect(() => {
    if (preview === null || preview.project !== draft.project || limitsApplied.current === draft.project)
      return;
    limitsApplied.current = draft.project;
    setDraft((d) => withLimitDefaults(d, preview.limits));
  }, [preview, draft.project]);

  // p6-ui-composer: a blank draft gets the first runtime a machine can run (with the sandbox it will use).
  const suggested =
    draft.mode === 'job' && draft.runtime === '' && !settling ? autoRuntime(draft, preview) : null;
  useEffect(() => {
    if (suggested === null) return;
    setDraft((d) => (d.runtime === '' ? { ...d, runtime: suggested } : d));
  }, [suggested]);

  // p19-repo-inputs-composer-workflows: a repository project's input files (job) / run files (workflow run) — while a
  // machine can take them (repo-inputs-v1); the master says so with the preview / the definition. Unknown (an older
  // master, still loading): offered, and the submission is refused with the same reason if needed.
  const repoProject = projectKind === 'repository';
  const repoFiles: InputFilesAvailability | null = !repoProject
    ? null
    : draft.mode === 'job'
      ? preview !== null && preview.project === draft.project
        ? (preview.inputFiles ?? null)
        : null
      : definition !== null && definition.id === draft.workflowId
        ? (definition.runFiles ?? null)
        : null;
  const repoFilesBlocked = repoFiles?.available === false;

  const errors: Errors = useMemo(() => {
    const base =
      draft.mode === 'job'
        ? validateJob(draft, workspace, repoFilesBlocked)
        : validateWorkflow(
            draft,
            definition?.inputs ?? [],
            definition?.defaults.repository != null,
            workspace,
            repoFilesBlocked,
          );
    return { ...base, ...validateSchedule(draft) };
  }, [draft, definition, workspace, repoFilesBlocked]);

  // Before the first submit, "this is still empty" errors wait; real problems show at once.
  const shownErrors: Errors = useMemo(() => {
    if (showErrors) return errors;
    const out: Errors = {};
    for (const [k, v] of Object.entries(errors)) {
      if (v === undefined || WAIT_FOR_SUBMIT.has(k) || k.startsWith('input.')) continue;
      if ((k === 'repoUrl' || k === 'baseRef') && draft[k].trim() === '') continue;
      out[k as keyof Errors] = v;
    }
    return out;
  }, [errors, showErrors, draft]);

  // What blocks the job in Where, besides field errors: no runtime can run it, or the placement says no machine
  // can run it.
  const current =
    draft.mode === 'job' &&
    !settling &&
    preview !== null &&
    preview.project === draft.project &&
    preview.sandboxProfile === draft.sandboxProfile;
  const placement = current && preview.placement?.runtime === draft.runtime ? preview.placement : null;
  const whereBlocked =
    draft.mode === 'job' &&
    (Object.keys(shownErrors).some((k) => sectionOf(k) === 'where') ||
      (current && draft.runtime === '' && suggested === null) ||
      placement?.verdict === 'infeasible');
  const rulesBlocked = Object.keys(shownErrors).some((k) => sectionOf(k) === 'rules');
  const whereOpen = opened.where || whereBlocked;
  const rulesOpen = opened.rules || rulesBlocked;
  const toggle = useCallback((s: 'where' | 'rules') => {
    setOpened((o) => ({ ...o, [s]: !o[s] }));
  }, []);

  // After a refused submit, the first field to fix gets focus (its section is open by then).
  useEffect(() => {
    if (submitTry === 0) return;
    const form = formRef.current;
    if (form === null) return;
    const bad =
      form.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      form
        .querySelector<HTMLElement>('[data-testid="field-error"]')
        ?.closest('fieldset, div')
        ?.querySelector<HTMLElement>('input, select, textarea') ??
      null;
    if (bad === null) return;
    // jsdom has no scrollIntoView.
    if (typeof bad.scrollIntoView === 'function') bad.scrollIntoView({ block: 'center' });
    bad.focus({ preventScroll: true });
  }, [submitTry]);

  // Any change to the draft makes an earlier "identical job" offer stale.
  useEffect(() => {
    setIdentical(null);
  }, [draft]);

  async function onSubmit(opts: { readonly runAnyway?: boolean } = {}): Promise<void> {
    if (submit.busy) return;
    setShowErrors(true);
    if (
      Object.keys(errors).length > 0 ||
      (draft.mode === 'job' &&
        (deployError(deploy) !== null || Object.keys(previewChoiceError(previewChoice)).length > 0))
    ) {
      setSubmitTry((n) => n + 1);
      return;
    }
    const when = scheduleWhen(draft);
    // p6-result-reuse: before a job is submitted now, ask whether an identical one succeeded recently. Advisory: a
    // failed check never blocks the submission.
    if (draft.mode === 'job' && when === null && opts.runAnyway !== true) {
      const files = workspace || repoProject ? workspaceFiles(draft) : {};
      const found = await checkReuse({
        project: draft.project,
        spec: buildSpec(draft, workspace),
        ...(files.files === undefined ? {} : { files: files.files }),
        ...(files.continueFrom === undefined ? {} : { continueFrom: files.continueFrom }),
      }).then(
        (r) => r.match,
        () => null,
      );
      if (found !== null) {
        setIdentical(found);
        return;
      }
    }
    setIdentical(null);
    // p5-research-workspace-next: files and continue-from go with workspace jobs, runs and schedules alike;
    // p19-repo-inputs-composer-workflows: with repository jobs and runs started now (validation keeps them off
    // schedules, which take files for workspace projects only).
    const files = workspace || repoProject ? workspaceFiles(draft) : {};
    const scheduled = {
      ...(files.files === undefined ? {} : { files: files.files }),
      ...(files.continueFrom === undefined
        ? {}
        : { continueFrom: { kind: 'job' as const, jobId: files.continueFrom } }),
    };
    await submit.run(async () => {
      try {
        if (draft.mode === 'job') {
          const spec = withPreviews(buildSpec(draft, workspace), previewChoice);
          const priority = Number(draft.priority);
          if (when === null) {
            const deployOnSuccess = deployRequest(deploy);
            // p16-zip-job-input: the .zip's files are uploaded to the chosen project first (progress on the field).
            let inputUpload: string | null = draft.inputBundleReuse?.id ?? null;
            if (draft.inputZip !== null) {
              const zip = draft.inputZip;
              inputUpload = await uploadComposerZip(draft.project, zip, (p) => {
                setDraft((cur) =>
                  cur.inputZip === null ? cur : { ...cur, inputZip: { ...cur.inputZip, ...p } },
                );
              });
              if (inputUpload === null) return;
            }
            const extras = {
              ...(inputUpload === null ? {} : { inputUpload }),
              ...(workspace
                ? {
                    inputs: files.files ?? [],
                    ...(files.continueFrom === undefined ? {} : { continueFrom: files.continueFrom }),
                    // p15-workspace-retention: "Run again" starts from the earlier job's kept working directory.
                    ...(prefillSource?.kind === 'job' ? { keptFilesFrom: prefillSource.id } : {}),
                  }
                : repoProject
                  ? {
                      // p19-repo-inputs-composer-workflows: read from a scratch in/ next to the checkout.
                      inputs: files.files ?? [],
                      ...(files.continueFrom === undefined ? {} : { continueFrom: files.continueFrom }),
                    }
                  : {}),
              ...(deployOnSuccess === undefined ? {} : { deployOnSuccess }),
              ...(verify === '' ? {} : { verifyOnSuccess: { mode: verify } }),
              ...(fromTemplate.current === null
                ? {}
                : { template: { id: fromTemplate.current.id, version: fromTemplate.current.version } }),
            };
            // p6-deploy-on-success: a deploy whose policy needs a step-up (production) asks for a code here.
            const job =
              deployOnSuccess === undefined
                ? await createJob(draft.project, spec, priority, extras)
                : await stepUp.run(
                    () => createJob(draft.project, spec, priority, extras),
                    texts.deployStepUp,
                  );
            void navigate(`/jobs/${job.id}`);
            return;
          }
          const s = await stepUp.run(
            () =>
              createSchedule({
                project: draft.project,
                name: draft.scheduleName.trim(),
                target: { kind: 'job', spec, priority, ...scheduled },
                when,
              }),
            texts.scheduleJobStepUp,
          );
          void navigate(`/automations/${s.automationId}`, { state: { created: 'schedule' } });
          return;
        }
        const repository =
          workspace || draft.repoUrl.trim() === ''
            ? undefined
            : { url: draft.repoUrl.trim(), baseRef: draft.baseRef.trim() };
        const inputs = Object.fromEntries(Object.entries(draft.inputs).filter(([, v]) => v.trim() !== ''));
        if (when === null) {
          const runId = await startWorkflowRun(draft.workflowId, {
            // p18-multi-project: a workflow the draft's project attached runs in that project.
            ...(sharedIn === null ? {} : { project: sharedIn }),
            inputs,
            ...(repository === undefined ? {} : { repository }),
            ...files,
            // p9-queue-priority: every step job runs in the run's class.
            ...(Number(draft.priority) === 0 ? {} : { priority: Number(draft.priority) }),
          });
          void navigate(`/jobs/workflows/${runId}`);
          return;
        }
        const s = await stepUp.run(
          () =>
            createSchedule({
              project: draft.project,
              name: draft.scheduleName.trim(),
              target: {
                kind: 'workflow',
                workflowId: draft.workflowId,
                inputs,
                ...(repository === undefined ? {} : { repository }),
                ...scheduled,
              },
              when,
            }),
          texts.scheduleWorkflowStepUp,
        );
        void navigate(`/automations/${s.automationId}`, { state: { created: 'schedule' } });
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  }

  /** Ctrl/Cmd+Enter submits (Enter in a field never does). */
  const onKeyDown = (e: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    preventDefault: () => void;
  }): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void onSubmit();
    }
  };

  return {
    draft,
    set,
    onFullAccess,
    prefillSource,
    prefillError,
    showErrors,
    identical,
    deploy,
    setDeploy,
    verify,
    setVerify,
    previewChoice,
    setPreviewChoice,
    projects,
    projectsError,
    gitHint,
    /** p16-workflow-quality: the selected project's registered repository (the run form's fallback), or null. */
    projectRepoUrl: projectRepo !== null && projectRepo.project === draft.project ? projectRepo.url : null,
    budgets,
    definitions,
    definition,
    definitionError,
    formRef,
    workspace,
    /** p19-repo-inputs-composer-workflows: input / run files of a repository project (null: not one, or unknown). */
    repoFiles,
    preview,
    loading,
    previewError,
    errors,
    shownErrors,
    placement,
    whereBlocked,
    rulesBlocked,
    whereOpen,
    rulesOpen,
    toggle,
    onSubmit,
    onKeyDown,
    submit,
  };
}
