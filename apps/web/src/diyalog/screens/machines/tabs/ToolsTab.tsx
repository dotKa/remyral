import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../../../api/client';
import {
  detectTools,
  getWorkerTools,
  INSPECT_SECTIONS,
  inspectMachine,
  inspectOf,
  installTool,
  inventoryOf,
  type MachineInspectReport,
  type RecipeTool,
  removeTool,
  startMachineTask,
  type ToolRecipe,
  type WorkerTools,
} from '../../../../api/machineAdmin';
import { type Op, TERMINAL_STATES } from '../../../../api/remoteOps';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyIcon } from '../../../icons';
import { ConfirmButton, DyApiError, DyDetails, DyNotice } from '../../forms';
import { DyButton, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../../parts';
import { useFleetTools } from '../fleet-tools-parts';
import { OpLine, useGuarded, useOpPoll, whenText } from './config-shared';
import { ToolsInventory } from './tools-inventory';
import { CodeImagesPanel } from './tools-code-images';
import { GitPanel } from './tools-git';
import { type MachineTabProps, operable } from './types';
import type { Formatter, Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../../i18n/I18nProvider';

function bytesOrDash(fmt: Formatter, n: number | null): string {
  return n === null ? '—' : fmt.bytes(n);
}

/**
 * p12-diyalog wave 2 (W3) — Makine → Araçlar in the Diyalog language, feature for feature with the classic
 * `ToolsPanel` (p5-machine-admin §2, ADR-0021): the tool inventory the worker found (system and worker-managed),
 * the release's checksummed recipes with install / remove (remote operation, step-up), recipes that need root /
 * Administrator through a machine administration job (always-fresh step-up; the master's `machine_admin_required`
 * also routes there), "Yeniden tara" and the read-only "Makineyi incele" report. Same requests; viewers read only.
 * p13-fleet-tools: the inventory is "Etkin" (what jobs use) + "Sistem" / "Worker’ın kurdukları" tabs with versions and
 * the fleet Güncelle / Kur (tools-inventory.tsx).
 */

type ToolsText = Messages['machineRuntimes']['tools'];

/** A recipe's tool name; the browser and cloudflared get a word on what they are for. */
function toolLabel(tool: RecipeTool, t: ToolsText): string {
  if (tool === 'browser') return t.labels.browser;
  if (tool === 'cloudflared') return t.labels.cloudflared;
  return tool === 'python' ? 'Python' : tool; // i18n-ignore: product name
}

const OP_WHAT: Readonly<Record<string, keyof ToolsText['ops']>> = {
  'tool.install': 'install',
  'tool.remove': 'remove',
  'tool.detect': 'detect',
  'tools.detect': 'detect',
  'machine.inspect': 'inspect',
};

function opWhat(kind: string, t: ToolsText): string {
  const key = OP_WHAT[kind];
  return key === undefined ? kind : t.ops[key];
}

export function ToolsTab(props: MachineTabProps): ReactNode {
  const fmt = useFormat();
  const t = useT().machineRuntimes.tools;
  const { worker, isAdmin } = props;
  const workerId = worker.id;
  const name = worker.name;
  const [data, setData] = useState<WorkerTools | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const [elevated, setElevated] = useState<ToolRecipe | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const load = useSubmit();
  const act = useSubmit();
  const guarded = useGuarded();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      setData(await getWorkerTools(workerId));
    });
  }, [load.run, workerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onDone = useCallback(() => {
    void refresh();
  }, [refresh]);
  // p13-fleet-tools: versions (pin / en son / status) from the fleet view; an older master → none shown.
  const fleet = useFleetTools(workerId);
  const reloadFleet = fleet.reload;
  const onFleetDone = useCallback(() => {
    void refresh();
    void reloadFleet();
  }, [refresh, reloadFleet]);
  useOpPoll(workerId, op, setOp, onDone);

  const running = op !== null && !TERMINAL_STATES.has(op.state);
  const inventory = inventoryOf(op) ?? data?.inventory ?? null;
  const inspected = inspectOf(op);

  const runOp = (fn: () => Promise<Op>, why: string): void => {
    void act.run(async () => {
      const o = await guarded(fn, why);
      if (o !== null) setOp(o);
    });
  };

  const install = (r: ToolRecipe): void => {
    if (r.elevated) {
      setElevated(r);
      return;
    }
    void act.run(async () => {
      try {
        const o = await guarded(
          () => installTool(workerId, r.tool, r.version),
          t.whyInstall({ tool: toolLabel(r.tool, t), machine: name }),
        );
        if (o !== null) setOp(o);
      } catch (err) {
        // The master decides: a recipe that needs root / Administrator runs as a machine-admin job.
        if (err instanceof ApiError && err.code === 'machine_admin_required') {
          setElevated({ ...r, elevated: true });
          return;
        }
        throw err;
      }
    });
  };

  return (
    <div className="flex flex-col gap-5" data-testid="tools-panel">
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {data === null ? (
        load.error === null ? (
          <Panel title={t.title} flush>
            <SkeletonRows label={t.loading} rows={3} />
          </Panel>
        ) : null
      ) : !data.supported ? (
        <DyNotice tone="amber" title={t.unsupported}>
          {t.updateFirst}
        </DyNotice>
      ) : (
        <>
          <Panel
            title={t.title}
            count={inventory === null ? undefined : String(inventory.tools.filter((x) => x.found).length)}
            countLabel={
              inventory === null ? undefined : t.found({ n: inventory.tools.filter((x) => x.found).length })
            }
            sub={
              inventory === null
                ? undefined
                : t.scanned({
                    when: whenText(inventory.detectedAt, fmt),
                    hours: Math.round(inventory.ttlSec / 3600),
                  })
            }
            aside={
              isAdmin ? (
                <span className="flex flex-wrap gap-2">
                  <DyButton
                    icon="retry"
                    busy={act.busy}
                    disabled={running}
                    onClick={() => {
                      runOp(() => detectTools(workerId), t.whyRescan({ machine: name }));
                    }}
                  >
                    {t.rescan}
                  </DyButton>
                  <DyButton
                    icon="search"
                    busy={act.busy}
                    disabled={running}
                    onClick={() => {
                      runOp(
                        () => inspectMachine(workerId, INSPECT_SECTIONS),
                        t.whyInspect({ machine: name }),
                      );
                    }}
                  >
                    {t.inspect}
                  </DyButton>
                </span>
              ) : undefined
            }
            flush
          >
            {op !== null ? (
              <div className="px-4 pb-3">
                <OpLine op={op} what={opWhat(op.kind, t)} testId="tool-op" />
              </div>
            ) : null}
            {inventory === null ? (
              <EmptyLine>{t.noInventory}</EmptyLine>
            ) : (
              <ToolsInventory
                inventory={inventory}
                fleet={fleet.data}
                workerId={workerId}
                workerName={name}
                isAdmin={isAdmin}
                busy={running}
                onFleetDone={onFleetDone}
              />
            )}
          </Panel>

          {inventory === null ? null : (
            <Panel title={t.recipes} sub={t.recipesSub} flush testId="tool-recipes">
              {inventory.recipes.length === 0 ? (
                <EmptyLine>{t.noRecipes}</EmptyLine>
              ) : (
                <Rows label={t.recipes}>
                  {inventory.recipes.map((r) => (
                    <Row
                      key={`${r.tool}@${r.version}`}
                      testId="tool-recipe"
                      lead={<DyIcon name={r.installed ? 'checkc' : 'tray'} className="size-4" />}
                      tone={r.installed ? 'green' : undefined}
                      title={
                        <span
                          className="flex flex-wrap items-center gap-x-2 gap-y-1"
                          data-recipe={`${r.tool}@${r.version}`}
                        >
                          {toolLabel(r.tool, t)}
                          <span className="font-dy-mono text-[0.8125rem] font-normal text-dy-muted">
                            {r.version}
                          </span>
                          {r.elevated ? (
                            <Pill tone="amber" icon="shield">
                              {t.needsRoot}
                            </Pill>
                          ) : null}
                          {r.installed ? <Pill tone="green">{t.installed}</Pill> : null}
                        </span>
                      }
                      meta={
                        <>
                          {r.sizeBytes !== undefined ? <span>{fmt.bytes(r.sizeBytes)}</span> : null}
                          {!r.supported ? <span>{r.unsupportedReason ?? t.unavailable}</span> : null}
                        </>
                      }
                      actions={
                        isAdmin && r.supported ? (
                          <>
                            {r.installed && !r.elevated ? (
                              <ConfirmButton
                                label={t.remove}
                                question={t.removeQuestion({ tool: toolLabel(r.tool, t), machine: name })}
                                confirmLabel={t.removeConfirm}
                                busy={act.busy}
                                disabled={running}
                                testId={`tool-remove-${r.tool}`}
                                onConfirm={() => {
                                  runOp(
                                    () => removeTool(workerId, r.tool, r.version),
                                    t.whyRemove({ tool: toolLabel(r.tool, t), machine: name }),
                                  );
                                }}
                              />
                            ) : null}
                            {!r.installed ? (
                              <DyButton
                                variant="secondary"
                                busy={act.busy}
                                disabled={running}
                                onClick={() => {
                                  install(r);
                                }}
                              >
                                {t.install}
                              </DyButton>
                            ) : null}
                          </>
                        ) : undefined
                      }
                    />
                  ))}
                </Rows>
              )}
              {elevated !== null ? (
                <div className="border-t border-dy-line px-4 py-3" data-testid="tool-elevated-dialog">
                  <DyNotice
                    tone="amber"
                    icon="shield"
                    title={t.elevatedTitle({ tool: toolLabel(elevated.tool, t) })}
                  >
                    {t.elevatedBody({ machine: name })}
                    {data.machineAdminEnabled ? '' : ` ${t.adminOff}`}
                  </DyNotice>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <DyButton
                      variant="primary"
                      busy={act.busy}
                      disabled={!data.machineAdminEnabled}
                      onClick={() => {
                        const r = elevated;
                        void act.run(async () => {
                          const job = await guarded(
                            () =>
                              startMachineTask(workerId, {
                                title: '',
                                prompt: '',
                                recipe: { tool: r.tool, version: r.version },
                              }),
                            t.whyAdminJob({ machine: name }),
                          );
                          if (job !== null) {
                            setStarted(job.jobId);
                            setElevated(null);
                          }
                        });
                      }}
                    >
                      {t.installAsAdmin}
                    </DyButton>
                    <DyButton
                      variant="ghost"
                      onClick={() => {
                        setElevated(null);
                      }}
                    >
                      {t.cancel}
                    </DyButton>
                  </div>
                </div>
              ) : null}
              {started !== null ? (
                <p
                  className="m-0 border-t border-dy-line px-4 py-3 text-[0.875rem]"
                  data-testid="tool-machine-task"
                >
                  {t.adminStarted}{' '}
                  <Link to={`/jobs/${encodeURIComponent(started)}`} className="font-medium text-dy-teal-ink">
                    {t.openJob}
                  </Link>
                </p>
              ) : null}
            </Panel>
          )}
          {inspected !== null ? <InspectReport report={inspected} /> : null}
          <DyApiError error={act.error} retryLeft={act.retryLeft} />
        </>
      )}
      {operable(worker) ? <CodeImagesPanel workerId={workerId} workerName={name} isAdmin={isAdmin} /> : null}
      {/* p15-git-central: git readiness of the machine and its one-click fix. */}
      <GitPanel workerId={workerId} workerName={name} isAdmin={isAdmin} />
    </div>
  );
}

function InspectReport(props: { readonly report: MachineInspectReport }): ReactNode {
  const fmt = useFormat();
  const t = useT().machineRuntimes.tools;
  const r = props.report;
  return (
    <Panel
      title={t.report}
      sub={`${whenText(r.collectedAt, fmt)} · ${r.platform}${r.truncated ? ` · ${t.truncated}` : ''}`}
      testId="inspect-report"
    >
      <div className="flex flex-col gap-3 text-[0.875rem]">
        {r.problems !== undefined && r.problems.length > 0 ? (
          <DyNotice tone="amber" title={t.unreadable}>
            <ul className="m-0 list-none p-0">
              {r.problems.map((p) => (
                <li key={p.section}>
                  <span className="font-dy-mono">{p.section}</span>: {p.message}
                </li>
              ))}
            </ul>
          </DyNotice>
        ) : null}
        {r.disk !== undefined ? (
          <ul
            className="m-0 flex list-none flex-col gap-1 p-0"
            data-testid="inspect-disk"
            aria-label={t.disks}
          >
            {r.disk.map((d) => (
              <li key={d.mount} className="flex flex-wrap gap-x-2">
                <span className="font-dy-mono">{d.mount}</span>
                <span className="text-dy-muted">
                  {t.diskFree({ free: bytesOrDash(fmt, d.freeBytes), total: bytesOrDash(fmt, d.totalBytes) })}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {r.software !== undefined ? (
          <DyDetails summary={t.software({ n: r.software.length })}>
            <ul className="m-0 max-h-60 list-none overflow-auto p-0 font-dy-mono text-[0.8125rem]">
              {r.software.map((s, i) => (
                <li key={`${s.name}-${String(i)}`}>
                  {s.name}
                  {s.version === undefined ? '' : ` ${s.version}`}
                </li>
              ))}
            </ul>
          </DyDetails>
        ) : null}
        {r.services !== undefined ? (
          <DyDetails summary={t.services({ n: r.services.length })}>
            <ul className="m-0 max-h-60 list-none overflow-auto p-0 font-dy-mono text-[0.8125rem]">
              {r.services.map((s, i) => (
                <li key={`${s.name}-${String(i)}`}>
                  {s.name} {s.state ?? ''} {s.startType ?? ''}
                </li>
              ))}
            </ul>
          </DyDetails>
        ) : null}
        {r.logs !== undefined && r.logs.length > 0 ? (
          <DyDetails summary={t.logs({ n: r.logs.length })}>
            <pre className="m-0 max-h-60 overflow-auto font-dy-mono text-[0.75rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
              {r.logs.join('\n')}
            </pre>
          </DyDetails>
        ) : null}
      </div>
    </Panel>
  );
}
