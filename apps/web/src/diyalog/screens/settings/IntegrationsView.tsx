import { type ReactNode, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import { getOpsIntegrations, type OpsIntegration, type OpsIntegrationsStatus } from '../../../api/deploy';
import { appConnections, getGitHubStatus, type GitHubStatus } from '../../../api/github';
import type { Navigate } from '../../../screens/integrationsPaths';
import { toApiError } from '../../../components/ui';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';
import { DyFormScope, DyTabs } from '../../formkit';
import { DyIcon, type IconName } from '../../icons';
import type { Tone } from '../../tone';
import { agoText, EmptyLine, ErrorLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { DefaultGitIdentityPanel } from '../shared/GitIdentity';
import { BedrockPanel } from './integrations-bedrock';
import { StoragePanel } from './integrations-storage';
import { GitHostsPanel } from './integrations-git-hosts';
import { GitHubPanel } from './integrations-github';
import { OpsIntegrationsPanels } from './integrations-ops';

/**
 * p12-diyalog Faz 4 — Ayarlar → Entegrasyonlar. First a Diyalog summary from the same reads the classic cards make
 * (`GET /integrations/github`, `GET /integrations/ops`): one row per connection with its state in a word and an icon,
 * then the Cloudflare DNS probe — the stored last "Test connection" result, one row per allowed zone (readable ✓ or
 * the missing Zone → DNS → Edit permission, with the projects that need it). Connecting, saving tokens, testing and
 * removing are the native panels below (p12-diyalog wave 2: GitHub connect flows, default git identity, Coolify /
 * Cloudflare tokens with "Bağlantıyı test et", AWS Bedrock) — write-only token fields, step-up on every change.
 */

type Json = Record<string, unknown>;
type OverviewText = Messages['integrations']['overview'];

function rec(v: unknown): Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
}
function list(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}
function text(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '—';
}

interface Conn {
  readonly key: string;
  readonly name: string;
  readonly tone: Tone;
  readonly icon: IconName;
  readonly state: string;
  readonly detail: string;
}

function ops(t: OverviewText, name: string, key: string, i: OpsIntegration | null): Conn {
  if (i === null)
    return { key, name, tone: 'neutral', icon: 'clock', state: t.notConnected, detail: t.noToken };
  if (!i.usable)
    return {
      key,
      name,
      tone: 'red',
      icon: 'xc',
      state: t.tokenUnusable,
      detail: t.reenterToken,
    };
  const tested = i.lastTest === null ? t.notTested : t.lastTest({ ago: agoText(i.lastTestAt) });
  const failed = i.lastTest !== null && i.lastTest.ok === false;
  return {
    key,
    name,
    tone: failed ? 'amber' : 'green',
    icon: failed ? 'shield' : 'checkc',
    state: failed ? t.testFailed : t.connected,
    detail: t.fingerprint({ fingerprint: i.keyFingerprint, tested }),
  };
}

function github(t: OverviewText, s: GitHubStatus): Conn {
  // p17-github-apps-ui: every App counts (panel and environment Apps), not only the first one.
  const apps = appConnections(s);
  if (apps.length === 0)
    return {
      key: 'github',
      name: 'GitHub', // i18n-ignore: product name or example value
      tone: 'neutral',
      icon: 'clock',
      state: t.notConnected,
      detail: s.available ? t.githubNoApp : t.githubUnavailable,
    };
  const n = apps.reduce((sum, c) => sum + c.installations.length, 0);
  const projects = apps.reduce((sum, c) => sum + c.projects.length, 0);
  return {
    key: 'github',
    name: 'GitHub', // i18n-ignore: product name or example value
    tone: n > 0 ? 'green' : 'amber',
    icon: n > 0 ? 'checkc' : 'shield',
    state: n > 0 ? t.connected : t.awaitingInstall,
    detail: t.githubDetail({ installations: n, projects }),
  };
}

/** The stored Cloudflare test's DNS probe: one row per zone some project allows. */
function DnsProbe(props: { readonly cf: OpsIntegration | null }): ReactNode {
  const t = useT().integrations.overview;
  const test = props.cf?.lastTest ?? null;
  const zones = list(test?.dns).map(rec);
  const hint = typeof test?.dnsHint === 'string' ? test.dnsHint : null;
  return (
    <Panel
      title={t.dnsTitle}
      count={zones.length === 0 ? undefined : String(zones.length)}
      countLabel={t.zones({ n: zones.length })}
      sub={test === null ? undefined : t.dnsSub({ ago: agoText(props.cf?.lastTestAt ?? null) })}
      flush
      testId="dy-dns-probe"
    >
      {props.cf === null ? (
        <EmptyLine>{t.dnsNoCloudflare}</EmptyLine>
      ) : test === null ? (
        <EmptyLine>{t.dnsNoTest}</EmptyLine>
      ) : zones.length === 0 ? (
        <EmptyLine>{t.dnsNoZones}</EmptyLine>
      ) : (
        <Rows label={t.dnsZones}>
          {zones.map((z) => {
            const ok = z.ok === true;
            const projects = list(z.projects).map(text);
            return (
              <Row
                key={text(z.zoneId ?? z.zone)}
                testId="dy-dns-zone"
                lead={<DyIcon name={ok ? 'checkc' : 'xc'} className="size-4" />}
                tone={ok ? 'green' : 'red'}
                title={
                  <span translate="no" className="font-dy-mono text-[0.9375rem]">
                    {text(z.zone)}
                  </span>
                }
                meta={
                  <>
                    <span>
                      {ok
                        ? t.dnsReadable
                        : t.dnsMissing({ error: typeof z.error === 'string' ? `: ${z.error}` : '' })}
                    </span>
                    {projects.length > 0 ? (
                      <span>{t.dnsProjects({ projects: projects.join(', ') })}</span>
                    ) : null}
                  </>
                }
                trail={
                  <Pill tone={ok ? 'green' : 'red'} icon={ok ? 'checkc' : 'xc'}>
                    {ok ? t.readable : t.missingPermission}
                  </Pill>
                }
              />
            );
          })}
        </Rows>
      )}
      {hint !== null ? (
        <p className="m-0 border-t border-dy-line px-4 py-3 text-[0.8125rem] text-dy-muted">{hint}</p>
      ) : null}
    </Panel>
  );
}

export function IntegrationsView(props: { readonly navigate?: Navigate | undefined } = {}): ReactNode {
  const t = useT().integrations.overview;
  const [gh, setGh] = useState<GitHubStatus | null>(null);
  const [opsStatus, setOps] = useState<OpsIntegrationsStatus | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.allSettled([getGitHubStatus(), getOpsIntegrations()]).then(([g, o]) => {
      if (!live) return;
      if (g.status === 'fulfilled') setGh(g.value);
      if (o.status === 'fulfilled') setOps(o.value);
      const failed = [g, o].find((r) => r.status === 'rejected');
      setError(failed?.status === 'rejected' ? toApiError(failed.reason) : null);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const conns: Conn[] = [
    ...(gh === null ? [] : [github(t, gh)]),
    ...(opsStatus === null
      ? []
      : [
          ops(t, 'Coolify', 'coolify', opsStatus.coolify), // i18n-ignore: product name or example value
          ops(t, 'Cloudflare', 'cloudflare', opsStatus.cloudflare), // i18n-ignore: product name or example value
        ]),
  ];

  const tt = useT().forms.tabs.integrations;
  // p15-form-pattern: the connections overview and each provider in its own tab (each provider's forms save on
  // their own; token fields are write-only and ask a fresh code).
  return (
    <div className="flex flex-col gap-4" data-testid="dy-integrations">
      <ErrorLine error={error} what={t.statusWhat} />
      <DyTabs
        label={tt.label}
        items={[
          { id: 'overview', label: tt.overview },
          { id: 'github', label: tt.github },
          { id: 'ops', label: tt.ops },
          { id: 'bedrock', label: tt.bedrock },
          // p17-object-storage: where job outputs and other files are kept.
          { id: 'storage', label: tt.storage },
          // p16-git-providers.
          { id: 'git-hosts', label: tt.gitHosts },
        ]}
      >
        {(tab) =>
          tab === 'git-hosts' ? (
            <GitHostsPanel />
          ) : tab === 'github' ? (
            <DyFormScope label={tt.github}>
              <GitHubPanel navigate={props.navigate} onStatus={setGh} />
              <DefaultGitIdentityPanel />
            </DyFormScope>
          ) : tab === 'ops' ? (
            <div className="flex flex-col gap-4">
              <p className="m-0 text-[0.875rem] text-dy-muted">{t.editSub}</p>
              <OpsIntegrationsPanels onStatus={setOps} />
            </div>
          ) : tab === 'storage' ? (
            <div className="flex flex-col gap-4">
              <p className="m-0 text-[0.875rem] text-dy-muted">{t.editSub}</p>
              <StoragePanel />
            </div>
          ) : tab === 'bedrock' ? (
            <div className="flex flex-col gap-4">
              <p className="m-0 text-[0.875rem] text-dy-muted">{t.editSub}</p>
              <BedrockPanel />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <Panel title={t.connections} flush testId="dy-connections">
                {!loaded ? (
                  <SkeletonRows label={t.loading} rows={3} />
                ) : conns.length === 0 ? (
                  <EmptyLine>{t.statusFailed}</EmptyLine>
                ) : (
                  <Rows label={t.connections}>
                    {conns.map((c) => (
                      <Row
                        key={c.key}
                        testId="dy-connection"
                        lead={<DyIcon name={c.icon} className="size-4" />}
                        tone={c.tone}
                        title={c.name}
                        meta={<span className="[overflow-wrap:anywhere]">{c.detail}</span>}
                        trail={
                          <Pill tone={c.tone} icon={c.icon}>
                            {c.state}
                          </Pill>
                        }
                      />
                    ))}
                  </Rows>
                )}
                {/* p17-ui-polish: the editing note is the connections card's footnote (it stood under the cards with
                    no container). */}
                <p
                  className="m-0 flex items-start gap-2 border-t border-dy-line px-4 py-2.5 text-[0.8125rem] text-dy-muted"
                  data-testid="dy-connections-note"
                >
                  <DyIcon name="info" className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    <span className="font-bold text-dy-ink">{t.editTitle}</span> · {t.editSub}
                  </span>
                </p>
              </Panel>
              {opsStatus === null ? null : <DnsProbe cf={opsStatus.cloudflare} />}
            </div>
          )
        }
      </DyTabs>
    </div>
  );
}
