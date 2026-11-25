/**
 * A small line-based unified diff for chat-authored skill drafts (p5-machine-admin): the draft card shows what
 * changes against the latest signed version. LCS over lines (files are ≤ 64 KiB); very large inputs fall back to
 * "replaced" so a pathological file cannot make the master spin.
 */

const MAX_CELLS = 4_000_000;
const CONTEXT = 3;

type Op = { readonly t: ' ' | '-' | '+'; readonly line: string };

function lcsOps(a: readonly string[], b: readonly string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) return null;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as Uint32Array;
    const next = dp[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: ' ', line: a[i] ?? '' });
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ t: '-', line: a[i] ?? '' });
      i++;
    } else {
      out.push({ t: '+', line: b[j] ?? '' });
      j++;
    }
  }
  while (i < n) out.push({ t: '-', line: a[i++] ?? '' });
  while (j < m) out.push({ t: '+', line: b[j++] ?? '' });
  return out;
}

/** Unified diff of one file ('' when equal). `before` null = new file, `after` null = removed file. */
export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  if (before === after) return '';
  const a = before === null ? [] : before.split('\n');
  const b = after === null ? [] : after.split('\n');
  const header = `--- ${before === null ? '/dev/null' : `a/${path}`}\n+++ ${after === null ? '/dev/null' : `b/${path}`}\n`;
  const ops = lcsOps(a, b);
  if (ops === null) {
    return `${header}@@ file replaced (${String(a.length)} → ${String(b.length)} lines) @@\n`;
  }
  // Hunks: changed lines with CONTEXT lines around them.
  const lines: string[] = [];
  let ai = 0;
  let bi = 0;
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k]?.t === ' ') {
      ai++;
      bi++;
      k++;
    }
    if (k >= ops.length) break;
    const start = Math.max(0, k - CONTEXT);
    let end = k;
    let quiet = 0;
    while (end < ops.length && quiet <= CONTEXT * 2) {
      quiet = ops[end]?.t === ' ' ? quiet + 1 : 0;
      end++;
    }
    end = Math.min(ops.length, end - Math.max(0, quiet - CONTEXT));
    const back = k - start;
    const aStart = ai - back;
    const bStart = bi - back;
    const hunk = ops.slice(start, end);
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    lines.push(`@@ -${String(aStart + 1)},${String(aLen)} +${String(bStart + 1)},${String(bLen)} @@`);
    for (const o of hunk) lines.push(`${o.t}${o.line}`);
    for (const o of ops.slice(k, end)) {
      if (o.t !== '+') ai++;
      if (o.t !== '-') bi++;
    }
    k = end;
  }
  return `${header}${lines.join('\n')}\n`;
}

/** Diff of a whole skill bundle (sorted by path), bounded for the draft card. */
export function bundleDiff(
  before: Readonly<Record<string, string>> | null,
  after: Readonly<Record<string, string>>,
  maxChars = 48 * 1024,
): string {
  const paths = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])].sort();
  const out = paths
    .map((p) => unifiedDiff(p, before?.[p] ?? null, after[p] ?? null))
    .filter((d) => d !== '')
    .join('');
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n[diff truncated]\n` : out;
}
