/**
 * p17-chat-flow (docs/design/p17-chat-flow.md §4): what changed between two drafted workflow documents — the list the
 * new draft card shows under "Öncekine göre değişenler" when it replaces an earlier card of the same conversation
 * ("Sohbette düzenle"). Pure. Values are compared canonically (key order does not count); `layout` and node positions
 * never count. Bounded: at most {@link MAX_CHANGES} entries (`truncated` says more exist).
 */

export type WorkflowChangeKind =
  'node_added' | 'node_removed' | 'node_changed' | 'edge_added' | 'edge_removed' | 'setting_changed';

export interface WorkflowChange {
  readonly kind: WorkflowChangeKind;
  /** Node id, edge key (`from[:port] → to`) or the document setting's name. */
  readonly id: string;
  /** node_changed: the changed fields (`type`, `label`, `config.url`, …). */
  readonly fields?: readonly string[];
}

export const MAX_CHANGES = 60;
const MAX_FIELDS = 8;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Canonical JSON (sorted keys) for comparisons. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}

const IGNORED_NODE_KEYS = new Set(['position', 'layout']);

function nodesOf(doc: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const n of Array.isArray(doc.nodes) ? doc.nodes : []) {
    if (isObj(n) && typeof n.id === 'string') out.set(n.id, n);
  }
  return out;
}

function edgeKey(e: Record<string, unknown>): string {
  const from = `${String(e.from)}${typeof e.fromPort === 'string' ? `:${e.fromPort}` : ''}`;
  const to = `${String(e.to)}${typeof e.toPort === 'string' ? `:${e.toPort}` : ''}`;
  return `${from} → ${to}`;
}

function edgesOf(doc: Record<string, unknown>): Set<string> {
  return new Set((Array.isArray(doc.edges) ? doc.edges : []).filter(isObj).map(edgeKey));
}

function nodeFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const out: string[] = [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !IGNORED_NODE_KEYS.has(k));
  for (const k of keys.sort()) {
    if (canonical(a[k]) === canonical(b[k])) continue;
    if (k === 'config' && isObj(a[k]) && isObj(b[k])) {
      const ca = a[k];
      const cb = b[k];
      for (const ck of [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort()) {
        if (canonical(ca[ck]) !== canonical(cb[ck])) out.push(`config.${ck}`);
      }
    } else out.push(k);
  }
  return out.slice(0, MAX_FIELDS);
}

/** The changes from `before` to `after` (nodes, then edges, then document settings). */
export function workflowChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { changes: WorkflowChange[]; truncated: boolean } {
  const all: WorkflowChange[] = [];
  const a = nodesOf(before);
  const b = nodesOf(after);
  for (const [id, n] of b) {
    const old = a.get(id);
    if (old === undefined) all.push({ kind: 'node_added', id });
    else {
      const fields = nodeFields(old, n);
      if (fields.length > 0) all.push({ kind: 'node_changed', id, fields });
    }
  }
  for (const id of a.keys()) if (!b.has(id)) all.push({ kind: 'node_removed', id });
  const ea = edgesOf(before);
  const eb = edgesOf(after);
  for (const k of eb) if (!ea.has(k)) all.push({ kind: 'edge_added', id: k });
  for (const k of ea) if (!eb.has(k)) all.push({ kind: 'edge_removed', id: k });
  const settings = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => k !== 'nodes' && k !== 'edges' && k !== 'layout',
  );
  for (const k of settings.sort()) {
    if (canonical(before[k]) !== canonical(after[k])) all.push({ kind: 'setting_changed', id: k });
  }
  return { changes: all.slice(0, MAX_CHANGES), truncated: all.length > MAX_CHANGES };
}
