import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  extendService,
  LIVE_STATES,
  listServices,
  restartService,
  type ServiceLogLine,
  serviceLogs,
  type ServiceView,
  startService,
  stopService,
} from '../../../api/services';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { DyDialog } from '../../DyDialog';
import { ConfirmButton, DyApiError, DyField, FormActions, FormGrid } from '../forms';
import { DyButton, DySelect, EmptyLine, ErrorLine, Panel, Pill, SkeletonRows } from '../parts';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p15-services (docs/design/p15-services.md §7): Servisler — the services of a machine (Makineler → makine → Servisler)
 * or of a project (Projeler → proje → Servisler): state, health, public URL (tunnel), port, uptime, CPU / memory,
 * lifetime; logs; stop / restart / extend / remove; and (project, operator+) a form that starts one from a checkout of
 * the project repository. Display only: the master decides (RBAC, limits, sandbox) and audits every change.
 */

const POLL_MS = 5_000;
type Tone = 'green' | 'amber' | 'red' | 'neutral';

const STATE_TONE: Readonly<Record<string, Tone>> = {
  running: 'green',
  starting: 'amber',
  pending: 'amber',
  restarting: 'amber',
  unhealthy: 'red',
  failed: 'red',
  refused: 'red',
  stopped: 'neutral',
  expired: 'neutral',
};

function useServices(filter: { project?: string; worker?: string }) {
  const { project, worker } = filter;
  const [rows, setRows] = useState<readonly ServiceView[] | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const load = useCallback(async () => {
    try {
      setRows(
        await listServices({
          ...(project === undefined ? {} : { project }),
          ...(worker === undefined ? {} : { worker }),
          state: 'any',
        }),
      );
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  }, [project, worker]);
  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, POLL_MS);
    return () => {
      clearInterval(t);
    };
  }, [load]);
  return { rows, error, reload: load };
}

export function ServicesPanel(props: {
  readonly project?: string;
  readonly workerId?: string;
  readonly canManage: boolean;
}): ReactNode {
  const t = useT().services;
  const { rows, error, reload } = useServices({
    ...(props.project === undefined ? {} : { project: props.project }),
    ...(props.workerId === undefined ? {} : { worker: props.workerId }),
  });
  const [logsOf, setLogsOf] = useState<ServiceView | null>(null);
  const [form, setForm] = useState(false);
  return (
    <div className="flex flex-col gap-4" data-testid="dy-services">
      <Panel
        title={t.title}
        sub={props.project === undefined ? t.machineSub : t.projectSub}
        flush
        aside={
          props.project !== undefined && props.canManage && !form ? (
            <DyButton
              icon="plus"
              onClick={() => {
                setForm(true);
              }}
              data-testid="service-new"
            >
              {t.form.title}
            </DyButton>
          ) : null
        }
      >
        <ErrorLine error={error} what={t.readError} onRetry={() => void reload()} />
        {rows === null && error === null ? <SkeletonRows label={t.loading} /> : null}
        {rows !== null && rows.length === 0 ? <EmptyLine>{t.empty}</EmptyLine> : null}
        {rows !== null && rows.length > 0 ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-dy-line p-0" data-testid="service-rows">
            {rows.map((s) => (
              <ServiceRow
                key={s.id}
                service={s}
                canManage={props.canManage}
                showMachine={props.workerId === undefined}
                showProject={props.project === undefined}
                onLogs={() => {
                  setLogsOf(s);
                }}
                onChanged={() => void reload()}
              />
            ))}
          </ul>
        ) : null}
        {!props.canManage ? (
          <p className="m-0 px-4 pb-3 text-[0.78125rem] text-dy-muted">{t.viewerNote}</p>
        ) : null}
      </Panel>
      {form && props.project !== undefined ? (
        <StartForm
          project={props.project}
          onDone={() => {
            setForm(false);
            void reload();
          }}
        />
      ) : null}
      {logsOf === null ? null : (
        <LogsDialog
          service={logsOf}
          onClose={() => {
            setLogsOf(null);
          }}
        />
      )}
    </div>
  );
}

function ServiceRow(props: {
  readonly service: ServiceView;
  readonly canManage: boolean;
  readonly showMachine: boolean;
  readonly showProject: boolean;
  readonly onLogs: () => void;
  readonly onChanged: () => void;
}): ReactNode {
  const t = useT().services;
  const f = useFormat();
  const s = props.service;
  const act = useSubmit();
  const live = LIVE_STATES.has(s.state) && s.desired === 'running';
  const run = (fn: () => Promise<unknown>) => {
    void act.run(async () => {
      await fn();
      props.onChanged();
    });
  };
  const stateWord = (t.state as Readonly<Record<string, string>>)[s.state] ?? s.state;
  const healthWord = (t.health as Readonly<Record<string, string>>)[s.health] ?? s.health;
  const uptime = s.startedAt !== null && live ? f.duration(Date.now() - Date.parse(s.startedAt)) : null;
  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-testid="service-row" data-state={s.state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold" translate="no">
          {s.name}
        </span>
        <Pill tone={STATE_TONE[s.state] ?? 'neutral'}>{stateWord}</Pill>
        {live ? <Pill tone={s.health === 'unhealthy' ? 'red' : 'neutral'}>{healthWord}</Pill> : null}
        {!s.workerConnected ? <Pill tone="amber">{t.fields.offline}</Pill> : null}
        {s.network === 'model_apis_only' ? <Pill tone="amber">{t.fields.modelApisOnly}</Pill> : null}
        {props.showProject ? (
          <Link to={`/projects/${encodeURIComponent(s.project)}?tab=services`} className="text-[0.8125rem]">
            {s.project}
          </Link>
        ) : null}
        {props.showMachine ? (
          <Link to={`/machines/${encodeURIComponent(s.workerId)}?tab=services`} className="text-[0.8125rem]">
            {s.workerName ?? s.workerId}
          </Link>
        ) : null}
      </div>
      {s.url !== null ? (
        <div className="flex flex-wrap items-center gap-2 text-[0.875rem]">
          <a
            href={s.url}
            target="_blank"
            rel="noreferrer noopener"
            className="font-dy-mono"
            data-testid="service-url"
          >
            {s.url}
          </a>
          {s.tunnel.mode === 'quick' ? <span className="text-dy-muted">{t.tunnel.publicWarning}</span> : null}
        </div>
      ) : s.tunnel.mode !== 'none' && live ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">
          {s.tunnel.state === 'failed' || s.tunnel.state === 'refused'
            ? `${s.tunnel.state === 'failed' ? t.tunnel.failed : t.tunnel.refused}${s.tunnel.detail === null ? '' : ` — ${s.tunnel.detail}`}`
            : t.tunnel.starting}
        </p>
      ) : null}
      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-1 text-[0.8125rem] sm:grid-cols-4">
        <Fact label={t.fields.port} value={s.port === null ? '—' : String(s.port)} />
        <Fact label={t.fields.uptime} value={uptime ?? '—'} />
        <Fact
          label={t.fields.cpu}
          value={s.cpuPercent === null || !live ? '—' : f.percent(s.cpuPercent / 100)}
        />
        <Fact
          label={t.fields.memory}
          value={s.memoryBytes === null || !live ? '—' : f.bytes(s.memoryBytes)}
        />
        <Fact
          label={t.fields.expires}
          value={s.expiresAt === null ? t.fields.untilStopped : f.dateTime(s.expiresAt)}
        />
        <Fact label={t.fields.restarts} value={String(s.restarts)} />
        <Fact label={t.fields.startedBy} value={s.createdBy.username ?? s.createdBy.id} />
        {s.sourceJobId === null ? null : (
          <div className="min-w-0">
            <dt className="text-dy-muted">{t.fields.fromJob}</dt>
            <dd className="m-0 truncate">
              <Link to={`/jobs/${s.sourceJobId}`} className="font-dy-mono">
                {s.sourceJobId.slice(0, 8)}
              </Link>
            </dd>
          </div>
        )}
      </dl>
      <p
        className="m-0 truncate font-dy-mono text-[0.78125rem] text-dy-muted"
        title={s.command}
        translate="no"
      >
        {s.command}
      </p>
      {s.detail !== null && !live ? <p className="m-0 text-[0.8125rem] text-dy-muted">{s.detail}</p> : null}
      <div className="flex flex-wrap gap-2">
        <DyButton variant="ghost" onClick={props.onLogs} data-testid="service-logs">
          {t.actions.logs}
        </DyButton>
        {props.canManage ? (
          <>
            {live ? (
              <DyButton
                busy={act.busy}
                onClick={() => {
                  run(() => stopService(s.id));
                }}
                data-testid="service-stop"
              >
                {t.actions.stop}
              </DyButton>
            ) : null}
            <DyButton
              busy={act.busy}
              onClick={() => {
                run(() => restartService(s.id));
              }}
              data-testid="service-restart"
            >
              {live ? t.actions.restart : t.actions.start}
            </DyButton>
            {live ? (
              <>
                <DyButton
                  variant="ghost"
                  busy={act.busy}
                  onClick={() => {
                    run(() => extendService(s.id, { minutes: 240 }));
                  }}
                  data-testid="service-extend"
                >
                  {t.actions.extendHours({ h: 4 })}
                </DyButton>
                <DyButton
                  variant="ghost"
                  busy={act.busy}
                  onClick={() => {
                    run(() => extendService(s.id, { untilStopped: true }));
                  }}
                >
                  {t.actions.forever}
                </DyButton>
              </>
            ) : (
              <ConfirmButton
                label={t.actions.remove}
                question={t.actions.removeConfirm}
                variant="danger"
                busy={act.busy}
                onConfirm={() => {
                  run(() => stopService(s.id, true));
                }}
                testId="service-remove"
              />
            )}
          </>
        ) : null}
      </div>
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </li>
  );
}

function Fact(props: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <div className="min-w-0">
      <dt className="text-dy-muted">{props.label}</dt>
      <dd className="m-0 truncate">{props.value}</dd>
    </div>
  );
}

function LogsDialog(props: { readonly service: ServiceView; readonly onClose: () => void }): ReactNode {
  const t = useT().services.logs;
  const [lines, setLines] = useState<readonly ServiceLogLine[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const loader = useSubmit();
  const { run } = loader;
  const load = useCallback(() => {
    void run(async () => {
      const l = await serviceLogs(props.service.id, 300);
      setLines(l.lines);
      setTruncated(l.truncated);
    });
  }, [run, props.service.id]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <DyDialog
      open
      onClose={props.onClose}
      title={t.title({ name: props.service.name })}
      description={t.note}
      size="lg"
      testId="service-logs-dialog"
      footer={
        <>
          <DyButton onClick={load} busy={loader.busy}>
            {t.refresh}
          </DyButton>
          <DyButton variant="primary" onClick={props.onClose}>
            {t.close}
          </DyButton>
        </>
      }
    >
      <DyApiError error={loader.error} retryLeft={loader.retryLeft} />
      {lines !== null && lines.length === 0 ? <p className="m-0 text-dy-muted">{t.empty}</p> : null}
      {truncated ? <p className="m-0 mb-2 text-[0.78125rem] text-dy-muted">{t.truncated}</p> : null}
      {lines !== null && lines.length > 0 ? (
        <pre
          className="m-0 max-h-[60vh] overflow-auto rounded-[9px] bg-dy-sunk p-3 font-dy-mono text-[0.78125rem] whitespace-pre-wrap"
          data-testid="service-log-lines"
        >
          {lines
            .map((l) => `${l.at.slice(11, 19)} ${l.stream === 'stderr' ? '!' : ' '} ${l.text}`)
            .join('\n')}
        </pre>
      ) : null}
    </DyDialog>
  );
}

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function StartForm(props: { readonly project: string; readonly onDone: () => void }): ReactNode {
  const all = useT().services;
  const t = all.form;
  const tt = all.tunnel;
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');
  const [port, setPort] = useState('');
  const [worker, setWorker] = useState('');
  const [tunnel, setTunnel] = useState<'none' | 'quick' | 'named'>('none');
  const [ttl, setTtl] = useState('240');
  const [health, setHealth] = useState<'none' | 'tcp' | 'http'>('tcp');
  const [restart, setRestart] = useState<'on-failure' | 'always' | 'never'>('on-failure');
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  const submit = useSubmit();
  const portNum = port.trim() === '' ? undefined : Number(port);
  const valid =
    NAME.test(name) &&
    command.trim() !== '' &&
    (portNum === undefined || (Number.isInteger(portNum) && portNum >= 1024 && portNum <= 65_535)) &&
    (tunnel === 'none' || portNum !== undefined);
  const go = (): void => {
    void submit.run(async () => {
      const v = await startService(props.project, {
        ...(worker.trim() === '' ? {} : { worker: worker.trim() }),
        request: {
          name,
          command,
          ...(cwd.trim() === '' ? {} : { cwd: cwd.trim() }),
          ...(portNum === undefined ? {} : { port: portNum }),
          tunnel,
          ...(ttl === 'forever' ? { untilStopped: true } : { ttlMinutes: Number(ttl) }),
          health:
            portNum === undefined || health === 'none'
              ? { kind: 'none' }
              : health === 'http'
                ? { kind: 'http', path: '/' }
                : { kind: 'tcp' },
          restart: { policy: restart },
        },
      });
      setDone(t.started({ name: v.name }));
      props.onDone();
    });
  };
  return (
    <Panel title={t.title} sub={t.noRepo} testId="service-form">
      <FormGrid>
        <DyField
          label={t.name}
          value={name}
          onChange={setName}
          hint={t.nameHint}
          mono
          data-testid="service-name"
        />
        <DyField label={t.command} value={command} onChange={setCommand} hint={t.commandHint} mono />
        <DyField label={t.cwd} value={cwd} onChange={setCwd} mono />
        <DyField label={t.port} value={port} onChange={setPort} inputMode="numeric" mono />
        <DyField label={t.machine} value={worker} onChange={setWorker} placeholder={t.anyMachine} mono />
        <DySelect
          label={t.tunnel}
          value={tunnel}
          options={[
            ['none', tt.none],
            ['quick', tt.quick],
            ['named', tt.named],
          ]}
          onChange={(v) => {
            setTunnel(v as 'none' | 'quick' | 'named');
          }}
        />
        <DySelect
          label={t.ttl}
          value={ttl}
          options={[
            ['60', t.ttlHours({ h: 1 })],
            ['240', t.ttlHours({ h: 4 })],
            ['1440', t.ttlHours({ h: 24 })],
            ['10080', t.ttlDays({ d: 7 })],
            ['forever', all.fields.untilStopped],
          ]}
          onChange={setTtl}
        />
        <DySelect
          label={t.health}
          value={health}
          options={[
            ['tcp', t.healthTcp],
            ['http', t.healthHttp],
            ['none', t.healthNone],
          ]}
          onChange={(v) => {
            setHealth(v as 'none' | 'tcp' | 'http');
          }}
        />
        <DySelect
          label={t.restart}
          value={restart}
          options={[
            ['on-failure', t.restartOnFailure],
            ['always', t.restartAlways],
            ['never', t.restartNever],
          ]}
          onChange={(v) => {
            setRestart(v as 'on-failure' | 'always' | 'never');
          }}
        />
      </FormGrid>
      {tunnel === 'quick' ? (
        <p className="m-0 mt-2 text-[0.8125rem] text-dy-amber-ink">{tt.publicWarning}</p>
      ) : null}
      <FormActions className="mt-3">
        <DyButton
          variant="primary"
          busy={submit.busy}
          disabled={!valid || submit.blocked}
          onClick={go}
          data-testid="service-submit"
        >
          {t.submit}
        </DyButton>
        <DyButton variant="ghost" onClick={props.onDone}>
          {t.cancel}
        </DyButton>
      </FormActions>
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </Panel>
  );
}

/** Makine → Genel bakış, next to the slots: services are listed apart from job slots (they hold none). */
export function ServicesSlotsNote(props: { readonly workerId: string }): ReactNode {
  const t = useT().services.slots;
  const { rows } = useServices({ worker: props.workerId });
  const live = rows?.filter((s) => s.desired === 'running' && LIVE_STATES.has(s.state)) ?? [];
  if (rows === null) return null;
  return (
    <Panel
      title={t.title}
      sub={t.sub}
      testId="service-slots-note"
      aside={
        <Link
          to={`/machines/${encodeURIComponent(props.workerId)}?tab=services`}
          className="text-[0.8125rem]"
        >
          {t.open}
        </Link>
      }
    >
      <p className="m-0 text-[0.875rem]" data-testid="service-slots-count">
        {t.count({ n: live.length })}
      </p>
      {live.length > 0 ? (
        <ul className="m-0 mt-2 flex list-none flex-wrap gap-2 p-0">
          {live.map((s) => (
            <li key={s.id}>
              <Pill tone={STATE_TONE[s.state] ?? 'neutral'}>{s.name}</Pill>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
