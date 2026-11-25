import { describe, expect, it } from 'vitest';
import { directDecision } from '../../src/chat/direct.js';
import { eventOfDraft } from '../../src/security-policy/events.js';

/** p17-chat-github Part 2: a project card is never executed without the user's click, and asks like POST /projects. */
describe('project_create cards', () => {
  it('are never executed directly — not by default, not with execute: true', () => {
    for (const execute of [false, true]) {
      expect(
        directDecision({
          tool: 'draft_project_create',
          execute,
          propose: false,
          byUser: true,
          proposeAware: true,
        }),
      ).toEqual({ run: null });
    }
    // Another draft tool in the same situation runs at once (the rule is specific).
    expect(
      directDecision({
        tool: 'create_repository',
        execute: false,
        propose: false,
        byUser: true,
        proposeAware: true,
      }),
    ).toEqual({ run: 'default' });
  });

  it('use the event of POST /projects', () => {
    expect(eventOfDraft('project_create', {})).toBe('projects.policy');
  });
});
