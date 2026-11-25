import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  type FleetAction,
  type FleetToolSettings,
  getFleetToolSettings,
  putFleetToolSettings,
  refreshVersionFeed,
} from '../../../api/fleetTools';
import { useAuth } from '../../../auth/AuthProvider';
import { toApiError } from '../../../components/ui';
import { useSubmit } from '../../../screens/useSubmit';
import { DyApiError, DySwitch } from '../forms';
import { DyButton, ErrorLine, Panel, Pill, SkeletonRows } from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import { toast } from '../../toast/store';
import { motionOff } from '../../motionKit';
import { ActionsPanel, useFleetActions } from './fleet-tools-actions';
import { BulkDialog } from './fleet-tools-bulk';
import { CustomToolsPanel } from './fleet-tools-custom';
import { FleetGitPanel } from './fleet-git';
import { FleetMatrix } from './fleet-tools-matrix';
import { useFleetTools } from './fleet-tools-parts';
import { CandidatesPanel, SummarySplit } from './fleet-tools-runtime-updates';
import { OwnerUpgradePanel } from './fleet-tools-owner-upgrade';
import { useGuarded, whenText } from './tabs/config-shared';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { PlatformProofsPanel } from '../settings/runtimes-verification';

/**
 * p13-fleet-tools (docs/design/p13-fleet-tools.md, ADR-0052) — Makineler → Araçlar ve sürümler (/machines/tools):
 * every tool and runtime version across the fleet (installed / pin / en son, in words), "Toplu işlem" to update or
 * install one item on selected machines or the whole fleet (canary-first, queued for offline machines), the recent
 * fleet actions with per-machine progress, admin-defined "Özel araçlar" and the weekly update digest switch. Owners
 * and admins act (step-up; machine-admin kinds always-fresh); everyone else reads.
 */

function DigestPanel(props: { readonly isAdmin: boolean }): ReactNode {
  const fmt = useFormat();
  const t = useT().fleetTools.screen;
  const [s, setS] = useState<FleetToolSettings | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = useSubmit();
  const guarded = useGuarded();
  useEffect(() => {
    getFleetToolSettings().then(setS, (err: unknown) => {
      setError(toApiError(err));
    });
  }, []);
  // p17-ui-polish: one switch is a compact row, not a card with a visible heading of its own; the heading stays for
  // assistive tech (heading navigation still finds "Ayarlar").
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid="fleet-tool-settings"
      className="shadow-dy-edge flex min-w-0 flex-col gap-2 rounded-[var(--dy-r-card)] border border-dy-line bg-dy-card px-4 py-3"
    >
      <h2 id={headingId} className="sr-only">
        {t.settings}
      </h2>
      <DyApiError error={error ?? submit.error} retryLeft={submit.retryLeft} />
      {s === null ? null : (
        <DySwitch
          label={t.digest}
          hint={`${t.digestHint}${s.lastDigestAt === null ? '' : t.lastDigest({ when: whenText(s.lastDigestAt, fmt) })}`}
          checked={s.digestEnabled}
          disabled={!props.isAdmin}
          busy={submit.busy}
          testId="digest-switch"
          onChange={(v) => {
            void submit.run(async () => {
              const next = await guarded(() => putFleetToolSettings(v), t.digestWhy({ on: v }));
              if (next !== null) setS(next);
            });
          }}
        />
      )}
    </section>
  );
}

export function FleetToolsScreen(): ReactNode {
  const fmt = useFormat();
  const t = useT().fleetTools.screen;
  const ft = useT().fleetTools;
  const { state: auth } = useAuth();
  const isAdmin = auth.kind === 'signedIn' && (auth.user.role === 'owner' || auth.user.role === 'admin');
  const fleet = useFleetTools();
  const actions = useFleetActions();
  const [machines, setMachines] = useState<ReadonlySet<string>>(new Set());
  const [items, setItems] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const feed = useSubmit();
  const guarded = useGuarded();
  const data = fleet.data;
  const setData = fleet.setData;
  const reloadFleet = fleet.reload;

  // A fleet action that ended changes versions: re-read the matrix once.
  const running = actions.actions?.filter((a) => a.state === 'running').length ?? 0;
  const wasRunning = useRef(0);
  useEffect(() => {
    if (running < wasRunning.current) void reloadFleet();
    wasRunning.current = running;
  }, [running, reloadFleet]);

  const onStarted = useCallback(
    (a: FleetAction) => {
      actions.put(a);
      setBulk(false);
      // The panel sits below the matrix: say that it started and take the owner to its progress.
      const what = [data?.catalog.find((c) => c.id === a.item)?.label ?? a.item, a.version]
        .filter(Boolean)
        .join(' ');
      const skipped = a.counts.skipped ?? 0;
      toast({
        id: `fleet-action-${a.id}`,
        tone: skipped > 0 ? 'warning' : 'success',
        title: ft.actions.started({ what, n: a.targets.length }),
        description: skipped > 0 ? ft.actions.skippedSome({ n: skipped }) : undefined,
        actions: [
          {
            label: ft.actions.seeStatus,
            testId: 'fleet-action-see',
            onClick: () => {
              const el = document.getElementById(`fleet-action-${a.id}`);
              // p22-classic-removal: reduced motion jumps instead of gliding.
              if (el === null) return;
              el.scrollIntoView({ behavior: motionOff(el) ? 'auto' : 'smooth', block: 'center' });
              el.focus({ preventScroll: true });
            },
          },
        ],
        testId: 'fleet-action-started',
      });
    },
    [actions, data, ft],
  );

  const summary = data?.summary;
  return (
    <ScreenFrame
      title={t.title}
      purpose={t.purpose}
      back={{ to: '/machines', label: t.back }}
      live={fleet.error !== null ? 'error' : 'live'}
      testId="dy-fleet-tools"
      facts={
        summary === undefined ? undefined : (
          <>
            {summary.updates > 0 ? (
              <span data-testid="fleet-summary">
                <Pill tone="amber" icon="retry">
                  {t.summary({ updates: summary.updates, machines: summary.machinesWithUpdates })}
                </Pill>
              </span>
            ) : (
              <span data-testid="fleet-summary">
                <Pill tone="green" icon="checkc">
                  {t.allCurrent}
                </Pill>
              </span>
            )}
            {/* p16-runtime-updates: "K kurulabilir · M makine yazılımı sürümü gerektirir". */}
            <SummarySplit summary={summary} />
            {summary.notFound > 0 ? <Pill tone="neutral">{t.notFound({ n: summary.notFound })}</Pill> : null}
            <span className="text-[0.8125rem] text-dy-muted" data-testid="feed-checked">
              {data?.feed.enabled === false
                ? t.feedOff
                : data?.feed.checkedAt === null || data?.feed.checkedAt === undefined
                  ? t.feedUnchecked
                  : t.feedChecked({ when: whenText(data.feed.checkedAt, fmt) })}
            </span>
          </>
        )
      }
      actions={
        isAdmin && data !== null ? (
          <>
            <DyButton
              icon="retry"
              busy={feed.busy}
              onClick={() => {
                void feed.run(async () => {
                  const next = await guarded(() => refreshVersionFeed(), t.refreshWhy);
                  if (next !== null) setData(next);
                });
              }}
            >
              {t.refresh}
            </DyButton>
            <DyButton
              variant="primary"
              onClick={() => {
                setBulk(true);
              }}
            >
              {t.bulk}
              {machines.size > 0 ? t.bulkCount({ n: machines.size }) : ''}
            </DyButton>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5">
        <ErrorLine error={fleet.error} what={t.what} onRetry={() => void reloadFleet()} />
        <DyApiError error={feed.error} retryLeft={feed.retryLeft} />
        {data === null ? (
          fleet.error === null ? (
            <Panel title={t.matrix} flush>
              <SkeletonRows label={t.loading} rows={4} />
            </Panel>
          ) : null
        ) : (
          <FleetMatrix
            data={data}
            isAdmin={isAdmin}
            machines={machines}
            items={items}
            onMachines={setMachines}
            onItems={setItems}
          />
        )}
        <ActionsPanel state={actions} catalog={data?.catalog ?? []} isAdmin={isAdmin} />
        {/* p16-runtime-updates: newer runtime versions and their automatic verification on a canary. */}
        {data === null ? null : <CandidatesPanel data={data} isAdmin={isAdmin} />}
        {/* p17-runtime-verify: per platform, which runtime versions a verification run proved. */}
        <PlatformProofsPanel />
        {/* p17-ui-polish: two independent column stacks on wide screens (no grid rows, so a short panel leaves no
            hole next to a tall one, as on the machine page): the upgrade and git readiness on the left, the custom
            tools and the digest switch on the right. On narrower screens the columns dissolve (`contents`) and the
            order is upgrade, custom tools, digest, git. */}
        <div className="flex flex-col gap-5 xl:grid xl:grid-cols-2 xl:items-start">
          <div className="contents xl:flex xl:min-w-0 xl:flex-col xl:gap-5">
            {/* p17-update-channel: the owner's upgrade to an exact upstream version. */}
            <div className="order-1 min-w-0 xl:order-none">
              <OwnerUpgradePanel />
            </div>
            {/* p15-git-central: git readiness of every machine and the fleet-wide fix. */}
            <div className="order-4 min-w-0 xl:order-none">
              <FleetGitPanel isAdmin={isAdmin} />
            </div>
          </div>
          <div className="contents xl:flex xl:min-w-0 xl:flex-col xl:gap-5">
            <div className="order-2 min-w-0 xl:order-none">
              <CustomToolsPanel
                isAdmin={isAdmin}
                onChanged={() => {
                  void reloadFleet();
                }}
              />
            </div>
            <div className="order-3 min-w-0 xl:order-none">
              <DigestPanel isAdmin={isAdmin} />
            </div>
          </div>
        </div>
      </div>
      {bulk && data !== null ? (
        <BulkDialog
          open
          data={data}
          initialItem={[...items][0] ?? null}
          selected={machines}
          onClose={() => {
            setBulk(false);
          }}
          onStarted={onStarted}
        />
      ) : null}
    </ScreenFrame>
  );
}
