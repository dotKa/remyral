import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  type DeployTargets,
  getDeployTargets,
  getOpsIntegrations,
  idempotencyKey,
  type OpsAction,
  putDeployTargets,
  requestOpsAction,
} from '../../../../api/deploy';
import {
  type CoolifyConnectionChoice,
  listProjectCoolifyConnections,
} from '../../../../api/coolifyConnections';
import type { Project } from '../../../../api/directory';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyFormScope, sameValue, useCardForm, useSectionSave } from '../../../formkit';
import { DyApiError, DyNotice } from '../../forms';
import { DyButton, Panel, SkeletonRows } from '../../parts';
import { ResultLine } from './deploy-pages';
import { PagesPanel } from './deploy-pages';
import { UptimePanel, VerifyPanel } from './deploy-settings';
import { SitePanel } from './deploy-site';
import { CoolifyAppsPanel } from './deploy-coolify';
import {
  EMPTY_TARGETS,
  fromTargetsForm,
  TargetsPanel,
  type TargetsForm,
  toTargetsForm,
  type Zone,
} from './deploy-targets';
import { AutofixSettingPanel } from '../../deploys/feedback';
import { useT } from '../../../../i18n/I18nProvider';
/**
 * p12-diyalog wave 2 (W3) — Projeler → Deploy, below the recent ops-action rows (ProjectScreen), in the Diyalog
 * language and feature for feature with the classic `ProjectDeploySection` + `SiteUploadCard` + `PagesProjectCard` +
 * `UptimeSettingsSection` + `VerifySettingsSection`: quick deploy / restart for operators (the master decides whether
 * it runs at once or waits), the deploy targets with their policies and preview links (admins, step-up), Upload a site
 * with its publish chain, a new Pages project and a custom domain, uptime auto-monitor and verification & health.
 * Same requests as classic: `GET /projects/:id/deploy-targets`, `GET /integrations/ops` (admins: the zones the
 * Cloudflare token sees), `PUT …/deploy-targets` (step-up), `POST /deploy/actions[/preview]`, site uploads, uptime and
 * verify settings. The recent ops actions are the Diyalog rows above (all of them on /deploys).
 */

/** The Pages projects a deploy or domain may name — the target first, then the further ones (classic). */
function pagesChoices(t: DeployTargets | null): string[] {
  if (t === null) return [];
  const target = t.pages?.projectName ?? null;
  return [...(target === null ? [] : [target]), ...t.pagesProjects.filter((p) => p !== target)];
}

function QuickDeploy(props: { readonly project: string; readonly targets: DeployTargets | null }): ReactNode {
  const run = useSubmit();
  const t = useT().projectTabs.deploySections;
  const [result, setResult] = useState<OpsAction | null>(null);
  const coolify = props.targets?.coolify ?? null;
  const quick = async (kind: 'coolify.deploy' | 'coolify.restart', env: 'preview' | 'production') => {
    setResult(null);
    await run.run(async () => {
      setResult(
        await requestOpsAction({
          project: props.project,
          kind,
          params: { env },
          idempotencyKey: idempotencyKey(kind === 'coolify.deploy' ? 'deploy' : 'restart'),
        }),
      );
    });
  };
  return (
    <Panel
      title={t.quick}
      sub={t.quickSub}
      aside={
        <Link
          to="/deploys"
          className="text-[0.8125rem] font-medium text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
        >
          {t.all}
        </Link>
      }
      testId="dy-quick-deploy"
    >
      <div className="flex flex-col gap-3">
        {coolify === null ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{t.noCoolify}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {coolify.preview !== null ? (
              <DyButton
                variant="primary"
                icon="rocket"
                busy={run.busy}
                onClick={() => void quick('coolify.deploy', 'preview')}
              >
                {t.toPreview}
              </DyButton>
            ) : null}
            {coolify.production !== null ? (
              <DyButton
                variant="warn"
                icon="rocket"
                disabled={run.busy}
                onClick={() => void quick('coolify.deploy', 'production')}
              >
                {t.toProduction}
              </DyButton>
            ) : null}
            <DyButton
              icon="retry"
              disabled={run.busy}
              onClick={() =>
                void quick('coolify.restart', coolify.production !== null ? 'production' : 'preview')
              }
            >
              {t.restart}
            </DyButton>
          </div>
        )}
        <DyApiError error={run.error} retryLeft={run.retryLeft} />
        <ResultLine action={result} />
      </div>
    </Panel>
  );
}

/**
 * p15-form-pattern: the Deploy tab is one form — the deploy targets and the verification settings are saved by its
 * sticky bar; quick deploy, Coolify apps, site upload, Pages and the instant switches (uptime, auto-fix) are actions /
 * resource lists that act at once.
 */
export function DeploySections(props: {
  readonly project: Project;
  readonly canEdit: boolean;
  readonly canRun: boolean;
}): ReactNode {
  return (
    <DyFormScope readOnly={!props.canEdit}>
      <DeploySectionsBody {...props} />
    </DyFormScope>
  );
}

function DeploySectionsBody(props: {
  readonly project: Project;
  readonly canEdit: boolean;
  readonly canRun: boolean;
}): ReactNode {
  const id = props.project.id;
  const all = useT().projectTabs;
  const t = all.deploySections;
  const sectionSave = useSectionSave();
  const [loaded, setLoaded] = useState<{ targets: DeployTargets | null; version: number | null } | null>(
    null,
  );
  const [form, setForm] = useState<TargetsForm>(toTargetsForm(EMPTY_TARGETS));
  const [zones, setZones] = useState<Zone[]>([]);
  const [connections, setConnections] = useState<CoolifyConnectionChoice[]>([]);
  const [saved, setSaved] = useState(false);
  const load = useSubmit();
  const save = useSubmit();

  useEffect(() => {
    void load.run(async () => {
      const t = await getDeployTargets(id);
      setLoaded({ targets: t.targets, version: t.version });
      setForm(toTargetsForm(t.targets ?? EMPTY_TARGETS));
      // p13-multi-coolify: the Coolify connections this project may use (target editor picker).
      setConnections(await listProjectCoolifyConnections(id).catch(() => []));
      const dnsZones = t.targets?.dns.zones ?? [];
      const previewZone = t.targets?.previews?.zone ?? null;
      const known =
        previewZone === null || dnsZones.some((z) => z.id === previewZone.id)
          ? dnsZones
          : [...dnsZones, previewZone];
      // Admins pick zones from what the Cloudflare token can see (last connection test), as classic.
      let visible: Zone[] = [];
      if (props.canEdit) {
        try {
          const s = await getOpsIntegrations();
          const test = s.cloudflare?.lastTest;
          const z = test !== null && test !== undefined && Array.isArray(test.zones) ? test.zones : [];
          visible = z.flatMap((x) => {
            const o = x as Record<string, unknown>;
            return typeof o.id === 'string' && typeof o.name === 'string' ? [{ id: o.id, name: o.name }] : [];
          });
        } catch {
          visible = [];
        }
      }
      setZones([...known, ...visible.filter((v) => !known.some((k) => k.id === v.id))]);
    });
  }, [id]);

  /** A Pages request or a site deploy may have set the target; keep the other unsaved form edits (classic). */
  const reloadAfterPages = () => {
    void (async () => {
      try {
        const t = await getDeployTargets(id);
        setLoaded({ targets: t.targets, version: t.version });
        setForm((f) => ({
          ...f,
          pagesProject: t.targets?.pages?.projectName ?? '',
          pagesProjects: (t.targets?.pagesProjects ?? []).join(', '),
        }));
      } catch {
        // The next load shows it.
      }
    })();
  };

  const submit = (): Promise<boolean> => {
    setSaved(false);
    return sectionSave(
      save,
      async () => {
        const out = await putDeployTargets(id, fromTargetsForm(form, zones), loaded?.version ?? null);
        setLoaded({ targets: out.targets, version: out.version });
        if (out.targets !== null) setForm(toTargetsForm(out.targets));
        setSaved(true);
      },
      t.stepUp,
    );
  };
  const card = useCardForm({
    dirty:
      props.canEdit && loaded !== null && !sameValue(form, toTargetsForm(loaded.targets ?? EMPTY_TARGETS)),
    busy: save.busy,
    save: submit,
    discard: () => {
      if (loaded !== null) setForm(toTargetsForm(loaded.targets ?? EMPTY_TARGETS));
    },
  });

  if (loaded === null) {
    return (
      <div data-testid="project-deploy">
        {load.error === null ? (
          <Panel title={all.targets.title} flush>
            <SkeletonRows label={t.loading} rows={3} />
          </Panel>
        ) : (
          <DyApiError error={load.error} retryLeft={load.retryLeft} />
        )}
      </div>
    );
  }

  const target = loaded.targets?.pages?.projectName ?? null;
  return (
    <div className="flex flex-col gap-5" data-testid="project-deploy">
      {props.canRun ? <QuickDeploy project={id} targets={loaded.targets} /> : null}
      {saved ? (
        <DyNotice tone="green" live>
          {t.saved}
        </DyNotice>
      ) : null}
      <TargetsPanel
        form={form}
        onChange={(f) => {
          setSaved(false);
          setForm(f);
        }}
        zones={zones}
        connections={connections}
        canEdit={props.canEdit}
        canRun={props.canRun}
        busy={save.busy}
        error={save.error}
        retryLeft={save.retryLeft}
        onSubmit={card.submit}
        inForm={card.inScope}
      />
      {/* p15-coolify-create: Coolify applications of this project (admins): create, variables, domains. */}
      <CoolifyAppsPanel
        project={id}
        canEdit={props.canEdit}
        onChanged={() => {
          void (async () => {
            try {
              const t = await getDeployTargets(id);
              setLoaded({ targets: t.targets, version: t.version });
              setForm(toTargetsForm(t.targets ?? EMPTY_TARGETS));
            } catch {
              // The next load shows it.
            }
          })();
        }}
      />
      {props.canRun ? (
        <SitePanel
          project={id}
          pagesProjects={pagesChoices(loaded.targets)}
          target={target}
          onDeployed={reloadAfterPages}
        />
      ) : null}
      {props.canRun ? (
        <PagesPanel
          project={id}
          canEdit={props.canEdit}
          currentTarget={target}
          pagesProjects={pagesChoices(loaded.targets)}
          onChanged={reloadAfterPages}
        />
      ) : null}
      <div className="grid items-start gap-5 xl:grid-cols-2">
        <UptimePanel project={id} canEdit={props.canEdit} />
        <VerifyPanel project={id} canEdit={props.canEdit} />
        <AutofixSettingPanel project={id} canEdit={props.canEdit} />
      </div>
    </div>
  );
}
