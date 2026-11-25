import { describe, expect, it } from 'vitest';
import {
  ALWAYS_FRESH_ROUTES,
  DEFAULT_STEP_UP_POLICY,
  maxAgeFor,
  parseLongLivedStepUp,
  sessionStepUp,
  type StepUpPolicy,
  stepUpFreshAt,
  stepUpPolicyFrom,
  stepUpStatus,
} from '../../src/auth/step-up.js';
import { ConfigError, loadConfig } from '../../src/config.js';

/** p5-stepup-window: step-up resolution per session type, the always-fresh class and configuration. */
const MIN = 60_000;
const base = {
  DATABASE_URL: 'postgres://u:pw@127.0.0.1:5432/db',
  REDIS_URL: 'redis://:pw@127.0.0.1:6379/0',
  TOTP_KEY_FILE: '/abs/totp.key',
};
const now = new Date('2026-10-14T12:00:00.000Z');
const expiresAt = new Date('2026-11-13T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const standard = { remember: false, trustedDeviceId: null };
const remembered = { remember: true, trustedDeviceId: null };
const trusted = { remember: false, trustedDeviceId: '00000000-0000-4000-8000-000000000001' };

describe('sessionStepUp', () => {
  it('standard session: the 10-minute window for both classes', () => {
    const rule = sessionStepUp(standard);
    expect(rule).toEqual({ scope: 'window', maxAgeMs: 10 * MIN, alwaysFreshMaxAgeMs: 10 * MIN });
  });

  it('remember-me or trusted-device session: the whole session, always-fresh stays 10 minutes', () => {
    for (const s of [remembered, trusted, { ...remembered, trustedDeviceId: trusted.trustedDeviceId }]) {
      const rule = sessionStepUp(s);
      expect(rule.scope).toBe('session');
      expect(rule.maxAgeMs).toBe(Number.POSITIVE_INFINITY);
      expect(maxAgeFor(rule, 'always-fresh')).toBe(10 * MIN);
    }
  });

  it('AUTH_STEP_UP_TRUSTED=<minutes> and off', () => {
    const hour: StepUpPolicy = { windowMs: 10 * MIN, longLived: { kind: 'window', ms: 60 * MIN } };
    expect(sessionStepUp(remembered, hour)).toEqual({
      scope: 'window',
      maxAgeMs: 60 * MIN,
      alwaysFreshMaxAgeMs: 10 * MIN,
    });
    expect(sessionStepUp(standard, hour).maxAgeMs).toBe(10 * MIN);
    const off: StepUpPolicy = { windowMs: 15 * MIN, longLived: { kind: 'off' } };
    expect(sessionStepUp(trusted, off)).toEqual({
      scope: 'window',
      maxAgeMs: 15 * MIN,
      alwaysFreshMaxAgeMs: 10 * MIN,
    });
  });

  it('always-fresh is min(standard window, 10 min)', () => {
    expect(
      sessionStepUp(remembered, { windowMs: 5 * MIN, longLived: { kind: 'session' } }).alwaysFreshMaxAgeMs,
    ).toBe(5 * MIN);
    expect(
      sessionStepUp(remembered, { windowMs: 60 * MIN, longLived: { kind: 'session' } }).alwaysFreshMaxAgeMs,
    ).toBe(10 * MIN);
  });
});

describe('stepUpFreshAt', () => {
  it('needs a TOTP, not from the future, within the age', () => {
    expect(stepUpFreshAt(null, now, Number.POSITIVE_INFINITY)).toBe(false);
    expect(stepUpFreshAt(undefined, now, 10 * MIN)).toBe(false);
    expect(stepUpFreshAt(ago(10 * MIN), now, 10 * MIN)).toBe(true);
    expect(stepUpFreshAt(ago(10 * MIN + 1), now, 10 * MIN)).toBe(false);
    expect(stepUpFreshAt(new Date(now.getTime() + 1), now, 10 * MIN)).toBe(false);
    expect(stepUpFreshAt(ago(30 * 24 * 60 * MIN), now, Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe('stepUpStatus', () => {
  it('window: valid until mfa_at + window; nothing once stale', () => {
    const rule = sessionStepUp(standard);
    expect(stepUpStatus({ ...standard, mfaAt: ago(2 * MIN), expiresAt }, now, rule)).toEqual({
      scope: 'window',
      fresh: true,
      validUntil: new Date(now.getTime() + 8 * MIN),
      alwaysFreshValidUntil: new Date(now.getTime() + 8 * MIN),
    });
    expect(stepUpStatus({ ...standard, mfaAt: ago(11 * MIN), expiresAt }, now, rule)).toEqual({
      scope: 'window',
      fresh: false,
      validUntil: null,
      alwaysFreshValidUntil: null,
    });
  });

  it('session: valid until the session ends; always-fresh only for 10 minutes', () => {
    const rule = sessionStepUp(remembered);
    const st = stepUpStatus({ ...remembered, mfaAt: ago(5 * 60 * MIN), expiresAt }, now, rule);
    expect(st).toEqual({ scope: 'session', fresh: true, validUntil: expiresAt, alwaysFreshValidUntil: null });
  });

  it('a trusted-device login without a code has not stepped up', () => {
    const st = stepUpStatus({ ...trusted, mfaAt: null, expiresAt }, now, sessionStepUp(trusted));
    expect(st).toEqual({ scope: 'session', fresh: false, validUntil: null, alwaysFreshValidUntil: null });
  });

  it('a window never reports beyond the session end', () => {
    const rule = sessionStepUp(standard);
    const end = new Date(now.getTime() + MIN);
    expect(stepUpStatus({ ...standard, mfaAt: now, expiresAt: end }, now, rule).validUntil).toEqual(end);
  });
});

describe('configuration', () => {
  it('parses AUTH_STEP_UP_TRUSTED', () => {
    expect(parseLongLivedStepUp(undefined)).toEqual({ kind: 'session' });
    expect(parseLongLivedStepUp('session')).toEqual({ kind: 'session' });
    expect(parseLongLivedStepUp(' OFF ')).toEqual({ kind: 'off' });
    expect(parseLongLivedStepUp('60')).toEqual({ kind: 'window', ms: 60 * MIN });
    for (const bad of ['0', '1441', '-5', '1.5', 'forever', ''])
      expect(parseLongLivedStepUp(bad), bad).toBeNull();
  });

  it('defaults: 10 minutes, long-lived sessions keep the step-up for the session', () => {
    const cfg = loadConfig(base, '/cwd');
    expect(cfg.stepUp).toEqual({ windowMinutes: 10, longLived: { kind: 'session' } });
    expect(stepUpPolicyFrom(cfg.stepUp)).toEqual(DEFAULT_STEP_UP_POLICY);
    // Empty values (compose `${VAR:-}`) mean the default.
    const empty = loadConfig({ ...base, AUTH_STEP_UP_MINUTES: '', AUTH_STEP_UP_TRUSTED: '' }, '/cwd');
    expect(stepUpPolicyFrom(empty.stepUp)).toEqual(DEFAULT_STEP_UP_POLICY);
  });

  it('reads AUTH_STEP_UP_MINUTES and AUTH_STEP_UP_TRUSTED', () => {
    const cfg = loadConfig({ ...base, AUTH_STEP_UP_MINUTES: '5', AUTH_STEP_UP_TRUSTED: '120' }, '/cwd');
    expect(stepUpPolicyFrom(cfg.stepUp)).toEqual({
      windowMs: 5 * MIN,
      longLived: { kind: 'window', ms: 120 * MIN },
    });
    expect(loadConfig({ ...base, AUTH_STEP_UP_TRUSTED: 'off' }, '/cwd').stepUp.longLived).toEqual({
      kind: 'off',
    });
  });

  it('rejects out-of-range values, naming the variable', () => {
    for (const env of [
      { AUTH_STEP_UP_MINUTES: '0' },
      { AUTH_STEP_UP_MINUTES: '61' },
      { AUTH_STEP_UP_MINUTES: '2.5' },
      { AUTH_STEP_UP_TRUSTED: 'always' },
      { AUTH_STEP_UP_TRUSTED: '0' },
    ]) {
      expect(() => loadConfig({ ...base, ...env }, '/cwd'), JSON.stringify(env)).toThrow(
        new RegExp(Object.keys(env)[0] ?? ''),
      );
      expect(() => loadConfig({ ...base, ...env }, '/cwd')).toThrow(ConfigError);
    }
  });
});

describe('always-fresh list', () => {
  it('names the account-security routes', () => {
    expect([...ALWAYS_FRESH_ROUTES].sort()).toEqual(
      [
        'POST /auth/password',
        'POST /auth/devices/revoke-all',
        'POST /users',
        'PUT /users/:id/role',
        'POST /users/:id/disable',
        'POST /users/:id/enable',
        'POST /vault/credentials',
        'PUT /vault/credentials/:id/value',
        'POST /vault/credentials/:id/unshare',
        'DELETE /vault/credentials/:id',
        'PATCH /vault/credentials/:id',
        // p5-sandbox-ops (ADR-0019).
        'POST /workers/:id/sandbox/prepare',
        'PUT /workers/:id/sandbox/unconfined',
        'PUT /projects/:id/execution',
        'POST /vault/workers/:id/rotate-key',
        'POST /workers/:id/runtimes/:runtime/login',
        'POST /workers/:id/ops/:opId/input',
        'POST /workers/:id/runtimes/:runtime/logout',
        // p13-runtime-accounts (ADR-0049).
        'DELETE /workers/:id/runtime-accounts/:runtime/:account',
        // p5-github-connect (ADR-0022).
        'POST /integrations/github/manifest',
        'POST /integrations/github/manifest/complete',
        'POST /integrations/github/key',
        'DELETE /integrations/github',
        'POST /integrations/github/webhook',
        // p17-chat-github: which App installations are used and how a connection is named.
        'PUT /integrations/github/installations/:installationId',
        'PATCH /integrations/github/connections/:connectionId',
        // p15-github-create-repo: a GitHub account Remyral may act for (user authorization or fine-grained token).
        'POST /integrations/github/accounts/authorize',
        'POST /integrations/github/accounts/authorize/complete',
        'PUT /integrations/github/accounts/token',
        'DELETE /integrations/github/accounts/:id',
        'POST /previews/:id/reveal',
        // p14-skill-import (ADR-0054): publishing an import signs it with the panel skills key.
        'POST /skills/imports/:id/publish',
        // p14-mcp-core (ADR-0054 decision 2): MCP server publish (panel-signed) and its token bindings.
        'POST /mcp/servers',
        'PUT /mcp/servers/:id/secrets',
        // p14-workflow-engine 14.3 (K1).
        'PUT /projects/:id/workflow-egress',
        // p18-multi-project: credential slots of an attached workflow.
        'PUT /workflow-attachments/:id/credentials/:slot',
        'DELETE /workflow-attachments/:id/credentials/:slot',
        // p14-repo-egress.
        'PUT /projects/:id/repo-egress',
        // p14-mcp-stdio (ADR-0054 decision 2): installing a local MCP package places third-party code on machines.
        'POST /mcp/servers/:id/versions/:version/install',
        'POST /mcp/install-actions/:actionId/continue',
        'POST /mcp/install-actions/:actionId/retry',
        // p14-mcp-chat (ADR-0054 P5): confirming an install preview signs the spec and starts the install.
        'POST /mcp/previews/:id/publish',
        'POST /mcp/install-scripts',
        // p17-host-actions (ADR-0063 amendment 2026-10-26): the control plane's update / rollback on the host.
        'POST /host-actions/upgrade',
        'POST /host-actions/rollback',
        'POST /host-actions/requests/:id/cancel',
        'POST /backups/restore',
        // p17-panel-settings Parts 4 and 5.
        'POST /users/:id/recover',
        'POST /users/recovery-requests/:id/approve',
        'POST /panel-settings/keys/:item/:action',
        // p5-machine-admin (ADR-0021).
        'PUT /workers/:id/machine-admin',
        'POST /workers/:id/machine-admin/tasks',
        // p17-worker-managed (ADR-0021 / ADR-0017 amendments 2026-10-27).
        'PUT /workers/:id/config/runtime-paths',
        'POST /workers/:id/remove',
        'POST /workers/:id/machine-admin/helper',
        // p13-fleet-tools (ADR-0052).
        'POST /fleet/tools/admin-actions',
        'POST /fleet/tools/recipes',
        'PUT /fleet/tools/recipes/:id',
        'DELETE /fleet/tools/recipes/:id',
        // p6-deploy-integrations (ADR-0028).
        'PUT /integrations/ops/coolify',
        'DELETE /integrations/ops/coolify',
        'PUT /integrations/ops/cloudflare',
        'DELETE /integrations/ops/cloudflare',
        // p17-object-storage: the bucket and keys every output goes to.
        'PUT /integrations/storage',
        'PUT /integrations/bedrock',
        'DELETE /integrations/bedrock',
        // p16-git-providers (ADR-0061).
        'POST /integrations/git-hosts',
        'PATCH /integrations/git-hosts/:id',
        'DELETE /integrations/git-hosts/:id',
        'POST /integrations/git-hosts/:id/rotate',
        'POST /integrations/git-hosts/:id/repositories',
        // p13-multi-coolify (ADR-0050).
        'POST /integrations/coolify/connections',
        'PUT /integrations/coolify/connections/:id',
        'DELETE /integrations/coolify/connections/:id',
      ].sort(),
    );
  });
});

describe('stepUpStatus with an unbounded window (p15-autonomy hotfix)', () => {
  it('never returns an invalid Date: an Infinity window ends with the session', async () => {
    const { stepUpStatus } = await import('../../src/auth/step-up.js');
    const now = new Date('2026-10-21T12:00:00Z');
    const s = { mfaAt: new Date('2026-10-21T11:00:00Z'), expiresAt: new Date('2026-11-20T12:00:00Z') };
    const st = stepUpStatus(s as never, now, {
      scope: 'window',
      maxAgeMs: Number.POSITIVE_INFINITY,
      alwaysFreshMaxAgeMs: Number.POSITIVE_INFINITY,
    } as never);
    expect(st.validUntil?.toISOString()).toBe('2026-11-20T12:00:00.000Z');
    expect(st.alwaysFreshValidUntil?.toISOString()).toBe('2026-11-20T12:00:00.000Z');
  });
});
