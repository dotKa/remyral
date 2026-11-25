import { type DefineAction, nodeType } from './catalog.js';
import { isAiStep, type V2Node, type WorkflowDefinitionV2 } from './v2.js';

/**
 * The privileged delta of a definition version (p14-workflow-engine §8.5): node types whose catalog entry needs more
 * than `workflows.define` (`define.network` for GitHub / uptime / HTTP / e-mail and a token-only webhook wait,
 * `define.deploy` for deploy / Pages / DNS, `define.code` for code). Saving a version that adds such a node or changes
 * one (type or config) needs that action and a fresh step-up — the same approach as creating an automation. Removing
 * a node or moving it on the canvas is not privileged.
 */

/** The action a node needs beyond `workflows.define` (null: none). */
export function nodeAction(n: V2Node): Exclude<DefineAction, 'workflows.define'> | null {
  const t = nodeType(n.type);
  if (t === undefined) return null;
  // A token-only webhook wait trusts URL secrecy alone (§8.1): admin opt-in, like the network nodes.
  if (n.type === 'control.waitWebhook' && !isAiStep(n) && (n.config as { mode?: unknown }).mode === 'token')
    return 'workflows.define.network';
  return t.requires === 'workflows.define' ? null : t.requires;
}

/** Key-order independent JSON (the editor may re-order keys without changing a node). */
function stable(v: unknown, depth = 0): string {
  if (depth > 32 || v === null || typeof v !== 'object') return jsonText(v);
  if (Array.isArray(v)) return `[${v.map((x) => stable(x, depth + 1)).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stable(o[k], depth + 1)}`)
    .join(',')}}`;
}

/** Comparable form of a node for the delta: everything but presentation (label). */
function essence(n: V2Node): string {
  const { label: _l, ...rest } = n as V2Node & { label?: string };
  return stable(rest);
}

export interface PrivilegedChange {
  readonly node: string;
  readonly type: string;
  readonly action: Exclude<DefineAction, 'workflows.define'>;
  readonly change: 'added' | 'changed';
}

/** Privileged nodes added or changed by `next` against `prev` (null: a new workflow — every such node counts). */
export function privilegedDelta(
  prev: Pick<WorkflowDefinitionV2, 'nodes'> | null,
  next: Pick<WorkflowDefinitionV2, 'nodes'>,
): PrivilegedChange[] {
  const before = new Map((prev?.nodes ?? []).map((n) => [n.id, n]));
  const out: PrivilegedChange[] = [];
  for (const n of next.nodes) {
    const action = nodeAction(n);
    if (action === null) continue;
    const old = before.get(n.id);
    if (old === undefined) out.push({ node: n.id, type: n.type, action, change: 'added' });
    else if (old.type !== n.type || essence(old) !== essence(n))
      out.push({ node: n.id, type: n.type, action, change: 'changed' });
  }
  return out;
}

/** The distinct actions of a delta, sorted. */
export function deltaActions(delta: readonly PrivilegedChange[]): string[] {
  return [...new Set(delta.map((d) => d.action))].sort();
}

/** JSON text of a scalar (`undefined` has none: `null`). */
function jsonText(v: unknown): string {
  return v === undefined ? 'null' : JSON.stringify(v);
}
