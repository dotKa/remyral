import { describe, expect, it } from 'vitest';
import { DraftEditBody, editedFields, jobDraftInput } from '../../src/chat/draft-edit.js';

/** p12-diyalog-f3: the pure part of editing a job card — back to a draft_job input with the edits applied. */

const card = {
  title: 'Speed up PDFs',
  payload: {
    project: 'odeme-api',
    spec: {
      projectId: 'odeme-api',
      runtime: 'claude-code',
      model: 'sonnet',
      prompt: 'Make it fast.',
      sandboxProfile: 'host-restricted',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600, maxTurns: 40 },
      requirements: { os: ['linux'] },
      repository: { url: 'https://x.test/a.git', baseRef: 'develop', workBranch: 'agent/chat-1' },
      sourceTrust: 'trusted',
    },
    review: { projectDefaults: ['sandboxProfile', 'approvalPolicy', 'limits'] },
    deployOnSuccess: { target: 'pages', env: 'preview', directory: 'site', resolvedTarget: { x: 1 } },
    verifyOnSuccess: 'report',
    continueFrom: '0b9e7f1c-3a0b-4c7e-9d7e-2b1f0c9a8e11',
    priorityClass: 'normal',
    template: { id: 't1', version: 2 },
  },
};

describe('jobDraftInput', () => {
  it('keeps the card as it is and applies only the edited fields', () => {
    const out = jobDraftInput(card, { runtime: 'codex', priorityClass: 'urgent', deployEnv: 'production' });
    expect(out.input).toEqual({
      project: 'odeme-api',
      title: 'Speed up PDFs',
      prompt: 'Make it fast.',
      runtime: 'codex',
      baseRef: 'develop',
      sandboxProfile: 'host-restricted',
      approvalPolicy: 'ask-sensitive',
      os: ['linux'],
      maxDurationSec: 3600,
      continueFrom: '0b9e7f1c-3a0b-4c7e-9d7e-2b1f0c9a8e11',
      deployOnSuccess: { target: 'pages', env: 'production', directory: 'site' },
      verifyOnSuccess: 'report',
    });
    // A changed runtime drops the old runtime's model; the class is kept for the rebuild, not put in the input.
    expect(out.priorityClass).toBe('urgent');
    expect(out.template).toEqual({ id: 't1', version: 2 });
    expect(out.inheritedDefaults).toEqual(['sandboxProfile', 'approvalPolicy', 'limits']);
  });

  it('a project change takes the new project’s defaults, base branch and template-less attribution', () => {
    const out = jobDraftInput(card, { project: 'vitrin-web', approvalPolicy: 'ask-all' });
    expect(out.input).toMatchObject({
      project: 'vitrin-web',
      approvalPolicy: 'ask-all',
      modelProfile: 'sonnet',
    });
    expect(out.input).not.toHaveProperty('sandboxProfile');
    expect(out.input).not.toHaveProperty('baseRef');
    expect(out.input).not.toHaveProperty('maxDurationSec');
    expect(out.template).toBeNull();
    expect(out.inheritedDefaults).toEqual([]);
  });

  it('drops the deploy, the input files and the machine pin on request', () => {
    const pinned = {
      ...card,
      payload: { ...card.payload, spec: { ...card.payload.spec, requirements: { workers: ['atlas'] } } },
    };
    const out = jobDraftInput(pinned, {
      deployOnSuccess: null,
      inputs: null,
      workers: null,
      verifyOnSuccess: null,
    });
    expect(out.input).not.toHaveProperty('deployOnSuccess');
    expect(out.input).not.toHaveProperty('continueFrom');
    expect(out.input).not.toHaveProperty('workers');
    expect(out.input).not.toHaveProperty('verifyOnSuccess');
    expect(jobDraftInput(card, { workers: ['atlas-win-02'] }).input.workers).toEqual(['atlas-win-02']);
  });

  it('the body is strict, non-empty and lists its fields', () => {
    expect(DraftEditBody.safeParse({}).success).toBe(false);
    expect(DraftEditBody.safeParse({ spec: {} }).success).toBe(false);
    expect(DraftEditBody.safeParse({ runtime: 'openhands' }).success).toBe(false);
    expect(DraftEditBody.safeParse({ deployOnSuccess: { target: 'pages' } }).success).toBe(false);
    const ok = DraftEditBody.parse({ title: '  New  ', runtime: 'pi' });
    expect(ok.title).toBe('New');
    expect(editedFields(ok)).toEqual(['runtime', 'title']);
  });
});
