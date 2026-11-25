import { z } from 'zod';
import { AutomationError, AutomationFile, ContinueFrom } from '../automations/model.js';
import type { AutomationService } from '../automations/service.js';
import { Repository } from '../workflows/definition.js';

/**
 * p5-composer schedules, now a thin alias over automations (p6-automations, ADR-0024): a schedule is a `cron` or
 * `at` automation created with the old behaviour (parallel runs, one catch-up fire). The composer's "At a time" /
 * "Repeat" keep using `/schedules`; everything else (runs, history, chat, console) is in `/automations`.
 */

export class ScheduleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ScheduleInput = z.object({
  project: z.string().regex(PROJECT),
  name: z.string().trim().min(1).max(200),
  target: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('job'),
      spec: z.record(z.string(), z.unknown()),
      priority: z.number().int().min(-100).max(100).optional(),
      // p5-research-workspace-next: input files and continue-from on workspace projects (as automations).
      files: z.array(AutomationFile).max(10).optional(),
      continueFrom: ContinueFrom.nullable().optional(),
    }),
    z.object({
      kind: z.literal('workflow'),
      workflowId: z.string().regex(UUID),
      inputs: z.record(z.string(), z.string().max(64 * 1024)).default({}),
      repository: Repository.optional(),
      files: z.array(AutomationFile).max(10).optional(),
      continueFrom: ContinueFrom.nullable().optional(),
    }),
  ]),
  when: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('at'), at: z.iso.datetime({ offset: true }) }),
    z.object({ kind: z.literal('cron'), cron: z.string().min(9).max(120) }),
  ]),
});
export type ScheduleInput = z.infer<typeof ScheduleInput>;

export interface ScheduleView {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly target: {
    readonly kind: 'job' | 'workflow';
    readonly runtime: string | null;
    readonly workflowId: string | null;
  };
  readonly when:
    { readonly kind: 'at'; readonly at: string } | { readonly kind: 'cron'; readonly cron: string };
  readonly state: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly lastJobId: string | null;
  readonly lastRunId: string | null;
  readonly lastError: string | null;
  readonly runCount: number;
  readonly createdBy: string;
  readonly createdAt: string;
  /** The automation behind the schedule (`/automations/<id>`). */
  readonly automationId: string;
}

export interface ScheduleActor {
  readonly id: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

const STATE: Readonly<Record<string, string>> = { deleted: 'cancelled' };
const STATUS: Readonly<Record<string, string>> = {
  queued: 'firing',
  starting: 'firing',
  running: 'created',
  succeeded: 'created',
  failed: 'created',
  cancelled: 'created',
  skipped: 'failed',
  error: 'failed',
};

function toSchedule(err: unknown): unknown {
  return err instanceof AutomationError ? new ScheduleError(err.status, err.code, err.message) : err;
}

export class ScheduleService {
  constructor(private readonly deps: { readonly automations: () => AutomationService }) {}

  preview(cron: string, count = 5): Date[] {
    try {
      return this.deps.automations().preview(cron, count).nextRuns;
    } catch (err) {
      throw toSchedule(err);
    }
  }

  async #view(id: string): Promise<ScheduleView> {
    const a = await this.deps.automations().get(id);
    const last = (await this.deps.automations().runs(id, { limit: 1 }))[0];
    const t = a.trigger;
    return {
      id: a.id,
      project: a.project,
      name: a.name,
      // Schedules are cron / one-time automations; a deploy target is shown as a workflow-less job slot.
      target: {
        kind: a.target.kind === 'deploy' ? 'job' : a.target.kind,
        runtime: a.target.runtime,
        workflowId: a.target.workflowId,
      },
      when:
        t.kind === 'cron'
          ? { kind: 'cron', cron: t.cron }
          : { kind: 'at', at: t.kind === 'at' ? t.at : a.createdAt },
      state: STATE[a.state] ?? a.state,
      nextRunAt: a.nextRunAt,
      lastRunAt: last?.createdAt ?? null,
      lastStatus: last === undefined ? null : (STATUS[last.state] ?? null),
      lastJobId: last?.jobId ?? null,
      lastRunId: last?.workflowRunId ?? null,
      lastError:
        last !== undefined && (last.state === 'error' || last.state === 'skipped') ? last.reason : null,
      runCount: a.runCount,
      createdBy: a.createdBy,
      createdAt: a.createdAt,
      automationId: a.id,
    };
  }

  async create(actor: ScheduleActor, input: ScheduleInput): Promise<ScheduleView> {
    try {
      const out = await this.deps.automations().create(actor, {
        project: input.project,
        name: input.name,
        trigger:
          input.when.kind === 'cron'
            ? { kind: 'cron', cron: input.when.cron }
            : { kind: 'at', at: input.when.at },
        target: input.target,
        concurrency: 'parallel',
        catchUp: 'once',
      });
      return await this.#view(out.automation.id);
    } catch (err) {
      throw toSchedule(err);
    }
  }

  async list(projects: readonly string[] | null, project?: string): Promise<ScheduleView[]> {
    const items = await this.deps.automations().list(projects, project === undefined ? {} : { project });
    const schedules = items.filter((a) => a.trigger.kind === 'cron' || a.trigger.kind === 'at').slice(0, 200);
    return Promise.all(schedules.map((a) => this.#view(a.id)));
  }

  async cancel(actor: ScheduleActor, id: string): Promise<ScheduleView> {
    try {
      const a = await this.deps.automations().get(id);
      if (a.trigger.kind !== 'cron' && a.trigger.kind !== 'at') {
        throw new ScheduleError(404, 'schedule_not_found', 'Schedule not found.');
      }
      if (a.state !== 'active') {
        throw new ScheduleError(
          409,
          'schedule_not_active',
          `The schedule is already ${STATE[a.state] ?? a.state}.`,
        );
      }
      await this.deps.automations().remove(actor, id);
      return await this.#view(id);
    } catch (err) {
      throw toSchedule(err);
    }
  }

  /** The sweeper (tests): due schedules fire through the automations engine. */
  fireDue(): Promise<number> {
    return this.deps.automations().fireDue();
  }
}
