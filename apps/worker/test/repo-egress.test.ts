import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { effectiveRepoEgress, PACKAGE_REGISTRY_PRESETS, REPO_EGRESS_PRESETS } from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { repoNetworkPolicy, repoRefusalHint, workspaceRefusalHint } from '../src/jobs/repo-egress.js';
import { networkPolicy } from '../src/jobs/workspace-job.js';
import { startEgressProxy, type EgressDecision, type EgressProxy } from '../src/sandbox/egress/proxy.js';
import { formatTarget, isForbiddenAddress, normalizeNetworkPolicy } from '../src/sandbox/network.js';
import type { NetworkPolicy } from '../src/sandbox/types.js';

/**
 * p14-repo-egress: a repository job's network policy per project mode (none / allowlist with presets / web), the
 * private-address floor that no mode lifts, and the 403 body that says why a tunnel was refused.
 */

const MODEL = ['api.anthropic.com', 'api.openai.com'];
const hostsOf = (p: NetworkPolicy): string[] => (p.mode === 'none' ? [] : p.targets.map(formatTarget));

describe('repository job network policy', () => {
  it('older master (no policy): model APIs + MCP hosts only, and the 403 says so', () => {
    const p = repoNetworkPolicy(null, [...MODEL, 'mcp.example.com']);
    expect(p.mode).toBe('allowlist');
    expect(hostsOf(p)).toEqual(['api.anthropic.com:443', 'api.openai.com:443', 'mcp.example.com:443']);
    expect(p.mode !== 'none' && p.refusalHint).toContain('did not send a project egress policy');
  });

  it('none: exactly the worker list (today’s behaviour), hint names the setting', () => {
    const p = repoNetworkPolicy({ mode: 'none', hosts: [] }, MODEL);
    expect(hostsOf(p)).toEqual(['api.anthropic.com:443', 'api.openai.com:443']);
    expect(p.mode !== 'none' && p.refusalHint).toBe(
      'project egress policy: none (model APIs only) — change it in Projeler → Politika → Ağ erişimi (Projects → Policy → Network access).',
    );
    // A stray host list with mode none is ignored.
    expect(hostsOf(repoNetworkPolicy({ mode: 'none', hosts: ['github.com'] }, MODEL))).toHaveLength(2);
  });

  it('allowlist with the package-registry presets: model APIs + every registry host', () => {
    const eff = effectiveRepoEgress('allowlist', PACKAGE_REGISTRY_PRESETS, ['cdn.example.com:8443']);
    const p = repoNetworkPolicy(eff, MODEL);
    expect(p.mode).toBe('allowlist');
    const hosts = hostsOf(p);
    for (const h of [
      ...REPO_EGRESS_PRESETS.npm,
      ...REPO_EGRESS_PRESETS.pypi,
      ...REPO_EGRESS_PRESETS.crates,
      ...REPO_EGRESS_PRESETS.go,
      ...REPO_EGRESS_PRESETS.maven,
    ])
      expect(hosts).toContain(`${h}:443`);
    expect(hosts).toContain('cdn.example.com:8443');
    expect(hosts).toContain('api.anthropic.com:443');
    expect(hosts).not.toContain('github.com:443');
    // Within the sandbox's 128-target bound even with every preset, the maximum of custom hosts and MCP hosts.
    const all = effectiveRepoEgress(
      'allowlist',
      ['npm', 'pypi', 'crates', 'go', 'maven', 'github', 'gitlab'],
      Array.from({ length: 48 }, (_, i) => `h${String(i)}.example.com`),
    );
    const mcp = Array.from({ length: 32 }, (_, i) => `m${String(i)}.example.com`);
    expect(() => normalizeNetworkPolicy(repoNetworkPolicy(all, [...MODEL, ...mcp]))).not.toThrow();
  });

  it('web: mode web (any public 443) plus the listed hosts; allowlist without hosts is none', () => {
    const p = repoNetworkPolicy(effectiveRepoEgress('web', [], ['git.example.com:2222']), MODEL);
    expect(p.mode).toBe('web');
    expect(hostsOf(p)).toContain('git.example.com:2222');
    expect(effectiveRepoEgress('allowlist', [], [])).toEqual({ mode: 'none', hosts: [] });
  });

  it('normalising keeps the refusal hint; workspace jobs get their own hint', () => {
    const p = normalizeNetworkPolicy(repoNetworkPolicy({ mode: 'none', hosts: [] }, MODEL));
    expect(p.mode !== 'none' && p.refusalHint).toBe(repoRefusalHint('none'));
    const w = networkPolicy({ egress: 'none', allowHosts: [] }, MODEL, workspaceRefusalHint('none'));
    expect(w.mode !== 'none' && w.refusalHint).toContain('workspace egress policy: none');
  });
});

/** Raw request through the proxy; resolves with the whole response once the proxy closes or a tunnel opens. */
function via(
  proxy: EgressProxy,
  target: string,
  method = 'CONNECT',
): Promise<{ status: number; head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const s = connect(proxy.port, '127.0.0.1');
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      const end = raw.indexOf('\r\n\r\n');
      const head = end === -1 ? raw : raw.slice(0, end);
      resolve({
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0),
        head,
        body: end === -1 ? '' : raw.slice(end + 4),
      });
      s.destroy();
    };
    s.on('error', reject);
    s.on('data', (c: Buffer) => {
      chunks.push(c);
      if (Buffer.concat(chunks).toString('latin1').startsWith('HTTP/1.1 200')) finish();
    });
    s.on('close', finish);
    s.write(
      method === 'CONNECT'
        ? `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`
        : `${method} http://${target}/ HTTP/1.1\r\nHost: ${target}\r\n\r\n`,
    );
  });
}

describe('egress proxy decisions per project mode (p14-repo-egress)', () => {
  let upstream: Server | undefined;
  let proxy: EgressProxy | undefined;
  afterEach(async () => {
    await proxy?.close();
    await new Promise<void>((r) => {
      if (upstream)
        upstream.close(() => {
          r();
        });
      else r();
    });
    proxy = undefined;
    upstream = undefined;
  });

  /** Every public name resolves to the loopback test upstream; `*.lan.example.com` and `metadata.example.com` to private addresses. */
  async function start(
    policy: NetworkPolicy | ((upstreamPort: number) => NetworkPolicy),
  ): Promise<{ port: number; decisions: EgressDecision[] }> {
    upstream = createServer((s) => s.end());
    await new Promise<void>((r) => {
      upstream?.listen(0, '127.0.0.1', () => {
        r();
      });
    });
    const port = (upstream.address() as AddressInfo).port;
    const p = normalizeNetworkPolicy(typeof policy === 'function' ? policy(port) : policy);
    if (p.mode === 'none') throw new Error('unexpected');
    const decisions: EgressDecision[] = [];
    proxy = await startEgressProxy({
      allow: p.targets,
      anyPublicHttps: p.mode === 'web',
      ...(p.refusalHint === undefined ? {} : { refusalHint: p.refusalHint }),
      lookup: (h) =>
        Promise.resolve(
          h.endsWith('.lan.example.com')
            ? [{ address: '192.168.1.10', family: 4 }]
            : h === 'metadata.example.com'
              ? [{ address: '169.254.169.254', family: 4 }]
              : [{ address: '127.0.0.1', family: 4 }],
        ),
      // The test upstream is on loopback; every other forbidden range stays forbidden.
      isForbidden: (a) => a !== '127.0.0.1' && isForbiddenAddress(a),
      onDecision: (d) => decisions.push(d),
    });
    return { port, decisions };
  }

  it('none: registry.npmjs.org gets a 403 whose body names the policy and where to change it', async () => {
    const { decisions } = await start(repoNetworkPolicy({ mode: 'none', hosts: [] }, MODEL));
    const r = await via(proxy as EgressProxy, 'registry.npmjs.org:443');
    expect(r.status).toBe(403);
    expect(r.head).toMatch(/X-Remyral-Egress: not-allowlisted/);
    expect(r.head).toMatch(/Content-Type: text\/plain; charset=utf-8/);
    expect(r.body).toBe(
      'Remyral egress proxy: registry.npmjs.org:443 refused: not allowed by the network policy of this job. project egress policy: none (model APIs only) — change it in Projeler → Politika → Ağ erişimi (Projects → Policy → Network access).\n',
    );
    expect(decisions.map((d) => d.reason)).toEqual(['not-allowlisted']);
    // Plain HTTP (npm with an http:// registry) carries the same hint.
    const plain = await via(proxy as EgressProxy, 'registry.npmjs.org', 'GET');
    expect(plain.status).toBe(403);
    expect(plain.body).toContain('project egress policy: none');
  });

  it('allowlist with presets + a custom host:port: listed hosts pass, others are refused with the allowlist hint', async () => {
    const eff = effectiveRepoEgress('allowlist', ['npm', 'github'], []);
    const { port, decisions } = await start((up) =>
      repoNetworkPolicy({ ...eff, hosts: [...eff.hosts, `mirror.example.com:${String(up)}`] }, MODEL),
    );
    expect((await via(proxy as EgressProxy, `mirror.example.com:${String(port)}`)).status).toBe(200);
    // A preset host passes the policy (nothing listens on loopback:443, so the tunnel itself fails: 502, not 403).
    expect((await via(proxy as EgressProxy, 'registry.npmjs.org:443')).status).not.toBe(403);
    expect((await via(proxy as EgressProxy, 'github.com:443')).status).not.toBe(403);
    const pypi = await via(proxy as EgressProxy, 'pypi.org:443');
    expect(pypi.status).toBe(403);
    expect(pypi.body).toContain('project egress policy: allowlist — this host is not in the list');
    expect(decisions.find((d) => d.target === 'registry.npmjs.org:443')?.reason).not.toBe('not-allowlisted');
    expect(decisions.find((d) => d.target === 'pypi.org:443')?.reason).toBe('not-allowlisted');
  });

  it('web: any public host on 443 passes, other ports are refused, the private floor holds', async () => {
    const { decisions } = await start(repoNetworkPolicy({ mode: 'web', hosts: [] }, MODEL));
    expect((await via(proxy as EgressProxy, 'example.com:443')).status).not.toBe(403);
    expect((await via(proxy as EgressProxy, 'example.com:8080')).status).toBe(403);
    const lan = await via(proxy as EgressProxy, 'nas.lan.example.com:443');
    expect(lan.status).toBe(403);
    expect(lan.head).toMatch(/X-Remyral-Egress: forbidden-address/);
    expect(lan.body).toContain('private, LAN, loopback, link-local or cloud metadata address');
    const md = await via(proxy as EgressProxy, 'metadata.example.com:443');
    expect(md.status).toBe(403);
    expect((await via(proxy as EgressProxy, '169.254.169.254:443')).status).toBe(403);
    expect(decisions.map((d) => [d.target, d.reason])).toEqual(
      expect.arrayContaining([
        ['example.com:8080', 'not-allowlisted'],
        ['nas.lan.example.com:443', 'forbidden-address'],
        ['metadata.example.com:443', 'forbidden-address'],
        ['169.254.169.254:443', 'bad-request'],
      ]),
    );
  });

  it('allowlist: a listed host that resolves to a LAN address is still refused', async () => {
    const { decisions } = await start(
      repoNetworkPolicy({ mode: 'allowlist', hosts: ['git.lan.example.com'] }, MODEL),
    );
    const r = await via(proxy as EgressProxy, 'git.lan.example.com:443');
    expect(r.status).toBe(403);
    expect(decisions.at(-1)).toEqual(
      expect.objectContaining({ allowed: false, reason: 'forbidden-address', address: '192.168.1.10' }),
    );
  });
});
