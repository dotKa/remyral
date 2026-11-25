import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyToolCall } from '@remyral/protocol';
import {
  ASK_USER_TOOL_NAMES,
  askUserToolSpecs,
  type AskUserToolHost,
  DEPLOY_TOOL_NAMES,
  type DeployToolHost,
  isJobChannelTool,
  jobChannelToolNames,
  jobChannelToolSpecs,
  opencodeSubtaskServerSource,
  runAskUserTool,
  runJobChannelTool,
  SubtaskFileRelay,
} from '../src/index.js';
import { askUserMcpServer, type ClaudeSdkPort } from '../src/runtimes/claude-code/adapter.js';
import { codexSubtaskDynamicTools } from '../src/runtimes/codex/config.js';
import { piSubtaskExtensionSource } from '../src/runtimes/pi/subtask-extension.js';

/** p14-ask-user: the in-job question tools on every runtime's job-tool channel. */

const root = mkdtempSync(join(tmpdir(), 'remyral-ask-tools-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function askHost(log: unknown[]): AskUserToolHost {
  return {
    ask: (a) => {
      log.push(['ask', a]);
      return Promise.resolve({ ok: true, text: 'The user answered: preview' });
    },
    wait: (id, waitSec) => {
      log.push(['wait', id, waitSec]);
      return Promise.resolve({ ok: true, text: 'still open' });
    },
  };
}

const deploy: DeployToolHost = {
  status: () => Promise.resolve({ ok: true, text: 's' }),
  logs: () => Promise.resolve({ ok: true, text: 'l' }),
  redeploy: () => Promise.resolve({ ok: true, text: 'r' }),
};

const question = {
  prompt: 'Which environment?',
  kind: 'single',
  options: [{ label: 'preview' }, { label: 'production' }],
  allowOther: true,
};

describe('question tools', () => {
  it('validate arguments strictly (question schema, sizes) and dispatch to the host', async () => {
    const log: unknown[] = [];
    const h = askHost(log);
    expect(await runAskUserTool(h, 'ask_user', { questions: [question], waitSec: 30 })).toEqual({
      ok: true,
      text: 'The user answered: preview',
    });
    expect(log[0]).toEqual([
      'ask',
      { title: undefined, questions: [question], timeoutSec: undefined, waitSec: 30 },
    ]);
    // Malformed: no options for a choice, too many questions, a too long wait, unknown fields, a bad id.
    const bad: Record<string, unknown>[] = [
      { questions: [{ prompt: 'x', kind: 'single', options: [{ label: 'a' }] }] },
      { questions: Array.from({ length: 5 }, () => question) },
      { questions: [question], waitSec: 601 },
      { questions: [question], timeoutSec: 5 },
      { questions: [question], recipients: ['someone'] },
    ];
    for (const b of bad) expect((await runAskUserTool(h, 'ask_user', b)).ok, JSON.stringify(b)).toBe(false);
    expect((await runAskUserTool(h, 'wait_for_answer', { questionId: 'nope' })).ok).toBe(false);
    const id = randomUUID();
    expect(await runAskUserTool(h, 'wait_for_answer', { questionId: id })).toEqual({
      ok: true,
      text: 'still open',
    });
    expect(log).toHaveLength(2);
    const boom: AskUserToolHost = { ...h, ask: () => Promise.reject(new Error('down')) };
    expect(await runAskUserTool(boom, 'ask_user', { questions: [question] })).toEqual({
      ok: false,
      text: 'the question tool failed: down',
    });
  });

  it('ride on the job-tool channel only when the job has them', async () => {
    const a = askHost([]);
    expect(jobChannelToolNames({ askUserTools: a })).toEqual([...ASK_USER_TOOL_NAMES]);
    expect(jobChannelToolNames({ deployTools: deploy, askUserTools: a })).toEqual([
      ...DEPLOY_TOOL_NAMES,
      ...ASK_USER_TOOL_NAMES,
    ]);
    expect(jobChannelToolNames({ deployTools: deploy })).not.toContain('ask_user');
    expect(isJobChannelTool({ deployTools: deploy }, 'ask_user')).toBe(false);
    expect(
      await runJobChannelTool({ deployTools: deploy }, 'ask_user', { questions: [question] }),
    ).toMatchObject({
      ok: false,
    });
    expect(await runJobChannelTool({ askUserTools: a }, 'ask_user', { questions: [question] })).toMatchObject(
      { ok: true },
    );
    for (const s of askUserToolSpecs()) {
      expect(s.inputSchema.type).toBe('object');
      expect(s.inputSchema.additionalProperties).toBe(false);
    }
    expect(JSON.stringify(askUserToolSpecs()[0]?.inputSchema)).toContain('allowOther');
  });

  it('Codex dynamic tools, the Pi extension and the OpenCode server list them; OpenCode caps their waits', () => {
    const names = codexSubtaskDynamicTools({ askUserTools: askHost([]) }).map((t) => t.name);
    expect(names).toEqual([...ASK_USER_TOOL_NAMES]);
    const src = piSubtaskExtensionSource(jobChannelToolSpecs({ askUserTools: askHost([]) }));
    for (const n of ASK_USER_TOOL_NAMES) expect(src).toContain(`"name":"${n}"`);
    const oc = opencodeSubtaskServerSource(jobChannelToolSpecs({ askUserTools: askHost([]) }), '/x', 120);
    expect(oc).toContain('"name":"ask_user"');
    expect(oc).toContain("name === 'ask_user' || name === 'wait_for_answer'");
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
    expect(askUserMcpServer(sdk, askHost(log), new AbortController().signal)).toMatchObject({
      name: 'remyral-ask',
    });
    const s = server as { name: string; tools: Tool[] } | null;
    if (s === null) throw new Error('no server');
    expect(s.tools.map((t) => t.name)).toEqual([...ASK_USER_TOOL_NAMES]);
    const out = await s.tools.find((t) => t.name === 'ask_user')?.handler({ questions: [question] });
    expect(out).toEqual({ content: [{ type: 'text', text: 'The user answered: preview' }], isError: false });
  });

  it('OpenCode: the file relay answers question tool calls from the channel', async () => {
    const dir = join(root, randomUUID());
    await SubtaskFileRelay.prepare(dir);
    const log: unknown[] = [];
    const abort = new AbortController();
    const relay = new SubtaskFileRelay({
      dir,
      channel: { askUserTools: askHost(log) },
      signal: abort.signal,
    });
    const id = randomUUID();
    writeFileSync(
      join(dir, `${id}.req.json`),
      JSON.stringify({ id, tool: 'ask_user', args: { questions: [question] } }),
    );
    await relay.scan();
    for (let i = 0; i < 50 && !existsSync(join(dir, `${id}.res.json`)); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(JSON.parse(readFileSync(join(dir, `${id}.res.json`), 'utf8'))).toEqual({
      ok: true,
      text: 'The user answered: preview',
    });
    expect(log).toHaveLength(1);
    abort.abort();
  });

  it('continuity: asking is external (it notifies people), waiting is idempotent', () => {
    expect(classifyToolCall('mcp__remyral-ask__ask_user', '{}')).toBe('external');
    expect(classifyToolCall('mcp__remyral-ask__wait_for_answer', '{}')).toBe('idempotent');
  });
});
