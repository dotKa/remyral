import type { ReactNode } from 'react';
import type { WorkerOverview } from '../../../api/fleet';
import {
  orderedWindows,
  type UsageEntry,
  type UsageLevel,
  type UsageWindow,
} from '../../../api/runtimeUsage';
import { useLimitTexts } from '../usage/limitText';
import type { WorkerSummary } from '../../../api/workers';
import { cx } from '../../../components/ui';
import { DyIcon, type IconName } from '../../icons';
import { runtimeCode, RuntimeMark } from '../../RuntimeMark';
import { INK, type Tone } from '../../tone';
import { Meter, Sparkline } from '../parts';
import { useChangeCount } from '../../motionKit';
import type { Formatter, Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../i18n/I18nProvider';

type MachineWords = Messages['machines'];

/**
 * p12-diyalog Faz 4 — Makineler: small pieces shared by the machine list and the machine page. Display only: the
 * rules (which actions a machine has, why it cannot run work, capacity advice) stay in the classic fleet modules.
 */

interface StateLook {
  readonly tone: Tone;
  readonly icon: IconName;
  readonly label: string;
}

type StateKey = keyof MachineWords['state'];

const STATES: Readonly<Record<string, { tone: Tone; icon: IconName; key: StateKey }>> = {
  online: { tone: 'green', icon: 'checkc', key: 'online' },
  busy: { tone: 'teal', icon: 'retry', key: 'busy' },
  updating: { tone: 'violet', icon: 'retry', key: 'updating' },
  draining: { tone: 'amber', icon: 'pause', key: 'draining' },
  offline: { tone: 'red', icon: 'xc', key: 'offline' },
  quarantined: { tone: 'red', icon: 'shield', key: 'quarantined' },
  pending: { tone: 'amber', icon: 'key', key: 'pending' },
  revoked: { tone: 'neutral', icon: 'xc', key: 'revoked' },
};

/** The machine's state look; `t` is `useT().machines`. */
export function machineLook(w: WorkerSummary, t: MachineWords): StateLook {
  const look = (state: string): StateLook => {
    const s = STATES[state];
    return s === undefined
      ? { tone: 'neutral', icon: 'cpu', label: state }
      : { tone: s.tone, icon: s.icon, label: t.state[s.key] };
  };
  if (w.archivedAt !== null) return { tone: 'neutral', icon: 'folder', label: t.state.archived };
  if (w.state !== 'pending' && w.state !== 'quarantined' && w.state !== 'revoked' && !w.connected)
    return look('offline');
  if (w.state === 'online' && w.drainRequestedAt !== null) return look('draining');
  return look(w.state);
}

/** The machine's state as word + icon + tone; `data-testid="worker-state"` keeps the raw state (as classic). */
export function MachineStateMark(props: {
  readonly worker: WorkerSummary;
  readonly className?: string;
}): ReactNode {
  const look = machineLook(props.worker, useT().machines);
  const w = props.worker;
  // p17-panel-motion: a machine that is connecting (waiting to pair, updating) pulses a ring out of its mark; the
  // change to its next state (Hazır, Kapalı …) cross-fades in. The first render stands still.
  const changed = useChangeCount(look.label);
  const connecting = w.archivedAt === null && (w.state === 'pending' || w.state === 'updating');
  return (
    <span
      key={changed}
      data-testid="worker-state"
      data-state={w.archivedAt === null ? w.state : 'archived'}
      className={cx(
        'inline-flex items-center gap-1.5 text-[0.8125rem] font-bold whitespace-nowrap',
        INK[look.tone],
        changed > 0 && 'dy-m-swap',
        props.className,
      )}
    >
      <span className={cx('inline-grid shrink-0 place-items-center rounded-full', connecting && 'dy-m-ping')}>
        <DyIcon
          name={look.icon}
          className={cx('size-[14px] shrink-0', w.state === 'busy' && w.connected && 'dy-breathe')}
        />
      </span>
      {look.label}
    </span>
  );
}

/** Operating system names (the same in every language). */
const OS_NAME: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  linux: 'Linux', // i18n-ignore: product name
  win32: 'Windows', // i18n-ignore: product name
  windows: 'Windows', // i18n-ignore: product name
};

/** "darwin / arm64" → "macOS · arm64"; `unknownOs` is `t.machines.shared.unknownOs`. */
export function platformText(os: string | null, arch: string | null, unknownOs: string): string {
  const o = os === null ? unknownOs : (OS_NAME[os] ?? os);
  return arch === null ? o : `${o} · ${arch}`;
}

export function slotsOf(w: WorkerSummary, o: WorkerOverview | undefined): { used: number; max: number } {
  const auto = o?.capacityMode?.mode === 'auto' ? o.capacityMode.slots : null;
  const max = auto ?? o?.capacity.max ?? Math.max(1, w.runningJobs);
  return { used: o?.capacity.running ?? w.runningJobs, max: Math.max(0, max) };
}

/** Runtimes ready (or allowed degraded) on the machine, as runtime marks. */
export function ReadyRuntimes(props: {
  readonly overview: WorkerOverview | undefined;
  readonly compact?: boolean;
}): ReactNode {
  const t = useT().machines.shared;
  const o = props.overview;
  if (o === undefined) return <span className="text-[0.8125rem] text-dy-faint">—</span>;
  const ready = o.compatibility.filter((c) => c.status === 'ready' || c.status === 'degraded');
  if (ready.length === 0)
    return (
      <span className="text-[0.8125rem] text-dy-muted" data-testid="no-ready-runtime">
        {o.compatibility.some((c) => c.status === 'unverified') ? t.notVerified : t.noReadyRuntime}
      </span>
    );
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1" aria-label={t.readyRuntimes}>
      {ready.map((c) => (
        <span
          key={c.runtime}
          data-runtime={c.runtime}
          className="inline-flex items-center gap-1 text-[0.8125rem]"
        >
          <RuntimeMark runtime={c.runtime} compact={props.compact} />
          {c.status === 'degraded' ? <span className="text-dy-amber-ink">{t.degraded}</span> : null}
        </span>
      ))}
    </span>
  );
}

export const LEVEL_TONE: Readonly<Record<UsageLevel, Tone>> = {
  ok: 'green',
  near: 'amber',
  limited: 'red',
  unknown: 'neutral',
};

const RUNTIME_FILL: Readonly<Record<string, string>> = {
  cc: 'bg-dy-cc',
  cx: 'bg-dy-cx',
  pi: 'bg-dy-pi',
  oc: 'bg-dy-oc',
};
const RUNTIME_INK: Readonly<Record<string, string>> = {
  cc: 'text-dy-cc',
  cx: 'text-dy-cx',
  pi: 'text-dy-pi',
  oc: 'text-dy-oc',
};

const DAY = 24 * 60 * 60_000;

/** The window's usage over the last 24 h (history points, oldest first) — empty when it reported fewer than two. */
export function last24h(w: UsageWindow, now: number): number[] {
  return w.history
    .filter((p) => {
      const t = Date.parse(p.at);
      return !Number.isNaN(t) && t >= now - DAY && t <= now + 60_000;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((p) => p.usedPercent);
}

function sparkSummary(
  name: string,
  pts: readonly number[],
  t: MachineWords['shared'],
  fmt: Formatter,
): string {
  if (pts.length < 2) return t.sparkNone({ name });
  const pct = (v: number): string => fmt.percent(Math.round(v) / 100);
  const first = pts[0] ?? 0;
  const last = pts[pts.length - 1] ?? 0;
  const peak = Math.max(...pts);
  return t.spark({ name, first: pct(first), last: pct(last), peak: pct(peak) });
}

/** One usage window: meter (runtime colour, amber near, red limited, the near threshold marked) + 24 h sparkline. */
export function WindowLine(props: {
  readonly runtime: string;
  readonly window: UsageWindow;
  readonly nearThreshold: number;
  readonly now: number;
}): ReactNode {
  const t = useT().machines.shared;
  const fmt = useFormat();
  const lt = useLimitTexts();
  const { window: w, now } = props;
  const code = runtimeCode(props.runtime);
  const name = lt.windowName(w);
  const reset = w.resetsAt === null ? '' : t.resets({ when: lt.resetText(w.resetsAt, now) });
  const fill =
    w.level === 'limited'
      ? 'bg-dy-red'
      : w.level === 'near'
        ? 'bg-dy-amber'
        : code === null
          ? 'bg-dy-teal'
          : RUNTIME_FILL[code];
  const pts = last24h(w, now);
  return (
    <li
      // p17-ui-polish: the 24 h line stays beside the bar on phones too (smaller) — under each bar it doubled the
      // limit card's height.
      className="grid grid-cols-[minmax(0,1fr)_64px] items-end gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_120px] sm:gap-x-4"
      data-testid="limit-window"
      data-level={w.level}
    >
      <Meter
        label={name}
        value={w.usedPercent}
        text={`${lt.percentText(w.usedPercent)}${reset}`}
        fill={fill}
        mark={props.nearThreshold}
      />
      <Sparkline
        points={pts}
        max={100}
        summary={sparkSummary(name, pts, t, fmt)}
        className="max-sm:h-auto max-sm:w-16"
        stroke={
          w.level === 'limited'
            ? INK.red
            : w.level === 'near'
              ? INK.amber
              : code === null
                ? INK.teal
                : RUNTIME_INK[code]
        }
      />
    </li>
  );
}

/** A runtime login's usage windows on one machine. */
export function EntryWindows(props: {
  readonly entry: UsageEntry;
  readonly nearThreshold: number;
  readonly now: number;
}): ReactNode {
  const t = useT().machines.shared;
  const e = props.entry;
  const windows = orderedWindows(e.windows);
  if (windows.length === 0)
    return (
      <p className="m-0 text-[0.8125rem] text-dy-muted">
        {e.auth === 'api_key' ? t.apiKeyWindows : t.noWindows}
      </p>
    );
  return (
    <ul className="m-0 grid list-none gap-3 p-0">
      {windows.map((w) => (
        <WindowLine
          key={w.id}
          runtime={e.runtime}
          window={w}
          nearThreshold={props.nearThreshold}
          now={props.now}
        />
      ))}
    </ul>
  );
}
