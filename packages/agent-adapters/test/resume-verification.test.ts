import { describe, expect, it } from 'vitest';
import {
  claudeCodeCapabilities,
  CLAUDE_CODE_CLI_PIN,
  CODEX_PIN,
  codexCapabilities,
  FakeRuntimeAdapter,
  isNativeResumeVerified,
  NATIVE_RESUME_VERIFIED,
  resumeCapability,
} from '../src/index.js';
import { spawnContext } from './helpers/runtime.js';

/** p11-session-continuity: native resume is used only for runtime versions verified live. */
describe('native resume verification', () => {
  const entry = {
    runtime: 'codex' as const,
    version: '9.9.9',
    verifiedAt: '2026-10-19',
    evidence: 'live test',
  };

  it('nothing is verified until the live tests ran; an entry is version-exact', () => {
    expect(NATIVE_RESUME_VERIFIED).toEqual([]);
    expect(isNativeResumeVerified('claude-code', CLAUDE_CODE_CLI_PIN)).toBe(false);
    expect(isNativeResumeVerified('codex', CODEX_PIN)).toBe(false);
    expect(isNativeResumeVerified('codex', '9.9.9', [entry])).toBe(true);
    expect(isNativeResumeVerified('codex', '9.9.10', [entry])).toBe(false);
    expect(isNativeResumeVerified('codex', undefined, [entry])).toBe(false);
  });

  it('the resume capability is supported only for a verified version', () => {
    const unverified = { status: 'unverified' as const, reason: 'pending' };
    expect(resumeCapability('codex', '9.9.9', unverified, [entry])).toMatchObject({ status: 'supported' });
    expect(resumeCapability('codex', '1.0.0', unverified, [entry])).toBe(unverified);
    const key = { version: CLAUDE_CODE_CLI_PIN, os: 'darwin' as const, arch: 'arm64' as const };
    expect(claudeCodeCapabilities({ runtime: 'claude-code', ...key }).capabilities.resume.status).toBe(
      'unverified',
    );
    expect(
      codexCapabilities({ runtime: 'codex', version: CODEX_PIN, os: 'linux', arch: 'x64' }).capabilities
        .resume.status,
    ).toBe('unverified');
  });

  it('fake adapter: sessionCheckpoint is read only and names the running session', async () => {
    const a = new FakeRuntimeAdapter({ runtime: 'codex', script: () => [{ kind: 'sleep', ms: 50 }] });
    await a.probe();
    const ref = await a.spawn(spawnContext('codex', process.cwd()));
    const cp = await a.sessionCheckpoint(ref);
    expect(cp?.runtimeSessionId).toBe(ref.runtimeSessionId);
    expect(a.parked).toEqual([]);
    await a.cleanup(ref);
  });
});
