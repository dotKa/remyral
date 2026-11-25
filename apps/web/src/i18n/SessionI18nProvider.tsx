import type { Locale } from '@remyral/i18n';
import { type ReactNode, useCallback } from 'react';
import { setMyLocale } from '../api/me';
import { useAuth } from '../auth/AuthProvider';
import { I18nProvider } from './I18nProvider';

/**
 * p14-i18n-foundation: the app-root language provider — follows the signed-in user's `locale` from the session and
 * saves a change on the master (`PUT /me/locale`), then re-reads the session so the console's session view agrees
 * (other devices and tabs pick it up with their next session read). Must sit inside <AuthProvider>.
 */
export function SessionI18nProvider(props: {
  readonly children: ReactNode;
  readonly api?: typeof setMyLocale;
}): ReactNode {
  const { state, actions } = useAuth();
  const sessionLocale = state.kind === 'signedIn' ? state.session?.locale : undefined;
  const put = props.api ?? setMyLocale;
  const save = useCallback(
    async (locale: Locale) => {
      await put(locale);
      await actions.refreshSession().catch(() => undefined);
    },
    [put, actions],
  );
  return (
    <I18nProvider sessionLocale={sessionLocale} save={save}>
      {props.children}
    </I18nProvider>
  );
}
