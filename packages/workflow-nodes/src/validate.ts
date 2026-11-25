import { isValidTimeZone } from '@remyral/protocol';
import { type GraphIssue, NODE_ID, templateRefs } from '@remyral/scheduler';
import { nodeType, type PortSpec } from './catalog.js';
import { compatible, MAX_SCHEMA_DEPTH, schemaDepth } from './data-schema.js';
import { containsExpression, nodeReferences, stringsOf } from './fields.js';
import { deployIssues, layoutIssues, zodIssues } from './v1.js';
import {
  type AiStepNode,
  isAiStep,
  PORT_NAME,
  V2_LIMITS,
  type V2Edge,
  type V2Node,
  type WorkflowDefinitionV2,
  WorkflowDefinitionV2Body,
} from './v2.js';

/**
 * Structural validation of a v2 document (p14-workflow-engine §2, §8.3): schema, ids, limits, groups and scopes,
 * ports (existence, direction, `many`, data-schema compatibility), acyclicity per scope, static-only fields, secrets in
 * configs, references (legacy templates and `$node.<id>`) only to ancestors, AI-step rules carried over from v1
 * (integrator upstream, planner-only `dynamic`, deploy steps), and — when the caller passes it — which node types the
 * running engine can execute. Issues are paths + codes only (prompts and configs may be sensitive).
 */

export interface ValidateV2Options {
  /** Types the engine executes now (others ⇒ `node_type_unavailable`); absent = every catalog type. */
  readonly available?: ReadonlySet<string>;
  /** Secret detector for config / prompt strings (the master passes its Redactor) ⇒ `secret_in_definition`. */
  readonly looksSecret?: (s: string) => boolean;
  /**
   * Static check of one expression (the master passes `@remyral/workflow-expr`'s `checkSource`: syntax, refused
   * functions, bounded regexes) ⇒ the issue code on the exact field path (`nodes.<i>.config.<field>…`).
   */
  readonly checkExpression?: (source: string, mode: 'expr' | 'template') => { readonly code: string } | null;
}

/** Every expression of a config value with its path (`{{ }}` templates in strings, `{ $expr }` objects). */
export function configExpressions(
  value: unknown,
  path: readonly (string | number)[] = [],
  out: { path: (string | number)[]; source: string; mode: 'expr' | 'template' }[] = [],
  depth = 0,
): { path: (string | number)[]; source: string; mode: 'expr' | 'template' }[] {
  if (depth > 12 || out.length > 500) return out;
  if (typeof value === 'string') {
    if (/\{\{[\s\S]*?\}\}/.test(value)) out.push({ path: [...path], source: value, mode: 'template' });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => configExpressions(v, [...path, i], out, depth + 1));
  } else if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.$expr === 'string' && Object.keys(o).length === 1)
      out.push({ path: [...path], source: o.$expr, mode: 'expr' });
    else for (const [k, v] of Object.entries(o)) configExpressions(v, [...path, k], out, depth + 1);
  }
  return out;
}

export type ValidateV2Result =
  | { readonly ok: true; readonly def: WorkflowDefinitionV2 }
  | { readonly ok: false; readonly issues: GraphIssue[] };

/** Ports of a node (config-dependent for switch). */
export function portsOf(n: V2Node): readonly PortSpec[] {
  const t = nodeType(n.type);
  if (t === undefined) return [];
  return t.ports(isAiStep(n) ? {} : n.config);
}

export const fromPortOf = (e: V2Edge): string => e.fromPort ?? 'out';
export const toPortOf = (e: V2Edge): string => e.toPort ?? 'in';

/** The scope of a node: its parent group id, or '' at top level. */
export const scopeOf = (n: V2Node): string => n.parent ?? '';

export function validateV2(value: unknown, opts: ValidateV2Options = {}): ValidateV2Result {
  let size: number;
  try {
    const json = JSON.stringify(value) as string | undefined;
    size = Buffer.byteLength(json ?? '', 'utf8');
  } catch {
    return { ok: false, issues: [{ path: '', code: 'not_json' }] };
  }
  if (size > V2_LIMITS.maxDefinitionBytes) return { ok: false, issues: [{ path: '', code: 'too_large' }] };
  // Static-field refusals first (they explain why a literal schema rejects an expression).
  const pre = staticIssues(value);
  const parsed = WorkflowDefinitionV2Body.safeParse(value);
  if (!parsed.success) {
    const issues = [...pre, ...zodIssues(parsed.error)];
    return { ok: false, issues: dedupe(issues).slice(0, 20) };
  }
  const def = parsed.data as unknown as WorkflowDefinitionV2;
  const issues = dedupe([...pre, ...structuralIssues(def, opts)]);
  return issues.length > 0 ? { ok: false, issues: issues.slice(0, 20) } : { ok: true, def };
}

function dedupe(issues: GraphIssue[]): GraphIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.path}\u0000${i.code}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Static-only fields with an expression (on the raw document, before the schema). */
function staticIssues(value: unknown): GraphIssue[] {
  const out: GraphIssue[] = [];
  const nodes = (value as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return out;
  nodes.forEach((raw: unknown, i) => {
    if (typeof raw !== 'object' || raw === null) return;
    const n = raw as { type?: unknown; config?: unknown };
    if (typeof n.type !== 'string') return;
    const t = nodeType(n.type);
    if (t === undefined) return;
    if (t.type === 'ai.step') {
      // Every AI-step field except the prompt is static (runtime, model, sandbox, approver role, limits, …).
      for (const [k, v] of Object.entries(raw)) {
        if (k === 'prompt' || k === 'label') continue;
        if (containsExpression(v)) out.push({ path: `nodes.${String(i)}.${k}`, code: 'static_field' });
      }
      return;
    }
    const config = (n.config ?? {}) as Record<string, unknown>;
    if (typeof config !== 'object' || Array.isArray(config)) return;
    for (const [k, v] of Object.entries(config)) {
      const mode = t.fields[k];
      if (mode === 'static' && containsExpression(v))
        out.push({ path: `nodes.${String(i)}.config.${k}`, code: 'static_field' });
    }
  });
  return out;
}

function structuralIssues(def: WorkflowDefinitionV2, opts: ValidateV2Options): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const add = (path: string, code: string): void => {
    issues.push({ path, code });
  };
  const idx = new Map<string, number>();
  const byId = new Map<string, V2Node>();
  let ai = 0;
  def.nodes.forEach((n, i) => {
    const p = `nodes.${String(i)}`;
    if (!NODE_ID.test(n.id)) add(`${p}.id`, 'invalid_format');
    if (byId.has(n.id)) add(`${p}.id`, 'duplicate');
    byId.set(n.id, n);
    idx.set(n.id, i);
    if (isAiStep(n)) ai++;
    if (opts.available !== undefined && !opts.available.has(n.type))
      add(`${p}.type`, 'node_type_unavailable');
    if (portsOf(n).length > V2_LIMITS.maxPortsPerNode) add(p, 'too_many_ports');
  });
  if (ai > V2_LIMITS.maxAiNodes) add('nodes', 'too_many_ai_steps');
  if (Object.keys(def.inputs).length > V2_LIMITS.maxInputs) add('inputs', 'too_many');
  if (issues.some((x) => x.code === 'duplicate' || x.code === 'invalid_format')) return issues;

  // ---------------------------------------------------------------- groups and scopes
  const depthOf = (n: V2Node): number => {
    let d = 0;
    let cur: V2Node | undefined = n;
    const seen = new Set<string>();
    while (cur?.parent !== undefined) {
      if (seen.has(cur.id)) return Infinity;
      seen.add(cur.id);
      cur = byId.get(cur.parent);
      d++;
    }
    return d;
  };
  def.nodes.forEach((n, i) => {
    const p = `nodes.${String(i)}`;
    const t = nodeType(n.type);
    if (n.parent !== undefined) {
      const g = byId.get(n.parent);
      if (g === undefined) add(`${p}.parent`, 'unknown_node');
      else if (nodeType(g.type)?.group !== true) add(`${p}.parent`, 'not_a_group');
      else if (n.parent === n.id) add(`${p}.parent`, 'self');
      const d = depthOf(n);
      if (d === Infinity) add(`${p}.parent`, 'cycle');
      else if (d > V2_LIMITS.maxNesting) add(`${p}.parent`, 'too_deep');
      if (t?.category === 'trigger') add(`${p}.parent`, 'trigger_in_group');
    }
    if (n.type === 'control.return' && n.parent === undefined) add(p, 'return_outside_group');
    // AI-step specific rules (v1 parity).
    if (isAiStep(n)) aiStepIssues(n, p, add);
    else {
      if (n.retry?.max !== undefined && n.retry.max > 10) add(`${p}.retry.max`, 'out_of_range');
      if (n.queueTimeoutSec !== undefined && t?.placement !== 'worker' && t?.placement !== 'worker-ai')
        add(`${p}.queueTimeoutSec`, 'not_applicable');
      // Data schemas inside configs: bounded depth.
      for (const k of ['bodySchema', 'schema'] as const) {
        const s = n.config[k];
        if (s !== undefined && schemaDepth(s as never) > MAX_SCHEMA_DEPTH)
          add(`${p}.config.${k}`, 'schema_too_deep');
      }
      // Expressions of expression-capable fields: syntax, refused functions, bounded regexes (14.1 sandbox).
      if (opts.checkExpression !== undefined && t !== undefined) {
        for (const [field, value] of Object.entries(n.config)) {
          if (t.fields[field] !== 'expr') continue;
          for (const x of configExpressions(value, [field])) {
            const r = opts.checkExpression(x.source, x.mode);
            if (r !== null) add(`${p}.config.${x.path.map(String).join('.')}`, r.code);
          }
        }
      }
    }
    if (n.join !== undefined && !portsOf(n).some((x) => x.direction === 'in' && x.many === true))
      add(`${p}.join`, 'not_applicable');
    if (opts.looksSecret !== undefined) {
      const texts = isAiStep(n) ? [n.prompt] : stringsOf(n.config);
      if (texts.some((s) => opts.looksSecret?.(s) === true)) add(p, 'secret_in_definition');
    }
  });
  if (issues.some((x) => x.path.endsWith('.parent'))) return issues;

  // ---------------------------------------------------------------- edges and ports
  const seen = new Set<string>();
  const inCount = new Map<string, number>();
  const fanOut = new Map<string, number>();
  def.edges.forEach((e, i) => {
    const p = `edges.${String(i)}`;
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (a === undefined) add(`${p}.from`, 'unknown_node');
    if (b === undefined) add(`${p}.to`, 'unknown_node');
    if (e.from === e.to) add(p, 'self_edge');
    if (a === undefined || b === undefined || e.from === e.to) return;
    const key = `${e.from}\u0000${fromPortOf(e)}\u0000${e.to}\u0000${toPortOf(e)}`;
    if (seen.has(key)) add(p, 'duplicate');
    seen.add(key);
    fanOut.set(e.from, (fanOut.get(e.from) ?? 0) + 1);
    const fp = portsOf(a).find((x) => x.name === fromPortOf(e) && x.direction === 'out');
    const tp = portsOf(b).find((x) => x.name === toPortOf(e) && x.direction === 'in');
    if (!PORT_NAME.test(fromPortOf(e)) || fp === undefined) add(`${p}.fromPort`, 'unknown_port');
    if (!PORT_NAME.test(toPortOf(e)) || tp === undefined) add(`${p}.toPort`, 'unknown_port');
    if (fp === undefined || tp === undefined) return;
    if (nodeType(b.type)?.category === 'trigger') add(`${p}.to`, 'trigger_has_no_input');
    // Scope rules: an inner port of a group feeds its own children; every other edge stays inside one scope.
    if (fp.side === 'inner') {
      if (b.parent !== a.id) add(p, 'crosses_scope');
    } else if (scopeOf(a) !== scopeOf(b)) add(p, 'crosses_scope');
    const k = `${e.to}\u0000${toPortOf(e)}`;
    inCount.set(k, (inCount.get(k) ?? 0) + 1);
    if ((inCount.get(k) ?? 0) > 1 && tp.many !== true) add(`${p}.toPort`, 'single_input');
    if (!compatible(fp.schema, tp.schema)) add(p, 'schema_mismatch');
  });
  for (const [id, n] of fanOut) {
    if (n > V2_LIMITS.maxFanOut) add(`nodes.${String(idx.get(id) ?? 0)}`, 'fan_out_too_large');
  }
  if (issues.some((x) => x.path.startsWith('edges'))) return issues;

  // ---------------------------------------------------------------- acyclic per scope
  if (!acyclic(def)) {
    add('edges', 'cycle');
    return issues;
  }

  // ---------------------------------------------------------------- references and AI-step graph rules
  const anc = ancestorsOf(def);
  const upstreamCount = new Map<string, number>();
  for (const e of def.edges) upstreamCount.set(e.to, (upstreamCount.get(e.to) ?? 0) + 1);
  def.nodes.forEach((n, i) => {
    const p = `nodes.${String(i)}`;
    const mine = anc.get(n.id) ?? new Set<string>();
    if (isAiStep(n)) {
      if (n.role === 'integrator' && (upstreamCount.get(n.id) ?? 0) === 0)
        add(p, 'integrator_needs_upstream');
      for (const { expr, ref } of templateRefs(n.prompt)) {
        if (ref === null) add(`${p}.prompt`, `unknown_reference:${expr.slice(0, 40)}`);
        else if (ref.kind === 'input' && !(ref.name in def.inputs))
          add(`${p}.prompt`, `undeclared_input:${ref.name}`);
        else if (ref.kind === 'upstream' && !mine.has(ref.node))
          add(`${p}.prompt`, `not_upstream:${ref.node}`);
      }
    } else {
      for (const ref of nodeReferences(n.config)) {
        if (mine.has(ref)) continue;
        // 14.2: a webhook wait's resume URL (`$node.<wait>.url`) exists from the run's start, so any node of the same
        // or an enclosing scope may send it (that is how the URL reaches the caller before the wait begins).
        const w = byId.get(ref);
        if (w?.type === 'control.waitWebhook' && onlyWaitUrl(n.config, ref)) {
          if (!enclosingScope(w, n, byId)) add(`${p}.config`, `wait_url_scope:${ref}`);
          continue;
        }
        add(`${p}.config`, `not_upstream:${ref}`);
      }
      // Static references to upstream steps (`fromNode`) must be AI-step ancestors.
      const from = (n.config as { fromNode?: unknown }).fromNode;
      if (typeof from === 'string') {
        const f = byId.get(from);
        if (f === undefined || !isAiStep(f) || !mine.has(from))
          add(`${p}.config.fromNode`, 'not_upstream_ai_step');
      }
    }
  });
  // 14.2: a signed webhook wait verifies the caller with the secret of the workflow's own webhook trigger.
  const hasWebhookTrigger = def.nodes.some((n) => n.type === 'trigger.webhook');
  // 14.4: a `control.respond` answers the request a `responseMode: wait` webhook trigger holds.
  const holdsRequest = def.nodes.some(
    (n) => n.type === 'trigger.webhook' && (n.config as { responseMode?: unknown }).responseMode === 'wait',
  );
  def.nodes.forEach((n, i) => {
    if (isAiStep(n)) return;
    const c = n.config as { mode?: unknown; cron?: unknown; timezone?: unknown; responseMode?: unknown };
    if (n.type === 'control.waitWebhook' && (c.mode ?? 'signed') === 'signed' && !hasWebhookTrigger)
      add(`nodes.${String(i)}.config.mode`, 'wait_needs_webhook_trigger');
    // p16-workflow-quality: the schedule runs on the wall clock of an IANA zone the runtime knows.
    if (n.type === 'trigger.schedule') {
      const tz = (c as { timeZone?: unknown }).timeZone ?? c.timezone ?? 'UTC';
      if (typeof tz === 'string' && !isValidTimeZone(tz))
        add(
          `nodes.${String(i)}.config.${c.timezone === undefined ? 'timeZone' : 'timezone'}`,
          'unknown_timezone',
        );
    }
    if (n.type === 'control.respond') {
      if (n.parent !== undefined) add(`nodes.${String(i)}.parent`, 'respond_in_group');
      else if (!holdsRequest) add(`nodes.${String(i)}`, 'respond_needs_wait_trigger');
    }
  });
  // 14.4: run settings — an error workflow is another workflow; the concurrency key is an expression.
  const settings = def.settings;
  if (settings?.onFailure !== undefined && settings.onFailure.workflow === def.name)
    add('settings.onFailure.workflow', 'on_failure_self');
  const key = settings?.concurrency?.key;
  if (key !== undefined && opts.checkExpression !== undefined) {
    for (const e of configExpressions(key)) {
      const bad = opts.checkExpression(e.source, e.mode);
      if (bad !== null) add('settings.concurrency.key', bad.code);
    }
  }
  if (key !== undefined && opts.looksSecret?.(JSON.stringify(key)) === true)
    add('settings.concurrency.key', 'secret_in_definition');
  const aiNodes = def.nodes.filter(isAiStep);
  issues.push(...deployIssues(aiNodes, (i) => def.nodes.indexOf(aiNodes[i] as V2Node)));
  issues.push(...layoutIssues(def.nodes, def.layout));
  return issues;
}

/** Every `$node.<ref>` occurrence in a config is `$node.<ref>.url`. */
function onlyWaitUrl(config: unknown, ref: string): boolean {
  const any = new RegExp(`\\$node\\.${ref}(?![a-z0-9_-])`, 'g');
  const url = new RegExp(`\\$node\\.${ref}\\.url(?![A-Za-z0-9_])`, 'g');
  return stringsOf(config).every((s) => (s.match(any) ?? []).length === (s.match(url) ?? []).length);
}

/** `w` runs in the scope of `n` or in one enclosing it (top level, or a group `n` is nested in). */
function enclosingScope(w: V2Node, n: V2Node, byId: ReadonlyMap<string, V2Node>): boolean {
  if (w.parent === undefined) return true;
  let cur: V2Node | undefined = n;
  const seen = new Set<string>();
  while (cur?.parent !== undefined && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.parent === w.parent) return true;
    cur = byId.get(cur.parent);
  }
  return false;
}

function aiStepIssues(n: AiStepNode, p: string, add: (path: string, code: string) => void): void {
  if (n.dynamic !== undefined && n.role !== 'planner') add(`${p}.dynamic`, 'planner_only');
  if (n.retry?.max !== undefined) {
    if (n.retry.max > V2_LIMITS.maxAiRetries) add(`${p}.retry.max`, 'out_of_range');
    // v1 parity: AI steps retry only when the author asserted they are safe to repeat.
    if (n.retry.max > 0 && n.retry.safe !== true) add(`${p}.retry.max`, 'requires_retry_safe');
  }
  if (n.parent !== undefined && n.dynamic !== undefined) add(`${p}.dynamic`, 'not_in_group');
  if (n.parent !== undefined && n.role === 'integrator') add(`${p}.role`, 'integrator_not_in_group');
}

/** Kahn per scope over the edges between siblings (inner-port edges feed a body and cannot close a cycle). */
function acyclic(def: WorkflowDefinitionV2): boolean {
  const ids = def.nodes.map((n) => n.id);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const down = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of def.edges) {
    down.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const ready = ids.filter((id) => indeg.get(id) === 0);
  let seen = 0;
  while (ready.length > 0) {
    const id = ready.pop() as string;
    seen++;
    for (const d of down.get(id) ?? []) {
      const v = (indeg.get(d) ?? 0) - 1;
      indeg.set(d, v);
      if (v === 0) ready.push(d);
    }
  }
  return seen === ids.length;
}

/**
 * Ancestors of every node: transitive upstreams through edges, plus — for nodes inside a group — the group's own
 * ancestors (a body sees what its group sees) and the group itself (its `item`).
 */
export function ancestorsOf(def: WorkflowDefinitionV2): Map<string, Set<string>> {
  const up = new Map<string, string[]>(def.nodes.map((n) => [n.id, []]));
  for (const e of def.edges) up.get(e.to)?.push(e.from);
  const parent = new Map(def.nodes.map((n) => [n.id, n.parent]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const m = memo.get(id);
    if (m !== undefined) return m;
    if (stack.has(id)) return new Set();
    stack.add(id);
    const out = new Set<string>();
    for (const u of up.get(id) ?? []) {
      out.add(u);
      for (const x of visit(u, stack)) out.add(x);
    }
    const g = parent.get(id);
    if (g !== undefined) {
      out.add(g);
      for (const x of visit(g, stack)) out.add(x);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const n of def.nodes) visit(n.id, new Set());
  return memo;
}
