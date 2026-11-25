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

export const OPENCODE_PINNED_VERSION = '1.19.4';

/**
 * (os-arch) tuples on which the contract kit passed against the pinned
 * `opencode` binary (`test/opencode-real.test.ts`, scripted OpenAI-compatible
 * provider on loopback, no credentials), with the date (ADR-0008).
 */
export const OPENCODE_CONTRACT_TESTED: Readonly<Partial<Record<`${OsFamilyT}-${ArchT}`, string>>> = {
  'darwin-arm64': '2026-10-26',
};

const ARTIFACTS: CapabilityEntry = {
  status: 'unsupported',
  reason: 'the adapter exports no runtime artifacts; the worker collects the workspace git diff itself',
};

/** Capability decisions for OpenCode 1.19.4 (docs/design/p3-adapter-pi-opencode.md §6.4). */
export const OPENCODE_TESTED_CAPABILITIES: Readonly<Record<AdapterCapability, CapabilityEntry>> = {
  streaming: {
    status: 'supported',
    reason: 'part-level events from the /event stream (text deltas are aggregated per finished text part)',
  },
  interactive_prompt: {
    status: 'supported',
    reason:
      'follow-ups while busy are queued by `prompt_async` and delivered with the next model request of the running loop',
  },
  approval: {
    status: 'degraded',
    reason:
      'native permission ask/reply, but tool shells inherit the server password and could answer requests themselves (detected and failed, not prevented)',
  },
  cancel: {
    status: 'supported',
    reason: '`POST /session/{id}/abort`, then process-tree kill after the grace period',
  },
  resume: {
    status: 'degraded',
    reason:
      'same worker only: the session persists in the adapter-owned database and is re-prompted after a server restart',
  },
  cost_reporting: {
    status: 'degraded',
    reason:
      "OpenCode's price-table estimate per step (secret-ref); tokens only under local-login; accuracy against provider billing not verified",
  },
  artifacts: ARTIFACTS,
  safe_cancel: {
    status: 'degraded',
    reason:
      'abort kills the running bash tool; tool shells run in their own process group, so a forced stop also kills the groups snapshotted before the kill; processes that left the tree are reaped only by the sandbox',
  },
};

/** p17-runtime-verify: bump when the adapter's mapping changes — evidence of an older revision then expires. */
export const OPENCODE_ADAPTER_REVISION = `opencode-adapter/1+pin${OPENCODE_PINNED_VERSION}`;

export function opencodeCapabilities(version: string, os: OsFamilyT, arch: ArchT): CapabilitySet {
  const key = { runtime: 'opencode' as const, version, os, arch };
  const testedOn = OPENCODE_CONTRACT_TESTED[platformKey(os, arch)];
  if (testedOn === undefined) {
    const reason = `OpenCode ${OPENCODE_PINNED_VERSION} not contract-tested on ${platformKey(os, arch)} yet`;
    const entries: Partial<Record<AdapterCapability, CapabilityEntry>> = { artifacts: ARTIFACTS };
    for (const cap of Object.keys(OPENCODE_TESTED_CAPABILITIES) as AdapterCapability[]) {
      if (cap !== 'artifacts') entries[cap] = { status: 'unverified', reason };
    }
    return applyVersionGate(defineCapabilitySet(key, entries), OPENCODE_PINNED_VERSION);
  }
  return applyVersionGate(defineCapabilitySet(key, OPENCODE_TESTED_CAPABILITIES), OPENCODE_PINNED_VERSION);
}
