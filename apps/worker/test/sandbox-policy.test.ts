import { describe, expect, it } from 'vitest';
import { SandboxUnavailableError } from '../src/sandbox/errors.js';
import {
  requireProfile,
  selectProfile,
  type JobSandboxRequirements,
  type WorkerSandboxCapabilities,
} from '../src/sandbox/policy.js';

const job = (over: Partial<JobSandboxRequirements> = {}): JobSandboxRequirements => ({
  profile: 'container',
  runtime: 'codex',
  sourceTrust: 'trusted',
  needsEgress: true,
  hostExecutionOptIn: false,
  ...over,
});

const caps = (over: Partial<WorkerSandboxCapabilities> = {}): WorkerSandboxCapabilities => ({
  platform: 'linux',
  container: { ready: true },
  hostRestricted: { ready: true, filesystemConfinement: 'none', egressEnforced: false },
  runtimeSandboxes: ['codex'],
  runningAttempts: 0,
  ...over,
});

const all = { allowedProfiles: ['container', 'runtime-sandbox', 'host-restricted'] as const };

function refusal(r: ReturnType<typeof selectProfile>): SandboxUnavailableError {
  if (r.ok) throw new Error(`expected refusal, got ${r.profile}`);
  return r.error;
}

describe('selectProfile (ADR-0007, ADR-0010 rule 3)', () => {
  it('provides the required profile when ready and allowed', () => {
    expect(selectProfile(job(), caps(), all)).toMatchObject({ ok: true, profile: 'container' });
    expect(
      selectProfile(job({ profile: 'host-restricted', hostExecutionOptIn: true }), caps(), all),
    ).toMatchObject({ ok: true, profile: 'host-restricted' });
    expect(
      selectProfile(job({ profile: 'runtime-sandbox', hostExecutionOptIn: true }), caps(), all),
    ).toMatchObject({ ok: true, profile: 'runtime-sandbox' });
  });

  it('untrusted sources run only in container', () => {
    const e = refusal(
      selectProfile(
        job({ profile: 'host-restricted', sourceTrust: 'untrusted', hostExecutionOptIn: true }),
        caps(),
        all,
      ),
    );
    expect(e.code).toBe('sandbox_unavailable');
    expect(e.reason).toBe('untrusted_requires_container');
    expect(e.remedy).toMatch(/container/);
    expect(selectProfile(job({ sourceTrust: 'untrusted' }), caps(), all).ok).toBe(true);
  });

  it('refuses a profile the policy does not allow, never substituting another', () => {
    const e = refusal(selectProfile(job(), caps(), { allowedProfiles: ['host-restricted'] }));
    expect(e.reason).toBe('profile_not_allowed');
  });

  it('refuses container when the engine/images are not ready, with the runner reason', () => {
    const e = refusal(
      selectProfile(
        job(),
        caps({
          container: {
            ready: false,
            reasonCode: 'image_unavailable',
            reason: 'image remyral/runtime-codex:0.1.0 missing',
            remedy: 'build it',
          },
        }),
        all,
      ),
    );
    expect(e.reason).toBe('image_unavailable');
    expect(e.message).toContain('remyral/runtime-codex');
    expect(e.remedy).toBe('build it');
  });

  it('host profiles need the project opt-in and a verified dedicated OS user', () => {
    expect(refusal(selectProfile(job({ profile: 'host-restricted' }), caps(), all)).reason).toBe(
      'host_restricted_not_opted_in',
    );
    const e = refusal(
      selectProfile(
        job({ profile: 'host-restricted', hostExecutionOptIn: true }),
        caps({
          platform: 'darwin',
          hostRestricted: {
            ready: false,
            reasonCode: 'worker_identity_unsafe',
            reason: 'member of privileged group(s): admin',
            filesystemConfinement: 'seatbelt',
            egressEnforced: true,
          },
        }),
        all,
      ),
    );
    expect(e.reason).toBe('worker_identity_unsafe');
    expect(e.message).toContain('admin');
  });

  it('without filesystem confinement a second concurrent host attempt is refused (T-SBX-4)', () => {
    const j = job({ profile: 'host-restricted', hostExecutionOptIn: true });
    expect(refusal(selectProfile(j, caps({ runningAttempts: 1 }), all)).message).toMatch(/concurrent/);
    const seatbelt = caps({
      platform: 'darwin',
      runningAttempts: 3,
      hostRestricted: { ready: true, filesystemConfinement: 'seatbelt', egressEnforced: true },
    });
    expect(selectProfile(j, seatbelt, all).ok).toBe(true);
  });

  it('runtime-sandbox needs a native sandbox of the job runtime', () => {
    const e = refusal(
      selectProfile(
        job({ profile: 'runtime-sandbox', runtime: 'pi', hostExecutionOptIn: true }),
        caps(),
        all,
      ),
    );
    expect(e.reason).toBe('runtime_has_no_sandbox');
  });

  it('notes (not refuses) unenforced egress for trusted host jobs', () => {
    const r = selectProfile(job({ profile: 'host-restricted', hostExecutionOptIn: true }), caps(), all);
    expect(r.ok && r.notes.join(' ')).toMatch(/egress is not enforced/);
  });

  it('requireProfile throws the typed refusal', () => {
    expect(() => requireProfile(job({ profile: 'host-restricted' }), caps(), all)).toThrow(
      SandboxUnavailableError,
    );
  });
});
