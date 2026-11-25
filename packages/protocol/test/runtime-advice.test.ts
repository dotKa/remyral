import { describe, expect, it } from 'vitest';
import {
  areaOfPath,
  classifyJob,
  globToRegExp,
  JobSpec,
  RUNTIME_ADVICE_DEFAULTS,
  RuntimeAdviceSettings,
} from '../src/index.js';

/** p11-runtime-advice (docs/design/p11-runtime-advice.md §2): the deterministic kind + area classifier. */

describe('globs', () => {
  it.each([
    ['**/*.tsx', 'apps/web/src/App.tsx', true],
    ['**/*.tsx', 'App.tsx', true],
    ['docs/**', 'docs/design/x.md', true],
    ['docs/**', 'src/docs.ts', false],
    ['src/*.ts', 'src/a/b.ts', false],
    ['**/test/**', 'apps/master/test/unit/x.ts', true],
    ['file?.md', 'file1.md', true],
    ['**/Dockerfile*', 'infra/Dockerfile.worker', true],
  ])('%s vs %s', (glob, path, match) => {
    expect(globToRegExp(glob).test(path)).toBe(match);
  });

  it('first matching rule wins: tests before frontend, project rules before built-ins', () => {
    expect(areaOfPath('src/components/Button.test.tsx')).toBe('tests');
    expect(areaOfPath('src/components/Button.tsx')).toBe('frontend');
    expect(areaOfPath('./infra/README.md')).toBe('docs');
    expect(areaOfPath('server/main.go')).toBe('backend');
    expect(areaOfPath('src/util.ts')).toBeNull();
    expect(areaOfPath('src/util.ts', [{ area: 'backend', globs: ['src/**'] }])).toBe('backend');
  });
});

describe('classifyJob', () => {
  it.each([
    ['Fix the dark mode toggle in the settings page layout', 'frontend'],
    ['Add a REST endpoint for invoices and the database migration', 'backend'],
    ['Write unit tests for the parser and raise coverage', 'tests'],
    ['Update the README and the changelog', 'docs'],
    ['Fix the Docker build in the CI pipeline', 'infra'],
    ['Ayarlar sayfasındaki butonun görünümünü düzelt', 'frontend'],
    ['Faturalar için yeni bir uç nokta ve veritabanı tablosu ekle', 'backend'],
    ['Ödeme modülü için birim testleri yaz', 'tests'],
    ['Kurulum adımlarını dokümantasyona ekle, README güncelle', 'docs'],
    ['Uygulamayı Coolify ile yayına al, altyapı ayarlarını kontrol et', 'infra'],
  ])('%s → %s', (prompt, area) => {
    expect(classifyJob({ prompt }).area).toBe(area);
  });

  it('is unclassified without enough evidence (no guess)', () => {
    const c = classifyJob({ prompt: 'Make it better' });
    expect(c.area).toBeNull();
    expect(c.areaSource).toBeNull();
    expect(c.signals).toEqual([]);
    // One weak keyword is below the threshold.
    expect(classifyJob({ prompt: 'Look at the react thing' }).area).toBeNull();
  });

  it('a close tie stays unclassified', () => {
    expect(classifyJob({ prompt: 'css and sql' }).area).toBeNull();
  });

  it('touched paths outweigh the prompt and are explained', () => {
    const c = classifyJob({
      prompt: 'Fix the login button',
      touchedPaths: ['server/auth.go', 'server/session.go', 'server/auth_test.go'],
    });
    expect(c.area).toBe('backend');
    expect(c.areaSource).toBe('touched-paths');
    const s = c.signals.find((x) => x.source === 'touched-paths' && x.area === 'backend');
    expect(s?.weight).toBe(4);
    expect(s?.detail).toContain('2 of 3 paths');
  });

  it('uses sub-job path hints, file names in the prompt and the template name', () => {
    expect(classifyJob({ prompt: 'Do the task', pathHints: ['apps/web/src/a.tsx'] }).area).toBe('frontend');
    const files = classifyJob({ prompt: 'Change Header.tsx and Footer.vue' });
    expect(files.area).toBe('frontend');
    expect(files.areaSource).toBe('file-types');
    const t = classifyJob({ prompt: 'Run it', templateName: 'Nightly e2e tests' });
    expect(t.area).toBe('tests');
    expect(t.areaSource).toBe('template');
  });

  it('project rules decide paths the built-ins do not know', () => {
    const c = classifyJob({
      prompt: 'Refactor',
      touchedPaths: ['packages/ui/src/a.ts'],
      projectRules: [{ area: 'frontend', globs: ['packages/ui/**'] }],
    });
    expect(c.area).toBe('frontend');
  });

  it('an explicit area always wins; the kind comes from the routing heuristic', () => {
    const c = classifyJob({ prompt: 'Review the Dockerfile', area: 'docs' });
    expect(c.area).toBe('docs');
    expect(c.areaSource).toBe('explicit');
    expect(c.kind).toBe('verify');
    expect(c.kindSource).toBe('inferred');
    expect(classifyJob({ prompt: 'x', role: 'plan' }).kindSource).toBe('explicit');
    expect(classifyJob({ prompt: 'x', kind: 'machine-admin' }).kind).toBeNull();
  });

  it('does not match keywords inside other words', () => {
    expect(
      classifyJob({ prompt: 'uint overflow in the guidelines builder', templateName: '' }).signals,
    ).toEqual([]);
  });

  it('is deterministic', () => {
    const input = { prompt: 'Add tests for the API endpoint', touchedPaths: ['api/x.test.ts'] };
    expect(classifyJob(input)).toEqual(classifyJob(input));
  });
});

describe('settings and JobSpec', () => {
  it('defaults parse; bounds are enforced', () => {
    expect(RuntimeAdviceSettings.parse(RUNTIME_ADVICE_DEFAULTS)).toEqual(RUNTIME_ADVICE_DEFAULTS);
    expect(RuntimeAdviceSettings.safeParse({ ...RUNTIME_ADVICE_DEFAULTS, explorationPct: 50 }).success).toBe(
      false,
    );
    expect(RuntimeAdviceSettings.safeParse({ ...RUNTIME_ADVICE_DEFAULTS, minSamples: 1 }).success).toBe(
      false,
    );
    expect(
      RuntimeAdviceSettings.safeParse({ ...RUNTIME_ADVICE_DEFAULTS, allowedRuntimes: ['openhands'] }).success,
    ).toBe(false);
  });

  it('JobSpec carries an optional area', () => {
    const base = {
      runtime: 'codex',
      prompt: 'x',
      repository: { url: 'https://example.com/a/b.git', baseRef: 'main', workBranch: 'rac/x' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 60 },
    };
    expect(JobSpec.parse({ ...base, area: 'tests' }).area).toBe('tests');
    expect(JobSpec.safeParse({ ...base, area: 'marketing' }).success).toBe(false);
  });
});
