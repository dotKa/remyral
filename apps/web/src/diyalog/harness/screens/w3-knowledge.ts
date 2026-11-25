import type { ScreenRoutes } from './types';

/**
 * p12-diyalog wave 2 (W3) harness fixtures: Yetenekler (`/skills`) and Denetim (`/audit`). A skill with two versions
 * (offline- and panel-signed) assigned to one project and all projects; audit events of every outcome (a hostile
 * target stays text). Also used by apps/web/test/diyalog-w3-knowledge.test.tsx.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const W3_SKILLS = {
  configured: true,
  panelKey: { configured: true, keyId: 'panel-7f3a' },
  // p14-skill-import: projects that accept only offline-signed skills; GitHub imports on.
  offlineOnlyProjects: [] as string[],
  imports: { github: true },
  skills: [
    {
      id: 'lint-fix',
      deleted: false,
      latest: '1.1.0',
      versions: [
        {
          version: '1.1.0',
          title: 'Lint düzeltici',
          description: 'Linter’ı çalıştırır, uyarıları düzeltir ve değişikliği küçük tutar.',
          runtimes: ['codex', 'claude-code'],
          manifestSha256: 'a3f1c2'.padEnd(64, '0'),
          keyId: 'owner-2026',
          fileCount: 2,
          totalBytes: 2100,
          uploadedAt: iso(2 * DAY),
          signer: 'offline',
          provenance: null,
        },
        {
          version: '1.0.0',
          title: 'Lint düzeltici',
          description: 'İlk sürüm.',
          runtimes: ['codex'],
          manifestSha256: '9b77de'.padEnd(64, '1'),
          keyId: 'panel-7f3a',
          fileCount: 1,
          totalBytes: 900,
          uploadedAt: iso(20 * DAY),
          signer: 'panel',
          provenance: {
            kind: 'github',
            repo: 'anthropics/skills',
            path: 'skills/lint',
            commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
          },
        },
      ],
      assignments: [
        {
          id: '00000000-0000-4000-8000-00000000a001',
          skillId: 'lint-fix',
          project: 'mobil-app',
          runtimes: ['codex'],
          version: '1.0.0',
          updatedAt: iso(DAY),
        },
        {
          id: '00000000-0000-4000-8000-00000000a002',
          skillId: 'lint-fix',
          project: '*',
          runtimes: null,
          version: null,
          updatedAt: iso(DAY),
        },
      ],
    },
    {
      id: 'release-notes',
      deleted: true,
      latest: null,
      versions: [
        {
          version: '0.3.0',
          title: 'Sürüm notları',
          description: 'Birleşen PR’lardan sürüm notu yazar.',
          runtimes: ['claude-code'],
          manifestSha256: 'c0ffee'.padEnd(64, '2'),
          keyId: 'owner-2026',
          fileCount: 1,
          totalBytes: 400,
          uploadedAt: iso(60 * DAY),
          signer: 'unknown',
        },
      ],
      assignments: [],
    },
  ],
};

export const W3_SKILL_FILES = {
  files: [
    {
      path: 'SKILL.md',
      sha256: '1'.repeat(64),
      executable: false,
      content: '# Lint düzeltici\n\n1. `pnpm lint`\n',
    },
    {
      path: 'scripts/fix.sh',
      sha256: '2'.repeat(64),
      executable: true,
      content: '#!/bin/sh\npnpm lint --fix\n',
    },
  ],
};

function event(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    occurredAt: iso((1043 - Number(id)) * 9 * MIN),
    actor: { type: 'user', id: 'alex' },
    action: 'job.transition',
    target: 'job:7f3a9c',
    outcome: 'success',
    ip: '203.0.113.9',
    userAgent: 'Mozilla/5.0',
    metadata: { from: 'QUEUED', to: 'RESERVED', password: '[REDACTED]' },
    prevHash: '0'.repeat(64),
    hash: 'a'.repeat(64),
    ...over,
  };
}

export const W3_AUDIT = {
  items: [
    event('1042'),
    event('1041', {
      action: 'auth.login.password',
      outcome: 'denied',
      actor: { type: 'anonymous', id: null },
    }),
    event('1040', { action: 'worker.approve', target: 'worker:ridge-lnx-01', outcome: 'success' }),
    event('1039', {
      action: 'deploy.run',
      target: 'deploy:<img src=x onerror=alert(1)>',
      outcome: 'failure',
    }),
    event('1038', {
      action: 'runtime.install',
      actor: { type: 'worker', id: 'atlas-win-01' },
      outcome: 'error',
    }),
    event('1037', {
      action: 'release.promote',
      target: 'channel:canary',
      actor: { type: 'system', id: null },
    }),
  ],
  nextCursor: 'c1',
};

export const ROUTES: ScreenRoutes = {
  '/skills': (_u, method) => (method === 'GET' ? W3_SKILLS : undefined),
  '/skills/lint-fix/versions/1.1.0': () => W3_SKILL_FILES,
  '/skills/lint-fix/versions/1.0.0': () => W3_SKILL_FILES,
  '/audit': () => W3_AUDIT,
};
