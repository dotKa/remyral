import type { ReactNode } from 'react';
import { useErrorText } from '../i18n/errors';
import { useT } from '../i18n/I18nProvider';
import { type ThemeChoice, useThemeChoice } from '../theme/theme';
import { Segmented } from './common/controls';
import { DyNotice } from './common/notices';

/**
 * p17-remyral-brand: the light / dark switch — Açık, Koyu, Sistem (default; follows prefers-color-scheme). Applies at
 * once and saves the choice for the account (src/theme/theme.ts). In the account menu (`compact`) and in Ayarlar →
 * Profil (with the hint).
 */
export function ThemeSwitch(props: { readonly compact?: boolean }): ReactNode {
  const t = useT().settings.theme;
  const sayError = useErrorText();
  const theme = useThemeChoice();
  const options: readonly (readonly [ThemeChoice, string])[] = [
    ['light', t.light],
    ['dark', t.dark],
    ['system', t.system],
  ];
  return (
    <div className="grid gap-2" data-testid={props.compact === true ? 'dy-theme-menu' : 'dy-theme'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {props.compact === true ? <span className="text-[0.84375rem] text-dy-muted">{t.label}</span> : null}
        <Segmented
          label={t.label}
          value={theme.choice}
          options={options}
          onChange={(v) => {
            void theme.choose(v);
          }}
        />
      </div>
      {props.compact === true ? null : <p className="m-0 text-[0.8125rem] text-dy-muted">{t.hint}</p>}
      {theme.error === null ? null : (
        <DyNotice tone="amber" live>
          {t.failed({ reason: sayError(theme.error) })}
        </DyNotice>
      )}
    </div>
  );
}
