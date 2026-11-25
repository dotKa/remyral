import { createContext, type ReactNode, use, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../../api/client';
import {
  type ActionKind,
  type ActionTarget,
  type CatalogItem,
  type FleetAction,
  type FleetTools,
  getFleetAction,
  getFleetTools,
  isAdminAction,
  type MatrixCell,
  type TargetState,
  type VersionStatus,
} from '../../../api/fleetTools';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';
import { toApiError } from '../../../components/ui';
import { DyIcon, type IconName } from '../../icons';
import { INK, type Tone } from '../../tone';
import { Pill } from '../parts';
import { RuntimeUpdateButtons, UnverifiedBadge } from './fleet-tools-runtime-updates';

/**
 * p13-fleet-tools (docs/design/p13-fleet-tools.md): the pieces the fleet screen (Makineler → Araçlar ve sürümler),
 * Makine → Araçlar, Makine → Runtime’lar, the machine list and Home share — the version status chip, the fleet matrix
 * read (one machine or all), a fleet action's progress (polled every 2 s) and the "N güncelleme" link.
 */

export const FLEET_TOOLS_PATH = '/machines/tools';
export const ACTION_POLL_MS = 2_000;

// ------------------------------------------------------------------------------------------------ words

type Words = Messages['fleetTools']['words'];

const KIND_KEY: Readonly<Record<ActionKind, keyof Words['actionKinds']>> = {
  'tool.install': 'toolInstall',
  'tool.remove': 'toolRemove',
  'runtime.install': 'runtimeInstall',
  'tool.elevated': 'toolElevated',
  'custom.install': 'customInstall',
  'custom.remove': 'customRemove',
};

function known(map: Readonly<Record<string, string>>, id: string): string {
  return Object.hasOwn(map, id) ? (map[id] ?? id) : id;
}

/** The fleet words in the user's language (p14-i18n-screens-b; the classic `api/fleetTools.ts` tables stay). */
export interface FleetWords {
  readonly status: (s: VersionStatus) => string;
  /** `MatrixCell.blocked` codes (unknown: the raw code). */
  readonly blocked: (code: string) => string;
  /** `ActionTarget.reason` codes (unknown: the raw code). */
  readonly reason: (code: string) => string;
  readonly target: (s: TargetState) => string;
  readonly actionKind: (k: ActionKind) => string;
  /** "en son" in words: the version, or why it is unknown. */
  readonly latest: (item: Pick<CatalogItem, 'latest' | 'latestState'> | undefined) => string;
  readonly source: (source: string | null | undefined) => string;
}

export function fleetWords(w: Words): FleetWords {
  return {
    status: (s) => w.status[s],
    blocked: (code) => known(w.blocked, code),
    reason: (code) => known(w.reasons, code),
    target: (s) => w.targetStates[s],
    actionKind: (k) => w.actionKinds[KIND_KEY[k]],
    latest: (item) => {
      if (item === undefined) return '—';
      if (item.latestState === 'failed') return w.latestFailed;
      if (item.latestState === 'unchecked') return w.latestUnchecked;
      return item.latest ?? '—';
    },
    source: (source) => {
      if (source === null || source === undefined) return '';
      return source === 'path' ? 'PATH' : known(w.sources, source);
    },
  };
}

export function useFleetWords(): FleetWords {
  return fleetWords(useT().fleetTools.words);
}

// ------------------------------------------------------------------------------------------------ data

export interface FleetToolsState {
  readonly data: FleetTools | null;
  readonly error: ApiError | null;
  readonly reload: () => Promise<void>;
  readonly setData: (d: FleetTools) => void;
}

/** `GET /fleet/tools` (narrowed to one machine with `worker`); errors are kept, never thrown. */
export function useFleetTools(worker?: string, enabled = true): FleetToolsState {
  const [data, setData] = useState<FleetTools | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await getFleetTools(worker));
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  }, [worker]);
  useEffect(() => {
    if (enabled) void reload();
  }, [reload, enabled]);
  return { data, error, reload, setData };
}

/** The cell of `item` on the (only / given) machine of a fleet read. */
export function cellOf(data: FleetTools | null, item: string, workerId?: string): MatrixCell | undefined {
  if (data === null) return undefined;
  const m = workerId === undefined ? data.machines[0] : data.machines.find((x) => x.workerId === workerId);
  return m?.cells.find((c) => c.item === item);
}

export function catalogOf(data: FleetTools | null, item: string): CatalogItem | undefined {
  return data?.catalog.find((c) => c.id === item);
}

// ------------------------------------------------------------------------------------------------ status chip

const STATUS_LOOK: Readonly<Record<VersionStatus, { tone: Tone; icon: IconName; outline?: boolean }>> = {
  current: { tone: 'green', icon: 'checkc' },
  update_available: { tone: 'amber', icon: 'retry' },
  pin_differs: { tone: 'amber', icon: 'flag', outline: true },
  not_found: { tone: 'neutral', icon: 'xc' },
  unknown: { tone: 'neutral', icon: 'clock' },
};

/** güncel / güncelleme var / pin’den farklı / bulunamadı — word + icon + tone (colour never alone). */
export function StatusChip(props: {
  readonly status: VersionStatus;
  readonly className?: string;
}): ReactNode {
  const look = STATUS_LOOK[props.status];
  const words = useFleetWords();
  return (
    <span data-testid="version-status" data-status={props.status} className={props.className}>
      <Pill
        tone={look.tone}
        icon={look.icon}
        className={look.outline === true ? 'bg-transparent ring-1 ring-dy-amber/60 ring-inset' : undefined}
      >
        {words.status(props.status)}
      </Pill>
    </span>
  );
}

export const isUpdate = (s: VersionStatus | undefined): boolean =>
  s === 'update_available' || s === 'pin_differs';

const mono = (v: string): ReactNode => <span className="font-dy-mono text-dy-ink">{v}</span>;

/** "Kurulu X · pin Y · en son Z" + the chip (one runtime / tool on one machine). */
export function VersionFacts(props: {
  readonly cell: MatrixCell;
  readonly catalog: CatalogItem | undefined;
  readonly installedLabel?: string;
  readonly testId?: string;
}): ReactNode {
  const { cell } = props;
  const t = useT().fleetTools.parts;
  const words = useFleetWords();
  const latest = cell.latest ?? null;
  const latestWord =
    latest !== null ? latest : words.latest(props.catalog ?? { latest: null, latestState: 'none' as const });
  return (
    <span
      className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8125rem] text-dy-muted"
      data-testid={props.testId}
    >
      <span>
        {props.installedLabel ?? t.installed} {cell.installed === null ? '—' : mono(cell.installed)}
      </span>
      {cell.pinned === null ? null : (
        <span>
          {t.pin} {mono(cell.pinned)}
        </span>
      )}
      <span>
        {t.latest} {latest === null ? latestWord : mono(latestWord)}
      </span>
      <StatusChip status={cell.status} />
    </span>
  );
}

// ------------------------------------------------------------------------------------------------ machine context

const FleetCellsContext = createContext<FleetTools | null>(null);

/** Makine → Runtime’lar: one fleet read for the machine, shared by every runtime row. */
export function FleetCellsProvider(props: {
  readonly workerId: string;
  readonly children: ReactNode;
}): ReactNode {
  const { data } = useFleetTools(props.workerId);
  return <FleetCellsContext value={data}>{props.children}</FleetCellsContext>;
}

/**
 * The version line of one runtime row (nothing when the master has no fleet view or no cell); p16-runtime-updates:
 * the "Doğrulanmamış sürüm (pin: X)" badge and — `manage` (owners / admins on an operable machine) — "Doğrulanmamış
 * olarak kur (Y)" / "Pin’e geri dön (X)".
 */
export function FleetVersionLine(props: {
  readonly item: string;
  readonly manage?: { readonly workerId: string; readonly workerName: string } | undefined;
}): ReactNode {
  const data = use(FleetCellsContext);
  const cell = cellOf(data, props.item);
  if (cell === undefined) return null;
  return (
    <div className="mt-1 flex min-w-0 flex-col gap-2">
      <span className="flex flex-wrap items-center gap-2">
        <VersionFacts cell={cell} catalog={catalogOf(data, props.item)} testId="runtime-version-line" />
        <UnverifiedBadge cell={cell} />
      </span>
      {props.manage === undefined ? null : (
        <RuntimeUpdateButtons
          cell={cell}
          workerId={props.manage.workerId}
          workerName={props.manage.workerName}
          data={data}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ actions

/** Step-up reason: admin kinds always ask for a new code. */
export function stepUpWhy(t: Messages['fleetTools']['parts'], kind: ActionKind, what: string): string {
  return isAdminAction(kind) ? t.stepUpAdmin({ what }) : t.stepUp({ what });
}

export const actionLive = (a: FleetAction): boolean => a.state === 'running';

/** Polls one fleet action every 2 s until it is done / cancelled. */
export function useActionPoll(action: FleetAction | null, set: (a: FleetAction) => void): void {
  useEffect(() => {
    if (action === null || action.state === 'done' || action.state === 'cancelled') return;
    let live = true;
    const timer = setTimeout(() => {
      getFleetAction(action.id).then(
        (next) => {
          if (live) set(next);
        },
        () => undefined,
      );
    }, ACTION_POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [action, set]);
}

const TARGET_TONE: Readonly<Record<TargetState, Tone>> = {
  queued: 'neutral',
  held: 'amber',
  sent: 'teal',
  running: 'teal',
  succeeded: 'green',
  failed: 'red',
  skipped: 'neutral',
  expired: 'neutral',
  cancelled: 'neutral',
};

const TARGET_ICON: Readonly<Record<TargetState, IconName>> = {
  queued: 'clock',
  held: 'pause',
  sent: 'send',
  running: 'retry',
  succeeded: 'checkc',
  failed: 'xc',
  skipped: 'xc',
  expired: 'clock',
  cancelled: 'xc',
};

export function TargetStatePill(props: { readonly state: TargetState }): ReactNode {
  const words = useFleetWords();
  return (
    <span data-testid="target-state" data-state={props.state}>
      <Pill tone={TARGET_TONE[props.state]} icon={TARGET_ICON[props.state]}>
        {words.target(props.state)}
      </Pill>
    </span>
  );
}

const ACTION_STATE: Readonly<Record<FleetAction['state'], { tone: Tone; icon: IconName }>> = {
  running: { tone: 'teal', icon: 'retry' },
  held: { tone: 'amber', icon: 'pause' },
  done: { tone: 'green', icon: 'checkc' },
  cancelled: { tone: 'neutral', icon: 'xc' },
};

export function ActionStateWord(props: { readonly action: FleetAction }): ReactNode {
  const look = ACTION_STATE[props.action.state];
  const t = useT().fleetTools.parts;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[0.8125rem] font-bold ${INK[look.tone]}`}
      data-testid="action-state"
      data-state={props.action.state}
    >
      <DyIcon name={look.icon} className={`size-4 ${props.action.state === 'running' ? 'dy-breathe' : ''}`} />
      {t.actionStates[props.action.state]}
    </span>
  );
}

/** "3 başarılı · 1 sırada" from the action's counts. */
export function countsText(a: FleetAction, t: Messages['fleetTools']['parts'], words: FleetWords): string {
  const order: TargetState[] = [
    'succeeded',
    'failed',
    'running',
    'sent',
    'queued',
    'held',
    'skipped',
    'expired',
    'cancelled',
  ];
  return order
    .filter((s) => (a.counts[s] ?? 0) > 0)
    .map((s) => t.count({ n: a.counts[s] ?? 0, state: words.target(s) }))
    .join(' · ');
}

/** One row per machine: name, phase, state, version, reason (Turkish) + detail, the job link. */
export function ActionTargets(props: { readonly targets: readonly ActionTarget[] }): ReactNode {
  const t = useT().fleetTools.parts;
  const words = useFleetWords();
  return (
    <ul className="m-0 grid list-none gap-0 p-0" aria-label={t.machines}>
      {props.targets.map((x) => (
        <li
          key={x.workerId}
          data-testid="action-target"
          data-worker={x.workerId}
          className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-dy-line py-2 text-[0.84375rem] first:border-t-0"
        >
          <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{x.name}</span>
          {x.phase === 1 ? <Pill tone="violet">{t.canary}</Pill> : null}
          <TargetStatePill state={x.state} />
          {x.version === null ? null : <span className="font-dy-mono text-[0.8125rem]">{x.version}</span>}
          {x.attempts > 1 ? <span className="text-dy-muted">{t.attempt({ n: x.attempts })}</span> : null}
          {x.jobId === null ? null : (
            <Link
              to={`/jobs/${encodeURIComponent(x.jobId)}`}
              className="font-medium text-dy-teal-ink no-underline hover:underline"
            >
              {t.openJob}
            </Link>
          )}
          {x.reason === null && x.detail === null ? null : (
            <span className="min-w-0 basis-full text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
              {x.reason === null ? null : (
                <span className="text-dy-ink" data-testid="target-reason">
                  {words.reason(x.reason)}
                </span>
              )}
              {x.reason !== null && x.detail !== null ? ' — ' : null}
              {x.detail === null ? null : <span lang="en">{x.detail}</span>}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------------------------------------ links

/**
 * Makineler → "Araçlar ve sürümler" (a button with the "N güncelleme" badge) and the small Home link (only when there
 * are updates). One fleet read; errors (an older master, a viewer without access) are silent.
 */
export function FleetToolsLink(props: { readonly variant: 'button' | 'home' }): ReactNode {
  const { data } = useFleetTools();
  const t = useT().fleetTools.parts;
  const updates = data?.summary.updates ?? 0;
  const badge =
    updates > 0 ? (
      <span
        className="rounded-full bg-dy-amber-soft px-1.5 font-dy-mono text-[0.75rem] font-bold text-dy-amber-ink tabular-nums"
        data-testid="fleet-updates-badge"
      >
        {t.updates({ n: updates })}
      </span>
    ) : null;
  if (props.variant === 'home') {
    if (updates === 0) return null;
    return (
      <Link
        to={FLEET_TOOLS_PATH}
        data-testid="home-fleet-updates"
        aria-label={t.homeLink({ n: updates })}
        className="inline-flex min-h-8 items-center rounded-lg text-[0.8125rem] no-underline"
      >
        {badge}
      </Link>
    );
  }
  return (
    <Link
      to={FLEET_TOOLS_PATH}
      data-testid="fleet-tools-link"
      className="dy-press inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] font-medium whitespace-nowrap text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink"
    >
      <DyIcon name="gear" className="size-4" />
      {t.link}
      {badge}
    </Link>
  );
}
