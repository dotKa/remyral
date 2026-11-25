import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ApiIssue } from '../../../../api/client';
import {
  CONFIG_RUNTIMES,
  type ConfigRuntime,
  putRuntimePaths,
  type RuntimePaths,
  type WorkerConfigReport,
  type WorkerConfigView,
  type WorkerSettingsSpec,
} from '../../../../api/workerConfig';
import { useAuth } from '../../../../auth/AuthProvider';
import { useT } from '../../../../i18n/I18nProvider';
import type { Draft } from '../../../../screens/fleet/workerConfig';
import { machinePath } from '../../../../screens/fleet/machineLinks';
import { useSubmit } from '../../../../screens/useSubmit';
import { KeyValue, type KeyValueRow } from '../../../KeyValue';
import { runtimeDisplayName } from '../../../RuntimeMark';
import { DyApiError, DyField, DyNotice, DyTextarea } from '../../forms';
import { DyButton, DySelect, Panel, Pill } from '../../parts';
import { FieldIssues } from './config-sections';
import { useGuarded } from './config-shared';

/**
 * p17-worker-managed Part 2 — Makine → Yapılandırma → Yerel ayarlar: the worker's local settings managed from the panel
 * (updates, log level, telemetry, assistant, remote operations, package caches, probe intervals) as part of the one
 * configuration document; every field shows whether the local file pins it and what is in effect now, and the keys
 * waiting for a restart are listed with a link to the restart. Runtime executable paths have their own owner-only save
 * (machine administration must be on; always-fresh step-up). The machine owner's local limits (`localCeiling`) are shown
 * read-only with why.
 */

type Settings = WorkerSettingsSpec;
type Group = Exclude<keyof Settings, 'logLevel' | 'telemetry' | 'runtimePaths'>;

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const HTTPS = 'https://'; // i18n-ignore: URL scheme

/** Sets (or, with `undefined`, removes) one key of a settings group; empty groups disappear. */
/** A copy of `o` without `key` (no dynamic delete). */
function omit(o: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
}

function withKey(draft: Draft, group: Group, key: string, value: unknown): Draft {
  const settings: Record<string, unknown> = { ...(draft.settings ?? {}) };
  const cur = (settings[group] ?? {}) as Record<string, unknown>;
  const g = value === undefined ? omit(cur, key) : { ...cur, [key]: value };
  const next = Object.keys(g).length === 0 ? omit(settings, group) : { ...settings, [group]: g };
  return { ...draft, settings: next };
}

function withTop(draft: Draft, key: 'logLevel' | 'telemetry', value: unknown): Draft {
  const settings: Record<string, unknown> = { ...(draft.settings ?? {}) };
  return { ...draft, settings: value === undefined ? omit(settings, key) : { ...settings, [key]: value } };
}

const intOrUndefined = (v: string): number | undefined => {
  const n = Number(v.replace(/\D/g, ''));
  return v.trim() === '' || !Number.isFinite(n) ? undefined : n;
};

function triState(v: boolean | undefined): string {
  return v === undefined ? '' : v ? 'on' : 'off';
}
const fromTri = (v: string): boolean | undefined => (v === '' ? undefined : v === 'on');

export function LocalSettingsSection(props: {
  readonly draft: Draft;
  readonly setDraft: (d: Draft) => void;
  readonly view: WorkerConfigView;
  readonly issues: readonly ApiIssue[];
}): ReactNode {
  const { draft, setDraft, view, issues } = props;
  const t = useT().machineManaged.settings;
  const s = draft.settings ?? {};
  const applied = view.report?.effective.settings;
  const pinned = new Set(applied?.pinned ?? []);
  const v = applied?.values;
  const show = (x: unknown): string =>
    x === null || x === undefined || x === ''
      ? t.none
      : typeof x === 'boolean'
        ? x
          ? t.on
          : t.off
        : typeof x === 'number' || typeof x === 'string'
          ? String(x)
          : JSON.stringify(x);
  /** Under each field: pinned in the local file, and what is in effect now. */
  const meta = (path: string, now: unknown): ReactNode => (
    <span className="flex flex-wrap items-center gap-2 text-[0.78125rem] text-dy-muted">
      {pinned.has(path) ? (
        <Pill tone="amber" icon="shield">
          {t.pinned}
        </Pill>
      ) : null}
      {applied === undefined ? null : <span>{t.inEffect({ value: show(now) })}</span>}
    </span>
  );
  const tri = (label: string, value: boolean | undefined, set: (b: boolean | undefined) => void) => (
    <DySelect
      label={label}
      value={triState(value)}
      options={[
        ['', t.fromLocal],
        ['on', t.on],
        ['off', t.off],
      ]}
      onChange={(x) => {
        set(fromTri(x));
      }}
    />
  );
  const num = (label: string, value: number | undefined, set: (n: number | undefined) => void) => (
    <DyField
      label={label}
      inputMode="numeric"
      value={value === undefined ? '' : String(value)}
      placeholder={t.fromLocal}
      onChange={(x) => {
        set(intOrUndefined(x));
      }}
    />
  );
  const telemetryMode = s.telemetry === undefined ? '' : s.telemetry.otlpEndpoint === null ? 'off' : 'on';

  if (!view.settings.supported) {
    return (
      <DyNotice tone="amber" testId="settings-unsupported">
        {t.unsupported}
      </DyNotice>
    );
  }
  return (
    <div className="flex flex-col gap-5" data-testid="local-settings">
      <p className="m-0 text-[0.875rem] text-dy-muted">{t.sub}</p>
      <PendingRestart report={view.report} workerId={view.workerId} />

      <fieldset className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-2">
        <legend className="mb-1 p-0 text-[0.875rem] font-bold">{t.groups.updates}</legend>
        <div>
          {tri(t.updatesEnabled, s.updates?.enabled, (b) => {
            setDraft(withKey(draft, 'updates', 'enabled', b));
          })}
          {meta('updates.enabled', v?.updates?.enabled)}
        </div>
        <div>
          <DySelect
            label={t.channel}
            value={s.updates?.channel ?? ''}
            options={[
              ['', t.channelDefault],
              ['stable', 'stable'],
              ['canary', 'canary'],
            ]}
            onChange={(x) => {
              setDraft(withKey(draft, 'updates', 'channel', x === '' ? undefined : x));
            }}
          />
          {meta('updates.channel', v?.updates?.channel)}
        </div>
        <div>
          <DyField
            label={t.minVersion}
            value={s.updates?.minVersion ?? ''}
            placeholder={t.fromLocal}
            hint={t.minVersionHint}
            onChange={(x) => {
              setDraft(withKey(draft, 'updates', 'minVersion', x.trim() === '' ? undefined : x.trim()));
            }}
          />
          {meta('updates.minVersion', v?.updates?.minVersion)}
        </div>
        <div>
          {num(t.healthTimeout, s.updates?.healthTimeoutSec, (n) => {
            setDraft(withKey(draft, 'updates', 'healthTimeoutSec', n));
          })}
          {meta('updates.healthTimeoutSec', v?.updates?.healthTimeoutSec)}
        </div>
        <p className="m-0 text-[0.8125rem] text-dy-muted sm:col-span-2">{t.releaseKeys}</p>
        <FieldIssues issues={issues} prefix="settings.updates" />
      </fieldset>

      <fieldset className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-2">
        <legend className="mb-1 p-0 text-[0.875rem] font-bold">{t.groups.logging}</legend>
        <div>
          <DySelect
            label={t.logLevel}
            value={s.logLevel ?? ''}
            options={[['', t.fromLocal], ...LOG_LEVELS.map((l) => [l, l] as const)]}
            onChange={(x) => {
              setDraft(withTop(draft, 'logLevel', x === '' ? undefined : x));
            }}
          />
          {meta('logLevel', v?.logLevel)}
        </div>
        <div>
          <DySelect
            label={t.telemetryMode}
            value={telemetryMode}
            options={[
              ['', t.fromLocal],
              ['off', t.telemetryOff],
              ['on', t.telemetryOn],
            ]}
            onChange={(x) => {
              setDraft(
                withTop(
                  draft,
                  'telemetry',
                  x === '' ? undefined : x === 'off' ? { otlpEndpoint: null } : { otlpEndpoint: '' },
                ),
              );
            }}
          />
          {meta('telemetry', v?.telemetry?.otlpEndpoint)}
        </div>
        {telemetryMode === 'on' ? (
          <DyField
            label={t.telemetry}
            value={s.telemetry?.otlpEndpoint ?? ''}
            placeholder={HTTPS}
            hint={t.telemetryHint}
            onChange={(x) => {
              setDraft(withTop(draft, 'telemetry', { otlpEndpoint: x.trim() }));
            }}
            wrapClassName="sm:col-span-2"
          />
        ) : null}
        <FieldIssues issues={issues} prefix="settings.telemetry" />
      </fieldset>

      <fieldset className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-3">
        <legend className="mb-1 p-0 text-[0.875rem] font-bold">{t.groups.assistant}</legend>
        <div>
          {tri(t.assistantDisabled, s.assistant?.disabled, (b) => {
            setDraft(withKey(draft, 'assistant', 'disabled', b));
          })}
          {meta('assistant.disabled', v?.assistant?.disabled)}
        </div>
        <div>
          {num(t.maxSessions, s.assistant?.maxSessions, (n) => {
            setDraft(withKey(draft, 'assistant', 'maxSessions', n));
          })}
          {meta('assistant.maxSessions', v?.assistant?.maxSessions)}
        </div>
        <div>
          <DySelect
            label={t.assistantSandbox}
            value={s.assistant?.sandbox ?? ''}
            options={[
              ['', t.fromLocal],
              ['auto', t.sandboxAuto],
              ['required', t.sandboxRequired],
            ]}
            onChange={(x) => {
              setDraft(withKey(draft, 'assistant', 'sandbox', x === '' ? undefined : x));
            }}
          />
          {meta('assistant.sandbox', v?.assistant?.sandbox)}
        </div>
      </fieldset>

      <fieldset className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-3">
        <legend className="mb-1 p-0 text-[0.875rem] font-bold">{t.groups.remoteOps}</legend>
        <div className="sm:col-span-3">
          <DyField
            label={t.npmRegistry}
            value={s.remoteOps?.npmRegistry ?? ''}
            placeholder={t.fromLocal}
            hint={t.npmRegistryHint}
            onChange={(x) => {
              setDraft(withKey(draft, 'remoteOps', 'npmRegistry', x.trim() === '' ? undefined : x.trim()));
            }}
          />
          {meta('remoteOps.npmRegistry', v?.remoteOps?.npmRegistry)}
        </div>
        <div>
          {tri(t.restartable, s.remoteOps?.restartable, (b) => {
            setDraft(withKey(draft, 'remoteOps', 'restartable', b));
          })}
          {meta('remoteOps.restartable', v?.remoteOps?.restartable)}
        </div>
        <div>
          {num(
            t.logFileMib,
            s.remoteOps?.logFileBytes === undefined
              ? undefined
              : Math.round(s.remoteOps.logFileBytes / 2 ** 20),
            (n) => {
              setDraft(
                withKey(draft, 'remoteOps', 'logFileBytes', n === undefined ? undefined : n * 2 ** 20),
              );
            },
          )}
          {meta(
            'remoteOps.logFileBytes',
            v?.remoteOps === undefined ? undefined : Math.round(v.remoteOps.logFileBytes / 2 ** 20),
          )}
        </div>
        <FieldIssues issues={issues} prefix="settings.remoteOps" />
      </fieldset>

      <fieldset className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-3">
        <legend className="mb-1 p-0 text-[0.875rem] font-bold">{t.groups.caches}</legend>
        <div>
          {tri(t.cachesEnabled, s.packageCaches?.enabled, (b) => {
            setDraft(withKey(draft, 'packageCaches', 'enabled', b));
          })}
          {meta('packageCaches.enabled', v?.packageCaches?.enabled)}
        </div>
      </fieldset>

      <fieldset className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-3">
        <legend className="mb-1 p-0 text-[0.875rem] font-bold">{t.groups.probes}</legend>
        <div>
          {num(t.loginRecheck, s.probes?.loginRecheckMinutes, (n) => {
            setDraft(withKey(draft, 'probes', 'loginRecheckMinutes', n));
          })}
          {meta('probes.loginRecheckMinutes', v?.probes?.loginRecheckMinutes)}
        </div>
        <div>
          {num(t.usageProbe, s.probes?.usageProbeMinutes, (n) => {
            setDraft(withKey(draft, 'probes', 'usageProbeMinutes', n));
          })}
          {meta('probes.usageProbeMinutes', v?.probes?.usageProbeMinutes)}
        </div>
        <div>
          {num(t.claudeLock, s.probes?.claudeLockMaxAgeMinutes, (n) => {
            setDraft(withKey(draft, 'probes', 'claudeLockMaxAgeMinutes', n));
          })}
          {meta('probes.claudeLockMaxAgeMinutes', v?.probes?.claudeLockMaxAgeMinutes)}
        </div>
        <FieldIssues issues={issues} prefix="settings.probes" />
      </fieldset>

      <fieldset className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-2" data-testid="settings-linux-sandbox">
        <legend className="mb-1 p-0 text-[0.875rem] font-bold">{t.groups.linuxSandbox}</legend>
        <div className="flex flex-col gap-1">
          {tri(t.linuxLoginStoreView, s.sandbox?.linuxLoginStoreView, (b) => {
            setDraft(withKey(draft, 'sandbox', 'linuxLoginStoreView', b));
          })}
          <span className="text-[0.78125rem] text-dy-muted">{t.linuxLoginStoreViewHint}</span>
          {meta('sandbox.linuxLoginStoreView', v?.sandbox?.linuxLoginStoreView)}
        </div>
        <div className="flex flex-col gap-1">
          <DySelect
            label={t.linuxPrivateNetwork}
            value={s.sandbox?.linuxPrivateNetwork ?? ''}
            options={[
              ['', t.fromLocal],
              ['auto', t.netAuto],
              ['off', t.netOff],
            ]}
            onChange={(x) => {
              setDraft(withKey(draft, 'sandbox', 'linuxPrivateNetwork', x === '' ? undefined : x));
            }}
          />
          <span className="text-[0.78125rem] text-dy-muted">{t.linuxPrivateNetworkHint}</span>
          {meta('sandbox.linuxPrivateNetwork', v?.sandbox?.linuxPrivateNetwork)}
        </div>
        <FieldIssues issues={issues} prefix="settings.sandbox" />
      </fieldset>
      <FieldIssues issues={issues} prefix="settings" />
      <p className="m-0 text-[0.8125rem] text-dy-muted">{t.localOnly}</p>
      <RuntimePathsPanel view={view} />
      <CeilingPanel report={view.report} />
    </div>
  );
}

/** The keys whose new value waits for a restart of the worker, with a link to the restart. */
function PendingRestart(props: {
  readonly report: WorkerConfigReport | null;
  readonly workerId: string;
}): ReactNode {
  const t = useT().machineManaged.settings;
  const pending = props.report?.effective.settings?.pendingRestart ?? [];
  if (pending.length === 0) return null;
  return (
    <DyNotice
      tone="amber"
      icon="retry"
      title={t.pending}
      testId="settings-pending-restart"
      action={<Link to={machinePath(props.workerId, 'admin')}>{t.openRestart}</Link>}
    >
      <p className="m-0">{t.pendingHint}</p>
      <p className="m-0 mt-1 font-dy-mono text-[0.8125rem]">{pending.join(', ')}</p>
    </DyNotice>
  );
}

/** Owner only, machine administration on, always-fresh step-up: which executable each runtime runs. */
function RuntimePathsPanel(props: { readonly view: WorkerConfigView }): ReactNode {
  const { view } = props;
  const t = useT().machineManaged.paths;
  const { state: auth } = useAuth();
  const owner = auth.kind === 'signedIn' && auth.user.role === 'owner';
  const submit = useSubmit();
  const guarded = useGuarded();
  const desired = view.desired?.spec.settings?.runtimePaths ?? {};
  const now = view.report?.effective.settings?.values.runtimePaths ?? {};
  const [binaries, setBinaries] = useState<Partial<Record<ConfigRuntime, string>>>({});
  const [extensions, setExtensions] = useState('');
  const [saved, setSaved] = useState(false);
  const key = JSON.stringify(desired);
  useEffect(() => {
    const d = JSON.parse(key) as Partial<Record<ConfigRuntime, RuntimePaths>>;
    setBinaries(Object.fromEntries(CONFIG_RUNTIMES.map((r) => [r, d[r]?.binary ?? ''])));
    setExtensions((d.pi?.extensions ?? []).join('\n'));
  }, [key]);
  const can = owner && view.settings.machineAdmin;
  const save = (): void => {
    setSaved(false);
    const paths: Partial<Record<ConfigRuntime, RuntimePaths>> = {};
    for (const r of CONFIG_RUNTIMES) {
      const b = (binaries[r] ?? '').trim();
      const ext =
        r === 'pi'
          ? extensions
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l !== '')
          : [];
      if (b !== '' || ext.length > 0)
        paths[r] = { ...(b === '' ? {} : { binary: b }), ...(ext.length > 0 ? { extensions: ext } : {}) };
    }
    void submit.run(async () => {
      const r = await guarded(
        () =>
          putRuntimePaths(view.workerId, {
            runtimePaths: paths,
            expectedGeneration: view.desired?.generation ?? 0,
          }),
        t.why({ name: view.displayName }),
      );
      if (r !== null) setSaved(true);
    });
  };
  return (
    <Panel title={t.title} sub={t.sub} testId="runtime-paths">
      <div className="flex flex-col gap-3">
        {!view.settings.machineAdmin ? <DyNotice tone="neutral">{t.needsMachineAdmin}</DyNotice> : null}
        {view.settings.machineAdmin && !owner ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.ownerOnly}</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {CONFIG_RUNTIMES.map((r) => (
            <DyField
              key={r}
              label={t.binary({ runtime: runtimeDisplayName(r) })}
              value={binaries[r] ?? ''}
              disabled={!can}
              hint={(() => {
                const b = now[r]?.binary;
                return b === undefined ? undefined : t.inEffect({ value: b });
              })()}
              onChange={(x) => {
                setBinaries({ ...binaries, [r]: x });
              }}
            />
          ))}
        </div>
        <DyTextarea
          label={t.extensions}
          value={extensions}
          rows={2}
          disabled={!can}
          onChange={setExtensions}
        />
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.hint}</p>
        {can ? (
          <div>
            <DyButton variant="primary" busy={submit.busy} onClick={save} data-testid="runtime-paths-save">
              {t.save}
            </DyButton>
          </div>
        ) : null}
        {saved ? (
          <DyNotice tone="green" live>
            {t.saved}
          </DyNotice>
        ) : null}
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </Panel>
  );
}

const CEILING_FLAGS = [
  'allowUnconfined',
  'allowMachineAdmin',
  'allowPanelSkills',
  'allowMcp',
  'allowMcpEgress',
  'allowMcpStdio',
  'allowPanelMcp',
  'allowCustomTools',
  'allowServices',
] as const;

/** `localCeiling.*` — read-only: the machine owner's veto. */
function CeilingPanel(props: { readonly report: WorkerConfigReport | null }): ReactNode {
  const t = useT().machineManaged.ceiling;
  const c = props.report?.ceiling;
  const rows: KeyValueRow[] = [];
  if (c !== undefined) {
    for (const f of CEILING_FLAGS) {
      if (c[f] === false) rows.push({ k: t.flags[f], v: <Pill tone="red">{t.forbidden}</Pill> });
    }
  }
  return (
    <Panel title={t.title} sub={t.sub} testId="local-ceiling">
      {rows.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.none}</p>
      ) : (
        <KeyValue rows={rows} />
      )}
    </Panel>
  );
}
