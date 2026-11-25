import { describe, expect, it } from 'vitest';
import {
  isSubtaskToolName,
  runSubtaskTool,
  subtaskToolSpecs,
  SUBTASK_TOOL_NAMES,
  SUBTASK_TOOL_PREFIX,
  type SubtaskToolHost,
} from '../src/subtask-tools.js';
import { type ClaudeSdkPort, subtaskMcpServer } from '../src/runtimes/claude-code/adapter.js';

function recordingHost(): { host: SubtaskToolHost; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    host: {
      request: (args) => {
        calls.push(['request', args]);
        return Promise.resolve({ ok: true, text: 'Sub-job 1 queued.' });
      },
      wait: (id, waitSec) => {
        calls.push(['wait', id, waitSec]);
        return Promise.resolve({ ok: true, text: 'running' });
      },
      cancel: (id) => {
        calls.push(['cancel', id]);
        return Promise.resolve({ ok: true, text: 'cancelled' });
      },
    },
  };
}

const ID = '00000000-0000-4000-8000-0000000000e2';

describe('sub-job tools (ADR-0031)', () => {
  it('validates arguments strictly before they reach the host', async () => {
    const { host, calls } = recordingHost();
    expect(SUBTASK_TOOL_PREFIX).toBe('mcp__remyral-subtasks__');
    const ok = await runSubtaskTool(host, 'request_subtask', {
      title: 'Thumbnails',
      prompt: 'Make three.',
      runtime: 'codex',
      requires: ['image-generation'],
      inputs: ['out/script.md'],
    });
    expect(ok.ok).toBe(true);
    expect(calls[0]).toEqual([
      'request',
      {
        title: 'Thumbnails',
        prompt: 'Make three.',
        runtime: 'codex',
        requires: ['image-generation'],
        inputs: ['out/script.md'],
        paths: undefined,
        wait: true,
        waitSec: undefined,
      },
    ]);
    for (const bad of [
      { title: 'x', prompt: 'y', runtime: 'openhands' },
      { title: 'x', prompt: 'y', sandboxProfile: 'unconfined' },
      { title: 'x', prompt: 'y', approvalPolicy: 'allow-all' },
      { title: 'x', prompt: 'y', waitSec: 3600 },
      { title: '', prompt: 'y' },
    ]) {
      const r = await runSubtaskTool(host, 'request_subtask', bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(r.text).toMatch(/^invalid arguments/);
    }
    expect(calls).toHaveLength(1);
    await runSubtaskTool(host, 'wait_subtask', { subtaskId: ID, waitSec: 0 });
    await runSubtaskTool(host, 'cancel_subtask', { subtaskId: ID });
    expect((await runSubtaskTool(host, 'wait_subtask', { subtaskId: 'nope' })).ok).toBe(false);
    expect(calls.slice(1)).toEqual([
      ['wait', ID, 0],
      ['cancel', ID],
    ]);
  });

  it('p11-merge-pipeline: paths (file ownership) are validated and reach the host', async () => {
    const { host, calls } = recordingHost();
    const r = await runSubtaskTool(host, 'request_subtask', {
      title: 'API',
      prompt: 'Build the API.',
      paths: ['src/api/', 'src/**/*.ts', 'README.md'],
      wait: false,
    });
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject(['request', { paths: ['src/api/', 'src/**/*.ts', 'README.md'] }]);
    for (const bad of ['/etc', '../x', 'a/../b', 'a\\b', '']) {
      const out = await runSubtaskTool(host, 'request_subtask', { title: 't', prompt: 'p', paths: [bad] });
      expect(out.ok, bad).toBe(false);
      expect(out.text).toMatch(/^invalid arguments: paths/);
    }
    expect(calls).toHaveLength(1);
  });

  it('JSON Schema specs (Codex dynamic tools, Pi extension tools) mirror the zod inputs', () => {
    const specs = subtaskToolSpecs();
    expect(specs.map((t) => t.name)).toEqual(SUBTASK_TOOL_NAMES);
    const req = specs[0]?.inputSchema as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { type?: string; description?: string; maxItems?: number }>;
      $schema?: string;
    };
    expect(req.type).toBe('object');
    expect(req.additionalProperties).toBe(false);
    expect(req.required.sort()).toEqual(['prompt', 'title']);
    expect(req.$schema).toBeUndefined();
    expect(req.properties.paths).toMatchObject({ type: 'array', maxItems: 32 });
    expect(req.properties.paths?.description).toMatch(/disjoint paths/);
    expect(specs.find((t) => t.name === 'wait_subtask')?.inputSchema).toMatchObject({
      required: ['subtaskId'],
    });
    expect(isSubtaskToolName('request_subtask')).toBe(true);
    expect(isSubtaskToolName('shell')).toBe(false);
  });

  it('Claude Code registers them as one in-process MCP server routed to the host', async () => {
    const { host, calls } = recordingHost();
    type Tool = { name: string; handler: (args: unknown) => Promise<{ isError: boolean }> };
    let server: { name: string; tools: Tool[] } | null = null;
    const sdk = {
      query: () => {
        throw new Error('unused');
      },
      createSdkMcpServer: (o: { name: string; tools: Tool[] }) => {
        server = o;
        return { type: 'sdk', name: o.name };
      },
      tool: (name: string, _d: string, _s: unknown, handler: Tool['handler']) => ({ name, handler }),
    } as unknown as ClaudeSdkPort;
    expect(subtaskMcpServer(sdk, host, new AbortController().signal)).toMatchObject({
      name: 'remyral-subtasks',
    });
    const s = server as { name: string; tools: Tool[] } | null;
    if (s === null) throw new Error('no server');
    expect(s.tools.map((t) => t.name)).toEqual(SUBTASK_TOOL_NAMES);
    const r = await s.tools[0]?.handler({ title: 't', prompt: 'p', wait: false });
    expect(r?.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(() =>
      subtaskMcpServer({ query: () => null as never }, host, new AbortController().signal),
    ).toThrow(/in-process tools/);
  });
});
