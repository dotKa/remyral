import { type ReactNode, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import { listProjects, type Project } from '../../../api/directory';
import { setTemplateHidden, setTemplateShares, type Template } from '../../../api/templates';
import { toApiError } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { ProjectChecks } from '../../common/ProjectChecks';
import { DyApiError, DyCheck, DyChoice, DyNotice } from '../kit';
import { DyButton, Panel, Pill } from '../parts';

/**
 * p18-multi-project W4 (docs/design/p18-multi-project.md §2.5): the template library in the Diyalog template screens —
 * the list's "Kütüphane" project (what can run there: its own, global and shared templates, minus the hidden ones),
 * the scope / shared / hidden pills, a template's sharing (listed projects or every project; owner project's
 * operators) and hiding a global or shared template from one project's library.
 */

export type LibraryScope = 'any' | 'global' | 'project' | 'shared';

/** The projects the caller reads (once per screen). */
export function useReadableProjects(): readonly Project[] | null {
  const [projects, setProjects] = useState<readonly Project[] | null>(null);
  useEffect(() => {
    let live = true;
    listProjects().then(
      (p) => {
        if (live) setProjects(p);
      },
      () => {
        if (live) setProjects([]);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return projects;
}

/** The list's library filter: which project's library, which scope, hidden ones too. */
export function LibraryFilter(props: {
  readonly projects: readonly Project[] | null;
  readonly here: string;
  readonly onHere: (v: string) => void;
  readonly scope: LibraryScope;
  readonly onScope: (v: LibraryScope) => void;
  readonly showHidden: boolean;
  readonly onShowHidden: (v: boolean) => void;
}): ReactNode {
  const t = useT().multiProject.library;
  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="template-library-filter">
      <DyChoice
        label={t.in}
        value={props.here}
        hint={props.here === '' ? t.inHint : undefined}
        options={[['', t.all], ...(props.projects ?? []).map((p) => [p.id, p.name] as const)]}
        onChange={props.onHere}
      />
      {props.here === '' ? null : (
        <>
          <DyChoice
            label={t.scopeFilter}
            value={props.scope}
            options={[
              ['any', t.anyScope],
              ['project', t.scope.project],
              ['global', t.scope.global],
              ['shared', t.scope.shared],
            ]}
            onChange={(v) => {
              props.onScope(v as LibraryScope);
            }}
          />
          <DyCheck label={t.showHidden} checked={props.showHidden} onChange={props.onShowHidden} />
        </>
      )}
    </div>
  );
}

/** Pills of a template in the library: shared from another project, shared out, hidden here. */
export function LibraryPills(props: { readonly t: Template }): ReactNode {
  const w = useT().multiProject.library;
  const { t } = props;
  return (
    <>
      {t.scope === 'shared' && t.project !== null ? (
        <Pill tone="teal" icon="merge">
          <span data-testid="template-shared-from">{w.sharedFrom({ project: t.project })}</span>
        </Pill>
      ) : null}
      {t.scope === 'project' && t.sharedTo.includes('*') ? (
        <Pill tone="neutral" icon="globe">
          <span data-testid="template-shared-out">{w.sharedAll}</span>
        </Pill>
      ) : t.scope === 'project' && t.sharedTo.length + t.sharedToHidden > 0 ? (
        <Pill tone="neutral" icon="merge">
          <span data-testid="template-shared-out">
            {w.sharedOut({ n: t.sharedTo.length + t.sharedToHidden })}
          </span>
        </Pill>
      ) : null}
      {t.hidden ? (
        <Pill tone="amber">
          <span data-testid="template-hidden">{w.hiddenPill}</span>
        </Pill>
      ) : null}
    </>
  );
}

type ShareMode = 'none' | 'all' | 'some';

function SharePanel(props: { readonly t: Template; readonly onChange: (t: Template) => void }): ReactNode {
  const w = useT().multiProject.library;
  const { t } = props;
  const projects = useReadableProjects();
  const initialMode: ShareMode = t.sharedTo.includes('*') ? 'all' : t.sharedTo.length > 0 ? 'some' : 'none';
  const [mode, setMode] = useState<ShareMode>(initialMode);
  const [chosen, setChosen] = useState<string[]>(t.sharedTo.filter((p) => p !== '*'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const list = mode === 'all' ? ['*'] : mode === 'some' ? chosen : [];
      props.onChange(await setTemplateShares(t.id, list));
      setSaved(true);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={w.share.title} sub={w.share.sub} testId="template-share">
      <div className="grid gap-3">
        <DyChoice
          label={w.share.mode}
          value={mode}
          options={[
            ['none', w.share.none],
            ['all', w.share.all],
            ['some', w.share.some],
          ]}
          onChange={(v) => {
            setMode(v as ShareMode);
            setSaved(false);
          }}
        />
        {mode === 'some' ? (
          <ProjectChecks
            legend={w.share.pick}
            empty={w.choose}
            projects={(projects ?? []).filter((p) => p.id !== t.project)}
            chosen={chosen}
            onChange={(next) => {
              setChosen(next);
              setSaved(false);
            }}
            testId="template-share-projects"
          />
        ) : null}
        {t.sharedToHidden > 0 ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{w.share.others({ n: t.sharedToHidden })}</p>
        ) : null}
        <DyApiError error={error} />
        {saved ? (
          <DyNotice tone="green" live>
            {w.share.saved}
          </DyNotice>
        ) : null}
        <div>
          <DyButton
            variant="primary"
            busy={busy}
            disabled={busy || (mode === 'some' && chosen.length === 0)}
            onClick={() => void save()}
            data-testid="template-share-save"
          >
            {w.share.save}
          </DyButton>
        </div>
      </div>
    </Panel>
  );
}

function HidePanel(props: {
  readonly t: Template;
  readonly here: string;
  readonly onChange: (t: Template) => void;
}): ReactNode {
  const w = useT().multiProject.library;
  const { t, here } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const toggle = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      props.onChange(await setTemplateHidden(t.id, here, !t.hidden));
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={w.hide.title} sub={w.hide.sub} testId="template-hide">
      <div className="grid gap-3">
        {t.hidden ? <DyNotice tone="amber">{w.hide.hiddenNote({ project: here })}</DyNotice> : null}
        <DyApiError error={error} />
        <div>
          <DyButton
            busy={busy}
            disabled={busy}
            onClick={() => void toggle()}
            data-testid="template-hide-toggle"
          >
            {t.hidden ? w.hide.show({ project: here }) : w.hide.hide({ project: here })}
          </DyButton>
        </div>
      </div>
    </Panel>
  );
}

/** A template's library tab: where it comes from, its sharing (owner side), hiding in the viewed project. */
export function LibraryPanel(props: {
  readonly t: Template;
  readonly here: string | undefined;
  readonly onChange: (t: Template) => void;
}): ReactNode {
  const w = useT().multiProject.library;
  const { t, here } = props;
  return (
    <div className="grid gap-4" data-testid="template-library">
      {t.scope === 'shared' && t.project !== null ? (
        <DyNotice tone="teal">{w.sharedNote({ owner: t.project })}</DyNotice>
      ) : null}
      {t.canShare ? <SharePanel t={t} onChange={props.onChange} /> : null}
      {here !== undefined && here !== '' && t.project !== here ? (
        <HidePanel t={t} here={here} onChange={props.onChange} />
      ) : null}
    </div>
  );
}

/** Whether the library tab has anything to show for this template. */
export function hasLibrary(t: Template, here: string | undefined): boolean {
  return t.scope === 'shared' || t.canShare || (here !== undefined && here !== '' && t.project !== here);
}
