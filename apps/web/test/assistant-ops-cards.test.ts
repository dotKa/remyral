import { createFormatter, messagesFor } from '@remyral/i18n';
import { beforeAll, describe, expect, it } from 'vitest';
import { draftEvent } from '../src/diyalog/drafts/event';
import { draftKindText, summarizeDraft } from '../src/diyalog/drafts/summary';

/**
 * p18-assistant-gaps (docs/design/p18-assistant-gaps.md): the new administration cards — workflow run cancel and
 * approval decision, backups (a restore is always a card), the control-plane update, a template from a job, monitor
 * changes, a health re-check, a job question answer and the cost brake: their kind pill, facts and warnings in both
 * languages and the event that decides about the code (carried in the payload).
 */
const TR = messagesFor('tr');
// The English catalog loads with the test setup (as in assistant-admin.test.tsx).
let EN = messagesFor('tr');
let fmtEn = createFormatter('tr');
const fmtTr = createFormatter('tr');
beforeAll(() => {
  EN = messagesFor('en');
  fmtEn = createFormatter('en');
});
const card = (payload: Record<string, unknown>) => ({
  kind: 'settings_change',
  payload: { target: 'admin', ...payload },
});

describe('ops cards (p18-assistant-gaps)', () => {
  it('name their area instead of "Yönetim"', () => {
    expect(draftKindText('settings_change', TR, { target: 'admin', op: 'workflow.cancel_run' })).toBe(
      'Workflow',
    );
    expect(draftKindText('settings_change', TR, { target: 'admin', op: 'backup.restore' })).toBe('Yedek');
    expect(draftKindText('settings_change', EN, { target: 'admin', op: 'host.upgrade' })).toBe('Update');
    expect(draftKindText('settings_change', TR, { target: 'admin', op: 'job.answer_question' })).toBe(
      'İş sorusu',
    );
    expect(draftKindText('settings_change', EN, { target: 'admin', op: 'cost_brake.lift' })).toBe(
      'Cost brake',
    );
    // The p16 administration cards keep their name.
    expect(draftKindText('settings_change', TR, { target: 'admin', op: 'user.disable' })).toBe('Yönetim');
  });

  it('a workflow approval decision names the run, the step and the decision', () => {
    const s = summarizeDraft(
      card({
        op: 'workflow.decide_node',
        event: 'approvals.decide',
        workflow: 'release-train',
        node: 'gate',
        project: 'alpha',
        decision: 'approve',
        stepTitle: 'Ship to production?',
      }),
      TR,
      fmtTr,
    );
    expect(s.key).toEqual(
      expect.arrayContaining([
        { k: 'İşlem', v: 'Workflow onay adımına karar ver' },
        { k: 'Workflow', v: 'release-train', mono: true },
        { k: 'Adım', v: 'gate', mono: true },
        { k: 'Karar', v: 'Onayla' },
        { k: 'Proje', v: 'alpha' },
      ]),
    );
    expect(s.details).toEqual(expect.arrayContaining([{ k: 'Adımın başlığı', v: 'Ship to production?' }]));
    expect(
      draftEvent('settings_change', card({ op: 'workflow.decide_node', event: 'approvals.decide' }).payload),
    ).toBe('approvals.decide');
  });

  it('a restore is always a card with a danger warning; a drill names the newest backup', () => {
    const restore = summarizeDraft(
      card({
        op: 'backup.restore',
        backupId: '20261028T0300Z',
        cardOnly: 'always',
        event: 'backups.restore',
      }),
      EN,
      fmtEn,
    );
    expect(restore.key).toEqual(
      expect.arrayContaining([
        { k: 'Action', v: 'Restore the database from a backup' },
        { k: 'Backup', v: '20261028T0300Z', mono: true },
      ]),
    );
    expect(restore.warnings[0]).toMatchObject({ testId: 'admin-card-always', danger: true });
    const drill = summarizeDraft(card({ op: 'backup.drill', backupId: null }), TR, fmtTr);
    expect(drill.key).toEqual(expect.arrayContaining([{ k: 'Yedek', v: 'en yenisi', mono: true }]));
  });

  it('an update shows the versions and warns about breaking changes', () => {
    const s = summarizeDraft(
      card({
        op: 'host.upgrade',
        version: '1.5.0',
        fromVersion: '1.4.2',
        breaking: ['Drops the legacy API'],
        summary: 'Plans and IDE',
      }),
      EN,
      fmtEn,
    );
    expect(s.key).toEqual(expect.arrayContaining([{ k: 'Version', v: '1.4.2 → 1.5.0', mono: true }]));
    expect(s.details).toEqual(expect.arrayContaining([{ k: 'Release note', v: 'Plans and IDE' }]));
    expect(s.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ testId: 'admin-card-breaking', danger: true })]),
    );
    expect(s.warnings[0]?.text).toContain('Drops the legacy API');
  });

  it('a job question answer shows each question with the user’s answer', () => {
    const s = summarizeDraft(
      card({
        op: 'job.answer_question',
        project: 'alpha',
        questions: [
          { id: 'q1', prompt: 'Hangi ortam?' },
          { id: 'q2', prompt: 'Not?' },
        ],
        answers: [
          { id: 'q1', choices: ['staging'] },
          { id: 'q2', text: 'acele yok' },
        ],
      }),
      TR,
      fmtTr,
    );
    expect(s.key).toEqual(
      expect.arrayContaining([{ k: 'Yanıt', v: 'Hangi ortam?: staging\nNot?: acele yok' }]),
    );
  });

  it('monitor, template, health re-check and cost brake cards say what changes', () => {
    const m = summarizeDraft(
      card({ op: 'monitor.update', monitorName: 'shop', action: 'edit', patch: { intervalSec: 120 } }),
      EN,
      fmtEn,
    );
    expect(m.key).toEqual(expect.arrayContaining([{ k: 'Monitor', v: 'shop' }]));
    expect(m.details).toEqual(expect.arrayContaining([{ k: 'Changes', v: 'intervalSec: 120', mono: true }]));
    const t = summarizeDraft(
      card({ op: 'template.from_job', title: 'Weekly digest', promptPreview: 'Summarise {{topic}}' }),
      TR,
      fmtTr,
    );
    expect(t.key).toEqual(expect.arrayContaining([{ k: 'Şablon adı', v: 'Weekly digest' }]));
    expect(t.details).toEqual(expect.arrayContaining([{ k: 'İstem (başı)', v: 'Summarise {{topic}}' }]));
    const h = summarizeDraft(
      card({ op: 'deploy.health_recheck', url: 'https://shop.example.com' }),
      EN,
      fmtEn,
    );
    expect(h.key).toEqual(
      expect.arrayContaining([{ k: 'Address', v: 'https://shop.example.com', mono: true }]),
    );
    const lift = summarizeDraft(
      card({ op: 'cost_brake.lift', scope: 'global', hours: 4, reason: 'demo' }),
      TR,
      fmtTr,
    );
    expect(lift.key).toEqual(
      expect.arrayContaining([
        { k: 'Kapsam', v: 'tümü' },
        { k: 'Saat', v: '4' },
      ]),
    );
    const ceiling = summarizeDraft(
      card({ op: 'cost_brake.project_ceiling', ceilingProject: 'alpha', dailyUsd: 10, monthlyUsd: null }),
      EN,
      fmtEn,
    );
    expect(ceiling.key).toEqual(expect.arrayContaining([{ k: 'Ceiling (USD)', v: 'daily 10 · monthly —' }]));
  });
});
