// p14-i18n-screens-a (i18n Phase 5): the job page frame (header pill, step bar, activity log and its system lines, the
// agent message box, the approval-mode words, the account switch) comes from the `job` catalog — Turkish by default
// (unchanged), English when the user's language is `en`.
import { render, screen } from '@testing-library/react';
import { messagesFor } from '@remyral/i18n';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { type JobDetail, parseJobDetail } from '../src/api/jobs';
import { type EventItem, parseEvent } from '../src/api/live';
import { ActivityLog } from '../src/diyalog/job/ActivityLog';
import { applicationText, lastChangeText, modeLabel } from '../src/diyalog/job/ApprovalModePanel';
import { JobComposer } from '../src/diyalog/job/JobComposer';
import { jobStatePill } from '../src/diyalog/job/JobHeader';
import { logRows } from '../src/diyalog/job/log';
import {
  accountSwitchText,
  buildJobThread,
  eventLine,
  toolStatus,
  transitionLine,
} from '../src/diyalog/job/mapping';
import { StepBar } from '../src/diyalog/job/StepBar';
import { jobSteps } from '../src/diyalog/job/steps';
import { createFormatter } from '@remyral/i18n';
import { I18nProvider } from '../src/i18n/I18nProvider';

// English is a lazy catalog: read it after test/setup.ts has loaded it.
let EN = messagesFor('tr');
beforeAll(() => {
  EN = messagesFor('en');
});
const EN_FORMAT = createFormatter('en');
const JOB = '7c1e09ab-0000-4000-8000-000000000001';
const W = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = Date.now();
const iso = (minAgo: number): string => new Date(NOW - minAgo * 60_000).toISOString();

function transition(id: string, from: string | null, to: string, minAgo: number, over = {}) {
  return {
    id,
    version: Number(id),
    from,
    to,
    trigger: 't',
    actor: { type: 'worker', id: W },
    reason: null,
    epoch: 1,
    occurredAt: iso(minAgo),
    ...over,
  };
}

function detail(state: string, transitions: unknown[], over: Record<string, unknown> = {}): JobDetail {
  return parseJobDetail({
    job: {
      id: JOB,
      project: 'mobil-app',
      projectKind: 'repository',
      state,
      priority: 0,
      version: 6,
      leaseEpoch: 1,
      createdBy: { type: 'user', id: 'u1' },
      createdAt: iso(21),
      stateChangedAt: iso(19),
      spec: { runtime: 'claude-code', prompt: 'Upgrade to Vitest 5' },
    },
    transitions,
    attempts: [],
    leases: [],
    approvals: [],
    dependsOn: [],
    dependents: [],
    pause: null,
    pausedMs: 0,
    continueAvailable: false,
    ...over,
  });
}

const running = (): JobDetail =>
  detail('RUNNING', [
    transition('1', null, 'QUEUED', 21, { actor: { type: 'user', id: 'u1' }, epoch: null }),
    transition('2', 'QUEUED', 'RESERVED', 20.9),
    transition('3', 'RESERVED', 'RUNNING', 20),
  ]);

function en(ui: ReactNode): ReturnType<typeof render> {
  return render(
    <I18nProvider locale="en">
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nProvider>,
  );
}

describe('job page frame in English', () => {
  it('says the state pill, steps and system lines in English (Turkish stays the default)', () => {
    expect(jobStatePill('RUNNING', true, true, EN).label).toBe('Awaiting approval, stale');
    expect(jobStatePill('SUCCEEDED').label).toBe('Bitti');

    const names = new Map([[W, 'mac-1']]);
    const d = running();
    const assigned = d.transitions[1];
    expect(assigned === undefined ? null : transitionLine(assigned, d, names, EN, 'en')?.text).toBe(
      'Assigned to mac-1',
    );
    expect(assigned === undefined ? null : transitionLine(assigned, d, names)?.text).toBe(
      'mac-1 makinesine atandı',
    );

    const steps = jobSteps(d, 'RUNNING', {}, EN, EN_FORMAT);
    expect(steps.map((s) => s.label)).toEqual(['Queue', 'Started', 'Done']);
    expect(steps[1]?.note).toBe('running');

    expect(toolStatus({ result: { ok: true, output: 'a\nb', at: '' } }, EN).text).toBe('2 lines');
    expect(toolStatus({ result: null }).text).toBe('çalışıyor');

    expect(
      accountSwitchText('account switch by a person: continuing with account Team in the same workspace', EN),
    ).toBe('Account switched by hand → Team');
  });

  it('builds the activity log rows in English', () => {
    const d = running();
    const items = buildJobThread({
      detail: d,
      events: [
        parseEvent({
          type: 'event',
          seq: 1,
          attemptId: 'att1',
          attemptNo: 1,
          workerSeq: 1,
          kind: 'memory',
          payload: { title: 'vite is pinned' },
          ts: iso(10),
          approval: null,
          hints: null,
        }),
      ],
      messages: EN,
      locale: 'en',
    });
    const rows = logRows(
      items,
      [],
      [
        {
          id: 'm1',
          text: 'also run lint',
          status: 'sent',
          code: null,
          detail: null,
          receipts: false,
          createdAt: iso(1),
        },
      ],
      EN,
    );
    const texts = rows.flatMap((r) => (r.kind === 'text' ? [r.text] : []));
    expect(texts).toContain('Prompt: Upgrade to Vitest 5');
    expect(texts).toContain('Queued, waiting for a machine');
    expect(texts).toContain('Noted to memory: vite is pinned');
    expect(texts).toContain('Sent to the agent: also run lint');
  });

  it('names approval modes and how a change applied in English', () => {
    expect(modeLabel('ask-all', EN)).toBe('Ask before every action');
    expect(modeLabel('ask-all')).toBe('Her adımda sor');
    expect(applicationText({ delivery: 'sent', application: 'gate' }, EN)).toBe(
      'Enforced by the machine’s approval gate.',
    );
    expect(
      lastChangeText(
        {
          id: 'c1',
          from: 'ask-all',
          to: 'allow-all',
          actor: { id: 'u1', username: 'alex' },
          reason: null,
          delivery: 'sent',
          application: 'live',
          detail: null,
          pendingResolved: 2,
          createdAt: iso(1),
        } as unknown as Parameters<typeof lastChangeText>[0],
        EN,
      ),
    ).toBe('Applied live by the runtime. 2 pending approvals were settled by the new mode.');
  });

  it('renders the step bar and the activity log in English', () => {
    const d = running();
    const rows = logRows(buildJobThread({ detail: d, events: [], messages: EN, locale: 'en' }), [], [], EN);
    en(
      <>
        <StepBar steps={jobSteps(d, 'RUNNING', {}, EN, EN_FORMAT)} />
        <ActivityLog
          rows={rows}
          runtime="claude-code"
          now="Claude Code is working"
          partial
          logsHref="?view=details&tab=logs"
          onApproval={() => undefined}
        />
      </>,
    );
    expect(screen.getByRole('navigation', { name: 'Job steps' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Activity log/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Log filter' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Tools/ })).toBeTruthy();
    expect(screen.getByPlaceholderText('Search the log')).toBeTruthy();
    expect(screen.getByText(/Older events are not in this log/)).toBeTruthy();
    expect(screen.queryByText(/Akış günlüğü/)).toBeNull();
    expect(screen.queryByText('Hepsi')).toBeNull();
  });

  it('renders the agent box of a queued job in English', () => {
    en(
      <JobComposer
        detail={detail('QUEUED', [transition('1', null, 'QUEUED', 1)])}
        state="QUEUED"
        canAct
        retired={false}
        onSent={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByText('Queued; it starts once a machine is found.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel job' })).toBeTruthy();
    expect(screen.queryByText(/Kuyrukta/)).toBeNull();
  });
});

describe('job secret references not injected (timeline line, by code)', () => {
  const event = (code: string, message: string): EventItem => ({
    type: 'event',
    seq: 1,
    attemptId: 'a',
    attemptNo: 1,
    workerSeq: 1,
    kind: 'error',
    payload: { kind: 'error', code, message },
    ts: '2026-10-12T10:00:00.000Z',
    approval: null,
    hints: null,
  });

  it('says which variables were not set and why, in the user’s language; other errors unchanged', () => {
    const en = messagesFor('en');
    const tr = messagesFor('tr');
    const withheld = event(
      'secret_refs_withheld',
      'DATABASE_URL, GIT — not set: the project does not give …',
    );
    expect(eventLine(withheld, en)?.text).toBe(
      en.job.thread.secretRefsWithheld({ names: 'DATABASE_URL, GIT' }),
    );
    expect(eventLine(withheld, tr)?.text).toContain('DATABASE_URL, GIT');
    expect(eventLine(withheld, tr)?.text).toContain('Ortam değişkeni verilmedi');
    const local = event('secret_refs_not_exposed', 'MINE — not set: this machine …');
    expect(eventLine(local, en)?.text).toBe(en.job.thread.secretRefsNotExposed({ names: 'MINE' }));
    expect(eventLine(event('other', 'boom'), en)?.text).toBe(
      en.job.thread.error({ code: 'other', message: 'boom' }),
    );
  });
});
