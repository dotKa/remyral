import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../../api/client';
import {
  getPreferences,
  type KindPreference,
  type NotificationKind,
  type NotificationPreferences,
  type PreferencesUpdate,
  updatePreferences,
} from '../../../api/notifications';
import { useAuth } from '../../../auth/AuthProvider';
import { cx, toApiError } from '../../../components/ui';
import { soundOutput } from '../../../sound/output';
import { CATEGORY_VARIANT, type SoundCategory, useSoundSettings } from '../../../sound/settings';
import { DyFormScope, DyTabs, useDyForm, useFormSection } from '../../formkit';
import { DyApiError, DyCheck, DyField, DyNotice } from '../forms';
import { DyButton, Panel, SkeletonRows } from '../parts';
import { useFormat, useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Ayarlar → Bildirimler in the Diyalog language, same rules as the classic
 * `NotificationSettingsPage` (p5-notifications, p8-pwa, p9-notification-sound): in-app always on; e-mail, webhook and
 * push opt-in per kind and only offered when configured; only changed targets are sent, so an unchanged target never
 * asks for a code (the master asks step-up for a target change); the sound settings are per browser and apply at once.
 */

type Channel = 'email' | 'webhook' | 'push';
type Toggles = Record<NotificationKind, Record<Channel, boolean>>;

function toggles(kinds: readonly KindPreference[]): Toggles {
  return Object.fromEntries(
    kinds.map((k) => [k.kind, { email: k.email, webhook: k.webhook, push: k.push }]),
  ) as Toggles;
}

const SOUND_CATEGORIES: readonly SoundCategory[] = ['chat', 'notifications', 'approvals'];

/** Ses (p9-notification-sound): stored in this browser for the signed-in user; changes apply at once. */
function SoundPanel(): ReactNode {
  const { state } = useAuth();
  const userId = state.kind === 'signedIn' ? state.user.id : 'anonymous';
  const [s, update] = useSoundSettings(userId);
  const [played, setPlayed] = useState<boolean | null>(null);
  const volumeId = useId();
  const output = soundOutput();
  const supported = output.supported();
  const t = useT().settings.notifications.sound;
  const fmt = useFormat();
  const volume = fmt.percent(s.volume / 100);
  const preview = (category: SoundCategory): void => {
    void output.preview(CATEGORY_VARIANT[category], s.volume).then(setPlayed);
  };
  return (
    <Panel title={t.title} sub={t.sub} testId="dy-sound">
      {!supported ? (
        <DyNotice tone="amber" live>
          {t.unsupported}
        </DyNotice>
      ) : (
        <div className="flex flex-col gap-4">
          <DyCheck
            label={t.enabled}
            checked={s.enabled}
            onChange={(enabled) => {
              update({ enabled });
            }}
          />
          <div className={cx('flex flex-col gap-1', !s.enabled && 'opacity-60')}>
            <label htmlFor={volumeId} className="text-[0.8125rem] font-bold">
              {t.volume}
            </label>
            <div className="flex items-center gap-3">
              <input
                id={volumeId}
                type="range"
                min={0}
                max={100}
                step={5}
                value={s.volume}
                disabled={!s.enabled}
                aria-valuetext={volume}
                onChange={(e) => {
                  update({ volume: Number(e.target.value) });
                }}
                className="h-11 w-full max-w-xs accent-[var(--dy-teal)] md:h-6"
              />
              <output
                htmlFor={volumeId}
                className="w-12 font-dy-mono text-[0.8125rem] text-dy-muted tabular-nums"
              >
                {volume}
              </output>
            </div>
          </div>
          <fieldset disabled={!s.enabled} className={cx('m-0 border-0 p-0', !s.enabled && 'opacity-60')}>
            <legend className="mb-1 text-[0.8125rem] font-bold">{t.playFor}</legend>
            <ul className="m-0 flex list-none flex-col p-0">
              {SOUND_CATEGORIES.map((category) => ({ category, ...t.rows[category] })).map((r) => (
                <li
                  key={r.category}
                  className="flex items-start justify-between gap-3 border-t border-dy-line py-1.5 first:border-t-0"
                >
                  <DyCheck
                    label={r.label}
                    hint={r.hint}
                    checked={s[r.category]}
                    disabled={!s.enabled}
                    onChange={(on) => {
                      update({ [r.category]: on });
                    }}
                  />
                  <DyButton
                    variant="ghost"
                    disabled={!s.enabled}
                    aria-label={t.playAria({ label: r.label })}
                    onClick={() => {
                      preview(r.category);
                    }}
                  >
                    {t.play}
                  </DyButton>
                </li>
              ))}
            </ul>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <DyButton
              disabled={!s.enabled}
              onClick={() => {
                preview('notifications');
              }}
            >
              {t.tryIt}
            </DyButton>
            <span role="status" className="text-[0.8125rem] text-dy-muted">
              {played === false ? t.blocked : ''}
            </span>
          </div>
          <p className="m-0 text-[0.78125rem] text-dy-muted">{t.note}</p>
        </div>
      )}
    </Panel>
  );
}

/**
 * p17-toasts-shortcuts: the toast preview of a new notification (per browser, with the sound settings; applies at
 * once — the preview reads it at each arrival).
 */
function PreviewPanel(): ReactNode {
  const { state } = useAuth();
  const userId = state.kind === 'signedIn' ? state.user.id : 'anonymous';
  const [s, update] = useSoundSettings(userId);
  const t = useT().settings.notifications.previews;
  return (
    <Panel title={t.title} sub={t.sub} testId="dy-previews">
      <DyCheck
        label={t.enabled}
        hint={t.hint}
        checked={s.previews}
        onChange={(previews) => {
          update({ previews });
        }}
      />
    </Panel>
  );
}

const CHANNEL_KEYS: readonly Channel[] = ['email', 'webhook', 'push'];

interface TargetsForm {
  readonly email: string;
  readonly webhookUrl: string;
}

function targetsOf(p: NotificationPreferences): TargetsForm {
  return { email: p.email.address ?? '', webhookUrl: p.webhook.url ?? '' };
}

/** Kanallar: the e-mail address and webhook; only a changed target is sent (the master asks a code for it). */
function TargetsTab(props: {
  readonly prefs: NotificationPreferences;
  readonly onSaved: (p: NotificationPreferences) => void;
}): ReactNode {
  const t = useT().settings.notifications;
  const { prefs } = props;
  const initial = useMemo(() => targetsOf(prefs), [prefs]);
  const form = useDyForm<TargetsForm>({
    initial,
    stepUpReason: t.stepUp,
    fieldOf: (path) => (path === 'email' || path === 'webhookUrl' ? path : null),
    save: async (f) => {
      const update: PreferencesUpdate = {
        ...(prefs.email.available && f.email.trim() !== (prefs.email.address ?? '')
          ? { email: f.email.trim() === '' ? null : f.email.trim() }
          : {}),
        ...(prefs.webhook.available && f.webhookUrl.trim() !== (prefs.webhook.url ?? '')
          ? { webhookUrl: f.webhookUrl.trim() === '' ? null : f.webhookUrl.trim() }
          : {}),
      };
      const next = await updatePreferences(update);
      props.onSaved(next);
      return targetsOf(next);
    },
  });
  useFormSection(form);
  const f = form.value ?? initial;
  return (
    <Panel title={t.targets} testId="dy-notify-targets">
      <div className="grid gap-4 md:grid-cols-2">
        <DyField
          label={t.email}
          type="email"
          name="notification-email"
          autoComplete="email"
          maxLength={254}
          value={f.email}
          disabled={!prefs.email.available}
          hint={prefs.email.available ? t.emailHint : t.emailOff}
          error={form.fieldError('email')}
          onChange={(v) => {
            form.set({ email: v });
          }}
        />
        <DyField
          label={t.webhook}
          type="url"
          name="notification-webhook"
          autoComplete="off"
          maxLength={2000}
          mono
          value={f.webhookUrl}
          disabled={!prefs.webhook.available}
          hint={prefs.webhook.available ? t.webhookHint : t.webhookOff}
          error={form.fieldError('webhookUrl')}
          onChange={(v) => {
            form.set({ webhookUrl: v });
          }}
        />
      </div>
      <p className="m-0 mt-4 text-[0.875rem] text-dy-muted" data-testid="push-target">
        {prefs.push.available ? (
          <>
            {prefs.push.devices === 0 ? t.pushNone : t.pushDevices({ n: prefs.push.devices })}
            {t.pushPerDevice}
            <Link to="/settings/devices" className="font-medium text-dy-teal-ink">
              {t.pushLink}
            </Link>
            {t.pushAfter}
          </>
        ) : (
          t.pushOff
        )}
      </p>
      <DyApiError error={form.error} retryLeft={form.retryLeft} className="mt-3" />
    </Panel>
  );
}

/** Bildirim türleri: the per-kind channel matrix (in-app is always on). */
function KindsTab(props: {
  readonly prefs: NotificationPreferences;
  readonly onSaved: (p: NotificationPreferences) => void;
}): ReactNode {
  const t = useT().settings.notifications;
  const { prefs } = props;
  const CHANNELS = CHANNEL_KEYS.map((key) => ({ key, label: t.channels[key] }));
  const initial = useMemo(() => toggles(prefs.kinds), [prefs]);
  const form = useDyForm<Toggles>({
    initial,
    stepUpReason: t.stepUp,
    save: async (state) => {
      const next = await updatePreferences({
        kinds: prefs.kinds.map((k) => ({
          kind: k.kind,
          ...(prefs.email.available ? { email: state[k.kind].email } : {}),
          ...(prefs.webhook.available ? { webhook: state[k.kind].webhook } : {}),
          ...(prefs.push.available ? { push: state[k.kind].push } : {}),
        })),
      });
      props.onSaved(next);
      return toggles(next.kinds);
    },
  });
  useFormSection(form);
  const state = form.value ?? initial;
  const available = (c: Channel): boolean =>
    c === 'email' ? prefs.email.available : c === 'webhook' ? prefs.webhook.available : prefs.push.available;
  return (
    <Panel title={t.what} sub={t.whatSub} flush testId="dy-notify-matrix">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[0.875rem]">
          <caption className="sr-only">{t.caption}</caption>
          <thead className="border-b border-dy-line">
            <tr>
              <th scope="col" className="px-4 py-2 text-left text-[0.78125rem] font-bold text-dy-muted">
                {t.kind}
              </th>
              <th scope="col" className="px-2 py-2 text-center text-[0.78125rem] font-bold text-dy-muted">
                {t.bell}
              </th>
              {CHANNELS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className="px-2 py-2 text-center text-[0.78125rem] font-bold text-dy-muted"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {prefs.kinds.map((k) => (
              <tr key={k.kind} className="border-t border-dy-line first:border-t-0">
                <th scope="row" className="px-4 py-2.5 text-left font-normal">
                  <span className="block font-medium">{k.label}</span>
                  <span className="block text-[0.78125rem] text-dy-muted">{k.description}</span>
                </th>
                <td className="px-1 text-center">
                  <label className="inline-flex size-11 items-center justify-center md:size-9">
                    <input
                      type="checkbox"
                      checked
                      disabled
                      aria-label={t.bellAria({ label: k.label })}
                      className="size-4 accent-[var(--dy-teal)]"
                    />
                  </label>
                </td>
                {CHANNELS.map((c) => (
                  <td key={c.key} className="px-1 text-center">
                    <label className="inline-flex size-11 items-center justify-center md:size-9">
                      <input
                        type="checkbox"
                        checked={state[k.kind][c.key]}
                        disabled={!available(c.key)}
                        aria-label={t.channelAria({ label: k.label, channel: c.label.toLowerCase() })}
                        onChange={(e) => {
                          const on = e.target.checked;
                          form.set((s) => ({ ...s, [k.kind]: { ...s[k.kind], [c.key]: on } }));
                        }}
                        className="size-4 accent-[var(--dy-teal)]"
                      />
                    </label>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 pb-3">
        <DyApiError error={form.error} retryLeft={form.retryLeft} />
      </div>
    </Panel>
  );
}

/**
 * p15-form-pattern: Bildirimler in tabs — Ses (this browser, applies at once), Kanallar (e-mail / webhook; a target
 * change asks a code) and Bildirim türleri (the channel per kind). Each form sends only its own part.
 */
export function NotificationsView(): ReactNode {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const t = useT().settings.notifications;
  const tt = useT().forms.tabs.notifications;

  useEffect(() => {
    getPreferences().then(setPrefs, (err: unknown) => {
      setLoadError(toApiError(err));
    });
  }, []);

  const body = (form: (p: NotificationPreferences) => ReactNode): ReactNode =>
    loadError !== null ? (
      <DyApiError error={loadError} />
    ) : prefs === null ? (
      <Panel title={t.prefs} flush>
        <SkeletonRows label={t.loading} rows={4} />
      </Panel>
    ) : (
      <DyFormScope label={t.formLabel}>{form(prefs)}</DyFormScope>
    );

  return (
    <DyTabs
      label={tt.label}
      items={[
        { id: 'sound', label: tt.sound },
        { id: 'targets', label: tt.targets },
        { id: 'events', label: tt.events },
      ]}
    >
      {(tab) =>
        tab === 'targets' ? (
          body((p) => <TargetsTab prefs={p} onSaved={setPrefs} />)
        ) : tab === 'events' ? (
          body((p) => <KindsTab prefs={p} onSaved={setPrefs} />)
        ) : (
          <div className="flex flex-col gap-4">
            <PreviewPanel />
            <SoundPanel />
          </div>
        )
      }
    </DyTabs>
  );
}
