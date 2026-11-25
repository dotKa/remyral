import { useErrorText } from '../../i18n/errors';
import { type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router';
import { APPROVAL_MODES } from '../../api/approvalMode';
import { type ChatDraft, confirmDraft, dismissDraft } from '../../api/chat';
import { PRIORITY_CLASSES, type PriorityClass } from '../../api/queue';
import { cx } from '../../components/ui';
import { draftApprovalPolicy, draftPriorityClass } from '../../screens/chat/drafts';
import { actionJobs } from '../../screens/chat/JobActionParts';
import { shortTime } from '../../screens/chat/time';
import { useRuntimeUsage } from '../../screens/usage/runtimeUsage';
import { isStepUpRequired } from '../../stepup/StepUpProvider';
import { limitLine } from '../compose/labels';
import { Seg } from '../compose/JobDraftCard';
import { Countdown } from '../Countdown';
import { DyNotice } from '../forms';
import { DyIcon } from '../icons';
import { KeyValue } from '../KeyValue';
import { CardButton, CardLink, LiveCard } from '../LiveCard';
import { DecisionPanel, useFreshStepUp } from '../ops/DecisionPanel';
import { JobTimeLimit } from '../common/timeLimit';
import { draftEvent } from './event';
import { useCardKeys } from '../ops/keys';
import { cardFor } from '../registry';
import { type DyState, StateBadge } from '../StateBadge';
import { OpsDiff } from './OpsDiff';
import { useHeldCard } from './held';
import {
  JobActionResults,
  JobApprovalMode,
  JobChecklist,
  JobQuickButtons,
  MemoryResult,
  resultLink,
  startedJob,
  TemporaryPassword,
  WebhookSecret,
} from './parts';
import {
  approvalHint,
  approvalLabel,
  classHint,
  classLabel,
  draftKindText,
  fullAccessOf,
  rec,
  roleText,
  summarizeDraft,
  workflowTriggerNote,
} from './summary';
import { issueLine, workflowDraftOf, WorkflowDraftGraph } from '../../screens/chat/workflowDraft';
import { DyCheck } from '../screens/forms';
import { McpInstallProgress } from '../screens/knowledge/McpInstall';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { nodeTypeText } from '../screens/workflows/nodeCatalog';
import { useChatActions } from '../chat/chatActions';
import type { Messages } from '@remyral/i18n';

/** p14-workflow-engine 14.5: where "Editörde aç" goes — the editor with the drafted document as the unsaved copy. */
export function draftEditorTarget(wf: {
  readonly project: string;
  readonly workflowId: string | null;
  readonly definition: Record<string, unknown> | null;
}): { readonly to: string; readonly state: { readonly draft: Record<string, unknown> } } | null {
  if (wf.definition === null) return null;
  const to =
    wf.workflowId === null
      ? `/workflows/new?project=${encodeURIComponent(wf.project)}`
      : `/workflows/${encodeURIComponent(wf.workflowId)}`;
  return { to, state: { draft: wf.definition } };
}

const PRIVILEGED_KEY: Readonly<Record<string, 'network' | 'code' | 'deploy'>> = {
  'workflows.define.network': 'network',
  'workflows.define.code': 'code',
  'workflows.define.deploy': 'deploy',
};

/**
 * p12-diyalog-w4 (docs/design/p12-diyalog.md §15.4): every chat draft kind as a native Diyalog card — what the
 * former classic chat card showed and did (its text helpers live on in screens/chat/drafts.tsx):
 * state; title; full-access and machine-administration marks with what they mean; the master's notes and warnings
 * (placement, approvals, policy); the facts, the rest behind "Ayrıntılar"; the job checklist of a job action (uncheck
 * to leave a job out); a skill's diff; a deploy / DNS / Pages change; the drafted runtime's limit line; the approval
 * mode and the queue class (changeable before confirming); Onayla with the authenticator code in the card, Vazgeç,
 * Formda düzenle, Şablon olarak kaydet; and after confirming the result: its link, per-job results, a memory
 * change's link, a webhook secret shown once, the quick buttons of a job it started and that job's approval mode.
 * Confirming calls the same endpoint with the same overrides; the master keeps every check (step-up, payload hash,
 * the person's own permissions).
 */

const DRAFT_STATE: Readonly<Record<string, DyState>> = {
  proposed: 'needs',
  confirmed: 'done',
  dismissed: 'cancelled',
  expired: 'stale',
};

const MACHINE_MODES: readonly string[] = ['ask-all', 'allow-all'];

type ChangeKind = keyof Messages['chatFlow']['edit']['changes'];
const CHANGE_KINDS = new Set<string>([
  'node_added',
  'node_removed',
  'node_changed',
  'edge_added',
  'edge_removed',
  'setting_changed',
]);

/**
 * p17-chat-flow item 4: what changed against the card this one replaced ("Sohbette düzenle"; the master compared the
 * two documents) — each change in words, the node / edge / setting names as they are.
 */
function WorkflowChanges(props: {
  readonly previous: Record<string, unknown>;
  /** p22-workflow-patch: `saved` = against the saved version this card follows (else: the card it replaced). */
  readonly against?: 'card' | 'saved';
  /** p22-workflow-patch: operations of a patch draft (only the changed steps were written). */
  readonly patchOps?: number | null;
}): ReactNode {
  const w = useT().chatFlow.edit;
  const saved = props.against === 'saved';
  const title = saved ? w.savedChangesTitle({ version: Number(props.previous.fromVersion) }) : w.changesTitle;
  const list = (Array.isArray(props.previous.changes) ? props.previous.changes : [])
    .map(rec)
    .filter((c) => typeof c.kind === 'string' && CHANGE_KINDS.has(c.kind) && typeof c.id === 'string');
  const line = (c: Record<string, unknown>): string => {
    const id = String(c.id);
    const kind = c.kind as ChangeKind;
    if (kind === 'node_changed') {
      const fields = Array.isArray(c.fields) ? c.fields.filter((x) => typeof x === 'string').join(', ') : '';
      return w.changes.node_changed({ id, fields });
    }
    return w.changes[kind]({ id });
  };
  return (
    <section
      className="grid min-w-0 gap-1"
      aria-label={title}
      data-testid={saved ? 'workflow-draft-version-changes' : 'workflow-draft-changes'}
    >
      <p className="m-0 flex items-center gap-1.5 text-[0.8125rem] font-bold text-dy-muted">
        <DyIcon name="file" className="size-3.5" />
        {title}
      </p>
      {props.patchOps === undefined || props.patchOps === null ? null : (
        <p className="m-0 text-[0.84375rem] text-dy-muted" data-testid="workflow-draft-patched">
          {w.patched({ count: props.patchOps })}
        </p>
      )}
      {list.length === 0 ? (
        <p className="m-0 text-[0.84375rem] text-dy-muted">{saved ? w.savedNoChanges : w.noChanges}</p>
      ) : (
        <ul className="m-0 list-disc pl-5 text-[0.84375rem]">
          {list.map((c, i) => (
            // Changes of one kind and id do not repeat; the index keeps the key unique anyway.
            <li key={`${String(c.kind)}:${String(c.id)}:${String(i)}`} className="[overflow-wrap:anywhere]">
              {line(c)}
            </li>
          ))}
          {props.previous.truncated === true ? <li>{w.more}</li> : null}
        </ul>
      )}
    </section>
  );
}

const LABEL = 'mb-[5px] block text-[0.8125rem] font-bold';
const SELECT =
  'min-h-11 w-full min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card px-[11px] text-base text-dy-ink outline-none focus:border-dy-teal disabled:opacity-60 sm:min-h-9 sm:w-auto sm:text-[0.9375rem]';

/** A skill's unified diff: added lines green, removed red (with a sign, never colour alone). */
function SkillDiff(props: { readonly diff: string }): ReactNode {
  const w = useT().drafts.skill;
  const lines = props.diff.split('\n');
  return (
    <section aria-label={w.diffRegion} className="grid gap-1.5">
      <p className="m-0 flex items-center gap-1.5 text-[0.8125rem] font-bold text-dy-muted">
        <DyIcon name="file" className="size-3.5" />
        {w.diffTitle}
      </p>
      <pre
        className="m-0 max-h-80 overflow-auto rounded-[10px] bg-dy-cmd px-3 py-2.5 font-dy-mono text-[0.78125rem] leading-[1.55] text-dy-cmd-ink"
        data-testid="skill-draft-diff"
        tabIndex={0}
      >
        {lines.map((l, i) => (
          <span
            // Diff lines repeat (blank lines, braces): the index is the identity.
            key={i}
            className={cx(
              'block whitespace-pre',
              l.startsWith('+') && !l.startsWith('+++') && 'bg-[rgb(29_122_76/0.28)]',
              l.startsWith('-') && !l.startsWith('---') && 'bg-[rgb(194_59_51/0.3)]',
              l.startsWith('@@') && 'text-[#7fd6d9]',
            )}
          >
            {l === '' ? ' ' : l}
          </span>
        ))}
      </pre>
    </section>
  );
}

function Pill(props: {
  readonly tone: 'red' | 'amber';
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <span
      data-testid={props.testId}
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-px text-[0.75rem] font-bold whitespace-nowrap',
        props.tone === 'red' ? 'bg-dy-red-soft text-dy-red-ink' : 'bg-dy-amber-soft text-dy-amber-ink',
      )}
    >
      <DyIcon name="shield" className="size-3" />
      {props.children}
    </span>
  );
}

/** The drafted runtime's usage-limit line (p11-limit-visibility), from the overview the rail reads. */
function RuntimeLimitLine(props: { readonly runtime: string }): ReactNode {
  const w = useT().drafts.card;
  const { data } = useRuntimeUsage();
  const line = limitLine(data, props.runtime);
  if (line === null) return null;
  return (
    <p
      className={cx(
        'm-0 text-[0.8125rem]',
        line.level === 'limited'
          ? 'text-dy-red-ink'
          : line.level === 'near'
            ? 'text-dy-violet'
            : 'text-dy-muted',
      )}
      data-testid="draft-runtime-limit"
    >
      <b className="font-bold">{w.usageLimit}</b>
      {line.text}
    </p>
  );
}

export function DyDraftCard(props: {
  readonly d: ChatDraft;
  readonly threadId: string;
  readonly onChanged: () => void;
}): ReactNode {
  const sayError = useErrorText();
  const t = useT();
  const f = useFormat();
  const w = t.drafts.card;
  const { d } = props;
  const summary = summarizeDraft(d, t, f);
  const spec = cardFor(`draft:${d.kind}`);
  const [result, setResult] = useState<Record<string, unknown> | null>(d.result);
  // Confirmed here: the card shows the outcome at once (a webhook secret is in this answer only), before the reload.
  const state = d.state === 'proposed' && result !== null ? 'confirmed' : d.state;
  // p17-chat-flow item 4: a card replaced by its edited version ("Sohbette düzenle") says so instead of "Vazgeçildi".
  const superseded = state === 'dismissed' && rec(d.result).reason === 'superseded';
  const st = {
    state: DRAFT_STATE[state] ?? ('queued' as const),
    label: superseded
      ? t.chatFlow.edit.superseded
      : Object.hasOwn(t.drafts.states, state)
        ? t.drafts.states[state as keyof typeof t.drafts.states]
        : state,
  };
  const chatActions = useChatActions();
  const [fitGraph, setFitGraph] = useState(false);
  const open = state === 'proposed';
  const key = `draft:${d.id}`;
  // p15-autonomy: no code up front when the security policy waives this card's event.
  const fresh = useFreshStepUp(draftEvent(d.kind, d.payload));
  const uid = useId();
  const detailsId = `${uid}-details`;

  const [busy, setBusy] = useState<'confirm' | 'dismiss' | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webhook, setWebhook] = useState<{ url: string; secret: string } | null>(null);
  const [password, setPassword] = useState<{ username: string; value: string } | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const drafted = draftApprovalPolicy(d);
  const [approval, setApproval] = useState<string | null>(null);
  const draftedClass = draftPriorityClass(d);
  const [cls, setCls] = useState<PriorityClass | null>(null);
  const listed = d.kind === 'job_action' ? actionJobs(d.payload) : [];
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(listed.map((j) => j.id)));
  const shownResult = result ?? d.result;
  const started = startedJob({ kind: d.kind, state }, shownResult);
  // p13-workflows-ui: a workflow card shows its graph and issues; it cannot be confirmed while invalid.
  const wf = d.kind === 'workflow' ? workflowDraftOf(d.payload) : null;
  const invalid = wf !== null && !wf.valid;
  const previous = wf === null || typeof d.payload.previous !== 'object' ? null : rec(d.payload.previous);
  // p22-workflow-patch: what the new version changes against the saved one (every update draft; patches too).
  const versionChanges =
    wf === null || typeof d.payload.versionChanges !== 'object' || d.payload.versionChanges === null
      ? null
      : rec(d.payload.versionChanges);
  const patchOps = typeof d.payload.patchOps === 'number' ? d.payload.patchOps : null;
  // p16-workflow-quality: confirming also turns on its triggers (or they stay off).
  const triggerNote = wf === null ? null : workflowTriggerNote(d.payload, t);
  // p14-mcp-chat: the "turn on MCP in this project" box of an MCP install card (unticked by default).
  const mcpProject =
    d.kind === 'mcp_install' && typeof d.payload.project === 'string' ? d.payload.project : null;
  const [enableMcp, setEnableMcp] = useState(false);
  // oss-sec3: held because the assistant's turn read untrusted content — why, and "remember" where allowed.
  const held = useHeldCard(d, open, busy !== null);
  // p14-workflow-engine 14.5: typed (v2) drafts — node type labels, privileged nodes, "Editörde aç".
  const wt = t.workflows;
  const typeLabel = (type: string): string => nodeTypeText(wt, type)?.label ?? type;
  const editor = wf === null ? null : draftEditorTarget(wf);
  const privileged =
    wf === null || wf.privileged.length === 0
      ? null
      : wt.chatDraft.privileged({
          list: wf.privileged
            .map((a) => {
              const k = PRIVILEGED_KEY[a];
              return k === undefined ? a : wt.chatDraft.actions[k];
            })
            .join(', '),
        });

  async function send(): Promise<void> {
    const unchecked = listed.some((j) => !checked.has(j.id));
    const overrides = {
      ...(approval !== null && approval !== drafted ? { approvalPolicy: approval } : {}),
      ...(cls !== null && cls !== draftedClass ? { priorityClass: cls } : {}),
      ...(unchecked ? { jobIds: listed.filter((j) => checked.has(j.id)).map((j) => j.id) } : {}),
      ...(mcpProject !== null && enableMcp ? { enableMcpProject: true } : {}),
      ...(held.remember ? { remember: true } : {}),
    };
    const r = await confirmDraft(d.id, {}, overrides);
    // p16-assistant-admin: an invite's temporary password is in this answer only — shown once, kept out of the result.
    const { temporaryPassword, ...kept } = r.result;
    setResult(kept);
    if (typeof temporaryPassword === 'string' && temporaryPassword !== 'shown once on the card')
      setPassword({
        username: typeof kept.username === 'string' ? kept.username : '',
        value: temporaryPassword,
      });
    const w = rec(r.result.webhook);
    if (typeof w.url === 'string' && typeof w.secret === 'string')
      setWebhook({ url: w.url, secret: w.secret });
    setNeedsCode(false);
    props.onChanged();
  }

  async function confirm(): Promise<void> {
    setError(null);
    if (!fresh) {
      setNeedsCode(true);
      return;
    }
    setBusy('confirm');
    try {
      await send();
    } catch (err) {
      if (isStepUpRequired(err)) setNeedsCode(true);
      else setError(sayError(err));
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(): Promise<void> {
    setBusy('dismiss');
    setError(null);
    try {
      await dismissDraft(d.id);
      props.onChanged();
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(null);
    }
  }

  const noneChecked = listed.length > 0 && checked.size === 0;
  useCardKeys(key, {
    approve: () => {
      if (open && !noneChecked && !invalid) void confirm();
    },
    deny: () => {
      if (open) void dismiss();
    },
  });

  const full = fullAccessOf(summary.spec);
  const sub: ReactNode[] = [];
  if (d.project !== null) sub.push(<span key="p">{d.project}</span>);
  if (!open && draftedClass !== null)
    sub.push(
      <span key="c" data-testid="draft-priority">
        {w.classLine({ cls: classLabel(draftedClass, t) })}
      </span>,
    );
  const link = shownResult === null ? null : resultLink(shownResult, t);
  const runtime = typeof summary.spec?.runtime === 'string' ? summary.spec.runtime : null;

  const outcome: ReactNode =
    shownResult === null || state === 'dismissed' ? null : d.kind === 'job_action' ? (
      <JobActionResults result={shownResult} />
    ) : d.kind === 'memory_change' ? (
      <MemoryResult draft={d} result={shownResult} />
    ) : d.kind === 'mcp_install' && typeof d.payload.previewId === 'string' ? (
      <McpInstallProgress
        previewId={d.payload.previewId}
        admin
        installError={typeof shownResult.installError === 'string' ? shownResult.installError : null}
        assignError={typeof shownResult.assignError === 'string' ? shownResult.assignError : null}
      />
    ) : null;
  const after: ReactNode = (
    <>
      {outcome}
      {webhook === null ? null : <WebhookSecret url={webhook.url} secret={webhook.secret} />}
      {password === null ? null : <TemporaryPassword username={password.username} value={password.value} />}
      {started === null ? null : (
        <>
          {d.kind === 'job' ? (
            <JobTimeLimit
              jobId={started}
              state={typeof shownResult?.state === 'string' ? shownResult.state : ''}
            />
          ) : null}
          {d.kind === 'job' ? (
            <JobApprovalMode
              jobId={started}
              state={typeof shownResult?.state === 'string' ? shownResult.state : ''}
            />
          ) : null}
          <JobQuickButtons threadId={props.threadId} jobId={started} onDrafted={props.onChanged} />
        </>
      )}
    </>
  );
  const hasAfter = outcome !== null || webhook !== null || started !== null;

  const body = (
    // p17-chat-flow item 7: one shrinkable column — a wide graph or a long word never widens the card.
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3" data-testid="dy-draft-card-body">
      {full === null && summary.machineAdmin === undefined ? null : (
        <div className="flex flex-wrap gap-1.5">
          {full === null ? null : (
            <Pill tone="red" testId="full-access-badge">
              {w.fullAccess}
            </Pill>
          )}
          {summary.machineAdmin === undefined ? null : (
            <Pill tone="red" testId="machine-admin-badge">
              {w.machineAdmin}
            </Pill>
          )}
          {summary.machineAdmin?.fullAccess === true ? (
            <Pill tone="amber" testId="machine-admin-full">
              {w.noAsk}
            </Pill>
          ) : null}
        </div>
      )}
      {full === null ? null : (
        <DyNotice tone="red" testId="draft-full-access-note">
          {full.allowAll ? w.allowAllNote : ''}
          {full.unconfined ? `${full.allowAll ? ' ' : ''}${w.unconfinedNote}` : ''}
        </DyNotice>
      )}
      {summary.machineAdmin === undefined ? null : (
        <DyNotice tone="red" testId="machine-admin-note">
          {summary.machineAdmin.note}
        </DyNotice>
      )}
      {summary.notice === undefined ? null : (
        <DyNotice
          tone={
            summary.notice.testId === 'skill-draft-note' ||
            summary.notice.testId === 'skill-import-note' ||
            summary.notice.testId === 'mcp-install-note' ||
            summary.notice.testId === 'automation-external-note'
              ? 'amber'
              : 'teal'
          }
          testId={summary.notice.testId}
        >
          {summary.notice.text}
        </DyNotice>
      )}
      {summary.identical === undefined ? null : (
        <DyNotice tone="amber" testId="draft-identical-result">
          {w.identical({ age: summary.identical.age })}
          <Link to={`/jobs/${summary.identical.jobId}`} className="font-bold underline underline-offset-2">
            {w.openResult}
          </Link>
          {open ? w.orConfirm : ''}
        </DyNotice>
      )}
      {summary.advice === undefined ? null : (
        <DyNotice tone={summary.advice.differs ? 'amber' : 'neutral'} testId="draft-runtime-advice">
          <b className="font-bold">{w.advice}</b>
          {summary.advice.text}
          {summary.advice.differs ? w.adviceDiffers : ''}
        </DyNotice>
      )}
      {summary.warnings.map((w) => (
        <DyNotice key={w.testId} tone={w.danger === true ? 'red' : 'amber'} testId={w.testId}>
          {w.text}
        </DyNotice>
      ))}
      {summary.key.length > 0 ? <KeyValue rows={summary.key} /> : null}
      {wf === null ? null : (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2" data-testid="workflow-draft">
          <div className="grid min-w-0 gap-1 rounded-[10px] border border-dy-line bg-dy-sunk p-2">
            <WorkflowDraftGraph
              draft={wf}
              look="diyalog"
              roleLabel={(role) => roleText(role, t)}
              typeLabel={typeLabel}
              scrollLabel={t.chatFlow.graph.scroll}
              fit={fitGraph}
            />
            <button
              type="button"
              aria-pressed={fitGraph}
              onClick={() => {
                setFitGraph((v) => !v);
              }}
              className="dy-press justify-self-end rounded-md px-1.5 py-0.5 text-[0.75rem] font-bold text-dy-teal-ink"
              data-testid="workflow-draft-fit"
            >
              {fitGraph ? t.chatFlow.graph.actual : t.chatFlow.graph.fit}
            </button>
          </div>
          {versionChanges === null ? null : (
            <WorkflowChanges previous={versionChanges} against="saved" patchOps={patchOps} />
          )}
          {previous === null ? null : <WorkflowChanges previous={previous} />}
          {privileged === null ? null : (
            <DyNotice tone="amber" testId="workflow-draft-privileged">
              {privileged}
            </DyNotice>
          )}
          {triggerNote === null ? null : (
            <DyNotice tone="amber" testId="workflow-draft-triggers">
              {triggerNote}
            </DyNotice>
          )}
          {wf.valid ? (
            <DyNotice tone="teal" testId="workflow-draft-valid">
              {t.drafts.workflow.valid({ isNew: wf.baseVersion === null })}
            </DyNotice>
          ) : (
            <DyNotice tone="red" testId="workflow-draft-issues">
              <b className="font-bold">{t.drafts.workflow.invalid}</b>
              <ul className="m-0 mt-1 list-disc pl-5">
                {wf.issues.map((i, k) => (
                  // Issues may repeat: the index is part of the identity.
                  <li key={`${i.path}-${i.code}-${String(k)}`} className="[overflow-wrap:anywhere]">
                    {issueLine(i)}
                  </li>
                ))}
              </ul>
            </DyNotice>
          )}
        </div>
      )}
      {open && d.kind === 'job' && runtime !== null ? <RuntimeLimitLine runtime={runtime} /> : null}
      {listed.length > 0 ? (
        <JobChecklist
          jobs={listed}
          open={open}
          checked={checked}
          disabled={busy !== null}
          onToggle={(id) => {
            setChecked((cur) => {
              const next = new Set(cur);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
        />
      ) : null}
      {summary.diff === undefined ? null : <SkillDiff diff={summary.diff} />}
      {summary.opsDiff === undefined ? null : <OpsDiff diff={summary.opsDiff} />}
      {summary.details.length > 0 ? (
        <div>
          <button
            type="button"
            aria-expanded={showDetails}
            aria-controls={detailsId}
            onClick={() => {
              setShowDetails((v) => !v);
            }}
            className="dy-press -ml-1 inline-flex min-h-9 items-center gap-1 rounded-md px-1 text-[0.8125rem] font-bold text-dy-teal-ink"
          >
            {showDetails ? w.hideDetails : w.details}
            <DyIcon
              name="chev"
              className={cx(
                'size-3.5 transition-transform duration-150 ease-dy',
                showDetails && 'rotate-180',
              )}
            />
          </button>
          <div id={detailsId} hidden={!showDetails} className="mt-1" data-testid="draft-details">
            <KeyValue rows={summary.details} className="[&_dd]:whitespace-pre-wrap" />
          </div>
        </div>
      ) : null}
      {open && drafted !== null ? (
        <div data-testid="draft-approval">
          <label htmlFor={`${uid}-approval`} className={LABEL}>
            {t.drafts.approvalMode.label}
          </label>
          <select
            id={`${uid}-approval`}
            value={approval ?? drafted}
            disabled={busy !== null}
            onChange={(e) => {
              setApproval(e.target.value);
            }}
            className={SELECT}
          >
            {(d.kind === 'machine_task' ? MACHINE_MODES : APPROVAL_MODES).map((m) => (
              <option key={m} value={m}>
                {approvalLabel(m, t)}
              </option>
            ))}
          </select>
          <p className="m-0 mt-1 text-[0.78125rem] text-dy-muted">{approvalHint(approval ?? drafted, t)}</p>
          {approval !== null && approval !== drafted ? (
            <p className="m-0 mt-1 text-[0.78125rem] text-dy-amber-ink" data-testid="draft-approval-changed">
              {w.instead({ was: approvalLabel(drafted, t) })}
              {approval === 'allow-all' ? w.allowAllWhere : ''}
            </p>
          ) : null}
        </div>
      ) : null}
      {held.node}
      {open && mcpProject !== null ? (
        <DyCheck
          label={t.mcp.install.card.enableProject({ project: mcpProject })}
          hint={t.mcp.install.proposal.enableProjectHint}
          checked={enableMcp}
          disabled={busy !== null}
          onChange={setEnableMcp}
          testId="mcp-install-enable-project"
        />
      ) : null}
      {open && draftedClass !== null ? (
        <div data-testid="draft-priority">
          <span className={LABEL}>{w.classLabel}</span>
          <Seg
            label={w.queueClass}
            value={cls ?? draftedClass}
            disabled={busy !== null}
            options={PRIORITY_CLASSES.map((c) => ({ value: c, label: classLabel(c, t) }))}
            onChange={setCls}
          />
          <p className="m-0 mt-1 text-[0.78125rem] text-dy-muted">
            {cls !== null && cls !== draftedClass ? (
              <span data-testid="draft-priority-changed">
                {w.classInstead({ was: classLabel(draftedClass, t) })}
              </span>
            ) : draftedClass === 'urgent' ? (
              w.urgentWhy
            ) : null}
            {classHint(cls ?? draftedClass, t)}
          </p>
        </div>
      ) : null}
      {open ? (
        <Countdown until={d.expiresAt} from={d.createdAt} label={w.expires} tone="amber" />
      ) : (
        <KeyValue rows={[{ k: w.proposedAt, v: shortTime(d.createdAt, new Date(), f), mono: true }]} />
      )}
    </div>
  );

  return (
    <LiveCard
      cardKey={key}
      kind={{ ...spec.kind, label: draftKindText(d.kind, t, d.payload), labelOf: undefined }}
      state={
        <span className="inline-flex flex-wrap items-center gap-2">
          <span data-testid="draft-state" className="inline-flex">
            <StateBadge state={st.state} label={st.label} />
          </span>
          {/* p17-chat-flow item 5: Geçerli / Geçersiz in the header (the body notice stays with the details). */}
          {wf === null ? null : (
            <span
              data-testid="workflow-draft-badge"
              data-valid={wf.valid ? 'true' : 'false'}
              className={cx(
                'inline-flex items-center gap-1 rounded-full px-2 py-px text-[0.75rem] font-bold whitespace-nowrap',
                wf.valid ? 'bg-dy-green-soft text-dy-green' : 'bg-dy-red-soft text-dy-red-ink',
              )}
            >
              <DyIcon name={wf.valid ? 'checkc' : 'xc'} className="size-3" />
              {wf.valid ? t.chatFlow.summary.valid : t.chatFlow.summary.invalid}
            </span>
          )}
        </span>
      }
      title={d.title}
      {...(sub.length === 0 ? {} : { sub: <>{sub}</> })}
      {...(open
        ? {
            actions: (
              <>
                <CardButton
                  variant={full === null && summary.machineAdmin === undefined ? 'primary' : 'warn'}
                  icon="check"
                  busy={busy === 'confirm'}
                  disabled={busy !== null || noneChecked || invalid}
                  expanded={needsCode}
                  onClick={() => void confirm()}
                >
                  {w.confirm}
                </CardButton>
                <CardButton busy={busy === 'dismiss'} disabled={busy !== null} onClick={() => void dismiss()}>
                  {w.dismiss}
                </CardButton>
                {summary.prefill === undefined ? null : (
                  <CardLink to="/jobs/new" state={{ prefill: summary.prefill }} variant="ghost" icon="pen">
                    {w.editInForm}
                  </CardLink>
                )}
                {editor === null ? null : (
                  <CardLink to={editor.to} state={editor.state} variant="ghost" icon="pen">
                    {wt.chatDraft.openInEditor}
                  </CardLink>
                )}
                {/* p17-chat-flow item 4: the next message changes this card; the assistant's new card replaces it. */}
                {wf === null || invalid || chatActions?.editDraft === undefined ? null : (
                  <CardButton
                    variant="ghost"
                    icon="bubble"
                    disabled={busy !== null}
                    onClick={() => {
                      chatActions.editDraft?.({ id: d.id, title: d.title });
                    }}
                  >
                    {t.chatFlow.edit.button}
                  </CardButton>
                )}
                {d.kind === 'job' ? (
                  <CardLink to={`/jobs/templates/new?fromDraft=${encodeURIComponent(d.id)}`} variant="ghost">
                    {w.saveTemplate}
                  </CardLink>
                ) : null}
              </>
            ),
            hint: noneChecked
              ? w.pickOne
              : invalid
                ? w.invalidWorkflow
                : full !== null || summary.machineAdmin !== undefined
                  ? w.readRed
                  : w.nothingRuns,
            panel: (
              <>
                {needsCode ? (
                  <DecisionPanel
                    intent="approve"
                    needsCode
                    submitLabel={w.submitCode}
                    onSubmit={send}
                    onCancel={() => {
                      setNeedsCode(false);
                    }}
                  />
                ) : null}
                {error === null ? null : (
                  <p role="alert" className="m-0 w-full text-[0.8125rem] text-dy-red-ink">
                    {error}
                  </p>
                )}
              </>
            ),
          }
        : {
            resolved: (
              <span className="text-dy-muted" data-testid="draft-outcome">
                {st.label}
                {superseded ? (
                  <span className="block text-[0.8125rem]" data-testid="draft-superseded">
                    {t.chatFlow.edit.supersededHint}
                  </span>
                ) : null}
                {d.decidedAt === null ? '' : `, ${shortTime(d.decidedAt, new Date(), f)}`}
                {link === null || state === 'dismissed' ? null : (
                  <>
                    {' · '}
                    <Link
                      to={link.to}
                      className="font-bold text-dy-ink underline-offset-2 hover:underline"
                      data-testid="draft-result-link"
                    >
                      {link.label}
                    </Link>
                  </>
                )}
              </span>
            ),
            ...(hasAfter ? { after } : {}),
          })}
    >
      {body}
    </LiveCard>
  );
}
