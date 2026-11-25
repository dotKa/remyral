import { assistantToolInput } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs } from '../src/assistant-kit.js';

/**
 * p22-workflow-patch: the assistant reads a saved workflow's whole definition (describe_workflow definition: true)
 * and changes single steps with a patch (draft_workflow workflowId + patch) instead of retyping the document.
 */
describe('reading and patching saved workflows (p22-workflow-patch)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';
  const specs = new Map(assistantToolSpecs().map((s) => [s.name, s]));
  const id = '7f9c2b1e-3a4d-4e5f-8a6b-1c2d3e4f5a6b';

  it('rule 25: read the definition first, prefer a patch, never rewrite unread steps, never say a step cannot be patched', () => {
    const r = rule(25);
    expect(r).toContain('describe_workflow definition: true');
    expect(r).toContain('patch {baseVersionId');
    expect(r).toMatch(/Never rewrite or retype a step you have not read/);
    expect(r).toMatch(/never tell the user that a single step cannot be changed/);
    expect(r).toMatch(/newer version was saved, read the definition again/);
    expect(r).not.toContain('not a patch');
  });

  it('describe_workflow offers the definition read; draft_workflow describes the patch operations', () => {
    const describeSpec = specs.get('describe_workflow');
    expect(describeSpec?.description).toContain('definition: true');
    expect(describeSpec?.description).toContain('never rewrite a step you have not read');
    expect(describeSpec?.description).toContain('never copy a marker back');
    const describeSchema = JSON.stringify(describeSpec?.inputSchema);
    expect(describeSchema).toContain('"definition"');
    expect(describeSchema).toContain('"nodeIds"');
    const draft = specs.get('draft_workflow');
    for (const s of [
      'CHANGING A SAVED WORKFLOW',
      'baseVersionId',
      'replace_node',
      'update_node',
      'remove_edge',
    ])
      expect(draft?.description).toContain(s);
    expect(draft?.description).toContain('a single step CAN always be patched');
    const schema = JSON.stringify(draft?.inputSchema);
    expect(schema).toContain('"patch"');
    expect(schema).toContain('"baseVersionId"');
    expect(schema).toContain('"add_edge"');
  });

  it('draft_workflow takes a patch without a definition; bad operations fail the input schema', () => {
    const input = assistantToolInput('draft_workflow');
    expect(
      input.safeParse({
        project: 'p',
        workflowId: id,
        patch: {
          baseVersionId: id,
          ops: [
            {
              op: 'replace_node',
              id: 'wa1',
              node: { id: 'wa1', type: 'http.request', config: { origin: 'https://graph.example.com' } },
            },
            { op: 'update_node', id: 'scan', config: { text: null } },
            { op: 'remove_edge', edge: { from: 'pick', to: 'wa2' } },
            { op: 'set', field: 'description', value: 'x' },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      input.safeParse({ project: 'p', patch: { baseVersionId: id, ops: [{ op: 'rename', id: 'a' }] } })
        .success,
    ).toBe(false);
    expect(
      input.safeParse({
        project: 'p',
        patch: { baseVersionId: id, ops: [{ op: 'set', field: 'name', value: 'x' }] },
      }).success,
    ).toBe(false);
    expect(input.safeParse({ project: 'p', patch: { baseVersionId: 'v1', ops: [] } }).success).toBe(false);
    expect(
      assistantToolInput('describe_workflow').safeParse({ workflowId: id, definition: true, nodeIds: ['a'] })
        .success,
    ).toBe(true);
  });
});
