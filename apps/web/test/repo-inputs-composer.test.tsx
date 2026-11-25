// p19-repo-inputs-composer-workflows: the job composer's file field for REPOSITORY projects (upload + earlier
// outputs), the "never committed, read from in/ next to the checkout" note, the "makine güncellenmeli" state when no
// machine has repo-inputs-v1, and run files for a repository project's workflow run.
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDefinition, parseInputFiles, parsePreview } from '../src/api/composer';
import type { AuthState } from '../src/auth/AuthProvider';
import { emptyDraft, validateJob, validateWorkflow } from '../src/screens/composer/draft';
import { summarizeDraft } from '../src/diyalog/drafts/summary';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { createFormatter, messagesFor } from '@remyral/i18n';

configure({ asyncUtilTimeout: 5_000 });

const signedIn: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const W1 = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = '44444444-4444-4444-8444-444444444444';
const EARLIER = '33333333-3333-4333-8333-333333333333';
const WF = '22222222-2222-4222-8222-222222222222';
const RUN = '55555555-5555-4555-8555-555555555555';
const empty = { status: 200, body: { items: [], nextCursor: null } };

type Avail = { available: boolean; reason: string | null };

function preview(inputFiles: Avail | undefined): Record<string, unknown> {
  return {
    project: 'acme',
    hostExecution: false,
    sandboxProfile: 'container',
    issues: [],
    placement: null,
    runtimes: [{ runtime: 'codex', verdict: 'placed', eligible: [W1], feasible: [W1], summary: [] }],
    modelProfiles: [],
    sandbox: [{ profile: 'container', workers: [W1] }],
    limits: {},
    workers: [
      { id: W1, name: 'linux-1', state: 'online', connected: true, os: 'linux', arch: 'x64', tools: ['git'] },
    ],
    ...(inputFiles === undefined ? {} : { inputFiles }),
  };
}

function definition(runFiles: Avail): Record<string, unknown> {
  return {
    id: WF,
    project: 'acme',
    name: 'fanout',
    version: 3,
    description: null,
    inputs: [{ name: 'task', required: true, description: null }],
    nodes: [{ id: 'build', role: 'executor', runtime: 'codex', gate: false, dynamic: false }],
    edges: [],
    defaults: {
      runtime: 'codex',
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: {},
      repository: { url: 'https://github.com/acme/app.git', baseRef: 'main' },
    },
    runFiles,
  };
}

function routes(avail: Avail, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/projects': () => ({
      status: 200,
      body: {
        items: [
          {
            id: 'acme',
            name: 'Acme',
            kind: 'repository',
            createdAt: '2026-10-01T00:00:00.000Z',
            createdBy: null,
            members: 2,
            myRole: 'operator',
          },
        ],
      },
    }),
    'GET /api/projects/acme/git': () => ({
      status: 200,
      body: {
        config: {
          project: 'acme',
          version: 1,
          provider: 'github',
          repositoryUrl: 'https://github.com/acme/app.git',
          baseBranch: 'main',
          mergeMethod: 'squash',
          requireCi: true,
          ciTimeoutSec: 600,
          github: null,
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      },
    }),
    'GET /api/budgets': () => ({ status: 200, body: { items: [] } }),
    'POST /api/jobs/placement-preview': () => ({ status: 200, body: preview(avail) }),
    'POST /api/jobs': () => ({
      status: 201,
      body: { job: { id: NEW, project: 'acme', state: 'QUEUED', version: 2, priority: 0 } },
    }),
    [`GET /api/jobs/${NEW}`]: () => ({ status: 404, body: { error: 'job_not_found', message: 'x' } }),
    'GET /api/workflows': () => ({
      status: 200,
      body: {
        definitions: [
          {
            id: WF,
            project: 'acme',
            name: 'fanout',
            version: 3,
            nodes: 1,
            createdAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        runs: [],
      },
    }),
    [`GET /api/workflows/${WF}`]: () => ({ status: 200, body: definition(avail) }),
    [`POST /api/workflows/${WF}/runs`]: () => ({ status: 201, body: { runId: RUN } }),
    ...extra,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ready: Avail = { available: true, reason: null };
const update: Avail = { available: false, reason: 'inputs_worker_update' };

describe('repository projects: composer file field and workflow run files', { timeout: 30_000 }, () => {
  it('a repository job takes an upload and an earlier job’s outputs, with the scratch in/ note', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({ path: '/jobs/new', initialState: signedIn, routes: routes(ready) });
    await user.selectOptions(await screen.findByLabelText('Proje'), 'acme');
    expect(await screen.findByDisplayValue('https://github.com/acme/app.git')).toBeTruthy();
    // The repository fields stay; the file field joins them with the note.
    const note = await screen.findByTestId('dy-composer-repo-files-note');
    expect(note.textContent).toContain('checkout’un yanındaki');
    expect(note.textContent).toContain('commit edilmez');
    const field = screen.getByLabelText<HTMLInputElement>('Girdi dosyaları');
    expect(field.disabled).toBe(false);
    await user.upload(field, new File(['old design'], 'teklif.md', { type: 'text/markdown' }));
    expect(await screen.findByText('teklif.md')).toBeTruthy();
    await user.type(screen.getByLabelText('Şu işten devam et (isteğe bağlı)'), EARLIER);
    await user.type(screen.getByLabelText('Ajanın görevi'), 'Rebuild the proposal page like the old design');
    await waitFor(() => {
      expect(screen.getByTestId('where-summary').textContent).toContain('Codex');
    });
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/jobs')).toBe(true);
    });
    const sent = requests.find((r) => r.method === 'POST' && r.url === '/api/jobs')?.body as {
      spec: { repository?: { url: string } };
      inputs?: { name: string; contentBase64: string }[];
      continueFrom?: string;
      keptFilesFrom?: string;
    };
    expect(sent.spec.repository?.url).toBe('https://github.com/acme/app.git');
    expect(sent.inputs).toEqual([{ name: 'teklif.md', contentBase64: btoa('old design') }]);
    expect(sent.continueFrom).toBe(EARLIER);
    // A kept working directory is a workspace concept.
    expect(sent.keptFilesFrom).toBeUndefined();
  });

  it('no machine has repo-inputs-v1: the field is off and says “makine güncellenmeli”; a job without files still goes', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({ path: '/jobs/new', initialState: signedIn, routes: routes(update) });
    await user.selectOptions(await screen.findByLabelText('Proje'), 'acme');
    const warn = await screen.findByTestId('dy-composer-repo-files-update');
    expect(warn.textContent).toContain('makineler güncellenmeli');
    expect(warn.textContent).toContain('repo-inputs-v1');
    expect(screen.queryByTestId('dy-composer-repo-files-note')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Girdi dosyaları').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Şu işten devam et (isteğe bağlı)').disabled).toBe(true);
    await user.type(screen.getByLabelText('Ajanın görevi'), 'Fix the flaky test');
    await waitFor(() => {
      expect(screen.getByTestId('where-summary').textContent).toContain('Codex');
    });
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/jobs')).toBe(true);
    });
    const sent = requests.find((r) => r.method === 'POST' && r.url === '/api/jobs')?.body as Record<
      string,
      unknown
    >;
    expect(sent.inputs).toBeUndefined();
    expect(sent.continueFrom).toBeUndefined();
  });

  it('a repository workflow run takes run files (every AI step) and sends them with the run', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({ path: '/jobs/new', initialState: signedIn, routes: routes(ready) });
    await user.selectOptions(await screen.findByLabelText('Proje'), 'acme');
    await user.click(screen.getByRole('radio', { name: /Bir iş akışı/ }));
    await user.selectOptions(await screen.findByLabelText('İş akışı'), WF);
    const note = await screen.findByTestId('dy-composer-repo-files-note');
    expect(note.textContent).toContain('Her yapay zeka adımı');
    await user.type(screen.getByLabelText('task (gerekli)'), 'Add dark mode');
    await user.type(screen.getByLabelText('Şu işten devam et (isteğe bağlı)'), EARLIER);
    await user.click(screen.getByRole('button', { name: 'Çalıştırmayı başlat' }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url === `/api/workflows/${WF}/runs`)).toBe(true);
    });
    expect(
      requests.find((r) => r.method === 'POST' && r.url === `/api/workflows/${WF}/runs`)?.body,
    ).toMatchObject({ inputs: { task: 'Add dark mode' }, continueFrom: EARLIER });
  });

  it('a repository workflow without a repo-inputs-v1 machine: run files are off with the reason', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    renderApp({ path: '/jobs/new', initialState: signedIn, routes: routes(update) });
    await user.selectOptions(await screen.findByLabelText('Proje'), 'acme');
    await user.click(screen.getByRole('radio', { name: /Bir iş akışı/ }));
    await user.selectOptions(await screen.findByLabelText('İş akışı'), WF);
    expect((await screen.findByTestId('dy-composer-repo-files-update')).textContent).toContain(
      'makineler güncellenmeli',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Girdi dosyaları').disabled).toBe(true);
  });
});

describe('repository file rules (draft validation, wire, card)', () => {
  const file = { name: 'shot.png', sizeBytes: 10, contentBase64: 'AA==' };

  it('validates a repository job’s files: blocked → update reason; scheduled → refused; now → fine', () => {
    const base = { ...emptyDraft(), project: 'acme', prompt: 'x', runtime: 'codex', inputFiles: [file] };
    expect(validateJob(base, false, false).inputFiles).toBeUndefined();
    expect(validateJob(base, false, true).inputFiles).toContain('makine güncellenmeli');
    expect(validateJob({ ...base, when: 'cron' }, false, false).inputFiles).toContain('started now');
    expect(
      validateJob({ ...base, inputFiles: [], continueFrom: 'nope' }, false, false).continueFrom,
    ).toContain('UUID');
    // Nothing to send: never blocked.
    expect(validateJob({ ...base, inputFiles: [] }, false, true).inputFiles).toBeUndefined();
  });

  it('validates a repository run’s files the same way', () => {
    const base = { ...emptyDraft(), project: 'acme', workflowId: WF, continueFrom: EARLIER };
    expect(validateWorkflow(base, [], true, false, false).inputFiles).toBeUndefined();
    expect(validateWorkflow(base, [], true, false, true).inputFiles).toContain('makine güncellenmeli');
  });

  it('parses the availability from the preview and the definition (absent: older master)', () => {
    expect(parseInputFiles(update)).toEqual(update);
    expect(parseInputFiles({ available: 'yes' })).toBeUndefined();
    expect(parsePreview(preview(update)).inputFiles).toEqual(update);
    expect(parsePreview(preview(undefined)).inputFiles).toBeUndefined();
    expect(parseDefinition(definition(ready)).runFiles).toEqual(ready);
  });

  it('the workflow_run card lists the run files and, for a repository run, where the steps find them', () => {
    const t = messagesFor('tr');
    const s = summarizeDraft(
      {
        kind: 'workflow_run',
        payload: {
          workflowId: WF,
          workflow: 'fanout',
          version: 3,
          project: 'acme',
          continueFrom: EARLIER,
          repository: { source: 'project', url: 'https://github.com/acme/app.git' },
        },
      },
      t,
      createFormatter('tr'),
    );
    const files = s.details.find((d) => d.k === t.drafts.facts.inputFiles);
    expect(files?.v).toContain('33333333');
    expect(files?.v).toContain(t.repoFiles.card.runNote);
  });
});
