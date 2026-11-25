import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  type FleetAction,
  type FleetTools,
  itemOfTool,
  type MatrixCell,
  startFleetAction,
} from '../../../../api/fleetTools';
import type { ToolEntry, ToolInventory } from '../../../../api/machineAdmin';
import { cx } from '../../../../components/ui';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyIcon } from '../../../icons';
import { DyApiError } from '../../forms';
import { DyButton, EmptyLine, Pill, Rows } from '../../parts';
import {
  ActionStateWord,
  ActionTargets,
  catalogOf,
  cellOf,
  countsText,
  FLEET_TOOLS_PATH,
  isUpdate,
  StatusChip,
  stepUpWhy,
  useFleetWords,
  useActionPoll,
} from '../fleet-tools-parts';
import { useGuarded } from './config-shared';
import { useT } from '../../../../i18n/I18nProvider';

/**
 * p13-fleet-tools — Makine → Araçlar, the inventory part (the system's and the worker's installs
 * were one confusing list): first "Etkin", one row per tool saying which install jobs use (the worker's
 * `effective` list when reported, else computed here: a found worker install wins over a found system one, the last
 * worker entry wins) and which one is shadowed, with the version status from the fleet view and its Güncelle / Kur;
 * then the two lists as tabs — "Sistem" (found on the machine's PATH / OS) and "Worker’ın kurdukları" (custom tools
 * marked "özel") — with the found / not found / update filter. Without the fleet view (an older master) versions
 * are simply not shown.
 */

type Source = 'config' | 'managed' | 'system';

export interface EffectiveRow {
  readonly name: string;
  readonly custom: boolean;
  readonly source: Source | null;
  readonly version?: string | undefined;
  readonly path?: string | undefined;
  /** A found install jobs do not use. */
  readonly shadowed: { readonly source: 'managed' | 'system'; readonly version?: string | undefined } | null;
  /** A system entry that was looked for and not found (said next to a worker install). */
  readonly systemMissing: boolean;
}

const isCustom = (t: ToolEntry): boolean => t.details?.custom === true;

/** Which install of each tool jobs use (see the file comment). */
export function effectiveRows(inv: ToolInventory): EffectiveRow[] {
  const names: string[] = [];
  for (const t of inv.tools) if (!names.includes(t.name)) names.push(t.name);
  for (const e of inv.effective ?? []) if (!names.includes(e.name)) names.push(e.name);
  return names.map((name) => {
    const entries = inv.tools.filter((t) => t.name === name);
    const managed = entries.filter((t) => t.source === 'managed' && t.found).at(-1);
    const system = entries.filter((t) => t.source === 'system' && t.found).at(-1);
    const reported = inv.effective?.find((e) => e.name === name);
    const custom = entries.some(isCustom);
    const systemMissing =
      !entries.some((t) => t.source === 'system' && t.found) && entries.some((t) => t.source === 'system');
    let eff: { source: Source; version?: string | undefined; path?: string | undefined } | null;
    if (inv.effective !== undefined) {
      eff =
        reported === undefined
          ? null
          : { source: reported.source, version: reported.version, path: reported.path };
    } else {
      const pick = managed ?? system;
      eff = pick === undefined ? null : { source: pick.source, version: pick.version, path: pick.path };
    }
    const other =
      eff === null
        ? null
        : eff.source === 'managed'
          ? system
          : eff.source === 'system'
            ? managed
            : (managed ?? system);
    return {
      name,
      custom,
      source: eff?.source ?? null,
      version: eff?.version,
      path: eff?.path,
      shadowed:
        other === undefined || other === null ? null : { source: other.source, version: other.version },
      systemMissing,
    };
  });
}

const mono = (v: string): ReactNode => <span className="font-dy-mono">{v}</span>;

type Filter = 'all' | 'found' | 'missing' | 'updates';
type Tab = 'system' | 'managed';

const FILTERS: readonly Filter[] = ['all', 'found', 'missing', 'updates'];

function cellFor(fleet: FleetTools | null, t: { name: string; custom: boolean }): MatrixCell | undefined {
  return cellOf(fleet, itemOfTool(t.name, t.custom));
}

/** The fleet cell describes this entry when it is the install jobs use. */
function describes(cell: MatrixCell | undefined, t: ToolEntry): boolean {
  if (cell === undefined || !t.found) return false;
  if (cell.source === t.source) return true;
  return cell.installed !== null && cell.installed === t.version;
}

export function ToolsInventory(props: {
  readonly inventory: ToolInventory;
  readonly fleet: FleetTools | null;
  readonly workerId: string;
  readonly workerName: string;
  readonly isAdmin: boolean;
  readonly busy: boolean;
  readonly onFleetDone: () => void;
}): ReactNode {
  const t = useT().machineRuntimes.inventory;
  const parts = useT().fleetTools.parts;
  const words = useFleetWords();
  const { inventory, fleet } = props;
  const [tab, setTab] = useState<Tab>('system');
  const [filter, setFilter] = useState<Filter>('all');
  const [action, setAction] = useState<FleetAction | null>(null);
  const submit = useSubmit();
  const guarded = useGuarded();
  const base = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useActionPoll(action, setAction);
  const finished = action !== null && (action.state === 'done' || action.state === 'cancelled');
  const onFleetDone = props.onFleetDone;
  useEffect(() => {
    if (finished) onFleetDone();
  }, [finished, onFleetDone]);

  const start = useCallback(
    (row: EffectiveRow, cell: MatrixCell): void => {
      const a = cell.action;
      if (a === null) return;
      void submit.run(async () => {
        const started = await guarded(
          () =>
            startFleetAction({
              kind: a.kind,
              item: cell.item,
              version: a.version,
              workers: [props.workerId],
            }),
          stepUpWhy(parts, a.kind, `${props.workerName}: ${row.name} ${a.version}`),
        );
        if (started !== null) setAction(started);
      });
    },
    [submit, guarded, props.workerId, props.workerName, parts],
  );

  const rows = effectiveRows(inventory);
  const system = inventory.tools.filter((t) => t.source === 'system');
  const managed = inventory.tools.filter((t) => t.source === 'managed');
  const list = tab === 'system' ? system : managed;
  const shown = list.filter((e) => {
    if (filter === 'found') return e.found;
    if (filter === 'missing') return !e.found;
    if (filter === 'updates') {
      const c = cellFor(fleet, { name: e.name, custom: isCustom(e) });
      return describes(c, e) && isUpdate(c?.status);
    }
    return true;
  });
  const tabs: readonly (readonly [Tab, string, number])[] = [
    ['system', t.tabSystem, system.length],
    ['managed', t.tabManaged, managed.length],
  ];

  return (
    <div className="flex flex-col">
      {action !== null ? (
        <div
          className="mx-4 mb-3 rounded-[10px] border border-dy-line px-3.5 py-2.5"
          aria-live="polite"
          data-testid="tool-fleet-action"
        >
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <ActionStateWord action={action} />
            <span className="text-[0.8125rem] text-dy-muted">{countsText(action, parts, words)}</span>
            <Link
              to={FLEET_TOOLS_PATH}
              className="ml-auto text-[0.8125rem] font-medium text-dy-teal-ink no-underline hover:underline"
            >
              {t.watch}
            </Link>
          </div>
          <ActionTargets targets={action.targets} />
        </div>
      ) : null}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />

      <h3 className="m-0 px-4 pt-1 pb-1 text-[0.875rem] font-bold">{t.effective}</h3>
      <p className="m-0 px-4 pb-1 text-[0.8125rem] text-dy-muted">{t.effectiveHint}</p>
      <Rows label={t.effectiveList} testId="tool-inventory">
        {rows.map((r) => {
          const cell = cellFor(fleet, r);
          const cat = cell === undefined ? undefined : catalogOf(fleet, cell.item);
          const installs = cell?.installed === null || cell?.installed === undefined;
          const verb = installs ? t.install : t.update;
          return (
            <li
              key={r.name}
              data-testid="tool-row"
              data-tool={r.name}
              data-source={r.source ?? 'none'}
              className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1.5 border-t border-dy-line px-4 py-2.5 first:border-t-0"
            >
              <DyIcon
                name={r.source === null ? 'xc' : 'checkc'}
                className={cx(
                  'mt-0.5 size-4 shrink-0',
                  r.source === null ? 'text-dy-faint' : 'text-dy-green',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={cx('font-medium', r.source === null && 'text-dy-muted')}>{r.name}</span>
                  {r.custom ? <Pill tone="violet">{t.custom}</Pill> : null}
                  {cell === undefined ? null : <StatusChip status={cell.status} />}
                </div>
                <p
                  className="m-0 mt-0.5 flex flex-wrap gap-x-1.5 text-[0.8125rem] text-dy-muted"
                  data-testid="tool-effective"
                >
                  {r.source === null ? (
                    <span>{t.notFound}</span>
                  ) : (
                    <>
                      <span className="text-dy-ink">
                        {t.effectiveLine} {t.effectiveWord[r.source]}{' '}
                        {r.version === undefined ? t.anInstall : mono(r.version)}
                      </span>
                      {r.shadowed !== null ? (
                        <span>
                          · {t.effectiveWord[r.shadowed.source]}{' '}
                          {r.shadowed.version === undefined ? '' : mono(r.shadowed.version)} {t.unused}
                        </span>
                      ) : r.source === 'managed' && r.systemMissing ? (
                        <span>· {t.systemMissing}</span>
                      ) : null}
                    </>
                  )}
                </p>
                {cell === undefined ? null : (
                  <p className="m-0 mt-0.5 flex flex-wrap gap-x-2.5 text-[0.78125rem] text-dy-muted">
                    {cell.pinned === null ? null : (
                      <span>
                        {t.pin} {mono(cell.pinned)}
                      </span>
                    )}
                    <span>
                      {t.latest} {cell.latest === null ? words.latest(cat) : mono(cell.latest)}
                    </span>
                    {cell.action === null && cell.blocked !== undefined ? (
                      <span data-testid="tool-blocked">{words.blocked(cell.blocked)}</span>
                    ) : null}
                  </p>
                )}
                {r.path === undefined ? null : (
                  <p className="m-0 mt-0.5 font-dy-mono text-[0.75rem] break-all text-dy-faint">{r.path}</p>
                )}
              </div>
              {props.isAdmin && cell !== undefined && cell.action !== null ? (
                <DyButton
                  variant="secondary"
                  busy={submit.busy}
                  disabled={props.busy || (action !== null && action.state === 'running')}
                  aria-label={t.actionLabel({
                    tool: r.name,
                    version: cell.action.version,
                    install: installs,
                  })}
                  onClick={() => {
                    start(r, cell);
                  }}
                >
                  {verb} <span className="font-dy-mono text-[0.8125rem]">{cell.action.version}</span>
                </DyButton>
              ) : null}
            </li>
          );
        })}
      </Rows>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-dy-line px-4 pt-3 pb-2">
        <div
          role="tablist"
          aria-label={t.source}
          className="flex max-w-full gap-0.5 overflow-x-auto rounded-[10px] border border-dy-line bg-dy-sunk p-[3px]"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End')
              return;
            e.preventDefault();
            const i = tabs.findIndex(([id]) => id === tab);
            const n =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? tabs.length - 1
                  : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            const next = tabs[n];
            if (next === undefined) return;
            setTab(next[0]);
            tabRefs.current[n]?.focus();
          }}
        >
          {tabs.map(([id, label, n], i) => {
            const on = id === tab;
            return (
              <button
                key={id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${base}-${id}`}
                aria-selected={on}
                aria-controls={`${base}-panel`}
                tabIndex={on ? 0 : -1}
                data-testid={`tools-tab-${id}`}
                onClick={() => {
                  setTab(id);
                }}
                className={cx(
                  'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-[7px] px-3 text-[0.84375rem] font-medium whitespace-nowrap',
                  on ? 'bg-dy-card text-dy-ink shadow-dy-seg' : 'text-dy-muted',
                )}
              >
                {label}
                <span
                  className="font-dy-mono text-[0.75rem] text-dy-muted tabular-nums"
                  aria-label={t.entries({ n })}
                >
                  {String(n)}
                </span>
              </button>
            );
          })}
        </div>
        <div
          role="group"
          aria-label={t.filter}
          className="inline-flex flex-wrap rounded-[9px] border border-dy-line bg-dy-sunk p-0.5"
        >
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
              }}
              className={cx(
                'min-h-8 rounded-[7px] px-2.5 text-[0.8125rem] font-medium',
                filter === f ? 'bg-dy-card text-dy-ink shadow-dy-seg' : 'text-dy-muted',
              )}
            >
              {t.filters[f]}
            </button>
          ))}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel`}
        aria-labelledby={`${base}-${tab}`}
        data-testid="tools-tabpanel"
        data-tab={tab}
      >
        {shown.length === 0 ? (
          <EmptyLine>
            {list.length === 0 ? (tab === 'system' ? t.noSystem : t.noManaged) : t.noMatch}
          </EmptyLine>
        ) : (
          <Rows label={tab === 'system' ? t.systemList : t.tabManaged}>
            {shown.map((e, i) => {
              const custom = isCustom(e);
              const cell = cellFor(fleet, { name: e.name, custom });
              const mine = describes(cell, e);
              const cat = cell === undefined ? undefined : catalogOf(fleet, cell.item);
              return (
                <li
                  key={`${e.name}-${String(i)}`}
                  data-testid="tool-entry"
                  data-tool={e.name}
                  data-source={e.source}
                  data-found={e.found}
                  className="grid grid-cols-[22px_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 border-t border-dy-line px-4 py-2.5 first:border-t-0 sm:grid-cols-[22px_minmax(0,12rem)_minmax(0,1fr)_auto]"
                >
                  <DyIcon
                    name={e.found ? 'checkc' : 'xc'}
                    className={`mt-0.5 size-4 ${e.found ? 'text-dy-green' : 'text-dy-faint'}`}
                  />
                  <span
                    className={cx(
                      'flex flex-wrap items-center gap-1.5 font-medium',
                      !e.found && 'text-dy-muted',
                    )}
                  >
                    {e.name}
                    {custom ? <Pill tone="violet">{t.custom}</Pill> : null}
                  </span>
                  <span className="col-start-2 min-w-0 text-[0.8125rem] sm:col-start-auto">
                    <span className="font-dy-mono">
                      {e.found ? (
                        (e.version ?? t.versionUnknown)
                      ) : (
                        <span className="font-sans text-dy-muted">{t.absent}</span>
                      )}
                    </span>
                    {cell !== undefined && mine ? (
                      <span className="ml-2 text-dy-muted">
                        {cell.pinned === null ? '' : `${t.pin} ${cell.pinned} · `}
                        {t.latest} {cell.latest ?? words.latest(cat)}
                      </span>
                    ) : e.found && cell !== undefined && cell.installed !== null ? (
                      <span className="ml-2 text-dy-muted">{t.unused}</span>
                    ) : null}
                    {e.path === undefined ? null : (
                      <span className="block font-dy-mono text-[0.75rem] break-all text-dy-faint">
                        {e.path}
                      </span>
                    )}
                  </span>
                  <span className="col-start-2 sm:col-start-auto">
                    {cell !== undefined && mine ? <StatusChip status={cell.status} /> : null}
                  </span>
                </li>
              );
            })}
          </Rows>
        )}
      </div>
    </div>
  );
}
