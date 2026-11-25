import { describe, expect, it } from 'vitest';
import {
  clipTitle,
  commitSubject,
  deriveJobTitle,
  JOB_TITLE_MAX,
  JobSpec,
  JobTitle,
  jobTitleOf,
  normalizeJobTitle,
  pullRequestTitle,
  titleLength,
} from '../src/index.js';

/** p15-job-titles (docs/design/p15-job-titles.md §2): the deterministic title of a job without one. */

describe('deriveJobTitle', () => {
  it.each([
    // The owner's example: the first sentence, cut at a word to ≤ 60 characters.
    [
      'Bu işin dalı, SampleWebApp uygulamasının Coolify DEPLOY DALI olacak. Uygulamayı Coolify üzerinde yayınla ve sağlık kontrolünü ekle.',
      'Bu işin dalı, SampleWebApp uygulamasının Coolify DEPLOY…',
    ],
    ['Fix the login redirect bug. Users land on /home after signing in.', 'Fix the login redirect bug'],
    ['Giriş sayfasındaki yönlendirme hatasını düzelt', 'Giriş sayfasındaki yönlendirme hatasını düzelt'],
    // Greetings and courtesy words go.
    ['Merhaba, lütfen README dosyasını güncelle.', 'README dosyasını güncelle'],
    ['Please add unit tests for the parser!', 'add unit tests for the parser'],
    ['Hi! Could you bump the Node version to 24?', 'bump the Node version to 24'],
    // Section labels and markdown are skipped.
    ['## Görev\n\n- Landing sayfasını yeniden tasarla\n- Testleri ekle', 'Landing sayfasını yeniden tasarla'],
    ['Task: migrate the queue to BullMQ 6; keep the old API', 'migrate the queue to BullMQ 6'],
    ['# Context\nWe use Postgres 18.\n\n## Task\n1. Add an index', 'We use Postgres 18'],
    ['**Amaç:** `api` paketinde hata kodlarını sadeleştir', 'api paketinde hata kodlarını sadeleştir'],
    ['- [ ] Remove the legacy importer', 'Remove the legacy importer'],
    ['\n\n   \n  Research the best vector index for 1M rows', 'Research the best vector index for 1M rows'],
    // A colon after three words ends the clause; a short "Name:" prefix stays.
    ['Fix the flaky test: it times out on Windows runners', 'Fix the flaky test'],
    ['SampleWebApp: Coolify deploy dalı hazırla', 'SampleWebApp: Coolify deploy dalı hazırla'],
    // Abbreviations and numbers do not end a sentence.
    ['Upgrade deps, e.g. vitest and zod. Then run the tests', 'Upgrade deps, e.g. vitest and zod'],
    ['Release v1.2.3 notes yaz. Sonra etiketle', 'Release v1.2.3 notes yaz'],
    // Long first line without punctuation: cut at a word.
    [
      'Implement the complete multi tenant billing pipeline with invoices credit notes and dunning emails for every plan',
      'Implement the complete multi tenant billing pipeline with…',
    ],
    // One very long word: cut inside it.
    ['x'.repeat(200), `${'x'.repeat(JOB_TITLE_MAX - 1)}…`],
    // Nothing but symbols / whitespace.
    ['---\n***', '--- ***'],
    ['   ', 'Job'],
  ])('%j → %j', (prompt, title) => {
    const t = deriveJobTitle(prompt);
    expect(t).toBe(title);
    expect(titleLength(t)).toBeLessThanOrEqual(JOB_TITLE_MAX);
    expect(t).not.toMatch(/\n/);
  });

  it('is deterministic and always within the limit (fuzz)', () => {
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const alphabet = ['a', 'ğ', 'İ', ' ', '.', ',', ':', '\n', '-', '#', '🙂', '1', ';', '—'];
    for (let n = 0; n < 500; n++) {
      const s = Array.from(
        { length: Math.floor(rnd() * 300) + 1 },
        () => alphabet[Math.floor(rnd() * 14)],
      ).join('');
      const t = deriveJobTitle(s);
      expect(t).toBe(deriveJobTitle(s));
      expect(t.length).toBeGreaterThan(0);
      expect(titleLength(t)).toBeLessThanOrEqual(JOB_TITLE_MAX);
      expect(t).not.toMatch(/[\n\r\t]/);
    }
  });
});

describe('normalizeJobTitle / JobTitle', () => {
  it('collapses whitespace, makes one line and clips long titles at a word', () => {
    expect(normalizeJobTitle('  SampleWebApp:\n Coolify   deploy dalı hazırla ')).toBe(
      'SampleWebApp: Coolify deploy dalı hazırla',
    );
    expect(normalizeJobTitle('   ')).toBeNull();
    expect(normalizeJobTitle(undefined)).toBeNull();
    const long = normalizeJobTitle(
      'Landing sayfasını yeniden tasarla ve tüm bileşenler için erişilebilirlik testleri ekle',
    );
    expect(long).toBe('Landing sayfasını yeniden tasarla ve tüm bileşenler için…');
    expect(titleLength(long ?? '')).toBeLessThanOrEqual(60);
  });

  it('the wire schema refuses multi-line and over-long titles', () => {
    expect(JobTitle.safeParse('Login hatasını düzelt').success).toBe(true);
    expect(JobTitle.safeParse('a\nb').success).toBe(false);
    expect(JobTitle.safeParse('x'.repeat(61)).success).toBe(false);
    expect(JobTitle.safeParse('ğ'.repeat(60)).success).toBe(true);
    expect(JobTitle.safeParse('   ').success).toBe(false);
  });

  it('JobSpec carries an optional title (additive)', () => {
    const base = {
      runtime: 'claude-code',
      prompt: 'p',
      repository: { url: 'https://github.com/example/repo.git', baseRef: 'main', workBranch: 'rac/j/a' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 60 },
    };
    expect(JobSpec.safeParse(base).success).toBe(true);
    expect(JobSpec.parse({ ...base, title: 'Kısa başlık' }).title).toBe('Kısa başlık');
    expect(JobSpec.safeParse({ ...base, title: 'a\nb' }).success).toBe(false);
  });

  it('jobTitleOf prefers the given title', () => {
    expect(jobTitleOf({ title: 'Given', prompt: 'Derived one. More' })).toEqual({
      title: 'Given',
      source: 'given',
    });
    expect(jobTitleOf({ prompt: 'Derived one. More' })).toEqual({ title: 'Derived one', source: 'derived' });
  });
});

describe('PR title and commit subject', () => {
  it('the PR title is the job title (≤ 72)', () => {
    expect(pullRequestTitle('SampleWebApp: Coolify deploy dalı hazırla')).toBe(
      'SampleWebApp: Coolify deploy dalı hazırla',
    );
    expect(titleLength(pullRequestTitle('w '.repeat(100)))).toBeLessThanOrEqual(72);
    expect(pullRequestTitle('')).toBe('Agent changes');
  });

  it('the commit subject is the title, else the first line of the summary', () => {
    expect(commitSubject('Login hatasını düzelt', 'Fixed it\nmore')).toBe('Login hatasını düzelt');
    expect(commitSubject(undefined, 'Fixed the redirect\nDetails')).toBe('Fixed the redirect');
    expect(commitSubject(null, '')).toBe('agent changes');
    expect(clipTitle('abc def', 5)).toBe('abc…');
  });
});
