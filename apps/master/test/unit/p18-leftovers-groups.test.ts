import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import {
  AutomationGroupAddProjects,
  AutomationGroupService,
  inputOfDetail,
} from '../../src/automations/groups.js';
import { AutomationError, type AutomationDetail, type AutomationInput } from '../../src/automations/model.js';
import type { AutomationActor, AutomationService } from '../../src/automations/service.js';

/**
 * p18-leftovers item 1 (docs/design/p18-multi-project.md §11 "Leftovers"): a project added to an existing automation
 * group (the reference sibling's configuration, adapted per project, refusals listed) and the group's pause / resume /
 * delete in one action (each sibling through the single action, refusals and hidden siblings listed / counted).
 */

const USER = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const subject = (
  role: 'owner' | 'admin' | 'operator' | 'viewer',
  projects: Record<string, string> = {},
): Subject => ({ userId: USER, role, memberships: new Map(Object.entries(projects)) }) as unknown as Subject;

const PROJECTS = [
  { id: 'alpha', kind: 'repository', repo: 'https://github.com/acme/alpha.git', base: 'main' },
  { id: 'beta', kind: 'repository', repo: 'https://github.com/acme/beta.git', base: 'develop' },
  { id: 'gamma', kind: 'workspace' },
  { id: 'delta', kind: 'repository' },
] as const;

function detail(over: Partial<AutomationDetail> = {}): AutomationDetail {
  return {
    id: 'a1',
    project: 'alpha',
    name: 'Nightly deps',
    description: 'Keeps deps fresh',
    state: 'active',
    enabled: true,
    trigger: { kind: 'cron', cron: '0 3 * * *', timeZone: 'Europe/Istanbul' },
    triggerSummary: 'every day 03:00',
    timeZone: 'Europe/Istanbul',
    target: {
      kind: 'job',
      deployAction: null,
      runtime: 'codex',
      workflowId: null,
      title: 'Update',
      approvalPolicy: 'ask-sensitive',
      sandboxProfile: 'container',
    },
    approvalTimeoutMinutes: 30,
    reuseWithinHours: null,
    waiting: null,
    concurrency: 'skip',
    catchUp: 'once',
    maxRunsPerHour: 4,
    notifyOnFailure: true,
    nextRunAt: null,
    lastRun: null,
    runCount: 0,
    successRate: null,
    webhook: null,
    runAs: USER,
    createdBy: USER,
    createdAt: '2026-10-28T00:00:00Z',
    updatedAt: '2026-10-28T00:00:00Z',
    workflowBinding: null,
    group: { id: GROUP, name: 'Nightly deps', size: 2, diverged: false },
    targetSpec: {
      spec: {
        projectId: 'alpha',
        runtime: 'codex',
        prompt: 'Update the dependencies.',
        repository: { url: 'https://github.com/acme/alpha.git', baseRef: 'main', workBranch: 'agent/auto-x' },
      },
      priority: 0,
      workflowInputs: null,
      workflowRepository: null,
      files: [{ id: 'in-abc', name: 'a.txt', mediaType: 'text/plain', sizeBytes: 3 }],
      continueFrom: { kind: 'job', jobId: '33333333-3333-4333-8333-333333333333' },
      deployOnSuccess: null,
      outputFolderId: '44444444-4444-4444-8444-444444444444',
      verifyOnSuccess: 'report',
    },
    stats: { finished: 0, succeeded: 0, failed: 0, skipped: 0, lastFailure: null },
    chainSource: null,
    chainedBy: [],
    github: null,
    ...over,
  };
}

function fakeDb(members: { id: string; project: string; state: string; diverged?: boolean }[]) {
  const log: { sql: string; params: unknown[] }[] = [];
  const db = {
    log,
    query(sql: string, params: unknown[] = []) {
      log.push({ sql, params });
      if (sql.includes('FROM automation_groups WHERE id'))
        return Promise.resolve({
          rows: [
            { id: GROUP, name: 'Nightly deps', created_by: USER, created_at: new Date(), updated_at: null },
          ],
        });
      if (sql.includes('AND NOT diverged'))
        return Promise.resolve({
          rows: members.filter((m) => m.diverged !== true).map((m) => ({ id: m.id })),
        });
      if (sql.includes('FROM automations WHERE group_id'))
        return Promise.resolve({ rows: members.filter((m) => m.state !== 'deleted') });
      if (sql.includes('SELECT kind FROM projects'))
        return Promise.resolve({
          rows: PROJECTS.filter((p) => p.id === params[0]).map((p) => ({ kind: p.kind })),
        });
      if (sql.includes('FROM project_git_configs'))
        return Promise.resolve({
          rows: PROJECTS.filter((p) => p.id === params[0] && 'repo' in p).map((p) => ({
            repository_url: (p as { repo: string }).repo,
            base_branch: (p as { base: string }).base,
          })),
        });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    connect: () =>
      Promise.resolve({
        query: (sql: string, params: unknown[] = []) => db.query(sql, params),
        release: () => undefined,
      }),
  };
  return db;
}

function groupService(db: ReturnType<typeof fakeDb>, automations: Partial<AutomationService>) {
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const svc = new AutomationGroupService({
    pool: db as never,
    audit: {
      record: (e: { action: string; metadata: Record<string, unknown> }) => {
        audits.push({ action: e.action, metadata: e.metadata });
        return Promise.resolve();
      },
    } as never,
    clock: () => new Date('2026-10-28T10:00:00Z'),
    automations: () => automations as AutomationService,
  });
  return { svc, audits };
}

const listOf = (members: { id: string; project: string; state: string }[]) => () =>
  Promise.resolve(
    members.map((m) => ({
      id: m.id,
      project: m.project,
      name: 'Nightly deps',
      state: m.state,
      enabled: m.state === 'active',
      triggerSummary: 'every day 03:00',
      nextRunAt: null,
      group: { id: GROUP, name: 'Nightly deps', size: members.length, diverged: false },
    })) as never,
  );

describe('a sibling’s configuration as the input of a new project', () => {
  it('keeps trigger, target and policies; drops input files, the output folder and a fixed continue-from job', () => {
    const input = inputOfDetail(detail(), 'beta');
    expect(input).toMatchObject({
      project: 'beta',
      name: 'Nightly deps',
      description: 'Keeps deps fresh',
      trigger: { kind: 'cron', cron: '0 3 * * *', timeZone: 'Europe/Istanbul' },
      enabled: true,
      concurrency: 'skip',
      catchUp: 'once',
      maxRunsPerHour: 4,
      approvalTimeoutMinutes: 30,
    });
    expect(input.target).toMatchObject({ kind: 'job', verifyOnSuccess: 'report', priority: 0 });
    expect(input.target).not.toHaveProperty('files');
    expect(input.target).not.toHaveProperty('outputFolderId');
    expect(input.target).not.toHaveProperty('continueFrom');
    expect(input.target).not.toHaveProperty('deployOnSuccess');
  });

  it('a paused sibling creates a paused automation; a webhook sibling keeps its allowed addresses', () => {
    const input = inputOfDetail(
      detail({
        state: 'paused',
        trigger: { kind: 'webhook' },
        webhook: {
          url: 'https://x/v1/hooks/a1',
          secretHint: 'ab',
          rotatedAt: '2026-10-28T00:00:00Z',
          previous: null,
          allowIps: ['10.0.0.0/8'],
        },
      }),
      'beta',
    );
    expect(input.enabled).toBe(false);
    expect(input.webhookAllowIps).toEqual(['10.0.0.0/8']);
  });

  it('the input is strict and needs at least one project', () => {
    expect(AutomationGroupAddProjects.safeParse({ projects: [] }).success).toBe(false);
    expect(AutomationGroupAddProjects.safeParse({ projects: ['beta'] }).success).toBe(true);
    expect(AutomationGroupAddProjects.safeParse({ projects: ['beta'], other: 1 }).success).toBe(false);
  });
});

describe('add projects to an existing group', () => {
  it('creates the reference sibling’s automation in each allowed new project; the others are listed', async () => {
    const members = [
      { id: 'a1', project: 'alpha', state: 'active', diverged: true },
      { id: 'b1', project: 'beta', state: 'active' },
    ];
    const db = fakeDb(members);
    const created: { input: AutomationInput; groupId: string | undefined }[] = [];
    const read: string[] = [];
    const { svc, audits } = groupService(db, {
      list: listOf(members),
      get: (id: string) => {
        read.push(id);
        return Promise.resolve(detail({ id, project: id === 'b1' ? 'beta' : 'alpha' }));
      },
      create: (_a: AutomationActor, input: AutomationInput, opts?: { groupId?: string }) => {
        if (input.project === 'delta')
          return Promise.reject(new AutomationError(400, 'repository_missing', 'no repo'));
        created.push({ input, groupId: opts?.groupId });
        return Promise.resolve({ automation: { id: `id-${input.project}` } as never, webhookSecret: null });
      },
    });
    const actor: AutomationActor = {
      id: USER,
      subject: subject('operator', {
        alpha: 'operator',
        beta: 'operator',
        gamma: 'operator',
        delta: 'operator',
        eps: 'viewer',
      }),
    };
    const out = await svc.addProjects(actor, GROUP, { projects: ['gamma', 'beta', 'delta', 'eps', 'zeta'] });
    // The first sibling that did not diverge is the reference (b1, not the diverged a1).
    expect(read).toContain('b1');
    expect(created.map((c) => c.input.project)).toEqual(['gamma']);
    expect(created[0]?.groupId).toBe(GROUP);
    // A workspace project takes no repository; the job's project is the new one.
    const spec = (created[0]?.input.target as { spec: Record<string, unknown> }).spec;
    expect(spec.projectId).toBe('gamma');
    expect(spec.repository).toBeUndefined();
    expect(out.refused.map((r) => `${r.project}:${r.code}`)).toEqual([
      'beta:already_in_group',
      'delta:repository_missing',
      'eps:forbidden',
      'zeta:project_not_found',
    ]);
    expect(audits.find((a) => a.action === 'automation.group.add_projects')?.metadata).toMatchObject({
      from: 'b1',
      created: ['id-gamma'],
    });
  });

  it('a `from` that is not a readable sibling is 404', async () => {
    const members = [
      { id: 'a1', project: 'alpha', state: 'active' },
      { id: 'h1', project: 'hidden', state: 'active' },
    ];
    const { svc } = groupService(fakeDb(members), { list: listOf(members) });
    const actor: AutomationActor = {
      id: USER,
      subject: subject('operator', { alpha: 'operator', beta: 'operator' }),
    };
    await expect(svc.addProjects(actor, GROUP, { projects: ['beta'], from: 'h1' })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('the whole group in one action', () => {
  const members = [
    { id: 'a1', project: 'alpha', state: 'active' },
    { id: 'b1', project: 'beta', state: 'active' },
    { id: 'c1', project: 'gamma', state: 'paused' },
    { id: 'x1', project: 'hidden', state: 'active' },
  ];
  const actor: AutomationActor = {
    id: USER,
    subject: subject('operator', { alpha: 'operator', beta: 'viewer', gamma: 'operator' }),
  };

  it('pause: active siblings the caller may change are paused; the rest is listed or counted', async () => {
    const paused: string[] = [];
    const { svc, audits } = groupService(fakeDb(members), {
      list: listOf(members),
      pause: (_a: AutomationActor, id: string) => {
        paused.push(id);
        return Promise.resolve({ id, state: 'paused' } as never);
      },
    });
    const out = await svc.lifecycle(actor, GROUP, 'pause');
    expect(paused).toEqual(['a1']);
    expect(out.done).toEqual([{ id: 'a1', project: 'alpha', state: 'paused' }]);
    expect(out.unchanged.map((u) => u.id)).toEqual(['c1']);
    expect(out.skipped.map((k) => `${k.project}:${k.code}`)).toEqual(['beta:forbidden']);
    expect(out.hiddenSkipped).toBe(1);
    expect(audits.find((a) => a.action === 'automation.group.pause')?.metadata).toMatchObject({
      done: ['a1'],
      skipped: ['beta:forbidden'],
      hiddenSkipped: 1,
    });
  });

  it('resume: the single resume decides (a GitHub sibling without its step-up is listed)', async () => {
    const { svc } = groupService(fakeDb(members), {
      list: listOf(members),
      resume: (_a: AutomationActor, id: string) =>
        id === 'c1'
          ? Promise.reject(
              new AutomationError(403, 'step_up_required', 'Confirm with a current authenticator code.'),
            )
          : Promise.resolve({ id, state: 'active' } as never),
    });
    const out = await svc.lifecycle(actor, GROUP, 'resume');
    expect(out.done).toEqual([]);
    expect(out.unchanged.map((u) => u.id)).toEqual(['a1']);
    expect(out.skipped.map((k) => `${k.project}:${k.code}`)).toEqual([
      'beta:forbidden',
      'gamma:step_up_required',
    ]);
  });

  it('delete: every sibling the caller may change; the group is gone for the caller when none is left', async () => {
    const left = members.map((m) => ({ ...m }));
    const db = fakeDb(left);
    const removed: string[] = [];
    const { svc } = groupService(db, {
      list: () => listOf(left.filter((m) => m.state !== 'deleted'))(),
      remove: (_a: AutomationActor, id: string) => {
        removed.push(id);
        const m = left.find((x) => x.id === id);
        if (m !== undefined) m.state = 'deleted';
        return Promise.resolve({ id, state: 'deleted' } as never);
      },
    });
    const owner: AutomationActor = {
      id: USER,
      subject: subject('operator', { alpha: 'operator', gamma: 'operator' }),
    };
    const out = await svc.lifecycle(owner, GROUP, 'delete');
    expect(removed).toEqual(['a1', 'c1']);
    expect(out.skipped).toEqual([]);
    expect(out.hiddenSkipped).toBe(2);
    expect(out.group).toBeNull();
  });
  it('resume asks for a step-up once when a GitHub / webhook sibling the caller administers would resume', async () => {
    const external = [
      { id: 'a1', project: 'alpha', state: 'paused', trigger_kind: 'github' },
      { id: 'b1', project: 'beta', state: 'paused', trigger_kind: 'cron' },
    ];
    let resumed = 0;
    const { svc } = groupService(fakeDb(external), {
      list: listOf(external),
      resume: (_a: AutomationActor, id: string) => {
        resumed++;
        return Promise.resolve({ id, state: 'active' } as never);
      },
    });
    const admin = subject('admin', { alpha: 'admin', beta: 'operator' });
    await expect(svc.lifecycle({ id: USER, subject: admin }, GROUP, 'resume')).rejects.toMatchObject({
      status: 403,
      code: 'step_up_required',
    });
    expect(resumed).toBe(0);
    const out = await svc.lifecycle({ id: USER, subject: admin, stepUpFresh: true }, GROUP, 'resume');
    expect(out.done.map((d) => d.id)).toEqual(['a1', 'b1']);
  });
});
