/**
 * Pi adapter against the fixture-driven stand-in (fixtures/pi/fake-pi.mjs):
 * runs everywhere, no Pi installation needed. The stand-in replays record
 * shapes captured from Pi 1.1.0 and executes the adapter's real gate extension.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CapabilityUnsupportedError,
  createPiAdapter,
  PI_GATE_POLICY_ENV,
  RuntimeCrashedError,
  SecretValue,
  SessionNotFoundError,
  VersionMismatchError,
  type PiAdapterOptions,
} from '../src/index.js';
import { defineAdapterContractSuite } from '../src/testing/index.js';
import { drain, spawnContext, waitFor } from './helpers/runtime.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi', 'fake-pi.mjs');
const root = mkdtempSync(join(tmpdir(), 'remyral-pi-fake-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const FAST = {
  startupMs: 10_000,
  cancelGraceMs: 500,
  cancelMs: 3_000,
  approvalMs: 5_000,
  maxDurationMs: 60_000,
};

function adapter(extra: Partial<PiAdapterOptions> = {}, env: Record<string, string> = {}) {
  return createPiAdapter({
    command: process.execPath,
    commandArgs: [FAKE],
    stateDir: join(root, 'state', randomUUID()),
    authMode: 'secret-ref',
    model: 'remyral-faux/scripted',
    platform: { os: 'darwin', arch: 'arm64' },
    env,
    ...extra,
  });
}

function workspace(): string {
  const dir = join(root, 'ws', randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

const prompts = {
  basic: 'faux:basic contract',
  'long-running': 'faux:long',
  approval: 'faux:approval',
} as const;

defineAdapterContractSuite('pi (fixture process, contract-tested platform)', () => adapter(), {
  prompts,
  timeouts: FAST,
});

defineAdapterContractSuite(
  'pi (fixture process, platform not contract-tested: everything unverified)',
  () => adapter({ platform: { os: 'linux', arch: 'x64' } }),
  { prompts, timeouts: FAST },
);

defineAdapterContractSuite(
  'pi (fixture process, version drift, policy allows unverified)',
  () => adapter({}, { FAKE_PI_VERSION: '1.2.0' }),
  { prompts, timeouts: FAST, makeContext: (base) => ({ ...base, allowUnverified: true }) },
);

describe('pi adapter (fixture process)', { timeout: 30_000 }, () => {
  it('passes the ADR-0012 policy flags and keeps secrets out of argv', async () => {
    const argvFile = join(root, `argv-${randomUUID()}.json`);
    const secret = new SecretValue(`sk-${randomUUID()}`);
    const a = adapter({}, { FAKE_PI_ARGV_FILE: argvFile });
    const ws = workspace();
    const ref = await a.spawn(
      spawnContext('pi', ws, { timeouts: FAST, secretEnv: { OPENAI_API_KEY: secret } }),
    );
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    for (const flag of [
      '--offline',
      '--no-approve',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-mcp',
      '--no-context-files',
    ]) {
      expect(argv).toContain(flag);
    }
    expect(argv.slice(argv.indexOf('--mode'), argv.indexOf('--mode') + 2)).toEqual(['--mode', 'rpc']);
    const gate = argv[argv.indexOf('-e') + 1] ?? '';
    expect(gate).toMatch(/remyral-permission-gate\.mjs$/);
    expect(existsSync(gate)).toBe(true);
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(ref.runtimeSessionId);
    expect(argv[argv.indexOf('--session-dir') + 1]?.startsWith('/')).toBe(true);
    expect(argv.join(' ')).not.toContain(secret.reveal());
    await a.cleanup(ref);
    expect(existsSync(gate)).toBe(false);
  });

  it('p8-subtasks-pi: the sub-job tool extension is loaded (and listed in --tools) only for a job with sub-job tools', async () => {
    const host = {
      request: () => Promise.resolve({ ok: true, text: '' }),
      wait: () => Promise.resolve({ ok: true, text: '' }),
      cancel: () => Promise.resolve({ ok: true, text: '' }),
    };
    expect(adapter().offersSubtaskTools).toBe(true);
    for (const withTools of [true, false]) {
      const argvFile = join(root, `argv-${randomUUID()}.json`);
      const a = adapter({ tools: ['read', 'grep'] }, { FAKE_PI_ARGV_FILE: argvFile });
      const ref = await a.spawn(
        spawnContext('pi', workspace(), { timeouts: FAST, ...(withTools ? { subtaskTools: host } : {}) }),
      );
      const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
      const extensions = argv.flatMap((x, i) => (x === '-e' ? [argv[i + 1] ?? ''] : []));
      const sub = extensions.find((e) => e.endsWith('remyral-subtask-tools.mjs'));
      const tools = argv[argv.indexOf('--tools') + 1];
      if (withTools) {
        expect(extensions[0]).toMatch(/remyral-permission-gate\.mjs$/);
        expect(sub).toBeDefined();
        expect(readFileSync(sub ?? '', 'utf8')).toContain('request_subtask');
        expect(tools).toBe('read,grep,request_subtask,wait_subtask,cancel_subtask');
      } else {
        expect(sub).toBeUndefined();
        expect(tools).toBe('read,grep');
      }
      await a.cleanup(ref);
    }
  });

  it('p22-previews-inputs: a job with preview tools loads the job-tool extension with them (also without sub-job tools)', async () => {
    const preview = {
      open: () => Promise.resolve({ ok: true, text: '' }),
      close: () => Promise.resolve({ ok: true, text: '' }),
      list: () => Promise.resolve({ ok: true, text: '' }),
    };
    const argvFile = join(root, `argv-${randomUUID()}.json`);
    const a = adapter({ tools: ['read'] }, { FAKE_PI_ARGV_FILE: argvFile });
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST, previewTools: preview }));
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    const extensions = argv.flatMap((x, i) => (x === '-e' ? [argv[i + 1] ?? ''] : []));
    const ext = extensions.find((e) => e.endsWith('remyral-subtask-tools.mjs'));
    expect(ext).toBeDefined();
    const src = readFileSync(ext ?? '', 'utf8');
    for (const n of ['open_preview', 'close_preview', 'list_previews'])
      expect(src).toContain(`"name":"${n}"`);
    expect(src).not.toContain('"name":"publish_site"');
    expect(src).not.toContain('"name":"request_subtask"');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('read,open_preview,close_preview,list_previews');
    await a.cleanup(ref);
  });

  it('p6-skills: verified skills load with --skill from the private run dir; discovery stays off', async () => {
    const argvFile = join(root, `argv-${randomUUID()}.json`);
    const a = adapter({}, { FAKE_PI_ARGV_FILE: argvFile });
    expect(a.skillDelivery()).toBe('native');
    const ws = workspace();
    const ref = await a.spawn({
      ...spawnContext('pi', ws, { timeouts: FAST }),
      skills: [
        {
          id: 'release-notes',
          version: '1.0.0',
          title: 'Release notes',
          description: 'd',
          files: [
            {
              path: 'SKILL.md',
              content: '---\nname: release-notes\ndescription: d\n---\nx\n',
              executable: false,
            },
          ],
        },
      ],
    });
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    expect(argv).toContain('--no-skills');
    const dir = argv[argv.indexOf('--skill') + 1] ?? '';
    expect(dir.endsWith('/skills/release-notes')).toBe(true);
    expect(dir.startsWith(ws)).toBe(false);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('name: release-notes');
    await a.cleanup(ref);
    expect(existsSync(dir)).toBe(false);
  });

  it('trusted repositories keep their context files', async () => {
    const argvFile = join(root, `argv-${randomUUID()}.json`);
    const a = adapter({}, { FAKE_PI_ARGV_FILE: argvFile });
    const ref = await a.spawn(
      spawnContext('pi', workspace(), { timeouts: FAST, repositoryTrust: 'trusted' }),
    );
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).not.toContain('--no-context-files');
    await a.cleanup(ref);
  });

  it('refuses a version that differs from the pin unless policy allows unverified', async () => {
    const a = adapter({}, { FAKE_PI_VERSION: '1.0.9' });
    const probe = await a.probe();
    expect(probe.versionMatchesPin).toBe(false);
    expect(Object.values(probe.capabilities.capabilities).every((c) => c.status !== 'supported')).toBe(true);
    await expect(a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }))).rejects.toBeInstanceOf(
      VersionMismatchError,
    );
  });

  it('reports a missing executable as not installed', async () => {
    const a = createPiAdapter({
      command: join(root, 'no-such-pi'),
      stateDir: join(root, 'state', randomUUID()),
      authMode: 'secret-ref',
    });
    const probe = await a.probe();
    expect(probe.installed).toBe(false);
    expect(probe.version).toBeUndefined();
    await expect(a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }))).rejects.toBeInstanceOf(
      RuntimeCrashedError,
    );
  });

  it('rejects a Pi that does not honour --session-id', async () => {
    const a = adapter({}, { FAKE_PI_WRONG_SESSION: '1' });
    await expect(a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }))).rejects.toThrow(/session-id/);
    expect(a.liveSessionCount).toBe(0);
  });

  it('a rejected prompt (no credentials) ends the session as failed with prompt_rejected', async () => {
    const a = adapter({}, { FAKE_PI_NO_AUTH: '1' });
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:basic' });
    const events = (await drain(a, ref, 10_000)).map((e) => e.event);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'prompt_rejected' }));
    expect(await a.collectResult(ref)).toMatchObject({ outcome: 'failed', errorCode: 'prompt_rejected' });
    await a.cleanup(ref);
  });

  it('a crash mid-run is reported as runtime_crashed with the exit code', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:crash' });
    const events = (await drain(a, ref, 10_000)).map((e) => e.event);
    const err = events.find((e) => e.kind === 'error');
    expect(err).toMatchObject({ kind: 'error', code: 'runtime_crashed' });
    expect(err?.kind === 'error' && err.message).toContain('exit code 3');
    expect(await a.collectResult(ref)).toMatchObject({
      outcome: 'failed',
      errorCode: 'runtime_crashed',
      exit: { code: 3, signal: null },
    });
    await a.cleanup(ref);
  });

  it('an unknown record type fails the session closed (no silent drift)', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:badline' });
    const events = (await drain(a, ref, 10_000)).map((e) => e.event);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'runtime_protocol_error' }));
    expect((await a.collectResult(ref)).outcome).toBe('failed');
    await a.cleanup(ref);
  });

  it('cancel falls back to the process-tree kill when abort is not answered', async () => {
    const a = adapter({}, { FAKE_PI_IGNORE_ABORT: '1' });
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:long' });
    await waitFor(a, ref, (e) => e.event.kind === 'status' && e.event.phase === 'running');
    const t0 = Date.now();
    const outcome = await a.cancel(ref);
    expect(outcome.mode).toBe('forced');
    expect(Date.now() - t0).toBeLessThan(FAST.cancelMs);
    expect((await a.collectResult(ref)).outcome).toBe('cancelled');
    await a.cleanup(ref);
  });

  it('without an offered approval capability the gate denies instead of asking', async () => {
    const a = adapter({ platform: { os: 'linux', arch: 'x64' } });
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:approval' });
    const events = (await drain(a, ref, 10_000)).map((e) => e.event);
    expect(events.some((e) => e.kind === 'approval_request')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', ok: false }));
    await expect(
      a.requestApproval(ref, { approvalId: 'x', decision: 'approve', decidedBy: 't' }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
    await a.cleanup(ref);
  });

  it('the wall-clock limit stops the run as failed', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: { ...FAST, maxDurationMs: 300 } }));
    await a.sendPrompt(ref, { text: 'faux:long' });
    const events = (await drain(a, ref, 10_000)).map((e) => e.event);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'max_duration_exceeded' }));
    expect(await a.collectResult(ref)).toMatchObject({
      outcome: 'failed',
      errorCode: 'max_duration_exceeded',
    });
    await a.cleanup(ref);
  });

  it('secret-ref uses a fresh agent dir; local-login keeps the user dir and never sets one', async () => {
    const argvFile = join(root, `argv-${randomUUID()}.json`);
    const stateDir = join(root, 'state', randomUUID());
    const a = createPiAdapter({
      command: process.execPath,
      commandArgs: [FAKE],
      stateDir,
      authMode: 'secret-ref',
      platform: { os: 'darwin', arch: 'arm64' },
      env: { FAKE_PI_ARGV_FILE: argvFile },
    });
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }));
    expect(existsSync(join(stateDir, 'run', ref.sessionId, 'agent'))).toBe(true);
    await a.cleanup(ref);
    const b = createPiAdapter({
      command: process.execPath,
      commandArgs: [FAKE],
      stateDir,
      authMode: 'local-login',
      platform: { os: 'darwin', arch: 'arm64' },
    });
    const ref2 = await b.spawn(spawnContext('pi', workspace(), { timeouts: FAST }));
    expect(existsSync(join(stateDir, 'run', ref2.sessionId, 'agent'))).toBe(false);
    expect((await b.probe()).authenticated).toBe('unknown');
    await b.cleanup(ref2);
  });

  it('local-login usage is token-only (no runtime dollar cost, ADR-0014)', async () => {
    const a = adapter({ authMode: 'local-login' });
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:basic' });
    const usage = (await drain(a, ref, 10_000)).map((e) => e.event).filter((e) => e.kind === 'usage');
    expect(usage.length).toBeGreaterThan(0);
    for (const u of usage) {
      expect(u).toMatchObject({ provenance: 'estimated-from-tokens', authMode: 'local-login' });
      expect(Object.keys(u)).not.toContain('costUsd');
    }
    const cost = await a.getCost(ref);
    expect(cost.provenance).toBe('estimated-from-tokens');
    expect(cost.costUsd).toBeUndefined();
    await a.cleanup(ref);
  });

  it('gate policy env carries the job approval policy and timeout', async () => {
    const a = adapter();
    const ws = workspace();
    const ref = await a.spawn(spawnContext('pi', ws, { timeouts: FAST, approvalPolicy: 'ask-all' }));
    // The policy is visible to the runtime only via env; prove the read-only tool is now gated.
    await a.sendPrompt(ref, { text: 'faux:basic' });
    const req = await waitFor(a, ref, (e) => e.event.kind === 'approval_request', 10_000);
    expect(req.event.kind === 'approval_request' && req.event.description).toContain('read');
    expect(PI_GATE_POLICY_ENV).toBe('REMYRAL_PI_GATE_POLICY');
    await a.cancel(ref);
    await a.cleanup(ref);
  });

  it('unknown sessions are reported, cleanup of unknown sessions is a no-op', async () => {
    const a = adapter();
    await expect(a.collectResult({ sessionId: 'nope', runtime: 'pi' })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
    await a.cleanup({ sessionId: 'nope', runtime: 'pi' });
  });
  // p15-message-delivery: steer receipts and refusals.
  const userTexts = (events: readonly { event: { kind: string; role?: string; text?: string } }[]) =>
    events.flatMap((e) =>
      e.event.kind === 'message' && e.event.role === 'user' ? [e.event.text ?? ''] : [],
    );

  it('p15: a steer while an approval is pending is recorded once accepted and read at the next output', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:approval' });
    const req = await waitFor(a, ref, (e) => e.event.kind === 'approval_request', 10_000);
    if (req.event.kind !== 'approval_request') throw new Error('unreachable');
    const receipts: { kind: string }[] = [];
    await a.sendPrompt(ref, { text: 'use staging', onReceipt: (r) => receipts.push(r) });
    expect(receipts).toEqual([]);
    await a.requestApproval(ref, { approvalId: req.event.approvalId, decision: 'approve', decidedBy: 't' });
    const events = await drain(a, ref, 10_000);
    expect(userTexts(events)).toContain('use staging');
    expect(receipts.map((r) => r.kind)).toEqual(['consumed']);
    await a.cleanup(ref);
  });

  it('p15: a refused steer throws, is not shown as sent, and the run goes on', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:long' });
    await waitFor(a, ref, (e) => e.event.kind === 'status' && e.event.phase === 'running');
    await expect(a.sendPrompt(ref, { text: 'faux:refuse please' })).rejects.toThrow();
    await a.cancel(ref);
    const events = await drain(a, ref, 10_000);
    expect(userTexts(events)).not.toContain('faux:refuse please');
    expect((await a.collectResult(ref)).outcome).toBe('cancelled');
    await a.cleanup(ref);
  });

  it('p15: after the run ended a follow-up is refused', async () => {
    const a = adapter();
    const ref = await a.spawn(spawnContext('pi', workspace(), { timeouts: FAST }));
    await a.sendPrompt(ref, { text: 'faux:basic' });
    await drain(a, ref, 10_000);
    await expect(a.sendPrompt(ref, { text: 'too late' })).rejects.toThrow();
    await a.cleanup(ref);
  });
});
