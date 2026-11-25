// p15-model-picker: the runtimes' model lists on this machine (CAPABILITIES runtimeModels). Fixtures are trimmed real
// outputs of `pi --list-models` (pi 0.85.1), `opencode models` (opencode 1.19.0) and `codex debug models --bundled`
// (codex-cli 0.163.0); no runtime CLI runs here (the process runner is faked).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogModelsFor, RUNTIME_MODEL_CATALOG_VERSION, RuntimeModelsReport } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import type { RunFn, RunResult } from '../src/remote-ops/process.js';
import {
  parseCodexDebugModels,
  parseOpencodeModels,
  parsePiListModels,
  RuntimeModelLister,
} from '../src/runtimes/models.js';

const dir = join(import.meta.dirname, 'fixtures', 'runtime-models');
const fixture = (name: string) => readFileSync(join(dir, name), 'utf8');

describe('model list parsers', () => {
  it('opencode models: provider/model per line, colour and noise ignored', () => {
    const ids = parseOpencodeModels(fixture('opencode-models.txt')).map((m) => m.id);
    expect(ids).toContain('opencode/big-pickle');
    expect(ids).toContain('amazon-bedrock/amazon.nova-2-lite-v1:0');
    expect(ids).toHaveLength(10);
    expect(parseOpencodeModels('\u001b[32manthropic/claude-sonnet-5-5\u001b[0m\n\nUsing cache\n')).toEqual([
      { id: 'anthropic/claude-sonnet-5-5' },
    ]);
  });

  it('pi --list-models: the table becomes provider/model with the context window', () => {
    const models = parsePiListModels(fixture('pi-list-models.txt'));
    expect(models).toHaveLength(11);
    expect(models[0]).toEqual({ id: 'amazon-bedrock/amazon.nova-2-lite-v1:0', contextWindow: 1_000_000 });
    expect(models.find((m) => m.id === 'amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0')).toEqual({
      id: 'amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0',
      contextWindow: 200_000,
    });
    // No models configured: Pi prints a sentence, nothing is parsed from it.
    expect(parsePiListModels('No models available. Set an API key.\n')).toEqual([]);
  });

  it('codex debug models: listed models with display names, hidden ones dropped', () => {
    const models = parseCodexDebugModels(fixture('codex-debug-models.json'));
    expect(models.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol']);
    expect(models[0]).toEqual({ id: 'gpt-6-astra', displayName: 'GPT-6-Astra', contextWindow: 272_000 });
    expect(() => parseCodexDebugModels('error: not logged in')).toThrow();
    expect(() => parseCodexDebugModels('{"nope": 1}')).toThrow(/models/);
  });
});

function fakeRun(answers: Record<string, Partial<RunResult>>): { run: RunFn; calls: string[] } {
  const calls: string[] = [];
  const run: RunFn = (file, args, opts) => {
    const key = [file, ...args].join(' ');
    calls.push(key);
    // Plain helper environment only: no credential reaches a list command.
    expect(Object.keys(opts.env).some((k) => /KEY|TOKEN|SECRET/.test(k))).toBe(false);
    const a = answers[key];
    return Promise.resolve({
      exitCode: a?.exitCode ?? (a === undefined ? 127 : 0),
      stdout: a?.stdout ?? '',
      stderr: a?.stderr ?? (a === undefined ? 'not found' : ''),
      timedOut: a?.timedOut ?? false,
      ...(a?.spawnError === undefined ? {} : { spawnError: a.spawnError }),
    });
  };
  return { run, calls };
}

const at = new Date('2026-10-23T10:00:00.000Z');

describe('RuntimeModelLister', () => {
  const installed = (which: string[]) => (runtime: string) =>
    which.includes(runtime)
      ? runtime === 'pi'
        ? { command: '/usr/bin/node', args: ['/opt/pi/cli.js'] }
        : { command: `/bin/${runtime}`, args: [] }
      : null;

  it('lists every installed runtime: CLI lists, Claude Code from the catalog, access from the auth mode', async () => {
    const { run, calls } = fakeRun({
      '/bin/opencode models': { stdout: fixture('opencode-models.txt') },
      '/usr/bin/node /opt/pi/cli.js --list-models': { stdout: fixture('pi-list-models.txt') },
      '/bin/codex debug models': { stdout: fixture('codex-debug-models.json') },
    });
    const lister = new RuntimeModelLister({
      launch: installed(['claude-code', 'codex', 'pi', 'opencode']),
      authMode: (r) => (r === 'claude-code' ? 'local-login' : r === 'codex' ? 'secret-ref' : null),
      env: { PATH: '/bin', HOME: '/home/w' },
      run,
      clock: () => at,
    });
    const report = await lister.detect();
    expect(RuntimeModelsReport.parse(report)).toEqual(report);
    expect(report.catalogVersion).toBe(RUNTIME_MODEL_CATALOG_VERSION);
    const by = new Map(report.runtimes.map((r) => [r.runtime, r]));
    expect(by.get('claude-code')).toMatchObject({ source: 'builtin', access: 'subscription' });
    expect(by.get('claude-code')?.models.map((m) => m.id)).toEqual(
      catalogModelsFor('claude-code').map((m) => m.id),
    );
    expect(by.get('codex')).toMatchObject({
      source: 'cli',
      command: 'codex debug models',
      access: 'api-key',
    });
    expect(by.get('pi')).toMatchObject({ source: 'cli', command: 'pi --list-models', access: 'api-key' });
    expect(by.get('opencode')?.models).toHaveLength(10);
    // Claude Code has no list command: nothing is run for it.
    expect(calls.some((c) => c.includes('claude'))).toBe(false);
  });

  it('codex falls back to the bundled catalog; a failing CLI is reported failed (one redacted line)', async () => {
    const { run } = fakeRun({
      '/bin/codex debug models': { exitCode: 1, stderr: 'error: refresh failed token=abc123\nmore' },
      '/bin/codex debug models --bundled': { stdout: fixture('codex-debug-models.json') },
      '/bin/opencode models': { exitCode: 2, stderr: '\u001b[31mError: no providers\u001b[0m' },
      '/usr/bin/node /opt/pi/cli.js --list-models': { timedOut: true, exitCode: null },
    });
    const lister = new RuntimeModelLister({
      launch: installed(['codex', 'opencode', 'pi']),
      env: { PATH: '/bin' },
      run,
      clock: () => at,
    });
    const report = await lister.detect();
    const by = new Map(report.runtimes.map((r) => [r.runtime, r]));
    expect(by.get('codex')).toMatchObject({ source: 'cli', command: 'codex debug models --bundled' });
    expect(by.get('opencode')).toEqual({
      runtime: 'opencode',
      source: 'failed',
      checkedAt: at.toISOString(),
      access: 'api-key',
      models: [],
      error: 'opencode models: exit 2: Error: no providers',
    });
    expect(by.get('pi')).toMatchObject({ source: 'failed', error: 'pi --list-models: timed out' });
    // Not installed: not reported at all.
    expect(by.has('claude-code')).toBe(false);
    expect(RuntimeModelsReport.safeParse(report).success).toBe(true);
  });

  it('unreadable output is failed, invalid and duplicate ids dropped, long lists truncated at 500', async () => {
    const many = Array.from({ length: 600 }, (_, i) => `p/m${String(i)}`).join('\n');
    const { run } = fakeRun({
      '/bin/codex debug models': { stdout: 'garbage' },
      '/bin/codex debug models --bundled': { stdout: 'still garbage' },
      '/bin/opencode models': { stdout: `${many}\np/m1\n/abs/path\n` },
    });
    const lister = new RuntimeModelLister({ launch: installed(['codex', 'opencode']), env: {}, run });
    const report = await lister.detect();
    const by = new Map(report.runtimes.map((r) => [r.runtime, r]));
    expect(by.get('codex')?.source).toBe('failed');
    expect(by.get('codex')?.error).toMatch(/^codex debug models --bundled: unreadable output/);
    expect(by.get('opencode')?.models).toHaveLength(500);
    expect(by.get('opencode')?.truncated).toBe(true);
    expect(RuntimeModelsReport.safeParse(report).success).toBe(true);
  });

  it('snapshot never waits: null first, the report after the background run, again after the TTL', async () => {
    let now = at.getTime();
    const { run, calls } = fakeRun({ '/bin/opencode models': { stdout: 'a/b\n' } });
    const lister = new RuntimeModelLister({
      launch: installed(['opencode']),
      env: {},
      run,
      clock: () => new Date(now),
      ttlMs: 1000,
    });
    let ready = 0;
    expect(lister.snapshot(() => (ready += 1))).toBeNull();
    await lister.detect();
    expect(lister.snapshot()?.runtimes[0]?.models).toEqual([{ id: 'a/b' }]);
    const before = calls.length;
    now += 2000;
    expect(lister.snapshot()).not.toBeNull();
    await lister.detect();
    expect(calls.length).toBeGreaterThan(before);
    expect(ready).toBe(1);
  });
});
