import { z } from 'zod';
import { RuntimeKind } from './common.js';
import { type ModelProfile, PolicyName } from './runtime-policy.js';
import { CredentialRef, ModelId } from './worker-config.js';

/**
 * Model catalog (p5-credentials-models, docs/design/p5-credentials-models.md §3): the master-wide registry of
 * model profiles. It does not replace the runtime policy's per-runtime `modelProfiles` (what a worker
 * enforces); it is their source:
 *
 *  - a runtime-policy profile whose name is a catalog id is the catalog entry projected onto that runtime
 *    ({@link catalogProfile}); the master refuses a policy whose such profile disagrees with the catalog;
 *  - a worker configuration's `runtimes.<kind>.modelProfile` names a catalog id; the master resolves it into
 *    that runtime's concrete settings ({@link catalogSettings}) when it builds the delivered document;
 *  - the composer offers catalog profiles valid for the chosen runtime and workers.
 *
 * Never holds a credential value: `credentialRef` is a reference (worker-store name or vault id).
 */

const ParamKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const ParamValue = z.union([z.string().max(256), z.number(), z.boolean()]);

export const ModelLimits = z.object({
  contextWindow: z.number().int().min(1).max(100_000_000).optional(),
  maxInputTokens: z.number().int().min(1).max(100_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(100_000_000).optional(),
});

/** Pricing hints in USD per million tokens (informational; usage records stay authoritative). */
export const ModelPricing = z.object({
  inputPerMTok: z.number().min(0).max(100_000).optional(),
  outputPerMTok: z.number().min(0).max(100_000).optional(),
  cachedInputPerMTok: z.number().min(0).max(100_000).optional(),
});

export const ModelCatalogEntryInput = z.object({
  id: PolicyName,
  displayName: z.string().min(1).max(128),
  description: z.string().max(500).optional(),
  /** Runtimes this profile can be used with (each projects it differently, see {@link catalogSettings}). */
  runtimes: z.array(RuntimeKind).min(1).max(RuntimeKind.options.length),
  provider: PolicyName,
  model: ModelId,
  /** The credential the runtime uses with this profile when its own auth is not set (reference only). */
  credentialRef: CredentialRef.optional(),
  // ADR-0023: `baseUrl` and `headers` (OpenHands LiteLLM only) were removed with OpenHands.
  /** Runtime parameters (same shape as a runtime-policy profile's `params`). */
  params: z.record(ParamKey, ParamValue).default({}),
  limits: ModelLimits.default({}),
  pricing: ModelPricing.default({}),
  enabled: z.boolean(),
});
export type ModelCatalogEntryInput = z.infer<typeof ModelCatalogEntryInput>;

export interface CatalogIssue {
  readonly path: string;
  readonly code: string;
}

/** Consistency rules beyond the schema. */
export function catalogEntryIssues(e: ModelCatalogEntryInput): CatalogIssue[] {
  const out: CatalogIssue[] = [];
  if (new Set(e.runtimes).size !== e.runtimes.length) out.push({ path: 'runtimes', code: 'duplicate' });
  if (Object.keys(e.params).length > 16) out.push({ path: 'params', code: 'too_many' });
  return out;
}

/** The runtime-policy profile a catalog entry stands for on one runtime (name = catalog id). */
export function catalogProfile(e: ModelCatalogEntryInput): ModelProfile {
  return { name: e.id, provider: e.provider, model: e.model, params: { ...e.params } };
}

/** Model id as a runtime expects it (Pi and OpenCode take `provider/model`). */
export function catalogModelFor(
  runtime: RuntimeKind,
  e: Pick<ModelCatalogEntryInput, 'provider' | 'model'>,
): string {
  if (runtime === 'pi' || runtime === 'opencode') {
    return e.model.includes('/') ? e.model : `${e.provider}/${e.model}`;
  }
  return e.model;
}

/** Concrete per-runtime settings a catalog profile resolves to (merged under explicitly set values). */
export interface CatalogRuntimeSettings {
  readonly model?: string;
  readonly provider?: string;
  readonly credentialRef?: z.infer<typeof CredentialRef>;
}

export function catalogSettings(runtime: RuntimeKind, e: ModelCatalogEntryInput): CatalogRuntimeSettings {
  const cred = e.credentialRef === undefined ? {} : { credentialRef: e.credentialRef };
  switch (runtime) {
    case 'pi':
      // Pi takes provider and model separately (`--provider`, `--model`).
      return { provider: e.provider, model: e.model, ...cred };
    case 'opencode':
      return { model: catalogModelFor(runtime, e), ...cred };
    case 'claude-code':
    case 'codex':
      return { model: e.model, ...cred };
  }
}

/**
 * What a job carries of the catalog profile it uses (`JobSpec.modelProfile`, filled by the master only): the
 * runtime model string and the profile's credential reference. Never a credential value.
 */
export function jobModelProfile(
  runtime: RuntimeKind,
  e: ModelCatalogEntryInput,
): {
  id: string;
  model: string;
  credentialRef?: z.infer<typeof CredentialRef>;
} {
  return {
    id: e.id,
    model: catalogModelFor(runtime, e),
    ...(e.credentialRef === undefined ? {} : { credentialRef: e.credentialRef }),
  };
}
