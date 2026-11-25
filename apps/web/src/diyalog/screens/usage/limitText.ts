import type { Formatter, Messages } from '@remyral/i18n';
import {
  resetWhen,
  type UsageEntry,
  type UsageLevel,
  type UsageWindow,
  windowShape,
} from '../../../api/runtimeUsage';
import { useFormat, useT } from '../../../i18n/I18nProvider';

/**
 * p14-i18n-screens-b (i18n Phase 5): the runtime limit-window words of `api/runtimeUsage.ts` (which stay English for
 * the classic console) in the Diyalog language — window names ("5 saatlik" / "5-hour"), the used share ("%86" /
 * "86%"), reset times on a 24-hour clock in the user's language, "2 dk önce okundu" / "Read 2 min ago", the account
 * name. Components take them from `useLimitTexts()`; pure helpers from `limitTexts(t, f)`.
 */
export interface LimitTexts {
  readonly windowName: (w: Pick<UsageWindow, 'id' | 'kind' | 'label' | 'windowMinutes'>) => string;
  readonly percentText: (p: number | null) => string;
  readonly resetText: (iso: string, now?: number) => string;
  /** p15-usage-refresh: the full reset time with the viewer's time zone ("Sıfırlanma: Per 23 Eki 18:40 (Europe/Istanbul)"). */
  readonly resetTitle: (iso: string) => string;
  readonly ageText: (iso: string, now?: number) => string;
  readonly sourceText: (e: Pick<UsageEntry, 'source' | 'observedAt' | 'reports'>, now?: number) => string;
  readonly accountText: (e: Pick<UsageEntry, 'account' | 'accountLabel'>) => string;
  readonly levelText: (l: UsageLevel) => string;
}

const KNOWN = {
  five_hour: 'fiveHour',
  seven_day: 'weekly',
  seven_day_opus: 'opusWeekly',
  seven_day_sonnet: 'sonnetWeekly',
  seven_day_oauth_apps: 'appsWeekly',
  seven_day_overage_included: 'weeklyOverage',
  extra_usage: 'extraUsage',
} as const;

/** The viewer's time zone (reset times are shown on the viewer's clock). */
export function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

const HH_MM: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

export function limitTexts(t: Messages['usage']['limits'], f: Formatter): LimitTexts {
  const ageText = (iso: string, now: number = Date.now()): string => {
    const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
    if (m < 1) return t.ago.justNow;
    if (m < 60) return t.ago.minutes({ n: m });
    const h = Math.round(m / 60);
    return h < 48 ? t.ago.hours({ n: h }) : t.ago.days({ n: Math.round(h / 24) });
  };
  return {
    windowName: (w) => {
      const s = windowShape(w);
      if (s.kind === 'known') return t.windows[KNOWN[s.id]];
      const base =
        s.kind === 'hours'
          ? s.n === 5
            ? t.windows.fiveHour
            : t.windows.hours({ n: s.n })
          : s.kind === 'days'
            ? t.windows.days({ n: s.n })
            : s.kind === 'weekly'
              ? t.windows.weekly
              : s.kind === 'spend'
                ? t.windows.spend
                : s.id;
      return w.label === null ? base : t.windows.labelled({ label: w.label, base });
    },
    percentText: (p) => (p === null ? '—' : f.percent(Math.round(p) / 100)),
    resetText: (iso, now = Date.now()) => {
      const when = resetWhen(iso, now);
      if (when === 'today') return f.dateWith(iso, HH_MM);
      if (when === 'week') return f.dateWith(iso, { weekday: 'short', ...HH_MM });
      return f.dateWith(iso, { month: 'short', day: 'numeric', ...HH_MM });
    },
    resetTitle: (iso) =>
      t.resetTitle({
        when: f.dateWith(iso, { weekday: 'short', month: 'short', day: 'numeric', ...HH_MM }),
        zone: viewerZone(),
      }),
    ageText,
    sourceText: (e, now = Date.now()) => {
      if (e.source === null || e.observedAt === null)
        return e.reports ? t.source.noReading : t.source.notReported;
      const age = ageText(e.observedAt, now);
      if (e.source === 'probe') return t.source.read({ age });
      return e.source === 'job' ? t.source.job({ age }) : t.source.chat({ age });
    },
    accountText: (e) => e.accountLabel ?? (e.account === 'default' ? t.defaultAccount : e.account),
    levelText: (l) => t.levels[l],
  };
}

export function useLimitTexts(): LimitTexts {
  return limitTexts(useT().usage.limits, useFormat());
}
