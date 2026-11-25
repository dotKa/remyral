import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import {
  ADMIN_ACTION_OF,
  adminAlwaysFresh,
  ChatAdmin,
  type ChatAdminDeps,
} from '../../src/chat/admin-actions.js';
import { ChatDirectActions, type TurnHuman } from '../../src/chat/direct.js';
import { type ConfirmContext, machinePolicyCard } from '../../src/chat/drafts.js';
import type { DraftRecord } from '../../src/chat/store.js';
import { adminOpEvent, eventOfDraft } from '../../src/security-policy/events.js';
import { effectivePolicy, type SecurityPolicyDocument } from '../../src/security-policy/model.js';

/**
 * p19-chat-machine-admin ("Makinede söylediğimi yap"): the pure parts — which cards the switch covers,
 * the sandbox prepare administration card (draft_machine_prepare), and that the direct path hands the switch to the
 * draft executor only for the user's own turn. The executor's step-up and the per-command pass are covered by the
 * integration tests (machine-admin.test.ts, chat-machine-admin.test.ts).
 */
const subject = (role: 'owner' | 'admin' | 'operator' | 'viewer'): Subject => ({
  userId: '11111111-1111-4111-8111-111111111111',
  role,
  memberships: new Map(),
});

const human: TurnHuman = { mfaAt: null, ip: '127.0.0.1', userAgent: 'vitest' };

describe('the cards the switch covers', () => {
  it('a machine task, an elevated tool install and the sandbox prepare — nothing else', () => {
    expect(machinePolicyCard({ kind: 'machine_task', payload: {} })).toBe(true);
    expect(machinePolicyCard({ kind: 'tool_install', payload: { elevated: true } })).toBe(true);
    expect(machinePolicyCard({ kind: 'tool_install', payload: { elevated: false } })).toBe(false);
    expect(
      machinePolicyCard({ kind: 'settings_change', payload: { target: 'admin', op: 'machine.prepare' } }),
    ).toBe(true);
    expect(
      machinePolicyCard({ kind: 'settings_change', payload: { target: 'admin', op: 'machine.revoke' } }),
    ).toBe(false);
    expect(machinePolicyCard({ kind: 'settings_change', payload: { target: 'project_execution' } })).toBe(
      false,
    );
    expect(machinePolicyCard({ kind: 'job', payload: {} })).toBe(false);
  });

  it('the sandbox prepare card has the route’s action, event and always-fresh class', () => {
    expect(ADMIN_ACTION_OF['machine.prepare']).toBe('workers.ops.write');
    expect(adminOpEvent('machine.prepare')).toBe('machines.sandbox');
    expect(eventOfDraft('settings_change', { target: 'admin', op: 'machine.prepare' })).toBe(
      'machines.sandbox',
    );
    expect(adminAlwaysFresh({ target: 'admin', op: 'machine.prepare' })).toBe(true);
  });
});

describe('draft_machine_prepare (an administration card, op machine.prepare)', () => {
  const none = () => null;
  function chatAdmin(
    prepared: { workerId: string; privileged: boolean }[],
    rows: Record<string, unknown>[] = [
      { id: 'w-1', display_name: 'mac-1', state: 'online', worker_version: '1.2.3' },
    ],
  ): ChatAdmin {
    return new ChatAdmin({
      db: { query: () => Promise.resolve({ rows, rowCount: rows.length }) } as unknown as ChatAdminDeps['db'],
      clock: () => new Date('2026-10-30T12:00:00Z'),
      directory: none,
      fleet: none,
      rotation: none,
      releases: none,
      backups: none,
      vault: none,
      notifications: none,
      integrations: none,
      github: none,
      quotas: none,
      schedules: none,
      previews: none,
      gitCentral: none,
      sandboxOps: () => ({
        prepare: (workerId: string, privileged: boolean) => {
          prepared.push({ workerId, privileged });
          return Promise.resolve({ id: 'op-1', state: 'sent' } as never);
        },
      }),
    });
  }

  it('administrators only; a pending or revoked machine is refused', async () => {
    const svc = chatAdmin([]);
    expect(await svc.plan(subject('operator'), 'draft_machine_prepare', { workerId: 'mac-1' })).toMatchObject(
      {
        ok: false,
        code: 'forbidden',
      },
    );
    const pending = chatAdmin(
      [],
      [{ id: 'w-1', display_name: 'mac-1', state: 'pending', worker_version: '1.2.3' }],
    );
    expect(
      await pending.plan(subject('admin'), 'draft_machine_prepare', { workerId: 'mac-1' }),
    ).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('builds a privileged prepare card by default and runs exactly the sandbox prepare', async () => {
    const prepared: { workerId: string; privileged: boolean }[] = [];
    const svc = chatAdmin(prepared);
    const plan = await svc.plan(subject('admin'), 'draft_machine_prepare', { workerId: 'mac-1' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.payload).toMatchObject({
      target: 'admin',
      op: 'machine.prepare',
      event: 'machines.sandbox',
      workerId: 'w-1',
      name: 'mac-1',
      privileged: true,
    });
    expect(plan.payload.cardOnly).toBeUndefined();
    const unprivileged = await svc.plan(subject('admin'), 'draft_machine_prepare', {
      workerId: 'mac-1',
      privileged: false,
    });
    expect(unprivileged.ok && unprivileged.payload.privileged).toBe(false);
    const ctx = {
      subject: subject('admin'),
      human: { id: subject('admin').userId, role: 'admin', mfaAt: null },
      actor: { userId: subject('admin').userId, ip: '127.0.0.1', userAgent: 'vitest' },
      direct: true,
    } as ConfirmContext;
    const out = await svc.run(ctx, { id: 'd1', payload: plan.payload } as unknown as DraftRecord);
    expect(prepared).toEqual([{ workerId: 'w-1', privileged: true }]);
    expect(out.result).toMatchObject({ op: 'machine.prepare', via: 'chat', opId: 'op-1', privileged: true });
    // An operator's card cannot be run by them either.
    await expect(
      svc.run({ ...ctx, subject: subject('operator') }, {
        id: 'd2',
        payload: plan.payload,
      } as unknown as DraftRecord),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(prepared).toHaveLength(1);
  });
});

describe('the direct path hands the switch to the executor only for the user’s own turn', () => {
  function direct(doc: SecurityPolicyDocument): {
    actions: ChatDirectActions;
    contexts: ConfirmContext[];
    audits: Record<string, unknown>[];
  } {
    const contexts: ConfirmContext[] = [];
    const audits: Record<string, unknown>[] = [];
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
    });
    return { actions, contexts, audits };
  }
  const draft = {
    id: 'd1',
    kind: 'machine_task',
    threadId: 't1',
    project: 'machines',
    payload: { workerId: 'w-1', title: 'Install htop', prompt: 'apt-get install -y htop' },
  } as unknown as DraftRecord;

  it('on: the user’s turn passes it and the success is audited as approved by policy', async () => {
    const d = direct({ preset: 'serbest' });
    const out = await d.actions.execute(subject('admin'), 'admin', human, draft, 'default');
    expect(out.executed).toBe(true);
    expect(d.contexts[0]?.machineAdminByPolicy).toBe(true);
    expect(d.audits.at(-1)).toMatchObject({
      action: 'chat.direct_action',
      outcome: 'success',
      metadata: { approvedBy: 'policy', policy: 'autonomy.chatMachineAdmin', trigger: 'default' },
    });
  });

  it('a plan continuation or a watch never gets it; nor does a turn while the switch is off', async () => {
    const d = direct({ preset: 'serbest' });
    await d.actions.execute(subject('admin'), 'admin', undefined, draft, 'plan');
    await d.actions.execute(subject('admin'), 'admin', undefined, draft, 'watch');
    // A system turn with a stray human context still is not the user's own trigger.
    await d.actions.execute(subject('admin'), 'admin', human, draft, 'watch');
    expect(d.contexts.map((c) => c.machineAdminByPolicy)).toEqual([undefined, undefined, undefined]);
    const off = direct({ preset: 'serbest', autonomy: { chatMachineAdmin: false } });
    await off.actions.execute(subject('admin'), 'admin', human, draft, 'execute');
    expect(off.contexts[0]?.machineAdminByPolicy).toBeUndefined();
    expect(off.audits.at(-1)?.metadata).not.toHaveProperty('approvedBy');
  });
});
