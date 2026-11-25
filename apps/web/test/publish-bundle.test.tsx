import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { opsStatusText } from '../src/api/deploy';
import { parseDeployOnSuccess } from '../src/api/deployOnSuccess';
import { deployLines, publishChainLines } from '../src/screens/chat/drafts';
import { publishStateOf } from '../src/screens/composer/deploy';

/**
 * p10-publish-bundle: the console side of "publish with one approval" — the chain in the diff (create → deploy →
 * domain → CNAME), the Upload a site card (recent uploads after a reload; publish options → ONE pages.publish
 * request), the composer's "Publish to", the chat card's steps, the job's deploy card, the ops action page's real
 * status line, DNS "Run at once" and the Cloudflare test's per-zone DNS lines.
 */

configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NOW = '2026-10-18T08:00:00.000Z';
describe('ops action page', () => {
  it('status text per state', () => {
    expect(opsStatusText('awaiting_approval', 'approval')).toBe('Waits for approval');
    expect(opsStatusText('failed', 'approval')).toBe('Failed');
    expect(opsStatusText('denied', 'approval_step_up')).toBe('Denied');
    expect(opsStatusText('deploying', 'auto')).toBe('Deploying');
    expect(opsStatusText('executing', 'auto')).toBe('Running');
    expect(opsStatusText('expired', 'approval')).toBe('Expired');
    expect(opsStatusText('refused', 'refused', 'protected')).toBe('Refused: protected');
  });
});

describe('composer: Deploy when done → Publish to', () => {
  it('a stored publish request becomes the form state again (automations)', () => {
    expect(publishStateOf(null)).toEqual({});
    expect(
      publishStateOf({ pagesProject: 'x-site', createIfMissing: true, domain: 'x.demo.test', dns: 'auto' }),
    ).toEqual({ publish: { choice: '__new__', newName: 'x-site', domain: 'x.demo.test', dns: 'auto' } });
    expect(
      publishStateOf({ pagesProject: 'deck-site', createIfMissing: false, domain: null, dns: 'auto' }),
    ).toEqual({
      publish: { choice: 'deck-site', newName: '', domain: '', dns: 'auto' },
    });
  });
});

describe('chat job card: the whole chain', () => {
  it('lists every step that one confirmation approves', () => {
    const lines = deployLines({
      target: 'pages',
      env: 'production',
      directory: 'site',
      pagesProject: 'x-site',
      createIfMissing: true,
      domain: 'x.demo.test',
      dns: 'auto',
    });
    expect(lines[0]?.value).toContain('confirming approves every step below at once');
    expect(lines.slice(1)).toEqual([
      { label: 'Step 1', value: 'Create the Pages project x-site if it is missing' },
      { label: 'Step 2', value: 'Deploy the site (production) to x-site' },
      { label: 'Step 3', value: 'Attach the custom domain x.demo.test' },
      {
        label: 'Step 4',
        value: 'Write the CNAME x.demo.test → x-site.pages.dev (allowed zone of the project)',
      },
    ]);
    // The master's own chain lines win; a plain deploy has none.
    expect(publishChainLines({ chain: ['a', 'b'] }, 'preview')).toEqual(['a', 'b']);
    expect(publishChainLines({ target: 'pages' }, 'preview')).toEqual([]);
  });
});

describe('job page: a publish request', () => {
  it('older masters (no publish field) still parse', () => {
    const v = parseDeployOnSuccess({
      id: 'd1',
      jobId: 'j',
      project: 'p',
      target: 'pages',
      env: 'preview',
      directory: null,
      state: 'pending',
      reason: null,
      url: null,
      opsActionId: null,
      opsActionState: null,
      covers: 'auto',
      approvedBy: { id: 'u1', username: null },
      approvedAt: NOW,
      stepUp: false,
      via: 'api',
      createdAt: NOW,
      finishedAt: null,
    });
    expect(v?.publish).toBeNull();
  });
});
