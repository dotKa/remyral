// p14-i18n-shell (i18n Phase 2, plan §2.5 / §4.6): Diyalog dates and numbers come from the locale-bound formatters —
// Turkish output is what the old forced 'tr-TR' calls printed, English follows en-GB; usage amounts follow the
// language too (the classic helpers stay English).
import { createFormatter } from '@remyral/i18n';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { absoluteText, DATE_TIME_NUMERIC, DyAbsoluteTime, HH_MM } from '../src/diyalog/common/time';
import { When } from '../src/diyalog/job/details/bits';
import { usageFormat } from '../src/diyalog/screens/usage/format';
import { I18nProvider, useFormat } from '../src/i18n/I18nProvider';
import { formatUsd as classicUsd } from '../src/screens/usage/format';

// A local wall-clock time, so the expectation does not depend on the test machine's time zone.
const AT = new Date(2026, 9, 20, 14, 3, 5);
const ISO = AT.toISOString();

describe('formatters in Turkish and English', () => {
  it('a date/time and a number differ by language; Turkish matches the old toLocaleString("tr-TR")', () => {
    const tr = createFormatter('tr');
    const en = createFormatter('en');
    expect(tr.dateWith(AT, DATE_TIME_NUMERIC)).toBe('20.10.2026 14:03:05');
    expect(tr.dateWith(AT, DATE_TIME_NUMERIC)).toBe(AT.toLocaleString('tr-TR'));
    expect(en.dateWith(AT, DATE_TIME_NUMERIC)).toBe('20/10/2026, 14:03:05');
    expect(tr.dateWith(AT, { day: 'numeric', month: 'long' })).toBe('20 Ekim');
    expect(en.dateWith(AT, { day: 'numeric', month: 'long' })).toBe('20 October');
    expect(tr.dateWith(AT, HH_MM)).toBe('14:03');
    expect(tr.number(262_144)).toBe('262.144');
    expect(en.number(262_144)).toBe('262,144');
  });

  it('useFormat follows the provider: Turkish by default, English under locale="en"', () => {
    function Probe(): ReactNode {
      const f = useFormat();
      return <span data-testid="probe">{`${f.dateWith(AT, DATE_TIME_NUMERIC)} · ${f.number(1234.5)}`}</span>;
    }
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('20.10.2026 14:03:05 · 1.234,5');
    unmount();
    render(
      <I18nProvider locale="en">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('20/10/2026, 14:03:05 · 1,234.5');
  });

  it('migrated Diyalog components render their date in the UI language', () => {
    const { unmount } = render(
      <>
        <DyAbsoluteTime iso={ISO} />
        <When iso={ISO} />
      </>,
    );
    expect(screen.getByText('20.10.2026 14:03:05')).toBeTruthy();
    expect(screen.getByText('20 Eki 2026 14:03')).toBeTruthy();
    unmount();
    render(
      <I18nProvider locale="en">
        <DyAbsoluteTime iso={ISO} />
        <When iso={ISO} />
      </I18nProvider>,
    );
    expect(screen.getByText('20/10/2026, 14:03:05')).toBeTruthy();
    expect(screen.getByText('20 Oct 2026, 14:03')).toBeTruthy();
    // Pure helpers keep their Turkish default for callers that pass no formatter.
    expect(absoluteText(ISO)).toBe('20.10.2026 14:03:05');
    expect(absoluteText('not a date')).toBe('—');
  });

  it('usage amounts follow the language in Diyalog; the classic helper stays English', () => {
    const tr = usageFormat(createFormatter('tr'));
    const en = usageFormat(createFormatter('en'));
    expect(tr.formatUsd(12.5)).toBe('$12,50');
    expect(en.formatUsd(12.5)).toBe('$12.50');
    expect(tr.spendText({ costUsd: 3, costComplete: false })).toBe('≥ $3,00');
    expect(en.formatUsd(0.01234)).toBe('$0.0123');
    expect(en.formatUsd(0.00001)).toBe('<$0.0001');
    expect(tr.formatPercent(0.67)).toBe('%67');
    expect(en.formatPercent(0.67)).toBe('67%');
    expect(tr.formatCount(1234)).toBe('1.234');
    expect(en.formatCount(12_300)).toBe('12.3k');
    expect(tr.formatDurationMs(185_000)).toBe('3 dk 05 sn');
    expect(en.formatDurationMs(185_000)).toBe('3 min 05 s');
    expect(classicUsd(12.5)).toBe('$12.50');
  });
});
