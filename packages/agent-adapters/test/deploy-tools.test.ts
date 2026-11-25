import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEPLOY_TOOL_NAMES,
  deployToolSpecs,
  type DeployToolHost,
  isJobChannelTool,
  jobChannelToolNames,
  jobChannelToolSpecs,
  opencodeSubtaskServerSource,
  runDeployTool,
  runJobChannelTool,
  SUBTASK_TOOL_NAMES,
  SubtaskFileRelay,
  type SubtaskToolHost,
} from '../src/index.js';
import { type ClaudeSdkPort, deployMcpServer } from '../src/runtimes/claude-code/adapter.js';
import { codexSubtaskDynamicTools } from '../src/runtimes/codex/config.js';
import { piSubtaskExtensionSource } from '../src/runtimes/pi/subtask-extension.js';
import { classifyToolCall } from '@remyral/protocol';

/** p12-deploy-feedback (ADR-0048): the in-job deploy tools and the shared job-tool channel of every runtime. */

const root = mkdtempSync(join(tmpdir(), 'remyral-deploy-tools-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function deployHost(log: unknown[]): DeployToolHost {
  return {
    status: (a) => {
      log.push(['status', a]);
      return Promise.resolve({ ok: true, text: 'recent deploys' });
    },
    logs: (a) => {
      log.push(['logs', a]);
      return Promise.resolve({ ok: true, text: 'build log' });
    },
    redeploy: (a) => {
      log.push(['redeploy', a]);
      return Promise.resolve({ ok: true, text: 'recorded' });
    },
  };
}

const subtasks: SubtaskToolHost = {
  request: () => Promise.resolve({ ok: true, text: 'sub' }),
  wait: () => Promise.resolve({ ok: true, text: 'wait' }),
  cancel: () => Promise.resolve({ ok: true, text: 'cancel' }),
};

describe('deploy tools', () => {
  it('validates arguments strictly and dispatches to the host; a throwing host becomes an error result', async () => {
    const log: unknown[] = [];
    const h = deployHost(log);
    expect(await runDeployTool(h, 'deploy_logs', { kind: 'runtime', env: 'preview', lines: 50 })).toEqual({
      ok: true,
      text: 'build log',
    });
    expect(log[0]).toEqual([
      'logs',
      { actionId: undefined, kind: 'runtime', lines: 50, sinceMinutes: undefined, env: 'preview' },
    ]);
    expect((await runDeployTool(h, 'deploy_logs', { kind: 'secrets' })).ok).toBe(false);
    expect((await runDeployTool(h, 'deploy_status', { actionId: 'not-a-uuid' })).ok).toBe(false);
    expect((await runDeployTool(h, 'request_redeploy', { env: 'production', force: true })).ok).toBe(false);
    expect(log).toHaveLength(1);
    const boom: DeployToolHost = { ...h, status: () => Promise.reject(new Error('down')) };
    expect(await runDeployTool(boom, 'deploy_status', {})).toEqual({
      ok: false,
      text: 'the deploy tool failed: down',
    });
  });

  it('the job-tool channel carries exactly the tools the job has', async () => {
    const d = deployHost([]);
    expect(jobChannelToolNames({ deployTools: d })).toEqual([...DEPLOY_TOOL_NAMES]);
    expect(jobChannelToolNames({ subtaskTools: subtasks })).toEqual([...SUBTASK_TOOL_NAMES]);
    expect(jobChannelToolNames({ subtaskTools: subtasks, deployTools: d })).toEqual([
      ...SUBTASK_TOOL_NAMES,
      ...DEPLOY_TOOL_NAMES,
    ]);
    expect(jobChannelToolSpecs({ deployTools: d }).map((s) => s.name)).toEqual([...DEPLOY_TOOL_NAMES]);
    expect(isJobChannelTool({ deployTools: d }, 'request_subtask')).toBe(false);
    expect(isJobChannelTool({ subtaskTools: subtasks }, 'deploy_logs')).toBe(false);
    expect(await runJobChannelTool({ subtaskTools: subtasks }, 'deploy_logs', {})).toMatchObject({
      ok: false,
    });
    expect(await runJobChannelTool({ deployTools: d }, 'deploy_status', {})).toEqual({
      ok: true,
      text: 'recent deploys',
    });
    for (const s of deployToolSpecs()) {
      expect(s.inputSchema.type).toBe('object');
      expect(s.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('Codex dynamic tools and the Pi extension list the deploy tools', () => {
    const names = codexSubtaskDynamicTools({ deployTools: deployHost([]) }).map((t) => t.name);
    expect(names).toEqual([...DEPLOY_TOOL_NAMES]);
    expect(codexSubtaskDynamicTools().map((t) => t.name)).toEqual([...SUBTASK_TOOL_NAMES]);
    const src = piSubtaskExtensionSource(jobChannelToolSpecs({ deployTools: deployHost([]) }));
    for (const n of DEPLOY_TOOL_NAMES) expect(src).toContain(`"name":"${n}"`);
    const oc = opencodeSubtaskServerSource(jobChannelToolSpecs({ deployTools: deployHost([]) }), '/x', 0);
    expect(oc).toContain('"name":"deploy_logs"');
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
    const log: unknown[] = [];
    expect(deployMcpServer(sdk, deployHost(log))).toMatchObject({ name: 'remyral-deploy' });
    const s = server as { name: string; tools: Tool[] } | null;
    if (s === null) throw new Error('no server');
    expect(s.tools.map((t) => t.name)).toEqual([...DEPLOY_TOOL_NAMES]);
    const out = await s.tools.find((t) => t.name === 'request_redeploy')?.handler({ env: 'preview' });
    expect(out).toEqual({ content: [{ type: 'text', text: 'recorded' }], isError: false });
    expect(log).toEqual([['redeploy', { target: undefined, env: 'preview' }]]);
  });

  it('OpenCode: the file relay answers deploy tool calls from the channel (no sub-job tools needed)', async () => {
    const dir = join(root, randomUUID());
    await SubtaskFileRelay.prepare(dir);
    const log: unknown[] = [];
    const abort = new AbortController();
    const relay = new SubtaskFileRelay({
      dir,
      channel: { deployTools: deployHost(log) },
      signal: abort.signal,
    });
    const ok = randomUUID();
    writeFileSync(join(dir, `${ok}.req.json`), JSON.stringify({ id: ok, tool: 'deploy_status', args: {} }));
    const sub = randomUUID();
    writeFileSync(
      join(dir, `${sub}.req.json`),
      JSON.stringify({ id: sub, tool: 'request_subtask', args: {} }),
    );
    await relay.scan();
    for (
      let i = 0;
      i < 50 && !(existsSync(join(dir, `${ok}.res.json`)) && existsSync(join(dir, `${sub}.res.json`)));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(JSON.parse(readFileSync(join(dir, `${ok}.res.json`), 'utf8'))).toEqual({
      ok: true,
      text: 'recent deploys',
    });
    expect(JSON.parse(readFileSync(join(dir, `${sub}.res.json`), 'utf8'))).toMatchObject({ ok: false });
    expect(log).toHaveLength(1);
    abort.abort();
  });

  it('continuity: the read tools are idempotent, request_redeploy is external', () => {
    expect(classifyToolCall('mcp__remyral-deploy__deploy_logs', '{}')).toBe('idempotent');
    expect(classifyToolCall('mcp__remyral-deploy__deploy_status', '{}')).toBe('idempotent');
    expect(classifyToolCall('mcp__remyral-deploy__request_redeploy', '{}')).toBe('external');
  });
});
