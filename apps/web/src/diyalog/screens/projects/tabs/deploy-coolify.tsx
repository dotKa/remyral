import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { idempotencyKey } from '../../../../api/deploy';
import {
  type AppDetails,
  type AppSettings,
  BUILD_PACKS,
  type BuildPack,
  type BuildSuggestion,
  type CoolifyOptions,
  type Creation,
  createCoolifyApp,
  deleteCoolifyApp,
  type DeployEnvName,
  type EnvChange,
  type EnvScope,
  getCoolifyApp,
  getCoolifyOptions,
  getCoolifySuggestion,
  type LinkedApp,
  listCoolifyApps,
  setCoolifyDomains,
  setCoolifyEnvs,
  updateCoolifyApp,
} from '../../../../api/coolifyApps';
import { useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../../stepup/StepUpProvider';
import { DyApiError, DyCheck, DyField, DyNotice, DyTextarea, FormActions, FormGrid } from '../../forms';
import { DyButton, DySelect, Panel, Pill, Row, Rows, SkeletonRows } from '../../parts';
import { DyConfirmDialog } from '../../../common/actions';
import { useDoneToast } from '../../../toast/useDoneToast';
import { CoolifyLifecycle, CoolifyLogsPanel, CoolifyStoragePanel } from '../../shared/CoolifyResourceParts';

/**
 * p15-coolify-create (ADR-0057, docs/design/p15-coolify-create.md §5): Projeler → Deploy → "Coolify uygulamaları" —
 * the applications linked to the project's deploy targets with their variables and domains editors, and the
 * "Coolify’da yeni uygulama" wizard (server / project / environment pickers loaded from Coolify, defaults suggested
 * from the repository). Project admins only (the master checks `deploy.coolify.*` and the security policy's code
 * rule). Variable values are typed into password fields, sent once and never shown again.
 */

type Open =
  | { readonly kind: 'create' }
  | { readonly kind: 'envs'; readonly uuid: string; readonly name: string }
  | { readonly kind: 'domains'; readonly uuid: string; readonly name: string }
  | { readonly kind: 'settings'; readonly uuid: string; readonly name: string }
  | { readonly kind: 'delete'; readonly uuid: string; readonly name: string }
  // p17-coolify-full: storages, start / stop / restart and logs of a linked application.
  | { readonly kind: 'storage'; readonly uuid: string; readonly name: string }
  | { readonly kind: 'status'; readonly uuid: string; readonly name: string; readonly status: string | null }
  | { readonly kind: 'logs'; readonly uuid: string; readonly name: string }
  | null;

const lines = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter((l) => l !== '');

export function CoolifyAppsPanel(props: {
  readonly project: string;
  readonly canEdit: boolean;
  /** The deploy targets changed (a new application was linked). */
  readonly onChanged: () => void;
}): ReactNode {
  const tx = useT().coolifyApps;
  const t = tx;
  const load = useSubmit();
  const { run } = load;
  const [data, setData] = useState<{ items: LinkedApp[]; creations: Creation[] } | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const refresh = useCallback(() => {
    void run(async () => {
      setData(await listCoolifyApps(props.project));
    });
  }, [run, props.project]);
  useEffect(() => {
    if (props.canEdit) refresh();
  }, [refresh, props.canEdit]);
  if (!props.canEdit) return null;

  const off = data?.items.find((a) => !a.manageApps && a.problem === null) ?? null;
  return (
    <Panel
      title={t.panel.title}
      sub={t.panel.sub}
      testId="dy-coolify-apps"
      aside={
        <DyButton
          variant="primary"
          icon="plus"
          data-testid="coolify-new-app"
          onClick={() => {
            setOpen({ kind: 'create' });
          }}
        >
          {t.panel.create}
        </DyButton>
      }
    >
      <div className="flex flex-col gap-3 pb-3">
        <DyApiError error={load.error} retryLeft={load.retryLeft} />
        {data === null && load.error === null ? <SkeletonRows label={t.panel.loading} rows={2} /> : null}
        {off !== null ? (
          <DyNotice tone="amber">{t.panel.manageOff({ label: off.connection.label })}</DyNotice>
        ) : null}
        {data !== null && data.items.length === 0 ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{t.panel.empty}</p>
        ) : null}
        {data !== null && data.items.length > 0 ? (
          <Rows label={t.panel.listLabel} testId="coolify-linked">
            {data.items.map((a) => (
              <Row
                key={`${a.env}:${a.uuid}`}
                title={a.name ?? a.uuid}
                meta={
                  <>
                    {t.panel.envName[a.env]} · {a.connection.label} ·{' '}
                    {a.fqdn === null || a.fqdn === '' ? t.panel.noDomain : a.fqdn}
                    {a.problem === null ? null : <span className="text-dy-red-ink"> · {a.problem}</span>}
                  </>
                }
                trail={a.status === null ? undefined : <Pill tone="neutral">{a.status}</Pill>}
                actions={
                  a.problem === null && a.manageApps ? (
                    <div className="flex flex-wrap gap-2">
                      <DyButton
                        data-testid={`coolify-envs-${a.uuid}`}
                        onClick={() => {
                          setOpen({ kind: 'envs', uuid: a.uuid, name: a.name ?? a.uuid });
                        }}
                      >
                        {t.panel.envs}
                      </DyButton>
                      <DyButton
                        data-testid={`coolify-domains-${a.uuid}`}
                        onClick={() => {
                          setOpen({ kind: 'domains', uuid: a.uuid, name: a.name ?? a.uuid });
                        }}
                      >
                        {t.panel.domains}
                      </DyButton>
                      <DyButton
                        data-testid={`coolify-settings-${a.uuid}`}
                        onClick={() => {
                          setOpen({ kind: 'settings', uuid: a.uuid, name: a.name ?? a.uuid });
                        }}
                      >
                        {t.panel.settings}
                      </DyButton>
                      <DyButton
                        data-testid={`coolify-storage-${a.uuid}`}
                        onClick={() => {
                          setOpen({ kind: 'storage', uuid: a.uuid, name: a.name ?? a.uuid });
                        }}
                      >
                        {tx.storage.open}
                      </DyButton>
                      <DyButton
                        data-testid={`coolify-status-${a.uuid}`}
                        onClick={() => {
                          setOpen({ kind: 'status', uuid: a.uuid, name: a.name ?? a.uuid, status: a.status });
                        }}
                      >
                        {tx.lifecycle.open}
                      </DyButton>
                      <DyButton
                        data-testid={`coolify-logs-${a.uuid}`}
                        onClick={() => {
                          setOpen({ kind: 'logs', uuid: a.uuid, name: a.name ?? a.uuid });
                        }}
                      >
                        {tx.logs.open}
                      </DyButton>
                      <DyButton
                        variant="danger"
                        data-testid={`coolify-delete-${a.uuid}`}
                        onClick={() => {
                          setOpen({ kind: 'delete', uuid: a.uuid, name: a.name ?? a.uuid });
                        }}
                      >
                        {t.panel.delete}
                      </DyButton>
                    </div>
                  ) : undefined
                }
              />
            ))}
          </Rows>
        ) : null}
        {open?.kind === 'create' ? (
          <NewAppForm
            project={props.project}
            onClose={() => {
              setOpen(null);
            }}
            onCreated={() => {
              refresh();
              props.onChanged();
            }}
          />
        ) : null}
        {open?.kind === 'envs' ? (
          <EnvEditor
            key={open.uuid}
            project={props.project}
            uuid={open.uuid}
            name={open.name}
            onClose={() => {
              setOpen(null);
            }}
          />
        ) : null}
        {open?.kind === 'settings' ? (
          <SettingsEditor
            key={open.uuid}
            project={props.project}
            uuid={open.uuid}
            name={open.name}
            onClose={() => {
              setOpen(null);
              refresh();
            }}
          />
        ) : null}
        {open?.kind === 'delete' ? (
          <DeleteApp
            key={open.uuid}
            project={props.project}
            uuid={open.uuid}
            name={open.name}
            onClose={() => {
              setOpen(null);
            }}
            onDeleted={() => {
              setOpen(null);
              refresh();
              props.onChanged();
            }}
          />
        ) : null}
        {open?.kind === 'storage' ? (
          <CoolifyStoragePanel
            key={open.uuid}
            scope={{ kind: 'project', project: props.project, uuid: open.uuid }}
            name={open.name}
            canEdit
            onClose={() => {
              setOpen(null);
            }}
          />
        ) : null}
        {open?.kind === 'status' ? (
          <section
            aria-label={open.name}
            className="flex flex-col gap-3 rounded-[12px] border border-dy-line-2 p-4"
            data-testid="coolify-status"
          >
            <h3 className="m-0 flex flex-wrap items-center gap-2 text-[1rem] font-bold">
              {open.name}
              {open.status === null ? null : <Pill tone="neutral">{open.status}</Pill>}
            </h3>
            <CoolifyLifecycle
              scope={{ kind: 'project', project: props.project, uuid: open.uuid }}
              name={open.name}
              onDone={refresh}
            />
            <FormActions>
              <DyButton
                onClick={() => {
                  setOpen(null);
                }}
              >
                {tx.logs.close}
              </DyButton>
            </FormActions>
          </section>
        ) : null}
        {open?.kind === 'logs' ? (
          <CoolifyLogsPanel
            key={open.uuid}
            scope={{ kind: 'project', project: props.project, uuid: open.uuid }}
            name={open.name}
            onClose={() => {
              setOpen(null);
            }}
          />
        ) : null}
        {open?.kind === 'domains' ? (
          <DomainsEditor
            key={open.uuid}
            project={props.project}
            uuid={open.uuid}
            name={open.name}
            onClose={() => {
              setOpen(null);
              refresh();
            }}
          />
        ) : null}
        {data !== null && data.creations.length > 0 ? (
          <details className="text-[0.8125rem]" data-testid="coolify-creations">
            <summary className="cursor-pointer font-medium">{t.panel.creations}</summary>
            <ul className="m-0 mt-2 list-none p-0">
              {data.creations.map((c) => {
                const uuid = c.appUuid;
                // p15-coolify-dedupe: an application created here but no longer linked can be deleted from here too.
                const deletable =
                  uuid !== null &&
                  c.state === 'created' &&
                  c.deletedAt === null &&
                  !data.items.some((a) => a.uuid === uuid);
                return (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 py-0.5">
                    <span>
                      <span className="font-medium">{c.name}</span> · {t.panel.envName[c.env]} ·{' '}
                      {t.panel.state[c.state]}
                      {c.deletedAt === null ? '' : ` · ${t.panel.deleted}`}
                      {deletable ? ` · ${t.panel.notLinked}` : ''}
                      {c.error === null ? '' : ` — ${c.error}`}
                    </span>
                    {deletable ? (
                      <DyButton
                        variant="danger"
                        data-testid={`coolify-delete-${uuid}`}
                        onClick={() => {
                          setOpen({ kind: 'delete', uuid, name: c.name || uuid });
                        }}
                      >
                        {t.panel.delete}
                      </DyButton>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </details>
        ) : null}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------- new app

interface EnvRow {
  readonly id: number;
  readonly key: string;
  readonly value: string;
  readonly useShared: boolean;
  readonly shared: string;
  readonly preview: boolean;
  readonly scope: EnvScope;
}

let rowSeq = 0;
const emptyRow = (key = '', preview = false): EnvRow => ({
  id: ++rowSeq,
  key,
  value: '',
  useShared: false,
  shared: '',
  preview,
  scope: 'both',
});

function rowChange(r: EnvRow): EnvChange {
  return {
    key: r.key.trim(),
    ...(r.useShared ? { shared: r.shared.trim() } : { value: r.value }),
    ...(r.preview ? { preview: true } : {}),
    ...(r.scope === 'both' ? {} : { scope: r.scope }),
  };
}

function EnvRows(props: {
  readonly rows: readonly EnvRow[];
  readonly onChange: (rows: EnvRow[]) => void;
}): ReactNode {
  const t = useT().coolifyApps.env;
  const set = (id: number, patch: Partial<EnvRow>) => {
    props.onChange(props.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  return (
    <div className="flex flex-col gap-3">
      {props.rows.map((r) => (
        <div
          key={r.id}
          className="grid gap-2 rounded-[10px] border border-dy-line p-3 sm:grid-cols-2"
          data-testid="coolify-env-row"
        >
          <DyField
            label={t.key}
            mono
            value={r.key}
            autoComplete="off"
            onChange={(v) => {
              set(r.id, { key: v });
            }}
          />
          {r.useShared ? (
            <DyField
              label={t.shared}
              hint={t.sharedHint}
              mono
              value={r.shared}
              autoComplete="off"
              onChange={(v) => {
                set(r.id, { shared: v });
              }}
            />
          ) : (
            <DyField
              label={t.value}
              hint={t.valueHint}
              type="password"
              autoComplete="new-password"
              mono
              value={r.value}
              onChange={(v) => {
                set(r.id, { value: v });
              }}
            />
          )}
          <DyCheck
            label={t.useShared}
            checked={r.useShared}
            onChange={(v) => {
              set(r.id, { useShared: v });
            }}
          />
          <DyCheck
            label={t.preview}
            checked={r.preview}
            onChange={(v) => {
              set(r.id, { preview: v });
            }}
          />
          <DySelect
            label={t.scope}
            value={r.scope}
            options={(['both', 'runtime', 'buildtime'] as const).map((s) => [s, t.scopes[s]] as const)}
            onChange={(v) => {
              set(r.id, { scope: v as EnvScope });
            }}
          />
          <div className="flex items-end">
            <DyButton
              variant="ghost"
              icon="xc"
              onClick={() => {
                props.onChange(props.rows.filter((x) => x.id !== r.id));
              }}
            >
              {t.remove}
            </DyButton>
          </div>
        </div>
      ))}
      <div>
        <DyButton
          icon="plus"
          data-testid="coolify-env-add"
          onClick={() => {
            props.onChange([...props.rows, emptyRow()]);
          }}
        >
          {t.add}
        </DyButton>
      </div>
    </div>
  );
}

type SourceType = 'repository' | 'image' | 'dockerfile';
type Access = 'public' | 'github_app' | 'deploy_key';

function NewAppForm(props: {
  readonly project: string;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}): ReactNode {
  const t = useT().coolifyApps;
  const w = t.wizard;
  const stepUp = useStepUp();
  const load = useSubmit();
  const save = useSubmit();
  const { run } = load;
  const [opts, setOpts] = useState<CoolifyOptions | null>(null);
  const [suggestion, setSuggestion] = useState<BuildSuggestion | null>(null);
  const [env, setEnv] = useState<DeployEnvName>('production');
  const [connection, setConnection] = useState('');
  const [server, setServer] = useState('');
  const [cproj, setCproj] = useState('');
  const [environment, setEnvironment] = useState('');
  const [destination, setDestination] = useState('');
  const [name, setName] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>('repository');
  const [access, setAccess] = useState<Access>('public');
  const [githubApp, setGithubApp] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [branch, setBranch] = useState('');
  const [image, setImage] = useState('');
  const [tag, setTag] = useState('');
  const [dockerfile, setDockerfile] = useState('');
  const [buildPack, setBuildPack] = useState<BuildPack>('nixpacks');
  const [ports, setPorts] = useState('3000');
  const [isStatic, setIsStatic] = useState(false);
  const [publishDirectory, setPublishDirectory] = useState('');
  const [baseDirectory, setBaseDirectory] = useState('');
  const [domains, setDomains] = useState('');
  const [healthPath, setHealthPath] = useState('');
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [link, setLink] = useState<'add' | 'replace' | 'none'>('add');
  const [deploy, setDeploy] = useState(true);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [result, setResult] = useState<Creation | null>(null);
  const [key] = useState(() => idempotencyKey('coolify-app'));

  // Options of the chosen connection (the env target's by default) + the repository suggestion, once.
  useEffect(() => {
    void run(async () => {
      const o = await getCoolifyOptions(props.project, { env, ...(connection === '' ? {} : { connection }) });
      setOpts(o);
      if (connection === '') setConnection(o.connection.id);
      if (o.servers.length === 1 && o.servers[0] !== undefined)
        setServer((s) => (s === '' ? (o.servers[0]?.uuid ?? '') : s));
      const named = o.projects.filter((p) => p.name.toLowerCase() === props.project.toLowerCase());
      const only = named.length === 1 ? named[0] : o.projects.length === 1 ? o.projects[0] : undefined;
      if (only !== undefined) setCproj((c) => (c === '' ? only.uuid : c));
      if (o.repository === null) setSourceType((st) => (st === 'repository' ? 'image' : st));
      else setBranch((b) => (b === '' ? (o.repository?.branch ?? '') : b));
    });
    // Reloads only when the connection or env changes.
  }, [props.project, connection, env, run]);
  useEffect(() => {
    void getCoolifySuggestion(props.project)
      .then((sg) => {
        setSuggestion(sg);
        setBuildPack(sg.buildPack);
        setPorts(sg.ports ?? '');
        setIsStatic(sg.isStatic);
        setPublishDirectory(sg.publishDirectory ?? '');
      })
      .catch(() => {
        setSuggestion(null);
      });
  }, [props.project]);
  // Environments (and destinations) of the chosen Coolify project / server.
  useEffect(() => {
    if (cproj === '' && server === '') return;
    void run(async () => {
      const o = await getCoolifyOptions(props.project, {
        env,
        ...(connection === '' ? {} : { connection }),
        ...(cproj === '' ? {} : { coolifyProject: cproj }),
        ...(server === '' ? {} : { server }),
      });
      setOpts(o);
      const envs = o.environments ?? [];
      const wanted =
        envs.find((e) => e.name.toLowerCase() === env) ?? (envs.length === 1 ? envs[0] : undefined);
      if (wanted !== undefined)
        setEnvironment((e) => (e === '' || !envs.some((x) => x.name === e) ? wanted.name : e));
    });
  }, [props.project, connection, env, cproj, server, run]);

  const ready = server !== '' && cproj !== '' && environment !== '';
  const submit = async () => {
    setResult(null);
    await save.run(async () => {
      const hc = healthPath.trim();
      const body: Record<string, unknown> = {
        env,
        connection,
        server,
        coolifyProject: cproj,
        environment,
        ...(destination === '' ? {} : { destination }),
        ...(name.trim() === '' ? {} : { name: name.trim() }),
        source:
          sourceType === 'repository'
            ? {
                type: 'repository',
                access,
                ...(access === 'github_app' && githubApp !== '' ? { githubApp } : {}),
                ...(access === 'deploy_key' && privateKey !== '' ? { privateKey } : {}),
                ...(branch.trim() === '' ? {} : { branch: branch.trim() }),
              }
            : sourceType === 'image'
              ? { type: 'image', image: image.trim(), ...(tag.trim() === '' ? {} : { tag: tag.trim() }) }
              : { type: 'dockerfile', dockerfile },
        ...(sourceType === 'repository' ? { buildPack } : {}),
        ...(ports.trim() === '' ? {} : { ports: ports.trim() }),
        ...(sourceType === 'repository' && isStatic ? { isStatic: true } : {}),
        ...(sourceType === 'repository' && publishDirectory.trim() !== ''
          ? { publishDirectory: publishDirectory.trim() }
          : {}),
        ...(baseDirectory.trim() === '' ? {} : { baseDirectory: baseDirectory.trim() }),
        ...(sourceType === 'repository' &&
        buildPack === 'dockerfile' &&
        suggestion?.dockerfileLocation != null
          ? { dockerfileLocation: suggestion.dockerfileLocation }
          : {}),
        ...(sourceType === 'repository' &&
        buildPack === 'dockercompose' &&
        suggestion?.composeLocation != null
          ? { composeLocation: suggestion.composeLocation }
          : {}),
        domains: lines(domains),
        ...(hc === '' ? {} : { healthCheck: { enabled: true, path: hc } }),
        envs: rows.filter((r) => r.key.trim() !== '').map(rowChange),
        link,
        deploy,
        ...(allowDuplicate ? { allowDuplicate: true } : {}),
        idempotencyKey: key,
      };
      try {
        const out = await stepUp.run(() => createCoolifyApp(props.project, body), w.stepUp);
        setResult(out);
        if (out.state === 'created') {
          setRows([]);
          props.onCreated();
        }
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };

  if (opts === null) {
    return load.error === null ? (
      <SkeletonRows label={w.loading} rows={3} />
    ) : (
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
    );
  }
  const choose = (list: readonly (readonly [string, string])[]) => [['', w.choose] as const, ...list];
  return (
    <section
      aria-label={w.title}
      className="flex flex-col gap-4 rounded-[12px] border border-dy-line-2 p-4"
      data-testid="coolify-new-app-form"
    >
      <div>
        <h3 className="m-0 text-[1rem] font-bold">{w.title}</h3>
        <p className="m-0 text-[0.8125rem] text-dy-muted">{w.sub}</p>
      </div>
      {!opts.connection.manageApps ? (
        <DyNotice tone="amber">{t.panel.manageOff({ label: opts.connection.label })}</DyNotice>
      ) : null}
      {opts.notes.length > 0 ? (
        <DyNotice tone="neutral" title={w.notes}>
          {opts.notes.join(' · ')}
        </DyNotice>
      ) : null}
      <FormGrid>
        <DySelect
          label={w.env}
          value={env}
          options={(['production', 'preview'] as const).map((e) => [e, t.panel.envName[e]] as const)}
          onChange={(v) => {
            setEnv(v === 'preview' ? 'preview' : 'production');
          }}
        />
        <DySelect
          label={w.connection}
          value={connection}
          options={opts.connections.map((c) => [c.id, c.label] as const)}
          onChange={(v) => {
            setConnection(v);
            setServer('');
            setCproj('');
            setEnvironment('');
          }}
        />
        <DySelect
          label={w.server}
          value={server}
          options={choose(
            opts.servers.map((s) => [s.uuid, s.ip === null ? s.name : `${s.name} (${s.ip})`] as const),
          )}
          onChange={setServer}
        />
        <DySelect
          label={w.coolifyProject}
          value={cproj}
          options={choose(opts.projects.map((p) => [p.uuid, p.name] as const))}
          onChange={(v) => {
            setCproj(v);
            setEnvironment('');
          }}
        />
        <DySelect
          label={w.environment}
          value={environment}
          options={choose((opts.environments ?? []).map((e) => [e.name, e.name] as const))}
          onChange={setEnvironment}
        />
        {opts.destinations !== null && opts.destinations.length > 1 ? (
          <DySelect
            label={w.destination}
            value={destination}
            options={[
              ['', w.destinationDefault] as const,
              ...opts.destinations.map((d) => [d.uuid, d.name] as const),
            ]}
            onChange={setDestination}
          />
        ) : null}
        <DyField label={w.name} hint={w.nameHint} value={name} onChange={setName} />
      </FormGrid>

      <FormGrid>
        <DySelect
          label={w.source}
          value={sourceType}
          options={(opts.repository === null
            ? (['image', 'dockerfile'] as const)
            : (['repository', 'image', 'dockerfile'] as const)
          ).map((s) => [s, w.sources[s]] as const)}
          onChange={(v) => {
            setSourceType(v as SourceType);
          }}
        />
        {sourceType === 'repository' ? (
          <>
            <DySelect
              label={w.access}
              value={access}
              options={(['public', 'github_app', 'deploy_key'] as const).map(
                (a) => [a, w.accesses[a]] as const,
              )}
              onChange={(v) => {
                setAccess(v as Access);
              }}
            />
            {access === 'github_app' ? (
              <DySelect
                label={w.githubApp}
                value={githubApp}
                options={choose(opts.githubApps.map((g) => [g.uuid, g.name] as const))}
                onChange={setGithubApp}
              />
            ) : null}
            {access === 'deploy_key' ? (
              <DySelect
                label={w.privateKey}
                value={privateKey}
                options={choose(opts.privateKeys.map((k) => [k.uuid, k.name] as const))}
                onChange={setPrivateKey}
              />
            ) : null}
            <DyField label={w.branch} mono value={branch} onChange={setBranch} />
          </>
        ) : null}
        {sourceType === 'image' ? (
          <>
            <DyField label={w.image} mono value={image} onChange={setImage} />
            <DyField label={w.tag} mono value={tag} onChange={setTag} />
          </>
        ) : null}
      </FormGrid>
      {sourceType === 'repository' && opts.repository !== null ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{w.repository({ url: opts.repository.url })}</p>
      ) : null}
      {opts.repository === null ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{w.noRepository}</p>
      ) : null}
      {sourceType === 'dockerfile' ? (
        <DyTextarea label={w.dockerfile} mono rows={8} value={dockerfile} onChange={setDockerfile} />
      ) : null}

      <FormGrid>
        {sourceType === 'repository' ? (
          <DySelect
            label={w.buildPack}
            value={buildPack}
            options={BUILD_PACKS.map((b) => [b, w.buildPacks[b]] as const)}
            onChange={(v) => {
              setBuildPack(v as BuildPack);
            }}
          />
        ) : null}
        {buildPack !== 'dockercompose' || sourceType !== 'repository' ? (
          <DyField label={w.ports} hint={w.portsHint} mono value={ports} onChange={setPorts} />
        ) : null}
        {sourceType === 'repository' && buildPack === 'nixpacks' ? (
          <DyCheck label={w.isStatic} checked={isStatic} onChange={setIsStatic} />
        ) : null}
        {sourceType === 'repository' && (isStatic || buildPack === 'static') ? (
          <DyField label={w.publishDirectory} mono value={publishDirectory} onChange={setPublishDirectory} />
        ) : null}
        <DyField label={w.baseDirectory} mono value={baseDirectory} onChange={setBaseDirectory} />
      </FormGrid>
      {sourceType === 'repository' && suggestion !== null ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="coolify-suggestion">
          {suggestion.source === 'repository' && suggestion.basis.length > 0
            ? w.suggestion({ basis: suggestion.basis.join(', ') })
            : w.suggestionNone}
        </p>
      ) : null}

      <FormGrid>
        <DyTextarea
          label={w.domains}
          hint={w.domainsHint}
          mono
          rows={2}
          value={domains}
          onChange={setDomains}
        />
        <DyField label={w.healthPath} hint={w.healthHint} mono value={healthPath} onChange={setHealthPath} />
      </FormGrid>

      <div className="flex flex-col gap-2">
        <h4 className="m-0 text-[0.875rem] font-bold">{w.envs}</h4>
        <EnvRows rows={rows} onChange={setRows} />
      </div>

      <FormGrid>
        <DySelect
          label={w.link}
          value={link}
          options={(['add', 'replace', 'none'] as const).map((l) => [l, w.links[l]] as const)}
          onChange={(v) => {
            setLink(v as 'add' | 'replace' | 'none');
          }}
        />
        <DyCheck label={w.deploy} hint={w.deployHint} checked={deploy} onChange={setDeploy} />
      </FormGrid>

      {!ready ? <p className="m-0 text-[0.8125rem] text-dy-muted">{w.missing}</p> : null}
      <DyApiError error={save.error} retryLeft={save.retryLeft} />
      {save.error?.code === 'coolify_app_exists' || allowDuplicate ? (
        <DyCheck
          label={w.allowDuplicate}
          hint={w.allowDuplicateHint}
          checked={allowDuplicate}
          onChange={setAllowDuplicate}
        />
      ) : null}
      <CreationResult result={result} />
      <FormActions>
        <DyButton
          variant="primary"
          icon="rocket"
          busy={save.busy}
          disabled={!ready || !opts.connection.manageApps}
          data-testid="coolify-create-submit"
          onClick={() => void submit()}
        >
          {save.busy ? w.creating : w.submit}
        </DyButton>
        <DyButton onClick={props.onClose}>{w.cancel}</DyButton>
      </FormActions>
    </section>
  );
}

function CreationResult(props: { readonly result: Creation | null }): ReactNode {
  const t = useT().coolifyApps;
  const w = t.wizard;
  const r = props.result;
  if (r === null) return null;
  if (r.state === 'failed') {
    return (
      <DyNotice tone="red" live testId="coolify-create-result">
        {w.failed({ error: r.error ?? '' })}
      </DyNotice>
    );
  }
  const warnings = r.result?.warnings ?? [];
  return (
    <DyNotice
      tone={warnings.length > 0 ? 'amber' : 'green'}
      live
      testId="coolify-create-result"
      action={
        r.result?.deployActionId == null ? undefined : (
          <Link
            to={`/deploys/${encodeURIComponent(r.result.deployActionId)}`}
            className="text-[0.8125rem] font-bold text-current underline underline-offset-2"
          >
            {w.deployLink}
          </Link>
        )
      }
    >
      {w.created({ name: r.name })} {r.replayed ? w.replayed : ''}{' '}
      {r.result?.linked === true ? w.linked({ env: t.panel.envName[r.env] }) : w.notLinked}{' '}
      {r.result?.deployState == null ? '' : w.deployRequested({ state: r.result.deployState })}
      {warnings.length > 0 ? (
        <span className="mt-1 block">
          {w.warnings}: {warnings.join(' · ')}
        </span>
      ) : null}
    </DyNotice>
  );
}

// ------------------------------------------------------------------------------------------- variables

function EnvEditor(props: {
  readonly project: string;
  readonly uuid: string;
  readonly name: string;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().coolifyApps.env;
  const stepUp = useStepUp();
  const load = useSubmit();
  const save = useSubmit();
  const { run } = load;
  const [app, setApp] = useState<AppDetails | null>(null);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'coolify-env-done' });
  const refresh = useCallback(() => {
    void run(async () => {
      setApp(await getCoolifyApp(props.project, props.uuid));
    });
  }, [run, props.project, props.uuid]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const id = (key: string, preview: boolean) => `${key}|${preview ? 'p' : ''}`;
  const submit = async (deploy: boolean) => {
    setDone(null);
    const changes: EnvChange[] = [
      ...rows.filter((r) => r.key.trim() !== '').map(rowChange),
      ...[...removing].map((k) => {
        const [key = '', p = ''] = k.split('|');
        return { key, remove: true as const, ...(p === 'p' ? { preview: true } : {}) };
      }),
    ];
    if (changes.length === 0) {
      setDone(t.nothing);
      return;
    }
    await save.run(async () => {
      try {
        const out = await stepUp.run(
          () => setCoolifyEnvs(props.project, props.uuid, changes, deploy),
          t.stepUp,
        );
        const parts = [
          t.saved({ created: out.created.length, updated: out.updated.length, removed: out.removed.length }),
          out.failed.length > 0
            ? t.failed({ keys: out.failed.map((f) => `${f.key} (${f.message})`).join(', ') })
            : '',
          out.deployState === null
            ? deploy
              ? ''
              : t.nextDeploy
            : t.deployRequested({ state: out.deployState }),
        ];
        setDone(parts.filter((p) => p !== '').join(' '));
        setRows([]);
        setRemoving(new Set());
        refresh();
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };

  return (
    <section
      aria-label={t.title({ name: props.name })}
      className="flex flex-col gap-3 rounded-[12px] border border-dy-line-2 p-4"
      data-testid="coolify-env-editor"
    >
      <h3 className="m-0 text-[1rem] font-bold">{t.title({ name: props.name })}</h3>
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {app === null && load.error === null ? <SkeletonRows label={t.loading} rows={2} /> : null}
      {app !== null && app.envs.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.empty}</p>
      ) : null}
      {app !== null && app.envs.length > 0 ? (
        <Rows label={t.listLabel}>
          {app.envs.map((e) => {
            const k = id(e.key, e.preview);
            const gone = removing.has(k);
            const flags = [
              e.preview ? t.flags.preview : null,
              e.buildtime === true ? t.flags.buildtime : null,
              e.runtime === true ? t.flags.runtime : null,
            ].filter((x): x is string => x !== null);
            return (
              <Row
                key={k}
                title={<span className="font-dy-mono">{e.key}</span>}
                meta={
                  <>
                    {e.shared === null ? t.hidden : t.sharedRef({ ref: e.shared })}
                    {flags.length === 0 ? '' : ` · ${flags.join(', ')}`}
                    {gone ? ` · ${t.removing}` : ''}
                  </>
                }
                actions={
                  <div className="flex flex-wrap gap-2">
                    <DyButton
                      onClick={() => {
                        setRows((r) => [...r, emptyRow(e.key, e.preview)]);
                      }}
                    >
                      {t.value}
                    </DyButton>
                    <DyButton
                      variant="ghost"
                      data-testid={`coolify-env-remove-${e.key}`}
                      onClick={() => {
                        setRemoving((s) => {
                          const n = new Set(s);
                          if (n.has(k)) n.delete(k);
                          else n.add(k);
                          return n;
                        });
                      }}
                    >
                      {gone ? t.undo : t.remove}
                    </DyButton>
                  </div>
                }
              />
            );
          })}
        </Rows>
      ) : null}
      <EnvRows rows={rows} onChange={setRows} />
      <DyApiError error={save.error} retryLeft={save.retryLeft} />
      <FormActions>
        <DyButton
          variant="primary"
          busy={save.busy}
          data-testid="coolify-env-save"
          onClick={() => void submit(false)}
        >
          {t.save}
        </DyButton>
        <DyButton icon="rocket" disabled={save.busy} onClick={() => void submit(true)}>
          {t.saveDeploy}
        </DyButton>
        <DyButton onClick={props.onClose}>{t.close}</DyButton>
      </FormActions>
    </section>
  );
}

// ------------------------------------------------------------------------------------------- domains

function DomainsEditor(props: {
  readonly project: string;
  readonly uuid: string;
  readonly name: string;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().coolifyApps.domains;
  const stepUp = useStepUp();
  const load = useSubmit();
  const save = useSubmit();
  const { run } = load;
  const [text, setText] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'coolify-domains-done' });
  useEffect(() => {
    void run(async () => {
      const a = await getCoolifyApp(props.project, props.uuid);
      setText(a.domains.join('\n'));
    });
  }, [run, props.project, props.uuid]);

  const submit = async (deploy: boolean) => {
    setDone(null);
    await save.run(async () => {
      try {
        const out = await stepUp.run(
          () => setCoolifyDomains(props.project, props.uuid, lines(text ?? ''), deploy),
          t.stepUp,
        );
        setText(out.domains.join('\n'));
        setDone(
          [
            t.saved,
            out.deployState === null ? t.nextDeploy : t.deployRequested({ state: out.deployState }),
            t.dns,
          ].join(' '),
        );
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };

  return (
    <section
      aria-label={t.title({ name: props.name })}
      className="flex flex-col gap-3 rounded-[12px] border border-dy-line-2 p-4"
      data-testid="coolify-domains-editor"
    >
      <h3 className="m-0 text-[1rem] font-bold">{t.title({ name: props.name })}</h3>
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {text === null ? null : (
        <DyTextarea label={t.label} hint={t.hint} mono rows={3} value={text} onChange={setText} />
      )}
      <DyApiError error={save.error} retryLeft={save.retryLeft} />
      <FormActions>
        <DyButton
          variant="primary"
          busy={save.busy}
          disabled={text === null}
          data-testid="coolify-domains-save"
          onClick={() => void submit(false)}
        >
          {t.save}
        </DyButton>
        <DyButton icon="rocket" disabled={save.busy || text === null} onClick={() => void submit(true)}>
          {t.saveDeploy}
        </DyButton>
        <DyButton onClick={props.onClose}>{t.close}</DyButton>
      </FormActions>
    </section>
  );
}

// ------------------------------------------------------------------------- p15-coolify-dedupe: settings

const opt = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim());

function SettingsEditor(props: {
  readonly project: string;
  readonly uuid: string;
  readonly name: string;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().coolifyApps.settings;
  const w = useT().coolifyApps.wizard;
  const stepUp = useStepUp();
  const load = useSubmit();
  const save = useSubmit();
  const { run } = load;
  const [cur, setCur] = useState<AppSettings | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [isStatic, setIsStatic] = useState(false);
  const [health, setHealth] = useState(false);
  const [buildPack, setBuildPack] = useState<BuildPack | ''>('');
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'coolify-settings-done' });
  useEffect(() => {
    void run(async () => {
      const a: AppDetails = await getCoolifyApp(props.project, props.uuid);
      const st = a.settings;
      setCur(st);
      setBuildPack(st.buildPack ?? '');
      setIsStatic(st.isStatic);
      setHealth(st.healthEnabled);
      setF({
        branch: st.branch ?? '',
        baseDirectory: st.baseDirectory ?? '',
        publishDirectory: st.publishDirectory ?? '',
        dockerfileLocation: st.dockerfileLocation ?? '',
        composeLocation: st.composeLocation ?? '',
        ports: st.ports ?? '',
        installCommand: st.installCommand ?? '',
        buildCommand: st.buildCommand ?? '',
        startCommand: st.startCommand ?? '',
        healthPath: st.healthPath ?? '',
        watchPaths: st.watchPaths.join('\n'),
      });
    });
  }, [run, props.project, props.uuid]);

  /** Only what differs from the current settings is sent. */
  const changes = (): Record<string, unknown> => {
    if (cur === null) return {};
    const out: Record<string, unknown> = {};
    // A path or the ports cannot be cleared (Coolify keeps a value); a command can (empty = none).
    const text = (k: keyof AppSettings) => {
      const v = (f[k] ?? '').trim();
      if (v === (cur[k] ?? '')) return;
      if (v !== '' || k.endsWith('Command')) out[k] = v; // i18n-ignore: a field name suffix
    };
    for (const k of [
      'branch',
      'baseDirectory',
      'publishDirectory',
      'dockerfileLocation',
      'composeLocation',
      'ports',
      'installCommand',
      'buildCommand',
      'startCommand',
    ] as const)
      text(k);
    if (buildPack !== '' && buildPack !== cur.buildPack) out.buildPack = buildPack;
    if (isStatic !== cur.isStatic) out.isStatic = isStatic;
    const wp = (f.watchPaths ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    if (wp.join('\n') !== cur.watchPaths.join('\n')) out.watchPaths = wp;
    const hp = opt(f.healthPath ?? '');
    if (health !== cur.healthEnabled || (hp ?? null) !== cur.healthPath)
      out.healthCheck = { enabled: health, ...(hp === undefined ? {} : { path: hp }) };
    return out;
  };

  const submit = async (deploy: boolean) => {
    setDone(null);
    const body = changes();
    if (Object.keys(body).length === 0) {
      setDone(t.nothing);
      return;
    }
    await save.run(async () => {
      try {
        const out = await stepUp.run(
          () => updateCoolifyApp(props.project, props.uuid, { ...body, deploy }),
          t.stepUp,
        );
        setDone(
          [
            t.saved({ fields: out.changed.join(', ') }),
            out.deployState === null ? t.nextDeploy : t.deployRequested({ state: out.deployState }),
          ].join(' '),
        );
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };

  const field = (k: string, label: string, hint?: string) => (
    <DyField
      label={label}
      {...(hint === undefined ? {} : { hint })}
      mono
      value={f[k] ?? ''}
      autoComplete="off"
      onChange={(v) => {
        setF((x) => ({ ...x, [k]: v }));
      }}
    />
  );

  return (
    <section
      aria-label={t.title({ name: props.name })}
      className="flex flex-col gap-3 rounded-[12px] border border-dy-line-2 p-4"
      data-testid="coolify-settings-editor"
    >
      <h3 className="m-0 text-[1rem] font-bold">{t.title({ name: props.name })}</h3>
      <p className="m-0 text-[0.8125rem] text-dy-muted">{t.sub}</p>
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {cur === null && load.error === null ? <SkeletonRows label={t.loading} rows={2} /> : null}
      {cur === null ? null : (
        <>
          <FormGrid>
            <DySelect
              label={t.buildPack}
              value={buildPack}
              options={BUILD_PACKS.map((b) => [b, w.buildPacks[b]] as const)}
              onChange={(v) => {
                setBuildPack(v as BuildPack);
              }}
            />
            {field('ports', t.ports, t.portsHint)}
            {field('branch', t.branch)}
            {field('baseDirectory', t.baseDirectory)}
            {field('publishDirectory', t.publishDirectory)}
            {field('dockerfileLocation', t.dockerfileLocation)}
            {field('composeLocation', t.composeLocation)}
            <DyCheck label={t.isStatic} checked={isStatic} onChange={setIsStatic} />
          </FormGrid>
          <FormGrid>
            {field('installCommand', t.installCommand, t.commandHint)}
            {field('buildCommand', t.buildCommand)}
            {field('startCommand', t.startCommand)}
          </FormGrid>
          <DyTextarea
            label={t.watchPaths}
            hint={t.watchPathsHint}
            mono
            rows={4}
            value={f.watchPaths ?? ''}
            onChange={(v) => {
              setF((x) => ({ ...x, watchPaths: v }));
            }}
          />
          <FormGrid>
            <DyCheck label={t.healthEnabled} checked={health} onChange={setHealth} />
            {field('healthPath', t.healthPath)}
          </FormGrid>
        </>
      )}
      <DyApiError error={save.error} retryLeft={save.retryLeft} />
      <FormActions>
        <DyButton
          variant="primary"
          busy={save.busy}
          disabled={cur === null}
          data-testid="coolify-settings-save"
          onClick={() => void submit(false)}
        >
          {t.save}
        </DyButton>
        <DyButton icon="rocket" disabled={save.busy || cur === null} onClick={() => void submit(true)}>
          {t.saveDeploy}
        </DyButton>
        <DyButton onClick={props.onClose}>{t.close}</DyButton>
      </FormActions>
    </section>
  );
}

// ------------------------------------------------------------------------- p15-coolify-dedupe: delete

function DeleteApp(props: {
  readonly project: string;
  readonly uuid: string;
  readonly name: string;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}): ReactNode {
  const t = useT().coolifyApps.remove;
  const stepUp = useStepUp();
  const save = useSubmit();
  const [volumes, setVolumes] = useState(false);
  // p17-coolify-full: the application's name is typed before a deletion.
  const [confirm, setConfirm] = useState('');
  const submit = async () => {
    await save.run(async () => {
      try {
        await stepUp.run(
          () =>
            deleteCoolifyApp(props.project, props.uuid, { deleteVolumes: volumes, confirm: confirm.trim() }),
          t.stepUp,
        );
        props.onDeleted();
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };
  // p18-confirm-dialog: the typed-name confirmation is a dialog, not a panel on the page.
  return (
    <DyConfirmDialog
      open
      focusField
      onClose={props.onClose}
      title={t.title({ name: props.name })}
      confirmLabel={t.confirm}
      cancelLabel={t.cancel}
      busy={save.busy}
      confirmDisabled={confirm.trim() !== props.name}
      testId="coolify-delete-confirm"
      confirmTestId="coolify-delete-submit"
      onConfirm={() => void submit()}
    >
      <DyNotice tone="amber">{t.body}</DyNotice>
      <p className="m-0 font-dy-mono text-[0.8125rem] text-dy-muted">{props.uuid}</p>
      <DyCheck label={t.volumes} checked={volumes} onChange={setVolumes} />
      <DyField
        label={t.confirmLabel}
        hint={t.confirmHint({ name: props.name })}
        mono
        autoComplete="off"
        value={confirm}
        onChange={setConfirm}
      />
      <DyApiError error={save.error} retryLeft={save.retryLeft} />
    </DyConfirmDialog>
  );
}
