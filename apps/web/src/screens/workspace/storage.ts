/** "" → null; otherwise a whole number within [min, max], or an error sentence. */
export function parseBound(
  text: string,
  min: number,
  max: number,
  unit: string,
): { value: number | null; error: string | null } {
  const t = text.trim();
  if (t === '') return { value: null, error: null };
  if (!/^\d+$/.test(t)) return { value: null, error: `A whole number of ${unit}, or empty for none.` };
  const n = Number(t);
  if (n < min || n > max) {
    return { value: null, error: `Between ${String(min)} and ${String(max)} ${unit}, or empty for none.` };
  }
  return { value: n, error: null };
}
