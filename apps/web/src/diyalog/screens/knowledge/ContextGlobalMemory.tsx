import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { listConflicts, type RecordConflict } from '../../../api/memoryRecords';
import { useSubmit } from '../../../screens/useSubmit';
import { ConflictList, NewRecordForm, RecordsBrowser } from '../projects/tabs/memory-records';
import { DyApiError, DyNotice } from '../forms';
import { DyButton, Panel, SkeletonRows } from '../parts';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Bağlam → Genel kurallar ve hafıza (p11-memory-layers): records every project gets
 * (`global`) or every project on one runtime (`runtime:<name>`), with the same record views and actions as project
 * memory (the Diyalog `memory-records` pieces), and the global possible conflicts. Owners / admins create and resolve.
 * `?record=<id>` outlines one record. Same calls as the classic `GlobalMemorySection`.
 */
export function GlobalMemoryPanels(props: { readonly isAdmin: boolean }): ReactNode {
  const t = useT().knowledge.context.global;
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
    <>
      <Panel
        title={t.title}
        sub={t.sub}
        aside={
          props.isAdmin ? (
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
          ) : undefined
        }
        testId="dy-global-memory"
      >
        <section aria-label={t.title} className="flex flex-col gap-4">
          {props.isAdmin && adding ? (
            <div className="rounded-[12px] border border-dy-line bg-dy-sunk/50 p-3.5">
              <NewRecordForm
                scopeMode={{ global: true }}
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
              <span data-testid="global-records-notice">{notice}</span>
            </DyNotice>
          ) : null}
          <RecordsBrowser
            scope={{ global: true }}
            reload={reload}
            highlight={highlight}
            onChanged={changed}
          />
        </section>
      </Panel>
      <GlobalConflicts canWrite={props.isAdmin} reload={reload} onChanged={changed} />
    </>
  );
}

function GlobalConflicts(props: {
  readonly canWrite: boolean;
  readonly reload: number;
  readonly onChanged: (notice: string) => void;
}): ReactNode {
  const t = useT().knowledge.context.global;
  const [items, setItems] = useState<RecordConflict[] | null>(null);
  const load = useSubmit();
  useEffect(() => {
    void load.run(async () => {
      setItems(await listConflicts(null));
    });
    // load.run is stable.
  }, [props.reload]);
  return (
    <Panel
      title={t.conflicts}
      count={items === null ? undefined : String(items.length)}
      sub={t.conflictsSub}
      testId="dy-global-conflicts"
    >
      <DyApiError error={load.error} />
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
