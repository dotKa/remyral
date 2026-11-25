import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applicationText } from '../src/api/approvalMode';
import type { ChatDraft } from '../src/api/chat';
import { draftApprovalPolicy } from '../src/screens/chat/drafts';

/**
 * p6-approval-mode-switch: the job page's approval mode control (before start and while running, allowed / refused
 * modes, how a change took effect) and the chat draft card's mode select (sent as an override on confirm).
 */

configure({ asyncUtilTimeout: 5_000 });

const D1 = '00000000-0000-4000-8000-0000000000d1';
const NOW = new Date().toISOString();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('job page approval mode control', () => {
  it('words every application', () => {
    expect(applicationText({ delivery: 'sent', application: null })).toContain('Waiting');
    expect(applicationText({ delivery: 'sent', application: 'gate' })).toContain('gate');
    expect(applicationText({ delivery: 'sent', application: 'refused' })).toContain('Refused');
  });
});

describe('chat draft card approval select', () => {
  const draft: ChatDraft = {
    id: D1,
    threadId: 't1',
    kind: 'job',
    title: 'Fix the flaky test',
    payload: {
      project: 'alpha',
      spec: {
        runtime: 'codex',
        prompt: 'Find and fix it',
        repository: { url: 'https://example.com/a.git', baseRef: 'main', workBranch: 'agent/x' },
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 1800 },
      },
    },
    project: 'alpha',
    state: 'proposed',
    result: null,
    createdAt: NOW,
    expiresAt: NOW,
    decidedAt: null,
  };

  it('knows which drafts carry a mode', () => {
    expect(draftApprovalPolicy(draft)).toBe('ask-sensitive');
    expect(draftApprovalPolicy({ kind: 'machine_task', payload: { approvalPolicy: 'allow-all' } })).toBe(
      'allow-all',
    );
    expect(draftApprovalPolicy({ kind: 'job_message', payload: {} })).toBeNull();
  });
});
