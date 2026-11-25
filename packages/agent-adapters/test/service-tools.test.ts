import { describe, expect, it } from 'vitest';
import { classifyToolCall } from '@remyral/protocol';
import {
  isJobChannelTool,
  jobChannelToolNames,
  jobChannelToolSpecs,
  runJobChannelTool,
  runServiceTool,
  SERVICE_TOOL_NAMES,
  serviceToolSpecs,
  type ServiceToolHost,
} from '../src/index.js';
import { type ClaudeSdkPort, serviceMcpServer } from '../src/runtimes/claude-code/adapter.js';
import { codexSubtaskDynamicTools } from '../src/runtimes/codex/config.js';
import { piSubtaskExtensionSource } from '../src/runtimes/pi/subtask-extension.js';

/** p15-services: the in-job service tools on every runtime's job-tool channel. */

function host(log: unknown[]): ServiceToolHost {
  const ok = (what: string) => (a?: unknown) => {
    log.push([what, a]);
    return Promise.resolve({ ok: true, text: what });
  };
  return { start: ok('start'), list: ok('list'), stop: ok('stop'), restart: ok('restart'), logs: ok('logs') };
}

describe('service tools', () => {
  it('validate strictly and dispatch to the host', async () => {
    const log: unknown[] = [];
    const h = host(log);
    expect(
      await runServiceTool(h, 'start_service', {
        name: 'web',
        command: 'pnpm dev --port 5173',
        port: 5173,
        tunnel: 'quick',
      }),
    ).toEqual({ ok: true, text: 'start' });
    expect(log[0]).toEqual([
      'start',
      { name: 'web', command: 'pnpm dev --port 5173', port: 5173, tunnel: 'quick' },
    ]);
    const bad: Record<string, unknown>[] = [
      { name: 'Web', command: 'x' },
      { name: 'web', command: '' },
      { name: 'web', command: 'x', port: 22 },
      { name: 'web', command: 'x', cwd: '../up' },
      { name: 'web', command: 'x', secretEnv: { K: 'value' } },
      { name: 'web', command: 'x', workerId: 'other' },
    ];
    for (const b of bad)
      expect((await runServiceTool(h, 'start_service', b)).ok, JSON.stringify(b)).toBe(false);
    expect(await runServiceTool(h, 'service_logs', { name: 'web', lines: 50 })).toEqual({
      ok: true,
      text: 'logs',
    });
    expect((await runServiceTool(h, 'service_logs', { name: 'web', lines: 501 })).ok).toBe(false);
    expect((await runServiceTool(h, 'stop_service', { serviceId: 'nope' })).ok).toBe(false);
    const boom: ServiceToolHost = { ...h, list: () => Promise.reject(new Error('down')) };
    expect(await runServiceTool(boom, 'list_services', {})).toEqual({
      ok: false,
      text: 'the service tool failed: down',
    });
  });

  it('ride on the job-tool channel (Codex, Pi, OpenCode) only when the job has them', async () => {
    const h = host([]);
    expect(jobChannelToolNames({ serviceTools: h })).toEqual([...SERVICE_TOOL_NAMES]);
    expect(isJobChannelTool({}, 'start_service')).toBe(false);
    expect(await runJobChannelTool({ serviceTools: h }, 'list_services', {})).toEqual({
      ok: true,
      text: 'list',
    });
    expect(codexSubtaskDynamicTools({ serviceTools: h }).map((t) => t.name)).toEqual([...SERVICE_TOOL_NAMES]);
    const src = piSubtaskExtensionSource(jobChannelToolSpecs({ serviceTools: h }));
    for (const n of SERVICE_TOOL_NAMES) expect(src).toContain(`"name":"${n}"`);
    for (const s of serviceToolSpecs()) {
      expect(s.inputSchema.type).toBe('object');
      expect(s.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('Claude Code: an in-process MCP server routes calls to the host', async () => {
    type Tool = {
      name: string;
      handler: (args: unknown) => Promise<{ isError: boolean; content: { text: string }[] }>;
    };
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
    expect(serviceMcpServer(sdk, host([]))).toMatchObject({ name: 'remyral-services' });
    const s = server as { name: string; tools: Tool[] } | null;
    if (s === null) throw new Error('no server');
    expect(s.tools.map((t) => t.name)).toEqual([...SERVICE_TOOL_NAMES]);
    const out = await s.tools.find((t) => t.name === 'list_services')?.handler({});
    expect(out).toEqual({ content: [{ type: 'text', text: 'list' }], isError: false });
  });

  it('continuity: starting outlives the job, listing is idempotent', () => {
    expect(classifyToolCall('mcp__remyral-services__start_service', '{}')).toBe('external');
    expect(classifyToolCall('mcp__remyral-services__list_services', '{}')).toBe('idempotent');
  });
});
