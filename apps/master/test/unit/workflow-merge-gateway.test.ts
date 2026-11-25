import { describe, expect, it } from 'vitest';
import type { Queryable } from '../../src/db/pool.js';
import { GitFlowError } from '../../src/gitflow/errors.js';
import type { GitFlowService } from '../../src/gitflow/service.js';
import type { JobStore } from '../../src/jobs/store.js';
import { GitFlowMergeGateway } from '../../src/workflows/gitflow-gateway.js';

const INPUT = {
  runId: '11111111-1111-4111-8111-111111111111',
  nodeId: 'integrate',
  jobId: '22222222-2222-4222-8222-222222222222',
  project: 'acme',
  repository: { url: 'https://example.com/acme.git', baseRef: 'main' },
  branches: ['rac/a/1', 'rac/b/2'],
  integrationBranch: 'rac/i/3',
};
const CREATOR = '33333333-3333-4333-8333-333333333333';

function gateway(opts: { enrolled: boolean; state: string; request?: () => Promise<unknown> }): {
  gw: GitFlowMergeGateway;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  const flow = {
    usesGitFlow: () => Promise.resolve(opts.enrolled),
    request: (...args: unknown[]) => {
      calls.push(args);
      return opts.request ? opts.request() : Promise.resolve({ request: { id: 'mr-1' }, created: true });
    },
  } as unknown as GitFlowService;
  const jobs = { get: () => Promise.resolve({ state: opts.state }) } as unknown as JobStore;
  const db = {
    query: () => Promise.resolve({ rows: [{ created_by: CREATOR }], rowCount: 1 }),
  } as unknown as Queryable;
  return { gw: new GitFlowMergeGateway({ gitflow: () => flow, jobs, db }), calls };
}

describe('GitFlowMergeGateway (p4-dag integrator → p4-git-flow)', () => {
  it('projects without git flow only record the request', async () => {
    const { gw, calls } = gateway({ enrolled: false, state: 'SUCCEEDED' });
    expect(await gw.requestMerge(INPUT)).toEqual({ status: 'pending', externalRef: null });
    expect(calls).toEqual([]);
  });

  it('opens the protected merge request for a verified integrator job on behalf of the run creator', async () => {
    const { gw, calls } = gateway({ enrolled: true, state: 'AWAITING_APPROVAL' });
    expect(await gw.requestMerge(INPUT)).toEqual({ status: 'pending', externalRef: 'mr-1' });
    expect(calls[0]?.slice(0, 3)).toEqual([INPUT.jobId, 'merge', { id: CREATOR }]);
  });

  it('nothing to merge when verification already finished the job; refusals end the merge', async () => {
    expect(await gateway({ enrolled: true, state: 'SUCCEEDED' }).gw.requestMerge(INPUT)).toEqual({
      status: 'merged',
      externalRef: null,
    });
    expect(await gateway({ enrolled: true, state: 'FAILED' }).gw.requestMerge(INPUT)).toMatchObject({
      status: 'refused',
    });
    const conflicts = gateway({
      enrolled: true,
      state: 'AWAITING_APPROVAL',
      request: () => Promise.reject(new GitFlowError(409, 'merge_conflicts', 'conflicts')),
    });
    expect(await conflicts.gw.requestMerge(INPUT)).toMatchObject({ status: 'refused' });
  });

  it('a request without an external reference stays pending', async () => {
    const { gw } = gateway({ enrolled: true, state: 'AWAITING_APPROVAL' });
    expect(await gw.status({ id: 'x', runId: INPUT.runId, externalRef: null })).toBe('pending');
  });
});
