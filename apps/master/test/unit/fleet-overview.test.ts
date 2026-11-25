import type { RuntimePolicyDocument } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { compatibility, jobAuthOf, networkGroup, type RuntimeFact } from '../../src/fleetview/overview.js';

const ok = { status: 'supported' };
function fact(over: Partial<RuntimeFact> = {}): RuntimeFact {
  return {
    runtime: 'codex',
    version: '0.162.1',
    installed: true,
    authenticated: 'yes',
    pinStatus: 'match',
    pinnedVersion: '0.162.1',
    capabilities: { streaming: ok, cancel: ok, approval: ok },
    ...over,
  };
}
function policy(rule: Record<string, unknown> | null) {
  const document = {
    runtimes:
      rule === null
        ? {}
        : {
            codex: {
              version: '0.162.1',
              authModes: ['secret-ref'],
              allowUnpinned: false,
              modelProfiles: [],
              defaultProfile: null,
              ...rule,
            },
          },
    projectProfiles: {},
  } as unknown as RuntimePolicyDocument;
  return { name: 'default', version: 3, document };
}
const cell = (runtimes: RuntimeFact[], p: ReturnType<typeof policy> | null = null, known = true) =>
  compatibility('codex', { capabilitiesKnown: known, runtimes }, p);

describe('fleet compatibility matrix cell (p5-fleet-ui)', () => {
  it.each([
    ['ready', cell([fact()], policy({})), 'ready'],
    ['no capabilities yet', cell([], null, false), 'unknown'],
    ['not installed', cell([fact({ installed: false })]), 'not_installed'],
    ['policy forbids', cell([fact()], policy(null)), 'not_allowed'],
    ['pin mismatch', cell([fact({ pinStatus: 'mismatch', version: '0.160.0' })], policy({})), 'pin_mismatch'],
    [
      'unpinned allowed',
      cell([fact({ pinStatus: 'mismatch' })], policy({ allowUnpinned: true })),
      'degraded',
    ],
    ['not authenticated', cell([fact({ authenticated: 'no' })]), 'not_authenticated'],
    ['missing capability', cell([fact({ capabilities: { cancel: ok, approval: ok } })]), 'unsupported'],
    [
      'unverified',
      cell([fact({ capabilities: { streaming: ok, cancel: ok, approval: { status: 'unverified' } } })]),
      'unverified',
    ],
    [
      'unverified allowed',
      cell(
        [fact({ capabilities: { streaming: ok, cancel: ok, approval: { status: 'unverified' } } })],
        policy({ allowUnverified: true }),
      ),
      'degraded',
    ],
  ])('%s', (_name, c, status) => {
    expect(c.status).toBe(status);
    expect(c.reason.length).toBeGreaterThan(0);
  });

  it('names the remedy', () => {
    expect(cell([fact({ pinStatus: 'mismatch', version: '0.160.0' })], policy({})).reason).toContain(
      'install the pinned',
    );
    expect(
      cell([fact({ capabilities: { streaming: ok, cancel: ok, approval: { status: 'unverified' } } })])
        .reason,
    ).toContain('Settings → Runtimes → default → Allow unverified');
    expect(cell([fact()], policy(null)).reason).toBe('not allowed by runtime policy default v3');
  });
});

describe('network groups for the map view', () => {
  it.each([
    ['192.168.1.40', '192.168.1.0/24', 'private'],
    ['10.0.5.7', '10.0.5.0/24', 'private'],
    ['172.20.1.2', '172.20.1.0/24', 'private'],
    ['100.101.5.9', '100.101.5.0/24', 'CGNAT'],
    ['203.0.113.9', '203.0.113.0/24', 'public'],
    ['::ffff:192.168.1.9', '192.168.1.0/24', 'private'],
    ['fd12:3456:789a:1::5', 'fd12:3456:789a:1::/64', 'unique local'],
  ])('%s → %s', (ip, key, kind) => {
    const g = networkGroup(ip);
    expect(g.key).toBe(key);
    expect(g.label).toContain(kind);
    // Only the network is exposed, never the host address.
    expect(g.key.endsWith('.0/24') || g.key.endsWith('::/64')).toBe(true);
  });
  it('unknown without an address', () => {
    expect(networkGroup(null).key).toBe('unknown');
  });
});

describe('not authenticated: the reason names the job auth (p14-login-status-consistency)', () => {
  const no = [fact({ runtime: 'claude-code', authenticated: 'no' })];
  const reason = (auth: Parameters<typeof jobAuthOf>[0]) =>
    compatibility(
      'claude-code',
      { capabilitiesKnown: true, runtimes: no },
      null,
      jobAuthOf(auth, 'claude-code'),
    ).reason;

  it('no sign-in method configured, an API key, or the plain login reason', () => {
    expect(jobAuthOf({ effective: { runtimeAuth: {} } }, 'claude-code')).toBe('none');
    expect(jobAuthOf({ effective: { runtimeAuth: { 'claude-code': 'local-login' } } }, 'claude-code')).toBe(
      'local-login',
    );
    expect(jobAuthOf(null, 'claude-code')).toBeUndefined();
    expect(reason({ effective: { runtimeAuth: {} } })).toMatch(/no sign-in method is configured for jobs/);
    expect(reason({ effective: { runtimeAuth: { 'claude-code': 'secret-ref' } } })).toMatch(
      /jobs on this machine use an API key \(secret-ref\)/,
    );
    expect(reason({ effective: { runtimeAuth: { 'claude-code': 'local-login' } } })).toMatch(
      /log in again: Remote operations/,
    );
    expect(reason(null)).toMatch(/log in again: Remote operations/);
  });

  it('p14-i18n-reasons: the cell carries the cause, so the console never reads the English reason', () => {
    const cell = (auth: Parameters<typeof jobAuthOf>[0]) =>
      compatibility(
        'claude-code',
        { capabilitiesKnown: true, runtimes: no },
        null,
        jobAuthOf(auth, 'claude-code'),
      );
    expect(cell({ effective: { runtimeAuth: {} } }).params).toEqual({ cause: 'no_job_auth' });
    expect(cell({ effective: { runtimeAuth: { 'claude-code': 'secret-ref' } } }).params).toEqual({
      cause: 'job_auth_secret_ref',
    });
    expect(cell({ effective: { runtimeAuth: { 'claude-code': 'local-login' } } }).params).toBeUndefined();
    expect(cell(null).params).toBeUndefined();
  });
});
