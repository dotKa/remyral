import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AssignJob,
  CapabilityEvidence,
  capabilityEvidenceStatement,
  DEFAULT_VERIFICATION_BUDGET,
  evidenceApplies,
  OpsOperation,
  opsOperationDigest,
  OpsUpdatePayload,
  overlayCapabilityStatus,
  RUNTIME_CAPABILITY_VERIFY_FEATURE,
  RuntimeCapabilities,
  VERIFICATION_ESTIMATE,
  VerificationBudget,
  verificationKeyId,
  verifiedCapabilities,
  verifyCapabilityEvidence,
  WorkerFeature,
  type CapabilityEvidence as Evidence,
} from '../src/index.js';

/** p17-runtime-verify: the wire additions, the evidence signature and the precedence rules. */

const OP = '0b7c0b9e-4c4b-4b2a-9a51-8d6a3f2f4e10';

function evidence(over: Partial<Evidence> = {}): Evidence {
  return CapabilityEvidence.parse({
    runtime: 'pi',
    runtimeVersion: '1.4.0',
    adapterVersion: 'pi-adapter/1+pin1.4.0',
    os: 'win32',
    arch: 'x64',
    workerId: 'w-win-1',
    workerVersion: '1.2.0',
    opId: OP,
    startedAt: '2026-10-27T10:00:00.000Z',
    finishedAt: '2026-10-27T10:02:00.000Z',
    durationMs: 120_000,
    authMode: 'local-login',
    sandboxProfile: 'host-restricted',
    budget: DEFAULT_VERIFICATION_BUDGET,
    usage: { inputTokens: 1200, outputTokens: 300 },
    declared: { streaming: 'supported', approval: 'degraded', artifacts: 'unsupported' },
    results: [
      { capability: 'streaming', status: 'passed', reason: 'ok', durationMs: 1000 },
      { capability: 'approval', status: 'passed', reason: 'ok', durationMs: 1000 },
      { capability: 'cancel', status: 'failed', reason: 'cancel took 40 s', durationMs: 40_000 },
      { capability: 'artifacts', status: 'skipped', reason: 'unsupported', durationMs: 0 },
    ],
    ...over,
  });
}

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, publicKey: String(jwk.x) };
}

describe('runtime.capabilities.verify op', () => {
  it('requires runtime, version and a bounded budget; the digest covers the budget', () => {
    const op = OpsOperation.parse({
      kind: 'runtime.capabilities.verify',
      runtime: 'codex',
      version: '0.164.0',
      budget: DEFAULT_VERIFICATION_BUDGET,
    });
    expect(op.kind).toBe('runtime.capabilities.verify');
    expect(
      OpsOperation.safeParse({ kind: 'runtime.capabilities.verify', runtime: 'codex', version: '0.164.0' })
        .success,
    ).toBe(false);
    expect(VerificationBudget.safeParse({ maxDurationSec: 10, maxTokens: 5000 }).success).toBe(false);
    expect(VerificationBudget.safeParse({ maxDurationSec: 600, maxTokens: 10_000_000 }).success).toBe(false);
    const bigger = OpsOperation.parse({ ...op, budget: { maxDurationSec: 900, maxTokens: 150_000 } });
    expect(opsOperationDigest(op)).not.toBe(opsOperationDigest(bigger));
  });

  it('is a feature workers advertise; estimates exist for every runtime', () => {
    expect(WorkerFeature.options).toContain(RUNTIME_CAPABILITY_VERIFY_FEATURE);
    for (const rt of ['claude-code', 'codex', 'pi', 'opencode'] as const) {
      expect(VERIFICATION_ESTIMATE[rt].tokens).toBeLessThan(DEFAULT_VERIFICATION_BUDGET.maxTokens);
      expect(VERIFICATION_ESTIMATE[rt].durationSec).toBeLessThan(DEFAULT_VERIFICATION_BUDGET.maxDurationSec);
    }
  });

  it('OPS_UPDATE carries progress results or the final signed evidence', () => {
    const base = { commandId: OP, seq: 1, kind: 'runtime.capabilities.verify', state: 'running' };
    expect(
      OpsUpdatePayload.parse({
        ...base,
        capabilityVerify: { final: false, results: evidence().results.slice(0, 1) },
      }).capabilityVerify,
    ).toMatchObject({ final: false });
    const signed = { evidence: evidence(), signature: 'A'.repeat(86) };
    expect(
      OpsUpdatePayload.parse({
        ...base,
        seq: 2,
        state: 'succeeded',
        capabilityVerify: { final: true, signed },
      }).capabilityVerify,
    ).toMatchObject({ final: true });
    expect(
      OpsUpdatePayload.safeParse({ ...base, capabilityVerify: { final: true, signed: { evidence: {} } } })
        .success,
    ).toBe(false);
  });

  it('CAPABILITIES carries the adapter revision and declared table; ASSIGN_JOB the verified set', () => {
    const r = RuntimeCapabilities.parse({
      runtime: 'pi',
      version: '1.4.0',
      installed: true,
      authenticated: 'yes',
      capabilities: { streaming: { status: 'unverified', note: 'x' } },
      verification: { adapterVersion: 'pi-adapter/1+pin1.4.0', declared: { streaming: 'supported' } },
    });
    expect(r.verification?.declared.streaming).toBe('supported');
    expect(
      RuntimeCapabilities.safeParse({ ...r, verification: { adapterVersion: 'Bad Rev', declared: {} } })
        .success,
    ).toBe(false);
    const execution = AssignJob.shape.payload.shape.execution.unwrap();
    expect(
      execution.safeParse({
        hostExecutionOptIn: false,
        verifiedCapabilities: {
          runtime: 'pi',
          runtimeVersion: '1.4.0',
          os: 'win32',
          arch: 'x64',
          adapterVersion: 'pi-adapter/1+pin1.4.0',
          capabilities: ['streaming', 'cancel'],
        },
      }).success,
    ).toBe(true);
  });
});

describe('capability evidence signature', () => {
  it('verifies for the signing worker and operation only', () => {
    const k = keys();
    const e = evidence();
    const signature = sign(
      null,
      capabilityEvidenceStatement({ workerId: e.workerId, opId: OP, evidence: e }),
      k.privateKey,
    ).toString('base64url');
    const signed = { evidence: e, signature };
    expect(
      verifyCapabilityEvidence({ workerId: 'w-win-1', opId: OP, devicePublicKey: k.publicKey, signed }),
    ).toBe('ok');
    // Another machine's device key / id / operation never accepts it.
    expect(
      verifyCapabilityEvidence({ workerId: 'w-win-1', opId: OP, devicePublicKey: keys().publicKey, signed }),
    ).toBe('bad_signature');
    expect(
      verifyCapabilityEvidence({ workerId: 'w-other', opId: OP, devicePublicKey: k.publicKey, signed }),
    ).toBe('wrong_worker');
    expect(
      verifyCapabilityEvidence({
        workerId: 'w-win-1',
        opId: '1b7c0b9e-4c4b-4b2a-9a51-8d6a3f2f4e10',
        devicePublicKey: k.publicKey,
        signed,
      }),
    ).toBe('wrong_op');
    // A changed result breaks the signature.
    const tampered = {
      ...signed,
      evidence: { ...e, results: e.results.map((r) => ({ ...r, status: 'passed' as const })) },
    };
    expect(
      verifyCapabilityEvidence({
        workerId: 'w-win-1',
        opId: OP,
        devicePublicKey: k.publicKey,
        signed: tampered,
      }),
    ).toBe('bad_signature');
  });
});

describe('precedence', () => {
  it('lifts only unverified, only to the declared supported / degraded, only on a pass', () => {
    expect(
      overlayCapabilityStatus({ reported: 'unverified', declared: 'supported', outcome: 'passed' }),
    ).toEqual({
      status: 'supported',
      verified: true,
    });
    expect(
      overlayCapabilityStatus({ reported: 'unverified', declared: 'degraded', outcome: 'passed' }),
    ).toEqual({
      status: 'degraded',
      verified: true,
    });
    expect(
      overlayCapabilityStatus({ reported: 'unverified', declared: 'unsupported', outcome: 'passed' }).status,
    ).toBe('unverified');
    expect(
      overlayCapabilityStatus({ reported: 'unverified', declared: undefined, outcome: 'passed' }).status,
    ).toBe('unverified');
    expect(
      overlayCapabilityStatus({ reported: 'unverified', declared: 'supported', outcome: 'failed' }).status,
    ).toBe('unverified');
    expect(
      overlayCapabilityStatus({ reported: 'unverified', declared: 'supported', outcome: 'skipped' }).status,
    ).toBe('unverified');
    // Never changes a reported supported / degraded / unsupported.
    expect(
      overlayCapabilityStatus({ reported: 'unsupported', declared: 'supported', outcome: 'passed' }),
    ).toEqual({
      status: 'unsupported',
      verified: false,
    });
    expect(
      overlayCapabilityStatus({ reported: 'degraded', declared: 'supported', outcome: 'passed' }).status,
    ).toBe('degraded');
  });

  it('applies only to the exact tuple; verified capabilities exclude declared unsupported', () => {
    const k = {
      runtime: 'pi',
      runtimeVersion: '1.4.0',
      os: 'win32',
      arch: 'x64',
      adapterVersion: 'pi-adapter/1+pin1.4.0',
    };
    expect(evidenceApplies(k, { ...k })).toBe(true);
    expect(evidenceApplies(k, { ...k, runtimeVersion: '1.5.0' })).toBe(false);
    expect(evidenceApplies(k, { ...k, arch: 'arm64' })).toBe(false);
    expect(evidenceApplies(k, { ...k, adapterVersion: 'pi-adapter/2+pin1.4.0' })).toBe(false);
    expect(verifiedCapabilities(evidence())).toEqual(['streaming', 'approval']);
  });

  it('a version or revision with separators never aliases another tuple; an unknown platform never applies', () => {
    const live = {
      runtime: 'pi',
      runtimeVersion: '1.4.0',
      os: 'win32',
      arch: 'x64',
      adapterVersion: 'pi-adapter/1/linux-arm64/x',
    };
    const forged = {
      runtime: 'pi',
      runtimeVersion: '1.4.0/win32-x64/pi-adapter/1',
      os: 'linux',
      arch: 'arm64',
      adapterVersion: 'x',
    };
    expect(verificationKeyId(forged)).not.toBe(verificationKeyId(live));
    expect(evidenceApplies(forged, live)).toBe(false);
    const odd = { ...live, os: 'freebsd' };
    expect(evidenceApplies(odd, { ...odd })).toBe(false);
    expect(evidenceApplies({ ...live, arch: 'ia32' }, { ...live, arch: 'ia32' })).toBe(false);
  });
});
