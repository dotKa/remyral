import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../../api/client';
import type { Project } from '../../../api/directory';
import { listCredentials, type CredentialView } from '../../../api/vault';
import { duplicateWorkflow } from '../../../api/workflowDefs';
import {
  acceptAttachmentVersion,
  type Attachment,
  type AttachmentOverrides,
  type AttachReport,
  attachWorkflow,
  bindAttachmentSlot,
  detachAttachment,
  getAttachment,
  getSharing,
  listOffers,
  type Offer,
  setSharing,
  unbindAttachmentSlot,
  updateAttachment,
  whereUsed,
  type WhereUsed,
} from '../../../api/workflowSharing';
import { toApiError } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { useNow } from '../../../lib/now';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { runLook } from '../jobs/WorkflowRuns';
import { DyApiError, DyCheck, DyChoice, DyConfirm, DyDialog, DyFieldset, DyInput, DyNotice } from '../kit';
import { DyButton, Pill } from '../parts';
import { agoIn, type Doc, isAiNode, WORKFLOW_NAME } from './model';

/**
 * p18-multi-project W1 + W2 (docs/design/p18-multi-project.md §5 Panel): the dialogs of shared workflows.
 * - {@link ShareDialog} (owner project): "Paylaş" — offer to every project or listed ones — and "Nerede kullanılıyor".
 * - {@link OffersDialog} (target project): "Paylaşılan workflow ekle" — the offers to a project, attach one.
 * - {@link AttachmentDialog} (target project): "Bu projedeki ayarlar" — enable / disable, follow / pin, a pending
 *   version to accept, credential slots, overrides; detach.
 * - {@link CopyToProjectDialog}: "Projeye kopyala" — the target's own copy under a new name.
 * The master decides every permission (project admin; step-up as asked); the dialogs say what it answered.
 */

const RANK: Readonly<Record<string, number>> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export function isProjectAdmin(projects: readonly Project[] | null, project: string): boolean {
  const p = projects?.find((x) => x.id === project);
  return p !== undefined && (RANK[p.myRole] ?? 0) >= 2;
}

/** Runs `fn` with the step-up prompt; a cancelled prompt is no error. */
async function withStepUp<T>(
  stepUp: ReturnType<typeof useStepUp>,
  fn: () => Promise<T>,
  why: string,
): Promise<T | null> {
  try {
    return await stepUp.run(fn, why);
  } catch (err) {
    if (err instanceof StepUpCancelledError) return null;
    throw err;
  }
}

// ------------------------------------------------------------------------------------------------ owner: share

function UsedList(props: { readonly used: WhereUsed | null; readonly error: ApiError | null }): ReactNode {
  const t = useT();
  const s = t.workflowSharing.used;
  const now = useNow();
  if (props.used === null)
    return props.error === null ? <p className="m-0 text-[0.875rem] text-dy-muted">{s.loading}</p> : null;
  return (
    <div className="grid gap-2" data-testid="workflow-where-used">
      {props.used.attachments.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{s.none}</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {props.used.attachments.map((a) => {
            const look = a.lastRun === null ? null : runLook(a.lastRun.state, t);
            return (
              <li
                key={a.id}
                className="grid gap-1 rounded-[12px] border border-dy-line p-3 text-[0.8125rem]"
                data-testid="workflow-used-row"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-dy-mono font-bold">{a.project}</span>
                  <Pill tone="neutral">{`v${String(a.version)}`}</Pill>
                  <Pill tone={a.follow === 'auto' ? 'teal' : 'neutral'}>{s.follow[a.follow]}</Pill>
                  <Pill tone={a.state === 'enabled' ? 'green' : 'neutral'}>{s.state[a.state]}</Pill>
                  {a.pendingVersion === null ? null : (
                    <Pill tone="amber">{s.pending({ version: a.pendingVersion })}</Pill>
                  )}
                </span>
                <span className="text-dy-muted">
                  {a.lastRun === null || look === null
                    ? s.neverRan
                    : s.lastRun({
                        state: look.label,
                        ago: agoIn(t.workflows.time, a.lastRun.createdAt, now),
                      })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {props.used.hidden > 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{s.hidden({ n: props.used.hidden })}</p>
      ) : null}
    </div>
  );
}

export function ShareDialog(props: {
  readonly open: boolean;
  readonly workflowId: string;
  readonly ownerProject: string;
  readonly projects: readonly Project[];
  /** The caller administers the owner project (may change the offer). */
  readonly canShare: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().workflowSharing;
  const s = t.share;
  const stepUp = useStepUp();
  const act = useSubmit();
  const [mode, setMode] = useState<'none' | 'all' | 'selected'>('none');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [used, setUsed] = useState<WhereUsed | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { open, workflowId } = props;

  const load = useCallback(() => {
    getSharing(workflowId).then(
      (sh) => {
        setMode(sh.projects.includes('*') ? 'all' : sh.projects.length > 0 ? 'selected' : 'none');
        setChosen(new Set(sh.projects.filter((p) => p !== '*')));
        setError(null);
      },
      (err: unknown) => {
        setError(toApiError(err));
      },
    );
    whereUsed(workflowId).then(setUsed, (err: unknown) => {
      setError(toApiError(err));
    });
  }, [workflowId]);
  useEffect(() => {
    if (!open) return;
    setDone(null);
    setUsed(null);
    load();
  }, [open, load]);

  const others = props.projects.filter((p) => p.id !== props.ownerProject);
  const save = (): void => {
    setDone(null);
    const projects = mode === 'all' ? ['*'] : mode === 'selected' ? [...chosen].sort() : [];
    void act
      .run(async () => {
        const r = await withStepUp(stepUp, () => setSharing(workflowId, projects), s.stepUp);
        if (r !== null) {
          setDone(s.saved);
          load();
        }
      })
      .then(() => undefined);
  };

  return (
    <DyDialog
      open={open}
      onClose={props.onClose}
      title={s.title}
      description={s.sub}
      size="md"
      testId="workflow-share"
      footer={
        <>
          <DyButton onClick={props.onClose}>{t.copy.cancel}</DyButton>
          {props.canShare ? (
            <DyButton
              variant="primary"
              icon="check"
              busy={act.busy}
              disabled={act.blocked || (mode === 'selected' && chosen.size === 0)}
              data-testid="workflow-share-save"
              onClick={save}
            >
              {s.save}
            </DyButton>
          ) : null}
        </>
      }
    >
      <div className="grid gap-4">
        <DyApiError error={error ?? act.error} retryLeft={act.retryLeft} />
        {done === null ? null : (
          <DyNotice tone="green" live testId="workflow-share-done">
            {done}
          </DyNotice>
        )}
        {props.canShare ? null : <DyNotice tone="neutral">{s.noPermission}</DyNotice>}
        <DyChoice
          label={s.projects}
          value={mode}
          disabled={!props.canShare}
          options={[
            ['none', s.none],
            ['all', s.all],
            ['selected', s.selected],
          ]}
          onChange={(v) => {
            setMode(v === 'all' || v === 'selected' ? v : 'none');
          }}
        />
        {mode !== 'selected' ? null : others.length === 0 ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{s.noOtherProjects}</p>
        ) : (
          <div className="grid gap-2" data-testid="workflow-share-projects">
            {others.map((p) => (
              <DyCheck
                key={p.id}
                label={p.name === p.id ? p.id : `${p.name} (${p.id})`}
                checked={chosen.has(p.id)}
                disabled={!props.canShare}
                onChange={(on) => {
                  const next = new Set(chosen);
                  if (on) next.add(p.id);
                  else next.delete(p.id);
                  setChosen(next);
                }}
              />
            ))}
          </div>
        )}
        <p className="m-0 text-[0.8125rem] text-dy-muted">{s.withdrawNote}</p>
        <DyFieldset legend={t.used.title}>
          <UsedList used={used} error={error} />
        </DyFieldset>
      </div>
    </DyDialog>
  );
}

// ------------------------------------------------------------------------------------------------ target: offers

export function OffersDialog(props: {
  readonly open: boolean;
  /** Projects the caller administers (attach targets). */
  readonly projects: readonly Project[];
  readonly initialProject: string;
  readonly onClose: () => void;
  readonly onAttached: (a: Attachment) => void;
}): ReactNode {
  const t = useT().workflowSharing;
  const o = t.offers;
  const stepUp = useStepUp();
  const act = useSubmit();
  const [project, setProject] = useState(props.initialProject);
  const [offers, setOffers] = useState<readonly Offer[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { open } = props;

  useEffect(() => {
    if (open) setProject((p) => (p === '' ? props.initialProject : p));
  }, [open, props.initialProject]);
  const load = useCallback(() => {
    if (project === '') return;
    setOffers(null);
    listOffers(project).then(
      (x) => {
        setOffers(x);
        setError(null);
      },
      (err: unknown) => {
        setError(toApiError(err));
        setOffers([]);
      },
    );
  }, [project]);
  useEffect(() => {
    if (!open) return;
    setNotice(null);
    load();
  }, [open, load]);

  const attach = (offer: Offer): void => {
    setNotice(null);
    void act
      .run(async () => {
        const r = await withStepUp(
          stepUp,
          () => attachWorkflow(project, { ownerProject: offer.ownerProject, name: offer.name }),
          o.stepUp,
        );
        if (r === null) return;
        setNotice(
          r.report.credentialUnbound.length > 0
            ? o.disabledNotice({ slots: r.report.credentialUnbound.join(', ') })
            : o.attachedNotice({ name: offer.name }),
        );
        props.onAttached(r.attachment);
        load();
      })
      .then(() => undefined);
  };

  return (
    <DyDialog
      open={open}
      onClose={props.onClose}
      title={o.title}
      description={o.sub}
      size="md"
      testId="workflow-offers"
      footer={<DyButton onClick={props.onClose}>{t.copy.cancel}</DyButton>}
    >
      <div className="grid gap-3">
        {props.projects.length === 0 ? (
          <DyNotice tone="neutral">{o.noAdmin}</DyNotice>
        ) : (
          <DyChoice
            label={o.project}
            value={project}
            options={props.projects.map((p) => [p.id, p.id] as const)}
            onChange={setProject}
          />
        )}
        <DyApiError error={error ?? act.error} retryLeft={act.retryLeft} />
        {notice === null ? null : (
          <DyNotice tone="green" live testId="workflow-offers-done">
            {notice}
          </DyNotice>
        )}
        {project === '' ? null : offers === null ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{o.loading}</p>
        ) : offers.length === 0 ? (
          <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="workflow-offers-none">
            {o.none}
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0" data-testid="workflow-offers-list">
            {offers.map((f) => (
              <li
                key={`${f.ownerProject}/${f.name}`}
                className="flex flex-wrap items-center gap-2 rounded-[12px] border border-dy-line p-3"
                data-testid="workflow-offer"
              >
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="font-dy-mono font-bold">{f.name}</span>
                  <span className="text-[0.8125rem] text-dy-muted">
                    {o.from({ owner: f.ownerProject, version: f.latestVersion, n: f.nodes })}
                  </span>
                  {f.description === null ? null : (
                    <span className="truncate text-[0.8125rem] text-dy-muted">{f.description}</span>
                  )}
                  {f.nameTaken && !f.attached ? (
                    <span className="text-[0.8125rem] text-dy-amber-ink">{o.nameTaken}</span>
                  ) : null}
                </span>
                {f.attached ? (
                  <Pill tone="green">{o.attached}</Pill>
                ) : (
                  <DyButton
                    variant="primary"
                    icon="plus"
                    busy={act.busy}
                    disabled={act.blocked || f.nameTaken}
                    aria-label={o.attachAria({ name: f.name })}
                    onClick={() => {
                      attach(f);
                    }}
                  >
                    {o.attach}
                  </DyButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </DyDialog>
  );
}

// ------------------------------------------------------------------------------------------------ target: settings

type Role = 'operator' | 'admin' | 'owner';
const ROLES: readonly Role[] = ['operator', 'admin', 'owner'];

interface Draft {
  inputs: Record<string, string>;
  approvers: Record<string, string>;
  triggers: Record<string, { cron: string; timeZone: string; repository: string }>;
  onFailure: string;
  retention: string;
  concurrency: string;
  repoUrl: string;
  baseRef: string;
}

function draftOf(o: AttachmentOverrides): Draft {
  const triggers: Draft['triggers'] = {};
  for (const [k, v] of Object.entries(o.triggers ?? {}))
    triggers[k] = { cron: v.cron ?? '', timeZone: v.timeZone ?? '', repository: v.repository ?? '' };
  return {
    inputs: { ...(o.inputs ?? {}) },
    approvers: { ...(o.approvers ?? {}) },
    triggers,
    onFailure: o.onFailure?.workflow ?? '',
    retention: o.retentionDays === undefined ? '' : String(o.retentionDays),
    concurrency: o.concurrency === undefined ? '' : String(o.concurrency.max),
    repoUrl: o.repository?.url ?? '',
    baseRef: o.repository?.baseRef ?? '',
  };
}

function overridesOf(d: Draft): AttachmentOverrides {
  const inputs = Object.fromEntries(Object.entries(d.inputs).filter(([, v]) => v.trim() !== ''));
  const approvers = Object.fromEntries(
    Object.entries(d.approvers).filter(([, v]) => (ROLES as readonly string[]).includes(v)),
  ) as Record<string, Role>;
  const triggers: Record<string, { cron?: string; timeZone?: string; repository?: string }> = {};
  for (const [k, v] of Object.entries(d.triggers)) {
    const entry = {
      ...(v.cron.trim() === '' ? {} : { cron: v.cron.trim() }),
      ...(v.timeZone.trim() === '' ? {} : { timeZone: v.timeZone.trim() }),
      ...(v.repository.trim() === '' ? {} : { repository: v.repository.trim() }),
    };
    if (Object.keys(entry).length > 0) triggers[k] = entry;
  }
  const n = (x: string): number | null => (x.trim() === '' || !Number.isFinite(Number(x)) ? null : Number(x));
  const retention = n(d.retention);
  const concurrency = n(d.concurrency);
  return {
    ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
    ...(Object.keys(approvers).length === 0 ? {} : { approvers }),
    ...(Object.keys(triggers).length === 0 ? {} : { triggers }),
    ...(d.onFailure.trim() === '' ? {} : { onFailure: { workflow: d.onFailure.trim() } }),
    ...(retention === null ? {} : { retentionDays: retention }),
    ...(concurrency === null ? {} : { concurrency: { max: concurrency } }),
    ...(d.repoUrl.trim() === ''
      ? {}
      : {
          repository: { url: d.repoUrl.trim(), baseRef: d.baseRef.trim() === '' ? 'main' : d.baseRef.trim() },
        }),
  };
}

/** The definition's gate nodes with their role, trigger nodes by type and the concurrency limit. */
function docFacts(doc: Doc): {
  gates: { id: string; role: string }[];
  schedules: string[];
  github: string[];
  concurrency: number | null;
} {
  const gates: { id: string; role: string }[] = [];
  const schedules: string[] = [];
  const github: string[] = [];
  for (const n of doc.nodes) {
    if (isAiNode(n)) {
      const approval = (n as { approval?: { approverRole?: string } }).approval;
      if (approval !== undefined) gates.push({ id: n.id, role: approval.approverRole ?? 'admin' });
      continue;
    }
    if (n.type === 'control.approval') {
      const role = n.config.approverRole;
      gates.push({ id: n.id, role: typeof role === 'string' ? role : 'admin' });
    } else if (n.type === 'trigger.schedule') schedules.push(n.id);
    else if (n.type === 'trigger.github') github.push(n.id);
  }
  const settings = doc.settings as { concurrency?: { max?: unknown } } | undefined;
  const max = settings?.concurrency?.max;
  return { gates, schedules, github, concurrency: typeof max === 'number' ? max : null };
}

export function AttachmentDialog(props: {
  readonly open: boolean;
  readonly attachmentId: string;
  /** The version's document (the editor's canvas): inputs, gates, triggers. */
  readonly doc: Doc;
  /** The caller administers the attaching project. */
  readonly canManage: boolean;
  readonly onClose: () => void;
  /** Something changed (version, state): the caller reloads. */
  readonly onChanged: (a: Attachment) => void;
  readonly onDetached: () => void;
  readonly onCopy: () => void;
}): ReactNode {
  const t = useT();
  const s = t.workflowSharing.attachment;
  const stepUp = useStepUp();
  const act = useSubmit();
  const [view, setView] = useState<{ attachment: Attachment; report: AttachReport } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<readonly CredentialView[] | null>(null);
  const [picked, setPicked] = useState<Readonly<Record<string, string>>>({});
  const [target, setTarget] = useState('');
  const now = useNow();
  const { open, attachmentId } = props;
  const facts = useMemo(() => docFacts(props.doc), [props.doc]);

  const show = useCallback((v: { attachment: Attachment; report: AttachReport }) => {
    setView(v);
    setDraft(draftOf(v.attachment.overrides));
    setError(null);
  }, []);
  const load = useCallback(() => {
    getAttachment(attachmentId).then(show, (err: unknown) => {
      setError(toApiError(err));
    });
  }, [attachmentId, show]);
  useEffect(() => {
    if (!open) return;
    setNotice(null);
    load();
    if (props.canManage)
      listCredentials().then(setCredentials, () => {
        setCredentials([]);
      });
  }, [open, load, props.canManage]);

  const change = (
    fn: () => Promise<{ attachment: Attachment; report: AttachReport } | null>,
    ok: string,
  ): void => {
    setNotice(null);
    void act
      .run(async () => {
        const r = await fn();
        if (r === null) return;
        show(r);
        setNotice(ok);
        props.onChanged(r.attachment);
      })
      .then(() => undefined);
  };

  const a = view?.attachment ?? null;
  const report = view?.report ?? null;
  const disabled = !props.canManage || act.blocked;
  const versions = a === null ? [] : Array.from({ length: a.latestVersion }, (_x, i) => a.latestVersion - i);
  return (
    <DyDialog
      open={open}
      onClose={props.onClose}
      title={s.title}
      description={a === null ? undefined : s.sub({ owner: a.ownerProject, project: a.project })}
      size="lg"
      testId="workflow-attachment"
      backdropClose={false}
      footer={
        <>
          <DyButton onClick={props.onCopy} icon="copy">
            {s.copy}
          </DyButton>
          {props.canManage && a !== null ? (
            <DyConfirm
              label={s.detach}
              confirmLabel={s.detachConfirm}
              question={s.detachQuestion}
              variant="danger"
              icon="trash"
              testId="workflow-attachment-detach"
              busy={act.busy}
              onConfirm={() => {
                void act
                  .run(async () => {
                    await detachAttachment(a.id);
                    props.onDetached();
                  })
                  .then(() => undefined);
              }}
            />
          ) : null}
          {props.canManage && draft !== null ? (
            <DyButton
              variant="primary"
              icon="check"
              busy={act.busy}
              disabled={disabled}
              data-testid="workflow-attachment-save"
              onClick={() => {
                change(() => updateAttachment(attachmentId, { overrides: overridesOf(draft) }), s.saved);
              }}
            >
              {s.save}
            </DyButton>
          ) : null}
        </>
      }
    >
      <div className="grid gap-5">
        <DyApiError error={error ?? act.error} retryLeft={act.retryLeft} />
        {notice === null ? null : (
          <DyNotice tone="green" live testId="workflow-attachment-done">
            {notice}
          </DyNotice>
        )}
        {props.canManage ? null : <DyNotice tone="neutral">{s.noPermission}</DyNotice>}
        {a === null || draft === null || report === null ? (
          error === null ? (
            <p className="m-0 text-[0.875rem] text-dy-muted">{s.loading}</p>
          ) : null
        ) : (
          <>
            {a.ownerArchived ? <DyNotice tone="amber">{s.ownerArchived}</DyNotice> : null}
            {a.offered ? null : <DyNotice tone="neutral">{s.notOffered}</DyNotice>}
            {report.repository === 'missing' ? (
              <DyNotice tone="amber">{s.report.repositoryMissing}</DyNotice>
            ) : null}
            {report.egress.length > 0 ? (
              <DyNotice tone="amber">{s.report.egress({ n: report.egress.length })}</DyNotice>
            ) : null}
            {report.credentialUnbound.length > 0 ? (
              <DyNotice tone="amber" testId="workflow-attachment-unbound">
                {s.report.unbound({ slots: report.credentialUnbound.join(', ') })}
              </DyNotice>
            ) : null}
            {report.privileged.length > 0 ? (
              <p className="m-0 text-[0.8125rem] text-dy-muted">
                {s.report.privileged({ nodes: report.privileged.map((p) => p.node).join(', ') })}
              </p>
            ) : null}

            <DyFieldset legend={s.state}>
              <span className="flex flex-wrap items-center gap-2">
                <Pill tone={a.state === 'enabled' ? 'green' : 'neutral'}>
                  {a.state === 'enabled' ? s.enabled : s.disabled}
                </Pill>
                {props.canManage ? (
                  <DyButton
                    icon={a.state === 'enabled' ? 'pause' : 'check'}
                    busy={act.busy}
                    disabled={disabled}
                    data-testid="workflow-attachment-state"
                    onClick={() => {
                      change(
                        () =>
                          updateAttachment(a.id, { state: a.state === 'enabled' ? 'disabled' : 'enabled' }),
                        a.state === 'enabled' ? s.disabled : s.enabled,
                      );
                    }}
                  >
                    {a.state === 'enabled' ? s.disable : s.enable}
                  </DyButton>
                ) : null}
              </span>
            </DyFieldset>

            <DyFieldset legend={s.version} sub={s.runs({ version: a.version, latest: a.latestVersion })}>
              <DyChoice
                label={s.follow}
                value={a.follow}
                disabled={disabled}
                options={[
                  ['auto', s.followAuto],
                  ['pin', s.followPin],
                ]}
                onChange={(v) => {
                  change(() => updateAttachment(a.id, { follow: v === 'pin' ? 'pin' : 'auto' }), s.saved);
                }}
              />
              {a.pendingVersion === null ? null : (
                <DyNotice tone="amber" testId="workflow-attachment-pending">
                  <span className="grid gap-2">
                    <span>{s.pending({ version: a.pendingVersion })}</span>
                    {a.pendingReason === null ? null : (
                      <span>
                        {(s.pendingReason as Readonly<Record<string, string | undefined>>)[a.pendingReason] ??
                          a.pendingReason}
                      </span>
                    )}
                    {props.canManage ? (
                      <span>
                        <DyButton
                          variant="primary"
                          icon="check"
                          busy={act.busy}
                          disabled={disabled}
                          data-testid="workflow-attachment-accept"
                          onClick={() => {
                            const v = a.pendingVersion ?? a.version;
                            change(
                              () =>
                                withStepUp(stepUp, () => acceptAttachmentVersion(a.id, v), s.acceptStepUp),
                              s.saved,
                            );
                          }}
                        >
                          {s.accept({ version: a.pendingVersion })}
                        </DyButton>
                      </span>
                    ) : null}
                  </span>
                </DyNotice>
              )}
              {props.canManage && a.follow === 'pin' ? (
                <span className="flex flex-wrap items-end gap-2">
                  <DyChoice
                    label={s.switchTo}
                    value={target === '' ? String(a.version) : target}
                    options={versions.map((v) => [String(v), s.switchVersion({ version: v })] as const)}
                    onChange={setTarget}
                  />
                  <DyButton
                    busy={act.busy}
                    disabled={disabled || target === '' || Number(target) === a.version}
                    onClick={() => {
                      const v = Number(target);
                      change(
                        () => withStepUp(stepUp, () => acceptAttachmentVersion(a.id, v), s.acceptStepUp),
                        s.saved,
                      );
                    }}
                  >
                    {s.switch}
                  </DyButton>
                </span>
              ) : null}
            </DyFieldset>

            {a.slots.length === 0 ? null : (
              <DyFieldset legend={s.slots} sub={s.slotsSub}>
                <ul className="m-0 grid list-none gap-2 p-0" data-testid="workflow-attachment-slots">
                  {a.slots.map((slot) => {
                    const options = (credentials ?? []).filter(
                      (c) => c.state === 'active' && c.kind === slot.kind,
                    );
                    const choice = picked[slot.slot] ?? options[0]?.id ?? '';
                    return (
                      <li
                        key={slot.slot}
                        className="grid gap-2 rounded-[12px] border border-dy-line p-3 text-[0.8125rem]"
                        data-testid="workflow-attachment-slot"
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-dy-mono font-bold">{slot.slot}</span>
                          <Pill tone={slot.credentialId === null ? 'amber' : 'green'}>
                            {slot.credentialId === null ? s.unbound : s.bound({ id: slot.credentialId })}
                          </Pill>
                        </span>
                        <span className="text-dy-muted">
                          {s.slotHosts({
                            kind: slot.kind,
                            hosts: slot.hosts.join(', '),
                            nodes: slot.nodes.join(', '),
                          })}
                        </span>
                        {props.canManage ? (
                          <span className="flex flex-wrap items-end gap-2">
                            {options.length > 0 ? (
                              <DyChoice
                                label={s.credential}
                                value={choice}
                                options={options.map((c) => [c.id, `${c.name} (${c.id})`] as const)}
                                onChange={(v) => {
                                  setPicked({ ...picked, [slot.slot]: v });
                                }}
                              />
                            ) : (
                              <DyInput
                                label={s.credential}
                                value={picked[slot.slot] ?? ''}
                                placeholder={s.pick}
                                autoComplete="off"
                                spellCheck={false}
                                onChange={(e) => {
                                  setPicked({ ...picked, [slot.slot]: e.target.value.trim() });
                                }}
                              />
                            )}
                            <DyButton
                              variant="primary"
                              busy={act.busy}
                              disabled={disabled || choice === ''}
                              onClick={() => {
                                change(
                                  () =>
                                    withStepUp(
                                      stepUp,
                                      () => bindAttachmentSlot(a.id, slot.slot, choice),
                                      s.bindStepUp,
                                    ),
                                  s.saved,
                                );
                              }}
                            >
                              {s.bind}
                            </DyButton>
                            {slot.credentialId === null ? null : (
                              <DyButton
                                variant="danger"
                                busy={act.busy}
                                disabled={disabled}
                                onClick={() => {
                                  change(
                                    () =>
                                      withStepUp(
                                        stepUp,
                                        () => unbindAttachmentSlot(a.id, slot.slot),
                                        s.bindStepUp,
                                      ),
                                    s.saved,
                                  );
                                }}
                              >
                                {s.unbind}
                              </DyButton>
                            )}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </DyFieldset>
            )}

            <DyFieldset legend={s.settings}>
              {Object.keys(props.doc.inputs).length === 0 ? null : (
                <DyFieldset legend={s.inputs} sub={s.inputsHint}>
                  {Object.keys(props.doc.inputs).map((name) => (
                    <DyInput
                      key={name}
                      label={name}
                      value={draft.inputs[name] ?? ''}
                      disabled={disabled}
                      onChange={(e) => {
                        setDraft({ ...draft, inputs: { ...draft.inputs, [name]: e.target.value } });
                      }}
                    />
                  ))}
                </DyFieldset>
              )}
              {facts.gates.length === 0 ? null : (
                <DyFieldset legend={s.approvers} sub={s.approversHint}>
                  {facts.gates.map((g) => (
                    <DyChoice
                      key={g.id}
                      label={s.approverOf({ node: g.id })}
                      value={draft.approvers[g.id] ?? ''}
                      disabled={disabled}
                      options={[
                        [
                          '',
                          s.asDefined({
                            role: (s.roles as Readonly<Record<string, string>>)[g.role] ?? g.role,
                          }),
                        ],
                        ...ROLES.filter((r) => (RANK[r] ?? 0) > (RANK[g.role] ?? 0)).map(
                          (r) => [r, s.roles[r]] as const,
                        ),
                      ]}
                      onChange={(v) => {
                        setDraft({ ...draft, approvers: { ...draft.approvers, [g.id]: v } });
                      }}
                    />
                  ))}
                </DyFieldset>
              )}
              {facts.schedules.length + facts.github.length === 0 ? null : (
                <DyFieldset legend={s.triggers} sub={s.triggersHint}>
                  {facts.schedules.map((id) => {
                    const v = draft.triggers[id] ?? { cron: '', timeZone: '', repository: '' };
                    return (
                      <span key={id} className="grid gap-2 sm:grid-cols-2">
                        <DyInput
                          label={s.cron({ node: id })}
                          value={v.cron}
                          disabled={disabled}
                          spellCheck={false}
                          onChange={(e) => {
                            setDraft({
                              ...draft,
                              triggers: { ...draft.triggers, [id]: { ...v, cron: e.target.value } },
                            });
                          }}
                        />
                        <DyInput
                          label={s.timeZone({ node: id })}
                          value={v.timeZone}
                          disabled={disabled}
                          spellCheck={false}
                          onChange={(e) => {
                            setDraft({
                              ...draft,
                              triggers: { ...draft.triggers, [id]: { ...v, timeZone: e.target.value } },
                            });
                          }}
                        />
                      </span>
                    );
                  })}
                  {facts.github.map((id) => {
                    const v = draft.triggers[id] ?? { cron: '', timeZone: '', repository: '' };
                    return (
                      <DyInput
                        key={id}
                        label={s.githubRepo({ node: id })}
                        value={v.repository}
                        disabled={disabled}
                        spellCheck={false}
                        onChange={(e) => {
                          setDraft({
                            ...draft,
                            triggers: { ...draft.triggers, [id]: { ...v, repository: e.target.value } },
                          });
                        }}
                      />
                    );
                  })}
                </DyFieldset>
              )}
              <DyInput
                label={s.onFailure}
                hint={s.onFailureHint}
                value={draft.onFailure}
                disabled={disabled}
                spellCheck={false}
                onChange={(e) => {
                  setDraft({ ...draft, onFailure: e.target.value });
                }}
              />
              <span className="grid gap-3 sm:grid-cols-2">
                <DyInput
                  label={s.retention}
                  type="number"
                  min={1}
                  max={365}
                  value={draft.retention}
                  disabled={disabled}
                  onChange={(e) => {
                    setDraft({ ...draft, retention: e.target.value });
                  }}
                />
                {facts.concurrency === null ? null : (
                  <DyInput
                    label={s.concurrency}
                    hint={s.concurrencyHint({ max: facts.concurrency })}
                    type="number"
                    min={1}
                    max={facts.concurrency}
                    value={draft.concurrency}
                    disabled={disabled}
                    onChange={(e) => {
                      setDraft({ ...draft, concurrency: e.target.value });
                    }}
                  />
                )}
              </span>
              <span className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <DyInput
                  label={s.repository}
                  hint={s.repositoryHint}
                  value={draft.repoUrl}
                  disabled={disabled}
                  spellCheck={false}
                  onChange={(e) => {
                    setDraft({ ...draft, repoUrl: e.target.value });
                  }}
                />
                <DyInput
                  label={s.baseRef}
                  value={draft.baseRef}
                  disabled={disabled}
                  spellCheck={false}
                  onChange={(e) => {
                    setDraft({ ...draft, baseRef: e.target.value });
                  }}
                />
              </span>
            </DyFieldset>
            {a.lastRun === null ? null : (
              <Link
                to={`/jobs/workflows/${encodeURIComponent(a.lastRun.id)}`}
                className="text-[0.8125rem] text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
              >
                {t.workflows.list.lastRun({
                  state: runLook(a.lastRun.state, t).label,
                  ago: agoIn(t.workflows.time, a.lastRun.createdAt, now),
                })}
              </Link>
            )}
          </>
        )}
      </div>
    </DyDialog>
  );
}

// ------------------------------------------------------------------------------------------------ copy

export function CopyToProjectDialog(props: {
  readonly source: { readonly id: string; readonly name: string; readonly project: string } | null;
  readonly onClose: () => void;
  readonly onDone: (id: string) => void;
}): ReactNode {
  const t = useT();
  const c = t.workflowSharing.copy;
  const act = useSubmit();
  const stepUp = useStepUp();
  const [name, setName] = useState('');
  const src = props.source;
  const suffix = c.suffix;
  useEffect(() => {
    if (src !== null) setName(`${src.name}${suffix}`.slice(0, 64));
  }, [src, suffix]);
  const bad = !WORKFLOW_NAME.test(name);
  return (
    <DyDialog
      open={src !== null}
      onClose={props.onClose}
      size="sm"
      title={c.title}
      description={src === null ? undefined : c.description({ name: src.name, project: src.project })}
      testId="workflow-copy-to-project"
      footer={
        <>
          <DyButton variant="ghost" onClick={props.onClose}>
            {c.cancel}
          </DyButton>
          <DyButton
            variant="primary"
            icon="copy"
            busy={act.busy}
            disabled={bad || act.blocked}
            onClick={() => {
              if (src === null) return;
              let id = '';
              void act
                .run(async () => {
                  const r = await withStepUp(
                    stepUp,
                    () => duplicateWorkflow(src.id, name, src.project),
                    t.workflows.editor.stepUpSave,
                  );
                  if (r !== null) id = r.id;
                })
                .then((ok) => {
                  if (ok && id !== '') props.onDone(id);
                });
            }}
          >
            {c.copy}
          </DyButton>
        </>
      }
    >
      <DyInput
        label={c.name}
        value={name}
        maxLength={64}
        autoComplete="off"
        spellCheck={false}
        error={name !== '' && bad ? t.workflows.model.workflowNameInvalid : null}
        onChange={(e) => {
          setName(e.target.value.trim());
        }}
      />
      <DyApiError error={act.error} />
    </DyDialog>
  );
}
