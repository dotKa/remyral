import type { ReasonParams } from '@remyral/protocol/reasons';
import { apiRequest, obj, type RequestOptions } from './client';

/**
 * p22-runtime-diagnostics: a project's trusted (pinned) certificates for its function jobs' HTTPS requests. A pin is
 * created only from a failed job of the project that reported the certificate (`http_error`, cause `tls_untrusted`) —
 * the console sends the job id, never a fingerprint (the master reads it from the job's report). Project admin,
 * step-up, audited.
 */

export interface TlsPin {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly sha256: string;
}

export interface UntrustedCertificate {
  readonly host: string;
  readonly port: number;
  readonly sha256: string;
  /** The project already trusts another certificate for this address (the server's changed). */
  readonly mismatch: boolean;
}

/** The refused certificate of a JOB_RESULT error (`http_error` + `tls_untrusted` + fingerprint), else null. */
export function untrustedCertificate(
  code: string | null | undefined,
  params: ReasonParams | null | undefined,
): UntrustedCertificate | null {
  if (code !== 'http_error' || params === null || params === undefined) return null;
  if (params.cause !== 'tls_untrusted') return null;
  const { host, port, certSha256 } = params;
  if (typeof host !== 'string' || typeof port !== 'number' || typeof certSha256 !== 'string') return null;
  if (!/^[0-9a-f]{64}$/.test(certSha256)) return null;
  return { host, port, sha256: certSha256, mismatch: params.pinMismatch === 1 };
}

function parsePins(body: unknown): TlsPin[] {
  const b = obj(body);
  const pins = Array.isArray(b.pins) ? b.pins : [];
  return pins.flatMap((p: unknown) => {
    const o = obj(p);
    return typeof o.id === 'string' &&
      typeof o.host === 'string' &&
      typeof o.port === 'number' &&
      typeof o.sha256 === 'string'
      ? [{ id: o.id, host: o.host, port: o.port, sha256: o.sha256 }]
      : [];
  });
}

/** "Trust this certificate": pins the certificate the latest attempt of `jobId` reported. */
export function trustCertificateOfJob(
  project: string,
  jobId: string,
  opts: Pick<RequestOptions, 'signal'> = {},
): Promise<TlsPin[]> {
  return apiRequest('POST', `/projects/${encodeURIComponent(project)}/tls-pins`, parsePins, {
    ...opts,
    body: { jobId },
  });
}

/** `aa:bb:…` groups of the fingerprint, for reading it aloud / comparing. */
export function formatFingerprint(sha256: string): string {
  return (sha256.match(/.{2}/g) ?? []).join(':').toUpperCase();
}
