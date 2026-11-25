import { type ReactNode, type SubmitEvent, useId, useState } from 'react';
import { Link } from 'react-router';
import { idempotencyKey } from '../../api/deploy';
import {
  closePreview,
  type ConnectorState,
  extendPreview,
  getJobPreviews,
  openPreview,
  PROTECTIONS,
  type PreviewProtection,
  revealServiceToken,
  safePreviewUrl,
  type TunnelView,
} from '../../api/previews';
import { useAuth } from '../../auth/AuthProvider';
import { cx } from '../../components/ui';
import { useSubmit } from '../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';
import { DyConfirm } from '../common/actions';
import { Countdown } from '../Countdown';
import { CardButton, LiveCard } from '../LiveCard';
import { type DyState, StateBadge } from '../StateBadge';
import { dateTimeText } from './details/bits';
import { useResource } from './resource';
import type { JobCardProps } from './types';
import { toast } from '../toast/store';
import type { Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../i18n/I18nProvider';

/**
 * p12-diyalog-w1: the job's preview tunnels (p8-preview-tunnels, ADR-0032) as a side panel of the control panel,
 * with every control of the classic `JobPreviewCard` natively in the Diyalog language (docs/design/p12-diyalog.md §14):
 * state, the link (https only after `safePreviewUrl`, opened outside the console with noopener), protection (a public
 * link carries a warning), stable address, port, time left / ended, the connector on the machine, who opened it and
 * its ops action, the service-token client id; +1 sa / +4 sa within the limit, Kapat; "Yeni önizleme aç" (port, name,
 * protection, hours, stable address — same validation) and, for admins with a fresh code, "Servis anahtarını göster"
 * once. Polls every 5 s while a preview is open or on its way. Master text is rendered as text.
 */

type PreviewWords = Messages['jobCards']['previews'];

function protectionText(w: PreviewWords, p: PreviewProtection): string {
  return p === 'service-token' ? w.protection.serviceToken : w.protection[p];
}

function connectorText(w: PreviewWords, c: ConnectorState): string {
  return w.connector[c];
}

function tunnelState(t: TunnelView, w: PreviewWords): { state: DyState; label: string } {
  switch (t.state) {
    case 'active':
      return t.connector?.state === 'running'
        ? { state: 'done', label: w.state.open }
        : { state: 'stale', label: w.state.waitingConnector };
    case 'opening':
      return { state: 'running', label: w.state.opening };
    case 'idle':
      return { state: 'stale', label: w.state.idle };
    case 'closing':
      return { state: 'running', label: w.state.closing };
    case 'failed':
      return { state: 'failed', label: w.state.failed };
    default:
      return { state: 'cancelled', label: w.state.closed };
  }
}

const isOpen = (t: TunnelView): boolean =>
  t.state === 'active' || t.state === 'opening' || t.state === 'idle';

function ErrorText(props: {
  readonly error: { readonly message: string } | null;
  readonly retryLeft: number;
}): ReactNode {
  const e = useT().shared.errors;
  if (props.error === null) return null;
  return (
    <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
      {props.error.message}
      {props.retryLeft > 0 ? ` ${e.retryIn({ wait: e.wait({ seconds: props.retryLeft }) })}` : ''}
    </p>
  );
}

function TunnelItem(props: {
  readonly t: TunnelView;
  readonly maxTtlMinutes: number;
  readonly canAct: boolean;
  readonly isAdmin: boolean;
  readonly onChanged: () => void;
}): ReactNode {
  const fmt = useFormat();
  const w = useT().jobCards.previews;
  const { t } = props;
  const stepUp = useStepUp();
  const act = useSubmit();
  const needsWord = useT().shared.actionToast.openNeeds;
  const [secret, setSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const url = safePreviewUrl(t.url);
  const open = isOpen(t);
  const st = tunnelState(t, w);
  const leftMin = Math.floor((Date.parse(t.expiresAt) - Date.now()) / 60_000);
  const limit = t.stable ? 30 * 24 * 60 : props.maxTtlMinutes;
  const run = (fn: () => Promise<{ action: { state: string } }>): void => {
    void act.run(async () => {
      const r = await fn();
      // p17-toasts-shortcuts: "waits for approval" is a toast with the way to the decision.
      if (r.action.state === 'awaiting_approval')
        toast.info(w.awaitingApproval, {
          id: `preview-${t.id}`,
          testId: 'preview-awaiting',
          actions: [{ label: needsWord, to: '/needs' }],
        });
      props.onChanged();
    });
  };
  return (
    <li className="grid gap-2 py-2.5" data-testid="dy-preview-row">
      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <b className="font-bold">{t.name}</b>
        <StateBadge state={st.state} label={st.label} />
        <span
          className={cx(
            'text-[0.8125rem]',
            t.protection === 'none' ? 'font-bold text-dy-amber-ink' : 'text-dy-muted',
          )}
        >
          {protectionText(w, t.protection)}
        </span>
        {t.stable ? <span className="text-[0.8125rem] font-medium text-dy-teal-ink">{w.stable}</span> : null}
        {t.port === null ? null : (
          <span className="font-dy-mono text-[0.8125rem] text-dy-muted">{`port ${String(t.port)}`}</span>
        )}
      </span>
      {url !== null && open ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="dy-preview-url"
          className="justify-self-start font-dy-mono text-[0.8125rem] text-dy-teal-ink underline-offset-2 [overflow-wrap:anywhere] hover:underline"
        >
          {url}
        </a>
      ) : (
        <span className="font-dy-mono text-[0.8125rem] break-all text-dy-muted">{t.hostname}</span>
      )}
      {t.protection === 'none' && open ? (
        <p
          className="m-0 rounded-[9px] bg-dy-amber-soft px-2.5 py-1.5 text-[0.8125rem] text-dy-amber-ink"
          data-testid="dy-preview-public"
        >
          {w.publicWarning}
        </p>
      ) : null}
      {open && Date.parse(t.expiresAt) > Date.now() ? (
        <Countdown until={t.expiresAt} from={t.createdAt} label={w.closesIn} tone="neutral" />
      ) : null}
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[0.8125rem] text-dy-muted">
        {open ? null : (
          <>
            <dt>{w.closed}</dt>
            <dd className="m-0">{t.closedAt === null ? '—' : dateTimeText(t.closedAt, fmt)}</dd>
          </>
        )}
        {t.connector === null ? null : (
          <>
            <dt>{w.machine}</dt>
            <dd className="m-0 [overflow-wrap:anywhere]" data-testid="dy-preview-connector">
              {`${connectorText(w, t.connector.state)}${t.connector.detail === null ? '' : `: ${t.connector.detail}`}`}
            </dd>
          </>
        )}
        {t.closeReason === null || open ? null : (
          <>
            <dt>{w.reason}</dt>
            <dd className="m-0 [overflow-wrap:anywhere]">{t.closeReason}</dd>
          </>
        )}
        <dt>{w.openedBy}</dt>
        <dd className="m-0">
          {t.openedBy.type === 'system' ? w.openedBySystem : (t.openedBy.username ?? t.openedBy.id)}
          {t.openActionId === null ? null : (
            <>
              {' · '}
              <Link
                to={`/deploys/${encodeURIComponent(t.openActionId)}`}
                className="text-dy-teal-ink underline-offset-2 hover:underline"
              >
                {w.opsRecord}
              </Link>
            </>
          )}
        </dd>
        {t.serviceTokenClientId === null ? null : (
          <>
            <dt>{w.clientId}</dt>
            <dd className="m-0 font-dy-mono break-all">{t.serviceTokenClientId}</dd>
          </>
        )}
      </dl>
      {secret === null ? null : (
        <div className="grid gap-1 rounded-[10px] bg-dy-sunk p-2.5 text-[0.8125rem]">
          <p className="m-0">{w.secretOnce}</p>
          <pre
            className="m-0 overflow-auto font-dy-mono text-[0.75rem] whitespace-pre-wrap"
            data-testid="dy-preview-secret"
          >
            {`CF-Access-Client-Id: ${secret.clientId}\nCF-Access-Client-Secret: ${secret.clientSecret}`}
          </pre>
        </div>
      )}
      {open && props.canAct ? (
        <span className="flex flex-wrap gap-2">
          {[60, 240].map((m) =>
            leftMin + m <= limit ? (
              <CardButton
                key={m}
                disabled={act.busy || act.blocked}
                onClick={() => {
                  run(() => extendPreview(t.id, m, idempotencyKey('preview-extend')));
                }}
              >
                {w.extend({ hours: m / 60 })}
              </CardButton>
            ) : null,
          )}
          {t.protection === 'service-token' && props.isAdmin && secret === null ? (
            <CardButton
              icon="key"
              disabled={act.busy || act.blocked}
              onClick={() => {
                void act.run(async () => {
                  try {
                    setSecret(await stepUp.run(() => revealServiceToken(t.id), w.stepUpReason));
                  } catch (err) {
                    if (!(err instanceof StepUpCancelledError)) throw err;
                  }
                });
              }}
            >
              {w.showKey}
            </CardButton>
          ) : null}
          <DyConfirm
            label={w.close}
            question={w.closeQuestion}
            confirmLabel={w.closeConfirm}
            busy={act.busy}
            disabled={act.blocked}
            testId="dy-preview-close"
            onConfirm={() => {
              run(() => closePreview(t.id, idempotencyKey('preview-close')));
            }}
          />
        </span>
      ) : null}
      <ErrorText error={act.error} retryLeft={act.retryLeft} />
    </li>
  );
}

const FIELD =
  'min-h-10 w-full min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.9375rem] text-dy-ink sm:min-h-9 sm:text-[0.875rem]';

/** "Yeni önizleme aç": the classic form's fields and validation (port 1024–65535, a name for a stable address). */
export function OpenPreviewForm(props: {
  readonly jobId: string;
  readonly protections: readonly PreviewProtection[];
  readonly defaultTtlMinutes: number;
  readonly maxTtlMinutes: number;
  readonly onOpened: (text: string, tone: 'red' | 'muted', actionId: string) => void;
}): ReactNode {
  const ids = useId();
  const w = useT().jobCards.previews;
  const [port, setPort] = useState('');
  const [name, setName] = useState('');
  const [protect, setProtect] = useState<PreviewProtection>('none');
  const [stable, setStable] = useState(false);
  const [hours, setHours] = useState(String(props.defaultTtlMinutes / 60));
  const submit = useSubmit();
  const portNum = Number.parseInt(port, 10);
  const valid = Number.isInteger(portNum) && portNum >= 1024 && portNum <= 65_535;
  const onSubmit = (e: SubmitEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!valid) return;
    void submit.run(async () => {
      const ttl = Math.round(Number.parseFloat(hours) * 60);
      const out = await openPreview(props.jobId, {
        port: portNum,
        ...(name.trim() === '' ? {} : { name: name.trim().toLowerCase() }),
        protect,
        ...(stable ? { stable: true } : {}),
        ...(Number.isFinite(ttl) && ttl > 0 ? { ttlMinutes: Math.min(ttl, props.maxTtlMinutes) } : {}),
        idempotencyKey: idempotencyKey('preview-open'),
      });
      const a = out.action;
      props.onOpened(
        a.state === 'refused'
          ? w.form.refused({ reason: a.policy.reason })
          : a.state === 'failed'
            ? w.form.failed({ error: a.error ?? null })
            : a.state === 'awaiting_approval'
              ? w.form.awaiting
              : w.form.opening,
        a.state === 'refused' || a.state === 'failed' ? 'red' : 'muted',
        a.id,
      );
      setPort('');
    });
  };
  const label = 'grid gap-1 text-[0.8125rem] font-bold';
  const hint = 'text-[0.75rem] font-normal text-dy-muted';
  return (
    <form onSubmit={onSubmit} className="grid gap-3 text-[0.875rem]" data-testid="dy-preview-open-form">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label} htmlFor={`${ids}-port`}>
          {w.form.port}
          <input
            id={`${ids}-port`}
            type="number"
            inputMode="numeric"
            min={1024}
            max={65535}
            value={port}
            onChange={(e) => {
              setPort(e.target.value);
            }}
            aria-describedby={`${ids}-port-hint`}
            className={FIELD}
          />
          <span id={`${ids}-port-hint`} className={hint}>
            {w.form.portHint}
          </span>
        </label>
        <label className={label} htmlFor={`${ids}-name`}>
          {w.form.name}
          <input
            id={`${ids}-name`}
            value={name}
            maxLength={20}
            onChange={(e) => {
              setName(e.target.value);
            }}
            className={FIELD}
          />
          <span className={hint}>{w.form.nameHint}</span>
        </label>
        <label className={label} htmlFor={`${ids}-protect`}>
          {w.form.protection}
          <select
            id={`${ids}-protect`}
            value={protect}
            onChange={(e) => {
              setProtect(e.target.value as PreviewProtection);
            }}
            className={FIELD}
          >
            {PROTECTIONS.filter((p) => props.protections.includes(p)).map((p) => (
              <option key={p} value={p}>
                {protectionText(w, p)}
              </option>
            ))}
          </select>
        </label>
        <label className={label} htmlFor={`${ids}-hours`}>
          {w.form.hours}
          <input
            id={`${ids}-hours`}
            type="number"
            min={0.25}
            max={props.maxTtlMinutes / 60}
            step={0.25}
            value={hours}
            onChange={(e) => {
              setHours(e.target.value);
            }}
            className={FIELD}
          />
        </label>
      </div>
      <label className="flex items-start gap-2.5" htmlFor={`${ids}-stable`}>
        <input
          id={`${ids}-stable`}
          type="checkbox"
          checked={stable}
          onChange={(e) => {
            setStable(e.target.checked);
          }}
          className="mt-1 size-4 accent-[var(--dy-teal)]"
        />
        <span>
          <b className="font-bold">{w.stable}</b>
          <span className="block text-[0.8125rem] text-dy-muted">{w.form.stableHint}</span>
        </span>
      </label>
      {protect === 'none' ? (
        <p className="m-0 text-[0.8125rem] text-dy-amber-ink">{w.form.publicNote}</p>
      ) : null}
      <span>
        <button
          type="submit"
          disabled={!valid || (stable && name.trim() === '') || submit.busy || submit.blocked}
          aria-busy={submit.busy || undefined}
          className="dy-press inline-flex min-h-9 items-center gap-1.5 rounded-[9px] border border-dy-ink bg-dy-ink px-3 text-[0.875rem] font-bold text-dy-card disabled:cursor-not-allowed disabled:opacity-55"
        >
          {w.form.submit}
        </button>
      </span>
      <ErrorText error={submit.error} retryLeft={submit.retryLeft} />
    </form>
  );
}

export function PreviewsCard(props: JobCardProps): ReactNode {
  const id = props.detail.job.id;
  const w = useT().jobCards.previews;
  const { state } = useAuth();
  const isAdmin = state.kind === 'signedIn' && (state.user.role === 'owner' || state.user.role === 'admin');
  const [formOpen, setFormOpen] = useState(false);
  const [opened, setOpened] = useState<{ text: string; tone: 'red' | 'muted'; actionId: string } | null>(
    null,
  );
  const { data, reload } = useResource((signal) => getJobPreviews(id, { signal }), `${id}:${props.state}`, {
    poll: (v) => v !== null && v.tunnels.some((t) => isOpen(t) || t.state === 'closing'),
    ms: 5_000,
  });
  // Nothing to show: previews are not configured for the project and the job never had one.
  if (data === null || (data.settings === null && data.tunnels.length === 0)) return null;
  const s = data.settings;
  const live = data.tunnels.filter(isOpen).length;
  const canOpen = !props.finished && s !== null && props.canAct;
  return (
    <LiveCard
      cardKey="job:previews"
      kind={{
        label: w.card.label,
        icon: 'globe',
        tone: data.tunnels.some((t) => t.protection === 'none' && t.state === 'active') ? 'amber' : 'teal',
      }}
      title={live > 0 ? w.card.live({ n: live }) : data.tunnels.length > 0 ? w.card.allClosed : w.card.none}
      actions={
        canOpen && data.available.ok ? (
          <CardButton
            icon={formOpen ? 'xc' : 'plus'}
            expanded={formOpen}
            onClick={() => {
              setFormOpen((v) => !v);
            }}
          >
            {formOpen ? w.card.closeForm : w.card.openNew}
          </CardButton>
        ) : undefined
      }
      panel={
        canOpen && data.available.ok && formOpen ? (
          <OpenPreviewForm
            jobId={id}
            protections={s.protections}
            defaultTtlMinutes={s.defaultTtlMinutes}
            maxTtlMinutes={s.maxTtlMinutes}
            onOpened={(text, tone, actionId) => {
              setOpened({ text, tone, actionId });
              setFormOpen(false);
              reload();
            }}
          />
        ) : undefined
      }
    >
      {data.tunnels.length === 0 ? null : (
        <ul
          className="m-0 grid list-none divide-y divide-dy-line p-0 text-[0.875rem]"
          aria-label={w.card.listLabel}
        >
          {data.tunnels.map((t) => (
            <TunnelItem
              key={t.id}
              t={t}
              maxTtlMinutes={s?.maxTtlMinutes ?? 1440}
              canAct={props.canAct}
              isAdmin={isAdmin}
              onChanged={reload}
            />
          ))}
        </ul>
      )}
      {opened === null ? null : (
        <p
          role={opened.tone === 'red' ? 'alert' : 'status'}
          className={cx(
            'm-0 mt-1 text-[0.8125rem]',
            opened.tone === 'red' ? 'text-dy-red-ink' : 'text-dy-muted',
          )}
        >
          {`${opened.text} `}
          <Link
            to={`/deploys/${encodeURIComponent(opened.actionId)}`}
            className="font-medium text-dy-teal-ink underline-offset-2 hover:underline"
          >
            {w.card.openRecord}
          </Link>
        </p>
      )}
      {!props.finished && s !== null && !data.available.ok ? (
        <p className="m-0 mt-1 text-[0.8125rem] text-dy-muted" data-testid="dy-preview-unavailable">
          {data.available.reason ?? w.card.unavailable}
        </p>
      ) : null}
    </LiveCard>
  );
}
