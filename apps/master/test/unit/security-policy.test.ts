import { describe, expect, it } from 'vitest';
import { resolveRule } from '../../src/approvals/policy.js';
import { DEFAULT_STEP_UP_POLICY, policyStepUp, STEP_UP_ALWAYS_FRESH_MS } from '../../src/auth/step-up.js';
import { ACTION_NAMES } from '../../src/authz/model.js';
import { applyJobDefaults, type ProjectFacts } from '../../src/composer/defaults.js';
import {
  CORE_EVENTS,
  eventForRoute,
  eventOfAction,
  eventOfDraft,
  NO_STEP_UP_ACTIONS,
  settingsTargetEvent,
  STEP_UP_EVENT_IDS,
  STEP_UP_EVENTS,
} from '../../src/security-policy/events.js';
import {
  applyPatch,
  AUTONOMY_ACTIONS,
  autoApprovedActions,
  changedPaths,
  DEFAULT_DOCUMENT,
  documentFor,
  effectivePolicy,
  PRESETS,
  SecurityPolicyDocument,
} from '../../src/security-policy/model.js';

/** p15-autonomy (ADR-0056): the security policy model, the event catalog and their enforcement helpers (pure). */

const HOUR = 3_600_000;

describe('event catalog', () => {
  it('maps every authorization action to exactly one event or lists it as never asking for a code', () => {
    const problems: string[] = [];
    for (const a of ACTION_NAMES) {
      const mapped = eventOfAction(a) !== undefined;
      const exempt = NO_STEP_UP_ACTIONS.has(a);
      if (mapped === exempt)
        problems.push(`${a}: ${mapped ? 'mapped and exempt' : 'neither mapped nor exempt'}`);
    }
    expect(problems).toEqual([]);
    for (const a of NO_STEP_UP_ACTIONS) expect(ACTION_NAMES as readonly string[], a).toContain(a);
  });

  it('lists every action and route at most once', () => {
    const actions = STEP_UP_EVENT_IDS.flatMap((e) => STEP_UP_EVENTS[e].actions);
    const routes = STEP_UP_EVENT_IDS.flatMap((e) => STEP_UP_EVENTS[e].routes);
    expect(new Set(actions).size).toBe(actions.length);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('the safe core is the owner list: security policy, 2FA, users / roles, revealing secrets, API tokens, server update, install scripts', () => {
    expect([...CORE_EVENTS].sort()).toEqual([
      'account.mfa',
      // p16-api-tokens (ADR-0058): minting a credential that never asks for a code again.
      'api.tokens',
      // p17-host-actions part 3: replacing the live database with a backup.
      'backups.restore',
      // p19-install-scripts (ADR-0068): an approved npm install script runs on every machine that installs it.
      'extensions.install_scripts',
      // p17-host-actions: updating / rolling back the control plane (a rollback may restore a backup).
      'host.update',
      'secrets.reveal',
      'security.policy',
      // p17-panel-settings: the master-stored settings and key rotations; another user's account recovery.
      'settings.panel',
      'users.recover',
      'users.roles',
    ]);
  });

  it('matches routes by override first, then by action; the chat confirmation is dynamic', () => {
    expect(eventForRoute('POST', '/auth/password', 'session.self')).toBe('account.password');
    expect(eventForRoute('GET', '/auth/session', 'session.self')).toBeUndefined();
    expect(eventForRoute('PUT', '/projects/:id/execution', 'projects.execution.write')).toBe(
      'machines.sandbox',
    );
    expect(eventForRoute('PUT', '/projects/:id/off-peak', 'projects.execution.write')).toBe(
      'projects.policy',
    );
    expect(eventForRoute('POST', '/vault/credentials', 'vault.write')).toBe('credentials.write');
    expect(eventForRoute('PUT', '/security/policy', 'security.write')).toBe('security.policy');
    expect(eventForRoute('POST', '/jobs', 'jobs.create')).toBe('deploy.production');
    expect(eventForRoute('POST', '/chat/drafts/:id/confirm', 'chat.use')).toBe('dynamic');
    expect(eventForRoute('GET', '/jobs', 'jobs.read')).toBeUndefined();
    expect(eventForRoute('HEAD', '/audit/events', 'audit.read')).toBe('data.access');
  });

  it('gives every chat card the event of the action it performs', () => {
    expect(eventOfDraft('approval_decision', {})).toBe('approvals.decide');
    expect(eventOfDraft('job', {})).toBe('chat.cards');
    expect(eventOfDraft('job_message', {})).toBe('chat.cards');
    expect(eventOfDraft('job_action', { action: 'run_now' })).toBe('jobs.control');
    expect(eventOfDraft('job_action', { action: 'cancel' })).toBe('chat.cards');
    expect(eventOfDraft('tool_install', { elevated: true })).toBe('machines.admin');
    expect(eventOfDraft('ops_action', {})).toBe('deploy.production');
    expect(eventOfDraft('workflow', { privileged: ['workflows.define.code'] })).toBe('workflows.privileged');
    expect(eventOfDraft('workflow', { privileged: [] })).toBe('chat.cards');
    expect(eventOfDraft('settings_change', { target: 'security_policy' })).toBe('security.policy');
    expect(eventOfDraft('settings_change', { target: 'project_execution' })).toBe('machines.sandbox');
    expect(settingsTargetEvent('project_approval_rules')).toBe('projects.policy');
    expect(settingsTargetEvent('worker_runtime_policy')).toBe('machines.config');
  });
});

/** The seed of migration 0118; no longer the default of a fresh install. */
const SERBEST: SecurityPolicyDocument = { preset: 'serbest' };

describe('presets and documents', () => {
  it('a fresh install defaults to Dengeli (migration 0221); the missing-row fallback is never Serbest', () => {
    expect(DEFAULT_DOCUMENT).toEqual({ preset: 'dengeli' });
    expect(effectivePolicy(DEFAULT_DOCUMENT).autonomy.autoMode).toBe(false);
  });

  it('Serbest asks only for the safe core and gives full autonomy', () => {
    const p = effectivePolicy(SERBEST);
    expect(p.preset).toBe('serbest');
    expect(p.customized).toBe(false);
    expect(STEP_UP_EVENT_IDS.filter((e) => p.events[e]).sort()).toEqual([...CORE_EVENTS].sort());
    expect(p.stepUp).toEqual({ windowMinutes: 720, rememberDevice: true, alwaysFreshMinutes: null });
    expect(p.autonomy).toMatchObject({
      newProjectsHostExecution: true,
      newProjectsAutoApprove: true,
      jobApproval: 'allow-all',
      chatDirect: true,
    });
    expect(AUTONOMY_ACTIONS.every((a) => p.autonomy.autoApprove[a])).toBe(true);
    expect(AUTONOMY_ACTIONS).not.toContain('machine.admin');
  });

  it('Sıkı is the behaviour before ADR-0056; Dengeli lies between', () => {
    const strict = PRESETS.siki;
    expect(STEP_UP_EVENT_IDS.every((e) => strict.events[e])).toBe(true);
    expect(strict.stepUp).toEqual({ windowMinutes: null, rememberDevice: null, alwaysFreshMinutes: 10 });
    expect(strict.autonomy).toMatchObject({ jobApproval: 'ask-sensitive', chatDirect: false });
    expect(AUTONOMY_ACTIONS.some((a) => strict.autonomy.autoApprove[a])).toBe(false);
    const balanced = PRESETS.dengeli;
    for (const e of CORE_EVENTS) expect(balanced.events[e]).toBe(true);
    expect(balanced.events['deploy.production']).toBe(true);
    expect(balanced.events['chat.cards']).toBe(false);
    expect(balanced.autonomy.autoApprove.deploy).toBe(false);
    expect(balanced.autonomy.autoApprove['git.force_push']).toBe(false);
    expect(balanced.autonomy.autoApprove['git.merge']).toBe(true);
  });

  it('p19-chat-machine-admin: "Makinede söylediğimi yap" is on in Serbest and Dengeli, off in Sıkı; an override', () => {
    expect(effectivePolicy(SERBEST).autonomy.chatMachineAdmin).toBe(true);
    expect(PRESETS.serbest.autonomy.chatMachineAdmin).toBe(true);
    expect(PRESETS.dengeli.autonomy.chatMachineAdmin).toBe(true);
    expect(PRESETS.siki.autonomy.chatMachineAdmin).toBe(false);
    // An owner switches it off (or on in Sıkı): the smallest document stores just that, and it is a change path.
    const off = applyPatch(SERBEST, { autonomy: { chatMachineAdmin: false } });
    expect(off).toEqual({ preset: 'serbest', autonomy: { chatMachineAdmin: false } });
    const p = effectivePolicy(off);
    expect(p.customized).toBe(true);
    expect(p.autonomy.chatMachineAdmin).toBe(false);
    expect(changedPaths(effectivePolicy(SERBEST), p)).toEqual(['autonomy.chatMachineAdmin']);
    expect(
      effectivePolicy({ preset: 'siki', autonomy: { chatMachineAdmin: true } }).autonomy.chatMachineAdmin,
    ).toBe(true);
    // Back to the preset's value drops the override; a preset change resets it.
    expect(applyPatch(off, { autonomy: { chatMachineAdmin: true } })).toEqual({ preset: 'serbest' });
    expect(applyPatch(off, { preset: 'dengeli' })).toEqual({ preset: 'dengeli' });
    expect(
      SecurityPolicyDocument.safeParse({ preset: 'serbest', autonomy: { chatMachineAdmin: 'yes' } }).success,
    ).toBe(false);
  });

  it('stores the smallest document: a preset plus overrides; a preset change resets the overrides', () => {
    const doc = applyPatch(SERBEST, {
      stepUp: { windowMinutes: 60 },
      events: { 'deploy.production': true },
      autonomy: { autoApprove: { 'git.force_push': false } },
    });
    expect(doc).toEqual({
      preset: 'serbest',
      stepUp: { windowMinutes: 60 },
      events: { 'deploy.production': true },
      autonomy: { autoApprove: { 'git.force_push': false } },
    });
    const p = effectivePolicy(doc);
    expect(p.customized).toBe(true);
    expect(changedPaths(effectivePolicy(SERBEST), p)).toEqual([
      'stepUp.windowMinutes',
      'events.deploy.production',
      'autonomy.autoApprove.git.force_push',
    ]);
    expect(applyPatch(doc, { preset: 'siki' })).toEqual({ preset: 'siki' });
    expect(applyPatch(doc, { preset: 'dengeli', resetOverrides: false }).stepUp).toEqual({
      windowMinutes: 60,
    });
    // Setting a value back to the preset's drops the override.
    expect(applyPatch(doc, { stepUp: { windowMinutes: 720 } }).stepUp).toBeUndefined();
    expect(documentFor(PRESETS.dengeli)).toEqual({ preset: 'dengeli' });
  });

  it('an event a later release adds takes its preset default; the schema refuses unknown keys and ranges', () => {
    const p = effectivePolicy({ preset: 'siki', events: {} });
    expect(p.events['account.mfa']).toBe(true);
    expect(SecurityPolicyDocument.safeParse({ preset: 'serbest', events: { 'nope.x': true } }).success).toBe(
      false,
    );
    expect(
      SecurityPolicyDocument.safeParse({ preset: 'serbest', stepUp: { windowMinutes: 4 } }).success,
    ).toBe(false);
    expect(
      SecurityPolicyDocument.safeParse({ preset: 'serbest', stepUp: { windowMinutes: 43_201 } }).success,
    ).toBe(false);
    expect(SecurityPolicyDocument.safeParse({ preset: 'open' }).success).toBe(false);
  });
});

describe('step-up window from the policy', () => {
  const standard = { remember: false, trustedDeviceId: null };
  const remembered = { remember: true, trustedDeviceId: null };

  it('Serbest: 12 h, the whole session on a remembered device, no extra always-fresh cap', () => {
    const s = PRESETS.serbest.stepUp;
    expect(policyStepUp(standard, DEFAULT_STEP_UP_POLICY, s)).toEqual({
      scope: 'window',
      maxAgeMs: 12 * HOUR,
      alwaysFreshMaxAgeMs: 12 * HOUR,
    });
    expect(policyStepUp(remembered, DEFAULT_STEP_UP_POLICY, s).scope).toBe('session');
    expect(policyStepUp(remembered, DEFAULT_STEP_UP_POLICY, { ...s, rememberDevice: false }).maxAgeMs).toBe(
      12 * HOUR,
    );
  });

  it('Sıkı: the server window and the 10-minute always-fresh cap (as before)', () => {
    const rule = policyStepUp(standard, DEFAULT_STEP_UP_POLICY, PRESETS.siki.stepUp);
    expect(rule).toEqual({
      scope: 'window',
      maxAgeMs: DEFAULT_STEP_UP_POLICY.windowMs,
      alwaysFreshMaxAgeMs: STEP_UP_ALWAYS_FRESH_MS,
    });
    expect(policyStepUp(remembered, DEFAULT_STEP_UP_POLICY, PRESETS.siki.stepUp)).toEqual({
      scope: 'session',
      maxAgeMs: Number.POSITIVE_INFINITY,
      alwaysFreshMaxAgeMs: STEP_UP_ALWAYS_FRESH_MS,
    });
  });

  it('a custom window from 5 minutes to 30 days, and an always-fresh cap below it', () => {
    const rule = policyStepUp(standard, DEFAULT_STEP_UP_POLICY, {
      windowMinutes: 30 * 24 * 60,
      rememberDevice: false,
      alwaysFreshMinutes: 15,
    });
    expect(rule.maxAgeMs).toBe(30 * 24 * HOUR);
    expect(rule.alwaysFreshMaxAgeMs).toBe(15 * 60_000);
  });
});

describe('autonomy enforcement', () => {
  it('lets a "never ask" job pass master approvals the policy auto-approves — never other modes or machine admin', () => {
    const all = autoApprovedActions(effectivePolicy(SERBEST));
    const deploy = resolveRule('deploy', { job: 'allow-all', autonomy: all });
    expect(deploy.outcome).toBe('allow');
    expect(deploy.sources).toContain('security_policy');
    expect(resolveRule('git.force_push', { job: 'allow-all', autonomy: all }).outcome).toBe('allow');
    expect(resolveRule('deploy', { job: 'ask-sensitive', autonomy: all }).outcome).toBe('require_approval');
    expect(resolveRule('deploy', { job: 'ask-all', autonomy: all }).outcome).toBe('require_approval');
    expect(
      resolveRule('machine.admin', { job: 'allow-all', autonomy: new Set(['machine.admin']) }).outcome,
    ).toBe('require_approval');
    const balanced = autoApprovedActions(effectivePolicy({ preset: 'dengeli' }));
    expect(resolveRule('deploy', { job: 'allow-all', autonomy: balanced }).outcome).toBe('require_approval');
    expect(resolveRule('git.merge', { job: 'allow-all', autonomy: balanced }).outcome).toBe('allow');
    const strict = autoApprovedActions(effectivePolicy({ preset: 'siki' }));
    expect(resolveRule('git.merge', { job: 'allow-all', autonomy: strict }).outcome).toBe('require_approval');
  });

  it('defaults a trusted job of an auto-approve project to "never ask" when the policy says so', () => {
    const facts: ProjectFacts = {
      workspace: true,
      registeredRepositoryUrl: null,
      hostExecution: true,
      autoApproveExecution: true,
      jobApproval: 'allow-all',
      sandbox: [],
      limits: {},
    };
    expect(applyJobDefaults({ prompt: 'x' }, facts).spec.approvalPolicy).toBe('allow-all');
    expect(
      applyJobDefaults({ prompt: 'x' }, { ...facts, autoApproveExecution: false }).spec.approvalPolicy,
    ).toBe('ask-sensitive');
    expect(
      applyJobDefaults({ prompt: 'x' }, { ...facts, jobApproval: 'ask-sensitive' }).spec.approvalPolicy,
    ).toBe('ask-sensitive');
    expect(applyJobDefaults({ prompt: 'x', sourceTrust: 'untrusted' }, facts).spec.approvalPolicy).toBe(
      'ask-sensitive',
    );
    expect(applyJobDefaults({ prompt: 'x', approvalPolicy: 'ask-all' }, facts).spec.approvalPolicy).toBe(
      'ask-all',
    );
  });
});
