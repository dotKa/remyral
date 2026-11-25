import type { FailurePolicy } from '@remyral/scheduler';
import { type WorkflowDefinition, WorkflowDefinitionBody, type WorkflowNodeBody } from './v1.js';
import type { AiStepNode, Retry, V2Edge, WorkflowDefinitionV2 } from './v2.js';

/**
 * Lossless conversion between v1 (AI-only) documents and v2 (p14-workflow-engine §2.1, §5.7):
 *
 * - `normaliseV1(v1)` — every v1 document is a v2 document: each node becomes `{type: "ai.step", …}` with the same
 *   fields, the failure policy mapped exactly (`fail-fast → onError: fail`, `continue → onError: skip`,
 *   `retry-safe → retry.safe: true`, `maxRetries → retry.max`), edges keep `{from, to}` (default ports).
 * - `toV1(v2)` — the inverse on the image of `normaliseV1`, `null` for any document that uses a v2 feature (other node
 *   types, ports, groups, settings, typed inputs, error ports, output schemas, …). `toV1(normaliseV1(d))` deep-equals
 *   `d` for every valid v1 document (property-tested), so the editor can keep writing v1 until a v2 feature is used.
 *
 * Both are pure; stored documents are never rewritten.
 */

/** A stored definition document of either version (`workflow_definitions.definition`). */
export type StoredDefinition = WorkflowDefinition | WorkflowDefinitionV2;

/** The schema version of a stored or submitted document (absent ⇒ 1). */
export function schemaVersionOf(doc: unknown): 1 | 2 | null {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null;
  const v = (doc as { schemaVersion?: unknown }).schemaVersion;
  if (v === undefined) return 1;
  return v === 2 ? 2 : null;
}

function mapPolicy(n: WorkflowNodeBody): Pick<AiStepNode, 'onError' | 'retry'> {
  const out: { onError?: AiStepNode['onError']; retry?: Retry } = {};
  if (n.failurePolicy === 'fail-fast') out.onError = 'fail';
  if (n.failurePolicy === 'continue') out.onError = 'skip';
  if (n.failurePolicy === 'retry-safe' || n.maxRetries !== undefined) {
    out.retry = {
      ...(n.maxRetries === undefined ? {} : { max: n.maxRetries }),
      ...(n.failurePolicy === 'retry-safe' ? { safe: true } : {}),
    };
  }
  return out;
}

/** v1 → v2 (exact; the input is a parsed v1 document). */
export function normaliseV1(def: WorkflowDefinition): WorkflowDefinitionV2 {
  return {
    schemaVersion: 2,
    name: def.name,
    ...(def.description === undefined ? {} : { description: def.description }),
    inputs: def.inputs,
    defaults: def.defaults,
    nodes: def.nodes.map((n) => {
      const { failurePolicy: _f, maxRetries: _m, ...rest } = n;
      return { type: 'ai.step' as const, ...rest, ...mapPolicy(n) };
    }),
    edges: def.edges.map((e) => ({ from: e.from, to: e.to })),
    ...(def.layout === undefined ? {} : { layout: def.layout }),
  };
}

const V2_ONLY_NODE_KEYS = [
  'outputSchema',
  'label',
  'parent',
  'timeoutSec',
  'join',
  'queueTimeoutSec',
] as const;

function unmapPolicy(n: AiStepNode): { failurePolicy?: FailurePolicy; maxRetries?: number } | null {
  const r = n.retry;
  if (r !== undefined) {
    const extra = Object.keys(r).filter((k) => k !== 'max' && k !== 'safe');
    if (extra.length > 0 || r.safe === false) return null;
  }
  const out: { failurePolicy?: FailurePolicy; maxRetries?: number } = {};
  if (r?.safe === true) {
    if (n.onError !== undefined) return null;
    out.failurePolicy = 'retry-safe';
  } else if (n.onError === 'fail') out.failurePolicy = 'fail-fast';
  else if (n.onError === 'skip') out.failurePolicy = 'continue';
  else if (n.onError !== undefined) return null;
  if (r?.max !== undefined) out.maxRetries = r.max;
  return out;
}

const isDefaultPorts = (e: V2Edge): boolean =>
  (e.fromPort === undefined || e.fromPort === 'out') && (e.toPort === undefined || e.toPort === 'in');

/** v2 → v1 when the document uses no v2 feature, else null. The result is a valid parsed v1 document. */
export function toV1(def: WorkflowDefinitionV2): WorkflowDefinition | null {
  if (def.settings !== undefined) return null;
  if (Object.values(def.inputs).some((i) => i.type !== undefined)) return null;
  if (!def.edges.every(isDefaultPorts)) return null;
  const nodes: Record<string, unknown>[] = [];
  for (const n of def.nodes) {
    if (n.type !== 'ai.step') return null;
    const ai = n as AiStepNode;
    if (V2_ONLY_NODE_KEYS.some((k) => ai[k] !== undefined)) return null;
    const policy = unmapPolicy(ai);
    if (policy === null) return null;
    const { type: _t, onError: _o, retry: _r, ...rest } = ai;
    // Original v1 key order: id, role, prompt, failurePolicy, maxRetries, … (the output of the v1 schema).
    const { id, role, prompt, ...others } = rest;
    nodes.push({ id, role, prompt, ...policy, ...others });
  }
  const candidate = {
    name: def.name,
    ...(def.description === undefined ? {} : { description: def.description }),
    inputs: def.inputs,
    defaults: def.defaults,
    nodes,
    edges: def.edges.map((e) => ({ from: e.from, to: e.to })),
    ...(def.layout === undefined ? {} : { layout: def.layout }),
  };
  const parsed = WorkflowDefinitionBody.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * The AI-step view of any stored document (v1 as is; v2: its `ai.step` nodes in v1 shape and the edges between them)
 * — for the v1-shaped readers that only care about AI steps (spec checks, routing, placement previews, the chat card,
 * the composer summary). Unlike `toV1` it is lossy by design and never used to execute a v2 document.
 */
export function aiProjection(doc: WorkflowDefinition | WorkflowDefinitionV2): WorkflowDefinition {
  if (schemaVersionOf(doc) !== 2) return doc as WorkflowDefinition;
  const def = doc as WorkflowDefinitionV2;
  const ai = def.nodes.filter((n): n is AiStepNode => n.type === 'ai.step');
  const ids = new Set(ai.map((n) => n.id));
  return {
    name: def.name,
    ...(def.description === undefined ? {} : { description: def.description }),
    inputs: Object.fromEntries(
      Object.entries(def.inputs).map(([k, v]) => [
        k,
        { required: v.required, ...(v.description === undefined ? {} : { description: v.description }) },
      ]),
    ),
    defaults: def.defaults,
    nodes: ai.map((n) => {
      const {
        type: _t,
        onError,
        retry,
        outputSchema: _s,
        label: _l,
        parent: _p,
        timeoutSec: _ts,
        join: _j,
        queueTimeoutSec: _q,
        ...rest
      } = n;
      const failurePolicy: FailurePolicy | undefined =
        retry?.safe === true
          ? 'retry-safe'
          : onError === 'skip'
            ? 'continue'
            : onError === 'fail'
              ? 'fail-fast'
              : undefined;
      const maxRetries = failurePolicy === 'retry-safe' ? retry?.max : undefined;
      const { id, role, prompt, ...others } = rest;
      return {
        id,
        role,
        prompt,
        ...(failurePolicy === undefined ? {} : { failurePolicy }),
        ...(maxRetries === undefined ? {} : { maxRetries }),
        ...others,
      };
    }),
    edges: def.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ from: e.from, to: e.to })),
    ...(def.layout === undefined
      ? {}
      : {
          layout: {
            positions: Object.fromEntries(Object.entries(def.layout.positions).filter(([k]) => ids.has(k))),
          },
        }),
  };
}
