import { useCallback } from 'react';
import { describeReason, type ReasonContext, type ReasonInfo, type ReasonParams } from '../lib/reasons';
import { useLocale } from './I18nProvider';

/**
 * p14-i18n-reasons (i18n Phase 4): a reported reason said in the reader's language — `lib/reasons.ts` over the
 * `reasons` catalog of `@remyral/i18n`. `params` are the reason's params when the API reported them (`cause` picks
 * the variant); without them an old reason's text decides (the legacy fallback in `lib/reasons.ts`).
 */
export type DescribeReason = (raw: string, ctx?: ReasonContext, params?: ReasonParams | null) => ReasonInfo;

/** Diyalog-only modules: reasons in the user's language. */
export function useDescribeReason(): DescribeReason {
  const { locale } = useLocale();
  return useCallback(
    (raw: string, ctx: ReasonContext = {}, params?: ReasonParams | null) =>
      describeReason(raw, ctx, { locale, params }),
    [locale],
  );
}
