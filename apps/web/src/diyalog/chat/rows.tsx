import { type ReactNode, useContext, useId, useState } from 'react';
import { Link } from 'react-router';
import type { ChatMessage } from '../../api/chat';
import type { RelatedUse } from '../../api/chatKnowledge';
import { MessageAttachments } from '../../screens/chat/Attachments';
import { CopyText, Markdown } from '../../screens/chat/markdown';
import { OutputsLink, toolName, WatchLinks } from '../../screens/chat/messageLinks';
import { StarButton } from '../../screens/chat/organize/Stars';
import { shortTime } from '../../screens/chat/time';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { DyIcon } from '../icons';
import { Message } from '../Message';
import type { TimelineItem } from '../ops/timeline';
import { jobKeptOf, JobResultCard } from './JobResultCard';
import { TimeWarningActions } from '../common/jobClock';
import { approvalNoteOf, workflowResultOf } from '../../api/workflowApprovals';
import { WorkflowApprovalCard, WorkflowResultCard } from './WorkflowCards';
import { PlanItemLink, planItemOf, ScheduledMute, scheduledOf } from './FlowLinks';
import { SmoothHeight, useChangeCount } from '../motionKit';
import { useSmoothText } from './smoothText';
import { fill, type Messages } from '@remyral/i18n';
import { MentionText } from './MentionBadge';
import { AnswerControls, EditButton, MessageEditor, regeneratedLabel, RetryButton } from './MessageControls';
import { ReadOnlyContext, useTurnControls } from './turnControls';
import { planAction } from '../../api/plans';
import { useErrorText } from '../../i18n/errors';

/**
 * p12-diyalog: one ops chat row in the Diyalog language (user / assistant / error message, a folded tool line) and the
 * assistant's turn as it is written. Shared by the Sohbet screen (DiyalogChat) and the Faz 1 operations thread.
 */

/**
 * p12-diyalog Faz 3 (parity with the chat screen): copy and star on a message, the files and mentions a sent message
 * carried, and the Outputs / watch links of the assistant's notes.
 */
export function MessageTools(props: { readonly m: ChatMessage }): ReactNode {
  const t = useT().shared.chat;
  const tc = useT().chatComplete;
  // p16-chat-complete: edit (own messages), regenerate (the last answer); none for a shared reader.
  const controls = useTurnControls();
  const readOnly = useContext(ReadOnlyContext);
  const m = props.m;
  const label = m.role === 'assistant' ? regeneratedLabel(tc.regenerate, m.meta) : null;
  return (
    <span
      className="dy-m-meta mt-1 flex flex-wrap items-center gap-1 text-[0.75rem] text-dy-muted"
      data-testid="dy-message-tools"
    >
      <CopyText text={m.content} label={t.copyMessage} />
      {readOnly ? null : <StarButton m={m} />}
      {controls !== null && m.role === 'user' && controls.editable.has(m.id) ? (
        <EditButton
          disabled={controls.busy}
          onClick={() => {
            controls.startEdit(m.id);
          }}
        />
      ) : null}
      {m.role === 'user' && typeof m.meta?.editOf === 'string' ? (
        <span data-testid="message-edited">{tc.edit.edited}</span>
      ) : null}
      {controls !== null && controls.lastAnswerId === m.id ? (
        <AnswerControls
          disabled={controls.busy}
          onRegenerate={controls.regenerate}
          onOther={controls.regenerateOther}
        />
      ) : null}
      {label === null ? null : (
        <span className="font-dy-mono" data-testid="message-regenerated">
          {label}
        </span>
      )}
    </span>
  );
}

export function ChatRow(props: {
  readonly item: TimelineItem & { kind: 'row' };
  readonly me: string;
  /** p12-diyalog-parity: the related items this answer's turn used ("Used N related items"). */
  readonly related?: RelatedUse | null | undefined;
}): ReactNode {
  const t = useT().shared.chat;
  const tf = useT().chatFailover;
  const all = useT();
  const format = useFormat();
  const controls = useTurnControls();
  const { row } = props.item;
  if (row.kind === 'tools') {
    const names = [...new Set(row.items.map(toolName))];
    return (
      <Message
        role="system"
        icon="term"
        at={row.items[0]?.createdAt}
        atText={shortTime(row.items[0]?.createdAt ?? '', undefined, format)}
      >
        {t.toolsUsed({
          n: row.items.length,
          names: `${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}`,
        })}
      </Message>
    );
  }
  const m = row.m;
  const at = shortTime(m.createdAt, undefined, format);
  // p18-plan-mode: a continuation turn of an approved plan is the platform's, not the person's: one quiet line.
  if (m.role === 'user' && m.meta?.origin === 'plan')
    return (
      <Message role="note" icon="flag" at={m.createdAt} atText={at}>
        <span data-testid="dy-plan-continuation">{planContinuationLine(all, m)}</span>
      </Message>
    );
  // p19-watch-follow-up: the platform hands the conversation back to the assistant after a watch ended unmet.
  if (m.role === 'user' && m.meta?.origin === 'watch')
    return (
      <Message role="note" icon="flag" at={m.createdAt} atText={at}>
        <span data-testid="dy-watch-follow-up">{watchFollowUpLine(all, m)}</span>
      </Message>
    );
  // p22-goal-line: a goal's resume turn is written by the platform, not the person, so it must not look like theirs.
  if (m.role === 'user' && m.meta?.origin === 'goal')
    return (
      <Message role="note" icon="flag" at={m.createdAt} atText={at}>
        <span data-testid="dy-goal-resume">{goalResumeLine(all, m)}</span>
      </Message>
    );
  // p22-slow-tools: a long-running action's result handed back to the assistant.
  if (m.role === 'user' && m.meta?.origin === 'tool_result')
    return (
      <Message role="note" icon="flag" at={m.createdAt} atText={at}>
        <span data-testid="dy-late-result">{lateResultLine(all, m)}</span>
      </Message>
    );
  // p18-plan-mode: "Plana devam edeyim mi?" — the plan waits (cost brake, budget, no progress, a failed step).
  if (m.meta?.notice === 'plan-continue') return <PlanStalledNotice m={m} at={at} />;
  if (m.role === 'user')
    return (
      <Message role="me" at={m.createdAt} atText={at} author={props.me}>
        <MessageAttachments meta={m.meta} />
        {controls !== null && controls.editingId === m.id ? (
          <MessageEditor
            initial={m.content}
            busy={controls.busy}
            error={controls.error}
            onCancel={() => {
              controls.startEdit(null);
            }}
            onSave={(text) => {
              controls.edit(m.id, text);
            }}
          />
        ) : (
          <>
            {/* p12-mention-badges: the mentions as badges, inline where the text names them. */}
            <MentionText text={m.content} meta={m.meta} />
            <MessageTools m={m} />
          </>
        )}
      </Message>
    );
  // p17-chat-github: the conversation was renamed automatically (said in the reader's language).
  const renamed = titleNotice(all, m);
  if (renamed !== null)
    return (
      <Message role="system" icon="pen" at={m.createdAt} atText={at}>
        <span data-testid="dy-title-notice">{renamed}</span>
      </Message>
    );
  // p15-chat-failover: the notice that another machine answers (not an error; said in the reader's language).
  const notice = failoverNotice(tf, m);
  if (notice !== null)
    return (
      <Message role="system" icon="cpu" at={m.createdAt} atText={at}>
        <span data-testid="dy-failover-notice">{notice}</span>
      </Message>
    );
  // p16-workflow-quality: the one compact line of a turn whose drafts all failed validation (no cards).
  const invalid = draftInvalidNotice(all, m);
  if (invalid !== null)
    return (
      <Message role="system" tone="warn" icon="xc" at={m.createdAt} atText={at}>
        <span data-testid="dy-draft-invalid">{invalid}</span>
      </Message>
    );
  if (m.role === 'error')
    return (
      <Message role="system" tone="warn" icon="xc" at={m.createdAt} atText={at}>
        {m.content}
        {/* p16-chat-complete: one click answers the failed / lost / stopped last turn again. */}
        {controls !== null && controls.retryId === m.id ? (
          <div>
            <RetryButton disabled={controls.busy} onRetry={controls.retry} />
          </div>
        ) : null}
      </Message>
    );
  const approval = approvalNoteOf(m.meta);
  const runResult = workflowResultOf(m.meta);
  // W4: the card serves a plan item / is a scheduled run's result of something this conversation created.
  const planItem = planItemOf(m.meta);
  const scheduled = scheduledOf(m.meta);
  return (
    <Message role="assistant" meta={t.assistantMeta} at={m.createdAt} atText={at}>
      <Markdown text={m.content} />
      {props.related === undefined || props.related === null ? null : <DyRelated related={props.related} />}
      <OutputsLink m={m} />
      {/* p20-job-clock: a job running out of time — "+30 dk" / "+1 saat" under the note. */}
      <TimeWarningActions m={m} />
      {/* p15-chat-cards-scroll: a job's end note shows the job result card under its text (older notes: the links). */}
      {/* p17-chat-flow: a workflow's approval step / a run's result shows its card the same way. */}
      {approval !== null ? (
        <SmoothHeight>
          <WorkflowApprovalCard runId={approval.runId} nodeRunId={approval.nodeRunId} pushed />
        </SmoothHeight>
      ) : runResult !== null ? (
        <WorkflowResultCard result={runResult} />
      ) : resultJob(m) === null ? (
        <WatchLinks m={m} />
      ) : (
        // p17-panel-motion: the card replaces its loading line and opens its details without a jump.
        <SmoothHeight>
          <JobResultCard
            jobId={resultJob(m) ?? ''}
            summary={jobSummary(m)}
            timedOut={m.meta?.jobTimedOut === true}
            kept={jobKeptOf(m.meta)}
          />
        </SmoothHeight>
      )}
      {planItem === null ? null : (
        <span className="mt-1.5 flex">
          <PlanItemLink item={planItem} />
        </span>
      )}
      {scheduled === null ? null : <ScheduledMute scheduled={scheduled} />}
      <MessageTools m={m} />
    </Message>
  );
}

/** p18-plan-mode: "Plan devam ediyor — sıradaki: …" from a continuation message (the item's title from its text). */
export function planContinuationLine(t: Messages, m: ChatMessage): string {
  const next = /(?:sıradaki madde|next item): (.+?) \([a-z0-9-]+\)/.exec(m.content)?.[1];
  return next === undefined ? t.plan.continuation.plain : t.plan.continuation.next({ title: next });
}

/** p22-goal-line: the goal's title from the system-written resume turn ("Hedefe devam: <title> — …"). */
export function goalResumeLine(t: Messages, m: ChatMessage): string {
  const title = /^(?:Hedefe devam|Resume the goal): (.+?) — /.exec(m.content)?.[1];
  return title === undefined
    ? t.goals.resumeLinePlain
    : t.goals.resumeLine({ title: title.replace(/[*_`[\]]/g, '') });
}

/** p19-watch-follow-up: the watch's label from the system-written message ("Takip sonuçsuz bitti: <label> — …"). */
/** p22-slow-tools: the quiet line of a late tool result handed back. */
export function lateResultLine(t: Messages, m: ChatMessage): string {
  const r = m.meta?.lateResult as { tool?: unknown } | undefined;
  return t.watches.delivery.lateResult({ tool: typeof r?.tool === 'string' ? r.tool : '' });
}

export function watchFollowUpLine(t: Messages, m: ChatMessage): string {
  // p22-watch-next-step: the follow-up of a watch with a next step.
  const next = /^(?:Beklediğin şey bitti|What you were waiting for has ended): (.+?) — /.exec(m.content)?.[1];
  if (next !== undefined) return t.watches.delivery.nextStep({ label: next.replace(/[*_`[\]]/g, '') });
  const label = /^(?:Takip sonuçsuz bitti|The watch ended without its condition): (.+?) — /.exec(
    m.content,
  )?.[1];
  return label === undefined
    ? t.watches.delivery.followUpPlain
    : t.watches.delivery.followUp({ label: label.replace(/[*_`[\]]/g, '') });
}

function PlanStalledNotice(props: { readonly m: ChatMessage; readonly at: string }): ReactNode {
  const t = useT().plan;
  const sayError = useErrorText();
  const readOnly = useContext(ReadOnlyContext);
  const meta = props.m.meta ?? {};
  const planId = typeof meta.planId === 'string' ? meta.planId : null;
  const reason = typeof meta.reason === 'string' ? meta.reason : 'default';
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  return (
    <Message role="system" tone="warn" icon="flag" at={props.m.createdAt} atText={props.at}>
      <span className="grid gap-1" data-testid="dy-plan-stalled">
        <span className="font-bold">{t.stalled.title}</span>
        <span>
          {(t.stalled.reasons as Readonly<Record<string, string>>)[reason] ?? t.stalled.reasons.default}
        </span>
        {planId === null || readOnly ? null : state === 'done' ? (
          <span role="status">{t.stalled.resumed}</span>
        ) : (
          <button
            type="button"
            disabled={state === 'busy'}
            onClick={() => {
              setState('busy');
              setError(null);
              planAction(planId, 'resume').then(
                () => {
                  setState('done');
                },
                (err: unknown) => {
                  setState('idle');
                  setError(sayError(err));
                },
              );
            }}
            className="dy-press inline-flex min-h-11 items-center gap-1.5 self-start rounded-[9px] bg-dy-ink px-3 text-[0.8125rem] font-bold text-dy-card sm:min-h-8"
          >
            {t.stalled.resume}
          </button>
        )}
        {error === null ? null : (
          <span role="alert" className="text-dy-red-ink">
            {error}
          </span>
        )}
      </span>
    </Message>
  );
}

/**
 * p16-workflow-quality: the give-up line of a turn (`meta.notice = 'draft-invalid'`) in the reader's language — the
 * kind, the attempts and the last issues — or null for other messages.
 */
export function draftInvalidNotice(t: Messages, m: ChatMessage): string | null {
  const meta = m.meta;
  if (meta?.notice !== 'draft-invalid') return null;
  const w = t.workflowQuality.draftInvalid;
  const list = Array.isArray(meta.drafts) ? meta.drafts : [];
  const lines = list.flatMap((x) => {
    if (typeof x !== 'object' || x === null) return [];
    const d = x as { kind?: unknown; attempts?: unknown; issues?: unknown };
    const kinds = t.drafts.kinds as Readonly<Record<string, string>>;
    const kind = typeof d.kind === 'string' ? (kinds[d.kind] ?? d.kind) : t.drafts.fallbackKind;
    const issues = Array.isArray(d.issues)
      ? d.issues.filter((i): i is string => typeof i === 'string').join('; ')
      : '';
    const shown = issues === '' ? w.refused : issues;
    const n = typeof d.attempts === 'number' ? d.attempts : 1;
    return [n > 1 ? fill(w.lineCount, { kind, n, issues: shown }) : fill(w.line, { issues: shown })];
  });
  return lines.length === 0 ? m.content : lines.join(' — ');
}

/** p17-chat-github: an automatic rename notice (`meta.notice = 'chat-title'`), or null for other messages. */
export function titleNotice(t: Messages, m: ChatMessage): string | null {
  const meta = m.meta;
  if (meta?.notice !== 'chat-title') return null;
  return typeof meta.title === 'string' ? t.chatGithub.title.renamed({ title: meta.title }) : m.content;
}

/** p15-chat-failover: a failover notice's sentence (`meta.notice = 'chat-failover'`), or null for other messages. */
export function failoverNotice(t: Messages['chatFailover'], m: ChatMessage): string | null {
  const meta = m.meta;
  if (meta?.notice !== 'chat-failover') return null;
  const from = typeof meta.from === 'string' ? meta.from : '';
  const to = typeof meta.to === 'string' ? meta.to : '';
  switch (meta.cause) {
    case 'primary_offline':
      return t.notice.primary_offline({ from, to });
    case 'primary_unavailable':
      return t.notice.primary_unavailable({ from, to });
    case 'primary_unstable':
      return t.notice.primary_unstable({ from, to });
    case 'pinned':
      return t.notice.pinned({ to });
    case 'returned':
      return t.notice.returned({ to });
    case 'rerun':
      return t.notice.rerun({ from, to });
    case 'restart':
      return t.notice.restart;
    default:
      return m.content;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** p15-chat-cards-scroll: the job a watch note reports the end of (`meta.jobId`), or null. */
export function resultJob(m: ChatMessage): string | null {
  const meta = m.meta;
  // p18-outputs-delivery: a job started from this conversation posts its outcome as `job-result` (no watch needed).
  if (meta?.notice !== 'chat-watch' && meta?.notice !== 'job-result') return null;
  const id = meta.jobId;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

function jobSummary(m: ChatMessage): string | null {
  const s = m.meta?.jobSummary;
  return typeof s === 'string' ? s : null;
}

export function Typing(props: {
  readonly text: string;
  readonly reconnecting?: boolean;
  /** p19-chat-stream-motion: the turn ended — what is still being revealed drains quickly. */
  readonly done?: boolean;
}): ReactNode {
  const t = useT().shared.chat;
  // p19-chat-stream-motion (smoothText.ts): the stream's bursts show at a steady pace, a caret at the writing end.
  const text = useSmoothText(props.text, props.done === true);
  // p17-chat-send-motion: the first words take the typing dots' place with a short fade (`dy-m-handoff`) — only when
  // they replace the dots here; an answer already being written when the conversation opens stands still.
  const handoff = useChangeCount(text !== '') > 0;
  // p17-chat-reconnect: a quiet line while the answering machine reconnects (no error unless the turn really fails).
  const reconnecting =
    props.reconnecting === true ? (
      <p className="m-0 mt-1.5 text-[0.8125rem] text-dy-muted" role="status" data-testid="dy-reconnecting">
        {t.reconnecting}
      </p>
    ) : null;
  if (text !== '')
    return (
      <>
        <Message
          role="assistant"
          meta={t.writing}
          className={handoff ? 'dy-m-handoff dy-m-streaming' : 'dy-m-streaming'}
        >
          <Markdown text={text} />
        </Message>
        {reconnecting}
      </>
    );
  if (reconnecting !== null) return reconnecting;
  return (
    <div className="flex items-center gap-2.5 text-[0.84375rem] text-dy-muted" role="status">
      <span
        className="inline-flex gap-1 rounded-full border border-dy-line bg-dy-card px-[11px] py-2"
        aria-hidden="true"
      >
        <i className="dy-breathe size-1.5 rounded-full bg-dy-faint" />
        <i className="dy-breathe size-1.5 rounded-full bg-dy-faint [animation-delay:150ms]" />
        <i className="dy-breathe size-1.5 rounded-full bg-dy-faint [animation-delay:300ms]" />
      </span>
      {t.typing}
    </div>
  );
}

/**
 * p12-diyalog-final: "N ilgili kayıt kullanıldı" under an answer (the classic `RelatedDisclosure` in the Diyalog
 * language): what the platform looked up for the turn — by meaning or by keywords — with links to each item.
 */
export function DyRelated(props: { readonly related: RelatedUse }): ReactNode {
  const t = useT().shared.chat;
  const id = useId();
  const [open, setOpen] = useState(false);
  const n = props.related.items.length;
  return (
    <div className="mt-1 text-[0.78125rem] text-dy-muted" data-testid="related-disclosure">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="dy-press -ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 md:min-h-8 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
      >
        <DyIcon name="search" className="size-3.5" />
        {t.related({ n })}
        <span className="hidden sm:inline">
          {t.relatedFound({ semantic: props.related.mode === 'semantic' })}
        </span>
        <DyIcon
          name="chev"
          className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? '' : '-rotate-90'}`}
        />
      </button>
      <ol
        id={id}
        hidden={!open}
        className="m-0 mt-1 ml-1 flex list-none flex-col gap-1 border-l border-dy-line py-0 pl-3"
      >
        {props.related.items.map((i, k) => (
          <li key={`${i.kind}:${i.id}`} className="[overflow-wrap:anywhere]" data-testid="related-item">
            <span>
              [{k + 1}] {t.relatedKind[i.kind]}
            </span>
            {i.project === null ? null : <span> · {i.project}</span>}
            {' · '}
            {i.link === null ? (
              <span className="text-dy-ink">{i.title}</span>
            ) : (
              <Link to={i.link} className="text-dy-teal-ink underline underline-offset-2">
                {i.title}
              </Link>
            )}
            {i.at === null ? null : <span> · {i.at.slice(0, 10)}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
