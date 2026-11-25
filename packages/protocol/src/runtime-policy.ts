import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RuntimeKind, Sha256Hex, withoutRetiredKeys } from './common.js';

/**
 * Runtime policy (p3-runtime-policy, docs/design/p3-runtime-policy.md): which runtimes a worker may run,
 * the exact version pinned per runtime (ADR-0012 rule 1), the auth modes allowed per runtime (ADR-0014)
 * and the model profiles jobs may choose. Authored and versioned on the master, delivered to workers inside
 * `UPDATE_POLICY` (additive in protocol 1.0) and enforced by the worker before it starts a runtime.
 *
 * Pure: schemas, consistency checks, the canonical document hash and model-profile resolution, shared by
 * master and worker so both judge a document identically.
 */

/** How a runtime authenticates on a worker (ADR-0014 §1). */
export const RuntimeAuthMode = z.enum(['secret-ref', 'local-login']);
export type RuntimeAuthMode = z.infer<typeof RuntimeAuthMode>;

/** Lower-case name: policy names, profile names, providers. */
export const PolicyName = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'lower-case name [a-z0-9_.-]');

/** An exact runtime version as the runtime reports it (no ranges: ADR-0012 pins are exact). */
export const PinnedVersion = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/, 'exact version such as 1.19.0');

const ProjectKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const ParamKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const ParamValue = z.union([z.string().max(256), z.number(), z.boolean()]);

/** A named model choice for one runtime: provider + model + runtime parameters (never credentials). */
export const ModelProfile = z.object({
  name: PolicyName,
  provider: PolicyName,
  model: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/, 'model id'),
  params: z.record(ParamKey, ParamValue),
});
export type ModelProfile = z.infer<typeof ModelProfile>;

/**
 * p17-update-channel (ADR-0065 §8): `follow` (also when absent) — the worker compares with its own effective pin (a
 * verified catalog version, else the release pin) and `version` only records what was current when the rule was
 * saved; `hold` — the owner's deliberate hold on exactly `version` (catalogs and releases do not move it).
 */
export const RuntimePinMode = z.enum(['follow', 'hold']);
export type RuntimePinMode = z.infer<typeof RuntimePinMode>;

export const RuntimePolicyRule = z.object({
  /**
   * With `pin: "hold"`: the exact version this runtime must report (anything else is `pinMismatch`, ADR-0008).
   * Otherwise the version that was current when the rule was saved (workers before p17-update-channel compare with it).
   */
  version: PinnedVersion,
  /** p17-update-channel: absent = `follow`. */
  pin: RuntimePinMode.optional(),
  /**
   * p17-update-channel: who held the version, when and why ("tutuluyor" in the console).
   * Display only — the worker ignores it.
   */
  hold: z
    .object({ by: z.string().min(1).max(64), at: z.string().max(40), note: z.string().max(300).optional() })
    .optional(),
  /** Auth modes the worker config may use for this runtime. */
  authModes: z.array(RuntimeAuthMode).min(1).max(2),
  /** Run even when the installed version differs from the pin (capabilities stay `unverified`). */
  allowUnpinned: z.boolean(),
  /**
   * ADR-0008: let jobs use capabilities the adapter reports `unverified` on this worker's OS/arch/version
   * (not contract-tested there). Additive in 1.0; absent = false. Never upgrades a capability to
   * `supported` — the CAPABILITIES report stays truthful.
   */
  allowUnverified: z.boolean().optional(),
  modelProfiles: z.array(ModelProfile).max(16),
  /** Required when profiles exist; null = the runtime's own default model and no profile choice. */
  defaultProfile: PolicyName.nullable(),
});
export type RuntimePolicyRule = z.infer<typeof RuntimePolicyRule>;

export const RuntimePolicyDocument = z.object({
  /** Allowed runtimes (a runtime that is absent is not allowed on workers under this policy). */
  /** ADR-0023: rules of retired runtimes in stored versions are dropped when parsed. */
  runtimes: withoutRetiredKeys(z.partialRecord(RuntimeKind, RuntimePolicyRule)),
  /** Projects may restrict further: project → runtime → allowed profile names (subset of the runtime's). */
  projectProfiles: z.record(
    ProjectKey,
    withoutRetiredKeys(z.partialRecord(RuntimeKind, z.array(PolicyName).max(16))),
  ),
});
export type RuntimePolicyDocument = z.infer<typeof RuntimePolicyDocument>;

/** What a worker receives: one exact policy version and the stage it was delivered at. */
export const RuntimePolicyDelivery = z.object({
  name: PolicyName,
  version: z.number().int().min(1),
  /** `canary`: a staged version delivered to canary workers only; `active`: the version for the group. */
  stage: z.enum(['active', 'canary']),
  documentHash: Sha256Hex,
  document: RuntimePolicyDocument,
});
export type RuntimePolicyDelivery = z.infer<typeof RuntimePolicyDelivery>;

/** The policy a worker has applied, reported in CAPABILITIES so the master can show and repair drift. */
export const AppliedRuntimePolicy = z.object({
  name: PolicyName,
  version: z.number().int().min(1),
  documentHash: Sha256Hex,
});
export type AppliedRuntimePolicy = z.infer<typeof AppliedRuntimePolicy>;

/** Upper bound of a document's canonical JSON (keeps UPDATE_POLICY far below MAX_FRAME_BYTES). */
export const MAX_RUNTIME_POLICY_BYTES = 32 * 1024;
export const MAX_PROJECT_RESTRICTIONS = 256;

export interface PolicyIssue {
  readonly path: string;
  readonly code: string;
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json | undefined };

/** Canonical JSON (sorted keys, no whitespace) — the hash input; identical on master and worker. */
export function canonicalPolicyJson(value: Json): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${(value as readonly Json[]).map(canonicalPolicyJson).join(',')}]`;
  const o = value as { readonly [k: string]: Json | undefined };
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalPolicyJson(o[k] as Json)}`).join(',')}}`;
}

/** Lowercase hex SHA-256 of the canonical JSON of a document. */
export function runtimePolicyHash(document: RuntimePolicyDocument): string {
  return createHash('sha256').update(canonicalPolicyJson(document), 'utf8').digest('hex');
}

/**
 * Consistency rules a schema cannot express. An empty result means the document is acceptable; the master
 * refuses to store, and the worker refuses to apply, a document with issues.
 */
export function runtimePolicyIssues(document: RuntimePolicyDocument): PolicyIssue[] {
  const out: PolicyIssue[] = [];
  for (const runtime of RuntimeKind.options) {
    const rule = document.runtimes[runtime];
    if (rule === undefined) continue;
    const base = `runtimes.${runtime}`;
    if (new Set(rule.authModes).size !== rule.authModes.length)
      out.push({ path: `${base}.authModes`, code: 'duplicate' });
    const names = rule.modelProfiles.map((p) => p.name);
    if (new Set(names).size !== names.length) out.push({ path: `${base}.modelProfiles`, code: 'duplicate' });
    if (rule.modelProfiles.length > 0 && rule.defaultProfile === null)
      out.push({ path: `${base}.defaultProfile`, code: 'required' });
    if (rule.defaultProfile !== null && !names.includes(rule.defaultProfile))
      out.push({ path: `${base}.defaultProfile`, code: 'unknown_profile' });
    rule.modelProfiles.forEach((p, i) => {
      if (Object.keys(p.params).length > 16)
        out.push({ path: `${base}.modelProfiles.${String(i)}.params`, code: 'too_many' });
    });
  }
  const projects = Object.keys(document.projectProfiles);
  if (projects.length > MAX_PROJECT_RESTRICTIONS) out.push({ path: 'projectProfiles', code: 'too_many' });
  for (const project of projects.sort()) {
    const byRuntime = document.projectProfiles[project] ?? {};
    for (const runtime of RuntimeKind.options) {
      const allowed = byRuntime[runtime];
      if (allowed === undefined) continue;
      const path = `projectProfiles.${project}.${runtime}`;
      const rule = document.runtimes[runtime];
      if (rule === undefined) {
        out.push({ path, code: 'runtime_not_allowed' });
        continue;
      }
      if (allowed.length === 0) out.push({ path, code: 'empty' });
      if (new Set(allowed).size !== allowed.length) out.push({ path, code: 'duplicate' });
      const names = new Set(rule.modelProfiles.map((p) => p.name));
      if (allowed.some((n) => !names.has(n))) out.push({ path, code: 'unknown_profile' });
    }
  }
  if (Buffer.byteLength(canonicalPolicyJson(document), 'utf8') > MAX_RUNTIME_POLICY_BYTES)
    out.push({ path: '', code: 'too_large' });
  return out;
}

export type ProfileResolution =
  | { readonly ok: true; readonly profile: ModelProfile | null }
  | {
      readonly ok: false;
      readonly code: 'runtime_not_allowed' | 'model_profile_not_allowed' | 'model_profile_unknown';
      readonly message: string;
    };

/**
 * The model profile a job of `project` gets on `runtime`: the requested one if the runtime offers it and the
 * project does not exclude it; without a request, the runtime default (or, when the project excludes the
 * default, the project's first allowed profile). `profile: null` = the runtime has no profiles (its own
 * default model is used and no choice is possible).
 */
export function resolveModelProfile(
  document: RuntimePolicyDocument,
  runtime: RuntimeKind,
  project: string,
  requested?: string | null,
): ProfileResolution {
  const rule = document.runtimes[runtime];
  if (rule === undefined)
    return {
      ok: false,
      code: 'runtime_not_allowed',
      message: `${runtime} is not allowed by the runtime policy`,
    };
  const req = requested ?? null;
  if (rule.modelProfiles.length === 0) {
    return req === null
      ? { ok: true, profile: null }
      : {
          ok: false,
          code: 'model_profile_unknown',
          message: `${runtime} has no model profiles; "${req}" unknown`,
        };
  }
  const restriction = document.projectProfiles[project]?.[runtime];
  const allowed = rule.modelProfiles.filter((p) => restriction === undefined || restriction.includes(p.name));
  if (req !== null) {
    if (!rule.modelProfiles.some((p) => p.name === req))
      return {
        ok: false,
        code: 'model_profile_unknown',
        message: `model profile "${req}" is not defined for ${runtime}`,
      };
    const hit = allowed.find((p) => p.name === req);
    return hit === undefined
      ? {
          ok: false,
          code: 'model_profile_not_allowed',
          message: `project ${project} does not allow model profile "${req}" on ${runtime}`,
        }
      : { ok: true, profile: hit };
  }
  const fallback = allowed.find((p) => p.name === rule.defaultProfile) ?? allowed[0];
  return fallback === undefined
    ? {
        ok: false,
        code: 'model_profile_not_allowed',
        message: `project ${project} allows no model profile on ${runtime}`,
      }
    : { ok: true, profile: fallback };
}

/** p17-update-channel: whether a rule holds its runtime at exactly `rule.version` (absent / `follow`: no). */
export function ruleHoldsVersion(rule: Pick<RuntimePolicyRule, 'pin'> | undefined): boolean {
  return rule?.pin === 'hold';
}
