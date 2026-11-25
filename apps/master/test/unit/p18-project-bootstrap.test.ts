import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import { ADMIN_ACTION_OF, adminAlwaysFresh } from '../../src/chat/admin-actions.js';
import { baseRefHint, reasonWords } from '../../src/chat/job-result.js';
import { planReadinessLine } from '../../src/chat/plans.js';
import { ChatProjectSetup, type ChatProjectSetupDeps, networkOpens } from '../../src/chat/project-setup.js';
import type { RepositoryState } from '../../src/gitflow/service.js';
import type { RepoEgressService, RepoEgressView } from '../../src/repo-egress/service.js';
import { classifyFailure } from '../../src/self-heal/classify.js';
import { adminOpEvent } from '../../src/security-policy/events.js';
import type { PreferredWorkersService } from '../../src/worker-config/preferred.js';
import type { ProjectWorkerView, WorkerConfigService } from '../../src/worker-config/service.js';

/**
 * p18-project-bootstrap (docs/design/p18-project-bootstrap.md): the assistant's project setup tools (readiness, network
 * and machine cards with the console's actions / events, opening the network a card by default), the repair hint of a
 * missing base branch (empty repository or a wrong branch) and the plan continuation's readiness instruction.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const subject = (role: 'owner' | 'admin' | 'operator' | 'viewer'): Subject => ({
  userId: USER,
  role,
  memberships: new Map(),
});
const ctx = {
  subject: subject('admin'),
  actor: { userId: USER, ip: '10.0.0.1', userAgent: 'ua' },
  meta: { ip: '10.0.0.1', userAgent: 'ua' },
};

const view = (over: Partial<RepoEgressView> = {}): RepoEgressView => ({
  project: 'leads',
  kind: 'repository',
  mode: 'none',
  presets: [],
  hosts: [],
  effective: { mode: 'none', hosts: [] },
  updatedAt: null,
  updatedBy: null,
  unsupportedWorkers: [],
  ...over,
});

const worker = (id: string, over: Partial<ProjectWorkerView> = {}): ProjectWorkerView => ({
  workerId: id,
  displayName: `name-${id}`,
  state: 'online',
  connected: true,
  managed: true,
  supported: true,
  assigned: false,
  effective: null,
  blocked: null,
  generation: 1,
  appliedGeneration: 1,
  ...over,
});

/** A db that answers the queries of the module by their text. */
function fakeDb(rows: {
  project?: Record<string, unknown> | null;
  repoKind?: { kind: string; repository_url: string | null };
  transition?: string | null;
  emptyReady?: string[];
}) {
  return {
    query: (sql: string) => {
      if (sql.includes('FROM job_transitions'))
        return Promise.resolve({ rows: rows.transition == null ? [] : [{ reason: rows.transition }] });
      if (sql.includes("features ? 'workspace-empty-repo-v1'"))
        return Promise.resolve({ rows: (rows.emptyReady ?? []).map((display_name) => ({ display_name })) });
      if (sql.includes('host_execution'))
        return Promise.resolve({ rows: rows.project == null ? [] : [rows.project] });
      if (sql.includes('SELECT p.kind, g.repository_url'))
        return Promise.resolve({ rows: rows.repoKind === undefined ? [] : [rows.repoKind] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

function setup(
  opts: {
    egress?: RepoEgressView;
    workers?: ProjectWorkerView[];
    preferred?: string[];
    repoState?: RepositoryState | null;
    db?: ReturnType<typeof fakeDb>;
  } = {},
) {
  const calls: { op: string; args: unknown[] }[] = [];
  let assigned = new Set((opts.workers ?? []).filter((w) => w.assigned).map((w) => w.workerId));
  const egress = {
    get: () => Promise.resolve(opts.egress ?? view()),
    set: (...args: unknown[]) => {
      calls.push({ op: 'egress.set', args });
      return Promise.resolve(view({ mode: 'allowlist', presets: ['npm'] }));
    },
  } as unknown as RepoEgressService;
  const workers = {
    projectWorkers: () =>
      Promise.resolve((opts.workers ?? []).map((w) => ({ ...w, assigned: assigned.has(w.workerId) }))),
    setProjectWorkers: (_p: string, input: { workerIds: string[] }, ...rest: unknown[]) => {
      calls.push({ op: 'workers.set', args: [input.workerIds, ...rest] });
      assigned = new Set(input.workerIds);
      return Promise.resolve((opts.workers ?? []).map((w) => ({ ...w, assigned: assigned.has(w.workerId) })));
    },
  } as unknown as WorkerConfigService;
  const preferred = {
    forProject: () => Promise.resolve(opts.preferred ?? []),
    set: (_p: string, input: { workerIds: string[] }) => {
      calls.push({ op: 'preferred.set', args: [input.workerIds] });
      return Promise.resolve({ project: 'leads', workerIds: input.workerIds, updatedAt: null });
    },
  } as unknown as PreferredWorkersService;
  const deps: ChatProjectSetupDeps = {
    db: (opts.db ??
      fakeDb({ repoKind: { kind: 'repository', repository_url: 'https://github.com/o/r' } })) as never,
    preview: () => null,
    repoState: () => () => Promise.resolve(opts.repoState ?? null),
    egress: () => egress,
    workers: () => workers,
    preferred: () => preferred,
  };
  return {
    s: new ChatProjectSetup(deps),
    calls,
    setAssigned: (ids: string[]) => {
      assigned = new Set(ids);
    },
  };
}

describe('which network changes open access', () => {
  const none = { mode: 'none', presets: [], hosts: [] };
  const npm = { mode: 'allowlist', presets: ['npm'], hosts: [] };
  it('a wider mode, a new preset or host opens; narrowing does not', () => {
    expect(networkOpens(none, npm)).toBe(true);
    expect(networkOpens(npm, { ...npm, presets: ['npm', 'github'] })).toBe(true);
    expect(networkOpens(npm, { ...npm, hosts: ['api.stripe.com'] })).toBe(true);
    expect(networkOpens(npm, { mode: 'web', presets: [], hosts: [] })).toBe(true);
    expect(networkOpens(npm, none)).toBe(false);
    expect(networkOpens({ mode: 'web', presets: [], hosts: [] }, npm)).toBe(false);
    expect(networkOpens({ ...npm, presets: ['npm', 'github'] }, npm)).toBe(false);
  });
});

describe('draft_project_network', () => {
  it('opening the network is an always-fresh projects.policy card by default', async () => {
    const { s } = setup();
    const plan = await s.plan(subject('admin'), 'draft_project_network', {
      project: 'leads',
      mode: 'allowlist',
      presets: ['npm', 'github'],
      hosts: ['API.Stripe.com'],
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.project).toBe('leads');
    expect(plan.payload).toMatchObject({
      target: 'admin',
      op: 'project.network',
      event: 'projects.policy',
      cardOnly: 'default',
      project: 'leads',
      mode: 'allowlist',
      presets: ['npm', 'github'],
      hosts: ['api.stripe.com'],
    });
    expect(adminAlwaysFresh(plan.payload)).toBe(true);
    expect(plan.describe).toHaveProperty('opens');
    // No audit-redacted key in the card.
    expect(JSON.stringify(plan.payload)).not.toMatch(/"code"/);
  });

  it('closing it again is not a card by default; refusals keep the console rules', async () => {
    const open = setup({ egress: view({ mode: 'web', updatedAt: '2026-10-29T00:00:00Z' }) });
    const close = await open.s.plan(subject('admin'), 'draft_project_network', {
      project: 'leads',
      mode: 'none',
    });
    if (!close.ok) throw new Error(close.message);
    expect(close.payload.cardOnly).toBeUndefined();

    const { s } = setup({ egress: view({ updatedAt: '2026-10-29T00:00:00Z' }) });
    expect(
      await s.plan(subject('admin'), 'draft_project_network', { project: 'leads', mode: 'none' }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await s.plan(subject('admin'), 'draft_project_network', {
        project: 'leads',
        mode: 'allowlist',
        hosts: ['10.0.0.5'],
      }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await s.plan(subject('operator'), 'draft_project_network', { project: 'leads', mode: 'web' }),
    ).toMatchObject({ ok: false });
    const ws = setup({ egress: view({ kind: 'workspace' }) });
    expect(
      await ws.s.plan(subject('admin'), 'draft_project_network', { project: 'leads', mode: 'web' }),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('keeping the network closed is a decision when none was made yet', async () => {
    const { s } = setup();
    const plan = await s.plan(subject('admin'), 'draft_project_network', { project: 'leads', mode: 'none' });
    expect(plan.ok).toBe(true);
  });

  it('confirming writes through the console service as the confirming user', async () => {
    const { s, calls } = setup();
    const out = await s.apply(
      'project.network',
      { project: 'leads', mode: 'allowlist', presets: ['npm', 'bogus'], hosts: ['registry.example.com'] },
      ctx,
    );
    expect(out).toMatchObject({ project: 'leads', mode: 'allowlist' });
    expect(calls[0]?.op).toBe('egress.set');
    expect(calls[0]?.args[0]).toEqual({ userId: USER });
    expect(calls[0]?.args[2]).toEqual({
      mode: 'allowlist',
      presets: ['npm'],
      hosts: ['registry.example.com'],
    });
  });
});

describe('draft_project_machines', () => {
  const ws = [worker('w1'), worker('w2', { assigned: true }), worker('w3', { connected: false })];

  it('plans assignment changes and the preferred machines as a machines.config card', async () => {
    const { s } = setup({ workers: ws });
    const plan = await s.plan(subject('admin'), 'draft_project_machines', {
      project: 'leads',
      add: ['w1', 'w2', 'w3'],
      preferred: ['w1'],
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.payload).toMatchObject({
      op: 'project.machines',
      event: 'machines.config',
      project: 'leads',
      // w2 is assigned already: not repeated.
      add: ['w1', 'w3'],
      remove: [],
      preferred: ['w1'],
      previousPreferred: [],
      names: { w1: 'name-w1', w3: 'name-w3' },
    });
    expect(plan.payload.cardOnly).toBeUndefined();
    expect(adminAlwaysFresh(plan.payload)).toBe(false);
    expect(plan.describe).toHaveProperty('offline');
  });

  it('refuses unknown machines, nothing to change and a project without a repository', async () => {
    const { s } = setup({ workers: ws, preferred: ['w2'] });
    expect(
      await s.plan(subject('admin'), 'draft_project_machines', { project: 'leads', add: ['nope'] }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await s.plan(subject('admin'), 'draft_project_machines', {
        project: 'leads',
        add: ['w2'],
        preferred: ['w2'],
      }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    const noRepo = setup({
      workers: ws,
      db: fakeDb({ repoKind: { kind: 'repository', repository_url: null } }),
    });
    expect(
      await noRepo.s.plan(subject('admin'), 'draft_project_machines', { project: 'leads', add: ['w1'] }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await s.plan(subject('operator'), 'draft_project_machines', { project: 'leads', add: ['w1'] }),
    ).toMatchObject({ ok: false });
  });

  it('confirming applies add / remove to the assignment as it is THEN (another change is kept)', async () => {
    const { s, calls, setAssigned } = setup({ workers: ws });
    const plan = await s.plan(subject('admin'), 'draft_project_machines', {
      project: 'leads',
      add: ['w1'],
      remove: ['w2'],
      preferred: [],
    });
    if (!plan.ok) throw new Error(plan.message);
    // Meanwhile someone assigned w3 in the console.
    setAssigned(['w2', 'w3']);
    await s.apply('project.machines', plan.payload, ctx);
    const set = calls.find((c) => c.op === 'workers.set');
    expect([...(set?.args[0] as string[])].sort()).toEqual(['w1', 'w3']);
    expect(set?.args[1]).toEqual({ userId: USER, ip: '10.0.0.1', userAgent: 'ua' });
    // preferred [] was planned only when it changes: here it did not.
    expect(plan.payload.preferred).toBeUndefined();
  });

  it('the operations keep the console routes’ actions and events', () => {
    expect(ADMIN_ACTION_OF['project.network']).toBe('projects.egress.write');
    expect(ADMIN_ACTION_OF['project.machines']).toBe('projects.workers.write');
    expect(adminOpEvent('project.network')).toBe('projects.policy');
    expect(adminOpEvent('project.machines')).toBe('machines.config');
  });
});

describe('describe_project_readiness', () => {
  const project = {
    name: 'Leads',
    kind: 'repository',
    host_execution: false,
    repository_url: 'https://github.com/o/leads.git',
    base_branch: 'main',
    provider: 'github',
    ws_egress: null,
    ws_hosts: null,
  };

  it('an empty repository is fine; an undecided network is missing', async () => {
    const { s } = setup({
      db: fakeDb({ project }),
      repoState: {
        provider: 'github',
        repositoryUrl: project.repository_url,
        baseBranch: 'main',
        state: 'empty',
      },
    });
    const r = await s.readiness(subject('admin'), { project: 'leads' });
    if (!r.ok) throw new Error(r.message);
    const data = r.data as Record<string, unknown>;
    expect(data).toMatchObject({
      project: 'leads',
      repository: { linked: true, state: 'empty', baseBranch: 'main' },
      network: { mode: 'none', decided: false },
      missing: ['network'],
    });
    expect(JSON.stringify(data.suggestions)).toMatch(/first job creates the base branch/);
  });

  it('an unlinked repository and a missing base branch are gaps; invisible projects are not found', async () => {
    const unlinked = setup({ db: fakeDb({ project: { ...project, repository_url: null } }) });
    const u = await unlinked.s.evaluate('leads', { provider: true });
    expect(u?.missing).toContain('repository');
    const missing = setup({
      db: fakeDb({ project }),
      egress: view({ updatedAt: '2026-10-29T00:00:00Z' }),
      repoState: { provider: 'github', repositoryUrl: '', baseBranch: 'main', state: 'base_missing' },
    });
    expect((await missing.s.evaluate('leads', { provider: true }))?.missing).toEqual(['repository']);
    const outsider: Subject = { userId: USER, role: 'viewer', memberships: new Map() };
    const hidden = await setup({ db: fakeDb({ project }) }).s.readiness(outsider, { project: 'other' });
    expect(hidden.ok).toBe(false);
  });
});

describe('a missing base branch', () => {
  it('the repair hint tells an empty repository from a wrong branch', async () => {
    const reason = 'BaseRefNotFoundError: base ref "main" was not found in the repository';
    const empty = setup({
      db: fakeDb({ transition: reason, emptyReady: ['ip-10-0-0-11'] }),
      repoState: { provider: 'github', repositoryUrl: '', baseBranch: 'main', state: 'empty' },
    });
    const h1 = await empty.s.baseRefRepairHint('j1', 'leads');
    expect(h1).toMatch(/EMPTY/);
    expect(h1).toContain('ip-10-0-0-11');
    const ready = setup({
      db: fakeDb({ transition: 'base ref "develop" was not found in the repository' }),
      repoState: { provider: 'github', repositoryUrl: '', baseBranch: 'main', state: 'ready' },
    });
    expect(await ready.s.baseRefRepairHint('j1', 'leads')).toMatch(/retry the job from main/);
    const newer = setup({
      db: fakeDb({
        transition:
          'base ref "main" was not found in the repository (the repository is empty: it has no branches yet)',
      }),
    });
    expect(await newer.s.baseRefRepairHint('j1', 'leads')).toMatch(
      /run an ordinary job of the project first/,
    );
    expect(await setup({ db: fakeDb({ transition: null }) }).s.baseRefRepairHint('j1', 'leads')).toBeNull();
  });

  it('the job result note says what to do, in the reader’s language', () => {
    const end = {
      jobId: 'j',
      transitionId: '1',
      state: 'FAILED' as const,
      fromState: 'STARTING',
      trigger: 'attempt_failed',
      attempts: 3,
      reason: 'base ref "main" was not found in the repository',
    };
    expect(reasonWords(end, 'tr')).toMatch(/dalı repoda yok — repo boşsa/);
    expect(reasonWords(end, 'en')).toMatch(/if the repository is empty, update the machine/);
    expect(baseRefHint(`${end.reason} (the repository is empty: it has no branches yet)`, 'tr')).toMatch(
      /repo boş/,
    );
    expect(reasonWords({ ...end, reason: 'boom' }, 'en')).toBe('setting it up on the machine failed');
  });

  it('a newer worker’s "repository is empty" refusal is not retried', () => {
    expect(
      classifyFailure({
        phase: 'start',
        code: 'BaseRefNotFoundError',
        message:
          'base ref "main" was not found in the repository (the repository is empty: it has no branches yet)',
      } as never),
    ).toMatchObject({ class: 'permanent', cause: 'base_ref' });
    expect(
      classifyFailure({
        phase: 'start',
        code: 'BaseRefNotFoundError',
        message: 'base ref "main" was not found in the repository',
      } as never),
    ).toMatchObject({ class: 'heal', cause: 'base_ref' });
  });
});

describe('the plan continuation', () => {
  it('asks for a readiness decision and never sets up silently', () => {
    const tr = planReadinessLine('leads', ['network', 'machines'], true);
    expect(tr).toContain('describe_project_readiness');
    expect(tr).toContain('plan_ask_decision');
    expect(tr).toMatch(/sessizce yapma/);
    const en = planReadinessLine('leads', ['network'], false);
    expect(en).toMatch(/never silent, also in an autonomous plan/);
    expect(en).toContain('missing: network');
  });
});
