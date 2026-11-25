import { describe, expect, it } from 'vitest';
import {
  ancestorsOf,
  configExpressions,
  validateV2,
  V2_LIMITS,
  type WorkflowDefinitionV2,
} from '../src/index.js';

const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
};
const ai = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'ai.step',
  role: 'executor',
  prompt: `do ${id}`,
  ...extra,
});
const wf = (nodes: unknown[], edges: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  name: 'v',
  defaults: DEFAULTS,
  nodes,
  edges,
  ...extra,
});
const issuesOf = (doc: unknown) => {
  const r = validateV2(doc);
  return r.ok ? [] : r.issues;
};

describe('v2 graph validation', () => {
  it('accepts an if / else over AI steps with port labels', () => {
    const r = validateV2(
      wf(
        [
          ai('a'),
          { id: 'big', type: 'control.if', config: { condition: '{{ $node.a.out.data.size > 5 }}' } },
          ai('review', { role: 'reviewer' }),
          ai('ship'),
        ],
        [
          { from: 'a', to: 'big' },
          { from: 'big', fromPort: 'true', to: 'review' },
          { from: 'big', fromPort: 'false', to: 'ship' },
        ],
      ),
    );
    expect(r.ok, JSON.stringify(r.ok ? null : r.issues)).toBe(true);
  });

  it('refuses unknown ports, wrong directions and a second edge into a single input', () => {
    expect(
      issuesOf(
        wf(
          [ai('a'), { id: 'c', type: 'control.if', config: { condition: true } }, ai('b')],
          [
            { from: 'a', to: 'c' },
            { from: 'c', fromPort: 'maybe', to: 'b' },
          ],
        ),
      ),
    ).toContainEqual({ path: 'edges.1.fromPort', code: 'unknown_port' });
    expect(issuesOf(wf([ai('a'), ai('b')], [{ from: 'a', to: 'b', toPort: 'out' }]))).toContainEqual({
      path: 'edges.0.toPort',
      code: 'unknown_port',
    });
    expect(
      issuesOf(
        wf(
          [ai('a'), ai('b'), { id: 'd', type: 'control.delay', config: { duration: 1 } }],
          [
            { from: 'a', to: 'd' },
            { from: 'b', to: 'd' },
          ],
        ),
      ),
    ).toContainEqual({ path: 'edges.1.toPort', code: 'single_input' });
    // `many` inputs (AI steps, merge) take several edges.
    expect(
      validateV2(
        wf(
          [ai('a'), ai('b'), ai('c')],
          [
            { from: 'a', to: 'c' },
            { from: 'b', to: 'c' },
          ],
        ),
      ).ok,
    ).toBe(true);
  });

  it('refuses edges into triggers and port schema mismatches', () => {
    expect(
      issuesOf(wf([ai('a'), { id: 't', type: 'trigger.manual' }], [{ from: 'a', to: 't' }])).map(
        (i) => i.code,
      ),
    ).toEqual(expect.arrayContaining(['unknown_port']));
    // data.filter.kept is an array; data.template's input accepts anything; ai.step out → if in is fine.
    expect(
      validateV2(
        wf(
          [
            ai('a'),
            { id: 'f', type: 'data.filter', config: { items: { $expr: '$input' }, keep: { $expr: 'true' } } },
            { id: 't', type: 'data.template', config: { template: 'x' } },
          ],
          [
            { from: 'a', to: 'f' },
            { from: 'f', fromPort: 'kept', to: 't' },
          ],
        ),
      ).ok,
    ).toBe(true);
  });

  it('groups: children only through the group’s inner port; edges never cross a scope; nesting ≤ 3', () => {
    const fe = (id: string, parent?: string) => ({
      id,
      type: 'control.forEach',
      config: { items: { $expr: '$input' } },
      ...(parent === undefined ? {} : { parent }),
    });
    const ok = wf(
      [
        ai('a'),
        fe('g'),
        ai('body', { parent: 'g' }),
        { id: 'r', type: 'control.return', parent: 'g' },
        ai('after'),
      ],
      [
        { from: 'a', to: 'g' },
        { from: 'g', fromPort: 'item', to: 'body' },
        { from: 'body', to: 'r' },
        { from: 'g', fromPort: 'results', to: 'after' },
      ],
    );
    expect(validateV2(ok).ok, JSON.stringify(issuesOf(ok))).toBe(true);
    // A top-level node feeding a body node directly crosses the scope.
    expect(
      issuesOf(
        wf(
          [ai('a'), fe('g'), ai('body', { parent: 'g' })],
          [
            { from: 'a', to: 'g' },
            { from: 'a', to: 'body' },
          ],
        ),
      ),
    ).toContainEqual({ path: 'edges.1', code: 'crosses_scope' });
    // Parent must be a group.
    expect(issuesOf(wf([ai('a'), ai('b', { parent: 'a' })], []))).toContainEqual({
      path: 'nodes.1.parent',
      code: 'not_a_group',
    });
    // Depth 4 refused.
    expect(
      issuesOf(
        wf([fe('g1'), fe('g2', 'g1'), fe('g3', 'g2'), fe('g4', 'g3'), ai('x', { parent: 'g4' })], []),
      ).map((i) => i.code),
    ).toContain('too_deep');
    expect(issuesOf(wf([{ id: 'r', type: 'control.return' }], []))).toContainEqual({
      path: 'nodes.0',
      code: 'return_outside_group',
    });
  });

  it('refuses cycles (repetition is structured: loops are groups, never back edges)', () => {
    expect(
      issuesOf(
        wf(
          [ai('a'), ai('b'), { id: 'c', type: 'control.if', config: { condition: true } }],
          [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
            { from: 'c', fromPort: 'true', to: 'a' },
          ],
        ),
      ),
    ).toContainEqual({ path: 'edges', code: 'cycle' });
  });

  it('references: templates and $node only to ancestors; inputs declared', () => {
    const codes = issuesOf(
      wf(
        [
          ai('a', { prompt: 'Use {{upstream.b.summary}} and {{inputs.nope}}' }),
          ai('b'),
          { id: 't', type: 'data.template', config: { template: '{{ $node.zzz.out }}' } },
        ],
        [{ from: 'a', to: 't' }],
      ),
    ).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(['not_upstream:b', 'undeclared_input:nope', 'not_upstream:zzz']),
    );
  });

  it('AI-step rules carried over from v1', () => {
    const codes = issuesOf(
      wf(
        [
          ai('i', { role: 'integrator' }),
          ai('p', { dynamic: { maxNodes: 2 } }),
          ai('r', { retry: { max: 2 } }),
          ai('d', { deploy: { kind: 'coolify.deploy', env: 'preview' } }),
          ai('big', { retry: { max: 5, safe: true } }),
        ],
        [],
      ),
    ).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'integrator_needs_upstream',
        'planner_only',
        'requires_retry_safe',
        'deploy_needs_verifier_or_integrator',
        'out_of_range',
      ]),
    );
  });

  it('limits: 200 nodes, 50 AI steps, 512 KiB', () => {
    const many = Array.from({ length: 51 }, (_, i) => ai(`a${String(i)}`));
    expect(issuesOf(wf(many, [])).map((i) => i.code)).toContain('too_many_ai_steps');
    const big = wf([ai('a', { prompt: 'x'.repeat(16 * 1024) })], [], {
      description: 'x'.repeat(900),
      layout: { positions: Object.fromEntries(Array.from({ length: 1 }, () => ['a', { x: 0, y: 0 }])) },
    });
    expect(validateV2(big).ok).toBe(true);
    const huge = { ...wf([ai('a')], []), padding: 'x'.repeat(V2_LIMITS.maxDefinitionBytes) };
    expect(issuesOf(huge)).toEqual([{ path: '', code: 'too_large' }]);
  });

  it('issues never carry prompt or config text', () => {
    const r = issuesOf(wf([ai('a', { prompt: 'SECRET-PROMPT {{inputs.missing}}' })], []));
    expect(JSON.stringify(r)).not.toContain('SECRET-PROMPT');
  });

  it('ancestors of a body node include its group and the group’s ancestors', () => {
    const r = validateV2(
      wf(
        [
          ai('a'),
          { id: 'g', type: 'control.forEach', config: { items: { $expr: '$input' } } },
          ai('b', { parent: 'g' }),
        ],
        [
          { from: 'a', to: 'g' },
          { from: 'g', fromPort: 'item', to: 'b' },
        ],
      ),
    );
    expect(r.ok).toBe(true);
    const anc = ancestorsOf((r as { def: WorkflowDefinitionV2 }).def);
    expect([...(anc.get('b') ?? [])].sort()).toEqual(['a', 'g']);
  });

  it('14.1: every expression of an expression field is checked at save on its exact path (static fields untouched)', () => {
    const seen: string[] = [];
    const r = validateV2(
      wf(
        [
          {
            id: 's',
            type: 'data.set',
            config: { fields: { a: { $expr: 'BAD' }, b: 'x {{ ok }} y', c: 'plain' } },
          },
          {
            id: 'w',
            type: 'control.switch',
            config: { value: { $expr: 'v' }, cases: [{ name: 'one', match: { $expr: 'BAD' } }] },
          },
        ],
        [{ from: 's', to: 'w' }],
      ),
      {
        checkExpression: (src, mode) => {
          seen.push(`${mode}:${src}`);
          return src.includes('BAD') ? { code: 'expr_syntax' } : null;
        },
      },
    );
    expect(r.ok).toBe(false);
    expect((r as { issues: unknown[] }).issues).toEqual([
      { path: 'nodes.0.config.fields.a', code: 'expr_syntax' },
      { path: 'nodes.1.config.cases.0.match', code: 'expr_syntax' },
    ]);
    expect(seen.sort()).toEqual(['expr:BAD', 'expr:BAD', 'expr:v', 'template:x {{ ok }} y']);
    expect(configExpressions({ a: [{ $expr: '1' }], b: { $expr: '2', c: 1 } }, ['f'])).toEqual([
      { path: ['f', 'a', 0], source: '1', mode: 'expr' },
    ]);
  });
});
