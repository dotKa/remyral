import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  CODE_HOST_PRESETS,
  getRepoEgress,
  MAX_REPO_EGRESS_HOSTS,
  REGISTRY_PRESETS,
  type RepoEgress,
  type RepoEgressMode,
  type RepoEgressPreset,
  REPO_EGRESS_PRESET_HOSTS,
  draftReach,
  setRepoEgress,
} from '../../../../api/repo-egress';
import { egressHostProblem } from '../../../../api/workflow-egress';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import { useCardForm, useSectionSave } from '../../../formkit';
import { DyCheck, DyDetails, DyField, DyNotice } from '../../forms';
import { DyButton, Panel, Row, Rows } from '../../parts';
import { LoadState, RadioCardGroup, SaveResult } from './policy-common';

/**
 * p14-repo-egress: Projeler → Politika → "Ağ erişimi" of a repository project. Kapalı (default: model APIs only) ·
 * Yalnız izin verilenler (ready-made groups — package registries, GitHub / GitLab — plus custom hosts; recommended with
 * the package registries) · Tüm genel web. The security floor (LAN / private / metadata always refused) is stated, not
 * configurable. The live line says what jobs can reach; machines on an older worker are named (they keep model APIs
 * only). Owners / admins save with a fresh TOTP (audited by the master); everyone else reads. p15-form-pattern: a
 * section of the project's "Ağ erişimi" tab form (mode, groups and hosts are its value; the tab's bar saves them).
 */
export function ProjectNetworkPanel(props: {
  readonly project: string;
  readonly canEdit: boolean;
}): ReactNode {
  const t = useT().repoEgress;
  const fmt = useFormat();
  const sectionSave = useSectionSave();
  const loader = useSubmit();
  const saver = useSubmit();
  const { project, canEdit } = props;
  const [data, setData] = useState<RepoEgress | null>(null);
  const [mode, setMode] = useState<RepoEgressMode>('none');
  const [presets, setPresets] = useState<readonly RepoEgressPreset[]>([]);
  const [hosts, setHosts] = useState<readonly string[]>([]);
  const [entry, setEntry] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;

  const apply = (d: RepoEgress): void => {
    setData(d);
    setMode(d.mode);
    setPresets(d.presets);
    setHosts(d.hosts);
  };
  const refresh = useCallback(() => {
    void run(async () => {
      apply(await getRepoEgress(project));
    });
  }, [run, project]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const edited = (): void => {
    setDone(null);
  };
  const add = (): void => {
    const v = entry.trim();
    const p = hosts.length >= MAX_REPO_EGRESS_HOSTS ? 'tooMany' : egressHostProblem(v, hosts);
    if (p !== null) {
      setProblem(t.problems[p]);
      return;
    }
    setProblem(null);
    setHosts([...hosts, v]);
    setEntry('');
    edited();
  };
  const toggle = (p: RepoEgressPreset, on: boolean): void => {
    setPresets(on ? [...presets, p] : presets.filter((x) => x !== p));
    edited();
  };
  const save = (): Promise<boolean> => {
    setDone(null);
    return sectionSave(
      saver,
      async () => {
        apply(await setRepoEgress(project, { mode, presets, hosts }));
        setDone(t.saved);
      },
      t.stepUp,
    );
  };
  const dirty =
    data !== null &&
    (data.mode !== mode ||
      [...data.presets].sort().join() !== [...presets].sort().join() ||
      data.hosts.join('\n') !== hosts.join('\n'));
  const card = useCardForm({
    dirty: canEdit && data?.kind !== 'workspace' && dirty,
    busy: saver.busy,
    save,
    discard: () => {
      if (data !== null) apply(data);
      setEntry('');
      setProblem(null);
    },
  });

  if (data?.kind === 'workspace')
    return (
      <Panel title={t.title} sub={t.sub} testId="project-network-panel">
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="network-workspace">
          {t.workspaceProject}
        </p>
      </Panel>
    );

  const reach = draftReach(mode, presets, hosts);
  const recommended = mode === 'allowlist' && REGISTRY_PRESETS.every((p) => presets.includes(p));
  const presetBox = (p: RepoEgressPreset): ReactNode => (
    <DyCheck
      key={p}
      label={t.presets[p]}
      hint={
        <span className="font-dy-mono [overflow-wrap:anywhere]">
          {t.presetHosts({ hosts: REPO_EGRESS_PRESET_HOSTS[p].join(', ') })}
        </span>
      }
      checked={presets.includes(p)}
      disabled={!canEdit}
      testId={`network-preset-${p}`}
      onChange={(on) => {
        toggle(p, on);
      }}
    />
  );

  return (
    <Panel title={t.title} sub={t.sub} testId="project-network-panel">
      <div className="flex flex-col gap-3">
        <LoadState loaded={data !== null} error={loader.error} what={t.loading} onRetry={refresh} />
        {data === null ? null : (
          <>
            {canEdit ? null : (
              <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="network-read-only">
                {t.readOnly}
              </p>
            )}
            <RadioCardGroup<RepoEgressMode>
              legend={t.modeLegend}
              value={mode}
              disabled={!canEdit}
              testId="network-mode"
              options={[
                { value: 'none', label: t.modes.none.label, description: t.modes.none.description },
                {
                  value: 'allowlist',
                  label: t.modes.allowlist.label,
                  description: t.modes.allowlist.description,
                  badge: t.recommendedBadge,
                },
                { value: 'web', label: t.modes.web.label, description: t.modes.web.description },
              ]}
              onChange={(v) => {
                setMode(v);
                edited();
              }}
            />
            <p className="m-0 text-[0.875rem] font-medium" data-testid="network-reach" aria-live="polite">
              {reach.mode === 'none'
                ? t.reach.none
                : reach.mode === 'web'
                  ? t.reach.web
                  : t.reach.allowlist({ n: reach.hosts.length })}
            </p>
            {recommended || !canEdit ? null : (
              <DyNotice
                tone="neutral"
                testId="network-recommend"
                action={
                  <DyButton
                    data-testid="network-apply-recommended"
                    onClick={() => {
                      setMode('allowlist');
                      setPresets([...new Set([...presets, ...REGISTRY_PRESETS])]);
                      edited();
                    }}
                  >
                    {t.applyRecommended}
                  </DyButton>
                }
              >
                {t.recommend}
              </DyNotice>
            )}
            {mode === 'none' ? null : (
              <>
                <h4 className="m-0 text-[0.8125rem] font-bold">{t.presetsTitle}</h4>
                <div className="grid gap-x-4 md:grid-cols-2" data-testid="network-presets">
                  <div className="flex min-w-0 flex-col">
                    <p className="m-0 text-[0.78125rem] font-bold text-dy-muted">
                      {t.presetGroups.registries}
                    </p>
                    {REGISTRY_PRESETS.map(presetBox)}
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <p className="m-0 text-[0.78125rem] font-bold text-dy-muted">{t.presetGroups.code}</p>
                    {CODE_HOST_PRESETS.map(presetBox)}
                  </div>
                </div>
                <h4 className="m-0 text-[0.8125rem] font-bold">{t.hostsTitle}</h4>
                {hosts.length === 0 ? (
                  <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="network-hosts-none">
                    {t.hostsNone}
                  </p>
                ) : (
                  <Rows label={t.hostsTitle} testId="network-hosts">
                    {hosts.map((h) => (
                      <Row
                        key={h}
                        title={<span className="font-dy-mono [overflow-wrap:anywhere]">{h}</span>}
                        actions={
                          canEdit ? (
                            <DyButton
                              variant="ghost"
                              icon="trash"
                              aria-label={t.remove({ host: h })}
                              onClick={() => {
                                setHosts(hosts.filter((x) => x !== h));
                                edited();
                              }}
                            />
                          ) : undefined
                        }
                      />
                    ))}
                  </Rows>
                )}
                {canEdit ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <DyField
                      label={t.hostLabel}
                      value={entry}
                      mono
                      placeholder={t.hostPlaceholder}
                      wrapClassName="min-w-0 flex-1"
                      data-testid="network-host-input"
                      error={problem}
                      onChange={(v) => {
                        setEntry(v);
                        setProblem(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          add();
                        }
                      }}
                    />
                    <DyButton icon="plus" data-testid="network-host-add" onClick={add}>
                      {t.add}
                    </DyButton>
                  </div>
                ) : null}
                {mode === 'allowlist' && reach.mode === 'none' ? (
                  <DyNotice tone="amber">{t.emptyAllowlist}</DyNotice>
                ) : null}
                {reach.hosts.length === 0 ? null : (
                  <DyDetails summary={t.effectiveTitle} testId="network-effective">
                    <p className="m-0 font-dy-mono text-[0.78125rem] [overflow-wrap:anywhere]">
                      {reach.hosts.join(', ')}
                    </p>
                  </DyDetails>
                )}
              </>
            )}
            <DyNotice tone="neutral">{t.floor}</DyNotice>
            <p className="m-0 text-[0.78125rem] text-dy-muted">{t.profiles}</p>
            {data.unsupportedWorkers.length === 0 ? null : (
              <DyNotice tone="amber" testId="network-unsupported">
                {t.unsupported({
                  n: data.unsupportedWorkers.length,
                  names: data.unsupportedWorkers.map((w) => w.name).join(', '),
                })}
              </DyNotice>
            )}
            {data.updatedAt === null ? null : (
              <p className="m-0 text-[0.75rem] text-dy-muted">
                {t.updated({ at: fmt.dateTime(data.updatedAt), by: data.updatedBy ?? '—' })}
              </p>
            )}
            {canEdit && !card.inScope ? (
              <div>
                <DyButton
                  variant="primary"
                  busy={saver.busy}
                  disabled={!dirty}
                  data-testid="network-save"
                  onClick={card.submit}
                >
                  {t.save}
                </DyButton>
              </div>
            ) : null}
            <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
          </>
        )}
      </div>
    </Panel>
  );
}
