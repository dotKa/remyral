import {
  applyVersionGate,
  defineCapabilitySet,
  type AdapterCapability,
  type ArchT,
  type CapabilityEntry,
  type CapabilitySet,
  type OsFamilyT,
} from '../../capabilities.js';
import { platformKey } from '../common/platform.js';

export const PI_PINNED_VERSION = '1.6.0';

/**
 * (os-arch) tuples on which the contract kit passed against the pinned Pi
 * binary (`test/pi-real.test.ts`, scripted provider, no credentials), with the
 * date. ADR-0008: only these get `supported`/`degraded`; every other tuple is
 * `unverified` until the suite has run there.
 */
export const PI_CONTRACT_TESTED: Readonly<Partial<Record<`${OsFamilyT}-${ArchT}`, string>>> = {
  'darwin-arm64': '2026-11-26',
};

const ARTIFACTS: CapabilityEntry = {
  status: 'unsupported',
  reason: 'Pi has no artifact API; the worker collects the workspace git diff itself',
};

/** Capability decisions for Pi 1.6.0 (docs/design/p3-adapter-pi-opencode.md §4). */
export const PI_TESTED_CAPABILITIES: Readonly<Record<AdapterCapability, CapabilityEntry>> = {
  streaming: {
    status: 'supported',
    reason: 'message-level events (token deltas are aggregated into one message per assistant response)',
  },
  interactive_prompt: {
    status: 'supported',
    reason: 'follow-ups while a run is active are sent as Pi `steer`; a settled run ends the session',
  },
  approval: {
    status: 'degraded',
    reason:
      "not native: provided by the worker's Pi permission-gate extension (tool calls only, denied on timeout/error); containment relies on the sandbox",
  },
  cancel: {
    status: 'supported',
    reason: 'RPC `clear_queue` + `abort`, then process-tree kill after the grace period',
  },
  resume: {
    status: 'degraded',
    reason:
      'same worker only: respawn with `--session-id` on the transcript kept in the adapter state directory',
  },
  cost_reporting: {
    status: 'degraded',
    reason:
      'Pi computes cost from its model catalogue (an estimate, not provider billing); under local-login only tokens are reported',
  },
  artifacts: ARTIFACTS,
  safe_cancel: {
    status: 'degraded',
    reason:
      "abort kills the bash tool's process group; a forced stop kills Pi's group and the tool groups snapshotted before the kill; processes that left the tree are reaped only by the sandbox",
  },
};

/** p17-runtime-verify: bump when the adapter's mapping changes — evidence of an older revision then expires. */
export const PI_ADAPTER_REVISION = `pi-adapter/1+pin${PI_PINNED_VERSION}`;

export function piCapabilities(version: string, os: OsFamilyT, arch: ArchT): CapabilitySet {
  const key = { runtime: 'pi' as const, version, os, arch };
  const testedOn = PI_CONTRACT_TESTED[platformKey(os, arch)];
  if (testedOn === undefined) {
    const reason = `Pi ${PI_PINNED_VERSION} not contract-tested on ${platformKey(os, arch)} yet`;
    const entries: Partial<Record<AdapterCapability, CapabilityEntry>> = { artifacts: ARTIFACTS };
    for (const cap of Object.keys(PI_TESTED_CAPABILITIES) as AdapterCapability[]) {
      if (cap !== 'artifacts') entries[cap] = { status: 'unverified', reason };
    }
    return applyVersionGate(defineCapabilitySet(key, entries), PI_PINNED_VERSION);
  }
  return applyVersionGate(defineCapabilitySet(key, PI_TESTED_CAPABILITIES), PI_PINNED_VERSION);
}
