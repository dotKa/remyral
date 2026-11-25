import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';
import type { CredentialRef } from './workerConfig';

/**
 * Model catalog (p5-credentials-models): the master-wide registry of model profiles. Runtime policies,
 * worker configurations (`runtimes.<kind>.modelProfile`) and the composer reference entries by id. An entry
 * never holds a credential value — `credentialRef` names a vault credential or a worker-store secret.
 */

/** ADR-0023: the four runtimes the platform runs (OpenHands was removed). */
export const MODEL_RUNTIMES = ['claude-code', 'codex', 'opencode', 'pi'] as const;
export type ModelRuntime = (typeof MODEL_RUNTIMES)[number];

export interface ModelLimits {
  readonly contextWindow?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface ModelPricing {
  readonly inputPerMTok?: number;
  readonly outputPerMTok?: number;
  readonly cachedInputPerMTok?: number;
}

export interface ModelEntryInput {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly runtimes: readonly ModelRuntime[];
  readonly provider: string;
  readonly model: string;
  readonly credentialRef?: CredentialRef;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly limits: ModelLimits;
  readonly pricing: ModelPricing;
  readonly enabled: boolean;
}

export interface ModelView extends ModelEntryInput {
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
  readonly usedBy: {
    readonly policies: readonly {
      readonly policy: string;
      readonly version: number;
      readonly runtime: string;
      readonly inSync: boolean;
    }[];
    readonly workers: readonly string[];
  };
}

/**
 * A project / global default: a model profile (`profileId`) or, since p15-model-picker, a model id (`model`, from the
 * runtime model catalog or a custom id). Exactly one is set.
 */
export interface ModelDefault {
  readonly project: string | null;
  readonly runtime: ModelRuntime;
  readonly profileId: string | null;
  readonly model: string | null;
}

/** What a default names (the profile id or the model id). */
export function defaultTarget(d: Pick<ModelDefault, 'profileId' | 'model'>): string {
  return d.profileId ?? d.model ?? '';
}

type Opts = Omit<RequestOptions, 'body'>;

function arrayOf<T>(v: unknown, f: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v.map(f);
}

export function parseModel(v: unknown): ModelView {
  const o = obj(v);
  str(o, 'id');
  str(o, 'displayName');
  strArray(o, 'runtimes');
  str(o, 'provider');
  str(o, 'model');
  if (typeof o.enabled !== 'boolean') throw new ShapeError('expected boolean at enabled');
  int(o, 'version');
  const used = obj(o.usedBy);
  arrayOf(used.policies, (p) => str(obj(p), 'policy'));
  strArray(used, 'workers');
  return {
    ...(o as unknown as ModelView),
    params: (o.params ?? {}) as ModelView['params'],
    limits: o.limits ?? {},
    pricing: o.pricing ?? {},
  };
}

function parseDefault(v: unknown): ModelDefault | null {
  const o = obj(v);
  const runtime = str(o, 'runtime');
  // ADR-0023: a default of a removed runtime (OpenHands) is not shown; any other unknown runtime is an error.
  if (runtime === 'openhands') return null;
  if (!(MODEL_RUNTIMES as readonly string[]).includes(runtime)) throw new ShapeError('bad runtime');
  const profileId = nullableStr(o, 'profileId');
  // p15-model-picker: older masters send no `model`.
  const model = typeof o.model === 'string' ? o.model : null;
  if (profileId === null && model === null) throw new ShapeError('default without profile or model');
  return { project: nullableStr(o, 'project'), runtime: runtime as ModelRuntime, profileId, model };
}

function parseDefaults(v: unknown): ModelDefault[] {
  return arrayOf(v, parseDefault).filter((d): d is ModelDefault => d !== null);
}

export function listModels(opts: Opts = {}): Promise<{ items: ModelView[]; defaults: ModelDefault[] }> {
  return apiRequest(
    'GET',
    '/models',
    (v) => {
      const o = obj(v);
      return { items: arrayOf(o.items, parseModel), defaults: parseDefaults(o.defaults) };
    },
    opts,
  );
}

export function putModel(
  id: string,
  body: { entry: ModelEntryInput; expectedVersion: number },
  opts: Opts = {},
): Promise<ModelView> {
  return apiRequest('PUT', `/models/${encodeURIComponent(id)}`, parseModel, { ...opts, body });
}

export function deleteModel(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/models/${encodeURIComponent(id)}`, () => undefined, opts);
}

export function putModelDefault(
  body: { project: string | null; runtime: ModelRuntime; profileId: string | null; model?: string | null },
  opts: Opts = {},
): Promise<ModelDefault[]> {
  return apiRequest('PUT', '/models/defaults', (v) => parseDefaults(obj(v).defaults), {
    ...opts,
    body,
  });
}

/** One-line pricing hint, e.g. "$3 / $15 per M tokens". */
export function pricingText(p: ModelPricing | undefined): string | null {
  if (p?.inputPerMTok === undefined && p?.outputPerMTok === undefined) return null;
  const f = (n: number | undefined) => (n === undefined ? '–' : `$${String(n)}`);
  return `${f(p.inputPerMTok)} in / ${f(p.outputPerMTok)} out per M tokens`;
}
