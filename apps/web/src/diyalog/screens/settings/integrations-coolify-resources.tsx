import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  type Backup,
  cancelDeployment,
  createBackup,
  createDatabase,
  createEnvironment,
  createProject,
  createService,
  deleteBackup,
  deleteEnvironment,
  deleteProject,
  deleteResource,
  getDatabaseBackups,
  getEnvironments,
  getOverview,
  getServer,
  type Overview,
  type Res,
  type ResourceKind,
  runBackup,
  type ServerView,
  setServiceEnvs,
  validateServer,
  type WriteResult,
} from '../../../api/coolifyResources';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { DyConfirmDialog } from '../../common/actions';
import { useDoneToast } from '../../toast/useDoneToast';
import { ConfirmButton, DyApiError, DyCheck, DyField, DyNotice, FormActions, FormGrid } from '../forms';
import { DyButton, DySelect, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import {
  CoolifyLifecycle,
  CoolifyLogsPanel,
  CoolifyStoragePanel,
  useCoolifyWrite,
} from '../shared/CoolifyResourceParts';

/**
 * p17-coolify-full (docs/design/p17-coolify-full.md §7): Ayarlar → Entegrasyonlar → Coolify → Kaynaklar — the whole
 * Coolify of one connection: applications, databases (backups), services (variables), servers, projects (environments)
 * and the deployments running now, with storages, start / stop / restart and logs per resource. Administrators; writes
 * need the connection's "Uygulama yönetimi" switch, deletions the typed name. The control plane is read-only.
 */

type Kind = 'applications' | 'databases' | 'services' | 'servers' | 'projects' | 'deployments';
const KINDS: readonly Kind[] = [
  'applications',
  'databases',
  'services',
  'servers',
  'projects',
  'deployments',
];
const ENGINES = [
  'postgresql',
  'mysql',
  'mariadb',
  'mongodb',
  'redis',
  'keydb',
  'dragonfly',
  'clickhouse',
] as const;

type Openable = 'storage' | 'status' | 'logs' | 'backups' | 'delete' | 'envs' | 'server' | 'envList';
type Open =
  | { readonly what: Openable; readonly r: Res }
  | { readonly what: 'newDatabase' | 'newService' | 'newProject' }
  | null;

const RESOURCE_OF: Readonly<Partial<Record<Kind, ResourceKind>>> = {
  applications: 'application',
  databases: 'database',
  services: 'service',
};

export function CoolifyResources(props: {
  readonly connection: { readonly id: string; readonly label: string };
  readonly onClose: () => void;
}): ReactNode {
  const tx = useT().coolifyApps;
  const t = tx.resources;
  const load = useSubmit();
  const act = useSubmit();
  const write = useCoolifyWrite();
  const { run } = load;
  const [data, setData] = useState<Overview | null>(null);
  const [kind, setKind] = useState<Kind>('applications');
  const [open, setOpen] = useState<Open>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'coolify-resources-done' });
  const conn = props.connection.id;
  const refresh = useCallback(() => {
    void run(async () => {
      setData(await getOverview(conn));
    });
  }, [run, conn]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const manage = data?.connection.manageApps === true;
  const items: readonly Res[] =
    data === null
      ? []
      : kind === 'deployments'
        ? data.deployments.map((d) => ({
            uuid: d.uuid,
            name: d.application ?? d.uuid,
            status: d.status,
            detail: null,
            controlPlane: false,
          }))
        : data[kind];
  const resource = RESOURCE_OF[kind];
  const partsOf = (r: Res) => data?.services.find((x) => x.uuid === r.uuid)?.parts;
  const simple = async (fn: () => Promise<WriteResult>, msg: string): Promise<void> => {
    setDone(null);
    await act.run(async () => {
      const out = await write(fn, t.stepUp);
      if (out === null) return;
      setDone([msg, ...out.warnings].join(' '));
      refresh();
    });
  };

  return (
    <Panel title={t.title({ label: props.connection.label })} sub={t.sub} testId="coolify-resources">
      <div className="flex flex-col gap-3 pb-3">
        <DyApiError error={load.error} retryLeft={load.retryLeft} />
        {data === null && load.error === null ? <SkeletonRows label={t.loading} rows={3} /> : null}
        {data?.connection.version == null ? null : (
          <p className="m-0 text-[0.8125rem] text-dy-muted">
            {t.version({ version: data.connection.version })}
          </p>
        )}
        {data !== null && !manage ? <DyNotice tone="amber">{t.manageOff}</DyNotice> : null}
        {data !== null && data.notes.length > 0 ? (
          <DyNotice tone="neutral" title={t.notes}>
            {data.notes.join(' · ')}
          </DyNotice>
        ) : null}
        <DySelect
          label={t.tabsLabel}
          value={kind}
          options={KINDS.map((k) => [k, t.tabs[k]] as const)}
          onChange={(v) => {
            setKind(KINDS.find((k) => k === v) ?? 'applications');
            setOpen(null);
          }}
        />
        {manage && (kind === 'databases' || kind === 'services' || kind === 'projects') ? (
          <FormActions>
            <DyButton
              icon="plus"
              data-testid={`coolify-new-${kind}`}
              onClick={() => {
                setOpen({
                  what:
                    kind === 'databases' ? 'newDatabase' : kind === 'services' ? 'newService' : 'newProject',
                });
              }}
            >
              {kind === 'databases' ? t.newDatabase : kind === 'services' ? t.newService : t.newProject}
            </DyButton>
          </FormActions>
        ) : null}
        {data !== null && items.length === 0 ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">
            {kind === 'deployments' ? t.noDeployments : t.empty}
          </p>
        ) : null}
        {items.length > 0 ? (
          <Rows label={t.tabs[kind]} testId={`coolify-list-${kind}`}>
            {items.map((r) => {
              const writable = manage && !r.controlPlane;
              const btn = (what: Openable, label: string) => (
                <DyButton
                  key={what}
                  data-testid={`coolify-${what}-${r.uuid}`}
                  onClick={() => {
                    setOpen({ what, r });
                  }}
                >
                  {label}
                </DyButton>
              );
              return (
                <Row
                  key={r.uuid}
                  title={r.name}
                  meta={
                    <>
                      <span className="font-dy-mono">{r.uuid}</span>
                      {r.detail === null ? '' : ` · ${r.detail}`}
                      {r.controlPlane ? <span className="text-dy-amber-ink"> · {t.controlPlane}</span> : null}
                    </>
                  }
                  trail={r.status === '' ? undefined : <Pill tone="neutral">{r.status}</Pill>}
                  actions={
                    <div className="flex flex-wrap gap-2">
                      {resource !== undefined ? btn('storage', tx.storage.open) : null}
                      {resource !== undefined && writable ? btn('status', tx.lifecycle.open) : null}
                      {resource !== undefined ? btn('logs', tx.logs.open) : null}
                      {kind === 'databases' ? btn('backups', t.backups) : null}
                      {kind === 'services' && writable ? btn('envs', t.envSet) : null}
                      {kind === 'servers' ? btn('server', t.serverDomains) : null}
                      {kind === 'servers' && manage && !r.controlPlane ? (
                        <DyButton
                          data-testid={`coolify-validate-${r.uuid}`}
                          disabled={act.busy}
                          onClick={() => void simple(() => validateServer(conn, r.uuid), t.validated)}
                        >
                          {t.validate}
                        </DyButton>
                      ) : null}
                      {kind === 'projects' ? btn('envList', t.environments) : null}
                      {kind === 'deployments' && manage ? (
                        <ConfirmButton
                          label={t.cancelDeployment}
                          testId={`coolify-cancel-${r.uuid}`}
                          disabled={act.busy}
                          onConfirm={() => void simple(() => cancelDeployment(conn, r.uuid), t.cancelled)}
                        />
                      ) : null}
                      {(kind === 'databases' || kind === 'services' || kind === 'projects') && writable ? (
                        <DyButton
                          variant="danger"
                          data-testid={`coolify-delete-${r.uuid}`}
                          onClick={() => {
                            setOpen({ what: 'delete', r });
                          }}
                        >
                          {t.del}
                        </DyButton>
                      ) : null}
                    </div>
                  }
                />
              );
            })}
          </Rows>
        ) : null}
        <DyApiError error={act.error} retryLeft={act.retryLeft} />
        {open !== null && 'r' in open && resource !== undefined && open.what === 'storage' ? (
          <CoolifyStoragePanel
            key={open.r.uuid}
            scope={{ kind: 'connection', connection: conn, resource, uuid: open.r.uuid }}
            name={open.r.name}
            canEdit={manage && !open.r.controlPlane}
            parts={resource === 'service' ? partsOf(open.r) : undefined}
            onClose={() => {
              setOpen(null);
            }}
          />
        ) : null}
        {open !== null && 'r' in open && resource !== undefined && open.what === 'status' ? (
          <section
            className="flex flex-col gap-2 rounded-[12px] border border-dy-line-2 p-4"
            data-testid="coolify-status"
          >
            <h3 className="m-0 text-[1rem] font-bold">{open.r.name}</h3>
            <CoolifyLifecycle
              scope={{ kind: 'connection', connection: conn, resource, uuid: open.r.uuid }}
              name={open.r.name}
              onDone={refresh}
            />
          </section>
        ) : null}
        {open !== null && 'r' in open && resource !== undefined && open.what === 'logs' ? (
          <CoolifyLogsPanel
            key={open.r.uuid}
            scope={{ kind: 'connection', connection: conn, resource, uuid: open.r.uuid }}
            name={open.r.name}
            parts={resource === 'service' ? partsOf(open.r) : undefined}
            onClose={() => {
              setOpen(null);
            }}
          />
        ) : null}
        {open !== null && 'r' in open && open.what === 'backups' ? (
          <Backups key={open.r.uuid} connection={conn} r={open.r} canEdit={manage && !open.r.controlPlane} />
        ) : null}
        {open !== null && 'r' in open && open.what === 'envs' ? (
          <ServiceEnv
            key={open.r.uuid}
            connection={conn}
            r={open.r}
            onDone={(msg) => {
              setOpen(null);
              setDone(msg);
            }}
          />
        ) : null}
        {open !== null && 'r' in open && open.what === 'server' ? (
          <ServerDetails key={open.r.uuid} connection={conn} r={open.r} />
        ) : null}
        {open !== null && 'r' in open && open.what === 'envList' ? (
          <Environments
            key={open.r.uuid}
            connection={conn}
            r={open.r}
            canEdit={manage && !open.r.controlPlane}
          />
        ) : null}
        {open !== null && 'r' in open && open.what === 'delete' ? (
          <DeleteResource
            key={open.r.uuid}
            connection={conn}
            kind={kind}
            r={open.r}
            onClose={() => {
              setOpen(null);
            }}
            onDeleted={(msg) => {
              setOpen(null);
              setDone(msg);
              refresh();
            }}
          />
        ) : null}
        {open !== null && !('r' in open) && data !== null ? (
          <NewResource
            what={open.what}
            connection={conn}
            data={data}
            onClose={() => {
              setOpen(null);
            }}
            onCreated={() => {
              setOpen(null);
              setDone(t.created);
              refresh();
            }}
          />
        ) : null}
        <FormActions>
          <DyButton icon="retry" busy={load.busy} onClick={refresh}>
            {tx.logs.refresh}
          </DyButton>
          <DyButton onClick={props.onClose}>{t.close}</DyButton>
        </FormActions>
      </div>
    </Panel>
  );
}

const box = 'flex flex-col gap-3 rounded-[12px] border border-dy-line-2 p-4';

function DeleteResource(props: {
  readonly connection: string;
  readonly kind: Kind;
  readonly r: Res;
  readonly onClose: () => void;
  readonly onDeleted: (msg: string) => void;
}): ReactNode {
  const t = useT().coolifyApps.resources;
  const save = useSubmit();
  const write = useCoolifyWrite();
  const [confirm, setConfirm] = useState('');
  const [volumes, setVolumes] = useState(false);
  const submit = async (): Promise<void> => {
    await save.run(async () => {
      const out = await write(
        () =>
          props.kind === 'projects'
            ? deleteProject(props.connection, props.r.uuid, confirm.trim())
            : deleteResource(
                props.connection,
                props.kind === 'services' ? 'service' : 'database',
                props.r.uuid,
                confirm.trim(),
                volumes,
              ),
        t.stepUp,
      );
      if (out !== null) props.onDeleted([t.deleted({ name: props.r.name }), ...out.lost].join(' '));
    });
  };
  // p18-confirm-dialog: the typed-name confirmation is a dialog, not a panel on the page.
  return (
    <DyConfirmDialog
      open
      focusField
      onClose={props.onClose}
      title={t.delTitle({ name: props.r.name })}
      confirmLabel={t.delConfirm}
      cancelLabel={t.close}
      busy={save.busy}
      confirmDisabled={confirm.trim() !== props.r.name}
      testId="coolify-delete-resource"
      confirmTestId="coolify-delete-resource-submit"
      onConfirm={() => void submit()}
    >
      <DyField
        label={t.dbName}
        hint={t.delHint({ name: props.r.name })}
        mono
        autoFocus
        autoComplete="off"
        value={confirm}
        onChange={setConfirm}
      />
      {props.kind === 'projects' ? null : (
        <DyCheck label={t.delVolumes} checked={volumes} onChange={setVolumes} />
      )}
      <DyApiError error={save.error} retryLeft={save.retryLeft} />
    </DyConfirmDialog>
  );
}

function Backups(props: {
  readonly connection: string;
  readonly r: Res;
  readonly canEdit: boolean;
}): ReactNode {
  const t = useT().coolifyApps.resources;
  const load = useSubmit();
  const act = useSubmit();
  const write = useCoolifyWrite();
  const { run } = load;
  const [items, setItems] = useState<Backup[] | null>(null);
  const [frequency, setFrequency] = useState('0 3 * * *');
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'coolify-backup-done' });
  const refresh = useCallback(() => {
    void run(async () => {
      setItems(await getDatabaseBackups(props.connection, props.r.uuid));
    });
  }, [run, props.connection, props.r.uuid]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const go = async (fn: () => Promise<WriteResult>, msg: string): Promise<void> => {
    setDone(null);
    await act.run(async () => {
      if ((await write(fn, t.stepUp)) === null) return;
      setDone(msg);
      refresh();
    });
  };
  return (
    <section className={box} data-testid="coolify-backups" aria-label={`${props.r.name} — ${t.backups}`}>
      <h3 className="m-0 text-[1rem] font-bold">
        {props.r.name} — {t.backups}
      </h3>
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {items !== null && items.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.backupNone}</p>
      ) : null}
      {items !== null && items.length > 0 ? (
        <Rows label={t.backups}>
          {items.map((b) => (
            <Row
              key={b.uuid}
              title={<span className="font-dy-mono">{b.frequency}</span>}
              meta={b.last === null ? undefined : t.backupLast({ last: b.last })}
              actions={
                props.canEdit ? (
                  <div className="flex flex-wrap gap-2">
                    <DyButton
                      data-testid={`coolify-backup-run-${b.uuid}`}
                      disabled={act.busy}
                      onClick={() =>
                        void go(() => runBackup(props.connection, props.r.uuid, b.uuid), t.backupDone)
                      }
                    >
                      {t.backupRun}
                    </DyButton>
                    <ConfirmButton
                      label={t.backupDelete}
                      disabled={act.busy}
                      onConfirm={() =>
                        void go(() => deleteBackup(props.connection, props.r.uuid, b.uuid), t.backupDelete)
                      }
                    />
                  </div>
                ) : undefined
              }
            />
          ))}
        </Rows>
      ) : null}
      {props.canEdit ? (
        <FormGrid>
          <DyField
            label={t.backupFrequency}
            hint={t.backupFrequencyHint}
            mono
            value={frequency}
            onChange={setFrequency}
          />
          <FormActions>
            <DyButton
              icon="plus"
              data-testid="coolify-backup-add"
              disabled={act.busy || frequency.trim() === ''}
              onClick={() =>
                void go(
                  () => createBackup(props.connection, props.r.uuid, { frequency: frequency.trim() }),
                  t.created,
                )
              }
            >
              {t.backupAdd}
            </DyButton>
          </FormActions>
        </FormGrid>
      ) : null}
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </section>
  );
}

function ServiceEnv(props: {
  readonly connection: string;
  readonly r: Res;
  readonly onDone: (msg: string) => void;
}): ReactNode {
  const t = useT().coolifyApps.resources;
  const save = useSubmit();
  const write = useCoolifyWrite();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const submit = async (): Promise<void> => {
    await save.run(async () => {
      const out = await write(
        () =>
          setServiceEnvs(props.connection, props.r.uuid, {
            changes: [{ key: key.trim(), value }],
            restart: true,
          }),
        t.stepUp,
      );
      if (out !== null) props.onDone([t.envSaved, ...out.warnings].join(' '));
    });
  };
  return (
    <section className={box} data-testid="coolify-service-env" aria-label={`${props.r.name} — ${t.envSet}`}>
      <FormGrid>
        <DyField label={t.envKey} mono value={key} onChange={setKey} />
        <DyField label={t.envValue} type="password" autoComplete="off" value={value} onChange={setValue} />
      </FormGrid>
      <DyApiError error={save.error} retryLeft={save.retryLeft} />
      <FormActions>
        <DyButton
          variant="primary"
          busy={save.busy}
          disabled={key.trim() === ''}
          data-testid="coolify-service-env-save"
          onClick={() => void submit()}
        >
          {t.envSet}
        </DyButton>
      </FormActions>
    </section>
  );
}

function ServerDetails(props: { readonly connection: string; readonly r: Res }): ReactNode {
  const t = useT().coolifyApps.resources;
  const load = useSubmit();
  const { run } = load;
  const [view, setView] = useState<ServerView | null>(null);
  useEffect(() => {
    void run(async () => {
      setView(await getServer(props.connection, props.r.uuid));
    });
  }, [run, props.connection, props.r.uuid]);
  return (
    <section className={box} data-testid="coolify-server" aria-label={props.r.name}>
      <h3 className="m-0 text-[1rem] font-bold">
        {props.r.name}
        {view === null ? '' : ` · ${t.serverResources({ n: view.resources.length })}`}
      </h3>
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {view === null ? null : (
        <ul className="m-0 list-none p-0 font-dy-mono text-[0.8125rem]">
          {view.domains.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Environments(props: {
  readonly connection: string;
  readonly r: Res;
  readonly canEdit: boolean;
}): ReactNode {
  const t = useT().coolifyApps.resources;
  const load = useSubmit();
  const act = useSubmit();
  const write = useCoolifyWrite();
  const { run } = load;
  const [items, setItems] = useState<{ name: string }[] | null>(null);
  const [name, setName] = useState('');
  const refresh = useCallback(() => {
    void run(async () => {
      setItems(await getEnvironments(props.connection, props.r.uuid));
    });
  }, [run, props.connection, props.r.uuid]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const go = async (fn: () => Promise<WriteResult>): Promise<void> => {
    await act.run(async () => {
      if ((await write(fn, t.stepUp)) !== null) refresh();
    });
  };
  return (
    <section
      className={box}
      data-testid="coolify-environments"
      aria-label={`${props.r.name} — ${t.environments}`}
    >
      <h3 className="m-0 text-[1rem] font-bold">
        {props.r.name} — {t.environments}
      </h3>
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {items === null ? null : (
        <Rows label={t.environments}>
          {items.map((e) => (
            <Row
              key={e.name}
              title={e.name}
              actions={
                props.canEdit ? (
                  <ConfirmButton
                    label={t.del}
                    ariaLabel={t.deleteEnvironment({ name: e.name })}
                    question={t.delTitle({ name: e.name })}
                    disabled={act.busy}
                    onConfirm={() => void go(() => deleteEnvironment(props.connection, props.r.uuid, e.name))}
                  />
                ) : undefined
              }
            />
          ))}
        </Rows>
      )}
      {props.canEdit ? (
        <FormGrid>
          <DyField label={t.environmentName} mono value={name} onChange={setName} />
          <FormActions>
            <DyButton
              icon="plus"
              data-testid="coolify-environment-add"
              disabled={act.busy || name.trim() === ''}
              onClick={() => void go(() => createEnvironment(props.connection, props.r.uuid, name.trim()))}
            >
              {t.newEnvironment}
            </DyButton>
          </FormActions>
        </FormGrid>
      ) : null}
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </section>
  );
}

/** A new database, service or project (where it goes: the same pickers as a new application). */
function NewResource(props: {
  readonly what: 'newDatabase' | 'newService' | 'newProject';
  readonly connection: string;
  readonly data: Overview;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}): ReactNode {
  const t = useT().coolifyApps.resources;
  const save = useSubmit();
  const load = useSubmit();
  const write = useCoolifyWrite();
  const { run } = load;
  const usable = props.data.servers.filter((s) => !s.controlPlane);
  const projects = props.data.projects.filter((p) => !p.controlPlane);
  const [server, setServer] = useState(usable.length === 1 ? (usable[0]?.uuid ?? '') : '');
  const [project, setProject] = useState(projects.length === 1 ? (projects[0]?.uuid ?? '') : '');
  const [envs, setEnvs] = useState<{ name: string }[]>([]);
  const [environment, setEnvironment] = useState('');
  const [engine, setEngine] = useState<string>('postgresql');
  const [type, setType] = useState('');
  const [name, setName] = useState('');
  const [user, setUser] = useState('');
  const [database, setDatabase] = useState('');
  const [password, setPassword] = useState('');
  const [instant, setInstant] = useState(false);
  useEffect(() => {
    if (project === '' || props.what === 'newProject') return;
    void run(async () => {
      const list = await getEnvironments(props.connection, project);
      setEnvs(list);
      setEnvironment(list.length === 1 ? (list[0]?.name ?? '') : '');
    });
  }, [run, project, props.connection, props.what]);
  const opt = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim());
  const submit = async (): Promise<void> => {
    await save.run(async () => {
      const place = { server, coolifyProject: project, environment };
      const out = await write(
        () =>
          props.what === 'newProject'
            ? createProject(props.connection, name.trim())
            : props.what === 'newDatabase'
              ? createDatabase(props.connection, {
                  engine,
                  ...place,
                  ...(opt(name) === undefined ? {} : { name: opt(name) }),
                  ...(opt(user) === undefined ? {} : { user: opt(user) }),
                  ...(opt(database) === undefined ? {} : { database: opt(database) }),
                  ...(password === '' ? {} : { password }),
                  instantDeploy: instant,
                })
              : createService(props.connection, {
                  type: type.trim(),
                  ...place,
                  ...(opt(name) === undefined ? {} : { name: opt(name) }),
                  instantDeploy: instant,
                }),
        t.stepUp,
      );
      if (out !== null) props.onCreated();
    });
  };
  const title =
    props.what === 'newDatabase' ? t.newDatabase : props.what === 'newService' ? t.newService : t.newProject;
  return (
    <section className={box} data-testid={`coolify-${props.what}`} aria-label={title}>
      <h3 className="m-0 text-[1rem] font-bold">{title}</h3>
      <FormGrid>
        {props.what === 'newProject' ? (
          <DyField label={t.projectName} value={name} onChange={setName} />
        ) : (
          <>
            <DySelect
              label={t.server}
              value={server}
              options={[['', t.choose], ...usable.map((s) => [s.uuid, s.name] as const)]}
              onChange={setServer}
            />
            <DySelect
              label={t.coolifyProject}
              value={project}
              options={[['', t.choose], ...projects.map((p) => [p.uuid, p.name] as const)]}
              onChange={setProject}
            />
            <DySelect
              label={t.environment}
              value={environment}
              options={[['', t.choose], ...envs.map((e) => [e.name, e.name] as const)]}
              onChange={setEnvironment}
            />
            {props.what === 'newDatabase' ? (
              <DySelect
                label={t.engine}
                value={engine}
                options={ENGINES.map((e) => [e, e] as const)}
                onChange={setEngine}
              />
            ) : (
              <DyField label={t.serviceType} hint={t.serviceTypeHint} mono value={type} onChange={setType} />
            )}
            <DyField label={t.dbName} value={name} onChange={setName} />
            {props.what === 'newDatabase' ? (
              <>
                <DyField label={t.dbUser} mono value={user} onChange={setUser} />
                <DyField label={t.dbDatabase} mono value={database} onChange={setDatabase} />
                <DyField
                  label={t.dbPassword}
                  hint={t.dbPasswordHint}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={setPassword}
                />
              </>
            ) : null}
          </>
        )}
      </FormGrid>
      {props.what === 'newProject' ? null : (
        <DyCheck label={t.instantDeploy} checked={instant} onChange={setInstant} />
      )}
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      <DyApiError error={save.error} retryLeft={save.retryLeft} />
      <FormActions>
        <DyButton
          variant="primary"
          busy={save.busy}
          data-testid="coolify-create-resource"
          disabled={
            props.what === 'newProject'
              ? name.trim() === ''
              : server === '' ||
                project === '' ||
                environment === '' ||
                (props.what === 'newService' && type.trim() === '')
          }
          onClick={() => void submit()}
        >
          {t.create}
        </DyButton>
        <DyButton onClick={props.onClose}>{t.close}</DyButton>
      </FormActions>
    </section>
  );
}
