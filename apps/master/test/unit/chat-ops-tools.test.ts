import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import {
  ADMIN_ACTION_OF,
  adminAlwaysFresh,
  adminCard,
  CARD_ALWAYS_OPS,
  OPS_TOOL_ACTION_OF,
} from '../../src/chat/admin-actions.js';
import { ChatDirectActions } from '../../src/chat/direct.js';
import type { DraftRecord } from '../../src/chat/store.js';
import {
  capJson,
  ChatOpsTools,
  type ChatOpsToolsDeps,
  globRegex,
  looksText,
} from '../../src/chat/ops-tools.js';
import { adminOpEvent, eventOfDraft, isStepUpEvent } from '../../src/security-policy/events.js';
import { effectivePolicy } from '../../src/security-policy/model.js';

/**
 * p18-assistant-gaps (docs/design/p18-assistant-gaps.md): the pure parts and the planners of the new tools with fake
 * services — events, card-only marks, the direct path's refusal of a restore, glob / text / size helpers, the owner
 * rules of backups / updates / the cost brake, and a job output read window (redacted, paged, binary → metadata).
 */
const subject = (role: 'owner' | 'admin' | 'operator' | 'viewer', projects: string[] = []): Subject =>
  ({
    userId: '11111111-1111-4111-8111-111111111111',
    role,
    memberships: new Map(projects.map((p) => [p, role === 'viewer' ? 'viewer' : 'operator'])),
  }) as unknown as Subject;

function deps(over: Partial<ChatOpsToolsDeps> = {}): ChatOpsToolsDeps {
  const none = () => null;
  return {
    db: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as unknown as ChatOpsToolsDeps['db'],
    clock: () => new Date('2026-10-28T12:00:00Z'),
    workflows: none,
    workspaces: none,
    uptime: none,
    memoryRecords: none,
    outputs: none,
    folders: none,
    reports: none,
    health: none,
    questions: none,
    templates: none,
    backups: none,
    hostActions: none,
    updates: none,
    costBrake: none,
    blobs: none,
    ...over,
  };
}

describe('assistant ops tools: events and card-only marks', () => {
  it('every new operation has the console route’s action and an event of the catalog', () => {
    for (const op of Object.keys(OPS_TOOL_ACTION_OF)) {
      expect(ADMIN_ACTION_OF[op as keyof typeof ADMIN_ACTION_OF], op).toBeDefined();
      expect(isStepUpEvent(adminOpEvent(op)), op).toBe(true);
    }
    expect(adminOpEvent('workflow.decide_node')).toBe('approvals.decide');
    expect(adminOpEvent('workflow.cancel_run')).toBe('chat.cards');
    expect(adminOpEvent('backup.run')).toBe('backups.manage');
    expect(adminOpEvent('backup.restore')).toBe('backups.restore');
    expect(adminOpEvent('host.upgrade')).toBe('host.update');
    expect(adminOpEvent('template.from_job')).toBe('automations.manage');
    expect(adminOpEvent('cost_brake.lift')).toBe('limits.budgets');
    expect(adminOpEvent('job.answer_question')).toBe('chat.cards');
    expect(eventOfDraft('settings_change', { target: 'admin', op: 'host.upgrade' })).toBe('host.update');
  });

  it('a restore is card-only (always) and always-fresh; the update always-fresh; a backup now neither', () => {
    expect([...CARD_ALWAYS_OPS]).toEqual(['backup.restore']);
    const restore = adminCard('backup.restore', 'Restore', { backupId: 'b1' }, {});
    expect(restore.ok && restore.payload).toMatchObject({ cardOnly: 'always', event: 'backups.restore' });
    expect(restore.ok && restore.describe.cardOnly).toMatch(/Always a card/);
    expect(adminAlwaysFresh({ target: 'admin', op: 'backup.restore' })).toBe(true);
    expect(adminAlwaysFresh({ target: 'admin', op: 'host.upgrade' })).toBe(true);
    expect(adminAlwaysFresh({ target: 'admin', op: 'backup.run' })).toBe(false);
    const run = adminCard('backup.run', 'Backup', {}, {});
    expect(run.ok && run.payload.cardOnly).toBeUndefined();
  });

  it('the direct path never runs a card-only restore, whatever the policy says (audited as denied)', async () => {
    const audits: Record<string, unknown>[] = [];
    let confirmed = 0;
    const direct = new ChatDirectActions({
      drafts: () =>
        ({
          confirm: () => {
            confirmed++;
            return Promise.resolve({ draft: {}, result: {} });
          },
        }) as never,
      securityPolicy: {
        current: () =>
          Promise.resolve(
            effectivePolicy({ preset: 'serbest', autonomy: { chatDirect: true, chatDestructive: true } }),
          ),
      },
      audit: { record: (e: Record<string, unknown>) => (audits.push(e), Promise.resolve()) } as never,
    });
    const draft = {
      id: 'd1',
      kind: 'settings_change',
      threadId: 't1',
      project: null,
      payload: { target: 'admin', op: 'backup.restore', cardOnly: 'always', backupId: 'b1' },
    } as unknown as DraftRecord;
    const out = await direct.execute(subject('owner'), 'owner', undefined, draft, 'plan');
    expect(out).toMatchObject({ executed: false, reason: 'card_only' });
    expect(confirmed).toBe(0);
    expect(audits[0]).toMatchObject({ action: 'chat.direct_action', outcome: 'denied' });
  });
});

describe('assistant ops tools: helpers', () => {
  it('globs: * within a folder, ** across folders, ? one character', () => {
    expect(globRegex('**/*.md').test('a/b/c.md')).toBe(true);
    expect(globRegex('**/*.md').test('c.md')).toBe(true);
    expect(globRegex('*.md').test('a/c.md')).toBe(false);
    expect(globRegex('data/r00?.csv').test('data/r001.csv')).toBe(true);
    expect(globRegex('a+b(1).txt').test('a+b(1).txt')).toBe(true);
  });

  it('text detection by type, name and NUL bytes', () => {
    expect(looksText('text/markdown', 'a.md', Buffer.from('# x'))).toBe(true);
    expect(looksText('application/octet-stream', 'a.ts', Buffer.from('const a = 1;'))).toBe(true);
    expect(looksText('image/png', 'a.png', Buffer.from([0x89, 0x50, 0, 1]))).toBe(false);
    expect(looksText('text/plain', 'a.txt', Buffer.from([0x41, 0, 0x42]))).toBe(false);
  });

  it('capJson keeps small values and shortens large ones under the budget', () => {
    expect(capJson({ a: 1 })).toEqual({ a: 1 });
    const big = { rows: Array.from({ length: 500 }, (_, i) => ({ i, text: 'y'.repeat(300) })) };
    const out = capJson(big, 20_000) as { rows: unknown[] };
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(20_000);
    expect(String(out.rows.at(-1))).toMatch(/more$/);
  });
});

describe('assistant ops tools: planners with fake services', () => {
  const applier = (managed: boolean) =>
    ({ applier: () => Promise.resolve({ managed }) }) as unknown as ReturnType<
      ChatOpsToolsDeps['hostActions']
    >;
  const backups = { view: () => Promise.resolve({}) } as unknown as ReturnType<ChatOpsToolsDeps['backups']>;

  it('backups: owners only; without the host applier the answer says how; a restore needs the backup id', async () => {
    const t = new ChatOpsTools(deps({ backups: () => backups, hostActions: () => applier(false) }));
    expect(await t.plan(subject('admin'), 'draft_backup_action', { action: 'run' })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    const off = await t.plan(subject('owner'), 'draft_backup_action', { action: 'run' });
    expect(off).toMatchObject({ ok: false, code: 'unavailable' });
    const on = new ChatOpsTools(deps({ backups: () => backups, hostActions: () => applier(true) }));
    expect(await on.plan(subject('owner'), 'draft_backup_action', { action: 'restore' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    const r = await on.plan(subject('owner'), 'draft_backup_action', { action: 'restore', backupId: 'b-1' });
    expect(r.ok && r.payload).toMatchObject({ op: 'backup.restore', cardOnly: 'always', backupId: 'b-1' });
    const d = await on.plan(subject('owner'), 'draft_backup_action', { action: 'drill' });
    expect(d.ok && d.payload).toMatchObject({ op: 'backup.drill', backupId: null });
  });

  it('control-plane update: a newer feed release, breaking changes only when accepted, the applier needed', async () => {
    const feed = {
      status: () => ({
        configured: true,
        currentVersion: '1.1.0',
        latest: { version: '1.3.0' },
        updateAvailable: true,
        newer: [
          { version: '1.3.0', breaking: ['Drops X'], summary: 'Big' },
          { version: '1.2.0', breaking: [], summary: 'Small' },
        ],
      }),
    } as unknown as ReturnType<ChatOpsToolsDeps['updates']>;
    const t = new ChatOpsTools(deps({ updates: () => feed, hostActions: () => applier(true) }));
    const breaking = await t.plan(subject('owner'), 'draft_control_plane_update', {});
    expect(breaking).toMatchObject({ ok: false, code: 'invalid' });
    expect(breaking.ok ? '' : breaking.message).toContain('Drops X');
    const accepted = await t.plan(subject('owner'), 'draft_control_plane_update', { acceptBreaking: true });
    expect(accepted.ok && accepted.payload).toMatchObject({
      op: 'host.upgrade',
      version: '1.3.0',
      fromVersion: '1.1.0',
      event: 'host.update',
    });
    const older = await t.plan(subject('owner'), 'draft_control_plane_update', { version: '1.0.0' });
    expect(older).toMatchObject({ ok: false, code: 'invalid' });
    const noApplier = new ChatOpsTools(deps({ updates: () => feed, hostActions: () => applier(false) }));
    const cmd = await noApplier.plan(subject('owner'), 'draft_control_plane_update', { version: '1.2.0' });
    expect(cmd.ok ? '' : cmd.message).toContain('sudo remyral-ctl upgrade --to 1.2.0');
  });

  it('cost brake: owners only; a lift needs scope, hours and a reason', async () => {
    const brake = {
      current: () => Promise.resolve({ lifts: [] }),
      projectCeilings: () => Promise.resolve([]),
    } as unknown as ReturnType<ChatOpsToolsDeps['costBrake']>;
    const t = new ChatOpsTools(deps({ costBrake: () => brake }));
    expect(
      await t.plan(subject('admin'), 'draft_cost_brake', {
        action: 'lift',
        scope: 'global',
        hours: 2,
        reason: 'x',
      }),
    ).toMatchObject({ ok: false, code: 'forbidden' });
    expect(
      await t.plan(subject('owner'), 'draft_cost_brake', { action: 'lift', scope: 'global' }),
    ).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    const lift = await t.plan(subject('owner'), 'draft_cost_brake', {
      action: 'lift',
      scope: 'global',
      hours: 3,
      reason: 'demo',
    });
    expect(lift.ok && lift.payload).toMatchObject({
      op: 'cost_brake.lift',
      hours: 3,
      event: 'limits.budgets',
    });
    expect(
      await t.plan(subject('owner'), 'draft_cost_brake', { action: 'end_lift', liftId: 'x' }),
    ).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('read_job_output: a redacted text window with nextOffset; binaries as metadata; invisible jobs not found', async () => {
    const JOB = '22222222-2222-4222-8222-222222222222';
    const text = Buffer.from(`hello\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n${'z'.repeat(100)}`);
    const db = {
      query: (sql: string) =>
        Promise.resolve(
          sql.includes('FROM jobs j')
            ? { rows: [{ project: 'alpha', state: 'SUCCEEDED', title: 'T' }], rowCount: 1 }
            : { rows: [], rowCount: 0 },
        ),
    } as unknown as ChatOpsToolsDeps['db'];
    const files: Record<string, { name: string; mediaType: string; content: Buffer }> = {
      'ws-a': { name: 'a.txt', mediaType: 'text/plain', content: text },
      'ws-b': { name: 'b.png', mediaType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]) },
    };
    const workspaces = {
      artifactContent: (_job: string, id: string) => {
        const f = files[id];
        return Promise.resolve(
          f === undefined ? null : { ...f, blobKey: null, sizeBytes: f.content.length, prunedReason: null },
        );
      },
      outputReport: () => Promise.resolve(null),
    } as unknown as ReturnType<ChatOpsToolsDeps['workspaces']>;
    const t = new ChatOpsTools(deps({ db, workspaces: () => workspaces }));
    const r = await t.read(subject('operator', ['alpha']), 'read_job_output', {
      jobId: JOB,
      artifactId: 'ws-a',
      limit: 50,
    });
    expect(r.ok).toBe(true);
    const d = (r.ok ? r.data : {}) as Record<string, unknown>;
    expect(String(d.content)).toContain('hello');
    expect(String(d.content)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(d.nextOffset).toBe(50);
    const png = await t.read(subject('operator', ['alpha']), 'read_job_output', {
      jobId: JOB,
      artifactId: 'ws-b',
    });
    expect(png.ok && png.data).toMatchObject({ binary: true, content: null });
    expect(
      await t.read(subject('operator', ['beta']), 'read_job_output', { jobId: JOB, artifactId: 'ws-a' }),
    ).toMatchObject({ ok: false, code: 'not_found' });
  });
});
