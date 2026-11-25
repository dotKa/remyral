import { describe, expect, it } from 'vitest';
import { ASSISTANT_TOOLS, assistantToolInput, assistantToolJsonSchema } from '../src/assistant.js';

/** p10-chat-job-actions: the assistant's job lookup and job management draft tool. */
describe('assistant job action tools (p10-chat-job-actions)', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  it('find_jobs is a read tool with strict, bounded filters', () => {
    expect(ASSISTANT_TOOLS.find_jobs.kind).toBe('read');
    const s = assistantToolInput('find_jobs');
    expect(s.safeParse({}).success).toBe(true);
    expect(
      s.safeParse({
        idPrefix: 'abc123',
        text: 'landing page',
        stateGroup: 'queued',
        priorityClass: 'background',
      }).success,
    ).toBe(true);
    expect(s.safeParse({ idPrefix: 'ab' }).success).toBe(false); // too short to identify a job
    expect(s.safeParse({ idPrefix: "x' OR 1=1" }).success).toBe(false);
    expect(s.safeParse({ stateGroup: 'everything' }).success).toBe(false);
    expect(s.safeParse({ limit: 51 }).success).toBe(false);
    expect(s.safeParse({ query: 'x' }).success).toBe(false);
  });

  it('draft_job_action is a draft tool: known actions, 1–50 job ids, nothing else', () => {
    expect(ASSISTANT_TOOLS.draft_job_action.kind).toBe('draft');
    const s = assistantToolInput('draft_job_action');
    for (const action of [
      'cancel',
      'run_again',
      'continue',
      'set_class',
      'move',
      'run_now',
      'resolve_conflicts',
    ]) {
      expect(s.safeParse({ action, jobIds: [id] }).success).toBe(true);
    }
    expect(s.safeParse({ action: 'delete', jobIds: [id] }).success).toBe(false);
    expect(s.safeParse({ action: 'cancel', jobIds: [] }).success).toBe(false);
    expect(s.safeParse({ action: 'cancel', jobIds: Array.from({ length: 51 }, () => id) }).success).toBe(
      false,
    );
    expect(s.safeParse({ action: 'cancel', jobIds: ['abc123'] }).success).toBe(false);
    expect(s.safeParse({ action: 'cancel', jobIds: [id], confirm: true }).success).toBe(false);
    expect(s.safeParse({ action: 'set_class', jobIds: [id], priorityClass: 'background' }).success).toBe(
      true,
    );
    expect(s.safeParse({ action: 'move', jobIds: [id], before: id }).success).toBe(true);
    const json = JSON.stringify(assistantToolJsonSchema('draft_job_action'));
    expect(json).toContain('"jobIds"');
    expect(json).toContain('"maxItems":50');
  });

  it('the descriptions say the master re-checks every job, the user’s command runs it, and urgency stays the user’s', () => {
    // p15-chat-execute-default: the user's command runs at once (see “Acting”); the master checks every job again.
    expect(ASSISTANT_TOOLS.draft_job_action.description).toMatch(/see “Acting” below/);
    expect(ASSISTANT_TOOLS.draft_job_action.description).toMatch(
      /checks every job again with THEIR permissions/,
    );
    expect(ASSISTANT_TOOLS.draft_job_action.description).toMatch(/ask instead of guessing/);
    expect(ASSISTANT_TOOLS.draft_job_action.description).toMatch(
      /urgent only from the user\\?'s own urgency words/,
    );
    expect(ASSISTANT_TOOLS.find_jobs.description).toMatch(/son başarısız iş/);
  });
});
