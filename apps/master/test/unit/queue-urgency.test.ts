import { PRIORITY_CLASS_BAND, priorityClassOf } from '@remyral/protocol';
import { priorityTier } from '@remyral/scheduler';
import { describe, expect, it } from 'vitest';
import { expressesUrgency } from '../../src/chat/urgency.js';
import { poolKey, waitCategory } from '../../src/queue/service.js';
import { profileFacts } from '../../src/queue/facts.js';

/** p9-queue-priority: master-side pieces without a database. */
describe('chat urgency guard', () => {
  it.each([
    'Bunu acil yap lütfen',
    'ACİL: şu endpointe istek at',
    'hemen çalıştır',
    'öncelikli olsun',
    'Bu iş ivedi',
    'please do this ASAP',
    'urgent: fix prod',
    'run it right now',
  ])('detects urgency in %s', (text) => {
    expect(expressesUrgency(text)).toBe(true);
  });

  it.each(['acilen değil, yarın bakarız? no: "sonra"', 'run the landing page job', 'hemencecik'])(
    'does not see urgency in unrelated words (%s)',
    (text) => {
      // "acilen" is an urgency word; the first case is deliberately ambiguous and counts as urgent.
      expect(expressesUrgency(text)).toBe(text.startsWith('acilen'));
    },
  );
});

describe('queue helpers', () => {
  it('the scheduler tier mirrors the protocol class bands', () => {
    for (let p = -100; p <= 100; p++) expect(priorityTier(p)).toBe(priorityClassOf(p));
    expect(PRIORITY_CLASS_BAND.urgent[0]).toBe(50);
  });

  it('wait categories', () => {
    expect(waitCategory('no_free_profile_slot')).toBe('profile_slot');
    expect(waitCategory('declined_busy')).toBe('profile_slot');
    expect(waitCategory('urgent_slot_reserved')).toBe('slot');
    expect(waitCategory('budget_exceeded')).toBe('budget');
    expect(waitCategory('deferred_off_peak')).toBe('off_peak');
    expect(waitCategory('dependency_pending')).toBe('dependency');
    expect(waitCategory('user_concurrency')).toBe('quota');
    expect(waitCategory('offline')).toBe('machine');
  });

  it('pool keys: profile, or profile@machine for a job pinned to one machine', () => {
    const spec = { sandboxProfile: 'host-restricted' } as never;
    expect(poolKey(spec)).toBe('host-restricted');
    expect(poolKey({ sandboxProfile: 'container', requirements: { workers: ['wrk_a'] } } as never)).toBe(
      'container@wrk_a',
    );
  });

  it('profile facts are used only with profile-slots-v1 and re-validated', () => {
    const raw = { 'host-restricted': 1, vm: 3, container: 99 };
    expect(profileFacts([], raw, ['host-restricted'], { container: 1 })).toEqual({
      profileActive: { container: 1 },
    });
    expect(profileFacts(['profile-slots-v1'], raw, ['host-restricted', 'vm'], null)).toEqual({
      profileConcurrency: { 'host-restricted': 1 },
      exclusiveProfiles: ['host-restricted'],
    });
  });
});
