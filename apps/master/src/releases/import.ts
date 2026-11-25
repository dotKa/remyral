import { ReleaseChannel } from '@remyral/protocol';
import { AdminError } from '../cli/admin.js';
import { HttpError } from '../http/errors.js';
import type { InstallerService } from '../installers/service.js';
import { RELEASE_IMPORT_ACTOR } from './actor.js';
import { publishRelease, ReleaseDocument } from './routes.js';
import type { ReleaseService } from './service.js';
import { RELEASE_UPLOAD_BODY_LIMIT } from './uploads.js';

/**
 * p6-release-import: publish a signed `release.json` from the control-plane host (docs/ops/worker-updates.md
 * §2, "Publishing from the host"). The core of `dist/cli/release-import.js`, kept free of process I/O so
 * it is testable without spawning.
 *
 * Trust is exactly the console's: the document is parsed with the same {@link ReleaseDocument} schema and
 * goes through {@link publishRelease} (release signature against RELEASE_PUBLIC_KEYS, artifact integrity,
 * protocol, signed installer kits), audited `release.upload` with the system actor `release-import`.
 * The optional rollout is `ReleaseService.promote` — the method behind `PUT /releases/channels/:channel`
 * — audited `release.promote` with the same actor.
 */

/** The same ceiling as `POST /releases` and an assembled chunked upload. */
export const RELEASE_IMPORT_MAX_BYTES = RELEASE_UPLOAD_BODY_LIMIT;

export interface Rollout {
  readonly channel: ReleaseChannel;
  readonly rolloutPercent: number;
}

export interface ImportResult {
  readonly version: string;
  readonly created: boolean;
  /** The channel the release is signed for. */
  readonly channel: ReleaseChannel;
  readonly sha256: string;
  /** The channel promotion made after the import (`--rollout`), or null. */
  readonly rollout: Rollout | null;
}

/** Reads the whole input, refusing (without buffering further) once it exceeds `maxBytes`. */
export async function readCapped(
  input: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  maxBytes: number = RELEASE_IMPORT_MAX_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    total += b.byteLength;
    if (total > maxBytes) {
      throw new AdminError(
        `release.json is larger than ${String(maxBytes)} bytes (the upload limit of the console); refused`,
      );
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks, total);
}

/** `--rollout <channel>[:<percent>]` (percent 0–100, default 100 like the rollout route). */
export function parseRollout(spec: string): Rollout {
  const m = /^([a-z]+)(?::(\d{1,3}))?$/.exec(spec);
  const channel = ReleaseChannel.safeParse(m?.[1]);
  const percent = m?.[2] === undefined ? 100 : Number(m[2]);
  if (m === null || !channel.success || !Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new AdminError(
      `--rollout must be <channel>[:<percent>] with channel ${ReleaseChannel.options.join('|')} and percent 0-100 (got "${spec}")`,
    );
  }
  return { channel: channel.data, rolloutPercent: percent };
}

/** Parses the bytes as a signed release.json with the console's schema (nothing is verified yet). */
export function parseReleaseDocument(bytes: Buffer): ReleaseDocument {
  if (bytes.byteLength > RELEASE_IMPORT_MAX_BYTES) {
    throw new AdminError(`release.json is larger than ${String(RELEASE_IMPORT_MAX_BYTES)} bytes; refused`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new AdminError('the input is not JSON: expected a signed release.json (sign.mjs build) on stdin');
  }
  const doc = ReleaseDocument.safeParse(parsed);
  if (!doc.success) {
    throw new AdminError('the input is not a signed release.json document (manifest, signature, artifact)');
  }
  return doc.data;
}

/** A refusal of the master's verification, as an operator-facing message (code + public message). */
function refused(err: unknown, what: string): never {
  if (err instanceof HttpError) throw new AdminError(`${what} refused (${err.code}): ${err.publicMessage}`);
  throw err;
}

/** Verifies and stores the document exactly like the console upload, then optionally rolls it out. */
export async function importRelease(
  services: { readonly releases: ReleaseService; readonly installers: InstallerService | null },
  bytes: Buffer,
  opts: { readonly rollout?: Rollout | null } = {},
): Promise<ImportResult> {
  const doc = parseReleaseDocument(bytes);
  const { release, created } = await publishRelease(
    services.releases,
    services.installers,
    doc,
    RELEASE_IMPORT_ACTOR,
  ).catch((err: unknown) => refused(err, 'release'));
  let rollout: Rollout | null = null;
  if (opts.rollout != null) {
    const r = opts.rollout;
    const ch = await services.releases
      .promote(r.channel, release.version, r.rolloutPercent, RELEASE_IMPORT_ACTOR)
      .catch((err: unknown) => refused(err, `release ${release.version} imported, but the rollout was`));
    rollout = { channel: ch.channel, rolloutPercent: ch.rolloutPercent };
  }
  return { version: release.version, created, channel: release.channel, sha256: release.sha256, rollout };
}
