import {
  type EffectiveRoutingRule,
  type JobRole,
  jobModelProfile,
  type JobModelProfile,
  type RuntimeKind,
} from '@remyral/protocol';
import { routingRuleFor } from '../routing/rules.js';
import type { Queryable } from '../db/pool.js';
import { type CatalogEntry, loadCatalog } from './service.js';

/**
 * docs/design/p5-credentials-models.md §5a: how a job's model is decided.
 *
 *  1. The job names a model (`spec.model`). If it is an enabled model catalog id offered for the job's runtime, the
 *     master attaches the profile (`spec.modelProfile`: runtime model string and credential
 *     reference). Anything else (a runtime model id, a runtime-policy profile name, a disabled
 *     catalog id) is kept as is; placement explains a disabled one (`model_profile_unavailable`).
 *  1b. p6-smart-routing: the job names none and the routing rule of its kind (project override, else global) prefers
 *     an enabled catalog profile offered for the job's runtime — that profile (source `project-routing` /
 *     `global-routing`). A rule whose profile does not fit the runtime is skipped (never an error).
 *  2. The job names none: the project default for the runtime, else the global one (Settings → Models →
 *     Defaults) is applied the same way (`spec.model` = its id).
 *     p15-model-picker: a default may be a model id instead of a profile. A project one becomes the job's model
 *     (`spec.model`); the global one is soft (`spec.defaultModel`): the machine's own default model wins over it
 *     (docs/design/p15-model-picker.md §4).
 *  3. Still none: the worker's own default applies (its runtime settings or runtime-policy profiles); every
 *     remaining runtime has a default model of its own (ADR-0023 removed OpenHands, which had none).
 *
 * A submitter's `modelProfile` / `defaultModel` is never trusted: both are always recomputed here.
 */

export interface ResolvedJobModel {
  /** The job's `model` after resolution (undefined: the worker's own default applies). */
  readonly model: string | undefined;
  readonly modelProfile: JobModelProfile | undefined;
  /** p15-model-picker: the global default model id, applied by the worker after its own default (soft). */
  readonly defaultModel?: string | undefined;
  /** Where the profile came from (null: no catalog profile). */
  readonly source: 'job' | 'project-routing' | 'global-routing' | 'project-default' | 'global-default' | null;
}

/** A project / global default: a catalog profile (`id`) or, since p15-model-picker, a model id (`model`). */
export type DefaultChoice =
  | { readonly id: string; readonly model?: undefined; readonly scope: 'project' | 'global' }
  | { readonly model: string; readonly id?: undefined; readonly scope: 'project' | 'global' };

/** The project's (else the global) default for `runtime`, or null. */
export async function defaultProfileId(
  db: Queryable,
  project: string,
  runtime: RuntimeKind,
): Promise<DefaultChoice | null> {
  const { rows } = await db.query<{ project: string; profile_id: string | null; model: string | null }>(
    "SELECT project, profile_id, model FROM model_defaults WHERE runtime = $2 AND project IN ('', $1)",
    [project, runtime],
  );
  return pickDefault(rows, project);
}

/** The project's own row wins over the global one (`project = ''`). */
export function pickDefault(
  rows: readonly { project: string; profile_id: string | null; model: string | null }[],
  project: string,
): DefaultChoice | null {
  const of = (r: { profile_id: string | null; model: string | null }, scope: 'project' | 'global') =>
    r.profile_id !== null ? { id: r.profile_id, scope } : r.model !== null ? { model: r.model, scope } : null;
  const own = rows.find((r) => r.project === project && project !== '');
  if (own !== undefined) return of(own, 'project');
  const global = rows.find((r) => r.project === '');
  return global === undefined ? null : of(global, 'global');
}

function usable(c: CatalogEntry | undefined, runtime: RuntimeKind): c is CatalogEntry {
  return c !== undefined && c.entry.enabled && c.entry.runtimes.includes(runtime);
}

/** Pure part of the resolution (the catalog and the default already loaded). */
export function resolveWithCatalog(
  catalog: ReadonlyMap<string, CatalogEntry>,
  runtime: RuntimeKind,
  model: string | undefined,
  fallback: DefaultChoice | null,
  rule: EffectiveRoutingRule | null = null,
): ResolvedJobModel {
  if (model !== undefined) {
    const c = catalog.get(model);
    return usable(c, runtime)
      ? { model, modelProfile: jobModelProfile(runtime, c.entry), source: 'job' }
      : { model, modelProfile: undefined, source: null };
  }
  if (rule?.modelProfile !== null && rule?.modelProfile !== undefined) {
    const c = catalog.get(rule.modelProfile);
    if (usable(c, runtime)) {
      return {
        model: rule.modelProfile,
        modelProfile: jobModelProfile(runtime, c.entry),
        source: rule.scope === 'project' ? 'project-routing' : 'global-routing',
      };
    }
  }
  if (fallback?.model !== undefined) {
    // p15-model-picker: a model id default — the project's is the job's model, the global one is soft.
    return fallback.scope === 'project'
      ? { model: fallback.model, modelProfile: undefined, source: 'project-default' }
      : { model: undefined, modelProfile: undefined, defaultModel: fallback.model, source: 'global-default' };
  }
  if (fallback !== null) {
    const c = catalog.get(fallback.id);
    // setDefault refuses unusable profiles and a catalog change drops defaults it invalidates; double-check anyway.
    if (usable(c, runtime)) {
      return {
        model: fallback.id,
        modelProfile: jobModelProfile(runtime, c.entry),
        source: fallback.scope === 'project' ? 'project-default' : 'global-default',
      };
    }
  }
  return { model: undefined, modelProfile: undefined, source: null };
}

export async function resolveJobModel(
  db: Queryable,
  project: string,
  runtime: RuntimeKind,
  model: string | undefined,
  role: JobRole | null = null,
): Promise<ResolvedJobModel> {
  const catalog = await loadCatalog(db);
  const fallback = model === undefined ? await defaultProfileId(db, project, runtime) : null;
  const rule = model === undefined ? await routingRuleFor(db, project, role) : null;
  return resolveWithCatalog(catalog, runtime, model, fallback, rule);
}
