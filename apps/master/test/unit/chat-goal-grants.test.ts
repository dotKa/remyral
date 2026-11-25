import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import {
  autonomyBlock,
  ChatDirectActions,
  directDecision,
  type DirectDecisionInput,
  inheritedMachineAdmin,
  type TurnHuman,
} from '../../src/chat/direct.js';
import type { ConfirmContext } from '../../src/chat/drafts.js';
import {
  covers,
  GOAL_GRANT_TTL_MS,
  type GoalGrantRow,
  type GoalGrants,
  goalScopeOf,
  matchGrant,
} from '../../src/chat/goal-grants.js';
import type { DraftRecord } from '../../src/chat/store.js';
import { effectivePolicy, type SecurityPolicyDocument } from '../../src/security-policy/model.js';

/**
 * p20-scope-preview (docs/design/p20-scope-preview.md §2): the goal-bound grant
 * ("Hedefe bağlı yetki") — a continuation turn (an approved autonomous plan, a watch follow-up) inherits the user's own
 * turn's direct run and `chatMachineAdmin` only inside its scope; out of scope stops on one card; off in Sıkı.
 */
const USER = '11111111-1111-4111-8111-111111111111';
const subject = { userId: USER, role: 'admin', memberships: new Map() } as unknown as Subject;
const human: TurnHuman = { mfaAt: null, ip: '127.0.0.1', userAgent: 'vitest' };
const NOW = new Date('2026-10-31T12:00:00Z');

const machineTask = (workerId: string, project = 'machines'): DraftRecord =>
  ({
    id: `d-${workerId}`,
    kind: 'machine_task',
    threadId: 't1',
    project,
    payload: { workerId, title: 'Install htop', prompt: 'apt-get install -y htop' },
  }) as unknown as DraftRecord;

const serviceStart = (worker: string, project = 'shop'): DraftRecord =>
  ({
    id: `s-${worker}`,
    kind: 'service_action',
    threadId: 't1',
    project,
    payload: { op: 'start', project, worker, name: 'web' },
  }) as unknown as DraftRecord;

const row = (over: Partial<GoalGrantRow> = {}): GoalGrantRow => ({
  id: 'g1',
  cls: 'machine_admin',
  project: 'machines',
  workerId: 'w-1',
  machineAdmin: true,
  createdAt: new Date(NOW.getTime() - 60_000),
  expiresAt: new Date(NOW.getTime() + GOAL_GRANT_TTL_MS - 60_000),
  ...over,
});

describe('the scope of a draft', () => {
  it('machine administration is one operation type per machine; a service start / restart one, its stop another', () => {
    expect(goalScopeOf(machineTask('w-1'))).toEqual({
      cls: 'machine_admin',
      project: 'machines',
      workerId: 'w-1',
    });
    expect(goalScopeOf(serviceStart('mac-1'))).toEqual({
      cls: 'service.run',
      project: 'shop',
      workerId: 'mac-1',
    });
    expect(
      goalScopeOf({ kind: 'service_action', project: 'shop', payload: { op: 'restart', worker: 'mac-1' } }),
    ).toMatchObject({ cls: 'service.run' });
    expect(
      goalScopeOf({ kind: 'service_action', project: 'shop', payload: { op: 'stop', worker: 'mac-1' } }),
    ).toMatchObject({ cls: 'service.stop' });
    // A machine task without a machine has no scope (never inherited).
    expect(goalScopeOf({ kind: 'machine_task', project: 'machines', payload: {} })).toBeNull();
  });

  it('covers: same operation type and project; another machine is never covered for machine administration', () => {
    const entry = goalScopeOf(machineTask('w-1'));
    expect(entry).not.toBeNull();
    if (entry === null) return;
    expect(covers(entry, { cls: 'machine_admin', project: 'machines', workerId: 'w-1' })).toBe(true);
    expect(covers(entry, { cls: 'machine_admin', project: 'machines', workerId: 'w-2' })).toBe(false);
    expect(covers(entry, { cls: 'service.run', project: 'machines', workerId: 'w-1' })).toBe(false);
    expect(
      covers(
        { cls: 'service.run', project: 'shop', workerId: 'mac-1' },
        { cls: 'service.run', project: 'other', workerId: 'mac-1' },
      ),
    ).toBe(false);
  });

  it('matchGrant: the newest unexpired covering entry; machine administration needs one that ran by policy', () => {
    const scope = { cls: 'machine_admin', project: 'machines', workerId: 'w-1' };
    expect(matchGrant([row()], scope, NOW)?.id).toBe('g1');
    expect(matchGrant([row({ expiresAt: new Date(NOW.getTime() - 1) })], scope, NOW)).toBeNull();
    expect(matchGrant([row({ machineAdmin: false })], scope, NOW)).toBeNull();
    const newer = row({ id: 'g2', createdAt: new Date(NOW.getTime() - 1000) });
    expect(matchGrant([row(), newer], scope, NOW)?.id).toBe('g2');
  });
});

describe('directDecision of a continuation turn', () => {
  const base: DirectDecisionInput = {
    tool: 'draft_machine_task',
    execute: false,
    propose: false,
    byUser: false,
    proposeAware: true,
  };
  const plan = { state: 'executing', autonomous: true } as const;

  it('a watch follow-up: in scope runs (inherited), out of scope stops with its reason, off keeps the card', () => {
    expect(directDecision({ ...base, followUp: true, goal: 'in_scope' })).toEqual({ run: 'watch' });
    expect(directDecision({ ...base, followUp: true, goal: 'out_of_scope' })).toEqual({
      run: null,
      refused: 'out_of_scope',
    });
    expect(directDecision({ ...base, followUp: true })).toEqual({ run: null });
  });

  it('an autonomous plan: machine administration out of scope stops on ONE card; in scope / unchecked runs', () => {
    expect(directDecision({ ...base, plan, goal: 'out_of_scope' })).toEqual({
      run: null,
      refused: 'out_of_scope',
    });
    expect(directDecision({ ...base, plan, goal: 'in_scope' })).toEqual({ run: 'plan' });
    expect(directDecision({ ...base, plan })).toEqual({ run: 'plan' });
  });

  it('always-card tools stay cards even in scope', () => {
    expect(directDecision({ ...base, tool: 'coolify_delete_app', followUp: true, goal: 'in_scope' })).toEqual(
      { run: null },
    );
  });

  it('a user turn is unaffected', () => {
    expect(directDecision({ ...base, byUser: true })).toEqual({ run: 'default' });
  });
});

describe('the inherited machine administration (policy switches)', () => {
  const grant = row();
  it('both switches on, a continuation trigger and a grant that ran by policy', () => {
    const serbest = effectivePolicy({ preset: 'serbest' });
    expect(inheritedMachineAdmin(serbest, 'plan', grant)).toBe(true);
    expect(inheritedMachineAdmin(serbest, 'watch', grant)).toBe(true);
    expect(inheritedMachineAdmin(serbest, 'default', grant)).toBe(false);
    expect(inheritedMachineAdmin(serbest, 'plan', undefined)).toBe(false);
    expect(inheritedMachineAdmin(serbest, 'plan', { ...grant, machineAdmin: false })).toBe(false);
  });

  it('off in Sıkı (the strict preset); on in Serbest and Dengeli', () => {
    expect(effectivePolicy({ preset: 'siki' }).autonomy.goalGrants).toBe(false);
    expect(effectivePolicy({ preset: 'dengeli' }).autonomy.goalGrants).toBe(true);
    expect(effectivePolicy({ preset: 'serbest' }).autonomy.goalGrants).toBe(true);
    expect(inheritedMachineAdmin(effectivePolicy({ preset: 'siki' }), 'plan', grant)).toBe(false);
    expect(
      inheritedMachineAdmin(
        effectivePolicy({ preset: 'serbest', autonomy: { goalGrants: false } } as SecurityPolicyDocument),
        'plan',
        grant,
      ),
    ).toBe(false);
  });
});

describe('ChatDirectActions with goal-bound grants', () => {
  function setup(doc: SecurityPolicyDocument, rows: GoalGrantRow[] = []) {
    const contexts: ConfirmContext[] = [];
    const audits: Record<string, unknown>[] = [];
    const recorded: { draftId: string; machineAdmin: boolean }[] = [];
    const grants = {
      record: (i: { draft: { id: string }; machineAdmin: boolean }) => {
        recorded.push({ draftId: i.draft.id, machineAdmin: i.machineAdmin });
        return Promise.resolve('g-new');
      },
      match: (_u: string, _t: string, d: DraftRecord) => {
        const scope = goalScopeOf(d);
        return Promise.resolve(scope === null ? null : matchGrant(rows, scope, NOW));
      },
    } as unknown as GoalGrants;
    const actions = new ChatDirectActions({
      drafts: () =>
        ({
          confirm: (ctx: ConfirmContext) => {
            contexts.push(ctx);
            return Promise.resolve({
              draft: {},
              result: ctx.machineAdminByPolicy === true ? { machineAdminByPolicy: true } : {},
            });
          },
        }) as never,
      securityPolicy: { current: () => Promise.resolve(effectivePolicy(doc)) },
      audit: { record: (e: Record<string, unknown>) => (audits.push(e), Promise.resolve()) } as never,
      goalGrants: () => grants,
    });
    return { actions, contexts, audits, recorded };
  }

  it('the user’s own turn records the scope of what it ran directly', async () => {
    const s = setup({ preset: 'serbest' });
    await s.actions.execute(subject, 'admin', human, machineTask('w-1'), 'default');
    expect(s.recorded).toEqual([{ draftId: 'd-w-1', machineAdmin: true }]);
    // A continuation never records (it only inherits).
    await s.actions.execute(subject, 'admin', undefined, machineTask('w-1'), 'plan');
    expect(s.recorded).toHaveLength(1);
  });

  it('nothing is recorded in Sıkı', async () => {
    const s = setup({ preset: 'siki' });
    await s.actions.execute(subject, 'admin', human, machineTask('w-1'), 'execute');
    expect(s.recorded).toEqual([]);
  });

  it('in scope: the continuation inherits chatMachineAdmin and the audit says so', async () => {
    const s = setup({ preset: 'serbest' }, [row()]);
    const draft = machineTask('w-1');
    const check = await s.actions.goal(USER, 't1', draft);
    expect(check.state).toBe('in_scope');
    if (check.state !== 'in_scope') return;
    const out = await s.actions.execute(subject, 'admin', undefined, draft, 'plan', {}, check.grant);
    expect(out.executed).toBe(true);
    expect(s.contexts[0]).toMatchObject({ machineAdminByPolicy: true, goalGrantId: 'g1' });
    expect(s.audits.at(-1)).toMatchObject({
      action: 'chat.direct_action',
      outcome: 'success',
      metadata: {
        trigger: 'plan',
        approvedBy: 'policy',
        policy: 'autonomy.goalGrants',
        inherited: { grantId: 'g1', from: 'user_turn' },
      },
    });
  });

  it('out of scope (another machine): no inheritance; refused with one reason and audited', async () => {
    const s = setup({ preset: 'serbest' }, [row()]);
    const draft = machineTask('w-2');
    const check = await s.actions.goal(USER, 't1', draft);
    expect(check).toMatchObject({
      state: 'out_of_scope',
      scope: 'machine_admin on machine w-2, project machines',
    });
    const out = await s.actions.refuse(subject, undefined, draft, 'out_of_scope', {
      trigger: 'plan',
      scope: check.state === 'out_of_scope' ? check.scope : '',
    });
    expect(out).toMatchObject({ executed: false, reason: 'out_of_scope' });
    expect(out.executed === false && out.message).toContain('ONE decision');
    expect(s.contexts).toEqual([]);
    expect(s.audits.at(-1)).toMatchObject({
      outcome: 'denied',
      metadata: { reason: 'out_of_scope', trigger: 'plan' },
    });
  });

  it('switch off (Sıkı): the check is off and a grant passed anyway is not used for machine administration', async () => {
    const s = setup({ preset: 'siki' }, [row()]);
    expect(await s.actions.goal(USER, 't1', machineTask('w-1'))).toEqual({ state: 'off' });
    const s2 = setup({ preset: 'serbest', autonomy: { goalGrants: false } } as SecurityPolicyDocument, [
      row(),
    ]);
    await s2.actions.execute(subject, 'admin', undefined, machineTask('w-1'), 'plan', {}, row());
    expect(s2.contexts[0]?.machineAdminByPolicy).toBeUndefined();
  });

  it('a watch’s then step (trigger watch without a follow-up grant) never inherits', async () => {
    const s = setup({ preset: 'serbest' }, [row()]);
    await s.actions.execute(subject, 'admin', undefined, machineTask('w-1'), 'watch');
    expect(s.contexts[0]?.machineAdminByPolicy).toBeUndefined();
  });

  it('the otonomi block names the goal scope', () => {
    const on = autonomyBlock({
      policy: effectivePolicy({ preset: 'serbest' }),
      byUser: false,
      proposeAware: true,
      plan: null,
      codeFreshUntil: null,
      followUp: true,
    });
    expect(on).toContain('goalScope');
    expect(on).toContain('out_of_scope');
    const off = autonomyBlock({
      policy: effectivePolicy({ preset: 'siki' }),
      byUser: true,
      proposeAware: true,
      plan: null,
      codeFreshUntil: null,
    });
    expect(off).toContain('never inherit');
  });
});

describe('a service start of the user’s turn covers the same service work of the follow-up', () => {
  it('same project and machine: in scope; another project: out of scope', () => {
    const entry = goalScopeOf(serviceStart('mac-1'));
    if (entry === null) throw new Error('scope');
    const rows = [row({ ...entry, machineAdmin: false })];
    expect(matchGrant(rows, { cls: 'service.run', project: 'shop', workerId: 'mac-1' }, NOW)).not.toBeNull();
    expect(matchGrant(rows, { cls: 'service.run', project: 'blog', workerId: 'mac-1' }, NOW)).toBeNull();
  });
});
