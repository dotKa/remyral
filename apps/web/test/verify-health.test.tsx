import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHealth, parseSiteHealth, parseVerification, screenshotUrl } from '../src/api/verify';
import { verifyLines } from '../src/screens/chat/drafts';

/**
 * p10-verify-health: the job page's Verification card (states, findings as text, screenshots from the artifact route,
 * "Deploy anyway" for admins with a step-up), the Deploys health card (probe, broken links, recheck), Project → Deploy
 * settings, the composer's choice, the chat card line and the parsers.
 */

configure({ asyncUtilTimeout: 5_000 });

const JOB = '66666666-6666-4666-8666-666666666666';
const VERIFIER = '88888888-8888-4888-8888-888888888888';
const NOW = '2026-10-18T08:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function verification(over: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    jobId: JOB,
    project: 'acme',
    mode: 'report',
    runtime: null,
    source: 'request',
    state: 'warned',
    outputType: 'site',
    verifierJobId: VERIFIER,
    verifierJobState: 'SUCCEEDED',
    checks: [
      { source: 'master', id: 'bundle-links', status: 'pass', detail: '2 page(s)' },
      { source: 'verifier', id: 'console', status: 'warn', detail: null },
    ],
    findings: [
      {
        source: 'verifier',
        severity: 'warn',
        kind: 'console',
        message: '<img src=x onerror=alert(1)> Uncaught TypeError',
        url: 'javascript:alert(1)',
      },
    ],
    screenshots: [
      { jobId: VERIFIER, artifactId: 'ws-v-desktop', name: 'verification/desktop.png', width: 1280 },
    ],
    summary: 'Looks fine.',
    reason: null,
    holdsDeploy: false,
    hasDeployOnSuccess: false,
    override: null,
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: NOW,
    ...over,
  };
}

describe('composer, chat card and parsers', () => {
  it('the chat card line', () => {
    expect(verifyLines('gate')[0]?.value).toContain('the deploy waits');
    expect(verifyLines(undefined)).toEqual([]);
    expect(verifyLines('nonsense')).toEqual([]);
  });

  it('parsers drop bad screenshot ids and unknown states', () => {
    const v = parseVerification(
      verification({
        screenshots: [
          { jobId: '../x', artifactId: 'ws-a' },
          { jobId: VERIFIER, artifactId: '../../etc' },
        ],
      }),
    );
    expect(v?.screenshots).toEqual([]);
    expect(() => parseVerification(verification({ state: 'great' }))).toThrow();
    expect(parseHealth(null)).toBeNull();
    expect(
      parseSiteHealth({
        id: 'h',
        state: 'passed',
        checkedAt: NOW,
        broken: 2,
        screenshot: { jobId: VERIFIER, artifactId: 'ws-x' },
      }),
    ).toMatchObject({ broken: 2, screenshot: { jobId: VERIFIER, artifactId: 'ws-x' } });
    expect(
      parseSiteHealth({
        id: 'h',
        state: 'passed',
        checkedAt: NOW,
        screenshot: { jobId: 'nope', artifactId: 'ws-x' },
      })?.screenshot,
    ).toBeNull();
    expect(screenshotUrl({ jobId: VERIFIER, artifactId: 'ws-a' })).toBe(
      `/api/jobs/${VERIFIER}/artifacts/ws-a?inline=1`,
    );
  });
});
