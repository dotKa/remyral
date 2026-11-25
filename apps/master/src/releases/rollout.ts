import { createHash } from 'node:crypto';
import { compareReleaseVersions, ReleaseVersion, type ReleaseChannel } from '@remyral/protocol';

/**
 * Deterministic rollout bucket 0–99 for a worker and a release version: the first four bytes of
 * SHA-256(`remyral-rollout/v1\n<version>\n<workerId>`) mod 100. The same worker always lands in the same
 * bucket for a given release (raising the percentage only ever adds workers), while different releases
 * spread the risk over different subsets of the fleet.
 */
export function rolloutBucket(workerId: string, version: string): number {
  const digest = createHash('sha256').update(`remyral-rollout/v1\n${version}\n${workerId}`, 'utf8').digest();
  return digest.readUInt32BE(0) % 100;
}

export function inRollout(workerId: string, version: string, percent: number): boolean {
  return rolloutBucket(workerId, version) < percent;
}

export interface ChannelState {
  readonly version: string;
  readonly rolloutPercent: number;
}

export interface TargetState {
  readonly channel: ReleaseChannel;
  readonly targetVersion: string | null;
  readonly rollback: boolean;
  readonly force: boolean;
}

export interface DesiredUpdate {
  readonly version: string;
  readonly source: 'channel' | 'target';
  readonly rollback: boolean;
  readonly force: boolean;
}

/**
 * What a worker should run next, or null (pure; docs/design/p2-signed-updates.md "Rollout"):
 * - an explicit target pins the worker: offered when it differs from the current version; a lower
 *   target is only offered as an explicit rollback;
 * - otherwise the worker's channel offers its version to the workers in the rollout bucket, and only
 *   when it is newer — a channel never downgrades anyone.
 * A worker whose own version is not a semantic version (pre-release builds) counts as older.
 */
export function desiredUpdate(
  workerId: string,
  currentVersion: string,
  target: TargetState | null,
  channels: ReadonlyMap<ReleaseChannel, ChannelState>,
): DesiredUpdate | null {
  const current = ReleaseVersion.safeParse(currentVersion).success ? currentVersion : null;
  const newer = (v: string) => current === null || compareReleaseVersions(v, current) > 0;
  if (target?.targetVersion != null) {
    const v = target.targetVersion;
    if (v === current) return null;
    if (!newer(v) && !target.rollback) return null;
    return { version: v, source: 'target', rollback: target.rollback, force: target.force };
  }
  const channel = channels.get(target?.channel ?? 'stable');
  if (channel === undefined) return null;
  if (!inRollout(workerId, channel.version, channel.rolloutPercent)) return null;
  if (!newer(channel.version)) return null;
  return { version: channel.version, source: 'channel', rollback: false, force: false };
}
