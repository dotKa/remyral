import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AttemptId, JobId } from '@remyral/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CapabilityUnsupportedError,
  createCodexAdapter,
  InvalidSpawnContextError,
  SessionNotFoundError,
  SessionStateError,
  type SpawnContext,
} from '../../../src/index.js';
import { collectUntilStopped, readUntil } from '../../../src/testing/index.js';
import { codexTestStateDir, FAKE_APP_SERVER } from '../../fixtures/codex/helpers.js';

/** p10-approval-pause: park a stopped Codex session and resume its thread from a new adapter instance. */
const describePosix = process.platform === 'win32' ? describe.skip : describe;
const stateDir = codexTestStateDir();
const wsRoot = mkdtempSync(join(tmpdir(), 'remyral-codex-park-'));
afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(wsRoot, { recursive: true, force: true });
});

function ctx(workspaceRoot: string, overrides: Partial<SpawnContext> = {}): SpawnContext {
  return {
    jobId: JobId.parse('job-codex-park'),
    attemptId: AttemptId.parse('attempt-1'),
    workspaceRoot,
    job: { runtime: 'codex', prompt: 'p', limits: { maxDurationSec: 60 } },
    sandboxProfile: 'runtime-sandbox',
    approvalPolicy: 'ask-sensitive',
    repositoryTrust: 'untrusted',
    repoConfig: 'ignore-repository-config',
    secretEnv: {},
    timeouts: {
      startupMs: 10_000,
      cancelGraceMs: 500,
      cancelMs: 2_000,
      approvalMs: 5_000,
      maxDurationMs: 60_000,
    },
    allowUnverified: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const make = () =>
  createCodexAdapter({ codexPath: FAKE_APP_SERVER, stateDir, sourceEnv: { ...process.env } });

async function recordedHome(ws: string): Promise<string | null> {
  const file = join(ws, '.fake-codex.json');
  const end = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error('fake app-server did not record itself');
    await new Promise((r) => setTimeout(r, 20));
  }
  return (JSON.parse(readFileSync(file, 'utf8')) as { codexHome: string | null }).codexHome;
}

describePosix('codex adapter: park and resume (p10-approval-pause)', () => {
  it('parks a thread stopped while waiting for an approval and resumes it with thread/resume from a new instance', async () => {
    const ws = mkdtempSync(join(wsRoot, 'ws-'));
    const first = make();
    await first.probe();
    const ref = await first.spawn(ctx(ws));
    await first.sendPrompt(ref, { text: 'approval please' });
    await readUntil(first, ref, (e) => e.event.kind === 'approval_request', 5_000);
    const home = await recordedHome(ws);
    await first.cancel(ref, 'paused');
    const parked = await first.parkSession(ref);
    expect(parked.runtime).toBe('codex');
    expect(parked.runtimeSessionId).toBe(first.threadInfo(ref)?.threadId);
    const rel = parked.state?.home ?? '';
    expect(rel).toMatch(/^home-/);
    expect(isAbsolute(rel)).toBe(false);
    await first.cleanup(ref);
    // The rollouts survive the cleanup of the parked session.
    expect(home).not.toBeNull();
    expect(existsSync(home ?? '/nonexistent')).toBe(true);

    rmSync(join(ws, '.fake-codex.json'));
    // p14-codex-mcp-isolation: an MCP server in the parked home's config.toml is disabled on thread/resume too.
    writeFileSync(
      join(home ?? '/nonexistent', 'config.toml'),
      '[mcp_servers.late]\ncommand = "/bin/false"\n',
    );
    const second = make();
    // Another id than the fake's thread/start default proves the resume went through thread/resume {threadId}.
    const threadId = '0199a0a0-0000-7000-8000-0000000000aa';
    const resumed = await second.resumeParked(ctx(ws), { ...parked, runtimeSessionId: threadId });
    expect(second.threadInfo(resumed)?.threadId).toBe(threadId);
    expect(await recordedHome(ws)).toBe(home);
    const start = JSON.parse(readFileSync(join(ws, '.fake-codex-start.json'), 'utf8')) as {
      method: string;
      config: unknown;
    };
    expect(start).toMatchObject({
      method: 'thread/resume',
      config: { mcp_servers: { late: { enabled: false } }, notify: [] },
    });
    await second.sendPrompt(resumed, { text: 'basic task' });
    await collectUntilStopped(second, resumed, 10_000);
    expect((await second.collectResult(resumed)).outcome).toBe('succeeded');
    await second.cleanup(resumed);
    // Not parked again: the resumed session owns the home and removes it.
    expect(existsSync(home ?? '/nonexistent')).toBe(false);
  });

  it('refuses to park a running session', async () => {
    const adapter = make();
    await adapter.probe();
    const ref = await adapter.spawn(ctx(mkdtempSync(join(wsRoot, 'ws-'))));
    await adapter.sendPrompt(ref, { text: 'approval please' });
    await readUntil(adapter, ref, (e) => e.event.kind === 'approval_request', 5_000);
    await expect(adapter.parkSession(ref)).rejects.toBeInstanceOf(SessionStateError);
    await adapter.cleanup(ref);
  });

  it('refuses tampered or missing parked state', async () => {
    mkdirSync(stateDir, { recursive: true });
    const adapter = make();
    const ws = mkdtempSync(join(wsRoot, 'ws-'));
    const base = { runtime: 'codex' as const, runtimeSessionId: '0199a0a0-0000-7000-8000-0000000000ab' };
    for (const home of ['/etc', '../outside', 'home-x/../../outside', '']) {
      await expect(adapter.resumeParked(ctx(ws), { ...base, state: { home } })).rejects.toBeInstanceOf(
        InvalidSpawnContextError,
      );
    }
    await expect(adapter.resumeParked(ctx(ws), base)).rejects.toBeInstanceOf(InvalidSpawnContextError);
    await expect(
      adapter.resumeParked(ctx(ws), { ...base, state: { home: 'home-missing' } }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(
      adapter.resumeParked(ctx(ws), { ...base, runtimeSessionId: 'a b', state: { home: 'home-a' } }),
    ).rejects.toBeInstanceOf(InvalidSpawnContextError);
  });

  it('gates the resume on the resume capability (unverified until live)', async () => {
    const adapter = make();
    await expect(
      adapter.resumeParked(ctx(mkdtempSync(join(wsRoot, 'ws-')), { allowUnverified: false }), {
        runtime: 'codex',
        runtimeSessionId: '0199a0a0-0000-7000-8000-0000000000ac',
        state: { home: 'home-a' },
      }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
  });
});
