import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  type DeployHealth,
  getActionHealth,
  healthOpen,
  recheckHealth,
  screenshotUrl,
} from '../../../api/verify';
import { useNow } from '../../../lib/now';
import { useSubmit } from '../../../screens/useSubmit';
import type { IconName } from '../../icons';
import { KeyValue, type KeyValueRow } from '../../KeyValue';
import type { Tone } from '../../tone';
import { DyApiError, DyNotice } from '../kit';
import { agoText, DyButton, Panel, Pill } from '../parts';
import { untilText } from '../approvals/call';
import { useFormat } from '../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from '../../common/time';

/**
 * p12-diyalog-w2: "Yayın sonrası sağlık" — the master's probe (answer, latency, TLS), the same-origin link check
 * (broken pages / assets and where they are linked from), the screenshot job, the auto-rollback and "Yeniden
 * kontrol et" (the classic `DeployHealthCard` calls and polling). URLs and findings are data: shown as text.
 */

const POLL_MS = 5_000;

export const HEALTH_TR: Readonly<Record<string, { label: string; tone: Tone; icon: IconName }>> = {
  pending: { label: 'Kontrol ediliyor…', tone: 'teal', icon: 'retry' },
  checking: { label: 'Kontrol ediliyor…', tone: 'teal', icon: 'retry' },
  browser: { label: 'Ekran görüntüsü alınıyor…', tone: 'teal', icon: 'retry' },
  passed: { label: 'Sağlıklı', tone: 'green', icon: 'checkc' },
  warned: { label: 'Uyarılarla sağlıklı', tone: 'amber', icon: 'flag' },
  failed: { label: 'Sağlıksız', tone: 'red', icon: 'xc' },
  error: { label: 'Kontrol yapılamadı', tone: 'red', icon: 'xc' },
  skipped: { label: 'Kontrol edilmedi', tone: 'neutral', icon: 'clock' },
};

export function HealthPill(props: { readonly state: string }): ReactNode {
  const h = HEALTH_TR[props.state] ?? {
    label: props.state,
    tone: 'neutral' as const,
    icon: 'clock' as const,
  };
  return (
    <Pill tone={h.tone} icon={h.icon}>
      {h.label}
    </Pill>
  );
}

const SEVERITY_TR: Readonly<Record<string, { label: string; tone: Tone }>> = {
  fail: { label: 'hata', tone: 'red' },
  warn: { label: 'uyarı', tone: 'amber' },
  info: { label: 'bilgi', tone: 'neutral' },
};

export function HealthPanel(props: { readonly actionId: string }): ReactNode {
  const fmt = useFormat();
  const [h, setH] = useState<DeployHealth | null>(null);
  const [tick, setTick] = useState(0);
  const recheck = useSubmit();
  const now = useNow();
  useEffect(() => {
    const ctl = new AbortController();
    getActionHealth(props.actionId, { signal: ctl.signal }).then(setH, () => undefined);
    return () => {
      ctl.abort();
    };
  }, [props.actionId, tick]);
  const open = h !== null && healthOpen(h.state);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      setTick((n) => n + 1);
    }, POLL_MS);
    return () => {
      clearInterval(t);
    };
  }, [open]);
  if (h === null) return null;
  const p = h.probe;
  const rows: KeyValueRow[] = [];
  if (p !== null) {
    rows.push({
      k: 'Yanıt',
      v: `${p.statusCode === null ? (p.detail ?? p.error ?? 'yanıt yok') : `HTTP ${String(p.statusCode)}`}${
        p.latencyMs === null ? '' : ` · ${String(p.latencyMs)} ms`
      }${h.attempts > 1 ? ` · ${String(h.attempts)} deneme` : ''}`,
      mono: true,
    });
    if (p.tlsExpiresAt !== null)
      rows.push({
        k: 'Sertifika',
        v: (
          <time dateTime={p.tlsExpiresAt} title={fmt.dateWith(p.tlsExpiresAt, DATE_TIME_NUMERIC)}>
            {Date.parse(p.tlsExpiresAt) > now
              ? `${untilText(p.tlsExpiresAt, now)} doluyor`
              : `${agoText(p.tlsExpiresAt, now)} doldu`}
          </time>
        ),
      });
  }
  if (h.links !== null)
    rows.push({
      k: 'Bağlantılar',
      v: `${String(h.links.pages)} sayfa, ${String(h.links.assets)} dosya denetlendi · ${String(h.links.broken.length)} kırık · ${String(h.links.external)} dış bağlantı açılmadı${h.links.truncated ? ' · sınırlı' : ''}`,
    });
  const findings = h.findings.filter((f) => f.kind !== 'link');
  return (
    <Panel title="Yayın sonrası sağlık" aside={<HealthPill state={h.state} />} testId="deploy-health">
      <div className="grid gap-3">
        {h.url === null ? null : (
          <p className="m-0 font-dy-mono text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">{h.url}</p>
        )}
        {rows.length === 0 ? null : (
          <div data-testid="deploy-health-probe">
            <KeyValue rows={rows} />
          </div>
        )}
        {h.links !== null && h.links.broken.length > 0 ? (
          <ul
            className="m-0 grid list-none overflow-hidden rounded-[10px] border border-dy-line p-0 text-[0.84375rem]"
            data-testid="deploy-health-broken"
            aria-label="Kırık bağlantılar"
          >
            {h.links.broken.map((b, i) => (
              <li key={String(i)} className="grid gap-0.5 border-t border-dy-line px-3 py-2 first:border-t-0">
                <span className="font-dy-mono text-[0.78125rem] [overflow-wrap:anywhere]">{b.url}</span>
                <span className="text-[0.78125rem] text-dy-red-ink">
                  {b.status === null ? (b.error ?? 'yanıt yok') : `HTTP ${String(b.status)}`}
                  {b.from === null ? '' : <span className="text-dy-muted"> · bağlayan: {b.from}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {findings.length > 0 ? (
          <ul className="m-0 grid list-none gap-1 p-0 text-[0.875rem]" aria-label="Bulgular">
            {findings.map((f, i) => {
              const s = SEVERITY_TR[f.severity] ?? { label: f.severity, tone: 'neutral' as const };
              return (
                <li key={String(i)} className="flex flex-wrap items-baseline gap-2 [overflow-wrap:anywhere]">
                  <Pill tone={s.tone}>{s.label}</Pill>
                  <span className="min-w-0 flex-1">{f.message}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {h.screenshots.length > 0 ? (
          <div className="grid grid-cols-2 gap-2" data-testid="deploy-health-screenshots">
            {h.screenshots.map((s) => (
              <figure key={s.artifactId} className="m-0 grid gap-1">
                <img
                  src={screenshotUrl(s)}
                  alt={`Ekran görüntüsü${s.width === null ? '' : `, ${String(s.width)} px`}`}
                  loading="lazy"
                  className="aspect-[4/3] w-full rounded-[10px] border border-dy-line object-cover object-top"
                />
                <figcaption className="text-[0.75rem] text-dy-muted">
                  {s.width === null ? s.name : `${String(s.width)} px`}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : null}
        {h.browserNote === null ? null : (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{h.browserNote}</p>
        )}
        {h.browserJobId === null ? null : (
          <p className="m-0 text-[0.8125rem] text-dy-muted">
            Ekran görüntüsü işi{' '}
            <Link to={`/jobs/${h.browserJobId}`} className="font-dy-mono text-dy-teal-ink">
              {h.browserJobId.slice(0, 8)}
            </Link>
          </p>
        )}
        {h.rollbackNote === null ? null : (
          <DyNotice
            tone="amber"
            action={
              h.rollbackActionId === null ? undefined : (
                <Link
                  to={`/deploys/${encodeURIComponent(h.rollbackActionId)}`}
                  className="text-[0.8125rem] font-bold text-current"
                >
                  Geri almayı aç
                </Link>
              )
            }
          >
            <span data-testid="deploy-health-rollback">{h.rollbackNote}</span>
          </DyNotice>
        )}
        {open ? null : (
          <div>
            <DyButton
              icon="retry"
              busy={recheck.busy}
              disabled={recheck.blocked}
              onClick={() =>
                void recheck.run(async () => {
                  setH(await recheckHealth(h.id));
                })
              }
            >
              Yeniden kontrol et
            </DyButton>
          </div>
        )}
        <DyApiError error={recheck.error} retryLeft={recheck.retryLeft} />
      </div>
    </Panel>
  );
}
