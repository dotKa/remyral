import { generateKeyPairSync } from 'node:crypto';
import {
  AssignedPreviews,
  JobPreviewRequest,
  leaseKeyId,
  MasterToWorker,
  PREVIEW_DENIED_PORTS,
  PreviewOp,
  previewPortProblem,
  signTunnelStart,
  tunnelMessageFresh,
  verifyTunnelStart,
  WorkerToMaster,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { DeployPolicy, DeployTargets, PreviewSettings, protectedRecordReason } from '../../src/ops/index.js';
import {
  extendedExpiry,
  lifetimeMinutes,
  previewAvailability,
  previewHostname,
  previewSlug,
  protectionsOffered,
  randomLabel,
  tunnelDecision,
} from '../../src/previews/model.js';

/** p8-preview-tunnels (ADR-0032): pure rules — hostnames, lifetimes, the tunnel.* policy, ports, wire schemas. */

const POLICY = DeployPolicy.parse({});
const MIN = 60_000;

describe('preview hostnames', () => {
  it('one label under the zone: [prefix-]name-random, random ≥ 50 bits from a 32-character alphabet', () => {
    const r = randomLabel();
    expect(r).toMatch(/^[a-z0-9]{10}$/);
    expect(new Set(Array.from({ length: 200 }, () => randomLabel())).size).toBe(200);
    expect(previewHostname('Preview.Example.test', 'pv', 'web', 'abcdefghjk')).toBe(
      'pv-web-abcdefghjk.preview.example.test',
    );
    expect(previewHostname('example.test', null, 'api', 'abcdefghjk')).toBe('api-abcdefghjk.example.test');
    const long = previewHostname('example.test', 'p'.repeat(20), 'n'.repeat(20), 'r'.repeat(30));
    expect(long.split('.')[0]?.length).toBeLessThanOrEqual(63);
    expect(long.endsWith('-' + 'r'.repeat(30) + '.example.test')).toBe(true);
  });

  it('slugs: lower-case letters, digits, single hyphens, ≤ 20, default preview', () => {
    expect(previewSlug('Web App!')).toBe('web-app');
    expect(previewSlug('--x--')).toBe('x');
    expect(previewSlug(undefined)).toBe('preview');
    expect(previewSlug('ÄÖÜ')).toBe('preview');
    expect(previewSlug('a'.repeat(40))).toHaveLength(20);
  });

  it('a generated hostname is never a protected record (console host, control plane, protected names)', () => {
    const ctx = {
      consoleHosts: new Set(['console.example.org']),
      protectedNames: new Set(['shop.example.org']),
      controlPlaneTargets: new Set(['203.0.113.10']),
    };
    expect(
      protectedRecordReason(
        { name: 'console.example.org', type: 'CNAME', content: 'x.cfargotunnel.com' },
        ctx,
      ),
    ).toContain('console host');
    expect(protectedRecordReason({ name: 'shop.example.org', type: 'CNAME', content: 'x' }, ctx)).toContain(
      'protected',
    );
    expect(
      protectedRecordReason(
        { name: previewHostname('example.org', null, 'web'), type: 'CNAME', content: 'x.cfargotunnel.com' },
        ctx,
      ),
    ).toBeNull();
  });
});

describe('lifetimes', () => {
  it('job-bound: default 4 h, at most 24 h; stable: at most 30 days', () => {
    expect(lifetimeMinutes(false, undefined)).toBe(240);
    expect(lifetimeMinutes(false, 5000)).toBe(1440);
    expect(lifetimeMinutes(true, undefined)).toBe(30 * 24 * 60);
    expect(lifetimeMinutes(true, 60)).toBe(60);
  });

  it('extensions never shorten and never exceed the cap from now', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    const cur = new Date(now.getTime() + 60 * MIN);
    expect(extendedExpiry(false, cur, 60, now).getTime()).toBe(cur.getTime() + 60 * MIN);
    expect(extendedExpiry(false, cur, 10_000, now).getTime()).toBe(now.getTime() + 24 * 60 * MIN);
    const far = new Date(now.getTime() + 30 * 60 * MIN);
    // Already beyond the cap (e.g. a policy change): kept, never shortened.
    expect(extendedExpiry(false, far, 5, now).getTime()).toBe(far.getTime());
    expect(extendedExpiry(true, cur, 40 * 24 * 60, now).getTime()).toBe(now.getTime() + 30 * 24 * 60 * MIN);
  });
});

describe('tunnel.* policy (ADR-0032 §3)', () => {
  it('defaults: open auto, new stable reservation approval, renew stable approval, close auto, refusals win', () => {
    expect(tunnelDecision('tunnel.open', POLICY, { refusal: null }).decision).toBe('auto');
    expect(tunnelDecision('tunnel.open', POLICY, { refusal: null, newStable: true }).decision).toBe(
      'approval',
    );
    expect(tunnelDecision('tunnel.extend', POLICY, { refusal: null }).decision).toBe('auto');
    expect(tunnelDecision('tunnel.extend', POLICY, { refusal: null, renewStable: true }).decision).toBe(
      'approval',
    );
    expect(tunnelDecision('tunnel.close', POLICY, { refusal: null }).decision).toBe('auto');
    expect(tunnelDecision('tunnel.open', POLICY, { refusal: 'limit' })).toEqual({
      decision: 'refused',
      reason: 'limit',
    });
    expect(tunnelDecision('tunnel.close', POLICY, { refusal: 'x' }).decision).toBe('refused');
  });

  it('project policy can tighten (and allow stable auto); close stays auto', () => {
    const strict = DeployPolicy.parse({ previewTunnel: 'approval_step_up', stableTunnel: 'auto' });
    expect(tunnelDecision('tunnel.open', strict, { refusal: null }).decision).toBe('approval_step_up');
    expect(tunnelDecision('tunnel.open', strict, { refusal: null, newStable: true }).decision).toBe('auto');
    expect(tunnelDecision('tunnel.close', strict, { refusal: null }).decision).toBe('auto');
  });

  it('settings defaults and the e-mail allowlist decide the protections offered', () => {
    const s = PreviewSettings.parse({});
    expect(s).toEqual({
      zone: null,
      prefix: null,
      agentsMayOpen: true,
      accessEmails: [],
      maxActive: 5,
      maxPerJob: 3,
    });
    expect(protectionsOffered(s)).toEqual(['none', 'service-token']);
    expect(protectionsOffered(PreviewSettings.parse({ accessEmails: [' A@Example.test '] }))).toEqual([
      'none',
      'access',
      'service-token',
    ]);
    expect(PreviewSettings.parse({ accessEmails: ['A@Example.test'] }).accessEmails).toEqual([
      'a@example.test',
    ]);
    expect(PreviewSettings.safeParse({ prefix: 'Bad_Prefix' }).success).toBe(false);
    expect(PreviewSettings.safeParse({ maxActive: 21 }).success).toBe(false);
    const t = DeployTargets.parse({});
    expect(t.previews).toBeNull();
    expect(t.policy).toMatchObject({ previewTunnel: 'auto', stableTunnel: 'approval' });
  });

  it('availability explains what is missing, in order', () => {
    const ok = {
      settings: PreviewSettings.parse({ zone: { id: 'a'.repeat(32), name: 'example.test' } }),
      jobActive: true,
      sandboxProfile: 'host-restricted',
      workerFeature: true,
      cloudflared: true,
      workerConnected: true,
    };
    expect(previewAvailability(ok)).toBeNull();
    expect(previewAvailability({ ...ok, settings: null })).toContain('not set up');
    expect(previewAvailability({ ...ok, jobActive: false })).toContain('not running');
    expect(previewAvailability({ ...ok, sandboxProfile: 'container' })).toContain('container');
    // p22-previews-inputs: container jobs on a worker that publishes container ports.
    expect(previewAvailability({ ...ok, sandboxProfile: 'container', containerFeature: true })).toBeNull();
    expect(previewAvailability({ ...ok, workerFeature: false })).toContain('worker release');
    expect(previewAvailability({ ...ok, cloudflared: false })).toContain('cloudflared');
    expect(previewAvailability({ ...ok, workerConnected: false })).toContain('not connected');
  });
});

describe('ports and wire schemas', () => {
  it('only unprivileged, non-service ports', () => {
    for (const p of [
      22, 80, 443, 1023, 3389, 5432, 3306, 6379, 27017, 2375, 6443, 9229, 20241, 65_536, 1.5,
    ]) {
      expect(previewPortProblem(p), String(p)).not.toBeNull();
    }
    for (const p of [3000, 5173, 8080, 8000, 4200, 8501, 19_006])
      expect(previewPortProblem(p), String(p)).toBeNull();
    expect(PREVIEW_DENIED_PORTS).toContain(5900);
  });

  it('PreviewOp / JobPreviewRequest / AssignedPreviews are strict', () => {
    expect(PreviewOp.parse({ kind: 'open', port: 5173, check: 'owned' })).toEqual({
      kind: 'open',
      port: 5173,
      protect: 'none',
      stable: false,
      check: 'owned',
    });
    expect(PreviewOp.safeParse({ kind: 'open', port: 5173, check: 'owned', host: 'evil' }).success).toBe(
      false,
    );
    expect(PreviewOp.safeParse({ kind: 'open', port: 22, check: 'declared' }).success).toBe(false);
    expect(JobPreviewRequest.safeParse({ autoOpen: { port: 5173, protect: 'access' } }).success).toBe(true);
    expect(JobPreviewRequest.safeParse({ autoOpen: { port: 5173, name: 'Bad Name' } }).success).toBe(false);
    expect(
      AssignedPreviews.safeParse({ tools: true, declaredPorts: [5173], protections: ['none'] }).success,
    ).toBe(true);
  });

  it('TUNNEL_START: signed binding (token as its hash), freshness window, part of the message unions', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const raw = String(publicKey.export({ format: 'jwk' }).x);
    const key = { kid: leaseKeyId(raw), publicKey: raw };
    const b = {
      workerId: 'wrk_1',
      tunnelId: '00000000-0000-4000-8000-000000000001',
      jobId: '00000000-0000-4000-8000-000000000002',
      attemptId: '00000000-0000-4000-8000-000000000003',
      epoch: 1,
      port: 5173,
      hostname: 'pv-web-abcdefghjk.example.test',
      expiresAt: '2026-10-16T16:00:00.000Z',
      check: 'owned' as const,
      issuedAt: '2026-10-16T12:00:00.000Z',
      connectorToken: 'eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=',
    };
    const sig = signTunnelStart(b, key.kid, privateKey);
    expect(verifyTunnelStart(b, sig, [key])).toBe('ok');
    expect(verifyTunnelStart({ ...b, connectorToken: `${b.connectorToken}x` }, sig, [key])).toBe(
      'bad_signature',
    );
    expect(verifyTunnelStart({ ...b, workerId: 'wrk_2' }, sig, [key])).toBe('bad_signature');
    expect(verifyTunnelStart(b, undefined, [key])).toBe('missing');
    expect(verifyTunnelStart(b, { ...sig, kid: 'other' }, [key])).toBe('unknown_key');
    expect(sig.signature).not.toContain(b.connectorToken);
    const now = new Date('2026-10-16T12:01:00Z');
    expect(tunnelMessageFresh(b.issuedAt, now)).toBe(true);
    expect(tunnelMessageFresh(b.issuedAt, new Date('2026-10-16T12:10:00Z'))).toBe(false);
    expect(tunnelMessageFresh('2026-10-16T12:30:00Z', now)).toBe(false);
    const env = {
      protocolVersion: '1.0',
      messageId: '00000000-0000-4000-8000-0000000000aa',
      seq: 0,
      ts: b.issuedAt,
      correlationId: 'c',
      workerId: 'wrk_1',
    };
    const { workerId: _w, ...payload } = b;
    expect(
      MasterToWorker.safeParse({ ...env, type: 'TUNNEL_START', payload: { ...payload, signature: sig } })
        .success,
    ).toBe(true);
    expect(
      WorkerToMaster.safeParse({
        ...env,
        type: 'TUNNEL_STATUS',
        payload: { tunnelId: b.tunnelId, state: 'running', at: b.issuedAt },
      }).success,
    ).toBe(true);
  });
});
