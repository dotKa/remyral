// p14-web-perf-2: both catalogs, synchronously (registers English).
import { CATALOGS } from '../src/all.js';
import { describe, expect, it } from 'vitest';
import {
  AVOID_IN_TURKISH,
  createFormatter,
  DEFAULT_LOCALE,
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  formatList,
  formatNumber,
  formatRelative,
  formatTime,
  formatUsd,
  isLocale,
  LOCALES,
  messagesFor,
  negotiateLocale,
  NO_VALUE,
  parseAcceptLanguage,
  plural,
  pluralCategory,
  spokenNumberEnd,
  turkishSuffix,
  withSuffix,
} from '../src/index.js';

type Node = Readonly<Record<string, unknown>>;

/** Every leaf path with its kind (`string` / `function/<arity>`). */
function leaves(node: Node, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(node)) {
    const path = prefix === '' ? k : `${prefix}.${k}`;
    if (typeof v === 'string') out.set(path, 'string');
    else if (typeof v === 'function') out.set(path, `function/${String(v.length)}`);
    else if (typeof v === 'object' && v !== null)
      for (const [p, kind] of leaves(v as Node, path)) out.set(p, kind);
    else out.set(path, typeof v);
  }
  return out;
}

/** Every string leaf by path (keys may themselves contain dots, e.g. security event ids). */
function strings(node: Node, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const [k, v] of Object.entries(node)) {
    const path = prefix === '' ? k : `${prefix}.${k}`;
    if (typeof v === 'string') out.set(path, v);
    else if (typeof v === 'object' && v !== null && typeof v !== 'function') strings(v as Node, path, out);
  }
  return out;
}

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('catalog parity (ADR-0053)', () => {
  const tr = leaves(CATALOGS.tr);
  const en = leaves(CATALOGS.en);

  it('TR and EN have the same keys and message kinds', () => {
    expect([...en.keys()].sort()).toEqual([...tr.keys()].sort());
    for (const [k, kind] of tr) expect(en.get(k), k).toBe(kind);
    expect(tr.size).toBeGreaterThan(10);
  });

  it('no empty strings; string placeholders match', () => {
    const trText = strings(CATALOGS.tr);
    const enText = strings(CATALOGS.en);
    for (const [k, kind] of tr) {
      if (kind !== 'string') continue;
      const a = trText.get(k) ?? '';
      const b = enText.get(k) ?? '';
      expect(a.trim(), k).not.toBe('');
      expect(b.trim(), k).not.toBe('');
      expect(placeholders(b), k).toEqual(placeholders(a));
    }
  });

  it('Turkish copy avoids the glossary’s rejected variants', () => {
    const words = (s: string) => s.toLocaleLowerCase('tr-TR');
    const texts: string[] = [];
    const walk = (n: unknown): void => {
      if (typeof n === 'string') texts.push(n);
      else if (typeof n === 'object' && n !== null) Object.values(n).forEach(walk);
    };
    walk(CATALOGS.tr);
    for (const t of texts)
      for (const bad of AVOID_IN_TURKISH)
        expect(new RegExp(`(^|[^\\p{L}])${bad}($|[^\\p{L}])`, 'u').test(words(t)), `${t} uses “${bad}”`).toBe(
          false,
        );
  });

  it('the rail labels follow the glossary in both languages', () => {
    const tr = messagesFor('tr').nav;
    expect([tr.jobs, tr.machines, tr.outputs, tr.usage, tr.projects, tr.settings, tr.needs]).toEqual([
      'İşler',
      'Makineler',
      'Çıktılar',
      'Kullanım',
      'Projeler',
      'Ayarlar',
      'Senden bekleyenler',
    ]);
    expect([tr.chat, tr.workflows]).toEqual(['Sohbet', 'Workflow’lar']);
    const en = messagesFor('en').nav;
    expect([en.jobs, en.machines, en.needs, en.chat]).toEqual(['Jobs', 'Machines', 'Needs you', 'Chat']);
    expect(en.withCount({ label: 'Chat', n: 3, unit: en.unit.unread })).toBe('Chat, 3 unread');
    expect(tr.withCount({ label: 'Sohbet', n: 3, unit: tr.unit.unread })).toBe('Sohbet, 3 okunmamış');
  });
});

describe('locale', () => {
  it('Turkish is the default; only tr and en are locales', () => {
    expect(DEFAULT_LOCALE).toBe('tr');
    expect(LOCALES).toEqual(['tr', 'en']);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it('negotiates navigator.languages and Accept-Language by primary subtag', () => {
    expect(negotiateLocale(['de-DE', 'en-US', 'tr'])).toBe('en');
    expect(negotiateLocale(['TR-tr'])).toBe('tr');
    expect(negotiateLocale(['fr', 'de'])).toBe('tr');
    expect(negotiateLocale([], 'en')).toBe('en');
    expect(negotiateLocale(undefined)).toBe('tr');
    expect(negotiateLocale('de;q=0.9, en-GB;q=0.8, tr;q=0.1')).toBe('en');
    expect(negotiateLocale('en;q=0, tr')).toBe('tr');
    expect(parseAcceptLanguage('a;q=0.5, b, c;q=0.7, *')).toEqual(['b', 'c', 'a']);
    expect(parseAcceptLanguage('x,'.repeat(1000)).length).toBeLessThanOrEqual(16);
  });
});

describe('plurals (Intl.PluralRules)', () => {
  it('English one/other, Turkish keeps one form after a number', () => {
    expect(pluralCategory('en', 1)).toBe('one');
    expect(pluralCategory('en', 2)).toBe('other');
    expect(plural('en', 0, { one: 'job', other: 'jobs' })).toBe('jobs');
    expect(plural('tr', 5, { other: 'iş' })).toBe('iş');
    expect(messagesFor('en').common.machineCount({ n: 1 })).toBe('1 machine');
    expect(messagesFor('en').common.machineCount({ n: 4 })).toBe('4 machines');
    expect(messagesFor('tr').common.machineCount({ n: 4 })).toBe('4 makine');
    expect(messagesFor('tr').common.jobCount({ n: 1 })).toBe('1 iş');
  });
});

describe('Turkish suffixes', () => {
  it.each([
    ['mac-1', 'locative', 'mac-1’de'],
    ['mac-3', 'locative', 'mac-3’te'],
    ['pi-10', 'locative', 'pi-10’da'],
    ['web', 'genitive', 'web’in'],
    ['studio', 'genitive', 'studio’nun'],
    ['linux-box', 'dative', 'linux-box’a'],
    ['pi-5', 'dative', 'pi-5’e'],
    ['kiosk', 'accusative', 'kiosk’u'],
    ['Mac Mini', 'ablative', 'Mac Mini’den'],
    ['ubuntu', 'accusative', 'ubuntu’yu'],
    ['win-2', 'genitive', 'win-2’nin'],
    ['api)', 'dative', 'api)’ye'],
  ] as const)('%s + %s → %s', (word, kase, want) => {
    expect(withSuffix(word, kase)).toBe(want);
  });

  it('reads trailing numbers out', () => {
    expect(spokenNumberEnd(0n)).toBe('sıfır');
    expect(spokenNumberEnd(40n)).toBe('kırk');
    expect(spokenNumberEnd(300n)).toBe('yüz');
    expect(spokenNumberEnd(2000n)).toBe('bin');
    expect(spokenNumberEnd(5_000_000n)).toBe('milyon');
    expect(turkishSuffix('srv-100', 'locative')).toBe('de');
    expect(messagesFor('tr').common.onMachine({ name: 'mac-1' })).toBe('mac-1’de');
    expect(messagesFor('en').common.onMachine({ name: 'mac-1' })).toBe('on mac-1');
  });
});

describe('formatters', () => {
  const at = new Date('2026-10-20T14:03:00Z');
  const utc = { timeZone: 'UTC' };

  it('dates: tr-TR and en-GB, 24 h, day-month order', () => {
    expect(formatDateTime('tr', at, utc)).toBe('20 Eki 2026 14:03');
    expect(formatDateTime('en', at, utc)).toBe('20 Oct 2026, 14:03');
    expect(formatDate('tr', at, utc)).toBe('20 Eki 2026');
    expect(formatTime('en', at, utc)).toBe('14:03');
    expect(formatTime('tr', '2026-10-20T09:05:00Z', utc)).toBe('09:05');
    expect(formatDate('en', 'not a date')).toBe(NO_VALUE);
  });

  it('relative time picks the largest unit', () => {
    const now = at.getTime();
    expect(formatRelative('tr', now - 3 * 60_000, now)).toBe('3 dakika önce');
    expect(formatRelative('en', now - 3 * 60_000, now)).toBe('3 minutes ago');
    expect(formatRelative('en', now + 24 * 3_600_000, now)).toBe('tomorrow');
    expect(formatRelative('tr', now, now)).toBe('şimdi');
    expect(formatRelative('en', now - 400 * 86_400_000, now)).toBe('last year');
  });

  it('numbers, money, sizes, durations, lists', () => {
    expect(formatNumber('tr', 1234.5)).toBe('1.234,5');
    expect(formatNumber('en', 1234.5)).toBe('1,234.5');
    expect(formatNumber('en', Number.NaN)).toBe(NO_VALUE);
    expect(formatUsd('en', 12.5)).toBe('US$12.50');
    expect(formatUsd('en', 0.01234)).toBe('US$0.0123');
    expect(formatBytes('tr', 1536 * 1024)).toBe('1,5 MB');
    expect(formatBytes('en', 512)).toBe('512 B');
    expect(formatBytes('en', 50 * 1024)).toBe('50 KB');
    expect(formatDuration('tr', 45_000)).toBe('45 sn');
    expect(formatDuration('en', 185_000)).toBe('3 min 05 s');
    expect(formatDuration('tr', 7_800_000)).toBe('2 sa 10 dk');
    expect(formatDuration('en', 2 * 86_400_000 + 3_600_000)).toBe('2 d 1 h');
    expect(formatList('tr', ['a', 'b', 'c'])).toBe('a, b ve c');
    expect(formatList('en', ['a', 'b'], 'disjunction')).toBe('a or b');
  });

  it('a bound formatter carries its locale', () => {
    const f = createFormatter('en', utc);
    expect(f.locale).toBe('en');
    expect(f.time(at)).toBe('14:03');
    expect(f.percent(0.42)).toBe('42%');
    expect(createFormatter('tr').percent(0.42)).toBe('%42');
    expect(f.compact(12_300)).toBe('12.3k');
  });

  it('custom Intl options and relative units (p14-i18n-shell)', () => {
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', timeZone: 'UTC' };
    expect(createFormatter('tr').dateWith(at, opts)).toBe('20 Ekim');
    expect(createFormatter('en').dateWith(at, opts)).toBe('20 October');
    expect(createFormatter('tr').dateWith('nope', opts)).toBe(NO_VALUE);
    expect(createFormatter('tr').relativeUnit(-3, 'minute')).toBe('3 dakika önce');
    expect(createFormatter('en').relativeUnit(2, 'hour')).toBe('in 2 hours');
    expect(createFormatter('en').relativeUnit(-1, 'day')).toBe('yesterday');
    expect(createFormatter('en').relativeUnit(-1, 'day', 'always')).toBe('1 day ago');
  });
});
