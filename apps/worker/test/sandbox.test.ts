import { describe, expect, it } from 'vitest';
import type { RuntimeReport, ToolReport } from '../src/probe/report.js';
import { probeSandboxProfiles } from '../src/probe/sandbox.js';

const docker = (rootless: boolean | null, reachable = true): ToolReport => ({
  name: 'docker',
  found: true,
  version: '28.1.0',
  details: { daemonReachable: reachable, rootless },
});

const runtime = (kind: RuntimeReport['runtime'], installed: boolean): RuntimeReport => ({
  runtime: kind,
  capabilities: {
    runtime: kind,
    version: installed ? '1.0.0' : 'not-installed',
    installed,
    authenticated: 'unknown',
    capabilities: {},
  },
  binaryPath: installed ? `/bin/${kind}` : null,
  pin: '1.0.0',
  pinStatus: installed ? 'match' : 'not-installed',
  notes: [],
});

const byProfile = (r: ReturnType<typeof probeSandboxProfiles>) =>
  Object.fromEntries(r.profiles.map((p) => [p.profile, p]));

describe('probeSandboxProfiles (ADR-0007)', () => {
  it('offers container on Linux with rootless docker; Pi has no native sandbox', () => {
    const r = byProfile(probeSandboxProfiles('linux', [docker(true)], [runtime('pi', true)]));
    expect(r.container).toMatchObject({ available: true, ready: false });
    expect(r['runtime-sandbox']).toMatchObject({ available: false, runtimes: [] });
  });

  it('refuses container for a rootful daemon or on macOS', () => {
    expect(byProfile(probeSandboxProfiles('linux', [docker(false)], [])).container?.available).toBe(false);
    expect(byProfile(probeSandboxProfiles('darwin', [docker(false)], [])).container?.available).toBe(false);
    expect(byProfile(probeSandboxProfiles('linux', [docker(true, false)], [])).container?.available).toBe(
      false,
    );
  });

  it('has no runtime-sandbox for Claude Code on native Windows or for Pi/OpenCode anywhere', () => {
    const r = byProfile(
      probeSandboxProfiles(
        'win32',
        [],
        [runtime('claude-code', true), runtime('pi', true), runtime('opencode', true)],
      ),
    );
    expect(r['runtime-sandbox']).toMatchObject({ available: false, runtimes: [] });
  });

  it('always offers host-restricted but never ready, with a warning about the OS user', () => {
    const result = probeSandboxProfiles('darwin', [], [runtime('codex', true)]);
    expect(byProfile(result)['host-restricted']).toMatchObject({ available: true, ready: false });
    expect(byProfile(result)['runtime-sandbox']).toMatchObject({ available: true, runtimes: ['codex'] });
    expect(result.problems.map((p) => p.code)).toEqual(['sandbox.os_user_missing']);
  });
});
