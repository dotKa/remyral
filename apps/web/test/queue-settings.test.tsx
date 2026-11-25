import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseQueueFacts } from '../src/api/fleet-queue';
import { buildTarget } from '../src/screens/automations/form';

/** p9-queue-priority: automation classes, project queue settings, a machine's slots and urgent reserve. */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('automation targets carry the priority class', () => {
  const form = (target: 'job' | 'workflow', priorityClass: 'urgent' | 'normal' | 'background') =>
    ({
      target,
      priorityClass,
      workflowId: 'wf',
      project: 'alpha',
      runtime: 'codex',
      prompt: 'p',
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      maxDurationMin: '60',
      deploy: { enabled: false },
      files: { files: [], continueFrom: null },
    }) as unknown as Parameters<typeof buildTarget>[0];

  it('job and workflow targets send the class value', () => {
    expect(buildTarget(form('job', 'urgent'), null, {})).toMatchObject({ kind: 'job', priority: 50 });
    expect(buildTarget(form('job', 'background'), null, {})).toMatchObject({ priority: -50 });
    expect(buildTarget(form('workflow', 'normal'), null, null)).toMatchObject({
      kind: 'workflow',
      priority: 0,
    });
  });
});

describe('machine slots and urgent reserve', () => {
  it('parses the overview queue facts (absent on older masters)', () => {
    expect(parseQueueFacts(undefined)).toBeNull();
    expect(parseQueueFacts({ profileSlots: null, urgentReserve: 0 })).toEqual({
      profileSlots: null,
      exclusiveProfiles: [],
      profileRunning: {},
      urgentReserve: 0,
      urgentReserveAuto: false,
    });
  });
});
