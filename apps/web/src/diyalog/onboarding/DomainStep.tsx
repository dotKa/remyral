import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../api/client';
import {
  cancelDomainRequest,
  checkDomainDns,
  clearConsoleDomain,
  type ConsoleDomain,
  type DnsCheck,
  domainOf,
  type DomainRequest,
  getConsoleDomain,
  saveConsoleDomain,
  TLS_MODES,
  type TlsMode,
} from '../../api/consoleDomain';
import { checkExpiryNow, type ExpiryItem, getExpiry } from '../../api/opsSafety';
import { cx } from '../../components/ui';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';
import { DyNotice } from '../common/notices';
import { DyField } from '../forms';
import { KeyValue } from '../KeyValue';
import { DyButton } from '../screens/parts';
import { useDoneToast } from '../toast/useDoneToast';

/**
 * p17-domain-wizard (docs/design/p17-domain-wizard.md): "Alan adı ve erişim" — the console's public address, set from
 * the wizard without a terminal.
 *
 * - Facts: the address links use (`GET /console-domain`: the saved setting, else PUBLIC_ORIGIN) and where it comes
 *   from, the certificate it serves (the "Anahtarlar ve süreler" item `tls:public-origin`, "check now" re-reads it),
 *   whether this browser reached the console at that address.
 * - Form: the domain (validated here and on the master), on a remyral-ctl host the TLS mode (Let's Encrypt with its
 *   e-mail / behind Cloudflare / own proxy — the options of `remyral-ctl install --tls`), "DNS bu sunucuyu gösteriyor
 *   mu?" (the master resolves the name and compares it with this server), then "Kaydet ve uygula" (authenticator code
 *   by the security policy, event `console.domain`).
 * - A remyral-ctl host applies the change itself (signed request → `remyral-ctl apply-pending`): the step polls the
 *   request ("Uygulanıyor… / Hazır / Hata: …"). Elsewhere (Coolify / EC2) saving changes the links at once and the
 *   step says what the platform's operator must route.
 */
export const TLS_ITEM = 'tls:public-origin';
const POLL_MS = 3_000;

type T = ReturnType<typeof useT>['selfhost']['wizard']['steps']['domain'];

export function DomainStep(): ReactNode {
  const t = useT().selfhost.wizard.steps.domain;
  const fmt = useFormat();
  const sayError = useErrorText();
  const stepUp = useStepUp();
  const [cd, setCd] = useState<ConsoleDomain | null>(null);
  const [tls, setTls] = useState<ExpiryItem | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'cert' | 'dns' | 'save' | 'clear' | 'cancel' | null>(null);
  const [domain, setDomain] = useState('');
  const [mode, setMode] = useState<TlsMode>('letsencrypt');
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);
  const [dns, setDns] = useState<DnsCheck | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'dy-onboarding-domain-saved' });
  const prefilled = useRef(false);
  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof StepUpCancelledError) return;
      setError(err instanceof ApiError ? sayError(err) : String(err));
    },
    [sayError],
  );

  const apply = useCallback((s: ConsoleDomain) => {
    setCd(s);
    if (prefilled.current) return;
    prefilled.current = true;
    // The name to start from: the address in use, else the one this browser reached the console at.
    const here = typeof window === 'undefined' ? '' : window.location.hostname;
    const fromOrigin = s.origin === null ? null : domainOf(s.origin.replace(/:\d+$/, ''));
    setDomain(fromOrigin ?? s.host.domain ?? domainOf(here) ?? '');
    if (s.host.tls !== null) setMode(s.host.tls);
    setEmail(s.host.acmeEmail ?? '');
  }, []);

  useEffect(() => {
    getConsoleDomain().then(apply, fail);
    getExpiry().then((l) => {
      setTls(l.items.find((i) => i.id === TLS_ITEM) ?? null);
    }, fail);
  }, [apply, fail]);

  // While the host applies a change: poll (the master may restart meanwhile — errors are retried silently).
  const open = cd?.request?.state === 'pending' || cd?.request?.state === 'applying';
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      getConsoleDomain().then(setCd, () => undefined);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [open]);

  const here = typeof window === 'undefined' ? '' : window.location.origin;
  const origin = cd?.origin ?? null;
  const reachable = origin !== null && origin === here;
  const managed = cd?.host.managed === true;
  const name = domainOf(domain);
  const invalid = touched && name === null;

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>): Promise<void> => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <p className="m-0 text-[0.9375rem] text-dy-muted">{t.body}</p>
      {error === null ? null : <DyNotice tone="red">{error}</DyNotice>}
      <div
        className="grid gap-1.5 rounded-[12px] border border-dy-line p-3"
        data-testid="dy-onboarding-domain"
      >
        <KeyValue
          rows={[
            {
              k: t.origin,
              v: cd === null ? t.loading : origin === null ? t.originMissing : origin,
              mono: origin !== null,
            },
            ...(cd === null || cd.source === 'none' ? [] : [{ k: t.source, v: sourceText(cd, t) }]),
            { k: t.tls, v: tlsText(tls, t, fmt) },
            {
              k: t.reach,
              v: origin === null ? '—' : reachable ? t.reachHere : t.reachOther({ here }),
            },
          ]}
        />
      </div>
      {tls?.detail?.startsWith('not publicly trusted') === true ? (
        <DyNotice tone="amber">{t.tlsNotPublic}</DyNotice>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <DyButton
          busy={busy === 'cert'}
          data-testid="dy-onboarding-domain-check"
          onClick={() => {
            void run('cert', async () => {
              const l = await checkExpiryNow();
              setTls(l.items.find((i) => i.id === TLS_ITEM) ?? null);
            });
          }}
        >
          {t.check}
        </DyButton>
        {origin === null || reachable ? null : (
          <a
            href={origin}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[0.875rem] font-bold text-dy-teal-ink underline underline-offset-2"
          >
            {t.open}
          </a>
        )}
        <Link to="/settings/ops-safety" className="text-[0.875rem] font-bold text-dy-teal-ink">
          {t.keys}
        </Link>
      </div>

      {cd?.request ? <RequestNotice request={cd.request} t={t} /> : null}

      {cd === null ? null : (
        <form
          className="grid gap-3 rounded-[12px] border border-dy-line p-3"
          data-testid="dy-onboarding-domain-form"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (name === null) return;
            void run('save', async () => {
              const res = await stepUp.run(
                () =>
                  saveConsoleDomain({
                    domain: name,
                    ...(managed ? { tls: mode } : {}),
                    ...(managed && mode === 'letsencrypt' && email.trim() !== ''
                      ? { email: email.trim() }
                      : {}),
                  }),
                t.stepUpReason,
              );
              setCd(res.status);
              setDone(res.mode === 'setting' && res.origin !== null ? t.saved({ origin: res.origin }) : null);
            });
          }}
        >
          <span className="font-bold">{t.formTitle}</span>
          <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="dy-onboarding-domain-mode">
            {managed ? t.managed : t.unmanaged}
          </p>
          <DyField
            id="onboarding-domain"
            label={t.domain}
            hint={t.domainHint}
            placeholder={t.placeholder}
            autoComplete="off"
            spellCheck={false}
            maxLength={260}
            value={domain}
            error={invalid ? t.domainInvalid : null}
            onChange={(e) => {
              setDomain(e.target.value);
              setDns(null);
              setDone(null);
            }}
            onBlur={() => {
              setTouched(true);
            }}
          />
          {managed ? (
            <fieldset className="m-0 grid gap-2 border-0 p-0">
              <legend className="mb-1.5 text-[0.875rem] font-bold">{t.tlsMode}</legend>
              <div className="grid gap-2 sm:grid-cols-3" data-testid="dy-onboarding-domain-tls">
                {TLS_MODES.map((m) => (
                  <label
                    key={m}
                    className={cx(
                      'flex cursor-pointer flex-col gap-1 rounded-[12px] border p-3',
                      mode === m ? 'border-dy-teal' : 'border-dy-line',
                    )}
                  >
                    <span className="flex items-center gap-2 font-bold">
                      <input
                        type="radio"
                        name="onboarding-domain-tls"
                        value={m}
                        checked={mode === m}
                        onChange={() => {
                          setMode(m);
                        }}
                      />
                      {t.tlsModes[m].title}
                    </span>
                    <span className="text-[0.8125rem] text-dy-muted">{t.tlsModes[m].body}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          {managed && mode === 'letsencrypt' ? (
            <DyField
              id="onboarding-domain-email"
              type="email"
              label={t.email}
              hint={t.emailHint}
              value={email}
              maxLength={254}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
          ) : null}
          <div className="grid gap-2">
            <span className="text-[0.875rem] font-bold">{t.dnsTitle}</span>
            <div>
              <DyButton
                busy={busy === 'dns'}
                disabled={name === null}
                data-testid="dy-onboarding-domain-dns"
                onClick={() => {
                  if (name === null) return;
                  void run('dns', async () => {
                    setDns(await checkDomainDns(name));
                  });
                }}
              >
                {busy === 'dns' ? t.dnsChecking : t.dnsCheck}
              </DyButton>
            </div>
            {dns === null || dns.domain !== name ? null : <DnsNotice dns={dns} t={t} />}
          </div>
          {!managed && name !== null ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="dy-onboarding-domain-route">
              {t.route({ origin: `https://${name}` })}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <DyButton
              type="submit"
              variant="primary"
              busy={busy === 'save'}
              disabled={open || name === null}
              data-testid="dy-onboarding-domain-save"
            >
              {busy === 'save' ? t.saving : managed ? t.saveApply : t.save}
            </DyButton>
            {cd.source === 'setting' && cd.environment !== null && !open ? (
              <DyButton
                busy={busy === 'clear'}
                data-testid="dy-onboarding-domain-clear"
                onClick={() => {
                  void run('clear', async () => {
                    setCd(await stepUp.run(() => clearConsoleDomain(), t.stepUpReason));
                    setDone(t.cleared);
                  });
                }}
              >
                {t.clear}
              </DyButton>
            ) : null}
            {cd.request?.state === 'pending' ? (
              <DyButton
                busy={busy === 'cancel'}
                data-testid="dy-onboarding-domain-cancel"
                onClick={() => {
                  void run('cancel', async () => {
                    setCd(await stepUp.run(() => cancelDomainRequest(), t.stepUpReason));
                  });
                }}
              >
                {t.cancel}
              </DyButton>
            ) : null}
          </div>
        </form>
      )}
    </>
  );
}

function RequestNotice(props: { readonly request: DomainRequest; readonly t: T }): ReactNode {
  const { request: r, t } = props;
  const detail = r.detail ?? '';
  const by: Record<
    DomainRequest['state'],
    { tone: 'teal' | 'green' | 'red' | 'amber' | 'neutral'; text: string }
  > = {
    pending: { tone: 'teal', text: t.request.pending({ domain: r.domain }) },
    applying: { tone: 'teal', text: t.request.applying({ domain: r.domain }) },
    applied: { tone: 'green', text: t.request.applied({ domain: r.domain }) },
    rolled_back: { tone: 'red', text: t.request.rolled_back({ detail }) },
    failed: { tone: 'red', text: t.request.failed({ detail }) },
    refused: { tone: 'red', text: t.request.refused({ detail }) },
    expired: { tone: 'amber', text: t.request.expired },
    cancelled: { tone: 'neutral', text: t.request.cancelled },
  };
  const v = by[r.state];
  const target = `https://${r.domain}`;
  return (
    <DyNotice
      tone={v.tone}
      live
      testId="dy-onboarding-domain-request"
      action={
        r.state === 'applied' && typeof window !== 'undefined' && window.location.hostname !== r.domain ? (
          <a
            href={target}
            className="text-[0.875rem] font-bold text-dy-teal-ink underline underline-offset-2"
          >
            {t.goNew}
          </a>
        ) : undefined
      }
    >
      {v.text}
    </DyNotice>
  );
}

function DnsNotice(props: { readonly dns: DnsCheck; readonly t: T }): ReactNode {
  const { dns, t } = props;
  const addresses = dns.addresses.join(', ');
  const expected = dns.expected.join(', ');
  const [tone, text] = ((): ['green' | 'amber' | 'red', string] => {
    switch (dns.verdict) {
      case 'match':
        return ['green', t.dnsMatch({ addresses })];
      case 'cloudflare':
        return ['amber', t.dnsCloudflare({ addresses })];
      case 'mismatch':
        return ['red', t.dnsMismatch({ addresses, expected })];
      case 'not_found':
        return ['red', t.dnsNotFound];
      case 'unknown':
        return ['amber', t.dnsUnknown({ addresses })];
      case 'error':
        return ['amber', t.dnsError({ detail: dns.detail ?? '' })];
    }
  })();
  return (
    <DyNotice tone={tone} live testId="dy-onboarding-domain-dns-result">
      {text}
    </DyNotice>
  );
}

function sourceText(cd: ConsoleDomain, t: T): string {
  if (cd.source === 'setting') return cd.setting?.source === 'host-applier' ? t.sourceHost : t.sourceSetting;
  return t.sourceEnvironment;
}

function tlsText(item: ExpiryItem | null | undefined, t: T, fmt: ReturnType<typeof useFormat>): string {
  if (item === undefined) return t.loading;
  if (item === null) return t.tlsNone;
  if (item.state === 'error') return t.tlsError({ detail: item.detail ?? '' });
  if (item.state === 'unknown' || item.dueAt === null) return t.tlsUnknown;
  const until = fmt.date(item.dueAt);
  if (item.state === 'expired') return t.tlsExpired({ until });
  return t.tlsValid({ until, days: item.daysLeft ?? 0 });
}
