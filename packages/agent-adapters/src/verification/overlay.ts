import { evidenceApplies } from '@remyral/protocol';
import {
  ADAPTER_CAPABILITIES,
  type AdapterCapability,
  type CapabilityEntry,
  type CapabilitySet,
  defineCapabilitySet,
} from '../capabilities.js';
import { adapterRevision, declaredCapabilities } from './declared.js';

/**
 * p17-runtime-verify: master-side evidence for one attempt (ASSIGN_JOB `execution.verifiedCapabilities`). An adapter
 * created with it lifts exactly these capabilities from `unverified` to its declared status — only when the tuple is
 * the one it probed (version, OS, arch) and the revision is its own. The worker's CAPABILITIES come from the reference
 * instance without an overlay, so the reported static table stays truthful.
 */
export interface VerifiedOverlay {
  readonly runtimeVersion: string;
  readonly os: string;
  readonly arch: string;
  readonly adapterVersion: string;
  readonly capabilities: readonly AdapterCapability[];
}

/**
 * Whether `overlay` names exactly the tuple of `set` (the probe's runtime, version, OS, arch) and this build's adapter
 * revision — the protocol's {@link evidenceApplies}. The worker's runtime gate decides with the same function.
 */
export function verifiedOverlayApplies(set: CapabilitySet, overlay: VerifiedOverlay): boolean {
  const k = set.key;
  return evidenceApplies(
    {
      runtime: k.runtime,
      runtimeVersion: overlay.runtimeVersion,
      os: overlay.os,
      arch: overlay.arch,
      adapterVersion: overlay.adapterVersion,
    },
    {
      runtime: k.runtime,
      runtimeVersion: k.version,
      os: k.os,
      arch: k.arch,
      adapterVersion: adapterRevision(k.runtime),
    },
  );
}

export function applyVerifiedOverlay(
  set: CapabilitySet,
  overlay: VerifiedOverlay | undefined,
): CapabilitySet {
  if (overlay === undefined || !verifiedOverlayApplies(set, overlay)) return set;
  const k = set.key;
  const declared = declaredCapabilities(k.runtime);
  const entries: Partial<Record<AdapterCapability, CapabilityEntry>> = {};
  for (const cap of ADAPTER_CAPABILITIES) {
    const current = set.capabilities[cap];
    const d = declared[cap];
    entries[cap] =
      current.status === 'unverified' &&
      overlay.capabilities.includes(cap) &&
      (d.status === 'supported' || d.status === 'degraded')
        ? {
            status: d.status,
            reason: `verified on ${k.os}-${k.arch} by a panel verification run (${d.reason ?? 'as declared'})`,
          }
        : current;
  }
  return defineCapabilitySet(k, entries);
}
