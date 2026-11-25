import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { IllegalTransitionError, JobStoreError } from '../jobs/errors.js';
import type { JobStore } from '../jobs/store.js';
import { ErrorBodySchema } from '../http/error-schema.js';

/**
 * ADR-0023: OpenHands was removed from the platform (runtime, adapter, installer and the interactive Canvas
 * screen). This module holds what is left of it on the master:
 *
 *  - {@link retireOpenHands}: an idempotent startup step that brings stored *configuration* in line (never history):
 *    unfinished OpenHands jobs and interactive sessions are cancelled through the normal job state machine (audited,
 *    reason `runtime_removed`), worker configurations get a generation without OpenHands, runtime policies an active
 *    version without it. Migration 0042 cleaned the model catalog and defaults.
 *  - {@link retiredInteractiveRoutes}: the former interactive-session endpoints answer 410 `runtime_removed`.
 *
 * History stays readable: jobs, attempts, events, usage and audit rows naming OpenHands are never changed.
 */

export const RETIREMENT_ACTOR = { type: 'system', id: 'runtime-retirement' } as const;
export const RUNTIME_REMOVED_REASON = 'runtime_removed';

export const INTERACTIVE_REMOVED_MESSAGE =
  'OpenHands was removed from the platform (ADR-0023); its interactive sessions are no longer available. Past sessions remain in Jobs history.';

export interface RetirementDeps {
  readonly pool: Pool;
  readonly jobs: JobStore;
  readonly log: FastifyBaseLogger;
  /** Queues CANCEL_JOB for a job that is now CANCELLING (Orchestrator.sendCancel). */
  readonly sendCancel?: (jobId: string, reason: string) => Promise<unknown>;
  readonly workerConfigs?: { retireRuntimes(): Promise<string[]> };
  readonly runtimePolicies?: { retireRuntimes(): Promise<string[]> };
}

export interface RetirementResult {
  readonly cancelledJobs: string[];
  readonly workerConfigs: string[];
  readonly runtimePolicies: string[];
}

/** Unfinished jobs of the removed runtime (or interactive OpenHands sessions), oldest first. */
async function openJobs(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM jobs
      WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELLING')
        AND (spec->>'runtime' = 'openhands' OR spec->>'kind' = 'interactive-openhands')
      ORDER BY created_at, id`,
  );
  return rows.map((r) => r.id);
}

/**
 * Runs every retirement step; each step is independent and best effort (a failure is logged, the master starts
 * anyway, and the next start retries). Safe to run on every start: once nothing names OpenHands it changes nothing.
 */
export async function retireOpenHands(deps: RetirementDeps): Promise<RetirementResult> {
  const cancelledJobs: string[] = [];
  try {
    for (const id of await openJobs(deps.pool)) {
      try {
        const { job } = await deps.jobs.transition(id, 'cancel_requested', {
          actor: RETIREMENT_ACTOR,
          reason: RUNTIME_REMOVED_REASON,
        });
        if (job.state === 'CANCELLING') await deps.sendCancel?.(id, RUNTIME_REMOVED_REASON);
        cancelledJobs.push(id);
      } catch (err) {
        if (err instanceof IllegalTransitionError || err instanceof JobStoreError) {
          deps.log.warn(
            { jobId: id, err },
            'OpenHands job not cancelled (state changed); retried next start',
          );
        } else throw err;
      }
    }
  } catch (err) {
    deps.log.error({ err }, 'OpenHands jobs not cancelled');
  }
  const run = async (
    name: string,
    target: { retireRuntimes(): Promise<string[]> } | undefined,
  ): Promise<string[]> => {
    if (target === undefined) return [];
    try {
      return await target.retireRuntimes();
    } catch (err) {
      deps.log.error({ err }, `OpenHands retirement step failed: ${name}`);
      return [];
    }
  };
  const workerConfigs = await run('worker configurations', deps.workerConfigs);
  const runtimePolicies = await run('runtime policies', deps.runtimePolicies);
  const result = { cancelledJobs, workerConfigs, runtimePolicies };
  if (cancelledJobs.length + workerConfigs.length + runtimePolicies.length > 0) {
    deps.log.info(result, 'OpenHands retired (ADR-0023)');
  }
  return result;
}

const Gone = ErrorBodySchema;

/**
 * ADR-0023 tombstone: the interactive OpenHands session API is gone; its collection endpoints
 * (`/interactive/sessions`, `/interactive/config`) answer a clear 410 instead of a generic 404 (per-session paths
 * and the `/oh/…` proxy simply no longer exist). Any authenticated console role may ask.
 */
export function retiredInteractiveRoutes() {
  return (app: FastifyInstance): void => {
    const gone = (): never => {
      throw new HttpError(410, RUNTIME_REMOVED_REASON, INTERACTIVE_REMOVED_MESSAGE);
    };
    const opts = {
      config: { authz: { action: 'jobs.read' as const } },
      schema: {
        tags: ['interactive'],
        summary: 'Removed (ADR-0023): interactive OpenHands sessions are no longer available.',
        deprecated: true,
        security: [{ session: [] }],
        response: { 410: Gone },
      },
    };
    app.get('/interactive/sessions', opts, gone);
    app.get('/interactive/config', opts, gone);
    app.post('/interactive/sessions', opts, gone);
  };
}
