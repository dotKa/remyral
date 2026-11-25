import {
  type ChangeEvent,
  type ReactNode,
  type SubmitEvent,
  useCallback,
  useEffect,
  useId,
  useState,
} from 'react';
import type { ApiError } from '../../../api/client';
import { listProjects, type Project } from '../../../api/directory';
import {
  ALL_PROJECTS,
  assignSkill,
  listSkills,
  type PanelKey,
  type Skill,
  type LayoutLimits,
  type SkillFile,
  type SkillLayout,
  skillFiles,
  type SkillVersion,
  unassignSkill,
  uploadSkill,
} from '../../../api/skills';
import { useAuth } from '../../../auth/AuthProvider';
import { DyPager } from '../../common/pager';
import { toApiError } from '../../../components/ui';
import { useClientPage } from '../../../lib/pager';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyIcon } from '../../icons';
import { RuntimeMark } from '../../RuntimeMark';
import { ConfirmButton, CopyLine, DyApiError, DyCheck, DyDetails, DyNotice } from '../forms';
import { agoText, DyButton, DySelect, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { ScreenFrame, SegTabs } from '../ScreenFrame';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { McpServersPanel } from './McpServers';
import { SkillCatalogPanel } from './SkillCatalog';
import { McpDiscoverPanel } from './McpDiscover';
import { ProvenancePill, SkillImportPanel } from './SkillImport';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p12-diyalog wave 2 (W3) — Yetenekler (`/skills`) in the Diyalog language. Same requests and rules as the classic
 * page (docs/design/p6-skills.md §7): signed, versioned skills; upload of a bundle signed offline (the console never
 * signs or edits skill content — the master verifies it against SKILLS_PUBLIC_KEYS); assignment to a project or all
 * projects with a runtime set and an optional version pin; the files of a version. Every change is admin-only and
 * goes through step-up. Skill text, file names and contents are untrusted and render as text.
 */

/** ADR-0023: the four runtimes the platform runs (OpenHands was removed). */
const RUNTIMES = ['claude-code', 'codex', 'opencode', 'pi'] as const;
/** The upload body limit is 1 MiB; a valid bundle is far smaller (≤ 128 KiB of files). */
const MAX_BUNDLE_BYTES = 1024 * 1024;

const SIGN_COMMAND =
  'node scripts/skills/sign.mjs pack --dir <skill> --version 1.0.0 --runtimes codex,claude-code --key skills-key.pem --out skill.json'; // i18n-ignore: a shell command

function projectName(p: string, all: string): string {
  return p === ALL_PROJECTS ? all : p;
}

function Upload(props: { readonly onDone: (message: string) => void }): ReactNode {
  const t = useT().skills.upload;
  const stepUp = useStepUp();
  const inputId = useId();
  const [bundle, setBundle] = useState<unknown>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    setBundle(null);
    setFileError(null);
    const file = e.target.files?.[0];
    if (file === undefined) return;
    setFileName(file.name);
    if (file.size > MAX_BUNDLE_BYTES) {
      setFileError(t.tooLarge);
      return;
    }
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('manifest' in parsed) ||
        !('signature' in parsed)
      ) {
        setFileError(t.notBundle);
        return;
      }
      setBundle(parsed);
    } catch {
      setFileError(t.notJson);
    }
  }

  async function onSubmit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (bundle === null) return;
    setBusy(true);
    setError(null);
    try {
      const v = await stepUp.run(() => uploadSkill(bundle), t.stepUp);
      props.onDone(t.done({ title: v.title, version: v.version, keyId: v.keyId }));
      setBundle(null);
      setFileName(null);
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={t.title} sub={t.sub({ file: 'skill.json' })} testId="skills-upload">
      <div className="flex flex-col gap-3">
        <CopyLine text={SIGN_COMMAND} about={t.copyCommand} />
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={inputId} className="text-[0.8125rem] font-bold">
              {t.fileLabel}
            </label>
            <input
              id={inputId}
              type="file"
              accept="application/json,.json"
              aria-describedby={fileError === null ? undefined : `${inputId}-error`}
              onChange={(e) => void onFile(e)}
              className="min-h-11 max-w-full text-[0.875rem] text-dy-muted file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-[9px] file:border file:border-dy-line-2 file:bg-dy-card file:px-3 file:font-medium file:text-dy-ink"
            />
            {fileName !== null && bundle !== null ? (
              <p className="m-0 text-[0.78125rem] text-dy-muted">{t.ready({ name: fileName })}</p>
            ) : null}
            {fileError === null ? null : (
              <p id={`${inputId}-error`} className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">
                {fileError}
              </p>
            )}
          </div>
          <DyApiError error={error} />
          <div>
            <DyButton type="submit" variant="primary" icon="tray" busy={busy} disabled={bundle === null}>
              {t.button}
            </DyButton>
          </div>
        </form>
      </div>
    </Panel>
  );
}

function SignerPill(props: { readonly v: SkillVersion }): ReactNode {
  const s = props.v.signer;
  const t = useT().skills.signer;
  return (
    <span data-testid="skill-signer">
      <Pill
        tone={s === 'panel' ? 'amber' : 'neutral'}
        icon={s === 'panel' ? 'bubble' : 'key'}
        title={s === 'panel' ? t.panelTitle : s === 'offline' ? t.offlineTitle : t.unknownTitle}
      >
        {s === 'panel' ? t.panel : s === 'offline' ? t.offline : t.unknown}
      </Pill>
    </span>
  );
}

/** p14-skill-catalogs: a layout-2 version only reaches machines with the wider skill layout. */
function LayoutPill(props: { readonly layout: SkillLayout }): ReactNode {
  const t = useT().skills.layout;
  if (props.layout !== 2) return null;
  return (
    <span data-testid="skill-layout-v2">
      <Pill tone="violet" title={t.pillTitle}>
        {t.pill}
      </Pill>
    </span>
  );
}

/** p14-skill-catalogs: the two layouts, their limits and how many machines take layout 2. */
function LayoutLimitsPanel(props: {
  readonly layouts: { v1: LayoutLimits; v2: LayoutLimits };
  readonly workers: { supported: number; total: number } | null;
}): ReactNode {
  const t = useT().skills.layout;
  const fmt = useFormat();
  const v1 = props.layouts.v1;
  const v2 = props.layouts.v2;
  return (
    <Panel title={t.title} testId="skills-layout-limits">
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[0.8125rem]">
        <li className="flex flex-col gap-0.5">
          <span className="font-bold">{t.v1}</span>
          <span className="text-dy-muted">{t.v1Hint}</span>
          <span className="text-dy-muted">
            {t.v1Limits({ files: v1.maxFiles, total: fmt.bytes(v1.maxTotalBytes) })}
          </span>
        </li>
        <li className="flex flex-col gap-0.5">
          <span className="font-bold">{t.v2}</span>
          <span className="text-dy-muted">{t.v2Hint}</span>
          <span className="text-dy-muted">
            {t.limits({
              files: v2.maxFiles,
              file: fmt.bytes(v2.maxFileBytes),
              total: fmt.bytes(v2.maxTotalBytes),
              job: fmt.bytes(v2.maxJobBytes),
            })}
          </span>
          {props.workers === null ? null : (
            <span data-testid="skills-layout-workers">
              {t.workers({ supported: props.workers.supported, total: props.workers.total })}
            </span>
          )}
        </li>
      </ul>
    </Panel>
  );
}

function Files(props: {
  readonly skill: string;
  readonly version: string;
  readonly files: readonly SkillFile[];
}): ReactNode {
  const t = useT().skills.files;
  return (
    <div data-testid="skill-files" className="flex flex-col gap-2 border-t border-dy-line px-4 py-3">
      <h3 className="m-0 text-[0.875rem] font-bold">
        <span className="font-dy-mono">{props.skill}</span> {t.title({ version: props.version })}
      </h3>
      {props.files.map((f) => (
        <DyDetails
          key={f.path}
          summary={
            <span className="font-dy-mono text-[0.8125rem] [overflow-wrap:anywhere]">
              {f.path}
              {f.executable ? (
                <span className="ml-2 font-dy-sans text-[0.78125rem] font-normal text-dy-amber-ink">
                  {t.script}
                </span>
              ) : null}
            </span>
          }
        >
          <pre className="m-0 max-h-72 overflow-auto font-dy-mono text-[0.78125rem] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
            {f.content}
          </pre>
        </DyDetails>
      ))}
    </div>
  );
}

function AssignForm(props: {
  readonly skill: Skill;
  readonly projects: readonly Project[];
  readonly onDone: (message: string) => void;
  readonly onError: (e: ApiError | null) => void;
}): ReactNode {
  const { skill } = props;
  const all = useT().skills.screen.allProjects;
  const t = useT().skills.assign;
  const stepUp = useStepUp();
  const [project, setProject] = useState(props.projects[0]?.id ?? '');
  const [version, setVersion] = useState('');
  const [runtimes, setRuntimes] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (project === '' && props.projects[0] !== undefined) setProject(props.projects[0].id);
  }, [project, props.projects]);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (project === '') return;
    setBusy(true);
    props.onError(null);
    try {
      await stepUp.run(
        () =>
          assignSkill({
            skillId: skill.id,
            project,
            runtimes: runtimes.length === 0 ? null : runtimes,
            version: version === '' ? null : version,
          }),
        t.stepUp,
      );
      props.onDone(t.done({ id: skill.id, project: projectName(project, all) }));
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) props.onError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label={t.form({ id: skill.id })}
      className="flex flex-col gap-3 border-t border-dy-line px-4 py-3.5"
    >
      <h3 className="m-0 text-[0.875rem] font-bold">{t.title}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <DySelect
          label={t.project({ id: skill.id })}
          value={project}
          options={[
            [ALL_PROJECTS, all] as const,
            ...props.projects.map((p) => [p.id, p.name === p.id ? p.id : `${p.name} (${p.id})`] as const),
          ]}
          onChange={setProject}
        />
        <DySelect
          label={t.version({ id: skill.id })}
          value={version}
          options={[
            ['', t.latestOption] as const,
            ...skill.versions.map((v) => [v.version, t.pinOption({ version: v.version })] as const),
          ]}
          onChange={setVersion}
        />
      </div>
      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-1 text-[0.8125rem] font-bold">
          {t.runtimes} <span className="font-normal text-dy-muted">{t.runtimesHint}</span>
        </legend>
        <div className="flex flex-wrap gap-x-5">
          {RUNTIMES.map((r) => (
            <DyCheck
              key={r}
              label={<RuntimeMark runtime={r} />}
              checked={runtimes.includes(r)}
              onChange={(on) => {
                setRuntimes(on ? [...runtimes, r] : runtimes.filter((x) => x !== r));
              }}
            />
          ))}
        </div>
      </fieldset>
      <div>
        <DyButton type="submit" icon="plus" busy={busy} disabled={project === ''}>
          {t.button}
        </DyButton>
      </div>
    </form>
  );
}

function SkillPanel(props: {
  readonly skill: Skill;
  readonly admin: boolean;
  readonly projects: readonly Project[];
  readonly onChanged: (message: string) => void;
}): ReactNode {
  const { skill } = props;
  const all = useT().skills.screen.allProjects;
  const t = useT().skills.skillCard;
  const tf = useT().skills.files;
  const w = useT().screenKit.time;
  const stepUp = useStepUp();
  const [error, setError] = useState<ApiError | null>(null);
  const [files, setFiles] = useState<{ version: string; files: SkillFile[] } | null>(null);

  async function remove(id: string, project: string): Promise<void> {
    setError(null);
    try {
      await stepUp.run(() => unassignSkill(id), t.removeStepUp);
      props.onChanged(t.removed({ id: skill.id, project: projectName(project, all) }));
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
    }
  }

  async function show(version: string): Promise<void> {
    setError(null);
    try {
      setFiles({ version, files: await skillFiles(skill.id, version) });
    } catch (err) {
      setError(toApiError(err));
    }
  }

  return (
    <Panel
      testId="skill-card"
      title={<span className="font-dy-mono">{skill.id}</span>}
      aside={
        <span className="flex flex-wrap items-center gap-1.5">
          {skill.latest === null ? null : <Pill tone="teal">{t.latest({ version: skill.latest })}</Pill>}
          {skill.deleted ? (
            <Pill tone="red" icon="trash">
              {t.deleted}
            </Pill>
          ) : null}
        </span>
      }
      flush
    >
      <Rows label={t.versions({ id: skill.id })}>
        {skill.versions.map((v) => (
          <Row
            key={v.version}
            testId="skill-version"
            lead={<DyIcon name="file" className="size-4" />}
            title={
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="font-dy-mono">{v.version}</span>
                <span className="font-normal">{v.title}</span>
                <SignerPill v={v} />
                <ProvenancePill provenance={v.provenance} />
                <LayoutPill layout={v.layout} />
              </span>
            }
            meta={
              <>
                <span className="flex flex-wrap gap-x-2">
                  {v.runtimes.map((r) => (
                    <RuntimeMark key={r} runtime={r} />
                  ))}
                </span>
                <span>
                  {t.filesKey({ n: v.fileCount })} <span className="font-dy-mono">{v.keyId}</span>
                </span>
                <span>{agoText(v.uploadedAt, Date.now(), w)}</span>
                <span className="w-full text-dy-muted">{v.description}</span>
                <span className="w-full font-dy-mono text-[0.75rem] [overflow-wrap:anywhere]">
                  {`sha256 ${v.manifestSha256}`}
                </span>
              </>
            }
            actions={
              <DyButton variant="ghost" icon="file" onClick={() => void show(v.version)}>
                {tf.button}
              </DyButton>
            }
          />
        ))}
      </Rows>
      {files === null ? null : <Files skill={skill.id} version={files.version} files={files.files} />}
      <div className="border-t border-dy-line">
        <h3 className="m-0 px-4 pt-3 text-[0.875rem] font-bold">{t.assignedTitle}</h3>
        {skill.assignments.length === 0 ? (
          <EmptyLine>{t.notAssigned}</EmptyLine>
        ) : (
          <Rows label={t.assignments({ id: skill.id })} testId="skill-assignments">
            {skill.assignments.map((a) => (
              <Row
                key={a.id}
                lead={<DyIcon name="folder" className="size-4" />}
                title={projectName(a.project, all)}
                meta={
                  <>
                    <span>
                      {a.runtimes === null
                        ? t.allRuntimes
                        : a.runtimes.map((r) => <RuntimeMark key={r} runtime={r} className="mr-2" />)}
                    </span>
                    <span>{a.version === null ? t.latestVersion : t.pinned({ version: a.version })}</span>
                  </>
                }
                actions={
                  props.admin ? (
                    <ConfirmButton
                      label={t.remove}
                      question={t.removeQuestion({ id: skill.id, project: projectName(a.project, all) })}
                      confirmLabel={t.removeConfirm}
                      testId={`skill-unassign-${a.id}`}
                      onConfirm={() => void remove(a.id, a.project)}
                    />
                  ) : undefined
                }
              />
            ))}
          </Rows>
        )}
      </div>
      {props.admin && !skill.deleted ? (
        <AssignForm skill={skill} projects={props.projects} onDone={props.onChanged} onError={setError} />
      ) : null}
      <DyApiError error={error} className="px-4 pb-3" />
    </Panel>
  );
}

export function SkillsScreen(): ReactNode {
  const { state } = useAuth();
  const admin = state.kind === 'signedIn' && (state.user.role === 'owner' || state.user.role === 'admin');
  const [data, setData] = useState<{
    configured: boolean;
    panelKey: PanelKey;
    skills: Skill[];
    offlineOnlyProjects: string[];
    githubImport: boolean;
    layouts: { v1: LayoutLimits; v2: LayoutLimits } | null;
    layoutV2Workers: { supported: number; total: number } | null;
  } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice);

  const load = useCallback(() => {
    listSkills().then(setData, (err: unknown) => {
      setError(toApiError(err));
    });
    listProjects().then(setProjects, () => {
      setProjects([]);
    });
  }, []);
  useEffect(load, [load]);
  const changed = (message: string): void => {
    setNotice(message);
    load();
  };

  const t = useT().skills;
  const mcpTab = useT().mcp.tab;
  const page = useClientPage(data?.skills ?? [], { label: t.screen.pages });
  return (
    <ScreenFrame title={t.screen.title} purpose={t.screen.purpose} testId="dy-skills">
      <div className="flex flex-col gap-4">
        <DyApiError error={error} />
        {data === null && error === null ? (
          <Panel title={t.screen.title} flush>
            <SkeletonRows label={t.screen.loading} rows={3} />
          </Panel>
        ) : null}
        {data !== null && !data.configured ? (
          <DyNotice tone="amber" title={t.screen.noKeyTitle}>
            {t.screen.noKey}
          </DyNotice>
        ) : null}
        {data !== null ? (
          <p
            className="m-0 flex items-start gap-2 text-[0.8125rem] text-dy-muted"
            data-testid="skills-panel-key"
          >
            <DyIcon name="key" className="mt-0.5 size-3.5 shrink-0" />
            {data.panelKey.configured
              ? t.screen.panelKey({ keyId: data.panelKey.keyId ?? t.screen.panelKeyUnknown })
              : t.screen.noPanelKey}
          </p>
        ) : null}
        <SegTabs
          label={t.catalog.tabsLabel}
          items={[
            { id: 'skills', label: t.catalog.tabSkills },
            { id: 'discover', label: t.catalog.tabDiscover },
            // p14-mcp-core (ADR-0054): remote MCP servers for jobs.
            { id: 'mcp', label: mcpTab },
          ]}
        >
          {(tab) =>
            tab === 'mcp' ? (
              <McpServersPanel admin={admin} projects={projects} />
            ) : tab === 'discover' ? (
              <div className="flex flex-col gap-4">
                <SkillCatalogPanel
                  admin={admin}
                  projects={projects}
                  offlineOnly={data?.offlineOnlyProjects ?? []}
                  onDone={changed}
                />
                {/* p14-mcp-chat (ADR-0054 P5): MCP Registry / npm / PyPI search and installs. */}
                <McpDiscoverPanel admin={admin} projects={projects} />
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {data?.layouts === null || data?.layouts === undefined ? null : (
                  <LayoutLimitsPanel layouts={data.layouts} workers={data.layoutV2Workers} />
                )}
                {admin && data !== null ? (
                  <SkillImportPanel
                    githubEnabled={data.githubImport}
                    panelKeyConfigured={data.panelKey.configured}
                    projects={projects}
                    offlineOnly={data.offlineOnlyProjects}
                    onDone={changed}
                  />
                ) : null}
                {admin && data !== null ? <Upload onDone={changed} /> : null}
                {data !== null && data.skills.length === 0 ? (
                  <Panel title={t.screen.emptyTitle} flush>
                    <EmptyLine testId="skills-empty">{t.screen.empty}</EmptyLine>
                  </Panel>
                ) : null}
                {page.pageItems.map((s) => (
                  <SkillPanel key={s.id} skill={s} admin={admin} projects={projects} onChanged={changed} />
                ))}
                {data !== null ? <DyPager {...page.pagination} /> : null}
              </div>
            )
          }
        </SegTabs>
      </div>
    </ScreenFrame>
  );
}
