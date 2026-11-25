import { type ChangeEvent, type ReactNode, useState } from 'react';
import { getPriceTable, type MissingPrice, putPriceTable } from '../../../api/usage';
import { useClientPage } from '../../../lib/pager';
import { type Row as PriceRow, rowsToEntries, toRow } from '../../../screens/usage/prices';
import { DyApiError, DyInput, DyNotice, DyPager } from '../kit';
import { DyButton, EmptyLine, ErrorLine, Panel, SkeletonRows } from '../parts';
import { INTL_TAG, type Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { TD, TH, useGuarded, useLoad, useProblemText } from './common';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p12-diyalog-w2: Kullanım → Fiyatlar in the Diyalog language. Same price table (`GET/PUT /usage/prices`), same
 * client-side check (`rowsToEntries`; the master validates again), same optimistic version and step-up on save;
 * admins and owners only edit (`canEdit`), everyone reads. Each saved table is a new immutable version.
 */

type Field = keyof Omit<PriceRow, 'key'>;

const FIELDS: readonly (readonly [Field, 'text' | 'date' | 'decimal'])[] = [
  ['provider', 'text'],
  ['model', 'text'],
  ['effectiveFrom', 'date'],
  ['input', 'decimal'],
  ['output', 'decimal'],
  ['cacheRead', 'decimal'],
  ['cacheWrite', 'decimal'],
  ['source', 'text'],
];

function fieldLabel(t: Messages['usage'], k: Field, locale: string): string {
  return k === 'model' ? t.words.model.toLocaleLowerCase(locale) : t.prices.fields[k];
}

function EditRow(props: {
  readonly row: PriceRow;
  readonly index: number;
  readonly onChange: (r: PriceRow) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const all = useT().usage;
  const t = all.prices;
  const tag = INTL_TAG[useFormat().locale];
  const n = String(props.index + 1);
  const set = (k: keyof Omit<PriceRow, 'key'>) => (e: ChangeEvent<HTMLInputElement>) => {
    props.onChange({ ...props.row, [k]: e.target.value });
  };
  return (
    <li className="border-t border-dy-line px-4 py-3 first:border-t-0" data-testid="price-edit-row">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[0.8125rem] font-bold">{t.row({ n })}</span>
        <DyButton variant="ghost" icon="trash" onClick={props.onRemove} aria-label={t.removeRow({ n })}>
          {t.remove}
        </DyButton>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {FIELDS.map(([k, kind]) => (
          <DyInput
            key={k}
            label={fieldLabel(all, k, tag)}
            aria-label={t.rowField({ n, field: fieldLabel(all, k, tag) })}
            type={kind === 'date' ? 'date' : 'text'}
            inputMode={kind === 'decimal' ? 'decimal' : undefined}
            value={props.row[k]}
            onChange={set(k)}
            wrapClassName={k === 'source' || k === 'model' ? 'col-span-2 sm:col-span-1' : undefined}
          />
        ))}
      </div>
    </li>
  );
}

const money = (n: number | null): string => (n === null ? '—' : `$${String(n)}`);

export function PricesView(props: {
  readonly canEdit: boolean;
  readonly missing: readonly MissingPrice[];
}): ReactNode {
  const all = useT().usage;
  const p = all.prices;
  const problemText = useProblemText();
  const table = useLoad(getPriceTable);
  const page = useClientPage(table.data?.entries ?? [], { label: p.pages, prefix: 'prices' });
  const [rows, setRows] = useState<PriceRow[] | null>(null);
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  useDoneToast(saved);
  const g = useGuarded();
  const t = table.data;

  const startEdit = (extra: readonly MissingPrice[] = []): void => {
    if (t === null) return;
    setSaved(null);
    setProblems([]);
    setNote('');
    g.clear();
    const add = extra
      .filter((m) => !t.entries.some((e) => e.provider === m.provider && e.model === m.model))
      .map((m) => toRow({ provider: m.provider, model: m.model }));
    setRows([...t.entries.map(toRow), ...add]);
  };

  if (t === null)
    return table.error === null ? (
      <SkeletonRows label={p.loading} rows={3} />
    ) : (
      <ErrorLine error={table.error} what={p.what} onRetry={table.reload} />
    );

  return (
    <section aria-label={p.section} className="flex flex-col gap-4" data-testid="dy-prices">
      <Panel
        title={p.title}
        count={`v${String(t.version)}`}
        countLabel={p.version({ n: t.version })}
        sub={
          <>
            {p.sub}
            {t.note === null || t.note === '' ? null : (
              <span className="block">{p.versionNote({ note: t.note })}</span>
            )}
          </>
        }
        aside={
          props.canEdit && rows === null ? (
            <>
              {props.missing.length > 0 ? (
                <DyButton
                  onClick={() => {
                    startEdit(props.missing);
                  }}
                >
                  {p.addMissing}
                </DyButton>
              ) : null}
              <DyButton
                variant="primary"
                icon="pen"
                onClick={() => {
                  startEdit();
                }}
              >
                {p.edit}
              </DyButton>
            </>
          ) : undefined
        }
        flush
      >
        {rows === null ? (
          t.entries.length === 0 ? (
            <EmptyLine testId="prices-empty">{p.empty}</EmptyLine>
          ) : (
            <>
              <div className="overflow-x-auto px-4" tabIndex={0} role="region" aria-label={p.region}>
                <table className="w-full min-w-[48rem]" data-testid="price-table">
                  <caption className="sr-only">{p.caption({ n: t.version })}</caption>
                  <thead>
                    <tr className="border-b border-dy-line">
                      {[
                        p.cols.provider,
                        all.words.model,
                        p.cols.effectiveFrom,
                        p.cols.input,
                        p.cols.output,
                        p.cols.cacheRead,
                        p.cols.cacheWrite,
                        p.cols.source,
                      ].map((h) => (
                        <th key={h} scope="col" className={TH}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {page.pageItems.map((e) => (
                      <tr
                        key={`${e.provider}/${e.model}/${e.effectiveFrom}`}
                        className="border-t border-dy-line first:border-t-0"
                      >
                        <td className="py-2 pr-4 text-[0.875rem]">{e.provider}</td>
                        <td className={TD}>{e.model}</td>
                        <td className={TD}>{e.effectiveFrom.slice(0, 10)}</td>
                        <td className={TD}>{money(e.inputUsdPerMTok)}</td>
                        <td className={TD}>{money(e.outputUsdPerMTok)}</td>
                        <td className={TD}>{money(e.cacheReadUsdPerMTok)}</td>
                        <td className={TD}>{money(e.cacheWriteUsdPerMTok)}</td>
                        <td
                          className="max-w-[16rem] truncate py-2 text-[0.8125rem] text-dy-muted"
                          title={e.source}
                        >
                          {e.source}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <DyPager {...page.pagination} />
            </>
          )
        ) : (
          <form
            aria-label={p.form}
            onSubmit={(e) => {
              e.preventDefault();
              const { entries, errors } = rowsToEntries(rows);
              const said = errors.map(problemText);
              setProblems(said);
              if (said.length > 0) return;
              void g.run(async () => {
                const next = await putPriceTable({ expectedVersion: t.version, note, entries });
                table.set(next);
                setRows(null);
                setSaved(p.saved({ n: next.version }));
              }, p.stepUp);
            }}
          >
            <ul className="m-0 grid list-none p-0" aria-label={p.rows}>
              {rows.map((r, i) => (
                <EditRow
                  key={r.key}
                  row={r}
                  index={i}
                  onChange={(next) => {
                    setRows(rows.map((x) => (x.key === r.key ? next : x)));
                  }}
                  onRemove={() => {
                    setRows(rows.filter((x) => x.key !== r.key));
                  }}
                />
              ))}
            </ul>
            <div className="grid gap-3 border-t border-dy-line px-4 py-3">
              <DyInput
                label={p.note}
                maxLength={1000}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                }}
              />
              {problems.length === 0 ? null : (
                <DyNotice tone="red" live>
                  <ul className="m-0 list-disc pl-5">
                    {problems.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </DyNotice>
              )}
              <DyApiError error={g.error} />
              <div className="flex flex-wrap gap-2">
                <DyButton
                  icon="plus"
                  onClick={() => {
                    setRows([...rows, toRow({})]);
                  }}
                >
                  {p.addRow}
                </DyButton>
                <DyButton type="submit" variant="primary" busy={g.busy}>
                  {p.save}
                </DyButton>
                <DyButton
                  variant="ghost"
                  disabled={g.busy}
                  onClick={() => {
                    setRows(null);
                    setProblems([]);
                  }}
                >
                  {all.cancel}
                </DyButton>
              </div>
            </div>
          </form>
        )}
      </Panel>
    </section>
  );
}
