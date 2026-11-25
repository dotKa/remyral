/**
 * p17-domain-wizard: the validation rules a console domain change must pass — on the master (the wizard's form) and,
 * identically, on the host (`remyral-ctl apply-pending` re-checks every field of a signed request with the same
 * expressions as `remyral-ctl install --domain/--tls/--email`). A compromised master can only ask for a domain within
 * these rules (ADR-0063 amendment 2026-10-24).
 */

export const TLS_MODES = ['letsencrypt', 'cloudflare', 'proxy'] as const;
export type TlsMode = (typeof TLS_MODES)[number];

export function isTlsMode(v: unknown): v is TlsMode {
  return typeof v === 'string' && (TLS_MODES as readonly string[]).includes(v);
}

const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
/** The exact expression of `remyral-ctl install --domain` (lower-case DNS name with at least one dot). */
export const DOMAIN_RE = new RegExp(`^${LABEL}(\\.${LABEL})+$`);
/** An ACME contact address: the characters `remyral-ctl` accepts and can write into its files without quoting. */
export const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;

export class ConsoleDomainError extends Error {
  override name = 'ConsoleDomainError';
  constructor(
    readonly code:
      | 'invalid_domain'
      | 'invalid_email'
      | 'email_required'
      | 'letsencrypt_needs_standard_ports'
      | 'domain_change_in_progress'
      | 'domain_unchanged'
      | 'host_applier_unavailable'
      | 'no_pending_request',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The domain of what the owner typed: trimmed, lower-cased; a pasted origin (`https://name/`) is reduced to its name.
 * Refuses ports, paths, user info, IP addresses, wildcards, single labels and names over 253 characters.
 */
export function normaliseDomain(input: string): string {
  let d = input.trim().toLowerCase();
  if (d.startsWith('https://')) d = d.slice('https://'.length);
  if (d.endsWith('/')) d = d.slice(0, -1);
  if (d.endsWith('.')) d = d.slice(0, -1);
  const last = d.split('.').at(-1) ?? '';
  if (d.length < 4 || d.length > 253 || !DOMAIN_RE.test(d) || /^[0-9]+$/.test(last)) {
    throw new ConsoleDomainError(
      'invalid_domain',
      'Enter a domain name such as remyral.example.com (no https://, port or path).',
    );
  }
  return d;
}

export function normaliseEmail(input: string): string {
  const e = input.trim();
  if (e.length > 254 || !EMAIL_RE.test(e)) {
    throw new ConsoleDomainError('invalid_email', 'Enter a valid e-mail address for Let’s Encrypt.');
  }
  return e;
}

/** `https://<domain>` with the HTTPS port when it is not 443. */
export function originFor(domain: string, httpsPort: number | null): string {
  return httpsPort === null || httpsPort === 443
    ? `https://${domain}`
    : `https://${domain}:${String(httpsPort)}`;
}
