import { type Messages, messagesFor } from '@remyral/i18n';
import type { ApiIssue } from '../../../api/client';

/** p14-i18n-screens-b: the model's words (`t.workflows.model`); pure helpers default to Turkish. */
export type ModelText = Messages['workflows']['model'];
const TR_MODEL: ModelText = messagesFor('tr').workflows.model;

/**
 * p13-workflows-ui (docs/design/p13-workflows-ui.md §3): the editor's pure model. The workflow definition document
 * (the master's schema, docs/design/p4-dag.md §2) is the single source of truth — the canvas, the inspector and the
 * YAML/JSON panel are views of it. Every edit is a function `Doc → Doc` (undo/redo keeps whole documents). Node
 * positions live in the document's presentation-only `layout.positions`. Validation here is only what the editor can
 * decide at once (ids, self / duplicate edges, cycles); the master's `POST /workflows/validate` is the authority.
 */

export const ROLES = ['planner', 'executor', 'verifier', 'reviewer', 'integrator'] as const;
export type Role = (typeof ROLES)[number];

/** An AI step (the v1 node; in a v2 document `type: "ai.step"` on the wire, never inside the editor). */
export interface DocNode {
  id: string;
  role: string;
  prompt: string;
  [key: string]: unknown;
}

/** p14-workflow-engine: a typed catalog node (`control.if`, `data.set`, …) with its `config`. */
export interface TypedNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  /** The group (forEach / loop) this node belongs to. */
  parent?: string;
  [key: string]: unknown;
}

export type AnyNode = DocNode | TypedNode;

/** An AI step (no `type` inside the editor). */
export function isAiNode(n: AnyNode): n is DocNode {
  return typeof n.type !== 'string';
}

export function isTypedNode(n: AnyNode): n is TypedNode {
  return typeof n.type === 'string';
}

export interface DocEdge {
  from: string;
  to: string;
  /** p14: output port of `from` (absent = `out`). */
  fromPort?: string;
  /** p14: input port of `to` (absent = `in`). */
  toPort?: string;
}

export interface Pos {
  x: number;
  y: number;
}

export interface Doc {
  name: string;
  description?: string;
  inputs: Record<string, { required?: boolean; description?: string }>;
  defaults: Record<string, unknown>;
  nodes: AnyNode[];
  edges: DocEdge[];
  layout?: { positions: Record<string, Pos> };
  [key: string]: unknown;
}

export const NODE_ID = /^[a-z][a-z0-9_-]{0,47}$/;
export const WORKFLOW_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
export const INPUT_NAME = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_NODES = 50;

/** A role's name in the current language (`t.workflows.model.roles`); unknown roles as they are. */
export function roleName(text: ModelText, role: string): string {
  return (text.roles as Readonly<Record<string, string | undefined>>)[role] ?? role;
}

export function roleHint(text: ModelText, role: string): string | undefined {
  return (text.roleHints as Readonly<Record<string, string | undefined>>)[role];
}

/** What the toolbar adds. `gate` = an iş adımı with an approval gate (gates are a property of a step). */
export type AddKind = Role | 'gate';

export function emptyDoc(text: ModelText = TR_MODEL): Doc {
  return {
    name: '',
    inputs: { task: { required: true, description: text.defaultTask } },
    defaults: {
      runtime: 'claude-code',
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      sourceTrust: 'untrusted',
      limits: { maxDurationSec: 1800 },
    },
    nodes: [],
    edges: [],
  };
}

/** A copy of `o` without `key` (no dynamic `delete`). */
export function without<T extends Record<string, unknown>>(o: T, key: string): T {
  return Object.fromEntries(Object.entries(o).filter(([k]) => k !== key)) as T;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The shape the editor needs (the master checks everything else). Text from the YAML/JSON panel and documents from
 * the master go through here; an error is a short Turkish sentence.
 */
export function asDoc(v: unknown, text: ModelText = TR_MODEL): { doc: Doc } | { error: string } {
  const e = text.doc;
  if (!isObj(v)) return { error: e.notObject };
  if (typeof v.name !== 'string') return { error: e.name };
  if (!Array.isArray(v.nodes)) return { error: e.nodes };
  const nodes: AnyNode[] = [];
  for (const [i, n] of v.nodes.entries()) {
    // p14: a typed node (anything but an AI step) carries `type` and an object `config`.
    if (isObj(n) && typeof n.id === 'string' && typeof n.type === 'string' && n.type !== AI_STEP) {
      const config = n.config ?? {};
      if (!isObj(config)) return { error: `nodes.${String(i)}.config` };
      nodes.push({ ...n, id: n.id, type: n.type, config });
      continue;
    }
    if (!isObj(n) || typeof n.id !== 'string' || typeof n.role !== 'string' || typeof n.prompt !== 'string') {
      return { error: e.node({ i }) };
    }
    nodes.push(n.type === AI_STEP ? aiFromWire(n as DocNode) : (n as DocNode));
  }
  const rawEdges = v.edges ?? [];
  if (!Array.isArray(rawEdges)) return { error: e.edges };
  const edges: DocEdge[] = [];
  for (const [i, raw] of rawEdges.entries()) {
    if (!isObj(raw) || typeof raw.from !== 'string' || typeof raw.to !== 'string') {
      return { error: e.edge({ i }) };
    }
    edges.push(edgeOf(raw.from, raw.to, raw.fromPort, raw.toPort));
  }
  const inputs = v.inputs ?? {};
  if (!isObj(inputs)) return { error: e.inputs };
  const defaults = v.defaults ?? {};
  if (!isObj(defaults)) return { error: e.defaults };
  const { schemaVersion: _sv, ...rest } = v;
  const doc: Doc = {
    ...rest,
    name: v.name,
    inputs: inputs as Doc['inputs'],
    defaults,
    nodes,
    edges,
  };
  if (v.layout !== undefined) {
    if (!isObj(v.layout) || !isObj(v.layout.positions)) return { error: e.positions };
    const positions: Record<string, Pos> = {};
    for (const [k, p] of Object.entries(v.layout.positions)) {
      if (isObj(p) && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x + p.y))
        positions[k] = { x: p.x, y: p.y };
    }
    doc.layout = { positions };
  }
  return { doc };
}

// ------------------------------------------------------------------------------------------------ graph helpers

/** An edge with its ports (default ports are left out: a v1 edge stays `{from, to}`). */
export function edgeOf(from: string, to: string, fromPort?: unknown, toPort?: unknown): DocEdge {
  return {
    from,
    to,
    ...(typeof fromPort === 'string' && fromPort !== 'out' ? { fromPort } : {}),
    ...(typeof toPort === 'string' && toPort !== 'in' ? { toPort } : {}),
  };
}

export const fromPortOf = (e: DocEdge): string => e.fromPort ?? 'out';
export const toPortOf = (e: DocEdge): string => e.toPort ?? 'in';

/** `from->to` for default ports (the v1 key), `from:port->to:port` otherwise. */
export const edgeKey = (e: DocEdge): string =>
  e.fromPort === undefined && e.toPort === undefined
    ? `${e.from}->${e.to}`
    : `${e.from}:${fromPortOf(e)}->${e.to}:${toPortOf(e)}`;

export function upstreamOf(doc: Doc, id: string): string[] {
  return doc.edges.filter((e) => e.to === id).map((e) => e.from);
}

export function ancestorsOf(doc: Doc, id: string): Set<string> {
  const out = new Set<string>();
  const stack = upstreamOf(doc, id);
  while (stack.length > 0) {
    const n = stack.pop() ?? '';
    if (out.has(n)) continue;
    out.add(n);
    stack.push(...upstreamOf(doc, n));
  }
  return out;
}

/** True when an edge from → to would close a cycle (to already reaches from). */
export function wouldCycle(doc: Doc, from: string, to: string): boolean {
  if (from === to) return true;
  return ancestorsOf(doc, from).has(to);
}

export type ConnectRefusal =
  | 'self'
  | 'duplicate'
  | 'cycle'
  | 'unknown'
  /** p14: the port does not exist on that side of the node. */
  | 'unknown_port'
  /** p14: the input port takes one link only (merge / AI steps take many). */
  | 'single_input'
  /** p14: links stay inside one group (a group feeds its body through its `item` port). */
  | 'crosses_scope'
  /** p14: a trigger has no input. */
  | 'trigger_input';

export interface PortSpec {
  readonly name: string;
  readonly direction: 'in' | 'out';
  readonly side?: 'inner' | 'outer';
  readonly many?: boolean;
  readonly required?: boolean;
}

/** Ports of a node, as the editor knows them (the catalog's; v1 / no catalog: one `in` and one `out`). */
export type PortsOf = (n: AnyNode) => readonly PortSpec[];

/** v1 ports: an AI step takes many inputs and has one output (the editor without the engine-2 catalog). */
export const V1_PORTS: PortsOf = () => [
  { name: 'in', direction: 'in', many: true },
  { name: 'out', direction: 'out' },
];

export interface Ports {
  readonly fromPort?: string | undefined;
  readonly toPort?: string | undefined;
}

export function connectRefusal(
  doc: Doc,
  from: string,
  to: string,
  ports: Ports = {},
  portsOf: PortsOf = V1_PORTS,
): ConnectRefusal | null {
  const a = doc.nodes.find((n) => n.id === from);
  const b = doc.nodes.find((n) => n.id === to);
  if (a === undefined || b === undefined) return 'unknown';
  if (from === to) return 'self';
  const fp = ports.fromPort ?? 'out';
  const tp = ports.toPort ?? 'in';
  if (doc.edges.some((e) => e.from === from && e.to === to && fromPortOf(e) === fp && toPortOf(e) === tp))
    return 'duplicate';
  if (isTypedNode(b) && b.type.startsWith('trigger.')) return 'trigger_input';
  const out = portsOf(a).find((p) => p.name === fp && p.direction === 'out');
  const inp = portsOf(b).find((p) => p.name === tp && p.direction === 'in');
  if (out === undefined || inp === undefined) return 'unknown_port';
  const scopeA = typeof a.parent === 'string' ? a.parent : '';
  const scopeB = typeof b.parent === 'string' ? b.parent : '';
  if (out.side === 'inner' ? scopeB !== a.id : scopeA !== scopeB) return 'crosses_scope';
  if (inp.many !== true && doc.edges.some((e) => e.to === to && toPortOf(e) === tp)) return 'single_input';
  if (wouldCycle(doc, from, to)) return 'cycle';
  return null;
}

// ------------------------------------------------------------------------------------------------ edits

export const PREFIX: Readonly<Record<AddKind, string>> = {
  planner: 'plan',
  executor: 'step',
  verifier: 'verify',
  reviewer: 'review',
  integrator: 'integrate',
  gate: 'gate',
};

export function freshId(doc: Doc, kind: AddKind): string {
  const used = new Set(doc.nodes.map((n) => n.id));
  const base = PREFIX[kind];
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}-${String(i)}`;
    if (!used.has(id)) return id;
  }
}

function withPositions(doc: Doc, positions: Record<string, Pos>): Doc {
  return { ...doc, layout: { positions } };
}

export function positionsOf(doc: Doc): Record<string, Pos> {
  return doc.layout?.positions ?? {};
}

/** Prompts may reference `{{inputs.x}}`; drop the reference text when the input is not declared. */
function promptFor(doc: Doc, kind: AddKind, text: ModelText): string {
  const p = text.prompts[kind];
  return 'task' in doc.inputs ? p : p.replace(': {{inputs.task}}', '.');
}

/**
 * Adds a step. When `after` names a step the new one depends on it and sits to its right; otherwise it goes right of
 * the right-most step (or at the origin).
 */
export function addNode(
  doc: Doc,
  kind: AddKind,
  after: string | null,
  at?: Pos,
  text: ModelText = TR_MODEL,
): { doc: Doc; id: string } {
  const id = freshId(doc, kind);
  const role: Role = kind === 'gate' ? 'executor' : kind;
  const node: DocNode = { id, role, prompt: promptFor(doc, kind, text) };
  if (kind === 'gate') node.approval = { approverRole: 'admin' };
  if (kind === 'planner') node.dynamic = { maxNodes: 5 };
  const pos = positionsOf(doc);
  const anchor = after === null ? undefined : pos[after];
  const all = Object.values(pos);
  const place: Pos =
    at ??
    (anchor !== undefined
      ? { x: anchor.x + 280, y: anchor.y + doc.edges.filter((e) => e.from === after).length * 90 }
      : all.length === 0
        ? { x: 0, y: 0 }
        : { x: Math.max(...all.map((p) => p.x)) + 280, y: 0 });
  const edges =
    after !== null && doc.nodes.some((n) => n.id === after)
      ? [...doc.edges, { from: after, to: id }]
      : doc.edges;
  return {
    doc: withPositions({ ...doc, nodes: [...doc.nodes, node], edges }, { ...pos, [id]: place }),
    id,
  };
}

/** A free id from a prefix (`if`, `if-2`, …). */
export function freshIdFrom(doc: Doc, base: string): string {
  const used = new Set(doc.nodes.map((n) => n.id));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}-${String(i)}`;
    if (!used.has(id)) return id;
  }
}

/** The AI step the palette adds (an `İş adımı`, as the v1 toolbar's default). */
export function aiStepBody(
  doc: Doc,
  kind: AddKind = 'executor',
  text: ModelText = TR_MODEL,
): Omit<DocNode, 'id'> {
  const role: Role = kind === 'gate' ? 'executor' : kind;
  return {
    role,
    prompt: promptFor(doc, kind, text),
    ...(kind === 'gate' ? { approval: { approverRole: 'admin' } } : {}),
    ...(kind === 'planner' ? { dynamic: { maxNodes: 5 } } : {}),
  };
}

/**
 * p14: inserts a node (typed or AI) — after `after` (linked from its port `port`, when that link is allowed), inside
 * the group `parent` (positions are relative to the group; the body's first node is fed by the group's `item` port).
 */
export function insertNode(
  doc: Doc,
  body: Omit<DocNode, 'id'> | Omit<TypedNode, 'id'>,
  prefix: string,
  opts: {
    readonly after?: { readonly id: string; readonly port: string } | null;
    readonly parent?: string | null;
    readonly toPort?: string;
    readonly portsOf?: PortsOf;
    readonly at?: Pos;
  } = {},
): { doc: Doc; id: string } {
  const id = freshIdFrom(doc, prefix);
  const parent = opts.parent ?? null;
  const node = { ...body, id, ...(parent === null ? {} : { parent }) } as AnyNode;
  const pos = positionsOf(doc);
  const siblings = doc.nodes.filter((n) => (n.parent ?? null) === parent).map((n) => pos[n.id]);
  const placed = siblings.filter((p): p is Pos => p !== undefined);
  const after = opts.after ?? null;
  const anchor = after === null ? undefined : pos[after.id];
  const place: Pos =
    opts.at ??
    (anchor !== undefined && (doc.nodes.find((n) => n.id === after?.id)?.parent ?? null) === parent
      ? { x: anchor.x + 280, y: anchor.y + doc.edges.filter((e) => e.from === after?.id).length * 90 }
      : placed.length === 0
        ? parent === null
          ? { x: 0, y: 0 }
          : { x: 24, y: 84 }
        : { x: Math.max(...placed.map((p) => p.x)) + 280, y: placed[0]?.y ?? 0 });
  let next: Doc = withPositions({ ...doc, nodes: [...doc.nodes, node] }, { ...pos, [id]: place });
  const toPort = opts.toPort ?? 'in';
  const portsOf = opts.portsOf ?? V1_PORTS;
  const tryLink = (from: string, fromPort: string): void => {
    const r = connect(next, from, id, { fromPort, toPort }, portsOf);
    if (typeof r !== 'string') next = r;
  };
  if (after !== null) tryLink(after.id, after.port);
  else if (parent !== null && placed.length === 0) tryLink(parent, 'item');
  return { doc: next, id };
}

/** The scope (enclosing group id, '' at top level) of a node. */
export const scopeOfNode = (n: AnyNode): string => (typeof n.parent === 'string' ? n.parent : '');

export function connect(
  doc: Doc,
  from: string,
  to: string,
  ports: Ports = {},
  portsOf: PortsOf = V1_PORTS,
): Doc | ConnectRefusal {
  const r = connectRefusal(doc, from, to, ports, portsOf);
  return r ?? { ...doc, edges: [...doc.edges, edgeOf(from, to, ports.fromPort, ports.toPort)] };
}

/** A group's body (its children, their children, …). */
export function descendantsInGroup(doc: Doc, group: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of doc.nodes) {
      const p = n.parent;
      if (typeof p === 'string' && (p === group || out.has(p)) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

export function removeElements(doc: Doc, nodeIds: readonly string[], edgeKeys: readonly string[]): Doc {
  // p14: removing a group removes its body.
  const gone = new Set(nodeIds.flatMap((id) => [id, ...descendantsInGroup(doc, id)]));
  const goneEdges = new Set(edgeKeys);
  const pos = Object.fromEntries(Object.entries(positionsOf(doc)).filter(([id]) => !gone.has(id)));
  const next: Doc = {
    ...doc,
    nodes: doc.nodes.filter((n) => !gone.has(n.id)),
    edges: doc.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to) && !goneEdges.has(edgeKey(e))),
  };
  return doc.layout === undefined ? next : withPositions(next, pos);
}

/** Sets (or, with `undefined`, removes) fields of a step. */
export function updateNode(doc: Doc, id: string, patch: Readonly<Record<string, unknown>>): Doc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== id) return n;
      let next: AnyNode = { ...n };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) next = without(next, k);
        else next[k] = v;
      }
      return next;
    }),
  };
}

export function renameRefusal(doc: Doc, from: string, to: string, text: ModelText = TR_MODEL): string | null {
  if (from === to) return null;
  if (!NODE_ID.test(to)) return text.renameInvalid;
  if (doc.nodes.some((n) => n.id === to)) return text.renameTaken;
  return null;
}

/** Renames a step: its edges, its position and every `{{upstream.<id>.…}}` reference follow. */
export function renameNode(doc: Doc, from: string, to: string): Doc {
  if (renameRefusal(doc, from, to) !== null || from === to) return doc;
  const ref = new RegExp(`\\{\\{\\s*upstream\\.${from.replace(/[-]/g, '\\-')}\\.`, 'g');
  const old = positionsOf(doc);
  const moved = old[from];
  const pos = moved === undefined ? old : { ...without(old, from), [to]: moved };
  const nodeRef = new RegExp(`\\$node\\.${from.replace(/[-]/g, '\\-')}(?![a-z0-9_-])`, 'g');
  const next: Doc = {
    ...doc,
    nodes: doc.nodes.map((n): AnyNode => {
      const id = n.id === from ? to : n.id;
      const parent = n.parent === from ? { parent: to } : {};
      if (isTypedNode(n)) {
        const config = renameRefs(n.config, nodeRef, `$node.${to}`) as Record<string, unknown>;
        return { ...n, id, ...parent, config };
      }
      return { ...n, id, ...parent, prompt: n.prompt.replace(ref, `{{upstream.${to}.`) };
    }),
    edges: doc.edges.map((e) => ({
      ...e,
      from: e.from === from ? to : e.from,
      to: e.to === from ? to : e.to,
    })),
  };
  return doc.layout === undefined ? next : withPositions(next, pos);
}

/** Sets a step's direct upstream steps (the inspector's "Bağlı olduğu adımlar"); refuses cycles. */
export function setUpstream(doc: Doc, id: string, ups: readonly string[]): Doc | ConnectRefusal {
  let next: Doc = { ...doc, edges: doc.edges.filter((e) => e.to !== id) };
  for (const u of ups) {
    const r = connect(next, u, id);
    if (typeof r === 'string') return r;
    next = r;
  }
  return next;
}

export function movePositions(doc: Doc, moved: Readonly<Record<string, Pos>>): Doc {
  return withPositions(doc, { ...positionsOf(doc), ...moved });
}

/**
 * What is sent to the master (and shown in the YAML / JSON panel): positions only for existing steps, no empty
 * description — and p14: the version-1 document while only v1 features are used (parity rule), else the v2 document
 * (`schemaVersion: 2`, AI steps as `type: "ai.step"` with the failure policy mapped as the master's `normaliseV1`).
 */
export function cleanDoc(doc: Doc): Doc {
  const ids = new Set(doc.nodes.map((n) => n.id));
  const out: Doc = { ...doc };
  if (out.description === '') delete out.description;
  if (doc.layout !== undefined) {
    const positions: Record<string, Pos> = {};
    for (const [k, p] of Object.entries(doc.layout.positions)) {
      if (ids.has(k)) positions[k] = { x: Math.round(p.x), y: Math.round(p.y) };
    }
    out.layout = { positions };
  }
  if (!usesV2(doc)) return out;
  const { name, ...rest } = out;
  return {
    schemaVersion: 2,
    name,
    ...rest,
    nodes: doc.nodes.map((n) => (isAiNode(n) ? aiToWire(n) : n)),
  } as unknown as Doc;
}

// ------------------------------------------------------------------------------------------------ v1 ↔ v2 (p14)

export const AI_STEP = 'ai.step';

/** Node keys only a v2 document can carry (their presence makes the document v2). */
const V2_NODE_KEYS = [
  'outputSchema',
  'label',
  'parent',
  'timeoutSec',
  'join',
  'queueTimeoutSec',
  'onError',
  'retry',
];

/** Does the document use anything a version-1 document cannot say? */
export function usesV2(doc: Doc): boolean {
  if (doc.settings !== undefined) return true;
  if (Object.values(doc.inputs).some((i) => isObj(i) && (i as Record<string, unknown>).type !== undefined))
    return true;
  if (doc.edges.some((e) => e.fromPort !== undefined || e.toPort !== undefined)) return true;
  return doc.nodes.some((n) => isTypedNode(n) || V2_NODE_KEYS.some((k) => n[k] !== undefined));
}

/** A wire `ai.step` → the editor's AI step: the failure policy back to v1 words when it maps exactly. */
function aiFromWire(n: DocNode): DocNode {
  const { type: _t, onError, retry, ...rest } = n;
  const out: DocNode = { ...rest };
  const r = isObj(retry) ? retry : undefined;
  const plain = r === undefined || Object.keys(r).every((k) => k === 'max' || k === 'safe');
  if (r !== undefined && r.safe === true && onError === undefined && plain) {
    out.failurePolicy = 'retry-safe';
    if (typeof r.max === 'number') out.maxRetries = r.max;
    return out;
  }
  if (r !== undefined && (r.safe !== undefined || !plain)) out.retry = r;
  else if (r !== undefined && typeof r.max === 'number') out.maxRetries = r.max;
  if (onError === 'fail') out.failurePolicy = 'fail-fast';
  else if (onError === 'skip') out.failurePolicy = 'continue';
  else if (onError !== undefined) out.onError = onError;
  return out;
}

/** The editor's AI step → a wire `ai.step` (`fail-fast → onError: fail`, `continue → skip`, `retry-safe → retry`). */
function aiToWire(n: DocNode): Record<string, unknown> {
  const { failurePolicy, maxRetries, id, role, prompt, ...rest } = n;
  const out: Record<string, unknown> = { type: AI_STEP, id, role, prompt, ...rest };
  if (failurePolicy === 'fail-fast') out.onError = 'fail';
  if (failurePolicy === 'continue') out.onError = 'skip';
  if (failurePolicy === 'retry-safe' || maxRetries !== undefined) {
    out.retry = {
      ...(isObj(rest.retry) ? rest.retry : {}),
      ...(typeof maxRetries === 'number' ? { max: maxRetries } : {}),
      ...(failurePolicy === 'retry-safe' ? { safe: true } : {}),
    };
  }
  return out;
}

/** `$node.<from>` → `$node.<to>` in every string of a config. */
function renameRefs(v: unknown, re: RegExp, to: string): unknown {
  if (typeof v === 'string') return v.replace(re, to);
  if (Array.isArray(v)) return v.map((x) => renameRefs(x, re, to));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renameRefs(x, re, to)]));
  return v;
}

// ------------------------------------------------------------------------------------------------ issues

export interface MappedIssues {
  readonly byNode: ReadonlyMap<string, readonly ApiIssue[]>;
  readonly byEdge: ReadonlyMap<string, readonly ApiIssue[]>;
  readonly general: readonly ApiIssue[];
}

/** The master's issue paths (`nodes.<i>.…`, `edges.<i>…`, `layout.positions.<id>`) on the document's elements. */
export function mapIssues(doc: Doc, issues: readonly ApiIssue[]): MappedIssues {
  const byNode = new Map<string, ApiIssue[]>();
  const byEdge = new Map<string, ApiIssue[]>();
  const general: ApiIssue[] = [];
  const push = (m: Map<string, ApiIssue[]>, k: string, i: ApiIssue): void => {
    m.set(k, [...(m.get(k) ?? []), i]);
  };
  for (const issue of issues) {
    const n = /^nodes\.(\d+)(?:\.|$)/.exec(issue.path);
    const e = /^edges\.(\d+)(?:\.|$)/.exec(issue.path);
    const p = /^layout\.positions\.(.+)$/.exec(issue.path);
    const node = n === null ? undefined : doc.nodes[Number(n[1])];
    const edge = e === null ? undefined : doc.edges[Number(e[1])];
    if (node !== undefined) push(byNode, node.id, issue);
    else if (edge !== undefined) push(byEdge, edgeKey(edge), issue);
    else if (p?.[1] !== undefined && doc.nodes.some((x) => x.id === p[1])) push(byNode, p[1], issue);
    else general.push(issue);
  }
  return { byNode, byEdge, general };
}

/** One issue in words: "prompt: tanımsız girdi “task”". Codes are the master's; unknown ones are shown as they are. */
export function issueText(issue: ApiIssue): string {
  return issueTextWith({}, TR_MODEL)(issue);
}

/**
 * p14: `issueText` with the engine-2 codes in the current language (`t.workflows.issues`: node_type_unavailable,
 * static_field, unknown_port, expr_* …); a code with an argument (`expr_error:T2001`) is looked up by its code.
 */
export function issueTextWith(
  extra: Readonly<Record<string, string>>,
  text: ModelText = TR_MODEL,
): (issue: ApiIssue) => string {
  const codes = text.codes as Readonly<Record<string, string | undefined>>;
  return (issue) => {
    const field = issue.path
      .replace(/^(nodes|edges)\.\d+\.?/, '')
      .replace(/^layout\.positions\..*/, text.position);
    const [code = '', arg] = issue.code.split(/:(.*)/s);
    let words: string;
    if (code === 'undeclared_input') words = text.undeclaredInput({ name: arg ?? '' });
    else if (code === 'not_upstream') words = text.notUpstream({ name: arg ?? '' });
    else if (code === 'unknown_reference') words = text.unknownReference({ name: arg ?? '' });
    else if (code === 'too_many' && arg !== undefined) words = text.atMost({ n: arg });
    else if (extra[code] !== undefined)
      words = arg === undefined ? (extra[code] ?? '') : `${extra[code] ?? ''} (${arg})`;
    else words = codes[code] ?? issue.code;
    return field === '' ? words : `${field}: ${words}`;
  };
}

// ------------------------------------------------------------------------------------------------ versions

export interface DocDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly { readonly id: string; readonly fields: readonly string[] }[];
  readonly edgesAdded: readonly string[];
  readonly edgesRemoved: readonly string[];
  /** Top-level fields that differ (name, description, inputs, defaults); layout is ignored. */
  readonly settings: readonly string[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What changed from `a` (older) to `b` (newer): steps, links and settings (positions do not count). */
export function diffDocs(a: Doc, b: Doc): DocDiff {
  const am = new Map(a.nodes.map((n) => [n.id, n]));
  const bm = new Map(b.nodes.map((n) => [n.id, n]));
  const changed: { id: string; fields: string[] }[] = [];
  for (const [id, nb] of bm) {
    const na = am.get(id);
    if (na === undefined) continue;
    const keys = new Set([...Object.keys(na), ...Object.keys(nb)]);
    const fields = [...keys].filter((k) => !same(na[k], nb[k])).sort();
    if (fields.length > 0) changed.push({ id, fields });
  }
  const ae = new Set(a.edges.map(edgeKey));
  const be = new Set(b.edges.map(edgeKey));
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return {
    added: [...bm.keys()].filter((id) => !am.has(id)),
    removed: [...am.keys()].filter((id) => !bm.has(id)),
    changed,
    edgesAdded: [...be].filter((k) => !ae.has(k)),
    edgesRemoved: [...ae].filter((k) => !be.has(k)),
    settings: [...keys].filter((k) => !['nodes', 'edges', 'layout'].includes(k) && !same(a[k], b[k])).sort(),
  };
}

export function diffIsEmpty(d: DocDiff): boolean {
  return (
    d.added.length +
      d.removed.length +
      d.changed.length +
      d.edgesAdded.length +
      d.edgesRemoved.length +
      d.settings.length ===
    0
  );
}

/** `{{upstream.<id>.summary}}` / `{{upstream.<id>.branch}}` — a template token, not prose. */
export function upstreamRef(id: string, field: 'summary' | 'branch'): string {
  return `{{upstream.${id}.${field}}}`; // i18n-ignore
}

/** `{{inputs.x}}` / `{{upstream.<id>.summary|branch}}` a step's prompt may use (for the inspector's chips). */
export function templateChoices(doc: Doc, id: string): string[] {
  const inputs = Object.keys(doc.inputs).map((k) => `{{inputs.${k}}}`);
  const ups = [...ancestorsOf(doc, id)]
    .sort()
    .flatMap((u) => [upstreamRef(u, 'summary'), upstreamRef(u, 'branch')]);
  return [...inputs, ...ups];
}

/** p14-i18n-screens-b: "az önce" / "3 dk önce" / "2 sa önce" / "4 gün önce" in the current language ("—" for none). */
export function agoIn(
  text: Messages['workflows']['time'],
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (iso === null || iso === undefined) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return text.justNow;
  const m = Math.round(s / 60);
  if (m < 60) return text.minutes({ n: m });
  const h = Math.round(m / 60);
  if (h < 48) return text.hours({ n: h });
  return text.days({ n: Math.round(h / 24) });
}
