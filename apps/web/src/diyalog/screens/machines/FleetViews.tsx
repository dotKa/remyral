import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { CompatCell, WorkerOverview } from '../../../api/fleet';
import type { QuotaPause } from '../../../api/quotas';
import type { WorkerSummary } from '../../../api/workers';
import { cx } from '../../../components/ui';
import { machinePath } from '../../../screens/fleet/machineLinks';
import { groupByNetwork, RUNTIMES } from '../../../screens/fleet/parts';
import { DyIcon, type IconName } from '../../icons';
import { RuntimeMark, runtimeDisplayName } from '../../RuntimeMark';
import { INK, SOFT, type Tone } from '../../tone';
import { Panel, SlotCells } from '../parts';
import { machineLook, MachineStateMark, platformText, slotsOf } from './shared';
import type { Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3): the machine list's "Ağ haritası" and "Uyumluluk" views in the Diyalog language. Same
 * data and grouping as the classic `NetworkMap` / `CompatMatrix` (screens/fleet/parts.tsx: `groupByNetwork`, the four
 * runtimes, the "why not ready" list); no external tiles, no addresses beyond the master's network label.
 */

// ------------------------------------------------------------------------------------------------ compatibility

interface CompatLook {
  readonly tone: Tone;
  readonly icon: IconName;
  readonly word: string;
}

type CompatWords = Messages['machines']['compat'];
type CompatKey =
  | 'ready'
  | 'degraded'
  | 'unverified'
  | 'notInstalled'
  | 'notAllowed'
  | 'notAuthenticated'
  | 'pinMismatch'
  | 'unsupported'
  | 'unknown';

const COMPAT: Readonly<Record<string, { tone: Tone; icon: IconName; key: CompatKey }>> = {
  ready: { tone: 'green', icon: 'checkc', key: 'ready' },
  degraded: { tone: 'amber', icon: 'shield', key: 'degraded' },
  unverified: { tone: 'amber', icon: 'clock', key: 'unverified' },
  not_installed: { tone: 'neutral', icon: 'plus', key: 'notInstalled' },
  not_allowed: { tone: 'neutral', icon: 'xc', key: 'notAllowed' },
  not_authenticated: { tone: 'amber', icon: 'key', key: 'notAuthenticated' },
  pin_mismatch: { tone: 'amber', icon: 'flag', key: 'pinMismatch' },
  unsupported: { tone: 'neutral', icon: 'xc', key: 'unsupported' },
  unknown: { tone: 'neutral', icon: 'clock', key: 'unknown' },
};

/** A compatibility status as tone + icon + word; `t` is `useT().machines.compat`. */
export function compatLook(status: string, t: CompatWords): CompatLook {
  const c = COMPAT[status];
  return c === undefined
    ? { tone: 'neutral', icon: 'clock', word: status.replaceAll('_', ' ') }
    : { tone: c.tone, icon: c.icon, word: t[c.key] };
}

/** One runtime's status on one machine: icon + word (+ version), the reason as title and for screen readers. */
function CompatBadge(props: { readonly cell: CompatCell; readonly withVersion?: boolean }): ReactNode {
  const c = props.cell;
  const look = compatLook(c.status, useT().machines.compat);
  const version =
    props.withVersion !== false && c.version !== null && c.status !== 'not_installed' ? ` ${c.version}` : '';
  return (
    <span
      title={c.reason}
      data-status={c.status}
      data-testid="compat-cell"
      className={cx(
        'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-px text-[0.75rem] font-bold whitespace-nowrap',
        SOFT[look.tone],
      )}
    >
      <DyIcon name={look.icon} className="size-3 shrink-0" />
      {look.word}
      {version === '' ? null : <span className="font-dy-mono font-medium">{version}</span>}
    </span>
  );
}

/**
 * Runtime × machine matrix. ≥ 768 px a table (reason on hover / focus via the title, and listed below under "Neden
 * hazır değil"); phones one card per machine with each runtime's reason written out (no hover needed).
 */
export function CompatView(props: {
  readonly workers: readonly WorkerSummary[];
  readonly overview: ReadonlyMap<string, WorkerOverview>;
}): ReactNode {
  const tm = useT().machines;
  const t = tm.compat;
  const rows = props.workers.map((w) => ({ w, o: props.overview.get(w.id) }));
  const issues = rows.flatMap(({ w, o }) =>
    (o?.compatibility ?? [])
      .filter((c) => c.status !== 'ready' && c.status !== 'not_installed')
      .map((c) => ({ w, c })),
  );
  return (
    <Panel title={t.title} sub={t.sub} testId="compat-matrix" flush>
      <div className="hidden px-4 pb-2 md:block">
        <table className="w-full border-collapse text-left text-[0.875rem]">
          <caption className="sr-only">{t.caption}</caption>
          <thead>
            <tr className="text-[0.78125rem] text-dy-muted">
              <th scope="col" className="py-2 pr-3 font-bold">
                {t.machine}
              </th>
              {RUNTIMES.map((r) => (
                <th key={r} scope="col" className="px-2 py-2 font-bold">
                  <RuntimeMark runtime={r} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ w, o }) => (
              <tr key={w.id} className="border-t border-dy-line">
                <th scope="row" className="py-2.5 pr-3 align-top font-medium">
                  <Link
                    to={machinePath(w.id)}
                    translate="no"
                    className="font-dy-mono text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                  >
                    {w.name}
                  </Link>
                  <span className="block text-[0.78125rem] font-normal text-dy-muted">
                    {platformText(w.os, w.arch, tm.shared.unknownOs)}
                  </span>
                </th>
                {RUNTIMES.map((r) => {
                  const cell = o?.compatibility.find((c) => c.runtime === r);
                  return (
                    <td key={r} className="px-2 py-2.5 align-top">
                      {cell === undefined ? (
                        <span className="text-[0.78125rem] text-dy-faint" title={t.notReported}>
                          —<span className="sr-only">{t.notReportedSr}</span>
                        </span>
                      ) : (
                        <span tabIndex={0} className="inline-flex rounded-full outline-offset-2">
                          <CompatBadge cell={cell} />
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {issues.length > 0 ? (
          <div className="mt-3 border-t border-dy-line pt-3">
            <h3 className="m-0 mb-1.5 text-[0.84375rem] font-bold">{t.whyNot}</h3>
            <ul
              className="m-0 flex list-none flex-col gap-1 p-0 text-[0.8125rem]"
              data-testid="compat-reasons"
            >
              {issues.map(({ w, c }) => (
                <li key={`${w.id}-${c.runtime}`} className="[overflow-wrap:anywhere]">
                  <Link
                    to={machinePath(w.id)}
                    className="font-dy-mono font-medium text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                  >
                    {w.name}
                  </Link>
                  <span className="text-dy-muted"> · {runtimeDisplayName(c.runtime)}: </span>
                  <span className={INK[compatLook(c.status, t).tone]}>{c.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <ul className="m-0 grid list-none p-0 md:hidden" aria-label={t.caption}>
        {rows.map(({ w, o }) => (
          <li key={w.id} className="border-t border-dy-line px-4 py-3 first:border-t-0">
            <Link
              to={machinePath(w.id)}
              translate="no"
              className="font-dy-mono text-[0.9375rem] font-medium text-dy-ink no-underline"
            >
              {w.name}
            </Link>
            <span className="ml-2 text-[0.78125rem] text-dy-muted">
              {platformText(w.os, w.arch, tm.shared.unknownOs)}
            </span>
            <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
              {(o?.compatibility ?? []).map((c) => (
                <li key={c.runtime} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem]">
                  <RuntimeMark runtime={c.runtime} className="w-28 shrink-0 font-medium" />
                  <CompatBadge cell={c} />
                  {c.status !== 'ready' ? (
                    <span className="min-w-0 basis-full text-dy-muted [overflow-wrap:anywhere]">
                      {c.reason}
                    </span>
                  ) : null}
                </li>
              ))}
              {o === undefined || o.compatibility.length === 0 ? (
                <li className="text-[0.8125rem] text-dy-faint">{t.noRuntimes}</li>
              ) : null}
            </ul>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ network map

/** "Ağ haritası": machines grouped by the network of their last connection (/24 or /64), largest group first. */
export function FleetMap(props: {
  readonly workers: readonly WorkerSummary[];
  readonly overview: ReadonlyMap<string, WorkerOverview>;
  readonly pauses: readonly QuotaPause[];
}): ReactNode {
  const tm = useT().machines;
  const t = tm.map;
  const fmt = useFormat();
  const groups = groupByNetwork(props.workers, props.overview);
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="network-map">
      {groups.map((g) => {
        const online = g.workers.filter((w) => w.connected).length;
        const label = g.key === 'unknown' ? t.unknownNetwork : g.label;
        return (
          <Panel
            key={g.key}
            title={
              <span className="flex min-w-0 items-center gap-2">
                <DyIcon name="globe" className="size-4 shrink-0 text-dy-muted" />
                <span className="min-w-0 font-dy-mono text-[0.875rem] break-all">{label}</span>
              </span>
            }
            aside={
              <span className="text-[0.78125rem] text-dy-muted tabular-nums">
                {online}/{g.workers.length} {t.online}
              </span>
            }
            flush
            testId="network-group"
          >
            <ul className="m-0 grid list-none p-0" aria-label={label}>
              {g.workers.map((w) => {
                const o = props.overview.get(w.id);
                const paused = props.pauses.some((p) => p.workers.includes(w.id));
                const s = slotsOf(w, o);
                const off = !w.connected;
                return (
                  <li
                    key={w.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-dy-line px-4 py-2.5 first:border-t-0"
                  >
                    <span className="min-w-0 flex-1">
                      <Link
                        to={machinePath(w.id)}
                        translate="no"
                        className="block truncate font-dy-mono text-[0.875rem] font-medium text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                      >
                        {w.name}
                      </Link>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[0.78125rem] text-dy-muted">
                        <MachineStateMark worker={w} className="text-[0.78125rem]" />
                        <span>{platformText(w.os, w.arch, tm.shared.unknownOs)}</span>
                        {paused ? <span className="text-dy-violet">{t.paused}</span> : null}
                      </span>
                    </span>
                    {o === undefined || o.capacity.max === null ? (
                      <span className="text-[0.75rem] text-dy-faint">{t.capacityUnknown}</span>
                    ) : (
                      <SlotCells
                        used={s.used}
                        max={s.max}
                        off={off}
                        limit={8}
                        label={
                          off
                            ? `${w.name}: ${machineLook(w, tm).label.toLocaleLowerCase(fmt.locale)}`
                            : tm.list.slotsFull({ name: w.name, used: s.used, max: s.max })
                        }
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </Panel>
        );
      })}
    </div>
  );
}
