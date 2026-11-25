import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { Plan, PlanEstimate, PlanItem, PlanOwner, PlanUserOp } from '../../api/plans';
import { cx } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { DyIcon } from '../icons';
import { SmoothHeight } from '../motionKit';
import { dependsCycle, PLAN_DEPENDS_MAX, PLAN_PHASES_MAX, planChanges } from './planModel';
import { type PlanConflict, type PlanUndo, UNDO_MS } from './usePlanEditor';

/**
 * p18-plan-mode W3 (docs/design/p18-plan-mode.md §3 "Editing"): the editing parts of the plan panel — the inline
 * rename field, the item editor (title, owner, estimate, project; W4: detail and dependencies), the "+ Madde ekle" row
 * of a phase, "+ Aşama ekle" (W4), the "Geri al" bar after a delete and the merge view of a conflicting edit ("Plan
 * güncellendi — farkları gör"; W4: the person picks which of their operations to apply again). Text only (plan texts
 * are model / person text); touch targets 44 px below `sm`.
 */

const field =
  'min-h-11 w-full rounded-[9px] border border-dy-line-2 bg-dy-card px-2.5 text-base text-dy-ink outline-none focus-visible:border-dy-teal sm:min-h-8 sm:text-[0.8125rem]';
const primary =
  'dy-press inline-flex min-h-11 items-center gap-1.5 rounded-[9px] bg-dy-ink px-3 text-[0.8125rem] font-bold text-dy-card disabled:opacity-50 sm:min-h-8';
const quiet =
  'dy-press inline-flex min-h-11 items-center rounded-[9px] px-2.5 text-[0.8125rem] text-dy-muted sm:min-h-8';

/* ------------------------------------------------------------------ rename */

/** The title as a field: Enter saves, Escape cancels, leaving the field saves a change. */
export function TitleField(props: {
  readonly item: PlanItem;
  readonly onDone: (title: string | null) => void;
}): ReactNode {
  const t = useT().plan.edit;
  const [v, setV] = useState(props.item.title);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    const next = v.trim();
    props.onDone(save && next !== '' && next !== props.item.title ? next : null);
  };
  return (
    <input
      ref={ref}
      value={v}
      maxLength={140}
      aria-label={t.renameLabel({ title: props.item.title })}
      data-testid="plan-item-rename"
      onChange={(e) => {
        setV(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => {
        finish(true);
      }}
      className={cx(field, 'dy-reveal font-bold')}
    />
  );
}

/* ------------------------------------------------------------------ item editor */

const SIZES = ['S', 'M', 'L'] as const;
const OWNERS: readonly PlanOwner[] = ['assistant', 'user', 'job', 'workflow'];

/** The operations that turn `item` into the edited values (only what changed). */
export function editorOps(
  item: PlanItem,
  v: {
    title: string;
    owner: PlanOwner;
    estimate: PlanEstimate | null;
    project: string | null;
    /** W4 (absent: unchanged). */
    detail?: string | undefined;
    dependsOn?: readonly string[] | undefined;
  },
): PlanUserOp[] {
  const ops: PlanUserOp[] = [];
  const title = v.title.trim();
  if (title !== '' && title !== item.title) ops.push({ op: 'rename', key: item.key, title });
  if (v.owner !== item.owner) ops.push({ op: 'set_owner', key: item.key, owner: v.owner });
  if (v.estimate !== item.estimate) ops.push({ op: 'set_estimate', key: item.key, estimate: v.estimate });
  if (v.project !== item.project) ops.push({ op: 'set_project', key: item.key, project: v.project });
  if (v.detail !== undefined) {
    const detail = v.detail.trim() === '' ? null : v.detail.trim();
    if (detail !== item.detail) ops.push({ op: 'detail', key: item.key, detail });
  }
  if (v.dependsOn !== undefined) {
    const same =
      v.dependsOn.length === item.dependsOn.length && v.dependsOn.every((d) => item.dependsOn.includes(d));
    if (!same) ops.push({ op: 'set_depends', key: item.key, dependsOn: [...v.dependsOn] });
  }
  return ops;
}

/** Title, owner, estimate (none / S / M / L / minutes) and — when the plan has projects — the project. */
export function ItemEditor(props: {
  readonly item: PlanItem;
  readonly projects: readonly string[];
  /** W4: the plan's items (the dependency choices; absent: no dependency field). */
  readonly items?: readonly PlanItem[] | undefined;
  readonly onSave: (ops: PlanUserOp[]) => void;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().plan;
  const id = useId();
  const i = props.item;
  const [title, setTitle] = useState(i.title);
  const [owner, setOwner] = useState<PlanOwner>(i.owner);
  const [estimate, setEstimate] = useState<PlanEstimate | null>(
    typeof i.estimate === 'number' || i.estimate === 'S' || i.estimate === 'M' || i.estimate === 'L'
      ? i.estimate
      : null,
  );
  const [project, setProject] = useState<string | null>(i.project);
  const [detail, setDetail] = useState(i.detail ?? '');
  const [deps, setDeps] = useState<readonly string[]>(i.dependsOn);
  const others = (props.items ?? []).filter((x) => x.key !== i.key);
  const cycle = props.items !== undefined && dependsCycle(props.items, i.key, deps);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  const chip = (on: boolean): string =>
    cx(
      'dy-press inline-flex min-h-11 items-center rounded-full border px-3 text-[0.75rem] font-bold sm:min-h-7',
      on ? 'border-dy-teal bg-dy-teal-soft text-dy-teal-ink' : 'border-dy-line-2 text-dy-muted',
    );
  const projects = [...new Set([...props.projects, ...(i.project === null ? [] : [i.project])])];
  return (
    <form
      className="dy-reveal mt-1.5 grid gap-2.5 rounded-[12px] border border-dy-line bg-dy-card p-2.5"
      aria-label={t.edit.editorTitle({ title: i.title })}
      data-testid="plan-item-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (cycle) return;
        props.onSave(
          editorOps(i, {
            title,
            owner,
            estimate,
            project,
            detail,
            ...(props.items === undefined ? {} : { dependsOn: deps }),
          }),
        );
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <label className="grid gap-1 text-[0.75rem] font-bold text-dy-muted" htmlFor={`${id}-title`}>
        {t.edit.titleLabel}
        <input
          ref={first}
          id={`${id}-title`}
          value={title}
          maxLength={140}
          onChange={(e) => {
            setTitle(e.target.value);
          }}
          className={cx(field, 'font-bold')}
        />
      </label>
      <fieldset className="m-0 grid gap-1 border-0 p-0">
        <legend className="mb-1 p-0 text-[0.75rem] font-bold text-dy-muted">{t.edit.owner}</legend>
        <span className="flex flex-wrap gap-1.5">
          {OWNERS.map((o) => (
            <button
              key={o}
              type="button"
              aria-pressed={owner === o}
              className={chip(owner === o)}
              onClick={() => {
                setOwner(o);
              }}
            >
              {t.owners[o]}
            </button>
          ))}
        </span>
      </fieldset>
      <fieldset className="m-0 grid gap-1 border-0 p-0">
        <legend className="mb-1 p-0 text-[0.75rem] font-bold text-dy-muted">{t.edit.estimate}</legend>
        <span className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={estimate === null}
            className={chip(estimate === null)}
            onClick={() => {
              setEstimate(null);
            }}
          >
            {t.edit.noEstimate}
          </button>
          {SIZES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={estimate === s}
              title={t.edit.sizeLabels[s]}
              aria-label={t.edit.sizeLabels[s]}
              className={chip(estimate === s)}
              onClick={() => {
                setEstimate(s);
              }}
            >
              {t.edit.sizes[s]}
            </button>
          ))}
          <label className="inline-flex items-center gap-1 text-[0.75rem] text-dy-muted">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={10080}
              aria-label={t.edit.minutesLabel}
              value={typeof estimate === 'number' ? String(estimate) : ''}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                setEstimate(Number.isFinite(n) && n >= 1 ? Math.min(n, 10080) : null);
              }}
              className={cx(field, 'w-20 font-dy-mono')}
            />
            <span aria-hidden="true">{t.edit.minutesUnit}</span>
          </label>
        </span>
      </fieldset>
      <label className="grid gap-1 text-[0.75rem] font-bold text-dy-muted" htmlFor={`${id}-detail`}>
        {t.edit.detail}
        <textarea
          id={`${id}-detail`}
          value={detail}
          maxLength={1000}
          rows={3}
          placeholder={t.edit.detailPlaceholder}
          data-testid="plan-item-detail"
          onChange={(e) => {
            setDetail(e.target.value);
          }}
          className={cx(field, 'resize-y py-1.5 font-normal')}
        />
      </label>
      {props.items === undefined ? null : (
        <fieldset className="m-0 grid gap-1 border-0 p-0" data-testid="plan-item-depends">
          <legend className="mb-1 p-0 text-[0.75rem] font-bold text-dy-muted">{t.edit.depends}</legend>
          <p id={`${id}-depends-hint`} className="m-0 text-[0.75rem] text-dy-muted">
            {others.length === 0 ? t.edit.dependsNone : t.edit.dependsHint({ max: PLAN_DEPENDS_MAX })}
          </p>
          <span className="grid max-h-40 gap-0.5 overflow-auto">
            {others.map((o) => {
              const on = deps.includes(o.key);
              return (
                <label
                  key={o.key}
                  className="flex min-h-11 items-center gap-2 rounded-[8px] px-1 text-[0.8125rem] sm:min-h-7"
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && deps.length >= PLAN_DEPENDS_MAX}
                    aria-describedby={`${id}-depends-hint`}
                    onChange={() => {
                      setDeps((cur) => (on ? cur.filter((d) => d !== o.key) : [...cur, o.key]));
                    }}
                  />
                  <span className="min-w-0 truncate">{o.title}</span>
                </label>
              );
            })}
          </span>
          {cycle ? (
            <p
              role="alert"
              className="m-0 text-[0.75rem] text-dy-red-ink"
              data-testid="plan-item-depends-cycle"
            >
              {t.edit.dependsCycle}
            </p>
          ) : null}
        </fieldset>
      )}
      {projects.length === 0 ? null : (
        <label className="grid gap-1 text-[0.75rem] font-bold text-dy-muted" htmlFor={`${id}-project`}>
          {t.edit.project}
          <select
            id={`${id}-project`}
            value={project ?? ''}
            onChange={(e) => {
              setProject(e.target.value === '' ? null : e.target.value);
            }}
            className={field}
          >
            <option value="">{t.edit.noProject}</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      )}
      <span className="flex flex-wrap gap-1.5">
        <button type="submit" className={primary} disabled={cycle} data-testid="plan-item-editor-save">
          <DyIcon name="check" className="size-3.5" />
          {t.edit.save}
        </button>
        <button type="button" className={quiet} onClick={props.onClose}>
          {t.edit.cancel}
        </button>
      </span>
    </form>
  );
}

/* ------------------------------------------------------------------ add */

/** "+ Madde ekle" at a phase's end; open: a field — Enter adds and stays for the next one, Escape closes. */
export function AddItemRow(props: {
  readonly phase: number;
  readonly phaseTitle: string;
  /** The last item of the phase (the new one follows it), null for an empty phase. */
  readonly after: string | null;
  readonly full: boolean;
  readonly onAdd: (op: PlanUserOp) => void;
}): ReactNode {
  const t = useT().plan;
  const [open, setOpen] = useState(false);
  const [v, setV] = useState('');
  const [owner, setOwner] = useState<PlanOwner>('assistant');
  const ref = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  const close = (): void => {
    setOpen(false);
    setV('');
    requestAnimationFrame(() => button.current?.focus());
  };
  return (
    <li className="list-none pl-1" data-plan-phase-end={props.phase} data-testid="plan-add-row">
      <SmoothHeight>
        {open ? (
          <form
            className="dy-reveal grid gap-1.5 py-1"
            onSubmit={(e) => {
              e.preventDefault();
              const title = v.trim();
              if (title === '') return;
              props.onAdd({
                op: 'add',
                item: { title, owner },
                phase: props.phase,
                after: props.after,
              });
              setV('');
              ref.current?.focus();
            }}
          >
            <span className="flex min-w-0 gap-1.5">
              <input
                ref={ref}
                value={v}
                maxLength={140}
                placeholder={t.edit.addPlaceholder}
                aria-label={t.edit.addLabel({ phase: props.phaseTitle })}
                data-testid="plan-add-input"
                onChange={(e) => {
                  setV(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    close();
                  }
                }}
                className={cx(field, 'min-w-0 flex-1')}
              />
              <button
                type="submit"
                className={primary}
                disabled={v.trim() === '' || props.full}
                data-testid="plan-add-submit"
              >
                <DyIcon name="plus" className="size-3.5" />
                <span className="sr-only sm:not-sr-only">{t.edit.addSubmit}</span>
              </button>
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <label
                className="flex min-w-0 items-center gap-1.5 text-[0.75rem] text-dy-muted"
                htmlFor={`${id}-owner`}
              >
                <span className="shrink-0">{t.edit.addOwner}</span>
                <select
                  id={`${id}-owner`}
                  value={owner}
                  onChange={(e) => {
                    setOwner(e.target.value as PlanOwner);
                  }}
                  className={cx(field, 'w-auto min-w-0')}
                >
                  {OWNERS.map((o) => (
                    <option key={o} value={o}>
                      {t.owners[o]}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className={quiet} onClick={close}>
                {t.edit.cancel}
              </button>
            </span>
          </form>
        ) : (
          <button
            ref={button}
            type="button"
            disabled={props.full}
            onClick={() => {
              setOpen(true);
            }}
            aria-label={t.edit.addLabel({ phase: props.phaseTitle })}
            className="dy-press flex min-h-11 w-full items-center gap-1.5 rounded-[9px] px-2 text-left text-[0.8125rem] font-bold text-dy-teal-ink disabled:opacity-50 sm:min-h-8 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
            data-testid="plan-add"
          >
            <DyIcon name="plus" className="size-3.5" />
            {t.edit.add}
          </button>
        )}
      </SmoothHeight>
    </li>
  );
}

/* ------------------------------------------------------------------ add a phase (W4) */

/**
 * "+ Aşama ekle" under the last phase (edit mode): the phase's name and its first item (a phase exists through its
 * items) — one `add` one past the last phase. Escape closes; at PLAN_PHASES_MAX phases it is off with the reason.
 */
export function AddPhaseRow(props: {
  /** The new phase's index (the number of phases now). */
  readonly phase: number;
  /** The plan is at its item limit. */
  readonly full: boolean;
  readonly onAdd: (op: PlanUserOp) => void;
}): ReactNode {
  const t = useT().plan;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [item, setItem] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const atMax = props.phase >= PLAN_PHASES_MAX;
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  const close = (): void => {
    setOpen(false);
    setName('');
    setItem('');
    requestAnimationFrame(() => button.current?.focus());
  };
  return (
    <div data-testid="plan-add-phase-row">
      <SmoothHeight>
        {open ? (
          <form
            className="dy-reveal grid gap-1.5 rounded-[12px] border border-dy-line bg-dy-card p-2.5"
            aria-label={t.edit.addPhaseLabel}
            onSubmit={(e) => {
              e.preventDefault();
              const phaseTitle = name.trim();
              const title = item.trim();
              if (phaseTitle === '' || title === '') return;
              props.onAdd({ op: 'add', item: { title }, phase: props.phase, phaseTitle, after: null });
              close();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          >
            <label className="grid gap-1 text-[0.75rem] font-bold text-dy-muted" htmlFor={`${id}-name`}>
              {t.edit.phaseTitle}
              <input
                ref={ref}
                id={`${id}-name`}
                value={name}
                maxLength={80}
                data-testid="plan-add-phase-name"
                onChange={(e) => {
                  setName(e.target.value);
                }}
                className={cx(field, 'font-bold')}
              />
            </label>
            <label className="grid gap-1 text-[0.75rem] font-bold text-dy-muted" htmlFor={`${id}-item`}>
              {t.edit.phaseFirstItem}
              <input
                id={`${id}-item`}
                value={item}
                maxLength={140}
                data-testid="plan-add-phase-item"
                onChange={(e) => {
                  setItem(e.target.value);
                }}
                className={field}
              />
            </label>
            <span className="flex flex-wrap gap-1.5">
              <button
                type="submit"
                className={primary}
                disabled={name.trim() === '' || item.trim() === '' || props.full}
                data-testid="plan-add-phase-submit"
              >
                <DyIcon name="plus" className="size-3.5" />
                {t.edit.addPhaseSubmit}
              </button>
              <button type="button" className={quiet} onClick={close}>
                {t.edit.cancel}
              </button>
            </span>
          </form>
        ) : (
          <button
            ref={button}
            type="button"
            disabled={props.full || atMax}
            title={atMax ? t.edit.phasesFull({ max: PLAN_PHASES_MAX }) : undefined}
            onClick={() => {
              setOpen(true);
            }}
            aria-label={t.edit.addPhaseLabel}
            className="dy-press flex min-h-11 w-full items-center gap-1.5 rounded-[9px] border border-dashed border-dy-line-2 px-2 text-left text-[0.8125rem] font-bold text-dy-teal-ink disabled:opacity-50 sm:min-h-8 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
            data-testid="plan-add-phase"
          >
            <DyIcon name="plus" className="size-3.5" />
            {t.edit.addPhase}
          </button>
        )}
      </SmoothHeight>
    </div>
  );
}

/* ------------------------------------------------------------------ undo */

/**
 * "“X” silindi · Geri al" at the bottom of the panel for UNDO_MS — the countdown pauses while the pointer or the focus
 * is on it (a bar nobody can reach in time does not expire).
 */
export function UndoBar(props: {
  readonly undo: PlanUndo;
  readonly onUndo: () => void;
  readonly onExpire: () => void;
}): ReactNode {
  const t = useT().plan.edit;
  const [paused, setPaused] = useState(false);
  const left = useRef(UNDO_MS);
  const started = useRef(Date.now());
  const { onExpire } = props;
  useEffect(() => {
    left.current = UNDO_MS;
  }, [props.undo.n]);
  useEffect(() => {
    if (paused) return;
    started.current = Date.now();
    const id = window.setTimeout(onExpire, Math.max(0, left.current));
    return () => {
      window.clearTimeout(id);
      left.current -= Date.now() - started.current;
    };
  }, [paused, onExpire, props.undo.n]);
  return (
    <div
      key={props.undo.n}
      className="dy-plan-undo sticky bottom-0 z-[1] mt-1 flex min-w-0 items-center gap-2 overflow-hidden rounded-[12px] border border-dy-line bg-dy-card py-1 pr-1 pl-3 shadow-dy-pop"
      data-testid="plan-undo"
      data-paused={paused ? '' : undefined}
      style={{ '--dy-undo-ms': `${String(UNDO_MS)}ms` } as CSSProperties}
      onPointerEnter={() => {
        setPaused(true);
      }}
      onPointerLeave={() => {
        setPaused(false);
      }}
      onFocus={() => {
        setPaused(true);
      }}
      onBlur={() => {
        setPaused(false);
      }}
    >
      <DyIcon name="trash" className="size-3.5 shrink-0 text-dy-muted" />
      <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
        {t.removed({ title: props.undo.title })}
      </span>
      <button
        type="button"
        onClick={props.onUndo}
        aria-label={t.undoLabel({ title: props.undo.title })}
        className="dy-press inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[9px] px-3 text-[0.8125rem] font-extrabold text-dy-teal-ink sm:min-h-8"
        data-testid="plan-undo-button"
      >
        <DyIcon name="retry" className="size-3.5" />
        {t.undo}
      </button>
      <span className="dy-plan-undo-clock absolute inset-x-0 bottom-0 h-0.5 bg-dy-teal" aria-hidden="true" />
    </div>
  );
}

/* ------------------------------------------------------------------ merge */

/**
 * A conflicting change (409 with the current plan): "Plan güncellendi — farkları gör". The differences between the
 * plan the person saw and the plan as it is (open on request), their own change, and — for an edit — "apply my change
 * again" (against the current plan) or "drop my change".
 */
export function MergeView(props: {
  readonly conflict: PlanConflict;
  readonly current: Plan;
  /** One sentence per operation of the person's edit (same order as `conflict.ops`). */
  readonly yours: readonly string[];
  /** W4: the operations chosen to apply again (every one by default). */
  readonly onReapply: (ops?: readonly PlanUserOp[]) => void;
  readonly onDiscard: () => void;
}): ReactNode {
  const t = useT().plan;
  const [open, setOpen] = useState(false);
  const listId = useId();
  const ops = props.conflict.ops ?? [];
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set(ops.map((_, n) => n)));
  const many = ops.length > 1;
  const changes = planChanges(props.conflict.base, props.current);
  const line = (c: (typeof changes)[number]): string => {
    switch (c.change) {
      case 'added':
        return t.merge.added({ title: c.title });
      case 'removed':
        return t.merge.removed({ title: c.title });
      case 'renamed':
        return t.merge.renamed({ from: c.from ?? '', to: c.to ?? '' });
      case 'moved':
        return t.merge.moved({ title: c.title, from: c.from ?? '', to: c.to ?? '' });
      case 'status':
        return t.merge.status({
          title: c.title,
          status: t.status[(c.to ?? 'pending') as keyof typeof t.status],
        });
      default:
        return t.merge.changed({ title: c.title });
    }
  };
  return (
    <div
      role="status"
      className="dy-reveal grid gap-2 rounded-[12px] border border-dy-amber/40 bg-dy-amber-soft px-3 py-2 text-dy-amber-ink"
      data-testid="plan-conflict"
    >
      <p className="m-0 text-[0.8125rem] font-extrabold">{t.merge.title}</p>
      <p className="m-0 text-[0.8125rem]">{t.merge.body}</p>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOpen(!open);
        }}
        className="dy-press inline-flex min-h-11 items-center gap-1 self-start rounded-[9px] px-1 text-[0.8125rem] font-bold underline sm:min-h-7"
        data-testid="plan-merge-toggle"
      >
        <DyIcon name="chev" className={cx('dy-plan-chev size-3.5', !open && '-rotate-90')} />
        {open ? t.merge.hide : t.merge.show}
      </button>
      <SmoothHeight>
        {open ? (
          <div id={listId} className="grid gap-2 text-dy-ink" data-testid="plan-merge-diff">
            <section className="grid gap-0.5">
              <h4 className="m-0 text-[0.75rem] font-extrabold text-dy-muted uppercase">{t.merge.theirs}</h4>
              {changes.length === 0 ? (
                <p className="m-0 text-[0.8125rem] text-dy-muted">{t.merge.none}</p>
              ) : (
                <ul role="list" className="m-0 grid list-none gap-0.5 p-0">
                  {changes.map((c) => (
                    <li
                      key={`${c.key}:${c.change}`}
                      className={cx(
                        'dy-plan-diff text-[0.8125rem] [overflow-wrap:anywhere]',
                        c.change === 'removed' && 'line-through opacity-50',
                      )}
                      data-change={c.change}
                    >
                      {line(c)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {props.yours.length === 0 ? null : (
              <section className="grid gap-0.5">
                <h4 className="m-0 text-[0.75rem] font-extrabold text-dy-muted uppercase">{t.merge.yours}</h4>
                {many ? <p className="m-0 text-[0.75rem] text-dy-muted">{t.merge.pick}</p> : null}
                <ul role="list" className="m-0 grid list-none gap-0.5 p-0" data-testid="plan-merge-yours">
                  {props.yours.map((y, n) =>
                    // The same sentence can repeat (two renames): its place keys it.
                    many ? (
                      <li key={`${String(n)}:${y}`} className="text-[0.8125rem] [overflow-wrap:anywhere]">
                        <label className="flex min-h-11 items-center gap-2 sm:min-h-7">
                          <input
                            type="checkbox"
                            checked={picked.has(n)}
                            data-testid="plan-merge-pick"
                            onChange={() => {
                              setPicked((cur) => {
                                const next = new Set(cur);
                                if (next.has(n)) next.delete(n);
                                else next.add(n);
                                return next;
                              });
                            }}
                          />
                          <span>{y}</span>
                        </label>
                      </li>
                    ) : (
                      <li key={`${String(n)}:${y}`} className="text-[0.8125rem] [overflow-wrap:anywhere]">
                        {y}
                      </li>
                    ),
                  )}
                </ul>
              </section>
            )}
          </div>
        ) : null}
      </SmoothHeight>
      <span className="flex flex-wrap gap-1.5">
        {props.conflict.ops === null ? (
          <button
            type="button"
            className={primary}
            onClick={props.onDiscard}
            data-testid="plan-merge-dismiss"
          >
            {t.merge.dismiss}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={primary}
              disabled={many && picked.size === 0}
              onClick={() => {
                props.onReapply(many ? ops.filter((_, n) => picked.has(n)) : undefined);
              }}
              data-testid="plan-merge-reapply"
            >
              <DyIcon name="retry" className="size-3.5" />
              {many && picked.size < ops.length
                ? t.merge.reapplySelected({ n: picked.size })
                : t.merge.reapply}
            </button>
            <button
              type="button"
              className={quiet}
              onClick={props.onDiscard}
              data-testid="plan-merge-discard"
            >
              {t.merge.discard}
            </button>
          </>
        )}
      </span>
    </div>
  );
}
