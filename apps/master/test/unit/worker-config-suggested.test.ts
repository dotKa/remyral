import type { WorkerConfigReport } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { suggestedFrom } from '../../src/worker-config/service.js';

/** p14-login-status-consistency: the panel's takeover prefill keeps a machine's subscription login. */
describe('worker configuration takeover prefill', () => {
  const report = {
    source: 'local',
    generation: 0,
    effective: {
      projects: ['alpha', 'unregistered'],
      allowedRuntimes: ['claude-code', 'codex', 'pi'],
      maxParallelJobs: 2,
      sandboxProfiles: ['container'],
      runtimeAuth: { 'claude-code': 'local-login', codex: 'secret-ref' },
      labels: {},
    },
    ceiling: {
      projects: null,
      repoHosts: null,
      allowedRuntimes: null,
      maxParallelJobs: null,
      sandboxProfiles: null,
      pinnedRuntimes: [],
    },
    blocked: [],
  } as unknown as WorkerConfigReport;

  it('carries local-login over (key references cannot be transcribed), registered projects only', () => {
    const s = suggestedFrom(report, new Set(['alpha']));
    expect(s.projects).toEqual(['alpha']);
    expect(s.runtimes).toEqual({ 'claude-code': { auth: { mode: 'local-login' } } });
  });

  it('nothing to suggest without a report', () => {
    expect(suggestedFrom(null, new Set()).runtimes).toEqual({});
  });
});
