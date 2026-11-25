import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ASSISTANT_TOOL_NAMES, ASSISTANT_TOOLS, assistantToolDescription } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ASSISTANT_SYSTEM_PROMPT,
  type AssistantSessionOptions,
  type AssistantToolBridge,
  ClaudeAssistantEngine,
  type ClaudeAssistantSdk,
  type ClaudeQueryLike,
  FakeAssistantEngine,
  SecretValue,
} from '../../../src/index.js';
import {
  assistantText,
  initMessage,
  resultInterrupted,
  resultSuccess,
  type CumulativeUsage,
} from '../../fixtures/claude-code/sdk-messages.js';

const root = mkdtempSync(join(tmpdir(), 'remyral-assistant-unit-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface ToolDef {
  readonly name: string;
  readonly handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

type Step =
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string; readonly args: Record<string, unknown> }
  | { readonly kind: 'block'; readonly ms: number }
  | { readonly kind: 'answer'; readonly text: string }
  /** p22-assistant-tools: the model calls a platform tool the session does not have. */
  | { readonly kind: 'missing'; readonly name: string };

/** A stand-in for the SDK's query(): records options, runs scripted turns, calls the in-process MCP tools. */
class FakeAssistantQuery implements ClaudeQueryLike {
  readonly prompts: string[] = [];
  /** p8-chat-attachments-mentions: the user messages as the SDK received them. */
  readonly raw: SDKUserMessage[] = [];
  readonly toolResults: string[] = [];
  readonly #out: SDKMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  #turnAbort: AbortController | null = null;
  #cumulative: CumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  readonly sessionId = randomUUID();
  /** p22-assistant-tools: `Query.mcpServerStatus`, set by a test (absent like on an SDK without it). */
  mcpServerStatus?: () => Promise<{ name: string; status: string }[]>;

  constructor(
    input: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
    private readonly script: (prompt: string, turn: number) => Step[],
    private readonly initTools: string[] | null,
  ) {
    void this.#read(input);
  }

  #emit(m: SDKMessage): void {
    if (this.#closed) return;
    this.#out.push(m);
    this.#wake?.();
  }

  async #read(input: AsyncIterable<SDKUserMessage>): Promise<void> {
    let turn = 0;
    for await (const m of input) {
      this.raw.push(m);
      const prompt = typeof m.message.content === 'string' ? m.message.content : '[blocks]';
      this.prompts.push(prompt);
      turn += 1;
      if (turn === 1) {
        const init = initMessage(this.sessionId, this.options.permissionMode ?? 'default', root);
        this.#emit({
          ...init,
          tools: this.initTools ?? ASSISTANT_TOOL_NAMES.map((n) => `mcp__remyral__${n}`),
        });
      }
      await this.#turn(prompt, turn);
    }
    this.close();
  }

  async #turn(prompt: string, turn: number): Promise<void> {
    const abort = new AbortController();
    this.#turnAbort = abort;
    this.#cumulative = {
      input: this.#cumulative.input + 100,
      output: this.#cumulative.output + 20,
      cacheRead: this.#cumulative.cacheRead,
      cacheWrite: this.#cumulative.cacheWrite,
      costUsd: this.#cumulative.costUsd + 0.002,
    };
    let answer = '';
    for (const step of this.script(prompt, turn)) {
      if (abort.signal.aborted || this.#closed) break;
      if (step.kind === 'delta') {
        this.#emit({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: this.sessionId,
        } as unknown as SDKMessage);
        answer += step.text;
      } else if (step.kind === 'tool') {
        const server = this.options.mcpServers?.remyral as unknown as { instance: { tools: ToolDef[] } };
        const tool = server.instance.tools.find((t) => t.name === step.name);
        if (tool === undefined) throw new Error(`no tool ${step.name}`);
        const r = await tool.handler(step.args, {});
        this.toolResults.push(`${r.isError === true ? 'ERR ' : ''}${r.content[0]?.text ?? ''}`);
      } else if (step.kind === 'missing') {
        const id = `toolu_${randomUUID()}`;
        this.#emit({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id, name: step.name, input: {} }] },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: this.sessionId,
        } as unknown as SDKMessage);
        this.#emit({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: id,
                is_error: true,
                content: `<tool_use_error>Error: No such tool available: ${step.name}</tool_use_error>`,
              },
            ],
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: this.sessionId,
        } as unknown as SDKMessage);
        await new Promise((r) => setTimeout(r, 20));
      } else if (step.kind === 'block') {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, step.ms);
          abort.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
      } else {
        answer = step.text;
        this.#emit(assistantText(this.sessionId, step.text));
      }
    }
    if (this.#closed) return;
    if (abort.signal.aborted) this.#emit(resultInterrupted(this.sessionId, this.#cumulative));
    else this.#emit(resultSuccess(this.sessionId, answer, this.#cumulative, { numTurns: 1, durationMs: 40 }));
  }

  initializationResult(): Promise<{ claude_code_version?: string }> {
    return Promise.resolve({ claude_code_version: '2.1.310' });
  }

  interrupt(): Promise<unknown> {
    this.#turnAbort?.abort();
    return Promise.resolve({});
  }

  close(): void {
    this.#closed = true;
    this.#turnAbort?.abort();
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      const m = this.#out.shift();
      if (m !== undefined) {
        yield m;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((r) => (this.#wake = r));
      this.#wake = null;
    }
  }
}

function fakeSdk(
  script: (prompt: string, turn: number) => Step[],
  initTools: string[] | null = null,
): ClaudeAssistantSdk & { queries: FakeAssistantQuery[] } {
  const queries: FakeAssistantQuery[] = [];
  return {
    queries,
    query: ({ prompt, options }) => {
      const q = new FakeAssistantQuery(prompt, options, script, initTools);
      queries.push(q);
      return q;
    },
    createSdkMcpServer: ((o: { name: string; tools?: ToolDef[] }) => ({
      type: 'sdk',
      name: o.name,
      instance: { tools: o.tools ?? [] },
    })) as unknown as ClaudeAssistantSdk['createSdkMcpServer'],
    tool: ((name: string, _d: string, _s: unknown, handler: ToolDef['handler']) => ({
      name,
      handler,
    })) as unknown as ClaudeAssistantSdk['tool'],
  };
}

function bridge(calls: { tool: string; input: Record<string, unknown> }[]): AssistantToolBridge {
  return {
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve({ content: `result of ${tool}`, isError: tool === 'search_audit' });
    },
  };
}

function sessionOptions(over: Partial<AssistantSessionOptions> = {}): AssistantSessionOptions {
  return {
    cwd: mkdtempSync(join(root, 'cwd-')),
    authMode: 'secret-ref',
    secretEnv: {},
    tools: bridge([]),
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    timeouts: { startupMs: 2_000, turnMs: 5_000, cancelGraceMs: 300 },
    ...over,
  };
}

describe('Claude Code assistant engine (p5-ops-chat)', () => {
  it('starts Claude Code with no built-in tools, only the platform tools, no settings and no transcripts', async () => {
    const sdk = fakeSdk(() => [{ kind: 'answer', text: 'hi' }]);
    const engine = new ClaudeAssistantEngine({ binary: () => '/opt/claude', sdk, stateDir: root });
    const secret = 'sk-ant-api03-' + 'q'.repeat(40);
    const session = await engine.start(
      sessionOptions({ secretEnv: { ANTHROPIC_API_KEY: new SecretValue(secret) }, model: 'claude-x' }),
    );
    const o = sdk.queries[0]?.options;
    expect(o?.tools).toEqual([]);
    expect(o?.allowedTools).toEqual(ASSISTANT_TOOL_NAMES.map((n) => `mcp__remyral__${n}`));
    expect(o?.permissionMode).toBe('dontAsk');
    expect(o?.allowDangerouslySkipPermissions).toBe(false);
    expect(o?.settingSources).toEqual([]);
    expect(o?.strictMcpConfig).toBe(true);
    expect(Object.keys(o?.mcpServers ?? {})).toEqual(['remyral']);
    expect(o?.plugins).toEqual([]);
    expect(o?.persistSession).toBe(false);
    expect(o?.verbatimPrompts).toBe(true);
    expect(o?.systemPrompt).toBe(ASSISTANT_SYSTEM_PROMPT);
    expect(o?.model).toBe('claude-x');
    expect(o?.env?.CLAUDE_CONFIG_DIR?.startsWith(root)).toBe(true);
    // The credential goes to the spawned process only, never into the options.
    expect(JSON.stringify(o?.env)).not.toContain(secret);
    const allowed = await o?.canUseTool?.(
      'mcp__remyral__list_jobs',
      {},
      {
        signal: new AbortController().signal,
        toolUseID: 't1',
        requestId: 'r1',
      },
    );
    expect(allowed?.behavior).toBe('allow');
    const denied = await o?.canUseTool?.(
      'Bash',
      { command: 'id' },
      {
        signal: new AbortController().signal,
        toolUseID: 't2',
        requestId: 'r2',
      },
    );
    expect(denied?.behavior).toBe('deny');
    await session.close();
  });

  it('p15-chat-execute-default: declares execute and propose on every draft tool (the bare input shape hid them)', async () => {
    const declared = new Map<string, { description: string; shape: Record<string, unknown> }>();
    const base = fakeSdk(() => [{ kind: 'answer', text: 'hi' }]);
    const sdk: ClaudeAssistantSdk = {
      ...base,
      tool: ((
        name: string,
        description: string,
        shape: Record<string, unknown>,
        handler: ToolDef['handler'],
      ) => {
        declared.set(name, { description, shape });
        return { name, handler };
      }) as unknown as ClaudeAssistantSdk['tool'],
    };
    const engine = new ClaudeAssistantEngine({ binary: () => '/opt/claude', sdk, stateDir: root });
    const session = await engine.start(sessionOptions());
    for (const name of ASSISTANT_TOOL_NAMES) {
      const d = declared.get(name);
      expect(d?.description).toBe(assistantToolDescription(name));
      const keys = Object.keys(d?.shape ?? {});
      if (ASSISTANT_TOOLS[name].kind === 'draft') {
        expect(keys).toEqual(expect.arrayContaining(['execute', 'propose']));
        expect(d?.description).toContain('Acting:');
      } else {
        expect(keys).not.toContain('propose');
        expect(keys).not.toContain('execute');
      }
    }
    await session.close();
  });

  it('streams a turn, relays tool calls to the bridge and reports per-turn usage', async () => {
    const calls: { tool: string; input: Record<string, unknown> }[] = [];
    const sdk = fakeSdk((prompt, turn) => [
      { kind: 'delta', text: 'Looking ' },
      { kind: 'tool', name: 'list_workers', args: { state: 'offline' } },
      { kind: 'tool', name: 'search_audit', args: {} },
      { kind: 'delta', text: `up (turn ${String(turn)}).` },
      { kind: 'answer', text: `Two workers are offline. ${prompt.length > 0 ? '' : ''}`.trim() },
    ]);
    const engine = new ClaudeAssistantEngine({ binary: () => '/opt/claude', sdk, stateDir: root });
    const session = await engine.start(sessionOptions({ tools: bridge(calls) }));
    const deltas: string[] = [];
    const r1 = await session.turn(
      { message: 'Which workers are offline?', history: '<<<fenced history>>>' },
      { delta: (t) => deltas.push(t) },
      new AbortController().signal,
    );
    expect(r1.outcome).toBe('done');
    expect(r1.text).toBe('Two workers are offline.');
    expect(deltas.join('')).toBe('Looking up (turn 1).');
    expect(calls).toEqual([
      { tool: 'list_workers', input: { state: 'offline' } },
      { tool: 'search_audit', input: {} },
    ]);
    expect(sdk.queries[0]?.toolResults).toEqual(['result of list_workers', 'ERR result of search_audit']);
    expect(sdk.queries[0]?.prompts[0]).toContain('<<<fenced history>>>');
    expect(sdk.queries[0]?.prompts[0]).toContain('Which workers are offline?');
    expect(r1.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      provenance: 'reported-by-runtime',
      authMode: 'secret-ref',
    });
    expect(r1.usage.costUsd).toBeCloseTo(0.002);
    // Second turn: the live session holds the conversation; usage is the increment, not the running total.
    const r2 = await session.turn(
      { message: 'And now?', history: null },
      { delta: () => undefined },
      new AbortController().signal,
    );
    expect(sdk.queries[0]?.prompts[1]).toBe('And now?');
    expect(r2.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(r2.usage.costUsd).toBeCloseTo(0.002);
    await session.close();
    expect(session.alive).toBe(false);
  });

  it("p13-runtime-accounts: local-login with an account dir (or the worker's own CLAUDE_CONFIG_DIR)", async () => {
    const sdk = fakeSdk(() => [{ kind: 'answer', text: 'ok' }]);
    const engine = new ClaudeAssistantEngine({
      binary: () => '/opt/claude',
      sdk,
      sourceEnv: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: '/srv/worker/.claude-own' },
    });
    const s1 = await engine.start(
      sessionOptions({ authMode: 'local-login', loginDir: '/data/acc/a1/.claude' }),
    );
    expect(sdk.queries[0]?.options.env?.CLAUDE_CONFIG_DIR).toBe('/data/acc/a1/.claude');
    await s1.close();
    const s2 = await engine.start(sessionOptions({ authMode: 'local-login' }));
    expect(sdk.queries[1]?.options.env?.CLAUDE_CONFIG_DIR).toBe('/srv/worker/.claude-own');
    await s2.close();
  });

  it('reports subscription runs without a dollar cost (ADR-0014 rule 5)', async () => {
    const sdk = fakeSdk(() => [{ kind: 'answer', text: 'ok' }]);
    const { CLAUDE_CONFIG_DIR: _ambient, ...sourceEnv } = process.env;
    const engine = new ClaudeAssistantEngine({ binary: () => '/opt/claude', sdk, sourceEnv });
    const session = await engine.start(sessionOptions({ authMode: 'local-login' }));
    expect(sdk.queries[0]?.options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    const r = await session.turn(
      { message: 'hi', history: null },
      { delta: () => undefined },
      new AbortController().signal,
    );
    expect(r.usage.costUsd).toBeUndefined();
    expect(r.usage.provenance).toBe('estimated-from-tokens');
    await session.close();
    await expect(
      engine.start(
        sessionOptions({
          authMode: 'local-login',
          secretEnv: { ANTHROPIC_API_KEY: new SecretValue('sk-ant-api03-' + 'z'.repeat(40)) },
        }),
      ),
    ).rejects.toThrow(/local-login/);
  });

  it('cancels a running turn natively', async () => {
    const sdk = fakeSdk(() => [
      { kind: 'delta', text: 'thinking' },
      { kind: 'block', ms: 30_000 },
    ]);
    const engine = new ClaudeAssistantEngine({ binary: () => '/opt/claude', sdk });
    const session = await engine.start(sessionOptions());
    const abort = new AbortController();
    const pending = session.turn(
      { message: 'long', history: null },
      { delta: () => undefined },
      abort.signal,
    );
    await new Promise((r) => setTimeout(r, 30));
    abort.abort();
    const r = await pending;
    expect(r.outcome).toBe('cancelled');
    expect(session.alive).toBe(true);
    await session.close();
  });

  it('times a turn out', async () => {
    const sdk = fakeSdk(() => [{ kind: 'block', ms: 30_000 }]);
    const engine = new ClaudeAssistantEngine({ binary: () => '/opt/claude', sdk });
    const session = await engine.start(
      sessionOptions({ timeouts: { startupMs: 1_000, turnMs: 50, cancelGraceMs: 100 } }),
    );
    const r = await session.turn(
      { message: 'x', history: null },
      { delta: () => undefined },
      new AbortController().signal,
    );
    expect(r).toMatchObject({ outcome: 'failed', errorCode: 'turn_timeout' });
    await session.close();
  });

  it('fails closed when the CLI reports tools other than the platform tools', async () => {
    const sdk = fakeSdk(() => [{ kind: 'block', ms: 30_000 }], ['Bash', 'mcp__remyral__list_jobs']);
    const engine = new ClaudeAssistantEngine({ binary: () => '/opt/claude', sdk });
    const session = await engine.start(sessionOptions());
    const r = await session.turn(
      { message: 'x', history: null },
      { delta: () => undefined },
      new AbortController().signal,
    );
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('runtime_crashed');
    expect(r.detail).toContain('assistant session refused');
    expect(session.alive).toBe(false);
  });

  it('never streams a secret, even split across two deltas', async () => {
    const secret = 'sk-ant-api03-' + 'S'.repeat(40);
    const sdk = fakeSdk(() => [
      { kind: 'delta', text: `The key is ${secret.slice(0, 20)}` },
      { kind: 'delta', text: `${secret.slice(20)} — done` },
      { kind: 'answer', text: `The key is ${secret} — done` },
    ]);
    const engine = new ClaudeAssistantEngine({ binary: () => '/opt/claude', sdk, stateDir: root });
    const session = await engine.start(
      sessionOptions({ secretEnv: { ANTHROPIC_API_KEY: new SecretValue(secret) } }),
    );
    const deltas: string[] = [];
    const r = await session.turn(
      { message: 'x', history: null },
      { delta: (t) => deltas.push(t) },
      new AbortController().signal,
    );
    expect(deltas.join('')).not.toContain(secret.slice(0, 20));
    expect(deltas.join('')).toContain('[REDACTED]');
    expect(r.text).not.toContain(secret);
    await session.close();
  });

  it('reports readiness without starting a model', async () => {
    const missing = new ClaudeAssistantEngine({ binary: () => null });
    expect(await missing.ready()).toMatchObject({ ready: false });
    const fake = new FakeAssistantEngine();
    expect(await fake.ready()).toEqual({ ready: true });
  });

  it('sends images and PDFs as content blocks after the text (p8-chat-attachments-mentions)', async () => {
    const sdk = fakeSdk(() => [{ kind: 'answer', text: 'A cat.' }]);
    const engine = new ClaudeAssistantEngine({ binary: () => '/opt/claude', sdk, stateDir: root });
    expect(engine.input).toEqual({ images: 'supported', pdf: true });
    const session = await engine.start(sessionOptions());
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const pdf = Buffer.from('%PDF-1.7 x');
    const r = await session.turn(
      {
        message: 'What is this?',
        history: null,
        context: '<<<REMYRAL-DATA mention>>>',
        attachments: [
          { kind: 'image', mediaType: 'image/png', name: 'cat.png', data: png },
          { kind: 'pdf', mediaType: 'application/pdf', name: 'spec.pdf', data: pdf },
        ],
      },
      { delta: () => undefined },
      new AbortController().signal,
    );
    expect(r.outcome).toBe('done');
    const content = sdk.queries[0]?.raw[0]?.message.content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as unknown as Record<string, unknown>[];
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect(String(blocks[0]?.text)).toMatch(/REMYRAL-DATA mention[\s\S]*What is this\?/);
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
    });
    expect(blocks[2]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
      title: 'spec.pdf',
    });
    // Without attachments the content stays a plain string.
    await session.turn(
      { message: 'Thanks', history: null },
      { delta: () => undefined },
      new AbortController().signal,
    );
    expect(sdk.queries[0]?.raw[1]?.message.content).toBe('Thanks');
    await session.close();
  });
});

describe('p22-assistant-tools: a session without its platform tools never answers', () => {
  const sink = { delta: () => undefined };

  it('fails the turn as a machine failure when the model gets "No such tool available" for a platform tool', async () => {
    const sdk = fakeSdk(() => [
      { kind: 'missing', name: 'mcp__remyral__find_jobs' },
      { kind: 'answer', text: 'Bu turda Remyral araçlarına erişemiyorum.' },
    ]);
    const engine = new ClaudeAssistantEngine({ binary: () => '/opt/claude', sdk, stateDir: root });
    const session = await engine.start(sessionOptions());
    const r = await session.turn(
      { message: 'gerekli işlemleri yap.', history: '' },
      sink,
      new AbortController().signal,
    );
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('runtime_crashed');
    expect(r.text).toBe('');
    expect(session.alive).toBe(false);
  });

  it("a made-up tool name is the model's mistake, not a missing toolset", async () => {
    const sdk = fakeSdk(() => [
      { kind: 'missing', name: 'mcp__remyral__no_such_thing' },
      { kind: 'answer', text: 'ok' },
    ]);
    const engine = new ClaudeAssistantEngine({ binary: () => '/opt/claude', sdk, stateDir: root });
    const session = await engine.start(sessionOptions());
    const r = await session.turn({ message: 'x', history: '' }, sink, new AbortController().signal);
    expect(r.outcome).toBe('done');
    await session.close();
  });

  it('waits while the tools server is pending, then runs the turn', async () => {
    const sdk = fakeSdk(() => [{ kind: 'answer', text: 'hazır' }]);
    const engine = new ClaudeAssistantEngine({ binary: () => '/opt/claude', sdk, stateDir: root });
    const session = await engine.start(sessionOptions());
    const q = sdk.queries[0];
    let n = 0;
    if (q !== undefined)
      q.mcpServerStatus = () =>
        Promise.resolve([{ name: 'remyral', status: (n += 1) < 3 ? 'pending' : 'connected' }]);
    const r = await session.turn({ message: 'x', history: '' }, sink, new AbortController().signal);
    expect(r.outcome).toBe('done');
    expect(n).toBe(3);
    // Checked once per session.
    await session.turn({ message: 'y', history: '' }, sink, new AbortController().signal);
    expect(n).toBe(3);
    await session.close();
  });

  it('a failed tools server fails the turn before the model sees it', async () => {
    const sdk = fakeSdk(() => [{ kind: 'answer', text: 'should not run' }]);
    const engine = new ClaudeAssistantEngine({ binary: () => '/opt/claude', sdk, stateDir: root });
    const session = await engine.start(sessionOptions());
    const q = sdk.queries[0];
    if (q !== undefined) q.mcpServerStatus = () => Promise.resolve([{ name: 'remyral', status: 'failed' }]);
    const r = await session.turn({ message: 'x', history: '' }, sink, new AbortController().signal);
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('runtime_crashed');
    expect(r.detail).toContain('failed');
    expect(q?.prompts).toEqual([]);
  });
});
