import { fill } from '@remyral/i18n';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../../auth/AuthProvider';
import type { ApiError } from '../../../api/client';
import { listProjects } from '../../../api/directory';
import {
  createWebhook,
  deleteWebhook,
  getWebhookCatalog,
  getWebhookSettings,
  listWebhooks,
  revealWebhookSecret,
  rotateWebhookSecret,
  setInternalOrigins,
  setWebhookState,
  testWebhook,
  type Webhook,
  type WebhookCatalog,
  type WebhookSettings,
} from '../../../api/webhooks';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyIcon } from '../../icons';
import { ConfirmButton, DyApiError, DyNotice, DyTextarea, FormActions } from '../forms';
import { DyButton, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import {
  CreateWebhookForm,
  DeliveryLog,
  errorText,
  eventLabel,
  RotateWebhookDialog,
  stateTone,
  WebhookSecret,
} from './webhooks-parts';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p16-webhooks-out (docs/design/p16-webhooks-out.md §8, ADR-0059): Ayarlar → Webhook'lar (owners and administrators).
 * Create (the secret shown once), list with state and last-24-hour counts, test, pause / resume, rotate the secret
 * with an overlap, show a never-shown secret once (a webhook the assistant made), delete, the delivery log with
 * redelivery, and the owner's internal targets. Creating, resuming, rotating, revealing and changing internal targets
 * go through the step-up provider; the master decides by the security policy.
 */
export function WebhooksView(): ReactNode {
  const t = useT().webhooks;
  const fmt = useFormat();
  const { state } = useAuth();
  const owner = state.kind === 'signedIn' && state.user.role === 'owner';
  const stepUp = useStepUp();
  const submit = useSubmit();
  const [items, setItems] = useState<readonly Webhook[] | null>(null);
  const [catalog, setCatalog] = useState<WebhookCatalog | null>(null);
  const [settings, setSettings] = useState<WebhookSettings | null>(null);
  const [projects, setProjects] = useState<readonly string[]>([]);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState<Webhook | null>(null);
  const [logOf, setLogOf] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'webhooks-done' });
  const [origins, setOrigins] = useState('');

  const load = useCallback(async () => {
    try {
      const [list, cat, s] = await Promise.all([listWebhooks(), getWebhookCatalog(), getWebhookSettings()]);
      setItems(list.items);
      setCatalog(cat);
      setSettings(s);
      setOrigins(s.internalOrigins.join('\n'));
      setLoadError(null);
    } catch (err) {
      setLoadError(toApiError(err));
    }
  }, []);

  useEffect(() => {
    void load();
    listProjects()
      .then((ps) => {
        setProjects(ps.map((p) => p.id));
      })
      .catch(() => undefined);
  }, [load]);

  function act(work: () => Promise<string | null>, ask?: string): void {
    setDone(null);
    void submit.run(async () => {
      try {
        const message = ask === undefined ? await work() : await stepUp.run(work, ask);
        if (message !== null) setDone(message);
        await load();
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  }

  if (items === null || catalog === null || settings === null)
    return loadError === null ? (
      <Panel title={t.pages.label}>
        <SkeletonRows label={t.loading} rows={3} />
      </Panel>
    ) : (
      <DyApiError error={loadError} />
    );

  const logHook = items.find((w) => w.id === logOf) ?? null;

  return (
    <div className="grid gap-4" data-testid="dy-webhooks">
      {secret === null ? null : (
        <WebhookSecret
          secret={secret}
          onClose={() => {
            setSecret(null);
          }}
        />
      )}
      <Panel title={t.create.title} sub={t.create.sub} testId="webhook-create-panel">
        <CreateWebhookForm
          catalog={catalog}
          projects={projects}
          create={createWebhook}
          onCreated={(out) => {
            setSecret(out.secret);
            setDone(fill(t.done.created, { name: out.webhook.name }));
            void load();
          }}
        />
      </Panel>
      <Panel
        title={t.list.title}
        count={String(items.length)}
        countLabel={fill(t.list.count, { n: items.length })}
        flush
        testId="webhook-list"
      >
        {items.length === 0 ? (
          <EmptyLine testId="webhooks-empty">{t.list.empty}</EmptyLine>
        ) : (
          <Rows label={t.list.title}>
            {items.map((w) => (
              <Row
                key={w.id}
                testId="webhook-row"
                lead={<DyIcon name="send" className="size-4" />}
                tone={stateTone(w)}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {w.name}
                    <Pill tone={stateTone(w)}>{t.states[w.state]}</Pill>
                    {w.includeDetails ? <Pill tone="violet">{t.list.details}</Pill> : null}
                  </span>
                }
                meta={
                  <>
                    <span className="font-dy-mono break-all">{w.url}</span>
                    <span>
                      {w.project === null ? t.list.allProjects : fill(t.list.project, { project: w.project })}
                    </span>
                    <span title={w.eventTypes.map((e) => eventLabel(t, e)).join(', ')}>
                      {fill(t.list.events, { n: w.eventTypes.length })}
                    </span>
                    <span>
                      {fill(t.list.last24h, {
                        ok: w.stats.succeeded24h,
                        failed: w.stats.failed24h,
                        pending: w.stats.pending,
                      })}
                    </span>
                    {w.consecutiveFailures > 0 ? (
                      <span>{fill(t.list.failures, { n: w.consecutiveFailures })}</span>
                    ) : null}
                    {w.headers.length === 0 ? null : (
                      <span>{fill(t.list.headers, { names: w.headers.map((h) => h.name).join(', ') })}</span>
                    )}
                    <span className="font-dy-mono">{w.secretHint}</span>
                    {w.previousValidUntil === null ? null : (
                      <span>{fill(t.list.overlap, { time: fmt.dateTime(w.previousValidUntil) })}</span>
                    )}
                    {w.secretRevealed ? null : <span>{t.list.secretNotShown}</span>}
                    {w.state === 'disabled' ? (
                      <div className="w-full pt-1">
                        <DyNotice tone="red" testId="webhook-disabled">
                          {fill(t.disabledWhy, { n: w.consecutiveFailures })}
                        </DyNotice>
                      </div>
                    ) : null}
                  </>
                }
                actions={
                  <>
                    <DyButton
                      icon="send"
                      disabled={submit.busy}
                      data-testid={`webhook-test-${w.id}`}
                      onClick={() => {
                        act(async () => {
                          const out = await testWebhook(w.id);
                          const a = out.attempts[0];
                          return out.delivery.status === 'succeeded'
                            ? fill(t.done.test, { code: a?.statusCode ?? 0, ms: a?.latencyMs ?? 0 })
                            : fill(t.done.testFailed, {
                                error:
                                  errorText(t, out.delivery.lastError) ||
                                  String(out.delivery.lastStatusCode ?? ''),
                              });
                        });
                      }}
                    >
                      {t.actions.test}
                    </DyButton>
                    {w.state === 'active' ? (
                      <DyButton
                        icon="pause"
                        disabled={submit.busy}
                        data-testid={`webhook-pause-${w.id}`}
                        onClick={() => {
                          act(async () => {
                            await setWebhookState(w.id, 'paused');
                            return fill(t.done.paused, { name: w.name });
                          });
                        }}
                      >
                        {t.actions.pause}
                      </DyButton>
                    ) : (
                      <DyButton
                        icon="retry"
                        disabled={submit.busy}
                        data-testid={`webhook-resume-${w.id}`}
                        onClick={() => {
                          act(async () => {
                            await setWebhookState(w.id, 'active');
                            return fill(t.done.resumed, { name: w.name });
                          }, t.resumeStepUp);
                        }}
                      >
                        {t.actions.resume}
                      </DyButton>
                    )}
                    {w.secretRevealed ? (
                      <DyButton
                        icon="key"
                        disabled={submit.busy}
                        data-testid={`webhook-rotate-${w.id}`}
                        onClick={() => {
                          setRotating(w);
                        }}
                      >
                        {t.actions.rotate}
                      </DyButton>
                    ) : (
                      <DyButton
                        icon="key"
                        disabled={submit.busy}
                        data-testid={`webhook-reveal-${w.id}`}
                        onClick={() => {
                          act(async () => {
                            setSecret(await revealWebhookSecret(w.id));
                            return null;
                          }, t.reveal.stepUp);
                        }}
                      >
                        {t.actions.reveal}
                      </DyButton>
                    )}
                    <DyButton
                      icon="inbox"
                      data-testid={`webhook-log-${w.id}`}
                      onClick={() => {
                        setLogOf(logOf === w.id ? null : w.id);
                      }}
                    >
                      {logOf === w.id ? t.actions.hideDeliveries : t.actions.deliveries}
                    </DyButton>
                    <ConfirmButton
                      label={t.actions.delete}
                      question={fill(t.actions.deleteQuestion, { name: w.name })}
                      confirmLabel={t.actions.deleteConfirm}
                      ariaLabel={fill(t.actions.deleteAria, { name: w.name })}
                      disabled={submit.busy}
                      testId={`webhook-delete-${w.id}`}
                      onConfirm={() => {
                        act(async () => {
                          await deleteWebhook(w.id);
                          if (logOf === w.id) setLogOf(null);
                          return fill(t.done.deleted, { name: w.name });
                        });
                      }}
                    />
                  </>
                }
              />
            ))}
          </Rows>
        )}
        <div className="flex flex-col gap-2 px-4 pb-4 empty:hidden">
          <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
        </div>
      </Panel>
      {logHook === null ? null : <DeliveryLog key={logHook.id} webhook={logHook} />}
      <Panel title={t.internal.title} sub={t.internal.sub} testId="webhook-internal">
        {owner ? (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const list = origins
                .split(/[\n,]/)
                .map((s) => s.trim())
                .filter((s) => s !== '');
              act(async () => {
                await setInternalOrigins(list);
                return t.internal.saved;
              }, t.internal.stepUp);
            }}
          >
            <DyTextarea
              label={t.internal.origins}
              hint={t.internal.originsHint}
              value={origins}
              rows={3}
              mono
              onChange={setOrigins}
            />
            <FormActions>
              <DyButton type="submit" icon="shield" busy={submit.busy} data-testid="webhook-internal-save">
                {t.internal.save}
              </DyButton>
            </FormActions>
          </form>
        ) : (
          <div className="grid gap-2">
            {settings.internalOrigins.length === 0 ? (
              <p className="m-0 text-[0.875rem]">{t.internal.none}</p>
            ) : (
              <ul className="m-0 grid gap-1 p-0">
                {settings.internalOrigins.map((o) => (
                  <li key={o} className="list-none font-dy-mono text-[0.8125rem]">
                    {o}
                  </li>
                ))}
              </ul>
            )}
            <p className="m-0 text-[0.78125rem] text-dy-muted">{t.internal.ownerOnly}</p>
          </div>
        )}
      </Panel>
      <RotateWebhookDialog
        webhook={rotating}
        rotate={(w, hours) => rotateWebhookSecret(w.id, hours)}
        onClose={() => {
          setRotating(null);
        }}
        onRotated={(out) => {
          setRotating(null);
          setSecret(out.secret);
          setDone(fill(t.done.rotated, { name: out.webhook.name }));
          void load();
        }}
      />
    </div>
  );
}
