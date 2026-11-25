import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import { ChatFlowService } from '../../src/chat/flow.js';
import { gateEventKey, gateId, gateTexts, isGateId, V1_NODE_ID } from '../../src/chat/flow-model.js';
import { CodeService } from '../../src/code/service.js';
import type { GitProvider, OpenPullRequest } from '../../src/gitflow/types.js';
import { HttpError } from '../../src/http/errors.js';

/**
 * p18-last-gaps (docs/design/p18-last-gaps.md): engine-1 workflow gates in the chat (stable step ids, claim keys, the
 * live view and "Senden bekleyen") and comments on compare views (where "Değişiklik iste" goes, the job on a pull
 * request's branch).
 */

const RUN = '11111111-2222-4333-8444-555555555555';
const HEAD = 'b'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);

/** The key check of migration 0188 (chat_flow_events_key_check, the engine-1 branch). */
const GATE_KEY =
  /^(gate|gatedone):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z][a-z0-9_-]{0,47}(\.[a-z][a-z0-9_-]{0,31})?$/;

describe('engine-1 gates: stable step ids and claim keys', () => {
  it('a gate id is a stable version-8 UUID per (run, node), never a version-4 node run', () => {
    const a = gateId(RUN, 'review');
    expect(a).toBe(gateId(RUN.toUpperCase(), 'review'));
    expect(a).not.toBe(gateId(RUN, 'deploy'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isGateId(a)).toBe(true);
    // gen_random_uuid() (engine-2 node runs) is version 4.
    expect(isGateId('9b2f6c1e-4d3a-4f6b-9c8d-7e6f5a4b3c2d')).toBe(false);
    expect(isGateId('not-a-uuid')).toBe(false);
  });

  it('the claim keys fit the migration’s check for every node id engine 1 accepts', () => {
    for (const node of ['review', 'a', 'plan.sub-2', `x${'y'.repeat(47)}`]) {
      expect(V1_NODE_ID.test(node)).toBe(true);
      expect(gateEventKey('gate', RUN, node)).toMatch(GATE_KEY);
      expect(gateEventKey('gatedone', RUN.toUpperCase(), node)).toMatch(GATE_KEY);
    }
    expect(gateEventKey('gate', RUN, 'review')).toBe(`gate:${RUN}:review`);
    expect('gatedone:' + gateEventKey('gate', RUN, 'review').slice(5)).toBe(
      gateEventKey('gatedone', RUN, 'review'),
    );
  });

  it('the card texts are the step title and its prompt, plain and bounded', () => {
    expect(gateTexts({ title: 'Ship\nit', prompt: `  ${'p'.repeat(3000)}` })).toEqual({
      title: 'Ship it',
      details: 'p'.repeat(2000),
    });
    expect(gateTexts({})).toEqual({ title: null, details: null });
    expect(gateTexts(null)).toEqual({ title: null, details: null });
  });
});

describe('engine-1 gates: the live view and "Senden bekleyen"', () => {
  const gateRow = (over: Record<string, unknown> = {}) => ({
    run_id: RUN,
    node_id: 'review',
    def: { id: 'review', title: 'Review the release', prompt: 'Check {{inputs.task}}' },
    state: 'awaiting_approval',
    gate_role: 'admin',
    gate_decision: null,
    gate_decided_at: null,
    decided_by_name: null,
    updated_at: new Date('2026-10-28T10:00:00Z'),
    name: 'release',
    project: 'acme',
    version: 3,
    run_state: 'running',
    source_trust: 'trusted',
    parent_run_id: null,
    ...over,
  });
  function flow(rows: { gate: Record<string, unknown>[]; nodeRuns?: Record<string, unknown>[] }) {
    const seen: string[] = [];
    const pool = {
      query: (sql: string) => {
        seen.push(sql);
        if (sql.includes('SELECT node_id FROM workflow_nodes'))
          return Promise.resolve({ rows: [{ node_id: 'review' }] });
        if (sql.includes('FROM workflow_nodes n JOIN workflow_runs r'))
          return Promise.resolve({ rows: rows.gate });
        if (sql.includes('FROM workflow_node_runs nr')) return Promise.resolve({ rows: rows.nodeRuns ?? [] });
        return Promise.resolve({ rows: [] });
      },
    };
    const svc = new ChatFlowService({
      pool: pool as never,
      store: {} as never,
      clock: () => new Date('2026-10-28T12:00:00Z'),
      log: { error: () => undefined, debug: () => undefined } as never,
      audit: { record: () => Promise.resolve() } as never,
      notifications: () => null,
      publish: () => undefined,
    });
    return { svc, seen };
  }
  const admin: Subject = { userId: 'u1', role: 'admin', memberships: new Map() };
  const operator: Subject = { userId: 'u2', role: 'operator', memberships: new Map([['acme', 'operator']]) };
  const outsider: Subject = { userId: 'u3', role: 'operator', memberships: new Map([['other', 'operator']]) };

  it('a gate id reads the engine-1 gate: engine 1, its node, texts, role and whether the caller may decide', async () => {
    const { svc } = flow({ gate: [gateRow()] });
    const v = await svc.approvalView(admin, RUN, gateId(RUN, 'review'));
    expect(v).toMatchObject({
      engine: 1,
      runId: RUN,
      nodeRunId: gateId(RUN, 'review'),
      node: 'review',
      workflow: 'release',
      title: 'Review the release',
      details: 'Check {{inputs.task}}',
      approverRole: 'admin',
      state: 'waiting',
      canDecide: true,
      untrusted: false,
    });
    // An operator reads it but cannot decide an admin gate; another project's member does not see it.
    expect((await svc.approvalView(operator, RUN, gateId(RUN, 'review')))?.canDecide).toBe(false);
    expect(await svc.approvalView(outsider, RUN, gateId(RUN, 'review'))).toBeNull();
    // An id of another node of the run is unknown.
    expect(await svc.approvalView(admin, RUN, gateId(RUN, 'deploy'))).toBeNull();
  });

  it('decided and closed gates read as such; one decision is shown with who took it', async () => {
    const decided = flow({
      gate: [
        gateRow({
          state: 'pending',
          gate_decision: 'denied',
          gate_decided_at: new Date('2026-10-28T11:00:00Z'),
          decided_by_name: 'ayse',
        }),
      ],
    });
    expect(await decided.svc.approvalView(admin, RUN, gateId(RUN, 'review'))).toMatchObject({
      state: 'denied',
      decidedBy: 'ayse',
      canDecide: false,
    });
    const closed = flow({ gate: [gateRow({ state: 'cancelled' })] });
    expect((await closed.svc.approvalView(admin, RUN, gateId(RUN, 'review')))?.state).toBe('closed');
  });

  it('"Senden bekleyen" lists the engine-1 gates the subject may decide', async () => {
    const { svc, seen } = flow({ gate: [gateRow()] });
    const list = await svc.pending(admin);
    expect(list.map((v) => [v.engine, v.node])).toEqual([[1, 'review']]);
    expect(seen.some((q) => q.includes("n.state = 'awaiting_approval'"))).toBe(true);
    expect(await flow({ gate: [gateRow()] }).svc.pending(operator)).toEqual([]);
  });
});

describe('compare views: where "Değişiklik iste" goes', () => {
  const pr = (over: Partial<OpenPullRequest>): OpenPullRequest => ({
    number: 7,
    title: 'Add billing',
    url: 'https://github.com/acme/app/pull/7',
    author: 'dev',
    draft: false,
    baseBranch: 'main',
    headBranch: 'feature/billing',
    headSha: HEAD,
    sameRepository: true,
    updatedAt: '2026-10-28T10:00:00Z',
    ...over,
  });

  function service(opts: {
    jobRow?: { job_id: string; branch: string | null };
    pulls?: OpenPullRequest[] | Error;
    comments?: Record<string, unknown>[];
  }) {
    const created: { project: string; spec: Record<string, unknown> }[] = [];
    const audits: Record<string, unknown>[] = [];
    const queries: { sql: string; params: unknown[] }[] = [];
    const provider = {
      kind: 'github',
      tree: () => Promise.resolve(null),
      blob: () => Promise.resolve({ state: 'text', size: 20, text: 'one\ntwo\nthree\nfour\n' }),
      branchHead: () => Promise.resolve(HEAD),
      compare: () => Promise.resolve({ mergeBase: MERGE_BASE, files: [], truncated: false }),
      ...(opts.pulls === undefined
        ? {}
        : {
            openPullRequests: () =>
              opts.pulls instanceof Error ? Promise.reject(opts.pulls) : Promise.resolve(opts.pulls ?? []),
          }),
    } as unknown as GitProvider;
    const pool = {
      query: (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes('FROM job_git g'))
          return Promise.resolve({ rows: opts.jobRow === undefined ? [] : [opts.jobRow] });
        if (sql.includes('FROM code_compare_comments c'))
          return Promise.resolve({ rows: opts.comments ?? [] });
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const svc = new CodeService({
      pool: pool as never,
      audit: {
        record: (e: Record<string, unknown>) => {
          audits.push(e);
          return Promise.resolve();
        },
      } as never,
      providers: () => ({
        providerFor: () =>
          Promise.resolve({
            provider,
            config: {
              baseBranch: 'main',
              version: 1,
              repositoryUrl: 'https://github.com/acme/app.git',
            } as never,
          }),
      }),
      jobs: {
        create: (input: { project: string; spec: Record<string, unknown> }) => {
          created.push(input);
          return Promise.resolve({ job: { id: '99999999-2222-4333-8444-555555555555' } });
        },
      } as never,
      defaults: {
        apply: (_p: string, spec: Record<string, unknown>) =>
          Promise.resolve({
            spec: {
              ...spec,
              sourceTrust: 'trusted',
              sandboxProfile: 'container',
              approvalPolicy: 'ask-sensitive',
              limits: { maxDurationSec: 3600 },
            },
            filled: [],
          }),
        facts: () =>
          Promise.resolve({ runtimes: [{ runtime: 'codex', feasible: ['w1'], eligible: ['w1'] }] }),
      } as never,
      clock: () => new Date('2026-10-28T12:00:00Z'),
    });
    return { svc, created, audits, queries };
  }
  const op = {
    subject: { userId: 'u2', role: 'operator', memberships: new Map([['acme', 'operator']]) } as Subject,
    userId: 'u2',
    ip: '127.0.0.1',
    userAgent: null,
  };

  it('a job’s branch (or verified head) → that job', async () => {
    const { svc } = service({ jobRow: { job_id: 'job-1', branch: 'rac/abc/def' } });
    expect(await svc.compareTarget('acme', 'rac/abc/def')).toEqual({
      mode: 'job',
      jobId: 'job-1',
      branch: 'rac/abc/def',
    });
  });

  it('an open pull request of the same repository → a new job on its branch; a fork or nothing → why not', async () => {
    expect(await service({ pulls: [pr({})] }).svc.compareTarget('acme', HEAD)).toEqual({
      mode: 'pull',
      number: 7,
      headBranch: 'feature/billing',
      baseBranch: 'main',
      headSha: HEAD,
    });
    expect((await service({ pulls: [pr({})] }).svc.compareTarget('acme', 'feature/billing')).mode).toBe(
      'pull',
    );
    expect(await service({ pulls: [pr({ sameRepository: false })] }).svc.compareTarget('acme', HEAD)).toEqual(
      { mode: 'none', reason: 'pull_fork' },
    );
    expect(await service({ pulls: [] }).svc.compareTarget('acme', 'develop')).toEqual({
      mode: 'none',
      reason: 'no_target',
    });
    expect(await service({}).svc.compareTarget('acme', 'develop')).toEqual({
      mode: 'none',
      reason: 'no_target',
    });
    expect(await service({ pulls: new Error('down') }).svc.compareTarget('acme', 'develop')).toEqual({
      mode: 'none',
      reason: 'provider_unavailable',
    });
  });

  it('refs that are neither a branch name nor a sha are refused', async () => {
    await expect(service({}).svc.compareTarget('acme', '--upload-pack=x')).rejects.toBeInstanceOf(HttpError);
  });

  it('nowhere to send it → 409 with the reason, nothing created', async () => {
    const { svc, created } = service({ pulls: [] });
    const err = await svc
      .compareRequestChanges(op, 'acme', { base: 'main', head: 'develop' }, { note: 'Fix it' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(409);
    expect(created).toEqual([]);
  });

  it('a pull request → a job at its head whose pull request targets its branch, the review in the prompt', async () => {
    const thread = {
      cid: '33333333-2222-4333-8444-555555555555',
      pid: null,
      aid: 'u2',
      username: 'op',
      path: 'src/a.ts',
      side: 'new',
      start_line: 2,
      end_line: 3,
      commit_sha: HEAD,
      body: 'Name this better',
      resolved_at: null,
      sent_at: null,
      created_at: new Date('2026-10-28T11:00:00Z'),
      updated_at: new Date('2026-10-28T11:00:00Z'),
    };
    const { svc, created, audits, queries } = service({ pulls: [pr({})], comments: [thread] });
    const out = await svc.compareRequestChanges(
      op,
      'acme',
      { base: 'main', head: HEAD },
      {
        note: 'Please tidy up',
        hunks: [{ path: 'src/a.ts', oldStart: 1, oldEnd: 1, newStart: 2, newEnd: 3 }],
      },
    );
    expect(out).toMatchObject({ mode: 'job', target: 'pull', comments: 1, messageId: null });
    const job = created[0];
    expect(job?.project).toBe('acme');
    expect(job?.spec).toMatchObject({
      projectId: 'acme',
      runtime: 'codex',
      sourceTrust: 'trusted',
      repository: { url: 'https://github.com/acme/app.git', baseRef: HEAD, targetBranch: 'feature/billing' },
    });
    const prompt = String(job?.spec.prompt);
    expect(prompt).toContain('pull request #7');
    expect(prompt).toContain('Please tidy up');
    expect(prompt).toContain('src/a.ts:2-3 (after the change): Name this better');
    expect(prompt).toContain('two\nthree');
    // Sent comments are stamped; the audit names the target, never a `code` key.
    expect(queries.some((q) => q.sql.startsWith('UPDATE code_compare_comments SET sent_at'))).toBe(true);
    expect(audits[0]).toMatchObject({
      action: 'code.review.request_changes',
      target: 'project:acme',
      metadata: { source: 'compare', reason: 'pull_request', pullRequest: 7 },
    });
    expect(Object.keys(audits[0]?.metadata as object)).not.toContain('code');
  });

  it('an operator without jobs.create in the project is refused', async () => {
    const viewer = {
      ...op,
      subject: { userId: 'u4', role: 'viewer', memberships: new Map([['acme', 'viewer']]) } as Subject,
    };
    const { svc, created } = service({ pulls: [pr({})] });
    await expect(
      svc.compareRequestChanges(viewer, 'acme', { base: 'main', head: HEAD }, { note: 'x' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(created).toEqual([]);
  });
});
