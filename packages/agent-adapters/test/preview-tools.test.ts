import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptId, JobId } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREVIEW_TOOL_NAMES,
  PREVIEW_TOOL_NAMES,
  PREVIEW_TOOL_PREFIX,
  previewToolNamesOf,
  type PreviewOpenArgs,
  type PreviewToolHost,
  runPreviewTool,
} from '../src/preview-tools.js';
import { claudeRuntimeSandbox } from '../src/runtimes/claude-code/sandbox.js';
import {
  createClaudeCodeAdapter,
  previewMcpServer,
  type ClaudeSdkPort,
} from '../src/runtimes/claude-code/adapter.js';
import type { SpawnContext } from '../src/contract.js';
import { collectUntilStopped } from '../src/testing/index.js';
import { FAKE_CLI, FakeClaudeSdk, type FakeTurnScript } from './fixtures/claude-code/fake-sdk.js';

function host(log: unknown[]): PreviewToolHost {
  return {
    open: (a: PreviewOpenArgs) => {
      log.push(['open', a]);
      return Promise.resolve({ ok: true, text: 'https://x.example.com' });
    },
    close: (a) => {
      log.push(['close', a]);
      return Promise.resolve({ ok: true, text: 'closed' });
    },
    list: () => {
      log.push(['list']);
      return Promise.resolve({ ok: true, text: 'none' });
    },
  };
}

describe('preview tools (ADR-0032)', () => {
  it('validates arguments strictly and dispatches to the host', async () => {
    const log: unknown[] = [];
    const h = host(log);
    expect(await runPreviewTool(h, 'open_preview', { port: 5173, protect: 'access', ttl: 60 })).toEqual({
      ok: true,
      text: 'https://x.example.com',
    });
    expect(log[0]).toEqual([
      'open',
      { port: 5173, name: undefined, ttl: 60, protect: 'access', stable: undefined },
    ]);
    // known service ports, privileged ports, unknown fields and bad names never reach the host
    for (const bad of [
      { port: 5432 },
      { port: 80 },
      { port: 3000, extra: 1 },
      { port: 3000, name: 'Bad Name' },
    ]) {
      expect((await runPreviewTool(h, 'open_preview', bad)).ok).toBe(false);
    }
    expect((await runPreviewTool(h, 'close_preview', {})).ok).toBe(false);
    await runPreviewTool(h, 'close_preview', { name: 'web' });
    await runPreviewTool(h, 'list_previews', {});
    expect(log).toHaveLength(3);
    expect(PREVIEW_TOOL_PREFIX).toBe('mcp__remyral-preview__');
  });

  it('the in-process MCP server routes calls to the host', async () => {
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
    expect(previewMcpServer(sdk, host(log), new AbortController().signal)).toMatchObject({
      name: 'remyral-preview',
    });
    const s = server as { name: string; tools: Tool[] } | null;
    if (s === null) throw new Error('no server');
    expect(s.tools.map((t) => t.name)).toEqual([...DEFAULT_PREVIEW_TOOL_NAMES]);
    const out = await s.tools.find((t) => t.name === 'open_preview')?.handler({ port: 22 });
    expect(out?.isError).toBe(true);
    expect(log).toHaveLength(0);
    expect(() =>
      previewMcpServer({ query: () => null as never }, host([]), new AbortController().signal),
    ).toThrow(/in-process tools/);
  });

  it('publish_site (ADR-0038): only for hosts that list it and implement publish; strict arguments', async () => {
    const log: unknown[] = [];
    const plain = host(log);
    expect(previewToolNamesOf(plain)).toEqual(['open_preview', 'close_preview', 'list_previews']);
    expect((await runPreviewTool(plain, 'publish_site', {})).ok).toBe(false);
    const pub: PreviewToolHost = {
      ...host(log),
      tools: ['publish_site'],
      publish: (a) => {
        log.push(['publish', a]);
        return Promise.resolve({ ok: true, text: 'recorded' });
      },
    };
    expect(previewToolNamesOf(pub)).toEqual(['publish_site']);
    expect(previewToolNamesOf({ ...host([]), tools: ['publish_site', 'open_preview'] })).toEqual([
      'open_preview',
    ]);
    expect(
      await runPreviewTool(pub, 'publish_site', {
        env: 'production',
        pagesProject: 'my-site',
        createIfMissing: true,
        domain: 'site.demo.test',
      }),
    ).toEqual({ ok: true, text: 'recorded' });
    expect(log).toEqual([
      [
        'publish',
        { env: 'production', pagesProject: 'my-site', createIfMissing: true, domain: 'site.demo.test' },
      ],
    ]);
    for (const bad of [
      { env: 'staging' },
      { pagesProject: 'Bad_Name' },
      { dns: 'maybe' },
      { directory: '../x' },
      { extra: 1 },
    ]) {
      expect((await runPreviewTool(pub, 'publish_site', bad)).ok).toBe(false);
    }
    expect(log).toHaveLength(1);
  });

  it('local binding is allowed in the Claude runtime sandbox only on request', () => {
    expect(claudeRuntimeSandbox({ workspace: '/w' }).network.allowLocalBinding).toBe(false);
    expect(claudeRuntimeSandbox({ workspace: '/w', allowLocalBinding: true }).network.allowLocalBinding).toBe(
      true,
    );
  });
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const root = mkdtempSync(join(tmpdir(), 'remyral-preview-tools-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describePosix('claude-code adapter registers the preview tools (ADR-0032)', () => {
  const turn: FakeTurnScript = () => [
    { kind: 'tool', id: 'toolu_pv', name: `${PREVIEW_TOOL_PREFIX}open_preview`, input: { port: 5173 } },
  ];
  async function run(
    previewTools: PreviewToolHost | undefined,
    approvalPolicy: SpawnContext['approvalPolicy'],
  ) {
    const sdk = new FakeClaudeSdk({ script: turn });
    Object.assign(sdk, {
      createSdkMcpServer: (o: { name: string }) => ({ type: 'sdk', name: o.name }),
      tool: (name: string) => ({ name }),
    });
    const adapter = createClaudeCodeAdapter({
      binaryPath: FAKE_CLI,
      sdkInfo: () => ({ sdkVersion: '0.3.310', claudeCodeVersion: '2.1.310', packageDir: root }),
      sdk,
      stateDir: join(root, 'state'),
      sourceEnv: { ...process.env },
    });
    await adapter.probe();
    const ctx: SpawnContext = {
      jobId: JobId.parse('job-preview-unit'),
      attemptId: AttemptId.parse('attempt-1'),
      workspaceRoot: mkdtempSync(join(root, 'ws-')),
      job: { runtime: 'claude-code', prompt: 'p', limits: { maxDurationSec: 60 } },
      sandboxProfile: 'host-restricted',
      approvalPolicy,
      repositoryTrust: 'untrusted',
      repoConfig: 'ignore-repository-config',
      secretEnv: {},
      timeouts: {
        startupMs: 5_000,
        cancelGraceMs: 500,
        cancelMs: 2_000,
        approvalMs: 5_000,
        maxDurationMs: 60_000,
      },
      allowUnverified: true,
      signal: new AbortController().signal,
      ...(previewTools === undefined ? {} : { previewTools }),
    };
    const ref = await adapter.spawn(ctx);
    await adapter.sendPrompt(ref, { text: 'go' });
    await collectUntilStopped(adapter, ref, 10_000);
    await adapter.cleanup(ref);
    return sdk;
  }

  it('with previewTools: the server, the pre-approved names and an allow from canUseTool (even deny-sensitive)', async () => {
    const sdk = await run(host([]), 'deny-sensitive');
    const o = sdk.calls[0]?.options;
    expect(Object.keys(o?.mcpServers ?? {})).toEqual(['remyral-preview']);
    expect(o?.allowedTools).toEqual(
      expect.arrayContaining(DEFAULT_PREVIEW_TOOL_NAMES.map((n) => `${PREVIEW_TOOL_PREFIX}${n}`)),
    );
    expect(o?.allowedTools).not.toContain(`${PREVIEW_TOOL_PREFIX}publish_site`);
    expect(sdk.queries[0]?.lastDecision).toMatchObject({ behavior: 'allow' });
  });

  it('a publish-only host: publish_site pre-approved, open_preview not (denied under deny-sensitive)', async () => {
    const sdk = await run(
      {
        ...host([]),
        tools: ['publish_site'],
        publish: () => Promise.resolve({ ok: true, text: 'recorded' }),
      },
      'deny-sensitive',
    );
    const o = sdk.calls[0]?.options;
    expect(Object.keys(o?.mcpServers ?? {})).toEqual(['remyral-preview']);
    expect(o?.allowedTools).toContain(`${PREVIEW_TOOL_PREFIX}publish_site`);
    expect(o?.allowedTools).not.toContain(`${PREVIEW_TOOL_PREFIX}open_preview`);
    expect(sdk.queries[0]?.lastDecision).toMatchObject({ behavior: 'deny' });
    expect(PREVIEW_TOOL_NAMES).toContain('publish_site');
  });

  it('without previewTools: no server and the tool name is just another (denied) tool', async () => {
    const sdk = await run(undefined, 'deny-sensitive');
    expect(sdk.calls[0]?.options.mcpServers).toEqual({});
    expect(sdk.queries[0]?.lastDecision).toMatchObject({ behavior: 'deny' });
  });
});
