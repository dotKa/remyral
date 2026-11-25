import {
  BUILTIN_RUNTIME_MODEL_CATALOG,
  modelIdIssue,
  RUNTIME_MODEL_CATALOG_VERSION,
} from '@remyral/protocol/runtime-models';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ModelRuntime } from '../../../api/models';
import {
  getRuntimeModels,
  type RuntimeCatalog,
  type RuntimeModel,
  type RuntimeModels,
} from '../../../api/runtimeModels';
import { cx } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { DyFloatingList } from '../../Popover';

/**
 * p15-model-picker (docs/design/p15-model-picker.md §5): the one model field of the Diyalog console — a searchable
 * combobox instead of a free-text model name. Options, in order:
 *
 *   1. "Varsayılan (runtime'ın kendi seçimi)" (or the caller's default text) — the empty value;
 *   2. model profiles, when the caller offers them (Settings → Modeller);
 *   3. "Bu makinede mevcut" (with `workerId`: models that machine's runtime listed) or "Makinelerde mevcut" (models any
 *      machine listed);
 *   4. "Katalog" — the rest of the maintained catalog (`GET /models/runtimes`, else the catalog built into this
 *      console when the master cannot be reached);
 *   5. "Özel model adı…" — any id the runtime accepts (validated like every model field before: nothing that worked
 *      typed by hand breaks); a value not in the list is shown with an "Özel" badge.
 *
 * Keyboard: type to filter, ↑/↓ to move, Enter to choose, Escape to close (it does not close an enclosing dialog). The
 * list floats over the page (`DyFloatingList`, p17-ui-batch): inside a modal dialog it renders into that dialog, under
 * the field or flipped above it, so the dialog's own scrolling box never cuts it off.
 */

export type ModelPickKind = 'default' | 'profile' | 'model';

export interface PickerProfile {
  readonly value: string;
  readonly label: string;
  /** e.g. the provider/model it stands for. */
  readonly detail?: string | undefined;
}

// --------------------------------------------------------------------------------------- data (cached per project)

type CatalogState = RuntimeCatalog | 'error' | null;
const cache = new Map<string, Promise<RuntimeCatalog>>();

/** Tests: forget fetched catalogs. */
export function resetRuntimeModelsCache(): void {
  cache.clear();
}

/** The runtime model catalog (all runtimes; the project's own default when `project` is given). */
export function useRuntimeModels(project?: string): CatalogState {
  const key = project ?? '';
  const [state, setState] = useState<CatalogState>(null);
  useEffect(() => {
    let live = true;
    let p = cache.get(key);
    if (p === undefined) {
      p = getRuntimeModels(key === '' ? {} : { project: key });
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    p.then(
      (c) => {
        if (live) setState(c);
      },
      () => {
        if (live) setState('error');
      },
    );
    return () => {
      live = false;
    };
  }, [key]);
  return state;
}

/** The built-in catalog in the API's shape (no machine data): the fallback when the master cannot answer. */
function builtinRuntime(runtime: ModelRuntime): RuntimeModels {
  return {
    runtime,
    models: (BUILTIN_RUNTIME_MODEL_CATALOG.runtimes[runtime] ?? []).map((m) => ({
      ...m,
      inCatalog: true,
      machines: [],
    })),
    machines: [],
    defaults: { global: null, project: null, machines: [] },
  };
}

export function runtimeModelsOf(catalog: CatalogState, runtime: ModelRuntime): RuntimeModels {
  if (catalog !== null && catalog !== 'error') {
    const r = catalog.runtimes.find((x) => x.runtime === runtime);
    if (r !== undefined) return r;
  }
  return builtinRuntime(runtime);
}

// --------------------------------------------------------------------------------------- options

interface Option {
  readonly key: string;
  readonly value: string;
  readonly kind: ModelPickKind | 'custom';
  readonly label: string;
  readonly detail: string | null;
  readonly group: 'default' | 'profiles' | 'here' | 'fleet' | 'catalog' | 'custom';
}

function tokensText(n: number): string {
  return n >= 1_000_000
    ? `${String(Math.round(n / 100_000) / 10)}M`
    : n >= 1000
      ? `${String(Math.round(n / 1000))}K`
      : String(n);
}

export function DyModelPicker(props: {
  readonly label: string;
  /** The runtime(s) whose models are offered (a profile can serve several: their models together). */
  readonly runtimes: readonly ModelRuntime[];
  /** '' = the default. */
  readonly value: string;
  /** Disambiguates a value that is both a profile id and a model id (default: a profile when one matches). */
  readonly valueKind?: 'profile' | 'model' | undefined;
  readonly onChange: (value: string, kind: ModelPickKind) => void;
  /** From {@link useRuntimeModels}; null while loading (the built-in catalog is shown meanwhile). */
  readonly catalog: CatalogState;
  /** The machine this choice is for: its models form "Bu makinede mevcut". */
  readonly workerId?: string | undefined;
  readonly profiles?: readonly PickerProfile[] | undefined;
  /** Text of the default option (default: "Varsayılan (runtime'ın kendi seçimi)"); null = no default option. */
  readonly defaultLabel?: string | null | undefined;
  readonly hint?: ReactNode;
  readonly error?: string | null | undefined;
  readonly disabled?: boolean | undefined;
  readonly testId?: string | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const t = useT().modelPicker;
  const id = useId();
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [custom, setCustom] = useState<string | null>(null);
  const [customTouched, setCustomTouched] = useState(false);

  const runtimes = props.runtimes;
  const views = useMemo(
    () => runtimes.map((r) => runtimeModelsOf(props.catalog, r)),
    [runtimes, props.catalog],
  );

  const all = useMemo((): Option[] => {
    const out: Option[] = [];
    if (props.defaultLabel !== null)
      out.push({
        key: 'default',
        value: '',
        kind: 'default',
        label: props.defaultLabel ?? t.defaultOption,
        detail: null,
        group: 'default',
      });
    for (const p of props.profiles ?? [])
      out.push({
        key: `p:${p.value}`,
        value: p.value,
        kind: 'profile',
        label: p.label,
        detail: p.detail ?? null,
        group: 'profiles',
      });
    const seen = new Set<string>();
    const models: RuntimeModel[] = [];
    for (const v of views)
      for (const m of v.models) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        models.push(m);
      }
    const groupOf = (m: RuntimeModel): Option['group'] =>
      props.workerId !== undefined
        ? m.machines.some((x) => x.workerId === props.workerId)
          ? 'here'
          : 'catalog'
        : m.machines.length > 0
          ? 'fleet'
          : 'catalog';
    const detailOf = (m: RuntimeModel): string | null => {
      const parts: string[] = [];
      if (m.id !== m.displayName) parts.push(m.id);
      if (m.kind === 'alias')
        parts.push(m.resolvesTo === undefined ? t.aliasMoving : t.alias({ to: m.resolvesTo }));
      if (m.contextWindow !== undefined) parts.push(t.context({ tokens: tokensText(m.contextWindow) }));
      if (props.workerId === undefined && m.machines.length > 0)
        parts.push(t.onMachines({ names: m.machines.map((x) => x.workerName).join(', ') }));
      const access = m.machines.find((x) => x.workerId === props.workerId)?.access;
      if (access !== undefined) parts.push(t.access[access]);
      return parts.length === 0 ? null : parts.join(' · ');
    };
    const order: Option['group'][] = ['here', 'fleet', 'catalog'];
    for (const g of order)
      for (const m of models)
        if (groupOf(m) === g)
          out.push({
            key: `m:${m.id}`,
            value: m.id,
            kind: 'model',
            label: m.displayName,
            detail: detailOf(m),
            group: g,
          });
    return out;
  }, [props.defaultLabel, props.profiles, props.workerId, views, t]);

  const selected = useMemo(() => {
    const pool = all.filter((o) => o.value === props.value);
    if (pool.length === 0) return null;
    if (props.valueKind === 'model') return pool.find((o) => o.kind === 'model') ?? pool[0] ?? null;
    if (props.valueKind === 'profile') return pool.find((o) => o.kind === 'profile') ?? pool[0] ?? null;
    return pool[0] ?? null;
  }, [all, props.value, props.valueKind]);
  const isCustomValue = props.value !== '' && selected === null;

  const q = query.trim().toLowerCase();
  const shown = useMemo((): Option[] => {
    const filtered =
      q === ''
        ? all
        : all.filter(
            (o) =>
              o.kind !== 'default' &&
              (o.value.toLowerCase().includes(q) ||
                o.label.toLowerCase().includes(q) ||
                (o.detail ?? '').toLowerCase().includes(q)),
          );
    return [
      ...filtered,
      { key: 'custom', value: '', kind: 'custom', label: t.custom, detail: null, group: 'custom' },
    ];
  }, [all, q, t.custom]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (wrap.current?.contains(target) === true || list.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const choose = (o: Option): void => {
    setOpen(false);
    setQuery('');
    if (o.kind === 'custom') {
      // What was typed into the search becomes the custom id to confirm (else the current custom value).
      setCustom(query.trim() !== '' ? query.trim() : isCustomValue ? props.value : '');
      setCustomTouched(false);
      return;
    }
    props.onChange(o.value, o.kind);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + d + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      const o = shown[active];
      if (o !== undefined) choose(o);
    } else if (e.key === 'Escape') {
      if (!open) return;
      // Only the list closes, never the enclosing dialog.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery('');
    }
  };

  // Notices: machines whose list is missing (older worker) or failed, for the runtimes shown.
  const notices = useMemo(() => {
    const machines = views.flatMap((v) => v.machines);
    const relevant =
      props.workerId === undefined ? machines : machines.filter((m) => m.workerId === props.workerId);
    const old = [...new Set(relevant.filter((m) => !m.supported).map((m) => m.workerName))];
    const failed = relevant.filter((m) => m.source === 'failed');
    return { old, failed };
  }, [views, props.workerId]);

  const display =
    props.value === ''
      ? props.defaultLabel === null
        ? ''
        : (props.defaultLabel ?? t.defaultOption)
      : selected !== null
        ? selected.kind === 'model' && selected.label !== selected.value
          ? `${selected.label} (${selected.value})`
          : selected.label
        : props.value;
  const activeId = open && shown[active] !== undefined ? `${id}-opt-${String(active)}` : undefined;
  const describedBy =
    [props.hint === undefined || props.hint === null ? null : hintId, props.error ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;
  const customIssue = custom === null ? null : modelIdIssue(custom.trim());

  let lastGroup: Option['group'] | null = null;
  return (
    <div ref={wrap} className={cx('relative grid gap-1.5', props.className)} data-testid={props.testId}>
      <label htmlFor={id} className="text-[0.8125rem] font-bold">
        {props.label}
      </label>
      {custom !== null ? (
        <div className="grid gap-1.5" data-testid="model-custom">
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={id}
              type="text"
              value={custom}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={t.customPlaceholder}
              aria-label={t.customLabel}
              aria-invalid={customTouched && customIssue !== null ? true : undefined}
              aria-describedby={`${id}-custom-hint`}
              disabled={props.disabled}
              onChange={(e) => {
                setCustom(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  setCustomTouched(true);
                  if (customIssue === null) {
                    props.onChange(custom.trim(), 'model');
                    setCustom(null);
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setCustom(null);
                }
              }}
              className="min-h-10 min-w-0 flex-1 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 font-dy-mono text-[0.9375rem] text-dy-ink placeholder:text-dy-faint aria-[invalid=true]:border-dy-red sm:min-h-9 sm:text-[0.875rem]"
            />
            <button
              type="button"
              className="dy-press min-h-10 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] font-bold sm:min-h-9"
              onClick={() => {
                setCustomTouched(true);
                if (customIssue === null) {
                  props.onChange(custom.trim(), 'model');
                  setCustom(null);
                }
              }}
            >
              {t.customApply}
            </button>
            <button
              type="button"
              className="dy-press min-h-10 rounded-[9px] px-2 text-[0.875rem] text-dy-teal-ink sm:min-h-9"
              onClick={() => {
                setCustom(null);
              }}
            >
              {t.customBack}
            </button>
          </div>
          <p id={`${id}-custom-hint`} className="m-0 text-[0.78125rem] text-dy-muted">
            {t.customHint}
          </p>
          {customTouched && customIssue !== null ? (
            <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink" role="alert">
              {t.customIssues[customIssue]}
            </p>
          ) : null}
        </div>
      ) : (
        <div ref={field} className="relative">
          <input
            ref={input}
            id={id}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            aria-invalid={props.error ? true : undefined}
            aria-describedby={describedBy}
            autoComplete="off"
            spellCheck={false}
            disabled={props.disabled}
            value={open ? query : display}
            placeholder={open ? t.search : undefined}
            data-testid="model-picker-input"
            onFocus={() => {
              setActive(0);
            }}
            onClick={() => {
              if (!open) {
                setOpen(true);
                setQuery('');
                setActive(0);
              }
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              if (!open) setOpen(true);
            }}
            onKeyDown={onKey}
            className={cx(
              'min-h-10 w-full min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card py-0 pr-20 pl-3 text-[0.9375rem] text-dy-ink placeholder:text-dy-faint aria-[invalid=true]:border-dy-red disabled:opacity-60 sm:min-h-9 sm:text-[0.875rem]',
              props.value !== '' && 'font-dy-mono',
            )}
          />
          {isCustomValue && !open ? (
            <span
              className="pointer-events-none absolute top-1/2 right-8 -translate-y-1/2 rounded-full bg-dy-amber-soft px-2 py-0.5 text-[0.71875rem] font-bold text-dy-amber-ink"
              data-testid="model-custom-badge"
            >
              {t.customBadge}
            </span>
          ) : null}
          <button
            type="button"
            tabIndex={-1}
            aria-label={t.open}
            disabled={props.disabled}
            className="absolute top-1/2 right-1 grid size-8 -translate-y-1/2 place-items-center rounded-[8px] text-dy-muted"
            onClick={() => {
              setOpen((o) => !o);
              setQuery('');
              input.current?.focus();
            }}
          >
            <span aria-hidden="true">▾</span>
          </button>
          {open ? (
            <DyFloatingList
              open
              anchorRef={field}
              listRef={list}
              id={listId}
              role="listbox"
              ariaLabel={props.label}
              testId="model-picker-list"
              contentKey={`${q}:${String(shown.length)}`}
              className="max-h-80 rounded-[12px] border border-dy-line bg-dy-card p-1 text-dy-ink shadow-dy-pop"
            >
              {shown.map((o, i) => {
                const head =
                  o.group !== lastGroup && o.group !== 'default' && o.group !== 'custom' ? (
                    <li
                      key={`g:${o.group}`}
                      role="presentation"
                      className="px-2 pt-2 pb-1 text-[0.71875rem] font-bold tracking-[0.04em] text-dy-muted uppercase"
                      data-testid={`model-group-${o.group}`}
                    >
                      {t.groups[o.group]}
                    </li>
                  ) : null;
                lastGroup = o.group;
                const isSel =
                  o.kind !== 'custom' &&
                  o.value === props.value &&
                  (selected === null || selected.key === o.key);
                return [
                  head,
                  <li
                    key={o.key}
                    id={`${id}-opt-${String(i)}`}
                    role="option"
                    aria-selected={isSel}
                    data-testid={
                      o.kind === 'custom' ? 'model-option-custom' : `model-option-${o.value || 'default'}`
                    }
                    data-group={o.group}
                    onMouseDown={(e) => {
                      e.preventDefault();
                    }}
                    onMouseEnter={() => {
                      setActive(i);
                    }}
                    onClick={() => {
                      choose(o);
                    }}
                    className={cx(
                      'cursor-pointer rounded-[8px] px-2 py-1.5 text-[0.875rem]',
                      i === active && 'bg-dy-sunk',
                      o.kind === 'custom' && 'mt-1 border-t border-dy-line pt-2 font-bold text-dy-teal-ink',
                      isSel && 'font-bold',
                    )}
                  >
                    <span className="block">{o.label}</span>
                    {o.detail === null ? null : (
                      <span className="block font-dy-mono text-[0.75rem] text-dy-muted">{o.detail}</span>
                    )}
                  </li>,
                ];
              })}
              {shown.length === 1 ? (
                <li role="presentation" className="px-2 py-1.5 text-[0.8125rem] text-dy-muted">
                  {t.noMatch}
                </li>
              ) : null}
            </DyFloatingList>
          ) : null}
        </div>
      )}
      {props.hint === undefined || props.hint === null ? null : (
        <p id={hintId} className="m-0 text-[0.78125rem] text-dy-muted">
          {props.hint}
        </p>
      )}
      {isCustomValue && custom === null ? (
        <p className="m-0 text-[0.78125rem] text-dy-amber-ink" data-testid="model-custom-note">
          {t.customHint}
        </p>
      ) : null}
      {notices.old.length > 0 ? (
        <p className="m-0 text-[0.78125rem] text-dy-muted" data-testid="model-update-needed">
          {t.updateNeeded({ names: notices.old.join(', ') })}
        </p>
      ) : null}
      {notices.failed.map((m) => (
        <p key={`${m.workerId}-${m.error ?? ''}`} className="m-0 text-[0.78125rem] text-dy-muted">
          {t.listFailed({ name: m.workerName, error: m.error ?? '' })}
        </p>
      ))}
      {props.catalog === 'error' ? (
        <p className="m-0 text-[0.78125rem] text-dy-muted">{t.loadFailed}</p>
      ) : null}
      {props.error ? (
        <p id={errorId} className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">
          {props.error}
        </p>
      ) : null}
      <span
        hidden
        data-catalog-version={
          props.catalog !== null && props.catalog !== 'error'
            ? props.catalog.catalogVersion
            : RUNTIME_MODEL_CATALOG_VERSION
        }
      />
    </div>
  );
}
