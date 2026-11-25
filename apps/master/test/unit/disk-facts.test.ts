import { eligibility } from '@remyral/scheduler';
import { describe, expect, it } from 'vitest';
import { diskFacts } from '../../src/queue/facts.js';

/** p15-merge-approvals item 4: the stored HEARTBEAT load as placement facts (free disk vs. minimum). */
describe('diskFacts', () => {
  const GiB = 1024 ** 3;

  it('reads load.workspaceDisk; anything else (older workers, malformed) is "not reported"', () => {
    expect(
      diskFacts({ cpuPercent: 1, workspaceDisk: { freeBytes: 19.3 * GiB, minFreeBytes: 20 * GiB } }),
    ).toEqual({ disk: { freeBytes: 19.3 * GiB, minFreeBytes: 20 * GiB } });
    for (const bad of [
      null,
      'x',
      { cpuPercent: 1 },
      { workspaceDisk: null },
      { workspaceDisk: { freeBytes: '1', minFreeBytes: 2 } },
      { workspaceDisk: { freeBytes: -1, minFreeBytes: 2 } },
      { workspaceDisk: { freeBytes: 1, minFreeBytes: Number.NaN } },
    ]) {
      expect(diskFacts(bad)).toEqual({});
    }
  });

  it('a machine reporting less than its minimum waits with disk_low', () => {
    const facts = diskFacts({ workspaceDisk: { freeBytes: 19.3 * GiB, minFreeBytes: 20 * GiB } });
    const reasons = eligibility(
      {
        project: 'p',
        runtime: 'codex',
        sandboxProfile: 'container',
        secretWorkers: [],
        declinedBy: [],
        failedOn: [],
      },
      {
        id: 'windows-worker-1',
        state: 'online',
        connected: true,
        capabilitiesKnown: true,
        os: 'win32',
        arch: 'x64',
        runtimes: [
          {
            runtime: 'codex',
            version: '1',
            installed: true,
            authenticated: 'yes',
            pinStatus: 'match',
            pinnedVersion: '1',
          },
        ],
        sandboxProfiles: ['container'],
        maxParallelJobs: 2,
        activeLeases: 0,
        allowedProjects: null,
        localProjects: ['p'],
        history: { succeeded: 0, failed: 0, lost: 0 },
        projectAffinity: 0,
        ...facts,
      },
    );
    expect(reasons.map((r) => [r.code, r.permanent])).toEqual([['disk_low', false]]);
  });
});
