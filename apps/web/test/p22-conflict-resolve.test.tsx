// p22-conflict-resolve: the job page's "Çakışmayı çöz" — shown when the verified result conflicts with its target, it
// opens the conflict-resolution job and hands its id to the page; the resolution's state is shown with a link.
import { configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AutoActivityPanel } from '../src/diyalog/job/AutoActivityPanel';
import { fakeFetch, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const JOB = '7c1e09ab-1111-4111-8111-111111111111';
const NEW = '8d2f10bc-2222-4222-8222-222222222222';
const base = { retry: null, fix: null, fixOf: null, conflictResolveOf: null, events: [] };

function show(body: Record<string, unknown>, canAct = true) {
  const f = fakeFetch({
    [`GET /api/jobs/${JOB}/autonomy`]: () => ({ status: 200, body: { ...base, ...body } }),
    [`POST /api/jobs/${JOB}/resolve-conflicts`]: () => ({ status: 201, body: { jobId: NEW } }),
  });
  vi.stubGlobal('fetch', f.fetch);
  stubCookies('__Host-remyral_csrf=t');
  const started: string[] = [];
  render(
    <MemoryRouter>
      <AutoActivityPanel
        jobId={JOB}
        state="AWAITING_APPROVAL"
        canAct={canAct}
        onResolveStarted={(id) => started.push(id)}
      />
    </MemoryRouter>,
  );
  return { requests: f.requests, started };
}

describe('p22-conflict-resolve: job page', () => {
  it('a conflicting result offers Çakışmayı çöz; it opens the resolution job', async () => {
    const r = show({ conflictResolve: null, conflictResolvable: true });
    const button = await screen.findByTestId('dy-job-conflict-resolve');
    expect(button.textContent).toContain('Çakışmayı çöz');
    await userEvent.click(button);
    await waitFor(() => {
      expect(r.started).toEqual([NEW]);
    });
    expect(r.requests.some((q) => q.method === 'POST' && q.url.endsWith('/resolve-conflicts'))).toBe(true);
  });

  it('a viewer sees the explanation without the button', async () => {
    show({ conflictResolve: null, conflictResolvable: true }, false);
    await screen.findByTestId('dy-job-conflict-resolvable');
    expect(screen.queryByTestId('dy-job-conflict-resolve')).toBeNull();
  });

  it('a merged resolution says the job was superseded and links the resolution job', async () => {
    show({
      conflictResolve: { resolveJobId: NEW, state: 'merged', reason: null, prClosed: true },
      conflictResolvable: false,
    });
    const line = await screen.findByTestId('dy-job-conflict-resolve-state');
    expect(line.textContent).toContain('Eski PR kapatıldı');
    expect(line.querySelector('a')?.getAttribute('href')).toBe(`/jobs/${NEW}`);
  });
});
