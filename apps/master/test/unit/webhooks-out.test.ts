import { describe, expect, it } from 'vitest';
import { DEPLOY_KINDS, eventIdOf, SOURCE_ACTIONS } from '../../src/webhooks-out/catalog.js';
import { errorCodeOf } from '../../src/webhooks-out/sender.js';
import {
  hmacHex,
  newWebhookSecret,
  parseSignatureHeader,
  secretHint,
  signatureHeader,
  verifySignature,
} from '../../src/webhooks-out/signing.js';
import {
  headerNameProblem,
  headerValueProblem,
  internalOriginProblem,
  mustBeSecret,
  targetProblem,
} from '../../src/webhooks-out/targets.js';

/** p16-webhooks-out (docs/design/p16-webhooks-out.md): the pure parts — signing, the target floor, ids. */
describe('webhook signing', () => {
  const body = '{"id":"x","type":"job.failed"}';

  it('signs `<t>.<body>` with HMAC-SHA256 and verifies in a tolerance window', () => {
    const s = newWebhookSecret();
    expect(s).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const header = signatureHeader([s], 1_700_000_000, body);
    expect(header).toBe(`t=1700000000,v1=${hmacHex(s, 1_700_000_000, body)}`);
    expect(verifySignature(s, header, body, 1_700_000_100)).toBe(true);
    expect(verifySignature(s, header, body, 1_700_000_301)).toBe(false);
    expect(verifySignature(s, header, `${body} `, 1_700_000_000)).toBe(false);
    expect(verifySignature(newWebhookSecret(), header, body, 1_700_000_000)).toBe(false);
  });

  it('carries one v1 per active secret during a rotation; either verifies', () => {
    const a = newWebhookSecret();
    const b = newWebhookSecret();
    const header = signatureHeader([b, a], 1_700_000_000, body);
    expect(parseSignatureHeader(header)?.v1).toHaveLength(2);
    expect(verifySignature(a, header, body, 1_700_000_000)).toBe(true);
    expect(verifySignature(b, header, body, 1_700_000_000)).toBe(true);
  });

  it('refuses malformed headers and ignores unknown schemes', () => {
    expect(parseSignatureHeader('v1=abc')).toBeNull();
    expect(parseSignatureHeader('t=1,t=2,v1=' + 'a'.repeat(64))).toBeNull();
    expect(parseSignatureHeader('t=1,v1=xyz')).toBeNull();
    expect(parseSignatureHeader(`t=1,v2=zz,v1=${'a'.repeat(64)}`)?.v1).toHaveLength(1);
    expect(() => signatureHeader([], 1, body)).toThrow();
  });

  it('the hint never contains enough of the secret to sign', () => {
    const s = newWebhookSecret();
    const hint = secretHint(s);
    expect(hint.length).toBeLessThan(16);
    expect(s.startsWith(hint.slice(0, 8))).toBe(true);
  });
});

describe('webhook targets', () => {
  const none = new Set<string>();

  it('allows public https on 443 / 8443 only', () => {
    expect(targetProblem('https://hooks.example.com/x?y=1', none)).toBeNull();
    expect(targetProblem('https://hooks.example.com:8443/x', none)).toBeNull();
    expect(targetProblem('https://hooks.example.com:8080/x', none)).toBe('port_refused');
    expect(targetProblem('http://hooks.example.com/x', none)).toBe('not_https');
    expect(targetProblem('https://u:p@hooks.example.com/x', none)).toBe('credentials_in_url');
    expect(targetProblem('https://hooks.example.com/x#frag', none)).toBe('fragment');
    expect(targetProblem('not a url', none)).toBe('invalid_url');
    expect(targetProblem(`https://hooks.example.com/${'a'.repeat(2000)}`, none)).toBe('too_long');
  });

  it('refuses loopback, private, CGNAT, link-local / metadata, IPv6 internal and internal names', () => {
    for (const u of [
      'https://127.0.0.1/',
      'https://127.1/',
      'https://2130706433/',
      'https://0x7f000001/',
      'https://10.0.0.1/',
      'https://172.16.5.4/',
      'https://192.168.1.1/',
      'https://100.64.1.1/',
      'https://169.254.169.254/',
      'https://[::1]/',
      'https://[fd00::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://localhost/',
      'https://db.internal/',
      'https://metadata.google.internal/',
      'https://nas.lan/',
    ]) {
      expect(targetProblem(u, none), u).not.toBeNull();
    }
  });

  it('an exact internal origin lifts the address floor, never the https rule', () => {
    const internal = new Set(['https://10.0.0.5:9443']);
    expect(targetProblem('https://10.0.0.5:9443/hook', internal)).toBeNull();
    expect(targetProblem('https://10.0.0.5/hook', internal)).not.toBeNull();
    expect(internalOriginProblem('https://10.0.0.5:9443')).toBeNull();
    expect(internalOriginProblem('http://10.0.0.5:9443')).toBe('not_https');
    expect(internalOriginProblem('https://10.0.0.5:9443/x')).toBe('not_an_origin');
  });

  it('headers: reserved names, CR/LF, credential names must be secret', () => {
    expect(headerNameProblem('X-Team')).toBeNull();
    expect(headerNameProblem('Host')).toBe('reserved_name');
    expect(headerNameProblem('x-remyral-signature')).toBe('reserved_name');
    expect(headerNameProblem('Bad Name')).toBe('invalid_name');
    expect(headerValueProblem('a\r\nInjected: 1')).toBe('invalid_value');
    expect(headerValueProblem('')).toBe('invalid_value');
    expect(mustBeSecret('Authorization')).toBe(true);
    expect(mustBeSecret('X-Api-Key')).toBe(true);
    expect(mustBeSecret('X-Auth-Token')).toBe(true);
    expect(mustBeSecret('X-Team')).toBe(false);
  });
});

describe('webhook catalog plumbing', () => {
  it('event ids are stable per audit entry and type, and differ otherwise', () => {
    const a = eventIdOf('42', 'approval.decided');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(eventIdOf('42', 'approval.decided')).toBe(a);
    expect(eventIdOf('42', 'merge.decided')).not.toBe(a);
    expect(eventIdOf('43', 'approval.decided')).not.toBe(a);
  });

  it('reads only the audited actions it maps; deploys exclude DNS and tunnels', () => {
    expect(SOURCE_ACTIONS.has('job.transition')).toBe(true);
    expect(SOURCE_ACTIONS.has('webhook.create')).toBe(false);
    expect(DEPLOY_KINDS.has('coolify.deploy')).toBe(true);
    expect(DEPLOY_KINDS.has('dns.upsert')).toBe(false);
    expect(DEPLOY_KINDS.has('tunnel.open')).toBe(false);
  });

  it('maps socket errors to fixed codes', () => {
    const e = (code: string) => Object.assign(new Error('x'), { code });
    expect(errorCodeOf(e('EADDRREFUSED_REMYRAL'))).toBe('address_refused');
    expect(errorCodeOf(e('ENOTFOUND'))).toBe('dns');
    expect(errorCodeOf(e('DEPTH_ZERO_SELF_SIGNED_CERT'))).toBe('tls');
    expect(errorCodeOf(e('ECONNREFUSED'))).toBe('connect');
    expect(errorCodeOf(e('EPIPE'))).toBe('network');
  });
});
