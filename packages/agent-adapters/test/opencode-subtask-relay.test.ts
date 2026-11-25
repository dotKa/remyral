import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, describe, expect, it } from 'vitest';
import {
  opencodeSubtaskServerSource,
  SubtaskFileRelay,
  subtaskToolSpecs,
  type SubtaskToolHost,
} from '../src/index.js';

/** p11-fixes-a: the OpenCode sub-job relay (file channel) and its generated stdio MCP server, without OpenCode. */

const root = mkdtempSync(join(tmpdir(), 'remyral-oc-relay-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function host(log: unknown[]): SubtaskToolHost {
  return {
    request: (args) => {
      log.push(['request', args]);
      return Promise.resolve({ ok: true, text: `created ${args.title}` });
    },
    wait: (id, waitSec) => {
      log.push(['wait', id, waitSec]);
      return Promise.resolve({ ok: true, text: 'still running' });
    },
    cancel: (id) => {
      log.push(['cancel', id]);
      return Promise.resolve({ ok: false, text: 'not yours' });
    },
  };
}

async function relayDir(): Promise<string> {
  const dir = join(root, randomUUID());
  await SubtaskFileRelay.prepare(dir);
  return dir;
}

describe('SubtaskFileRelay', () => {
  it('answers a request file from the host; bad ids, bad tools and bad arguments get no host call', async () => {
    const dir = await relayDir();
    const log: unknown[] = [];
    const abort = new AbortController();
    const relay = new SubtaskFileRelay({ dir, host: host(log), signal: abort.signal });
    const ok = randomUUID();
    writeFileSync(
      join(dir, `${ok}.req.json`),
      JSON.stringify({ id: ok, tool: 'request_subtask', args: { title: 'T', prompt: 'P' } }),
    );
    const badTool = randomUUID();
    writeFileSync(join(dir, `${badTool}.req.json`), JSON.stringify({ tool: 'rm_rf', args: {} }));
    const badArgs = randomUUID();
    writeFileSync(join(dir, `${badArgs}.req.json`), JSON.stringify({ tool: 'wait_subtask', args: { x: 1 } }));
    writeFileSync(join(dir, '../escape.req.json'.replace('../', 'not-an-id.')), '{}');
    await relay.scan();
    await expect.poll(() => existsSync(join(dir, `${ok}.res.json`))).toBe(true);
    await expect.poll(() => existsSync(join(dir, `${badArgs}.res.json`))).toBe(true);
    // The answers are written concurrently: wait for each one (this used to race on a loaded machine).
    await expect.poll(() => existsSync(join(dir, `${badTool}.res.json`))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, `${ok}.res.json`), 'utf8'))).toEqual({
      ok: true,
      text: 'created T',
    });
    expect(JSON.parse(readFileSync(join(dir, `${badTool}.res.json`), 'utf8'))).toEqual({
      ok: false,
      text: 'invalid sub-job tool request',
    });
    expect(
      (JSON.parse(readFileSync(join(dir, `${badArgs}.res.json`), 'utf8')) as { text: string }).text,
    ).toMatch(/^invalid arguments/);
    expect(existsSync(join(dir, 'not-an-id.escape.req.json'))).toBe(false); // removed, never answered
    expect(log).toEqual([['request', { title: 'T', prompt: 'P', wait: true }]]);
    abort.abort();
  });

  it('a request file above the size cap is refused', async () => {
    const dir = await relayDir();
    const log: unknown[] = [];
    const relay = new SubtaskFileRelay({ dir, host: host(log), signal: new AbortController().signal });
    const id = randomUUID();
    writeFileSync(join(dir, `${id}.req.json`), 'x'.repeat(300 * 1024));
    await relay.scan();
    await expect.poll(() => existsSync(join(dir, `${id}.res.json`))).toBe(true);
    expect(log).toEqual([]);
  });
});

describe('generated MCP server (stdio) + relay, under Node', () => {
  it('initialize, tools/list, tools/call through the relay; wait cap applies', async () => {
    const dir = await relayDir();
    const script = join(root, `${randomUUID()}.mjs`);
    writeFileSync(script, opencodeSubtaskServerSource(subtaskToolSpecs(), dir, 45));
    const log: unknown[] = [];
    const abort = new AbortController();
    new SubtaskFileRelay({ dir, host: host(log), signal: abort.signal, pollMs: 20 }).start();
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = createInterface({ input: child.stdout });
    const answers = new Map<number, unknown>();
    lines.on('line', (l) => {
      const m = JSON.parse(l) as { id: number };
      answers.set(m.id, m);
    });
    const rpc = async (id: number, method: string, params: unknown): Promise<Record<string, unknown>> => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      await expect.poll(() => answers.has(id), { timeout: 10_000 }).toBe(true);
      return answers.get(id) as Record<string, unknown>;
    };
    try {
      const init = await rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} });
      expect(init.result).toMatchObject({
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'remyral-subtasks' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const list = await rpc(2, 'tools/list', {});
      const tools = (list.result as { tools: { name: string; inputSchema: { type: string } }[] }).tools;
      expect(tools.map((t) => t.name)).toEqual(['request_subtask', 'wait_subtask', 'cancel_subtask']);
      expect(tools[0]?.inputSchema.type).toBe('object');
      const sub = randomUUID();
      const waited = await rpc(3, 'tools/call', {
        name: 'wait_subtask',
        arguments: { subtaskId: sub, waitSec: 600 },
      });
      expect(waited.result).toEqual({ content: [{ type: 'text', text: 'still running' }], isError: false });
      const cancelled = await rpc(4, 'tools/call', { name: 'cancel_subtask', arguments: { subtaskId: sub } });
      expect(cancelled.result).toEqual({ content: [{ type: 'text', text: 'not yours' }], isError: true });
      const unknown = await rpc(5, 'tools/call', { name: 'bash', arguments: {} });
      expect((unknown.result as { isError: boolean }).isError).toBe(true);
      const missing = await rpc(6, 'resources/list', {});
      expect(missing.error).toMatchObject({ code: -32601 });
      expect(log).toEqual([
        ['wait', sub, 45],
        ['cancel', sub],
      ]);
    } finally {
      child.kill('SIGKILL');
      abort.abort();
    }
  });
});
