import type { Category, DataSchema, NodeTypeInfo, WorkflowCatalog } from '../../../api/workflowEngine';
import {
  ancestorsOf,
  type AnyNode,
  type Doc,
  isAiNode,
  isTypedNode,
  type PortSpec,
  type PortsOf,
  V1_PORTS,
} from './model';

/**
 * p14-workflow-engine 14.1 (docs/design/p14-workflow-engine.md §7): the editor's view of the master's node catalog
 * (`GET /workflows/catalog`) — palette categories and availability, ports of a node (switch cases from its config),
 * the default config of a new node, id prefixes and the expression editor's suggestions. Pure; no React, no graph
 * library (the list screen may import it).
 */

/**
 * The catalog label and description of a node type (`control.if` → `t.workflows.nodeTypes.control.if`; the i18n
 * catalog nests by category because its tooling reads dotted paths). Undefined for an unknown type.
 */
export function nodeTypeText(
  w: { readonly nodeTypes: unknown },
  type: string,
): { readonly label: string; readonly description: string } | undefined {
  const at = type.indexOf('.');
  if (at < 0) return undefined;
  const byCategory = w.nodeTypes as Record<
    string,
    Record<string, { label: string; description: string } | undefined> | undefined
  >;
  return byCategory[type.slice(0, at)]?.[type.slice(at + 1)];
}

export const CATEGORY_ORDER: readonly Category[] = [
  'trigger',
  'ai',
  'control',
  'data',
  'integration',
  'code',
];

/** A sensible first config per type (the master validates; empty strings are flagged there). */
export const DEFAULT_CONFIG: Readonly<Record<string, Record<string, unknown>>> = {
  'control.if': { condition: { $expr: '$input != null' } },
  'control.switch': { value: { $expr: '$input' }, cases: [{ name: 'a', equals: 'a' }] },
  'control.merge': {},
  'control.forEach': { items: { $expr: '$input' } },
  'control.loop': { while: { $expr: '$loop.index < 3' }, maxIterations: 3 },
  'control.delay': { duration: 60 },
  'control.waitUntil': { at: '{{ $now }}' },
  'control.approval': { title: '' },
  'control.subWorkflow': { workflow: { name: '' } },
  'control.stop': {},
  'control.fail': { reason: '' },
  'control.return': { value: { $expr: '$input' } },
  'data.set': { fields: { value: { $expr: '$input' } } },
  'data.transform': { expression: { $expr: '$input' } },
  'data.filter': { items: { $expr: '$input' }, keep: { $expr: 'true' } },
  'data.aggregate': { items: { $expr: '$input' }, operations: [{ name: 'count', op: 'count' }] },
  'data.split': { mode: 'array', value: { $expr: '$input' } },
  'data.template': { template: '' },
  'data.parse': { format: 'json', value: { $expr: '$input' } },
  'data.validate': { schema: { type: 'object' }, value: { $expr: '$input' } },
  'data.dateTime': { operation: 'now' },
  // p14-workflow-engine 14.2: triggers, the webhook wait and the master integrations.
  'trigger.schedule': { cron: '0 9 * * 1-5' },
  'trigger.webhook': {},
  'trigger.github': { repository: '', events: ['pull_request'] },
  'trigger.workflow': { workflow: { name: '' }, outcomes: ['succeeded'] },
  'trigger.chat': {},
  // p14-workflow-engine 14.4: the error workflow's trigger and the webhook answer.
  'trigger.error': {},
  'control.respond': { status: 200, body: { $expr: '$input' } },
  'control.waitWebhook': { timeoutSec: 3600 },
  'notify.users': { recipients: { creator: true }, title: '' },
  'chat.message': { text: '' },
  'jobs.create': {
    spec: {
      runtime: 'claude-code',
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 1800 },
    },
    prompt: '',
  },
  'deploy.coolify': { env: 'preview' },
  'deploy.pages': { fromNode: '' },
  'dns.change': { operation: 'upsert', record: { type: 'CNAME', name: '' } },
  'github.comment': { number: { $expr: '$input.number' }, body: '' },
  'github.pullRequest': { fromNode: '', title: '' },
  'uptime.check': { kind: 'http', url: 'https://' },
  // p14-workflow-engine 14.3: worker function nodes (HTTP request, e-mail, code).
  'http.request': { method: 'GET', origin: 'https://api.example.com', path: '/' },
  'email.send': {
    smtp: {
      provider: 'custom',
      host: 'smtp.example.com',
      port: 587,
      tls: 'starttls',
      username: '',
      credential: '',
    },
    from: { address: 'workflow@example.com' },
    to: '',
    subject: '',
    text: '',
  },
  'code.js': { source: 'return { ok: true, input };', input: { $expr: '$input' } }, // i18n-ignore (code)
  'code.python': { source: "return {'ok': True, 'input': input}", input: { $expr: '$input' } }, // i18n-ignore (code)
};

/**
 * p14-workflow-engine 14.3: which function workers a worker-placed type needs (`http` for HTTP / e-mail —
 * function-v1, `code` for code nodes — function-code-v1); null for every other placement.
 */
export function functionWorkerKind(info: {
  readonly type: string;
  readonly placement: string;
}): 'http' | 'code' | null {
  if (info.placement !== 'worker') return null;
  return info.type.startsWith('code.') ? 'code' : 'http';
}

/** `control.forEach` → `for-each`, `data.dateTime` → `date-time` (the id prefix of a new node). */
export function idPrefix(type: string): string {
  const last = type.split('.').pop() ?? 'node';
  const kebab = last.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return /^[a-z]/.test(kebab) ? kebab.slice(0, 40) : 'node';
}

export function typeInfo(catalog: WorkflowCatalog | null, type: string): NodeTypeInfo | undefined {
  return catalog?.types.find((t) => t.type === type);
}

const ERROR_PORT: PortSpec = { name: 'error', direction: 'out' };

/** Ports of a node from the catalog: switch cases come from its config (before `default`). */
export function makePortsOf(catalog: WorkflowCatalog | null): PortsOf {
  return (n: AnyNode) => {
    if (catalog === null) return V1_PORTS(n);
    const info = typeInfo(catalog, isAiNode(n) ? 'ai.step' : n.type);
    if (info === undefined) return isAiNode(n) ? V1_PORTS(n) : [];
    const ports: PortSpec[] = info.ports.map((p) => ({
      name: p.name,
      direction: p.direction,
      ...(p.side === undefined ? {} : { side: p.side }),
      ...(p.many === true ? { many: true } : {}),
      ...(p.required === true ? { required: true } : {}),
    }));
    if (info.dynamicPorts === 'cases' && isTypedNode(n)) {
      const cases = Array.isArray(n.config.cases) ? n.config.cases : [];
      const names = cases.flatMap((c) =>
        typeof c === 'object' && c !== null && typeof (c as { name?: unknown }).name === 'string'
          ? [(c as { name: string }).name]
          : [],
      );
      const at = ports.findIndex((p) => p.name === 'default');
      const caseports: PortSpec[] = names.map((name) => ({ name, direction: 'out' }));
      ports.splice(at === -1 ? ports.length : at, 0, ...caseports);
    }
    if (!ports.some((p) => p.name === 'error') && info.ports.some((p) => p.name === 'error'))
      ports.push(ERROR_PORT);
    return ports;
  };
}

export type Availability =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'phase' | 'permission' | 'engine' };

/**
 * Can the user add this type now? Not in the engine's executable set ⇒ `phase` (a later phase delivers it); a
 * `workflows.define.*` action (network / code / deploy) needs an admin of the project.
 */
export function availability(
  info: NodeTypeInfo,
  catalog: WorkflowCatalog,
  projectRole: string | null,
): Availability {
  if (!catalog.engineV2) return { ok: false, reason: 'engine' };
  if (!catalog.executable.includes(info.type)) return { ok: false, reason: 'phase' };
  if (info.requires !== 'workflows.define' && projectRole !== 'admin' && projectRole !== 'owner')
    return { ok: false, reason: 'permission' };
  return { ok: true };
}

/** Output schema of a node's port (for suggestions). */
function outSchema(catalog: WorkflowCatalog | null, n: AnyNode, port: string): DataSchema | undefined {
  const info = typeInfo(catalog, isAiNode(n) ? 'ai.step' : n.type);
  return info?.ports.find((p) => p.name === port && p.direction === 'out')?.schema;
}

export interface Suggestion {
  /** What is inserted (replaces the `$…` token before the caret). */
  readonly insert: string;
  /** Extra words (a port's type, a function's signature). */
  readonly detail: string;
}

/** The enclosing groups of a node (nearest first). */
export function groupsOf(doc: Doc, n: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  let cur: AnyNode | undefined = n;
  const seen = new Set<string>();
  while (typeof cur?.parent === 'string' && !seen.has(cur.parent)) {
    seen.add(cur.parent);
    const p: string = cur.parent;
    cur = doc.nodes.find((x) => x.id === p);
    if (cur !== undefined) out.push(cur);
  }
  return out;
}

/** Ancestors in the v2 sense: upstream through links, plus every enclosing group and its ancestors. */
export function ancestorsV2(doc: Doc, id: string): Set<string> {
  const out = new Set<string>();
  const visit = (x: string): void => {
    for (const a of ancestorsOf(doc, x)) out.add(a);
    const n = doc.nodes.find((y) => y.id === x);
    for (const g of n === undefined ? [] : groupsOf(doc, n)) {
      if (out.has(g.id)) continue;
      out.add(g.id);
      visit(g.id);
    }
  };
  visit(id);
  out.delete(id);
  return out;
}

/**
 * The expression editor's suggestions for a node: `$input`, declared `$inputs.*`, `$node.<ancestor>.<port>` (and the
 * declared fields of that port's schema), `$item` / `$index` / `$items` (and `$loop`) inside groups, `$run.*`, `$now`
 * and the catalog's functions.
 */
export function suggestionsFor(doc: Doc, nodeId: string, catalog: WorkflowCatalog | null): Suggestion[] {
  const out: Suggestion[] = [{ insert: '$input', detail: 'in' }];
  for (const name of Object.keys(doc.inputs)) out.push({ insert: `$inputs.${name}`, detail: 'input' });
  const portsOf = makePortsOf(catalog);
  for (const a of [...ancestorsV2(doc, nodeId)].sort()) {
    const n = doc.nodes.find((x) => x.id === a);
    if (n === undefined) continue;
    for (const p of portsOf(n).filter((x) => x.direction === 'out' && x.side !== 'inner')) {
      const schema = outSchema(catalog, n, p.name);
      out.push({ insert: `$node.${a}.${p.name}`, detail: schema?.type ?? 'any' });
      for (const [k, s] of Object.entries(schema?.properties ?? {}))
        out.push({ insert: `$node.${a}.${p.name}.${k}`, detail: s.type });
    }
  }
  const n = doc.nodes.find((x) => x.id === nodeId);
  const groups = n === undefined ? [] : groupsOf(doc, n);
  if (groups.length > 0) {
    out.push({ insert: '$item', detail: 'item' }, { insert: '$index', detail: 'number' });
    out.push({ insert: '$items', detail: 'array' });
    if (groups.some((g) => isTypedNode(g) && g.type === 'control.loop'))
      out.push({ insert: '$loop.index', detail: 'number' }, { insert: '$loop.last', detail: 'any' });
  }
  if (n !== undefined && isTypedNode(n) && n.type === 'control.loop')
    out.push({ insert: '$loop.index', detail: 'number' }, { insert: '$loop.last', detail: 'any' });
  for (const k of ['id', 'startedAt', 'workflow', 'version', 'project'])
    out.push({ insert: `$run.${k}`, detail: 'run' });
  out.push({ insert: '$now', detail: 'string' }, { insert: '$trigger', detail: 'trigger' });
  for (const f of catalog?.functions ?? [])
    out.push({ insert: `${f.name.startsWith('$') ? f.name : `$${f.name}`}(`, detail: f.signature });
  return out;
}

/** The token being typed before the caret (`$node.a.o`), or null. */
export function tokenBefore(text: string, caret: number): { start: number; token: string } | null {
  const m = /\$[A-Za-z0-9_.-]*$/.exec(text.slice(0, caret));
  return m === null ? null : { start: m.index, token: m[0] };
}

/** Suggestions matching a token (prefix first, then contains), at most `max`. */
export function matchSuggestions(all: readonly Suggestion[], token: string, max = 12): Suggestion[] {
  const t = token.toLowerCase();
  const seen = new Set<string>();
  const uniq = all.filter((s) => (seen.has(s.insert) ? false : (seen.add(s.insert), true)));
  const prefix = uniq.filter((s) => s.insert.toLowerCase().startsWith(t));
  const rest = uniq.filter(
    (s) => !s.insert.toLowerCase().startsWith(t) && s.insert.toLowerCase().includes(t.slice(1)),
  );
  return [...prefix, ...(t.length > 1 ? rest : [])].slice(0, max);
}
