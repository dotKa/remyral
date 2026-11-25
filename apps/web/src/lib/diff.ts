/**
 * Line diff for the context version viewer: longest common subsequence over lines, after trimming the
 * shared prefix and suffix. Output is plain text ops; callers render them as text, never markup.
 */

export interface DiffOp {
  readonly type: 'same' | 'add' | 'del';
  readonly text: string;
}

/** Above this many LCS cells the middle part is shown as a block replacement (keeps the UI responsive). */
export const MAX_LCS_CELLS = 4_000_000;

/** Splits text into lines; a trailing newline does not add an empty last line, and '' has no lines. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function diffLines(from: string, to: string): DiffOp[] {
  const a = splitLines(from);
  const b = splitLines(to);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const ops: DiffOp[] = a.slice(0, start).map((text) => ({ type: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  if (n * m > MAX_LCS_CELLS) {
    for (const text of midA) ops.push({ type: 'del', text });
    for (const text of midB) ops.push({ type: 'add', text });
  } else if (n > 0 || m > 0) {
    // lcs[i][j] = LCS length of midA[i..] and midB[j..], stored row-major in one typed array.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * w + j] =
          midA[i] === midB[j]
            ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
            : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      const x = midA[i] ?? '';
      const y = midB[j] ?? '';
      if (x === y) {
        ops.push({ type: 'same', text: x });
        i += 1;
        j += 1;
      } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
        ops.push({ type: 'del', text: x });
        i += 1;
      } else {
        ops.push({ type: 'add', text: y });
        j += 1;
      }
    }
    for (; i < n; i += 1) ops.push({ type: 'del', text: midA[i] ?? '' });
    for (; j < m; j += 1) ops.push({ type: 'add', text: midB[j] ?? '' });
  }

  for (const text of a.slice(endA)) ops.push({ type: 'same', text });
  return ops;
}
