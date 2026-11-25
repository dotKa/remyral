import { apiRequest, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p11-runtime-advice (docs/design/p11-runtime-advice.md, ADR-0044): which runtime does well for which kind of work in
 * a project — advice for drafts, auto mode settings, the runtime × area outcome matrix, and 👍 / 👎 on finished jobs.
 */

export const JOB_AREAS = ['frontend', 'backend', 'tests', 'docs', 'infra'] as const;
export type JobArea = (typeof JOB_AREAS)[number];
export const AREA_LABEL: Record<JobArea, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  tests: 'Tests',
  docs: 'Docs',
  infra: 'Infra / deploy',
};
export function areaLabel(a: string | null): string {
  return a === null ? 'Unclassified' : ((AREA_LABEL as Record<string, string>)[a] ?? a);
}

export type AdviceMode = 'off' | 'advice' | 'auto';

/** The runtime value that asks auto mode to choose (resolved by the master; never reaches a machine). */
export const AUTO_RUNTIME = 'auto';

export interface ClassificationSignal {
  readonly source: string;
  readonly area: string;
  readonly weight: number;
  readonly detail: string;
}

export interface AdviceOption {
  readonly runtime: string;
  readonly n: number;
  readonly rate: number;
  readonly low: number;
  readonly high: number;
  readonly rawRate: number | null;
  readonly medianDurationSec: number | null;
  readonly meanCostUsd: number | null;
  readonly counted: boolean;
}

export interface RuntimeAdvice {
  readonly recommended: string | null;
  readonly confidence: 'strong' | 'weak' | 'insufficient';
  readonly scope: string;
  readonly text: string;
  readonly options: readonly AdviceOption[];
}

export interface AdviceView {
  readonly mode: AdviceMode;
  readonly classification: {
    readonly kind: string | null;
    readonly area: string | null;
    readonly areaSource: string | null;
    readonly signals: readonly ClassificationSignal[];
  };
  readonly advice: RuntimeAdvice | null;
}

type Opts = Omit<RequestOptions, 'body'>;

function isMode(v: unknown): v is AdviceMode {
  return v === 'off' || v === 'advice' || v === 'auto';
}

export function parseAdvice(v: unknown): AdviceView {
  const o = obj(v);
  const mode = o.mode;
  if (!isMode(mode)) throw new ShapeError('expected mode');
  const c = obj(o.classification);
  if (!Array.isArray(c.signals)) throw new ShapeError('expected signals');
  return {
    mode,
    classification: {
      kind: typeof c.kind === 'string' ? c.kind : null,
      area: typeof c.area === 'string' ? c.area : null,
      areaSource: typeof c.areaSource === 'string' ? c.areaSource : null,
      signals: c.signals as ClassificationSignal[],
    },
    advice: o.advice === null || o.advice === undefined ? null : (obj(o.advice) as unknown as RuntimeAdvice),
  };
}

export function getRuntimeAdvice(
  body: {
    project: string;
    prompt?: string;
    role?: string;
    area?: string;
    paths?: readonly string[];
    templateName?: string;
  },
  opts: Opts = {},
): Promise<AdviceView> {
  const prompt = body.prompt === undefined ? undefined : body.prompt.slice(0, 4000);
  return apiRequest('POST', '/routing/advice', parseAdvice, {
    ...opts,
    body: { ...body, ...(prompt === undefined ? {} : { prompt }) },
  });
}

export interface AreaRule {
  readonly area: JobArea;
  readonly globs: readonly string[];
}

export interface AdviceSettings {
  readonly mode: AdviceMode;
  readonly explorationPct: number;
  readonly minSamples: number;
  readonly allowedRuntimes: readonly string[];
  readonly allowPaid: boolean;
  readonly halfLifeDays: number;
  readonly rerunWindowDays: number;
  readonly areaRules: readonly AreaRule[];
}

function parseSettings(v: unknown): AdviceSettings {
  const s = obj(obj(v).settings);
  if (!isMode(s.mode) || typeof s.explorationPct !== 'number') throw new ShapeError('expected settings');
  return s as unknown as AdviceSettings;
}

export function getAdviceSettings(project: string, opts: Opts = {}): Promise<AdviceSettings> {
  return apiRequest('GET', `/projects/${encodeURIComponent(project)}/runtime-advice`, parseSettings, opts);
}

export function putAdviceSettings(
  project: string,
  settings: AdviceSettings,
  opts: Opts = {},
): Promise<AdviceSettings> {
  return apiRequest('PUT', `/projects/${encodeURIComponent(project)}/runtime-advice`, parseSettings, {
    ...opts,
    body: { settings },
  });
}

export interface MatrixCell {
  readonly area: string | null;
  readonly runtime: string;
  readonly n: number;
  readonly rate: number;
  readonly low: number;
  readonly high: number;
  readonly rawRate: number | null;
  readonly medianDurationSec: number | null;
  readonly meanCostUsd: number | null;
  readonly recent: { readonly n: number; readonly rate: number | null };
  readonly previous: { readonly n: number; readonly rate: number | null };
  readonly models: readonly { readonly model: string; readonly n: number; readonly good: number }[];
}

export interface OutcomeMatrix {
  readonly project: string;
  readonly settings: AdviceSettings;
  readonly runtimes: readonly string[];
  readonly areas: readonly (string | null)[];
  readonly cells: readonly MatrixCell[];
  readonly advice: readonly {
    readonly area: string | null;
    readonly recommended: string | null;
    readonly text: string;
  }[];
  readonly jobs: number;
}

export function getRuntimeOutcomes(project: string, opts: Opts = {}): Promise<OutcomeMatrix> {
  return apiRequest(
    'GET',
    `/usage/runtime-outcomes?project=${encodeURIComponent(project)}`,
    (v) => {
      const o = obj(v);
      str(o, 'project');
      if (!Array.isArray(o.cells) || !Array.isArray(o.runtimes)) throw new ShapeError('expected cells');
      return o as unknown as OutcomeMatrix;
    },
    opts,
  );
}

export interface JobRuntimeOutcome {
  readonly classification: {
    readonly kind: string | null;
    readonly kindSource: string | null;
    readonly area: string | null;
    readonly areaSource: string | null;
    readonly signals: readonly ClassificationSignal[];
    readonly stage: string;
  } | null;
  readonly decision: {
    readonly runtime: string;
    readonly how: string;
    readonly reasons: readonly string[];
    readonly decidedAt: string;
  } | null;
  readonly rating: { readonly value: number; readonly at: string } | null;
  readonly outcome: { readonly good: boolean; readonly reasons: readonly string[] } | null;
}

export function getJobRuntimeOutcome(jobId: string, opts: Opts = {}): Promise<JobRuntimeOutcome> {
  return apiRequest(
    'GET',
    `/jobs/${encodeURIComponent(jobId)}/runtime-outcome`,
    (v) => {
      const o = obj(v);
      if (!('classification' in o) || !('rating' in o)) throw new ShapeError('expected runtime outcome');
      return o as unknown as JobRuntimeOutcome;
    },
    opts,
  );
}

export function rateJob(jobId: string, rating: 1 | -1 | null, opts: Opts = {}): Promise<number | null> {
  return apiRequest(
    'PUT',
    `/jobs/${encodeURIComponent(jobId)}/rating`,
    (v) => {
      const r = obj(v).rating;
      return typeof r === 'number' ? r : null;
    },
    { ...opts, body: { rating } },
  );
}

export const pct = (x: number | null): string => (x === null ? '–' : `${String(Math.round(x * 100))}%`);
