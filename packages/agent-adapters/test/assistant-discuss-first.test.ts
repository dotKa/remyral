import { ASSISTANT_TOOLS } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';

/**
 * p19-discuss-first: rule 62 — "tartışalım" is a conversation, not a plan (a request to discuss a project must not
 * turn into a readiness check and a promised plan).
 */
describe('assistant discusses when asked to (p19-discuss-first)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');
  const rule = (n: number): string => rules.find((l) => l.startsWith(`${String(n)}. `)) ?? '';

  it('rule 62 keeps a discussion a discussion', () => {
    const r = rule(62);
    expect(r).toContain('tartışalım');
    expect(r).toContain('stays one across the following turns');
    expect(r).toContain('never call plan_propose');
    expect(r).toContain('never run describe_project_readiness');
    expect(r).toContain('bunları bir plana dökeceğim');
    expect(r).toContain('Rules 52 and 56 do not apply while discussing');
    expect(r).not.toMatch(/[âîûÂÎÛ]/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('planning, project setup and plan_propose point to it', () => {
    expect(rule(52)).toContain('never while the user is discussing an idea (rule 62)');
    expect(rule(56)).toContain('not while the user is discussing an idea (rule 62)');
    expect(ASSISTANT_TOOLS.plan_propose.description).toContain(
      'never while the user wants to discuss an idea',
    );
  });
});

/** p19-watch-follow-up: rule 63 — progress lines in the user's language, local clock times, carry on after failures. */
describe('assistant keeps going in the user’s language and clock (p19-watch-follow-up)', () => {
  const rule = ASSISTANT_SYSTEM_PROMPT.split('\n').find((l) => l.startsWith('63. ')) ?? '';
  it('rule 63', () => {
    expect(rule).toContain('also the short progress lines between tool calls');
    expect(rule).toContain('expiresAtLocal');
    expect(rule).toContain('never write a UTC clock time as theirs');
    expect(rule).toContain('Takip sonuçsuz bitti:');
    expect(rule).not.toMatch(/[âîûÂÎÛ]/);
  });
});

/** p19-answer-every-question: rule 64 — no question in the user's message is dropped. */
describe('assistant answers every question (p19-answer-every-question)', () => {
  const rule = ASSISTANT_SYSTEM_PROMPT.split('\n').find((l) => l.startsWith('64. ')) ?? '';
  it('rule 64', () => {
    expect(rule).toContain('answer each one explicitly');
    expect(rule).toContain('Never drop a question silently');
    expect(rule).toContain('never turned into an ask_user card');
    expect(rule).toContain('change course');
    expect(rule).not.toMatch(/[âîûÂÎÛ]/);
  });
});

/** p20-job-clock: rule 65 — a job's time running out (extend with progress, say why without, continue after). */
describe('assistant handles a job running out of time (p20-job-clock)', () => {
  const rule = ASSISTANT_SYSTEM_PROMPT.split('\n').find((l) => l.startsWith('65. ')) ?? '';
  it('rule 65', () => {
    expect(rule).toContain('İşin süresi azalıyor');
    expect(rule).toContain('draft_time_limit');
    expect(rule).toContain('last 10 minutes');
    expect(rule).toContain('do NOT extend it');
    expect(rule).toContain('draft_job_action continue');
    expect(rule).toContain('Aynı yerden devam et');
    expect(rule).not.toMatch(/[âîûÂÎÛ]/);
  });

  // p22-timeout-continuity: continue from the kept work, never a fresh job; automatic extension under the policy.
  it('rule 65 continues from the kept work and knows the automatic extension', () => {
    expect(rule).toContain('autonomy.autoExtendTime');
    expect(rule).toContain('keptWork');
    expect(rule).toContain('ALWAYS use continue');
    expect(rule).toContain('never run_again or a new draft_job');
    expect(rule).toContain('Never say the work is lost');
  });
});
