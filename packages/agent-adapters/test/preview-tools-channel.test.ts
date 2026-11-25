import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createOpenCodeAdapter,
  hasJobChannelTools,
  isJobChannelTool,
  jobChannelToolNames,
  jobChannelToolSpecs,
  opencodeSubtaskServerSource,
  PREVIEW_TOOL_NAMES,
  previewToolSpecs,
  type PreviewToolHost,
  runJobChannelTool,
  SubtaskFileRelay,
} from '../src/index.js';
import { codexSubtaskDynamicTools } from '../src/runtimes/codex/config.js';
import { piSubtaskExtensionSource } from '../src/runtimes/pi/subtask-extension.js';
import { spawnContext } from './helpers/runtime.js';

/**
 * p22-previews-inputs: the preview tools on the job-tool channel of Codex (dynamic tools), Pi (extension relay) and
 * OpenCode (local MCP server + file relay) — the same zod inputs and dispatch as Claude Code's in-process server.
 */

const root = mkdtempSync(join(tmpdir(), 'remyral-preview-channel-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const PREVIEWS = ['open_preview', 'close_preview', 'list_previews'];

function host(log: unknown[], publish = false): PreviewToolHost {
  return {
    ...(publish ? { tools: [...PREVIEW_TOOL_NAMES] } : {}),
    open: (a) => {
      log.push(['open', a]);
      return Promise.resolve({ ok: true, text: 'https://web-x.example.com' });
    },
    close: (a) => {
      log.push(['close', a]);
      return Promise.resolve({ ok: true, text: 'closed' });
    },
    list: () => {
      log.push(['list']);
      return Promise.resolve({ ok: true, text: 'no previews' });
    },
    ...(publish
      ? {
          publish: (a: unknown) => {
            log.push(['publish', a]);
            return Promise.resolve({ ok: true, text: 'recorded' });
          },
        }
      : {}),
  };
}

describe('preview tools on the job-tool channel', () => {
  it('carries exactly the tools the host offers (publish_site only with the host offering it)', async () => {
    const log: unknown[] = [];
    const h = host(log);
    expect(hasJobChannelTools({ previewTools: h })).toBe(true);
    expect(jobChannelToolNames({ previewTools: h })).toEqual(PREVIEWS);
    expect(jobChannelToolNames({ previewTools: host([], true) })).toEqual([...PREVIEWS, 'publish_site']);
    expect(jobChannelToolNames({ previewTools: { ...h, tools: ['publish_site'] } })).toEqual([]);
    expect(hasJobChannelTools({ previewTools: { ...h, tools: [] } })).toBe(false);
    expect(isJobChannelTool({ previewTools: h }, 'open_preview')).toBe(true);
    expect(isJobChannelTool({ previewTools: h }, 'publish_site')).toBe(false);
    expect(isJobChannelTool({}, 'open_preview')).toBe(false);
    expect(await runJobChannelTool({ previewTools: h }, 'publish_site', {})).toMatchObject({ ok: false });
    expect(await runJobChannelTool({}, 'open_preview', { port: 5173 })).toMatchObject({ ok: false });
    expect(await runJobChannelTool({ previewTools: h }, 'open_preview', { port: 5173, ttl: 30 })).toEqual({
      ok: true,
      text: 'https://web-x.example.com',
    });
    expect((await runJobChannelTool({ previewTools: h }, 'open_preview', { port: 3306 })).ok).toBe(false);
    expect((await runJobChannelTool({ previewTools: h }, 'close_preview', {})).ok).toBe(false);
    expect(log).toEqual([
      ['open', { port: 5173, name: undefined, ttl: 30, protect: undefined, stable: undefined }],
    ]);
    const boom: PreviewToolHost = { ...h, list: () => Promise.reject(new Error('down')) };
    expect(await runJobChannelTool({ previewTools: boom }, 'list_previews', {})).toEqual({
      ok: false,
      text: 'the preview tool failed: down',
    });
    for (const s of previewToolSpecs(host([], true))) {
      expect(s.inputSchema.type).toBe('object');
      expect(s.inputSchema.additionalProperties).toBe(false);
      expect(s.inputSchema).not.toHaveProperty('$schema');
    }
  });

  it('Codex dynamic tools, the Pi extension and the OpenCode server list them', () => {
    const h = host([]);
    expect(codexSubtaskDynamicTools({ previewTools: h }).map((t) => t.name)).toEqual(PREVIEWS);
    const pi = piSubtaskExtensionSource(jobChannelToolSpecs({ previewTools: h }));
    for (const n of PREVIEWS) expect(pi).toContain(`"name":"${n}"`);
    const oc = opencodeSubtaskServerSource(jobChannelToolSpecs({ previewTools: h }), '/x', 0);
    for (const n of PREVIEWS) expect(oc).toContain(`"name":"${n}"`);
  });

  it('OpenCode: the file relay answers preview tool calls (no sub-job tools needed)', async () => {
    const dir = join(root, randomUUID());
    await SubtaskFileRelay.prepare(dir);
    const log: unknown[] = [];
    const abort = new AbortController();
    const relay = new SubtaskFileRelay({ dir, channel: { previewTools: host(log) }, signal: abort.signal });
    const id = randomUUID();
    writeFileSync(
      join(dir, `${id}.req.json`),
      JSON.stringify({ id, tool: 'open_preview', args: { port: 8080 } }),
    );
    await relay.scan();
    for (let i = 0; i < 50 && !existsSync(join(dir, `${id}.res.json`)); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(JSON.parse(readFileSync(join(dir, `${id}.res.json`), 'utf8'))).toEqual({
      ok: true,
      text: 'https://web-x.example.com',
    });
    expect(log).toHaveLength(1);
    abort.abort();
  });

  it.skipIf(process.platform === 'win32')(
    'OpenCode adapter: a job with preview tools starts the local job-tool server with them',
    async () => {
      const fake = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode', 'fake-opencode.mjs');
      const launchLog = join(root, `launch-${randomUUID()}.jsonl`);
      // The job-tool server needs the OpenCode binary itself (no `commandArgs` wrapper): a one-line executable.
      const bin = join(root, `opencode-${randomUUID()}`);
      writeFileSync(
        bin,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`,
        {
          mode: 0o755,
        },
      );
      const a = createOpenCodeAdapter({
        command: bin,
        stateDir: join(root, 'state', randomUUID()),
        authMode: 'secret-ref',
        model: 'fake/scripted',
        platform: { os: 'darwin', arch: 'arm64' },
        env: { FAKE_OC_LAUNCH_LOG: launchLog },
      });
      const ws = join(root, 'ws', randomUUID());
      mkdirSync(ws, { recursive: true });
      const ref = await a.spawn(spawnContext('opencode', ws, { previewTools: host([]) }));
      const first =
        readFileSync(launchLog, 'utf8')
          .split('\n')
          .find((l) => l.trim() !== '') ?? '{}';
      const config = (JSON.parse(first) as { configContent: { mcp?: Record<string, { command: string[] }> } })
        .configContent;
      const server = config.mcp?.['remyral-subtasks'];
      expect(server).toBeDefined();
      const script = server?.command.at(-1) ?? '';
      const src = readFileSync(script, 'utf8');
      for (const n of PREVIEWS) expect(src).toContain(`"name":"${n}"`);
      expect(src).not.toContain('"name":"request_subtask"');
      await a.cleanup(ref);
    },
  );
});
