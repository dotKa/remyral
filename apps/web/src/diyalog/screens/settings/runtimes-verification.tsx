import { fill, type Messages } from '@remyral/i18n';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  type CatalogProof,
  getCatalogProofs,
  getPlatformProofs,
  getPolicyDependence,
  markCatalogVerified,
  type PlatformProof,
  type PolicyDependence,
} from '../../../api/runtimeVerification';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { machineHref } from '../../../lib/reasons';
import { DATE_TIME_NUMERIC } from '../../common/time';
import { RuntimeMark } from '../../RuntimeMark';
import { ConfirmButton, DyApiError, DyNotice } from '../forms';
import { EmptyLine, Panel, Pill } from '../parts';

/**
 * p17-runtime-verify (docs/design/p17-runtime-verify.md §5): Ayarlar → Runtime politikası — how many installed runtimes
 * still use job capabilities only because a policy allows unverified ones, and the way to turn that off; and (also on
 * Araçlar ve sürümler) per platform which runtime versions a verification run proved. Both read only; nothing shows
 * on an older master (the routes do not exist there).
 */

type Text = Messages['runtimeVerify'];

function caps(t: Text, list: readonly string[]): string {
  return list.map((c) => (t.capability as Readonly<Record<string, string | undefined>>)[c] ?? c).join(', ');
}

export function PolicyDependencePanel(): ReactNode {
  const t = useT().runtimeVerify;
  const [d, setD] = useState<PolicyDependence | null>(null);
  useEffect(() => {
    let live = true;
    getPolicyDependence().then(
      (x) => {
        if (live) setD(x);
      },
      () => {
        if (live) setD(null);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  if (d === null) return null;
  if (d.dependent === 0)
    return (
      <DyNotice tone="green" icon="checkc" testId="runtime-policy-dependence" title={t.policy.title}>
        {t.policy.none}
      </DyNotice>
    );
  return (
    <DyNotice tone="amber" icon="shield" testId="runtime-policy-dependence" title={t.policy.title}>
      <div className="flex flex-col gap-2">
        <span data-testid="runtime-policy-dependence-count">
          {fill(t.policy.count, { n: d.dependent, total: d.total })}
        </span>
        <span>{t.policy.path}</span>
        <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
          {d.items.map((i) => (
            <li key={`${i.workerId}:${i.runtime}`}>
              <Link to={machineHref(i.workerId, 'remote-ops')} className="text-dy-teal-ink">
                {fill(t.policy.item, {
                  machine: i.machine,
                  runtime: i.runtime,
                  version: i.version,
                  platform: i.platform ?? '?',
                  caps: caps(t, i.unverified),
                })}
              </Link>
              {i.canVerify ? null : ` — ${t.policy.updateFirst}`}
            </li>
          ))}
        </ul>
      </div>
    </DyNotice>
  );
}

export function PlatformProofsPanel(): ReactNode {
  const t = useT().runtimeVerify;
  const fmt = useFormat();
  const [items, setItems] = useState<PlatformProof[] | null>(null);
  useEffect(() => {
    let live = true;
    getPlatformProofs().then(
      (x) => {
        if (live) setItems(x);
      },
      () => {
        if (live) setItems(null);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  if (items === null) return null;
  const platforms = [...new Set(items.map((i) => i.platform))].sort();
  return (
    <Panel title={t.platforms.title} sub={t.platforms.sub} flush testId="runtime-platform-proofs">
      {items.length === 0 ? (
        <EmptyLine>{t.platforms.empty}</EmptyLine>
      ) : (
        <ul className="m-0 list-none p-0">
          {platforms.map((platform) => (
            <li key={platform} className="border-t border-dy-line px-4 py-3 first:border-t-0">
              <h3 className="m-0 font-dy-mono text-[0.875rem] font-bold">{platform}</h3>
              <ul className="m-0 mt-1.5 flex list-none flex-col gap-1.5 p-0">
                {items
                  .filter((i) => i.platform === platform)
                  .map((i) => (
                    <li
                      key={`${i.runtime}@${i.version}/${i.adapterVersion}`}
                      className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8125rem]"
                      data-testid="runtime-platform-proof"
                      data-runtime={i.runtime}
                      data-version={i.version}
                    >
                      <RuntimeMark runtime={i.runtime} />
                      <span className="font-dy-mono">{i.version}</span>
                      {i.verified.length > 0 ? (
                        <Pill tone={i.current ? 'green' : 'neutral'} icon="checkc">
                          {fill(t.platforms.verified, { caps: caps(t, i.verified) })}
                        </Pill>
                      ) : null}
                      {i.failed.length > 0 ? (
                        <Pill tone="red" icon="xc">
                          {fill(t.platforms.failed, { caps: caps(t, i.failed) })}
                        </Pill>
                      ) : null}
                      {i.current ? null : <span className="text-dy-amber-ink">{t.platforms.expired}</span>}
                      <span className="text-dy-muted">
                        {fill(t.platforms.by, {
                          machine: i.machine,
                          when: fmt.dateWith(i.at, DATE_TIME_NUMERIC),
                        })}
                      </span>
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Version catalog: an unverified catalog runtime version with a verification run — its result, the owner's local
 * "verified" mark and the button to set it (admin, step-up; only after a passed run). The signed catalog never changes
 * here: making the version verified for everyone is the vendor's catalog routine (docs/ops/update-channel.md §4).
 */
export function CatalogProofLine(props: {
  readonly runtime: string;
  readonly version: string;
  readonly proofs: readonly CatalogProof[];
  readonly canMark: boolean;
  readonly onMarked: () => void;
}): ReactNode {
  const t = useT().runtimeVerify;
  const fmt = useFormat();
  const submit = useSubmit();
  const stepUp = useStepUp();
  const p = props.proofs.find((x) => x.runtime === props.runtime && x.version === props.version);
  const when = (iso: string) => fmt.dateWith(iso, DATE_TIME_NUMERIC);
  if (p === undefined)
    return (
      <span className="text-[0.8125rem] text-dy-muted" data-testid="catalog-proof" data-state="none">
        {t.catalog.verifyFirst}
      </span>
    );
  const label =
    p.marked !== null
      ? fill(t.catalog.marked, { when: when(p.marked.at) })
      : p.evidence === 'passed'
        ? fill(t.catalog.proven, { machine: p.machine, when: when(p.at) })
        : p.evidence === 'failed'
          ? fill(t.catalog.failed, { when: when(p.at) })
          : fill(t.catalog.partial, { when: when(p.at) });
  return (
    <span
      className="flex flex-wrap items-center gap-2"
      data-testid="catalog-proof"
      data-state={p.marked !== null ? 'marked' : p.evidence}
    >
      <Pill
        tone={
          p.marked !== null || p.evidence === 'passed' ? 'green' : p.evidence === 'failed' ? 'red' : 'amber'
        }
      >
        {label}
      </Pill>
      {props.canMark && p.marked === null && p.evidence === 'passed' ? (
        <ConfirmButton
          label={t.catalog.mark}
          question={fill(t.catalog.markQuestion, { runtime: props.runtime, version: props.version })}
          busy={submit.busy}
          onConfirm={() => {
            void submit.run(async () => {
              try {
                await stepUp.run(
                  () => markCatalogVerified(props.runtime, props.version),
                  fill(t.catalog.markWhy, { runtime: props.runtime, version: props.version }),
                );
                props.onMarked();
              } catch (err) {
                if (!(err instanceof StepUpCancelledError)) throw err;
              }
            });
          }}
        />
      ) : null}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </span>
  );
}

/** The catalog proofs (null: an older master). */
export function useCatalogProofs(): { readonly proofs: CatalogProof[] | null; readonly reload: () => void } {
  const [proofs, setProofs] = useState<CatalogProof[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    getCatalogProofs().then(
      (x) => {
        if (live) setProofs(x);
      },
      () => {
        if (live) setProofs(null);
      },
    );
    return () => {
      live = false;
    };
  }, [tick]);
  return {
    proofs,
    reload: () => {
      setTick((n) => n + 1);
    },
  };
}
