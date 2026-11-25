import { describe, expect, it } from 'vitest';
import {
  decide,
  DeployPolicy,
  DeployTargets,
  OpsActionRequest,
  PagesAddDomainParams,
  PagesCreateProjectParams,
  PagesNewProjectName,
  REQUESTABLE_KINDS,
} from '../../src/ops/index.js';

/** p6-pages-create: parameter validation (Cloudflare naming rules) and the policy of the two new kinds. */

const DEFAULT = DeployPolicy.parse({});
const none = { refusal: null };

describe('pages.create_project parameters', () => {
  it('accepts Cloudflare project names: lowercase letters, digits, hyphens; 1–58; letter/digit at both ends', () => {
    for (const ok of ['a', '0', 'my-site', 'site-2026', 'a'.repeat(58), 'a-b-c']) {
      expect(PagesNewProjectName.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of [
      '',
      'My-site',
      'my_site',
      'my.site',
      '-site',
      'site-',
      'a'.repeat(59),
      'sité',
      'a b',
    ]) {
      expect(PagesNewProjectName.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('defaults: production branch main, refuse an existing name, no target change', () => {
    expect(PagesCreateProjectParams.parse({ name: 'site' })).toEqual({
      name: 'site',
      productionBranch: 'main',
      ifExists: 'refuse',
      useAsTarget: false,
    });
  });

  it('accepts adopt with or without useAsTarget (p10-site-upload: a further Pages project); refuses unknown fields (no source repository) and bad branches', () => {
    // The right to adopt (deploy-target change) is checked by the service / route, not by the schema.
    expect(PagesCreateProjectParams.safeParse({ name: 'site', ifExists: 'adopt' }).success).toBe(true);
    expect(
      PagesCreateProjectParams.safeParse({ name: 'site', ifExists: 'adopt', useAsTarget: true }).success,
    ).toBe(true);
    expect(PagesCreateProjectParams.safeParse({ name: 'site', source: { type: 'github' } }).success).toBe(
      false,
    );
    expect(PagesCreateProjectParams.safeParse({ name: 'site', productionBranch: 'a b' }).success).toBe(false);
  });
});

describe('pages.add_domain parameters', () => {
  it('normalises the host name; dns auto by default; refuses non-host names', () => {
    expect(PagesAddDomainParams.parse({ domain: 'WWW.Example.com.' })).toEqual({
      domain: 'www.example.com',
      dns: 'auto',
    });
    for (const bad of ['example', 'http://x.example.com', '*.example.com', 'a..b.com']) {
      expect(PagesAddDomainParams.safeParse({ domain: bad }).success, bad).toBe(false);
    }
    expect(PagesAddDomainParams.safeParse({ domain: 'x.example.com', dns: 'force' }).success).toBe(false);
  });
});

describe('pages project policy', () => {
  it('both kinds are requestable', () => {
    expect(REQUESTABLE_KINDS).toContain('pages.create_project');
    expect(REQUESTABLE_KINDS).toContain('pages.add_domain');
    expect(
      OpsActionRequest.safeParse({
        project: 'p',
        kind: 'pages.create_project',
        params: {},
        idempotencyKey: 'key-12345',
      }).success,
    ).toBe(true);
  });

  it('defaults to approval; a project may choose auto or approval with step-up', () => {
    expect(DEFAULT.pagesProject).toBe('approval');
    expect(DeployTargets.parse({}).policy.pagesProject).toBe('approval');
    expect(decide('pages.create_project', null, DEFAULT, none).decision).toBe('approval');
    expect(decide('pages.add_domain', null, DEFAULT, none).decision).toBe('approval');
    const auto = DeployPolicy.parse({ pagesProject: 'auto' });
    expect(decide('pages.create_project', null, auto, none).decision).toBe('auto');
    const strict = DeployPolicy.parse({ pagesProject: 'approval_step_up' });
    expect(decide('pages.add_domain', null, strict, none).decision).toBe('approval_step_up');
  });

  it('a domain with a DNS change needs the stricter of the Pages and DNS levels, never auto', () => {
    const auto = DeployPolicy.parse({ pagesProject: 'auto' });
    expect(decide('pages.add_domain', null, auto, none, { withDns: true }).decision).toBe('approval');
    const dnsStrict = DeployPolicy.parse({ pagesProject: 'auto', dnsChange: 'approval_step_up' });
    expect(decide('pages.add_domain', null, dnsStrict, none, { withDns: true }).decision).toBe(
      'approval_step_up',
    );
    const pagesStrict = DeployPolicy.parse({ pagesProject: 'approval_step_up' });
    expect(decide('pages.add_domain', null, pagesStrict, none, { withDns: true }).decision).toBe(
      'approval_step_up',
    );
  });

  it('a protected target is refused whatever the policy', () => {
    const auto = DeployPolicy.parse({ pagesProject: 'auto' });
    expect(decide('pages.add_domain', null, auto, { refusal: 'console host' })).toEqual({
      decision: 'refused',
      reason: 'console host',
    });
  });
});
