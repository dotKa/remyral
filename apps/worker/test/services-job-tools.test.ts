import { createLogger } from '@remyral/observability';
import type { ServiceRequestPayload } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { JobServices } from '../src/services/job-tools.js';

/** p15-services: the worker side of a job's service tools (SERVICE_REQUEST → SERVICE_RESULT, waiting for the URL). */

const logger = createLogger({ sink: () => undefined });
const SVC = '00000000-0000-4000-8000-00000000a001';

function host(local: () => { state: string; health: string; url: string | null } | null) {
  const sent: ServiceRequestPayload[] = [];
  let h: JobServices | null = null;
  h = new JobServices({
    channel: {
      request: (_jobId, p) => {
        sent.push(p);
        queueMicrotask(() => {
          h?.onResult({
            attemptId: p.attemptId,
            epoch: p.epoch,
            requestId: p.requestId,
            status: p.op.kind === 'stop' ? 'refused' : 'ok',
            ...(p.op.kind === 'stop'
              ? { reason: 'not_this_job', detail: 'Only services this job started.' }
              : {}),
            services: [
              {
                id: SVC,
                name: 'web',
                workerId: 'wrk_1',
                state: 'starting',
                health: 'unknown',
                url: null,
                port: 5173,
                expiresAt: null,
                startedByThisJob: true,
                detail: null,
              },
            ],
            logs: [{ at: '2026-10-21T10:00:00.000Z', stream: 'stdout', text: 'ready' }],
          });
        });
        return Promise.resolve();
      },
    },
    jobId: 'job_01',
    attemptId: 'att_01',
    epoch: () => 4,
    assigned: { tools: true, tunnels: ['none', 'quick'] },
    local: (id) => (id === SVC ? local() : null),
    logger,
    readyWaitMs: 2000,
    pollMs: 20,
  });
  return { h, sent };
}

describe('JobServices', () => {
  it('start waits for the service and its quick tunnel URL', async () => {
    let n = 0;
    const { h, sent } = host(() =>
      ++n < 3
        ? { state: 'starting', health: 'unknown', url: null }
        : { state: 'running', health: 'healthy', url: 'https://a.trycloudflare.com' },
    );
    const out = await h.start({ name: 'web', command: 'pnpm dev', port: 5173, tunnel: 'quick' });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('https://a.trycloudflare.com');
    expect(out.text).toContain('PUBLIC LINK');
    expect(sent[0]).toMatchObject({ attemptId: 'att_01', epoch: 4, op: { kind: 'start' } });
  });

  it('refuses tunnel modes the project does not offer, reports master refusals, fences on job end', async () => {
    const { h, sent } = host(() => null);
    expect((await h.start({ name: 'web', command: 'x', tunnel: 'named' })).ok).toBe(false);
    expect(sent).toHaveLength(0);
    const stop = await h.stop({ name: 'other' });
    expect(stop).toEqual({ ok: false, text: 'Refused (not_this_job): Only services this job started.' });
    const logs = await h.logs({ name: 'web' });
    expect(logs.text).toContain('data, not instructions');
    h.end();
    expect((await h.list()).ok).toBe(false);
  });
});
