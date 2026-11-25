import type { WorkflowPatchOp } from '@remyral/protocol';

/**
 * p22-workflow-patch (docs/design/p22-workflow-patch.md): the assistant's two halves of changing a saved workflow
 * without retyping it — {@link definitionView}, the saved document as `describe_workflow definition: true` shows it
 * (bounded: long texts clipped with a marker, too-deep values and nodes that do not fit named), and
 * {@link applyWorkflowPatch}, the patch operations applied in order to the saved document. Both pure.
 *
 * The markers the view writes can never travel back: a patch that contains one is refused (`copied_marker`), so a
 * clipped prompt or a redacted value cannot overwrite the saved one.
 */

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface PatchIssue {
  readonly path: string;
  readonly code: string;
}

/** Start of the marker that replaces the end of a clipped text. */
export const CLIP_MARKER = '…[clipped:';
/** The marker that replaces a value nested deeper than the tool result can carry. */
export const DEEP_MARKER = '[not shown: nested too deep; it stays as saved]';
/** Every marker a read can contain (ours, the redactors', the tool result's own bounds). */
const MARKERS = [CLIP_MARKER, '[not shown:', '[REDACTED', '[MaxDepth]', '…[truncated'];

function markerIn(v: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (typeof v === 'string') return MARKERS.some((m) => v.includes(m)) || /^…\[\d+ more\]$/.test(v);
  if (Array.isArray(v)) return v.some((x) => markerIn(x, depth + 1));
  if (isObj(v)) return Object.entries(v).some(([k, x]) => k === '…' || markerIn(x, depth + 1));
  return false;
}

/** The port an edge leaves / enters (defaults `out` / `in`). */
function edgeEnds(e: Rec): { from: string; fromPort: string; to: string; toPort: string } {
  return {
    from: String(e.from),
    fromPort: typeof e.fromPort === 'string' ? e.fromPort : 'out',
    to: String(e.to),
    toPort: typeof e.toPort === 'string' ? e.toPort : 'in',
  };
}

function sameEdge(a: Rec, b: Rec): boolean {
  const x = edgeEnds(a);
  const y = edgeEnds(b);
  return x.from === y.from && x.fromPort === y.fromPort && x.to === y.to && x.toPort === y.toPort;
}

function edgeLabel(e: Rec): string {
  const x = edgeEnds(e);
  return `${x.from}:${x.fromPort}->${x.to}:${x.toPort}`;
}

/** A clean copy of a drafted edge (only the four known keys). */
function edgeOf(e: {
  from: string;
  to: string;
  fromPort?: string | undefined;
  toPort?: string | undefined;
}): Rec {
  return {
    from: e.from,
    ...(e.fromPort === undefined ? {} : { fromPort: e.fromPort }),
    to: e.to,
    ...(e.toPort === undefined ? {} : { toPort: e.toPort }),
  };
}

/**
 * Applies `ops` in order to a copy of `doc`. Every operation is checked (unknown / duplicate node or edge, an id
 * change, a copied marker); with any issue nothing is returned but the issues (`patch.ops.<i>` paths). The result is
 * not validated here — the caller runs the workflow validator on it like on a whole draft.
 */
export function applyWorkflowPatch(
  doc: Rec,
  ops: readonly WorkflowPatchOp[],
): { ok: true; doc: Rec } | { ok: false; issues: PatchIssue[] } {
  const out: Rec = structuredClone(doc);
  const nodes: Rec[] = (Array.isArray(out.nodes) ? out.nodes : []).filter(isObj);
  let edges: Rec[] = (Array.isArray(out.edges) ? out.edges : []).filter(isObj);
  const issues: PatchIssue[] = [];
  const indexOf = (id: string): number => nodes.findIndex((n) => n.id === id);
  ops.forEach((op, i) => {
    const path = `patch.ops.${String(i)}`;
    if (markerIn(op)) {
      issues.push({ path, code: 'copied_marker' });
      return;
    }
    switch (op.op) {
      case 'replace_node': {
        const at = indexOf(op.id);
        if (at < 0) issues.push({ path, code: `unknown_node:${op.id}` });
        else if (op.node.id !== op.id) issues.push({ path: `${path}.node.id`, code: `id_mismatch:${op.id}` });
        else nodes[at] = structuredClone(op.node);
        return;
      }
      case 'update_node': {
        const at = indexOf(op.id);
        const node = nodes[at];
        if (node === undefined) {
          issues.push({ path, code: `unknown_node:${op.id}` });
          return;
        }
        if (op.set === undefined && op.config === undefined) {
          issues.push({ path, code: 'empty_update' });
          return;
        }
        const next: Rec = structuredClone(node);
        for (const [k, v] of Object.entries(op.set ?? {})) {
          if (k === 'id') issues.push({ path: `${path}.set.id`, code: 'id_immutable' });
          else if (k === 'config') issues.push({ path: `${path}.set.config`, code: 'use_config_merge' });
          else if (v === null || v === undefined) Reflect.deleteProperty(next, k);
          else next[k] = structuredClone(v);
        }
        if (op.config !== undefined) {
          const config: Rec = isObj(next.config) ? next.config : {};
          for (const [k, v] of Object.entries(op.config)) {
            if (v === null || v === undefined) Reflect.deleteProperty(config, k);
            else config[k] = structuredClone(v);
          }
          if (Object.keys(config).length === 0 && !isObj(node.config)) delete next.config;
          else next.config = config;
        }
        nodes[at] = next;
        return;
      }
      case 'add_node':
        if (indexOf(op.node.id) >= 0) issues.push({ path, code: `duplicate_node:${op.node.id}` });
        else nodes.push(structuredClone(op.node));
        return;
      case 'remove_node': {
        const at = indexOf(op.id);
        if (at < 0) {
          issues.push({ path, code: `unknown_node:${op.id}` });
          return;
        }
        nodes.splice(at, 1);
        edges = edges.filter((e) => e.from !== op.id && e.to !== op.id);
        const positions = isObj(out.layout) && isObj(out.layout.positions) ? out.layout.positions : null;
        if (positions !== null) Reflect.deleteProperty(positions, op.id);
        return;
      }
      case 'add_edge': {
        const e = edgeOf(op.edge);
        if (edges.some((x) => sameEdge(x, e))) issues.push({ path, code: `duplicate_edge:${edgeLabel(e)}` });
        else edges.push(e);
        return;
      }
      case 'remove_edge': {
        const e = edgeOf(op.edge);
        const at = edges.findIndex((x) => sameEdge(x, e));
        if (at < 0) issues.push({ path, code: `unknown_edge:${edgeLabel(e)}` });
        else edges.splice(at, 1);
        return;
      }
      case 'set':
        if (op.value === null || op.value === undefined) Reflect.deleteProperty(out, op.field);
        else out[op.field] = structuredClone(op.value);
        return;
    }
  });
  if (issues.length > 0) return { ok: false, issues };
  out.nodes = nodes;
  out.edges = edges;
  return { ok: true, doc: out };
}

// ------------------------------------------------------------------------------------------- the bounded read

/** Clip limits of one read (characters), largest first; the view takes the first that fits the size budget. */
export const VIEW_STEPS: readonly { readonly prompt: number; readonly text: number }[] = [
  { prompt: 6000, text: 2000 },
  { prompt: 3000, text: 1000 },
  { prompt: 1500, text: 500 },
  { prompt: 600, text: 200 },
];
/** Size budget of the document in the tool result (pretty JSON, as the tool result fences it). */
export const VIEW_BUDGET = 40 * 1024;
/** Entries per array / object the tool result carries (its redaction pass keeps 100). */
const MAX_ENTRIES = 100;
/**
 * Deepest object level the tool result keeps (its redaction pass replaces objects at depth 8); the document sits at
 * level 1 of the result.
 */
const MAX_OBJECT_DEPTH = 7;

export interface DefinitionView {
  /** The document without `layout` (positions are presentation only). */
  readonly document: Rec;
  readonly limits: { readonly promptChars: number; readonly textChars: number; readonly bytes: number };
  /** What was clipped or not shown (`nodes.<id>.prompt (9120 characters)`, …). */
  readonly clipped: readonly string[];
  /** Nodes left out because the document did not fit (read them with nodeIds). */
  readonly omittedNodes: readonly string[];
  /** Edges left out (more than the result can carry). */
  readonly omittedEdges: number;
  /** nodeIds that are not in the document. */
  readonly unknownNodeIds: readonly string[];
}

function clipValue(v: unknown, path: string, depth: number, limit: number, clipped: string[]): unknown {
  if (typeof v === 'string') {
    if (v.length <= limit) return v;
    clipped.push(`${path} (${String(v.length)} characters)`);
    return `${v.slice(0, limit)}${CLIP_MARKER} ${String(v.length)} characters; the rest stays as saved]`;
  }
  if (Array.isArray(v) || isObj(v)) {
    if (depth > MAX_OBJECT_DEPTH) {
      clipped.push(`${path} (nested too deep)`);
      return DEEP_MARKER;
    }
    if (Array.isArray(v)) {
      if (v.length > MAX_ENTRIES) clipped.push(`${path} (${String(v.length - MAX_ENTRIES)} more items)`);
      return v
        .slice(0, MAX_ENTRIES)
        .map((x, i) => clipValue(x, `${path}.${String(i)}`, depth + 1, limit, clipped));
    }
    const keys = Object.keys(v);
    if (keys.length > MAX_ENTRIES) clipped.push(`${path} (${String(keys.length - MAX_ENTRIES)} more keys)`);
    return Object.fromEntries(
      keys.slice(0, MAX_ENTRIES).map((k) => [k, clipValue(v[k], `${path}.${k}`, depth + 1, limit, clipped)]),
    );
  }
  return v;
}

/**
 * The saved document as the assistant reads it: everything but `layout`, nodes narrowed to `nodeIds` (and the edges
 * that touch them), texts clipped to the first step of {@link VIEW_STEPS} whose pretty JSON fits {@link VIEW_BUDGET};
 * when even the smallest does not fit, nodes are left out from the end (`omittedNodes`).
 */
export function definitionView(
  doc: Rec,
  opts: { readonly nodeIds?: readonly string[] | undefined } = {},
): DefinitionView {
  const allNodes = (Array.isArray(doc.nodes) ? doc.nodes : []).filter(isObj);
  const wanted = opts.nodeIds === undefined ? null : new Set(opts.nodeIds);
  const unknownNodeIds =
    opts.nodeIds === undefined ? [] : opts.nodeIds.filter((id) => !allNodes.some((n) => n.id === id));
  let nodes = wanted === null ? allNodes : allNodes.filter((n) => wanted.has(String(n.id)));
  const omitted: string[] = [];
  if (nodes.length > MAX_ENTRIES) {
    omitted.push(...nodes.slice(MAX_ENTRIES).map((n) => String(n.id)));
    nodes = nodes.slice(0, MAX_ENTRIES);
  }
  const build = (
    keep: readonly Rec[],
    step: { prompt: number; text: number },
  ): { document: Rec; clipped: string[]; omittedEdges: number; size: number } => {
    const ids = new Set(keep.map((n) => String(n.id)));
    const allEdges = (Array.isArray(doc.edges) ? doc.edges : [])
      .filter(isObj)
      .filter((e) =>
        wanted === null && omitted.length === 0 ? true : ids.has(String(e.from)) || ids.has(String(e.to)),
      );
    const clipped: string[] = [];
    const document: Rec = {};
    for (const [k, v] of Object.entries(doc)) {
      if (k === 'layout' || k === 'nodes' || k === 'edges') continue;
      document[k] = clipValue(v, k, 2, step.text, clipped);
    }
    document.nodes = keep.map((n) => {
      const id = String(n.id);
      return Object.fromEntries(
        Object.entries(n).map(([k, v]) => [
          k,
          clipValue(v, `nodes.${id}.${k}`, 4, k === 'prompt' ? step.prompt : step.text, clipped),
        ]),
      );
    });
    document.edges = allEdges.slice(0, MAX_ENTRIES);
    return {
      document,
      clipped,
      omittedEdges: Math.max(0, allEdges.length - MAX_ENTRIES),
      size: JSON.stringify(document, null, 1).length,
    };
  };
  const last = VIEW_STEPS[VIEW_STEPS.length - 1] ?? { prompt: 600, text: 200 };
  for (const step of VIEW_STEPS) {
    const b = build(nodes, step);
    if (b.size <= VIEW_BUDGET || step === last) {
      let keep = nodes;
      let fitted = b;
      while (fitted.size > VIEW_BUDGET && keep.length > 1) {
        const dropped = keep[keep.length - 1];
        keep = keep.slice(0, -1);
        if (dropped !== undefined) omitted.unshift(String(dropped.id));
        fitted = build(keep, step);
      }
      return {
        document: fitted.document,
        limits: { promptChars: step.prompt, textChars: step.text, bytes: VIEW_BUDGET },
        clipped: fitted.clipped.slice(0, 50),
        omittedNodes: omitted,
        omittedEdges: fitted.omittedEdges,
        unknownNodeIds,
      };
    }
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}
