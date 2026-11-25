import { type ReactNode, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import { getWorkflowDocument, listWorkflowVersions, type WorkflowVersion } from '../../../api/workflowDefs';
import { toApiError } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { useNow } from '../../../lib/now';
import { DyApiError, DyDialog } from '../kit';
import { DyButton, Pill } from '../parts';
import { agoIn, asDoc, type Doc, type DocDiff, diffDocs, diffIsEmpty } from './model';

/**
 * p13-workflows-ui (docs/design/p13-workflows-ui.md §3.5): Sürümler — every saved version of this workflow (newest
 * first, append-only on the master), and for a chosen one what differs from the canvas: steps added / removed /
 * changed (by field), links, settings. "Bu sürümü aç" shows it read-only; "Bu sürümden devam et" puts it on the
 * canvas as unsaved changes (saving makes it the next version — history is never rewritten).
 */

function DiffView(props: { readonly diff: DocDiff }): ReactNode {
  const d = props.diff;
  const v = useT().workflows.versions;
  if (diffIsEmpty(d)) return <p className="m-0 text-[0.875rem] text-dy-muted">{v.same}</p>;
  const line = (label: string, items: readonly string[], tone: 'green' | 'red' | 'amber'): ReactNode =>
    items.length === 0 ? null : (
      <li className="grid gap-1">
        <span className="text-[0.8125rem] font-bold">{label}</span>
        <span className="flex flex-wrap gap-1">
          {items.map((i) => (
            <Pill key={i} tone={tone} className="font-dy-mono">
              {i}
            </Pill>
          ))}
        </span>
      </li>
    );
  return (
    <ul className="m-0 grid list-none gap-3 p-0" data-testid="workflow-diff">
      {line(v.added, d.added, 'green')}
      {line(v.removed, d.removed, 'red')}
      {d.changed.length === 0 ? null : (
        <li className="grid gap-1">
          <span className="text-[0.8125rem] font-bold">{v.changed}</span>
          <ul className="m-0 grid list-none gap-0.5 p-0 text-[0.84375rem]">
            {d.changed.map((c) => (
              <li key={c.id}>
                <span className="font-dy-mono font-bold">{c.id}</span>
                <span className="text-dy-muted">{`: ${c.fields.join(', ')}`}</span>
              </li>
            ))}
          </ul>
        </li>
      )}
      {line(v.edgesAdded, d.edgesAdded, 'green')}
      {line(v.edgesRemoved, d.edgesRemoved, 'red')}
      {line(v.settings, d.settings, 'amber')}
    </ul>
  );
}

export function VersionsDialog(props: {
  readonly open: boolean;
  readonly workflowId: string;
  /** The document on the canvas (the diff's newer side). */
  readonly current: Doc;
  readonly currentVersion: number;
  readonly canRestore: boolean;
  readonly onClose: () => void;
  readonly onOpenVersion: (id: string) => void;
  readonly onRestore: (doc: Doc, version: number) => void;
  /** p18-multi-project: read through a project that attached the workflow (the versions it runs or has pending). */
  readonly project?: string | undefined;
}): ReactNode {
  const [versions, setVersions] = useState<readonly WorkflowVersion[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [picked, setPicked] = useState<{ v: WorkflowVersion; doc: Doc } | null>(null);
  const now = useNow();
  const w = useT().workflows;
  const t = w.versions;
  const { open, workflowId, project } = props;
  useEffect(() => {
    if (!open) return;
    setPicked(null);
    listWorkflowVersions(workflowId, project === undefined ? {} : { project }).then(
      setVersions,
      (err: unknown) => {
        setError(toApiError(err));
      },
    );
  }, [open, workflowId, project]);
  const pick = (v: WorkflowVersion): void => {
    setError(null);
    getWorkflowDocument(v.id, project === undefined ? {} : { project }).then(
      (d) => {
        const r = asDoc(d.definition, w.model);
        if ('doc' in r) setPicked({ v, doc: r.doc });
      },
      (err: unknown) => {
        setError(toApiError(err));
      },
    );
  };
  return (
    <DyDialog
      open={open}
      onClose={props.onClose}
      title={t.title}
      description={t.sub}
      size="lg"
      testId="workflow-versions"
    >
      <DyApiError error={error} />
      <div className="grid gap-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <ul
          className="m-0 grid max-h-[50vh] list-none content-start gap-1 overflow-auto p-0"
          aria-label={t.title}
        >
          {versions === null ? (
            <li className="text-[0.875rem] text-dy-muted">{t.loading}</li>
          ) : (
            versions.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  aria-pressed={picked?.v.id === v.id}
                  onClick={() => {
                    pick(v);
                  }}
                  className="dy-press grid w-full gap-0.5 rounded-[10px] border border-dy-line px-3 py-2 text-left aria-pressed:border-dy-ink aria-pressed:bg-dy-sunk"
                  data-testid="workflow-version"
                >
                  <span className="flex items-center gap-2 font-dy-mono text-[0.875rem] font-bold">
                    {`v${String(v.version)}`}
                    {v.version === props.currentVersion ? <Pill tone="teal">{t.current}</Pill> : null}
                  </span>
                  <span className="text-[0.78125rem] text-dy-muted">
                    {t.meta({ n: v.nodes, by: v.createdBy ?? '—', ago: agoIn(w.time, v.createdAt, now) })}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="min-w-0">
          {picked === null ? (
            <p className="m-0 text-[0.875rem] text-dy-muted">{t.pick}</p>
          ) : (
            <div className="grid gap-4">
              <h3 className="m-0 text-[0.9375rem] font-bold">{t.diffTitle({ version: picked.v.version })}</h3>
              <DiffView diff={diffDocs(picked.doc, props.current)} />
              <div className="flex flex-wrap gap-2">
                <DyButton
                  onClick={() => {
                    props.onOpenVersion(picked.v.id);
                  }}
                >
                  {t.open}
                </DyButton>
                {props.canRestore ? (
                  <DyButton
                    variant="primary"
                    icon="retry"
                    onClick={() => {
                      props.onRestore(picked.doc, picked.v.version);
                    }}
                  >
                    {t.restore}
                  </DyButton>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </DyDialog>
  );
}
