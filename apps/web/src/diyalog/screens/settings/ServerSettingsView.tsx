import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../../api/client';
import { putSupportSettings } from '../../../api/doctor';
import {
  getMail,
  getPanelSection,
  type MailView,
  type PanelField,
  type PanelSection,
  type PanelSectionView,
  type PanelValue,
  savePanelSection,
  testMail,
} from '../../../api/panelSettings';
import { formatBytes, parseOutputServerLimits } from '../../../api/workspaces';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { useIsOwner } from '../../onboarding/useOnboarding';
import { DyNotice } from '../../common/notices';
import { DyDialog } from '../../DyDialog';
import { DyTabs } from '../../formkit';
import { DyApiError, DyCheck, DyField, DyTextarea } from '../forms';
import { DyButton, DySelect, ErrorLine, Panel, Pill, SkeletonRows } from '../parts';
import { KeyRotationPanel } from './server-keys';
import { MaintenancePanel } from './server-maintenance';
import { WorkflowCheckPanel } from './server-workflow-check';

/**
 * p17-panel-settings (docs/design/p17-panel-settings.md §3–§9): Ayarlar → Sunucu ayarları — the settings that used to
 * exist only as environment variables, per section: each field shows its effective value, the environment variable it
 * overrides and the source ("panel" / "ortam değişkeni"); "Ortam değişkenine dön" removes the panel value; secrets are
 * write-only ("Değiştir"), generated ones are shown once. Saves go through the step-up and may ask for a confirmation
 * (a client-IP change, a new push key). Owners edit; admins read. Keys (rotation) and Bakım (maintenance jobs) are
 * tabs of their own.
 */

type Draft = Record<string, string | boolean>;

function toText(f: PanelField, v: PanelValue | null): string | boolean {
  if (f.kind === 'bool') return v === true;
  if (v === null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return v.join('\n');
}

function fromText(f: PanelField, v: string | boolean): PanelValue | null {
  if (f.kind === 'bool') return v === true;
  const s = String(v).trim();
  if (f.kind === 'list')
    return s
      .split(/\n|,/)
      .map((x) => x.trim())
      .filter((x) => x !== '');
  if (s === '') return null;
  if (f.kind === 'int' || f.kind === 'number') {
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) ? n : s;
  }
  return s;
}

function shown(v: PanelValue | null, none: string): string {
  if (v === null) return none;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return v.length === 0 ? none : v.join(', ');
}

function SectionForm(props: { readonly section: PanelSection; readonly owner: boolean }): ReactNode {
  const all = useT();
  const t = all.panelSettings;
  const stepUp = useStepUp();
  const loader = useSubmit();
  const act = useSubmit();
  const [view, setView] = useState<PanelSectionView | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [resets, setResets] = useState<ReadonlySet<string>>(new Set());
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set());
  const [generate, setGenerate] = useState<ReadonlySet<string>>(new Set());
  const [generated, setGenerated] = useState<Readonly<Record<string, string>>>({});
  const [ask, setAsk] = useState<{ code: string; details: Record<string, unknown> } | null>(null);
  const [saved, setSaved] = useState(false);

  const fill = useCallback((v: PanelSectionView): void => {
    setView(v);
    setDraft(Object.fromEntries(v.fields.map((f) => [f.key, toText(f, f.value)])));
    setResets(new Set());
    setSecrets({});
    setEditing(new Set());
    setGenerate(new Set());
  }, []);
  const load = useCallback((): void => {
    void loader.run(async () => {
      fill(await getPanelSection(props.section));
    });
  }, [loader, fill, props.section]);
  useEffect(load, [props.section]);

  if (view === null)
    return (
      <div className="grid gap-3">
        <ErrorLine error={loader.error} what={t.status} onRetry={load} />
        {loader.error === null ? <SkeletonRows label={t.loading} rows={3} /> : null}
      </div>
    );

  const changedValues = (): Record<string, PanelValue | null> => {
    const out: Record<string, PanelValue | null> = {};
    for (const f of view.fields) {
      if (f.kind === 'secret') continue;
      if (resets.has(f.key)) {
        if (f.source === 'panel') out[f.key] = null;
        continue;
      }
      const d = draft[f.key];
      if (d === undefined) continue;
      const next = fromText(f, d);
      if (JSON.stringify(next) !== JSON.stringify(f.value)) {
        // An emptied optional value goes back to the environment.
        out[f.key] = next;
      }
    }
    return out;
  };
  const values = changedValues();
  const dirty = Object.keys(values).length > 0 || Object.keys(secrets).length > 0 || generate.size > 0;

  const save = (confirm: readonly string[] = []): void => {
    setSaved(false);
    void act.run(async () => {
      try {
        const out = await stepUp.run(
          () =>
            savePanelSection(props.section, {
              values,
              ...(Object.keys(secrets).length === 0 ? {} : { secrets }),
              ...(generate.size === 0 ? {} : { generate: [...generate] }),
              version: view.version,
              ...(confirm.length === 0 ? {} : { confirm }),
            }),
          t.stepUp,
        );
        setGenerated(out.generated);
        fill(out);
        setSaved(true);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        if (
          err instanceof ApiError &&
          (err.code === 'client_ip_would_change' || err.code === 'push_key_change')
        ) {
          const d = err.details.details;
          setAsk({
            code: err.code,
            details: typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {},
          });
          return;
        }
        throw err;
      }
    });
  };

  const info = view.info;
  return (
    <div className="grid gap-4" data-testid={`dy-panel-${props.section}`}>
      <p className="m-0 text-[0.875rem] text-dy-muted">{t.sections[props.section]}</p>
      {props.section === 'network' && typeof info.clientIp === 'string' ? (
        <DyNotice tone="teal" icon="globe" testId="dy-panel-client-ip">
          <p className="m-0">{t.info.clientIp({ ip: info.clientIp })}</p>
          <p className="m-0 text-[0.8125rem] text-dy-muted">
            {t.info.socket({
              ip: typeof info.socketAddress === 'string' ? info.socketAddress : '',
              xff:
                typeof info.forwardedFor === 'string' && info.forwardedFor !== ''
                  ? info.forwardedFor
                  : t.none,
            })}
          </p>
        </DyNotice>
      ) : null}
      {props.section === 'jobs' ? <OutputLimitsInfo info={info.outputs} /> : null}
      {Object.keys(generated).length > 0 ? (
        <DyNotice tone="amber" icon="key" testId="dy-panel-generated">
          {Object.entries(generated).map(([k, v]) => {
            const f = view.fields.find((x) => x.key === k);
            return (
              <div key={k} className="grid gap-1">
                <p className="m-0 font-bold">
                  {t.fields[k]?.label ?? k}
                  {f?.generated === 'vapid' ? ` — ${t.secret.publicKey}` : ''}
                </p>
                {f?.generated === 'vapid' ? null : (
                  <p className="m-0 text-[0.8125rem]">{t.secret.shownOnce}</p>
                )}
                <code className="font-dy-mono text-[0.8125rem] break-all select-all">{v}</code>
              </div>
            );
          })}
        </DyNotice>
      ) : null}
      <Panel title={t.tabs[props.section] ?? props.section}>
        <div className="grid gap-4">
          {view.fields.map((f) => (
            <FieldRow
              key={f.key}
              field={f}
              owner={props.owner}
              draft={draft[f.key] ?? ''}
              reset={resets.has(f.key)}
              secret={secrets[f.key]}
              editing={editing.has(f.key)}
              generate={generate.has(f.key)}
              onDraft={(v) => {
                setDraft({ ...draft, [f.key]: v });
                if (resets.has(f.key)) setResets(new Set([...resets].filter((k) => k !== f.key)));
              }}
              onReset={() => {
                setResets(new Set([...resets, f.key]));
                setDraft({ ...draft, [f.key]: toText(f, f.envValue) });
              }}
              onSecret={(v) => {
                const next = Object.fromEntries(Object.entries(secrets).filter(([k]) => k !== f.key));
                setSecrets(v === undefined ? next : { ...next, [f.key]: v });
              }}
              onEditing={(on) => {
                setEditing(
                  on ? new Set([...editing, f.key]) : new Set([...editing].filter((k) => k !== f.key)),
                );
              }}
              onGenerate={(on) => {
                setGenerate(
                  on ? new Set([...generate, f.key]) : new Set([...generate].filter((k) => k !== f.key)),
                );
              }}
            />
          ))}
        </div>
        {props.owner ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <DyButton
              variant="primary"
              busy={act.busy}
              disabled={!dirty}
              onClick={() => {
                save();
              }}
            >
              {t.save}
            </DyButton>
            {saved ? <span className="text-[0.875rem] text-dy-green-ink">{t.saved}</span> : null}
          </div>
        ) : null}
        <DyApiError error={act.error} className="mt-3" />
      </Panel>
      {props.section === 'notifications' ? <MailPanel owner={props.owner} /> : null}
      {props.section === 'workflows' ? <WorkflowCheckPanel owner={props.owner} /> : null}
      <DyDialog
        open={ask !== null}
        onClose={() => {
          setAsk(null);
        }}
        title={t.confirm.title}
        testId="dy-panel-confirm"
        footer={
          <>
            <DyButton
              onClick={() => {
                setAsk(null);
              }}
            >
              {t.confirm.no}
            </DyButton>
            <DyButton
              variant="danger"
              onClick={() => {
                const code = ask?.code === 'push_key_change' ? 'push_resubscribe' : 'client_ip_change';
                setAsk(null);
                save([code]);
              }}
            >
              {t.confirm.yes}
            </DyButton>
          </>
        }
      >
        <p className="m-0">
          {ask?.code === 'push_key_change'
            ? t.confirm.push({ devices: Number(ask.details.devices ?? 0) })
            : t.confirm.clientIp({
                current: typeof ask?.details.current === 'string' ? ask.details.current : '',
                after: typeof ask?.details.after === 'string' ? ask.details.after : '',
              })}
        </p>
      </DyDialog>
    </div>
  );
}

/**
 * p17-output-limits: what decides where a job's output files go — the storage's state and limits, the direct-path
 * budget, the zip, and that older workers keep the old limits.
 */
function OutputLimitsInfo(props: { readonly info: unknown }): ReactNode {
  const t = useT().panelSettings.info;
  const o = parseOutputServerLimits(props.info);
  if (o === null) return null;
  const raw = props.info as Record<string, unknown>;
  const num = (k: string, d: number): number => (typeof raw[k] === 'number' ? raw[k] : d);
  return (
    <DyNotice
      tone={o.storage === 'unavailable' ? 'amber' : 'teal'}
      icon="folder"
      testId="dy-panel-output-limits"
    >
      <p className="m-0" data-testid="dy-panel-output-store">
        {t.outputsStore[o.storage]}
      </p>
      <p className="m-0 text-[0.8125rem]">
        {t.outputsBudget({
          inlineFile: formatBytes(num('inlineFileBytes', 5 * 1024 * 1024)),
          inlineTotal: formatBytes(num('inlineTotalBytes', 15 * 1024 * 1024)),
          file: formatBytes(o.maxFileBytes),
          job: formatBytes(o.maxJobBytes),
        })}
      </p>
      <p className="m-0 text-[0.8125rem] text-dy-muted">{t.outputsOldWorkers}</p>
    </DyNotice>
  );
}

function FieldRow(props: {
  readonly field: PanelField;
  readonly owner: boolean;
  readonly draft: string | boolean;
  readonly reset: boolean;
  readonly secret: string | null | undefined;
  readonly editing: boolean;
  readonly generate: boolean;
  readonly onDraft: (v: string | boolean) => void;
  readonly onReset: () => void;
  readonly onSecret: (v: string | null | undefined) => void;
  readonly onEditing: (on: boolean) => void;
  readonly onGenerate: (on: boolean) => void;
}): ReactNode {
  const all = useT();
  const t = all.panelSettings;
  const f = props.field;
  const text = t.fields[f.key] ?? { label: f.key, hint: '' };
  const source = t.source[f.source];
  const meta = (
    <span className="flex flex-wrap items-center gap-2 text-[0.75rem] text-dy-muted">
      <span>{t.sourceLine({ source, env: f.env })}</span>
      {f.kind === 'secret' ? null : (
        <span>{f.envValue === null ? t.envUnset : t.envDefault({ value: shown(f.envValue, t.none) })}</span>
      )}
      {f.restart ? <Pill tone="amber">{t.restart}</Pill> : null}
      {props.owner && f.source === 'panel' && f.kind !== 'secret' && !props.reset ? (
        <button
          type="button"
          className="dy-press font-bold text-dy-teal-ink underline"
          onClick={props.onReset}
        >
          {t.reset}
        </button>
      ) : null}
    </span>
  );
  if (f.kind === 'secret') {
    return (
      <div className="grid gap-1" data-testid={`dy-field-${f.key}`}>
        <span className="font-bold">{text.label}</span>
        <span className="text-[0.8125rem] text-dy-muted">{text.hint}</span>
        <span className="flex flex-wrap items-center gap-2">
          <Pill tone={f.secretSet ? 'green' : 'neutral'}>{f.secretSet ? t.secret.set : t.secret.unset}</Pill>
          {props.owner && f.generated !== null ? (
            <DyCheck
              label={f.secretSet ? t.secret.regenerate : t.secret.generate}
              checked={props.generate}
              onChange={props.onGenerate}
            />
          ) : null}
          {props.owner && f.generated !== 'vapid' && !props.editing ? (
            <DyButton
              onClick={() => {
                props.onEditing(true);
              }}
            >
              {t.secret.change}
            </DyButton>
          ) : null}
          {props.owner && f.source === 'panel' && f.secretSet ? (
            <DyButton
              variant="ghost"
              onClick={() => {
                props.onSecret(props.secret === null ? undefined : null);
              }}
            >
              {props.secret === null ? t.secret.cancelChange : t.secret.remove}
            </DyButton>
          ) : null}
        </span>
        {props.editing ? (
          <span className="flex flex-wrap items-end gap-2">
            <DyField
              label={t.secret.placeholder}
              value={typeof props.secret === 'string' ? props.secret : ''}
              onChange={(v) => {
                props.onSecret(v === '' ? undefined : v);
              }}
              type="password"
              autoComplete="new-password"
              mono
              wrapClassName="min-w-0 flex-1"
            />
            <DyButton
              variant="ghost"
              onClick={() => {
                props.onSecret(undefined);
                props.onEditing(false);
              }}
            >
              {t.secret.cancelChange}
            </DyButton>
          </span>
        ) : null}
        {meta}
      </div>
    );
  }
  const disabled = !props.owner;
  return (
    <div className="grid gap-1" data-testid={`dy-field-${f.key}`}>
      {f.kind === 'bool' ? (
        <DyCheck
          label={text.label}
          hint={text.hint}
          checked={props.draft === true}
          onChange={(v) => {
            props.onDraft(v);
          }}
          disabled={disabled}
        />
      ) : f.kind === 'enum' ? (
        <DySelect
          label={text.label}
          value={String(props.draft)}
          options={[
            ...(f.options ?? []).map((o) => [o, o === '' ? t.none : o] as const),
            ...((f.options ?? []).includes('') || props.draft !== '' ? [] : [['', t.none] as const]),
          ]}
          onChange={(v) => {
            props.onDraft(v);
          }}
          className="max-w-md"
        />
      ) : f.kind === 'list' ? (
        <DyTextarea
          label={text.label}
          hint={`${text.hint} ${t.listHint}`}
          value={String(props.draft)}
          onChange={(v) => {
            props.onDraft(v);
          }}
          mono
        />
      ) : (
        <DyField
          label={text.label}
          hint={text.hint}
          value={String(props.draft)}
          onChange={(v) => {
            props.onDraft(v);
          }}
          inputMode={f.kind === 'int' ? 'numeric' : f.kind === 'number' ? 'decimal' : undefined}
          mono={f.kind !== 'string'}
        />
      )}
      {meta}
    </div>
  );
}

/** The one SMTP configuration (edited with the support settings route) and a test send. */
function MailPanel(props: { readonly owner: boolean }): ReactNode {
  const t = useT().panelSettings.mail;
  const all = useT();
  const stepUp = useStepUp();
  const loader = useSubmit();
  const act = useSubmit();
  const [mail, setMail] = useState<MailView | null>(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({
    host: '',
    port: '587',
    security: 'starttls',
    from: '',
    username: '',
    password: '',
  });
  const [to, setTo] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const load = useCallback((): void => {
    void loader.run(async () => {
      const m = await getMail();
      setMail(m);
      setForm({
        host: m.host ?? '',
        port: String(m.port ?? 587),
        security: m.security ?? 'starttls',
        from: m.from ?? '',
        username: m.username ?? '',
        password: '',
      });
    });
  }, [loader]);
  useEffect(load, []);
  const run = (fn: () => Promise<void>): void => {
    void act.run(async () => {
      try {
        await fn();
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  };
  return (
    <Panel title={t.title} testId="dy-panel-mail">
      <p className="m-0 mb-3 text-[0.875rem] text-dy-muted">{t.sub}</p>
      <ErrorLine error={loader.error} what={t.title} onRetry={load} />
      {mail === null ? null : (
        <dl
          className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.875rem]"
          data-testid="dy-mail-current"
        >
          {/* p17-ui-polish: the source line spans the list — as the key column it set that column's width (on a
              phone the values wrapped in a narrow column next to it). */}
          <dt className="col-span-2 text-dy-muted">
            {all.panelSettings.sourceLine({
              source: t.source[mail.source] ?? mail.source,
              env: 'NOTIFY_SMTP_*',
            })}
          </dt>
          <dd className="hidden" />
          {mail.host === null ? null : (
            <>
              <dt className="text-dy-muted">{t.host}</dt>
              <dd className="m-0 font-dy-mono">
                {mail.host}:{String(mail.port ?? '')} ({mail.security ?? ''})
              </dd>
              <dt className="text-dy-muted">{t.from}</dt>
              <dd className="m-0 font-dy-mono">{mail.from}</dd>
              <dt className="text-dy-muted">{t.username}</dt>
              <dd className="m-0 font-dy-mono">{mail.username ?? all.panelSettings.none}</dd>
              <dt className="text-dy-muted">{t.password}</dt>
              <dd className="m-0">{mail.passwordSet ? t.passwordSet : all.panelSettings.none}</dd>
            </>
          )}
        </dl>
      )}
      {props.owner ? (
        <div className="mt-3 grid gap-3">
          {edit ? (
            <div className="grid gap-3 sm:grid-cols-2" data-testid="dy-mail-form">
              <DyField
                label={t.host}
                value={form.host}
                onChange={(v) => {
                  setForm({ ...form, host: v });
                }}
                mono
              />
              <DyField
                label={t.port}
                value={form.port}
                onChange={(v) => {
                  setForm({ ...form, port: v });
                }}
                inputMode="numeric"
                mono
              />
              <DySelect
                label={t.security}
                value={form.security}
                options={[
                  ['starttls', 'STARTTLS'],
                  ['tls', 'TLS'],
                ]}
                onChange={(v) => {
                  setForm({ ...form, security: v });
                }}
              />
              <DyField
                label={t.from}
                value={form.from}
                onChange={(v) => {
                  setForm({ ...form, from: v });
                }}
                mono
              />
              <DyField
                label={t.username}
                value={form.username}
                onChange={(v) => {
                  setForm({ ...form, username: v });
                }}
                mono
              />
              <DyField
                label={t.password}
                value={form.password}
                onChange={(v) => {
                  setForm({ ...form, password: v });
                }}
                type="password"
                autoComplete="new-password"
                hint={all.panelSettings.secret.placeholder}
              />
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <DyButton
                  variant="primary"
                  busy={act.busy}
                  onClick={() => {
                    run(async () => {
                      await stepUp.run(
                        () =>
                          putSupportSettings({
                            smtp: {
                              host: form.host.trim(),
                              port: Number(form.port),
                              security: form.security === 'tls' ? 'tls' : 'starttls',
                              from: form.from.trim(),
                              username: form.username.trim() === '' ? null : form.username.trim(),
                              ...(form.password === '' ? {} : { password: form.password }),
                            },
                          }),
                        all.panelSettings.stepUp,
                      );
                      setEdit(false);
                      load();
                    });
                  }}
                >
                  {t.save}
                </DyButton>
                {mail?.source === 'panel' ? (
                  <DyButton
                    variant="ghost"
                    onClick={() => {
                      run(async () => {
                        await stepUp.run(() => putSupportSettings({ smtp: null }), all.panelSettings.stepUp);
                        setEdit(false);
                        load();
                      });
                    }}
                  >
                    {t.remove}
                  </DyButton>
                ) : null}
              </div>
            </div>
          ) : (
            <div>
              <DyButton
                onClick={() => {
                  setEdit(true);
                }}
              >
                {t.edit}
              </DyButton>
            </div>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <DyField
              label={t.testTo}
              value={to}
              onChange={setTo}
              wrapClassName="min-w-0 flex-1 basis-full sm:basis-0"
              mono
            />
            <DyButton
              icon="send"
              busy={act.busy}
              disabled={mail?.source === 'none'}
              onClick={() => {
                setResult(null);
                run(async () => {
                  const r = await stepUp.run(() => testMail(to), all.panelSettings.stepUp);
                  setResult(r.ok ? t.testOk({ to: r.to }) : t.testFailed({ error: r.error ?? '' }));
                });
              }}
            >
              {t.test}
            </DyButton>
          </div>
          {result === null ? null : (
            <p className="m-0 text-[0.875rem]" data-testid="dy-mail-test-result">
              {result}
            </p>
          )}
          <DyApiError error={act.error} />
        </div>
      ) : null}
    </Panel>
  );
}

export function ServerSettingsView(): ReactNode {
  const t = useT().panelSettings;
  const owner = useIsOwner();
  const sections: readonly PanelSection[] = [
    'notifications',
    'search',
    'network',
    'sessions',
    'jobs',
    'logs',
    'memory',
    'workflows',
    'ops',
  ];
  return (
    <DyTabs
      label={t.page.label}
      testId="dy-server-settings-tabs"
      items={[
        ...sections.map((s) => ({ id: s, label: t.tabs[s] ?? s })),
        { id: 'keys', label: t.tabs.keys ?? 'keys' },
        { id: 'maintenance', label: t.tabs.maintenance ?? 'maintenance' },
      ]}
    >
      {(tab) =>
        tab === 'keys' ? (
          <KeyRotationPanel owner={owner} />
        ) : tab === 'maintenance' ? (
          <MaintenancePanel owner={owner} />
        ) : (
          <SectionForm key={tab} section={tab as PanelSection} owner={owner} />
        )
      }
    </DyTabs>
  );
}
