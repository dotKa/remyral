import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  getOpsIntegrations,
  type OpsIntegrationsStatus,
  removeOpsIntegration,
  saveCloudflare,
  testOpsIntegration,
} from '../../../api/deploy';
import { show } from '../../../screens/deploy/diffText';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { DyIcon } from '../../icons';
import { ConfirmButton, DyApiError, DyCopyButton, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, Panel, Pill, SkeletonRows } from '../parts';
import { CoolifyConnectionsPanel, Flag, list, rec, useGuardedOp, Warnings } from './integrations-coolify';
import { useDoneToast } from '../../toast/useDoneToast';

export { useGuardedOp };

/**
 * p12-diyalog wave 2 (W3) — Ayarlar → Entegrasyonlar → Coolify and Cloudflare in the Diyalog language, feature for
 * feature with the classic `OpsIntegrationsCards` (p6-deploy-integrations, ADR-0028): write-only token fields ("leave
 * empty to keep"), save / remove with an always-fresh authenticator code, "Bağlantıyı test et" with what the stored
 * token can do (Coolify permissions; Cloudflare zones, Pages, the DNS probe per allowed zone and the preview-tunnel
 * permissions with copyable missing scope names), and the server's always-protected resources and hosts. The master
 * never returns a token; nothing here shows one.
 */

type Json = Record<string, unknown>;

function DnsProbe(props: { readonly test: Json }): ReactNode {
  const t = useT().integrations.cloudflare;
  const dns = list(props.test.dns).map(rec);
  if (dns.length === 0 && typeof props.test.dnsHint !== 'string') return null;
  const missing = dns.some((z) => z.ok !== true);
  return (
    <div className="flex flex-col gap-1" data-testid="cloudflare-dns-probe">
      <p className="m-0 text-dy-muted">{t.dnsTitle}</p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {dns.map((z) => {
          const ok = z.ok === true;
          return (
            <li key={show(z.zoneId ?? z.zone)} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <DyIcon
                name={ok ? 'checkc' : 'xc'}
                className={`size-4 ${ok ? 'text-dy-green' : 'text-dy-red-ink'}`}
              />
              <span className="font-dy-mono">{show(z.zone)}</span>
              <span className={ok ? 'text-dy-muted' : 'text-dy-red-ink'}>
                {ok
                  ? t.dnsReadable
                  : t.dnsMissing({ error: typeof z.error === 'string' ? `: ${z.error}` : '' })}
              </span>
              {list(z.projects).length > 0 ? (
                <span className="text-dy-muted">
                  {t.dnsProjects({ projects: list(z.projects).map(show).join(', ') })}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {missing || typeof props.test.dnsHint === 'string' ? (
        <p className="m-0 text-[0.78125rem] text-dy-muted" data-testid="cloudflare-dns-hint">
          {typeof props.test.dnsHint === 'string' ? props.test.dnsHint : t.dnsHint}
        </p>
      ) : null}
    </div>
  );
}

const SERVICE_TOKENS = 'Account → Access: Service Tokens → Edit'; // i18n-ignore Cloudflare's scope name

/** p8-preview-tunnels: the preview-tunnel permissions of the stored token (classic `PreviewTunnelHealth`). */
function PreviewTunnels(props: { readonly test: Json }): ReactNode {
  const t = useT().integrations.cloudflare;
  const p = props.test.previews;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return null;
  const v = p as Json;
  const missing = Array.isArray(v.missing) ? v.missing.filter((m): m is string => typeof m === 'string') : [];
  const ok = missing.length === 0 && v.tunnels === true && v.accessApps === true;
  return (
    <div className="flex flex-col gap-2" data-testid="preview-tunnel-health">
      <p className="m-0">
        <span className="text-dy-muted">{t.previews} </span>
        {ok ? t.previewsReady : t.previewsNeedMore}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Flag label={t.tunnels} value={v.tunnels === true} />
        <Flag label={t.accessApps} value={v.accessApps === true} />
        <Flag label={t.serviceTokens} value={v.serviceTokens === true} />
      </div>
      {missing.length > 0 ? (
        <DyNotice tone="amber" title={t.addScopes}>
          <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {missing.map((m) => (
              <li key={m} className="flex flex-wrap items-center gap-2">
                <code
                  className="rounded bg-dy-card px-1.5 py-0.5 font-dy-mono text-[0.78125rem] text-dy-ink"
                  data-testid="preview-missing-scope"
                >
                  {m}
                </code>
                <DyCopyButton text={m} variant="ghost" about={t.copyScope({ scope: m })} />
              </li>
            ))}
          </ul>
          {missing.includes(SERVICE_TOKENS) ? (
            <p className="m-0 mt-1 text-[0.78125rem]">{t.serviceTokensNote}</p>
          ) : null}
        </DyNotice>
      ) : null}
    </div>
  );
}

function CloudflareTest(props: { readonly test: Json }): ReactNode {
  const tx = useT().integrations.cloudflare;
  const t = props.test;
  const pages = rec(t.pages);
  const zones = list(t.zones).map(rec);
  return (
    <div className="flex flex-col gap-2 text-[0.875rem]" data-testid="cloudflare-test">
      <p className="m-0">
        {t.ok === true ? tx.tokenActive : tx.testFailed}
        {typeof t.tokenStatus === 'string' ? tx.tokenStatus({ status: t.tokenStatus }) : ''}
      </p>
      <p className="m-0">
        <span className="text-dy-muted">{tx.zones} </span>
        <span className="font-dy-mono">
          {zones.length === 0 ? tx.none : zones.map((z) => show(z.name)).join(', ')}
        </span>
      </p>
      <p className="m-0">
        <span className="text-dy-muted">{tx.pages} </span>
        {pages.access === true ? (
          <>
            {tx.pagesAccess} ·{' '}
            <span className="font-dy-mono">{list(pages.projects).map(show).join(', ') || tx.noProjects}</span>
          </>
        ) : (
          tx.noAccess
        )}
      </p>
      <DnsProbe test={t} />
      <PreviewTunnels test={t} />
      <Warnings test={t} />
    </div>
  );
}

/** Cloudflare (Coolify is a list of connections: `CoolifyConnectionsPanel`, p13-multi-coolify). */
function ProviderPanel(props: {
  readonly provider: 'cloudflare';
  readonly status: OpsIntegrationsStatus;
  readonly onChanged: (s: OpsIntegrationsStatus) => void;
  /** A fresh "Bağlantıyı test et" result (the master stores it as the last test), so the page summary follows. */
  readonly onTested?: (test: Json) => void;
}): ReactNode {
  const t = useT().integrations.cloudflare;
  const current = props.status[props.provider];
  const settings = current?.settings ?? {};
  const [accountId, setAccountId] = useState(
    typeof settings.accountId === 'string' ? settings.accountId : '',
  );
  const [token, setToken] = useState('');
  const [test, setTest] = useState<Json | null>(current?.lastTest ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice);
  const act = useSubmit();
  const guarded = useGuardedOp();
  const title = 'Cloudflare'; // i18n-ignore product name

  const reload = async (): Promise<void> => {
    props.onChanged(await getOpsIntegrations());
  };

  const save = async (): Promise<void> => {
    setNotice(null);
    await act.run(async () => {
      const tok = token.trim() === '' ? {} : { token: token.trim() };
      const out = await guarded(() => saveCloudflare({ accountId: accountId.trim(), ...tok }), t.stepUpSave);
      if (out === null) return;
      setToken('');
      setTest(null);
      setNotice(t.saved);
      await reload();
    });
  };

  const runTest = async (): Promise<void> => {
    setNotice(null);
    await act.run(async () => {
      const res = await testOpsIntegration(props.provider);
      setTest(res);
      props.onTested?.(res);
    });
  };

  const remove = async (): Promise<void> => {
    setNotice(null);
    await act.run(async () => {
      const out = await guarded(async () => {
        await removeOpsIntegration(props.provider);
        return true;
      }, t.stepUpRemove);
      if (out === null) return;
      setTest(null);
      await reload();
    });
  };

  return (
    <Panel
      title={title}
      testId={`dy-ops-${props.provider}`}
      aside={
        current === null ? (
          <Pill tone="neutral" icon="clock">
            {t.notConnected}
          </Pill>
        ) : current.usable ? (
          <Pill tone="green" icon="checkc">
            {t.connected}
          </Pill>
        ) : (
          <Pill tone="red" icon="xc">
            {t.tokenUnusable}
          </Pill>
        )
      }
      sub={t.panelSub}
    >
      <form
        aria-label={t.formLabel}
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <DyField label={t.accountId} value={accountId} mono onChange={setAccountId} />
        <DyField
          label={t.token}
          type="password"
          autoComplete="off"
          value={token}
          hint={current === null ? t.tokenHint : t.keepTokenHint}
          onChange={setToken}
        />
        {current !== null ? (
          <p className="m-0 text-[0.78125rem] text-dy-muted">
            {t.fingerprint} <span className="font-dy-mono">{current.keyFingerprint}</span>
          </p>
        ) : null}
        <FormActions>
          <DyButton type="submit" variant="primary" busy={act.busy}>
            {t.save}
          </DyButton>
          {current !== null ? (
            <>
              <DyButton icon="retry" disabled={act.busy} onClick={() => void runTest()}>
                {t.test}
              </DyButton>
              <ConfirmButton
                label={t.remove}
                question={t.removeQuestion}
                disabled={act.busy}
                onConfirm={() => void remove()}
              />
            </>
          ) : null}
        </FormActions>
      </form>
      <div className="mt-3 flex flex-col gap-2 empty:hidden">
        <DyApiError error={act.error} retryLeft={act.retryLeft} />
        {test !== null ? (
          <div className="rounded-[10px] border border-dy-line bg-dy-sunk/50 p-3">
            <CloudflareTest test={test} />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

/** Coolify, Cloudflare and the always-protected list; `onStatus` lets the page's summary follow a change. */
export function OpsIntegrationsPanels(props: {
  readonly onStatus?: (s: OpsIntegrationsStatus) => void;
}): ReactNode {
  const t = useT().integrations.cloudflare;
  const [status, setStatus] = useState<OpsIntegrationsStatus | null>(null);
  const load = useSubmit();
  const { onStatus } = props;
  const changed = useCallback(
    (s: OpsIntegrationsStatus) => {
      setStatus(s);
      onStatus?.(s);
    },
    [onStatus],
  );
  useEffect(() => {
    void load.run(async () => {
      setStatus(await getOpsIntegrations());
    });
  }, []);
  // The master stores a test as the provider's last test: mirror it locally (no extra read) so the page summary's
  // DNS probe and connection state show the fresh result, not the one from page load.
  const tested =
    (provider: 'cloudflare') =>
    (test: Json): void => {
      if (status === null) return;
      const cur = status[provider];
      if (cur === null) return;
      changed({ ...status, [provider]: { ...cur, lastTest: test, lastTestAt: new Date().toISOString() } });
    };
  // p13-multi-coolify: a connection change moves the default (the summary's Coolify line) — reload the status.
  const coolifyChanged = useCallback(() => {
    void getOpsIntegrations().then(changed, () => undefined);
  }, [changed]);
  if (status === null)
    return load.error === null ? (
      <Panel title={t.opsTitle} flush>
        <SkeletonRows label={t.opsLoading} rows={2} />
      </Panel>
    ) : (
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
    );
  return (
    <div className="flex flex-col gap-4" data-testid="ops-integrations">
      <CoolifyConnectionsPanel onChanged={coolifyChanged} />
      <ProviderPanel
        key={`cloudflare-${status.cloudflare?.updatedAt ?? ''}`}
        provider="cloudflare"
        status={status}
        onChanged={changed}
        onTested={tested('cloudflare')}
      />
      <Panel title={t.protectedTitle} sub={t.protectedSub} testId="dy-ops-protected">
        <dl className="m-0 grid gap-2 text-[0.875rem]">
          <div>
            <dt className="text-dy-muted">{t.controlPlaneResources}</dt>
            <dd className="m-0 font-dy-mono [overflow-wrap:anywhere]">
              {status.controlPlaneResources.join(', ') || t.notDefined}
            </dd>
          </div>
          <div>
            <dt className="text-dy-muted">{t.protectedHosts}</dt>
            <dd className="m-0">
              <span className="font-dy-mono [overflow-wrap:anywhere]">
                {status.protectedHosts.join(', ')}
              </span>{' '}
              <span className="text-dy-muted">{t.protectedHostsNote}</span>
            </dd>
          </div>
        </dl>
      </Panel>
    </div>
  );
}
