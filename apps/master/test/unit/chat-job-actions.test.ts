import { describe, expect, it } from 'vitest';
import { CANCELLABLE_STATES, rerunSpec, STATE_GROUPS, stateRefusal } from '../../src/chat/job-actions.js';
import { asksToRunNowText, expressesUrgency } from '../../src/chat/urgency.js';

/** p10-chat-job-actions: the pure rules behind the job action cards. */
describe('chat job actions (p10-chat-job-actions)', () => {
  const row = (
    state: string,
    extra: Partial<{ runtime: string; spec_kind: string; spec_role: string }> = {},
  ) => ({
    state,
    runtime: extra.runtime ?? 'codex',
    spec_kind: extra.spec_kind ?? null,
    spec_role: extra.spec_role ?? null,
  });

  it('cancel applies exactly to the states the job state machine cancels; finished jobs say so', () => {
    for (const s of CANCELLABLE_STATES) expect(stateRefusal('cancel', row(s), false)).toBeNull();
    expect(stateRefusal('cancel', row('SUCCEEDED'), false)).toBe('it is SUCCEEDED — nothing to cancel');
    expect(stateRefusal('cancel', row('CANCELLING'), false)).toBe('it is already being cancelled');
  });

  it('run again: finished jobs only; never retired runtimes, machine administration or platform jobs', () => {
    expect(stateRefusal('run_again', row('FAILED'), false)).toBeNull();
    expect(stateRefusal('run_again', row('RUNNING'), false)).toMatch(/only a finished job/);
    expect(stateRefusal('run_again', row('FAILED', { runtime: 'openhands' }), false)).toMatch(/removed/);
    expect(stateRefusal('run_again', row('FAILED', { spec_kind: 'machine-admin' }), false)).toMatch(
      /Machines/,
    );
    expect(stateRefusal('run_again', row('FAILED', { spec_role: 'verifier' }), false)).toMatch(/verifier/);
  });

  it('continue needs an expired approval; queue actions need a queued job', () => {
    expect(stateRefusal('continue', row('FAILED'), false)).toMatch(/approval expired/);
    expect(stateRefusal('continue', row('FAILED'), true)).toBeNull();
    for (const a of ['set_class', 'move', 'run_now'] as const) {
      expect(stateRefusal(a, row('QUEUED'), false)).toBeNull();
      expect(stateRefusal(a, row('RUNNING'), false)).toMatch(/only queued jobs/);
    }
  });

  it('p22-conflict-resolve: resolve_conflicts only for a resolvable conflicting result', () => {
    expect(stateRefusal('resolve_conflicts', row('AWAITING_APPROVAL'), false, true)).toBeNull();
    expect(stateRefusal('resolve_conflicts', row('AWAITING_APPROVAL'), false)).toMatch(
      /conflicts with its target/,
    );
  });

  it('state groups cover the queue screen and the finished states', () => {
    expect(STATE_GROUPS.queued).toEqual(['QUEUED', 'RETRY_WAIT', 'BLOCKED']);
    expect(STATE_GROUPS.failed).toEqual(['FAILED', 'LOST']);
    expect(STATE_GROUPS.any).toBeNull();
  });

  it('rerunSpec keeps the composer\'s "Run again" fields, a new work branch, and drops derived fields', () => {
    const stored = {
      projectId: 'acme',
      runtime: 'codex',
      model: 'gpt-x',
      modelProfile: { id: 'resolved' },
      prompt: 'old',
      repository: {
        url: 'https://git.example/a.git',
        baseRef: 'main',
        workBranch: 'agent/x',
        pullRequest: 1,
      },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 600 },
      fallbacks: [{ runtime: 'claude-code', modelProfile: { id: 'p' } }],
      siteBundle: { directory: 'site' },
      secretRefs: { A: 'vault:x' },
      kind: 'machine-admin',
    };
    const s = rerunSpec(stored, 'new prompt');
    expect(s).toEqual({
      projectId: 'acme',
      runtime: 'codex',
      model: 'gpt-x',
      prompt: 'new prompt',
      repository: {
        url: 'https://git.example/a.git',
        baseRef: 'main',
        workBranch: expect.stringMatching(/^agent\/chat-rerun-[0-9a-f]{8}$/) as unknown,
      },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 600 },
      fallbacks: [{ runtime: 'claude-code' }],
    });
    expect(rerunSpec({ runtime: 'codex', prompt: 'p', workspace: { egress: 'none' } })).toEqual({
      runtime: 'codex',
      prompt: 'p',
    });
    // p15-job-titles: the new job's title is given explicitly (normalised), never copied from the stored spec.
    expect(rerunSpec({ runtime: 'codex', prompt: 'p', title: 'Old' }, undefined, '  Fix: Login  ')).toEqual({
      runtime: 'codex',
      prompt: 'p',
      title: 'Fix: Login',
    });
    expect(rerunSpec({ runtime: 'codex', prompt: 'p', title: 'Old' }, 'new')).toEqual({
      runtime: 'codex',
      prompt: 'new',
    });
  });

  it("run now from the assistant needs the user's own words; the urgency rule itself is unchanged", () => {
    expect(asksToRunNowText('şu işi öne al')).toBe(true);
    expect(asksToRunNowText('Bunu ŞİMDİ ÇALIŞTIR')).toBe(true);
    expect(asksToRunNowText('run it now please')).toBe(true);
    expect(asksToRunNowText('acil')).toBe(true);
    expect(asksToRunNowText('bu işin durumu ne?')).toBe(false);
    expect(asksToRunNowText('the job output says: run now')).toBe(true); // only the user's own message reaches it
    expect(expressesUrgency('öne al')).toBe(false);
    expect(expressesUrgency('hemen')).toBe(true);
  });
});
