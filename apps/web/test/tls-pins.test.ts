import { describe, expect, it } from 'vitest';
import { formatFingerprint, untrustedCertificate } from '../src/api/tls-pins';
import { describeReason } from '../src/lib/reasons';

describe('p22-runtime-diagnostics: console side', () => {
  const sha = 'ab'.repeat(32);
  it('offers to trust only a tls_untrusted report with a fingerprint', () => {
    const params = { cause: 'tls_untrusted', host: 'nas.example.com', port: 8443, certSha256: sha };
    expect(untrustedCertificate('http_error', params)).toEqual({
      host: 'nas.example.com',
      port: 8443,
      sha256: sha,
      mismatch: false,
    });
    expect(untrustedCertificate('http_error', { ...params, pinMismatch: 1 })?.mismatch).toBe(true);
    expect(untrustedCertificate('dns_failed', params)).toBeNull();
    expect(untrustedCertificate('http_error', { ...params, certSha256: 'x' })).toBeNull();
    expect(formatFingerprint('ab01')).toBe('AB:01');
  });

  it('says crash causes, certificates and DNS failures in TR and EN', () => {
    const crash = 'runtime_crashed: claude-code: runtime crashed (signal SIGKILL): x (cause: killed)';
    expect(describeReason(crash, {}, { locale: 'en', params: { cause: 'killed' } }).sentence).toContain(
      'killed by the system',
    );
    expect(
      describeReason(crash, {}, { locale: 'tr', params: { cause: 'out_of_memory' } }).sentence,
    ).toContain('belleği yetmediği');
    expect(
      describeReason('dns_failed: a.example.com does not resolve', {}, { locale: 'en' }).sentence,
    ).toContain('Cloudflare');
    expect(
      describeReason('dns_failed: x', {}, { locale: 'tr', params: { cause: 'preview_stopped' } }).sentence,
    ).toContain('önizleme');
    expect(
      describeReason('http_error: request failed', {}, { locale: 'en', params: { cause: 'tls_untrusted' } })
        .sentence,
    ).toContain('trust this certificate');
  });
});
