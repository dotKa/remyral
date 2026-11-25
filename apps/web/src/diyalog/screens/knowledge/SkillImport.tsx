import { type ChangeEvent, type ReactNode, type SubmitEvent, useId, useState } from 'react';
import type { ApiError } from '../../../api/client';
import type { Project } from '../../../api/directory';
import {
  ALL_PROJECTS,
  discardSkillImport,
  type ImportFinding,
  type ImportSource,
  previewSkillImport,
  publishSkillImport,
  type SkillImport,
  type SkillProvenance,
} from '../../../api/skills';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { RuntimeMark } from '../../RuntimeMark';
import { DyApiError, DyCheck, DyDetails, DyField, DyNotice, DyTextarea } from '../forms';
import { DyButton, DySelect, Panel, Pill } from '../parts';

/**
 * p14-skill-import (ADR-0054, docs/design/p14-mcp-skills.md §3, §5.5): Yetenekler → "İçe aktar". A folder, a zip or a
 * GitHub folder link becomes a master-side preview (files, findings, suggested id / version, diff); publishing signs
 * it with the panel key after an always-fresh step-up. Everything shown from the import is untrusted text.
 */

const RUNTIMES = ['claude-code', 'codex', 'opencode', 'pi'] as const;
/** Raw bytes the browser sends (the body limit is 3 MiB of base64). */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const SKILL_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** p14-skill-catalogs (ADR-0054 decision 6): the per-job total of layout 2 (the preview carries the per-skill limits). */
const JOB_SKILL_BYTES_V2 = 640 * 1024;

type SourceKind = 'folder' | 'zip' | 'github';

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** The provenance badge of a version (null for offline uploads, which the signer pill already explains). */
export function ProvenancePill(props: { readonly provenance: SkillProvenance | null }): ReactNode {
  const t = useT().skills.provenance;
  const p = props.provenance;
  if (p === null) return null;
  const text =
    p.kind === 'github'
      ? t.github({ repo: p.repo ?? '', commit: (p.commit ?? '').slice(0, 7) })
      : p.kind === 'zip'
        ? t.zip({ name: p.fileName ?? '' })
        : p.kind === 'upload'
          ? p.fileName === undefined
            ? t.uploadUnnamed
            : t.upload({ name: p.fileName })
          : p.kind === 'chat'
            ? t.chat
            : p.repo !== undefined && p.commit !== undefined
              ? t.catalogRepo({ repo: p.repo, commit: p.commit.slice(0, 7) })
              : t.catalog;
  const pill = (
    <Pill
      tone={p.kind === 'chat' ? 'amber' : 'violet'}
      icon={p.kind === 'github' || p.kind === 'catalog' ? 'branch' : 'tray'}
    >
      <span className="font-dy-mono">{text}</span>
    </Pill>
  );
  if (
    (p.kind === 'github' || p.kind === 'catalog') &&
    p.repo !== undefined &&
    p.commit !== undefined &&
    /^[0-9a-f]{40}$/.test(p.commit)
  ) {
    const href = `https://github.com/${p.repo}/tree/${p.commit}${p.path === undefined || p.path === '' ? '' : `/${p.path}`}`;
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        title={t.githubLink}
        data-testid="skill-provenance"
        className="no-underline"
      >
        {pill}
      </a>
    );
  }
  return <span data-testid="skill-provenance">{pill}</span>;
}

function FindingLine(props: {
  readonly f: ImportFinding;
  readonly maxFiles: number;
  readonly maxFile: number;
  readonly maxTotal: number;
}): ReactNode {
  const t = useT().skills;
  const fmt = useFormat();
  const f = props.f;
  const path = f.path ?? '';
  const where = f.line === undefined ? path : `${path}:${String(f.line)}`;
  let text: string;
  switch (f.kind) {
    case 'secret':
      text = t.finding.secret({ where, rule: f.rule ?? '' });
      break;
    case 'missing_skill_md':
      text = t.finding.missingSkillMd;
      break;
    case 'layout':
      text = t.finding.layout({ path });
      break;
    case 'binary':
      text = t.finding.binary({ path });
      break;
    case 'file_too_large':
      text = t.finding.fileTooLarge({ path, size: fmt.bytes(f.size ?? 0), max: fmt.bytes(props.maxFile) });
      break;
    case 'too_many_files':
      text = t.finding.tooManyFiles({ n: f.size ?? 0, max: props.maxFiles });
      break;
    case 'total_too_large':
      text = t.finding.totalTooLarge({ size: fmt.bytes(f.size ?? 0), max: fmt.bytes(props.maxTotal) });
      break;
    case 'script':
      text = [
        t.finding.script({ path }),
        f.line === undefined ? '' : t.finding.scriptMention({ line: f.line }),
        f.rule === 'not_executable' ? t.finding.scriptNotExecutable : '',
      ]
        .filter((s) => s !== '')
        .join(' ');
      break;
    case 'risky': {
      const rules: Record<string, string> = t.finding.riskyRules;
      text = t.finding.risky({ where, what: rules[f.rule ?? ''] ?? t.finding.riskyRules.other });
      break;
    }
    case 'network':
      text =
        f.severity === 'warn'
          ? t.finding.networkActive({ hosts: fmt.list(f.hosts ?? []) })
          : t.finding.networkLinks({ hosts: fmt.list(f.hosts ?? []) });
      break;
    case 'name_invalid':
      text = t.finding.nameInvalid;
      break;
    case 'no_description':
      text = t.finding.noDescription;
      break;
    case 'skipped': {
      const reasons: Record<string, string> = t.finding.skipReasons;
      text = t.finding.skipped({ path, why: reasons[f.rule ?? ''] ?? t.finding.skipReasons.other });
      break;
    }
    case 'moved':
      text = t.finding.moved({ path, to: f.to ?? '' });
      break;
    case 'license':
      text = t.finding.license({ name: f.rule ?? path });
      break;
    case 'no_license':
      text = t.finding.noLicense;
      break;
    case 'layout_v2':
      text = t.finding.layoutV2({ size: fmt.bytes(f.size ?? 0) });
      break;
    default:
      text = t.finding.unknown({ kind: f.kind });
  }
  const tone = f.severity === 'block' ? 'red' : f.severity === 'warn' ? 'amber' : 'neutral';
  return (
    <li className="flex flex-col gap-1 py-1.5" data-testid={`import-finding-${f.kind}`}>
      <span className="flex flex-wrap items-start gap-2">
        <Pill tone={tone}>{t.preview.severity[f.severity]}</Pill>
        <span className="min-w-0 flex-1 text-[0.8125rem] [overflow-wrap:anywhere]">{text}</span>
      </span>
      {f.excerpt === undefined ? null : (
        <code className="ml-1 block font-dy-mono text-[0.75rem] text-dy-muted [overflow-wrap:anywhere]">
          {f.excerpt}
        </code>
      )}
    </li>
  );
}

function PublishForm(props: {
  readonly preview: SkillImport;
  readonly projects: readonly Project[];
  readonly offlineOnly: readonly string[];
  readonly onDone: (message: string) => void;
  readonly onClosed: () => void;
}): ReactNode {
  const all = useT();
  const t = all.skills;
  const stepUp = useStepUp();
  const p = props.preview;
  const [skillId, setSkillId] = useState(p.suggested.skillId ?? '');
  const [title, setTitle] = useState(p.suggested.title ?? p.suggested.skillId ?? '');
  const [description, setDescription] = useState(p.suggested.description ?? '');
  const [version, setVersion] = useState(p.suggested.version);
  const [runtimes, setRuntimes] = useState<readonly string[]>(RUNTIMES);
  const [assign, setAssign] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const idBad = skillId !== '' && !SKILL_ID.test(skillId);
  const ready =
    !p.blocked &&
    SKILL_ID.test(skillId) &&
    title.trim() !== '' &&
    description.trim() !== '' &&
    version.trim() !== '' &&
    runtimes.length > 0;

  async function onSubmit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const out = await stepUp.run(
        () =>
          publishSkillImport(p.id, {
            skillId,
            title: title.trim(),
            description: description.trim(),
            version: version.trim(),
            runtimes,
            assign: assign === '' ? null : { project: assign },
          }),
        t.publish.stepUp,
      );
      props.onDone(t.publish.done({ id: skillId, version: out.version.version }));
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  async function discard(): Promise<void> {
    setError(null);
    try {
      await discardSkillImport(p.id);
      props.onDone(t.publish.discarded);
    } catch (err) {
      setError(toApiError(err));
    }
  }

  const projectOptions = props.projects.map((pr) => {
    const name = pr.name === pr.id ? pr.id : `${pr.name} (${pr.id})`;
    return [
      pr.id,
      props.offlineOnly.includes(pr.id) ? t.publish.offlineOnlyProject({ name }) : name,
    ] as const;
  });

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="flex flex-col gap-3 border-t border-dy-line pt-3"
      aria-label={t.publish.title}
      data-testid="skill-import-publish"
    >
      <h3 className="m-0 text-[0.875rem] font-bold">{t.publish.title}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <DyField
          label={t.publish.idLabel}
          value={skillId}
          onChange={setSkillId}
          mono
          hint={t.publish.idHint}
          error={idBad ? t.publish.idHint : undefined}
        />
        <DyField label={t.publish.versionLabel} value={version} onChange={setVersion} mono />
        <DyField label={t.publish.titleLabel} value={title} onChange={setTitle} maxLength={120} />
        <DySelect
          label={t.publish.assignLabel}
          value={assign}
          options={[
            ['', t.publish.assignNone] as const,
            [ALL_PROJECTS, t.publish.allProjects] as const,
            ...projectOptions,
          ]}
          onChange={setAssign}
        />
      </div>
      <DyTextarea
        label={t.publish.descriptionLabel}
        value={description}
        onChange={setDescription}
        rows={3}
        maxLength={1024}
      />
      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-1 text-[0.8125rem] font-bold">{t.publish.runtimesLegend}</legend>
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
        {runtimes.length === 0 ? (
          <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{t.publish.needRuntime}</p>
        ) : null}
      </fieldset>
      <p className="m-0 text-[0.8125rem] text-dy-muted">{t.publish.warnNotice}</p>
      <DyApiError error={error} />
      <div className="flex flex-wrap gap-2">
        <DyButton type="submit" variant="primary" icon="key" busy={busy} disabled={!ready}>
          {t.publish.button}
        </DyButton>
        <DyButton variant="ghost" icon="trash" onClick={() => void discard()}>
          {t.publish.discard}
        </DyButton>
        <DyButton variant="ghost" icon="back" onClick={props.onClosed}>
          {all.shared.confirm.back}
        </DyButton>
      </div>
    </form>
  );
}

export function ImportPreview(props: {
  readonly preview: SkillImport;
  readonly projects: readonly Project[];
  readonly offlineOnly: readonly string[];
  readonly onDone: (message: string) => void;
  readonly onClosed: () => void;
}): ReactNode {
  const t = useT().skills;
  const fmt = useFormat();
  const p = props.preview;
  const source =
    p.sourceKind === 'github'
      ? t.preview.sourceGithub({ repo: p.source.repo ?? '', commit: (p.source.commit ?? '').slice(0, 12) })
      : p.sourceKind === 'catalog'
        ? t.preview.sourceCatalog({
            repo: p.source.repo ?? '',
            path: p.source.path ?? '',
            commit: (p.source.commit ?? '').slice(0, 12),
          })
        : p.sourceKind === 'zip'
          ? t.preview.sourceZip({ name: p.source.fileName ?? '' })
          : t.preview.sourceUpload({ name: p.source.fileName ?? '' });
  const order = { block: 0, warn: 1, info: 2 } as const;
  const findings = [...p.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <div className="flex flex-col gap-3" data-testid="skill-import-preview">
      <p className="m-0 font-dy-mono text-[0.8125rem] [overflow-wrap:anywhere]">{source}</p>
      {p.state === 'previewed' ? (
        <DyNotice tone={p.blocked ? 'red' : 'green'}>
          {p.blocked ? t.preview.blocked : t.preview.ready}
        </DyNotice>
      ) : (
        <DyNotice tone="amber">{t.preview.closed({ state: t.preview.states[p.state] })}</DyNotice>
      )}
      <p className="m-0 text-[0.78125rem] text-dy-muted">
        {t.preview.untrusted} {t.preview.expires({ when: fmt.relative(p.expiresAt) })}
      </p>
      {p.layout === null ? null : (
        <p className="m-0 flex flex-wrap items-center gap-2 text-[0.8125rem]" data-testid="import-layout">
          <Pill tone={p.layout === 2 ? 'violet' : 'green'}>{p.layout === 2 ? t.layout.v2 : t.layout.v1}</Pill>
          <span className="text-dy-muted">
            {t.layout.limits({
              files: p.limits.maxFiles,
              file: fmt.bytes(p.limits.maxFileBytes),
              total: fmt.bytes(p.limits.maxTotalBytes),
              job: fmt.bytes(JOB_SKILL_BYTES_V2),
            })}
          </span>
        </p>
      )}
      <section aria-label={t.preview.findingsTitle}>
        <h3 className="m-0 text-[0.875rem] font-bold">{t.preview.findingsTitle}</h3>
        {findings.length === 0 ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.preview.noFindings}</p>
        ) : (
          <ul className="m-0 list-none divide-y divide-dy-line p-0">
            {findings.map((f, i) => (
              <FindingLine
                key={`${f.kind}-${f.path ?? ''}-${String(f.line ?? i)}-${String(i)}`}
                f={f}
                maxFiles={p.limits.maxFiles}
                maxFile={p.limits.maxFileBytes}
                maxTotal={p.limits.maxTotalBytes}
              />
            ))}
          </ul>
        )}
      </section>
      <section aria-label={t.preview.filesTitle({ n: p.files.length, size: fmt.bytes(p.totalBytes) })}>
        <h3 className="m-0 mb-1 text-[0.875rem] font-bold">
          {t.preview.filesTitle({ n: p.files.length, size: fmt.bytes(p.totalBytes) })}
        </h3>
        {p.files.map((f) => (
          <DyDetails
            key={f.path}
            summary={
              <span className="font-dy-mono text-[0.8125rem] [overflow-wrap:anywhere]">
                {f.path} · {fmt.bytes(f.size)}
                {f.executable ? (
                  <span className="ml-2 font-dy-sans text-[0.78125rem] text-dy-amber-ink">
                    {t.preview.executable}
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
      </section>
      {p.excluded.length === 0 ? null : (
        <section aria-label={t.preview.excludedTitle}>
          <h3 className="m-0 mb-1 text-[0.875rem] font-bold">{t.preview.excludedTitle}</h3>
          <ul className="m-0 list-none p-0 font-dy-mono text-[0.78125rem] text-dy-muted">
            {p.excluded.map((e) => (
              <li key={e.path} className="[overflow-wrap:anywhere]">
                {e.path} · {fmt.bytes(e.size)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {p.diff === null || p.latest === null ? null : (
        <DyDetails
          summary={
            <span className="text-[0.8125rem] font-bold">{t.preview.diffTitle({ latest: p.latest })}</span>
          }
        >
          <pre className="m-0 max-h-72 overflow-auto font-dy-mono text-[0.75rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {p.diff}
          </pre>
        </DyDetails>
      )}
      {p.state === 'previewed' ? (
        <PublishForm
          preview={p}
          projects={props.projects}
          offlineOnly={props.offlineOnly}
          onDone={props.onDone}
          onClosed={props.onClosed}
        />
      ) : null}
    </div>
  );
}

export function SkillImportPanel(props: {
  readonly githubEnabled: boolean;
  readonly panelKeyConfigured: boolean;
  readonly projects: readonly Project[];
  readonly offlineOnly: readonly string[];
  readonly onDone: (message: string) => void;
}): ReactNode {
  const t = useT().skills;
  const stepUp = useStepUp();
  const fileId = useId();
  const [kind, setKind] = useState<SourceKind>('folder');
  const [picked, setPicked] = useState<ImportSource | null>(null);
  const [pickedCount, setPickedCount] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [preview, setPreview] = useState<SkillImport | null>(null);

  function choose(k: SourceKind): void {
    setKind(k);
    setPicked(null);
    setPickedCount(0);
    setFileError(null);
    setError(null);
  }

  async function onFiles(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    setPicked(null);
    setFileError(null);
    const list = [...(e.target.files ?? [])];
    if (list.length === 0) return;
    const total = list.reduce((n, f) => n + f.size, 0);
    if (total > MAX_UPLOAD_BYTES) {
      setFileError(t.import.tooLarge);
      return;
    }
    try {
      if (kind === 'zip') {
        const f = list[0];
        if (f === undefined) return;
        setPicked({ kind: 'zip', fileName: f.name, data: toBase64(await f.arrayBuffer()) });
        setPickedCount(1);
      } else {
        const files = await Promise.all(
          list.map(async (f) => ({
            path: f.webkitRelativePath === '' ? f.name : f.webkitRelativePath,
            data: toBase64(await f.arrayBuffer()),
          })),
        );
        setPicked({ kind: 'files', files });
        setPickedCount(files.length);
      }
    } catch {
      setFileError(t.import.readFailed);
    }
  }

  async function onSubmit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const source: ImportSource | null =
      kind === 'github'
        ? url.trim() === ''
          ? null
          : { kind: 'github', url: url.trim(), ...(ref.trim() === '' ? {} : { ref: ref.trim() }) }
        : picked;
    if (source === null) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await stepUp.run(() => previewSkillImport(source), t.import.stepUpPreview));
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  const sources: readonly SourceKind[] = props.githubEnabled
    ? ['folder', 'zip', 'github']
    : ['folder', 'zip'];
  return (
    <Panel title={t.import.title} sub={t.import.sub} testId="skills-import">
      {preview !== null ? (
        <ImportPreview
          preview={preview}
          projects={props.projects}
          offlineOnly={props.offlineOnly}
          onDone={(m) => {
            setPreview(null);
            props.onDone(m);
          }}
          onClosed={() => {
            setPreview(null);
          }}
        />
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
          {props.panelKeyConfigured ? null : <DyNotice tone="amber">{t.import.panelKeyMissing}</DyNotice>}
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-1 text-[0.8125rem] font-bold">{t.import.sourceLegend}</legend>
            <div className="flex flex-wrap gap-2" role="group">
              {sources.map((s) => (
                <DyButton
                  key={s}
                  variant={kind === s ? 'primary' : 'secondary'}
                  aria-pressed={kind === s}
                  icon={s === 'github' ? 'branch' : s === 'zip' ? 'tray' : 'folder'}
                  onClick={() => {
                    choose(s);
                  }}
                >
                  {t.import.sources[s]}
                </DyButton>
              ))}
            </div>
            {props.githubEnabled ? null : (
              <p className="m-0 mt-1 text-[0.78125rem] text-dy-muted">{t.import.githubOff}</p>
            )}
          </fieldset>
          {kind === 'github' ? (
            <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
              <DyField
                label={t.import.githubLabel}
                value={url}
                onChange={setUrl}
                mono
                type="url"
                inputMode="url"
                hint={t.import.githubHint}
              />
              <DyField label={t.import.refLabel} value={ref} onChange={setRef} mono />
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <label htmlFor={fileId} className="text-[0.8125rem] font-bold">
                {kind === 'zip' ? t.import.zipLabel : t.import.folderLabel}
              </label>
              <input
                key={kind}
                id={fileId}
                type="file"
                multiple={kind === 'folder'}
                accept={kind === 'zip' ? '.zip,application/zip' : undefined}
                {...(kind === 'folder' ? { webkitdirectory: '' } : {})}
                onChange={(e) => void onFiles(e)}
                className="min-h-11 max-w-full text-[0.875rem] text-dy-muted file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-[9px] file:border file:border-dy-line-2 file:bg-dy-card file:px-3 file:font-medium file:text-dy-ink"
              />
              {picked === null ? null : (
                <p className="m-0 text-[0.78125rem] text-dy-muted">{t.import.selected({ n: pickedCount })}</p>
              )}
              {fileError === null ? null : (
                <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{fileError}</p>
              )}
            </div>
          )}
          <DyApiError error={error} />
          <div>
            <DyButton
              type="submit"
              variant="primary"
              icon="search"
              busy={busy}
              disabled={kind === 'github' ? url.trim() === '' : picked === null}
            >
              {t.import.previewButton}
            </DyButton>
          </div>
        </form>
      )}
    </Panel>
  );
}
