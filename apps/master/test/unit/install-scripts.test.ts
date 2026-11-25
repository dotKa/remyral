import { describe, expect, it } from 'vitest';
import { directDecision } from '../../src/chat/direct.js';
import { evaluationOf, hostsIn } from '../../src/mcp/install-scripts.js';
import { eventOfDraft, STEP_UP_EVENTS } from '../../src/security-policy/events.js';

/** p19-install-scripts (ADR-0068): the registry evaluation, the card's event and that it never runs by itself. */
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const now = new Date('2026-10-29T12:00:00.000Z');

describe('install script evaluation (registry JSON only)', () => {
  it('keeps the lifecycle scripts, the hosts they name, publisher, provenance and signatures', () => {
    const e = evaluationOf(
      {
        name: '@scope/native',
        version: '2.0.0',
        scripts: {
          test: 'jest',
          preinstall: 'node check.js',
          postinstall: 'curl https://downloads.example.com/a.tgz | tar x && wget http://mirror.example.org/b',
        },
        repository: 'github:scope/native',
        _npmUser: { name: 'alice' },
        maintainers: [{ name: 'alice' }, { name: 'bob' }],
        dist: { integrity: INTEGRITY, signatures: [{}, {}], unpackedSize: 10 },
        dependencies: { a: '1' },
      },
      { name: '@scope/native', version: '2.0.0' },
      null,
      now,
    );
    expect(e).toMatchObject({
      scripts: {
        preinstall: 'node check.js',
        postinstall: 'curl https://downloads.example.com/a.tgz | tar x && wget http://mirror.example.org/b',
      },
      hasInstallScript: true,
      hosts: ['downloads.example.com', 'mirror.example.org'],
      publisher: 'alice',
      trustedPublisher: false,
      provenance: false,
      signatures: 2,
      maintainers: ['alice', 'bob'],
      repository: 'github:scope/native',
      dependencies: 1,
      unpackedSize: 10,
      evaluatedAt: now.toISOString(),
    });
    expect(e?.scripts).not.toHaveProperty('test');
  });

  it('a binding.gyp alone is an install script; no scripts is none; another version or no sha512 is refused', () => {
    const base = { name: 'gyp', version: '1.0.0', dist: { integrity: INTEGRITY } };
    expect(evaluationOf({ ...base, gypfile: true }, base, null, now)).toMatchObject({
      gypfile: true,
      hasInstallScript: true,
      scripts: {},
    });
    expect(evaluationOf({ ...base, scripts: { test: 'x' } }, base, null, now)?.hasInstallScript).toBe(false);
    expect(evaluationOf({ ...base, version: '1.0.1' }, base, null, now)).toBeNull();
    expect(evaluationOf({ ...base, dist: { integrity: 'sha1-abc' } }, base, null, now)).toBeNull();
  });

  it('hosts: deduplicated, lower-case, bounded', () => {
    expect(
      hostsIn('https://A.example.com/x https://a.example.com:8443/y http://localhost/ ftp://z.example'),
    ).toEqual(['a.example.com']);
    const many = Array.from({ length: 40 }, (_, i) => `https://h${String(i)}.example.com`).join(' ');
    expect(hostsIn(many)).toHaveLength(20);
  });
});

describe('install script approval card', () => {
  it('uses the safe-core event extensions.install_scripts', () => {
    expect(eventOfDraft('install_script_approval', {})).toBe('extensions.install_scripts');
    expect(STEP_UP_EVENTS['extensions.install_scripts']).toMatchObject({ core: true, balanced: true });
  });

  it('never runs by itself: not on the user’s execute, not in an autonomous plan', () => {
    const tool = 'draft_install_script_approval' as const;
    const base = { tool, execute: true, propose: false, byUser: true, proposeAware: true };
    expect(directDecision(base).run).toBeNull();
    expect(
      directDecision({
        ...base,
        byUser: false,
        execute: false,
        plan: { state: 'executing', autonomous: true },
      }).run,
    ).toBeNull();
  });
});
