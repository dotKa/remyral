import { fill } from '@remyral/i18n';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  type Delivery,
  type DeliveryAttempt,
  type DeliveryStatus,
  getDelivery,
  type HeaderInput,
  listDeliveries,
  redeliver,
  verifySnippet,
  type Webhook,
  type WebhookCatalog,
  type WebhookInput,
} from '../../../api/webhooks';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyTime } from '../../common/time';
import type { Tone } from '../../tone';
import { CopyLine, DyApiError, DyCheck, DyDialog, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, DySelect, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p16-webhooks-out (docs/design/p16-webhooks-out.md §8): the parts of Ayarlar → Webhook'lar — the create form (events
 * grouped as in the catalog, project, details, custom headers with secret values), the shown-once secret with a
 * verification snippet, the rotate dialog and the delivery log (status, attempts, HTTP code, latency, redelivery, the
 * attempts of one delivery and its exact body).
 */

type Messages = ReturnType<typeof useT>['webhooks'];

const HTTPS = 'https://'; // i18n-ignore: a URL scheme, the same in every language

/** The console label of an event type (`job.failed` → its sentence), the type itself when unknown. */
export function eventLabel(t: Messages, type: string): string {
  const labels = t.events as Readonly<Record<string, string>>;
  return labels[type.replaceAll('.', '_')] ?? type;
}

/** A delivery error code in words (`http_503` → "HTTP 503"). */
export function errorText(t: Messages, code: string | null): string {
  if (code === null) return '';
  const m = /^http_(\d{3})$/.exec(code);
  if (m?.[1] !== undefined) return fill(t.errors.http, { code: m[1] });
  const words = t.errors as Readonly<Record<string, string>>;
  return words[code] ?? code;
}

export function stateTone(w: Webhook): Tone {
  if (w.state === 'disabled') return 'red';
  if (w.state === 'paused') return 'neutral';
  return w.consecutiveFailures > 0 ? 'amber' : 'green';
}

function deliveryTone(d: Delivery): Tone {
  return d.status === 'succeeded' ? 'green' : d.status === 'failed' ? 'red' : 'amber';
}

/** The new secret, once: a copy line and the receiver-side check. */
export function WebhookSecret(props: { readonly secret: string; readonly onClose: () => void }): ReactNode {
  const t = useT().webhooks.secret;
  return (
    <section
      aria-label={t.title}
      data-testid="webhook-secret"
      className="grid gap-3 rounded-[var(--dy-r-card)] border border-dy-amber bg-dy-card p-4"
    >
      <h2 className="m-0 text-[1rem] font-bold">{t.title}</h2>
      <DyNotice tone="amber" icon="flag">
        {t.warning}
      </DyNotice>
      <CopyLine text={props.secret} about={t.copy} testId="webhook-secret-value" />
      <div className="grid gap-1">
        <span className="text-[0.8125rem] font-bold">{t.verify}</span>
        <pre className="m-0 overflow-x-auto rounded-md bg-dy-sunk p-3 font-dy-mono text-[0.75rem] whitespace-pre">
          {verifySnippet()}
        </pre>
      </div>
      <FormActions>
        <DyButton variant="primary" onClick={props.onClose} data-testid="webhook-secret-done">
          {t.done}
        </DyButton>
      </FormActions>
    </section>
  );
}

interface HeaderRow {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
}

/** The create form. Every create runs through the step-up provider (event `integrations.webhooks`). */
export function CreateWebhookForm(props: {
  readonly catalog: WebhookCatalog;
  readonly projects: readonly string[];
  readonly create: (input: WebhookInput) => Promise<{ webhook: Webhook; secret: string }>;
  readonly onCreated: (out: { webhook: Webhook; secret: string }) => void;
}): ReactNode {
  const t = useT().webhooks;
  const stepUp = useStepUp();
  const submit = useSubmit();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [project, setProject] = useState('');
  const [types, setTypes] = useState<readonly string[]>([]);
  const [details, setDetails] = useState(false);
  const [headers, setHeaders] = useState<readonly HeaderRow[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const global = new Set(props.catalog.events.filter((e) => e.global).map((e) => e.type));
  const groups = t.create.groups as Readonly<Record<string, string>>;

  function send(): void {
    setProblem(null);
    const missing =
      name.trim() === ''
        ? t.create.nameRequired
        : !url.trim().startsWith('https://')
          ? t.create.urlRequired
          : types.length === 0
            ? t.create.eventsRequired
            : null;
    if (missing !== null) {
      setProblem(missing);
      return;
    }
    const hs: HeaderInput[] = headers
      .filter((h) => h.name.trim() !== '')
      .map((h) => ({ name: h.name.trim(), value: h.value, ...(h.secret ? { secret: true } : {}) }));
    void submit.run(async () => {
      try {
        const out = await stepUp.run(
          () =>
            props.create({
              name: name.trim(),
              url: url.trim(),
              project: project === '' ? null : project,
              eventTypes: types,
              includeDetails: details,
              ...(hs.length === 0 ? {} : { headers: hs }),
            }),
          t.create.stepUp,
        );
        setName('');
        setUrl('');
        setTypes([]);
        setHeaders([]);
        setDetails(false);
        props.onCreated(out);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  }

  return (
    <form
      className="grid gap-4"
      data-testid="webhook-create"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <DyField
        label={t.create.name}
        value={name}
        maxLength={80}
        placeholder={t.create.namePlaceholder}
        error={problem === t.create.nameRequired ? problem : undefined}
        onChange={setName}
      />
      <DyField
        label={t.create.url}
        value={url}
        mono
        maxLength={2000}
        placeholder={HTTPS}
        hint={t.create.urlHint}
        error={problem === t.create.urlRequired ? problem : undefined}
        onChange={setUrl}
      />
      <DySelect
        label={t.create.project}
        value={project}
        options={[['', t.create.allProjects] as const, ...props.projects.map((p) => [p, p] as const)]}
        onChange={setProject}
      />
      <fieldset className="m-0 grid gap-3 border-0 p-0" data-testid="webhook-events">
        <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{t.create.events}</legend>
        <p className="m-0 text-[0.78125rem] text-dy-muted">{t.create.eventsHint}</p>
        {Object.entries(props.catalog.groups).map(([g, list]) => (
          <div key={g} className="grid gap-0.5">
            <span className="text-[0.75rem] font-bold tracking-wide text-dy-muted uppercase">
              {groups[g] ?? g}
            </span>
            {list.map((type) => (
              <DyCheck
                key={type}
                testId={`webhook-event-${type}`}
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    {eventLabel(t, type)}
                    <span className="font-dy-mono text-[0.75rem] text-dy-muted">{type}</span>
                    {global.has(type) ? <Pill tone="neutral">{t.create.global}</Pill> : null}
                  </span>
                }
                checked={types.includes(type)}
                disabled={project !== '' && global.has(type)}
                onChange={(on) => {
                  setTypes(on ? [...types.filter((x) => x !== type), type] : types.filter((x) => x !== type));
                }}
              />
            ))}
          </div>
        ))}
        {problem === t.create.eventsRequired ? (
          <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{problem}</p>
        ) : null}
      </fieldset>
      <DyCheck
        testId="webhook-details"
        label={t.create.includeDetails}
        hint={t.create.includeDetailsHint}
        checked={details}
        onChange={setDetails}
      />
      <fieldset className="m-0 grid gap-2 border-0 p-0" data-testid="webhook-headers">
        <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{t.create.headers}</legend>
        <p className="m-0 text-[0.78125rem] text-dy-muted">{t.create.headersHint}</p>
        {headers.map((h, i) => (
          <div key={i} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1.4fr_auto_auto]">
            <DyField
              label={t.create.headerName}
              value={h.name}
              maxLength={64}
              mono
              onChange={(v) => {
                setHeaders(headers.map((x, j) => (j === i ? { ...x, name: v } : x)));
              }}
            />
            <DyField
              label={t.create.headerValue}
              value={h.value}
              maxLength={1000}
              type={h.secret ? 'password' : 'text'}
              autoComplete="off"
              mono
              onChange={(v) => {
                setHeaders(headers.map((x, j) => (j === i ? { ...x, value: v } : x)));
              }}
            />
            <DyCheck
              label={t.create.headerSecret}
              checked={h.secret}
              onChange={(on) => {
                setHeaders(headers.map((x, j) => (j === i ? { ...x, secret: on } : x)));
              }}
            />
            <DyButton
              icon="trash"
              aria-label={fill(t.create.removeHeader, { name: h.name === '' ? String(i + 1) : h.name })}
              onClick={() => {
                setHeaders(headers.filter((_, j) => j !== i));
              }}
            >
              {''}
            </DyButton>
          </div>
        ))}
        {headers.length < 10 ? (
          <div>
            <DyButton
              icon="plus"
              data-testid="webhook-add-header"
              onClick={() => {
                setHeaders([...headers, { name: '', value: '', secret: false }]);
              }}
            >
              {t.create.addHeader}
            </DyButton>
          </div>
        ) : null}
      </fieldset>
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      <FormActions>
        <DyButton type="submit" variant="primary" icon="send" busy={submit.busy} data-testid="webhook-submit">
          {submit.busy ? t.create.submitting : t.create.submit}
        </DyButton>
      </FormActions>
    </form>
  );
}

const OVERLAPS: readonly number[] = [0, 1, 24, 72, 168];

/** Rotate: how long the previous secret keeps signing; then the new secret, once. */
export function RotateWebhookDialog(props: {
  readonly webhook: Webhook | null;
  readonly rotate: (w: Webhook, overlapHours: number) => Promise<{ webhook: Webhook; secret: string }>;
  readonly onClose: () => void;
  readonly onRotated: (out: { webhook: Webhook; secret: string }) => void;
}): ReactNode {
  const t = useT().webhooks.rotate;
  const stepUp = useStepUp();
  const submit = useSubmit();
  const [overlap, setOverlap] = useState(24);
  const w = props.webhook;

  function go(): void {
    if (w === null) return;
    void submit.run(async () => {
      try {
        props.onRotated(await stepUp.run(() => props.rotate(w, overlap), t.stepUp));
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  }

  return (
    <DyDialog
      open={w !== null}
      onClose={props.onClose}
      title={w === null ? '' : fill(t.title, { name: w.name })}
      description={t.sub}
      backdropClose={false}
      testId="webhook-rotate-dialog"
      footer={
        <>
          <DyButton onClick={props.onClose}>{t.cancel}</DyButton>
          <DyButton
            variant="primary"
            icon="retry"
            busy={submit.busy}
            onClick={go}
            data-testid="webhook-rotate-go"
          >
            {t.submit}
          </DyButton>
        </>
      }
    >
      <div className="grid gap-3">
        <DySelect
          label={t.overlap}
          value={String(overlap)}
          options={OVERLAPS.map(
            (h) => [String(h), h === 0 ? t.overlapNone : fill(t.overlapHours, { n: h })] as const,
          )}
          onChange={(v) => {
            setOverlap(Number(v));
          }}
        />
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </DyDialog>
  );
}

/** The attempts and the exact body of one delivery. */
function DeliveryDetail(props: { readonly webhookId: string; readonly delivery: Delivery }): ReactNode {
  const t = useT().webhooks;
  const [detail, setDetail] = useState<{ attempts: DeliveryAttempt[]; body: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    getDelivery(props.webhookId, props.delivery.id)
      .then((d) => {
        setDetail(d);
      })
      .catch((err: unknown) => {
        setError(toApiError(err));
      });
  }, [props.webhookId, props.delivery.id]);
  if (error !== null) return <DyApiError error={error} />;
  if (detail === null) return <SkeletonRows label={t.loading} rows={1} />;
  return (
    <div className="grid gap-2" data-testid="webhook-delivery-detail">
      <CopyLine text={props.delivery.id} about={t.deliveries.deliveryId} />
      <ul className="m-0 grid gap-1 p-0">
        {detail.attempts.map((a) => (
          <li key={a.attempt} className="list-none text-[0.8125rem]">
            <span className="font-bold">{fill(t.deliveries.attempt, { n: a.attempt })}</span>{' '}
            <DyTime iso={a.startedAt} />
            {a.statusCode === null ? null : <> · {fill(t.deliveries.code, { code: a.statusCode })}</>}
            {a.latencyMs === null ? null : <> · {fill(t.deliveries.latency, { ms: a.latencyMs })}</>}
            {a.error === null ? null : <> · {errorText(t, a.error)}</>}
            {a.responseExcerpt === null ? null : (
              <pre
                aria-label={t.deliveries.response}
                className="m-0 mt-1 overflow-x-auto rounded bg-dy-sunk p-2 font-dy-mono text-[0.75rem] whitespace-pre-wrap"
              >
                {a.responseExcerpt}
              </pre>
            )}
          </li>
        ))}
      </ul>
      <span className="text-[0.8125rem] font-bold">{t.deliveries.body}</span>
      <pre className="m-0 max-h-64 overflow-auto rounded bg-dy-sunk p-2 font-dy-mono text-[0.75rem] whitespace-pre-wrap">
        {(() => {
          try {
            return JSON.stringify(JSON.parse(detail.body), null, 2);
          } catch {
            return detail.body;
          }
        })()}
      </pre>
    </div>
  );
}

/** The delivery log of one webhook (newest first): filter, pages, details, redelivery. */
export function DeliveryLog(props: { readonly webhook: Webhook }): ReactNode {
  const t = useT().webhooks;
  const fmt = useFormat();
  const submit = useSubmit();
  const [items, setItems] = useState<readonly Delivery[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<DeliveryStatus | ''>('');
  const [open, setOpen] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'webhook-deliveries-done' });
  const [error, setError] = useState<ApiError | null>(null);
  const id = props.webhook.id;

  const load = useCallback(
    async (before?: string) => {
      try {
        const out = await listDeliveries(id, {
          ...(status === '' ? {} : { status }),
          ...(before === undefined ? {} : { before }),
        });
        setItems((prev) => (before === undefined || prev === null ? out.items : [...prev, ...out.items]));
        setCursor(out.nextCursor);
        setError(null);
      } catch (err) {
        setError(toApiError(err));
      }
    },
    [id, status],
  );

  useEffect(() => {
    void load();
  }, [load]);

  function again(d: Delivery): void {
    setDone(null);
    void submit.run(async () => {
      await redeliver(id, d.id);
      setDone(t.deliveries.redelivered);
      await load();
    });
  }

  return (
    <Panel
      title={fill(t.deliveries.title, { name: props.webhook.name })}
      flush
      testId="webhook-deliveries"
      aside={
        <DySelect
          label={t.deliveries.filter}
          value={status}
          options={[
            ['', t.deliveries.filterAll] as const,
            ['pending', t.deliveries.status.pending] as const,
            ['succeeded', t.deliveries.status.succeeded] as const,
            ['failed', t.deliveries.status.failed] as const,
          ]}
          onChange={(v) => {
            setStatus(v === 'pending' || v === 'succeeded' || v === 'failed' ? v : '');
          }}
        />
      }
    >
      {error !== null ? (
        <div className="p-4">
          <DyApiError error={error} />
        </div>
      ) : items === null ? (
        <SkeletonRows label={t.loading} rows={3} />
      ) : items.length === 0 ? (
        <EmptyLine testId="webhook-deliveries-empty">{t.deliveries.empty}</EmptyLine>
      ) : (
        <Rows label={fill(t.deliveries.title, { name: props.webhook.name })}>
          {items.map((d) => (
            <Row
              key={d.id}
              testId="webhook-delivery-row"
              tone={deliveryTone(d)}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {eventLabel(t, d.eventType)}
                  <span className="font-dy-mono text-[0.75rem] text-dy-muted">{d.eventType}</span>
                  <Pill tone={deliveryTone(d)}>{t.deliveries.status[d.status]}</Pill>
                  {d.test ? <Pill tone="neutral">{t.deliveries.test}</Pill> : null}
                </span>
              }
              meta={
                <>
                  <span>
                    <DyTime iso={d.lastAttemptAt ?? d.createdAt} />
                  </span>
                  <span>{fill(t.deliveries.attempts, { n: d.attempts })}</span>
                  {d.lastStatusCode === null ? null : (
                    <span>{fill(t.deliveries.code, { code: d.lastStatusCode })}</span>
                  )}
                  {d.lastLatencyMs === null ? null : (
                    <span>{fill(t.deliveries.latency, { ms: d.lastLatencyMs })}</span>
                  )}
                  {d.lastError === null ? null : <span>{errorText(t, d.lastError)}</span>}
                  {d.nextAttemptAt === null ? null : (
                    <span>{fill(t.deliveries.next, { time: fmt.dateTime(d.nextAttemptAt) })}</span>
                  )}
                  {open === d.id ? (
                    <div className="w-full pt-2">
                      <DeliveryDetail webhookId={id} delivery={d} />
                    </div>
                  ) : null}
                </>
              }
              actions={
                <>
                  <DyButton
                    data-testid={`webhook-delivery-details-${d.id}`}
                    onClick={() => {
                      setOpen(open === d.id ? null : d.id);
                    }}
                  >
                    {open === d.id ? t.deliveries.hideDetails : t.deliveries.details}
                  </DyButton>
                  {d.status === 'pending' || d.test ? null : (
                    <DyButton
                      icon="retry"
                      disabled={submit.busy}
                      data-testid={`webhook-redeliver-${d.id}`}
                      onClick={() => {
                        again(d);
                      }}
                    >
                      {t.deliveries.redeliver}
                    </DyButton>
                  )}
                </>
              }
            />
          ))}
        </Rows>
      )}
      <div className="flex flex-col gap-2 px-4 pb-4 empty:hidden">
        {cursor === null ? null : (
          <div>
            <DyButton
              onClick={() => {
                void load(cursor);
              }}
            >
              {t.deliveries.more}
            </DyButton>
          </div>
        )}
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </Panel>
  );
}
