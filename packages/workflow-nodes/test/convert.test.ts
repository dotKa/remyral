import { describe, expect, it } from 'vitest';
import {
  definitionIssuesV1,
  normaliseV1,
  schemaVersionOf,
  toV1,
  validateV2,
  type WorkflowDefinition,
  WorkflowDefinitionBody,
  type WorkflowDefinitionV2,
} from '../src/index.js';

const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://example.com/r.git', baseRef: 'main' },
};

/** Deterministic PRNG (mulberry32) so the property test is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random valid v1 document: a DAG over 1–12 nodes with every optional v1 field sometimes set. */
function randomV1(seed: number): unknown {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const n = 1 + Math.floor(r() * 12);
  const roles = ['planner', 'executor', 'verifier', 'reviewer'] as const;
  const nodes: Record<string, unknown>[] = [];
  const edges: { from: string; to: string }[] = [];
  for (let i = 0; i < n; i++) {
    const id = `n${String(i)}`;
    const ups = nodes.filter(() => r() < 0.3).map((x) => x.id as string);
    for (const u of ups) edges.push({ from: u, to: id });
    const role = ups.length > 0 && r() < 0.2 ? 'integrator' : pick(roles);
    const node: Record<string, unknown> = { id, role, prompt: `Do ${id} for {{inputs.task}}` };
    const policy = pick([undefined, 'fail-fast', 'continue', 'retry-safe'] as const);
    if (policy !== undefined) node.failurePolicy = policy;
    if (policy === 'retry-safe' && r() < 0.5) node.maxRetries = Math.floor(r() * 4);
    if (policy !== 'retry-safe' && r() < 0.1) node.maxRetries = 0;
    if (r() < 0.2) node.approval = { approverRole: pick(['operator', 'admin', 'owner'] as const) };
    if (role === 'planner' && r() < 0.5) node.dynamic = { maxNodes: 1 + Math.floor(r() * 10) };
    if (r() < 0.2) node.runtime = pick(['claude-code', 'codex', 'pi', 'opencode'] as const);
    if (r() < 0.1) node.limits = { maxDurationSec: 100 + Math.floor(r() * 1000) };
    if (r() < 0.1) node.deferrable = r() < 0.5;
    if (r() < 0.1) node.reuseWithinHours = 1 + Math.floor(r() * 100);
    if (role === 'verifier' && r() < 0.2) node.deploy = { kind: 'coolify.deploy', env: 'preview' };
    nodes.push(node);
  }
  const doc: Record<string, unknown> = {
    name: `wf-${String(seed)}`,
    inputs: { task: { required: r() < 0.5, ...(r() < 0.5 ? { description: 'The task' } : {}) } },
    defaults: DEFAULTS,
    nodes,
    edges,
  };
  if (r() < 0.3) doc.description = 'Random workflow';
  if (r() < 0.3) doc.layout = { positions: { n0: { x: 1, y: 2 } } };
  return doc;
}

describe('v1 ↔ v2 conversion (lossless)', () => {
  it('schemaVersionOf: absent = 1, 2 = 2, anything else = null', () => {
    expect(schemaVersionOf({ name: 'x' })).toBe(1);
    expect(schemaVersionOf({ schemaVersion: 2 })).toBe(2);
    expect(schemaVersionOf({ schemaVersion: 3 })).toBeNull();
    expect(schemaVersionOf([])).toBeNull();
    expect(schemaVersionOf(null)).toBeNull();
  });

  it('maps failure policies exactly', () => {
    const v1 = WorkflowDefinitionBody.parse({
      name: 'p',
      defaults: DEFAULTS,
      nodes: [
        { id: 'a', role: 'executor', prompt: 'a', failurePolicy: 'fail-fast' },
        { id: 'b', role: 'executor', prompt: 'b', failurePolicy: 'continue' },
        { id: 'c', role: 'executor', prompt: 'c', failurePolicy: 'retry-safe', maxRetries: 1 },
        { id: 'd', role: 'executor', prompt: 'd', failurePolicy: 'retry-safe' },
        { id: 'e', role: 'executor', prompt: 'e' },
      ],
      edges: [],
    });
    const v2 = normaliseV1(v1);
    expect(v2.nodes.map((n) => [n.id, n.onError, n.retry])).toEqual([
      ['a', 'fail', undefined],
      ['b', 'skip', undefined],
      ['c', undefined, { max: 1, safe: true }],
      ['d', undefined, { safe: true }],
      ['e', undefined, undefined],
    ]);
    expect(v2.nodes.every((n) => n.type === 'ai.step')).toBe(true);
    expect(toV1(v2)).toEqual(v1);
  });

  it('property: every valid v1 document normalises to a valid v2 document and converts back unchanged', () => {
    let checked = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const raw = randomV1(seed);
      const v1 = definitionIssuesV1(raw);
      if (!v1.ok) continue;
      checked++;
      const v2 = normaliseV1(v1.def);
      // Round trip through JSON (what is stored) and the v2 validator.
      const stored = JSON.parse(JSON.stringify(v2)) as unknown;
      const valid = validateV2(stored);
      expect(valid.ok, JSON.stringify(valid.ok ? [] : valid.issues)).toBe(true);
      if (!valid.ok) continue;
      expect(toV1(valid.def)).toEqual(v1.def);
      // The v1 serialisation (definition_hash input) is byte-identical.
      expect(JSON.stringify(toV1(normaliseV1(v1.def)))).toBe(JSON.stringify(v1.def));
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('toV1 returns null when a v2 feature is used', () => {
    const base = normaliseV1(
      WorkflowDefinitionBody.parse({
        name: 'x',
        defaults: DEFAULTS,
        nodes: [
          { id: 'a', role: 'executor', prompt: 'a' },
          { id: 'b', role: 'verifier', prompt: 'b' },
        ],
        edges: [{ from: 'a', to: 'b' }],
      }),
    );
    const variants: WorkflowDefinitionV2[] = [
      { ...base, settings: { timeoutSec: 3600 } },
      { ...base, inputs: { task: { required: false, type: 'string' } } },
      { ...base, edges: [{ from: 'a', to: 'b', fromPort: 'error' }] },
      { ...base, nodes: [{ ...base.nodes[0], onError: 'continue' } as never, base.nodes[1] as never] },
      { ...base, nodes: [{ ...base.nodes[0], label: 'A' } as never, base.nodes[1] as never] },
      {
        ...base,
        nodes: [{ ...base.nodes[0], retry: { max: 1, backoff: 'fixed' } } as never, base.nodes[1] as never],
      },
      { ...base, nodes: [...base.nodes, { id: 'c', type: 'control.delay', config: { duration: 5 } }] },
    ];
    for (const v of variants) expect(toV1(v)).toBeNull();
    // Explicit default ports are still v1.
    expect(toV1({ ...base, edges: [{ from: 'a', to: 'b', fromPort: 'out', toPort: 'in' }] })).not.toBeNull();
  });

  it('a stored v1 document is never mistaken for v2', () => {
    const v1 = randomV1(7) as WorkflowDefinition;
    expect(schemaVersionOf(v1)).toBe(1);
    expect(validateV2(v1).ok).toBe(false);
  });
});
