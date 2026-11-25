import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUTH_CHALLENGE_CONTEXT,
  challengePayload,
  publicKeyFingerprint,
  rotationPayload,
  verifyChallenge,
  verifyEd25519,
  verifyRotation,
} from '../src/auth.js';
import {
  isSequencedMasterType,
  isSequencedWorkerType,
  MasterToWorker,
  WorkerToMaster,
} from '../src/index.js';

const RFC_PUBLIC = Buffer.from(
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  'hex',
).toString('base64url');
const RFC_SIG_EMPTY = Buffer.from(
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  'hex',
).toString('base64url');

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, publicKey: String(jwk.x) };
}

describe('AUTH challenge payload (ADR-0005 §4)', () => {
  it('is domain separated', () => {
    expect(AUTH_CHALLENGE_CONTEXT).toBe('remana-worker-auth/v1\n');
    expect(challengePayload('abc').toString('utf8')).toBe('remana-worker-auth/v1\nabc');
  });

  it('verifies a signature over the payload and nothing else', () => {
    const { privateKey, publicKey } = keyPair();
    const nonce = 'n'.repeat(32);
    const good = sign(null, challengePayload(nonce), privateKey).toString('base64url');
    expect(verifyChallenge(publicKey, nonce, good)).toBe(true);
    // A bare-nonce signature (no domain separation) is not accepted.
    const bare = sign(null, Buffer.from(nonce), privateKey).toString('base64url');
    expect(verifyChallenge(publicKey, nonce, bare)).toBe(false);
    expect(verifyChallenge(publicKey, 'm'.repeat(32), good)).toBe(false);
    expect(verifyChallenge(keyPair().publicKey, nonce, good)).toBe(false);
  });

  it('never throws on malformed input', () => {
    expect(verifyChallenge('not-a-key', 'x', 'y')).toBe(false);
    expect(verifyChallenge(RFC_PUBLIC, 'x', 'A'.repeat(86))).toBe(false);
    expect(verifyChallenge('A'.repeat(43), 'x', 'A'.repeat(86))).toBe(false);
  });

  it('matches RFC 8032 §7.1 test 1', () => {
    expect(verifyEd25519(RFC_PUBLIC, new Uint8Array(), RFC_SIG_EMPTY)).toBe(true);
  });

  it('computes the fingerprint shown in pairing', () => {
    expect(publicKeyFingerprint(RFC_PUBLIC)).toBe(
      'SHA256:21FE-31DF-A154-A261-626B-F854-046F-D227-1B7B-ED4B-6ABE-45AA-5887-7EF4-7F97-21B9',
    );
  });
});

describe('rotation statement (p2-identity-rotation)', () => {
  it('needs both keys to sign the bound statement', () => {
    const oldKey = keyPair();
    const newKey = keyPair();
    const st = {
      workerId: 'wrk_a',
      oldPublicKey: oldKey.publicKey,
      newPublicKey: newKey.publicKey,
      nonce: 'z'.repeat(32),
    };
    const data = rotationPayload(st);
    expect(data.toString().startsWith('remana-worker-rotate/v1\n')).toBe(true);
    const oldSig = sign(null, data, oldKey.privateKey).toString('base64url');
    const newSig = sign(null, data, newKey.privateKey).toString('base64url');
    expect(verifyRotation(st, oldSig, newSig)).toBe(true);
    expect(verifyRotation(st, newSig, oldSig)).toBe(false);
    expect(verifyRotation({ ...st, nonce: 'y'.repeat(32) }, oldSig, newSig)).toBe(false);
    expect(verifyRotation({ ...st, workerId: 'wrk_b' }, oldSig, newSig)).toBe(false);
    expect(verifyRotation({ ...st, newPublicKey: st.oldPublicKey }, oldSig, oldSig)).toBe(false);
    // An AUTH signature over the nonce can never stand in for a rotation statement.
    const authSig = sign(null, challengePayload(st.nonce), oldKey.privateKey).toString('base64url');
    expect(verifyRotation(st, authSig, newSig)).toBe(false);
  });
});

describe('sequencing', () => {
  it('classifies every message type exactly once', () => {
    const workerTypes = WorkerToMaster.options.map((o) => o.shape.type.value);
    const masterTypes = MasterToWorker.options.map((o) => o.shape.type.value);
    expect(workerTypes.filter(isSequencedWorkerType).sort()).toEqual(
      ['ARTIFACT_CHUNK', 'ARTIFACT_REF', 'EVENT', 'JOB_RESULT', 'LEASE_ACK', 'LOG_CHUNK'].sort(),
    );
    expect(masterTypes.filter(isSequencedMasterType).sort()).toEqual(
      [
        'APPROVAL_DECISION',
        'ASSIGN_JOB',
        'CANCEL_JOB',
        'JOB_MESSAGE',
        'PAUSE_JOB',
        'RENEW_LEASE',
        'SET_APPROVAL_POLICY',
        'SET_TIME_LIMIT',
        'UPDATE_POLICY',
      ].sort(),
    );
    expect(workerTypes).toContain('ACK');
    expect(masterTypes).toContain('ACK');
    expect(masterTypes).toContain('ENROLL_PENDING');
    expect(workerTypes).toContain('ROTATE_KEY');
    expect(masterTypes).toContain('CREDENTIAL_ROTATED');
  });
});
