import { type Messages, messagesFor } from '@remyral/i18n';
import { createContext, type ReactNode, use } from 'react';
import { useT } from './I18nProvider';

/**
 * p14-i18n-shell (i18n Phase 2, ADR-0053 addendum): shared modules that both shells render (`components/ui`, the
 * classic chat parts inside Sohbet rows, …) speak the user's language only inside the Diyalog UI. The classic console
 * stays English (by design) until Phase 8 wraps it in `<I18nProvider locale="en">`; until then these modules
 * ask `useSharedT()` / `useSharedFormat()`, which give the user's catalog under a `<DiyalogTextScope>` (the Diyalog
 * shell and the Diyalog sign-in frames) and the English one everywhere else — so classic output is unchanged.
 */

const InDiyalog = createContext(false);

export function DiyalogTextScope(props: { readonly children: ReactNode }): ReactNode {
  return <InDiyalog value>{props.children}</InDiyalog>;
}

/** True under a `<DiyalogTextScope>`. */
export function useInDiyalog(): boolean {
  return use(InDiyalog);
}

/** The user's catalog inside Diyalog, English in the classic console. */
export function useSharedT(): Messages {
  const t = useT();
  // p14-web-perf-2: read at call time (English is loaded with the classic console's chunk).
  return use(InDiyalog) ? t : messagesFor('en');
}
