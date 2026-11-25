import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_MODE_SWITCH_FEATURE,
  type ApprovalModeBinding,
  approvalModeStatement,
  isSequencedMasterType,
  MasterToWorker,
  SetApprovalPolicyPayload,
  signApprovalMode,
  verifyApprovalMode,
  WorkerFeature,
  WorkerToMaster,
} from '../src/index.js';
import { masterMessages, workerMessages } from './fixtures.js';

function keyPair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x;
  if (raw === undefined) throw new Error('no key');
  return { key: { kid, publicKey: raw }, privateKey };
}

const binding: ApprovalModeBinding = {
  workerId: 'wrk_mac1',
  jobId: '00000000-0000-4000-8000-000000000001',
  attemptId: '00000000-0000-4000-8000-000000000002',
  epoch: 3,
  changeId: '00000000-0000-4000-8000-0000000000e1',
  seq: 2,
  approvalPolicy: 'ask-all',
  autoApproveOptIn: false,
  changedBy: '00000000-0000-4000-8000-0000000000c4',
  issuedAt: '2026-10-16T10:00:00.000Z',
};

describe('p6-approval-mode-switch protocol', () => {
  it('knows the feature and both messages', () => {
    expect(WorkerFeature.safeParse(APPROVAL_MODE_SWITCH_FEATURE).success).toBe(true);
    expect(MasterToWorker.safeParse(masterMessages.SET_APPROVAL_POLICY).success).toBe(true);
    expect(WorkerToMaster.safeParse(workerMessages.APPROVAL_POLICY_STATUS).success).toBe(true);
    expect(isSequencedMasterType('SET_APPROVAL_POLICY')).toBe(true);
  });

  it('refuses unknown modes and a zero seq', () => {
    const p = (masterMessages.SET_APPROVAL_POLICY as { payload: Record<string, unknown> }).payload;
    expect(SetApprovalPolicyPayload.safeParse({ ...p, approvalPolicy: 'yolo' }).success).toBe(false);
    expect(SetApprovalPolicyPayload.safeParse({ ...p, seq: 0 }).success).toBe(false);
  });

  it('signs and verifies, and every bound field matters', () => {
    const { key, privateKey } = keyPair('kid-0001');
    const sig = signApprovalMode(binding, key.kid, privateKey);
    expect(verifyApprovalMode(binding, sig, [key])).toBe('ok');
    const tampers: Partial<ApprovalModeBinding>[] = [
      { workerId: 'wrk_other' },
      { jobId: '00000000-0000-4000-8000-000000000009' },
      { attemptId: '00000000-0000-4000-8000-000000000009' },
      { epoch: 4 },
      { changeId: '00000000-0000-4000-8000-0000000000e2' },
      { seq: 3 },
      { approvalPolicy: 'allow-all' },
      { autoApproveOptIn: true },
      { changedBy: 'someone-else' },
      { issuedAt: '2026-10-16T10:00:01.000Z' },
    ];
    for (const tampered of tampers) {
      expect(verifyApprovalMode({ ...binding, ...tampered }, sig, [key])).toBe('bad_signature');
    }
    expect(verifyApprovalMode(binding, undefined, [key])).toBe('missing');
    expect(verifyApprovalMode(binding, { ...sig, kid: 'kid-9999' }, [key])).toBe('unknown_key');
    const other = keyPair('kid-0001');
    expect(verifyApprovalMode(binding, sig, [other.key])).toBe('bad_signature');
  });

  it('has a domain-separated statement', () => {
    expect(approvalModeStatement(binding).toString('utf8').startsWith('remana-approval-mode/v1\n')).toBe(
      true,
    );
  });
});
