import {
  Capability,
  CapabilityStatus,
  overlayCapabilityStatus,
  verificationKeyId,
  type VerificationKey,
} from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';

/**
 * p17-runtime-verify (docs/design/p17-runtime-verify.md §4): master-side evidence on top of the worker-reported static
 * capability status. Pure except {@link loadVerifiedIndex} / {@link cachedVerifiedIndex}.
 *
 * Per exact tuple (runtime, version, OS, arch, adapter revision) and capability, the most recent run that **decided**
 * it (passed / failed) counts — a later failure revokes an earlier pass, a skipped check changes nothing. The protocol's
 * `overlayCapabilityStatus` then applies: only `unverified` is lifted, at most to the adapter's declared status.
 */

export interface DecidedCapability {
  readonly outcome: 'passed' | 'failed';
  readonly reason: string;
  readonly at: string;
  readonly evidenceId: string;
  readonly workerId: string;
}

export type VerifiedIndex = ReadonlyMap<string, ReadonlyMap<Capability, DecidedCapability>>;

export const EMPTY_INDEX: VerifiedIndex = new Map();

/** Rows of runs, newest first → the index (pure; exported for tests). */
export function buildVerifiedIndex(
  rows: readonly (VerificationKey & {
    readonly evidenceId: string;
    readonly workerId: string;
    readonly finishedAt: string;
    readonly results: readonly unknown[];
  })[],
): VerifiedIndex {
  const sorted = [...rows].sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
  const out = new Map<string, Map<Capability, DecidedCapability>>();
  for (const r of sorted) {
    const id = verificationKeyId(r);
    let caps = out.get(id);
    if (caps === undefined) {
      caps = new Map();
      out.set(id, caps);
    }
    for (const raw of r.results) {
      const x = raw as { capability?: unknown; status?: unknown; reason?: unknown };
      const cap = Capability.safeParse(x.capability);
      if (!cap.success || (x.status !== 'passed' && x.status !== 'failed')) continue;
      if (caps.has(cap.data)) continue; // a newer run already decided it
      caps.set(cap.data, {
        outcome: x.status,
        reason: typeof x.reason === 'string' ? x.reason : '',
        at: r.finishedAt,
        evidenceId: r.evidenceId,
        workerId: r.workerId,
      });
    }
  }
  return out;
}

/**
 * The deciding results of the stored runs. Precedence is per tuple and capability, so Postgres picks, for every
 * (tuple, capability), the newest run that decided it (`DISTINCT ON`): at most one row per tuple and capability, and no
 * global row cap that would let many newer runs of other tuples push an old, still-deciding pass out.
 */
export async function loadVerifiedIndex(q: Queryable): Promise<VerifiedIndex> {
  const { rows } = await q.query<{
    id: string;
    worker_id: string;
    runtime: string;
    runtime_version: string;
    os: string;
    arch: string;
    adapter_version: string;
    finished_at: Date;
    result: unknown;
  }>(
    `SELECT DISTINCT ON (e.runtime, e.runtime_version, e.os, e.arch, e.adapter_version, x->>'capability')
            e.id::text AS id, e.worker_id, e.runtime, e.runtime_version, e.os, e.arch, e.adapter_version,
            e.finished_at, x AS result
       FROM runtime_capability_evidence e CROSS JOIN LATERAL jsonb_array_elements(e.results) AS x
      WHERE x->>'status' IN ('passed', 'failed')
      ORDER BY e.runtime, e.runtime_version, e.os, e.arch, e.adapter_version, x->>'capability',
               e.finished_at DESC, e.id DESC`,
  );
  return buildVerifiedIndex(
    rows.map((r) => ({
      evidenceId: r.id,
      workerId: r.worker_id,
      runtime: r.runtime,
      runtimeVersion: r.runtime_version,
      os: r.os,
      arch: r.arch,
      adapterVersion: r.adapter_version,
      finishedAt: r.finished_at.toISOString(),
      results: [r.result],
    })),
  );
}

const cache = new WeakMap<object, { readonly stamp: string; readonly index: VerifiedIndex }>();

/**
 * {@link loadVerifiedIndex} cached per pool (placement, the matrix poll, ASSIGN_JOB, the machine view). Each read
 * checks a cheap stamp (row count and the newest receipt) instead of rebuilding the index, so evidence stored by any
 * master instance — or a machine's evidence removed with it — shows at once.
 */
export async function cachedVerifiedIndex(q: Queryable): Promise<VerifiedIndex> {
  const { rows } = await q.query<{ stamp: string }>(
    `SELECT count(*)::text || '/' || COALESCE(max(received_at)::text, '-') AS stamp FROM runtime_capability_evidence`,
  );
  const stamp = rows[0]?.stamp ?? '';
  const hit = cache.get(q);
  if (hit?.stamp === stamp) return hit.index;
  const index = await loadVerifiedIndex(q);
  cache.set(q, { stamp, index });
  return index;
}

/** Drops the cached index of `q` (after this instance stored evidence). */
export function invalidateVerifiedIndex(q: Queryable): void {
  cache.delete(q);
}

/** A runtime as a worker reported it (worker_runtimes row + the machine's OS / arch). */
export interface ReportedRuntime {
  readonly runtime: string;
  readonly version: string;
  readonly os: string | null;
  readonly arch: string | null;
  /** Null: an older worker (no evidence applies). */
  readonly adapterVersion: string | null;
  /**
   * The adapter probe's version when the worker reports it (CAPABILITIES `evidenceVersion`; Claude Code with a
   * non-pinned SDK: `<cli>+sdk.<sdk>`) — the version of the evidence tuple. Null / absent: `version`.
   */
  readonly evidenceVersion?: string | null;
  readonly declared: Readonly<Record<string, unknown>> | null;
  readonly capabilities: Readonly<Record<string, unknown>> | null;
}

export interface EffectiveCapability {
  readonly capability: Capability;
  readonly reported: CapabilityStatus | 'unknown';
  readonly declared: CapabilityStatus | null;
  readonly effective: CapabilityStatus | 'unknown';
  /** Lifted by master-side evidence. */
  readonly verified: boolean;
  /** The deciding run for this tuple, if any (also a failure, which keeps it unverified and says why). */
  readonly decided: DecidedCapability | null;
  readonly note: string | null;
}

function status(v: unknown): CapabilityStatus | 'unknown' {
  const s = typeof v === 'object' && v !== null ? (v as { status?: unknown }).status : undefined;
  const p = CapabilityStatus.safeParse(s);
  return p.success ? p.data : 'unknown';
}

function noteOf(v: unknown): string | null {
  const n = typeof v === 'object' && v !== null ? (v as { note?: unknown }).note : undefined;
  return typeof n === 'string' ? n : null;
}

export function keyOf(r: ReportedRuntime): VerificationKey | null {
  if (r.adapterVersion === null || r.os === null || r.arch === null) return null;
  return {
    runtime: r.runtime,
    runtimeVersion: r.evidenceVersion ?? r.version,
    os: r.os,
    arch: r.arch,
    adapterVersion: r.adapterVersion,
  };
}

/** Per capability: reported, declared, effective and the deciding run. */
export function effectiveCapabilities(r: ReportedRuntime, index: VerifiedIndex): EffectiveCapability[] {
  const key = keyOf(r);
  const decided = key === null ? undefined : index.get(verificationKeyId(key));
  return Capability.options.map((capability) => {
    const raw = r.capabilities?.[capability];
    const reported = status(raw);
    const d = CapabilityStatus.safeParse(r.declared?.[capability]);
    const declared = d.success ? d.data : null;
    const run = decided?.get(capability) ?? null;
    if (reported === 'unknown' || key === null) {
      return {
        capability,
        reported,
        declared,
        effective: reported,
        verified: false,
        decided: run,
        note: noteOf(raw),
      };
    }
    const o = overlayCapabilityStatus({ reported, declared: declared ?? undefined, outcome: run?.outcome });
    return {
      capability,
      reported,
      declared,
      effective: o.status,
      verified: o.verified,
      decided: run,
      note: o.verified ? `verified by a panel run (${run?.at ?? ''})` : noteOf(raw),
    };
  });
}

/** The reported `capabilities` object with the overlay applied (same shape: `{ status, note? }`). */
export function overlaidCapabilities(
  r: ReportedRuntime,
  index: VerifiedIndex,
): Record<string, { status: string; note?: string; verified?: true }> {
  const out: Record<string, { status: string; note?: string; verified?: true }> = {};
  for (const [name, raw] of Object.entries(r.capabilities ?? {})) {
    const s = status(raw);
    if (s !== 'unknown') {
      const n = noteOf(raw);
      out[name] = n === null ? { status: s } : { status: s, note: n };
    }
  }
  for (const e of effectiveCapabilities(r, index)) {
    if (!e.verified) continue;
    out[e.capability] = { status: e.effective, note: e.note ?? 'verified', verified: true };
  }
  return out;
}

/** The capabilities evidence lifted on this machine (ASSIGN_JOB `execution.verifiedCapabilities`). */
export function verifiedList(r: ReportedRuntime, index: VerifiedIndex): Capability[] {
  return effectiveCapabilities(r, index)
    .filter((e) => e.verified)
    .map((e) => e.capability);
}
