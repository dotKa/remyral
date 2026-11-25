import { type AnyNode, type Doc, type DocEdge, edgeKey, fromPortOf, positionsOf, toPortOf } from './model';

/** An edge's identity with its ports spelled out (`{from, to}` and `{from, fromPort: 'out', to}` are one edge). */
export const changeKey = (e: DocEdge): string => `${e.from}:${fromPortOf(e)}->${e.to}:${toPortOf(e)}`;

/**
 * p15-workflow-ai (docs/design/p15-workflow-ai.md §3): the assistant's proposal against the editor's document as a
 * list of changes the user accepts or rejects one by one or all at once. Pure: documents in, documents out. Values are
 * compared canonically (key order does not count); positions (`layout`) are presentation only and never a change.
 */

export type AiChangeKind =
  'node-added' | 'node-removed' | 'node-changed' | 'edge-added' | 'edge-removed' | 'settings';

export interface AiChange {
  /** Stable: `node:+<id>`, `node:-<id>`, `node:~<id>`, `edge:+<edge key>`, `edge:-<edge key>`, `settings`. */
  readonly key: string;
  readonly kind: AiChangeKind;
  /** The node id, the edge key, or the changed top-level fields (settings). */
  readonly id: string;
  /** node-changed: the fields that differ; settings: the top-level keys that differ. */
  readonly fields?: readonly string[];
}

export type DiffMark = 'added' | 'removed' | 'changed';

/** JSON with sorted keys: two values that differ only in key order are equal. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return v === undefined || typeof v === 'function' ? 'null' : JSON.stringify(v);
}

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const SKIP_TOP = new Set(['nodes', 'edges', 'layout']);

/** The changes from `current` (the editor's document) to `proposed` (the assistant's), in document order. */
export function aiChanges(current: Doc, proposed: Doc): AiChange[] {
  const cur = new Map(current.nodes.map((n) => [n.id, n]));
  const pro = new Map(proposed.nodes.map((n) => [n.id, n]));
  const out: AiChange[] = [];
  const settings = [...new Set([...Object.keys(current), ...Object.keys(proposed)])]
    .filter((k) => !SKIP_TOP.has(k) && !same(current[k], proposed[k]))
    .sort();
  if (settings.length > 0)
    out.push({ key: 'settings', kind: 'settings', id: settings.join(', '), fields: settings });
  for (const n of proposed.nodes) {
    const was = cur.get(n.id);
    if (was === undefined) out.push({ key: `node:+${n.id}`, kind: 'node-added', id: n.id });
    else {
      const fields = [...new Set([...Object.keys(was), ...Object.keys(n)])]
        .filter((k) => !same(was[k], n[k]))
        .sort();
      if (fields.length > 0) out.push({ key: `node:~${n.id}`, kind: 'node-changed', id: n.id, fields });
    }
  }
  for (const n of current.nodes) {
    if (!pro.has(n.id)) out.push({ key: `node:-${n.id}`, kind: 'node-removed', id: n.id });
  }
  const ce = new Set(current.edges.map(changeKey));
  const pe = new Set(proposed.edges.map(changeKey));
  for (const e of proposed.edges) {
    const k = changeKey(e);
    if (!ce.has(k) && !out.some((c) => c.key === `edge:+${k}`))
      out.push({ key: `edge:+${k}`, kind: 'edge-added', id: k });
  }
  for (const e of current.edges) {
    const k = changeKey(e);
    if (!pe.has(k) && !out.some((c) => c.key === `edge:-${k}`))
      out.push({ key: `edge:-${k}`, kind: 'edge-removed', id: k });
  }
  return out;
}

/**
 * The document with the `accepted` changes of `proposed` applied to `current`: a node takes the proposed version only
 * when its change is accepted; edges likewise; an edge whose end does not exist afterwards is dropped (so an accepted
 * new edge to a rejected new node is not taken, and a removed node takes its edges with it). Existing positions stay;
 * a new node takes the proposal's position when it has one.
 */
export function applyAiChanges(current: Doc, proposed: Doc, accepted: ReadonlySet<string>): Doc {
  const pro = new Map(proposed.nodes.map((n) => [n.id, n]));
  const nodes: AnyNode[] = [];
  for (const n of current.nodes) {
    if (accepted.has(`node:-${n.id}`)) continue;
    const next = pro.get(n.id);
    nodes.push(next !== undefined && accepted.has(`node:~${n.id}`) ? next : n);
  }
  // New nodes in the proposal's order, after the existing ones.
  for (const n of proposed.nodes) {
    if (accepted.has(`node:+${n.id}`) && !current.nodes.some((x) => x.id === n.id)) nodes.push(n);
  }
  const ids = new Set(nodes.map((n) => n.id));
  const pe = new Set(proposed.edges.map(changeKey));
  const edges: DocEdge[] = [];
  const seen = new Set<string>();
  const keep = (e: DocEdge): void => {
    const k = changeKey(e);
    if (seen.has(k) || !ids.has(e.from) || !ids.has(e.to)) return;
    seen.add(k);
    edges.push(e);
  };
  for (const e of current.edges) {
    const k = changeKey(e);
    if (!pe.has(k) && accepted.has(`edge:-${k}`)) continue;
    keep(e);
  }
  for (const e of proposed.edges) {
    if (accepted.has(`edge:+${changeKey(e)}`)) keep(e);
  }
  // Settings: the proposal's top-level fields (a field it dropped is dropped), else the current ones.
  const base: Doc = accepted.has('settings')
    ? ({
        ...Object.fromEntries(Object.entries(current).filter(([k]) => SKIP_TOP.has(k))),
        ...Object.fromEntries(
          Object.entries(proposed).filter(([k, v]) => !SKIP_TOP.has(k) && v !== undefined),
        ),
      } as Doc)
    : { ...current };
  const pos = { ...positionsOf(proposed), ...positionsOf(current) };
  const positions = Object.fromEntries(Object.entries(pos).filter(([k]) => ids.has(k)));
  return {
    ...base,
    nodes,
    edges,
    ...(Object.keys(positions).length === 0 ? {} : { layout: { positions } }),
  };
}

/**
 * What the canvas draws while the user reviews: the proposed document plus the removed nodes and edges (at their
 * current positions), and a mark per node id / edge key.
 */
export function previewAiDoc(
  current: Doc,
  proposed: Doc,
): { doc: Doc; nodes: ReadonlyMap<string, DiffMark>; edges: ReadonlyMap<string, DiffMark> } {
  const changes = aiChanges(current, proposed);
  const nodes = new Map<string, DiffMark>();
  const edges = new Map<string, DiffMark>();
  for (const c of changes) {
    if (c.kind === 'node-added') nodes.set(c.id, 'added');
    else if (c.kind === 'node-changed') nodes.set(c.id, 'changed');
    else if (c.kind === 'node-removed') nodes.set(c.id, 'removed');
    else if (c.kind === 'edge-added') edges.set(c.id, 'added');
    else if (c.kind === 'edge-removed') edges.set(c.id, 'removed');
  }
  const removedNodes = current.nodes.filter((n) => nodes.get(n.id) === 'removed');
  const removedEdges = current.edges.filter((e) => edges.get(changeKey(e)) === 'removed');
  // The canvas knows edges by the editor's key (`edgeKey`): the marks are keyed so.
  const marks = new Map<string, DiffMark>();
  for (const e of [...proposed.edges, ...removedEdges]) {
    const m = edges.get(changeKey(e));
    if (m !== undefined) marks.set(edgeKey(e), m);
  }
  const pos = { ...positionsOf(proposed), ...positionsOf(current) };
  return {
    doc: {
      ...proposed,
      nodes: [...proposed.nodes, ...removedNodes],
      edges: [...proposed.edges, ...removedEdges],
      layout: { positions: pos },
    },
    nodes,
    edges: marks,
  };
}
