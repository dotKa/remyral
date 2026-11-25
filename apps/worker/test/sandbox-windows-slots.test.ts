// p9-windows-host-isolation: per-job Windows accounts — ACL construction, pool allocation/release, the cross-access
// self-test (fake Windows command runner), the controller's gating, the policy change and the host runner wiring.
// The real Windows behaviour is UNVERIFIED here (see the Windows-only block at the end).
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import type { OpsCommandPayload } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { SandboxSettings } from '../src/sandbox/config.js';
import { SandboxUnavailableError } from '../src/sandbox/errors.js';
import { createSandboxRunners } from '../src/sandbox/factory.js';
import type { WorkerIdentity } from '../src/sandbox/host/identity.js';
import { HostRestrictedRunner } from '../src/sandbox/host/runner.js';
import {
  WINDOWS_JOBRUN_PS1,
  WINDOWS_JOBRUN_SHA256,
  type RunFile,
} from '../src/sandbox/host/windows-jobrun.js';
import { WINDOWS_JOB_SLOTS_PS1 } from '../src/sandbox/host/windows-job-slots.generated.js';
import { WindowsSlotController } from '../src/sandbox/host/windows-slot-controller.js';
import {
  checkWorkerTokenPrivileges,
  encodedCommand,
  evaluateProbe,
  isMissingTokenPrivilegeError,
  parseWhoamiPrivileges,
  loadSlotState,
  probeScript,
  provisionCount,
  runSlotSelfTest,
  slotAttemptAclArgs,
  slotGrantArgs,
  slotRevokeArgs,
  SlotPool,
  slotsOf,
  SlotState,
  sweepCommandLine,
  sweepScript,
  type JobSlot,
  type SlotSelfTestRecord,
} from '../src/sandbox/host/windows-slots.js';
import { selectProfile, type WorkerSandboxCapabilities } from '../src/sandbox/policy.js';
import { SandboxPreparer } from '../src/sandbox/prepare.js';
import { buildSandboxStatus } from '../src/sandbox/status.js';
import { parseJobSlotsResult, jobSlotsArgs } from '../src/update/helper/prepare.js';
import { tempDir } from './helpers.js';

const WORKER = 'S-1-5-80-3873781773-1309777572-2309334471-3127388086-2944079060';
const GROUP = 'S-1-5-21-1-2-3-1100';
const sidOf = (i: number): string => `S-1-5-21-1-2-3-${String(1000 + i)}`;
const GEN = '0b5c8f8e-2d7a-4a50-9c7e-000000000001';

function stateDoc(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    generation: GEN,
    provisionedAt: '2026-10-17T10:00:00.000Z',
    group: { name: 'remyral-job-slots', sid: GROUP },
    workerSid: WORKER,
    slots: Array.from({ length: n }, (_, k) => ({
      index: k + 1,
      user: `remyral-job-${String(k + 1)}`,
      sid: sidOf(k + 1),
    })),
    ...over,
  };
}

const slots = (n: number, dir = 'C:\\cfg\\job-slots'): JobSlot[] =>
  slotsOf(SlotState.parse(stateDoc(n)), dir);

const identity: WorkerIdentity = {
  verified: true,
  username: 'RemyralWorker',
  uid: null,
  problems: [],
  expectedUser: 'NT SERVICE\\RemyralWorker',
  expectedUserSource: 'config',
  sid: WORKER,
};

const passed = (n: number): SlotSelfTestRecord => ({
  v: 1,
  generation: GEN,
  jobRunnerSha: WINDOWS_JOBRUN_SHA256,
  ok: true,
  at: '2026-10-17T10:01:00.000Z',
  detail: 'ok',
  slots: Array.from({ length: n }, (_, k) => ({
    user: `remyral-job-${String(k + 1)}`,
    ok: true,
    detail: 'ok',
  })),
});

function controller(
  n: number,
  over: Partial<ConstructorParameters<typeof WindowsSlotController>[0]> = {},
): WindowsSlotController {
  return new WindowsSlotController({
    stateDir: 'C:\\cfg\\job-slots',
    workspaceRoot: 'C:\\ws',
    dataDir: 'C:\\data',
    workerSid: WORKER,
    identityVerified: true,
    jobRunner: () => ({ script: 'C:\\data\\sandbox\\remyral-jobrun.ps1', source: 'data', verified: true }),
    readState: () => Promise.resolve(JSON.stringify(stateDoc(n))),
    readRecord: () => Promise.resolve(passed(n)),
    writeRecord: () => Promise.resolve(),
    // Hermetic: on a Windows host the default asks this process's token (whoami /priv) for the slot privileges.
    tokenPrivileges: () => Promise.resolve({ checked: true, missing: [] }),
    ...over,
  });
}

describe('ACL construction (icacls)', () => {
  it('attempt dirs: protected, SYSTEM/Admins/worker full, the slot modify, OWNER RIGHTS synchronize only', () => {
    expect(slotAttemptAclArgs('C:\\ws\\jobs\\j\\a', WORKER, sidOf(1))).toEqual([
      'C:\\ws\\jobs\\j\\a',
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
      `*${WORKER}:(OI)(CI)F`,
      `*${sidOf(1)}:(OI)(CI)M`,
      '*S-1-3-4:(OI)(CI)(S)',
      '/Q',
    ]);
    expect(() => slotAttemptAclArgs('C:\\x', WORKER, WORKER)).toThrow(RangeError);
    expect(() => slotAttemptAclArgs('C:\\x', 'Everyone', sidOf(1))).toThrow(/not a SID/);
    expect(() => slotAttemptAclArgs('C:\\x', WORKER, '*S-1-1-0')).toThrow(/not a SID/);
  });

  it('grants and revokes per attempt (directories inherit, single files do not)', () => {
    expect(slotGrantArgs('C:\\m\\objects', sidOf(2), 'RX')).toEqual([
      'C:\\m\\objects',
      '/grant',
      `*${sidOf(2)}:(OI)(CI)RX`,
      '/Q',
    ]);
    expect(slotGrantArgs('C:\\p\\.claude.json', GROUP, 'M', false)).toEqual([
      'C:\\p\\.claude.json',
      '/grant',
      `*${GROUP}:M`,
      '/Q',
    ]);
    expect(slotRevokeArgs('C:\\m\\objects', sidOf(2))).toEqual([
      'C:\\m\\objects',
      '/remove:g',
      `*${sidOf(2)}`,
      '/Q',
    ]);
  });

  it('sweep: the account removes its own scheduled tasks, then ends its own processes', () => {
    const slot = slots(1)[0] as JobSlot;
    const script = sweepScript(slot, { SystemRoot: 'C:\\Windows' });
    expect(/^[\t\n\x20-\x7e]*$/.test(script)).toBe(true);
    expect(script.indexOf('Unregister-ScheduledTask')).toBeLessThan(script.indexOf('taskkill.exe'));
    expect(script).toContain("$u = 'remyral-job-1'");
    expect(script).toContain("& 'C:\\Windows\\System32\\taskkill.exe' /F /FI ('USERNAME eq ' + $u)");
    const line = sweepCommandLine(slot, { SystemRoot: 'C:\\Windows' });
    expect(line).toContain('-EncodedCommand ');
    expect(Buffer.from(line.split(' ').at(-1) ?? '', 'base64').toString('utf16le')).toBe(script);
    expect(() => sweepScript({ ...slot, user: 'Administrator' })).toThrow(RangeError);
  });
});

describe('slots.json', () => {
  it('parses a valid pool and attaches the credential files', () => {
    const s = slots(2, '/cfg/job-slots');
    expect(s.map((x) => [x.user, x.credentialFile])).toEqual([
      ['remyral-job-1', join('/cfg/job-slots', 'remyral-job-1.cred')],
      ['remyral-job-2', join('/cfg/job-slots', 'remyral-job-2.cred')],
    ]);
  });

  it('refuses names that are not per-job accounts, duplicates and the worker SID as a slot', () => {
    const bad = [
      stateDoc(1, { slots: [{ index: 1, user: 'Administrator', sid: sidOf(1) }] }),
      stateDoc(1, { slots: [{ index: 1, user: 'remyral-job-2', sid: sidOf(1) }] }),
      stateDoc(2, {
        slots: [
          { index: 1, user: 'remyral-job-1', sid: sidOf(1) },
          { index: 2, user: 'remyral-job-2', sid: sidOf(1) },
        ],
      }),
      stateDoc(1, { slots: [{ index: 1, user: 'remyral-job-1', sid: WORKER }] }),
      stateDoc(1, { group: { name: 'Users', sid: GROUP } }),
    ];
    for (const doc of bad) expect(SlotState.safeParse(doc).success, JSON.stringify(doc)).toBe(false);
  });

  it('load: unprovisioned, invalid, prepared for another worker, ok', async () => {
    const missing = await loadSlotState('/nowhere', WORKER, () => Promise.reject(new Error('ENOENT')));
    expect(missing).toMatchObject({ ok: false, code: 'job_slots_unprovisioned' });
    const invalid = await loadSlotState('/x', WORKER, () => Promise.resolve('{"v":2}'));
    expect(invalid).toMatchObject({ ok: false, code: 'job_slots_invalid' });
    const other = await loadSlotState('/x', 'S-1-5-80-1-2-3-4-5', () =>
      Promise.resolve(`\uFEFF${JSON.stringify(stateDoc(2))}`),
    );
    expect(other).toMatchObject({ ok: false, code: 'job_slots_worker_mismatch' });
    const ok = await loadSlotState('/x', WORKER, () => Promise.resolve(JSON.stringify(stateDoc(3))));
    expect(ok.ok && ok.slots.length).toBe(3);
  });

  it('provision count: configured, else max(maxParallelJobs, 4), within 1..16; 0 = off', () => {
    expect(provisionCount(undefined, undefined)).toBe(4);
    expect(provisionCount(undefined, 6)).toBe(6);
    expect(provisionCount(undefined, 40)).toBe(16);
    expect(provisionCount(2, 8)).toBe(2);
    expect(provisionCount(0, 8)).toBe(0);
  });
});

describe('SlotPool', () => {
  it('one account per attempt, reference counted across spawns, freed after the last', () => {
    const pool = new SlotPool(slots(2));
    const a = pool.acquire('att-a');
    const b = pool.acquire('att-b');
    expect([a?.slot.user, a?.first, b?.slot.user, b?.first]).toEqual([
      'remyral-job-1',
      true,
      'remyral-job-2',
      true,
    ]);
    expect(pool.acquire('att-c')).toBeNull();
    expect(pool.acquire('att-a')).toMatchObject({ first: false, slot: { user: 'remyral-job-1' } });
    expect(pool.release('att-a')).toMatchObject({ last: false });
    expect(pool.acquire('att-c')).toBeNull();
    expect(pool.release('att-a')).toMatchObject({ last: true, slot: { user: 'remyral-job-1' } });
    expect(pool.release('att-a')).toBeNull();
    // still being cleaned: not free, and the finished attempt cannot take it back
    expect(pool.acquire('att-c')).toBeNull();
    expect(pool.acquire('att-a')).toBeNull();
    pool.finish('att-a');
    expect(pool.acquire('att-c')?.slot.user).toBe('remyral-job-1');
    expect(pool.inUse()).toBe(2);
  });

  it('quarantined accounts are never handed out; a reloaded pool keeps running attempts on theirs', () => {
    const pool = new SlotPool(slots(3));
    pool.quarantine(1, 'revoke failed');
    expect(pool.healthy()).toBe(2);
    expect(pool.acquire('a')?.slot.index).toBe(2);
    const next = new SlotPool(slots(3));
    next.adopt(pool);
    expect(next.holder('a')?.index).toBe(2);
    expect(next.acquire('b')?.slot.index).toBe(1);
    expect(next.acquire('c')?.slot.index).toBe(3);
    expect(next.acquire('d')).toBeNull();
  });
});

describe('cross-access probe', () => {
  it('is ASCII PowerShell with quoted paths, base64 UTF-16LE for -EncodedCommand', () => {
    const s = probeScript("C:\\ws\\it's", 'C:\\ws\\b', [
      { path: 'C:\\data', kind: 'dir' },
      { path: 'C:\\cfg\\x.cred', kind: 'file' },
    ]);
    expect(/^[\t\n\x20-\x7e]*$/.test(s)).toBe(true);
    expect(s).toContain("$own = 'C:\\ws\\it''s'");
    expect(s).toContain("[IO.Directory]::GetFileSystemEntries('C:\\data')");
    expect(s).toContain("[IO.File]::ReadAllBytes('C:\\cfg\\x.cred')");
    expect(Buffer.from(encodedCommand('ab'), 'base64')).toEqual(Buffer.from('a\0b\0', 'latin1'));
  });

  it('passes only with the slot SID, own access and every foreign access denied', () => {
    const good =
      'remyral-slot-probe sid=S-1-5-21-1-2-3-1001 own-write=ok own-read=ok other-read=denied other-list=denied other-write=denied secret-0=denied secret-1=denied\r\n';
    expect(evaluateProbe(good, sidOf(1), true, 2).ok).toBe(true);
    expect(
      evaluateProbe(good.replace('other-read=denied', 'other-read=ok'), sidOf(1), true, 2),
    ).toMatchObject({
      ok: false,
      detail: expect.stringContaining('other-read=ok (want denied)') as unknown,
    });
    // Running as the worker account (runAs ignored) is a failure, whatever the access results.
    expect(evaluateProbe(good.replace(sidOf(1), WORKER), sidOf(1), true, 2).ok).toBe(false);
    expect(evaluateProbe(good.replace('secret-1=denied', 'secret-1=error'), sidOf(1), true, 2).ok).toBe(
      false,
    );
    expect(evaluateProbe('', sidOf(1), true, 2).ok).toBe(false);
  });
});

/** Fake Windows: icacls succeeds; the job runner "runs" the probe as the spec's account. */
function fakeWindows(opts: { leak?: string } = {}) {
  const calls: {
    file: string;
    args: readonly string[];
    spec?: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
  }[] = [];
  const run: RunFile = async (file, args, _timeoutMs, env) => {
    const i = args.indexOf('-SpecFile');
    if (i < 0) {
      calls.push({ file, args });
      return { code: 0, stdout: '', stderr: '' };
    }
    const spec = JSON.parse(await readFile(args[i + 1] as string, 'utf8')) as {
      commandLine: string;
      runAs?: { user: string };
    };
    calls.push({ file, args, spec, ...(env === undefined ? {} : { env }) });
    const user = spec.runAs?.user ?? 'worker';
    const idx = Number(/remyral-job-(\d+)/.exec(user)?.[1] ?? 0);
    if (!spec.commandLine.includes('-EncodedCommand')) return { code: 0, stdout: '', stderr: '' };
    const script = Buffer.from(spec.commandLine.split(' ').at(-1) ?? '', 'base64').toString('utf16le');
    const other = script.includes('$other') ? ' other-read=denied other-list=denied other-write=denied' : '';
    const line = `remyral-slot-probe sid=${idx === 0 ? WORKER : sidOf(idx)} own-write=ok own-read=ok${other} secret-0=denied secret-1=denied secret-2=denied`;
    return {
      code: 0,
      stdout: `${opts.leak === user ? line.replace('other-read=denied', 'other-read=ok') : line}\r\n`,
      stderr: '',
    };
  };
  return { run, calls };
}

describe('cross-access self-test (fake Windows runner)', () => {
  it('ACLs every slot dir, runs the probe as each account against its neighbour, cleans up', async () => {
    const root = await tempDir('slots-');
    const ws = join(root, 'ws');
    const data = join(root, 'data');
    await mkdir(ws);
    await mkdir(data);
    const w = fakeWindows();
    const acl: string[][] = [];
    const state = SlotState.parse(stateDoc(3));
    const r = await runSlotSelfTest({
      state,
      slots: slotsOf(state, join(root, 'cfg', 'job-slots')),
      stateDir: join(root, 'cfg', 'job-slots'),
      workspaceRoot: ws,
      dataDir: data,
      jobRunner: 'C:\\jobrun.ps1',
      run: w.run,
      env: { SystemRoot: 'C:\\Windows' },
      acl: (a) => {
        acl.push([...a]);
        return Promise.resolve();
      },
    });
    expect(r).toMatchObject({ ok: true, generation: GEN, jobRunnerSha: WINDOWS_JOBRUN_SHA256 });
    expect(r.slots.map((s) => s.ok)).toEqual([true, true, true]);
    expect(acl.map((a) => a[6])).toEqual([
      `*${sidOf(1)}:(OI)(CI)M`,
      `*${sidOf(2)}:(OI)(CI)M`,
      `*${sidOf(3)}:(OI)(CI)M`,
    ]);
    expect(w.calls.map((c) => (c.spec?.runAs as { user: string } | undefined)?.user)).toEqual([
      'remyral-job-1',
      'remyral-job-2',
      'remyral-job-3',
    ]);
    // spec files are written to the worker-only data dir and removed; the test dirs are gone
    expect(
      w.calls.every((c) =>
        (c.args[c.args.indexOf('-SpecFile') + 1] ?? '').startsWith(join(data, 'sandbox', 'specs')),
      ),
    ).toBe(true);
    expect(await readdir(join(data, 'sandbox', 'specs'))).toEqual([]);
    expect(await readdir(join(ws, 'sandboxes'))).toEqual([]);
  });

  it('fails when one account can read its neighbour', async () => {
    const root = await tempDir('slots-');
    await mkdir(join(root, 'ws'));
    const state = SlotState.parse(stateDoc(2));
    const r = await runSlotSelfTest({
      state,
      slots: slotsOf(state, root),
      stateDir: root,
      workspaceRoot: join(root, 'ws'),
      dataDir: join(root, 'data'),
      jobRunner: 'C:\\jobrun.ps1',
      run: fakeWindows({ leak: 'remyral-job-2' }).run,
      acl: () => Promise.resolve(),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('remyral-job-2: other-read=ok (want denied)');
  });
});

describe('WindowsSlotController gating', () => {
  it('active only with a valid pool, a verified job runner and a current passing self-test', async () => {
    const c = controller(3);
    expect(c.status()).toMatchObject({ active: false, code: 'job_slots_unchecked' });
    await c.reload();
    expect(c.status()).toMatchObject({ active: true, accounts: 3, healthy: 3 });
    expect(c.concurrency(2)).toBe(2);
    expect(c.concurrency(8)).toBe(3);
    c.activePool()?.quarantine(1, 'x');
    c.activePool()?.quarantine(2, 'x');
    expect(c.concurrency(8)).toBe(1);
    c.activePool()?.quarantine(3, 'x');
    expect(c.status()).toMatchObject({ active: false, code: 'job_slots_quarantined' });
    expect(c.concurrency(8)).toBe(1);
  });

  it('falls back to one at a time with a reason: unprovisioned, unverified, failed, other generation, no job runner', async () => {
    const cases: [Partial<ConstructorParameters<typeof WindowsSlotController>[0]>, string][] = [
      [{ readState: () => Promise.reject(new Error('ENOENT')) }, 'job_slots_unprovisioned'],
      [{ readRecord: () => Promise.resolve(null) }, 'job_slots_unverified'],
      [
        { readRecord: () => Promise.resolve({ ...passed(2), ok: false, detail: 'leak' }) },
        'job_slots_selftest_failed',
      ],
      [{ readRecord: () => Promise.resolve({ ...passed(2), generation: 'old' }) }, 'job_slots_unverified'],
      [{ readRecord: () => Promise.resolve({ ...passed(2), jobRunnerSha: 'old' }) }, 'job_slots_unverified'],
      [{ jobRunner: () => ({ verified: false, code: 'job_runner_selftest_failed' }) }, 'job_runner_missing'],
      [{ identityVerified: false }, 'worker_identity_unsafe'],
      [{ workerSid: 'S-1-5-80-9-9-9-9-9' }, 'job_slots_worker_mismatch'],
    ];
    for (const [over, code] of cases) {
      const c = controller(2, over);
      await c.reload();
      expect(c.status(), code).toMatchObject({ active: false, code });
      expect(c.concurrency(4)).toBe(1);
      expect(c.activePool()).toBeNull();
    }
  });

  it('verify(): runs the self-test only when needed (force always) and stores the result', async () => {
    const runs: string[] = [];
    const stored: SlotSelfTestRecord[] = [];
    let record: SlotSelfTestRecord | null = null;
    const c = controller(2, {
      readRecord: () => Promise.resolve(record),
      writeRecord: (_d, r) => {
        stored.push(r);
        record = r;
        return Promise.resolve();
      },
      selfTest: (d) => {
        runs.push(d.state.generation);
        return Promise.resolve(passed(2));
      },
    });
    await c.verify();
    expect(c.status().active).toBe(true);
    await c.verify();
    expect(runs).toHaveLength(1);
    await c.verify(true);
    expect(runs).toHaveLength(2);
    expect(stored).toHaveLength(2);
  });
});

const hostCaps = (over: Partial<WorkerSandboxCapabilities> = {}): WorkerSandboxCapabilities => ({
  platform: 'win32',
  container: { ready: false },
  hostRestricted: { ready: true, filesystemConfinement: 'job_user', egressEnforced: false, concurrency: 3 },
  runtimeSandboxes: [],
  unconfined: { ready: true },
  runningAttempts: 0,
  hostAttempts: 0,
  ...over,
});

describe('selectProfile with per-job accounts (T-SBX-4)', () => {
  const host = {
    profile: 'host-restricted' as const,
    runtime: 'claude-code' as const,
    sourceTrust: 'trusted' as const,
    needsEgress: true,
    hostExecutionOptIn: true,
    unconfinedOptIn: true,
  };
  const policy = { allowedProfiles: ['host-restricted', 'unconfined'] as const };

  it('runs host attempts in parallel up to the verified account count', () => {
    expect(selectProfile(host, hostCaps({ runningAttempts: 2, hostAttempts: 2 }), policy)).toMatchObject({
      ok: true,
      notes: expect.arrayContaining(['host attempt runs as its own Windows account (3/3)']) as unknown,
    });
    const full = selectProfile(host, hostCaps({ runningAttempts: 3, hostAttempts: 3 }), policy);
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error.message).toMatch(/all 3 per-job account\(s\) are busy.*\(T-SBX-4\)/);
  });

  it('never next to an attempt that runs as the worker account (unconfined), and unconfined stays exclusive', () => {
    const r = selectProfile(host, hostCaps({ runningAttempts: 1, hostAttempts: 0 }), policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/worker account itself .*\(T-SBX-4\)/);
    const u = selectProfile(
      { ...host, profile: 'unconfined' },
      hostCaps({ runningAttempts: 1, hostAttempts: 1 }),
      policy,
    );
    expect(u.ok).toBe(false);
  });

  it('without per-job accounts: one at a time, as before (with a Prepare hint on Windows)', () => {
    const none = hostCaps({
      hostRestricted: { ready: true, filesystemConfinement: 'none', egressEnforced: false },
      runningAttempts: 1,
      hostAttempts: 1,
    });
    const r = selectProfile(host, none, policy);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/\(T-SBX-4\)/);
      expect(r.error.remedy).toMatch(/Prepare/);
    }
    // missing hostAttempts = all running attempts count as host attempts (they fill the accounts)
    const { hostAttempts: _unused, ...withoutHost } = hostCaps({ runningAttempts: 1 });
    expect(selectProfile(host, withoutHost, policy).ok).toBe(true);
    expect(selectProfile(host, { ...withoutHost, runningAttempts: 3 }, policy).ok).toBe(false);
  });
});

describe('host runner on Windows with per-job accounts (fake runner)', () => {
  async function setup(n: number, wrap: (run: RunFile) => RunFile = (r) => r) {
    const root = await realpath(await tempDir('slot-run-'));
    const ws = join(root, 'ws');
    const data = join(root, 'data');
    const mirror = join(ws, 'mirrors', 'p', 'objects');
    await mkdir(mirror, { recursive: true });
    await mkdir(data, { recursive: true });
    const w = fakeWindows();
    const c = controller(n, { workspaceRoot: ws, dataDir: data });
    await c.reload();
    const runner = new HostRestrictedRunner({
      identity,
      workspaceRoot: ws,
      workerDataDir: data,
      platform: 'win32',
      windowsJobRunner: () => ({ script: 'C:\\jr.ps1', source: 'data', verified: true }),
      runFile: wrap(w.run),
      windowsSlots: c,
    });
    const attempt = async (id: string) => {
      const workspace = join(ws, 'jobs', 'job1', id);
      const sandboxDir = join(ws, 'sandboxes', 'job1', id);
      await mkdir(workspace, { recursive: true });
      await mkdir(sandboxDir, { recursive: true });
      const confined = await runner
        .confiner({
          jobId: 'job1',
          attemptId: id,
          workspacePath: workspace,
          sandboxDir,
          network: { mode: 'none' },
          limits: {
            memoryBytes: 2 ** 30,
            cpus: 1,
            pids: 64,
            fileSizeBytes: 2 ** 30,
            openFiles: 1024,
            tmpBytes: 2 ** 30,
          },
          git: {
            sandboxDir,
            gitDir: join(sandboxDir, 'git'),
            mirrorObjects: mirror,
            containerDotGit: join(sandboxDir, 'dotgit'),
            branch: `rac/job1/${id}`,
            hostEnv: {},
          },
        })
        .confine({ command: 'C:\\node.exe', args: ['x.js'], cwd: workspace, env: {}, secretNames: [] });
      return { confined, workspace, sandboxDir };
    };
    return { runner, c, w, attempt, data, mirror };
  }

  it('confines each attempt to its own account: ACLs, mirror grant, runAs spec in the data dir, APPDATA per attempt', async () => {
    const { runner, w, attempt, data, mirror } = await setup(2);
    expect(runner.filesystemConfinement).toBe('job_user');
    const a = await attempt('a1');
    const b = await attempt('a2');
    const acls = w.calls.filter((x) => !x.args.includes('-SpecFile')).map((x) => x.args);
    expect(acls).toEqual([
      slotAttemptAclArgs(a.workspace, WORKER, sidOf(1)),
      expect.arrayContaining(['/inheritance:r', `*${sidOf(1)}:(OI)(CI)M`]),
      slotGrantArgs(mirror, sidOf(1), 'RX'),
      slotAttemptAclArgs(b.workspace, WORKER, sidOf(2)),
      expect.arrayContaining(['/inheritance:r', `*${sidOf(2)}:(OI)(CI)M`]),
      slotGrantArgs(mirror, sidOf(2), 'RX'),
    ]);
    const specA = a.confined.args[a.confined.args.indexOf('-SpecFile') + 1] ?? '';
    expect(specA.startsWith(join(data, 'sandbox', 'specs'))).toBe(true);
    expect(JSON.parse(await readFile(specA, 'utf8'))).toMatchObject({
      runAs: { user: 'remyral-job-1', credentialFile: join('C:\\cfg\\job-slots', 'remyral-job-1.cred') },
    });
    expect(a.confined.env.APPDATA).toBe(join(a.sandboxDir, 'home', 'AppData', 'Roaming'));
    // a third concurrent attempt has no account left
    await expect(attempt('a3')).rejects.toBeInstanceOf(SandboxUnavailableError);
    // release: sweep as the account, revoke its grants, the account is free again
    await a.confined.dispose?.();
    const after = w.calls.slice(-3);
    expect((after[0]?.spec?.runAs as { user: string }).user).toBe('remyral-job-1');
    const sweepLine = (after[0]?.spec as { commandLine?: string } | undefined)?.commandLine ?? '';
    const sweep = Buffer.from(sweepLine.split(' ').at(-1) ?? '', 'base64').toString('utf16le');
    expect(sweep).toContain("$u = 'remyral-job-1'");
    expect(after.slice(1).map((x) => x.args)).toEqual([
      slotRevokeArgs(mirror, sidOf(1)),
      slotRevokeArgs(a.workspace, sidOf(1)),
    ]);
    const c = await attempt('a3');
    expect(
      JSON.parse(await readFile(c.confined.args[c.confined.args.indexOf('-SpecFile') + 1] ?? '', 'utf8')),
    ).toMatchObject({
      runAs: { user: 'remyral-job-1' },
    });
    await b.confined.dispose?.();
    await c.confined.dispose?.();
  });

  it('p19-ide W2b: an IDE server holds its own account; its mirror is granted read-only and revoked at stop', async () => {
    const { runner, w, mirror } = await setup(1);
    const ws = join(mirror, '..', '..', '..');
    const id = '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e002';
    const folder = join(ws, 'jobs', `ide-${id}`, 'checkout');
    const run = join(ws, 'sandboxes', `ide-${id}`, 'run');
    await mkdir(folder, { recursive: true });
    await mkdir(run, { recursive: true });
    const mirrorDir = join(mirror, '..');
    const confined = await runner
      .confiner({
        jobId: `ide-${id}`,
        attemptId: `ide-${id}`,
        workspacePath: folder,
        sandboxDir: run,
        network: { mode: 'none' },
        limits: {
          memoryBytes: 4 * 2 ** 30,
          cpus: 2,
          pids: 1024,
          fileSizeBytes: 2 ** 30,
          openFiles: 8192,
          tmpBytes: 2 ** 30,
        },
        listen: true,
        jobAccount: true,
        loopbackPorts: [4100],
        unixSocketDirs: [run],
        readOnlyDirs: [mirrorDir],
      })
      .confine({ command: 'C:\\cs\\lib\\node.exe', args: ['C:\\cs'], cwd: folder, env: {}, secretNames: [] });
    const acls = w.calls.filter((x) => !x.args.includes('-SpecFile')).map((x) => x.args);
    expect(acls).toContainEqual(slotGrantArgs(mirrorDir, sidOf(1), 'RX'));
    const spec = confined.args[confined.args.indexOf('-SpecFile') + 1] ?? '';
    expect(JSON.parse(await readFile(spec, 'utf8'))).toMatchObject({ runAs: { user: 'remyral-job-1' } });
    await confined.dispose?.();
    expect(w.calls.slice(-2).map((x) => x.args)).toEqual([
      slotRevokeArgs(mirrorDir, sidOf(1)),
      slotRevokeArgs(folder, sidOf(1)),
    ]);
  });

  it('a failed cleanup quarantines the account (no attempt gets it until the next Prepare)', async () => {
    const { c, attempt } = await setup(
      2,
      (run) => (file, args, t) =>
        args.includes('/remove:g')
          ? Promise.resolve({ code: 5, stdout: '', stderr: 'Access is denied.' })
          : run(file, args, t),
    );
    const a = await attempt('q1');
    await a.confined.dispose?.();
    expect(c.activePool()?.quarantined()).toEqual([
      { index: 1, reason: expect.stringContaining('revoke ') as unknown },
    ]);
    expect(c.concurrency(4)).toBe(1);
    const b = await attempt('q2');
    expect(
      JSON.parse(await readFile(b.confined.args[b.confined.args.indexOf('-SpecFile') + 1] ?? '', 'utf8')),
    ).toMatchObject({ runAs: { user: 'remyral-job-2' } });
    await c.reload();
    expect(c.activePool()?.quarantined()).toEqual([]);
  });

  it('without an active pool the runner keeps the old behaviour (worker account, tree kill)', async () => {
    const root = await tempDir('slot-off-');
    const c = controller(2, { readState: () => Promise.reject(new Error('ENOENT')) });
    await c.reload();
    const runner = new HostRestrictedRunner({
      identity,
      workspaceRoot: root,
      workerDataDir: join(root, 'data'),
      platform: 'win32',
      windowsJobRunner: () => ({ script: 'C:\\jr.ps1', source: 'data', verified: true }),
      runFile: fakeWindows().run,
      windowsSlots: c,
    });
    expect(runner.filesystemConfinement).toBe('none');
    const workspace = join(root, 'jobs', 'j', 'a');
    await mkdir(workspace, { recursive: true });
    const confined = await runner
      .confiner({
        jobId: 'j',
        attemptId: 'a',
        workspacePath: workspace,
        sandboxDir: join(root, 'sandboxes', 'j', 'a'),
        network: { mode: 'none' },
        limits: {
          memoryBytes: 2 ** 30,
          cpus: 1,
          pids: 64,
          fileSizeBytes: 2 ** 30,
          openFiles: 1024,
          tmpBytes: 2 ** 30,
        },
      })
      .confine({ command: 'C:\\node.exe', args: [], cwd: workspace, env: {}, secretNames: [] });
    const spec = JSON.parse(
      await readFile(confined.args[confined.args.indexOf('-SpecFile') + 1] ?? '', 'utf8'),
    ) as Record<string, unknown>;
    expect(spec.runAs).toBeUndefined();
    await confined.dispose?.();
  });
});

describe('status, factory and helper wiring', () => {
  it('reports the job_slots check and host-restricted concurrency', async () => {
    const root = await tempDir('slot-status-');
    const runners = await createSandboxRunners({
      settings: SandboxSettings.parse({}),
      workspaceRoot: root,
      dataDir: join(root, 'data'),
      platform: 'win32',
      identity,
      jobRunner: { verified: true, script: 'C:\\jr.ps1', source: 'data' },
      maxParallelJobs: () => 2,
      slotStateDir: 'C:\\cfg\\job-slots',
      slotDeps: {
        readState: () => Promise.resolve(JSON.stringify(stateDoc(4))),
        readRecord: () => Promise.resolve(passed(4)),
        writeRecord: () => Promise.resolve(),
        // Hermetic on a Windows host: no token query, no icacls on this machine's login stores / account folders.
        tokenPrivileges: () => Promise.resolve({ checked: true, missing: [] }),
        loginStores: [],
        accountFolders: () => Promise.resolve([]),
      },
    });
    expect(runners.hostRestrictedConcurrency()).toBe(2);
    const caps = await runners.capabilities({ runtime: 'claude-code', runningAttempts: 1, hostAttempts: 1 });
    expect(caps.hostRestricted).toMatchObject({ filesystemConfinement: 'job_user', concurrency: 2 });
    const st = await buildSandboxStatus({
      runners,
      runnersError: null,
      enabledRuntimes: ['claude-code'],
      unconfined: 'not_enabled',
      workspaceRoot: root,
      privilegedHelper: { available: true },
      freeBytes: 50 * 1024 ** 3,
      platform: 'win32',
    });
    expect(st.checks.find((x) => x.id === 'job_slots')).toMatchObject({ status: 'ok' });
    expect(st.profiles.find((p) => p.profile === 'host-restricted')).toMatchObject({
      ready: true,
      concurrency: 2,
      checks: expect.arrayContaining(['job_slots']) as unknown,
    });
  });

  it('an unprovisioned pool: one at a time, warning with a privileged-Prepare fix', async () => {
    const root = await tempDir('slot-status-');
    const runners = await createSandboxRunners({
      settings: SandboxSettings.parse({}),
      workspaceRoot: root,
      dataDir: join(root, 'data'),
      platform: 'win32',
      identity,
      jobRunner: { verified: true, script: 'C:\\jr.ps1', source: 'data' },
      maxParallelJobs: () => 4,
      slotStateDir: join(root, 'no-such-dir'),
    });
    expect(runners.hostRestrictedConcurrency()).toBe(1);
    const st = await buildSandboxStatus({
      runners,
      runnersError: null,
      enabledRuntimes: [],
      unconfined: 'not_enabled',
      workspaceRoot: root,
      privilegedHelper: { available: true },
      freeBytes: 50 * 1024 ** 3,
      platform: 'win32',
    });
    expect(st.checks.find((x) => x.id === 'job_slots')).toMatchObject({
      status: 'warning',
      code: 'job_slots_unprovisioned',
      fix: 'prepare_privileged',
    });
    expect(st.profiles.find((p) => p.profile === 'host-restricted')).toMatchObject({
      concurrency: 1,
      concurrencyNote: expect.stringContaining('one attempt at a time') as unknown,
    });
  });

  it('`windowsJobSlots: 0` turns per-job accounts off; other platforms report not_applicable', async () => {
    const root = await tempDir('slot-off-');
    const off = await createSandboxRunners({
      settings: SandboxSettings.parse({ windowsJobSlots: 0 }),
      workspaceRoot: root,
      dataDir: join(root, 'data'),
      platform: 'win32',
      identity,
      jobRunner: { verified: true, script: 'C:\\jr.ps1', source: 'data' },
      slotStateDir: 'C:\\cfg\\job-slots',
    });
    expect(off.windowsSlots).toBeUndefined();
    expect(off.hostRestrictedConcurrency()).toBe(1);
    const linux = await createSandboxRunners({
      settings: SandboxSettings.parse({}),
      workspaceRoot: root,
      dataDir: join(root, 'data'),
      platform: 'linux',
      identity: { ...identity, sid: null },
      namespaces: { usable: true, detail: 'ok' },
      maxParallelJobs: () => 4,
    });
    // Linux host profiles have no per-attempt filesystem confinement: one at a time (documented gap).
    expect(linux.hostRestrictedConcurrency()).toBe(1);
  });

  it('worker Prepare re-runs the cross-access self-test after the helper and reports it as a step', async () => {
    const root = await tempDir('slot-prep-');
    const runs: string[] = [];
    const runners = await createSandboxRunners({
      settings: SandboxSettings.parse({}),
      workspaceRoot: root,
      dataDir: join(root, 'data'),
      platform: 'win32',
      identity,
      jobRunner: { verified: true, script: 'C:\\jr.ps1', source: 'data' },
      runFile: () => Promise.resolve({ code: 0, stdout: 'remyral-jobrun ok 2\r\n', stderr: '' }),
      maxParallelJobs: () => 3,
      slotStateDir: 'C:\\cfg\\job-slots',
      slotDeps: {
        readState: () => Promise.resolve(JSON.stringify(stateDoc(3))),
        readRecord: () => Promise.resolve(passed(3)),
        writeRecord: () => Promise.resolve(),
        selfTest: () => {
          runs.push('x');
          return Promise.resolve(passed(3));
        },
      },
    });
    const updates: { state: string; prepare?: { steps: { id: string; state: string }[] } }[] = [];
    const prep = new SandboxPreparer({
      platform: 'win32',
      dataDir: join(root, 'data'),
      installDir: undefined,
      runners: () => runners,
      status: () =>
        buildSandboxStatus({
          runners,
          runnersError: null,
          enabledRuntimes: [],
          unconfined: 'not_enabled',
          workspaceRoot: root,
          privilegedHelper: { available: false },
          freeBytes: 50 * 1024 ** 3,
          platform: 'win32',
        }),
      changed: () => undefined,
      restart: () => undefined,
      logger: createLogger({ sink: () => undefined }),
    });
    await prep.run(
      'w',
      {
        commandId: '00000000-0000-4000-8000-000000000001',
        op: { kind: 'sandbox.prepare', privileged: false, localLogin: false },
      } as unknown as OpsCommandPayload,
      (u) => updates.push(u as (typeof updates)[number]),
    );
    const steps = updates.at(-1)?.prepare?.steps ?? [];
    expect(steps.map((x) => x.id)).toEqual([
      'worker_user',
      'job_runner',
      'disk_space',
      'job_slots',
      'recheck',
    ]);
    expect(steps.find((x) => x.id === 'job_slots')?.state).toBe('done');
    expect(runs).toHaveLength(1);
  });

  it('helper: fixed provisioning arguments and the result line', () => {
    const args = jobSlotsArgs({
      script: 'C:\\Program Files\\Remyral\\remyral-job-slots.ps1',
      count: 4,
      stateDir: 'C:\\ProgramData\\RemyralWorker\\job-slots',
      workerSid: WORKER,
      readDirs: ['C:\\d\\runtimes', 'C:\\d\\tools'],
    });
    expect(args.slice(-8)).toEqual([
      '-Count',
      '4',
      '-StateDir',
      'C:\\ProgramData\\RemyralWorker\\job-slots',
      '-WorkerSid',
      WORKER,
      '-ReadDirs',
      'C:\\d\\runtimes|C:\\d\\tools',
    ]);
    expect(() =>
      jobSlotsArgs({ script: 's', count: 17, stateDir: 's', workerSid: WORKER, readDirs: [] }),
    ).toThrow();
    expect(() =>
      jobSlotsArgs({ script: 's', count: 1, stateDir: 's', workerSid: 'x', readDirs: [] }),
    ).toThrow();
    expect(() =>
      jobSlotsArgs({ script: 's', count: 1, stateDir: 's', workerSid: WORKER, readDirs: ['a|b'] }),
    ).toThrow();
    expect(
      parseJobSlotsResult('noise\r\nremyral-job-slots {"ok":true,"count":4,"privilegesAdded":false}\r\n'),
    ).toEqual({ ok: true, count: 4, privilegesAdded: false });
    expect(
      parseJobSlotsResult('remyral-job-slots {"ok":false,"code":"not_admin","detail":"x"}'),
    ).toMatchObject({
      ok: false,
      code: 'not_admin',
    });
    expect(parseJobSlotsResult('garbage')).toBeNull();
  });

  it('the embedded scripts: runAs only for per-job accounts, password via DPAPI LocalMachine, batch logon', () => {
    expect(WINDOWS_JOBRUN_PS1).toContain("-cnotmatch '^remyral-job-[1-9][0-9]?$'");
    expect(WINDOWS_JOBRUN_PS1).toContain('DataProtectionScope]::LocalMachine');
    expect(WINDOWS_JOBRUN_PS1).toContain('LOGON32_LOGON_BATCH');
    expect(WINDOWS_JOBRUN_PS1).toContain('CreateProcessAsUserW');
    expect(WINDOWS_JOB_SLOTS_PS1).toContain(
      "'SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight'",
    );
    expect(WINDOWS_JOB_SLOTS_PS1).toContain("'SeDenyNetworkLogonRight', 'SeDenyServiceLogonRight'");
    expect(WINDOWS_JOB_SLOTS_PS1).toContain('"*${WorkerSid}:(OI)(CI)RX"');
  });
});

// Windows-only: the real accounts, ACLs and job runner. Needs an elevated Prepare on the machine first; run with
// REMYRAL_WINDOWS_SLOT_IT=1 on a prepared worker host (as the worker service account). UNVERIFIED until then.
describe.skipIf(process.platform !== 'win32' || process.env.REMYRAL_WINDOWS_SLOT_IT !== '1')(
  'Windows integration: real per-job accounts',
  () => {
    it('slot A cannot read or write slot B (real icacls, LogonUser, CreateProcessAsUser)', async () => {
      const stateDir = process.env.REMYRAL_SLOT_STATE_DIR ?? 'C:\\ProgramData\\RemyralWorker\\job-slots';
      const dataDir = process.env.REMYRAL_DATA_DIR ?? 'C:\\ProgramData\\RemyralWorker\\data';
      const ws = await tempDir('slot-it-');
      const whoami = process.env.REMYRAL_WORKER_SID ?? '';
      const load = await loadSlotState(stateDir, whoami);
      expect(load.ok).toBe(true);
      if (!load.ok) return;
      const script = join(dataDir, 'sandbox', 'remyral-jobrun.ps1');
      await writeFile(script, WINDOWS_JOBRUN_PS1);
      const r = await runSlotSelfTest({
        state: load.state,
        slots: load.slots,
        stateDir,
        workspaceRoot: ws,
        dataDir,
        jobRunner: script,
      });
      expect(r.ok, r.detail).toBe(true);
    }, 600_000);
  },
);

describe('remyral-job-slots.ps1 literals', () => {
  it('keeps every -Description within the 48-character limit of New-LocalUser / New-LocalGroup', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const script = readFileSync(
      fileURLToPath(new URL('../../../infra/worker/windows/remyral-job-slots.ps1', import.meta.url)),
      'utf8',
    );
    const descriptions = [...script.matchAll(/-Description '([^']*)'/g)].map((m) => m[1] ?? '');
    expect(descriptions.length).toBeGreaterThan(0);
    for (const d of descriptions) expect(d.length).toBeLessThanOrEqual(48);
  });
});

// Live finding 2026-10-17 (1.0.29): privileges granted to NT SERVICE\RemyralWorker reach the worker only with a new
// service logon; a node restart under the same shawl process kept the old token and the self-test failed for every
// slot ("does not hold SeAssignPrimaryTokenPrivilege"); the failed result then blocked a re-run after the fix.
describe('worker token privileges and self-test freshness (p9-windows-slots-service-restart)', () => {
  const WHOAMI_OK =
    '"SeAssignPrimaryTokenPrivilege","Bir işlem düzeyi belirtecini değiştir","Devre dışı"\r\n' +
    '"SeIncreaseQuotaPrivilege","İşlem için bellek kotalarını ayarla","Devre dışı"\r\n' +
    '"SeChangeNotifyPrivilege","Çapraz geçiş denetimini atla","Etkin"\r\n';
  const WHOAMI_OLD = '"SeChangeNotifyPrivilege","Bypass traverse checking","Enabled"\r\n';
  const missingRecord: SlotSelfTestRecord = {
    ...passed(2),
    ok: false,
    detail:
      'remyral-job-1: exit 1: remyral-jobrun: start failed: the worker account does not hold SeAssignPrimaryTokenPrivilege (run Sandbox > Prepare ...)',
  };

  it('parses whoami /priv (names are not localised) and reports what the token lacks', async () => {
    expect([...parseWhoamiPrivileges(WHOAMI_OK)]).toEqual([
      'SeAssignPrimaryTokenPrivilege',
      'SeIncreaseQuotaPrivilege',
      'SeChangeNotifyPrivilege',
    ]);
    const calls: string[][] = [];
    const run: RunFile = (file, args) => {
      calls.push([file, ...args]);
      return Promise.resolve({ code: 0, stdout: WHOAMI_OLD, stderr: '' });
    };
    expect(await checkWorkerTokenPrivileges(run, { SystemRoot: 'C:\\Windows' })).toEqual({
      checked: true,
      missing: ['SeAssignPrimaryTokenPrivilege', 'SeIncreaseQuotaPrivilege'],
    });
    expect(calls).toEqual([['C:\\Windows\\System32\\whoami.exe', '/priv', '/fo', 'csv', '/nh']]);
    expect(
      await checkWorkerTokenPrivileges(() => Promise.resolve({ code: 0, stdout: WHOAMI_OK, stderr: '' }), {}),
    ).toEqual({ checked: true, missing: [] });
    // whoami unusable: unknown, never "missing"
    expect(
      await checkWorkerTokenPrivileges(() => Promise.resolve({ code: 1, stdout: '', stderr: 'x' }), {}),
    ).toMatchObject({ checked: false });
    expect(isMissingTokenPrivilegeError(missingRecord.detail)).toBe(true);
    expect(isMissingTokenPrivilegeError('remyral-job-1: leaked read')).toBe(false);
  });

  it('privileges granted but not in the token: no self-test, no stored failure, "restart the RemyralWorker service"', async () => {
    const runs: string[] = [];
    const stored: SlotSelfTestRecord[] = [];
    const c = controller(2, {
      readRecord: () => Promise.resolve(null),
      writeRecord: (_d, r) => {
        stored.push(r);
        return Promise.resolve();
      },
      tokenPrivileges: () =>
        Promise.resolve({
          checked: true,
          missing: ['SeAssignPrimaryTokenPrivilege', 'SeIncreaseQuotaPrivilege'],
        }),
      selfTest: () => {
        runs.push('x');
        return Promise.resolve(passed(2));
      },
    });
    expect(await c.verify(true)).toBeNull();
    expect(runs).toEqual([]);
    expect(stored).toEqual([]);
    const st = c.status();
    expect(st).toMatchObject({ active: false, code: 'job_slots_service_restart' });
    expect(st.detail).toMatch(
      /^restart the RemyralWorker service: SeAssignPrimaryTokenPrivilege and SeIncreaseQuotaPrivilege/,
    );
    expect(st.detail.length).toBeLessThanOrEqual(300);
    expect(c.concurrency(4)).toBe(1);
  });

  it('a stored missing-privilege failure reads as "restart the service" until the token has been checked', async () => {
    const c = controller(2, { readRecord: () => Promise.resolve(missingRecord) });
    await c.reload();
    expect(c.status()).toMatchObject({ code: 'job_slots_service_restart' });
    // An ordinary failure stays a failure.
    const d = controller(2, {
      readRecord: () => Promise.resolve({ ...missingRecord, detail: 'remyral-job-1: leaked read' }),
    });
    await d.reload();
    expect(d.status()).toMatchObject({ code: 'job_slots_selftest_failed' });
  });

  it('after a service restart a stored failed result does not block: the self-test re-runs at worker start', async () => {
    const root = await tempDir('slot-fresh-');
    let record: SlotSelfTestRecord | null = missingRecord;
    const runs: string[] = [];
    let changed = 0;
    const runners = await createSandboxRunners({
      settings: SandboxSettings.parse({}),
      workspaceRoot: root,
      dataDir: join(root, 'data'),
      platform: 'win32',
      identity,
      jobRunner: { verified: true, script: 'C:\\jr.ps1', source: 'data' },
      maxParallelJobs: () => 2,
      slotStateDir: 'C:\\cfg\\job-slots',
      onChanged: () => {
        changed++;
      },
      slotDeps: {
        readState: () => Promise.resolve(JSON.stringify(stateDoc(2))),
        readRecord: () => Promise.resolve(record),
        writeRecord: (_d, r) => {
          record = r;
          return Promise.resolve();
        },
        // the new service logon: the token now holds both privileges
        tokenPrivileges: () => Promise.resolve({ checked: true, missing: [] }),
        selfTest: () => {
          runs.push('x');
          return Promise.resolve(passed(2));
        },
      },
    });
    // No explicit verify(): the factory starts it in the background because the stored result is not ok.
    for (let i = 0; i < 100 && changed === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(runs).toHaveLength(1);
    expect(record).toMatchObject({ ok: true });
    expect(runners.windowsSlots?.status()).toMatchObject({ active: true });
    expect(runners.hostRestrictedConcurrency()).toBe(2);
    expect(changed).toBeGreaterThanOrEqual(1);
  });
});

describe('cross-access self-test environment', () => {
  it('gives each probe a TEMP inside its own slot folder (PowerShell 5.1 falls back to ConstrainedLanguage otherwise)', async () => {
    const root = await tempDir('slots-env-');
    const ws = join(root, 'ws');
    const data = join(root, 'data');
    await mkdir(ws);
    await mkdir(data);
    const w = fakeWindows();
    const state = SlotState.parse(stateDoc(2));
    const r = await runSlotSelfTest({
      state,
      slots: slotsOf(state, join(root, 'cfg', 'job-slots')),
      stateDir: join(root, 'cfg', 'job-slots'),
      workspaceRoot: ws,
      dataDir: data,
      jobRunner: 'C:\\jobrun.ps1',
      run: w.run,
      acl: () => Promise.resolve(),
      env: { PATH: 'x', TEMP: 'C:\\worker-temp' },
    });
    expect(r.ok).toBe(true);
    const probes = w.calls.filter((c) => c.spec !== undefined);
    expect(probes).toHaveLength(2);
    for (const c of probes) {
      const cwd = String(c.spec?.cwd);
      expect(c.env?.TEMP).toBe(join(cwd, 'tmp'));
      expect(c.env?.TMP).toBe(join(cwd, 'tmp'));
      expect(c.env?.PATH).toBe('x');
    }
  });
});
