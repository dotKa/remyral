import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  type CoolifyConnection,
  createCoolifyConnection,
  listCoolifyConnections,
  removeCoolifyConnection,
  testCoolifyConnection,
  updateCoolifyConnection,
} from '../../../api/coolifyConnections';
import { show } from '../../../screens/deploy/diffText';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { useT } from '../../../i18n/I18nProvider';
import type { Tone } from '../../tone';
import { ConfirmButton, DyApiError, DyCheck, DyField, DyNotice, FormActions } from '../forms';
import { agoText, DyButton, EmptyLine, Panel, Pill, SkeletonRows } from '../parts';
import { CoolifyResources } from './integrations-coolify-resources';

/**
 * p13-multi-coolify (ADR-0050) — Ayarlar → Entegrasyonlar → Coolify as a list of connections: add, change (label,
 * address, team, open address, server SSO, projects), replace the token (write-only), test, make default and remove
 * (confirmation naming the projects that use it; always-fresh authenticator code). The master never returns a token.
 * Also holds the small helpers the Cloudflare panel shares (`integrations-ops.tsx` imports them from here).
 */

type Json = Record<string, unknown>;

export function rec(v: unknown): Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
}

export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}

export function useGuardedOp(): <T>(fn: () => Promise<T>, why: string) => Promise<T | null> {
  const stepUp = useStepUp();
  return useCallback(
    async <T,>(fn: () => Promise<T>, why: string): Promise<T | null> => {
      try {
        return await stepUp.run(fn, why);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return null;
        throw err;
      }
    },
    [stepUp],
  );
}

/** A yes / no / unknown flag as a pill (word + icon, never colour alone). */
export function Flag(props: { readonly label: string; readonly value: unknown }): ReactNode {
  const tx = useT().integrations.coolify;
  const v = props.value;
  const tone: Tone = v === true ? 'green' : v === false ? 'red' : 'neutral';
  const word = v === true ? tx.yes : v === false ? tx.no : tx.unknown;
  return (
    <Pill tone={tone} icon={v === true ? 'checkc' : v === false ? 'xc' : 'flag'}>
      {props.label}: {word}
    </Pill>
  );
}

export function Warnings(props: { readonly test: Json }): ReactNode {
  const warnings = list(props.test.warnings).map(show);
  return (
    <>
      {typeof props.test.error === 'string' ? <DyNotice tone="red">{props.test.error}</DyNotice> : null}
      {warnings.map((w) => (
        <DyNotice key={w} tone="amber">
          {w}
        </DyNotice>
      ))}
    </>
  );
}

export function CoolifyTest(props: { readonly test: Json }): ReactNode {
  const tx = useT().integrations.coolify;
  const t = props.test;
  const p = rec(t.permissions);
  return (
    <div className="flex flex-col gap-2 text-[0.875rem]" data-testid="coolify-test">
      <p className="m-0">
        {t.ok === true ? tx.testOk : tx.testFailed}
        {typeof t.version === 'string' ? tx.version({ version: t.version }) : ''}
        {typeof t.team === 'string' ? tx.team({ team: t.team }) : ''}
        {typeof t.applications === 'number' ? tx.applications({ n: t.applications }) : ''}
        {typeof t.controlPlaneResources === 'number' && t.controlPlaneResources > 0
          ? tx.controlPlaneResources({ n: t.controlPlaneResources })
          : ''}
      </p>
      {t.permissions !== undefined ? (
        <div className="flex flex-wrap gap-1.5">
          <Flag label={tx.read} value={p.read} />
          <Flag label={tx.deploy} value={p.deploy} />
          <Flag label={tx.write} value={p.write} />
          {/* p17-coolify-full: logs of applications, databases and services need read:sensitive. */}
          {p.readSensitive === undefined ? null : <Flag label={tx.readSensitive} value={p.readSensitive} />}
        </div>
      ) : null}
      <Warnings test={t} />
    </div>
  );
}

const splitList = (s: string): string[] =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter((x) => x !== '');

/** Add / change form. `current` null: a new connection (token required). */
function ConnectionForm(props: {
  readonly current: CoolifyConnection | null;
  readonly onSaved: (c: CoolifyConnection) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const tx = useT().integrations.coolify;
  const c = props.current;
  const [label, setLabel] = useState(c?.label ?? '');
  const [url, setUrl] = useState(c?.url ?? '');
  const [team, setTeam] = useState(c?.team ?? '');
  const [openUrl, setOpenUrl] = useState(c?.openUrl ?? '');
  const [sso, setSso] = useState(c?.useServerSso ?? false);
  const [all, setAll] = useState(c?.allProjects ?? false);
  // p15-coolify-create: Remyral may create applications / change variables and domains on this connection.
  const [manage, setManage] = useState(c?.manageApps ?? false);
  const ct = useT().coolifyApps.connection;
  const [projects, setProjects] = useState((c?.projects ?? []).join(', '));
  const [deny, setDeny] = useState((c?.denyResources ?? []).join(', '));
  const [token, setToken] = useState('');
  const act = useSubmit();
  const guarded = useGuardedOp();
  const save = async (): Promise<void> => {
    await act.run(async () => {
      const body = {
        label: label.trim(),
        url: url.trim(),
        team: team.trim() === '' ? null : team.trim(),
        openUrl: openUrl.trim() === '' ? null : openUrl.trim(),
        useServerSso: sso,
        allProjects: all,
        manageApps: manage,
        projects: all ? [] : splitList(projects),
        denyResources: splitList(deny),
      };
      const tok = token.trim();
      const out = await guarded(
        () =>
          c === null
            ? createCoolifyConnection({ ...body, token: tok })
            : updateCoolifyConnection(c.id, { ...body, ...(tok === '' ? {} : { token: tok }) }),
        c === null ? tx.stepUpAdd : tx.stepUpChange,
      );
      if (out === null) return;
      setToken('');
      props.onSaved(out);
    });
  };
  return (
    <form
      aria-label={c === null ? tx.newConnection : tx.editConnection({ label: c.label })}
      className="flex flex-col gap-3"
      data-testid={c === null ? 'coolify-conn-new' : 'coolify-conn-edit'}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <DyField label={tx.name} value={label} placeholder={tx.namePlaceholder} onChange={setLabel} />
      <DyField
        label={tx.url}
        value={url}
        mono
        placeholder="https://coolify.example.com" // i18n-ignore: product name or example value
        hint={tx.urlHint}
        onChange={setUrl}
      />
      <DyField label={tx.teamLabel} value={team} hint={tx.teamHint} onChange={setTeam} />
      <DyField label={tx.openUrl} value={openUrl} mono hint={tx.openUrlHint} onChange={setOpenUrl} />
      <DyCheck label={tx.sso} checked={sso} hint={tx.ssoHint} onChange={setSso} />
      <DyCheck label={tx.allProjects} checked={all} onChange={setAll} />
      {all ? null : (
        <DyField
          label={tx.projectsLabel}
          value={projects}
          mono
          hint={tx.projectsHint}
          onChange={setProjects}
        />
      )}
      <DyField label={tx.deny} value={deny} mono hint={tx.denyHint} onChange={setDeny} />
      <DyCheck
        label={ct.manageApps}
        checked={manage}
        hint={ct.manageAppsHint}
        testId="coolify-conn-manage-apps"
        onChange={setManage}
      />
      <DyField
        label={c === null ? tx.token : tx.newToken}
        type="password"
        autoComplete="off"
        value={token}
        hint={c === null ? tx.tokenHint : tx.keepTokenHint}
        onChange={setToken}
      />
      <FormActions>
        <DyButton type="submit" variant="primary" busy={act.busy}>
          {c === null ? tx.add : tx.save}
        </DyButton>
        <DyButton variant="ghost" disabled={act.busy} onClick={props.onCancel}>
          {tx.cancel}
        </DyButton>
      </FormActions>
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </form>
  );
}

function ConnectionCard(props: {
  readonly c: CoolifyConnection;
  readonly onChanged: () => Promise<void>;
}): ReactNode {
  const tx = useT().integrations.coolify;
  const { c } = props;
  const [editing, setEditing] = useState(false);
  // p17-coolify-full: the whole Coolify of this connection (applications, databases, services, servers, projects).
  const [resources, setResources] = useState(false);
  const rt = useT().coolifyApps.resources;
  const [test, setTest] = useState<Json | null>(c.lastTest);
  const act = useSubmit();
  const guarded = useGuardedOp();
  const used = c.usedBy.map((u) => `${u.project} (${u.envs.join(', ')})`);
  const runTest = async (): Promise<void> => {
    await act.run(async () => {
      setTest(await testCoolifyConnection(c.id));
    });
  };
  const makeDefault = async (): Promise<void> => {
    await act.run(async () => {
      const out = await guarded(
        () => updateCoolifyConnection(c.id, { isDefault: true }),
        tx.stepUpDefault({ label: c.label }),
      );
      if (out !== null) await props.onChanged();
    });
  };
  const remove = async (): Promise<void> => {
    await act.run(async () => {
      const out = await guarded(
        async () => {
          await removeCoolifyConnection(c.id);
          return true;
        },
        tx.stepUpRemove({ label: c.label }),
      );
      if (out !== null) await props.onChanged();
    });
  };
  return (
    <li
      className="flex flex-col gap-2 rounded-[10px] border border-dy-line p-3"
      data-testid={`coolify-conn-${c.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">{c.label}</span>
        <span className="font-dy-mono text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">{c.host}</span>
        {c.isDefault ? (
          <Pill tone="teal" icon="checkc">
            {tx.default}
          </Pill>
        ) : null}
        {c.controlPlane ? (
          <Pill tone="amber" icon="flag" title={tx.controlPlaneTitle}>
            {tx.controlPlane}
          </Pill>
        ) : null}
        {c.usable ? (
          <Pill tone="green" icon="checkc">
            {tx.connected}
          </Pill>
        ) : (
          <Pill tone="red" icon="xc">
            {tx.tokenUnusable}
          </Pill>
        )}
      </div>
      <dl className="m-0 grid gap-1 text-[0.8125rem]">
        <div>
          <dt className="inline text-dy-muted">{tx.projects} </dt>
          <dd className="inline m-0">
            {c.allProjects ? tx.allProjectsLower : c.projects.join(', ') || tx.none}
          </dd>
        </div>
        <div data-testid="coolify-conn-used">
          <dt className="inline text-dy-muted">{tx.usedBy} </dt>
          <dd className="inline m-0">{used.length === 0 ? tx.noneUsed : used.join(', ')}</dd>
        </div>
        <div>
          <dt className="inline text-dy-muted">{tx.fingerprint} </dt>
          <dd className="inline m-0 font-dy-mono">{c.keyFingerprint}</dd>
          {c.lastTestAt === null ? null : (
            <span className="text-dy-muted"> · {tx.lastTest({ ago: agoText(c.lastTestAt) })}</span>
          )}
        </div>
      </dl>
      {editing ? (
        <ConnectionForm
          current={c}
          onCancel={() => {
            setEditing(false);
          }}
          onSaved={() => {
            setEditing(false);
            void props.onChanged();
          }}
        />
      ) : (
        <FormActions>
          <DyButton icon="retry" disabled={act.busy} onClick={() => void runTest()}>
            {tx.test}
          </DyButton>
          <DyButton
            disabled={act.busy}
            onClick={() => {
              setEditing(true);
            }}
          >
            {tx.edit}
          </DyButton>
          {c.usable ? (
            <DyButton
              icon="db"
              aria-label={rt.openLabel({ label: c.label })}
              aria-expanded={resources}
              data-testid={`coolify-resources-${c.id}`}
              onClick={() => {
                setResources((v) => !v);
              }}
            >
              {rt.open}
            </DyButton>
          ) : null}
          {c.isDefault ? null : (
            <DyButton disabled={act.busy} onClick={() => void makeDefault()}>
              {tx.makeDefault}
            </DyButton>
          )}
          <ConfirmButton
            label={tx.remove}
            ariaLabel={tx.removeLabel({ label: c.label })}
            question={
              used.length === 0
                ? tx.removeQuestion({ label: c.label })
                : tx.removeQuestionUsed({ label: c.label, used: used.join(', ') })
            }
            disabled={act.busy}
            onConfirm={() => void remove()}
          />
        </FormActions>
      )}
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
      {test !== null ? (
        <div className="rounded-[10px] border border-dy-line bg-dy-sunk/50 p-3">
          <CoolifyTest test={test} />
        </div>
      ) : null}
      {resources ? (
        <CoolifyResources
          connection={c}
          onClose={() => {
            setResources(false);
          }}
        />
      ) : null}
    </li>
  );
}

/** Ayarlar → Entegrasyonlar → Coolify bağlantıları. `onChanged` lets the page summary reload. */
export function CoolifyConnectionsPanel(props: { readonly onChanged?: () => void }): ReactNode {
  const tx = useT().integrations.coolify;
  const [items, setItems] = useState<CoolifyConnection[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useSubmit();
  const { onChanged } = props;
  const reload = useCallback(async (): Promise<void> => {
    setItems(await listCoolifyConnections());
    onChanged?.();
  }, [onChanged]);
  useEffect(() => {
    void load.run(async () => {
      setItems(await listCoolifyConnections());
    });
  }, []);
  return (
    <Panel
      title="Coolify" // i18n-ignore product name
      count={items === null ? undefined : String(items.length)}
      countLabel={tx.countLabel}
      testId="dy-ops-coolify"
      aside={
        adding ? null : (
          <DyButton
            icon="plus"
            onClick={() => {
              setAdding(true);
            }}
          >
            {tx.addCoolify}
          </DyButton>
        )
      }
      sub={tx.panelSub}
    >
      <div className="flex flex-col gap-3">
        {adding ? (
          <ConnectionForm
            current={null}
            onCancel={() => {
              setAdding(false);
            }}
            onSaved={() => {
              setAdding(false);
              void reload();
            }}
          />
        ) : null}
        {items === null ? (
          load.error === null ? (
            <SkeletonRows label={tx.loading} rows={2} />
          ) : (
            <DyApiError error={load.error} retryLeft={load.retryLeft} />
          )
        ) : items.length === 0 ? (
          <EmptyLine>{tx.empty}</EmptyLine>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {items.map((c) => (
              <ConnectionCard key={`${c.id}-${c.updatedAt}`} c={c} onChanged={reload} />
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
