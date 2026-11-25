// p14-i18n-foundation: the i18n guards — catalog parity read from the TypeScript sources, and the hard-coded string
// ratchet over the Diyalog console.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  avoidedWords,
  checkCatalogs,
  compareTrees,
  constStringArray,
  constStringArrayRecord,
  glossaryProblems,
  masterErrorProblems,
  messageTree,
  reasonProblems,
  turkishTexts,
} from '../i18n/check-catalogs.mjs';
import { masterErrorCodes, masterErrorSites } from '../i18n/master-errors.mjs';
import { countStrings, inventory, looksLikeProse, ratchet } from '../i18n/inventory.mjs';

describe('check-catalogs', () => {
  const tr = messageTree(
    'tr/x.ts',
    `export default {
      a: 'İşler',
      b: { c: 'Merhaba {name}' },
      f: (p: { n: number; name: string }) => \`\${String(p.n)} \${p.name}\`,
    };`,
  );

  it('the real catalogs match', { timeout: 120_000 }, () => {
    const r = checkCatalogs();
    expect(r.problems).toEqual([]);
    expect(r.namespaces).toBeGreaterThanOrEqual(3);
  });

  it('reads keys, kinds, placeholders and typed parameters', () => {
    expect(tr.problems).toEqual([]);
    expect([...tr.tree.keys()]).toEqual(['a', 'b.c', 'f']);
    expect(tr.tree.get('f')).toMatchObject({ kind: 'function', params: ['n', 'name'] });
  });

  it('reports missing, extra, mistyped, copied and placeholder-mismatched entries', () => {
    const en = messageTree(
      'en/x.ts',
      `import type { Shape } from '../shape.js';
       export default {
         a: 'İşler',
         b: { c: 'Hello {who}' },
         f: (p: { n: number }) => String(p.n),
         extra: 'x',
       } satisfies Shape<typeof tr>;`,
    );
    const problems = compareTrees('x', tr.tree, en.tree);
    expect(problems).toEqual([
      expect.stringContaining('x.a: en is a copy of tr'),
      expect.stringContaining('x.b.c: placeholders differ'),
      expect.stringContaining('x.f: parameters differ'),
      'x.extra: only in en',
    ]);
    const missing = compareTrees('x', tr.tree, new Map());
    expect(missing).toContain('x.a: missing in en');
    const kind = compareTrees('x', tr.tree, new Map([['a', { kind: 'function', params: null }]]));
    expect(kind).toContain('x.a: string in tr but function in en');
  });

  it('an untyped Turkish function and a non-catalog value are problems', () => {
    const bad = messageTree('tr/y.ts', 'export default { f: (p) => p, n: 3 };');
    expect(bad.problems).toEqual([expect.stringContaining('n must be a string')]);
    expect(compareTrees('y', bad.tree, bad.tree)).toEqual([
      'y.f: the Turkish message must type its parameter object',
    ]);
    expect(messageTree('tr/z.ts', 'export const x = 1;').problems).toEqual([
      'tr/z.ts: no `export default { … }` catalog object',
    ]);
  });

  it('glossary: rejected Turkish variants fail, whole words only', () => {
    const avoid = avoidedWords(`export const GLOSSARY = [{ concept: 'w', avoid: ['iş akışı', 'dal'] }];`);
    expect(avoid).toEqual(['iş akışı', 'dal']);
    const texts = turkishTexts(
      'tr/x.ts',
      "export default { a: 'Yeni İş Akışı', b: 'Dalga', c: `bir dal ${'x'}` };",
    );
    expect(glossaryProblems('tr/x.ts', texts, avoid)).toEqual([
      expect.stringContaining('“iş akışı”'),
      expect.stringContaining('“dal”'),
    ]);
  });

  it('owner style rule: no circumflex in Turkish copy ("zeka", "hala"; never the hatted forms)', () => {
    const texts = turkishTexts(
      'tr/x.ts',
      "export default { a: 'Yapay zek\u00e2', b: 'H\u00e2l\u00e2 bekliyor', c: 'Yapay zeka' };",
    );
    const problems = glossaryProblems('tr/x.ts', texts, []);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('no circumflex');
  });
});

describe('reason codes (p14-i18n-reasons)', () => {
  it('reads REASON_CODES and REASON_CAUSES from the sources', () => {
    expect(
      constStringArray('p.ts', "export const REASON_CODES = ['a', 'b_c'] as const;", 'REASON_CODES'),
    ).toEqual(['a', 'b_c']);
    const causes = constStringArrayRecord(
      'r.ts',
      "export const REASON_CAUSES = { x: ['y', 'z'] } as const satisfies Readonly<Record<string, readonly string[]>>;",
      'REASON_CAUSES',
    );
    expect([...causes]).toEqual([['x', ['y', 'z']]]);
  });

  it('reports missing codes, missing / unknown causes, a missing default and a wrong parameter', () => {
    const { tree } = messageTree(
      'tr/reasons.ts',
      `export default {
        codes: {
          a: (v: ReasonVars) => 'A',
          x: { default: (v: ReasonVars) => 'X', y: (v: ReasonVars) => 'Y', stray: (v: ReasonVars) => 'S' },
          w: { y: (v: ReasonVars) => 'W' },
          p: (p: { n: number }) => 'P',
        },
        actions: { open: 'Aç' },
      };`,
    );
    const problems = reasonProblems(
      tree,
      ['a', 'b', 'p'],
      new Map([
        ['x', ['y', 'z']],
        ['w', ['y']],
        ['a', ['q']],
      ]),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'reasons.codes.b: missing — the scheduler sends this code',
        'reasons.codes.x.z: missing — REASON_CAUSES lists cause `z`',
        expect.stringContaining('reasons.codes.x.stray: not a cause'),
        'reasons.codes.w: no `default` variant',
        expect.stringContaining('reasons.codes.a: needs variants'),
        'reasons.codes.p: takes (n), not (v: ReasonVars)',
      ]),
    );
    expect(problems).toHaveLength(6);
  });

  it('the real catalog covers every scheduler code and every cause', { timeout: 120_000 }, () => {
    const r = checkCatalogs();
    expect(r.reasonCount?.codes).toBeGreaterThanOrEqual(70);
    expect(r.reasonCount?.causes).toBeGreaterThanOrEqual(5);
  });
});

describe('inventory ratchet', () => {
  it('counts JSX text, text attributes and prose literals; skips code-like strings', () => {
    const src = `
      import { x } from './not-text';
      const KEYS = { home: 'home', label: 'Ana sayfa', icon: 'gear', cls: 'flex items-center gap-2' };
      export function A({ on }: { on: boolean }) {
        if (on === 'Not Counted') console.log('Not counted either');
        return (
          <div className="mt-2 text-dy-muted" aria-label="Yan menü" data-x="Some Thing">
            Merhaba dünya
            <span title={on ? 'İki kelime' : 'one'}>{'Tek başına metin'}</span>
            <b>{\`Sayı: \${String(1)} tane\`}</b>
            {/* i18n-ignore */}
            <i>Jobs</i> {/* i18n-ignore — sample */}
          </div>
        );
      }`;
    // JSX text "Merhaba dünya" + aria-label + 'İki kelime' + 'Tek başına metin' + the template + label 'Ana sayfa'.
    expect(countStrings('a.tsx', src)).toBe(6);
  });

  it('prose heuristic', () => {
    expect(looksLikeProse('Jobs')).toBe(true);
    expect(looksLikeProse('İşler')).toBe(true);
    expect(looksLikeProse('two words')).toBe(true);
    expect(looksLikeProse('min-h-10 rounded-[9px] border')).toBe(false);
    expect(looksLikeProse('remyral.locale')).toBe(false);
    expect(looksLikeProse('GET')).toBe(false);
    expect(looksLikeProse('camelCase')).toBe(false);
    expect(looksLikeProse('/api/me/locale')).toBe(false);
    expect(looksLikeProse('123')).toBe(false);
  });

  it('a file may only go down; a new file counts from zero', () => {
    const r = ratchet({ a: 3, b: 5, c: 1 }, { a: 4, b: 5, gone: 2 });
    expect(r.rises).toEqual([{ file: 'c', allowed: 0, now: 1 }]);
    expect(r.drops).toEqual([
      { file: 'a', allowed: 4, now: 3 },
      { file: 'gone', allowed: 2, now: 0 },
    ]);
  });

  it('scans the Diyalog tree (harness excluded)', () => {
    const files = inventory();
    const keys = Object.keys(files);
    // Phase 5 moves screens to the catalog, so the count only falls; the walk must still find the tree.
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.every((k) => k.startsWith('apps/web/src/diyalog/'))).toBe(true);
    expect(keys.some((k) => k.includes('/harness/'))).toBe(false);
  });
});

// p14-i18n-errors: every master error code has a catalog entry; params match the sentence's placeholders.
describe('master error codes', () => {
  const fixture = `
    import { HttpError } from '../http/errors.js';
    export function notFound(what: 'project' | 'user'): HttpError {
      return new HttpError(404, \`\${what}_not_found\`, \`The \${what} does not exist.\`);
    }
    function conflict(code: string, message: string): HttpError {
      return new HttpError(409, code, message);
    }
    export function f(err: { code: string }, admin: boolean, n: number) {
      if (admin) throw conflict('user_exists', 'A user with this username already exists.');
      if (n > 1) throw new HttpError(413, 'too_big', \`Larger than \${String(n)} KiB.\`, {}, {}, { max: n });
      if (n > 2) throw new HttpError(404, 'not_found', 'Worker not found.', {}, {}, { reason: 'worker' });
      if (n > 3) throw new HttpError(404, 'not_found', 'Ghost.', {}, {}, { reason: admin ? 'ghost' : 'worker' });
      if (n > 4) throw new HttpError(413, 'too_big', 'Too big.');
      throw new HttpError(400, admin ? 'partly_known' : err.code, 'x');
    }`;

  function sitesOf(src) {
    const dir = mkdtempSync(join(tmpdir(), 'i18n-errors-'));
    try {
      writeFileSync(join(dir, 'a.ts'), src);
      return masterErrorSites(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('resolves literal, union-typed template, helper-argument and partly dynamic codes', () => {
    const sites = sitesOf(fixture);
    expect(masterErrorCodes(sites)).toEqual([
      'not_found',
      'partly_known',
      'project_not_found',
      'too_big',
      'user_exists',
      'user_not_found',
    ]);
    expect(sites.find((s) => s.codes === null)).toMatchObject({ partial: ['partly_known'] });
    expect(sites.find((s) => s.params?.keys.includes('max'))).toMatchObject({
      codes: ['too_big'],
      message: 'template',
      params: { keys: ['max'], reason: null },
    });
  });

  it('reports missing codes, unknown variants, missing placeholders and unused catalog codes', () => {
    const tree = messageTree(
      'tr/errors.ts',
      `export default {
        not_found: { default: 'Bulunamadı.', worker: 'Makine bulunamadı.' },
        too_big: '{max} KiB sınırından büyük.',
        user_exists: 'Kullanıcı zaten var.',
        project_not_found: 'Proje yok.',
        user_not_found: 'Kullanıcı yok.',
        stale_code: 'Eski.',
      };`,
    ).tree;
    const problems = masterErrorProblems(sitesOf(fixture), tree);
    expect(problems).toEqual([
      expect.stringMatching(/^errors\.partly_known: missing — .*a\.ts:\d+ sends it$/),
      'errors.stale_code: no HttpError in apps/master/src sends this code',
      expect.stringMatching(/^errors\.not_found: no variant `ghost` \(params\.reason of .*a\.ts:\d+\)$/),
      expect.stringMatching(/^errors\.too_big: needs \{max\} but .*a\.ts:\d+ does not send params\.max$/),
    ]);
  });

  it('a literal message sent without params must be the English entry word for word', () => {
    const src = `
      import { HttpError } from '../http/errors.js';
      export function g(n: number) {
        if (n > 0) throw new HttpError(404, 'job_not_found', 'Job not found.');
        throw new HttpError(404, 'job_not_found', 'No such job here.');
      }`;
    const tree = messageTree('tr/errors.ts', `export default { job_not_found: 'İş bulunamadı.' };`).tree;
    const en = messageTree('en/errors.ts', `export default { job_not_found: 'Job not found.' };`).tree;
    expect(masterErrorProblems(sitesOf(src), tree, en)).toEqual([
      expect.stringMatching(
        /^errors\.job_not_found: English “Job not found\.” is not the message of .*a\.ts:5/,
      ),
    ]);
  });

  // Parses all of apps/master/src (≈ 600 files): slow on a loaded machine.
  it('the real master: at least the 238 planned codes, all in the catalog', { timeout: 120_000 }, () => {
    const r = checkCatalogs();
    expect(r.problems).toEqual([]);
    expect(r.errorCodes?.codes).toBeGreaterThanOrEqual(238);
    expect(r.errorCodes?.sites).toBeGreaterThanOrEqual(596);
  });
});
