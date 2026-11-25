import { describe, expect, it } from 'vitest';
import {
  credentialIdFor,
  credentialToken,
  credentialTokenNames,
  detectSecrets,
  pastedSecretToken,
  removedSecretToken,
  replaceFindings,
  segmentSecretTokens,
  suggestCredentialName,
} from '../src/chat-secrets.js';

/** p15-chat-vault: pasted-secret detection and the tokens that stand in for a value. */
const OPENAI = 'sk-proj-abcDEF0123456789ghijklmnopQRSTUV';
const GH = `ghp_${'a1B2'.repeat(9)}`;

describe('detectSecrets', () => {
  it('names the provider of vendor-prefixed keys', () => {
    const text = `use ${OPENAI} and ${GH} please`;
    const f = detectSecrets(text);
    expect(f.map((x) => x.provider)).toEqual(['openai', 'github']);
    expect(f.map((x) => text.slice(x.start, x.end))).toEqual([OPENAI, GH]);
  });

  it('knows Anthropic, OpenRouter, Google, Stripe and marks subscription tokens', () => {
    const ant = `sk-ant-api03-${'x'.repeat(30)}`;
    const oat = `sk-ant-oat01-${'y'.repeat(30)}`;
    const or = `sk-or-v1-${'0a'.repeat(15)}`;
    const g = `AIza${'B'.repeat(35)}`;
    const s = `sk_live_${'Z9'.repeat(10)}`;
    const f = detectSecrets([ant, oat, or, g, s].join(' '));
    expect(f.map((x) => x.provider)).toEqual(['anthropic', 'anthropic', 'openrouter', 'google', 'stripe']);
    expect(f.map((x) => x.subscription)).toEqual([false, true, false, false, false]);
  });

  it('takes the value of assignments and bearer tokens, not the key name', () => {
    const text = 'API_KEY=s3cr3tValue99 and Authorization: Bearer abcdefghijklmnop1234';
    const f = detectSecrets(text);
    expect(f.map((x) => x.value)).toEqual(['s3cr3tValue99', 'abcdefghijklmnop1234']);
    expect(f.every((x) => x.provider === 'generic')).toBe(true);
  });

  it('a bare random token counts only as a paste; hashes, uuids and prose stay text', () => {
    const bare = 'Qm9vT2xkU2VjcmV0S2V5MTIzNDU2Nzg5';
    expect(detectSecrets(bare)).toEqual([]);
    expect(detectSecrets(bare, { pasted: true }).map((x) => x.value)).toEqual([bare]);
    expect(detectSecrets('3f2a9c1e0b7d4a6f8e2c5b1a9d7f3e6c0b2a4d8f', { pasted: true })).toEqual([]);
    expect(detectSecrets('0b3c6c1e-6a52-4c1c-9a3f-3a1e2b4c5d6e', { pasted: true })).toEqual([]);
    expect(detectSecrets('bunu kasaya kaydet lütfen', { pasted: true })).toEqual([]);
  });

  it('never detects inside its own tokens', () => {
    const text = `${credentialToken('OPENAI_API_KEY')} token=${pastedSecretToken('pasted-1', 'openai')}`;
    expect(detectSecrets(text, { pasted: true })).toEqual([]);
  });

  it('a private key block is one finding', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----';
    const f = detectSecrets(`key:\n${pem}\nend`);
    expect(f).toHaveLength(1);
    expect(f[0]?.provider).toBe('private-key');
    expect(f[0]?.value).toBe(pem);
  });
});

describe('tokens', () => {
  it('replaces findings and segments the result into chips', () => {
    const text = `call it with ${OPENAI} now`;
    const out = replaceFindings(text, detectSecrets(text), (f, i) =>
      pastedSecretToken(`pasted-${String(i + 1)}`, f.provider),
    );
    expect(out).toBe('call it with {{secret:pasted-1:openai}} now');
    expect(out).not.toContain(OPENAI);
    const segs = segmentSecretTokens(
      `${out} via ${credentialToken('GITHUB_TOKEN')} ${removedSecretToken('jwt')}`,
    );
    expect(segs.filter((s) => s.kind !== 'text')).toEqual([
      { kind: 'secret', text: '{{secret:pasted-1:openai}}', handle: 'pasted-1', hint: 'openai' },
      { kind: 'credential', text: '{{credential:GITHUB_TOKEN}}', name: 'GITHUB_TOKEN' },
      { kind: 'secret', text: '{{secret:removed:jwt}}', handle: 'removed', hint: 'jwt' },
    ]);
    expect(credentialTokenNames('{{credential:A}} {{credential:B}} {{credential:A}}')).toEqual(['A', 'B']);
  });

  it('suggests free names and ids', () => {
    expect(suggestCredentialName('openai', [])).toBe('OPENAI_API_KEY');
    expect(suggestCredentialName('openai', ['openai_api_key'])).toBe('OPENAI_API_KEY_2');
    expect(suggestCredentialName('generic', ['API_KEY_1'])).toBe('API_KEY_2');
    expect(credentialIdFor('OPENAI_API_KEY')).toBe('openai-api-key');
    expect(credentialIdFor('_X')).toBe('x');
  });
});
