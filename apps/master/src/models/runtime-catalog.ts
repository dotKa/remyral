import {
  BUILTIN_RUNTIME_MODEL_CATALOG,
  type MergedRuntimeModel,
  mergeRuntimeModels,
  type ModelAccess,
  RUNTIME_MODEL_CATALOG_VERSION,
  RuntimeKind,
  type RuntimeModelDiscovery,
  RuntimeModelsReport,
  type WorkerModelReport,
  WorkerConfigSpec,
} from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';

/**
 * p15-model-picker (docs/design/p15-model-picker.md §3): the models each runtime accepts, for the console's model
 * picker and the assistant's `list_runtime_models`. The built-in catalog (this master release) merged with what each
 * machine reported (CAPABILITIES `runtimeModels`, workers with `runtime-models-v1`), plus the defaults in force: the
 * global / project default (Settings → Modeller → Varsayılanlar) and each machine's own default (its configuration's
 * `runtimes.<kind>.model` / `modelProfile`). Read-only; model ids only.
 */

export const RUNTIME_MODELS_FEATURE = 'runtime-models-v1';

export interface MachineModelReport {
  readonly workerId: string;
  readonly workerName: string;
  /** `none`: the worker reported no list (older worker: update needed, or not listed yet). */
  readonly source: RuntimeModelDiscovery['source'] | 'none';
  readonly command?: string | undefined;
  readonly access?: ModelAccess | undefined;
  readonly error?: string | undefined;
  readonly models: number;
  readonly truncated?: boolean | undefined;
  readonly checkedAt: string | null;
  /** The worker release's catalog version (null: not reported). */
  readonly catalogVersion: string | null;
  /** The worker can report lists at all (`runtime-models-v1`). */
  readonly supported: boolean;
}

export interface MachineDefault {
  readonly workerId: string;
  readonly workerName: string;
  /** The machine's own default model id for the runtime (Pi: `provider/model`), if any. */
  readonly model: string | null;
  /** Its default model profile, if any. */
  readonly modelProfile: string | null;
}

export interface RuntimeModelsView {
  readonly runtime: RuntimeKind;
  readonly models: readonly MergedRuntimeModel[];
  readonly machines: readonly MachineModelReport[];
  readonly defaults: {
    /** The global default (Settings → Modeller): a profile id or a model id. */
    readonly global: { readonly profileId: string | null; readonly model: string | null } | null;
    /** The project's own default when a project was asked for. */
    readonly project: { readonly profileId: string | null; readonly model: string | null } | null;
    readonly machines: readonly MachineDefault[];
  };
}

export interface RuntimeCatalogView {
  readonly catalogVersion: string;
  readonly runtimes: readonly RuntimeModelsView[];
}

interface WorkerRow {
  id: string;
  display_name: string;
  runtime_models: unknown;
  runtime_models_at: Date | null;
  features: unknown;
  spec: unknown;
}

function machineDefault(
  runtime: RuntimeKind,
  spec: WorkerConfigSpec | null,
): {
  model: string | null;
  modelProfile: string | null;
} {
  const s = spec?.runtimes[runtime] as
    { model?: string; provider?: string; modelProfile?: string } | undefined;
  const model =
    s?.model === undefined
      ? null
      : runtime === 'pi' && s.provider !== undefined && !s.model.includes('/')
        ? `${s.provider}/${s.model}`
        : s.model;
  return { model, modelProfile: s?.modelProfile ?? null };
}

/** Catalog + machine lists + defaults; `runtime` narrows to one runtime, `project` adds its own default. */
export async function runtimeCatalog(
  db: Queryable,
  opts: { readonly runtime?: RuntimeKind | undefined; readonly project?: string | undefined } = {},
): Promise<RuntimeCatalogView> {
  const { rows } = await db.query<WorkerRow>(
    `SELECT w.id, w.display_name, w.runtime_models, w.runtime_models_at, w.features, v.spec
       FROM workers w
       LEFT JOIN worker_configs c ON c.worker_id = w.id
       LEFT JOIN worker_config_versions v ON v.worker_id = c.worker_id AND v.generation = c.generation
      WHERE w.approved_at IS NOT NULL AND w.revoked_at IS NULL AND w.archived_at IS NULL
      ORDER BY w.display_name, w.id`,
  );
  const defaults = await db.query<{
    project: string;
    runtime: string;
    profile_id: string | null;
    model: string | null;
  }>("SELECT project, runtime, profile_id, model FROM model_defaults WHERE project IN ('', $1)", [
    opts.project ?? '',
  ]);
  const workers = rows.map((r) => {
    const report = RuntimeModelsReport.safeParse(r.runtime_models);
    const spec = WorkerConfigSpec.safeParse(r.spec);
    const features = Array.isArray(r.features) ? (r.features as unknown[]) : [];
    return {
      id: r.id,
      name: r.display_name,
      report: report.success ? report.data : null,
      spec: spec.success ? spec.data : null,
      supported: features.includes(RUNTIME_MODELS_FEATURE),
    };
  });
  const runtimes: RuntimeModelsView[] = [];
  for (const runtime of RuntimeKind.options) {
    if (opts.runtime !== undefined && runtime !== opts.runtime) continue;
    const reports: WorkerModelReport[] = [];
    const machines: MachineModelReport[] = [];
    for (const w of workers) {
      const d = w.report?.runtimes.find((x) => x.runtime === runtime);
      if (d !== undefined) reports.push({ workerId: w.id, workerName: w.name, discovery: d });
      machines.push({
        workerId: w.id,
        workerName: w.name,
        source: d?.source ?? 'none',
        ...(d?.command === undefined ? {} : { command: d.command }),
        ...(d?.access === undefined ? {} : { access: d.access }),
        ...(d?.error === undefined ? {} : { error: d.error }),
        models: d?.models.length ?? 0,
        ...(d?.truncated === true ? { truncated: true } : {}),
        checkedAt: d?.checkedAt ?? null,
        catalogVersion: w.report?.catalogVersion ?? null,
        supported: w.supported,
      });
    }
    const pick = (project: string) => {
      const d = defaults.rows.find((x) => x.runtime === runtime && x.project === project);
      return d === undefined ? null : { profileId: d.profile_id, model: d.model };
    };
    runtimes.push({
      runtime,
      models: mergeRuntimeModels(runtime, reports, BUILTIN_RUNTIME_MODEL_CATALOG),
      // Machines that do not run this runtime at all are left out of the per-runtime list when they reported others.
      machines: machines.filter(
        (m) => m.source !== 'none' || workers.find((w) => w.id === m.workerId)?.report === null,
      ),
      defaults: {
        global: pick(''),
        project: opts.project === undefined || opts.project === '' ? null : pick(opts.project),
        machines: workers
          .map((w) => ({ workerId: w.id, workerName: w.name, ...machineDefault(runtime, w.spec) }))
          .filter((m) => m.model !== null || m.modelProfile !== null),
      },
    });
  }
  return { catalogVersion: RUNTIME_MODEL_CATALOG_VERSION, runtimes };
}
