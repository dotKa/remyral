#!/usr/bin/env node
/**
 * Stand-in for `codex app-server --listen stdio://` (codex-cli 0.162.1) in
 * adapter tests — never talks to a model. Handshake/thread responses replay
 * the shapes captured from the pinned binary (handshake-0.162.1.json); turn
 * notifications and server requests are typed against the protocol types
 * generated from that binary (`satisfies`), so the compiler rejects shapes
 * the real app-server would not send. Runs as a real child process (Node
 * type stripping), so process ownership, cancel and reaping are real.
 *
 * Scenario by prompt text: contains "long" → runs until turn/interrupt; "mcp-start" → an MCP server reports
 * starting mid-turn, then runs until turn/interrupt;
 * "approval" → one command approval request; "crash" → exits mid-turn;
 * "subtask:<tool>:<json args>" (p8-subtasks-codex) → one `item/tool/call` of that dynamic tool, its answer
 * recorded in `.fake-codex-tool.json` (runs until turn/interrupt if the answer does not come);
 * anything else → a short successful turn. `initialize` capabilities and `thread/start` dynamic tools and
 * config are recorded in `.fake-codex-start.json`. `config/read` reports the `[mcp_servers.*]` tables of
 * `$CODEX_HOME/config.toml`; each one not disabled in the thread config sends `mcpServer/startupStatus/updated`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setInterval, setTimeout } from 'node:timers';
import type { DynamicToolCallParams } from '../../../src/runtimes/codex/protocol/generated/v2/DynamicToolCallParams.js';
import type { CommandExecutionRequestApprovalParams } from '../../../src/runtimes/codex/protocol/generated/v2/CommandExecutionRequestApprovalParams.js';
import type { ItemCompletedNotification } from '../../../src/runtimes/codex/protocol/generated/v2/ItemCompletedNotification.js';
import type { ItemStartedNotification } from '../../../src/runtimes/codex/protocol/generated/v2/ItemStartedNotification.js';
import type { ThreadTokenUsageUpdatedNotification } from '../../../src/runtimes/codex/protocol/generated/v2/ThreadTokenUsageUpdatedNotification.js';
import type { Turn } from '../../../src/runtimes/codex/protocol/generated/v2/Turn.js';
import type { TurnCompletedNotification } from '../../../src/runtimes/codex/protocol/generated/v2/TurnCompletedNotification.js';
import type { TurnDiffUpdatedNotification } from '../../../src/runtimes/codex/protocol/generated/v2/TurnDiffUpdatedNotification.js';
import type { TurnStartedNotification } from '../../../src/runtimes/codex/protocol/generated/v2/TurnStartedNotification.js';
import type { GetAccountRateLimitsResponse } from '../../../src/runtimes/codex/protocol/generated/v2/GetAccountRateLimitsResponse.js';
import type { AccountRateLimitsUpdatedNotification } from '../../../src/runtimes/codex/protocol/generated/v2/AccountRateLimitsUpdatedNotification.js';

type Json = Record<string, unknown>;

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? '0.164.0'}\n`);
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  process.stderr.write('Not logged in\n');
  process.exit(1);
}

const capture = JSON.parse(readFileSync(new URL('./handshake-0.162.1.json', import.meta.url), 'utf8')) as {
  lines: { dir: string; msg: Json }[];
};
const captured = (id: number): Json => {
  const line = capture.lines.find((l) => l.dir === 'in' && l.msg.id === id);
  if (!line) throw new Error(`capture has no response ${String(id)}`);
  return line.msg.result as Json;
};

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
grandchild.on('spawn', () => {
  try {
    writeFileSync(
      join(process.cwd(), '.fake-codex.json'),
      JSON.stringify({
        pid: process.pid,
        grandchild: grandchild.pid,
        argv: args,
        envNames: Object.keys(process.env),
        codexHome: process.env.CODEX_HOME ?? null,
      }),
    );
  } catch {
    // ignore
  }
});

const send = (msg: Json): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};
const notify = (method: string, params: unknown): void => {
  send({ method, params, emittedAtMs: Date.now() });
};

let threadId = '01a13336-2f88-7013-aa1f-c2a92bff8ce3';
let cwd = process.cwd();
let turnSeq = 0;
let activeTurn: string | undefined;
let interrupt: (() => void) | undefined;
let nextServerRequest = 1000;
const pendingServer = new Map<number, (result: Json) => void>();
let usageTotal = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 };

function turn(id: string, status: Turn['status'], durationMs: number | null = null): Turn {
  return {
    id,
    rootTurnId: id,
    items: [],
    itemsView: 'notLoaded',
    status,
    error:
      status === 'failed'
        ? { message: 'boom', codexErrorInfo: 'other', additionalDetails: null, misalignment: null }
        : null,
    startedAt: Math.floor(Date.now() / 1000),
    completedAt: status === 'inProgress' ? null : Math.floor(Date.now() / 1000),
    durationMs,
  };
}

function itemStarted(item: ItemStartedNotification['item'], turnId: string): void {
  notify('item/started', {
    item,
    threadId,
    turnId,
    startedAtMs: Date.now(),
  } satisfies ItemStartedNotification);
}
function itemCompleted(item: ItemCompletedNotification['item'], turnId: string): void {
  notify('item/completed', {
    item,
    threadId,
    turnId,
    completedAtMs: Date.now(),
  } satisfies ItemCompletedNotification);
}
function agentMessage(id: string, text: string, turnId: string): void {
  itemCompleted(
    { type: 'agentMessage', id, text, phase: null, memoryCitation: null, delivery: null, questions: null },
    turnId,
  );
}
function command(
  id: string,
  cmd: string,
  status: 'inProgress' | 'completed' | 'declined' | 'failed',
  exitCode: number | null,
) {
  return {
    type: 'commandExecution' as const,
    id,
    pluginId: null,
    scriptPath: null,
    command: cmd,
    cwd,
    processId: null,
    source: 'agent' as const,
    status,
    commandActions: [],
    aggregatedOutput: status === 'completed' ? 'ok\n' : null,
    exitCode,
    durationMs: status === 'inProgress' ? null : 5,
  };
}
function usage(turnId: string, input: number, cached: number, output: number): void {
  usageTotal = {
    inputTokens: usageTotal.inputTokens + input,
    cachedInputTokens: usageTotal.cachedInputTokens + cached,
    cacheWriteInputTokens: 0,
    outputTokens: usageTotal.outputTokens + output,
  };
  const b = {
    ...usageTotal,
    reasoningOutputTokens: 0,
    totalTokens: usageTotal.inputTokens + usageTotal.outputTokens,
  };
  notify('thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: { total: b, last: b, modelContextWindow: 272_000 },
  } satisfies ThreadTokenUsageUpdatedNotification);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** p11-limit-visibility: the plan's usage windows (shape of codex-cli 0.162.1 `RateLimitSnapshot`). */
const nowSec = (): number => Math.floor(Date.now() / 1000);
function rateLimitSnapshot(primaryUsed: number): GetAccountRateLimitsResponse['rateLimits'] {
  return {
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: primaryUsed, windowDurationMins: 300, resetsAt: nowSec() + 3600 },
    secondary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: nowSec() + 4 * 86400 },
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: 'plus',
    rateLimitReachedType: null,
  };
}
function complete(turnId: string, status: Turn['status']): void {
  activeTurn = undefined;
  notify('account/rateLimits/updated', {
    rateLimits: rateLimitSnapshot(47),
  } satisfies AccountRateLimitsUpdatedNotification);
  notify('turn/completed', { threadId, turn: turn(turnId, status, 42) } satisfies TurnCompletedNotification);
}
let lastAsk: Promise<Json> | undefined;
function askServer(method: string, params: unknown): Promise<Json> {
  const id = nextServerRequest++;
  lastAsk = new Promise((resolve) => {
    pendingServer.set(id, resolve);
    send({ id, method, params });
  });
  return lastAsk;
}
/** The answer to the most recent server request (also after an interrupt raced it). */
function pendingAnswer(): Promise<Json | null> {
  return lastAsk ?? Promise.resolve(null);
}

async function runTurn(turnId: string, prompt: string): Promise<void> {
  notify('turn/started', { threadId, turn: turn(turnId, 'inProgress') } satisfies TurnStartedNotification);
  // p14-mcp-core: "mcp:<server>/<tool>[,…]" → per call an mcpToolCall item, then the MCP tool-call approval request
  // (`_meta.codex_approval_kind = "mcp_tool_call"`, as in core/src/mcp_tool_call.rs of 0.162.1); accepted → completed.
  // "mcp-bypass:<server>/<tool>" → a call that completes without asking (a runtime ignoring the approval mode).
  const mcp = /mcp(-bypass)?:([A-Za-z0-9_,/-]+)/.exec(prompt);
  if (mcp !== null) {
    const answers: string[] = [];
    let n = 0;
    for (const call of (mcp[2] ?? '').split(',')) {
      const [server = '', tool = ''] = call.split('/');
      n += 1;
      const item = {
        type: 'mcpToolCall' as const,
        id: `mcp-${turnId}-${String(n)}`,
        server,
        tool,
        status: 'inProgress' as const,
        arguments: { q: `hello ${String(n)}` },
        appContext: null,
        mcpAppUi: null,
        pluginId: null,
        readOnlyHint: null,
        result: null,
        error: null,
        durationMs: null,
      };
      itemStarted(item, turnId);
      let accepted = true;
      if (mcp[1] === undefined) {
        const res = await askServer('mcpServer/elicitation/request', {
          threadId,
          turnId,
          serverName: server,
          mode: 'form',
          _meta: { codex_approval_kind: 'mcp_tool_call', tool_title: tool },
          message: `Allow ${server} to run ${tool}?`,
          requestedSchema: { type: 'object', properties: {}, required: [] },
        });
        accepted = res.action === 'accept';
        answers.push(String(res.action));
      }
      itemCompleted(
        accepted
          ? {
              ...item,
              status: 'completed',
              result: {
                content: [{ type: 'text', text: 'ok-result' }],
                structuredContent: null,
                _meta: null,
              },
              durationMs: 7,
            }
          : { ...item, status: 'failed', error: { message: 'user rejected MCP tool call' }, durationMs: 0 },
        turnId,
      );
    }
    writeFileSync(join(cwd, '.fake-codex-mcp.json'), JSON.stringify({ answers }));
    agentMessage(`msg-${turnId}-2`, 'mcp done', turnId);
    complete(turnId, 'completed');
    return;
  }
  const sub = /subtask:([a-z_]+):(\{.*\})/s.exec(prompt);
  if (sub !== null) {
    const tool = sub[1] ?? '';
    const args = JSON.parse(sub[2] ?? '{}') as Json;
    const callId = `call-${turnId}`;
    const started = {
      type: 'dynamicToolCall' as const,
      id: callId,
      namespace: null,
      tool,
      arguments: args as never,
      status: 'inProgress' as const,
      contentItems: null,
      success: null,
      durationMs: null,
    };
    itemStarted(started, turnId);
    const params: DynamicToolCallParams = {
      threadId,
      turnId,
      callId,
      namespace: null,
      tool,
      arguments: args as never,
    };
    const state = { interrupted: false };
    const answer = await Promise.race([
      askServer('item/tool/call', params),
      new Promise<null>((resolve) => {
        interrupt = () => {
          state.interrupted = true;
          resolve(null);
        };
      }),
    ]);
    interrupt = undefined;
    // An interrupt does not cancel the client's pending answer: wait briefly for it (the adapter answers aborted calls).
    const late = answer ?? (await Promise.race([pendingAnswer(), sleep(2_000).then(() => null)]));
    writeFileSync(
      join(cwd, '.fake-codex-tool.json'),
      JSON.stringify({ answer: late, interrupted: state.interrupted }),
    );
    const items = (late?.contentItems ?? []) as { type: 'inputText'; text: string }[];
    itemCompleted(
      {
        ...started,
        status: late?.success === true ? 'completed' : 'failed',
        contentItems: items,
        success: late?.success === true,
        durationMs: 3,
      },
      turnId,
    );
    if (state.interrupted) {
      complete(turnId, 'interrupted');
      return;
    }
    agentMessage(`msg-${turnId}-2`, 'tool done', turnId);
    usage(turnId, 10, 0, 5);
    complete(turnId, 'completed');
    return;
  }
  if (prompt.includes('crash')) {
    await sleep(20);
    process.exit(3);
  }
  agentMessage(`msg-${turnId}-1`, `ack: ${prompt.slice(0, 40)}`, turnId);
  if (prompt.includes('mcp-start')) {
    // p14-codex-mcp-isolation: an MCP server starts although the adapter disabled every configured one.
    notify('mcpServer/startupStatus/updated', {
      threadId,
      name: 'sneaky',
      status: 'starting',
      error: null,
      failureReason: null,
    });
    await new Promise<void>((resolve) => {
      interrupt = resolve;
    });
    complete(turnId, 'interrupted');
    return;
  }
  if (prompt.includes('long')) {
    itemStarted(command(`cmd-${turnId}`, 'sleep 600', 'inProgress', null), turnId);
    await new Promise<void>((resolve) => {
      interrupt = resolve;
    });
    itemCompleted(command(`cmd-${turnId}`, 'sleep 600', 'failed', null), turnId);
    usage(turnId, 50, 0, 5);
    complete(turnId, 'interrupted');
    return;
  }
  if (prompt.includes('image')) {
    // p8-codex-images: like 0.162.1 — the CLI saves the image under $CODEX_HOME/generated_images/<thread>/.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fake-png-body'),
    ]);
    const home = process.env.CODEX_HOME ?? cwd;
    const dir = join(home, 'generated_images', threadId);
    mkdirSync(dir, { recursive: true });
    const saved = join(dir, 'ig_one.png');
    writeFileSync(saved, png);
    const outside = join(cwd, 'outside.png');
    writeFileSync(outside, Buffer.from('not the image'));
    const items: ItemCompletedNotification['item'][] = [
      {
        type: 'imageGeneration',
        id: 'ig_one',
        status: 'completed',
        revisedPrompt: null,
        // codex-cli 0.164.0: an image uploaded to Codex's attachment store carries `fileId`, no inline `result`.
        fileId: 'file_ig_one',
        failure: null,
        savedPath: saved,
      },
      // savedPath outside CODEX_HOME: only the base64 result is used.
      {
        type: 'imageGeneration',
        id: 'ig_two',
        status: 'completed',
        revisedPrompt: null,
        result: png.toString('base64'),
        failure: null,
        savedPath: outside,
      },
      {
        type: 'imageGeneration',
        id: 'ig_bad',
        status: 'completed',
        revisedPrompt: null,
        result: Buffer.from('plain text').toString('base64'),
        failure: null,
      },
    ];
    for (const item of items) itemCompleted(item, turnId);
    agentMessage(`msg-${turnId}-2`, 'images done', turnId);
    usage(turnId, 10, 0, 5);
    complete(turnId, 'completed');
    return;
  }
  if (prompt.includes('approval')) {
    const item = command(`cmd-${turnId}`, 'git push origin work', 'inProgress', null);
    itemStarted(item, turnId);
    const params: CommandExecutionRequestApprovalParams = {
      kind: 'command',
      threadId,
      turnId,
      itemId: item.id,
      startedAtMs: Date.now(),
      approvalId: null,
      environmentId: null,
      reason: 'needs network',
      command: 'git push origin work',
      cwd,
    };
    const res = await askServer('item/commandExecution/requestApproval', params);
    const accepted = res.decision === 'accept';
    lastDecision = String(res.decision);
    itemCompleted(
      command(item.id, item.command, accepted ? 'completed' : 'declined', accepted ? 0 : null),
      turnId,
    );
    // p17-runtime-verify: an approved command changes the tree, so the turn's aggregated diff names it.
    if (accepted)
      notify('turn/diff/updated', {
        threadId,
        turnId,
        diff: 'diff --git a/approved.txt b/approved.txt\n+approved\n',
      } satisfies TurnDiffUpdatedNotification);
    agentMessage(`msg-${turnId}-2`, 'finished', turnId);
    usage(turnId, 200, 50, 20);
    complete(turnId, 'completed');
    return;
  }
  itemStarted(command(`cmd-${turnId}`, 'cat README.md', 'inProgress', null), turnId);
  itemCompleted(command(`cmd-${turnId}`, 'cat README.md', 'completed', 0), turnId);
  notify('turn/diff/updated', {
    threadId,
    turnId,
    diff: 'diff --git a/x b/x\n+hello\n',
  } satisfies TurnDiffUpdatedNotification);
  usage(turnId, 120, 40, 30);
  agentMessage(`msg-${turnId}-2`, 'done', turnId);
  complete(turnId, 'completed');
}

/**
 * `[mcp_servers.<name>]` / `[mcp_servers."<name>"]` tables of `$CODEX_HOME/config.toml` (headers only — enough for
 * the adapter tests; the real binary parses the whole TOML).
 */
function userMcpServers(): Record<string, Json> {
  const home = process.env.CODEX_HOME;
  if (home === undefined) return {};
  let text: string;
  try {
    text = readFileSync(join(home, 'config.toml'), 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, Json> = {};
  for (const m of text.matchAll(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)) {
    out[m[1] ?? m[2] ?? ''] = { command: 'configured-by-user' };
  }
  return out;
}

/**
 * p14-mcp-core: `-c mcp_servers.<name>={ url = "…", … }` overrides (merged over the user's tables, like Codex).
 * Like the pinned 0.162.1 (verified with `codex -c … mcp list --json`), the key path segment is taken literally: a
 * quoted `mcp_servers."x-docs"` names the server `"x-docs"` with the quotes. p14-mcp-stdio: stdio overrides
 * (`command = "…", args = […], env_vars = […]`) too.
 */
function overrideMcpServers(): Record<string, Json> {
  const out: Record<string, Json> = {};
  const list = (body: string, key: string): string[] | undefined => {
    const m = new RegExp(`(?:^|, )${key} = \\[([^\\]]*)\\]`).exec(body);
    return m === null ? undefined : [...(m[1] ?? '').matchAll(/"([^"]*)"/g)].map((x) => x[1] ?? '');
  };
  for (const a of args) {
    const m = /^mcp_servers\.([^=]+)=\{ (.*) \}$/.exec(a);
    if (m === null) continue;
    const name = m[1] ?? '';
    const body = m[2] ?? '';
    const url = /^url = "([^"]+)"/.exec(body);
    if (url !== null) {
      out[name] = { url: url[1] ?? '' };
      continue;
    }
    const command = /^command = "([^"]+)"/.exec(body);
    if (command !== null) {
      const envVars = list(body, 'env_vars');
      out[name] = {
        command: command[1] ?? '',
        args: list(body, 'args') ?? [],
        ...(envVars === undefined ? {} : { env_vars: envVars }),
      };
    }
  }
  return out;
}

function effectiveMcpServers(): Record<string, Json> {
  const user = userMcpServers();
  const out: Record<string, Json> = { ...user };
  for (const [name, entry] of Object.entries(overrideMcpServers()))
    out[name] = { ...(user[name] ?? {}), ...entry };
  return out;
}

let lastDecision = '';
const startRecord: Json = {};

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line) as Json;
  const id = msg.id as number | string | undefined;
  const method = msg.method as string | undefined;
  if (method === undefined && typeof id === 'number' && pendingServer.has(id)) {
    pendingServer.get(id)?.((msg.result ?? { decision: 'error' }) as Json);
    pendingServer.delete(id);
    return;
  }
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case 'initialize':
      startRecord.capabilities = params.capabilities ?? null;
      send({ id, result: { ...captured(1), codexHome: process.env.CODEX_HOME ?? '' } });
      return;
    case 'initialized':
      return;
    case 'account/read': {
      // p15-usage-refresh: a test can name the login's ChatGPT account (`$CODEX_HOME/fake-account.json`).
      const file =
        process.env.CODEX_HOME === undefined ? null : join(process.env.CODEX_HOME, 'fake-account.json');
      send({
        id,
        result:
          file !== null && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Json) : captured(2),
      });
      return;
    }
    case 'account/rateLimits/read':
      send({
        id,
        result: {
          ordinaryUsageAllowed: true,
          rateLimits: rateLimitSnapshot(62),
          rateLimitsByLimitId: null,
          rateLimitResetCredits: null,
          accountId: null,
          rateLimitUpsell: null,
        } satisfies GetAccountRateLimitsResponse,
      });
      return;
    case 'config/read':
      // p14-codex-mcp-isolation: the MCP servers of `$CODEX_HOME/config.toml`, like the real effective config.
      send({ id, result: { config: { mcp_servers: effectiveMcpServers() }, origins: {}, layers: null } });
      return;
    case 'thread/start':
    case 'thread/resume': {
      cwd = typeof params.cwd === 'string' ? params.cwd : cwd;
      startRecord.config = params.config ?? null;
      if (method === 'thread/resume')
        threadId = typeof params.threadId === 'string' ? params.threadId : threadId;
      startRecord.method = method;
      startRecord.dynamicTools = params.dynamicTools ?? null;
      writeFileSync(join(cwd, '.fake-codex-start.json'), JSON.stringify(startRecord));
      const base = captured(4);
      const thread = { ...(base.thread as Json), id: threadId, cwd };
      // Like the real binary: `-c model_provider="<id>"` selects the provider the thread reports.
      const providerArg = args.find((a) => a.startsWith('model_provider='));
      const modelProvider: unknown =
        providerArg === undefined
          ? base.modelProvider
          : (JSON.parse(providerArg.slice('model_provider='.length)) as string);
      send({
        id,
        result: {
          ...base,
          thread,
          cwd,
          approvalPolicy: params.approvalPolicy,
          modelProvider,
          instructionSources: args.includes('project_doc_max_bytes=0') ? [] : [join(cwd, 'AGENTS.md')],
        },
      });
      notify('thread/started', { thread });
      // Like the real binary: every configured MCP server not disabled in the thread config starts.
      const disabled = ((params.config as Json | null | undefined)?.mcp_servers ?? {}) as Record<
        string,
        { enabled?: unknown }
      >;
      for (const name of Object.keys(effectiveMcpServers())) {
        if (disabled[name]?.enabled === false) continue;
        notify('mcpServer/startupStatus/updated', {
          threadId: null,
          name,
          status: 'starting',
          error: null,
          failureReason: null,
        });
      }
      return;
    }
    case 'turn/start': {
      const input = (params.input as { text?: string }[] | undefined)?.[0]?.text ?? '';
      turnSeq += 1;
      const turnId = `turn-${String(turnSeq)}`;
      activeTurn = turnId;
      send({ id, result: { turn: turn(turnId, 'inProgress') } });
      void runTurn(turnId, input);
      return;
    }
    case 'turn/steer':
      if (activeTurn !== undefined && params.expectedTurnId === activeTurn)
        send({ id, result: { turnId: activeTurn } });
      else send({ id, error: { code: -32600, message: 'no active turn to steer' } });
      return;
    case 'turn/interrupt':
      send({ id, result: {} });
      interrupt?.();
      interrupt = undefined;
      return;
    default:
      send({ id, error: { code: -32600, message: `unknown variant \`${String(method)}\`` } });
  }
});
rl.on('close', () => {
  try {
    writeFileSync(join(process.cwd(), '.fake-codex-decision.json'), JSON.stringify({ lastDecision }));
  } catch {
    // ignore
  }
  grandchild.kill('SIGKILL');
  process.exit(0);
});
setInterval(() => {}, 1000);
