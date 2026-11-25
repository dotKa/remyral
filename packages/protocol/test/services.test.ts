import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AssignedServices,
  leaseKeyId,
  SERVICE_LIMITS,
  ServiceRequestOp,
  ServiceSpec,
  serviceExpiry,
  serviceMessageFresh,
  serviceSpecHash,
  serviceSpecIssues,
  signServiceControl,
  signServiceStart,
  signServiceTunnel,
  verifyServiceControl,
  verifyServiceStart,
  verifyServiceTunnel,
} from '../src/index.js';

const base = {
  serviceId: '00000000-0000-4000-8000-00000000a001',
  projectId: 'shop',
  name: 'web',
  source: { kind: 'job', jobId: 'job_01', attemptId: 'att_01' },
  cwd: 'apps/web',
  command: 'pnpm dev --port 5173',
  env: { NODE_ENV: 'development' },
  secretEnv: { API_KEY: 'secret:vault-abc' },
  port: 5173,
  health: { kind: 'http', path: '/health' },
  restart: {},
  sandboxProfile: 'host-restricted',
  limits: {},
  expiresAt: '2026-10-12T23:00:00.000Z',
  tunnel: 'quick',
} as const;

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

describe('p15-services wire', () => {
  it('parses a spec with defaults and refuses unsafe fields', () => {
    const spec = ServiceSpec.parse(base);
    expect(spec.health).toMatchObject({
      kind: 'http',
      intervalSec: 10,
      failures: 3,
      expectStatus: { min: 200 },
    });
    expect(spec.restart).toEqual({ policy: 'on-failure', maxRestarts: 5, windowSec: 600 });
    expect(serviceSpecIssues(spec)).toEqual([]);
    for (const cwd of ['../etc', '/abs', 'a/../b', 'a//b']) {
      expect(ServiceSpec.safeParse({ ...base, cwd }).success).toBe(false);
    }
    expect(ServiceSpec.safeParse({ ...base, port: 22 }).success).toBe(false);
    expect(ServiceSpec.safeParse({ ...base, sandboxProfile: 'container' }).success).toBe(false);
    expect(ServiceSpec.safeParse({ ...base, secretEnv: { K: 'plain-value' } }).success).toBe(false);
    expect(ServiceSpec.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(ServiceSpec.safeParse({ ...base, command: 'a\0b' }).success).toBe(false);
    expect(serviceSpecIssues(ServiceSpec.parse({ ...base, port: null }))).toContain(
      'a tcp / http health check needs a port',
    );
    expect(
      serviceSpecIssues(ServiceSpec.parse({ ...base, env: { API_KEY: 'x' } })).some((i) =>
        i.includes('both'),
      ),
    ).toBe(true);
  });

  it('hashes the canonical spec (key order does not matter, any change does)', () => {
    const a = ServiceSpec.parse(base);
    const b = ServiceSpec.parse(Object.fromEntries(Object.entries(base).reverse()));
    expect(serviceSpecHash(a)).toBe(serviceSpecHash(b));
    expect(serviceSpecHash(ServiceSpec.parse({ ...base, command: 'pnpm start' }))).not.toBe(
      serviceSpecHash(a),
    );
    // A re-parse of the parsed spec is stable (what the worker hashes).
    expect(serviceSpecHash(ServiceSpec.parse(JSON.parse(JSON.stringify(a))))).toBe(serviceSpecHash(a));
  });

  it('signs and verifies start, control and tunnel statements', () => {
    const { privateKey, key } = keys();
    const other = keys();
    const spec = ServiceSpec.parse(base);
    const start = { workerId: 'wrk_mac1', revision: 2, issuedAt: '2026-10-12T19:00:00.000Z', spec };
    const sig = signServiceStart(start, key.kid, privateKey);
    expect(verifyServiceStart(start, sig, [key])).toBe('ok');
    expect(verifyServiceStart({ ...start, revision: 3 }, sig, [key])).toBe('bad_signature');
    expect(verifyServiceStart({ ...start, workerId: 'wrk_other' }, sig, [key])).toBe('bad_signature');
    expect(
      verifyServiceStart({ ...start, spec: ServiceSpec.parse({ ...base, command: 'curl evil' }) }, sig, [
        key,
      ]),
    ).toBe('bad_signature');
    expect(verifyServiceStart(start, sig, [other.key])).toBe('unknown_key');
    expect(verifyServiceStart(start, undefined, [key])).toBe('missing');

    const ctl = {
      workerId: 'wrk_mac1',
      serviceId: spec.serviceId,
      op: 'stop' as const,
      issuedAt: start.issuedAt,
    };
    const cs = signServiceControl(ctl, key.kid, privateKey);
    expect(verifyServiceControl(ctl, cs, [key])).toBe('ok');
    expect(verifyServiceControl({ ...ctl, op: 'remove' }, cs, [key])).toBe('bad_signature');

    const tun = {
      workerId: 'wrk_mac1',
      serviceId: spec.serviceId,
      tunnelId: '00000000-0000-4000-8000-00000000a002',
      hostname: 'Web-x.example.com',
      port: 5173,
      expiresAt: '2026-10-12T23:00:00.000Z',
      issuedAt: start.issuedAt,
      connectorToken: 'e'.repeat(64),
    };
    const ts = signServiceTunnel(tun, key.kid, privateKey);
    expect(verifyServiceTunnel({ ...tun, hostname: 'web-x.example.com' }, ts, [key])).toBe('ok');
    expect(verifyServiceTunnel({ ...tun, connectorToken: 'f'.repeat(64) }, ts, [key])).toBe('bad_signature');
    expect(verifyServiceTunnel({ ...tun, port: 5174 }, ts, [key])).toBe('bad_signature');
  });

  it('freshness, expiry and the job tool shapes', () => {
    const now = new Date('2026-10-12T19:10:00.000Z');
    expect(serviceMessageFresh('2026-10-12T19:08:00.000Z', now)).toBe(true);
    expect(serviceMessageFresh('2026-10-12T18:50:00.000Z', now)).toBe(false);
    expect(serviceMessageFresh('2026-10-12T19:20:00.000Z', now)).toBe(false);
    expect(serviceExpiry(now, {})?.getTime()).toBe(now.getTime() + SERVICE_LIMITS.defaultTtlMinutes * 60_000);
    expect(serviceExpiry(now, { untilStopped: true })).toBeNull();
    expect(serviceExpiry(now, { ttlMinutes: 10 })?.toISOString()).toBe('2026-10-12T19:20:00.000Z');
    expect(ServiceRequestOp.safeParse({ kind: 'stop', name: 'web' }).success).toBe(true);
    expect(
      ServiceRequestOp.safeParse({ kind: 'start', request: { name: 'Web!', command: 'x' } }).success,
    ).toBe(false);
    expect(AssignedServices.safeParse({ tools: true, tunnels: [] }).success).toBe(false);
  });
});
