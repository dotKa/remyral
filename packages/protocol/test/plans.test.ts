import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_PLAN_FEATURE,
  ASSISTANT_TOOLS,
  assistantToolInput,
  assistantToolJsonSchema,
  assistantToolShape,
  dependencyCycle,
  PLAN_LIMITS,
  PlanCreateInput,
  PlanLink,
  PlanUserEdit,
  UserQuestion,
  WorkerFeature,
} from '../src/index.js';

/** p18-plan-mode (docs/design/p18-plan-mode.md §5): plan tool schemas, limits, unknown keys. */
const PLAN_ID = '0b6f2a8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const item = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Do ${key}`,
  owner: 'assistant',
  ...extra,
});
const plan = (items: Record<string, unknown>[]) => ({
  title: 'Sürüm 2.4 yayını',
  goal: '2.4 testleri geçmiş halde production’a çıksın.',
  phases: [{ title: 'Hazırlık', items }],
});

describe('plan tools (p18-plan-mode)', () => {
  it('advertises the worker feature', () => {
    expect(WorkerFeature.safeParse(ASSISTANT_PLAN_FEATURE).success).toBe(true);
  });

  it('plan_create: strict, bounded, keys unique, dependencies known and acyclic', () => {
    const create = assistantToolInput('plan_create');
    expect(create.safeParse(plan([item('a'), item('b', { dependsOn: ['a'] })])).success).toBe(true);
    expect(create.safeParse({ ...plan([item('a')]), shell: 'x' }).success).toBe(false);
    expect(create.safeParse(plan([{ ...item('a'), extra: 1 }])).success).toBe(false);
    expect(create.safeParse(plan([item('A b')])).success).toBe(false);
    expect(create.safeParse(plan([item('a', { owner: 'robot' })])).success).toBe(false);
    expect(create.safeParse(plan([item('a', { estimate: 20_000 })])).success).toBe(false);
    expect(create.safeParse(plan([item('a', { estimate: 'M' })])).success).toBe(true);
    expect(create.safeParse({ ...plan([item('a')]), title: 'x'.repeat(121) }).success).toBe(false);
    expect(create.safeParse({ ...plan([item('a')]), title: 'bad‮title' }).success).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => ({
      title: `P${String(i)}`,
      items: [item(`k${String(i)}`)],
    }));
    expect(create.safeParse({ ...plan([]), phases: nine }).success).toBe(false);
    // The structural rules are the full schema's (the tool shape is raw; the master checks both).
    expect(PlanCreateInput.safeParse(plan([item('a'), item('a')])).success).toBe(false);
    expect(PlanCreateInput.safeParse(plan([item('a', { dependsOn: ['zz'] })])).success).toBe(false);
    expect(
      PlanCreateInput.safeParse(plan([item('a', { dependsOn: ['b'] }), item('b', { dependsOn: ['a'] })]))
        .success,
    ).toBe(false);
    const many = Array.from({ length: 4 }, (_, p) => ({
      title: `P${String(p)}`,
      items: Array.from({ length: 16 }, (_, i) => item(`p${String(p)}-${String(i)}`)),
    }));
    expect(PlanCreateInput.safeParse({ ...plan([]), phases: many }).success).toBe(false);
    expect(PLAN_LIMITS.items).toBe(60);
  });

  it('finds dependency cycles', () => {
    expect(dependencyCycle([{ key: 'a', dependsOn: ['b'] }, { key: 'b' }])).toBeNull();
    expect(
      dependencyCycle([
        { key: 'a', dependsOn: ['c'] },
        { key: 'b', dependsOn: ['a'] },
        { key: 'c', dependsOn: ['b'] },
      ]),
    ).toEqual(['a', 'c', 'b', 'a']);
  });

  it('plan_update_items / plan_set_status / plan_ask_decision / plan_set_state are strict', () => {
    const upd = assistantToolInput('plan_update_items');
    const ok = { planId: PLAN_ID, baseVersion: 1, reason: 'Deploy önce preview', ops: [] as unknown[] };
    expect(upd.safeParse({ ...ok, ops: [{ op: 'remove', key: 'a' }] }).success).toBe(true);
    expect(
      upd.safeParse({ ...ok, ops: [{ op: 'add', item: item('n'), phase: 0, after: 'a' }] }).success,
    ).toBe(true);
    expect(upd.safeParse({ ...ok, ops: [] }).success).toBe(false);
    expect(upd.safeParse({ ...ok, ops: [{ op: 'explode', key: 'a' }] }).success).toBe(false);
    expect(upd.safeParse({ ...ok, ops: [{ op: 'remove', key: 'a', why: 'x' }] }).success).toBe(false);
    const st = assistantToolInput('plan_set_status');
    expect(
      st.safeParse({
        planId: PLAN_ID,
        items: [{ key: 'a', status: 'done', link: { kind: 'job', id: PLAN_ID } }],
      }).success,
    ).toBe(true);
    expect(
      st.safeParse({
        planId: PLAN_ID,
        items: [{ key: 'a', status: 'done', link: { kind: 'url', id: 'javascript:x' } }],
      }).success,
    ).toBe(false);
    expect(st.safeParse({ planId: PLAN_ID, items: [{ key: 'a', status: 'finished' }] }).success).toBe(false);
    const dec = assistantToolInput('plan_ask_decision');
    expect(
      dec.safeParse({
        planId: PLAN_ID,
        prompt: 'Deploy ortamı?',
        kind: 'single',
        options: [{ label: 'preview' }, { label: 'production' }],
        recommended: 'preview',
        rationale: 'Önce doğrula.',
      }).success,
    ).toBe(true);
    expect(
      dec.safeParse({
        planId: PLAN_ID,
        prompt: 'x',
        kind: 'single',
        options: Array.from({ length: 7 }, (_, i) => ({ label: `o${String(i)}` })),
      }).success,
    ).toBe(false);
    const state = assistantToolInput('plan_set_state');
    expect(state.safeParse({ planId: PLAN_ID, state: 'done' }).success).toBe(true);
    expect(state.safeParse({ planId: PLAN_ID, state: 'executing' }).success).toBe(false);
    expect(assistantToolInput('plan_propose').safeParse({ reason: 'Çok adımlı.' }).success).toBe(true);
    expect(assistantToolInput('plan_read').safeParse({}).success).toBe(true);
  });

  it('draft tools take planItem; other tools do not; JSON schemas render', () => {
    expect('planItem' in assistantToolShape('draft_job')).toBe(true);
    expect('planItem' in assistantToolShape('plan_create')).toBe(false);
    expect('planItem' in assistantToolShape('list_jobs')).toBe(false);
    expect(
      assistantToolInput('draft_job').safeParse({
        project: 'alpha',
        title: 'Changelog yaz',
        prompt: 'Write it',
        runtime: 'claude-code',
        planItem: 'changelog',
      }).success,
    ).toBe(true);
    for (const name of Object.keys(ASSISTANT_TOOLS) as (keyof typeof ASSISTANT_TOOLS)[]) {
      if (!name.startsWith('plan_')) continue;
      expect(JSON.stringify(assistantToolJsonSchema(name)).length).toBeGreaterThan(10);
    }
  });

  it('links are ids or https URLs', () => {
    expect(PlanLink.safeParse({ kind: 'pr', id: 'https://github.com/a/b/pull/1' }).success).toBe(true);
    expect(PlanLink.safeParse({ kind: 'url', id: 'http://x' }).success).toBe(false);
    expect(PlanLink.safeParse({ kind: 'job', id: 'a b' }).success).toBe(false);
  });

  it('the person’s edits carry a base revision and 1–20 ops', () => {
    expect(PlanUserEdit.safeParse({ baseRev: 3, ops: [{ op: 'done_mine', key: 'a' }] }).success).toBe(true);
    expect(PlanUserEdit.safeParse({ baseRev: 3, ops: [] }).success).toBe(false);
    expect(PlanUserEdit.safeParse({ ops: [{ op: 'skip', key: 'a' }] }).success).toBe(false);
  });

  it('W3: the person edits owner / project / estimate and undoes a removal (strict, bounded)', () => {
    const ok = (op: unknown): boolean => PlanUserEdit.safeParse({ baseRev: 1, ops: [op] }).success;
    expect(ok({ op: 'set_owner', key: 'a', owner: 'job' })).toBe(true);
    expect(ok({ op: 'set_owner', key: 'a', owner: 'robot' })).toBe(false);
    expect(ok({ op: 'set_project', key: 'a', project: 'alpha' })).toBe(true);
    expect(ok({ op: 'set_project', key: 'a', project: null })).toBe(true);
    expect(ok({ op: 'set_project', key: 'a', project: 'a b' })).toBe(false);
    expect(ok({ op: 'set_estimate', key: 'a', estimate: 'M' })).toBe(true);
    expect(ok({ op: 'set_estimate', key: 'a', estimate: 90 })).toBe(true);
    expect(ok({ op: 'set_estimate', key: 'a', estimate: null })).toBe(true);
    expect(ok({ op: 'set_estimate', key: 'a', estimate: 20_000 })).toBe(false);
    expect(ok({ op: 'restore', key: 'a' })).toBe(true);
    expect(ok({ op: 'restore', key: 'a', phase: 0 })).toBe(false);
    expect(ok({ op: 'add', item: { title: 'Yeni', estimate: 'S' }, phase: 0, after: null })).toBe(true);
  });

  it('a question may recommend one of its options (plan decisions)', () => {
    const q = {
      id: 'q1',
      prompt: 'Ortam?',
      kind: 'single',
      options: [{ label: 'preview' }, { label: 'prod' }],
    };
    expect(UserQuestion.safeParse({ ...q, recommended: 'preview', rationale: 'Önce doğrula' }).success).toBe(
      true,
    );
    expect(UserQuestion.safeParse({ ...q, recommended: 'staging' }).success).toBe(false);
    expect(UserQuestion.safeParse({ id: 'q1', prompt: 'Not?', kind: 'text', recommended: 'x' }).success).toBe(
      false,
    );
  });
});
