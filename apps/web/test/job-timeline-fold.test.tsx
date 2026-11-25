import { describe, expect, it } from 'vitest';
import type { Transition } from '../src/api/jobs';
import { foldTimeline } from '../src/screens/job/timeline';

let n = 0;
function t(from: string | null, to: string, trigger: string): Transition {
  n += 1;
  return {
    id: `t${String(n)}`,
    version: n,
    from,
    to,
    trigger,
    actor: { type: 'system', id: null },
    reason: null,
    epoch: null,
    occurredAt: new Date(1_700_000_000_000 + n * 1000).toISOString(),
  };
}

describe('foldTimeline', () => {
  it('folds a repeated reserve/decline cycle into one row and keeps the last step visible', () => {
    const steps = [t(null, 'DRAFT', 'create'), t('DRAFT', 'QUEUED', 'submit')];
    for (let i = 0; i < 10; i += 1)
      steps.push(t('QUEUED', 'RESERVED', 'reserve'), t('RESERVED', 'QUEUED', 'lease_declined'));
    steps.push(t('QUEUED', 'RESERVED', 'reserve'));
    const rows = foldTimeline(steps);
    expect(rows.map((r) => r.kind)).toEqual(['step', 'step', 'folded', 'step']);
    const folded = rows[2];
    expect(folded?.kind === 'folded' ? folded.times : 0).toBe(10);
    const last = rows.at(-1);
    expect(last?.kind === 'step' ? last.t.id : '').toBe(steps.at(-1)?.id);
  });

  it('leaves short or non-repeating histories unchanged', () => {
    const steps = [
      t(null, 'DRAFT', 'create'),
      t('DRAFT', 'QUEUED', 'submit'),
      t('QUEUED', 'RESERVED', 'reserve'),
      t('RESERVED', 'QUEUED', 'lease_declined'),
      t('QUEUED', 'RESERVED', 'reserve'),
      t('RESERVED', 'STARTING', 'lease_ack'),
    ];
    expect(foldTimeline(steps).every((r) => r.kind === 'step')).toBe(true);
  });
});
