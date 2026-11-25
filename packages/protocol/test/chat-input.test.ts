import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AssistantAttachmentDataPayload,
  AssistantAttachmentRef,
  AssistantAttachmentRequestPayload,
  AssistantReport,
  assistantToolInput,
  assistantTurnDigest,
  AssistantTurnPayload,
  attachmentMagicMatches,
  type LeaseKey,
  MAX_ASSISTANT_CONTEXT,
  MAX_CHAT_BINARY_BYTES,
  signAssistantTurn,
  verifyAssistantTurn,
  WorkerFeature,
} from '../src/index.js';

/** p8-chat-attachments-mentions: turn fields, digest, attachment messages, engine input report. */
const base = {
  turnId: '00000000-0000-4000-8000-0000000000c1',
  sessionKey: '00000000-0000-4000-8000-0000000000c2',
  runtime: 'claude-code' as const,
  issuedAt: '2026-10-16T10:00:00.000Z',
  expiresAt: '2026-10-16T10:02:00.000Z',
  message: 'What does this screenshot show?',
  history: '',
};
const ref = {
  id: '00000000-0000-4000-8000-0000000000a1',
  kind: 'image' as const,
  mediaType: 'image/png' as const,
  name: 'screen.png',
  sizeBytes: 1234,
  sha256: 'a'.repeat(64),
};

describe('chat input protocol (p8-chat-attachments-mentions)', () => {
  it('keeps the digest of turns without the new fields (older workers still verify them)', () => {
    const old = createHash('sha256')
      .update(
        JSON.stringify({
          history: base.history,
          message: base.message,
          runtime: base.runtime,
          sessionKey: base.sessionKey,
        }),
        'utf8',
      )
      .digest('hex');
    expect(assistantTurnDigest(base)).toBe(old);
  });

  it('binds attachments and context into the signature', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
    const keys = [{ kid: 'k', publicKey: jwk.x }] as unknown as LeaseKey[];
    const turn = { ...base, attachments: [ref], context: 'fenced data' };
    const sig = signAssistantTurn({ workerId: 'wrk_1', turn }, 'k', privateKey);
    expect(verifyAssistantTurn({ workerId: 'wrk_1', turn }, sig, keys)).toBe('ok');
    for (const change of [
      { attachments: [{ ...ref, sha256: 'b'.repeat(64) }] },
      { attachments: [{ ...ref, sizeBytes: 1235 }] },
      { attachments: [{ ...ref, id: '00000000-0000-4000-8000-0000000000a2' }] },
      { context: 'other data' },
      { context: undefined },
      { attachments: undefined },
    ]) {
      expect(verifyAssistantTurn({ workerId: 'wrk_1', turn: { ...turn, ...change } }, sig, keys)).toBe(
        'bad_signature',
      );
    }
  });

  it('validates refs, turn fields and the attachment messages', () => {
    expect(AssistantAttachmentRef.safeParse(ref).success).toBe(true);
    for (const bad of [
      { ...ref, mediaType: 'image/svg+xml' },
      { ...ref, sizeBytes: MAX_CHAT_BINARY_BYTES + 1 },
      { ...ref, name: '../etc/passwd' },
      { ...ref, extra: 1 },
    ]) {
      expect(AssistantAttachmentRef.safeParse(bad).success).toBe(false);
    }
    expect(AssistantTurnPayload.safeParse({ ...base, attachments: [ref, ref, ref, ref, ref] }).success).toBe(
      false,
    );
    expect(
      AssistantTurnPayload.safeParse({ ...base, context: 'x'.repeat(MAX_ASSISTANT_CONTEXT + 1) }).success,
    ).toBe(false);
    expect(
      AssistantAttachmentRequestPayload.safeParse({
        turnId: base.turnId,
        requestId: base.sessionKey,
        attachmentId: ref.id,
        offset: 0,
      }).success,
    ).toBe(true);
    expect(
      AssistantAttachmentDataPayload.safeParse({
        turnId: base.turnId,
        requestId: base.sessionKey,
        attachmentId: ref.id,
        status: 'ok',
        offset: 0,
        data: 'not base64!',
        eof: true,
      }).success,
    ).toBe(false);
    expect(WorkerFeature.safeParse('assistant-input-v1').success).toBe(true);
    expect(
      AssistantReport.safeParse({
        disabled: false,
        maxSessions: 8,
        engines: [{ runtime: 'pi', ready: true, input: { images: 'model-dependent', pdf: false } }],
      }).success,
    ).toBe(true);
  });

  it('draft_job takes chat attachment ids only', () => {
    const schema = assistantToolInput('draft_job');
    const job = { project: 'genel', title: 't', prompt: 'p', runtime: 'codex', mode: 'workspace' };
    expect(schema.safeParse({ ...job, chatAttachments: [ref.id] }).success).toBe(true);
    expect(schema.safeParse({ ...job, chatAttachments: ['../x'] }).success).toBe(false);
  });

  it('checks magic bytes', () => {
    expect(
      attachmentMagicMatches(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'),
    ).toBe(true);
    expect(attachmentMagicMatches(Buffer.from('%PDF-1.7'), 'application/pdf')).toBe(true);
    expect(attachmentMagicMatches(Buffer.from('<svg'), 'image/png')).toBe(false);
    expect(attachmentMagicMatches(Buffer.from('<svg'), 'image/svg+xml')).toBe(false);
  });
});
