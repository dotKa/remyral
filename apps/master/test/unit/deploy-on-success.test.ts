import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import {
  DeployOnSuccessRequest,
  DeployPolicy,
  DeployTargets,
  onSuccessLevel,
  OpsError,
  preApprovalCovers,
} from '../../src/ops/index.js';
import { creatorRefusal, liveUrl, specForDeploy, targetSnapshot } from '../../src/ops/on-success.js';

/** p6-deploy-on-success (ADR-0030): the pure pieces — levels, coverage, creator permissions, spec rewrite, snapshot. */

const DEFAULT = DeployPolicy.parse({});
const subject = (
  role: Subject['role'],
  memberships: Record<string, 'operator' | 'viewer'> = {},
): Subject => ({
  userId: 'u1',
  role,
  memberships: new Map(Object.entries(memberships)),
});
const NOW = new Date('2026-10-16T12:00:00Z');
const fresh = { mfaAt: new Date(NOW.getTime() - 60_000), now: NOW };
const stale = { mfaAt: new Date(NOW.getTime() - 60 * 60_000), now: NOW };

describe('deploy on success: levels and coverage', () => {
  it('preview follows previewDeploy; production is refused unless the project switch is on', () => {
    expect(DEFAULT.autoDeployProductionOnSuccess).toBe(false);
    expect(onSuccessLevel('preview', DEFAULT)).toEqual({ level: 'auto' });
    expect(onSuccessLevel('preview', { ...DEFAULT, previewDeploy: 'approval' })).toEqual({
      level: 'approval',
    });
    expect('refused' in onSuccessLevel('production', DEFAULT)).toBe(true);
    expect(onSuccessLevel('production', { ...DEFAULT, autoDeployProductionOnSuccess: true })).toEqual({
      level: 'approval_step_up',
    });
    expect(
      onSuccessLevel('production', {
        ...DEFAULT,
        autoDeployProductionOnSuccess: true,
        productionDeploy: 'approval',
      }),
    ).toEqual({ level: 'approval' });
  });

  it('a pre-approval covers decisions up to its level, never a refusal, step-up only with a step-up time', () => {
    const at = NOW;
    const step = { by: 'u1', at, stepUpAt: at, covers: 'approval_step_up' as const };
    expect(preApprovalCovers('approval_step_up', step)).toBe(true);
    expect(preApprovalCovers('approval', step)).toBe(true);
    expect(preApprovalCovers('refused', step)).toBe(false);
    expect(preApprovalCovers('auto', step)).toBe(false);
    expect(preApprovalCovers('approval_step_up', { ...step, stepUpAt: null })).toBe(false);
    const plain = { by: 'u1', at, stepUpAt: null, covers: 'approval' as const };
    expect(preApprovalCovers('approval', plain)).toBe(true);
    expect(preApprovalCovers('approval_step_up', plain)).toBe(false);
    const auto = { by: 'u1', at, stepUpAt: null, covers: 'auto' as const };
    expect(preApprovalCovers('approval', auto)).toBe(false);
  });

  it('the targets policy keeps old stored configs valid (switch defaults to off)', () => {
    const t = DeployTargets.parse({ policy: { previewDeploy: 'auto' } });
    expect(t.policy.autoDeployProductionOnSuccess).toBe(false);
  });
});

describe('deploy on success: creator permissions at creation', () => {
  it('preview auto needs deploy.request (operator); viewers are refused', () => {
    expect(
      creatorRefusal(subject('operator', { shop: 'operator' }), 'shop', 'preview', 'auto', stale),
    ).toBeNull();
    expect(
      creatorRefusal(subject('viewer', { shop: 'viewer' }), 'shop', 'preview', 'auto', stale)?.code,
    ).toBe('deploy_forbidden');
    expect(creatorRefusal(subject('operator', {}), 'shop', 'preview', 'auto', stale)?.code).toBe(
      'deploy_forbidden',
    );
  });

  it('an approval level needs deploy.approve (project admin); a step-up level an always-fresh code', () => {
    expect(
      creatorRefusal(subject('operator', { shop: 'operator' }), 'shop', 'preview', 'approval', fresh)?.code,
    ).toBe('deploy_approval_forbidden');
    expect(creatorRefusal(subject('admin'), 'shop', 'production', 'approval', stale)).toBeNull();
    expect(creatorRefusal(subject('admin'), 'shop', 'production', 'approval_step_up', stale)?.code).toBe(
      'step_up_required',
    );
    expect(creatorRefusal(subject('owner'), 'shop', 'production', 'approval_step_up', fresh)).toBeNull();
    // A session that accepts a longer step-up window is capped at the always-fresh 10 minutes.
    expect(
      creatorRefusal(subject('owner'), 'shop', 'production', 'approval_step_up', {
        ...stale,
        maxAgeMs: 24 * 3600_000,
      })?.code,
    ).toBe('step_up_required');
  });
});

describe('deploy on success: request and spec', () => {
  const spec = { runtime: 'codex', prompt: 'Build a page', sourceTrust: 'trusted' };

  it('parses only target, env and a safe directory', () => {
    expect(DeployOnSuccessRequest.parse({ target: 'pages' })).toEqual({ target: 'pages', env: 'preview' });
    expect(DeployOnSuccessRequest.safeParse({ target: 'pages', directory: '../x' }).success).toBe(false);
    expect(DeployOnSuccessRequest.safeParse({ target: 'pages', project: 'other' }).success).toBe(false);
    expect(DeployOnSuccessRequest.safeParse({ target: 'cloudflare' }).success).toBe(false);
  });

  it('Pages adds a site bundle (default site/), keeps the spec’s own directory, refuses a different one', () => {
    expect(specForDeploy(spec, { target: 'pages' })).toEqual({
      spec: { ...spec, siteBundle: { directory: 'site' } },
      directory: 'site',
    });
    expect(specForDeploy(spec, { target: 'pages', directory: 'dist' }).spec.siteBundle).toEqual({
      directory: 'dist',
    });
    const own = { ...spec, siteBundle: { directory: 'public' } };
    expect(specForDeploy(own, { target: 'pages' }).directory).toBe('public');
    expect(() => specForDeploy(own, { target: 'pages', directory: 'dist' })).toThrow(OpsError);
    expect(specForDeploy(spec, { target: 'coolify' })).toEqual({ spec, directory: null });
    expect(() => specForDeploy(spec, { target: 'coolify', directory: 'x' })).toThrow(OpsError);
  });

  it('untrusted sources and special job kinds never deploy', () => {
    const untrusted = { ...spec, sourceTrust: 'untrusted' };
    expect(() => specForDeploy(untrusted, { target: 'pages' })).toThrow(/trusted source/);
    const { sourceTrust: _s, ...absent } = spec;
    expect(() => specForDeploy(absent, { target: 'pages' })).toThrow(/trusted source/);
    expect(() => specForDeploy({ ...spec, kind: 'machine-admin' }, { target: 'coolify' })).toThrow(OpsError);
  });
});

describe('deploy on success: target snapshot and live URL', () => {
  const t = DeployTargets.parse({
    coolify: { preview: { uuids: ['bbbbbb2', 'aaaaaa1'], tags: [] }, production: null },
    pages: { projectName: 'shop-site' },
  });

  it('snapshots the configured target and refuses a missing one', () => {
    expect(targetSnapshot(t, 'pages', 'preview')).toEqual({ snapshot: { pagesProject: 'shop-site' } });
    expect(targetSnapshot(t, 'coolify', 'preview')).toEqual({
      snapshot: { coolify: { uuids: ['aaaaaa1', 'bbbbbb2'], tags: [] } },
    });
    const missing = targetSnapshot(t, 'coolify', 'production');
    expect('error' in missing && missing.error.code).toBe('no_coolify_target');
    const noPages = targetSnapshot(DeployTargets.parse({}), 'pages', 'preview');
    expect('error' in noPages && noPages.error.code).toBe('no_pages_target');
  });

  it('the live URL is the Pages https URL, else the first http(s) fqdn of a Coolify resource', () => {
    expect(liveUrl({ result: { url: 'https://abc.shop-site.pages.dev' }, target: {} })).toBe(
      'https://abc.shop-site.pages.dev',
    );
    expect(liveUrl({ result: { url: 'javascript:alert(1)' }, target: {} })).toBeNull();
    expect(
      liveUrl({
        result: {},
        target: { resources: [{ fqdn: 'https://preview.shop.example,https://b.example' }] },
      }),
    ).toBe('https://preview.shop.example');
    expect(liveUrl({ result: null, target: { resources: [{ fqdn: '' }] } })).toBeNull();
  });
});
