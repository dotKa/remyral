// p14-web-perf-2: both catalogs, synchronously (registers English).
import '../src/all.js';
import { describe, expect, it } from 'vitest';
import { errorSentence, errorTemplate, fill, messagesFor, placeholdersOf } from '../src/index.js';

describe('fill (p16-api-tokens)', () => {
  it('fills every placeholder and leaves unknown ones', () => {
    expect(fill('{n} gün kaldı · {name}', { n: 3, name: 'ci' })).toBe('3 gün kaldı · ci');
    expect(fill('{a} {b}', { a: 'x' })).toBe('x {b}');
    expect(fill('no params', {})).toBe('no params');
  });
});

// p14-i18n-errors (i18n Phase 3): the master's error code + params said in the reader's language.
describe('master errors', () => {
  const tr = messagesFor('tr');
  const en = messagesFor('en');

  it('says a code with params in Turkish and English; numbers follow the locale', () => {
    const p = { name: 'notes.md', maxKib: 1536 };
    expect(errorSentence(tr, 'tr', 'attachment_too_large', p)).toBe('notes.md: 1.536 KiB sınırından büyük.');
    expect(errorSentence(en, 'en', 'attachment_too_large', p)).toBe('notes.md: larger than 1,536 KiB.');
  });

  it('params.reason picks a variant; no reason is `default`', () => {
    expect(errorSentence(tr, 'tr', 'not_found', { reason: 'project' })).toBe('Proje bulunamadı.');
    expect(errorSentence(tr, 'tr', 'not_found')).toBe('Bulunamadı.');
    expect(errorSentence(en, 'en', 'weak_password', { reason: 'too_short', min: 12 })).toBe(
      'Password must be at least 12 characters.',
    );
    // A code with a single sentence ignores a reason.
    expect(errorSentence(tr, 'tr', 'job_input_unavailable', { reason: 'x' })).toBe(
      'İş şu an mesaj alamıyor.',
    );
  });

  it('unknown code, unknown variant or a missing value → null (the caller shows the master message)', () => {
    expect(errorSentence(tr, 'tr', 'brand_new_code')).toBeNull();
    expect(errorSentence(tr, 'tr', 'not_found', { reason: 'brand_new_variant' })).toBeNull();
    expect(errorSentence(tr, 'tr', 'attachment_too_large', { name: 'a.md' })).toBeNull();
    expect(errorSentence(tr, 'tr', 'attachment_too_large', { name: 'a.md', maxKib: null })).toBeNull();
    expect(errorSentence(tr, 'tr', 'constructor')).toBeNull();
    expect(errorSentence(tr, 'tr', 'not_found', { reason: 'toString' })).toBeNull();
  });

  it('values are text only — never re-read as placeholders or markup', () => {
    expect(errorSentence(en, 'en', 'recipe_exists', { name: '<b>{x}</b>' })).toBe(
      'A custom tool named <b>{x}</b> exists already.',
    );
    expect(placeholdersOf('Part {part} of {last}')).toEqual(['part', 'last']);
    expect(errorTemplate(en, 'invalid_job', { reason: 'continue' })).toBe(
      'The job cannot be continued: {issues}',
    );
  });

  it('every Turkish variant has an English twin with the same placeholders', () => {
    const trTable = tr.errors as unknown as Record<string, string | Record<string, string>>;
    const enTable = en.errors as unknown as Record<string, string | Record<string, string>>;
    for (const [code, entry] of Object.entries(trTable)) {
      const other = enTable[code];
      if (typeof entry === 'string') {
        expect(typeof other, code).toBe('string');
        expect(placeholdersOf(other as string).sort(), code).toEqual(placeholdersOf(entry).sort());
      } else {
        for (const [k, v] of Object.entries(entry))
          expect(placeholdersOf((other as Record<string, string>)[k] ?? '').sort(), `${code}.${k}`).toEqual(
            placeholdersOf(v).sort(),
          );
      }
    }
    expect(Object.keys(trTable).length).toBeGreaterThanOrEqual(238);
  });
});
