/**
 * The Codex assistant engine against the **real pinned codex-cli** (CODEX_PIN) and a local mock Responses API
 * (fixtures/codex/mock-responses.ts): no model, no network, no real login. Opt-in: REMYRAL_CODEX_BIN (the
 * pinned binary). The test plays a worker user whose own config.toml (local-login) points Codex at the mock
 * provider and also carries what must NOT reach the assistant: an MCP server, a `notify` program and
 * developer instructions. The mock records each model request, so the tests assert what the model is
 * actually offered — exactly the platform tools, none of Codex's built-ins.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ASSISTANT_TOOL_NAMES } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ASSISTANT_SYSTEM_PROMPT,
  type AssistantToolBridge,
  CODEX_PIN,
  CodexAssistantEngine,
  SecretValue,
} from '../../../src/index.js';
import { pinnedCodexBinary } from '../../fixtures/codex/helpers.js';
import { startMockResponses, type MockScript } from '../../fixtures/codex/mock-responses.js';

const bin = process.env.REMYRAL_CODEX_BIN !== undefined ? pinnedCodexBinary() : undefined;
const base = join(homedir(), '.cache', 'remyral-tests');
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, 'codex-assistant-real-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const CODE_MODE_SLUG = 'remyral-code-mode-only-test';

/**
 * A model catalog like a ChatGPT login's (p8-codex-chat-code-mode: there every listed model is
 * `tool_mode: "code_mode_only"`): one entry copied from the pinned binary's bundled catalog
 * (`codex debug models --bundled`) — a code_mode_only model that also declares multi-agent v2 and extra
 * experimental tools — under a test slug.
 */
function codeModeOnlyCatalog(dir: string): string {
  const out = execFileSync(bin ?? 'codex', ['debug', 'models', '--bundled'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: mkdtempSync(join(dir, 'catalog-home-')) },
  });
  const models = (JSON.parse(out) as { models: Record<string, unknown>[] }).models;
  const entry =
    models.find(
      (m) =>
        m.tool_mode === 'code_mode_only' &&
        m.multi_agent_version === 'v2' &&
        Array.isArray(m.experimental_supported_tools) &&
        m.experimental_supported_tools.length > 0,
    ) ?? models.find((m) => m.tool_mode === 'code_mode_only');
  if (entry === undefined) throw new Error('the pinned catalog has no code_mode_only model');
  const file = join(dir, 'catalog.json');
  writeFileSync(file, JSON.stringify({ models: [{ ...entry, slug: CODE_MODE_SLUG, priority: 1 }] }));
  return file;
}

/** Every tool the request offers, `namespace.name` (Responses Lite puts them in an `additional_tools` input item). */
function offeredTools(req: Record<string, unknown>): string[] {
  const flat = (tools: unknown, prefix = ''): string[] =>
    (Array.isArray(tools) ? (tools as Record<string, unknown>[]) : []).flatMap((t) =>
      t.type === 'namespace' ? flat(t.tools, `${String(t.name)}.`) : [`${prefix}${String(t.name ?? t.type)}`],
    );
  const input = Array.isArray(req.input) ? (req.input as Record<string, unknown>[]) : [];
  return [
    ...flat(req.tools),
    ...input.filter((i) => i.type === 'additional_tools').flatMap((i) => flat(i.tools)),
  ];
}

/** A local-login session on the code_mode_only test model, against the mock provider. */
async function codeModeSession(script: MockScript, tools: AssistantToolBridge) {
  const mock = await startMockResponses(script);
  const home = mkdtempSync(join(root, 'home-'));
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome);
  writeFileSync(
    join(codexHome, 'config.toml'),
    [
      `model = "${CODE_MODE_SLUG}"`,
      'model_provider = "mock"',
      `model_catalog_json = ${JSON.stringify(codeModeOnlyCatalog(home))}`,
      '',
      '[model_providers.mock]',
      'name = "mock"',
      `base_url = ${JSON.stringify(mock.url)}`,
      'env_key = "MOCK_PROVIDER_KEY"',
      'wire_api = "responses"',
      '',
    ].join('\n'),
  );
  const engine = new CodexAssistantEngine({
    command: () => ({ command: bin ?? 'codex', args: [] }),
    stateRoot: join(root, 'state'),
    sourceEnv: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome },
  });
  const session = await engine.start({
    cwd: mkdtempSync(join(root, 'cwd-')),
    authMode: 'local-login',
    secretEnv: {},
    env: { MOCK_PROVIDER_KEY: 'mock-key' },
    tools,
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    timeouts: { startupMs: 60_000, turnMs: 60_000, cancelGraceMs: 3_000 },
  });
  return { mock, session };
}

describe.skipIf(bin === undefined)(
  `Codex assistant engine: real codex-cli ${CODEX_PIN}`,
  { timeout: 120_000 },
  () => {
    it('offers the model only the platform tools, relays a call and streams the answer', async () => {
      const mock = await startMockResponses();
      try {
        const home = mkdtempSync(join(root, 'home-'));
        const codexHome = join(home, '.codex');
        mkdirSync(codexHome);
        const notified = join(root, 'NOTIFIED');
        writeFileSync(
          join(codexHome, 'config.toml'),
          [
            'model = "gpt-5.4"',
            'model_provider = "mock"',
            'developer_instructions = "USER-DEVELOPER-INSTRUCTIONS-MARKER"',
            `notify = ["/usr/bin/touch", ${JSON.stringify(notified)}]`,
            '',
            '[model_providers.mock]',
            'name = "mock"',
            `base_url = ${JSON.stringify(mock.url)}`,
            'env_key = "MOCK_PROVIDER_KEY"',
            'wire_api = "responses"',
            '',
            '[mcp_servers.user-mcp]',
            'command = "/bin/cat"',
            '',
          ].join('\n'),
        );
        const calls: string[] = [];
        const tools: AssistantToolBridge = {
          call: (tool) => {
            calls.push(tool);
            return Promise.resolve({ content: '{"workers":[{"name":"mac"},{"name":"pi"}]}', isError: false });
          },
        };
        const engine = new CodexAssistantEngine({
          command: () => ({ command: bin ?? 'codex', args: [] }),
          stateRoot: join(root, 'state'),
          sourceEnv: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome },
        });
        expect(await engine.ready()).toEqual({ ready: true });
        const cwd = mkdtempSync(join(root, 'cwd-'));
        const session = await engine.start({
          cwd,
          authMode: 'local-login',
          secretEnv: {},
          env: { MOCK_PROVIDER_KEY: 'mock-key' },
          tools,
          systemPrompt: ASSISTANT_SYSTEM_PROMPT,
          timeouts: { startupMs: 60_000, turnMs: 60_000, cancelGraceMs: 3_000 },
        });
        try {
          const deltas: string[] = [];
          const r = await session.turn(
            { message: 'Which machines are online?', history: null },
            { delta: (t) => deltas.push(t) },
            new AbortController().signal,
          );
          expect(r.outcome).toBe('done');
          expect(r.text).toBe('Two workers online.');
          expect(deltas.join('')).toBe('Two workers online.');
          expect(calls).toEqual(['list_workers']);
          expect(r.usage).toMatchObject({ inputTokens: 200, outputTokens: 40, authMode: 'local-login' });
          expect(r.usage.costUsd).toBeUndefined();

          expect(mock.requests.length).toBe(2);
          for (const req of mock.requests) {
            const offered = (req.tools as { name?: string; type: string }[]).map((t) => t.name ?? t.type);
            expect(offered.sort()).toEqual([...ASSISTANT_TOOL_NAMES].sort());
            const text = JSON.stringify(req);
            expect(text).toContain('the operations assistant of the Remyral platform');
            expect(text).not.toContain('USER-DEVELOPER-INSTRUCTIONS-MARKER');
            expect(text).not.toContain('skills_instructions');
          }
          // The second request carries the relayed tool result back to the model.
          expect(JSON.stringify(mock.requests[1])).toContain('function_call_output');
          expect(session.alive).toBe(true);
        } finally {
          await session.close();
        }
        // The user's notify program never ran.
        expect(existsSync(notified)).toBe(false);
      } finally {
        await mock.close();
      }
    });

    it('secret-ref: private CODEX_HOME, the API key only in the environment', async () => {
      const mock = await startMockResponses();
      try {
        const key = 'sk-proj-remyral-test-0123456789abcdef';
        const engine = new CodexAssistantEngine({
          command: () => ({ command: bin ?? 'codex', args: [] }),
          stateRoot: join(root, 'state'),
          sourceEnv: { PATH: process.env.PATH, HOME: mkdtempSync(join(root, 'home-')) },
          apiBaseUrl: mock.url,
        });
        const stateDir = mkdtempSync(join(root, 'st-'));
        const session = await engine.start({
          cwd: mkdtempSync(join(root, 'cwd-')),
          stateDir,
          authMode: 'secret-ref',
          secretEnv: { CODEX_API_KEY: new SecretValue(key) },
          model: 'gpt-5.4',
          tools: { call: () => Promise.resolve({ content: '[]', isError: false }) },
          systemPrompt: ASSISTANT_SYSTEM_PROMPT,
          timeouts: { startupMs: 60_000, turnMs: 60_000, cancelGraceMs: 3_000 },
        });
        try {
          const r = await session.turn(
            { message: 'hi', history: null },
            { delta: () => undefined },
            new AbortController().signal,
          );
          expect(r.outcome).toBe('done');
          expect(mock.requests.length).toBe(2);
          // The key reached the provider as a bearer token from the environment (never argv).
          expect(mock.authorizations.every((a) => a === `Bearer ${key}`)).toBe(true);
          const offered = (mock.requests[0]?.tools as { name: string }[]).map((t) => t.name).sort();
          expect(offered).toEqual([...ASSISTANT_TOOL_NAMES].sort());
          // Ephemeral credential store: nothing with the key was written into the private home.
          const files = readdirSync(stateDir, { recursive: true }) as string[];
          for (const f of files) {
            const p = join(stateDir, f);
            if (statSync(p).isFile()) expect(readFileSync(p, 'utf8')).not.toContain(key);
          }
        } finally {
          await session.close();
        }
        expect(readdirSync(stateDir)).toEqual([]);
      } finally {
        await mock.close();
      }
    });

    it('code_mode_only model: the platform tools stay direct and are called directly; no sub-agent tools', async () => {
      const calls: string[] = [];
      const { mock, session } = await codeModeSession(
        {},
        {
          call: (tool) => {
            calls.push(tool);
            return Promise.resolve({ content: '{"workers":[]}', isError: false });
          },
        },
      );
      try {
        const r = await session.turn(
          { message: 'Which machines are online?', history: null },
          { delta: () => undefined },
          new AbortController().signal,
        );
        expect(r.outcome).toBe('done');
        expect(r.usage.model).toBe(CODE_MODE_SLUG);
        expect(calls).toEqual(['list_workers']);
        expect(session.alive).toBe(true);
        for (const req of mock.requests) {
          const offered = offeredTools(req);
          // Every platform tool is a top-level function the model calls directly …
          for (const name of ASSISTANT_TOOL_NAMES) expect(offered).toContain(`functions.${name}`);
          // … and none is nested inside code mode's exec (whose host is off and can run nothing).
          const text = JSON.stringify(req);
          for (const name of ASSISTANT_TOOL_NAMES) {
            expect(text).not.toContain(`declare const tools: { ${name}(`);
          }
          // The catalog's multi-agent v2 / clock tools are switched off.
          expect(offered.filter((t) => /^(collaboration|clock)\.|spawn_agent|sleep/.test(t))).toEqual([]);
          // Residual of 0.162.1 (docs/compat/codex.md §11): Codex lists the dead exec/wait for any
          // code_mode_only model and no setting removes them; a call ends the session (next tests).
          // 0.164.0 also lists `apply_patch` for a catalog entry with `apply_patch_tool_type`, even without an
          // environment (`spec_plan.rs` dropped the `advertise_environment_tools` gate); it is dead too (no
          // environment: "No usable execution environment") and a call of it ends the session.
          const extra = offered.filter(
            (t) => !(ASSISTANT_TOOL_NAMES as readonly string[]).includes(t.replace(/^functions\./, '')),
          );
          expect(extra.sort()).toEqual(
            [
              'functions.apply_patch',
              'functions.exec',
              'functions.list_mcp_resource_templates',
              'functions.list_mcp_resources',
              'functions.read_mcp_resource',
              'functions.wait',
              ...extra.filter((t) => t.endsWith('_async')),
            ].sort(),
          );
        }
      } finally {
        await session.close();
        await mock.close();
      }
    });

    it('code_mode_only model: a call of exec ends the session with a clear engine error', async () => {
      const calls: string[] = [];
      const { mock, session } = await codeModeSession(
        { toolKind: 'custom', toolName: 'exec', toolArguments: 'text(await tools.list_workers({}))' },
        {
          call: (tool) => {
            calls.push(tool);
            return Promise.resolve({ content: '[]', isError: false });
          },
        },
      );
      try {
        const r = await session.turn(
          { message: 'Which machines are online?', history: null },
          { delta: () => undefined },
          new AbortController().signal,
        );
        expect(r.outcome).toBe('failed');
        expect(r.errorCode).toBe('code_mode_refused');
        expect(r.detail).toContain('`exec`');
        expect(calls).toEqual([]);
        expect(session.alive).toBe(false);
      } finally {
        await session.close();
        await mock.close();
      }
    });

    it('code_mode_only model (0.164.0): a call of the listed apply_patch ends the session, nothing is written', async () => {
      const calls: string[] = [];
      const { mock, session } = await codeModeSession(
        {
          toolKind: 'custom',
          toolName: 'apply_patch',
          toolArguments: '*** Begin Patch\n*** Add File: PATCHED.txt\n+x\n*** End Patch\n',
        },
        {
          call: (tool) => {
            calls.push(tool);
            return Promise.resolve({ content: '[]', isError: false });
          },
        },
      );
      try {
        const r = await session.turn(
          { message: 'Which machines are online?', history: null },
          { delta: () => undefined },
          new AbortController().signal,
        );
        expect(r.outcome).toBe('failed');
        expect(r.errorCode).toBe('runtime_refused');
        expect(r.detail).toContain('apply_patch');
        expect(calls).toEqual([]);
        expect(session.alive).toBe(false);
      } finally {
        await session.close();
        await mock.close();
      }
    });
  },
);
