import { describe, expect, it } from 'vitest';
import { GIT_FLOW_PREAMBLE, withPlatformCommitNote } from '../src/jobs/gitflow-note.js';

const PUSHED = { branch: 'rac/j/a', sha: 'a'.repeat(40) };

describe('p15-merge-approvals: git flow note for agents and summaries', () => {
  it('tells the agent not to commit or push', () => {
    expect(GIT_FLOW_PREAMBLE).toContain(
      'Do not run git commit/push; leave your changes in the working tree — the platform commits and pushes them after the run.',
    );
  });

  it('adds what the platform pushed; a reported commit failure is explained, not a failure', () => {
    expect(withPlatformCommitNote('Done: fixed the bug.', PUSHED)).toBe(
      `Done: fixed the bug.\n\nThe platform committed and pushed the changes as rac/j/a@${'a'.repeat(12)}.`,
    );
    for (const s of [
      "Fixed it, but I couldn't commit (cannot lock ref 'HEAD').",
      'I was unable to commit the changes.',
      'Değişiklikleri commitleyemedim.',
      'git push edemedim',
    ]) {
      expect(withPlatformCommitNote(s, PUSHED)).toContain('the agent cannot commit under git flow by design');
    }
    expect(withPlatformCommitNote('', PUSHED)).toBe(
      `The platform committed and pushed the changes as rac/j/a@${'a'.repeat(12)}.`,
    );
  });

  it('leaves the summary alone when nothing was pushed', () => {
    expect(withPlatformCommitNote("I couldn't commit", null)).toBe("I couldn't commit");
  });
});
