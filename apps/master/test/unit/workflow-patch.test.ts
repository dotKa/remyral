import { WorkflowPatch, type WorkflowPatchOp } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { workflowChanges } from '../../src/workflows/draft-diff.js';
import {
  applyWorkflowPatch,
  CLIP_MARKER,
  DEEP_MARKER,
  definitionView,
  VIEW_BUDGET,
} from '../../src/workflows/patch.js';

/**
 * p22-workflow-patch: patch operations on a saved document and the bounded definition read (pure halves; the
 * integration test drives them through describe_workflow / draft_workflow).
 */

const DOC = {
  schemaVersion: 2,
  name: 'leads',
  description: 'Lead package',
  inputs: { city: { required: true } },
  nodes: [
    { id: 'start', type: 'trigger.manual' },
    { id: 'scan', type: 'ai.step', role: 'executor', prompt: 'Scan the city {{inputs.city}} for leads.' },
    { id: 'pick', type: 'ai.step', role: 'reviewer', prompt: 'Pick the best ten.' },
    { id: 'wa1', type: 'control.subWorkflow', config: { workflow: 'other/whatsapp', inputs: { to: 'a' } } },
    { id: 'wa2', type: 'control.subWorkflow', config: { workflow: 'other/whatsapp', inputs: { to: 'b' } } },
  ],
  edges: [
    { from: 'start', to: 'scan' },
    { from: 'scan', to: 'pick' },
    { from: 'pick', to: 'wa1' },
    { from: 'pick', to: 'wa2' },
  ],
  layout: { positions: { wa1: { x: 1, y: 2 }, scan: { x: 0, y: 0 } } },
};

const http = (id: string) => ({
  id,
  type: 'http.request',
  config: { method: 'POST', origin: 'https://graph.example.com', path: '/v1/messages' },
});

describe('applyWorkflowPatch', () => {
  it('replaces two sub-workflow steps with http.request steps and keeps everything else byte for byte', () => {
    const out = applyWorkflowPatch(DOC, [
      { op: 'replace_node', id: 'wa1', node: http('wa1') },
      { op: 'replace_node', id: 'wa2', node: http('wa2') },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const changes = workflowChanges(DOC, out.doc).changes;
    expect(changes).toEqual([
      {
        kind: 'node_changed',
        id: 'wa1',
        fields: ['config.inputs', 'config.method', 'config.origin', 'config.path', 'config.workflow', 'type'],
      },
      {
        kind: 'node_changed',
        id: 'wa2',
        fields: ['config.inputs', 'config.method', 'config.origin', 'config.path', 'config.workflow', 'type'],
      },
    ]);
    // Untouched steps and the input document are unchanged.
    expect((out.doc.nodes as unknown[]).slice(0, 3)).toEqual(DOC.nodes.slice(0, 3));
    expect(DOC.nodes[3]?.type).toBe('control.subWorkflow');
  });

  it('update_node merges top-level fields and config keys (null removes)', () => {
    const out = applyWorkflowPatch(DOC, [
      { op: 'update_node', id: 'scan', set: { prompt: 'Scan {{inputs.city}} again.', label: 'Tara' } },
      { op: 'update_node', id: 'wa1', config: { inputs: { to: 'c' }, workflow: null } },
      { op: 'update_node', id: 'pick', set: { role: null } },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const nodes = out.doc.nodes as Record<string, unknown>[];
    expect(nodes[1]).toEqual({
      id: 'scan',
      type: 'ai.step',
      role: 'executor',
      prompt: 'Scan {{inputs.city}} again.',
      label: 'Tara',
    });
    expect(nodes[3]).toEqual({ id: 'wa1', type: 'control.subWorkflow', config: { inputs: { to: 'c' } } });
    expect(nodes[2]).not.toHaveProperty('role');
  });

  it('adds and removes nodes and edges; removing a node drops its edges and position', () => {
    const out = applyWorkflowPatch(DOC, [
      { op: 'remove_node', id: 'wa2' },
      { op: 'add_node', node: http('send') },
      { op: 'remove_edge', edge: { from: 'pick', to: 'wa1' } },
      { op: 'add_edge', edge: { from: 'pick', to: 'send' } },
      { op: 'remove_node', id: 'wa1' },
      { op: 'set', field: 'description', value: 'Leads + WhatsApp via HTTP' },
      { op: 'set', field: 'inputs', value: null },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.doc.nodes as { id: string }[]).map((n) => n.id)).toEqual(['start', 'scan', 'pick', 'send']);
    expect(out.doc.edges).toEqual([
      { from: 'start', to: 'scan' },
      { from: 'scan', to: 'pick' },
      { from: 'pick', to: 'send' },
    ]);
    expect(out.doc.layout).toEqual({ positions: { scan: { x: 0, y: 0 } } });
    expect(out.doc.description).toBe('Leads + WhatsApp via HTTP');
    expect(out.doc).not.toHaveProperty('inputs');
  });

  it('edges match with their default ports', () => {
    const out = applyWorkflowPatch(DOC, [
      { op: 'remove_edge', edge: { from: 'scan', fromPort: 'out', to: 'pick', toPort: 'in' } },
    ]);
    expect(out.ok && (out.doc.edges as unknown[]).length).toBe(3);
    expect(
      applyWorkflowPatch(DOC, [{ op: 'add_edge', edge: { from: 'scan', to: 'pick', toPort: 'in' } }]),
    ).toEqual({
      ok: false,
      issues: [{ path: 'patch.ops.0', code: 'duplicate_edge:scan:out->pick:in' }],
    });
  });

  it('every bad operation is an issue and nothing is applied', () => {
    const out = applyWorkflowPatch(DOC, [
      { op: 'replace_node', id: 'ghost', node: http('ghost') },
      { op: 'replace_node', id: 'wa1', node: http('wa9') },
      { op: 'add_node', node: http('scan') },
      { op: 'remove_node', id: 'nope' },
      { op: 'remove_edge', edge: { from: 'start', to: 'pick' } },
      { op: 'update_node', id: 'scan', set: { id: 'x' } },
      { op: 'update_node', id: 'scan', set: { config: {} } },
      { op: 'update_node', id: 'scan' },
    ]);
    expect(out).toEqual({
      ok: false,
      issues: [
        { path: 'patch.ops.0', code: 'unknown_node:ghost' },
        { path: 'patch.ops.1.node.id', code: 'id_mismatch:wa1' },
        { path: 'patch.ops.2', code: 'duplicate_node:scan' },
        { path: 'patch.ops.3', code: 'unknown_node:nope' },
        { path: 'patch.ops.4', code: 'unknown_edge:start:out->pick:in' },
        { path: 'patch.ops.5.set.id', code: 'id_immutable' },
        { path: 'patch.ops.6.set.config', code: 'use_config_merge' },
        { path: 'patch.ops.7', code: 'empty_update' },
      ],
    });
  });

  it('refuses markers a read wrote (clipped, redacted, too deep) so they never overwrite the saved value', () => {
    for (const value of [
      `Scan ${CLIP_MARKER} 9000 characters; the rest stays as saved]`,
      '[REDACTED:key]',
      DEEP_MARKER,
      '[MaxDepth]',
      '…[3 more]',
    ]) {
      const ops: WorkflowPatchOp[] = [{ op: 'update_node', id: 'scan', set: { prompt: value } }];
      expect(applyWorkflowPatch(DOC, ops)).toEqual({
        ok: false,
        issues: [{ path: 'patch.ops.0', code: 'copied_marker' }],
      });
    }
  });

  it('the protocol schema takes the operations and refuses unknown ones', () => {
    const id = '7f9c2b1e-3a4d-4e5f-8a6b-1c2d3e4f5a6b';
    expect(
      WorkflowPatch.safeParse({
        baseVersionId: id,
        ops: [{ op: 'replace_node', id: 'wa1', node: http('wa1') }],
      }).success,
    ).toBe(true);
    expect(
      WorkflowPatch.safeParse({ baseVersionId: id, ops: [{ op: 'rename_node', id: 'a' }] }).success,
    ).toBe(false);
    expect(WorkflowPatch.safeParse({ baseVersionId: id, ops: [] }).success).toBe(false);
  });
});

describe('definitionView', () => {
  it('shows the whole document without layout, prompts and configs included', () => {
    const v = definitionView(DOC);
    expect(v.document).not.toHaveProperty('layout');
    expect(v.document.nodes).toEqual(DOC.nodes);
    expect(v.document.edges).toEqual(DOC.edges);
    expect(v.document.inputs).toEqual(DOC.inputs);
    expect(v.clipped).toEqual([]);
    expect(v.omittedNodes).toEqual([]);
    expect(v.limits).toEqual({ promptChars: 6000, textChars: 2000, bytes: VIEW_BUDGET });
  });

  it('narrows to nodeIds and the edges that touch them; unknown ids are named', () => {
    const v = definitionView(DOC, { nodeIds: ['wa1', 'zzz'] });
    expect((v.document.nodes as { id: string }[]).map((n) => n.id)).toEqual(['wa1']);
    expect(v.document.edges).toEqual([{ from: 'pick', to: 'wa1' }]);
    expect(v.unknownNodeIds).toEqual(['zzz']);
  });

  it('clips long prompts with a marker and names them; deep values are not shown', () => {
    const long = 'x'.repeat(7000);
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 6; i += 1) deep = { d: deep };
    const v = definitionView({
      ...DOC,
      nodes: [
        { id: 'a', type: 'ai.step', role: 'executor', prompt: long },
        { id: 'b', type: 'data.set', config: { fields: deep } },
      ],
      edges: [],
    });
    const nodes = v.document.nodes as Record<string, unknown>[];
    expect(String(nodes[0]?.prompt)).toContain(CLIP_MARKER);
    expect(String(nodes[0]?.prompt).startsWith('x'.repeat(6000))).toBe(true);
    expect(v.clipped).toContain('nodes.a.prompt (7000 characters)');
    expect(JSON.stringify(nodes[1])).toContain(DEEP_MARKER);
    expect(
      v.clipped.some((c) => c.startsWith('nodes.b.config.fields.d.d') && c.endsWith('(nested too deep)')),
    ).toBe(true);
  });

  it('stays inside the budget: smaller clip limits first, then nodes left out from the end', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `n${String(i)}`,
      type: 'ai.step',
      role: 'executor',
      prompt: `${String(i)} `.repeat(3000),
    }));
    const v = definitionView({ ...DOC, nodes: many, edges: [] });
    expect(JSON.stringify(v.document, null, 1).length).toBeLessThanOrEqual(VIEW_BUDGET);
    expect(v.limits.promptChars).toBe(600);
    expect(v.omittedNodes.length).toBeGreaterThan(0);
    expect(v.omittedNodes.at(-1)).toBe('n59');
    const shown = (v.document.nodes as unknown[]).length;
    expect(shown + v.omittedNodes.length).toBe(60);
  });
});
