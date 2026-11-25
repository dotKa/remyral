import { type PriceEntry } from '../../api/usage';

/**
 * Price table viewer/editor (admin+, step-up). The platform ships no prices: every number here is entered
 * by an admin with its source, and each save creates a new immutable version.
 */

export interface Row {
  readonly key: number;
  provider: string;
  model: string;
  effectiveFrom: string; // yyyy-mm-dd (UTC)
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  source: string;
}

let rowKey = 0;
export function toRow(e: Partial<PriceEntry>): Row {
  rowKey += 1;
  return {
    key: rowKey,
    provider: e.provider ?? '',
    model: e.model ?? '',
    effectiveFrom: (e.effectiveFrom ?? new Date().toISOString()).slice(0, 10),
    input: e.inputUsdPerMTok === undefined ? '' : String(e.inputUsdPerMTok),
    output: e.outputUsdPerMTok === undefined ? '' : String(e.outputUsdPerMTok),
    cacheRead:
      e.cacheReadUsdPerMTok === undefined || e.cacheReadUsdPerMTok === null
        ? ''
        : String(e.cacheReadUsdPerMTok),
    cacheWrite:
      e.cacheWriteUsdPerMTok === undefined || e.cacheWriteUsdPerMTok === null
        ? ''
        : String(e.cacheWriteUsdPerMTok),
    source: e.source ?? '',
  };
}

function parseAmount(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}

/** Client-side check; the master validates again and is authoritative. */
export function rowsToEntries(rows: readonly Row[]): { entries: PriceEntry[]; errors: string[] } {
  const errors: string[] = [];
  const entries: PriceEntry[] = [];
  rows.forEach((r, i) => {
    const n = i + 1;
    const input = parseAmount(r.input);
    const output = parseAmount(r.output);
    const cacheRead = parseAmount(r.cacheRead);
    const cacheWrite = parseAmount(r.cacheWrite);
    if (r.provider.trim() === '' || r.model.trim() === '')
      errors.push(`Row ${String(n)}: provider and model are required.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.effectiveFrom))
      errors.push(`Row ${String(n)}: effective date is required.`);
    if (input === null || output === null || Number.isNaN(input) || Number.isNaN(output))
      errors.push(`Row ${String(n)}: input and output prices must be numbers ≥ 0.`);
    if (Number.isNaN(cacheRead) || Number.isNaN(cacheWrite))
      errors.push(`Row ${String(n)}: cache prices must be numbers ≥ 0 or empty.`);
    if (r.source.trim() === '') errors.push(`Row ${String(n)}: say where the price comes from.`);
    entries.push({
      provider: r.provider.trim().toLowerCase(),
      model: r.model.trim(),
      effectiveFrom: `${r.effectiveFrom}T00:00:00.000Z`,
      inputUsdPerMTok: input ?? 0,
      outputUsdPerMTok: output ?? 0,
      cacheReadUsdPerMTok: cacheRead,
      cacheWriteUsdPerMTok: cacheWrite,
      source: r.source.trim(),
    });
  });
  return { entries, errors };
}
