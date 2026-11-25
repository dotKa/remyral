// p16-workflow-quality: schedules in words with their zone ("her saat başı · Europe/Istanbul"), the time zone field of
// the automation form, the give-up line of a turn whose drafts failed validation, what a workflow card does to its
// triggers, and the run form's optional repository fields prefilled with the project's repository.
import { messagesFor } from '@remyral/i18n';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/api/chat';
import type { WorkflowDefinitionView } from '../src/api/composer';
import { draftInvalidNotice } from '../src/diyalog/chat/rows';
import { repositoryFact, triggerText, workflowTriggerNote } from '../src/diyalog/drafts/summary';
import { WorkflowFields } from '../src/diyalog/screens/composer/what';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { cronLine, cronWords, isTimeZone, scheduleSummary } from '../src/lib/schedule';
import { emptyDraft } from '../src/screens/composer/draft';
import { buildTrigger, EMPTY } from '../src/screens/automations/form';

const tr = messagesFor('tr');
/** English is a lazy chunk the setup loads before the first test (not at import time). */
const EN = () => messagesFor('en');

describe('schedules in words with their zone', () => {
  it('says the common cron shapes in Turkish and English, the rest as the expression', () => {
    const s = tr.workflowQuality.schedule;
    expect(cronLine('0 * * * *', 'Europe/Istanbul', s)).toBe('her saat başı · Europe/Istanbul');
    expect(cronWords('*/15 * * * *', s)).toBe('her 15 dakikada bir');
    expect(cronWords('30 * * * *', s)).toBe('her saat 30. dakikada');
    expect(cronWords('0 9 * * *', s)).toBe('her gün 09:00');
    expect(cronWords('0 9 * * 1-5', s)).toBe('hafta içi her gün 09:00');
    expect(cronWords('0 8 * * 1', s)).toBe('her pazartesi 08:00');
    expect(cronWords('0 8 1 * *', s)).toBeNull();
    expect(cronLine('0 8 1 * *', 'UTC', s)).toBe('0 8 1 * * · UTC');
    expect(cronLine('0 9 * * *', 'Europe/Istanbul', EN().workflowQuality.schedule)).toBe(
      'every day at 09:00 · Europe/Istanbul',
    );
    expect(
      scheduleSummary(
        {
          trigger: { kind: 'cron', cron: '0 * * * *' },
          triggerSummary: 'Every hour',
          timeZone: 'Europe/Istanbul',
        },
        s,
      ),
    ).toBe('her saat başı · Europe/Istanbul');
    expect(
      scheduleSummary({ trigger: { kind: 'webhook' }, triggerSummary: 'Signed webhook', timeZone: 'UTC' }, s),
    ).toBe('Signed webhook');
    expect(isTimeZone('Europe/Istanbul')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });

  it('the automation form sends the zone with a cron trigger (UTC is left out)', () => {
    expect(buildTrigger({ ...EMPTY, kind: 'cron', cron: '0 * * * *', timeZone: 'Europe/Istanbul' })).toEqual({
      kind: 'cron',
      cron: '0 * * * *',
      timeZone: 'Europe/Istanbul',
    });
    expect(buildTrigger({ ...EMPTY, kind: 'cron', cron: '0 * * * *', timeZone: 'UTC' })).toEqual({
      kind: 'cron',
      cron: '0 * * * *',
    });
  });

  it('a drafted zoned trigger reads in words on the card', () => {
    expect(triggerText({ kind: 'cron', cron: '0 * * * *', timeZone: 'Europe/Istanbul' }, tr)).toBe(
      'her saat başı · Europe/Istanbul',
    );
    expect(triggerText({ kind: 'cron', cron: '0 3 * * *' }, tr)).toBe('Cron 0 3 * * * (UTC)');
  });
});

describe('no junk cards', () => {
  const msg = (meta: Record<string, unknown>): ChatMessage =>
    ({
      id: 'm1',
      seq: 3,
      role: 'error',
      content: 'Draft invalid (workflow, 2 attempt(s)): nodes.0.type: invalid_value',
      meta,
      createdAt: '2026-10-23T10:00:00.000Z',
      turnId: 't1',
    }) as unknown as ChatMessage;

  it('the give-up line names the kind, the attempts and the last issues in the reader’s language', () => {
    const m = msg({
      notice: 'draft-invalid',
      drafts: [{ kind: 'workflow', attempts: 2, issues: ['nodes.0.type: invalid_value'] }],
    });
    expect(draftInvalidNotice(tr, m)).toBe(
      'Taslak geçersiz (Workflow taslağı, 2 deneme): nodes.0.type: invalid_value',
    );
    expect(
      draftInvalidNotice(
        EN(),
        msg({ notice: 'draft-invalid', drafts: [{ kind: 'automation', attempts: 1, issues: [] }] }),
      ),
    ).toBe('Draft invalid: did not pass validation');
    expect(draftInvalidNotice(tr, msg({ notice: 'chat-failover' }))).toBeNull();
  });

  it('a workflow card says that confirming turns its schedule on (or that it stays off)', () => {
    const payload = {
      activate: true,
      triggers: [
        { nodeId: 'every_hour', type: 'trigger.schedule' },
        { nodeId: 'hook', type: 'trigger.webhook' },
      ],
      schedules: [{ node: 'every_hour', timeZone: 'Europe/Istanbul', summary: 'Every hour', nextRuns: [] }],
      definition: { nodes: [{ id: 'every_hour', type: 'trigger.schedule', config: { cron: '0 * * * *' } }] },
    };
    expect(workflowTriggerNote(payload, tr)).toBe(
      'Onaylamak tetikleyicileri de açar: her saat başı · Europe/Istanbul, webhook',
    );
    expect(workflowTriggerNote({ ...payload, activate: false }, tr)).toContain('kapalı kalır');
    expect(workflowTriggerNote({ triggers: [] }, tr)).toBeNull();
    expect(repositoryFact({ source: 'none' }, tr)).toEqual([
      { k: 'Depo', v: 'Depo yok: adımlar kodsuz, geçici bir klasörde çalışır' },
    ]);
    expect(repositoryFact({ source: 'project', url: 'https://g.example/a.git' }, EN())[0]?.v).toBe(
      "Repository: the project's (https://g.example/a.git)",
    );
  });
});

describe('the run form: the repository is optional', () => {
  const def = (repository: WorkflowDefinitionView['defaults']['repository']): WorkflowDefinitionView => ({
    id: 'wf1',
    project: 'acme',
    name: 'reminder',
    version: 1,
    description: null,
    inputs: [],
    nodes: [{ id: 'write', role: 'executor', runtime: 'codex', gate: false, dynamic: false }],
    edges: [],
    defaults: { runtime: 'codex', sandboxProfile: 'container', approvalPolicy: 'ask-sensitive', repository },
  });
  function show(definition: WorkflowDefinitionView, projectRepoUrl: string | null) {
    const draft = { ...emptyDraft(), mode: 'workflow' as const, project: 'acme', workflowId: 'wf1' };
    return render(
      <MemoryRouter>
        <I18nProvider locale="tr">
          <WorkflowFields
            draft={draft}
            set={() => undefined}
            errors={{}}
            definitions={[]}
            definition={definition}
            definitionError={null}
            workspace={false}
            projectRepoUrl={projectRepoUrl}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
  }

  it('labels the fields optional and prefills the project’s repository as the fallback', () => {
    show(def(null), 'https://git.example/acme/app.git');
    const repo = screen.getByLabelText<HTMLInputElement>('Depo adresi (isteğe bağlı)');
    expect(repo.placeholder).toBe('https://git.example/acme/app.git');
    expect(screen.getByLabelText('Temel branch (isteğe bağlı)')).toBeTruthy();
    expect(screen.getByText('Boş bırakırsan projenin deposu: https://git.example/acme/app.git')).toBeTruthy();
  });

  it('without any repository it says the AI steps run without code; the workflow default wins', () => {
    show(def(null), null);
    expect(screen.getByText(/depo yoksa yapay zeka adımları kodsuz/)).toBeTruthy();
  });

  it('a workflow default repository is the placeholder', () => {
    show(
      def({ url: 'https://git.example/acme/own.git', baseRef: 'dev' }),
      'https://git.example/acme/app.git',
    );
    const repo = screen.getByLabelText<HTMLInputElement>('Depo adresi (isteğe bağlı)');
    expect(repo.placeholder).toBe('https://git.example/acme/own.git');
  });
});
