import { useErrorText } from '../../../i18n/errors';
import { type ReactNode, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { ApiError } from '../../../api/client';
import { type DocWithCurrent, exportContext, listContextDocs, runRetention } from '../../../api/context';
import { listProjects, type Project } from '../../../api/directory';
import type { ExportResult } from '../../../api/download';
import { useAuth } from '../../../auth/AuthProvider';
import { DyPager } from '../../common/pager';
import { cx, toApiError } from '../../../components/ui';
import { useResetPageOn } from '../../../lib/pageReset';
import { useClientPage } from '../../../lib/pager';
import { DyIcon } from '../../icons';
import { ConfirmButton, DyApiError, DyCheck, DyNotice } from '../forms';
import { DyButton, DySelect, EmptyLine, Panel, Pill, Rows, SkeletonRows } from '../parts';
import { DyExportResult, DyTime } from '../records';
import { ScreenFrame } from '../ScreenFrame';
import { ContextDocumentPanel } from './ContextDocument';
import { GlobalMemoryPanels } from './ContextGlobalMemory';
import { ContextReceiptsPanel, ContextRetentionPanel } from './ContextRetention';
import { ContextSearchPanel, KnowledgeDefaultsPanel } from './ContextSearch';
import { GLOBAL, kindText, provenanceWord, purgeSummary, usePrivileged } from './ContextShared';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Bağlam (`/context`, and the same body inside the settings frame on `/settings/context`,
 * as classic renders the same page on both) in the Diyalog language. Same requests and rules as the classic
 * `ContextPage`: a namespace (`global` or `project:<id>`), its documents (owners / admins may show deleted ones),
 * one document's versions / diff / rollback / delete, the namespace retention policy, deletion receipts, JSONL
 * export of a project (operators+, step-up), the manual retention run (owners / admins, step-up), global rules and
 * memory, semantic search and the defaults for new projects. Document titles and notes are untrusted text.
 * p15-classic-removal: `?namespace=global|project:<id>` (the assistant's knowledge-search links) opens that namespace.
 */

/** The namespace a `?namespace=` link names, or the global one. */
export function namespaceFromLink(value: string | null): string {
  if (value === null) return GLOBAL;
  return value === GLOBAL || /^project:[^\s/]{1,200}$/.test(value) ? value : GLOBAL;
}

export function ContextView(): ReactNode {
  const sayError = useErrorText();
  const t = useT().knowledge.context;
  const { state } = useAuth();
  const role = state.kind === 'signedIn' ? state.user.role : 'viewer';
  const isAdmin = role === 'owner' || role === 'admin';
  const canWrite = role !== 'viewer';

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsError, setProjectsError] = useState<ApiError | null>(null);
  const [params] = useSearchParams();
  const [namespace, setNamespace] = useState(() => namespaceFromLink(params.get('namespace')));
  const [showDeleted, setShowDeleted] = useState(false);
  const [docs, setDocs] = useState<DocWithCurrent[] | null>(null);
  const [docsError, setDocsError] = useState<ApiError | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exported, setExported] = useState<ExportResult | null>(null);
  const { submit: act, run } = usePrivileged();

  useEffect(() => {
    let live = true;
    listProjects().then(
      (p) => {
        if (live) setProjects(p);
      },
      (err: unknown) => {
        if (live) setProjectsError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    setDocsError(null);
    listContextDocs(namespace, isAdmin && showDeleted).then(
      (d) => {
        if (live) setDocs(d);
      },
      (err: unknown) => {
        if (live) setDocsError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [namespace, showDeleted, isAdmin, reload]);

  const project = namespace.startsWith('project:') ? namespace.slice('project:'.length) : null;
  const entry = docs?.find((d) => d.document.id === selected) ?? null;
  // p9-pagination: documents page in the browser; another namespace or "show deleted" starts on page 1.
  const docPage = useClientPage(docs ?? [], { label: t.docPages });
  useResetPageOn(`${namespace}\u0000${String(showDeleted)}`);

  const changed = (message: string): void => {
    setNotice(message);
    setReload((n) => n + 1);
  };

  const options: (readonly [string, string])[] = [
    [GLOBAL, t.globalOption],
    ...projects.map(
      (p) =>
        [`project:${p.id}`, p.name === p.id ? `project:${p.id}` : `${p.name} (project:${p.id})`] as const,
    ),
  ];

  return (
    <div className="flex flex-col gap-5" data-testid="dy-context">
      <Panel title={t.namespace} sub={t.namespaceSub} testId="dy-context-namespace">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <DySelect
              label={t.namespace}
              value={namespace}
              options={options}
              className="min-w-0 flex-[1_1_16rem] sm:max-w-sm"
              onChange={(v) => {
                setNamespace(v);
                setSelected(null);
                setDocs(null);
                setNotice(null);
                setExported(null);
              }}
            />
            {isAdmin ? (
              <DyCheck label={t.showDeleted} checked={showDeleted} onChange={setShowDeleted} />
            ) : null}
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              {canWrite && project !== null ? (
                <DyButton
                  icon="tray"
                  busy={act.busy}
                  onClick={() => {
                    setNotice(null);
                    setExported(null);
                    void run(async () => {
                      setExported(await exportContext(project));
                    }, t.exportStepUp);
                  }}
                >
                  {t.export}
                </DyButton>
              ) : null}
              {isAdmin ? (
                <ConfirmButton
                  label={t.runRetention}
                  icon="retry"
                  variant="warn"
                  question={t.runQuestion}
                  confirmLabel={t.runConfirm}
                  busy={act.busy}
                  testId="context-run-retention"
                  onConfirm={() => {
                    setNotice(null);
                    setExported(null);
                    void run(async () => {
                      const r = await runRetention();
                      changed(purgeSummary(t, r));
                    }, t.runStepUp);
                  }}
                />
              ) : null}
            </div>
          </div>
          {projectsError ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">
              {t.projectsFailed({ reason: sayError(projectsError) })}
            </p>
          ) : null}
          <DyApiError error={act.error} retryLeft={act.retryLeft} />
          {exported !== null ? <DyExportResult result={exported} /> : null}
          {notice !== null ? (
            <DyNotice tone="green" live>
              <span data-testid="context-notice">{notice}</span>
            </DyNotice>
          ) : null}
        </div>
      </Panel>

      {/* p11-memory-layers: typed global / per-runtime records. */}
      <GlobalMemoryPanels isAdmin={isAdmin} />

      <Panel
        title={t.docs}
        count={docs === null ? undefined : String(docs.length)}
        countLabel={docs === null ? undefined : t.docCount({ n: docs.length })}
        sub={t.docsSub}
        flush
        testId="dy-context-docs"
      >
        {docsError === null ? null : (
          <div className="px-4 pb-2">
            <DyApiError error={docsError} />
          </div>
        )}
        {docs === null ? (
          docsError === null ? (
            <SkeletonRows label={t.docsLoading} rows={3} />
          ) : null
        ) : docs.length === 0 ? (
          <EmptyLine>{t.noDocs}</EmptyLine>
        ) : (
          <>
            <Rows label={t.docsLabel} testId="context-docs">
              {docPage.pageItems.map(({ document: d, current }) => {
                const on = d.id === selected;
                return (
                  <li
                    key={d.id}
                    data-testid="context-doc-row"
                    className={cx(
                      'flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-dy-line px-4 py-3 first:border-t-0',
                      on && 'bg-dy-teal-soft/50',
                    )}
                  >
                    <DyIcon
                      name="file"
                      className={cx('mt-0.5 size-4 shrink-0', on ? 'text-dy-teal-ink' : 'text-dy-muted')}
                    />
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        aria-pressed={on}
                        className="text-left font-medium text-dy-ink [overflow-wrap:anywhere] [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                        onClick={() => {
                          setSelected(on ? null : d.id);
                        }}
                      >
                        {current.title}
                      </button>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.8125rem] text-dy-muted">
                        <span>{kindText(t, d.kind)}</span>
                        <span className="font-dy-mono">{`v${String(d.currentVersion)}`}</span>
                        <span>{provenanceWord(t, current.provenance.type)}</span>
                        <DyTime iso={d.updatedAt} />
                      </div>
                    </div>
                    {d.deletedAt !== null ? (
                      <span data-testid="context-deleted" className="pl-7 sm:pl-0">
                        <Pill tone="red" icon="trash">
                          {t.deleted}
                          {d.purgeAfter === null ? null : (
                            <>
                              {` ${t.purgeAt} `}
                              <DyTime iso={d.purgeAfter} />
                            </>
                          )}
                        </Pill>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </Rows>
            <div className="px-4">
              <DyPager {...docPage.pagination} />
            </div>
          </>
        )}
      </Panel>

      {entry !== null ? (
        <ContextDocumentPanel
          key={entry.document.id}
          entry={entry}
          canWrite={canWrite}
          isAdmin={isAdmin}
          onChanged={changed}
        />
      ) : null}

      <ContextRetentionPanel namespace={namespace} isAdmin={isAdmin} />
      {isAdmin ? <ContextReceiptsPanel key={namespace} namespace={namespace} /> : null}
      <ContextSearchPanel key={`search:${namespace}`} namespace={namespace} isAdmin={isAdmin} />
      {/* p10-semantic-defaults-chat: what new projects start with. */}
      {isAdmin ? <KnowledgeDefaultsPanel /> : null}
    </div>
  );
}

/** `/context`: the context view in its own Diyalog screen. */
export function ContextScreen(): ReactNode {
  const t = useT().knowledge.context;
  return (
    <ScreenFrame title={t.title} purpose={t.purpose} testId="dy-context-screen">
      <ContextView />
    </ScreenFrame>
  );
}
