import { describe, expect, it } from 'vitest';
import type { ProjectReadiness } from '../../src/chat/project-setup.js';
import { assessWork, type WorkContext, type WorkerFacts } from '../../src/chat/work-readiness.js';

/**
 * p20-scope-preview (docs/design/p20-scope-preview.md §4; tools a job needs are installed automatically): the
 * deterministic work-specific readiness check behind check_work_readiness — preparation it can run is
 * returned as ready tool calls, what only the user can decide as ONE question, and what nobody can fix as blocked.
 */
const AT = '2026-10-31T12:00:00.000Z';

const readiness = (over: Partial<ProjectReadiness> = {}): ProjectReadiness => ({
  project: 'shop',
  name: 'Shop',
  kind: 'workspace',
  repository: null,
  network: {
    mode: 'allowlist',
    presets: [],
    hosts: [],
    decided: true,
    setting: 'project',
    unsupportedMachines: [],
  },
  runtime: 'claude-code',
  machines: [
    {
      id: 'w-1',
      name: 'linux-1',
      os: 'linux',
      arch: 'x64',
      online: true,
      managed: true,
      assigned: true,
      preferred: true,
      canRun: 'now',
      assignable: false,
      runtimes: ['claude-code'],
      why: [],
    },
  ],
  holds: [],
  missing: [],
  ...over,
});

const sandbox = (ready: boolean, fix?: string) => ({
  checkedAt: AT,
  platform: 'linux',
  workerUser: { running: 'remyral', source: 'config' },
  privilegedPrepare: { available: true },
  profiles: [
    {
      profile: 'host-restricted',
      ready,
      checks: [],
      ...(ready ? {} : { code: 'bwrap_missing', reason: 'bubblewrap is not installed', fix }),
    },
  ],
  checks: [],
});

const inventory = (cloudflared: boolean, elevated = false) => ({
  detectedAt: AT,
  ttlSec: 3600,
  tools: [{ name: 'cloudflared', found: cloudflared, source: 'system' }],
  recipes: [{ tool: 'cloudflared', version: '2025.8.0', elevated, supported: true, installed: cloudflared }],
});

const worker = (over: Partial<WorkerFacts> = {}): WorkerFacts => ({
  id: 'w-1',
  name: 'linux-1',
  state: 'online',
  features: ['services-v1'],
  localProjects: ['shop'],
  sandboxStatus: sandbox(true),
  previewTunnels: { cloudflared: { version: '2025.8.0', source: 'managed' }, connectors: [] },
  toolInventory: inventory(true),
  machineAdmin: null,
  ...over,
});

const userTurn: WorkContext = { canPrepare: true, runsAtOnce: true, machineAdminByPolicy: true };

describe('assessWork (check_work_readiness)', () => {
  it('ready: a service with a quick tunnel on a prepared machine', () => {
    const v = assessWork(
      { project: 'shop', kind: 'service', tunnel: 'quick' },
      readiness(),
      [worker()],
      userTurn,
    );
    expect(v).toMatchObject({
      ready: true,
      prepare: [],
      ask: null,
      blocked: null,
      next: 'ready: start the work',
    });
    expect(v.worker).toEqual({ id: 'w-1', name: 'linux-1' });
  });

  it('a sandbox that needs a privileged prepare becomes a draft_machine_prepare call that runs at once', () => {
    const v = assessWork(
      { project: 'shop', kind: 'service' },
      readiness(),
      [worker({ sandboxStatus: sandbox(false, 'prepare_privileged') })],
      userTurn,
    );
    expect(v.ready).toBe(false);
    expect(v.prepare).toEqual([
      expect.objectContaining({
        tool: 'draft_machine_prepare',
        input: { workerId: 'w-1', privileged: true },
        runsAtOnce: true,
      }),
    ]);
    expect(v.ask).toBeNull();
    expect(v.next).toContain('draft_machine_prepare');
  });

  it('without chatMachineAdmin a privileged prepare is a card; without the role it is a question', () => {
    const w = [worker({ sandboxStatus: sandbox(false, 'prepare_privileged') })];
    const card = assessWork({ project: 'shop', kind: 'service' }, readiness(), w, {
      ...userTurn,
      machineAdminByPolicy: false,
    });
    expect(card.prepare[0]?.runsAtOnce).toBe(false);
    const operator = assessWork({ project: 'shop', kind: 'service' }, readiness(), w, {
      ...userTurn,
      canPrepare: false,
    });
    expect(operator.prepare).toEqual([]);
    expect(operator.ask?.reason).toBe('prepare_needs_admin');
  });

  it('a missing cloudflared is installed before the tunnel is needed', () => {
    const v = assessWork(
      { project: 'shop', kind: 'service', tunnel: 'quick' },
      readiness(),
      [worker({ previewTunnels: { cloudflared: null, connectors: [] }, toolInventory: inventory(false) })],
      userTurn,
    );
    expect(v.prepare).toEqual([
      expect.objectContaining({
        tool: 'draft_tool_install',
        input: { workerId: 'w-1', tool: 'cloudflared', version: '2025.8.0' },
        runsAtOnce: true,
      }),
    ]);
    expect(v.checks.find((c) => c.check === 'cloudflared')?.ok).toBe(false);
  });

  it('closed network access becomes ONE question with its reason', () => {
    const v = assessWork({ project: 'shop', kind: 'job', network: 'web' }, readiness(), [worker()], userTurn);
    expect(v.ask).toMatchObject({ reason: 'network_closed' });
    expect(v.ask?.question).toContain('"web"');
    expect(v.next).toContain('ask the user the one question');
  });

  it('an unassigned machine for a service is a question; an offline machine or a hold blocks', () => {
    expect(
      assessWork(
        { project: 'shop', kind: 'service' },
        readiness(),
        [worker({ localProjects: ['other'] })],
        userTurn,
      ).ask?.reason,
    ).toBe('machine_not_assigned');
    expect(
      assessWork(
        { project: 'shop', kind: 'service', worker: 'linux-1' },
        readiness(),
        [worker({ state: 'offline' })],
        userTurn,
      ).blocked?.reason,
    ).toBe('machine_offline');
    const held = assessWork(
      { project: 'shop', kind: 'job' },
      readiness({ holds: [{ code: 'kill_switch', message: 'The project is paused.' }] }),
      [worker()],
      userTurn,
    );
    expect(held.blocked?.reason).toBe('hold_kill_switch');
    expect(held.next).toContain('do not start the work');
  });

  it('a continuation turn without the user present: preparation is listed but does not claim to run at once', () => {
    const v = assessWork(
      { project: 'shop', kind: 'service' },
      readiness(),
      [worker({ sandboxStatus: sandbox(false, 'prepare') })],
      { canPrepare: true, runsAtOnce: false, machineAdminByPolicy: false },
    );
    expect(v.prepare[0]).toMatchObject({ tool: 'draft_machine_prepare', runsAtOnce: false });
  });
});
