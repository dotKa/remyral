// p22-output-delivery (docs/design/p22-output-delivery.md): the composer's delivery choice reaches the job spec (and
// "run again"), and "Senden bekleyen" approves several merge decisions of one project together.
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { messagesFor } from '@remyral/i18n';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../src/api/approvals';
import type { OpsItem } from '../src/api/opsThread';
import { BulkMerges, mergeGroups } from '../src/diyalog/screens/needs/BulkMerges';
import { buildSpec, emptyDraft } from '../src/screens/composer/draft';
import { draftFromPrefill } from '../src/screens/composer/prefill';
import { fakeFetch, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const TR = messagesFor('tr');
const id = (n: number): string => `0000000${String(n)}-1f7a-4c3b-9e8d-2a1b3c4d5e71`;

function card(n: number, over: Partial<ApprovalRequest> = {}): OpsItem {
  return {
    id: `approval:${id(n)}`,
    type: 'approval:request',
    at: new Date().toISOString(),
    subject: null,
    unread: false,
    event: null,
    approval: {
      id: id(n),
      jobId: id(n + 50),
      project: 'sample-leads',
      kind: 'gate',
      action: 'git.merge',
      status: 'pending',
      ...over,
    } as ApprovalRequest,
  } as OpsItem;
}

function item(n: number, mergeState: string | null, files = 26): Record<string, unknown> {
  return {
    id: id(n),
    jobId: id(n + 50),
    title: `Lead paketi üret ${String(n)}`,
    stepUp: true,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    targetBranch: 'main',
    mergeState,
    conflictFiles: mergeState === 'conflicts' ? 2 : 0,
    ciState: 'none',
    files,
  };
}

beforeEach(() => {
  stubCookies('__Host-remyral_csrf=csrf-token');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('delivery choice (composer)', () => {
  it('outputs goes into a repository spec, never into a workspace spec; merge is the default and is left out', () => {
    const d = {
      ...emptyDraft(),
      project: 'p',
      runtime: 'codex',
      prompt: 'x',
      repoUrl: 'https://g/x.git',
      baseRef: 'main',
    };
    expect(buildSpec(d)).not.toHaveProperty('delivery');
    expect(buildSpec({ ...d, delivery: 'outputs' })).toMatchObject({ delivery: 'outputs' });
    expect(buildSpec({ ...d, delivery: 'outputs' }, true)).not.toHaveProperty('delivery');
  });

  it('"run again" keeps the delivery', () => {
    expect(draftFromPrefill({ project: 'p', spec: { delivery: 'outputs' } } as never).delivery).toBe(
      'outputs',
    );
    expect(draftFromPrefill({ project: 'p', spec: {} } as never).delivery).toBeUndefined();
  });
});

describe('bulk merge approval ("Senden bekleyen")', () => {
  it('groups open pending merge decisions per project, only from two on', () => {
    const cards = [
      card(1),
      card(2),
      card(3, { project: 'other' }),
      card(4, { action: 'deploy.request' }),
      card(5, { status: 'approved' }),
    ];
    const open = new Set(cards.map((c) => c.id));
    expect(mergeGroups(cards, open)).toEqual([{ project: 'sample-leads', cards: [cards[0], cards[1]] }]);
    expect(mergeGroups(cards, new Set([cards[0]?.id ?? '']))).toEqual([]);
  });

  it('lists the live merge check, leaves a known conflict unselected, approves the selection in one request', async () => {
    const user = userEvent.setup();
    const f = fakeFetch({
      'GET /api/approvals/merge-batch?project=sample-leads': () => ({
        status: 200,
        body: { items: [item(1, 'clean'), item(2, 'unknown'), item(3, 'conflicts')], max: 25 },
      }),
      'POST /api/approvals/merge-batch': () => ({
        status: 200,
        body: {
          results: [
            { id: id(1), outcome: 'approved', jobState: 'AWAITING_APPROVAL' },
            { id: id(2), outcome: 'refused', code: 'approval_expired', message: 'The approval expired.' },
          ],
        },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    const cards = [card(1), card(2), card(3)];
    const changed = vi.fn();
    render(
      <MemoryRouter>
        <BulkMerges cards={cards} open={new Set(cards.map((c) => c.id))} onChanged={changed} />
      </MemoryRouter>,
    );
    const section = screen.getByTestId('dy-bulk-merges');
    expect(
      within(section).getByText(TR.outputDelivery.bulk.project({ project: 'sample-leads', n: 3 })),
    ).toBeTruthy();
    await user.click(screen.getByTestId('dy-bulk-merges-open'));
    const list = await screen.findByTestId('dy-bulk-merges-list');
    expect(list.textContent).toContain(TR.outputDelivery.bulk.state.clean);
    expect(list.textContent).toContain(TR.outputDelivery.bulk.state.unknown);
    expect(list.textContent).toContain(TR.outputDelivery.bulk.state.conflicts({ n: 2 }));
    const boxes = within(list).getAllByRole('checkbox');
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, true, false]);

    await user.click(screen.getByTestId('dy-bulk-merges-approve'));
    await waitFor(() => {
      expect(screen.getByTestId('dy-bulk-merges-summary').textContent).toBe(
        TR.outputDelivery.bulk.summary({ approved: 1, refused: 1 }),
      );
    });
    const post = f.requests.find((r) => r.method === 'POST');
    expect(post?.body).toEqual({ project: 'sample-leads', ids: [id(1), id(2)] });
    const results = screen.getAllByTestId('dy-bulk-merges-result').map((e) => e.textContent);
    expect(results).toEqual([
      TR.outputDelivery.bulk.result.approved,
      TR.outputDelivery.bulk.result.refused({ reason: 'The approval expired.' }),
    ]);
    // The approved card is marked decided on the page.
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0]?.[0]).toMatchObject({ approval: { id: id(1), status: 'approved' } });
  });

  it('shows nothing for a single merge decision', () => {
    const cards = [card(1)];
    render(
      <MemoryRouter>
        <BulkMerges cards={cards} open={new Set([cards[0]?.id ?? ''])} onChanged={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('dy-bulk-merges')).toBeNull();
  });
});
