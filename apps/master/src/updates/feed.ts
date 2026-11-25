import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';

/**
 * p16-selfhost-onboarding §4 (ADR-0063): the signed control-plane update feed, written by
 * `scripts/release/control-plane.mjs feed` and read here for the owners' "Güncelleme mevcut" banner. Pure: parse,
 * verify, compare. A feed is accepted only with a valid Ed25519 signature (domain `remyral-control-plane-feed/v1`) by
 * one of CONTROL_PLANE_RELEASE_KEYS — an unsigned or foreign feed never shows a banner (it could point an owner at a
 * fake release). The upgrade itself verifies the release manifest again on the host (remyral-ctl).
 */

export const FEED_CONTEXT = 'remyral-control-plane-feed/v1\n';
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
export const FEED_MAX_BYTES = 1024 * 1024;

const Semver = z.string().regex(SEMVER);
export const FeedRelease = z.object({
  version: Semver,
  publishedAt: z.string().max(40),
  minWorkerVersion: Semver,
  migrationsHead: z.string().regex(/^\d{4}$/),
  breaking: z.array(z.string().max(500)).max(50),
  summary: z.string().max(300),
  notes: z.string().max(8000),
});
export type FeedRelease = z.infer<typeof FeedRelease>;

export const Feed = z.object({
  schema: z.literal(1),
  name: z.literal('remyral-control-plane'),
  channel: z.enum(['stable', 'canary']),
  generatedAt: z.string().max(40),
  releases: z.array(FeedRelease).max(500),
});
export type Feed = z.infer<typeof Feed>;

const Signature = z.object({ keyId: z.string().regex(/^[0-9a-f]{16}$/), signature: z.string().max(200) });

export type FeedFailure = 'malformed' | 'unknown_key' | 'bad_signature' | 'too_large';

export class FeedError extends Error {
  override name = 'FeedError';
  constructor(readonly code: FeedFailure) {
    super(`update feed rejected: ${code}`);
  }
}

export const keyIdOf = (pub: string): string =>
  createHash('sha256').update(Buffer.from(pub, 'base64url')).digest('hex').slice(0, 16);

/** Verifies `bytes` (the exact feed.json) and its signature document; returns the parsed feed. */
export function verifyFeed(bytes: Buffer, signatureText: string, keys: readonly string[]): Feed {
  if (bytes.byteLength > FEED_MAX_BYTES) throw new FeedError('too_large');
  let sig: z.infer<typeof Signature>;
  try {
    sig = Signature.parse(JSON.parse(signatureText));
  } catch {
    throw new FeedError('malformed');
  }
  const key = keys.find((k) => KEY.test(k) && keyIdOf(k) === sig.keyId);
  if (key === undefined) throw new FeedError('unknown_key');
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' });
  const ok = verify(
    null,
    Buffer.concat([Buffer.from(FEED_CONTEXT, 'utf8'), bytes]),
    pub,
    Buffer.from(sig.signature, 'base64url'),
  );
  if (!ok) throw new FeedError('bad_signature');
  try {
    return Feed.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new FeedError('malformed');
  }
}

/** -1 / 0 / 1 (numeric x.y.z; a pre-release sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new RangeError(`not a semantic version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  const ra = pa[4] ?? '';
  const rb = pb[4] ?? '';
  if (ra === rb) return 0;
  if (ra === '') return 1;
  if (rb === '') return -1;
  return ra < rb ? -1 : 1;
}

/** Releases newer than `current`, newest first (all of them when the installed version is unknown). */
export function newerReleases(feed: Feed, current: string | null): FeedRelease[] {
  return [...feed.releases]
    .sort((a, b) => compareVersions(b.version, a.version))
    .filter((r) => current === null || compareVersions(r.version, current) > 0);
}
