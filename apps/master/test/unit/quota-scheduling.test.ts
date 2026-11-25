import { JobSpec } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  inOffPeak,
  nextOffPeakStart,
  OffPeakWindow,
  runtimeChoice,
  specOptions,
  workerSpec,
} from '../../src/quota-scheduling/index.js';

/** p6-quota-scheduling: off-peak windows (time zones, DST) and fallback runtime options. */

const w = (start: string, end: string, timeZone: string) => OffPeakWindow.parse({ start, end, timeZone });

describe('off-peak window', () => {
  it('validates times, distinct ends and known zones', () => {
    expect(
      OffPeakWindow.safeParse({ start: '22:00', end: '07:00', timeZone: 'Europe/Istanbul' }).success,
    ).toBe(true);
    expect(OffPeakWindow.safeParse({ start: '22:00', end: '22:00', timeZone: 'UTC' }).success).toBe(false);
    expect(OffPeakWindow.safeParse({ start: '24:00', end: '07:00', timeZone: 'UTC' }).success).toBe(false);
    expect(OffPeakWindow.safeParse({ start: '22:00', end: '07:00', timeZone: 'Mars/Base' }).success).toBe(
      false,
    );
    expect(OffPeakWindow.safeParse({ start: '22:00', end: '07:00', timeZone: 'UTC', x: 1 }).success).toBe(
      false,
    );
  });

  it('a window across midnight in a zone east of UTC', () => {
    const night = w('22:00', '07:00', 'Europe/Istanbul'); // UTC+3
    expect(inOffPeak(night, new Date('2026-10-16T18:59:00Z'))).toBe(false); // 21:59 local
    expect(inOffPeak(night, new Date('2026-10-16T19:00:00Z'))).toBe(true); // 22:00
    expect(inOffPeak(night, new Date('2026-10-17T03:59:00Z'))).toBe(true); // 06:59
    expect(inOffPeak(night, new Date('2026-10-17T04:00:00Z'))).toBe(false); // 07:00 (end exclusive)
    expect(nextOffPeakStart(night, new Date('2026-10-16T10:00:00Z')).toISOString()).toBe(
      '2026-10-16T19:00:00.000Z',
    );
    const inside = new Date('2026-10-16T20:00:00Z');
    expect(nextOffPeakStart(night, inside)).toBe(inside);
  });

  it('a daytime window west of UTC; after it closes the next one is tomorrow', () => {
    const day = w('09:00', '17:00', 'America/Los_Angeles'); // PDT UTC-7 in October
    expect(nextOffPeakStart(day, new Date('2026-10-17T01:00:00Z')).toISOString()).toBe(
      '2026-10-17T16:00:00.000Z',
    );
  });

  it('follows daylight saving: same local start, one hour different in UTC', () => {
    const night = w('22:00', '06:00', 'Europe/Berlin');
    // Before the change (CEST, UTC+2) and after it (CET, UTC+1), 2026-10-25.
    expect(nextOffPeakStart(night, new Date('2026-10-24T12:00:00Z')).toISOString()).toBe(
      '2026-10-24T20:00:00.000Z',
    );
    expect(nextOffPeakStart(night, new Date('2026-10-25T12:00:00Z')).toISOString()).toBe(
      '2026-10-25T21:00:00.000Z',
    );
    // The fall-back night is an hour longer: 05:30 local CET is still inside.
    expect(inOffPeak(night, new Date('2026-10-25T04:30:00Z'))).toBe(true);
  });

  it('a start skipped by spring-forward opens at the transition', () => {
    // Europe/Berlin 2026-03-29: 02:00 CET → 03:00 CEST (01:00Z). 02:30 never happens that night.
    const early = w('02:30', '05:00', 'Europe/Berlin');
    const opens = nextOffPeakStart(early, new Date('2026-03-28T23:00:00Z'));
    expect(opens.toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(inOffPeak(early, opens)).toBe(true);
    expect(inOffPeak(early, new Date(opens.getTime() - 60_000))).toBe(false);
  });
});

describe('runtime options', () => {
  const spec = JobSpec.parse({
    runtime: 'claude-code',
    runtimeVersion: '2.1.296',
    model: 'sonnet',
    prompt: 'p',
    repository: { url: 'https://x.test/a.git', baseRef: 'main', workBranch: 'w' },
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 60 },
    fallbacks: [{ runtime: 'codex', model: 'gpt-5.5' }, { runtime: 'pi' }],
    deferrable: true,
  });

  const opt = (i: number) => {
    const o = specOptions(spec)[i];
    if (o === undefined) throw new Error('missing option');
    return o;
  };

  it('the job runtime first, then each fallback without the primary pin and model', () => {
    const opts = specOptions(spec);
    expect(opts.map((o) => o.runtime)).toEqual(['claude-code', 'codex', 'pi']);
    expect(opts[1]?.spec).toMatchObject({ runtime: 'codex', model: 'gpt-5.5' });
    expect(opts[1]?.spec).not.toHaveProperty('runtimeVersion');
    expect(opts[2]?.spec).not.toHaveProperty('model');
  });

  it('workers never see the scheduling fields; the choice records why', () => {
    const ws = workerSpec(opt(1).spec);
    expect(ws).not.toHaveProperty('fallbacks');
    expect(ws).not.toHaveProperty('deferrable');
    expect(JobSpec.safeParse(ws).success).toBe(true);
    expect(runtimeChoice(opt(1), ['claude-code: provider_paused [w1]'])).toEqual({
      index: 1,
      runtime: 'codex',
      model: 'gpt-5.5',
      reason: 'claude-code: provider_paused [w1]',
    });
    expect(runtimeChoice(opt(0), [])).not.toHaveProperty('reason');
  });

  it('the protocol refuses repeated or primary fallback runtimes and more than three', () => {
    const base = { ...spec, fallbacks: undefined };
    expect(JobSpec.safeParse({ ...base, fallbacks: [{ runtime: 'claude-code' }] }).success).toBe(false);
    expect(JobSpec.safeParse({ ...base, fallbacks: [{ runtime: 'pi' }, { runtime: 'pi' }] }).success).toBe(
      false,
    );
    expect(
      JobSpec.safeParse({
        ...base,
        fallbacks: [{ runtime: 'pi' }, { runtime: 'codex' }, { runtime: 'opencode' }, { runtime: 'pi' }],
      }).success,
    ).toBe(false);
  });
});
