import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError, ApiIssue } from '../../../api/client';
import type { ChatDraft, ChatMessage, ThreadDetail } from '../../../api/chat';
import {
  openWorkflowAiThread,
  sendWorkflowAi,
  type WorkflowAiMode,
  type WorkflowAiThread,
} from '../../../api/workflowAi';
import { listWorkflowRuns, type WorkflowRunSummary } from '../../../api/workflows';
import { cx, toApiError } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { useNow } from '../../../lib/now';
import { Markdown } from '../../../screens/chat/markdown';
import { DyIcon } from '../../icons';
import { useOpsChat } from '../../ops/useOpsChat';
import { DyApiError, DyNotice } from '../kit';
import { agoText, DyButton } from '../parts';
import type { AiChange } from './aiDiff';
import { asDoc, cleanDoc, type Doc, issueTextWith, mapIssues } from './model';

/**
 * p15-workflow-ai (docs/design/p15-workflow-ai.md): the AI panel of the workflow editor. Its conversation is the
 * caller's chat thread linked to the workflow (`POST /workflows/ai/threads`), shown live through the chat stream
 * (`useOpsChat`). A message carries the mode, the current document, the selected nodes and (debug) a failed run. The
 * assistant answers with `draft_workflow` cards the master validated; a new valid card of a design request goes onto
 * the canvas at once (the editor's `onProposal`), one of an edit request opens the diff review; an invalid one is
 * shown with its issues in words (after the master's one automatic repair turn). Nothing is saved here.
 */

export interface AiProposal {
  readonly draftId: string;
  readonly mode: 'design' | 'edit';
  readonly doc: Doc;
}

/** One workflow card of the conversation with the request it answered. */
export interface ProposalItem {
  readonly draft: ChatDraft;
  readonly mode: WorkflowAiMode | null;
  /** The card answered the master's automatic repair turn. */
  readonly repair: boolean;
  readonly valid: boolean;
  readonly issues: readonly ApiIssue[];
  readonly definition: Record<string, unknown> | null;
}

interface AiMeta {
  readonly mode?: unknown;
  readonly repairOf?: unknown;
}
const aiMeta = (m: ChatMessage): AiMeta | null => {
  const v = m.meta?.workflowAi;
  return typeof v === 'object' && v !== null ? v : null;
};
const isMode = (v: unknown): v is WorkflowAiMode =>
  v === 'design' || v === 'edit' || v === 'explain' || v === 'debug';

/** The workflow cards of a conversation in order, each with the mode of the user message it answered. */
export function proposalsOf(detail: ThreadDetail): ProposalItem[] {
  const out: ProposalItem[] = [];
  for (const d of detail.drafts) {
    if (d.kind !== 'workflow') continue;
    const tool = detail.messages.find((m) => m.role === 'tool' && m.meta?.draftId === d.id);
    const asked =
      tool === undefined
        ? undefined
        : [...detail.messages].reverse().find((m) => m.role === 'user' && m.seq < tool.seq);
    const meta = asked === undefined ? null : aiMeta(asked);
    const p = d.payload;
    const issues = Array.isArray(p.issues)
      ? p.issues.flatMap((i): ApiIssue[] => {
          const x = i as { path?: unknown; code?: unknown };
          return typeof x.path === 'string' && typeof x.code === 'string'
            ? [{ path: x.path, code: x.code }]
            : [];
        })
      : [];
    out.push({
      draft: d,
      mode: isMode(meta?.mode) ? meta.mode : null,
      repair: typeof meta?.repairOf === 'string',
      valid: p.valid === true,
      issues,
      definition:
        typeof p.definition === 'object' && p.definition !== null
          ? (p.definition as Record<string, unknown>)
          : null,
    });
  }
  return out;
}

function IssueList(props: { readonly item: ProposalItem }): ReactNode {
  const words = useT().workflows.issues;
  const say = issueTextWith(words);
  const parsed = props.item.definition === null ? null : asDoc(props.item.definition);
  const doc = parsed !== null && 'doc' in parsed ? parsed.doc : null;
  const mapped = doc === null ? null : mapIssues(doc, props.item.issues);
  const nodeOf = (i: ApiIssue): string | null => {
    if (mapped === null) return null;
    for (const [id, list] of mapped.byNode) if (list.includes(i)) return id;
    return null;
  };
  return (
    <ul className="m-0 mt-1 grid list-none gap-0.5 p-0" data-testid="ai-issues">
      {props.item.issues.map((i) => {
        const node = nodeOf(i);
        return (
          <li key={`${i.path}:${i.code}`}>
            {node === null ? null : <span className="font-dy-mono font-bold">{`${node} · `}</span>}
            {say(i)}
          </li>
        );
      })}
    </ul>
  );
}

function Conversation(props: {
  readonly opened: WorkflowAiThread;
  readonly project: string;
  readonly workflowId: string | null;
  readonly doc: Doc;
  readonly selected: readonly string[];
  readonly canEdit: boolean;
  readonly initialMode?: WorkflowAiMode | undefined;
  readonly initialRun?: string | null | undefined;
  readonly onProposal: (p: AiProposal) => void;
  readonly onFresh: () => void;
}): ReactNode {
  const t = useT().workflowAi;
  const now = useNow();
  const threadId = props.opened.thread.id;
  const chat = useOpsChat(threadId);
  const detail = chat.chat.status === 'ready' ? chat.chat.detail : null;
  const saved = props.workflowId !== null;
  const empty = props.doc.nodes.length === 0;
  const modes: WorkflowAiMode[] = [
    ...(props.canEdit ? (['design'] as const) : []),
    ...(props.canEdit && !empty ? (['edit'] as const) : []),
    ...(empty ? [] : (['explain'] as const)),
    ...(saved ? (['debug'] as const) : []),
  ];
  const fallback: WorkflowAiMode = props.canEdit ? (empty ? 'design' : 'edit') : saved ? 'explain' : 'design';
  const [mode0, setMode] = useState<WorkflowAiMode>(props.initialMode ?? fallback);
  const mode = modes.includes(mode0) ? mode0 : (modes[0] ?? fallback);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [runs, setRuns] = useState<readonly WorkflowRunSummary[] | null>(null);
  const [runId, setRunId] = useState<string | null>(props.initialRun ?? null);
  const name = props.opened.workflow.name;

  useEffect(() => {
    if (!saved || name === null) return;
    let alive = true;
    listWorkflowRuns().then(
      (all) => {
        if (!alive) return;
        const failed = all.filter(
          (r) => r.project === props.project && r.name === name && r.state === 'failed',
        );
        setRuns(failed);
        setRunId((cur) => cur ?? failed[0]?.id ?? null);
      },
      () => {
        if (alive) setRuns([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [saved, name, props.project]);

  // New workflow cards since the panel opened: valid ones go to the editor, invalid ones are only shown.
  const proposals = useMemo(() => (detail === null ? [] : proposalsOf(detail)), [detail]);
  const handled = useRef<Set<string> | null>(null);
  const { onProposal } = props;
  useEffect(() => {
    if (detail === null) return;
    if (handled.current === null) {
      handled.current = new Set(proposals.map((p) => p.draft.id));
      return;
    }
    for (const p of proposals) {
      if (handled.current.has(p.draft.id)) continue;
      handled.current.add(p.draft.id);
      if (!p.valid || p.definition === null) continue;
      const parsed = asDoc(p.definition);
      if ('error' in parsed) continue;
      onProposal({ draftId: p.draft.id, mode: p.mode === 'edit' ? 'edit' : 'design', doc: parsed.doc });
    }
  }, [detail, proposals, onProposal]);

  const latest = proposals.at(-1) ?? null;
  const running = detail?.turn != null || chat.live !== null;

  const send = useCallback(
    async (m: WorkflowAiMode, words: string) => {
      const said = words.trim();
      if (said === '' || busy) return;
      setBusy(true);
      setError(null);
      try {
        await sendWorkflowAi(threadId, {
          mode: m,
          text: said,
          project: props.project,
          ...(props.workflowId === null ? {} : { workflowId: props.workflowId }),
          document: cleanDoc(props.doc),
          ...(m === 'edit' && props.selected.length > 0 ? { selected: props.selected } : {}),
          ...(m === 'debug' && runId !== null ? { runId } : {}),
        });
        setText('');
        chat.reload();
      } catch (err) {
        setError(toApiError(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, threadId, props.project, props.workflowId, props.doc, props.selected, runId, chat],
  );

  // A link from a failed run ("Neden başarısız oldu?"): ask once on arrival.
  const autoAsked = useRef(false);
  useEffect(() => {
    if (autoAsked.current || props.initialMode !== 'debug' || props.initialRun == null || detail === null)
      return;
    autoAsked.current = true;
    void send('debug', t.debugPrompt);
  }, [detail, props.initialMode, props.initialRun, send, t.debugPrompt]);

  const shown = (detail?.messages ?? []).filter(
    (m) => m.role !== 'tool' || m.meta?.name === 'draft_workflow',
  );
  const latestInvalid = latest !== null && !latest.valid;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ai-conversation" data-thread={threadId}>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
        {detail === null && chat.chat.status === 'error' ? (
          <DyNotice tone="red">{chat.chat.message}</DyNotice>
        ) : shown.length === 0 && !running ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{t.empty}</p>
        ) : (
          <ol className="m-0 grid list-none gap-2 p-0" data-testid="ai-messages">
            {shown.map((m) => {
              const meta = aiMeta(m);
              if (m.role === 'user') {
                const repair = typeof meta?.repairOf === 'string';
                return (
                  <li
                    key={m.id}
                    data-role={repair ? 'repair' : 'user'}
                    className={cx(
                      'rounded-[10px] px-3 py-2 text-[0.875rem]',
                      repair ? 'border border-dashed border-dy-line text-dy-muted' : 'ml-6 bg-dy-sunk',
                    )}
                  >
                    {repair ? t.repairMessage : <span className="whitespace-pre-wrap">{m.content}</span>}
                  </li>
                );
              }
              if (m.role === 'tool')
                return (
                  <li key={m.id} className="text-[0.75rem] text-dy-faint">
                    {t.tool({ name: 'draft_workflow' })}
                  </li>
                );
              if (m.role === 'error')
                return (
                  <li key={m.id}>
                    <DyNotice tone="red">{m.content}</DyNotice>
                  </li>
                );
              return (
                <li key={m.id} data-role="assistant" className="text-[0.875rem]">
                  <Markdown text={m.content} />
                </li>
              );
            })}
            {chat.live === null || chat.live.text === '' ? null : (
              <li data-role="assistant" className="text-[0.875rem] text-dy-muted">
                <Markdown text={chat.live.text} />
              </li>
            )}
          </ol>
        )}
        {running ? (
          <p
            className="m-0 mt-2 flex items-center gap-2 text-[0.8125rem] text-dy-muted"
            data-testid="ai-working"
          >
            <DyIcon name="clock" className="size-4" />
            {t.working}
          </p>
        ) : null}
        {latest === null ? null : latestInvalid ? (
          <div className="mt-3" data-testid="ai-invalid">
            <DyNotice tone={latest.repair || !running ? 'red' : 'amber'}>
              {latest.repair
                ? t.proposal.invalidAfterRepair
                : running
                  ? t.proposal.repairing
                  : t.proposal.invalid}
              <IssueList item={latest} />
            </DyNotice>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="ai-latest">
            <span className="text-[0.8125rem] text-dy-muted">{t.proposal.latest}</span>
            {latest.definition === null ? null : (
              <DyButton
                variant="ghost"
                icon={latest.mode === 'edit' ? 'branch' : 'grid'}
                disabled={!props.canEdit}
                onClick={() => {
                  if (latest.definition === null) return;
                  const parsed = asDoc(latest.definition);
                  if ('error' in parsed) return;
                  props.onProposal({
                    draftId: latest.draft.id,
                    mode: latest.mode === 'edit' ? 'edit' : 'design',
                    doc: parsed.doc,
                  });
                }}
              >
                {latest.mode === 'edit' ? t.proposal.review : t.proposal.load}
              </DyButton>
            )}
          </div>
        )}
      </div>
      <form
        className="grid shrink-0 gap-2 border-t border-dy-line px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(mode, text);
        }}
      >
        <div role="radiogroup" aria-label={t.modesLabel} className="flex flex-wrap gap-1">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              data-testid={`ai-mode-${m}`}
              onClick={() => {
                setMode(m);
              }}
              className={cx(
                'dy-press min-h-8 rounded-[8px] px-2.5 text-[0.8125rem] font-medium',
                mode === m ? 'bg-dy-ink text-dy-card' : 'bg-dy-sunk text-dy-ink',
              )}
            >
              {t.modes[m]}
            </button>
          ))}
        </div>
        <p className="m-0 text-[0.75rem] text-dy-muted">{t.hint[mode]}</p>
        {props.canEdit ? null : <p className="m-0 text-[0.75rem] text-dy-muted">{t.viewerNote}</p>}
        {mode === 'edit' && props.selected.length > 0 ? (
          <p className="m-0 text-[0.75rem] text-dy-muted" data-testid="ai-selected">
            {t.selected({ n: props.selected.length })}
          </p>
        ) : null}
        {mode === 'debug' ? (
          runs !== null && runs.length === 0 ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.run.none}</p>
          ) : (
            <label className="grid gap-1 text-[0.8125rem]">
              <span className="font-medium">{t.run.label}</span>
              <select
                value={runId ?? ''}
                data-testid="ai-run"
                onChange={(e) => {
                  setRunId(e.target.value === '' ? null : e.target.value);
                }}
                className="min-h-9 rounded-[8px] border border-dy-line bg-dy-card px-2"
              >
                {(runs ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {t.run.option({ id: r.id.slice(0, 8), time: agoText(r.createdAt, now) })}
                  </option>
                ))}
                {runId !== null && !(runs ?? []).some((r) => r.id === runId) ? (
                  <option value={runId}>{runId.slice(0, 8)}</option>
                ) : null}
              </select>
            </label>
          )
        ) : null}
        <textarea
          value={text}
          rows={3}
          data-testid="ai-input"
          aria-label={t.placeholder[mode]}
          placeholder={t.placeholder[mode]}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(mode, text);
            }
          }}
          className="w-full resize-y rounded-[10px] border border-dy-line bg-dy-card px-3 py-2 text-[0.875rem]"
        />
        <DyApiError error={error} />
        {chat.available ? null : <DyNotice tone="amber">{t.unavailable}</DyNotice>}
        <div className="flex flex-wrap items-center gap-2">
          <DyButton
            type="submit"
            variant="primary"
            icon="send"
            busy={busy}
            disabled={
              text.trim() === '' || running || !chat.available || (mode === 'debug' && runId === null)
            }
            data-testid="ai-send"
          >
            {t.send}
          </DyButton>
          {mode === 'explain' ? (
            <DyButton
              variant="ghost"
              disabled={running || busy}
              data-testid="ai-explain"
              onClick={() => void send('explain', t.explainPrompt)}
            >
              {t.explainPrompt}
            </DyButton>
          ) : null}
          {mode === 'debug' && runId !== null ? (
            <DyButton
              variant="ghost"
              disabled={running || busy}
              data-testid="ai-debug"
              onClick={() => void send('debug', t.debugPrompt)}
            >
              {t.debugPrompt}
            </DyButton>
          ) : null}
          {running ? (
            <DyButton variant="ghost" onClick={chat.stop}>
              {t.stop}
            </DyButton>
          ) : null}
          <span className="flex-1" />
          <DyButton variant="ghost" onClick={props.onFresh}>
            {t.newConversation}
          </DyButton>
          <Link to={`/chat/${encodeURIComponent(threadId)}`} className="text-[0.8125rem] text-dy-muted">
            {t.openInChat}
          </Link>
        </div>
      </form>
    </div>
  );
}

export function AiPanel(props: {
  readonly project: string;
  /** The latest saved version's id (null: a new workflow). */
  readonly workflowId: string | null;
  readonly doc: Doc;
  readonly selected: readonly string[];
  readonly canEdit: boolean;
  readonly initialMode?: WorkflowAiMode | undefined;
  readonly initialRun?: string | null | undefined;
  /** A conversation to continue (`?aiThread=` from Sohbet); else the latest linked one / a new one. */
  readonly initialThread?: string | null | undefined;
  /** The conversation (the editor links it to the workflow when it saves a new one). */
  readonly onThread: (threadId: string) => void;
  readonly onProposal: (p: AiProposal) => void;
  readonly onClose: () => void;
}): ReactNode {
  const t = useT().workflowAi;
  const [opened, setOpened] = useState<WorkflowAiThread | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const { project, workflowId, onThread } = props;
  const continued = useRef(props.initialThread ?? null);
  const open = useCallback(
    (fresh: boolean) => {
      if (project === '') return;
      setError(null);
      const threadId = fresh ? null : continued.current;
      continued.current = null;
      openWorkflowAiThread({
        project,
        ...(workflowId === null ? {} : { workflowId }),
        ...(fresh ? { fresh } : {}),
        ...(threadId === null ? {} : { threadId }),
      }).then(
        (o) => {
          setOpened(o);
          onThread(o.thread.id);
        },
        (err: unknown) => {
          setError(toApiError(err));
        },
      );
    },
    [project, workflowId, onThread],
  );
  useEffect(() => {
    open(false);
  }, [open]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workflow-ai-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-dy-line px-4 py-2.5">
        <DyIcon name="brain" className="size-4 text-dy-teal" />
        <h2 className="m-0 min-w-0 flex-1 truncate text-[0.9375rem] font-bold">{t.title}</h2>
        <button
          type="button"
          aria-label={t.close}
          onClick={props.onClose}
          className="dy-press grid size-8 place-items-center rounded-lg text-dy-muted"
        >
          <DyIcon name="xc" className="size-4" />
        </button>
      </div>
      {project === '' ? (
        <p className="m-0 px-4 py-3 text-[0.875rem] text-dy-muted">{t.needProject}</p>
      ) : opened === null ? (
        <div className="px-4 py-3">
          <DyApiError error={error} />
        </div>
      ) : (
        <Conversation
          key={opened.thread.id}
          opened={opened}
          project={project}
          workflowId={workflowId}
          doc={props.doc}
          selected={props.selected}
          canEdit={props.canEdit}
          initialMode={props.initialMode}
          initialRun={props.initialRun}
          onProposal={props.onProposal}
          onFresh={() => {
            open(true);
          }}
        />
      )}
    </div>
  );
}

/** p15-workflow-ai: the review of an edit proposal — every change with a checkbox, accept / reject all, apply. */
export function AiReview(props: {
  readonly changes: readonly AiChange[];
  readonly accepted: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
  readonly onAcceptAll: () => void;
  readonly onRejectAll: () => void;
  readonly onApply: () => void;
}): ReactNode {
  const t = useT().workflowAi.review;
  const label = (c: AiChange): string => {
    switch (c.kind) {
      case 'node-added':
        return t.kinds.nodeAdded({ id: c.id });
      case 'node-removed':
        return t.kinds.nodeRemoved({ id: c.id });
      case 'node-changed':
        return t.kinds.nodeChanged({ id: c.id, fields: (c.fields ?? []).join(', ') });
      case 'edge-added':
        return t.kinds.edgeAdded({ id: c.id });
      case 'edge-removed':
        return t.kinds.edgeRemoved({ id: c.id });
      case 'settings':
        return t.kinds.settings({ fields: (c.fields ?? []).join(', ') });
    }
  };
  const tone = (c: AiChange): string =>
    c.kind === 'node-added' || c.kind === 'edge-added'
      ? 'bg-dy-green'
      : c.kind === 'node-removed' || c.kind === 'edge-removed'
        ? 'bg-dy-red'
        : 'bg-dy-amber';
  return (
    <section
      aria-label={t.title({ n: props.changes.length })}
      data-testid="ai-review"
      className="grid max-h-[50%] shrink-0 gap-2 overflow-y-auto border-b border-dy-line px-4 py-3"
    >
      <h3 className="m-0 text-[0.875rem] font-bold">{t.title({ n: props.changes.length })}</h3>
      <p className="m-0 text-[0.75rem] text-dy-muted">{t.reviewing}</p>
      <ul className="m-0 grid list-none gap-1 p-0">
        {props.changes.map((c) => (
          <li key={c.key}>
            <label
              className="flex items-start gap-2 text-[0.8125rem]"
              data-testid="ai-change"
              data-key={c.key}
            >
              <input
                type="checkbox"
                checked={props.accepted.has(c.key)}
                onChange={() => {
                  props.onToggle(c.key);
                }}
                className="mt-0.5"
              />
              <span aria-hidden="true" className={cx('mt-1.5 size-2 shrink-0 rounded-full', tone(c))} />
              <span className="min-w-0 break-words">{label(c)}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <DyButton variant="primary" icon="check" data-testid="ai-accept-all" onClick={props.onAcceptAll}>
          {t.acceptAll}
        </DyButton>
        <DyButton data-testid="ai-apply" onClick={props.onApply}>
          {t.applySelected}
        </DyButton>
        <DyButton variant="ghost" data-testid="ai-reject-all" onClick={props.onRejectAll}>
          {t.rejectAll}
        </DyButton>
      </div>
    </section>
  );
}
