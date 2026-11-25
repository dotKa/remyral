import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { editPlanItems, parsePlan, type Plan, type PlanItem, type PlanUserOp } from '../../api/plans';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { applyLocal, editSentence } from './planModel';
import { putPlan } from './planStore';

/**
 * p18-plan-mode W3 (docs/design/p18-plan-mode.md §3 "Editing"): the person's edits of the plan panel.
 *
 *  - Every edit is a batch of operations sent with the revision the person saw (`baseRev`). Batches go one at a time;
 *    the panel shows them at once (optimistic, `applyLocal`) and the master's answer replaces that.
 *  - A batch made while an earlier one was on its way is based on the revision that earlier batch produced — but only
 *    when nothing else changed the plan meanwhile; then it is a real conflict: 409 `plan_rev_conflict` with the current
 *    plan, and the merge view offers to apply the person's change again or to drop it.
 *  - A deleted item can be brought back for UNDO_MS ("Geri al": the `restore` operation).
 *  - Each edit is said in the polite live region at once.
 */

/** How long "Geri al" stays after a delete. */
export const UNDO_MS = 6_000;

interface Batch {
  readonly ops: readonly PlanUserOp[];
  /** The plan as the person saw it when they made the edit (the merge view's "before"). */
  readonly seen: Plan;
}

export interface PlanConflict {
  /** The plan the person's edit was based on. */
  readonly base: Plan;
  /** Their operations (null: an approval / action, nothing to apply again). */
  readonly ops: readonly PlanUserOp[] | null;
}

export interface PlanUndo {
  readonly key: string;
  readonly title: string;
  /** Bumped per delete (the bar restarts its countdown). */
  readonly n: number;
}

export interface PlanEditor {
  /** The plan to show: the stored one with the edits on their way applied. */
  readonly plan: Plan;
  readonly saving: boolean;
  readonly error: string | null;
  readonly conflict: PlanConflict | null;
  readonly undo: PlanUndo | null;
  /** The live-region sentence of the latest edit. */
  readonly said: string;
  readonly edit: (ops: readonly PlanUserOp[]) => void;
  readonly say: (text: string) => void;
  readonly undoNow: () => void;
  readonly dismissUndo: () => void;
  /** Applies the conflicting edit again — W4: only `ops` when given (the person's choice in the merge view). */
  readonly reapply: (ops?: readonly PlanUserOp[]) => void;
  readonly discard: () => void;
  /** An approval / action answered 409 with the current plan: the merge view without operations. */
  readonly showConflict: (base: Plan) => void;
  readonly clear: () => void;
  /** Items deleted here (an undo shows them back before the master answers). */
  readonly removed: ReadonlyMap<string, PlanItem>;
}

export function usePlanEditor(plan: Plan, threadId: string): PlanEditor {
  const t = useT().plan;
  const sayError = useErrorText();
  const queue = useRef<Batch[]>([]);
  const inflight = useRef<Batch | null>(null);
  /** The revision the batch on its way was sent at. */
  const sentAt = useRef(0);
  /** baseRev → the revision our own batch made from it (a later batch seen at baseRev is based on that). */
  const own = useRef(new Map<number, number>());
  const removed = useRef(new Map<string, PlanItem>());
  const latest = useRef(plan);
  latest.current = plan;
  const [, setTick] = useState(0);
  const rerender = useCallback(() => {
    setTick((n) => n + 1);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<PlanConflict | null>(null);
  const [undo, setUndo] = useState<PlanUndo | null>(null);
  const [said, setSaid] = useState('');
  const flip = useRef(false);
  const undoN = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const say = useCallback((text: string) => {
    // The same sentence twice is still announced (a zero-width mark alternates).
    flip.current = !flip.current;
    setSaid(flip.current ? text : `${text}\u200b`);
  }, []);

  const pump = useCallback(() => {
    if (inflight.current !== null) return;
    const next = queue.current.shift();
    if (next === undefined) return;
    inflight.current = next;
    let base = next.seen.rev;
    for (let guard = 0; own.current.has(base) && guard < 50; guard++) base = own.current.get(base) ?? base;
    sentAt.current = base;
    editPlanItems(plan.id, base, next.ops).then(
      (out) => {
        own.current.set(base, out.rev);
        inflight.current = null;
        putPlan(threadId, out);
        if (alive.current) rerender();
        pump();
      },
      (err: unknown) => {
        inflight.current = null;
        const cur = err instanceof ApiError ? parsePlan(err.details.plan) : null;
        if (cur !== null && err instanceof ApiError && err.code === 'plan_rev_conflict') {
          // Everything still waiting was made on the same view: it joins the edit to apply again.
          const ops = [...next.ops, ...queue.current.flatMap((b) => b.ops)];
          queue.current = [];
          putPlan(threadId, cur);
          if (!alive.current) return;
          setConflict({ base: next.seen, ops });
          setUndo(null);
          say(t.edit.live.conflict);
          rerender();
          return;
        }
        if (cur !== null) putPlan(threadId, cur);
        if (!alive.current) return;
        // A delete that did not happen has nothing to undo.
        const gone = new Set(next.ops.flatMap((o) => (o.op === 'remove' ? [o.key] : [])));
        setUndo((u) => (u !== null && gone.has(u.key) ? null : u));
        setError(sayError(err));
        rerender();
        pump();
      },
    );
  }, [plan.id, threadId, rerender, say, sayError, t]);

  const edit = useCallback(
    (ops: readonly PlanUserOp[]) => {
      if (ops.length === 0) return;
      const seen = applyLocal(latest.current, pendingOps(), { removed: removed.current });
      for (const op of ops) {
        if (op.op !== 'remove') continue;
        const item = seen.items.find((i) => i.key === op.key);
        if (item === undefined) continue;
        removed.current.set(op.key, item);
        undoN.current++;
        setUndo({ key: op.key, title: item.title, n: undoN.current });
      }
      setError(null);
      const first = ops[0];
      if (first !== undefined) say(editSentence(first, seen, t, removed.current));
      queue.current.push({ ops, seen: latest.current });
      rerender();
      pump();
    },
    // pendingOps reads refs only.
    [pump, rerender, say, t],
  );

  function pendingOps(): PlanUserOp[] {
    // The plan already moved past the revision the batch was sent at (its own change arrived on the stream first, or
    // someone else's — then a 409 follows): it is not applied twice.
    const sent =
      inflight.current !== null && latest.current.rev <= sentAt.current ? inflight.current.ops : [];
    return [...sent, ...queue.current.flatMap((b) => b.ops)];
  }

  const shown = applyLocal(plan, pendingOps(), { removed: removed.current });

  return {
    plan: shown,
    saving: inflight.current !== null || queue.current.length > 0,
    error,
    conflict,
    undo,
    said,
    edit,
    say,
    undoNow: () => {
      if (undo === null) return;
      setUndo(null);
      edit([{ op: 'restore', key: undo.key }]);
    },
    dismissUndo: () => {
      setUndo(null);
    },
    reapply: (ops?: readonly PlanUserOp[]) => {
      const c = conflict;
      setConflict(null);
      const chosen = ops ?? c?.ops ?? null;
      if (chosen !== null && chosen.length > 0) edit(chosen);
    },
    discard: () => {
      setConflict(null);
    },
    showConflict: (base: Plan) => {
      setConflict({ base, ops: null });
    },
    clear: () => {
      setError(null);
      setConflict(null);
    },
    removed: removed.current,
  };
}
