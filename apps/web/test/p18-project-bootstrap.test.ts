import { createFormatter, messagesFor } from '@remyral/i18n';
import { beforeAll, describe, expect, it } from 'vitest';
import { draftEvent } from '../src/diyalog/drafts/event';
import { draftKindText, summarizeDraft } from '../src/diyalog/drafts/summary';

/**
 * p18-project-bootstrap (docs/design/p18-project-bootstrap.md): the project setup cards — a project's network access
 * (now → after, a warning when it opens access) and its machines (assign, take off, preferred) — in both languages,
 * with the event carried in the payload.
 */
const TR = messagesFor('tr');
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

describe('project setup cards (p18-project-bootstrap)', () => {
  it('name their area', () => {
    expect(draftKindText('settings_change', TR, { target: 'admin', op: 'project.network' })).toBe(
      'Proje kurulumu',
    );
    expect(draftKindText('settings_change', EN, { target: 'admin', op: 'project.machines' })).toBe(
      'Project setup',
    );
  });

  it('a network card shows now → after and warns when it opens access', () => {
    const payload = {
      op: 'project.network',
      event: 'projects.policy',
      cardOnly: 'default',
      project: 'sample-leads',
      mode: 'allowlist',
      presets: ['npm', 'github'],
      hosts: ['api.stripe.com'],
      previous: { mode: 'none', presets: [], hosts: [] },
    };
    const s = summarizeDraft(card(payload), TR, fmtTr);
    expect(s.key).toEqual(
      expect.arrayContaining([
        { k: 'İşlem', v: 'Projenin ağ erişimi' },
        { k: 'Proje', v: 'sample-leads' },
        { k: 'Şu an', v: 'Kapalı (yalnızca model API’leri) · liste yok' },
        { k: 'Ağ erişimi', v: 'Yalnızca izin verilenler · npm, github, api.stripe.com' },
      ]),
    );
    expect(s.warnings[0]).toMatchObject({ testId: 'admin-card-loosens' });
    expect(s.warnings[0]?.text).toMatch(/ağ erişimi açar/);
    const en = summarizeDraft(card(payload), EN, fmtEn);
    expect(en.warnings[0]?.text).toMatch(/opens network access/);
    expect(draftEvent('settings_change', card(payload).payload)).toBe('projects.policy');
  });

  it('a machines card names the machines by name and the preferred set', () => {
    const s = summarizeDraft(
      card({
        op: 'project.machines',
        event: 'machines.config',
        project: 'sample-leads',
        add: ['wrk_a'],
        remove: ['wrk_b'],
        preferred: ['wrk_a'],
        previousPreferred: [],
        names: { wrk_a: 'ip-10-0-0-11', wrk_b: 'WIN-WORKER-9' },
      }),
      TR,
      fmtTr,
    );
    expect(s.key).toEqual(
      expect.arrayContaining([
        { k: 'Atanacak makineler', v: 'ip-10-0-0-11' },
        { k: 'Çıkarılacak makineler', v: 'WIN-WORKER-9' },
        { k: 'Tercih edilen makineler', v: 'ip-10-0-0-11' },
      ]),
    );
    expect(s.warnings).toEqual([]);
    const cleared = summarizeDraft(
      card({ op: 'project.machines', project: 'p', add: [], remove: [], preferred: [], names: {} }),
      EN,
      fmtEn,
    );
    expect(cleared.key).toEqual(expect.arrayContaining([{ k: 'Preferred machines', v: 'no preference' }]));
  });
});
