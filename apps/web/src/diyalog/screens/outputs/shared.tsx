import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Messages } from '@remyral/i18n';
import { type OutputItem, type OutputSite, type SiteMonitor, siteProviderText } from '../../../api/outputs';
import { pct } from '../../../api/uptime';
import { screenshotUrl } from '../../../api/verify';
import { cx } from '../../../components/ui';
import { parseMarkdown, renderInline } from '../../../screens/workspace/MarkdownView';
import { DyIcon, type IconName } from '../../icons';
import { INK, type Tone } from '../../tone';
import { DyTime } from '../../common/time';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog-w2 (docs/design/p12-diyalog.md §12, Çıktılar): the shared parts of the Diyalog Outputs screen — who may
 * write, time words, a Markdown view on the classic parser (React elements only, no HTML, no links), and the site
 * health / uptime badges in the Diyalog language.
 */

export interface Viewer {
  readonly userId: string;
  /** Owner / admin: may edit and delete anyone's note. */
  readonly admin: boolean;
  /** Projects where the viewer may write (operator and above). */
  readonly writable: ReadonlySet<string>;
}

export function canEdit(viewer: Viewer, authorId: string | null): boolean {
  return viewer.admin || (authorId !== null && authorId === viewer.userId);
}

export { whenText } from '../../common/time';

/** Where a site runs: product names as they are, the tunnel's "preview link" in the user's language. */
export function siteWhere(site: Pick<OutputSite, 'provider' | 'env'>, t: Messages['outputs']): string {
  const provider = site.provider === 'tunnel' ? t.tunnel : siteProviderText(site.provider);
  return `${provider} · ${site.env === 'production' ? 'production' : t.preview}`;
}

/** A `<time>` with the relative words (moving with the shared clock; a time ahead reads "… sonra"). */
export function When(props: { readonly iso: string; readonly className?: string }): ReactNode {
  return <DyTime iso={props.iso} className={props.className} future />;
}

const H_CLASS: Readonly<Record<number, string>> = {
  1: 'text-[1.125rem] font-extrabold',
  2: 'text-[1rem] font-bold',
  3: 'text-[0.9375rem] font-bold',
};

/** Untrusted Markdown as React elements (the classic parser: headings, lists, code, bold, inline code). */
export function DyMarkdown(props: { readonly source: string; readonly className?: string }): ReactNode {
  const blocks = parseMarkdown(props.source);
  return (
    <div
      className={cx('flex flex-col gap-2 text-[0.9375rem] leading-relaxed break-words', props.className)}
      data-testid="markdown-view"
    >
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading': {
            const Tag = `h${String(Math.min(6, b.level + 2))}` as 'h3' | 'h4' | 'h5' | 'h6';
            return (
              <Tag key={i} className={cx('m-0', H_CLASS[b.level] ?? 'text-[0.9375rem] font-bold')}>
                {renderInline(b.text)}
              </Tag>
            );
          }
          case 'paragraph':
            return (
              <p key={i} className="m-0">
                {renderInline(b.text)}
              </p>
            );
          case 'list': {
            const items = b.items.map((t, j) => <li key={j}>{renderInline(t)}</li>);
            return b.ordered ? (
              <ol key={i} className="m-0 list-decimal pl-6">
                {items}
              </ol>
            ) : (
              <ul key={i} className="m-0 list-disc pl-6">
                {items}
              </ul>
            );
          }
          case 'code':
            return (
              <pre
                key={i}
                className="m-0 overflow-auto rounded-[10px] bg-dy-sunk p-3 font-dy-mono text-[0.8125rem] whitespace-pre"
              >
                {b.text}
              </pre>
            );
          case 'rule':
            return <hr key={i} className="w-full border-dy-line" />;
        }
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ site badges

type HealthState = 'pending' | 'checking' | 'browser' | 'passed' | 'warned' | 'failed' | 'error' | 'skipped';

const HEALTH: Readonly<Record<HealthState, { readonly tone: Tone; readonly icon: IconName }>> = {
  pending: { tone: 'teal', icon: 'clock' },
  checking: { tone: 'teal', icon: 'clock' },
  browser: { tone: 'teal', icon: 'clock' },
  passed: { tone: 'green', icon: 'checkc' },
  warned: { tone: 'amber', icon: 'flag' },
  failed: { tone: 'red', icon: 'xc' },
  error: { tone: 'red', icon: 'xc' },
  skipped: { tone: 'neutral', icon: 'pause' },
};

function isHealthState(s: string): s is HealthState {
  return Object.hasOwn(HEALTH, s);
}

/** The last post-deploy health check: state word + icon, HTTP / latency / broken links, when; links to the deploy. */
export function HealthBadge(props: { readonly item: OutputItem }): ReactNode {
  const t = useT().outputs.health;
  const h = props.item.health;
  if (h === null) return null;
  const s = isHealthState(h.state)
    ? { ...HEALTH[h.state], text: t.states[h.state] }
    : { text: h.state, tone: 'neutral' as Tone, icon: 'flag' as IconName };
  const facts = [
    h.statusCode === null ? null : `HTTP ${String(h.statusCode)}`,
    h.latencyMs === null ? null : `${String(h.latencyMs)} ms`,
    h.broken > 0 ? t.broken({ n: h.broken }) : null,
  ].filter((x): x is string => x !== null);
  const action = props.item.site?.provider !== 'tunnel' ? props.item.site?.opsActionId : undefined;
  const word = (
    <span className={cx('inline-flex items-center gap-1 font-bold', INK[s.tone])}>
      <DyIcon name={s.icon} className="size-3.5" />
      {s.text}
    </span>
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-[0.8125rem]" data-testid="site-health">
      {action !== undefined && action !== '' ? (
        <Link
          to={`/deploys/${encodeURIComponent(action)}`}
          title={t.openDeploy}
          className="no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
        >
          {word}
        </Link>
      ) : (
        word
      )}
      {facts.length > 0 ? <span className="text-dy-muted">{facts.join(' · ')}</span> : null}
      <span className="text-dy-muted">
        · <When iso={h.checkedAt} />
      </span>
    </span>
  );
}

export function HealthThumb(props: { readonly item: OutputItem; readonly large?: boolean }): ReactNode {
  const t = useT().outputs.health;
  const shot = props.item.health?.screenshot ?? null;
  if (shot === null) return null;
  return (
    <img
      src={screenshotUrl(shot)}
      alt={t.shotAlt({ name: props.item.name })}
      loading="lazy"
      data-testid="site-health-thumb"
      className={
        props.large === true
          ? 'w-full rounded-[10px] border border-dy-line object-cover object-top'
          : 'h-20 w-32 shrink-0 rounded-[8px] border border-dy-line object-cover object-top'
      }
    />
  );
}

export type UpState = 'up' | 'down' | 'pending' | 'paused';

const UP: Readonly<Record<UpState, { readonly tone: Tone; readonly icon: IconName }>> = {
  up: { tone: 'green', icon: 'checkc' },
  down: { tone: 'red', icon: 'xc' },
  pending: { tone: 'amber', icon: 'clock' },
  paused: { tone: 'neutral', icon: 'pause' },
};

export function UpWord(props: { readonly state: UpState }): ReactNode {
  const words = useT().outputs.up.states;
  const u = UP[props.state];
  return (
    <span
      className={cx('inline-flex items-center gap-1 font-bold', INK[u.tone])}
      data-testid="status-dot"
      data-status={props.state}
    >
      <DyIcon name={u.icon} className="size-3.5" />
      {words[props.state]}
    </span>
  );
}

export function upState(m: Pick<SiteMonitor, 'status' | 'paused'>): UpState {
  return m.paused ? 'paused' : m.status;
}

function lead(item: OutputItem): SiteMonitor | undefined {
  const ms = item.uptime?.monitors ?? [];
  return ms.find((m) => m.type === 'http' || m.type === 'tcp') ?? ms[0];
}

/** The site's uptime state and 24 h figure, linking to its lead monitor; nothing without monitors. */
export function UptimeBadge(props: { readonly item: OutputItem }): ReactNode {
  const t = useT().outputs;
  const u = props.item.uptime;
  const m = lead(props.item);
  if (u === null || m === undefined) return null;
  return (
    <Link
      to={`/uptime/${encodeURIComponent(m.id)}`}
      className="inline-flex items-center gap-1.5 text-[0.8125rem] no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
      data-testid="site-uptime"
      title={t.up.openMonitor}
    >
      <UpWord state={u.status ?? 'paused'} />
      <span className="font-dy-mono text-dy-muted">{`${pct(u.uptime24h)} · ${t.last24h}`}</span>
    </Link>
  );
}
