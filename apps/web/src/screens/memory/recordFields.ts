/** "a, b, c" → ['a', 'b', 'c'] (trimmed, unique, non-empty). */
export function parseTags(s: string): string[] {
  return [
    ...new Set(
      s
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
    ),
  ];
}

/** A date input value (YYYY-MM-DD) → the end of that local day as ISO; '' → null. */
export function expiryIso(date: string): string | null {
  if (date === '') return null;
  const d = new Date(`${date}T23:59:59`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
