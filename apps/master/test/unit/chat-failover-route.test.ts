import { describe, expect, it } from 'vitest';
import {
  chooseRoute,
  FAILOVER_STABLE_MS,
  type FailoverState,
  type MachineIssue,
  type RouteCandidate,
} from '../../src/chat/failover.js';

const NOW = new Date('2026-10-23T10:00:00Z');
const LONG_AGO = new Date(NOW.getTime() - 3600_000);
const JUST_NOW = new Date(NOW.getTime() - 5_000);

function m(
  id: string,
  position: number,
  issue: MachineIssue | null = null,
  connectedAt: Date | null = LONG_AGO,
) {
  return {
    workerId: id,
    role: position === 0 ? ('primary' as const) : ('backup' as const),
    position,
    issue,
    connectedAt: issue === 'offline' ? null : connectedAt,
  } satisfies RouteCandidate;
}

const AUTO: FailoverState = { auto: true, pin: null, active: null };

/** p15-chat-failover design §4: the routing rule. */
describe('chat failover route choice', () => {
  it('takes the primary when it can answer, the first eligible backup otherwise', () => {
    expect(chooseRoute([m('p', 0), m('b1', 1)], AUTO, NOW)).toMatchObject({
      chosen: { workerId: 'p' },
      reason: 'primary',
      pinned: false,
    });
    const r = chooseRoute([m('p', 0, 'offline'), m('b1', 1, 'engine_not_ready'), m('b2', 2)], AUTO, NOW);
    expect(r).toMatchObject({ chosen: { workerId: 'b2' }, reason: 'primary_offline' });
    expect(chooseRoute([m('p', 0, 'engine_limited'), m('b1', 1)], AUTO, NOW).reason).toBe(
      'primary_unavailable',
    );
    expect(chooseRoute([m('p', 0, 'offline'), m('b1', 1, 'offline')], AUTO, NOW)).toMatchObject({
      chosen: null,
      reason: null,
    });
  });

  it('a primary that just reconnected answers at once while the chat was not failed over', () => {
    const active = { workerId: 'p', reason: 'primary', since: LONG_AGO };
    const r = chooseRoute([m('p', 0, null, JUST_NOW), m('b1', 1)], { ...AUTO, active }, NOW);
    expect(r.chosen?.workerId).toBe('p');
  });

  it('after a failover the primary takes over only once it has been connected for the stable period', () => {
    const state: FailoverState = {
      ...AUTO,
      active: { workerId: 'b1', reason: 'primary_offline', since: LONG_AGO },
    };
    const unstable = chooseRoute([m('p', 0, null, JUST_NOW), m('b1', 1)], state, NOW);
    expect(unstable).toMatchObject({ chosen: { workerId: 'b1' }, reason: 'primary_unstable' });
    expect(unstable.returnsAt?.getTime()).toBe(JUST_NOW.getTime() + FAILOVER_STABLE_MS);
    const later = new Date(JUST_NOW.getTime() + FAILOVER_STABLE_MS);
    expect(chooseRoute([m('p', 0, null, JUST_NOW), m('b1', 1)], state, later)).toMatchObject({
      chosen: { workerId: 'p' },
      reason: 'primary',
    });
    // A stable earlier backup also takes over from a later one.
    const onB2: FailoverState = {
      ...AUTO,
      active: { workerId: 'b2', reason: 'primary_offline', since: LONG_AGO },
    };
    expect(chooseRoute([m('p', 0, 'offline'), m('b1', 1), m('b2', 2)], onB2, NOW).chosen?.workerId).toBe(
      'b1',
    );
    // The backup it was on is gone: the first eligible one, stable or not.
    const gone = chooseRoute([m('p', 0, null, JUST_NOW), m('b1', 1, 'offline')], state, NOW);
    expect(gone.chosen?.workerId).toBe('p');
  });

  it('a pinned machine answers first while it can; otherwise the normal order', () => {
    const pin = { workerId: 'b1', until: new Date(NOW.getTime() + 600_000), by: null };
    expect(chooseRoute([m('p', 0), m('b1', 1)], { ...AUTO, pin }, NOW)).toMatchObject({
      chosen: { workerId: 'b1' },
      reason: 'pinned',
      pinned: true,
    });
    expect(chooseRoute([m('p', 0), m('b1', 1, 'offline')], { ...AUTO, pin }, NOW).chosen?.workerId).toBe('p');
    const expired = { ...pin, until: new Date(NOW.getTime() - 1) };
    expect(chooseRoute([m('p', 0), m('b1', 1)], { ...AUTO, pin: expired }, NOW).chosen?.workerId).toBe('p');
  });

  it('with automatic failover off only the primary (and a pin) answers', () => {
    const off: FailoverState = { ...AUTO, auto: false };
    expect(chooseRoute([m('p', 0, 'offline'), m('b1', 1)], off, NOW).chosen).toBeNull();
    const pin = { workerId: 'b1', until: new Date(NOW.getTime() + 600_000), by: null };
    expect(chooseRoute([m('p', 0, 'offline'), m('b1', 1)], { ...off, pin }, NOW).chosen?.workerId).toBe('b1');
  });

  it('a re-run excludes the machine that lost the turn', () => {
    const r = chooseRoute([m('p', 0), m('b1', 1)], AUTO, NOW, { exclude: new Set(['p']) });
    expect(r).toMatchObject({ chosen: { workerId: 'b1' }, reason: 'primary_unavailable' });
    expect(chooseRoute([m('p', 0)], AUTO, NOW, { exclude: new Set(['p']) }).chosen).toBeNull();
  });
});
