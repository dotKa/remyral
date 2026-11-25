import { type Telemetry, withTraceparent } from '@remyral/observability/telemetry';

/**
 * Worker job telemetry (p6-otel, docs/design/p6-observability.md §2.2): a `job.run` span per attempt with
 * one child span per phase (credential, workspace, spawn, prompt, stream, collect, publish, cleanup) — the
 * adapter calls — plus phase-duration and finished-job metrics. Attributes are the job/attempt ids, the
 * epoch, the runtime and the phase; never the prompt, repository URL, summaries or errors (only the error
 * class). Without a configured exporter every call is a cheap pass-through.
 */
export interface TelemetryJob {
  readonly jobId: string;
  readonly attemptId: string;
  readonly epoch: number;
  readonly spec: { readonly runtime: string };
}

export type JobPhase =
  | 'credential'
  | 'workspace'
  | 'inputs'
  | 'seed'
  | 'input-bundle'
  | 'skills'
  | 'spawn'
  | 'prompt'
  | 'stream'
  | 'collect'
  | 'artifacts'
  | 'publish'
  | 'cleanup';

export class JobTelemetry {
  readonly #t: Telemetry | null;

  constructor(t: Telemetry | null) {
    this.#t = t;
  }

  readonly #phaseSeconds = (): ReturnType<Telemetry['meter']['createHistogram']> | null =>
    this.#t?.meter.createHistogram('remyral_worker_job_phase_duration_seconds', {
      description: 'Duration of job runner phases (adapter calls) by runtime',
      unit: 's',
      advice: { explicitBucketBoundaries: [0.01, 0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600] },
    }) ?? null;

  #attrs(job: TelemetryJob): Record<string, string | number> {
    return {
      'remyral.job.id': job.jobId,
      'remyral.attempt.id': job.attemptId,
      'remyral.attempt.epoch': job.epoch,
      'remyral.runtime': job.spec.runtime,
    };
  }

  /**
   * The whole attempt as the active parent span. p16-observability: with the ASSIGN_JOB envelope's `traceparent` the
   * span continues the master's `job.dispatch` trace (one trace from dispatch to the worker's phases).
   */
  run(job: TelemetryJob, fn: () => Promise<void>, traceparent?: string): Promise<void> {
    const t = this.#t;
    if (t === null) return fn();
    return withTraceparent(traceparent, () => t.span('job.run', this.#attrs(job), fn));
  }

  /** A phase runner bound to `job`. */
  phases(job: TelemetryJob): <T>(phase: JobPhase, fn: () => Promise<T>) => Promise<T> {
    const t = this.#t;
    if (t === null) return (_phase, fn) => fn();
    // Instruments are cached by name in the SDK; creating the handle here is cheap.
    const hist = this.#phaseSeconds();
    return async <T>(phase: JobPhase, fn: () => Promise<T>): Promise<T> => {
      const start = process.hrtime.bigint();
      let result = 'ok';
      try {
        return await t.span(`job.${phase}`, { ...this.#attrs(job), 'remyral.phase': phase }, fn);
      } catch (err) {
        result = 'error';
        throw err;
      } finally {
        hist?.record(Number(process.hrtime.bigint() - start) / 1e9, {
          phase,
          runtime: job.spec.runtime,
          result,
        });
      }
    };
  }

  finished(job: TelemetryJob, outcome: string): void {
    this.#t?.meter
      .createCounter('remyral_worker_jobs_finished', {
        description: 'Attempts finished on this worker by outcome and runtime',
      })
      .add(1, { outcome, runtime: job.spec.runtime });
  }
}
