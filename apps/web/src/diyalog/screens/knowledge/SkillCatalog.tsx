import { type ReactNode, type SubmitEvent, useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import type { Project } from '../../../api/directory';
import {
  type CatalogEntry,
  type CatalogFit,
  type CatalogSource,
  deleteCatalogSource,
  previewSkillImport,
  refreshCatalogSource,
  saveCatalogSource,
  searchSkillCatalog,
  type SkillImport,
} from '../../../api/skills';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import type { Tone } from '../../tone';
import { DyIcon } from '../../icons';
import { ConfirmButton, DyApiError, DyCheck, DyField, DyNotice } from '../forms';
import { DyButton, DySelect, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { ImportPreview } from './SkillImport';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p14-skill-catalogs (ADR-0054, docs/design/p14-mcp-skills.md §3.3, §5.5): Yetenekler → Keşfet. Searches the configured
 * skill catalogs (GitHub repositories the master reads pinned to a commit and caches) and imports an entry through
 * the usual preview → always-fresh publish. Admins refresh, add, change, switch off or remove catalog sources (step-up,
 * audited). Every name, description and path from a catalog is untrusted third-party text and renders as text.
 */

const FIT_TONE: Readonly<Record<CatalogFit, Tone>> = {
  v1: 'green',
  v2: 'violet',
  too_large: 'red',
  binary: 'red',
};
const SOURCE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

function FitPill(props: { readonly fit: CatalogFit }): ReactNode {
  const t = useT().skills.catalog;
  return (
    <span data-testid={`catalog-fit-${props.fit}`}>
      <Pill tone={FIT_TONE[props.fit]} title={t.fitTitle[props.fit]}>
        {t.fit[props.fit]}
      </Pill>
    </span>
  );
}

function EntryRow(props: {
  readonly entry: CatalogEntry;
  readonly admin: boolean;
  readonly busy: boolean;
  readonly onImport: (e: CatalogEntry) => void;
}): ReactNode {
  const t = useT().skills.catalog;
  const fmt = useFormat();
  const e = props.entry;
  const importable = e.fit === 'v1' || e.fit === 'v2';
  return (
    <Row
      testId="catalog-entry"
      lead={<DyIcon name="file" className="size-4" />}
      title={
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="font-dy-mono [overflow-wrap:anywhere]">{e.name ?? e.path}</span>
          <FitPill fit={e.fit} />
        </span>
      }
      meta={
        <>
          <span className="w-full text-dy-muted [overflow-wrap:anywhere]">
            {e.description ?? t.noDescription}
          </span>
          <a
            href={e.url}
            target="_blank"
            rel="noreferrer noopener"
            title={t.openOnGithub}
            className="font-dy-mono [overflow-wrap:anywhere]"
          >
            {`${e.repo}/${e.path}@${e.commit.slice(0, 7)}`}
          </a>
          <span>{t.files({ n: e.fileCount, size: fmt.bytes(e.totalBytes) })}</span>
        </>
      }
      actions={
        props.admin && importable ? (
          <DyButton
            variant="secondary"
            icon="tray"
            busy={props.busy}
            onClick={() => {
              props.onImport(e);
            }}
          >
            {t.importButton}
          </DyButton>
        ) : undefined
      }
    />
  );
}

interface SourceForm {
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  readonly ref: string;
  readonly path: string;
  readonly enabled: boolean;
  readonly existing: boolean;
}

const EMPTY_FORM: SourceForm = {
  id: '',
  title: '',
  repo: '',
  ref: '',
  path: '',
  enabled: true,
  existing: false,
};

function SourceEditor(props: {
  readonly form: SourceForm;
  readonly onDone: (message: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const t = useT().skills.catalog;
  const stepUp = useStepUp();
  const [f, setF] = useState<SourceForm>(props.form);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const idBad = f.id !== '' && !SOURCE_ID.test(f.id);
  const ready = SOURCE_ID.test(f.id) && f.title.trim() !== '' && REPO.test(f.repo.trim());

  async function onSubmit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await stepUp.run(
        () =>
          saveCatalogSource(f.id, {
            title: f.title.trim(),
            repo: f.repo.trim(),
            ref: f.ref.trim() === '' ? null : f.ref.trim(),
            path: f.path.trim(),
            enabled: f.enabled,
          }),
        t.stepUp,
      );
      props.onDone(t.saved({ id: f.id }));
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  const title = f.existing ? t.formEdit({ id: f.id }) : t.formAdd;
  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label={title}
      className="flex flex-col gap-3 border-t border-dy-line px-4 py-3.5"
      data-testid="catalog-source-form"
    >
      <h3 className="m-0 text-[0.875rem] font-bold">{title}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {f.existing ? null : (
          <DyField
            label={t.idLabel}
            value={f.id}
            onChange={(v) => {
              setF({ ...f, id: v });
            }}
            mono
            hint={t.idHint}
            error={idBad ? t.idHint : undefined}
          />
        )}
        <DyField
          label={t.titleLabel}
          value={f.title}
          onChange={(v) => {
            setF({ ...f, title: v });
          }}
        />
        <DyField
          label={t.repoLabel}
          value={f.repo}
          onChange={(v) => {
            setF({ ...f, repo: v });
          }}
          mono
        />
        <DyField
          label={t.refLabel}
          value={f.ref}
          onChange={(v) => {
            setF({ ...f, ref: v });
          }}
          mono
        />
        <DyField
          label={t.pathLabel}
          value={f.path}
          onChange={(v) => {
            setF({ ...f, path: v });
          }}
          mono
        />
      </div>
      <DyCheck
        label={t.enabledLabel}
        checked={f.enabled}
        onChange={(on) => {
          setF({ ...f, enabled: on });
        }}
      />
      <DyApiError error={error} />
      <div className="flex flex-wrap gap-2">
        <DyButton type="submit" variant="primary" icon="check" busy={busy} disabled={!ready}>
          {t.save}
        </DyButton>
        <DyButton variant="ghost" icon="back" onClick={props.onCancel}>
          {t.cancel}
        </DyButton>
      </div>
    </form>
  );
}

function SourcesPanel(props: {
  readonly sources: readonly CatalogSource[];
  readonly admin: boolean;
  readonly onChanged: (message: string) => void;
}): ReactNode {
  const t = useT().skills.catalog;
  const fmt = useFormat();
  const stepUp = useStepUp();
  const [form, setForm] = useState<SourceForm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function refresh(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await refreshCatalogSource(id);
      props.onChanged(t.refreshed({ id }));
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string): Promise<void> {
    setError(null);
    try {
      await stepUp.run(() => deleteCatalogSource(id), t.stepUp);
      props.onChanged(t.removed({ id }));
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
    }
  }

  return (
    <Panel
      title={t.sourcesTitle}
      testId="catalog-sources"
      flush
      aside={
        props.admin && form === null ? (
          <DyButton
            variant="ghost"
            icon="plus"
            onClick={() => {
              setForm(EMPTY_FORM);
            }}
          >
            {t.addButton}
          </DyButton>
        ) : undefined
      }
    >
      <Rows label={t.sourcesLabel}>
        {props.sources.map((s) => (
          <Row
            key={s.id}
            testId="catalog-source"
            lead={<DyIcon name="branch" className="size-4" />}
            title={
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span>{s.title}</span>
                <span className="font-dy-mono text-[0.8125rem]">{s.repo}</span>
                {s.builtin ? <Pill tone="teal">{t.builtin}</Pill> : null}
                {s.enabled ? null : <Pill tone="neutral">{t.off}</Pill>}
              </span>
            }
            meta={
              <>
                <span>
                  {s.listedAt === null || s.commit === null
                    ? t.notListed
                    : t.listed({ when: fmt.relative(s.listedAt), commit: s.commit.slice(0, 7) })}
                </span>
                <span>{t.entries({ n: s.entryCount })}</span>
                {s.error === null ? null : (
                  <span className="w-full text-dy-red-ink [overflow-wrap:anywhere]">
                    {t.error({ message: s.error })}
                  </span>
                )}
              </>
            }
            actions={
              props.admin ? (
                <span className="flex flex-wrap gap-1.5">
                  <DyButton
                    variant="ghost"
                    icon="retry"
                    busy={busy === s.id}
                    onClick={() => void refresh(s.id)}
                  >
                    {t.refresh}
                  </DyButton>
                  <DyButton
                    variant="ghost"
                    icon="gear"
                    onClick={() => {
                      setForm({
                        id: s.id,
                        title: s.title,
                        repo: s.repo,
                        ref: s.ref ?? '',
                        path: s.path,
                        enabled: s.enabled,
                        existing: true,
                      });
                    }}
                  >
                    {t.edit}
                  </DyButton>
                  {s.builtin ? null : (
                    <ConfirmButton
                      label={t.remove}
                      question={t.removeQuestion({ id: s.id })}
                      confirmLabel={t.removeConfirm}
                      testId={`catalog-source-remove-${s.id}`}
                      onConfirm={() => void remove(s.id)}
                    />
                  )}
                </span>
              ) : undefined
            }
          />
        ))}
      </Rows>
      {form === null ? null : (
        <SourceEditor
          key={form.id}
          form={form}
          onCancel={() => {
            setForm(null);
          }}
          onDone={(m) => {
            setForm(null);
            props.onChanged(m);
          }}
        />
      )}
      <DyApiError error={error} className="px-4 pb-3" />
    </Panel>
  );
}

export function SkillCatalogPanel(props: {
  readonly admin: boolean;
  readonly projects: readonly Project[];
  readonly offlineOnly: readonly string[];
  readonly onDone: (message: string) => void;
}): ReactNode {
  const all = useT();
  const t = all.skills.catalog;
  const stepUp = useStepUp();
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [data, setData] = useState<{
    enabled: boolean;
    sources: CatalogSource[];
    entries: CatalogEntry[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [preview, setPreview] = useState<SkillImport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice);

  const load = useCallback((query: { q: string; source: string }) => {
    setLoading(true);
    setError(null);
    searchSkillCatalog(query).then(
      (d) => {
        setData(d);
        setLoading(false);
      },
      (err: unknown) => {
        setError(toApiError(err));
        setLoading(false);
      },
    );
  }, []);
  useEffect(() => {
    load({ q: '', source: '' });
  }, [load]);

  async function importEntry(e: CatalogEntry): Promise<void> {
    setImporting(e.id);
    setError(null);
    try {
      setPreview(
        await stepUp.run(() => previewSkillImport({ kind: 'catalog', entryId: e.id }), t.stepUpImport),
      );
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
    } finally {
      setImporting(null);
    }
  }

  const sourcesChanged = (m: string): void => {
    setNotice(m);
    load({ q, source });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="skill-catalog">
      {preview === null ? null : (
        <Panel title={t.previewTitle} testId="catalog-import-preview">
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
        </Panel>
      )}
      <Panel title={t.title} sub={t.sub} testId="catalog-search" flush>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            load({ q, source });
          }}
          role="search"
          className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-end"
        >
          <DyField label={t.searchLabel} value={q} onChange={setQ} wrapClassName="min-w-0 flex-1" />
          <DySelect
            label={t.sourceLabel}
            value={source}
            options={[
              ['', t.allSources] as const,
              ...(data?.sources ?? []).map((s) => [s.id, s.title] as const),
            ]}
            onChange={setSource}
          />
          <div>
            <DyButton type="submit" icon="search" busy={loading}>
              {t.searchButton}
            </DyButton>
          </div>
        </form>
        <p className="m-0 px-4 pb-2 text-[0.78125rem] text-dy-muted">
          {t.untrusted} {t.skillsSh}
        </p>
        {data !== null && !data.enabled ? (
          <DyNotice tone="amber" className="mx-4 mb-3">
            {t.disabled}
          </DyNotice>
        ) : null}
        <DyApiError error={error} className="px-4 pb-3" />
        {data === null && loading ? (
          <SkeletonRows label={t.loading} rows={3} />
        ) : data !== null && data.entries.length === 0 ? (
          <EmptyLine testId="catalog-empty">{t.empty}</EmptyLine>
        ) : data !== null ? (
          <Rows label={t.resultsLabel} testId="catalog-results">
            {data.entries.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                admin={props.admin}
                busy={importing === e.id}
                onImport={(x) => void importEntry(x)}
              />
            ))}
          </Rows>
        ) : null}
      </Panel>
      {data === null ? null : (
        <SourcesPanel sources={data.sources} admin={props.admin} onChanged={sourcesChanged} />
      )}
    </div>
  );
}
