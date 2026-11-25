import { describe, expect, it } from 'vitest';
import {
  eligibility,
  hasLoginExclusion,
  infeasibleReason,
  place,
  type PlacementJob,
  type PlacementWorker,
  score,
} from '../src/placement.js';

const job: PlacementJob = {
  project: 'acme',
  runtime: 'codex',
  sandboxProfile: 'container',
  secretWorkers: [],
  declinedBy: [],
  failedOn: [],
};

function worker(over: Partial<PlacementWorker> = {}): PlacementWorker {
  return {
    id: 'wrk_a',
    state: 'online',
    connected: true,
    capabilitiesKnown: true,
    os: 'linux',
    arch: 'x64',
    runtimes: [
      {
        runtime: 'codex',
        version: '0.162.1',
        installed: true,
        authenticated: 'yes',
        pinStatus: 'match',
        pinnedVersion: '0.162.1',
      },
    ],
    sandboxProfiles: ['container', 'host-restricted'],
    maxParallelJobs: 2,
    activeLeases: 0,
    allowedProjects: null,
    localProjects: ['acme'],
    history: { succeeded: 0, failed: 0, lost: 0 },
    projectAffinity: 0,
    ...over,
  };
}

const codes = (w: PlacementWorker, j: PlacementJob = job) => eligibility(j, w).map((r) => r.code);

describe('placement eligibility filters (p4-scheduler)', () => {
  it('accepts a fully matching worker', () => {
    expect(codes(worker())).toEqual([]);
  });

  it.each([
    ['offline', worker({ connected: false, state: 'offline' }), 'offline', false],
    ['draining', worker({ state: 'draining' }), 'draining', false],
    ['updating', worker({ state: 'updating' }), 'updating', false],
    ['no free slot', worker({ activeLeases: 2 }), 'no_free_slot', false],
    ['capabilities not yet reported', worker({ capabilitiesKnown: false }), 'capabilities_unknown', false],
    ['runtime missing', worker({ runtimes: [] }), 'runtime_not_installed', true],
    [
      'pin mismatch',
      worker({
        runtimes: [
          {
            runtime: 'codex',
            version: '0.160.0',
            installed: true,
            authenticated: 'yes',
            pinStatus: 'mismatch',
            pinnedVersion: '0.162.1',
          },
        ],
      }),
      'runtime_version_unverified',
      true,
    ],
    [
      'not authenticated',
      worker({
        runtimes: [
          { runtime: 'codex', version: '0.162.1', installed: true, authenticated: 'no', pinStatus: 'match' },
        ],
      }),
      'runtime_not_authenticated',
      true,
    ],
    [
      'sandbox profile missing',
      worker({ sandboxProfiles: ['host-restricted'] }),
      'sandbox_profile_unavailable',
      true,
    ],
    ['master project policy', worker({ allowedProjects: ['other'] }), 'project_not_allowed', true],
    [
      'worker repository allowlist',
      worker({ localProjects: ['other'] }),
      'project_not_in_worker_allowlist',
      true,
    ],
    ['zero capacity', worker({ maxParallelJobs: 0 }), 'no_free_slot', true],
  ])('%s → %s (permanent=%s)', (_label, w, code, permanent) => {
    const reasons = eligibility(job, w);
    expect(reasons.map((r) => r.code)).toContain(code);
    expect(reasons.find((r) => r.code === code)?.permanent).toBe(permanent);
    expect(reasons.find((r) => r.code === code)?.message.length).toBeGreaterThan(10);
  });

  it('os/arch requirements, exact runtime version, declined and secret-bound jobs', () => {
    expect(codes(worker(), { ...job, os: ['darwin'] })).toEqual(['os_mismatch']);
    expect(codes(worker(), { ...job, arch: ['arm64'] })).toEqual(['arch_mismatch']);
    expect(codes(worker(), { ...job, runtimeVersion: '0.150.0' })).toEqual(['runtime_version_mismatch']);
    expect(codes(worker(), { ...job, declinedBy: ['wrk_a'] })).toEqual(['declined_before']);
    expect(codes(worker(), { ...job, secretWorkers: ['wrk_b'] })).toEqual(['secret_bound_to_other_worker']);
    expect(codes(worker(), { ...job, secretWorkers: ['wrk_a'] })).toEqual([]);
  });

  it('never places on pending or quarantined workers', () => {
    expect(codes(worker({ state: 'pending' }))).toEqual(['not_enrolled']);
    expect(codes(worker({ state: 'quarantined' }))).toEqual(['quarantined']);
  });
});

describe('placement scoring and verdicts', () => {
  it('ranks by free capacity, reliability and affinity; penalises a worker that lost this job', () => {
    const idle = worker({ id: 'wrk_idle' });
    const half = worker({ id: 'wrk_half', activeLeases: 1 });
    const flaky = worker({ id: 'wrk_flaky', history: { succeeded: 1, failed: 5, lost: 4 } });
    const warm = worker({ id: 'wrk_warm', projectAffinity: 5 });
    const r = place(job, [half, flaky, idle, warm]);
    if (r.kind !== 'placed') throw new Error(r.kind);
    expect(r.ranked.map((x) => x.workerId)).toEqual(['wrk_warm', 'wrk_idle', 'wrk_flaky', 'wrk_half']);
    const retry = place({ ...job, failedOn: ['wrk_warm'] }, [warm, idle]);
    if (retry.kind !== 'placed') throw new Error(retry.kind);
    expect(retry.ranked[0]?.workerId).toBe('wrk_idle');
    expect(score(job, idle).score).toBeGreaterThan(score(job, half).score);
  });

  it('is deterministic (ties broken by worker id, input order irrelevant)', () => {
    const a = worker({ id: 'wrk_a' });
    const b = worker({ id: 'wrk_b' });
    const one = place(job, [b, a]);
    const two = place(job, [a, b]);
    expect(one).toEqual(two);
    if (one.kind !== 'placed') throw new Error(one.kind);
    expect(one.ranked.map((x) => x.workerId)).toEqual(['wrk_a', 'wrk_b']);
  });

  it('waits when some worker could run it later; infeasible only when every worker is permanently excluded', () => {
    const waiting = place(job, [worker({ activeLeases: 2 }), worker({ id: 'wrk_b', runtimes: [] })]);
    expect(waiting.kind).toBe('waiting');
    const infeasible = place({ ...job, runtime: 'pi' }, [
      worker(),
      worker({ id: 'wrk_b', connected: false, state: 'offline' }),
    ]);
    expect(infeasible.kind).toBe('infeasible');
    if (infeasible.kind !== 'infeasible') throw new Error('unreachable');
    expect(infeasible.summary.find((s) => s.code === 'runtime_not_installed')?.workers).toEqual([
      'wrk_a',
      'wrk_b',
    ]);
    const text = infeasibleReason(infeasible.summary);
    expect(text).toMatch(/^no eligible worker: runtime_not_installed \[wrk_a, wrk_b\]: pi is not installed/);
    expect(text.length).toBeLessThanOrEqual(1000);
  });

  it('an empty fleet waits (a worker may still be paired); quarantined-only fleets too', () => {
    expect(place(job, []).kind).toBe('waiting');
    const r = place(job, [worker({ state: 'quarantined' })]);
    expect(r.kind).toBe('waiting');
    if (r.kind === 'waiting') expect(r.summary[0]?.code).toBe('no_workers');
  });
});

describe('composer constraints: tools and worker affinity (p5-composer)', () => {
  it('excludes workers outside the affinity list, permanently', () => {
    const pinned: PlacementJob = { ...job, workers: ['wrk_b'] };
    const r = eligibility(pinned, worker());
    expect(r.map((x) => x.code)).toEqual(['worker_not_selected']);
    expect(r[0]?.permanent).toBe(true);
    expect(codes(worker({ id: 'wrk_b' }), pinned)).toEqual([]);
  });

  it('requires every requested tool and names the missing ones', () => {
    const needs: PlacementJob = { ...job, tools: ['git', 'docker'] };
    const r = eligibility(needs, worker({ tools: ['git', 'node'] }));
    expect(r.map((x) => x.code)).toEqual(['tool_missing']);
    expect(r[0]?.message).toContain('does not report docker');
    expect(codes(worker({ tools: ['docker', 'git'] }), needs)).toEqual([]);
    // A worker that reported no tools cannot satisfy a tool requirement.
    expect(codes(worker(), needs)).toEqual(['tool_missing']);
  });

  it('a repository job implicitly needs git (p5-live-fixes-2)', () => {
    const repo: PlacementJob = { ...job, repository: true };
    const r = eligibility(repo, worker({ tools: ['node', 'python'] }));
    expect(r.map((x) => x.code)).toEqual(['tool_missing']);
    expect(r[0]?.permanent).toBe(true);
    expect(r[0]?.message).toContain('tool_missing: git');
    expect(r[0]?.message).toContain('Machines > <machine> > Tools');
    expect(codes(worker({ tools: ['git', 'node'] }), repo)).toEqual([]);
    // Combined with an explicit requirement both are named once.
    const both = eligibility({ ...repo, tools: ['docker'] }, worker({ tools: ['node'] }));
    expect(both[0]?.message).toContain('docker, git');
    // A worker that never reported tools (legacy facts) is not excluded for the implicit requirement.
    expect(codes(worker(), repo)).toEqual([]);
  });

  it('workspace and machine-admin jobs do not need git', () => {
    expect(codes(worker({ tools: ['node'], workspaceSupported: true }), { ...job, workspace: true })).toEqual(
      [],
    );
    expect(
      codes(worker({ tools: ['node'], workspaceSupported: true }), {
        ...job,
        repository: true,
        workspace: true,
      }),
    ).toEqual([]);
    expect(codes(worker({ tools: ['node'] }), job)).toEqual([]);
  });

  it('a job pinned to a worker that cannot run it is infeasible with both reasons', () => {
    const pinned: PlacementJob = { ...job, workers: ['wrk_a'], tools: ['docker'] };
    const res = place(pinned, [worker(), worker({ id: 'wrk_b', tools: ['docker'] })]);
    expect(res.kind).toBe('infeasible');
    if (res.kind === 'placed') throw new Error('unexpected');
    expect(res.summary.map((s) => s.code).sort()).toEqual(['tool_missing', 'worker_not_selected']);
  });
});

describe('panel-managed workers (ADR-0015)', () => {
  const managed = (over: Partial<NonNullable<PlacementWorker['managed']>> = {}) =>
    worker({
      // Legacy facts that would refuse the job must not apply to a managed worker.
      localProjects: [],
      allowedProjects: [],
      managed: {
        supported: true,
        desiredGeneration: 3,
        appliedGeneration: 3,
        rejected: null,
        assignedProjects: ['acme'],
        assignedRuntimes: ['codex'],
        effectiveProjects: ['acme'],
        effectiveRuntimes: ['codex'],
        blocked: {},
        ...over,
      },
    });
  const reasons = (w: PlacementWorker, j: PlacementJob = job) =>
    eligibility(j, w).map((r) => `${r.code}:${String(r.permanent)}`);

  it('uses the panel configuration instead of the local allowlist', () => {
    expect(codes(managed())).toEqual([]);
    expect(codes(managed(), { ...job, repositoryRegistered: true })).toEqual([]);
  });

  it('explains every managed exclusion with a stable code', () => {
    expect(reasons(managed({ assignedProjects: [] }))).toEqual(['project_not_assigned:true']);
    expect(reasons(managed(), { ...job, repositoryRegistered: false })).toEqual(['repo_not_registered:true']);
    expect(reasons(managed({ assignedRuntimes: [] }))).toEqual(['runtime_not_enabled:true']);
    expect(reasons(managed({ appliedGeneration: 2 }))).toEqual(['config_not_applied:false']);
    expect(
      reasons(managed({ appliedGeneration: 2, rejected: { generation: 3, reason: 'bad_signature' } })),
    ).toEqual(['config_not_applied:true']);
    expect(reasons(managed({ supported: false, appliedGeneration: null }))).toEqual([
      'config_not_applied:true',
    ]);
    const blocked = eligibility(
      job,
      managed({ effectiveProjects: [], blocked: { 'projects.acme': 'host not in repoHosts' } }),
    );
    expect(blocked.map((r) => r.code)).toEqual(['blocked_by_local_ceiling']);
    expect(blocked[0]?.message).toContain('host not in repoHosts');
    expect(reasons(managed({ effectiveRuntimes: [] }))).toEqual(['blocked_by_local_ceiling:true']);
  });

  it('a pending configuration only makes the job wait; a missing assignment makes it infeasible', () => {
    expect(place(job, [managed({ appliedGeneration: 2 })]).kind).toBe('waiting');
    expect(place(job, [managed({ assignedProjects: [] })]).kind).toBe('infeasible');
  });
});

describe('vault credentials and model catalog (p5-credentials-models)', () => {
  const managed = (over: Partial<NonNullable<PlacementWorker['managed']>> = {}) =>
    worker({
      localProjects: [],
      allowedProjects: [],
      managed: {
        supported: true,
        desiredGeneration: 3,
        appliedGeneration: 3,
        rejected: null,
        assignedProjects: ['acme'],
        assignedRuntimes: ['codex'],
        effectiveProjects: ['acme'],
        effectiveRuntimes: ['codex'],
        blocked: {},
        ...over,
      },
    });
  const reasons = (w: PlacementWorker, j: PlacementJob = job) =>
    eligibility(j, w).map((r) => `${r.code}:${String(r.permanent)}`);

  it('a pending credential delivery makes the job wait, a missing credential makes it infeasible', () => {
    const pending = managed({ runtimeCredentials: { codex: { credentialId: 'openai', state: 'pending' } } });
    const missing = managed({ runtimeCredentials: { codex: { credentialId: 'openai', state: 'missing' } } });
    const ready = managed({ runtimeCredentials: { codex: { credentialId: 'openai', state: 'ready' } } });
    expect(reasons(pending)).toEqual(['credential_missing:false']);
    expect(reasons(missing)).toEqual(['credential_missing:true']);
    expect(reasons(ready)).toEqual([]);
    expect(place(job, [pending]).kind).toBe('waiting');
    expect(place(job, [missing]).kind).toBe('infeasible');
    // Another runtime's credential does not matter for this job.
    expect(reasons(managed({ runtimeCredentials: { pi: { credentialId: 'x', state: 'missing' } } }))).toEqual(
      [],
    );
  });

  it('an unusable model profile is a permanent reason (worker default or the job choice)', () => {
    expect(
      reasons(managed({ unavailableModelProfiles: { codex: 'model profile fast is disabled' } })),
    ).toEqual(['model_profile_unavailable:true']);
    const j = { ...job, modelProfileUnavailable: 'model profile fast is disabled in the model catalog' };
    expect(reasons(worker(), j)).toContain('model_profile_unavailable:true');
    expect(place(j, [worker()]).kind).toBe('infeasible');
  });
});

describe('job model profiles (p5-credentials-models)', () => {
  const reasons = (w: PlacementWorker, j: PlacementJob) =>
    eligibility(j, w).map((r) => `${r.code}:${String(r.permanent)}`);

  it('a job with a catalog profile needs model-profile-v1 workers', () => {
    const j = { ...job, modelProfile: { id: 'claude-aws' } };
    expect(reasons(worker(), j)).toEqual(['model_profile_unavailable:true']);
    expect(eligibility(j, worker())[0]?.message).toContain('model-profile-v1');
    expect(reasons(worker({ modelProfileSupported: true }), j)).toEqual([]);
    expect(place(j, [worker()]).kind).toBe('infeasible');
  });

  it('a vault credential of the profile of the job must be on the worker', () => {
    const j = {
      ...job,
      modelProfile: { id: 'claude-aws', credentialId: 'aws', credentialWorkers: ['wrk_b'] },
    };
    const a = worker({ modelProfileSupported: true });
    const b = worker({ id: 'wrk_b', modelProfileSupported: true });
    expect(reasons(a, j)).toEqual(['credential_missing:true']);
    expect(eligibility(j, a)[0]?.message).toContain('vault credential aws of model profile claude-aws');
    expect(reasons(b, j)).toEqual([]);
    const r = place(j, [a, b]);
    expect(r.kind === 'placed' ? r.ranked.map((x) => x.workerId) : []).toEqual(['wrk_b']);
  });
});

describe('workspace jobs (p5-research-workspace)', () => {
  const ws: PlacementJob = { ...job, project: 'genel', workspace: true };

  it('needs a worker that advertises workspace-v1 (permanent workspace_unsupported otherwise)', () => {
    const old = worker({ localProjects: ['genel'] });
    expect(eligibility(ws, old).map((r) => `${r.code}:${String(r.permanent)}`)).toEqual([
      'workspace_unsupported:true',
    ]);
    expect(place(ws, [old]).kind).toBe('infeasible');
    expect(codes(worker({ localProjects: ['genel'], workspaceSupported: true }), ws)).toEqual([]);
  });

  it('repository jobs ignore the workspace feature', () => {
    expect(codes(worker({ workspaceSupported: false }))).toEqual([]);
  });

  it('a scratch step of a repository project also needs repo-scratch-v1 (p16-workflow-quality)', () => {
    const scratch: PlacementJob = { ...job, workspace: true, repoScratch: true };
    const old = worker({ workspaceSupported: true });
    expect(eligibility(scratch, old).map((r) => `${r.code}:${String(r.permanent)}`)).toEqual([
      'workspace_unsupported:true',
    ]);
    expect(eligibility(scratch, old)[0]?.message).toContain('repo-scratch-v1');
    expect(codes(worker({ workspaceSupported: true, repoScratchSupported: true }), scratch)).toEqual([]);
  });

  it('a managed worker runs an assigned workspace project without a registered repository', () => {
    const m: NonNullable<PlacementWorker['managed']> = {
      supported: true,
      desiredGeneration: 2,
      appliedGeneration: 2,
      rejected: null,
      assignedProjects: ['genel'],
      assignedRuntimes: ['codex'],
      effectiveProjects: ['genel'],
      effectiveRuntimes: ['codex'],
      blocked: {},
    };
    const w = worker({ localProjects: [], allowedProjects: [], workspaceSupported: true, managed: m });
    expect(codes(w, ws)).toEqual([]);
    expect(codes({ ...w, managed: { ...m, assignedProjects: [] } }, ws)).toEqual(['project_not_assigned']);
  });
});

describe('full access: approval policy allow-all (p5-full-access, ADR-0020)', () => {
  const allowAll: PlacementJob = { ...job, approvalPolicy: 'allow-all', autoApproveOptIn: true };

  it('needs a worker that advertises full-access-v1 (permanent approval_policy_unsupported otherwise)', () => {
    expect(codes(worker(), allowAll)).toEqual(['approval_policy_unsupported']);
    expect(codes(worker({ fullAccessSupported: true }), allowAll)).toEqual([]);
    expect(eligibility(allowAll, worker()).every((r) => r.permanent)).toBe(true);
  });

  it('needs the project opt-in (permanent auto_approve_not_allowed, with the Execution policy path)', () => {
    const r = eligibility({ ...allowAll, autoApproveOptIn: false }, worker({ fullAccessSupported: true }));
    expect(r.map((x) => x.code)).toEqual(['auto_approve_not_allowed']);
    expect(r[0]?.permanent).toBe(true);
    expect(r[0]?.message).toContain('Execution policy');
    // An unknown opt-in is treated as not allowed (fail closed).
    const { autoApproveOptIn: _o, ...unknown } = allowAll;
    expect(codes(worker({ fullAccessSupported: true }), unknown)).toEqual(['auto_approve_not_allowed']);
  });

  it('asking policies ignore the feature and the opt-in', () => {
    for (const approvalPolicy of ['ask-all', 'ask-sensitive', 'deny-sensitive']) {
      expect(codes(worker(), { ...job, approvalPolicy, autoApproveOptIn: false })).toEqual([]);
    }
  });

  it('an allow-all job with no eligible worker is infeasible', () => {
    expect(place(allowAll, [worker(), worker({ id: 'wrk_b' })]).kind).toBe('infeasible');
  });
});

describe('machine administration (p5-machine-admin, ADR-0021)', () => {
  const admin: PlacementJob = { ...job, machineAdmin: true };
  const on = { supported: true, enabled: true, autoApprove: false, localVeto: false };

  it('needs a worker that advertises machine-admin-v1 and has it enabled, without a local veto', () => {
    expect(codes(worker(), admin)).toEqual(['machine_admin_unsupported']);
    expect(codes(worker({ machineAdmin: { ...on, supported: false } }), admin)).toEqual([
      'machine_admin_unsupported',
    ]);
    expect(codes(worker({ machineAdmin: { ...on, enabled: false } }), admin)).toEqual([
      'machine_admin_not_enabled',
    ]);
    const veto = eligibility(admin, worker({ machineAdmin: { ...on, localVeto: true } }));
    expect(veto.map((r) => r.code)).toEqual(['machine_admin_not_enabled']);
    expect(veto[0]?.message).toContain('allowMachineAdmin');
    expect(codes(worker({ machineAdmin: on }), admin)).toEqual([]);
    expect(eligibility(admin, worker()).every((r) => r.permanent)).toBe(true);
  });

  it('allow-all also needs the worker auto-approve switch', () => {
    const allowAll: PlacementJob = { ...admin, approvalPolicy: 'allow-all', autoApproveOptIn: true };
    expect(codes(worker({ fullAccessSupported: true, machineAdmin: on }), allowAll)).toEqual([
      'auto_approve_not_allowed',
    ]);
    expect(
      codes(worker({ fullAccessSupported: true, machineAdmin: { ...on, autoApprove: true } }), allowAll),
    ).toEqual([]);
  });

  it('ordinary jobs ignore the machine admin facts', () => {
    expect(codes(worker({ machineAdmin: { ...on, enabled: false, localVeto: true } }))).toEqual([]);
  });
});

describe('capability_unverified (p5-first-live-fixes, ADR-0008)', () => {
  const unverifiedApproval = (allow: readonly string[] | undefined) =>
    worker({
      runtimes: [
        {
          runtime: 'codex',
          version: '0.162.1',
          installed: true,
          authenticated: 'yes',
          pinStatus: 'match',
          pinnedVersion: '0.162.1',
          capabilities: { streaming: 'supported', cancel: 'supported', approval: 'unverified' },
        },
      ],
      allowUnverifiedRuntimes: allow,
    });

  it('excludes a worker whose required capabilities are unverified and not allowed by its policy', () => {
    const reasons = eligibility(job, unverifiedApproval([]));
    expect(reasons.map((r) => r.code)).toEqual(['capability_unverified']);
    expect(reasons[0]?.permanent).toBe(true);
    expect(reasons[0]?.message).toContain('approval unverified');
    expect(reasons[0]?.message).toContain('Settings → Runtimes');
    expect(place(job, [unverifiedApproval([])]).kind).toBe('infeasible');
  });

  it('accepts it when the policy allows unverified for the runtime', () => {
    expect(codes(unverifiedApproval(['codex']))).toEqual([]);
  });

  it('is not predicted when the policy facts are absent (dispatch defers to the worker gate)', () => {
    expect(codes(unverifiedApproval(undefined))).toEqual([]);
  });

  it('ignores approval when nobody is ever asked', () => {
    expect(codes(unverifiedApproval([]), { ...job, approvalPolicy: 'deny-sensitive' })).toEqual([]);
  });
});

describe('pull request head jobs (p6-automations-next, ADR-0026)', () => {
  const pr: PlacementJob = { ...job, pullRequestHead: true };

  it('needs a worker that advertises pr-head-v1 (permanent pr_head_unsupported otherwise)', () => {
    expect(eligibility(pr, worker()).map((r) => `${r.code}:${String(r.permanent)}`)).toEqual([
      'pr_head_unsupported:true',
    ]);
    expect(place(pr, [worker()]).kind).toBe('infeasible');
    expect(codes(worker({ prHeadSupported: true }), pr)).toEqual([]);
  });

  it('other jobs ignore the feature', () => {
    expect(codes(worker({ prHeadSupported: false }))).toEqual([]);
  });
});

describe('static site bundle jobs (p6-deploy-pipeline, ADR-0028)', () => {
  const site: PlacementJob = { ...job, siteBundle: true };

  it('needs a worker that advertises site-bundle-v1 (permanent site_bundle_unsupported otherwise)', () => {
    expect(eligibility(site, worker()).map((r) => `${r.code}:${String(r.permanent)}`)).toEqual([
      'site_bundle_unsupported:true',
    ]);
    expect(place(site, [worker()]).kind).toBe('infeasible');
    expect(codes(worker({ siteBundleSupported: true }), site)).toEqual([]);
  });
});

describe('job input bundles (p16-zip-job-input, ADR-0060)', () => {
  const bundle: PlacementJob = { ...job, inputBundle: true };

  it('needs a worker that advertises input-bundle-v1 (permanent input_bundle_unsupported otherwise)', () => {
    expect(eligibility(bundle, worker()).map((r) => `${r.code}:${String(r.permanent)}`)).toEqual([
      'input_bundle_unsupported:true',
    ]);
    const why = eligibility(bundle, worker())[0]?.message ?? '';
    expect(why).toMatch(/input-bundle-v1.*update the worker/);
    expect(place(bundle, [worker()]).kind).toBe('infeasible');
    expect(codes(worker({ inputBundleSupported: true }), bundle)).toEqual([]);
    // A job without a bundle is unaffected by old workers.
    expect(codes(worker())).toEqual([]);
  });
});

describe('repository job input files (p19-repo-job-inputs)', () => {
  const withInputs: PlacementJob = { ...job, repoInputs: true };

  it('needs a worker that advertises repo-inputs-v1 (permanent repo_inputs_unsupported otherwise)', () => {
    expect(eligibility(withInputs, worker()).map((r) => `${r.code}:${String(r.permanent)}`)).toEqual([
      'repo_inputs_unsupported:true',
    ]);
    expect(eligibility(withInputs, worker())[0]?.message ?? '').toMatch(/repo-inputs-v1.*update the worker/);
    expect(place(withInputs, [worker()]).kind).toBe('infeasible');
    expect(codes(worker({ repoInputsSupported: true }), withInputs)).toEqual([]);
    // A repository job without input files is unaffected by old workers.
    expect(codes(worker())).toEqual([]);
  });
});

describe('project environment credentials (p19-project-env)', () => {
  it('needs every credential on the worker (the job waits: temporary credential_missing)', () => {
    const bound: PlacementJob = {
      ...job,
      envCredentials: { credentials: ['dev-db'], credentialWorkers: ['other'] },
    };
    expect(eligibility(bound, worker()).map((r) => `${r.code}:${String(r.permanent)}`)).toEqual([
      'credential_missing:false',
    ]);
    expect(place(bound, [worker()]).kind).not.toBe('infeasible');
    expect(
      codes(worker(), {
        ...bound,
        envCredentials: { credentials: ['dev-db'], credentialWorkers: ['wrk_a'] },
      }),
    ).toEqual([]);
  });
});

describe('external MCP servers (p14-mcp-core, ADR-0054)', () => {
  const withMcp: PlacementJob = { ...job, mcp: { credentials: [] } };

  it('needs a worker that advertises mcp-v1 (permanent mcp_unsupported otherwise)', () => {
    expect(eligibility(withMcp, worker()).map((r) => `${r.code}:${String(r.permanent)}`)).toEqual([
      'mcp_unsupported:true',
    ]);
    expect(place(withMcp, [worker()]).kind).toBe('infeasible');
    expect(codes(worker({ mcpSupported: true }), withMcp)).toEqual([]);
  });

  it('needs the bound vault credentials on the worker (permanent credential_missing otherwise)', () => {
    const bound: PlacementJob = { ...job, mcp: { credentials: ['gh'], credentialWorkers: ['other'] } };
    expect(codes(worker({ mcpSupported: true }), bound)).toEqual(['credential_missing']);
    expect(
      codes(worker({ mcpSupported: true }), {
        ...bound,
        mcp: { credentials: ['gh'], credentialWorkers: ['wrk_a'] },
      }),
    ).toEqual([]);
  });

  it('p14-mcp-stdio: local packages must be installed on the worker (mcp_not_installed, the job waits)', () => {
    const local: PlacementJob = {
      ...job,
      mcp: { credentials: [], stdio: ['files@1.0.0'], installedWorkers: ['other'] },
    };
    const r = eligibility(local, worker({ mcpSupported: true }));
    expect(r.map((x) => `${x.code}:${String(x.permanent)}`)).toEqual(['mcp_not_installed:false']);
    expect(place(local, [worker({ mcpSupported: true })]).kind).not.toBe('infeasible');
    expect(
      codes(worker({ mcpSupported: true }), { ...local, mcp: { ...local.mcp, installedWorkers: ['wrk_a'] } }),
    ).toEqual([]);
  });

  it('jobs without MCP ignore the feature', () => {
    expect(codes(worker({ mcpSupported: false }))).toEqual([]);
  });
});

describe('layout-v2 skills (p14-skill-catalogs, ADR-0054)', () => {
  const wide: PlacementJob = { ...job, skillLayoutV2: true };

  it('needs a worker that advertises skills-layout-v2 (permanent skill_layout_unsupported otherwise)', () => {
    expect(eligibility(wide, worker()).map((r) => `${r.code}:${String(r.permanent)}`)).toEqual([
      'skill_layout_unsupported:true',
    ]);
    expect(place(wide, [worker()]).kind).toBe('infeasible');
    expect(codes(worker({ skillLayoutV2Supported: true }), wide)).toEqual([]);
    // Jobs whose skills fit today's layout run anywhere.
    expect(codes(worker(), job)).toEqual([]);
  });
});

describe('integration steps (p11-merge-pipeline, ADR-0041)', () => {
  const integration: PlacementJob = { ...job, integration: true, repository: true };

  it('needs an integration-v1 worker; its runtime, login and sandbox profile are not required', () => {
    const bare = worker({
      runtimes: [],
      sandboxProfiles: [],
      tools: ['git'],
    });
    expect(codes(bare, integration)).toEqual(['integration_unsupported']);
    expect(codes({ ...bare, integrationSupported: true }, integration)).toEqual([]);
    // An ordinary job on the same machine still needs its runtime.
    expect(codes({ ...bare, integrationSupported: true })).toContain('runtime_not_installed');
  });

  it('still needs git and a free slot', () => {
    const noGit = worker({ integrationSupported: true, tools: ['node'] });
    expect(codes(noGit, integration)).toContain('tool_missing');
    const full = worker({ integrationSupported: true, tools: ['git'], maxParallelJobs: 1, activeLeases: 1 });
    expect(codes(full, integration)).toContain('no_free_slot');
  });
});

describe('p10-claude-login-health: a signed-out runtime makes the job wait (bounded)', () => {
  const signedOut = worker({
    runtimes: [
      { runtime: 'codex', version: '0.162.1', installed: true, authenticated: 'no', pinStatus: 'match' },
    ],
  });
  const since = '2026-10-18T08:00:00.000Z';
  const until = '2026-10-18T08:30:00.000Z';

  it('without a login wait the reason stays permanent (infeasible), as before', () => {
    const r = place(job, [signedOut]);
    expect(r.kind).toBe('infeasible');
    expect(hasLoginExclusion(r)).toBe(true);
  });

  it('within the wait it is transient with the time it started; the job waits', () => {
    const r = place({ ...job, loginWait: { since, until, expired: false } }, [signedOut]);
    expect(r.kind).toBe('waiting');
    if (r.kind === 'placed') throw new Error('unreachable');
    expect(r.summary[0]).toMatchObject({
      code: 'runtime_not_authenticated',
      permanent: false,
      waitingSince: since,
      workers: ['wrk_a'],
    });
    expect(r.summary[0]?.message).toMatch(/^Codex needs a login on wrk_a — waiting \(until 2026-10-18T08:30/);
    // p14-i18n-reasons: the console says the wait from the cause, never from the English message.
    expect(r.summary[0]?.params).toEqual({ cause: 'login_wait', until });
  });

  it('after the wait it is permanent again (the job fails with a clear reason)', () => {
    const r = place({ ...job, loginWait: { since, until, expired: true } }, [signedOut]);
    expect(r.kind).toBe('infeasible');
    if (r.kind === 'placed') throw new Error('unreachable');
    expect(infeasibleReason(r.summary)).toContain('still signed out on wrk_a');
    // p14-i18n-reasons: no cause after the wait — the default "signed out" sentence.
    expect(r.summary.find((s) => s.code === 'runtime_not_authenticated')?.params).toBeUndefined();
  });

  it('a signed-in machine is placed at once; another machine signed out does not hold the job', () => {
    const ok = worker({ id: 'wrk_b' });
    const r = place({ ...job, loginWait: { since, until, expired: false } }, [signedOut, ok]);
    expect(r.kind).toBe('placed');
  });
});

describe('p15-merge-approvals: free disk under the minimum (disk_low)', () => {
  const GiB = 1024 ** 3;
  const low = worker({ id: 'wrk_low', disk: { freeBytes: 19.3 * GiB, minFreeBytes: 20 * GiB } });

  it('excludes a machine below its minimum free disk as a transient wait, with the figures as params', () => {
    const [r] = eligibility(job, low);
    expect(r).toMatchObject({
      code: 'disk_low',
      permanent: false,
      params: { freeBytes: 19.3 * GiB, minFreeBytes: 20 * GiB },
    });
    expect(r?.message).toContain('19.3 GiB free');
    expect(r?.message).toContain('Minimum free disk');
    // Only that machine: the job waits (never infeasible), or goes to another machine.
    expect(place(job, [low]).kind).toBe('waiting');
    const ok = worker({ id: 'wrk_ok', disk: { freeBytes: 50 * GiB, minFreeBytes: 20 * GiB } });
    const r2 = place(job, [low, ok]);
    expect(r2.kind === 'placed' ? r2.ranked.map((x) => x.workerId) : null).toEqual(['wrk_ok']);
  });

  it('ignores machines that do not report it, and function jobs (no workspace)', () => {
    expect(codes(worker())).toEqual([]);
    expect(codes(worker({ disk: { freeBytes: 20 * GiB, minFreeBytes: 20 * GiB } }))).toEqual([]);
    expect(codes(low, { ...job, function: { type: 'network' } })).not.toContain('disk_low');
  });
});
