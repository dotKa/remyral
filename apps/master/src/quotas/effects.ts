import type { FastifyBaseLogger } from 'fastify';
import type { InboxEffects } from '../orchestration/inbox.js';
import type { SequencedWorkerMessage } from '../workers/replay.js';
import type { QuotaService } from './service.js';

/**
 * Wraps the integration-glue effects (p4-orchestration §8): after a usage EVENT was recorded, the job's run
 * limits are checked (runaway stop on every usage event, docs/design/p4-quotas.md §5). The inner effect
 * stays idempotent; the check is idempotent too (a stopped job is no longer running).
 */
export class QuotaEffects implements InboxEffects {
  constructor(
    private readonly inner: InboxEffects,
    private readonly quotas: QuotaService,
    private readonly log: FastifyBaseLogger,
  ) {}

  async run(
    inboxId: string,
    workerId: string,
    message: Extract<SequencedWorkerMessage, { type: 'EVENT' }>,
  ): Promise<void> {
    await this.inner.run(inboxId, workerId, message);
    if (message.payload.event.kind !== 'usage') return;
    try {
      await this.quotas.onUsage(message.jobId);
    } catch (err) {
      // The usage is recorded; the wall-time loop and the next usage event re-check the limits.
      this.log.error({ err, jobId: message.jobId }, 'run limit check failed');
    }
  }
}
