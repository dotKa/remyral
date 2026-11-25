import { stepUpFresh } from '../approvals/policy-store.js';
import { STEP_UP_ALWAYS_FRESH_MS } from '../auth/step-up.js';
import { HttpError } from '../http/errors.js';
import type { BatchRequest, JobBatchService } from '../jobs/batches.js';
import type { SharedWorkflowService } from '../workflows/sharing.js';
import type { ConfirmContext, CoolifyChangeRunner } from './drafts.js';
import type { DraftRecord } from './store.js';
import type { ThreadProjects } from './thread-projects.js';

/**
 * p18-multi-project W3 + W5: the confirmed cards of the working projects (`thread_projects`), of attaching a shared
 * workflow (`workflow_attach`) and of a job batch (`job_batch`). Each runs the console route's service for the
 * confirming user (their subject and step-up), so the card can never do more than the screen:
 *
 * - `thread_projects` → ThreadProjects.set (every member readable by the confirming user; audited chat.thread.projects);
 * - `workflow_attach` → SharedWorkflowService.attach (offer, `workflows.attach` and — for privileged nodes — the
 *   target's `workflows.define.*` with a fresh step-up; audited workflow.attach);
 * - `job_batch` → JobBatchService.submit (preflight again now, one `jobs.create` per project; audited job.batch.submit).
 */

const unavailable = (): HttpError =>
  new HttpError(
    503,
    'unavailable',
    'This card is not available on this master.',
    {},
    {},
    { reason: 'multi_project' },
  );

export class ThreadProjectsRunner implements CoolifyChangeRunner {
  constructor(
    private readonly deps: {
      readonly threadProjects: () => ThreadProjects | null;
      /** The conversation's stream gets the changed thread (its header re-reads the set). */
      readonly published?: (userId: string, threadId: string) => Promise<void>;
    },
  ) {}

  async run(ctx: ConfirmContext, d: DraftRecord): Promise<Record<string, unknown>> {
    const svc = this.deps.threadProjects();
    if (svc === null) throw unavailable();
    const raw = Array.isArray(d.payload.projects) ? d.payload.projects : [];
    const projects = raw.flatMap((m: unknown) => {
      const x = m as { project?: unknown; share?: unknown };
      return typeof x.project === 'string'
        ? [{ project: x.project, ...(typeof x.share === 'boolean' ? { share: x.share } : {}) }]
        : [];
    });
    const view = await svc.set(ctx.subject, d.threadId, projects, {
      ip: ctx.actor.ip,
      userAgent: ctx.actor.userAgent,
      source: 'chat',
    });
    await this.deps.published?.(ctx.subject.userId, d.threadId).catch(() => undefined);
    return { projects: view.map((v) => ({ project: v.project, share: v.share, primary: v.primary })) };
  }
}

export class WorkflowAttachRunner implements CoolifyChangeRunner {
  constructor(
    private readonly deps: {
      readonly sharing: () => SharedWorkflowService | null;
      readonly clock?: () => Date;
    },
  ) {}

  async run(ctx: ConfirmContext, d: DraftRecord): Promise<Record<string, unknown>> {
    const svc = this.deps.sharing();
    if (svc === null) throw unavailable();
    const p = d.payload;
    const now = (this.deps.clock ?? (() => new Date()))();
    const out = await svc.attach(
      {
        id: ctx.subject.userId,
        subject: ctx.subject,
        // The card's confirmation is the step-up (its event is the attach route's, workflows.privileged).
        stepUpFresh: stepUpFresh(ctx.human.mfaAt, now, ctx.human.stepUpMaxAgeMs ?? STEP_UP_ALWAYS_FRESH_MS),
      },
      String(p.project),
      {
        ownerProject: String(p.ownerProject),
        name: String(p.name),
        follow: p.follow === 'pin' ? 'pin' : 'auto',
        ...(typeof p.version === 'number' ? { version: p.version } : {}),
      },
    );
    return {
      attachmentId: out.attachment.id,
      project: out.attachment.project,
      ownerProject: out.attachment.ownerProject,
      name: out.attachment.name,
      version: out.attachment.version,
      state: out.attachment.state,
      credentialUnbound: [...out.report.credentialUnbound],
      link: `/workflows/${out.attachment.definitionId ?? ''}?project=${encodeURIComponent(out.attachment.project)}`,
    };
  }
}

export class JobBatchRunner implements CoolifyChangeRunner {
  constructor(private readonly deps: { readonly batches: () => JobBatchService | null }) {}

  async run(ctx: ConfirmContext, d: DraftRecord): Promise<Record<string, unknown>> {
    const svc = this.deps.batches();
    if (svc === null) throw unavailable();
    const request = d.payload.request as BatchRequest;
    const out = await svc.submit(ctx.subject, request, {
      kind: 'chat',
      threadId: d.threadId,
      draftId: d.id,
      ip: ctx.actor.ip,
      userAgent: ctx.actor.userAgent,
    });
    if (out.created.length === 0)
      throw new HttpError(
        409,
        'batch_refused',
        `No project could take the job: ${out.refused.map((r) => `${r.project} (${r.code})`).join(', ')}`.slice(
          0,
          500,
        ),
      );
    return {
      batchId: out.batchId,
      created: out.created,
      refused: out.refused.map((r) => ({ project: r.project, code: r.code })),
      link: `/jobs/batches/${out.batchId}`,
    };
  }
}
