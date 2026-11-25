import { describe, expect, it } from 'vitest';
import {
  newWebhookSecret,
  payloadDigest,
  secretHint,
  signGitHubWebhook,
  signRemyralWebhook,
  verifyGitHubSignature,
  verifyRemyralWebhook,
  WEBHOOK_SKEW_MS,
} from '../../src/automations/webhook-signature.js';

const now = new Date('2026-10-15T12:00:00Z');
const ts = String(Math.floor(now.getTime() / 1000));
const nonce = 'n0nce-0123456789abcdef';
const body = Buffer.from('{"deploy":"done","sha":"abc"}');

describe('Remyral webhook signature (p6-automations §8)', () => {
  const secret = newWebhookSecret();

  it('generates prefixed high-entropy secrets with a public hint', () => {
    expect(secret).toMatch(/^rwh_[A-Za-z0-9_-]{43}$/);
    expect(newWebhookSecret()).not.toBe(secret);
    expect(secretHint(secret)).toMatch(/^[a-f0-9]{8}$/);
    expect(secretHint(secret)).toBe(secretHint(secret));
    expect(payloadDigest(body)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('accepts a correct signature and returns the nonce', () => {
    const signature = signRemyralWebhook(secret, ts, nonce, body);
    const v = verifyRemyralWebhook(secret, { timestamp: ts, nonce, signature }, body, now);
    expect(v).toEqual({ ok: true, timestamp: new Date(Number(ts) * 1000), nonce });
  });

  it('refuses a wrong secret, a changed body, a changed nonce or timestamp', () => {
    const signature = signRemyralWebhook(secret, ts, nonce, body);
    const bad = (h: { timestamp: string; nonce: string; signature: string }, b = body) =>
      verifyRemyralWebhook(secret, h, b, now);
    expect(
      bad({ timestamp: ts, nonce, signature: signRemyralWebhook(newWebhookSecret(), ts, nonce, body) }),
    ).toEqual({
      ok: false,
      code: 'bad_signature',
    });
    expect(bad({ timestamp: ts, nonce, signature }, Buffer.from('{"deploy":"evil"}'))).toMatchObject({
      ok: false,
    });
    expect(bad({ timestamp: ts, nonce: `${nonce}x`, signature })).toMatchObject({ code: 'bad_signature' });
    expect(bad({ timestamp: String(Number(ts) - 1), nonce, signature })).toMatchObject({
      code: 'bad_signature',
    });
    // Hex case in the header is not significant.
    expect(bad({ timestamp: ts, nonce, signature: signature.toUpperCase() })).toMatchObject({ ok: true });
  });

  it('refuses stale or future timestamps beyond ±5 minutes (replay window)', () => {
    const old = String(Math.floor((now.getTime() - WEBHOOK_SKEW_MS - 1000) / 1000));
    const future = String(Math.floor((now.getTime() + WEBHOOK_SKEW_MS + 1000) / 1000));
    for (const t of [old, future]) {
      const v = verifyRemyralWebhook(
        secret,
        { timestamp: t, nonce, signature: signRemyralWebhook(secret, t, nonce, body) },
        body,
        now,
      );
      expect(v).toEqual({ ok: false, code: 'stale_timestamp' });
    }
    const edge = String(Math.floor((now.getTime() - WEBHOOK_SKEW_MS + 1000) / 1000));
    expect(
      verifyRemyralWebhook(
        secret,
        { timestamp: edge, nonce, signature: signRemyralWebhook(secret, edge, nonce, body) },
        body,
        now,
      ).ok,
    ).toBe(true);
  });

  it('refuses missing or malformed headers before computing anything', () => {
    const signature = signRemyralWebhook(secret, ts, nonce, body);
    expect(verifyRemyralWebhook(secret, { timestamp: ts, nonce, signature: undefined }, body, now)).toEqual({
      ok: false,
      code: 'missing_headers',
    });
    expect(verifyRemyralWebhook(secret, { timestamp: ts, nonce: 'short', signature }, body, now)).toEqual({
      ok: false,
      code: 'bad_nonce',
    });
    expect(verifyRemyralWebhook(secret, { timestamp: '12.5', nonce, signature }, body, now)).toEqual({
      ok: false,
      code: 'bad_timestamp',
    });
    expect(verifyRemyralWebhook(secret, { timestamp: ts, nonce, signature: 'sha1=abc' }, body, now)).toEqual({
      ok: false,
      code: 'bad_signature',
    });
  });
});

describe('GitHub X-Hub-Signature-256', () => {
  const secret = 'gh-webhook-secret';
  it('verifies the HMAC over the raw body in constant time', () => {
    const sig = signGitHubWebhook(secret, body);
    expect(verifyGitHubSignature(secret, sig, body)).toBe(true);
    expect(verifyGitHubSignature('other', sig, body)).toBe(false);
    expect(verifyGitHubSignature(secret, sig, Buffer.from(`${body.toString()} `))).toBe(false);
    expect(verifyGitHubSignature(secret, undefined, body)).toBe(false);
    expect(verifyGitHubSignature(secret, 'sha256=00', body)).toBe(false);
  });
});
