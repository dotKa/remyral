import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  checkBaseUrl,
  coolifyDenyReason,
  createGuardedFetch,
  decide,
  DeployPolicy,
  DeployTargets,
  hostsOfFqdn,
  isNonPublicAddress,
  nameInZone,
  protectedRecordReason,
  publishDecision,
} from '../../src/ops/index.js';

/** p6-deploy-integrations (ADR-0028): the pure policy matrix, protected records, deny-list and SSRF rules. */

const DEFAULT = DeployPolicy.parse({});
const none = { refusal: null };

describe('ops policy matrix', () => {
  it('defaults: preview auto, production approval + step-up, DNS approval, delete approval + step-up', () => {
    expect(decide('coolify.deploy', 'preview', DEFAULT, none).decision).toBe('auto');
    expect(decide('coolify.restart', 'preview', DEFAULT, none).decision).toBe('auto');
    expect(decide('pages.deploy', 'preview', DEFAULT, none).decision).toBe('auto');
    expect(decide('coolify.deploy', 'production', DEFAULT, none).decision).toBe('approval_step_up');
    expect(decide('coolify.rollback', 'production', DEFAULT, none).decision).toBe('approval_step_up');
    expect(decide('pages.deploy', 'production', DEFAULT, none).decision).toBe('approval_step_up');
    expect(decide('pages.rollback', 'production', DEFAULT, none).decision).toBe('approval_step_up');
    expect(decide('dns.upsert', null, DEFAULT, none).decision).toBe('approval');
    expect(decide('dns.delete', null, DEFAULT, none).decision).toBe('approval_step_up');
    expect(decide('dns.upsert', null, DEFAULT, none, { rollbackOfDelete: true }).decision).toBe('approval');
  });

  it('project policy can tighten, never make production or DNS automatic', () => {
    const strict = DeployPolicy.parse({
      previewDeploy: 'approval_step_up',
      productionDeploy: 'approval_step_up',
      dnsChange: 'approval_step_up',
    });
    expect(decide('coolify.deploy', 'preview', strict, none).decision).toBe('approval_step_up');
    expect(decide('dns.upsert', null, strict, none).decision).toBe('approval_step_up');
    const loose = DeployPolicy.parse({ productionDeploy: 'approval' });
    expect(decide('coolify.deploy', 'production', loose, none).decision).toBe('approval');
    expect(DeployPolicy.safeParse({ productionDeploy: 'auto' }).success).toBe(false);
  });

  it('p10-publish-bundle: DNS "Run at once" covers only CNAMEs to the project’s own Pages projects', () => {
    const p = DeployPolicy.parse({ dnsChange: 'auto' });
    expect(decide('dns.upsert', null, p, none, { ownPagesCname: true }).decision).toBe('auto');
    // Any other record (type or content) keeps approval; deletes keep approval + step-up; restores approval.
    expect(decide('dns.upsert', null, p, none).decision).toBe('approval');
    expect(decide('dns.upsert', null, p, none, { ownPagesCname: false }).reason).toMatch(/Only CNAME/);
    expect(decide('dns.delete', null, p, none, { ownPagesCname: true }).decision).toBe('approval_step_up');
    expect(
      decide('dns.upsert', null, p, none, { ownPagesCname: true, rollbackOfDelete: true }).decision,
    ).toBe('approval');
    expect(decide('dns.upsert', null, p, { refusal: 'protected' }, { ownPagesCname: true }).decision).toBe(
      'refused',
    );
    // Attaching a domain with its CNAME: the stricter of pagesProject and dnsChange — auto only when both are.
    expect(decide('pages.add_domain', null, p, none, { withDns: true }).decision).toBe('approval');
    const all = DeployPolicy.parse({ dnsChange: 'auto', pagesProject: 'auto' });
    expect(decide('pages.add_domain', null, all, none, { withDns: true }).decision).toBe('auto');
    // The default stays approval for an own-pages CNAME too.
    expect(decide('dns.upsert', null, DEFAULT, none, { ownPagesCname: true }).decision).toBe('approval');
  });

  it('p10-publish-bundle: a bundle is decided by its strictest step, with step-up for production or DNS', () => {
    const create = { step: 'create' as const };
    const preview = { step: 'deploy' as const, env: 'preview' as const };
    const production = { step: 'deploy' as const, env: 'production' as const };
    const domainDns = { step: 'domain' as const, withDns: true };
    const domainManual = { step: 'domain' as const, withDns: false };
    // Defaults: create approval, preview auto, domain + CNAME approval → one approval with a code (DNS involved).
    const d = publishDecision([create, preview, domainDns], DEFAULT);
    expect(d.decision).toBe('approval_step_up');
    expect(d.steps.map((s) => s.decision)).toEqual(['approval', 'auto', 'approval']);
    expect(d.reason).toMatch(/One approval with a fresh authenticator code/);
    // No DNS write, preview: plain approval.
    expect(publishDecision([create, preview, domainManual], DEFAULT).decision).toBe('approval');
    // Production always needs at least approval, and then a code.
    const loose = DeployPolicy.parse({
      productionDeploy: 'approval',
      pagesProject: 'auto',
      dnsChange: 'auto',
    });
    expect(publishDecision([production], loose).decision).toBe('approval_step_up');
    // Every step at "run at once": auto.
    const allAuto = DeployPolicy.parse({ pagesProject: 'auto', dnsChange: 'auto' });
    expect(publishDecision([create, preview, domainDns], allAuto).decision).toBe('auto');
    // A refused step refuses the bundle.
    expect(
      publishDecision([preview, { step: 'domain', withDns: true, refusal: 'protected name' }], allAuto),
    ).toMatchObject({ decision: 'refused', reason: 'protected name' });
  });

  it('a refusal wins over every rule', () => {
    for (const kind of ['coolify.deploy', 'dns.upsert', 'dns.delete', 'pages.deploy'] as const) {
      expect(decide(kind, 'preview', DEFAULT, { refusal: 'protected' })).toEqual({
        decision: 'refused',
        reason: 'protected',
      });
    }
  });

  it('targets schema: strict, defaults, sane names', () => {
    const t = DeployTargets.parse({});
    expect(t).toMatchObject({
      coolify: null,
      pages: null,
      dns: { zones: [], protectedNames: [] },
      policy: DEFAULT,
    });
    expect(DeployTargets.safeParse({ extra: 1 }).success).toBe(false);
    expect(DeployTargets.safeParse({ dns: { zones: [{ id: 'x', name: 'a.b' }] } }).success).toBe(false);
    expect(DeployTargets.parse({ dns: { protectedNames: ['WWW.Example.COM.'] } }).dns.protectedNames).toEqual(
      ['www.example.com'],
    );
  });
});

describe('protected DNS records', () => {
  const ctx = {
    consoleHosts: new Set(['console.example.org']),
    protectedNames: new Set(['mail.example.org']),
    controlPlaneTargets: new Set(['203.0.113.10', 'origin.example.org']),
  };
  const cases: [string, { name: string; type: string; content?: string }, boolean][] = [
    ['console host', { name: 'console.example.org', type: 'A', content: '192.0.2.1' }, true],
    ['console host trailing dot / case', { name: 'Console.Example.Org.', type: 'CNAME', content: 'x' }, true],
    ['MX', { name: 'example.org', type: 'MX', content: 'mx.example' }, true],
    ['SPF', { name: 'example.org', type: 'TXT', content: '"v=spf1 -all"' }, true],
    ['DKIM name', { name: 's1._domainkey.example.org', type: 'TXT', content: 'k=rsa' }, true],
    ['DKIM content', { name: 'x.example.org', type: 'TXT', content: 'v=DKIM1; p=abc' }, true],
    ['DMARC', { name: '_dmarc.example.org', type: 'TXT', content: 'v=DMARC1; p=none' }, true],
    ['project protected name', { name: 'mail.example.org', type: 'A', content: '192.0.2.1' }, true],
    ['points at console', { name: 'a.example.org', type: 'CNAME', content: 'console.example.org.' }, true],
    ['points at control-plane IP', { name: 'a.example.org', type: 'A', content: '203.0.113.10' }, true],
    ['ordinary A', { name: 'shop.example.org', type: 'A', content: '192.0.2.1' }, false],
    ['ordinary TXT', { name: 'shop.example.org', type: 'TXT', content: 'google-site-verification=x' }, false],
  ];
  for (const [label, rec, protectedExpected] of cases) {
    it(label, () => {
      expect(protectedRecordReason(rec, ctx) !== null).toBe(protectedExpected);
    });
  }

  it('zone membership', () => {
    expect(nameInZone('example.org', 'example.org')).toBe(true);
    expect(nameInZone('a.b.example.org', 'example.org')).toBe(true);
    expect(nameInZone('evilexample.org', 'example.org')).toBe(false);
    expect(nameInZone('example.org.evil.test', 'example.org')).toBe(false);
  });
});

describe('control-plane Coolify deny-list', () => {
  const ctx = { denyUuids: new Set(['cp1']), consoleHosts: new Set(['console.example.org']) };
  it('denies listed uuids and anything serving the console host', () => {
    expect(coolifyDenyReason({ uuid: 'cp1', fqdn: '' }, ctx)).not.toBeNull();
    expect(
      coolifyDenyReason({ uuid: 'x', fqdn: 'https://a.test,https://console.example.org:443' }, ctx),
    ).not.toBeNull();
    expect(coolifyDenyReason({ uuid: 'x', fqdn: 'console.example.org' }, ctx)).not.toBeNull();
    expect(coolifyDenyReason({ uuid: 'x', fqdn: 'https://shop.example.test' }, ctx)).toBeNull();
    expect(hostsOfFqdn('https://a.test, http://B.test:8080/x')).toEqual(['a.test', 'b.test']);
  });
});

describe('SSRF rules of the ops HTTP client', () => {
  it('classifies addresses', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.100.1.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      'not-an-ip',
    ]) {
      expect(isNonPublicAddress(a), a).toBe(true);
    }
    for (const a of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])
      expect(isNonPublicAddress(a), a).toBe(false);
  });

  it('checks the administrator-supplied base URL', () => {
    const none = new Set<string>();
    expect(checkBaseUrl('https://coolify.example.test/', none)).toEqual({
      ok: true,
      url: 'https://coolify.example.test',
    });
    expect(checkBaseUrl('http://coolify.example.test', none).ok).toBe(false);
    expect(checkBaseUrl('https://10.0.0.5', none).ok).toBe(false);
    expect(checkBaseUrl('https://[::1]', none).ok).toBe(false);
    expect(checkBaseUrl('https://u:p@x.test', none).ok).toBe(false);
    expect(checkBaseUrl('https://x.test/?a=1', none).ok).toBe(false);
    expect(checkBaseUrl('http://coolify:8080', new Set(['http://coolify:8080']))).toEqual({
      ok: true,
      url: 'http://coolify:8080',
    });
  });

  it('refuses non-https and non-public destinations, and never follows redirects', async () => {
    const f = createGuardedFetch();
    await expect(f({ method: 'GET', url: 'http://example.test/' })).rejects.toMatchObject({
      code: 'url_refused',
    });
    await expect(f({ method: 'GET', url: 'https://127.0.0.1/' })).rejects.toMatchObject({
      code: 'address_refused',
    });
    // `localhost` resolves to loopback: refused inside the socket lookup.
    await expect(f({ method: 'GET', url: 'https://localhost:1/' })).rejects.toMatchObject({
      code: 'address_refused',
    });
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const res = await createGuardedFetch({ internalOrigins: [origin] })({
        method: 'GET',
        url: `${origin}/x`,
      });
      expect(res.status).toBe(302);
    } finally {
      await new Promise<void>((r) =>
        server.close(() => {
          r();
        }),
      );
    }
  });
});
