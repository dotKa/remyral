import { describe, expect, it } from 'vitest';
import {
  assessGoal,
  defaultOutcome,
  GOAL_AUTOFIX_GRACE_MS,
  GOAL_FOLLOW_UP_WINDOW_MS,
  GOAL_PROGRESS_MS,
  type GoalFacts,
  goalFingerprint,
  type GoalPlanFact,
  type GoalRecordFact,
  goalText,
} from '../../src/chat/goal-model.js';
import { interventionNotice, reasonText, resumeText } from '../../src/chat/goals.js';

/** p20-outcome (docs/design/p20-outcome-contract.md): who owns the next step, and when nobody does. */
const T0 = new Date('2026-10-31T10:00:00Z');
const at = (min: number): Date => new Date(T0.getTime() + min * 60_000);

const job = (x: Partial<GoalRecordFact> = {}): GoalRecordFact => ({
  kind: 'job',
  id: '00000000-0000-4000-8000-000000000001',
  createdAt: T0,
  phase: 'live',
  endedAt: null,
  detail: null,
  ...x,
});
const watch = (x: Partial<GoalRecordFact> = {}): GoalRecordFact => ({
  kind: 'watch',
  id: '00000000-0000-4000-8000-000000000002',
  createdAt: at(1),
  phase: 'live',
  endedAt: null,
  detail: null,
  followUp: null,
  followUpAt: null,
  deliveryLive: false,
  expiresAt: at(120),
  ...x,
});
const facts = (x: Partial<GoalFacts>): GoalFacts => ({
  origin: 'job',
  plan: null,
  records: [],
  chatAvailable: true,
  openedAt: T0,
  ...x,
});
const plan = (x: Partial<GoalPlanFact> = {}): GoalPlanFact => ({
  state: 'executing',
  stalled: null,
  contDue: false,
  deliveryLive: false,
  itemCapped: false,
  waitsForUser: false,
  updatedAt: T0,
  lastTurnAt: null,
  ...x,
});

describe('goal assessment (p20-outcome)', () => {
  it('a running job owns its goal; a succeeded one ends it', () => {
    expect(assessGoal(facts({ records: [job()] }), at(5))).toMatchObject({
      state: 'open',
      owner: 'job',
      nextAction: 'job_running',
    });
    expect(
      assessGoal(facts({ records: [job({ phase: 'succeeded', endedAt: at(10) })] }), at(11)),
    ).toMatchObject({ state: 'done', resolvedBy: 'outcome' });
    expect(
      assessGoal(facts({ records: [job({ phase: 'waiting_user', detail: 'merge' })] }), at(5)),
    ).toMatchObject({ state: 'open', owner: 'user', nextAction: 'user_approval' });
  });

  it('a failed job waits for an auto-fix, then is an intervention with its error', () => {
    const f = facts({ records: [job({ phase: 'failed', endedAt: at(10), detail: 'exit 1' })] });
    expect(assessGoal(f, at(12))).toMatchObject({ state: 'open', owner: 'system', nextAction: 'auto_fix' });
    expect(assessGoal(f, new Date(at(10).getTime() + GOAL_AUTOFIX_GRACE_MS))).toMatchObject({
      state: 'intervention',
      blockedReason: 'job_failed',
      detail: 'exit 1',
      owner: 'user',
    });
  });

  it('a crashed service + watch: follow-up window, sent turn, then the cap → intervention', () => {
    const ended = watch({ phase: 'ended_unmet', endedAt: at(60), detail: 'Servis durdu (failed)' });
    const base = facts({ origin: 'watch', records: [ended] });
    expect(assessGoal(base, at(61))).toMatchObject({
      state: 'open',
      owner: 'assistant',
      nextAction: 'follow_up',
    });
    // Never sent within the window: the assistant was away → intervention, with the reason.
    const late = new Date(at(60).getTime() + GOAL_FOLLOW_UP_WINDOW_MS + 1);
    expect(assessGoal({ ...base, chatAvailable: false }, late)).toMatchObject({
      state: 'intervention',
      blockedReason: 'assistant_unavailable',
    });
    expect(assessGoal(base, late)).toMatchObject({ blockedReason: 'follow_up_window' });
    // Sent: the assistant has GOAL_PROGRESS_MS to move it.
    const sent = facts({ origin: 'watch', records: [{ ...ended, followUp: 'sent', followUpAt: at(62) }] });
    expect(assessGoal(sent, at(70))).toMatchObject({ state: 'open', nextAction: 'assistant_turn' });
    expect(assessGoal(sent, new Date(at(62).getTime() + GOAL_PROGRESS_MS))).toMatchObject({
      state: 'intervention',
      blockedReason: 'no_progress',
    });
    // The cap: nobody owns it any more.
    const capped = facts({ origin: 'watch', records: [{ ...ended, followUp: 'skipped:cap' }] });
    expect(assessGoal(capped, at(61))).toMatchObject({
      state: 'intervention',
      blockedReason: 'follow_up_cap',
      detail: 'Servis durdu (failed)',
    });
    expect(
      assessGoal(
        facts({ origin: 'watch', records: [{ ...ended, followUp: 'skipped:user_active' }] }),
        at(61),
      ),
    ).toMatchObject({ state: 'open', owner: 'user' });
  });

  it('a new watch the follow-up turn created moves the goal on', () => {
    const first = watch({ phase: 'ended_unmet', endedAt: at(60), followUp: 'sent', followUpAt: at(61) });
    const second = watch({
      id: '00000000-0000-4000-8000-000000000003',
      createdAt: at(65),
      expiresAt: at(200),
    });
    const a = assessGoal(facts({ origin: 'watch', records: [first, second] }), at(120));
    expect(a).toMatchObject({ state: 'open', owner: 'system', nextAction: 'watch_waiting' });
    expect(a.reevaluateAt?.getTime()).toBeGreaterThan(at(200).getTime());
  });

  it('a cancelled watch never decides the outcome; the run it watched does', () => {
    const run: GoalRecordFact = {
      kind: 'workflow_run',
      id: '00000000-0000-4000-8000-000000000004',
      createdAt: T0,
      phase: 'succeeded',
      endedAt: at(30),
      detail: null,
    };
    const cancelled = watch({ phase: 'cancelled', endedAt: at(5) });
    expect(assessGoal(facts({ origin: 'workflow_run', records: [run, cancelled] }), at(31))).toMatchObject({
      state: 'done',
    });
    expect(assessGoal(facts({ origin: 'watch', records: [cancelled] }), at(31))).toMatchObject({
      state: 'cancelled',
    });
  });

  it('plans: a stall or a capped item is an intervention; silence past the progress time too', () => {
    const p = (x: Partial<GoalPlanFact>): GoalFacts => facts({ origin: 'plan', plan: plan(x) });
    expect(assessGoal(p({ stalled: 'budget' }), at(1))).toMatchObject({
      state: 'intervention',
      blockedReason: 'plan_stalled:budget',
    });
    expect(assessGoal(p({ itemCapped: true }), at(1))).toMatchObject({ blockedReason: 'plan_item_failed' });
    expect(assessGoal(p({ waitsForUser: true }), at(90))).toMatchObject({ state: 'open', owner: 'user' });
    expect(assessGoal(p({ contDue: true }), at(5))).toMatchObject({
      state: 'open',
      owner: 'assistant',
      nextAction: 'plan_continue',
    });
    expect(assessGoal(p({}), at(31))).toMatchObject({ state: 'intervention', blockedReason: 'no_progress' });
    expect(assessGoal({ ...p({}), chatAvailable: false }, at(31))).toMatchObject({
      blockedReason: 'assistant_unavailable',
    });
    expect(assessGoal(p({ state: 'done' }), at(31))).toMatchObject({ state: 'done' });
    expect(assessGoal(p({ state: 'cancelled' }), at(31))).toMatchObject({ state: 'cancelled' });
    expect(assessGoal(facts({ origin: 'plan', plan: plan({}), records: [job()] }), at(90))).toMatchObject({
      state: 'open',
      owner: 'job',
    });
  });

  it('the fingerprint changes with a record’s phase (lifts a declared state)', () => {
    const a = goalFingerprint(facts({ records: [job()] }));
    const b = goalFingerprint(facts({ records: [job({ phase: 'failed' })] }));
    expect(a).not.toBe(b);
  });

  it('texts: default outcome, plain bounded columns, the notice and the resume turn', () => {
    expect(defaultOutcome('watch', 'tr', 'tasarim-onizleme')).toBe('Takip koşulu sağlanır: tasarim-onizleme');
    expect(goalText(' a\n\tb ', 10)).toBe('a b');
    expect(goalText('x'.repeat(20), 10)).toHaveLength(10);
    expect(goalText('   ', 10)).toBeNull();
    expect(reasonText('tr', 'plan_stalled:budget')).toBe('plan durdu (budget)');
    const n = interventionNotice('tr', 'Önizleme', 'follow_up_cap', 'Servis durdu');
    expect(n.title).toBe('Müdahalen gerekiyor: Önizleme');
    expect(n.body).toContain('otomatik devam sınırına ulaşıldı');
    expect(n.note).toContain('Senden bekleyen');
    const r = resumeText(
      'tr',
      { id: 'g1', title: 'Önizleme', outcome: 'Servis ayakta', reason: 'follow_up_cap' },
      'Servis durdu',
    );
    expect(r.startsWith('Hedefe devam: Önizleme — ')).toBe(true);
    expect(r).toContain('list_goals');
    expect(r).toContain('goal_update');
  });
});
