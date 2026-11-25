import { randomUUID } from 'node:crypto';
import { encodeHeader, isEmailAddress } from '../notifications/smtp.js';

/**
 * p16-doctor: the support report e-mail (RFC 5322 + MIME, RFC 2045/2046/2183): a UTF-8 text part and, when the bundle
 * fits the cap, the zip as an `application/zip` attachment — both base64 (no line-length or dot issues). Addresses are
 * checked (no header injection); the subject is an encoded word with control characters removed.
 */
export interface SupportMail {
  readonly from: string;
  readonly to: string;
  readonly cc: string | null;
  readonly subject: string;
  readonly text: string;
  readonly attachment: { readonly filename: string; readonly data: Buffer } | null;
  readonly reportId: string;
}

function b64Lines(data: Buffer): string {
  return (data.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

function rfc5322Date(d: Date): string {
  return d.toUTCString().replace('GMT', '+0000');
}

const FILENAME = /^[A-Za-z0-9._-]{1,100}$/;

export function buildSupportMail(m: SupportMail, now: Date = new Date()): string {
  for (const a of [m.from, m.to, ...(m.cc === null ? [] : [m.cc])])
    if (!isEmailAddress(a)) throw new Error('invalid e-mail address');
  if (m.attachment !== null && !FILENAME.test(m.attachment.filename))
    throw new Error('invalid attachment name');
  const boundary = `remyral-${randomUUID()}`;
  const headers = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    ...(m.cc === null ? [] : [`Cc: ${m.cc}`]),
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${rfc5322Date(now)}`,
    `Message-ID: <${randomUUID()}@remyral.support>`,
    'MIME-Version: 1.0',
    `X-Remyral-Support-Report: ${m.reportId}`,
  ];
  const textPart = b64Lines(Buffer.from(m.text.replace(/\r?\n/g, '\r\n'), 'utf8'));
  if (m.attachment === null) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      textPart,
      '',
    ].join('\r\n');
  }
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    'This is a multi-part message in MIME format.',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    textPart,
    `--${boundary}`,
    `Content-Type: application/zip; name="${m.attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${m.attachment.filename}"`,
    '',
    b64Lines(m.attachment.data),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
