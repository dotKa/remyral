import { type ReactNode, useEffect } from 'react';
import { cx } from '../../components/ui';
import { useDocumentLang, useT } from '../../i18n/I18nProvider';
import { DiyalogTextScope } from '../../i18n/scope';
import { BrandLogo } from '../Brand';

/**
 * p12-diyalog-w4: the frame of the sign-in steps in the Diyalog language — outside the shell, so it is its own
 * `[data-ui="diyalog"]` scope root (tokens, light / dark by the system scheme). Product logo, one card with the step
 * label, title and one purpose line, then the step's form; links under the card. Phones: the card starts near the
 * top (the keyboard never covers the field) and keeps the safe-area insets.
 */
export function AuthFrame(props: {
  readonly step: string;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly wide?: boolean;
  readonly testId?: string;
}): ReactNode {
  const t = useT().auth.frame;
  // p14-i18n-shell: `<html lang>` follows the pre-sign-in language; shared parts inside speak it too.
  useDocumentLang();
  useEffect(() => {
    document.title = t.documentTitle({ title: props.title });
  }, [props.title, t]);
  return (
    <DiyalogTextScope>
      <div
        data-ui="diyalog"
        data-testid={props.testId ?? 'dy-auth'}
        className="dy-surface flex min-h-dvh flex-col items-center bg-dy-bg pt-[max(2rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(2rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] sm:justify-center sm:py-12"
      >
        <div className={cx('w-full', props.wide === true ? 'max-w-[34rem]' : 'max-w-[26rem]')}>
          {/* p17-remyral-brand: the Remyral lock-up (its wordmark is the product name) and the tagline. */}
          <div className="mb-5 flex items-center gap-3">
            <BrandLogo alt={t.product} height={30} />
            <p className="m-0 border-l border-dy-line-2 pl-3 text-[0.8125rem] leading-tight text-dy-muted">
              {t.tagline}
            </p>
          </div>
          <main id="main" className="rounded-[16px] border border-dy-line bg-dy-card p-5 shadow-dy sm:p-6">
            <p className="m-0 mb-1 text-[0.8125rem] font-bold text-dy-teal-ink">{props.step}</p>
            <h1 className="m-0 text-[1.375rem] leading-tight font-extrabold tracking-[-0.02em] text-balance">
              {props.title}
            </h1>
            {props.description === undefined ? null : (
              <div className="m-0 mt-1.5 text-[0.9375rem] text-dy-muted">{props.description}</div>
            )}
            <div className="mt-5">{props.children}</div>
          </main>
          {props.footer === undefined ? null : (
            <div className="mt-4 text-[0.875rem] text-dy-muted">{props.footer}</div>
          )}
        </div>
      </div>
    </DiyalogTextScope>
  );
}

/** A text-button link under the card ("Baştan başla", "Kurtarma kodu kullan"). */
export function FrameLink(props: { readonly onClick: () => void; readonly children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="dy-press inline-flex min-h-10 items-center rounded-md px-1 text-[0.875rem] font-bold text-dy-teal-ink underline-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
    >
      {props.children}
    </button>
  );
}
