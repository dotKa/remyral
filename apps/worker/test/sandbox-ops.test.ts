import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Capabilities, type WorkerConfigDocument } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { deriveCeiling } from '../src/config/ceiling.js';
import { type WorkerConfig, workerConfigSchema } from '../src/config/schema.js';
import { configReport, effectiveConfig } from '../src/managed-config/effective.js';
import { workerCapabilities } from '../src/probe/capabilities.js';
import { SandboxSettings } from '../src/sandbox/config.js';
import { createSandboxRunners } from '../src/sandbox/factory.js';
import { evaluateIdentity, type IdentityFacts, windowsServiceSid } from '../src/sandbox/host/identity.js';
import {
  attemptAclArgs,
  isEmbeddedJobRunner,
  jobRunnerDigest,
  locateJobRunner,
  quoteWindowsArg,
  WINDOWS_JOBRUN_PS1,
  WINDOWS_JOBRUN_SHA256,
  windowsCommandLine,
} from '../src/sandbox/host/windows-jobrun.js';
import { selectProfile, type WorkerSandboxCapabilities } from '../src/sandbox/policy.js';
import { buildSandboxStatus } from '../src/sandbox/status.js';
import { tempDir } from './helpers.js';

const SERVICE_SID = 'S-1-5-80-3873781773-1309777572-2309334471-3127388086-2944079060';

const win = (over: Partial<IdentityFacts> = {}): IdentityFacts => ({
  platform: 'win32',
  username: 'RemyralWorker',
  uid: null,
  groupNames: [],
  groupIds: [],
  consoleUid: null,
  groupSids: ['S-1-5-6', 'S-1-5-11', 'S-1-1-0'],
  userSid: SERVICE_SID,
  ...over,
});

describe('worker user: installer accounts and inference (p5-sandbox-ops)', () => {
  it('computes service SIDs like sc.exe showsid', () => {
    expect(windowsServiceSid('RemyralWorker')).toBe(SERVICE_SID);
    expect(windowsServiceSid('TrustedInstaller')).toBe(
      'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',
    );
  });

  it('infers NT SERVICE\\RemyralWorker from the token SID, never from a name alone', () => {
    expect(evaluateIdentity(win(), undefined)).toMatchObject({
      verified: true,
      expectedUser: 'NT SERVICE\\RemyralWorker',
      expectedUserSource: 'inferred',
      sid: SERVICE_SID,
    });
    // A local account that happens to be called RemyralWorker is not the virtual account.
    const impostor = evaluateIdentity(win({ userSid: 'S-1-5-21-1-2-3-1001' }), undefined);
    expect(impostor).toMatchObject({ verified: false, code: 'worker_user_unset' });
  });

  it('a configured NT SERVICE account is matched by SID; admin / SYSTEM are refused whatever the name', () => {
    expect(evaluateIdentity(win(), 'NT SERVICE\\RemyralWorker').verified).toBe(true);
    expect(evaluateIdentity(win({ userSid: 'S-1-5-21-9' }), 'NT SERVICE\\RemyralWorker').code).toBe(
      'worker_user_mismatch',
    );
    expect(evaluateIdentity(win({ groupSids: ['S-1-5-32-544'] }), undefined)).toMatchObject({
      verified: false,
      code: 'running_as_admin',
    });
    expect(
      evaluateIdentity(win({ userSid: 'S-1-5-18', username: 'SYSTEM' }), 'SYSTEM').problems.join(),
    ).toMatch(/LocalSystem/);
  });

  it('POSIX: the installer user is inferred by name; root and admin groups still refused', () => {
    const posix: IdentityFacts = {
      platform: 'linux',
      username: 'remyral-worker',
      uid: 990,
      groupNames: ['remyral-worker'],
      groupIds: [990],
      consoleUid: null,
      groupSids: [],
    };
    expect(evaluateIdentity(posix, undefined)).toMatchObject({
      verified: true,
      expectedUserSource: 'inferred',
    });
    expect(evaluateIdentity({ ...posix, groupNames: ['remyral-worker', 'docker'] }, undefined).code).toBe(
      'privileged_group',
    );
    expect(evaluateIdentity({ ...posix, username: 'root', uid: 0 }, undefined).verified).toBe(false);
    expect(
      evaluateIdentity({ ...posix, platform: 'darwin', username: '_remyralworker' }, undefined).verified,
    ).toBe(true);
  });
});

describe('unconfined profile selection (ADR-0019)', () => {
  const caps = (over: Partial<WorkerSandboxCapabilities> = {}): WorkerSandboxCapabilities => ({
    platform: 'win32',
    container: { ready: false },
    hostRestricted: { ready: true, filesystemConfinement: 'none', egressEnforced: false },
    runtimeSandboxes: [],
    unconfined: { ready: true },
    runningAttempts: 0,
    ...over,
  });
  const job = {
    profile: 'unconfined' as const,
    runtime: 'claude-code' as const,
    sourceTrust: 'trusted' as const,
    needsEgress: true,
    hostExecutionOptIn: true,
    unconfinedOptIn: true,
  };
  const allowed = { allowedProfiles: ['container', 'host-restricted', 'unconfined'] as const };

  it('runs only when policy, project and worker all allow it', () => {
    expect(selectProfile(job, caps(), allowed)).toMatchObject({ ok: true, profile: 'unconfined' });
    const reason = (r: ReturnType<typeof selectProfile>) => (r.ok ? 'ok' : r.error.reason);
    expect(reason(selectProfile({ ...job, sourceTrust: 'untrusted' }, caps(), allowed))).toBe(
      'untrusted_requires_container',
    );
    expect(reason(selectProfile(job, caps(), { allowedProfiles: ['host-restricted'] }))).toBe(
      'profile_not_allowed',
    );
    expect(reason(selectProfile({ ...job, unconfinedOptIn: false }, caps(), allowed))).toBe(
      'unconfined_not_opted_in',
    );
    expect(reason(selectProfile(job, { ...caps(), unconfined: { ready: false } }, allowed))).toBe(
      'profile_not_allowed',
    );
    expect(reason(selectProfile(job, caps({ runningAttempts: 1 }), allowed))).toBe(
      'profile_unsupported_on_os',
    );
  });
});

function configFrom(raw: Record<string, unknown>): WorkerConfig {
  const parsed = workerConfigSchema('linux').parse({
    masterUrl: 'wss://m.example.com/v1/worker',
    workspaceRoot: '/srv/work',
    ...raw,
  });
  const { dataDir: _d, $schema: _s, ...rest } = parsed;
  const base = { ...rest, dataDir: '/var/lib/rw', source: '/etc/remyral-worker/config.json' };
  return { ...base, ...deriveCeiling(raw, base) };
}

const DOC: WorkerConfigDocument = {
  schemaVersion: 1,
  projects: {},
  allowedRuntimes: ['claude-code'],
  maxParallelJobs: 1,
  sandboxProfiles: ['container', 'host-restricted'],
  workspace: {},
  labels: {},
  runtimes: {},
};
const delivery = (doc: WorkerConfigDocument) => ({
  generation: 2,
  documentHash: 'a'.repeat(64),
  issuedAt: '2026-10-14T10:00:00.000Z',
  document: doc,
});

describe('unconfined gating in the effective configuration', () => {
  it('local file alone never enables it', () => {
    expect(effectiveConfig(configFrom({}), null).config.sandboxProfiles).not.toContain('unconfined');
  });

  it('the panel flag enables it; the local ceiling forbids it (explicitly or by a profile list)', () => {
    const on = effectiveConfig(configFrom({}), delivery({ ...DOC, allowUnconfined: true }));
    expect(on.config.sandboxProfiles).toContain('unconfined');
    expect(on.config.unconfined).toBe('allowed');
    const report = configReport(
      configFrom({}),
      on,
      { generation: 2, documentHash: 'a'.repeat(64), appliedAt: 'x' },
      null,
    );
    expect(report.effective.allowUnconfined).toBe(true);

    for (const ceiling of [
      { allowUnconfined: false },
      { sandboxProfiles: ['container', 'host-restricted'] },
    ]) {
      const cfg = configFrom({ localCeiling: ceiling });
      const r = effectiveConfig(cfg, delivery({ ...DOC, allowUnconfined: true }));
      expect(r.config.sandboxProfiles).not.toContain('unconfined');
      expect(r.config.unconfined).toBe('forbidden_locally');
      expect(r.blocked).toContainEqual(
        expect.objectContaining({ path: 'allowUnconfined', code: 'blocked_by_local_ceiling' }),
      );
      const rep = configReport(cfg, r, null, null);
      expect(rep.ceiling.allowUnconfined).toBe(false);
      // Older masters only know the ADR-0007 profiles: never 'unconfined' in the ceiling list.
      expect(rep.ceiling.sandboxProfiles ?? []).not.toContain('unconfined');
    }
  });

  it('`unconfined` in the panel profile list alone does nothing (only the flag counts)', () => {
    const r = effectiveConfig(
      configFrom({}),
      delivery({ ...DOC, sandboxProfiles: ['container', 'unconfined'] }),
    );
    expect(r.config.sandboxProfiles).toEqual(['container']);
  });
});

describe('readiness reasons and CAPABILITIES (p5-sandbox-ops)', () => {
  it('reports machine-readable codes and fixes; sandboxReadiness stays ADR-0007-only for older masters', async () => {
    const root = await tempDir('sbx-');
    let unconfinedOn = false;
    const runners = await createSandboxRunners({
      settings: SandboxSettings.parse({}),
      workspaceRoot: root,
      dataDir: root,
      platform: 'win32',
      identity: {
        verified: true,
        username: 'RemyralWorker',
        uid: null,
        problems: [],
        expectedUser: 'NT SERVICE\\RemyralWorker',
        expectedUserSource: 'inferred',
      },
      jobRunner: { verified: false, code: 'job_runner_selftest_failed', detail: 'Add-Type blocked' },
      unconfinedAllowed: () =>
        unconfinedOn ? { allowed: true } : { allowed: false, code: 'unconfined_not_enabled' },
    });
    const status = await buildSandboxStatus({
      runners,
      runnersError: null,
      enabledRuntimes: ['claude-code'],
      unconfined: 'not_enabled',
      workspaceRoot: root,
      privilegedHelper: { available: false, detail: 'old updater' },
      freeBytes: 10 * 1024 ** 3,
    });
    const byProfile = Object.fromEntries(status.profiles.map((p) => [p.profile, p]));
    expect(byProfile['host-restricted']).toMatchObject({
      ready: false,
      code: 'job_runner_selftest_failed',
      fix: 'prepare',
    });
    expect(byProfile.container).toMatchObject({
      ready: false,
      code: 'profile_unsupported_on_os',
      fix: 'none',
    });
    expect(byProfile.unconfined).toMatchObject({
      ready: false,
      code: 'unconfined_not_enabled',
      fix: 'panel',
    });
    expect(status.checks.find((c) => c.id === 'job_runner')).toMatchObject({
      status: 'failed',
      fix: 'prepare',
    });
    expect(status.workerUser).toMatchObject({ source: 'inferred', expected: 'NT SERVICE\\RemyralWorker' });

    unconfinedOn = true;
    const base = {
      runtimes: [],
      sandboxProfiles: [],
      maxParallelJobs: 1,
      tools: [],
    } as unknown as Parameters<typeof workerCapabilities>[0];
    const caps = await workerCapabilities(base, {
      registry: null,
      runners,
      runnersError: null,
      enabledRuntimes: ['claude-code'],
      projects: [],
      allowedProfiles: ['container', 'host-restricted', 'unconfined'],
    });
    // Unconfined needs the job runner too on Windows (limits must apply).
    expect(caps.sandboxProfiles).not.toContain('unconfined');
    expect((caps.sandboxReadiness ?? []).map((r) => r.profile)).not.toContain('unconfined');
    const parsed = Capabilities.shape.payload.safeParse({ ...caps, sandboxStatus: status });
    expect(parsed.success).toBe(true);
  });
});

describe('Windows job runner (real Windows run: docs/design/p5-sandbox-ops.md §Verification)', () => {
  it('quotes command lines like CommandLineToArgvW expects', () => {
    expect(quoteWindowsArg('a')).toBe('a');
    expect(windowsCommandLine(['C:\\Program Files\\x.exe', 'a b', 'c"d', 'e\\', ''])).toBe(
      '"C:\\Program Files\\x.exe" "a b" "c\\"d" e\\ ""',
    );
    expect(() => windowsCommandLine(['a\0b'])).toThrow(RangeError);
  });

  it('writes the embedded runner, accepts an installer copy only when identical, rewrites a tampered data copy', async () => {
    const dir = await tempDir('jr-');
    const install = join(dir, 'install');
    await mkdir(install, { recursive: true });
    const ok = () => Promise.resolve({ code: 0, stdout: 'remyral-jobrun ok 1\r\n', stderr: '' });
    const fromData = await locateJobRunner({ installDir: install, dataDir: dir, run: ok });
    expect(fromData).toMatchObject({ verified: true, source: 'data' });
    expect(jobRunnerDigest(await readFile(join(dir, 'sandbox', 'remyral-jobrun.ps1'), 'utf8'))).toBe(
      WINDOWS_JOBRUN_SHA256,
    );
    // CRLF copies (a kit unpacked on Windows) are the same script.
    await writeFile(join(install, 'remyral-jobrun.ps1'), WINDOWS_JOBRUN_PS1.replace(/\n/g, '\r\n'));
    expect(await locateJobRunner({ installDir: install, dataDir: dir, run: ok })).toMatchObject({
      source: 'install',
    });
    await writeFile(join(install, 'remyral-jobrun.ps1'), `${WINDOWS_JOBRUN_PS1}\n# extra`);
    expect(await locateJobRunner({ installDir: install, dataDir: dir, run: ok })).toMatchObject({
      source: 'data',
    });
    await writeFile(join(dir, 'sandbox', 'remyral-jobrun.ps1'), 'Write-Output pwned');
    expect(await isEmbeddedJobRunner(join(dir, 'sandbox', 'remyral-jobrun.ps1'))).toBe(false);
    await locateJobRunner({ installDir: undefined, dataDir: dir, run: ok });
    expect(await isEmbeddedJobRunner(join(dir, 'sandbox', 'remyral-jobrun.ps1'))).toBe(true);
    // A failing self-test (Constrained Language Mode, GPO execution policy) is reported, not used.
    const failed = await locateJobRunner({
      dataDir: dir,
      run: () => Promise.resolve({ code: 120, stdout: '', stderr: 'remyral-jobrun: cannot compile' }),
    });
    expect(failed).toMatchObject({ verified: false, code: 'job_runner_selftest_failed' });
    expect(
      await locateJobRunner({ configured: 'C:\\x\\remyral-jobrun.exe', dataDir: dir, run: ok }),
    ).toMatchObject({
      verified: false,
      code: 'job_runner_unsupported',
    });
  });

  it('per-attempt ACL: protected, SYSTEM + Administrators + the worker SID only', () => {
    expect(attemptAclArgs('C:\\w\\jobs\\j\\a', SERVICE_SID)).toEqual([
      'C:\\w\\jobs\\j\\a',
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
      `*${SERVICE_SID}:(OI)(CI)M`,
      '/Q',
    ]);
    expect(() => attemptAclArgs('C:\\w', 'Everyone')).toThrow(RangeError);
  });

  it('the script stays ASCII and uses only case-sensitive operators', () => {
    expect(/[^\t\n\r\x20-\x7e]/.test(WINDOWS_JOBRUN_PS1)).toBe(false);
    expect(/\s-(match|notmatch|replace|split|like|notlike)\s/.test(WINDOWS_JOBRUN_PS1)).toBe(false);
  });
});
