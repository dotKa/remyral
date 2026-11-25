import { type ReactNode, useState } from 'react';
import {
  approveMergeBatch,
  listMergeBatch,
  type MergeBatchItem,
  type MergeBatchResult,
} from '../../../api/approvals';
import type { OpsItem } from '../../../api/opsThread';
import { cx } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { StepUpCancelledError, useOptionalStepUp } from '../../../stepup/StepUpProvider';
import { DyButton } from '../parts';

/**
 * p22-output-delivery §2 (docs/design/p22-output-delivery.md): "Senden bekleyenler" offers, per project with at least
 * two open merge decisions, to select several and approve them together. The master decides each one exactly like a
 * single approval (role, expiry, step-up, audit per item); one authenticator code covers the batch (the step-up runner
 * asks once and sends the batch again). The merges then run one after another; a later one that conflicts is not
 * merged and comes back as a new decision with its reason.
 */

type ApprovalCard = Extract<OpsItem, { type: 'approval:request' }>;

/** The open, pending merge decisions on the page, by project (only projects with at least two). */
export function mergeGroups(
  cards: readonly OpsItem[],
  open: ReadonlySet<string>,
): readonly { readonly project: string; readonly cards: readonly ApprovalCard[] }[] {
  const by = new Map<string, ApprovalCard[]>();
  for (const c of cards) {
    if (c.type !== 'approval:request' || !open.has(c.id)) continue;
    const a = c.approval;
    if (a.kind !== 'gate' || a.action !== 'git.merge' || a.status !== 'pending') continue;
    by.set(a.project, [...(by.get(a.project) ?? []), c]);
  }
  return [...by.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([project, list]) => ({ project, cards: list }));
}

export function BulkMerges(props: {
  readonly cards: readonly OpsItem[];
  readonly open: ReadonlySet<string>;
  readonly onChanged: (item: OpsItem) => void;
}): ReactNode {
  const w = useT().outputDelivery.bulk;
  const groups = mergeGroups(props.cards, props.open);
  if (groups.length === 0) return null;
  return (
    <section
      aria-label={w.title}
      data-testid="dy-bulk-merges"
      className="grid gap-2 rounded-[14px] border border-dy-line bg-dy-card px-4 py-3 shadow-dy"
    >
      <h3 className="m-0 text-[0.9375rem] font-extrabold">{w.title}</h3>
      {groups.map((g) => (
        <ProjectBatch key={g.project} project={g.project} cards={g.cards} onChanged={props.onChanged} />
      ))}
    </section>
  );
}

function ProjectBatch(props: {
  readonly project: string;
  readonly cards: readonly ApprovalCard[];
  readonly onChanged: (item: OpsItem) => void;
}): ReactNode {
  const w = useT().outputDelivery.bulk;
  const stepUp = useOptionalStepUp();
  const [items, setItems] = useState<readonly MergeBatchItem[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<readonly MergeBatchResult[] | null>(null);
  const open = items !== null;

  const load = (): void => {
    setError(null);
    setResults(null);
    listMergeBatch(props.project).then(
      (list) => {
        setItems(list);
        // Clean or still-checking merges are selected; a known conflict is left for a person to look at.
        setSelected(new Set(list.filter((i) => i.mergeState !== 'conflicts').map((i) => i.id)));
      },
      (err: unknown) => {
        setError(w.loadFailed({ error: err instanceof Error ? err.message : String(err) }));
      },
    );
  };

  const approve = (): void => {
    const ids = (items ?? []).filter((i) => selected.has(i.id)).map((i) => i.id);
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    const send = (): Promise<MergeBatchResult[]> => approveMergeBatch(props.project, ids);
    (stepUp === null ? send() : stepUp.run(send)).then(
      (res) => {
        setBusy(false);
        setResults(res);
        const done = new Set(res.filter((r) => r.outcome === 'approved').map((r) => r.id));
        for (const c of props.cards) {
          if (done.has(c.approval.id))
            props.onChanged({ ...c, approval: { ...c.approval, status: 'approved' } });
        }
      },
      (err: unknown) => {
        setBusy(false);
        if (err instanceof StepUpCancelledError) return;
        setError(w.failed({ error: err instanceof Error ? err.message : String(err) }));
      },
    );
  };

  const stateText = (i: MergeBatchItem): string =>
    i.mergeState === 'clean'
      ? w.state.clean
      : i.mergeState === 'conflicts'
        ? w.state.conflicts({ n: i.conflictFiles })
        : i.mergeState === 'base_moved'
          ? w.state.base_moved
          : w.state.unknown;
  const resultOf = new Map((results ?? []).map((r) => [r.id, r]));
  const approved = (results ?? []).filter((r) => r.outcome !== 'refused').length;
  const refused = (results ?? []).filter((r) => r.outcome === 'refused').length;

  return (
    <div className="grid gap-2 border-t border-dy-line pt-2 first-of-type:border-t-0 first-of-type:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[0.875rem]">
          {w.project({ project: props.project, n: items?.length ?? props.cards.length })}
        </span>
        <DyButton
          variant="ghost"
          onClick={() => {
            if (open) {
              setItems(null);
              setResults(null);
            } else load();
          }}
          aria-expanded={open}
          data-testid="dy-bulk-merges-open"
        >
          {open ? w.close : w.open}
        </DyButton>
      </div>
      {items === null ? null : (
        <>
          <p className="m-0 text-[0.78125rem] text-dy-muted">{w.hint}</p>
          <div className="flex flex-wrap gap-1.5">
            <DyButton
              variant="ghost"
              onClick={() => {
                setSelected(new Set(items.map((i) => i.id)));
              }}
            >
              {w.all}
            </DyButton>
            <DyButton
              variant="ghost"
              onClick={() => {
                setSelected(new Set());
              }}
            >
              {w.none}
            </DyButton>
          </div>
          <ul className="m-0 grid list-none gap-1 p-0" data-testid="dy-bulk-merges-list">
            {items.map((i) => {
              const r = resultOf.get(i.id);
              return (
                <li key={i.id} className="flex flex-wrap items-start gap-2 text-[0.875rem]">
                  <input
                    id={`bulk-${i.id}`}
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(i.id)}
                    disabled={busy || r !== undefined}
                    onChange={(ev) => {
                      const next = new Set(selected);
                      if (ev.target.checked) next.add(i.id);
                      else next.delete(i.id);
                      setSelected(next);
                    }}
                  />
                  <label htmlFor={`bulk-${i.id}`} className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    {i.title ?? w.untitled}
                    <span
                      className={cx(
                        'ml-2 text-[0.78125rem]',
                        i.mergeState === 'conflicts' || i.mergeState === 'base_moved'
                          ? 'text-dy-red-ink'
                          : 'text-dy-muted',
                      )}
                    >
                      {stateText(i)}
                      {i.files === null ? '' : ` · ${w.files({ n: i.files })}`}
                    </span>
                    {r === undefined ? null : (
                      <span
                        className={cx(
                          'block text-[0.78125rem]',
                          r.outcome === 'refused' ? 'text-dy-red-ink' : 'text-dy-green',
                        )}
                        data-testid="dy-bulk-merges-result"
                      >
                        {r.outcome === 'approved'
                          ? w.result.approved
                          : r.outcome === 'pending'
                            ? w.result.pending
                            : w.result.refused({ reason: r.message ?? r.code ?? '' })}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
          {results === null ? (
            <DyButton
              variant="primary"
              busy={busy}
              disabled={busy || selected.size === 0}
              onClick={approve}
              data-testid="dy-bulk-merges-approve"
            >
              {busy ? w.busy : w.approve({ n: selected.size })}
            </DyButton>
          ) : (
            <p role="status" className="m-0 text-[0.875rem]" data-testid="dy-bulk-merges-summary">
              {w.summary({ approved, refused })}
            </p>
          )}
        </>
      )}
      {error === null ? null : (
        <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
          {error}
        </p>
      )}
    </div>
  );
}
