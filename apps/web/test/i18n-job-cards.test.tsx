// p14-i18n-screens-a (i18n Phase 5): the job thread cards (`diyalog/job/cards.tsx`, `previews.tsx`) come from the
// `jobCards` catalog — Turkish by default (diyalog-job keeps querying the Turkish text), English when the user's
// language is `en`.
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { type JobDetail, parseJobDetail } from '../src/api/jobs';
import { QueueCard } from '../src/diyalog/job/cards';
import type { JobCardProps } from '../src/diyalog/job/types';
import { I18nProvider } from '../src/i18n/I18nProvider';

const JOB = '7c1e09ab-0000-4000-8000-000000000001';
const iso = (minAgo: number): string => new Date(Date.now() - minAgo * 60_000).toISOString();

function queued(code: string): JobDetail {
  return parseJobDetail({
    job: {
      id: JOB,
      project: 'mobil-app',
      projectKind: 'repository',
      state: 'QUEUED',
      priority: 0,
      version: 1,
      leaseEpoch: 0,
      createdBy: { type: 'user', id: 'u1' },
      createdAt: iso(5),
      stateChangedAt: iso(5),
      spec: { runtime: 'claude-code', prompt: 'Upgrade to Vitest 5' },
    },
    transitions: [],
    attempts: [],
    leases: [],
    approvals: [],
    dependsOn: [],
    dependents: [],
    pause: null,
    pausedMs: 0,
    continueAvailable: false,
    orchestration: {
      schedule: { status: 'waiting', reasons: [{ code, message: '', until: iso(-90) }] },
      runs: [],
    },
  });
}

function props(detail: JobDetail): JobCardProps {
  return {
    detail,
    state: 'QUEUED',
    finished: false,
    canAct: true,
    reload: () => undefined,
    names: new Map(),
    onCancel: () => undefined,
    detailsHref: () => '#',
    continuity: null,
    memory: null,
  };
}

function inLocale(locale: 'tr' | 'en', ui: ReactNode) {
  return render(
    <I18nProvider locale={locale}>
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nProvider>,
  );
}

describe('job cards in English', () => {
  it('the deferred queue card speaks English', () => {
    inLocale('en', <QueueCard {...props(queued('deferred_off_peak'))} />);
    expect(screen.getByText('Deferred to the project’s off-peak hours')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start now' })).toBeTruthy();
    expect(screen.getByText('Deferred')).toBeTruthy();
    expect(screen.queryByText('Şimdi başlat')).toBeNull();
  });

  it('the limit-wait queue card speaks English, Turkish stays the default', () => {
    inLocale('en', <QueueCard {...props(queued('usage_limited'))} />);
    expect(screen.getByText('Waiting for a limit')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start now' })).toBeNull();
  });

  it('keeps the Turkish copy for Turkish users', () => {
    inLocale('tr', <QueueCard {...props(queued('deferred_off_peak'))} />);
    expect(screen.getByRole('button', { name: 'Şimdi başlat' })).toBeTruthy();
    expect(screen.getByText('Ertelendi')).toBeTruthy();
    expect(screen.queryByText('Deferred to the project’s off-peak hours')).toBeNull();
  });
});
