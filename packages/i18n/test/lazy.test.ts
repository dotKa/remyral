import { describe, expect, it } from 'vitest';
import { EN_ERRORS, hasCatalog, loadCatalog, messagesFor } from '../src/messages.js';
import { masterErrorSentence } from '../src/errors.js';

// p14-web-perf-2: this file imports the catalogs module alone (not `all.js`), as the console does.
describe('catalogs load on demand (p14-web-perf-2)', () => {
  it('Turkish is there at once; English only after loadCatalog; an unloaded language answers in Turkish', async () => {
    expect(hasCatalog('tr')).toBe(true);
    expect(hasCatalog('en')).toBe(false);
    const tr = messagesFor('tr');
    expect(messagesFor('en')).toBe(tr); // fallback, and the load has started
    const en = await loadCatalog('en');
    expect(hasCatalog('en')).toBe(true);
    expect(messagesFor('en')).toBe(en);
    expect(en.nav).not.toEqual(tr.nav);
    expect(await loadCatalog('en')).toBe(en); // idempotent
  });

  it('the English error sentences are always bundled (the master-message guard works before English loads)', () => {
    expect(EN_ERRORS.workflow_not_found).toBe('Workflow not found.');
    expect(
      masterErrorSentence(messagesFor('tr'), 'tr', {
        code: 'workflow_not_found',
        message: 'Workflow not found.',
      }),
    ).toBe('Workflow bulunamadı.');
  });
});
