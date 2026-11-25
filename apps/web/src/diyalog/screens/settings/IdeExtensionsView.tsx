import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  allowIdeExtension,
  getIdeExtensionPolicy,
  type IdeAllowedExtension,
  type IdeExtensionPolicy,
  type IdeSearchHit,
  listIdeExtensions,
  putIdeExtensionPolicy,
  removeIdeExtension,
  searchIdeExtensions,
} from '../../../api/ideExtensions';
import { toApiError } from '../../../components/ui';
import { useErrorText } from '../../../i18n/errors';
import { useT } from '../../../i18n/I18nProvider';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyNotice } from '../../common/notices';
import { toast } from '../../toast/store';
import { DyApiError, DyCheck, DyInput, DyTextarea } from '../kit';
import { DyButton, Panel, SkeletonRows } from '../parts';

/**
 * p19-ide W3 (docs/design/p19-ide.md §4): Ayarlar → Geliştirme ortamı — the IDE extension allowlist.
 * Admins search Open VSX through the master and allow an extension (a version, or the latest now): the master
 * downloads it, checks size, SHA-256 and the registry signature, and caches it; workers install only from that cache.
 * The global policy: the registry address (an Open VSX-compatible https URL), "verified publishers only", a deny list.
 * Every change asks for the `extensions.ide` step-up when the security policy says so; all of it is audited.
 */
export function IdeExtensionsView(): ReactNode {
  const t = useT().ide.admin;
  const sayError = useErrorText();
  const stepUp = useStepUp();
  const [policy, setPolicy] = useState<IdeExtensionPolicy | null>(null);
  const [list, setList] = useState<readonly IdeAllowedExtension[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [registry, setRegistry] = useState('');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [deny, setDeny] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly IdeSearchHit[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState({ id: '', version: '' });

  const load = useCallback((signal?: AbortSignal) => {
    const o = signal === undefined ? {} : { signal };
    Promise.all([getIdeExtensionPolicy(o), listIdeExtensions(o)]).then(
      ([p, l]) => {
        setPolicy(p);
        setList(l);
        setRegistry(p.registryUrl);
        setVerifiedOnly(p.verifiedOnly);
        setDeny(p.deny.join('\n'));
      },
      (err: unknown) => {
        if (signal?.aborted !== true) setError(toApiError(err));
      },
    );
  }, []);
  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal);
    return () => {
      ctl.abort();
    };
  }, [load]);

  if (error !== null) return <DyApiError error={error} />;
  if (policy === null || list === null) return <SkeletonRows label={t.title} rows={3} />;

  const guarded = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key);
    try {
      await stepUp.run(fn, t.stepUp);
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) toast({ tone: 'error', title: sayError(err) });
    } finally {
      setBusy(null);
    }
  };
  const savePolicy = (): Promise<void> =>
    guarded('policy', async () => {
      const p = await putIdeExtensionPolicy({
        registryUrl: registry.trim() === '' ? null : registry.trim(),
        verifiedOnly,
        deny: deny
          .split(/[\s,]+/)
          .map((x) => x.trim())
          .filter((x) => x !== ''),
      });
      setPolicy(p);
      setDeny(p.deny.join('\n'));
      setRegistry(p.registryUrl);
      toast({ tone: 'success', title: t.saved });
    });
  const allow = (id: string, version?: string): Promise<void> =>
    guarded(`allow:${id}`, async () => {
      const e = await allowIdeExtension(version === undefined || version === '' ? { id } : { id, version });
      setList((l) => [...(l ?? []).filter((x) => x.id !== e.id), e].sort((a, b) => a.id.localeCompare(b.id)));
      setHits((h) => h?.map((x) => (x.id === e.id ? { ...x, allowedVersion: e.version } : x)) ?? null);
      toast({ tone: 'success', title: t.allowed({ id: e.id, version: e.version }) });
    });
  const remove = (id: string): Promise<void> =>
    guarded(`remove:${id}`, async () => {
      await removeIdeExtension(id);
      setList((l) => (l ?? []).filter((x) => x.id !== id));
      setHits((h) => h?.map((x) => (x.id === id ? { ...x, allowedVersion: null } : x)) ?? null);
      toast({ tone: 'success', title: t.removed({ id }) });
    });
  const search = async (): Promise<void> => {
    if (query.trim() === '') return;
    setBusy('search');
    try {
      setHits(await searchIdeExtensions(query.trim()));
    } catch (err) {
      toast({ tone: 'error', title: sayError(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex max-w-[52rem] flex-col gap-4" data-testid="ide-extensions-settings">
      <p className="m-0 text-[0.875rem] text-dy-muted">{t.sub}</p>
      <Panel title={t.policyTitle} sub={t.policySub} testId="ide-ext-policy">
        <div className="flex flex-col gap-3">
          <DyInput
            label={t.registry}
            hint={t.registryHint}
            value={registry}
            onChange={(e) => {
              setRegistry(e.target.value);
            }}
            data-testid="ide-ext-registry"
          />
          <DyCheck
            label={t.verifiedOnly}
            hint={t.verifiedOnlyHint}
            checked={verifiedOnly}
            onChange={setVerifiedOnly}
          />
          <DyTextarea
            label={t.deny}
            hint={t.denyHint}
            rows={3}
            value={deny}
            onChange={(e) => {
              setDeny(e.target.value);
            }}
            data-testid="ide-ext-deny"
          />
          <div>
            <DyButton
              variant="primary"
              icon="key"
              busy={busy === 'policy'}
              onClick={() => void savePolicy()}
              data-testid="ide-ext-policy-save"
            >
              {t.save}
            </DyButton>
          </div>
        </div>
      </Panel>
      <Panel title={t.searchTitle} sub={t.searchSub} testId="ide-ext-search">
        <div className="flex flex-col gap-3">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <DyInput
              label={t.searchLabel}
              wrapClassName="min-w-[16rem] flex-1"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              data-testid="ide-ext-query"
            />
            <DyButton type="submit" busy={busy === 'search'} data-testid="ide-ext-search-run">
              {t.searchButton}
            </DyButton>
          </form>
          {hits === null ? null : hits.length === 0 ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.noHits}</p>
          ) : (
            <ul className="grid gap-1.5" data-testid="ide-ext-hits">
              {hits.map((h) => (
                <li
                  key={h.id}
                  className="flex flex-wrap items-center gap-2 rounded-[9px] border border-dy-line px-3 py-2"
                  data-testid="ide-ext-hit"
                >
                  <span className="font-bold">{h.displayName}</span>
                  <span className="font-dy-mono text-[0.75rem] text-dy-muted">
                    {h.id}@{h.version}
                  </span>
                  {h.verified ? <span className="text-[0.75rem] text-dy-muted">{t.verified}</span> : null}
                  {h.deprecated ? <span className="text-[0.75rem] text-dy-muted">{t.deprecated}</span> : null}
                  <span className="basis-full text-[0.8125rem] text-dy-muted">{h.description}</span>
                  <span className="ml-auto">
                    {h.denied ? (
                      <span className="text-[0.75rem]">{t.denied}</span>
                    ) : h.allowedVersion === h.version ? (
                      <span className="text-[0.75rem]">{t.isAllowed}</span>
                    ) : (
                      <DyButton
                        variant="primary"
                        busy={busy === `allow:${h.id}`}
                        onClick={() => void allow(h.id)}
                        data-testid="ide-ext-allow"
                      >
                        {h.allowedVersion === null ? t.allow : t.update({ version: h.version })}
                      </DyButton>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (manual.id.trim() !== '') void allow(manual.id.trim(), manual.version.trim());
            }}
          >
            <DyInput
              label={t.manualId}
              wrapClassName="min-w-[14rem] flex-1"
              value={manual.id}
              placeholder="publisher.name" // i18n-ignore: an id pattern
              onChange={(e) => {
                setManual({ ...manual, id: e.target.value });
              }}
              data-testid="ide-ext-manual-id"
            />
            <DyInput
              label={t.manualVersion}
              hint={t.manualVersionHint}
              wrapClassName="w-[10rem]"
              value={manual.version}
              onChange={(e) => {
                setManual({ ...manual, version: e.target.value });
              }}
              data-testid="ide-ext-manual-version"
            />
            <DyButton type="submit" variant="primary" busy={busy === `allow:${manual.id.trim()}`}>
              {t.allow}
            </DyButton>
          </form>
        </div>
      </Panel>
      <Panel title={t.listTitle} count={String(list.length)} sub={t.listSub} testId="ide-ext-allowlist">
        {list.length === 0 ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.empty}</p>
        ) : (
          <ul className="grid gap-1.5">
            {list.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-center gap-2 rounded-[9px] border border-dy-line px-3 py-2"
                data-testid="ide-ext-allowed"
              >
                <span className="font-bold">{e.displayName}</span>
                <span className="font-dy-mono text-[0.75rem] text-dy-muted">
                  {e.id}@{e.version}
                </span>
                <span className="text-[0.75rem] text-dy-muted">
                  {e.targets.map((x) => x.target).join(', ')}
                </span>
                <span className="text-[0.75rem] text-dy-muted">
                  {e.targets.every((x) => x.keyPinned) ? t.signaturePinned : t.signatureRegistry}
                </span>
                {e.dependencies.length === 0 ? null : (
                  <span className="basis-full text-[0.75rem] text-dy-muted">
                    {t.dependencies({ list: e.dependencies.join(', ') })}
                  </span>
                )}
                <span className="ml-auto">
                  <DyButton
                    variant="ghost"
                    icon="trash"
                    busy={busy === `remove:${e.id}`}
                    onClick={() => void remove(e.id)}
                    data-testid="ide-ext-remove"
                  >
                    {t.remove}
                  </DyButton>
                </span>
              </li>
            ))}
          </ul>
        )}
        {list.some((e) => e.dependencies.some((d) => !list.some((x) => x.id === d))) ? (
          <DyNotice tone="amber" testId="ide-ext-missing-deps">
            {t.missingDependencies}
          </DyNotice>
        ) : null}
      </Panel>
    </div>
  );
}
