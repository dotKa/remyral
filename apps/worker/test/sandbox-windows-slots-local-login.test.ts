// p9-windows-slots-local-login (design p9-windows-host-isolation §9.3): a subscription login (local-login) is never
// shared with the per-job Windows accounts — local-login attempts run as the worker account and alone, API-key
// attempts keep running in parallel on the slots, the slots lose any old grant on the login store, and the status
// says so. Fake Windows command runner; the real icacls behaviour is UNVERIFIED here.
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxSettings } from '../src/sandbox/config.js';
import { createSandboxRunners } from '../src/sandbox/factory.js';
import type { WorkerIdentity } from '../src/sandbox/host/identity.js';
import { HostRestrictedRunner } from '../src/sandbox/host/runner.js';
import { WINDOWS_JOBRUN_SHA256, type RunFile } from '../src/sandbox/host/windows-jobrun.js';
import {
  loginStorePaths,
  loginStoreShared,
  loginStoreUnshareArgs,
  unshareLoginStores,
} from '../src/sandbox/host/windows-login-store.js';
import { WindowsSlotController } from '../src/sandbox/host/windows-slot-controller.js';
import type { SlotSelfTestRecord } from '../src/sandbox/host/windows-slots.js';
import { selectProfile, type WorkerSandboxCapabilities } from '../src/sandbox/policy.js';
import { profileSlots } from '../src/sandbox/profile-slots.js';
import { buildSandboxStatus } from '../src/sandbox/status.js';
import type { SandboxContext } from '../src/sandbox/types.js';
import { tempDir } from './helpers.js';

const WORKER = 'S-1-5-80-3873781773-1309777572-2309334471-3127388086-2944079060';
const GROUP = 'S-1-5-21-1-2-3-1100';
const sidOf = (i: number): string => `S-1-5-21-1-2-3-${String(1000 + i)}`;
const GEN = '0b5c8f8e-2d7a-4a50-9c7e-000000000001';

const stateDoc = (n: number) => ({
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
});

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

const identity: WorkerIdentity = {
  verified: true,
  username: 'RemyralWorker',
  uid: null,
  problems: [],
  expectedUser: 'NT SERVICE\\RemyralWorker',
  expectedUserSource: 'config',
  sid: WORKER,
};

const PROFILE = 'C:\\Windows\\ServiceProfiles\\RemyralWorker';
const SHARED_LISTING = `${PROFILE}\\.claude NT SERVICE\\RemyralWorker:(OI)(CI)(F)
                                              windows-worker-1\\remyral-job-slots:(OI)(CI)(M)
                                              NT AUTHORITY\\SYSTEM:(OI)(CI)(F)

Successfully processed 1 files; Failed processing 0 files`;
const CLEAN_LISTING = `${PROFILE}\\.claude NT SERVICE\\RemyralWorker:(OI)(CI)(F)
                                              NT AUTHORITY\\SYSTEM:(OI)(CI)(F)

Successfully processed 1 files; Failed processing 0 files`;

/** A fake icacls: listings come from `acl` (mutated by /remove:g), every call is recorded. */
function fakeIcacls(acl: Map<string, string>, opts: { removeFails?: boolean } = {}) {
  const calls: (readonly string[])[] = [];
  const run: RunFile = (file, args) => {
    calls.push(args);
    if (file !== 'icacls.exe') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    const path = args[0] ?? '';
    if (args.length === 1)
      return Promise.resolve({ code: 0, stdout: acl.get(path) ?? CLEAN_LISTING, stderr: '' });
    if (args[1] === '/remove:g') {
      if (opts.removeFails === true)
        return Promise.resolve({ code: 5, stdout: '', stderr: 'Access is denied.' });
      acl.set(path, CLEAN_LISTING);
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  return { run, calls };
}

describe('login store is never shared with the per-job accounts', () => {
  it('paths: the runtimes’ usual stores under USERPROFILE plus hostExtraWritable, regardless of keepHome', () => {
    expect(loginStorePaths([], { USERPROFILE: PROFILE })).toEqual([
      join(PROFILE, '.claude'),
      join(PROFILE, '.claude.json'),
      join(PROFILE, '.codex'),
    ]);
    expect(loginStorePaths(['C:\\x\\.claude'], {})).toEqual(['C:\\x\\.claude']);
  });

  it('recognises a grant to the slot group or a slot account (by name or raw SID)', () => {
    expect(loginStoreShared(SHARED_LISTING, GROUP)).toBe(true);
    expect(loginStoreShared(CLEAN_LISTING, GROUP)).toBe(false);
    expect(loginStoreShared(`${PROFILE}\\.claude.json ${GROUP}:(M)`, GROUP)).toBe(true);
    expect(loginStoreShared(`${PROFILE}\\.claude.json PC\\remyral-job-2:(M)`, GROUP)).toBe(true);
    // a path that merely contains the name is not an entry
    expect(loginStoreShared(`C:\\remyral-job-slots\\x NT SERVICE\\RemyralWorker:(F)`, GROUP)).toBe(false);
  });

  it('unshare arguments: ownership back to the worker, group entries removed (recursive for directories)', () => {
    expect(loginStoreUnshareArgs('C:\\p\\.claude', WORKER, GROUP, true)).toEqual([
      ['C:\\p\\.claude', '/setowner', `*${WORKER}`, '/T', '/C', '/Q'],
      ['C:\\p\\.claude', '/remove:g', `*${GROUP}`, '/T', '/C', '/Q'],
    ]);
    expect(loginStoreUnshareArgs('C:\\p\\.claude.json', WORKER, GROUP, false)[1]).toEqual([
      'C:\\p\\.claude.json',
      '/remove:g',
      `*${GROUP}`,
      '/C',
      '/Q',
    ]);
    expect(() => loginStoreUnshareArgs('C:\\p', 'Everyone', GROUP, true)).toThrow();
  });

  it('takes a shared store back and proves it; missing stores are skipped', async () => {
    const claude = `${PROFILE}\\.claude`;
    const acl = new Map([[claude, SHARED_LISTING]]);
    const w = fakeIcacls(acl);
    const r = await unshareLoginStores({
      paths: [claude, `${PROFILE}\\.claude.json`, `${PROFILE}\\.codex`],
      workerSid: WORKER,
      groupSid: GROUP,
      run: w.run,
      kind: (p) => Promise.resolve(p.endsWith('.codex') ? null : p.endsWith('.json') ? 'file' : 'dir'),
    });
    expect(r).toEqual({ ok: true, checked: [claude, `${PROFILE}\\.claude.json`], unshared: [claude] });
    expect(w.calls).toEqual([
      [claude],
      ['C:\\Windows\\ServiceProfiles\\RemyralWorker\\.claude', '/setowner', `*${WORKER}`, '/T', '/C', '/Q'],
      [claude, '/remove:g', `*${GROUP}`, '/T', '/C', '/Q'],
      [claude],
      [`${PROFILE}\\.claude.json`],
    ]);
  });

  it('fails closed when the grant cannot be removed', async () => {
    const claude = `${PROFILE}\\.claude`;
    const w = fakeIcacls(new Map([[claude, SHARED_LISTING]]), { removeFails: true });
    const r = await unshareLoginStores({
      paths: [claude],
      workerSid: WORKER,
      groupSid: GROUP,
      run: w.run,
      kind: () => Promise.resolve('dir'),
    });
    expect(r).toMatchObject({ ok: false, code: 'job_slots_login_shared' });
    if (!r.ok) expect(r.detail).toMatch(/icacls <path> \/remove:g remyral-job-slots/);
  });
});

function controller(
  over: Partial<ConstructorParameters<typeof WindowsSlotController>[0]> = {},
): WindowsSlotController {
  return new WindowsSlotController({
    stateDir: 'C:\\cfg\\job-slots',
    workspaceRoot: 'C:\\ws',
    dataDir: 'C:\\data',
    workerSid: WORKER,
    identityVerified: true,
    jobRunner: () => ({ script: 'C:\\data\\sandbox\\remyral-jobrun.ps1', source: 'data', verified: true }),
    readState: () => Promise.resolve(JSON.stringify(stateDoc(3))),
    readRecord: () => Promise.resolve(passed(3)),
    writeRecord: () => Promise.resolve(),
    tokenPrivileges: () => Promise.resolve({ checked: true, missing: [] }),
    ...over,
  });
}

describe('controller gating on the login store', () => {
  it('the pool stays off until the login store was checked, and off while it is shared', async () => {
    let result: Awaited<ReturnType<typeof unshareLoginStores>> = {
      ok: false,
      code: 'job_slots_login_shared',
      detail: 'shared',
    };
    const seen: string[][] = [];
    const c = controller({
      loginStores: [`${PROFILE}\\.claude`],
      unshareLogin: (d) => {
        seen.push([...d.paths, d.workerSid, d.groupSid]);
        return Promise.resolve(result);
      },
    });
    await c.reload();
    expect(c.status()).toMatchObject({ active: false, code: 'job_slots_unchecked' });
    expect(c.status().detail).toMatch(/subscription login store/);
    await c.verify();
    expect(seen).toEqual([[`${PROFILE}\\.claude`, WORKER, GROUP]]);
    expect(c.status()).toMatchObject({ active: false, code: 'job_slots_login_shared' });
    expect(c.concurrency(3)).toBe(1);
    result = { ok: true, checked: [`${PROFILE}\\.claude`], unshared: [] };
    await c.verify(); // a current passing self-test is not repeated; the login check always runs
    expect(seen).toHaveLength(2);
    expect(c.status()).toMatchObject({ active: true });
    expect(c.status().detail).toMatch(/subscription logins run one at a time as the worker account/);
    expect(c.concurrency(3)).toBe(3);
  });

  it('without login stores (no USERPROFILE) the gate does not apply', async () => {
    const c = controller({ loginStores: [] });
    await c.reload();
    expect(c.status()).toMatchObject({ active: true });
  });

  it('the factory runs the check at worker start and reports it in the status', async () => {
    const root = await tempDir('slot-login-');
    const extra = join(root, 'claude-state');
    await mkdir(extra, { recursive: true });
    let changed = 0;
    const runners = await createSandboxRunners({
      settings: SandboxSettings.parse({ keepHome: true, hostExtraWritable: [extra] }),
      workspaceRoot: root,
      dataDir: join(root, 'data'),
      platform: 'win32',
      identity,
      jobRunner: { verified: true, script: 'C:\\jr.ps1', source: 'data' },
      maxParallelJobs: () => 3,
      slotStateDir: 'C:\\cfg\\job-slots',
      onChanged: () => {
        changed++;
      },
      slotDeps: {
        readState: () => Promise.resolve(JSON.stringify(stateDoc(3))),
        readRecord: () => Promise.resolve(passed(3)),
        writeRecord: () => Promise.resolve(),
        tokenPrivileges: () => Promise.resolve({ checked: true, missing: [] }),
        unshareLogin: (d) => Promise.resolve({ ok: true, checked: [...d.paths], unshared: [] }),
      },
    });
    for (let i = 0; i < 50 && changed === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(changed).toBe(1);
    expect(runners.windowsSlots?.loginStore).toMatchObject({
      ok: true,
      checked: expect.arrayContaining([extra]) as unknown,
    });
    expect(runners.hostRestrictedConcurrency()).toBe(3);
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
    expect(st.profiles.find((p) => p.profile === 'host-restricted')).toMatchObject({
      concurrency: 3,
      concurrencyNote: expect.stringMatching(
        /^for API-key runtimes; subscription logins run one at a time/,
      ) as unknown,
    });
  });

  it('a shared store that cannot be taken back is a failed job_slots check with a Prepare fix', async () => {
    const root = await tempDir('slot-login-shared-');
    const runners = await createSandboxRunners({
      settings: SandboxSettings.parse({}),
      workspaceRoot: root,
      dataDir: join(root, 'data'),
      platform: 'win32',
      identity,
      jobRunner: { verified: true, script: 'C:\\jr.ps1', source: 'data' },
      maxParallelJobs: () => 3,
      slotStateDir: 'C:\\cfg\\job-slots',
      slotDeps: {
        loginStores: ['C:\\p\\.claude'],
        readState: () => Promise.resolve(JSON.stringify(stateDoc(3))),
        readRecord: () => Promise.resolve(passed(3)),
        writeRecord: () => Promise.resolve(),
        tokenPrivileges: () => Promise.resolve({ checked: true, missing: [] }),
        unshareLogin: () =>
          Promise.resolve({ ok: false, code: 'job_slots_login_shared', detail: 'still shared' } as const),
      },
    });
    await runners.windowsSlots?.verify();
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
    expect(st.checks.find((x) => x.id === 'job_slots')).toMatchObject({
      status: 'failed',
      code: 'job_slots_login_shared',
      fix: 'prepare',
    });
    expect(runners.hostRestrictedConcurrency()).toBe(1);
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

describe('selectProfile: subscription logins run one at a time, alone', () => {
  const job = {
    profile: 'host-restricted' as const,
    runtime: 'claude-code' as const,
    sourceTrust: 'trusted' as const,
    needsEgress: true,
    hostExecutionOptIn: true,
  };
  const policy = { allowedProfiles: ['host-restricted'] as const };

  it('a local-login attempt runs only on an otherwise idle worker (transient refusal otherwise)', () => {
    const idle = selectProfile({ ...job, authMode: 'local-login' }, hostCaps(), policy);
    expect(idle).toMatchObject({
      ok: true,
      notes: expect.arrayContaining([
        expect.stringMatching(/^local-login: runs as the worker account/),
      ]) as unknown,
    });
    for (const caps of [
      hostCaps({ runningAttempts: 1, hostAttempts: 1 }), // an API-key attempt on a slot
      hostCaps({ runningAttempts: 1, hostAttempts: 0 }), // another local-login attempt (worker account)
    ]) {
      const r = selectProfile({ ...job, authMode: 'local-login' }, caps, policy);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.busy).toBe(true);
        expect(r.error.message).toMatch(/subscription logins \(local-login\) run one at a time.*\(T-SBX-4\)/);
      }
    }
  });

  it('API-key attempts stay parallel on the slots, but wait while a local-login attempt runs', () => {
    expect(
      selectProfile(
        { ...job, authMode: 'secret-ref' },
        hostCaps({ runningAttempts: 2, hostAttempts: 2 }),
        policy,
      ).ok,
    ).toBe(true);
    // the running local-login attempt holds no slot: runningAttempts 1, hostAttempts 0
    const r = selectProfile(
      { ...job, authMode: 'secret-ref' },
      hostCaps({ runningAttempts: 1, hostAttempts: 0 }),
      policy,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.busy).toBe(true);
      expect(r.error.message).toMatch(/worker account itself \(unconfined, or a subscription login\)/);
    }
  });

  it('macOS (Seatbelt) is unchanged: local-login attempts stay parallel there', () => {
    const r = selectProfile(
      { ...job, authMode: 'local-login' },
      hostCaps({
        platform: 'darwin',
        hostRestricted: { ready: true, filesystemConfinement: 'seatbelt', egressEnforced: true },
        runningAttempts: 2,
        hostAttempts: 2,
      }),
      policy,
    );
    expect(r.ok).toBe(true);
  });

  it('the master keeps seeing N host slots (the worker declines a second local-login job transiently)', () => {
    expect(
      profileSlots({
        maxParallelJobs: 3,
        profiles: ['host-restricted'],
        filesystemConfinement: 'job_user',
        hostConcurrency: 3,
      }).profileConcurrency,
    ).toEqual({ 'host-restricted': 3 });
  });
});

describe('host runner: local-login attempts never get a per-job account', () => {
  async function setup(keepHome: boolean) {
    const root = await realpath(await tempDir('slot-ll-'));
    const ws = join(root, 'ws');
    const data = join(root, 'data');
    await mkdir(data, { recursive: true });
    const calls: (readonly string[])[] = [];
    const run: RunFile = (_file, args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    const c = controller({ workspaceRoot: ws, dataDir: data });
    await c.reload();
    const runner = new HostRestrictedRunner({
      identity,
      workspaceRoot: ws,
      workerDataDir: data,
      platform: 'win32',
      keepHome,
      windowsJobRunner: () => ({ script: 'C:\\jr.ps1', source: 'data', verified: true }),
      runFile: run,
      windowsSlots: c,
    });
    const confine = async (id: string, authMode: SandboxContext['authMode']) => {
      const workspace = join(ws, 'jobs', 'job1', id);
      const sandboxDir = join(ws, 'sandboxes', 'job1', id);
      await mkdir(workspace, { recursive: true });
      await mkdir(sandboxDir, { recursive: true });
      const confined = await runner
        .confiner({
          jobId: 'job1',
          attemptId: id,
          ...(authMode === undefined ? {} : { authMode }),
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
        })
        .confine({ command: 'C:\\node.exe', args: [], cwd: workspace, env: {}, secretNames: [] });
      const spec = JSON.parse(
        await readFile(confined.args[confined.args.indexOf('-SpecFile') + 1] ?? '', 'utf8'),
      ) as { runAs?: { user: string } };
      return { confined, spec, sandboxDir };
    };
    return { c, calls, confine };
  }

  it('local-login: worker account (no runAs), the worker-only attempt ACL, no grant on any login store', async () => {
    const { c, calls, confine } = await setup(true);
    const a = await confine('l1', 'local-login');
    expect(a.spec.runAs).toBeUndefined();
    expect(c.pool?.inUse()).toBe(0);
    // the worker's own HOME (its login) stays: keepHome
    expect(a.confined.env.HOME).toBeUndefined();
    expect(calls.flat().some((x) => x.includes('.claude'))).toBe(false);
    expect(calls.flat().some((x) => x.includes(GROUP))).toBe(false);
    await a.confined.dispose?.();
  });

  it('API-key attempts run on a slot with a per-attempt HOME even with keepHome', async () => {
    const { c, confine } = await setup(true);
    const a = await confine('s1', 'secret-ref');
    expect(a.spec.runAs?.user).toBe('remyral-job-1');
    expect(c.pool?.inUse()).toBe(1);
    expect(a.confined.env.HOME).toBe(join(a.sandboxDir, 'home'));
    expect(a.confined.env.USERPROFILE).toBe(join(a.sandboxDir, 'home'));
    await a.confined.dispose?.();
  });
});
