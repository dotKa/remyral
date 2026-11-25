import { describe, expect, it } from 'vitest';
import { previewStoppedParams } from '../../src/jobs/query.js';
import { untrustedCertificateOf } from '../../src/tls-pins/service.js';

describe('p22-runtime-diagnostics: the certificate a failed job reported', () => {
  const sha = 'ab'.repeat(32);
  const params = {
    cause: 'tls_untrusted',
    tlsCode: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    host: 'nas.example.com',
    port: 8443,
  };

  it('reads a tls_untrusted report with its fingerprint', () => {
    expect(untrustedCertificateOf('http_error', { ...params, certSha256: sha })).toEqual({
      host: 'nas.example.com',
      port: 8443,
      sha256: sha,
      tlsCode: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
  });

  it('refuses anything else (no pin from a malformed or foreign report)', () => {
    expect(untrustedCertificateOf('http_error', params)).toBeNull();
    expect(untrustedCertificateOf('dns_failed', { ...params, certSha256: sha })).toBeNull();
    expect(untrustedCertificateOf('http_error', { ...params, certSha256: sha, cause: 'other' })).toBeNull();
    expect(untrustedCertificateOf('http_error', { ...params, certSha256: 'AB'.repeat(32) })).toBeNull();
    expect(untrustedCertificateOf('http_error', { ...params, certSha256: sha, host: 'Bad Host' })).toBeNull();
    expect(untrustedCertificateOf('http_error', { ...params, certSha256: sha, port: 70_000 })).toBeNull();
    expect(untrustedCertificateOf('http_error', null)).toBeNull();
  });
});

describe('p22-runtime-diagnostics: a stopped preview address', () => {
  it('turns dns_failed into preview_stopped only when the master knows the tunnel is stopped', () => {
    expect(previewStoppedParams({ host: 'a.example.com' }, false)).toEqual({ host: 'a.example.com' });
    expect(previewStoppedParams({ host: 'a.example.com' }, true)).toEqual({
      host: 'a.example.com',
      cause: 'preview_stopped',
    });
    expect(previewStoppedParams(null, true)).toEqual({ cause: 'preview_stopped' });
  });
});
