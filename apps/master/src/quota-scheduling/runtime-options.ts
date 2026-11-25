import { type JobRuntimeFallback, type JobSpec } from '@remyral/protocol';

/**
 * p6-quota-scheduling: the runtime options of a job (docs/design/p6-quota-scheduling.md §3). Index 0 is the job's
 * own spec; each fallback gives the same job with that runtime and its model (resolved at submission), without the
 * primary's exact runtime version (a pin of another runtime).
 */
export interface SpecOption {
  readonly index: number;
  readonly runtime: JobSpec['runtime'];
  readonly spec: JobSpec;
}

export function fallbackSpec(spec: JobSpec, fallback: JobRuntimeFallback): JobSpec {
  const { runtimeVersion: _v, model: _m, modelProfile: _p, defaultModel: _d, ...rest } = spec;
  return {
    ...rest,
    runtime: fallback.runtime,
    ...(fallback.model === undefined ? {} : { model: fallback.model }),
    ...(fallback.modelProfile === undefined ? {} : { modelProfile: fallback.modelProfile }),
    // p15-model-picker: the fallback runtime's own global default model (never the primary runtime's).
    ...(fallback.defaultModel === undefined ? {} : { defaultModel: fallback.defaultModel }),
  };
}

export function specOptions(spec: JobSpec): SpecOption[] {
  return [
    { index: 0, runtime: spec.runtime, spec },
    ...(spec.fallbacks ?? []).map((f, i) => ({
      index: i + 1,
      runtime: f.runtime,
      spec: fallbackSpec(spec, f),
    })),
  ];
}

/** The spec a worker receives: master-only scheduling fields removed (the worker runs one runtime). */
export function workerSpec(spec: JobSpec): JobSpec {
  const { fallbacks: _f, deferrable: _d, delivery: _v, ...rest } = spec;
  // The protocol's MASTER_ONLY_SPEC_FIELDS (fallbacks, deferrable, delivery).
  return rest;
}

/** `job_runs.runtime_choice`: which option an attempt ran with and why earlier ones were passed over. */
export interface RuntimeChoice {
  readonly index: number;
  readonly runtime: string;
  readonly model?: string;
  readonly modelProfile?: string;
  /** Why earlier options were passed over (codes, workers, times; ≤ 1000 characters). Absent for index 0. */
  readonly reason?: string;
  /**
   * p11-usage-limit-fallback: `policy` = the option came from the project's usage-limit policy (not `spec.fallbacks`),
   * so its index does not point into `spec.fallbacks`.
   */
  readonly origin?: 'policy';
  /** p11-usage-limit-fallback: the option brings its own (API-key) credential — for slot accounting. */
  readonly ownCredential?: boolean;
  /**
   * p13-runtime-accounts: the runtime account the attempt runs with on its machine (absent = the configured auth,
   * `default`, on a machine without accounts). Sent as ASSIGN_JOB `execution.account`.
   */
  readonly account?: string;
  /** p13-runtime-accounts: `api_key` when that account is an API key (slot accounting, paid display). */
  readonly accountKind?: 'subscription' | 'api_key';
}

export function runtimeChoice(
  option: SpecOption & { readonly origin?: 'job' | 'spec' | 'policy' },
  passedOver: readonly string[],
): RuntimeChoice {
  const reason = passedOver.join(' | ');
  return {
    index: option.index,
    runtime: option.runtime,
    ...(option.spec.model === undefined ? {} : { model: option.spec.model }),
    ...(option.spec.modelProfile === undefined ? {} : { modelProfile: option.spec.modelProfile.id }),
    ...(option.index === 0 || reason === '' ? {} : { reason: reason.slice(0, 1000) }),
    ...(option.origin === 'policy' ? { origin: 'policy' as const } : {}),
    ...(option.spec.modelProfile?.credentialRef === undefined ? {} : { ownCredential: true }),
  };
}

/** SQL for an attempt's effective runtime (fallback-aware); `r` = job_runs, `j` = jobs. */
export const EFFECTIVE_RUNTIME_SQL = "COALESCE(r.runtime_choice->>'runtime', j.spec->>'runtime')";
