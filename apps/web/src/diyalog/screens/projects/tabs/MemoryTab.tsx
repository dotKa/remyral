import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { Project } from '../../../../api/directory';
import {
  giveType,
  listConflicts,
  listDecisions,
  listUntyped,
  type MemoryRecord,
  type RecordConflict,
  type RecordType,
  type UntypedDoc,
} from '../../../../api/memoryRecords';
import { typesFor } from '../../../../screens/memory/recordTypes';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyApiError, DyNotice } from '../../forms';
import { DyButton, DyButtonLink, DySelect, Panel, SkeletonRows } from '../../parts';
import { ConflictList, DecisionTimeline, NewRecordForm, RecordsBrowser } from './memory-records';
import { SuggestionsPanels } from './memory-suggestions';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from '../../../common/time';

/**
 * Projeler → Hafıza in the Diyalog language (p12-diyalog wave 2, W3; p11-memory-layers + p10-semantic-memory): the
 * project's typed memory (records grouped by type with filters and actions, "Yeni kayıt"), possible conflicts, the
 * decision history, untyped legacy documents ("Tür ver") and the suggestions inbox. `?record=<id>` outlines one
 * record. Viewers read; operators and up write — the same rule and calls as the classic `ProjectMemoryTab`.
 */

function LoadNote(props: { readonly error: { message: string } | null; readonly what: string }): ReactNode {
  const t = useT().projectTabs.memoryTab;
  if (props.error === null) return null;
  return (
    <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="memory-load-error">
      {t.loadFailed({ what: props.what, reason: props.error.message })}
    </p>
  );
}

export function MemoryTab(props: { readonly project: Project }): ReactNode {
  const project = props.project.id;
  const all = useT();
  const t = all.projectTabs.memoryTab;
  const ti = all.memoryImport;
  const role = props.project.myRole;
  const canWrite = role !== 'viewer';
  const [params] = useSearchParams();
  const highlight = params.get('record');
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const changed = useCallback((text: string) => {
    setNotice(text);
    setReload((n) => n + 1);
  }, []);

  return (
    <div className="flex flex-col gap-4" data-testid="dy-project-memory">
      <Panel
        title={t.title}
        sub={t.sub}
        aside={
          canWrite ? (
            <span className="flex flex-wrap gap-2">
              {/* p17-memory-import: an assistant's knowledge into this project (operators and up, like a new record). */}
              <DyButtonLink
                to={`/settings/profile?tab=import&project=${encodeURIComponent(project)}`}
                icon="inbox"
                aria-label={ti.projectLinkTitle}
              >
                {ti.projectLink}
              </DyButtonLink>
              <DyButton
                variant={adding ? 'secondary' : 'primary'}
                icon={adding ? 'xc' : 'plus'}
                aria-expanded={adding}
                onClick={() => {
                  setAdding((a) => !a);
                }}
              >
                {adding ? t.close : t.add}
              </DyButton>
            </span>
          ) : undefined
        }
        testId="dy-memory-records"
      >
        <div className="flex flex-col gap-4">
          {adding ? (
            <div className="rounded-[12px] border border-dy-line bg-dy-sunk/50 p-3.5">
              <NewRecordForm
                scopeMode={{ project }}
                onCreated={(c) => {
                  changed(t.added({ title: c.record.title }));
                }}
                onCancel={() => {
                  setAdding(false);
                }}
              />
            </div>
          ) : null}
          {notice !== null ? (
            <DyNotice tone="green" live>
              <span data-testid="records-notice">{notice}</span>
            </DyNotice>
          ) : null}
          <RecordsBrowser scope={{ project }} reload={reload} highlight={highlight} onChanged={changed} />
        </div>
      </Panel>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ConflictsPanel project={project} canWrite={canWrite} reload={reload} onChanged={changed} />
        <DecisionsPanel project={project} reload={reload} />
      </div>
      <UntypedPanel project={project} canWrite={canWrite} reload={reload} onChanged={changed} />
      <SuggestionsPanels project={project} role={role} />
    </div>
  );
}

function ConflictsPanel(props: {
  readonly project: string;
  readonly canWrite: boolean;
  readonly reload: number;
  readonly onChanged: (notice: string) => void;
}): ReactNode {
  const t = useT().projectTabs.memoryTab;
  const [items, setItems] = useState<RecordConflict[] | null>(null);
  const load = useSubmit();
  useEffect(() => {
    void load.run(async () => {
      setItems(await listConflicts(props.project));
    });
    // load.run is stable.
  }, [props.project, props.reload]);
  return (
    <Panel
      title={t.conflicts}
      count={items === null ? undefined : String(items.length)}
      sub={t.conflictsSub}
      testId="dy-memory-conflicts"
    >
      <LoadNote error={load.error} what={t.conflicts} />
      {items === null ? (
        load.error === null ? (
          <SkeletonRows label={t.conflictsLoading} rows={1} />
        ) : null
      ) : (
        <ConflictList conflicts={items} canResolve={props.canWrite} onResolved={props.onChanged} />
      )}
    </Panel>
  );
}

function DecisionsPanel(props: { readonly project: string; readonly reload: number }): ReactNode {
  const t = useT().projectTabs.memoryTab;
  const [items, setItems] = useState<MemoryRecord[] | null>(null);
  const load = useSubmit();
  useEffect(() => {
    void load.run(async () => {
      setItems(await listDecisions(props.project));
    });
    // load.run is stable.
  }, [props.project, props.reload]);
  return (
    <Panel
      title={t.decisions}
      count={items === null ? undefined : String(items.length)}
      testId="dy-memory-decisions"
    >
      <LoadNote error={load.error} what={t.decisionsWhat} />
      {items === null ? (
        load.error === null ? (
          <SkeletonRows label={t.decisionsLoading} rows={2} />
        ) : null
      ) : (
        <DecisionTimeline decisions={items} />
      )}
    </Panel>
  );
}

function UntypedPanel(props: {
  readonly project: string;
  readonly canWrite: boolean;
  readonly reload: number;
  readonly onChanged: (notice: string) => void;
}): ReactNode {
  const t = useT().projectTabs.memoryTab;
  const [items, setItems] = useState<UntypedDoc[] | null>(null);
  const load = useSubmit();
  useEffect(() => {
    void load.run(async () => {
      setItems(await listUntyped(props.project));
    });
    // load.run is stable.
  }, [props.project, props.reload]);
  // Shown only when there is something to type (older projects), as classic.
  if (items === null || items.length === 0) return null;
  return (
    <Panel title={t.untyped} count={String(items.length)} sub={t.untypedSub} flush>
      <ul className="m-0 flex list-none flex-col p-0" data-testid="untyped-docs">
        {items.map((d) => (
          <UntypedRow key={d.id} doc={d} canWrite={props.canWrite} onChanged={props.onChanged} />
        ))}
      </ul>
    </Panel>
  );
}

function UntypedRow(props: {
  readonly doc: UntypedDoc;
  readonly canWrite: boolean;
  readonly onChanged: (notice: string) => void;
}): ReactNode {
  const fmt = useFormat();
  const all = useT().projectTabs;
  const t = all.memoryTab;
  const d = props.doc;
  const allowed = typesFor(d.kind);
  const [type, setType] = useState<RecordType>(allowed[0] ?? 'fact');
  const act = useSubmit();
  return (
    <li className="flex flex-wrap items-end justify-between gap-3 border-t border-dy-line px-4 py-3 first:border-t-0">
      <div className="min-w-0">
        <p className="m-0 font-medium [overflow-wrap:anywhere]">{d.title}</p>
        <p className="m-0 text-[0.8125rem] text-dy-muted">
          {d.kind === 'instructions' ? t.instructions : d.kind === 'memory' ? t.memory : d.kind}
          {t.updated} <time dateTime={d.updatedAt}>{fmt.dateWith(d.updatedAt, DATE_TIME_NUMERIC)}</time>
        </p>
      </div>
      {props.canWrite ? (
        <div className="flex flex-wrap items-end gap-2">
          {allowed.length > 1 ? (
            <DySelect
              label={t.type}
              value={type}
              options={allowed.map((x) => [x, all.memory.type[x]] as const)}
              onChange={(v) => {
                const next = allowed.find((x) => x === v);
                if (next !== undefined) setType(next);
              }}
              className="min-w-32"
            />
          ) : (
            <span className="pb-2 text-[0.8125rem] text-dy-muted">{t.becomesRule}</span>
          )}
          <DyButton
            busy={act.busy}
            onClick={() => {
              void act.run(async () => {
                const r = await giveType(d.id, { type });
                props.onChanged(t.typed({ title: r.title, type: all.memory.typeLower[r.type] }));
              });
            }}
          >
            {t.giveType}
          </DyButton>
        </div>
      ) : null}
      <DyApiError error={act.error} retryLeft={act.retryLeft} className="basis-full" />
    </li>
  );
}
