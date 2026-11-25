import type { ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';

// p14-web-perf: the session check of the Diyalog sign-in, a module of its own — it is drawn on every first load,
// while the sign-in steps (auth/screens.tsx) load only for a visit that is not signed in.

export function DyChecking(): ReactNode {
  const t = useT().auth;
  return (
    <div
      data-ui="diyalog"
      data-testid="dy-checking"
      className="dy-surface flex min-h-dvh items-center justify-center gap-2.5 bg-dy-bg text-[0.9375rem] text-dy-muted"
    >
      <span className="dy-breathe size-2.5 rounded-full bg-dy-teal" aria-hidden="true" />
      <span role="status">{t.checking}</span>
    </div>
  );
}
