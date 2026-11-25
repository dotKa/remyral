import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import { derivedStatus, type LinkFacts } from '../../src/chat/plan-model.js';
import { planProjectRefusal, projectSetRefusal, writeTargets } from '../../src/chat/project-set.js';
import {
  normaliseSet,
  setChanges,
  type ThreadProjectMember,
  workingProjectsBlock,
} from '../../src/chat/thread-projects.js';
import { batchState, JobBatchService, projectPrompt } from '../../src/jobs/batches.js';
import { computeLinks } from '../../src/search/chat-knowledge.js';
import { eventOfDraft } from '../../src/security-policy/events.js';

/**
 * p18-multi-project W3 + W5 (docs/design/p18-multi-project.md "Built: W3 + W5"): the pure rules of the working projects,
 * the write targeting matrix, the plan item rule, knowledge links of every member, the batch preflight with fake
 * project rows / holds / defaults, the batch state and a plan item following a batch.
 */
const subject = (role: 'owner' | 'admin' | 'operator' | 'viewer', projects: string[] = []): Subject =>
  ({
    userId: '11111111-1111-4111-8111-111111111111',
    role,
    memberships: new Map(projects.map((p) => [p, role === 'viewer' ? 'viewer' : 'operator'])),
  }) as unknown as Subject;

describe('working projects of a conversation (W3)', () => {
  const before: ThreadProjectMember[] = [
    { project: 'alpha', share: true, primary: true },
    { project: 'beta', share: false, primary: false },
  ];

  it('normalises a new set: the first is primary, switches default to the current value, else on', () => {
    const r = normaliseSet(
      [{ project: 'beta' }, { project: 'gamma' }, { project: 'alpha', share: false }],
      before,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.set).toEqual([
      { project: 'beta', share: false, primary: true },
      { project: 'gamma', share: true, primary: false },
      { project: 'alpha', share: false, primary: false },
    ]);
    expect(normaliseSet([{ project: 'a' }, { project: 'a' }], []).ok).toBe(false);
    expect(normaliseSet([{ project: 'bad id' }], []).ok).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => ({ project: `p${String(i)}` }));
    const many = normaliseSet(nine, []);
    expect(!many.ok && many.code).toBe('too_many_projects');
    expect(normaliseSet([], before)).toEqual({ ok: true, set: [] });
  });

  it('names what changed (added, removed, switches, primary)', () => {
    const r = normaliseSet([{ project: 'beta', share: true }, { project: 'gamma' }], before);
    if (!r.ok) throw new Error('set');
    expect(setChanges(before, r.set)).toEqual({
      added: ['gamma'],
      removed: ['alpha'],
      shareChanged: ['beta'],
      primaryChanged: true,
    });
  });

  it('the "Çalışma projeleri" block lists the set as fenced data, with the rule for several projects', () => {
    expect(workingProjectsBlock([])).toBeNull();
    const one = workingProjectsBlock([
      { project: 'alpha', name: 'Alpha', kind: 'repository', role: 'operator', share: true, primary: true },
    ]);
    expect(one).toContain('REMYRAL-DATA');
    expect(one).toContain('"id": "alpha"');
    expect(one).toContain('set_thread_projects');
    const two = workingProjectsBlock([
      { project: 'alpha', name: 'Alpha', kind: 'repository', role: 'operator', share: true, primary: true },
      { project: 'beta', name: 'Beta', kind: 'workspace', role: 'viewer', share: false, primary: false },
    ]);
    expect(two).toContain('"sharedWithProjectKnowledge": false');
    expect(two).toContain('ask_user');
  });

  it('every working project links the messages like the primary (knowledge)', () => {
    const msgs = [
      { id: 'm1', seq: 1, role: 'user' as const, turn_id: null, meta: null },
      { id: 'm2', seq: 2, role: 'assistant' as const, turn_id: 't1', meta: null },
    ];
    const links = computeLinks(['alpha', 'beta'], msgs, []);
    expect([...(links.get('m1') ?? new Map()).entries()]).toEqual([
      ['alpha', 'thread'],
      ['beta', 'thread'],
    ]);
    // The old single-project form still works.
    expect([...(computeLinks('alpha', msgs, []).get('m2') ?? new Map()).keys()]).toEqual(['alpha']);
    expect(computeLinks(null, msgs, []).size).toBe(0);
  });
});

describe('write targeting with a project set (W3)', () => {
  const set = ['alpha', 'beta'];

  it('writes name the projects they target; reads and set_thread_projects are not targeted', () => {
    expect(writeTargets('draft_job', { project: 'alpha' })).toEqual(['alpha']);
    expect(writeTargets('draft_job_batch', { projects: ['alpha', 'gamma'] })).toEqual(['alpha', 'gamma']);
    expect(writeTargets('list_jobs', { project: 'gamma' })).toEqual([]);
    expect(writeTargets('set_thread_projects', { projects: [{ project: 'gamma' }] })).toEqual([]);
  });

  it('refuses a write outside the set (project_not_in_thread); allows inside; no set → no rule', () => {
    expect(projectSetRefusal('draft_job', { project: 'alpha' }, set)).toBeNull();
    const out = projectSetRefusal('draft_job', { project: 'gamma' }, set);
    expect(out?.code).toBe('project_not_in_thread');
    expect(out?.message).toContain('set_thread_projects');
    expect(projectSetRefusal('draft_job_batch', { projects: ['alpha', 'gamma'] }, set)?.code).toBe(
      'project_not_in_thread',
    );
    expect(projectSetRefusal('attach_workflow', { project: 'gamma', workflowId: 'x' }, set)?.code).toBe(
      'project_not_in_thread',
    );
    expect(projectSetRefusal('draft_job', { project: 'gamma' }, [])).toBeNull();
    expect(projectSetRefusal('list_jobs', { project: 'gamma' }, set)).toBeNull();
  });

  it('plan items: a project outside the set is refused; job / workflow items need one when there are several', () => {
    const create = (items: Record<string, unknown>[]) => ({
      title: 'P',
      goal: 'G',
      phases: [{ title: 'Ph', items }],
    });
    expect(
      planProjectRefusal('plan_create', create([{ key: 'a', owner: 'job', project: 'gamma' }]), set)?.code,
    ).toBe('project_not_in_thread');
    expect(planProjectRefusal('plan_create', create([{ key: 'a', owner: 'job' }]), set)?.code).toBe(
      'project_required',
    );
    expect(planProjectRefusal('plan_create', create([{ key: 'a', owner: 'assistant' }]), set)).toBeNull();
    expect(planProjectRefusal('plan_create', create([{ key: 'a', owner: 'job' }]), ['alpha'])).toBeNull();
    expect(
      planProjectRefusal(
        'plan_update_items',
        { ops: [{ op: 'set_project', key: 'a', project: 'gamma' }] },
        set,
      )?.code,
    ).toBe('project_not_in_thread');
    expect(
      planProjectRefusal(
        'plan_update_items',
        { ops: [{ op: 'add', item: { key: 'b', owner: 'workflow' } }] },
        set,
      )?.code,
    ).toBe('project_required');
  });

  it('cards: attaching a workflow asks for the privileged event of the attach route', () => {
    expect(eventOfDraft('workflow_attach', {})).toBe('workflows.privileged');
    expect(eventOfDraft('thread_projects', {})).toBe('chat.cards');
    expect(eventOfDraft('job_batch', {})).toBe('chat.cards');
  });
});

describe('job fan-out batches (W5)', () => {
  it('fills {{project.id}} / {{project.name}} and appends a project’s own instructions', () => {
    expect(
      projectPrompt('Update {{ project.name }} ({{project.id}})', { id: 'a', name: 'Alpha' }, undefined),
    ).toBe('Update Alpha (a)');
    expect(projectPrompt('Do it', { id: 'a', name: 'A' }, 'Also docs')).toBe('Do it\n\nAlso docs');
  });

  it('the batch state follows its created jobs', () => {
    expect(batchState([{ jobId: null, state: null }]).state).toBe('refused');
    expect(
      batchState([
        { jobId: 'j1', state: 'SUCCEEDED' },
        { jobId: 'j2', state: 'RUNNING' },
      ]).state,
    ).toBe('running');
    expect(
      batchState([
        { jobId: 'j1', state: 'SUCCEEDED' },
        { jobId: null, state: null },
      ]),
    ).toMatchObject({ state: 'done', succeeded: 1, failed: 0 });
    expect(
      batchState([
        { jobId: 'j1', state: 'SUCCEEDED' },
        { jobId: 'j2', state: 'FAILED' },
      ]),
    ).toMatchObject({ state: 'failed', failed: 1 });
  });

  it('preflight: per project its own job or why not (held, budget, no repository, no role, not visible)', async () => {
    const projects = [
      { id: 'a', name: 'Alpha', kind: 'repository', repo: 'https://example.com/a.git' },
      { id: 'b', name: 'Beta', kind: 'repository', repo: 'https://example.com/b.git' },
      { id: 'c', name: 'Gamma', kind: 'workspace', repo: null },
      { id: 'd', name: 'Delta', kind: 'repository', repo: null },
      { id: 'e', name: 'Eps', kind: 'repository', repo: 'https://example.com/e.git' },
    ];
    const db = {
      query: (sql: string, params: unknown[]) => {
        if (sql.includes('FROM projects p LEFT JOIN project_git_configs'))
          return Promise.resolve({
            rows: projects.map((p) => ({
              id: p.id,
              name: p.name,
              kind: p.kind,
              host_execution: false,
              unconfined_execution: false,
              auto_approve_execution: false,
              repository_url: p.repo,
              base_branch: p.repo === null ? null : 'main',
            })),
          });
        if (sql.includes('SELECT kind FROM projects'))
          return Promise.resolve({ rows: [{ kind: projects.find((p) => p.id === params[0])?.kind }] });
        return Promise.resolve({ rows: [] });
      },
    };
    const svc = new JobBatchService({
      pool: db as never,
      audit: { record: () => Promise.resolve() } as never,
      createJob: () => Promise.reject(new Error('not in a preflight')),
      applyDefaults: (_p, spec) =>
        Promise.resolve({
          spec: {
            sandboxProfile: 'container',
            approvalPolicy: 'ask-sensitive',
            ...spec,
            limits: { maxDurationSec: 3600 },
          },
          filled: ['sandboxProfile', 'limits'],
        }),
      holds: (project) =>
        Promise.resolve(
          project === 'b'
            ? [{ code: 'project_hold', message: 'project b is on hold' }]
            : project === 'e'
              ? [{ code: 'budget_exceeded', message: 'budget' }]
              : project === 'a'
                ? [{ code: 'concurrency', message: 'two jobs run already' }]
                : [],
        ),
    });
    const who = subject('operator', ['a', 'b', 'c', 'd', 'e']);
    const plan = await svc.plan(who, {
      projects: ['a', 'b', 'c', 'd', 'e', 'x'],
      spec: { title: 'Bump deps', prompt: 'Bump {{project.name}}', runtime: 'codex' },
      perProject: { a: { baseRef: 'develop', prompt: 'Also the lockfile.' } },
    });
    expect(plan.refused.find((r) => r.project === 'a')).toBeUndefined();
    expect(plan.ready.map((r) => r.project)).toEqual(['a', 'c']);
    const a = plan.ready[0];
    expect(a?.spec).toMatchObject({
      projectId: 'a',
      prompt: 'Bump Alpha\n\nAlso the lockfile.',
      repository: { url: 'https://example.com/a.git', baseRef: 'develop' },
      sandboxProfile: 'container',
    });
    expect(a?.waits).toEqual(['two jobs run already']);
    expect(plan.ready[1]?.spec.repository).toBeUndefined();
    expect(Object.fromEntries(plan.refused.map((r) => [r.project, r.code]))).toEqual({
      b: 'project_held',
      d: 'repository_missing',
      e: 'budget_exceeded',
      x: 'not_found',
    });
    // A viewer may create no job anywhere (the role check comes first and reveals nothing about the project).
    const viewer = await svc.plan(subject('viewer', ['a']), {
      projects: ['a', 'c'],
      spec: { title: 'T', prompt: 'P', runtime: 'codex' },
    });
    expect(viewer.ready).toEqual([]);
    expect(viewer.refused.map((r) => r.code)).toEqual(['forbidden', 'forbidden']);
  });

  it('a plan item linked to a batch (directly or through its confirmed card) follows the batch', () => {
    const B = '22222222-2222-4222-8222-222222222222';
    const D = '33333333-3333-4333-8333-333333333333';
    const facts = (state: 'running' | 'done' | 'failed' | 'refused'): LinkFacts => ({
      drafts: new Map([[D, { state: 'confirmed', jobId: null, runId: null, batchId: B }]]),
      jobs: new Map(),
      runs: new Map(),
      batches: new Map([[B, { state, note: state === 'failed' ? '1/2 jobs failed' : null }]]),
    });
    const viaCard = derivedStatus([{ kind: 'draft', id: D }], facts('running'));
    expect(viaCard?.status).toBe('in_progress');
    expect(viaCard?.addLinks).toEqual([{ kind: 'batch', id: B }]);
    expect(derivedStatus([{ kind: 'batch', id: B }], facts('done'))?.status).toBe('done');
    const failed = derivedStatus([{ kind: 'batch', id: B }], facts('failed'));
    expect(failed).toMatchObject({ status: 'blocked', note: '1/2 jobs failed' });
  });
});
