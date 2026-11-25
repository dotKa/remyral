import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import { authorize } from '../../src/authz/model.js';
import { AutomationGroupInput, AutomationGroupService } from '../../src/automations/groups.js';
import { AutomationError, type AutomationInput, type AutomationPatch } from '../../src/automations/model.js';
import type { AutomationActor, AutomationService } from '../../src/automations/service.js';
import { projectSetRefusal, writeTargets } from '../../src/chat/project-set.js';
import { eventOfAction } from '../../src/security-policy/events.js';
import { TemplateHidden, TemplateShares } from '../../src/templates/model.js';
import { TemplateService } from '../../src/templates/service.js';

/**
 * p18-multi-project W4 (docs/design/p18-multi-project.md "Built: W4"): automation groups (per-project adaptation of the
 * shared configuration, refusals per project, "Tümüne uygula" skipping and marking diverged siblings) and the template
 * library rules (where a template may run, the share / hide inputs, the new action).
 */

const USER = '11111111-1111-4111-8111-111111111111';
const subject = (
  role: 'owner' | 'admin' | 'operator' | 'viewer',
  projects: Record<string, string> = {},
): Subject =>
  ({
    userId: USER,
    role,
    memberships: new Map(Object.entries(projects)),
  }) as unknown as Subject;

interface FakeProject {
  readonly id: string;
  readonly kind: 'repository' | 'workspace';
  readonly repo?: string;
  readonly base?: string;
}

function fakeDb(
  projects: readonly FakeProject[],
  workflows: readonly { id: string; project: string; name: string; version: number }[] = [],
) {
  const log: { sql: string; params: unknown[] }[] = [];
  return {
    log,
    query(sql: string, params: unknown[] = []) {
      log.push({ sql, params });
      if (sql.includes('SELECT kind FROM projects'))
        return Promise.resolve({
          rows: projects.filter((p) => p.id === params[0]).map((p) => ({ kind: p.kind })),
        });
      if (sql.includes('FROM project_git_configs'))
        return Promise.resolve({
          rows: projects
            .filter((p) => p.id === params[0] && p.repo !== undefined)
            .map((p) => ({ repository_url: p.repo, base_branch: p.base ?? 'main' })),
        });
      if (sql.includes('SELECT project, name FROM workflow_definitions WHERE id'))
        return Promise.resolve({ rows: workflows.filter((w) => w.id === params[0]) });
      if (sql.includes('FROM workflow_definitions WHERE project = $1 AND name = $2 ORDER BY version DESC'))
        return Promise.resolve({
          rows: workflows
            .filter((w) => w.project === params[0] && w.name === params[1])
            .map((w) => ({ id: w.id, version: w.version, definition: {} })),
        });
      if (sql.includes('FROM workflow_attachments')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

const PROJECTS: FakeProject[] = [
  { id: 'alpha', kind: 'repository', repo: 'https://github.com/acme/alpha.git', base: 'main' },
  { id: 'beta', kind: 'repository', repo: 'https://github.com/acme/beta.git', base: 'develop' },
  { id: 'gamma', kind: 'workspace' },
  { id: 'delta', kind: 'repository' },
];

const jobTarget = {
  kind: 'job' as const,
  spec: {
    projectId: 'alpha',
    runtime: 'codex',
    prompt: 'Update the dependencies.',
    repository: { url: 'https://github.com/acme/alpha.git', baseRef: 'main', workBranch: 'agent/auto-x' },
  },
};

function groupService(db: ReturnType<typeof fakeDb>, automations: Partial<AutomationService>) {
  return new AutomationGroupService({
    pool: db as never,
    audit: { record: () => Promise.resolve() } as never,
    clock: () => new Date('2026-10-28T10:00:00Z'),
    automations: () => automations as AutomationService,
  });
}

describe('automation groups: the shared configuration as each project takes it', () => {
  it('a job target takes each project’s own repository (none for a workspace), never another project’s', async () => {
    const svc = groupService(fakeDb(PROJECTS), {});
    const own = await svc.adapt(fakeDb(PROJECTS) as never, 'alpha', undefined, jobTarget);
    expect(own.target).toMatchObject({ spec: { projectId: 'alpha', repository: jobTarget.spec.repository } });
    const beta = await svc.adapt(fakeDb(PROJECTS) as never, 'beta', undefined, jobTarget);
    const spec = (beta.target as { spec: Record<string, unknown> }).spec;
    expect(spec.projectId).toBe('beta');
    expect(spec.repository).toMatchObject({ url: 'https://github.com/acme/beta.git', baseRef: 'develop' });
    expect((spec.repository as { workBranch: string }).workBranch).toMatch(/^agent\/auto-[0-9a-f]{8}$/);
    const gamma = await svc.adapt(fakeDb(PROJECTS) as never, 'gamma', undefined, jobTarget);
    expect((gamma.target as { spec: Record<string, unknown> }).spec.repository).toBeUndefined();
    await expect(svc.adapt(fakeDb(PROJECTS) as never, 'delta', undefined, jobTarget)).rejects.toMatchObject({
      code: 'repository_missing',
    });
    await expect(svc.adapt(fakeDb(PROJECTS) as never, 'nope', undefined, jobTarget)).rejects.toMatchObject({
      code: 'project_not_found',
    });
  });

  it('a GitHub trigger listens to each project’s registered repository', async () => {
    const svc = groupService(fakeDb(PROJECTS), {});
    const trigger = { kind: 'github' as const, repository: 'acme/alpha', event: 'push' as const };
    const out = await svc.adapt(fakeDb(PROJECTS) as never, 'beta', trigger, undefined);
    expect(out.trigger).toMatchObject({ repository: 'acme/beta' });
    await expect(svc.adapt(fakeDb(PROJECTS) as never, 'gamma', trigger, undefined)).rejects.toMatchObject({
      code: 'invalid_trigger',
    });
  });

  it('a workflow target names the workflow: each project runs its own of that name, else it is refused', async () => {
    const wfs = [
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', project: 'alpha', name: 'nightly', version: 3 },
      { id: 'bbbbbbbb-0000-4000-8000-000000000002', project: 'beta', name: 'nightly', version: 1 },
    ];
    const db = fakeDb(PROJECTS, wfs);
    const svc = groupService(db, {});
    const target = { kind: 'workflow' as const, workflowId: wfs[0]?.id ?? '', inputs: {} };
    expect((await svc.adapt(db as never, 'alpha', undefined, target)).target).toMatchObject({
      workflowId: wfs[0]?.id,
    });
    expect((await svc.adapt(db as never, 'beta', undefined, target)).target).toMatchObject({
      workflowId: wfs[1]?.id,
    });
    await expect(svc.adapt(db as never, 'gamma', undefined, target)).rejects.toMatchObject({
      code: 'workflow_not_found',
    });
  });

  it('input files stay each sibling’s own when a change is applied to all', async () => {
    const svc = groupService(fakeDb(PROJECTS), {});
    const out = await svc.adapt(
      fakeDb(PROJECTS) as never,
      'gamma',
      undefined,
      { ...jobTarget, files: [{ inputId: 'in-abc' }] },
      { dropFiles: true },
    );
    expect(out.target).not.toHaveProperty('files');
  });
});

describe('automation groups: create and apply per project', () => {
  const base = {
    name: 'Nightly deps',
    trigger: { kind: 'cron' as const, cron: '0 3 * * *' },
    target: jobTarget,
  };

  it('needs two different projects', () => {
    expect(AutomationGroupInput.safeParse({ ...base, projects: ['alpha'] }).success).toBe(false);
    expect(AutomationGroupInput.safeParse({ ...base, projects: ['alpha', 'beta'] }).success).toBe(true);
    expect(
      AutomationGroupInput.safeParse({ ...base, project: 'alpha', projects: ['alpha', 'beta'] }).success,
    ).toBe(false);
  });

  it('creates one automation per allowed project; the others are listed with their reason', async () => {
    const db = fakeDb(PROJECTS);
    const created: AutomationInput[] = [];
    const svc = groupService(db, {
      create: (_a: AutomationActor, input: AutomationInput, opts?: { groupId?: string }) => {
        if (input.project === 'gamma')
          return Promise.reject(new AutomationError(400, 'invalid_job', 'bad spec'));
        created.push(input);
        expect(opts?.groupId).toMatch(/^[0-9a-f-]{36}$/);
        return Promise.resolve({
          automation: { id: `id-${input.project}`, project: input.project } as never,
          webhookSecret: null,
        });
      },
    });
    // operator in alpha, beta and gamma; viewer in epsilon; nothing in zeta.
    const actor: AutomationActor = {
      id: USER,
      subject: subject('operator', {
        alpha: 'operator',
        beta: 'operator',
        gamma: 'operator',
        epsilon: 'viewer',
      }),
    };
    const out = await svc.create(actor, {
      ...base,
      projects: ['alpha', 'beta', 'gamma', 'epsilon', 'zeta', 'alpha'],
    });
    expect(created.map((c) => c.project)).toEqual(['alpha', 'beta']);
    expect((created[1]?.target as { spec: Record<string, unknown> }).spec.projectId).toBe('beta');
    expect(out.refused).toEqual([
      { project: 'gamma', code: 'invalid_job', message: 'bad spec' },
      { project: 'epsilon', code: 'forbidden', message: expect.stringContaining('operator role') as string },
      { project: 'zeta', code: 'project_not_found', message: 'Project not found.' },
    ]);
    expect(db.log.some((l) => l.sql.startsWith('INSERT INTO automation_groups'))).toBe(true);
  });

  it('nothing created: 409 group_refused and the empty group is removed', async () => {
    const db = fakeDb(PROJECTS);
    const svc = groupService(db, {
      create: () => Promise.reject(new AutomationError(403, 'forbidden', 'GitHub and webhook automations…')),
    });
    const actor: AutomationActor = {
      id: USER,
      subject: subject('operator', { alpha: 'operator', beta: 'operator' }),
    };
    await expect(svc.create(actor, { ...base, projects: ['alpha', 'beta'] })).rejects.toMatchObject({
      status: 409,
      code: 'group_refused',
    });
    expect(db.log.some((l) => l.sql.startsWith('DELETE FROM automation_groups'))).toBe(true);
  });

  it('apply-to-all changes the siblings the editor may change and marks the others diverged', async () => {
    const GROUP = '22222222-2222-4222-8222-222222222222';
    const members = [
      { id: 'a1', project: 'alpha', state: 'active' },
      { id: 'b1', project: 'beta', state: 'active' },
      { id: 'c1', project: 'gamma', state: 'paused' },
      { id: 'x1', project: 'hidden', state: 'active' },
    ];
    const inner = fakeDb(PROJECTS);
    const db = {
      log: inner.log,
      query(sql: string, params: unknown[] = []) {
        if (sql.includes('FROM automation_groups WHERE id'))
          return Promise.resolve({
            rows: [
              { id: GROUP, name: 'Nightly deps', created_by: USER, created_at: new Date(), updated_at: null },
            ],
          });
        if (sql.includes('FROM automations WHERE group_id')) return Promise.resolve({ rows: members });
        return inner.query(sql, params);
      },
      connect: () =>
        Promise.resolve({
          query: (sql: string, params: unknown[] = []) => db.query(sql, params),
          release: () => undefined,
        }),
    };
    const updated: { id: string; patch: AutomationPatch; group?: boolean }[] = [];
    const svc = groupService(db as never, {
      list: () =>
        Promise.resolve(
          members.map((m) => ({
            id: m.id,
            project: m.project,
            name: 'Nightly deps',
            state: m.state,
            enabled: m.state === 'active',
            triggerSummary: 'every day 03:00',
            nextRunAt: null,
            group: { id: GROUP, name: 'Nightly deps', size: 4, diverged: false },
          })) as never,
        ),
      update: (_a: AutomationActor, id: string, patch: AutomationPatch, opts?: { group?: boolean }) => {
        if (id === 'c1') return Promise.reject(new AutomationError(400, 'invalid_trigger', 'no'));
        updated.push({ id, patch, ...(opts?.group === undefined ? {} : { group: opts.group }) });
        return Promise.resolve({ automation: {} as never, webhookSecret: null });
      },
    });
    // operator in alpha and gamma, viewer in beta, nothing in "hidden".
    const actor: AutomationActor = {
      id: USER,
      subject: subject('operator', { alpha: 'operator', beta: 'viewer', gamma: 'operator' }),
    };
    const out = await svc.apply(actor, GROUP, { patch: { maxRunsPerHour: 5 } });
    expect(updated).toEqual([{ id: 'a1', patch: { maxRunsPerHour: 5 }, group: true }]);
    expect(out.applied.map((a) => a.id)).toEqual(['a1']);
    expect(out.skipped.map((k) => `${k.project}:${k.code}`)).toEqual([
      'beta:forbidden',
      'gamma:invalid_trigger',
    ]);
    expect(out.hiddenSkipped).toBe(1);
    const diverged = db.log
      .filter((l) => l.sql.startsWith('UPDATE automations SET diverged = true'))
      .map((l) => l.params[0]);
    expect(diverged.sort()).toEqual(['b1', 'c1', 'x1']);
    expect(out.group.members.map((m) => m.project)).toEqual(['alpha', 'beta', 'gamma']);
    expect(out.group.hidden).toBe(1);
  });
});

describe('template library rules', () => {
  it('a template runs in its own project, anywhere when global, and in the projects it is shared to', () => {
    expect(TemplateService.usableIn(null, [], 'alpha')).toBe('global');
    expect(TemplateService.usableIn('alpha', [], 'alpha')).toBe('own');
    expect(TemplateService.usableIn('alpha', ['beta'], 'beta')).toBe('shared');
    expect(TemplateService.usableIn('alpha', ['*'], 'gamma')).toBe('shared');
    expect(TemplateService.usableIn('alpha', ['beta'], 'gamma')).toBeNull();
  });

  it('share and hide inputs are strict', () => {
    expect(TemplateShares.safeParse({ projects: ['*'] }).success).toBe(true);
    expect(TemplateShares.safeParse({ projects: ['beta', 'gamma'] }).success).toBe(true);
    expect(TemplateShares.safeParse({ projects: ['bad id'] }).success).toBe(false);
    expect(TemplateShares.safeParse({ projects: [], extra: 1 }).success).toBe(false);
    expect(TemplateHidden.safeParse({ project: 'beta', hidden: true }).success).toBe(true);
    expect(TemplateHidden.safeParse({ project: 'beta' }).success).toBe(false);
  });

  it('templates.share is an operator action of the owner project (no broader grant)', () => {
    expect(
      authorize(subject('operator', { alpha: 'operator' }), 'templates.share', { project: 'alpha' }).allow,
    ).toBe(true);
    expect(
      authorize(subject('operator', { alpha: 'viewer' }), 'templates.share', { project: 'alpha' }).allow,
    ).toBe(false);
    expect(
      authorize(subject('operator', { alpha: 'operator' }), 'templates.share', { project: 'beta' }).allow,
    ).toBe(false);
    expect(eventOfAction('templates.share')).toBe('automations.manage');
  });
});

describe('the chat’s automation group (draft_automation projects)', () => {
  it('every project of the group is a write target of the working-project rule', () => {
    expect(writeTargets('draft_automation', { projects: ['alpha', 'beta', 'alpha'] })).toEqual([
      'alpha',
      'beta',
    ]);
    expect(
      projectSetRefusal('draft_automation', { projects: ['alpha', 'gamma'] }, ['alpha', 'beta']),
    ).toMatchObject({
      code: 'project_not_in_thread',
    });
    expect(
      projectSetRefusal('draft_automation', { projects: ['alpha', 'beta'] }, ['alpha', 'beta']),
    ).toBeNull();
  });
});
