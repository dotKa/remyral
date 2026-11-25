import {
  Capability,
  type Arch,
  type CapabilityStatus,
  type OsFamily,
  type RuntimeCapabilities,
  type RuntimeKind,
} from '@remyral/protocol';
import type { z } from 'zod';
import { CapabilityUnsupportedError, VersionMismatchError } from './errors.js';

/** Kept as aliases of the protocol types; `safe_cancel` moved into protocol v1.0. */
export type AdapterCapability = Capability;
export const ADAPTER_CAPABILITIES: readonly AdapterCapability[] = Capability.options;

export type OsFamilyT = OsFamily;
export type ArchT = Arch;

/** ADR-0008: a capability set is valid only for this exact tuple. */
export interface CapabilityKey {
  readonly runtime: RuntimeKind;
  readonly version: string;
  readonly os: OsFamilyT;
  readonly arch: ArchT;
}

/** Anything other than `supported` must say why (shown to users as the disable reason). */
export type CapabilityEntry =
  | { readonly status: 'supported'; readonly reason?: string }
  | { readonly status: Exclude<CapabilityStatus, 'supported'>; readonly reason: string };

export interface CapabilitySet {
  readonly key: CapabilityKey;
  readonly capabilities: Readonly<Record<AdapterCapability, CapabilityEntry>>;
}

export const NOT_CONTRACT_TESTED = 'not yet contract-tested on this runtime/version/OS/arch';

/**
 * Builds a complete set. Capabilities not mentioned default to `unverified`:
 * silence is never interpreted as support.
 */
export function defineCapabilitySet(
  key: CapabilityKey,
  entries: Partial<Record<AdapterCapability, CapabilityEntry>>,
): CapabilitySet {
  const capabilities = {} as Record<AdapterCapability, CapabilityEntry>;
  for (const cap of ADAPTER_CAPABILITIES) {
    const entry = entries[cap];
    if (entry && entry.status !== 'supported' && entry.reason.trim() === '') {
      throw new TypeError(`capability ${cap}: status ${entry.status} requires a reason`);
    }
    capabilities[cap] = entry ?? { status: 'unverified', reason: NOT_CONTRACT_TESTED };
  }
  return Object.freeze({ key: Object.freeze({ ...key }), capabilities: Object.freeze(capabilities) });
}

/** Stable cache key; the master invalidates cached sets when any component changes. */
export function capabilityKeyId(key: CapabilityKey): string {
  return `${key.runtime}@${key.version}/${key.os}-${key.arch}`;
}

/** ADR-0008: only supported and degraded capabilities are offered. */
export function isOffered(entry: CapabilityEntry, opts: { allowUnverified?: boolean } = {}): boolean {
  if (entry.status === 'supported' || entry.status === 'degraded') return true;
  return entry.status === 'unverified' && opts.allowUnverified === true;
}

export interface RequireCapabilityOptions {
  /** ADR-0012 rule 1: unverified may be used only when policy explicitly allows it. */
  readonly allowUnverified?: boolean;
}

/** Throws a typed error instead of ever faking success for a missing capability. */
export function requireCapability(
  set: CapabilitySet,
  capability: AdapterCapability,
  opts: RequireCapabilityOptions = {},
): CapabilityEntry {
  const entry = set.capabilities[capability];
  if (!isOffered(entry, opts)) {
    throw new CapabilityUnsupportedError(
      set.key.runtime,
      capability,
      entry.status,
      entry.reason ?? 'not offered',
    );
  }
  return entry;
}

/**
 * ADR-0012 rule 1 (version gate). If the installed version differs from the
 * pin, every offered capability is downgraded to `unverified` — the contract
 * tests that justified `supported` ran against a different binary.
 */
export function applyVersionGate(set: CapabilitySet, pinnedVersion: string): CapabilitySet {
  if (set.key.version === pinnedVersion) return set;
  const reason = `installed version ${set.key.version} differs from pinned ${pinnedVersion}`;
  const entries: Partial<Record<AdapterCapability, CapabilityEntry>> = {};
  for (const cap of ADAPTER_CAPABILITIES) {
    const entry = set.capabilities[cap];
    entries[cap] = entry.status === 'unsupported' ? entry : { status: 'unverified', reason };
  }
  return defineCapabilitySet(set.key, entries);
}

/** Throws unless the version matches the pin (or policy explicitly allows unverified versions). */
export function assertPinnedVersion(
  runtime: RuntimeKind,
  pinnedVersion: string,
  actualVersion: string | undefined,
  opts: { allowUnpinned?: boolean } = {},
): void {
  if (actualVersion === pinnedVersion) return;
  if (opts.allowUnpinned === true && actualVersion !== undefined) return;
  throw new VersionMismatchError(runtime, pinnedVersion, actualVersion);
}

type ProtocolCapabilities = z.infer<typeof RuntimeCapabilities>['capabilities'];

/** Projection onto the protocol v1 CAPABILITIES payload (includes safe_cancel since protocol v1.0). */
export function toProtocolCapabilities(set: CapabilitySet): ProtocolCapabilities {
  const out: ProtocolCapabilities = {};
  for (const cap of Capability.options) {
    const entry = set.capabilities[cap];
    out[cap] =
      entry.reason === undefined ? { status: entry.status } : { status: entry.status, note: entry.reason };
  }
  return out;
}
