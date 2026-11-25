import { createHash } from 'node:crypto';
import type { ContextProvider } from '../orchestration/orchestrator.js';

/**
 * p17-embeddings (docs/design/p17-embeddings.md §4): appends the "similar past jobs" block — fenced untrusted data,
 * chosen once per job — after everything else a job's context carries (bundle, upstream outputs, the trigger event).
 * It can only add a block; when the lookup is off, fails or is slow, the inner context goes out unchanged. A job whose
 * inner provider gives no context (function jobs) gets no block either.
 */

const MAX_RENDERED = 192 * 1024;

export class RelatedContextProvider implements ContextProvider {
  constructor(
    private readonly inner: ContextProvider,
    private readonly block: (jobId: string) => Promise<string | null>,
  ) {}

  async issue(jobId: string, workerId: string): Promise<{ bundleHash: string; rendered: string } | null> {
    const base = await this.inner.issue(jobId, workerId);
    if (base === null) return null;
    const extra = await this.block(jobId).catch(() => null);
    if (extra === null || extra === '') return base;
    const rendered = `${base.rendered}\n\n${extra}`;
    if (rendered.length > MAX_RENDERED) return base;
    return { bundleHash: `sha256:${createHash('sha256').update(rendered).digest('hex')}`, rendered };
  }
}
