import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';
import { MODEL_RUNTIMES, type ModelRuntime } from './models';

/**
 * p15-model-picker: GET /models/runtimes — per runtime the models it accepts (the master's built-in catalog merged
 * with what each machine's runtime CLI listed), the machines each model was seen on, and the defaults in force
 * (global, the project's, each machine's own). Model ids only.
 */

export type ModelAccess = 'subscription' | 'api-key';

export interface ModelSeenOn {
  readonly workerId: string;
  readonly workerName: string;
  readonly source: 'cli' | 'builtin';
  readonly access?: ModelAccess;
}

export interface RuntimeModel {
  readonly id: string;
  readonly displayName: string;
  readonly kind: 'alias' | 'model';
  readonly resolvesTo?: string | undefined;
  readonly provider?: string | undefined;
  readonly contextWindow?: number | undefined;
  readonly notes?: string | undefined;
  readonly access?: readonly ModelAccess[] | undefined;
  readonly inCatalog: boolean;
  readonly machines: readonly ModelSeenOn[];
}

export interface MachineModelReport {
  readonly workerId: string;
  readonly workerName: string;
  readonly source: 'cli' | 'builtin' | 'failed' | 'none';
  readonly error?: string;
  readonly access?: ModelAccess;
  readonly models: number;
  readonly checkedAt: string | null;
  readonly catalogVersion: string | null;
  readonly supported: boolean;
}

export interface DefaultChoice {
  readonly profileId: string | null;
  readonly model: string | null;
}

export interface MachineDefault {
  readonly workerId: string;
  readonly workerName: string;
  readonly model: string | null;
  readonly modelProfile: string | null;
}

export interface RuntimeModels {
  readonly runtime: ModelRuntime;
  readonly models: readonly RuntimeModel[];
  readonly machines: readonly MachineModelReport[];
  readonly defaults: {
    readonly global: DefaultChoice | null;
    readonly project: DefaultChoice | null;
    readonly machines: readonly MachineDefault[];
  };
}

export interface RuntimeCatalog {
  readonly catalogVersion: string;
  readonly runtimes: readonly RuntimeModels[];
}

function arr(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v;
}

function choice(v: unknown): DefaultChoice | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return { profileId: nullableStr(o, 'profileId'), model: nullableStr(o, 'model') };
}

function parseModel(v: unknown): RuntimeModel {
  const o = obj(v);
  str(o, 'id');
  str(o, 'displayName');
  const kind = str(o, 'kind');
  if (kind !== 'alias' && kind !== 'model') throw new ShapeError('bad kind');
  if (typeof o.inCatalog !== 'boolean') throw new ShapeError('expected boolean at inCatalog');
  const machines = arr(o.machines).map((m) => {
    const x = obj(m);
    str(x, 'workerId');
    str(x, 'workerName');
    return x as unknown as ModelSeenOn;
  });
  return { ...(o as unknown as RuntimeModel), machines };
}

function parseRuntime(v: unknown): RuntimeModels | null {
  const o = obj(v);
  const runtime = str(o, 'runtime');
  // A runtime this console does not know (a newer master) is skipped, never an error.
  if (!(MODEL_RUNTIMES as readonly string[]).includes(runtime)) return null;
  const d = obj(o.defaults);
  return {
    runtime: runtime as ModelRuntime,
    models: arr(o.models).map(parseModel),
    machines: arr(o.machines).map((m) => {
      const x = obj(m);
      str(x, 'workerId');
      str(x, 'workerName');
      if (typeof x.supported !== 'boolean') throw new ShapeError('expected boolean at supported');
      return x as unknown as MachineModelReport;
    }),
    defaults: {
      global: choice(d.global),
      project: choice(d.project),
      machines: arr(d.machines).map((m) => {
        const x = obj(m);
        return {
          workerId: str(x, 'workerId'),
          workerName: str(x, 'workerName'),
          model: nullableStr(x, 'model'),
          modelProfile: nullableStr(x, 'modelProfile'),
        };
      }),
    },
  };
}

export function parseRuntimeCatalog(v: unknown): RuntimeCatalog {
  const o = obj(v);
  return {
    catalogVersion: str(o, 'catalogVersion'),
    runtimes: arr(o.runtimes)
      .map(parseRuntime)
      .filter((r): r is RuntimeModels => r !== null),
  };
}

export function getRuntimeModels(
  q: { readonly runtime?: ModelRuntime; readonly project?: string } = {},
  opts: Omit<RequestOptions, 'body'> = {},
): Promise<RuntimeCatalog> {
  const params = new URLSearchParams();
  if (q.runtime !== undefined) params.set('runtime', q.runtime);
  if (q.project !== undefined && q.project !== '') params.set('project', q.project);
  const qs = params.toString();
  return apiRequest('GET', `/models/runtimes${qs === '' ? '' : `?${qs}`}`, parseRuntimeCatalog, opts);
}
