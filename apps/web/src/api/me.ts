import { isLocale, type Locale } from '@remyral/i18n';
import { apiRequest, obj, type RequestOptions } from './client';

type Opts = Omit<RequestOptions, 'body'>;

/**
 * p14-i18n-foundation (ADR-0053): `PUT /me/locale` — stores the caller's console language on the master (audited
 * when it changes). `changed: false` = it already was this language.
 */
export function setMyLocale(locale: Locale, opts: Opts = {}): Promise<{ locale: Locale; changed: boolean }> {
  return apiRequest(
    'PUT',
    '/me/locale',
    (v) => {
      const o = obj(v);
      if (!isLocale(o.locale) || typeof o.changed !== 'boolean') throw new Error('unexpected body');
      return { locale: o.locale, changed: o.changed };
    },
    { ...opts, body: { locale } },
  );
}
