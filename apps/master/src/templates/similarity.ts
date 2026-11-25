import { createHash } from 'node:crypto';
import type { ParamType, TemplateParameter } from './params.js';

/**
 * p8-templates (docs/design/p8-templates.md §4): deterministic template suggestions — recurring prompts among finished
 * jobs and chat job drafts, grouped by MinHash similarity over normalised word shingles, with the varying spans of the
 * group turned into parameters (token alignment against the group's medoid). Pure and deterministic: the same items
 * give the same suggestions in the same order; no model, no embedding service, no network.
 */

export interface SourceItem {
  /** `job:<uuid>` or `draft:<uuid>`. */
  readonly key: string;
  readonly kind: 'job' | 'draft';
  readonly id: string;
  readonly project: string;
  readonly prompt: string;
  readonly title: string;
  readonly createdAt: string;
  readonly runtime: string | null;
  readonly model: string | null;
  readonly sandboxProfile: string | null;
  readonly approvalPolicy: string | null;
}

export interface Token {
  readonly text: string;
  /** Lower-case NFKC form (used for alignment). */
  readonly norm: string;
  /** Class form for similarity: URLs and numbers collapse to one symbol each. */
  readonly cls: string;
  readonly start: number;
  readonly end: number;
}

const TOKEN =
  /https?:\/\/[^\s<>"'`)\]]+|\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{M}][\p{L}\p{M}\p{N}_'’-]*|[^\s\p{L}\p{N}]/gu;

export function tokenize(s: string): Token[] {
  const out: Token[] = [];
  for (const m of s.matchAll(TOKEN)) {
    const text = m[0];
    const norm = text.normalize('NFKC').toLowerCase();
    const cls = /^https?:\/\//i.test(text) ? '<url>' : /^\p{N}/u.test(text) ? '<num>' : norm;
    out.push({ text, norm, cls, start: m.index, end: m.index + text.length });
  }
  return out;
}

// ------------------------------------------------------------------------------------------- MinHash

export const MINHASH_PERMUTATIONS = 128;
const SHINGLE = 3;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fmix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const SEEDS: readonly number[] = Array.from({ length: MINHASH_PERMUTATIONS }, (_, i) =>
  fmix32(Math.imul(i + 1, 0x9e3779b1)),
);

/** Word shingles of the class tokens (unigrams for very short prompts). */
export function shingles(tokens: readonly Token[]): Set<string> {
  const words = tokens.map((t) => t.cls);
  const out = new Set<string>();
  if (words.length < SHINGLE) {
    for (const w of words) out.add(w);
    return out;
  }
  for (let i = 0; i + SHINGLE <= words.length; i++) out.add(words.slice(i, i + SHINGLE).join(' '));
  return out;
}

export function minhash(set: ReadonlySet<string>): Uint32Array {
  const sig = new Uint32Array(MINHASH_PERMUTATIONS).fill(0xffffffff);
  for (const s of set) {
    const base = fnv1a(s);
    for (let i = 0; i < MINHASH_PERMUTATIONS; i++) {
      const h = fmix32(base ^ (SEEDS[i] ?? 0));
      if (h < (sig[i] ?? 0)) sig[i] = h;
    }
  }
  return sig;
}

/** Estimated Jaccard similarity of two signatures. */
export function similarity(a: Uint32Array, b: Uint32Array): number {
  let same = 0;
  for (let i = 0; i < MINHASH_PERMUTATIONS; i++) if (a[i] === b[i]) same++;
  return same / MINHASH_PERMUTATIONS;
}

// ------------------------------------------------------------------------------------------- grouping

export interface GroupingOptions {
  /** Edge threshold between two items. */
  readonly threshold?: number;
  /** Members must be at least this similar to the group's medoid. */
  readonly medoidThreshold?: number;
  /** Fewest occurrences that make a pattern. */
  readonly minOccurrences?: number;
  /** Item keys that the user marked "not similar" to each other (no edge between two keys of one set). */
  readonly notSimilar?: readonly (readonly string[])[];
}

export interface Group {
  readonly project: string;
  readonly medoid: SourceItem;
  readonly members: readonly SourceItem[];
  readonly avgSimilarity: number;
}

export const MAX_PROMPT_FOR_SUGGESTIONS = 16 * 1024;

function byAge(a: SourceItem, b: SourceItem): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.key < b.key ? -1 : 1;
}

/** Groups recurring prompts per project (union-find over similar pairs, then trimmed around the medoid). */
export function groupItems(items: readonly SourceItem[], opts: GroupingOptions = {}): Group[] {
  const threshold = opts.threshold ?? 0.6;
  const medoidThreshold = opts.medoidThreshold ?? 0.5;
  const min = opts.minOccurrences ?? 3;
  const banned = new Map<string, Set<number>>();
  (opts.notSimilar ?? []).forEach((set, i) => {
    for (const k of set) {
      const s = banned.get(k) ?? new Set<number>();
      s.add(i);
      banned.set(k, s);
    }
  });
  const apart = (a: string, b: string): boolean => {
    const x = banned.get(a);
    const y = banned.get(b);
    if (x === undefined || y === undefined) return false;
    for (const i of x) if (y.has(i)) return true;
    return false;
  };
  const byProject = new Map<string, SourceItem[]>();
  for (const it of [...items].sort(byAge)) {
    if (it.prompt.trim() === '' || it.prompt.length > MAX_PROMPT_FOR_SUGGESTIONS) continue;
    const list = byProject.get(it.project) ?? [];
    list.push(it);
    byProject.set(it.project, list);
  }
  const groups: Group[] = [];
  for (const [project, list] of [...byProject].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (list.length < min) continue;
    const sigs = list.map((it) => minhash(shingles(tokenize(it.prompt))));
    const n = list.length;
    const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => {
      let r = x;
      while (parent[r] !== r) r = parent[r] ?? r;
      let c = x;
      while (parent[c] !== r) {
        const next = parent[c] ?? r;
        parent[c] = r;
        c = next;
      }
      return r;
    };
    for (let i = 0; i < n; i++) {
      (sim[i] as number[])[i] = 1;
      for (let j = i + 1; j < n; j++) {
        const s = similarity(sigs[i] as Uint32Array, sigs[j] as Uint32Array);
        (sim[i] as number[])[j] = s;
        (sim[j] as number[])[i] = s;
        if (s >= threshold && !apart((list[i] as SourceItem).key, (list[j] as SourceItem).key)) {
          const a = find(i);
          const b = find(j);
          if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
        }
      }
    }
    const components = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      components.set(r, [...(components.get(r) ?? []), i]);
    }
    for (const idx of components.values()) {
      if (idx.length < min) continue;
      let medoid = idx[0] ?? 0;
      let best = -1;
      for (const i of idx) {
        const total = idx.reduce((acc, j) => acc + (sim[i]?.[j] ?? 0), 0);
        if (total > best + 1e-9) {
          best = total;
          medoid = i;
        }
      }
      const kept = idx.filter(
        (i) =>
          (sim[medoid]?.[i] ?? 0) >= medoidThreshold &&
          !(i !== medoid && apart((list[i] as SourceItem).key, (list[medoid] as SourceItem).key)),
      );
      if (kept.length < min) continue;
      const others = kept.filter((i) => i !== medoid);
      const avg = others.reduce((acc, i) => acc + (sim[medoid]?.[i] ?? 0), 0) / Math.max(1, others.length);
      groups.push({
        project,
        medoid: list[medoid] as SourceItem,
        members: kept.map((i) => list[i] as SourceItem),
        avgSimilarity: Math.round(avg * 100) / 100,
      });
    }
  }
  return groups.sort(
    (a, b) =>
      b.members.length - a.members.length ||
      (a.project < b.project ? -1 : a.project > b.project ? 1 : byAge(a.medoid, b.medoid)),
  );
}

// ------------------------------------------------------------------------------- parameter inference

const MAX_ALIGN_TOKENS = 1500;
export const MAX_INFERRED_PARAMETERS = 8;

/** Longest common subsequence over normalised tokens: medoid index → other index. */
export function align(a: readonly Token[], b: readonly Token[]): Map<number, number> | null {
  const n = a.length;
  const m = b.length;
  if (n > MAX_ALIGN_TOKENS || m > MAX_ALIGN_TOKENS) return null;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as Uint16Array;
    const next = dp[i + 1] as Uint16Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i]?.norm === b[j]?.norm ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i]?.norm === b[j]?.norm) {
      out.set(i, j);
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) i++;
    else j++;
  }
  return out;
}

export interface InferredParameter extends TemplateParameter {
  /** The value each member had (in member order; '' = empty there). */
  readonly examples: readonly string[];
}

export interface InferredTemplate {
  readonly prompt: string;
  readonly parameters: readonly InferredParameter[];
}

const ASCII: Readonly<Record<string, string>> = {
  ç: 'c',
  ğ: 'g',
  ı: 'i',
  ö: 'o',
  ş: 's',
  ü: 'u',
  â: 'a',
  î: 'i',
  û: 'u',
};

function slug(word: string | undefined): string | null {
  if (word === undefined) return null;
  const s = word
    .toLowerCase()
    .replace(/[çğıöşüâîû]/g, (c) => ASCII[c] ?? c)
    .normalize('NFKD')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^[0-9_]+/, '');
  return s.length >= 3 ? s.slice(0, 32) : null;
}

function typeOf(values: readonly string[], members: number): { type: ParamType; options?: string[] } {
  const filled = values.filter((v) => v !== '');
  if (filled.length > 0 && filled.every((v) => /^https?:\/\/\S+$/i.test(v))) return { type: 'url' };
  if (filled.length > 0 && filled.every((v) => /^-?\d{1,15}$/.test(v))) return { type: 'int' };
  if (filled.length > 0 && filled.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return { type: 'number' };
  if (filled.some((v) => /[\r\n]/.test(v) || v.length > 200)) return { type: 'text' };
  const distinct = [...new Set(filled)].sort();
  if (
    distinct.length >= 2 &&
    distinct.length <= 5 &&
    distinct.length < members &&
    filled.length === values.length &&
    distinct.every((v) => v.length <= 40)
  ) {
    return { type: 'enum', options: distinct };
  }
  return { type: 'string' };
}

/**
 * The group's template: the medoid's text where all members agree, a `{{name}}` placeholder where they differ. null
 * when the members are too different (no alignment, more than {@link MAX_INFERRED_PARAMETERS} varying spans, or less
 * than half of the medoid's tokens shared).
 */
export function inferTemplate(group: Group): InferredTemplate | null {
  const base = group.medoid.prompt;
  const bt = tokenize(base);
  if (bt.length === 0) return null;
  const others = group.members.filter((m) => m.key !== group.medoid.key);
  const maps: { tokens: Token[]; map: Map<number, number>; text: string }[] = [];
  for (const o of others) {
    const ot = tokenize(o.prompt);
    const map = align(bt, ot);
    if (map === null) return null;
    maps.push({ tokens: ot, map, text: o.prompt });
  }
  const anchors: number[] = [];
  for (let i = 0; i < bt.length; i++) if (maps.every((m) => m.map.has(i))) anchors.push(i);
  if (anchors.length < Math.ceil(bt.length / 2)) return null;

  // Gaps: before the first anchor, between anchors, after the last one.
  interface Gap {
    readonly baseStart: number;
    readonly baseEnd: number;
    readonly values: string[];
  }
  const gaps: Gap[] = [];
  const memberSpan = (m: (typeof maps)[number], from: number | null, to: number | null): string => {
    const start = from === null ? 0 : (m.tokens[m.map.get(from) ?? 0]?.end ?? 0);
    const end = to === null ? m.text.length : (m.tokens[m.map.get(to) ?? 0]?.start ?? m.text.length);
    return m.text.slice(start, end).trim();
  };
  for (let k = 0; k <= anchors.length; k++) {
    const from = k === 0 ? null : (anchors[k - 1] ?? null);
    const to = k === anchors.length ? null : (anchors[k] ?? null);
    const baseStart = from === null ? 0 : (bt[from]?.end ?? 0);
    const baseEnd = to === null ? base.length : (bt[to]?.start ?? base.length);
    const values = [base.slice(baseStart, baseEnd).trim(), ...maps.map((m) => memberSpan(m, from, to))];
    if (values.every((v) => v === values[0])) continue;
    gaps.push({ baseStart, baseEnd, values });
  }
  if (gaps.length === 0 || gaps.length > MAX_INFERRED_PARAMETERS) return null;

  const names = new Set<string>();
  const unique = (b: string): string => {
    let n = b;
    for (let i = 2; names.has(n); i++) n = `${b}_${String(i)}`;
    names.add(n);
    return n;
  };
  let prompt = '';
  let at = 0;
  const parameters: InferredParameter[] = [];
  for (const g of gaps) {
    const t = typeOf(g.values, group.members.length);
    const prev = bt.filter((x) => x.end <= g.baseStart && /^\p{L}/u.test(x.text)).at(-1);
    const named =
      t.type === 'url'
        ? 'url'
        : t.type === 'int' || t.type === 'number'
          ? 'count'
          : (slug(prev?.text) ?? (t.type === 'enum' ? 'option' : 'value'));
    const name = unique(named);
    const raw = base.slice(g.baseStart, g.baseEnd);
    const lead = /^\s*/.exec(raw)?.[0] ?? '';
    const trail = /\s*$/.exec(raw)?.[0] ?? '';
    const core = raw.trim();
    const piece = core === '' ? `${lead === '' ? ' ' : lead}{{${name}}} ` : `${lead}{{${name}}}${trail}`;
    prompt += base.slice(at, g.baseStart) + (core === '' ? piece : piece);
    at = g.baseEnd;
    parameters.push({
      name,
      type: t.type,
      required: g.values.every((v) => v !== ''),
      ...(t.options === undefined ? {} : { options: t.options }),
      examples: g.values,
    });
  }
  prompt += base.slice(at);
  return { prompt: prompt.replace(/[ \t]{2,}/g, ' '), parameters };
}

/** Stable id of a suggestion: the project and its normalised template text. */
export function suggestionId(project: string, prompt: string): string {
  const norm = prompt.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${project}\n${norm}`, 'utf8').digest('hex').slice(0, 32);
}

function majority(values: readonly (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [v, c] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (c > n) {
      best = v;
      n = c;
    }
  }
  return best;
}

export interface Suggestion {
  readonly id: string;
  readonly project: string;
  readonly title: string;
  readonly prompt: string;
  readonly parameters: readonly InferredParameter[];
  readonly occurrences: number;
  readonly avgSimilarity: number;
  readonly lastSeenAt: string;
  readonly members: readonly {
    readonly kind: 'job' | 'draft';
    readonly id: string;
    readonly title: string;
    readonly createdAt: string;
  }[];
  readonly defaults: {
    readonly runtime: string | null;
    readonly modelProfile: string | null;
    readonly sandboxProfile: string | null;
    readonly approvalPolicy: string | null;
  };
}

export function titleOf(prompt: string): string {
  const line = prompt.split('\n').find((l) => l.trim() !== '') ?? 'Template';
  const t = line.trim().replace(/\s+/g, ' ');
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

/** Groups → suggestions (groups whose members are too different are dropped). */
export function suggest(items: readonly SourceItem[], opts: GroupingOptions = {}): Suggestion[] {
  const out: Suggestion[] = [];
  for (const g of groupItems(items, opts)) {
    const t = inferTemplate(g);
    if (t === null) continue;
    const members = [...g.members].sort(byAge);
    out.push({
      id: suggestionId(g.project, t.prompt),
      project: g.project,
      title: titleOf(t.prompt),
      prompt: t.prompt,
      parameters: t.parameters,
      occurrences: g.members.length,
      avgSimilarity: g.avgSimilarity,
      lastSeenAt: members.at(-1)?.createdAt ?? g.medoid.createdAt,
      members: members.map((m) => ({ kind: m.kind, id: m.id, title: m.title, createdAt: m.createdAt })),
      defaults: {
        runtime: majority(g.members.map((m) => m.runtime)),
        modelProfile: majority(g.members.map((m) => m.model)),
        sandboxProfile: majority(g.members.map((m) => m.sandboxProfile)),
        approvalPolicy: majority(g.members.map((m) => m.approvalPolicy)),
      },
    });
  }
  return out;
}
