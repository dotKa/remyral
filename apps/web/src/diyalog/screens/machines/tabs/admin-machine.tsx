import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  type AdminCommandDetail,
  type CommandState,
  getAdminCommand,
  getMachineAdmin,
  type MachineAdminView,
  saveMachineMemory,
  setMachineAdmin,
  startMachineTask,
} from '../../../../api/machineAdmin';
import { useAuth } from '../../../../auth/AuthProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyIcon, type IconName } from '../../../icons';
import { KeyValue, type KeyValueRow } from '../../../KeyValue';
import type { Tone } from '../../../tone';
import { DyApiError, DyCheck, DyField, DyNotice, DyTextarea, FormActions } from '../../forms';
import {
  agoText,
  DyButton,
  DySelect,
  EmptyLine,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
  ThreadLink,
} from '../../parts';
import { DyConfirmDialog } from '../../../common/actions';
import { useGuardedValue } from './admin-guard';
import type { Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { HelperManage } from './admin-helper';
import { DATE_TIME_NUMERIC } from '../../../common/time';

/**
 * p12-diyalog wave 2 (W3) — Makine → Yönetim → Makine yönetimi (p5-machine-admin, ADR-0021) in the Diyalog language:
 * an AI agent running elevated commands (root / Administrator / SYSTEM) through the privileged helper. Same rules as
 * the classic `MachineAdminPanel`: owners and admins see it; only an owner switches it on or off (two presses for on,
 * always-fresh step-up, the expected generation sent); admins start machine tasks (step-up; "full access" only when
 * the machine and the Machines project both allow it), read every elevated command with its detail and output, and
 * read / edit the machine memory (step-up, expected version).
 */

const CMD_STATE: Readonly<Record<CommandState, { tone: Tone; icon: IconName }>> = {
  requested: { tone: 'neutral', icon: 'clock' },
  pending: { tone: 'amber', icon: 'shield' },
  granted: { tone: 'teal', icon: 'retry' },
  denied: { tone: 'red', icon: 'xc' },
  succeeded: { tone: 'green', icon: 'checkc' },
  failed: { tone: 'red', icon: 'xc' },
  refused: { tone: 'red', icon: 'xc' },
};

type AdminText = Messages['machineAdmin']['admin'];

function kindText(t: AdminText, kind: string): string {
  return kind === 'exec' || kind === 'write_file' || kind === 'read_file' ? t.kind[kind] : kind;
}

/** Helper readiness reasons whose worker detail is the command line the owner runs on the machine. */
const COMMAND_REASONS: ReadonlySet<string> = new Set(['helper_not_bound', 'helper_bound_elsewhere']);

/**
 * p17-worker-1-1-1: the helper readiness line — available, or unavailable / unknown with the reason in the user's
 * language (the worker's English detail for a code this console does not know).
 */
export function helperText(t: AdminText, r: NonNullable<MachineAdminView['reported']>): string {
  if (r.helper === 'available') return t.helperInstalled;
  const reasons = t.helperReason as Readonly<Record<string, string>>;
  const why =
    r.helperReason !== undefined && Object.hasOwn(reasons, r.helperReason)
      ? reasons[r.helperReason]
      : r.helperDetail;
  // A reason means the probe found the helper unready, also when it could not be sure ("unknown").
  const state = r.helper === 'missing' || r.helperReason !== undefined ? t.helperMissing : t.helperUnknown;
  // Security fix (helper binding): for these the worker's detail is the exact command to run on the machine.
  const command =
    why !== r.helperDetail && r.helperDetail !== undefined && COMMAND_REASONS.has(r.helperReason ?? '')
      ? ` ${r.helperDetail}`
      : '';
  return why === undefined ? state : `${state} — ${why}${command}`;
}

/** p17-worker-1-1-1: the agent's purpose of an elevated command, labelled as its unverified explanation. */
function Purpose(props: { readonly text: string; readonly label: string }): ReactNode {
  return (
    <span
      className="block text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]"
      data-testid="admin-command-purpose"
    >
      <span className="font-bold">{props.label}: </span>
      <span className="text-dy-ink">“{props.text}”</span>
    </span>
  );
}

/** "3 dk önce" in Turkish (the shared Diyalog helper), the locale's relative time otherwise. */
function useAgo(): (iso: string) => string {
  const fmt = useFormat();
  return (iso) => (fmt.locale === 'tr' ? agoText(iso) : fmt.relative(iso));
}

export function MachineAdminSection(props: {
  readonly workerId: string;
  readonly workerName: string;
  /** p17-worker-managed: the machine's OS (the rootless Docker setup is Linux only). */
  readonly os?: string | null;
}): ReactNode {
  const { state: auth } = useAuth();
  const role = auth.kind === 'signedIn' ? auth.user.role : 'viewer';
  const isOwner = role === 'owner';
  const isAdmin = role === 'owner' || role === 'admin';
  const t = useT().machineAdmin.admin;
  const [data, setData] = useState<MachineAdminView | null>(null);
  const load = useSubmit();
  const { run } = load;

  const refresh = useCallback(async () => {
    await run(async () => {
      setData(await getMachineAdmin(props.workerId));
    });
  }, [run, props.workerId]);

  useEffect(() => {
    if (isAdmin) void refresh();
  }, [isAdmin, refresh]);

  if (!isAdmin) return null;

  return (
    <section aria-labelledby="dy-madmin-h" className="flex flex-col gap-4" data-testid="machine-admin">
      <div>
        <h2 id="dy-madmin-h" className="m-0 text-[1rem] font-bold tracking-[-0.01em]">
          {t.title}
        </h2>
        <p className="m-0 mt-0.5 text-[0.84375rem] text-dy-muted">{t.intro}</p>
      </div>
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {data === null ? (
        load.error === null ? (
          <Panel title={t.title} flush>
            <SkeletonRows label={t.loading} rows={2} />
          </Panel>
        ) : null
      ) : !data.supported ? (
        <DyNotice tone="amber" testId="machine-admin-unsupported">
          {t.unsupported}
        </DyNotice>
      ) : (
        <>
          <Panel title={t.status} testId="machine-admin-status">
            <Status data={data} />
            {isOwner ? (
              <OwnerSwitch data={data} workerName={props.workerName} onChanged={setData} />
            ) : (
              <p className="m-0 mt-3 text-[0.8125rem] text-dy-muted" data-testid="machine-admin-owner-only">
                {t.ownerOnly}
              </p>
            )}
            <HelperManage
              workerId={props.workerId}
              workerName={props.workerName}
              os={props.os ?? null}
              isOwner={isOwner}
              machineAdminEnabled={data.desired.enabled}
              onChanged={() => void refresh()}
            />
          </Panel>
          {data.desired.enabled ? (
            <TaskForm data={data} workerName={props.workerName} onStarted={() => void refresh()} />
          ) : null}
          <Commands data={data} />
          <Memory data={data} onSaved={() => void refresh()} />
        </>
      )}
    </section>
  );
}

function Status(props: { readonly data: MachineAdminView }): ReactNode {
  const d = props.data;
  const r = d.reported;
  const t = useT().machineAdmin.admin;
  const rows: KeyValueRow[] = [
    {
      k: t.title,
      v: (
        <span className="flex flex-wrap items-center gap-2">
          <span data-testid="machine-admin-state">
            {d.desired.enabled ? (
              <Pill tone="red" icon="shield">
                {t.on}
              </Pill>
            ) : (
              <Pill tone="neutral">{t.off}</Pill>
            )}
          </span>
          {d.desired.enabled ? (
            <span className="text-[0.8125rem] text-dy-muted">
              {d.desired.autoApprove ? t.autoApproveOn : t.autoApproveOff}
            </span>
          ) : null}
        </span>
      ),
    },
  ];
  if (r !== null) {
    rows.push({
      k: t.helper,
      v: (
        <span
          data-testid="machine-admin-helper"
          className={r.helper === 'available' ? 'text-dy-ink' : 'text-dy-amber-ink'}
        >
          {helperText(t, r)}
        </span>
      ),
    });
  }
  if (d.activeJob !== null) {
    const job = d.activeJob;
    rows.push({
      k: t.runningJob,
      v: (
        <span className="flex flex-wrap items-center gap-2">
          <Link
            to={`/jobs/${encodeURIComponent(job.jobId)}`}
            className="text-dy-teal-ink [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
          >
            {job.title}
          </Link>
          <span className="font-dy-mono text-[0.78125rem] text-dy-muted">{job.state}</span>
        </span>
      ),
    });
  }
  return (
    <div className="flex flex-col gap-3">
      <KeyValue rows={rows} />
      {r === null ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.notReported}</p>
      ) : (
        <>
          {r.localVeto ? (
            <DyNotice tone="amber" testId="machine-admin-veto">
              {t.vetoBefore}
              <code className="font-dy-mono">
                localCeiling.allowMachineAdmin: false{/* i18n-ignore: config key */}
              </code>
              {t.vetoAfter}
            </DyNotice>
          ) : null}
          {d.desired.enabled !== r.enabled && !r.localVeto ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.notApplied}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function OwnerSwitch(props: {
  readonly data: MachineAdminView;
  readonly workerName: string;
  readonly onChanged: (v: MachineAdminView) => void;
}): ReactNode {
  const d = props.data;
  const all = useT().machineAdmin;
  const t = all.admin;
  const [confirm, setConfirm] = useState(false);
  const [autoApprove, setAutoApprove] = useState(d.desired.autoApprove);
  const act = useSubmit();
  const guarded = useGuardedValue();
  useEffect(() => {
    setAutoApprove(d.desired.autoApprove);
  }, [d.desired.autoApprove]);

  const save = (enabled: boolean, auto: boolean): void => {
    void act.run(async () => {
      const v = await guarded(
        () =>
          setMachineAdmin(d.workerId, {
            enabled,
            autoApprove: enabled && auto,
            expectedGeneration: d.desired.generation,
          }),
        t.switchWhy({ machine: props.workerName, enable: enabled }),
      );
      if (v !== null) {
        setConfirm(false);
        props.onChanged(v);
      }
    });
  };

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-dy-line pt-3" data-testid="machine-admin-switch">
      <DyCheck
        label={t.autoApprove}
        hint={t.autoApproveHint}
        checked={autoApprove}
        onChange={setAutoApprove}
      />
      {!d.projectAutoApprove && autoApprove ? (
        <p className="m-0 text-[0.8125rem] text-dy-amber-ink" data-testid="machine-admin-project-note">
          {t.projectNoteBefore}{' '}
          <Link to="/projects" className="text-dy-teal-ink underline">
            {t.projectNoteLink}
          </Link>
          {t.projectNoteAfter}
        </p>
      ) : null}
      <FormActions>
        {d.desired.enabled ? (
          <>
            <DyButton
              busy={act.busy}
              disabled={act.blocked}
              onClick={() => {
                save(false, false);
              }}
            >
              {t.disable}
            </DyButton>
            {autoApprove !== d.desired.autoApprove ? (
              <DyButton
                variant="primary"
                busy={act.busy}
                disabled={act.blocked}
                onClick={() => {
                  save(true, autoApprove);
                }}
              >
                {t.saveAutoApprove}
              </DyButton>
            ) : null}
          </>
        ) : (
          <>
            <DyButton
              variant="danger"
              icon="shield"
              busy={act.busy}
              disabled={act.blocked}
              data-testid="machine-admin-enable"
              aria-haspopup="dialog"
              onClick={() => {
                act.clearError();
                setConfirm(true);
              }}
            >
              {t.enable}
            </DyButton>
            <DyConfirmDialog
              open={confirm}
              onClose={() => {
                setConfirm(false);
              }}
              title={t.warningTitle}
              description={t.warning({ machine: props.workerName })}
              confirmLabel={t.enableConfirm}
              cancelLabel={all.cancel}
              busy={act.busy}
              confirmDisabled={act.blocked}
              testId="machine-admin-warning"
              confirmTestId="machine-admin-enable-confirm"
              onConfirm={() => {
                save(true, autoApprove);
              }}
            >
              <DyApiError error={act.error} retryLeft={act.retryLeft} />
            </DyConfirmDialog>
          </>
        )}
      </FormActions>
      {confirm ? null : <DyApiError error={act.error} retryLeft={act.retryLeft} />}
    </div>
  );
}

function TaskForm(props: {
  readonly data: MachineAdminView;
  readonly workerName: string;
  readonly onStarted: () => void;
}): ReactNode {
  const d = props.data;
  const allowAll = d.desired.autoApprove && d.projectAutoApprove;
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [policy, setPolicy] = useState<'ask-all' | 'allow-all'>('ask-all');
  const [minutes, setMinutes] = useState('60');
  const [started, setStarted] = useState<string | null>(null);
  const act = useSubmit();
  const guarded = useGuardedValue();
  const t = useT().machineAdmin.admin;

  return (
    <Panel title={t.taskTitle} sub={t.taskSub} testId="machine-task-panel">
      <form
        aria-label={t.taskForm({ machine: props.workerName })}
        data-testid="machine-task-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const mins = Number(minutes);
          void act.run(async () => {
            const job = await guarded(
              () =>
                startMachineTask(d.workerId, {
                  title: title.trim(),
                  prompt: prompt.trim(),
                  approvalPolicy: allowAll ? policy : 'ask-all',
                  ...(Number.isFinite(mins) && mins > 0 ? { maxDurationSec: Math.round(mins * 60) } : {}),
                }),
              t.taskWhy({ machine: props.workerName }),
            );
            if (job !== null) {
              setStarted(job.jobId);
              setTitle('');
              setPrompt('');
              props.onStarted();
            }
          });
        }}
      >
        <DyField label={t.taskName} value={title} maxLength={200} onChange={setTitle} />
        <DyTextarea label={t.taskPrompt} value={prompt} maxLength={32768} rows={4} onChange={setPrompt} />
        <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <DySelect
            label={t.approvals}
            value={allowAll ? policy : 'ask-all'}
            options={[['ask-all', t.askAll], ...(allowAll ? [['allow-all', t.allowAll] as const] : [])]}
            onChange={(v) => {
              setPolicy(v === 'allow-all' ? 'allow-all' : 'ask-all');
            }}
          />
          <DyField
            label={t.maxMinutes}
            type="number"
            min={1}
            max={720}
            value={minutes}
            onChange={setMinutes}
          />
        </div>
        {allowAll ? null : <p className="m-0 text-[0.78125rem] text-dy-muted">{t.noFullAccess}</p>}
        <FormActions>
          <DyButton
            type="submit"
            variant="primary"
            icon="term"
            busy={act.busy}
            disabled={title.trim() === '' || prompt.trim() === '' || act.blocked}
          >
            {t.startTask}
          </DyButton>
          {started !== null ? (
            <span className="flex items-center gap-2 text-[0.875rem]" data-testid="machine-task-started">
              <DyIcon name="checkc" className="size-4 text-dy-green" />
              {t.started}
              <ThreadLink target={{ kind: 'job', id: started }} about={t.taskLink} />
            </span>
          ) : null}
        </FormActions>
        <DyApiError error={act.error} retryLeft={act.retryLeft} />
      </form>
    </Panel>
  );
}

function Commands(props: { readonly data: MachineAdminView }): ReactNode {
  const d = props.data;
  const [detail, setDetail] = useState<AdminCommandDetail | null>(null);
  const act = useSubmit();
  const all = useT().machineAdmin;
  const t = all.admin;
  const ago = useAgo();
  return (
    <Panel
      title={t.commandsTitle}
      count={d.commands.length === 0 ? undefined : String(d.commands.length)}
      flush
      testId="admin-commands-panel"
    >
      {d.commands.length === 0 ? (
        <EmptyLine>{t.commandsNone}</EmptyLine>
      ) : (
        <Rows label={t.commandsLabel} testId="admin-commands">
          {d.commands.map((c) => {
            const s = CMD_STATE[c.state];
            return (
              <Row
                key={c.requestId}
                testId="admin-command"
                tone={s.tone}
                lead={<DyIcon name={s.icon} className="size-4" />}
                title={
                  <span className="grid gap-0.5">
                    {c.purpose === undefined || c.purpose === null ? null : (
                      <Purpose text={c.purpose} label={t.purpose} />
                    )}
                    <span className="font-dy-mono text-[0.84375rem] break-all">{c.summary}</span>
                  </span>
                }
                meta={
                  <>
                    <span data-state={c.state} className="font-bold">
                      {t.cmdState[c.state]}
                    </span>
                    <span>{kindText(t, c.kind)}</span>
                    {c.autoApproved ? (
                      <Pill tone="red" icon="shield">
                        {t.autoApproved}
                      </Pill>
                    ) : null}
                    {c.reason !== null && c.state !== 'succeeded' ? (
                      <span className="font-dy-mono" data-testid="admin-command-reason">
                        {c.reason}
                      </span>
                    ) : null}
                    {c.exitCode !== null ? (
                      <span className="font-dy-mono">{t.exitCode({ code: c.exitCode })}</span>
                    ) : null}
                    <span>{ago(c.createdAt)}</span>
                  </>
                }
                actions={
                  <DyButton
                    variant="ghost"
                    busy={act.busy}
                    aria-label={t.commandDetails({ summary: c.summary })}
                    onClick={() => {
                      void act.run(async () => {
                        setDetail(await getAdminCommand(d.workerId, c.requestId));
                      });
                    }}
                  >
                    {all.details}
                  </DyButton>
                }
              />
            );
          })}
        </Rows>
      )}
      {detail !== null ? (
        <div
          className="flex flex-col gap-2 border-t border-dy-line px-4 py-3"
          data-testid="admin-command-detail"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold">{kindText(t, detail.kind)}</span>
            <ThreadLink target={{ kind: 'job', id: detail.jobId }} about={t.commandJob} />
            <DyButton
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                setDetail(null);
              }}
            >
              {all.close}
            </DyButton>
          </div>
          {detail.purpose === undefined || detail.purpose === null ? null : (
            <Purpose text={detail.purpose} label={t.purpose} />
          )}
          <pre className="m-0 max-h-48 overflow-auto rounded-[9px] bg-dy-sunk px-3 py-2 font-dy-mono text-[0.78125rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {JSON.stringify(detail.op, null, 2)}
          </pre>
          {detail.file !== null ? (
            <p className="m-0 font-dy-mono text-[0.78125rem] break-all text-dy-muted">
              {t.fileLine({
                path: detail.file.path,
                bytes: detail.file.bytes,
                before: detail.file.sha256Before,
                after: detail.file.sha256After,
              })}
            </p>
          ) : null}
          <h3 className="m-0 text-[0.8125rem] font-bold">{t.output}</h3>
          <pre
            className="m-0 max-h-60 overflow-auto rounded-[9px] bg-dy-cmd-bg px-3 py-2 font-dy-mono text-[0.78125rem] whitespace-pre-wrap text-dy-cmd-ink [overflow-wrap:anywhere]"
            data-testid="admin-command-output"
          >
            {detail.output}
            {detail.truncated ? `\n${t.truncated}` : ''}
          </pre>
        </div>
      ) : null}
      <DyApiError error={act.error} retryLeft={act.retryLeft} className="px-4 pb-3" />
    </Panel>
  );
}

function Memory(props: { readonly data: MachineAdminView; readonly onSaved: () => void }): ReactNode {
  const fmt = useFormat();
  const all = useT().machineAdmin;
  const t = all.admin;
  const ago = useAgo();
  const m = props.data.memory;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  const act = useSubmit();
  const guarded = useGuardedValue();
  useEffect(() => {
    if (!editing) setText(m.content);
  }, [m.content, editing]);

  return (
    <Panel
      title={t.memoryTitle}
      count={m.updatedAt === null ? undefined : ago(m.updatedAt)}
      countLabel={
        m.updatedAt === null
          ? undefined
          : t.memoryUpdated({ at: fmt.dateWith(m.updatedAt, DATE_TIME_NUMERIC) })
      }
      sub={t.memorySub}
      testId="machine-memory"
    >
      {editing ? (
        <div className="flex flex-col gap-3">
          <DyTextarea label={t.memoryTitle} value={text} rows={8} maxLength={65536} mono onChange={setText} />
          <FormActions>
            <DyButton
              variant="primary"
              busy={act.busy}
              disabled={act.blocked}
              onClick={() => {
                void act.run(async () => {
                  const saved = await guarded(
                    () =>
                      saveMachineMemory(props.data.workerId, { content: text, expectedVersion: m.version }),
                    t.memoryWhy,
                  );
                  if (saved !== null) {
                    setEditing(false);
                    props.onSaved();
                  }
                });
              }}
            >
              {t.memorySave}
            </DyButton>
            <DyButton
              variant="ghost"
              onClick={() => {
                setEditing(false);
              }}
            >
              {all.cancel}
            </DyButton>
          </FormActions>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <pre
            className="m-0 max-h-60 overflow-auto rounded-[9px] border border-dy-line bg-dy-sunk px-3 py-2 font-dy-mono text-[0.8125rem] whitespace-pre-wrap [overflow-wrap:anywhere]"
            data-testid="machine-memory-content"
          >
            {m.content === '' ? t.memoryEmpty : m.content}
          </pre>
          <div>
            <DyButton
              icon="pen"
              onClick={() => {
                setEditing(true);
              }}
            >
              {t.memoryEdit}
            </DyButton>
          </div>
        </div>
      )}
      <DyApiError error={act.error} retryLeft={act.retryLeft} className="mt-3" />
    </Panel>
  );
}
