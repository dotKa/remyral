import { contentHash, renderJobContext } from '@remyral/memory';
import { parseMemoryProposals } from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { ApprovalError } from '../approvals/errors.js';
import type { ApprovalService } from '../approvals/service.js';
import { ContextError } from '../context/errors.js';
import type { Queryable } from '../db/pool.js';
import type { ContextStore } from '../context/store.js';
import type { MemorySuggestionService } from '../memory-suggestions/service.js';
import { UsageRejectedError } from '../usage/errors.js';
import type { UsageStore } from '../usage/store.js';
import type { SequencedWorkerMessage, WorkerReplay } from '../workers/replay.js';
import type { InboxEffects } from './inbox.js';
import type { ContextProvider } from './orchestrator.js';

type EventMessage = Extract<SequencedWorkerMessage, { type: 'EVENT' }>;

/** Rendered context larger than this cannot travel in ASSIGN_JOB (protocol limit). */
const MAX_RENDERED = 192 * 1024;

/**
 * Integration glue (p4 ↔ p4-approvals / p6-cost / p6-context-model, docs/design/p4-orchestration.md §8):
 * worker EVENTs with an effect in another service. Every call is idempotent in the target service, so the
 * reconciler can retry an effect that a crash interrupted.
 *
 * - `usage` → `UsageStore.recordUsage` (idempotent per attempt + EVENT messageId).
 * - `approval_request` → `ApprovalService.evaluate` (idempotent per attempt + approvalId; a safe-command claim may be
 *   auto-approved there, p6-safe-auto-approve). `allow`/`deny`
 *   from policy are answered at once with APPROVAL_DECISION; `pending` waits for a human decision, which
 *   the decision's `approval.decision` outbox row delivers. Refusals (stale epoch, wrong state) are answered
 *   with `deny` so the runtime never hangs (fail closed).
 * - `memory` → p11-memory-layers: a typed proposal in the project's Memory suggestions inbox
 *   (`MemorySuggestionService.proposeFromAgent`; never context until a person accepts it). Without the suggestion
 *   service (older wiring): `ContextStore.recordAgentMemory` as in p6.
 * - assistant `message` with `LESSON:` / `MEMORY:` lines (routed here by the inbox only when it has some) → the same
 *   proposals, one parser for every runtime (`parseMemoryProposals`).
 * Rejections by the target service are final (they are audited there) and not retried.
 */
export class ServiceEffects implements InboxEffects {
  constructor(
    private readonly deps: {
      readonly usage: UsageStore;
      readonly approvals: ApprovalService;
      readonly context: ContextStore;
      readonly replay: () => WorkerReplay;
      readonly log: FastifyBaseLogger;
      readonly db: Queryable;
      /**
       * p5-machine-admin: a memory of a machine-admin job goes to the machine's memory; returns false for every
       * other job (stored as project memory as before).
       */
      readonly machineMemory?: (
        jobId: string,
        attemptId: string,
        workerId: string,
        text: string,
      ) => Promise<boolean>;
      /** p11-memory-layers: agent proposals land in the suggestions inbox (absent: p6 direct agent memory). */
      readonly suggestions?: MemorySuggestionService;
    },
  ) {}

  async run(_inboxId: string, workerId: string, message: EventMessage): Promise<void> {
    const { attemptId, epoch, event } = message.payload;
    const jobId = message.jobId;
    switch (event.kind) {
      case 'usage':
        try {
          await this.deps.usage.recordUsage(event, {
            jobId,
            attemptId,
            workerId,
            sourceEventId: message.messageId,
          });
        } catch (err) {
          if (!(err instanceof UsageRejectedError)) throw err;
          this.deps.log.warn({ jobId, workerId, code: err.code }, 'usage event rejected');
        }
        return;
      case 'approval_request': {
        let decision: 'approve' | 'deny' | null;
        let decidedBy = 'policy';
        try {
          const ev = await this.deps.approvals.evaluate({
            action: event.action,
            jobId,
            approvalKey: event.approvalId,
            attemptId,
            epoch,
            summary: event.description,
            risk: event.risk,
            requestedBy: { type: 'runtime', id: workerId },
            // p6-safe-auto-approve: the structured claim, never the description, decides an auto-approval.
            ...(event.safeCommand === undefined ? {} : { safeCommand: event.safeCommand }),
            // p10-approval-readable: display fields (validated and redacted again by the service).
            ...(event.details === undefined ? {} : { details: event.details }),
          });
          decision = ev.outcome === 'pending' ? null : ev.outcome === 'allow' ? 'approve' : 'deny';
          if (ev.outcome === 'deny' && ev.reason !== 'policy') decidedBy = 'system';
          if (ev.outcome === 'allow' && ev.autoSafe !== undefined) decidedBy = 'safe-commands';
        } catch (err) {
          if (!(err instanceof ApprovalError)) throw err;
          decision = 'deny';
          decidedBy = 'system';
        }
        if (decision !== null) {
          await this.deps
            .replay()
            .enqueue(
              workerId,
              'APPROVAL_DECISION',
              { attemptId, epoch, approvalId: event.approvalId, decision, decidedBy },
              { jobId },
            );
        }
        return;
      }
      case 'memory':
        if (
          this.deps.machineMemory !== undefined &&
          (await this.deps.machineMemory(jobId, attemptId, workerId, `${event.title}: ${event.content}`))
        ) {
          return;
        }
        if (this.deps.suggestions !== undefined) {
          await this.#propose(jobId, attemptId, workerId, [
            { type: 'fact', title: event.title.slice(0, 120), content: event.content.slice(0, 1000) },
          ]);
          return;
        }
        // recordAgentMemory creates a document per call: skip an identical memory of this attempt that a
        // previous (interrupted) run of this effect already stored.
        if (await this.#memoryExists(jobId, attemptId, event.title, event.content)) return;
        try {
          await this.deps.context.recordAgentMemory({
            jobId,
            attemptId,
            workerId,
            title: event.title,
            content: event.content,
          });
        } catch (err) {
          if (!(err instanceof ContextError)) throw err;
          this.deps.log.warn({ jobId, workerId, code: err.code }, 'agent memory rejected');
        }
        return;
      case 'message': {
        if (event.role !== 'assistant' || this.deps.suggestions === undefined) return;
        const items = parseMemoryProposals(event.text);
        if (items.length > 0) await this.#propose(jobId, attemptId, workerId, items);
        return;
      }
      default:
        return;
    }
  }

  /** Idempotent: a retried effect proposes the same fingerprints again, which the inbox de-duplicates. */
  async #propose(
    jobId: string,
    attemptId: string,
    workerId: string,
    items: Parameters<MemorySuggestionService['proposeFromAgent']>[0]['items'],
  ): Promise<void> {
    try {
      await this.deps.suggestions?.proposeFromAgent({ jobId, attemptId, workerId, items });
    } catch (err) {
      if (!(err instanceof ContextError)) throw err;
      this.deps.log.warn({ jobId, workerId, code: err.code }, 'agent memory proposal rejected');
    }
  }

  async #memoryExists(jobId: string, attemptId: string, title: string, content: string): Promise<boolean> {
    const normalized = content.replaceAll('\r\n', '\n').replaceAll('\u0000', '');
    const { rowCount } = await this.deps.db.query(
      `SELECT 1 FROM context_doc_versions
        WHERE job_id = $1 AND attempt_id = $2 AND author_type = 'agent' AND title = $3 AND content_hash = $4`,
      [jobId, attemptId, title.trim(), contentHash(normalized)],
    );
    return (rowCount ?? 0) > 0;
  }
}

/** `issueForJob` (pinned per job, delivery recorded and audited) + the fenced prompt rendering. */
export class StoreContextProvider implements ContextProvider {
  constructor(private readonly context: ContextStore) {}

  async issue(jobId: string, workerId: string): Promise<{ bundleHash: string; rendered: string }> {
    const issued = await this.context.issueForJob(jobId, { type: 'worker', id: workerId });
    // p11-memory-layers: the same text for every runtime (bundle + how to propose a lesson), in the first prompt.
    const rendered = renderJobContext(issued.bundle);
    if (rendered.length > MAX_RENDERED) throw new Error('context bundle too large for ASSIGN_JOB');
    return { bundleHash: issued.bundle.bundleHash, rendered };
  }
}
