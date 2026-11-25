import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDeployOnSuccess, safeHttpsUrl } from '../src/api/deployOnSuccess';
import { deployLines } from '../src/screens/chat/drafts';
import { deployError, deployOptions, deployRequest, NO_DEPLOY } from '../src/screens/composer/deploy';
import { buildTarget } from '../src/screens/automations/form';

/**
 * p6-deploy-on-success (ADR-0030): the job page's Deploy card (live link, reasons, the ops action), the composer's
 * request building, the chat draft card line and the automation job target.
 */

configure({ asyncUtilTimeout: 5_000 });

const JOB = '66666666-6666-4666-8666-666666666666';
const ACTION = '77777777-7777-4777-8777-777777777777';
const NOW = '2026-10-16T08:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function view(over: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    jobId: JOB,
    project: 'acme',
    target: 'pages',
    env: 'preview',
    directory: 'site',
    state: 'succeeded',
    reason: null,
    url: 'https://abc123.acme-site.pages.dev',
    opsActionId: ACTION,
    opsActionState: 'succeeded',
    covers: 'auto',
    approvedBy: { id: 'u1', username: 'alex' },
    approvedAt: NOW,
    stepUp: false,
    via: 'chat',
    createdAt: NOW,
    finishedAt: NOW,
    ...over,
  };
}

describe('deploy on success: shapes and requests', () => {
  it('parses the view and accepts only https links', () => {
    expect(parseDeployOnSuccess(view())?.state).toBe('succeeded');
    expect(parseDeployOnSuccess(null)).toBeNull();
    expect(() => parseDeployOnSuccess(view({ state: 'weird' }))).toThrow();
    expect(safeHttpsUrl('http://x.example')).toBeNull();
    expect(safeHttpsUrl('https://x.example/a')).toBe('https://x.example/a');
  });

  it('builds the composer request; off sends nothing; Pages needs a safe directory', () => {
    expect(deployRequest(NO_DEPLOY)).toBeUndefined();
    expect(deployRequest({ enabled: true, target: 'coolify', env: 'preview', directory: 'site' })).toEqual({
      target: 'coolify',
      env: 'preview',
    });
    expect(deployRequest({ enabled: true, target: 'pages', env: 'production', directory: ' out ' })).toEqual({
      target: 'pages',
      env: 'production',
      directory: 'out',
    });
    expect(deployError({ enabled: true, target: 'pages', env: 'preview', directory: '../x' })).not.toBeNull();
    expect(
      deployError({ enabled: true, target: 'pages', env: 'preview', directory: 'site/public' }),
    ).toBeNull();
  });

  it('offers what the project configured; production only with the project switch', () => {
    expect(deployOptions(null)).toEqual({
      pages: false,
      coolify: { preview: false, production: false },
      productionAllowed: false,
    });
    const o = deployOptions({
      coolify: { preview: { connection: null, uuids: ['a'], tags: [] }, production: null },
      pages: null,
      pagesProjects: [],
      dns: { zones: [], protectedNames: [] },
      policy: {
        previewDeploy: 'auto',
        productionDeploy: 'approval_step_up',
        dnsChange: 'approval',
        autoDeployProductionOnSuccess: true,
        pagesProject: 'approval',
        previewTunnel: 'auto',
        stableTunnel: 'approval',
      },
      previews: null,
    });
    expect(o).toEqual({
      pages: false,
      coolify: { preview: true, production: false },
      productionAllowed: true,
    });
  });

  it('the chat job draft card states the deploy and that confirming approves it', () => {
    expect(deployLines(undefined)).toEqual([]);
    expect(deployLines({ target: 'pages', env: 'preview', directory: 'site' })).toEqual([
      {
        label: 'Deploy',
        value:
          'Deploys to Cloudflare Pages (preview) from site/ when it succeeds — confirming approves the deploy',
      },
    ]);
  });

  it('automation job targets carry deployOnSuccess when on, null when switched off, nothing when untouched', () => {
    const base = {
      project: 'acme',
      target: 'job',
      runtime: 'codex',
      prompt: 'Build',
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      maxDurationMin: '60',
    };
    type F = Parameters<typeof buildTarget>[0];
    const on = buildTarget(
      {
        ...base,
        deploy: { enabled: true, target: 'pages', env: 'preview', directory: 'site' },
      } as unknown as F,
      null,
      {},
    );
    expect(on).toMatchObject({
      kind: 'job',
      deployOnSuccess: { target: 'pages', env: 'preview', directory: 'site' },
    });
    const off = buildTarget({ ...base, deploy: { ...NO_DEPLOY } } as unknown as F, null, {});
    expect(off).toMatchObject({ deployOnSuccess: null });
    const untouched = buildTarget({ ...base, deploy: NO_DEPLOY } as unknown as F, null, {});
    expect('deployOnSuccess' in untouched).toBe(false);
  });
});
