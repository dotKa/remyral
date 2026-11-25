// p6-ui-refactor Phase A: grouped navigation, phone bottom bar, shortcuts, redirects, Home and Settings routing.
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { buildNeedsYou, openFailures } from '../src/screens/home/needsYou';
import { type Handler, renderApp, sessionBody } from './helpers';

const signedIn = (role = 'owner'): AuthState => ({
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role },
  session: null,
  remainingRecoveryCodes: null,
});

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function worker(id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name,
    state: 'online',
    quarantineReason: null,
    connected: true,
    fingerprint: null,
    os: 'linux',
    arch: 'x64',
    osVersion: '6.8',
    hostname: name,
    workerVersion: '1.0.0',
    runningJobs: 0,
    lastSeenAt: iso(1000),
    createdAt: iso(86_400_000),
    pairingExpiresAt: null,
    pairingExpired: false,
    drainRequestedAt: null,
    revokedAt: null,
    ...over,
  };
}

function overview(id: string, compatibility: unknown[]): Record<string, unknown> {
  return {
    id,
    capacity: { running: 0, max: 2 },
    capabilitiesAt: iso(60_000),
    sandboxProfiles: [],
    sandboxReadiness: [],
    tools: [],
    load: null,
    network: { key: 'n', label: 'n' },
    runtimePolicy: { assigned: null, effective: 'default', version: 1, stage: 'active', inSync: true },
    release: { channel: 'stable', targetVersion: null, lastAttempt: null },
    compatibility,
  };
}

function job(id: string, state: string, title: string, msAgo: number): Record<string, unknown> {
  return {
    id,
    project: 'acme',
    state,
    runtime: 'codex',
    title,
    attempts: 1,
    workerId: 'w-ok',
    createdBy: { type: 'user', id: 'u1' },
    createdAt: iso(msAgo + 1000),
    stateChangedAt: iso(msAgo),
  };
}

const empty = { status: 200, body: { items: [], nextCursor: null } };

function homeRoutes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => ({ status: 200, body: { items: [] } }),
    'GET /api/jobs?state=FAILED&limit=50': () => empty,
    'GET /api/jobs?state=BLOCKED&limit=50': () => empty,
    'GET /api/jobs?state=LOST&limit=50': () => empty,
    'GET /api/jobs?state=RUNNING%2CSTARTING%2CVERIFYING%2CAWAITING_APPROVAL&limit=200': () => empty,
    'GET /api/workers': () => ({ status: 200, body: { workers: [worker('w-ok', 'linux-a')] } }),
    'GET /api/fleet/overview': () => ({
      status: 200,
      body: {
        workers: [overview('w-ok', [{ runtime: 'codex', status: 'ready', version: '1', reason: 'ready' }])],
      },
    }),
    ...over,
  };
}

describe('shell (p6-ui-refactor)', () => {
  // p15-classic-removal: the old URLs land on the Diyalog screens.
  it.each([
    ['/fleet', 'Makineler'],
    ['/fleet/add', 'Makine ekle'],
  ])('redirects the old %s URL', async (path, heading) => {
    renderApp({
      path,
      initialState: signedIn(),
      routes: homeRoutes({ 'GET /api/fleet/overview': () => ({ status: 200, body: { workers: [] } }) }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy();
  });
});

describe('Home (p6-ui-refactor)', () => {
  it('buildNeedsYou: quarantined machines, blocked jobs and machines without a ready runtime', () => {
    const w = (id: string, over: Record<string, unknown> = {}) => worker(id, id, over) as never;
    const items = buildNeedsYou(
      {
        approvals: [],
        failed: [],
        blocked: [job('j-b', 'BLOCKED', 'Stuck', 1000) as never],
        workers: [
          w('q', { state: 'quarantined', quarantineReason: 'fingerprint changed' }),
          w('bare'),
          w('off', { connected: false }),
        ],
        overview: [
          overview('q', []) as never,
          overview('bare', [{ runtime: 'pi', status: 'not_installed', version: null, reason: 'x' }]) as never,
          overview('off', []) as never,
        ],
      },
      NOW,
    );
    expect(
      items.map((i) => (i.kind === 'reason' ? `${i.kind}:${i.reason}` : `${i.kind}:${i.sentence}`)),
    ).toEqual([
      'blocked:“Stuck” cannot start: no machine can run it yet.',
      'reason:quarantined: fingerprint changed',
      'reason:no_ready_runtime',
    ]);
  });
});

describe('Home: failed jobs in "Needs you"', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const job = (id: string, title: string, createdAt: string, state = 'FAILED') =>
    ({
      id,
      project: 'p',
      projectKind: 'repository',
      state,
      runtime: 'codex',
      title,
      attempts: 1,
      workerId: null,
      createdBy: { type: 'user', id: 'u' },
      createdAt,
      stateChangedAt: createdAt,
    }) as never;
  const base = { approvals: [], blocked: [], workers: [], overview: [] };

  it('hides a failure that was re-run successfully or is running again, and dismissed ones', () => {
    const failed = [job('a', 'Fix  it', '2026-10-15T08:00:00Z'), job('b', 'Other', '2026-10-15T09:00:00Z')];
    const later = [job('c', 'Fix it', '2026-10-15T10:00:00Z', 'SUCCEEDED')];
    expect(openFailures({ ...base, failed, later }, now).map((j) => (j as { id: string }).id)).toEqual(['b']);
    expect(
      openFailures({ ...base, failed, later: [], dismissed: new Set(['failed:b']) }, now).map(
        (j) => (j as { id: string }).id,
      ),
    ).toEqual(['a']);
  });

  it('lists at most three failures and folds the rest into one item', () => {
    const failed = Array.from({ length: 7 }, (_, i) =>
      job(`f${String(i)}`, `Job ${String(i)}`, `2026-10-15T0${String(i)}:00:00Z`),
    );
    const items = buildNeedsYou({ ...base, failed }, now);
    expect(items.filter((i) => i.kind === 'failed')).toHaveLength(2);
    const more = items.find((i) => i.kind === 'failed-more');
    expect(more && 'sentence' in more ? more.sentence : '').toBe('5 more jobs failed in the last 24 hours.');
  });
});
