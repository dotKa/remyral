import { describe, expect, it } from 'vitest';
import {
  bestLexical,
  bestSemantic,
  classify,
  extractChatLearnings,
  extractLearnings,
  fingerprint,
  isDecision,
  jaccard,
  LEXICAL_THRESHOLDS,
  normalizeLearning,
  SEMANTIC_THRESHOLDS,
  semanticThresholds,
} from '../../src/memory-suggestions/index.js';
import { wordSet } from '../../src/memory-suggestions/dedupe.js';
import { cut, MAX_LEARNINGS, titleOf } from '../../src/memory-suggestions/extract.js';
import { cleanLearning, suggestionSnippet } from '../../src/memory-suggestions/service.js';

/** p10-semantic-memory (docs/design/p10-semantic-memory.md §4–5): the deterministic pass and the dedupe rules. */

describe('extractLearnings (unit)', () => {
  it('reads explicit MEMORY / HAFIZA / ÖĞRENİM lines (the agent-summary format)', () => {
    const out = extractLearnings(
      [
        'Done. Summary below.',
        'MEMORY: Uses pnpm — the repository is a pnpm workspace; run pnpm -r build before tests.',
        '- HAFIZA: Relackout marka rengi #FF5A1F, ikincil renk #1B1B1F.',
        'ÖĞRENİM: Staging deploy için önce `pnpm db:migrate` çalıştırılmalı.',
        '**Learning:** Windows workers need long paths enabled.',
      ].join('\n'),
    );
    expect(out.map((l) => l.rule)).toEqual(['marker', 'marker', 'marker', 'marker', 'package-manager']);
    expect(out[0]).toEqual({
      rule: 'marker',
      title: 'Uses pnpm',
      content: 'Uses pnpm — the repository is a pnpm workspace; run pnpm -r build before tests.',
    });
    expect(out[1]?.content).toBe('Relackout marka rengi #FF5A1F, ikincil renk #1B1B1F.');
    expect(out[2]?.content).toContain('pnpm db:migrate');
    expect(out[3]?.content).toBe('Windows workers need long paths enabled.');
  });

  it('reads bullets under a Learnings / Öğrenimler heading until the next heading', () => {
    const out = extractLearnings(
      [
        '## What I did',
        '- changed the footer',
        '## Öğrenimler',
        '- Testler `pnpm vitest run` ile koşuyor.',
        '- E2E testleri için Playwright tarayıcısı gerekiyor.',
        '## Next steps',
        '- open a PR',
      ].join('\n'),
    );
    const section = out.filter((l) => l.rule === 'section').map((l) => l.content);
    expect(section).toEqual([
      'Testler `pnpm vitest run` ile koşuyor.',
      'E2E testleri için Playwright tarayıcısı gerekiyor.',
    ]);
    expect(section.join(' ')).not.toMatch(/footer|open a PR/);
  });

  it('detects exactly one package manager (ambiguous summaries propose nothing) and verification commands', () => {
    const pnpm = extractLearnings(
      'Installed deps with `pnpm install` and ran `pnpm test` and `pnpm lint`: green.',
    );
    expect(pnpm.find((l) => l.rule === 'package-manager')).toMatchObject({ title: 'Uses pnpm' });
    expect(pnpm.find((l) => l.rule === 'command')?.content).toBe(
      'Verify changes with `pnpm test`, `pnpm lint`.',
    );
    const both = extractLearnings('Migrated from yarn install to pnpm install; removed yarn.lock.');
    expect(both.filter((l) => l.rule === 'package-manager')).toEqual([]);
    const py = extractLearnings('Ran `uv sync` then `uv run pytest -q` — all tests pass.');
    expect(py.find((l) => l.rule === 'package-manager')?.title).toBe('Uses uv');
  });

  it('finds brand colours and deploy requirements in Turkish and English sentences', () => {
    const out = extractLearnings(
      [
        'Updated the landing page. The Relackout brand colour is #FF5A1F and the accent is #222.',
        'Coolify deploy requires the PUBLIC_URL variable to be set first.',
        'Canlıya dağıtım için Cloudflare Pages projesinin önceden oluşturulması gerekiyor.',
        'The weather was nice.',
      ].join('\n'),
    );
    expect(out.map((l) => l.rule)).toEqual(['color', 'deploy-note', 'deploy-note']);
    expect(out[0]?.content).toBe('The Relackout brand colour is #FF5A1F and the accent is #222.');
    expect(out[2]?.content).toContain('Cloudflare Pages');
  });

  it('caps the number and length of learnings and ignores an empty summary', () => {
    const many = Array.from(
      { length: 12 },
      (_, i) => `MEMORY: Fact number ${String(i)} about the build pipeline.`,
    );
    expect(extractLearnings(many.join('\n'))).toHaveLength(MAX_LEARNINGS);
    const long = extractLearnings(`MEMORY: ${'word '.repeat(300)}`);
    expect(long[0]?.content.length).toBeLessThanOrEqual(500);
    expect(long[0]?.title.length).toBeLessThanOrEqual(80);
    expect(extractLearnings('')).toEqual([]);
    expect(extractLearnings('MEMORY: same fact.\nMEMORY: Same   fact')).toHaveLength(1);
  });

  it('titles, cuts and fingerprints are stable', () => {
    expect(titleOf('Deploy target X needs Y: set the env first')).toBe('Deploy target X needs Y');
    expect(cut('a'.repeat(10), 5)).toBe('aaaa…');
    expect(normalizeLearning('  Bu depo **PNPM** kullanıyor.  ')).toBe('bu depo pnpm kullanıyor');
    expect(fingerprint('Uses pnpm.')).toBe(fingerprint('uses   PNPM'));
    expect(fingerprint('Uses pnpm')).not.toBe(fingerprint('Uses yarn'));
    expect(fingerprint('x')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('dedupe thresholds (unit)', () => {
  it('classifies scores against duplicate / related thresholds', () => {
    expect(classify(0.95, SEMANTIC_THRESHOLDS)).toBe('duplicate');
    expect(classify(0.9, SEMANTIC_THRESHOLDS)).toBe('duplicate');
    expect(classify(0.85, SEMANTIC_THRESHOLDS)).toBe('related');
    expect(classify(0.5, SEMANTIC_THRESHOLDS)).toBe('new');
    expect(classify(Number.NaN, SEMANTIC_THRESHOLDS)).toBe('new');
    expect(semanticThresholds(0.85)).toEqual({ duplicate: 0.85, related: expect.closeTo(0.73, 5) as number });
    expect(() => semanticThresholds(1)).toThrow(RangeError);
    expect(() => semanticThresholds(0)).toThrow(RangeError);
  });

  it('lexical similarity: Jaccard over normalised word sets', () => {
    expect(jaccard(wordSet('Uses pnpm workspace'), wordSet('uses PNPM workspace!'))).toBe(1);
    expect(jaccard(wordSet(''), wordSet('x y'))).toBe(0);
    const best = bestLexical('This repository uses pnpm for installs', [
      { id: 'b', text: 'Deploy needs the staging secret' },
      { id: 'a', text: 'The repository uses pnpm for installs and scripts' },
    ]);
    expect(best?.id).toBe('a');
    expect(classify(best?.score ?? 0, LEXICAL_THRESHOLDS)).toBe('related');
    expect(bestLexical('x', [])).toBeNull();
  });

  it('semantic best match is the highest cosine; ties go to the smaller id', () => {
    const best = bestSemantic(
      [1, 0],
      [
        { id: 'z', embedding: [0.6, 0.8] },
        { id: 'b', embedding: [1, 0] },
        { id: 'a', embedding: [1, 0] },
      ],
    );
    expect(best).toEqual({ id: 'a', score: 1 });
    expect(bestSemantic([1, 0], [{ id: 'q', embedding: [1, 0, 0] }])?.score).toBe(-1);
  });
});

describe('cleanLearning (unit)', () => {
  it('tidies whitespace and refuses empty or over-long fields', () => {
    expect(cleanLearning('  Uses   pnpm ', ' Run pnpm   install.  ')).toEqual({
      title: 'Uses pnpm',
      content: 'Run pnpm install.',
    });
    expect(() => cleanLearning('', 'x')).toThrow(/invalid context input/);
    expect(() => cleanLearning('t', 'x'.repeat(1001))).toThrow(/content:too_long/);
  });
});

/** p10-chat-memory-suggestions (docs/design/p10-semantic-memory.md §13): chat messages and their snippets. */
describe('extractChatLearnings (unit)', () => {
  it('reads explicit decisions and conventions in Turkish and English from a person’s message', () => {
    const out = extractChatLearnings(
      [
        'Bundan sonra paket yöneticisi olarak Yarn yerine bun kullanma, kararımız net.',
        'From now on, deploy previews only from the release branch.',
        'Asla main dalına doğrudan push yapma.',
        'KARAR: Uygulamada tarih biçimi her yerde GG.AA.YYYY olsun.',
      ].join('\n'),
      'user',
    );
    const decisions = out.filter((l) => l.rule === 'decision').map((l) => l.content);
    expect(decisions).toEqual([
      'Uygulamada tarih biçimi her yerde GG.AA.YYYY olsun.',
      'Bundan sonra paket yöneticisi olarak Yarn yerine bun kullanma, kararımız net.',
      'From now on, deploy previews only from the release branch.',
      'Asla main dalına doğrudan push yapma.',
    ]);
    expect(out.length).toBeLessThanOrEqual(MAX_LEARNINGS);
  });

  it('does not take casual sentences or questions for decisions', () => {
    expect(isDecision('Artık çalışıyor, teşekkürler.')).toBe(false);
    expect(isDecision('Bundan sonra pnpm mi kullanalım?')).toBe(false);
    expect(isDecision('Should we always use pnpm from now on?')).toBe(false);
    expect(isDecision('I never liked that colour.')).toBe(false);
    expect(isDecision('Always use the design tokens instead of raw hex values.')).toBe(true);
    expect(extractChatLearnings('Merhaba, nasılsın? Bugün hava güzel.', 'user')).toEqual([]);
  });

  it('runs the job rules on a person’s message too (package manager, commands, colours, deploy notes)', () => {
    const rules = extractChatLearnings(
      'We run `pnpm -r test` and `pnpm lint` before merging. Staging deploy requires the VPN to be on. Primary brand colour is #0F766E.',
      'user',
    ).map((l) => l.rule);
    expect(rules).toEqual(expect.arrayContaining(['package-manager', 'command', 'deploy-note', 'color']));
  });

  it('reads only explicit MEMORY lines from an assistant answer', () => {
    const out = extractChatLearnings(
      [
        'From now on I will always use npm install in my examples.',
        'Run `pnpm -r test` to verify.',
        'MEMORY: Preview deploys — previews go to Cloudflare Pages, production to Coolify.',
      ].join('\n'),
      'assistant',
    );
    expect(out.map((l) => l.rule)).toEqual(['marker']);
  });

  it('does not read decisions from a job summary (narration)', () => {
    const rules = extractLearnings('From now on the build always uses the cache.').map((l) => l.rule);
    expect(rules).not.toContain('decision');
  });

  it('cuts a snippet from the message line the learning came from, redacted, never a secret', () => {
    const msg = [
      'Selam!',
      'Bundan sonra paket yöneticisi olarak pnpm kullan.',
      `Bu arada token ghp_${'Z9y8X7w6V5'.repeat(4)} burada.`,
    ].join('\n');
    expect(suggestionSnippet(msg, 'Bundan sonra paket yöneticisi olarak pnpm kullan')).toBe(
      'Bundan sonra paket yöneticisi olarak pnpm kullan.',
    );
    expect(suggestionSnippet(msg, 'token burada') ?? '').not.toContain('Z9y8X7w6V5');
    expect(suggestionSnippet('x'.repeat(600), 'x', 100)?.length).toBe(100);
  });
});
