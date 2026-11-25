import { describe, expect, it } from 'vitest';
import { CAPACITY_RULE_NOTE, capacityOf, capacityRuleAware } from '../../src/chat/capacity.js';

/**
 * p19-linux-host-isolation Part 2 (docs/design/p19-linux-host-isolation.md §6): describe_worker `capacity` — the real
 * per-profile concurrency of a machine, why, and advice that names only settings and screens that exist.
 */

const NOW = '2026-10-29T10:00:00.000Z';
const status = (
  platform: 'linux' | 'win32' | 'darwin',
  host: Record<string, unknown>,
  checks: Record<string, unknown>[] = [],
  extra: Record<string, unknown>[] = [],
) => ({
  checkedAt: NOW,
  platform,
  workerUser: { running: 'remyral-worker', source: 'inferred' },
  privilegedPrepare: { available: true },
  profiles: [
    { profile: 'container', ready: true, checks: [] },
    { profile: 'host-restricted', ready: true, checks: [], ...host },
    { profile: 'unconfined', ready: false, checks: [] },
    ...extra,
  ],
  checks,
});
const SLOTS = 'profile-slots-v1';

describe('capacity advice (describe_worker capacity)', () => {
  it('Linux without isolation, new release: names the bubblewrap install and Prepare, never a slot setting', () => {
    const c = capacityOf({
      name: 'ec2-linux',
      os: 'linux',
      features: [SLOTS, 'host-isolation-linux-v1'],
      maxParallelJobs: 3,
      profileConcurrency: { container: 3, 'host-restricted': 1 },
      exclusiveProfiles: ['host-restricted'],
      localLogin: null,
      sandboxStatus: status(
        'linux',
        {
          concurrency: 1,
          confinement: { filesystem: 'os_user', egress: 'proxy_env_only', limits: 'rlimits' },
        },
        [
          {
            id: 'host_isolation',
            status: 'warning',
            code: 'host_isolation_bwrap_missing',
            detail: 'bubblewrap is not installed',
            fix: 'prepare_privileged',
          },
        ],
      ),
      ruleAware: true,
    });
    const host = c.profiles.find((p) => p.profile === 'host-restricted');
    expect(host).toMatchObject({ parallel: 1, runsAlone: true, limitedBy: 'no_isolation' });
    expect(host?.why).toMatch(/host_isolation_bwrap_missing/);
    expect(c.profiles.find((p) => p.profile === 'container')).toMatchObject({
      parallel: 3,
      limitedBy: 'max_parallel_jobs',
    });
    expect(c.hostIsolation).toMatchObject({
      os: 'linux',
      confinement: 'none',
      state: 'host_isolation_bwrap_missing',
    });
    const text = c.advice.join('\n');
    expect(text).toContain('sudo apt install bubblewrap');
    expect(text).toContain('Makineler → ec2-linux → Sandbox ve politika');
    expect(text).toMatch(/Konteyner \/ Container profile already run in parallel/);
    expect(text).not.toMatch(/slot count|yuva sayısı/i);
    expect(c.noOtherSetting).toMatch(/no per-profile or "host-restricted slot" setting exists/);
    expect(c.rule).toBeUndefined();
  });

  it('Linux on an older release: update the machine first', () => {
    const c = capacityOf({
      name: 'pi',
      os: 'linux',
      features: [SLOTS],
      maxParallelJobs: 2,
      profileConcurrency: { 'host-restricted': 1 },
      exclusiveProfiles: ['host-restricted'],
      localLogin: null,
      sandboxStatus: status('linux', { concurrency: 1 }),
    });
    expect(c.advice[0]).toMatch(/Update pi to a worker release with Linux per-attempt isolation/);
    expect(c.advice[0]).toContain('Ayarlar → Makine sürümleri');
    // An assistant without the capacity prompt rule gets the rule with the data.
    expect(c.rule).toBe(CAPACITY_RULE_NOTE);
  });

  it('Linux with bubblewrap views: host-restricted bounded by maxParallelJobs; runtime-sandbox one at a time', () => {
    const c = capacityOf({
      name: 'ec2-linux',
      os: 'linux',
      features: [SLOTS, 'host-isolation-linux-v1'],
      maxParallelJobs: 3,
      localCeiling: 4,
      profileConcurrency: { 'host-restricted': 3, 'runtime-sandbox': 1 },
      exclusiveProfiles: ['runtime-sandbox'],
      localLogin: null,
      sandboxStatus: status(
        'linux',
        {
          concurrency: 3,
          concurrencyNote: 'each attempt in its own bubblewrap view; subscription-login …',
          confinement: { filesystem: 'bwrap', egress: 'proxy_env_only', limits: 'rlimits' },
        },
        [{ id: 'host_isolation', status: 'ok', detail: 'each host attempt runs in its own bubblewrap view' }],
        [{ profile: 'runtime-sandbox', ready: true, checks: [], concurrency: 1 }],
      ),
      ruleAware: true,
    });
    expect(c.hostIsolation).toMatchObject({ confinement: 'bwrap', state: 'ok' });
    expect(c.profiles.find((p) => p.profile === 'host-restricted')).toMatchObject({
      parallel: 3,
      limitedBy: 'max_parallel_jobs',
    });
    expect(c.profiles.find((p) => p.profile === 'runtime-sandbox')).toMatchObject({
      parallel: 1,
      runsAlone: true,
      limitedBy: 'runtime_sandbox_nesting',
    });
    const raise = c.advice.find((a) => a.startsWith('Raise'));
    expect(raise).toContain('“En çok paralel iş / Max parallel jobs” (now 3)');
    expect(raise).toContain('Makineler → ec2-linux → Yapılandırma → Genel');
    expect(raise).toContain('draft_worker_config_change');
    expect(raise).toContain('localCeiling.maxParallelJobs = 4');
    expect(c.subscriptionLogins).toMatch(/one job family at a time/);
  });

  it('Windows: per-job accounts are the lever; subscription logins one at a time per login', () => {
    const c = capacityOf({
      name: 'desk',
      os: 'win32',
      features: [SLOTS],
      maxParallelJobs: 3,
      profileConcurrency: { 'host-restricted': 1 },
      exclusiveProfiles: ['host-restricted'],
      localLogin: {
        runtimes: ['claude-code'],
        exclusiveProfiles: ['host-restricted'],
        stores: { 'claude-code': 'claude' },
      },
      sandboxStatus: status('win32', { concurrency: 1 }, [
        { id: 'job_slots', status: 'warning', code: 'job_slots_unprovisioned', detail: 'no accounts' },
      ]),
    });
    expect(c.profiles.find((p) => p.profile === 'host-restricted')?.limitedBy).toBe('per_job_accounts');
    expect(c.advice.join('\n')).toMatch(
      /Set up per-job Windows accounts: Makineler → desk → Sandbox ve politika → Hazırla/,
    );
    expect(c.subscriptionLogins).toMatch(/claude-code run one at a time per login/);
  });

  it('macOS Seatbelt: only maxParallelJobs; unconfined always alone; older reports', () => {
    const c = capacityOf({
      name: 'mac',
      os: 'darwin',
      features: [SLOTS],
      maxParallelJobs: 2,
      profileConcurrency: { 'host-restricted': 2, unconfined: 1 },
      exclusiveProfiles: ['unconfined'],
      localLogin: null,
      sandboxStatus: status(
        'darwin',
        { concurrency: 2, confinement: { filesystem: 'seatbelt', egress: 'enforced', limits: 'rlimits' } },
        [],
        [],
      ),
    });
    expect(c.hostIsolation.confinement).toBe('seatbelt');
    expect(c.advice.join()).toMatch(/^Raise/);
    // A worker without profile-slots-v1 / sandbox status: nothing invented.
    const old = capacityOf({
      name: 'old',
      os: 'linux',
      features: [],
      maxParallelJobs: 1,
      profileConcurrency: null,
      exclusiveProfiles: null,
      localLogin: null,
      sandboxStatus: null,
    });
    expect(old.profiles).toEqual([]);
    expect(old.hostIsolation.confinement).toBe('unknown');
    expect(capacityRuleAware(['assistant-capacity-v1'])).toBe(true);
    expect(capacityRuleAware(null)).toBe(false);
  });

  it('p19-unconfined-parallel: unconfined alone names the setting; with it on, bounded by maxParallelJobs', () => {
    const base = {
      name: 'mac',
      os: 'darwin',
      features: [SLOTS],
      maxParallelJobs: 3,
      localLogin: null,
    };
    const unconfined = { profile: 'unconfined', ready: true, checks: [] };
    const st = (u: Record<string, unknown>) => {
      const s = status('darwin', { concurrency: 3, confinement: { filesystem: 'seatbelt' } });
      return { ...s, profiles: [...s.profiles.filter((p) => p.profile !== 'unconfined'), u] };
    };
    const alone = capacityOf({
      ...base,
      profileConcurrency: { 'host-restricted': 3, unconfined: 1 },
      exclusiveProfiles: ['unconfined'],
      sandboxStatus: st(unconfined),
    });
    expect(alone.profiles.find((p) => p.profile === 'unconfined')).toMatchObject({
      runsAlone: true,
      limitedBy: 'unconfined_profile',
    });
    expect(alone.profiles.find((p) => p.profile === 'unconfined')?.why).toContain(
      'Sandbox’sız işler paralel çalışabilir',
    );
    expect(alone.advice.join('\n')).toContain('Makineler → mac → Sandbox ve politika');
    const parallel = capacityOf({
      ...base,
      profileConcurrency: { 'host-restricted': 3, unconfined: 3 },
      exclusiveProfiles: [],
      sandboxStatus: st({ ...unconfined, concurrency: 3 }),
    });
    expect(parallel.profiles.find((p) => p.profile === 'unconfined')).toMatchObject({
      parallel: 3,
      runsAlone: false,
      limitedBy: 'max_parallel_jobs',
    });
    expect(parallel.advice.join('\n')).not.toContain('Sandbox’sız işler paralel');
  });
});
