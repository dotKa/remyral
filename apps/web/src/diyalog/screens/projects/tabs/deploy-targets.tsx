import type { ReactNode } from 'react';
import type { CoolifyConnectionChoice } from '../../../../api/coolifyConnections';
import type { DecisionRule, DeployTargets } from '../../../../api/deploy';
import { fromPreviewForm, type PreviewForm, toPreviewForm } from '../../../../screens/deploy/previewSettings';
import { DyApiError, DyCheck, DyField, FormActions, FormGrid } from '../../forms';
import { DyButton, DySelect, Panel } from '../../parts';
import type { ApiError } from '../../../../api/client';
import { ruleOptions, ruleText } from './deploy-text';
import { useT } from '../../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Projeler → Deploy → "Deploy hedefleri": Coolify resources per environment, the Pages
 * target and further Pages projects, allowed DNS zones and protected names, the policy for each kind of action,
 * preview links (zone, prefix, agents, Access e-mails, limits, policies) and auto-deploy to production on success.
 * The form state and its conversion are the classic ones (`ProjectDeploySection`'s `toForm` / `fromForm`, the
 * classic preview form helpers); saving is `PUT /projects/:id/deploy-targets` through step-up, by the caller.
 */

export interface TargetsForm {
  /** p13-multi-coolify: the Coolify connection per environment ('' = the default connection). */
  previewConnection: string;
  productionConnection: string;
  previewUuids: string;
  previewTags: string;
  productionUuids: string;
  productionTags: string;
  pagesProject: string;
  pagesProjects: string;
  zoneIds: string[];
  protectedNames: string;
  previewDeploy: DecisionRule;
  productionDeploy: 'approval' | 'approval_step_up';
  dnsChange: DecisionRule;
  autoDeployProductionOnSuccess: boolean;
  pagesPolicy: DecisionRule;
  previews: PreviewForm;
}

export type Zone = { readonly id: string; readonly name: string };

export const EMPTY_TARGETS: DeployTargets = {
  coolify: null,
  pages: null,
  pagesProjects: [],
  dns: { zones: [], protectedNames: [] },
  policy: {
    previewDeploy: 'auto',
    productionDeploy: 'approval_step_up',
    dnsChange: 'approval',
    autoDeployProductionOnSuccess: false,
    pagesProject: 'approval',
    previewTunnel: 'auto',
    stableTunnel: 'approval',
  },
  previews: null,
};

function words(s: string): string[] {
  return s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

export function toTargetsForm(t: DeployTargets): TargetsForm {
  return {
    previewConnection: t.coolify?.preview?.connection ?? '',
    productionConnection: t.coolify?.production?.connection ?? '',
    previewUuids: (t.coolify?.preview?.uuids ?? []).join(', '),
    previewTags: (t.coolify?.preview?.tags ?? []).join(', '),
    productionUuids: (t.coolify?.production?.uuids ?? []).join(', '),
    productionTags: (t.coolify?.production?.tags ?? []).join(', '),
    pagesProject: t.pages?.projectName ?? '',
    pagesProjects: t.pagesProjects.join(', '),
    zoneIds: t.dns.zones.map((z) => z.id),
    protectedNames: t.dns.protectedNames.join(', '),
    previewDeploy: t.policy.previewDeploy,
    productionDeploy: t.policy.productionDeploy,
    dnsChange: t.policy.dnsChange,
    autoDeployProductionOnSuccess: t.policy.autoDeployProductionOnSuccess,
    pagesPolicy: t.policy.pagesProject,
    previews: toPreviewForm(t.previews, t.policy),
  };
}

export function fromTargetsForm(f: TargetsForm, zones: readonly Zone[]): DeployTargets {
  const env = (connection: string, uuids: string, tags: string) => {
    const u = words(uuids);
    const t = words(tags);
    return u.length === 0 && t.length === 0
      ? null
      : { connection: connection === '' ? null : connection, uuids: u, tags: t };
  };
  const preview = env(f.previewConnection, f.previewUuids, f.previewTags);
  const production = env(f.productionConnection, f.productionUuids, f.productionTags);
  return {
    coolify: preview === null && production === null ? null : { preview, production },
    pages: f.pagesProject.trim() === '' ? null : { projectName: f.pagesProject.trim() },
    pagesProjects: words(f.pagesProjects),
    dns: {
      zones: zones.filter((z) => f.zoneIds.includes(z.id)),
      protectedNames: words(f.protectedNames),
    },
    policy: {
      previewDeploy: f.previewDeploy,
      productionDeploy: f.productionDeploy,
      dnsChange: f.dnsChange,
      autoDeployProductionOnSuccess: f.autoDeployProductionOnSuccess,
      pagesProject: f.pagesPolicy,
      previewTunnel: f.previews.previewTunnel,
      stableTunnel: f.previews.stableTunnel,
    },
    previews: fromPreviewForm(f.previews, zones),
  };
}

/**
 * p13-multi-coolify: the Coolify connection of one environment — the project's usable connections (the default
 * preselected); a single one is shown read-only; a stored one the project may not use any more stays visible.
 */
export function ConnectionPicker(props: {
  readonly label: string;
  readonly value: string;
  readonly connections: readonly CoolifyConnectionChoice[];
  readonly disabled: boolean;
  readonly testId: string;
  readonly onChange: (id: string) => void;
}): ReactNode {
  const { connections } = props;
  const t = useT().projectTabs.targets;
  const def = connections.find((c) => c.isDefault) ?? null;
  const shown = props.value === '' ? (def?.id ?? '') : props.value;
  const known = connections.some((c) => c.id === shown);
  const text = (c: CoolifyConnectionChoice) =>
    `${c.label}${c.host === '' ? '' : ` (${c.host})`}${c.isDefault ? t.isDefault : ''}`;
  if (connections.length === 0) {
    return (
      <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid={props.testId}>
        {t.noConnection({ label: props.label })}
      </p>
    );
  }
  const only = connections.length === 1 ? connections[0] : undefined;
  if (only !== undefined && known) {
    return (
      <p className="m-0 text-[0.8125rem]" data-testid={props.testId}>
        <span className="font-bold">{props.label}:</span> {text(only)}
      </p>
    );
  }
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[0.8125rem] font-bold">
      {props.label}
      <select
        data-testid={props.testId}
        value={shown}
        disabled={props.disabled}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        className="min-h-10 rounded-md border border-dy-line bg-dy-surface px-2 font-normal"
      >
        {known ? null : <option value={shown}>{t.notOpen({ id: shown })}</option>}
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {text(c)}
          </option>
        ))}
      </select>
    </label>
  );
}

function SubHead(props: { readonly children: ReactNode; readonly sub?: ReactNode }): ReactNode {
  return (
    <div className="mt-2 border-t border-dy-line pt-4">
      <h3 className="m-0 text-[0.9375rem] font-bold">{props.children}</h3>
      {props.sub === undefined ? null : (
        <p className="m-0 mt-0.5 text-[0.8125rem] text-dy-muted">{props.sub}</p>
      )}
    </div>
  );
}

function PreviewFields(props: {
  readonly value: PreviewForm;
  readonly zones: readonly Zone[];
  readonly disabled: boolean;
  readonly onChange: (v: PreviewForm) => void;
}): ReactNode {
  const f = props.value;
  const all = useT().projectTabs;
  const t = all.targets;
  const options = ruleOptions(all.deployText);
  const set = <K extends keyof PreviewForm>(k: K, v: PreviewForm[K]) => {
    props.onChange({ ...f, [k]: v });
  };
  const zoneName = props.zones.find((z) => z.id === f.zoneId)?.name;
  const prefix = f.prefix.trim().toLowerCase();
  const example =
    zoneName === undefined ? null : `${prefix === '' ? '' : `${prefix}-`}web-k3x9q2m7ta.${zoneName}`;
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
      data-testid="preview-settings"
      disabled={props.disabled}
    >
      <legend className="sr-only">{t.previews}</legend>
      <SubHead sub={t.previewsSub}>{t.previews}</SubHead>
      <FormGrid>
        <DySelect
          label={t.zone}
          value={f.zoneId}
          options={[['', t.zoneOff], ...props.zones.map((z) => [z.id, z.name] as const)]}
          onChange={(v) => {
            set('zoneId', v);
          }}
        />
        <DyField
          label={t.prefix}
          value={f.prefix}
          maxLength={20}
          mono
          disabled={props.disabled}
          hint={example === null ? t.prefixHint : t.prefixExample({ example })}
          onChange={(v) => {
            set('prefix', v);
          }}
        />
      </FormGrid>
      <DyCheck
        label={t.agentsMayOpen}
        hint={t.agentsMayOpenHint}
        checked={f.agentsMayOpen}
        disabled={props.disabled}
        onChange={(v) => {
          set('agentsMayOpen', v);
        }}
      />
      <DyField
        label={t.accessEmails}
        value={f.accessEmails}
        disabled={props.disabled}
        hint={t.accessEmailsHint}
        onChange={(v) => {
          set('accessEmails', v);
        }}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <DyField
          label={t.maxActive}
          type="number"
          min={1}
          max={20}
          value={f.maxActive}
          disabled={props.disabled}
          onChange={(v) => {
            set('maxActive', v);
          }}
        />
        <DyField
          label={t.maxPerJob}
          type="number"
          min={1}
          max={5}
          value={f.maxPerJob}
          disabled={props.disabled}
          onChange={(v) => {
            set('maxPerJob', v);
          }}
        />
        <DySelect
          label={t.previewTunnel}
          value={f.previewTunnel}
          options={options}
          onChange={(v) => {
            set('previewTunnel', v as DecisionRule);
          }}
        />
        <DySelect
          label={t.stableTunnel}
          value={f.stableTunnel}
          options={options}
          onChange={(v) => {
            set('stableTunnel', v as DecisionRule);
          }}
        />
      </div>
      <p className="m-0 text-[0.8125rem] text-dy-muted">{t.stableHint}</p>
    </fieldset>
  );
}

export function TargetsPanel(props: {
  readonly form: TargetsForm;
  readonly onChange: (f: TargetsForm) => void;
  readonly zones: readonly Zone[];
  /** p13-multi-coolify: the Coolify connections this project may use. */
  readonly connections?: readonly CoolifyConnectionChoice[];
  readonly canEdit: boolean;
  readonly canRun: boolean;
  readonly busy: boolean;
  readonly error: ApiError | null;
  readonly retryLeft: number;
  readonly onSubmit: () => void;
  /** p15-form-pattern: inside a tab form the tab's sticky bar saves; the panel shows no save button of its own. */
  readonly inForm?: boolean | undefined;
}): ReactNode {
  const { form, canEdit } = props;
  const all = useT().projectTabs;
  const t = all.targets;
  const options = ruleOptions(all.deployText);
  const set = <K extends keyof TargetsForm>(k: K, v: TargetsForm[K]) => {
    props.onChange({ ...form, [k]: v });
  };
  const text = (
    label: string,
    k:
      | 'previewUuids'
      | 'previewTags'
      | 'productionUuids'
      | 'productionTags'
      | 'pagesProject'
      | 'pagesProjects'
      | 'protectedNames',
    hint?: string,
  ) => (
    <DyField
      label={label}
      value={form[k]}
      mono
      disabled={!canEdit}
      hint={hint}
      onChange={(v) => {
        set(k, v);
      }}
    />
  );
  // Selects have no `disabled` prop in DySelect: the classic form lets everyone change them but only admins save.
  return (
    <Panel title={t.title} sub={t.sub} testId="dy-deploy-targets">
      <form
        aria-label={t.title}
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit();
        }}
      >
        <h3 className="m-0 text-[0.9375rem] font-bold">Coolify</h3>
        {/* i18n-ignore: product name */}
        <div className="grid gap-3 sm:grid-cols-2">
          <ConnectionPicker
            label={t.previewConnection}
            value={form.previewConnection}
            connections={props.connections ?? []}
            disabled={!canEdit}
            testId="dy-coolify-connection-preview"
            onChange={(v) => {
              set('previewConnection', v);
            }}
          />
          <ConnectionPicker
            label={t.productionConnection}
            value={form.productionConnection}
            connections={props.connections ?? []}
            disabled={!canEdit}
            testId="dy-coolify-connection-production"
            onChange={(v) => {
              set('productionConnection', v);
            }}
          />
        </div>
        <FormGrid>
          {text(t.previewUuids, 'previewUuids', t.uuidsHint)}
          {text(t.previewTags, 'previewTags')}
          {text(t.productionUuids, 'productionUuids')}
          {text(t.productionTags, 'productionTags')}
        </FormGrid>
        <SubHead>Cloudflare Pages</SubHead>
        {/* i18n-ignore: product name */}
        {text(t.pagesProject, 'pagesProject', props.canRun ? t.pagesHintRun : t.pagesHint)}
        {text(t.otherPages, 'pagesProjects', t.otherPagesHint)}
        <SubHead>DNS</SubHead>
        {/* i18n-ignore: technical name */}
        <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
          <legend className="mb-1 text-[0.8125rem] font-bold">{t.zones}</legend>
          {props.zones.length === 0 ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.noZones}</p>
          ) : (
            props.zones.map((z) => (
              <DyCheck
                key={z.id}
                label={<span className="font-dy-mono">{z.name}</span>}
                disabled={!canEdit}
                checked={form.zoneIds.includes(z.id)}
                onChange={(on) => {
                  set('zoneIds', on ? [...form.zoneIds, z.id] : form.zoneIds.filter((x) => x !== z.id));
                }}
              />
            ))
          )}
        </fieldset>
        {text(t.protectedNames, 'protectedNames', t.protectedHint)}
        <SubHead sub={t.policySub}>{t.policy}</SubHead>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DySelect
            label={t.previewDeploy}
            value={form.previewDeploy}
            options={options}
            onChange={(v) => {
              set('previewDeploy', v as DecisionRule);
            }}
          />
          <DySelect
            label={t.productionDeploy}
            value={form.productionDeploy}
            options={(['approval', 'approval_step_up'] as const).map(
              (r) => [r, ruleText(all.deployText, r)] as const,
            )}
            onChange={(v) => {
              set('productionDeploy', v as 'approval' | 'approval_step_up');
            }}
          />
          <DySelect
            label={t.dnsChange}
            value={form.dnsChange}
            options={options}
            onChange={(v) => {
              set('dnsChange', v as DecisionRule);
            }}
          />
          <DySelect
            label={t.pagesPolicy}
            value={form.pagesPolicy}
            options={options}
            onChange={(v) => {
              set('pagesPolicy', v as DecisionRule);
            }}
          />
        </div>
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.dnsDeleteHint}</p>
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="dns-auto-help">
          {t.dnsAutoHint}
        </p>
        <PreviewFields
          value={form.previews}
          zones={props.zones}
          disabled={!canEdit}
          onChange={(v) => {
            set('previews', v);
          }}
        />
        <SubHead>{t.onSuccess}</SubHead>
        <DyCheck
          label={t.onSuccessLabel}
          hint={t.onSuccessHint}
          checked={form.autoDeployProductionOnSuccess}
          testId="deploy-auto-production-on-success"
          onChange={(v) => {
            set('autoDeployProductionOnSuccess', v);
          }}
        />
        {canEdit ? (
          <FormActions>
            {props.inForm === true ? null : (
              <DyButton type="submit" variant="primary" busy={props.busy}>
                {t.save}
              </DyButton>
            )}
            <span className="text-[0.8125rem] text-dy-muted">{t.saveHint}</span>
          </FormActions>
        ) : (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.adminsOnly}</p>
        )}
        <DyApiError error={props.error} retryLeft={props.retryLeft} />
      </form>
    </Panel>
  );
}
