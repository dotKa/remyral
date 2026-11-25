import type { ReactNode } from 'react';
import { causeText as classicCause, type Monitor, type MonitorType } from '../../../api/uptime';
import { cx } from '../../../components/ui';
import { useNow } from '../../../lib/now';
import type { IconName } from '../../icons';
import { INK, type Tone } from '../../tone';
import { DATE_TIME_NUMERIC, DyTime, TR_FORMAT } from '../../common/time';
import { useFormat } from '../../../i18n/I18nProvider';
import type { Formatter } from '@remyral/i18n';

/**
 * p12-diyalog-w2: what the Uptime list, the monitor page and the monitor form share — the state words (icon + word +
 * tone, never colour alone), Turkish cause / duration / type words over the classic codes, the write roles, the
 * relative time and the 24 h latency line.
 */

export const WRITE_ROLES = new Set(['operator', 'admin', 'owner']);

export type Shown = 'up' | 'down' | 'pending' | 'paused';

export const STATE: Readonly<Record<Shown, { tone: Tone; icon: IconName; word: string }>> = {
  down: { tone: 'red', icon: 'xc', word: 'Çalışmıyor' },
  up: { tone: 'green', icon: 'checkc', word: 'Çalışıyor' },
  pending: { tone: 'amber', icon: 'clock', word: 'Bekliyor' },
  paused: { tone: 'neutral', icon: 'pause', word: 'Duraklatıldı' },
};

export function shownOf(m: Pick<Monitor, 'status' | 'paused'>): Shown {
  return m.paused ? 'paused' : m.status;
}

export const TYPE_WORD: Readonly<Record<MonitorType, string>> = {
  http: 'HTTP(S)',
  tcp: 'TCP',
  pages: 'Cloudflare Pages',
  coolify: 'Coolify uygulaması',
};

const CAUSE_TR: Readonly<Record<string, string>> = {
  timeout: 'zaman aşımı',
  dns: 'alan adı çözülemiyor',
  address_refused: 'genel olmayan adres (reddedildi)',
  url_refused: 'URL’ye izin yok',
  connect: 'bağlantı reddedildi ya da koptu',
  network: 'ağ hatası',
  tls: 'TLS sertifikası reddedildi',
  status: 'beklenmeyen HTTP durumu',
  keyword: 'anahtar kelime denetimi tutmadı',
  slow: 'çok yavaş',
  redirect: 'çok fazla ya da geçersiz yönlendirme',
  provider_down: 'sağlayıcı kapalı diyor',
  provider_pending: 'sağlayıcı: sürüyor',
  provider_not_found: 'sağlayıcıda bulunamadı',
  provider_auth: 'sağlayıcı anahtarı reddedildi',
  provider_rate_limited: 'sağlayıcı istek sınırı',
  provider_unavailable: 'sağlayıcı yanıt vermedi',
  provider_not_configured: 'sağlayıcı bağlı değil',
  invalid_config: 'ayarlar artık geçerli değil',
  check_error: 'kontrol çalıştırılamadı',
};

/** A failure cause in Turkish; unknown codes keep the classic wording. */
export function causeTr(code: string | null): string {
  if (code === null) return '';
  return CAUSE_TR[code] ?? classicCause(code);
}

/** "45 sn", "12 dk", "3 sa 5 dk", "4 gün" — or "—". */
export function durationTr(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)} sn`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)} dk`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 ? `${String(h)} sa` : `${String(h)} sa ${String(m % 60)} dk`;
  return `${String(Math.round(h / 24))} gün`;
}

/** The provider row in Turkish ("Cloudflare Pages: healthy"), or null for http / tcp. */
export function providerTr(type: string, detail: string | null, status: string): string | null {
  if (type !== 'pages' && type !== 'coolify') return null;
  const label = type === 'pages' ? 'Cloudflare Pages' : 'Coolify uygulaması';
  const word =
    status === 'pending'
      ? 'henüz kontrol edilmedi'
      : status === 'up' || status === 'down'
        ? STATE[status].word
        : status;
  return `${label}: ${detail ?? word}`;
}

/** "19 Eki 14:05" in the browser's zone. */
export function absTr(iso: string, f: Formatter = TR_FORMAT): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return f.dateWith(d, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Relative time ("4 dk önce"), the absolute time on hover; moves with the shared clock. */
export function Ago(props: { readonly iso: string }): ReactNode {
  return <DyTime iso={props.iso} />;
}

/** Future relative time ("2 dk sonra"); a time in the past reads "şimdi". */
export function Until(props: { readonly iso: string }): ReactNode {
  const now = useNow();
  const fmt = useFormat();
  const t = Date.parse(props.iso);
  const s = Number.isNaN(t) ? 0 : Math.round((t - now) / 1000);
  const text =
    s <= 0
      ? 'şimdi'
      : s < 60
        ? `${String(s)} sn sonra`
        : s < 3600
          ? `${String(Math.round(s / 60))} dk sonra`
          : `${String(Math.round(s / 3600))} sa sonra`;
  return (
    <time dateTime={props.iso} title={fmt.dateWith(props.iso, DATE_TIME_NUMERIC)}>
      {text}
    </time>
  );
}

/** Splits a series into runs without nulls (an hour without checks breaks the line). */
export function runs(values: readonly (number | null)[]): { i: number; v: number }[][] {
  const out: { i: number; v: number }[][] = [];
  let cur: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length > 0) out.push(cur);
      cur = [];
    } else cur.push({ i, v });
  });
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * The 24 hourly latency points (oldest first) as a small line: 2 px stroke, a 10 % wash, the newest point as a dot
 * with a surface ring; an hour without checks breaks the line (no invented values).
 */
export function LatencyLine(props: {
  readonly values: readonly (number | null)[];
  readonly label: string;
}): ReactNode {
  const w = 120;
  const h = 28;
  const pad = 3;
  const vals = props.values;
  const max = Math.max(1, ...vals.map((v) => v ?? 0));
  const n = vals.length;
  const x = (i: number): number => (n <= 1 ? w / 2 : pad + (i * (w - pad * 2)) / (n - 1));
  const y = (v: number): number => h - pad - (v / max) * (h - pad * 2);
  const segments = runs(vals);
  const lastIdx = vals.reduce<number>((acc, v, i) => (v === null ? acc : i), -1);
  const last = lastIdx < 0 ? null : (vals[lastIdx] ?? null);
  return (
    <svg
      viewBox={`0 0 ${String(w)} ${String(h)}`}
      width={w}
      height={h}
      role="img"
      aria-label={props.label}
      data-testid="sparkline"
      className={cx('block shrink-0 overflow-visible', INK.teal)}
    >
      <title>{props.label}</title>
      <line x1={pad} x2={w - pad} y1={h - pad} y2={h - pad} stroke="var(--dy-line)" strokeWidth={1} />
      {segments.map((seg) => {
        const line = seg
          .map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`)
          .join(' ');
        const first = seg[0];
        const end = seg[seg.length - 1];
        const area =
          first === undefined || end === undefined || seg.length < 2
            ? null
            : `${line} L${x(end.i).toFixed(1)} ${String(h - pad)} L${x(first.i).toFixed(1)} ${String(h - pad)} Z`;
        return (
          <g key={first?.i ?? 0}>
            {area === null ? null : <path d={area} fill="currentColor" opacity={0.1} />}
            <path
              d={line}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        );
      })}
      {last === null ? null : (
        <circle
          cx={x(lastIdx)}
          cy={y(last)}
          r={3.5}
          fill="currentColor"
          stroke="var(--dy-card)"
          strokeWidth={2}
        />
      )}
    </svg>
  );
}
