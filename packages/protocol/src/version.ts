import { z } from 'zod';

/** Protocol versions are MAJOR.MINOR (ADR-0011). */
export const ProtocolVersion = z.string().regex(/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/, 'MAJOR.MINOR');
export type ProtocolVersion = z.infer<typeof ProtocolVersion>;

export const PROTOCOL_VERSION = '1.0' satisfies ProtocolVersion;

/** Versions this build can speak, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly ProtocolVersion[] = [PROTOCOL_VERSION];

function parse(version: ProtocolVersion): [number, number] {
  const [major, minor] = version.split('.').map(Number);
  return [major ?? 0, minor ?? 0];
}

/**
 * Picks the highest version both peers speak (ADR-0011 handshake).
 * Returns `undefined` when there is none, in which case the master answers
 * with an ERROR carrying `code: 'upgrade_required'`.
 */
export function negotiateProtocolVersion(
  offered: readonly ProtocolVersion[],
  supported: readonly ProtocolVersion[] = SUPPORTED_PROTOCOL_VERSIONS,
): ProtocolVersion | undefined {
  const ours = new Set(supported);
  return offered
    .filter((v) => ours.has(v))
    .sort((a, b) => {
      const [aMajor, aMinor] = parse(a);
      const [bMajor, bMinor] = parse(b);
      return bMajor - aMajor || bMinor - aMinor;
    })[0];
}
