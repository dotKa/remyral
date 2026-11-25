// p14-i18n-screens-a (i18n Phase 5): the Sohbet draft cards (`diyalog/drafts/*`) and the chat composer's words
// (`diyalog/compose/*`) come from the `drafts` and `chatCompose` catalogs — Turkish by default (diyalog-drafts and
// chat tests keep querying the Turkish text), English when the user's language is `en`.
import { createFormatter, messagesFor } from '@remyral/i18n';
import { beforeAll, describe, expect, it } from 'vitest';
import { choiceWords } from '../src/diyalog/compose/labels';
import { matchCommands, slashCommands } from '../src/diyalog/compose/slash';
import {
  decisionText,
  draftKindText,
  jobActionEffect,
  roleText,
  summarizeDraft,
} from '../src/diyalog/drafts/summary';

// English is a lazy catalog: read it after test/setup.ts has loaded it (not at import time).
let EN = messagesFor('tr');
const TR = messagesFor('tr');
const ENF = createFormatter('en');
const TRF = createFormatter('tr');
beforeAll(() => {
  EN = messagesFor('en');
});
const JOB_A = '7c1e09ab-0000-4000-8000-0000000000a1';
const JOB_B = '7c1e09ab-0000-4000-8000-0000000000b2';

describe('draft summaries in English', () => {
  it('names the kinds and summarises a machine job with English facts', () => {
    expect(draftKindText('workflow_run', EN)).toBe('Workflow run');
    expect(draftKindText('machine_task', EN)).toBe('Machine administration job');
    expect(draftKindText('workflow_run', TR)).not.toBe('Workflow run');
    const payload = {
      workerName: 'atlas',
      approvalPolicy: 'allow-all',
      maxDurationSec: 1800,
      prompt: 'apt upgrade',
    };
    const en = summarizeDraft({ kind: 'machine_task', payload }, EN, ENF);
    const tr = summarizeDraft({ kind: 'machine_task', payload }, TR, TRF);
    expect(tr.key.find((f) => f.k === 'En uzun süre')?.v).toBe('30 dk');
    expect(en.key.map((f) => f.k)).toHaveLength(tr.key.length);
    for (const f of en.key) expect(f.k).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    expect(en.machineAdmin?.fullAccess).toBe(true);
  });

  it('job action effects use English plurals; Turkish keeps the singular noun', () => {
    const two = { action: 'cancel', jobs: [{ id: JOB_A }, { id: JOB_B }] };
    expect(jobActionEffect(two, TR)).toBe('İşaretli her iş iptal edilir; çalışan iş makinesinde durdurulur.');
    const en = jobActionEffect(two, EN);
    expect(en).toContain('is cancelled; a running job is stopped on its machine.');
    expect(en).not.toBe(jobActionEffect({ action: 'cancel', jobs: [{ id: JOB_A }] }, EN));
  });

  it('decisions and roles read in English', () => {
    expect(decisionText('approval_step_up', EN)).not.toBe(decisionText('approval_step_up', TR));
    expect(decisionText('refused', EN, 'no')).toContain('no');
    expect(roleText('reviewer', EN)).toBe('Review');
  });
});

describe('chat composer words in English', () => {
  it('slash commands keep their syntax and describe themselves in the user language', () => {
    const en = slashCommands(EN);
    const tr = slashCommands(TR);
    expect(en.map((c) => c.name)).toEqual(tr.map((c) => c.name));
    expect(en[0]?.hint).not.toBe(tr[0]?.hint);
    for (const c of en) expect(c.hint).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    expect(matchCommands('/iş', en)[0]?.name).toBe('/iş');
    expect(en.find((c) => c.name === '/makine')?.intent('')).toContain('describe_worker');
  });

  it('priority classes and approval modes read in English', () => {
    const en = choiceWords(EN);
    const tr = choiceWords(TR);
    expect(en.cls.background).not.toBe(tr.cls.background);
    expect(Object.keys(en.approval)).toEqual(Object.keys(tr.approval));
    for (const v of Object.values(en.approval)) expect(v.label).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
  });
});
