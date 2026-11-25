import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isTlsMode, type TlsMode } from './domain.js';

/**
 * p17-domain-wizard §4: the files the master and a remyral-ctl host exchange (ADR-0063 amendment 2026-10-24).
 *
 * `<HOST_APPLIER_DIR>` (container `/run/remyral-host`, host `<data>/host`):
 * - `requests/` — writable by the master only (uid 10001): `domain-change.json` + `domain-change.sig.json`, a request
 *   signed with the master's lease-signing key under the domain {@link DOMAIN_CHANGE_CONTEXT}. The host (root) reads it,
 *   verifies the signature against the public half of `<data>/secrets/lease-signing.pem`, re-validates every field and
 *   consumes the nonce. Nothing else in the request is acted on: it carries data, never commands.
 * - `status/` — root-owned, read-only for the master: `applier.json` (heartbeat, every minute) and `domain-result.json`
 *   (the state of the last request: applying / applied / rolled_back / failed / refused).
 *
 * Both sides write pretty JSON with one string value per line (the host parses it with sed after the signature
 * verified); every value the master puts in is validated to contain no quote, backslash or control character.
 */

export const DOMAIN_CHANGE_CONTEXT = 'remyral-host-domain-change/v1';
export const DOMAIN_CHANGE_KIND = 'remyral-host-domain-change/v1';
export const APPLIER_KIND = 'remyral-host-applier/v1';
export const RESULT_KIND = 'remyral-host-domain-result/v1';
export const REQUEST_FILE = 'domain-change.json';
export const REQUEST_SIG_FILE = 'domain-change.sig.json';
export const HEARTBEAT_FILE = 'applier.json';
export const RESULT_FILE = 'domain-result.json';
const MAX_FILE_BYTES = 64 * 1024;

export interface DomainChangeRequestDoc {
  readonly kind: typeof DOMAIN_CHANGE_KIND;
  readonly id: string;
  readonly nonce: string;
  readonly domain: string;
  readonly tls: TlsMode;
  /** '' = keep the e-mail the host has stored. */
  readonly email: string;
  readonly previousDomain: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** `YYYY-MM-DDTHH:MM:SSZ` — the host compares these as strings with `date -u +%Y-%m-%dT%H:%M:%SZ`. */
export function isoSeconds(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

// eslint-disable-next-line no-control-regex
const SAFE = /^[^"\\\u0000-\u001f\u007f]*$/u;

/** The exact bytes of a request (fixed key order, two-space indent, trailing newline). */
export function requestBytes(doc: DomainChangeRequestDoc): Buffer {
  const ordered = {
    kind: doc.kind,
    id: doc.id,
    nonce: doc.nonce,
    domain: doc.domain,
    tls: doc.tls,
    email: doc.email,
    previousDomain: doc.previousDomain,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
  };
  for (const [k, v] of Object.entries(ordered)) {
    if (!SAFE.test(v)) throw new Error(`domain change request: unsafe ${k}`);
  }
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
}

export interface HostSigner {
  /** Ed25519 over `context + "\n"` ‖ bytes; base64url signature. */
  signHostDocument(context: string, bytes: Buffer): { kid: string; signature: string };
}

/** The signature file next to the request. */
export function signatureBytes(sig: { kid: string; signature: string }): Buffer {
  return Buffer.from(`${JSON.stringify({ keyId: sig.kid, signature: sig.signature }, null, 2)}\n`, 'utf8');
}

/** Writes `name` in `dir` atomically (temp file + rename), mode 0644. */
async function writeAtomic(dir: string, name: string, bytes: Buffer): Promise<void> {
  const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, bytes, { mode: 0o644, flag: 'wx' });
  try {
    await rename(tmp, join(dir, name));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Writes the signed request: signature first, request last (the host's path unit watches the request file). */
export async function writeRequest(
  requestsDir: string,
  doc: DomainChangeRequestDoc,
  signer: HostSigner,
): Promise<void> {
  await mkdir(requestsDir, { recursive: true });
  const bytes = requestBytes(doc);
  await writeAtomic(
    requestsDir,
    REQUEST_SIG_FILE,
    signatureBytes(signer.signHostDocument(DOMAIN_CHANGE_CONTEXT, bytes)),
  );
  await writeAtomic(requestsDir, REQUEST_FILE, bytes);
}

export async function removeRequest(requestsDir: string): Promise<void> {
  await rm(join(requestsDir, REQUEST_FILE), { force: true });
  await rm(join(requestsDir, REQUEST_SIG_FILE), { force: true });
}

/** The id of the request file still waiting in the requests directory (null: none / unreadable). */
export async function pendingRequestId(requestsDir: string): Promise<string | null> {
  const doc = await readJson(join(requestsDir, REQUEST_FILE));
  return doc !== null && typeof doc.id === 'string' ? doc.id : null;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const v: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The HTTPS port the host publishes ('' = the default 443). */
const Port = z
  .string()
  .regex(/^([1-9][0-9]{0,4})?$/)
  .transform((v) => (v === '' ? 443 : Number(v)))
  .refine((n) => n <= 65535);
const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

const HeartbeatSchema = z.object({
  kind: z.literal(APPLIER_KIND),
  version: z.string().max(64),
  at: Iso,
  domain: z.string().max(253),
  tls: z.string().refine(isTlsMode),
  acmeEmail: z.string().max(254).default(''),
  httpsPort: Port.optional(),
  addresses: z.array(z.string().max(64)).max(64).default([]),
});

export interface ApplierHeartbeat {
  readonly version: string;
  readonly at: Date;
  readonly domain: string;
  readonly tls: TlsMode;
  readonly acmeEmail: string | null;
  readonly httpsPort: number;
  readonly addresses: readonly string[];
}

export async function readHeartbeat(statusDir: string): Promise<ApplierHeartbeat | null> {
  const raw = await readJson(join(statusDir, HEARTBEAT_FILE));
  const p = HeartbeatSchema.safeParse(raw);
  if (!p.success) return null;
  const h = p.data;
  return {
    version: h.version,
    at: new Date(h.at),
    domain: h.domain,
    tls: h.tls,
    acmeEmail: h.acmeEmail === '' ? null : h.acmeEmail,
    httpsPort: h.httpsPort ?? 443,
    addresses: h.addresses,
  };
}

export const RESULT_STATES = ['applying', 'applied', 'rolled_back', 'failed', 'refused'] as const;
export type HostResultState = (typeof RESULT_STATES)[number];

const ResultSchema = z.object({
  kind: z.literal(RESULT_KIND),
  id: z.string().max(64),
  state: z.enum(RESULT_STATES),
  domain: z.string().max(253).default(''),
  detail: z.string().max(2000).default(''),
  at: Iso,
});

export interface HostResult {
  /** '' when the host could not attribute it (e.g. the signature did not verify). */
  readonly id: string;
  readonly state: HostResultState;
  readonly domain: string;
  readonly detail: string;
  readonly at: Date;
}

export async function readResult(statusDir: string): Promise<HostResult | null> {
  const p = ResultSchema.safeParse(await readJson(join(statusDir, RESULT_FILE)));
  if (!p.success) return null;
  return { ...p.data, detail: p.data.detail.slice(0, 500), at: new Date(p.data.at) };
}
