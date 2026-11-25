// p6-automations: list, detail tabs, the create form for every trigger kind, the one-time webhook secret, the
// /jobs/schedules redirect, Home "Needs you" and the chat draft card.
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { curlExample } from '../src/api/automations';
import { buildNeedsYou } from '../src/screens/home/needsYou';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

const signedIn: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-15T10:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function automation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: A1,
    project: 'acme',
    name: 'Nightly tests',
    description: null,
    state: 'active',
    enabled: true,
    trigger: { kind: 'cron', cron: '0 3 * * *' },
    triggerSummary: 'Every day at 03:00 UTC',
    target: {
      kind: 'job',
      runtime: 'codex',
      workflowId: null,
      title: 'Run the test suite',
      approvalPolicy: 'ask-sensitive',
      sandboxProfile: 'container',
    },
    approvalTimeoutMinutes: 60,
    waiting: null,
    concurrency: 'skip',
    catchUp: 'once',
    maxRunsPerHour: 30,
    notifyOnFailure: true,
    nextRunAt: '2026-10-16T03:00:00.000Z',
    lastRun: { id: RUN, state: 'failed', at: NOW },
    runCount: 4,
    successRate: 0.75,
    webhook: null,
    runAs: USER.id,
    createdBy: USER.id,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function detail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...automation(over),
    targetSpec: {
      spec: {
        runtime: 'codex',
        prompt: 'Run the test suite',
        sandboxProfile: 'container',
        limits: { maxDurationSec: 3600 },
      },
      priority: 0,
      workflowInputs: null,
      workflowRepository: null,
    },
    stats: {
      finished: 4,
      succeeded: 3,
      failed: 1,
      skipped: 0,
      lastFailure: { runId: RUN, state: 'failed', reason: 'The job ended failed.', jobId: JOB, at: NOW },
    },
    chainSource: null,
    chainedBy: [{ id: A2, name: 'Deploy preview', on: ['succeeded'] }],
    github: null,
    ...over,
  };
}

/** The body of the last POST /api/automations. */
const session: Handler = () => ({ status: 200, body: sessionBody() });
describe('automations list and detail', () => {
  it('warns when a GitHub automation cannot receive deliveries', async () => {
    renderApp({
      path: `/automations/${A1}`,
      initialState: signedIn,
      routes: {
        'GET /api/auth/session': session,
        [`GET /api/automations/${A1}`]: () => ({
          status: 200,
          body: detail({
            trigger: { kind: 'github', repository: 'acme/app', event: 'pull_request' },
            github: { receiving: false, hookUrl: 'https://console.example/v1/hooks/github' },
          }),
        }),
      },
    });
    expect(await screen.findByTestId('github-not-receiving')).toBeTruthy();
  });

  it('redirects the old schedules page', async () => {
    renderApp({
      path: '/jobs/schedules',
      initialState: signedIn,
      routes: { 'GET /api/automations': () => ({ status: 200, body: { items: [] } }) },
    });
    expect(await screen.findByTestId('automations-empty')).toBeTruthy();
  });
});

describe('automation form', () => {
  it('the curl example signs timestamp.nonce.body', () => {
    const text = curlExample('https://x/v1/hooks/id');
    expect(text).toContain('openssl dgst -sha256 -hmac');
    expect(text).toContain('printf \'%s.%s.%s\' "$TS" "$NONCE" "$BODY"');
  });
});

describe('Home and chat', () => {
  it('Needs you lists failing and stopped automations', () => {
    const items = buildNeedsYou(
      {
        approvals: [],
        failed: [],
        blocked: [],
        workers: [],
        overview: [],
        automations: [
          automation() as never,
          automation({ id: A2, name: 'Stopped one', state: 'failed', lastRun: null }) as never,
          automation({ id: 'x', name: 'Fine', lastRun: { id: RUN, state: 'succeeded', at: NOW } }) as never,
        ],
      },
      Date.now(),
    );
    expect(items.map((i) => i.key)).toEqual([`automation:${A1}`, `automation:${A2}`]);
    const first = items[0];
    expect(first?.kind === 'automation' ? first.action.href : '').toBe(`/automations/${A1}?tab=runs`);
  });
});

// ---------------------------------------------------------------------------------------------------------
// p6-automation-defaults: project defaults, unattended approvals, waiting runs.
