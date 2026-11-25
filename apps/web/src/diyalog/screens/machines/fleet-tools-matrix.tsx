import { DyIcon } from '../../icons';
import { type ReactNode, useState } from 'react';
import {
  type CatalogItem,
  type FleetTools,
  type ItemKind,
  type MatrixCell,
  type MatrixMachine,
} from '../../../api/fleetTools';
import { useT } from '../../../i18n/I18nProvider';
import { cx } from '../../../components/ui';
import { EmptyLine, Panel, Pill } from '../parts';
import { StatusChip, useFleetWords } from './fleet-tools-parts';
import { UnverifiedBadge, UnverifiedOffer } from './fleet-tools-runtime-updates';

/**
 * p13-fleet-tools — the fleet matrix of Makineler → Araçlar ve sürümler: rows are the catalog (Runtime’lar / Araçlar
 * / Özel araçlar), columns the machines (online dot, "kanarya"); each cell says the installed version, its status in
 * words and where it comes from. Admins select machines (column headers) and items (row headers) for "Toplu işlem".
 * The table scrolls inside its own box; "Makine başına" is the phone-friendly card view of the same data.
 */

export const GROUPS: readonly ItemKind[] = ['runtime', 'tool', 'custom'];

const mono = (v: string): ReactNode => <span className="font-dy-mono">{v}</span>;

function OnlineDot(props: { readonly m: MatrixMachine }): ReactNode {
  const t = useT().fleetTools.matrix;
  return (
    <span className="inline-flex items-center gap-1 text-[0.75rem] font-normal text-dy-muted">
      <span
        aria-hidden="true"
        className={cx('size-2 rounded-full', props.m.connected ? 'bg-dy-green' : 'bg-dy-line-2')}
      />
      {props.m.connected ? t.online : t.offline}
    </span>
  );
}

function CellBody(props: { readonly cell: MatrixCell | undefined }): ReactNode {
  const c = props.cell;
  const t = useT().fleetTools.matrix;
  const words = useFleetWords();
  if (c === undefined) return <span className="text-dy-faint">—</span>;
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className={cx('font-dy-mono', c.installed === null && 'text-dy-faint')}>
          {c.installed ?? '—'}
        </span>
        {c.source === null ? null : (
          <span className="text-[0.75rem] text-dy-muted">{words.source(c.source)}</span>
        )}
      </span>
      <StatusChip status={c.status} />
      {/* p16-runtime-updates: an unverified version running here, or one this machine can install. */}
      <UnverifiedBadge cell={c} />
      {c.action === null ? <UnverifiedOffer cell={c} /> : null}
      {c.shadowed === null || c.shadowed === undefined ? null : (
        <span className="text-[0.75rem] text-dy-muted">
          {t.notUsed({ source: words.source(c.shadowed.source), version: c.shadowed.version ?? '' })}
        </span>
      )}
      {c.action === null && c.unverifiedAction === undefined && c.blocked !== undefined ? (
        <span className="max-w-[14rem] text-[0.75rem] text-dy-muted" data-testid="cell-blocked">
          {words.blocked(c.blocked)}
        </span>
      ) : null}
    </span>
  );
}

function ItemHead(props: { readonly item: CatalogItem }): ReactNode {
  const i = props.item;
  const all = useT().fleetTools;
  const uc = useT().updateChannel;
  const words = useFleetWords();
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="font-bold">{i.label}</span>
      <span className="text-[0.75rem] font-normal text-dy-muted" data-testid="item-versions">
        {i.pinned === null ? null : (
          <>
            {all.parts.pin} {mono(i.pinned)} ·{' '}
          </>
        )}
        {all.parts.latest} {i.latest === null || i.latestState !== 'ok' ? words.latest(i) : mono(i.latest)}
        {i.upstreamPinned === undefined || i.upstreamPinned === null ? null : <> · {i.upstreamPinned}</>}
        {i.catalog === undefined || i.catalog === null ? null : (
          <span data-testid="item-catalog">
            {' · '}
            {i.catalog.verified
              ? uc.matrixCatalog({ version: i.catalog.version })
              : uc.matrixCatalogUnverified({ version: i.catalog.version })}
          </span>
        )}
      </span>
      {i.sourceUrl === null ? null : (
        <a
          href={i.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[0.75rem] font-normal text-dy-teal-ink no-underline hover:underline"
        >
          {all.matrix.source}
        </a>
      )}
    </span>
  );
}

export function FleetMatrix(props: {
  readonly data: FleetTools;
  readonly isAdmin: boolean;
  readonly machines: ReadonlySet<string>;
  readonly items: ReadonlySet<string>;
  readonly onMachines: (s: ReadonlySet<string>) => void;
  readonly onItems: (s: ReadonlySet<string>) => void;
  readonly aside?: ReactNode;
}): ReactNode {
  const { data, isAdmin } = props;
  const all = useT().fleetTools;
  const t = all.matrix;
  const [view, setView] = useState<'table' | 'cards'>(() =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 639px)').matches
      ? 'cards'
      : 'table',
  );
  const toggle = (set: ReadonlySet<string>, id: string, on: (s: ReadonlySet<string>) => void): void => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    on(next);
  };
  const cell = (m: MatrixMachine, item: string): MatrixCell | undefined =>
    m.cells.find((c) => c.item === item);
  const cardRow = (m: MatrixMachine, item: CatalogItem): ReactNode => (
    <li
      key={item.id}
      className="flex flex-wrap items-start justify-between gap-2 border-t border-dy-line px-3.5 py-2 first:border-t-0"
      data-testid="matrix-cell"
      data-item={item.id}
      data-worker={m.workerId}
      data-status={cell(m, item.id)?.status ?? 'none'}
    >
      <ItemHead item={item} />
      <CellBody cell={cell(m, item.id)} />
    </li>
  );
  const groups = GROUPS.map(
    (kind) => [t.groups[kind], data.catalog.filter((c) => c.kind === kind)] as const,
  ).filter(([, list]) => list.length > 0);

  return (
    <Panel
      title={t.title}
      count={`${String(data.catalog.length)}×${String(data.machines.length)}`}
      countLabel={t.size({ items: data.catalog.length, machines: data.machines.length })}
      sub={isAdmin ? t.subAdmin : t.sub}
      aside={
        <span className="flex flex-wrap items-center gap-2">
          <span
            role="group"
            aria-label={t.view}
            className="inline-flex rounded-[9px] border border-dy-line bg-dy-sunk p-0.5"
          >
            {(
              [
                ['table', t.table],
                ['cards', t.cards],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => {
                  setView(v);
                }}
                className={cx(
                  'min-h-8 rounded-[7px] px-2.5 text-[0.8125rem] font-medium',
                  view === v ? 'bg-dy-card text-dy-ink shadow-dy-seg' : 'text-dy-muted',
                )}
              >
                {label}
              </button>
            ))}
          </span>
          {props.aside}
        </span>
      }
      flush
      testId="fleet-matrix"
    >
      {data.machines.length === 0 ? (
        <EmptyLine>{t.empty}</EmptyLine>
      ) : view === 'table' ? (
        <div className="overflow-x-auto overscroll-x-contain" tabIndex={0} aria-label={t.scroll}>
          <table className="w-full min-w-max border-collapse text-left text-[0.8125rem]">
            <thead>
              <tr className="border-b border-dy-line align-bottom">
                <th scope="col" className="sticky left-0 z-[1] bg-dy-card px-4 py-2 font-bold">
                  {t.tool}
                </th>
                {data.machines.map((m) => (
                  <th
                    key={m.workerId}
                    scope="col"
                    className="px-3 py-2 font-medium"
                    data-testid="matrix-machine"
                    data-worker={m.workerId}
                  >
                    <span className="flex flex-col items-start gap-1">
                      <span className="flex items-center gap-2">
                        {isAdmin ? (
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--dy-teal)]"
                            aria-label={t.select({ name: m.name })}
                            checked={props.machines.has(m.workerId)}
                            onChange={() => {
                              toggle(props.machines, m.workerId, props.onMachines);
                            }}
                          />
                        ) : null}
                        <span className="font-bold">{m.name}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <OnlineDot m={m} />
                        {m.canary ? <Pill tone="violet">{all.parts.canary}</Pill> : null}
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map(([label, list]) => (
              <tbody key={label}>
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={data.machines.length + 1}
                    className="sticky left-0 bg-dy-sunk px-4 py-1.5 text-[0.75rem] font-bold tracking-[0.02em] text-dy-muted uppercase"
                  >
                    {label}
                  </th>
                </tr>
                {list.map((item) => (
                  <tr
                    key={item.id}
                    className="border-t border-dy-line align-top"
                    data-testid="matrix-row"
                    data-item={item.id}
                  >
                    <th
                      scope="row"
                      className="sticky left-0 z-[1] max-w-[16rem] bg-dy-card px-4 py-2.5 font-normal"
                    >
                      <span className="flex items-start gap-2">
                        {isAdmin ? (
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4 shrink-0 accent-[var(--dy-teal)]"
                            aria-label={t.select({ name: item.label })}
                            checked={props.items.has(item.id)}
                            onChange={() => {
                              toggle(props.items, item.id, props.onItems);
                            }}
                          />
                        ) : null}
                        <ItemHead item={item} />
                      </span>
                    </th>
                    {data.machines.map((m) => {
                      const c = cell(m, item.id);
                      return (
                        <td
                          key={m.workerId}
                          className="px-3 py-2.5"
                          data-testid="matrix-cell"
                          data-item={item.id}
                          data-worker={m.workerId}
                          data-status={c?.status ?? 'none'}
                        >
                          <CellBody cell={c} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0 px-4 pb-4" aria-label={t.machines}>
          {data.machines.map((m) => (
            <li
              key={m.workerId}
              className="min-w-0 rounded-[12px] border border-dy-line"
              data-testid="matrix-card"
              data-worker={m.workerId}
            >
              <div className="flex flex-wrap items-center gap-2 border-b border-dy-line px-3.5 py-2.5">
                {isAdmin ? (
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--dy-teal)]"
                    aria-label={t.select({ name: m.name })}
                    checked={props.machines.has(m.workerId)}
                    onChange={() => {
                      toggle(props.machines, m.workerId, props.onMachines);
                    }}
                  />
                ) : null}
                <h3 className="m-0 text-[0.9375rem] font-bold [overflow-wrap:anywhere]">{m.name}</h3>
                <OnlineDot m={m} />
                {m.canary ? <Pill tone="violet">{all.parts.canary}</Pill> : null}
              </div>
              {/* p17-ui-review: on a machine card only what needs something is listed; the current ones fold into
                  one line ("7 öğe güncel"), so a phone does not scroll through every up-to-date tool of every machine. */}
              {groups.map(([label, list]) => {
                const open = list.filter((item) => cell(m, item.id)?.status !== 'current');
                return open.length === 0 ? null : (
                  <div key={label}>
                    <p className="m-0 bg-dy-sunk px-3.5 py-1 text-[0.75rem] font-bold text-dy-muted">
                      {label}
                    </p>
                    <ul className="m-0 list-none p-0" aria-label={label}>
                      {open.map((item) => cardRow(m, item))}
                    </ul>
                  </div>
                );
              })}
              {(() => {
                const current = data.catalog.filter((item) => cell(m, item.id)?.status === 'current');
                return current.length === 0 ? null : (
                  <details className="group border-t border-dy-line" data-testid="matrix-card-current">
                    <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3.5 text-[0.8125rem] font-medium text-dy-muted [&::-webkit-details-marker]:hidden">
                      <DyIcon
                        name="chev"
                        className="size-4 shrink-0 -rotate-90 transition-transform group-open:rotate-0 motion-reduce:transition-none"
                      />
                      {t.currentCount({ n: current.length })}
                    </summary>
                    <ul className="m-0 list-none p-0" aria-label={t.currentCount({ n: current.length })}>
                      {current.map((item) => cardRow(m, item))}
                    </ul>
                  </details>
                );
              })()}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
