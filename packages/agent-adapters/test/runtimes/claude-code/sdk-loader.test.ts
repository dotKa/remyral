import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AttemptId, JobId } from '@remyral/protocol';
import {
  CLAUDE_AGENT_SDK_PACKAGE,
  ClaudeAssistantEngine,
  ClaudeSdkUnavailableError,
  createClaudeCodeAdapter,
  claudeSdkEntryFile,
  claudeSdkSpecifier,
  loadClaudeAgentSdk,
  locateClaudeSdk,
  VersionMismatchError,
} from '../../../src/index.js';
import { FAKE_CLI } from '../../fixtures/claude-code/fake-sdk.js';

// oss-sdk-external: the worker bundle no longer contains the Agent SDK. The SDK is loaded from the runtime the
// machine installed (next to the CLI it runs), else by its package name (source checkouts, tests).

const root = mkdtempSync(join(tmpdir(), 'remyral-sdk-loader-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const plat = `claude-agent-sdk-${process.platform}-${process.arch}`;
const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';

/** A worker-managed install layout (`npm ci` of the SDK pin): `<dir>/node_modules/@anthropic-ai/...`. */
function runtimeDir(
  name: string,
  pkg: Record<string, unknown>,
  files: Record<string, string>,
): { dir: string; binary: string; sdkDir: string } {
  const dir = join(root, name);
  const scope = join(dir, 'node_modules', '@anthropic-ai');
  const sdkDir = join(scope, 'claude-agent-sdk');
  mkdirSync(join(scope, plat), { recursive: true });
  mkdirSync(sdkDir, { recursive: true });
  const binary = join(scope, plat, exe);
  writeFileSync(binary, '#!/bin/sh\n');
  writeFileSync(join(sdkDir, 'package.json'), JSON.stringify({ name: CLAUDE_AGENT_SDK_PACKAGE, ...pkg }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(sdkDir, file, '..'), { recursive: true });
    writeFileSync(join(sdkDir, file), text);
  }
  return { dir, binary, sdkDir };
}

const fakeSdk = (marker: string): string =>
  `export const marker = ${JSON.stringify(marker)};\nexport function query() {}\nexport function tool() {}\nexport function createSdkMcpServer() {}\n`;

const noBare = { resolveModule: () => undefined };

describe('Claude Agent SDK loader', () => {
  it('loads the SDK next to the installed CLI, from the entry its package.json exports declare', async () => {
    const rt = runtimeDir(
      'exports',
      {
        version: '0.3.310',
        main: 'wrong.mjs',
        exports: { '.': { types: './sdk.d.ts', default: './lib/sdk.mjs' } },
      },
      { 'lib/sdk.mjs': fakeSdk('exports-entry'), 'wrong.mjs': fakeSdk('main-entry') },
    );
    const loc = locateClaudeSdk(rt.binary, noBare);
    expect(loc).toMatchObject({ source: 'runtime', packageDir: rt.sdkDir, sdkVersion: '0.3.310' });
    const sdk = (await loadClaudeAgentSdk(rt.binary, noBare)) as unknown as { marker: string };
    expect(sdk.marker).toBe('exports-entry');
  });

  it('falls back to `main` when the package has no exports map', async () => {
    const rt = runtimeDir('main', { version: '0.3.296', main: 'sdk.mjs' }, { 'sdk.mjs': fakeSdk('main') });
    expect(claudeSdkEntryFile(rt.sdkDir)).toBe(join(rt.sdkDir, 'sdk.mjs'));
    const sdk = (await loadClaudeAgentSdk(rt.binary, noBare)) as unknown as { marker: string };
    expect(sdk.marker).toBe('main');
  });

  it('each installed version is its own module: a rollback loads the JS that matches the CLI', async () => {
    const a = runtimeDir('v-new', { version: '0.3.310', main: 'sdk.mjs' }, { 'sdk.mjs': fakeSdk('new') });
    const b = runtimeDir('v-old', { version: '0.3.296', main: 'sdk.mjs' }, { 'sdk.mjs': fakeSdk('old') });
    const first = (await loadClaudeAgentSdk(a.binary, noBare)) as unknown as { marker: string };
    const second = (await loadClaudeAgentSdk(b.binary, noBare)) as unknown as { marker: string };
    expect([first.marker, second.marker]).toEqual(['new', 'old']);
  });

  it.skipIf(process.platform === 'win32')(
    'follows a symlinked CLI (the images link it as /usr/local/bin/claude)',
    () => {
      const rt = runtimeDir(
        'linked',
        { version: '0.3.310', main: 'sdk.mjs' },
        { 'sdk.mjs': fakeSdk('linked') },
      );
      const bin = join(root, 'bin');
      mkdirSync(bin, { recursive: true });
      symlinkSync(rt.binary, join(bin, 'claude'));
      expect(locateClaudeSdk(join(bin, 'claude'), noBare)).toMatchObject({
        source: 'runtime',
        packageDir: realpathSync(rt.sdkDir),
      });
    },
  );

  it('never loads an entry outside the package directory', () => {
    const rt = runtimeDir('escape', { version: '0.3.310', exports: { '.': '../../../evil.mjs' } }, {});
    writeFileSync(join(rt.dir, 'evil.mjs'), fakeSdk('evil'));
    expect(claudeSdkEntryFile(rt.sdkDir)).toBeUndefined();
    expect(locateClaudeSdk(rt.binary, noBare)).toBeUndefined();
  });

  it('falls back to the package name when no SDK is next to the CLI (source checkouts)', async () => {
    const seen: string[] = [];
    const sdk = await loadClaudeAgentSdk(join(root, 'nowhere', 'claude'), {
      resolveModule: () => '/checkout/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
      importModule: (spec) => {
        seen.push(spec);
        return Promise.resolve({ marker: 'bare' });
      },
    });
    expect(seen).toEqual([CLAUDE_AGENT_SDK_PACKAGE]);
    expect((sdk as unknown as { marker: string }).marker).toBe('bare');
  });

  it('missing everywhere: a typed, actionable error (version_mismatch path), never a crash', async () => {
    const binary = join(root, 'native', 'claude');
    expect(locateClaudeSdk(binary, noBare)).toBeUndefined();
    const err = await loadClaudeAgentSdk(binary, noBare).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ClaudeSdkUnavailableError);
    expect(err).toBeInstanceOf(VersionMismatchError);
    expect((err as ClaudeSdkUnavailableError).code).toBe('version_mismatch');
    expect((err as Error).message).toContain(binary);
    expect((err as Error).message).toMatch(/Makineler|Runtimes|install/i);
  });

  it('a module that fails to load is not cached: a later install is picked up', async () => {
    let calls = 0;
    const deps = {
      resolveModule: () => '/x/sdk.mjs',
      importModule: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ marker: 'ok' });
      },
    };
    await expect(loadClaudeAgentSdk(undefined, deps)).rejects.toBeInstanceOf(ClaudeSdkUnavailableError);
    await expect(loadClaudeAgentSdk(undefined, deps)).resolves.toMatchObject({ marker: 'ok' });
  });

  it('import specifiers are file:// URLs on every host (a bare C:\\ path is not an ESM specifier)', () => {
    expect(
      claudeSdkSpecifier('C:\\Users\\w\\rt\\node_modules\\@anthropic-ai\\claude-agent-sdk\\sdk.mjs', true),
    ).toBe('file:///C:/Users/w/rt/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
    expect(
      claudeSdkSpecifier('/opt/remyral/runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', false),
    ).toBe('file:///opt/remyral/runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
  });

  it('the probe reports Claude Code as not installed (with the reason) when its SDK is missing; spawn is refused', async () => {
    const adapter = createClaudeCodeAdapter({
      binaryPath: FAKE_CLI,
      sdkInfo: () => ({ sdkVersion: '0.3.310', claudeCodeVersion: '2.1.310', packageDir: root }),
      sdkLoader: noBare,
      stateDir: join(root, 'state'),
    });
    const probe = await adapter.probe();
    expect(probe.installed).toBe(false);
    expect(probe.notes.join('\n')).toContain('Claude Agent SDK could not be loaded');
    await expect(
      adapter.spawn({
        jobId: JobId.parse('job-sdk-missing'),
        attemptId: AttemptId.parse('attempt-1'),
        workspaceRoot: root,
        job: { runtime: 'claude-code', prompt: 'p', limits: { maxDurationSec: 60 } },
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
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
      }),
    ).rejects.toBeInstanceOf(VersionMismatchError);
  });

  it('the assistant is not ready, naming the missing SDK, before any model is started', async () => {
    const engine = new ClaudeAssistantEngine({ binary: () => FAKE_CLI, sdkLoader: noBare });
    const r = await engine.ready();
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('Claude Agent SDK could not be loaded');
  });
});
