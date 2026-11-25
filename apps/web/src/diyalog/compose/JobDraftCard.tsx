import { useErrorText } from '../../i18n/errors';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { type ChatDraft, confirmDraft, type DraftEdit, dismissDraft, editDraft } from '../../api/chat';
import { listProjects } from '../../api/directory';
import { getQueue, isPriorityClass, PRIORITY_CLASSES, type QueueView } from '../../api/queue';
import { cx } from '../../components/ui';
import { summarizeDraft } from '../../screens/chat/drafts';
import type { PrefillState } from '../../screens/composer/prefill';
import { RUNTIMES } from '../../screens/composer/draft';
import { shortTime } from '../../screens/chat/time';
import { useRuntimeUsage } from '../../screens/usage/runtimeUsage';
import { isStepUpRequired } from '../../stepup/StepUpProvider';
import { Countdown } from '../Countdown';
import { DyIcon } from '../icons';
import { CardButton, CardLink, LiveCard } from '../LiveCard';
import { DecisionPanel, useFreshStepUp } from '../ops/DecisionPanel';
import { useCardKeys } from '../ops/keys';
import { RuntimeMark, runtimeDisplayName } from '../RuntimeMark';
import { type DyState, StateBadge } from '../StateBadge';
import { choiceWords, limitLine } from './labels';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { estimateQueue } from './queueEstimate';
import { JobApprovalMode, JobQuickButtons, startedJob } from '../drafts/parts';
import { DraftTimeLimitField, JobTimeLimit } from '../common/timeLimit';
import {
  deployFacts,
  publishChain,
  schedulingFacts,
  summarizeDraft as summarizeDyDraft,
} from '../drafts/summary';
import { KeyValue } from '../KeyValue';
import { SimilarRecordNotice } from '../related/RelatedWork';
import { useHeldCard } from '../drafts/held';

/**
 * p12-diyalog Faz 3 (docs/design/p12-diyalog.md §11.2): the assistant's job draft as an EDITABLE card in the thread —
 * target mockup `#new`. Every field is the card's real state: a change is saved at once through `PATCH
 * /chat/drafts/:id` (the master rebuilds the card with draft_job's own checks for this person and answers the new
 * version — refusals show under the field), so what the card shows is what "Kuyruğa al" runs. Text fields save when
 * they lose focus (or before confirming). Beside the fields: the project's runtime advice, each runtime's limit line,
 * where it would run, and where it would enter the queue (an estimate from GET /queue). Confirming asks for the
 * authenticator code in the card when the session has no fresh step-up (the master requires it either way).
 */

type Field =
  | 'title'
  | 'project'
  | 'priorityClass'
  | 'runtime'
  | 'prompt'
  | 'approvalPolicy'
  | 'sandboxProfile'
  | 'workers'
  | 'deploy'
  | 'verifyOnSuccess'
  | 'inputs'
  | 'maxDurationSec';

const STATE: Readonly<Record<string, DyState>> = {
  proposed: 'needs',
  confirmed: 'done',
  dismissed: 'cancelled',
  expired: 'stale',
};

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** The parts of a job draft's payload the card shows and edits. */
export function jobDraftView(d: Pick<ChatDraft, 'payload' | 'title' | 'project'>) {
  const p = d.payload;
  const spec = rec(p.spec);
  const review = rec(p.review);
  const placement = rec(review.placement);
  const advice = rec(p.runtimeAdvice);
  const repo = rec(spec.repository);
  const files = Array.isArray(p.inputFiles)
    ? p.inputFiles.map(rec).flatMap((f) => (typeof f.name === 'string' ? [f.name.slice(0, 100)] : []))
    : [];
  const refs =
    files.length > 0 ||
    typeof p.continueFrom === 'string' ||
    strs(p.chatAttachments).length > 0 ||
    Array.isArray(p.inputArtifacts);
  const reuse = rec(p.reuse);
  return {
    project: typeof p.project === 'string' ? p.project : (d.project ?? ''),
    runtime: typeof spec.runtime === 'string' ? spec.runtime : '',
    model: typeof spec.model === 'string' ? spec.model : null,
    prompt: typeof spec.prompt === 'string' ? spec.prompt : '',
    sandbox: typeof spec.sandboxProfile === 'string' ? spec.sandboxProfile : 'container',
    // p15-autonomy: the time limit, editable on the card.
    maxSec:
      typeof rec(spec.limits).maxDurationSec === 'number'
        ? (rec(spec.limits).maxDurationSec as number)
        : null,
    approval: typeof spec.approvalPolicy === 'string' ? spec.approvalPolicy : 'ask-sensitive',
    cls: isPriorityClass(p.priorityClass) ? p.priorityClass : 'normal',
    pinned: strs(rec(spec.requirements).workers),
    machines: strs(placement.machines),
    warning: typeof placement.warning === 'string' ? placement.warning : null,
    note: typeof placement.note === 'string' ? placement.note : null,
    defaults: strs(review.projectDefaults),
    advice:
      typeof advice.text === 'string' && advice.text !== ''
        ? {
            text: advice.text.slice(0, 500),
            recommended: typeof advice.recommended === 'string' ? advice.recommended : null,
          }
        : null,
    deploy: p.deployOnSuccess === undefined || p.deployOnSuccess === null ? null : rec(p.deployOnSuccess),
    verify: typeof p.verifyOnSuccess === 'string' ? p.verifyOnSuccess : null,
    files,
    refs,
    branch: typeof repo.workBranch === 'string' ? repo.workBranch : null,
    base: typeof repo.baseRef === 'string' ? repo.baseRef : null,
    identical:
      typeof reuse.jobId === 'string' && /^[0-9a-f-]{36}$/i.test(reuse.jobId) && typeof reuse.age === 'string'
        ? { jobId: reuse.jobId, age: reuse.age }
        : null,
    template: typeof rec(p.template).id === 'string',
  };
}

// ------------------------------------------------------------------------------------------------ shared reads

let projectsCache: Promise<string[]> | null = null;
function useProjects(current: string): string[] {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    projectsCache ??= listProjects().then(
      (ps) => ps.map((p) => p.id),
      () => {
        projectsCache = null;
        return [];
      },
    );
    void projectsCache.then((ids) => {
      if (live) setList(ids);
    });
    return () => {
      live = false;
    };
  }, []);
  return list.includes(current) || current === '' ? list : [current, ...list];
}

const QUEUE_POLL_MS = 30_000;
function useQueue(open: boolean): QueueView | null {
  const [view, setView] = useState<QueueView | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = (): void => {
      getQueue(null).then(
        (v) => {
          if (live) setView(v);
        },
        () => undefined,
      );
    };
    load();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') load();
    }, QUEUE_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [open]);
  return view;
}

// ------------------------------------------------------------------------------------------------ pieces

const LABEL = 'mb-[5px] block text-[0.8125rem] font-bold';
const INPUT =
  'w-full min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card px-[11px] py-2 text-base text-dy-ink outline-none focus:border-dy-teal sm:text-[0.9375rem] disabled:opacity-60';

function FieldError(props: { readonly id: string; readonly text: string | undefined }): ReactNode {
  if (props.text === undefined) return null;
  return (
    <p id={props.id} role="alert" className="m-0 mt-1.5 text-[0.8125rem] text-dy-red-ink">
      {props.text}
    </p>
  );
}

export function Seg<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly disabled: boolean;
  readonly onChange: (v: T) => void;
}): ReactNode {
  return (
    <div
      role="group"
      aria-label={props.label}
      className="inline-flex flex-wrap gap-0.5 rounded-[10px] border border-dy-line bg-dy-sunk p-[3px]"
    >
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === props.value}
          disabled={props.disabled}
          onClick={() => {
            if (o.value !== props.value) props.onChange(o.value);
          }}
          className={cx(
            'dy-press rounded-[7px] px-3 py-[5px] text-sm',
            o.value === props.value
              ? 'bg-dy-card font-bold text-dy-ink shadow-dy-seg'
              : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const TAG: Readonly<Record<'teal' | 'violet' | 'red', string>> = {
  teal: 'bg-dy-teal-soft text-dy-teal-ink',
  violet: 'bg-dy-violet-soft text-dy-violet',
  red: 'bg-dy-red-soft text-dy-red-ink',
};

// ------------------------------------------------------------------------------------------------ card

export function JobDraftCard(props: {
  readonly d: ChatDraft;
  readonly threadId: string;
  readonly onChanged: () => void;
}): ReactNode {
  const sayError = useErrorText();
  const t = useT();
  const fmt = useFormat();
  const w = t.chatCompose.card;
  const words = choiceWords(t);
  const [saved, setSaved] = useState<ChatDraft | null>(null);
  // A fresher copy from the thread replaces the one the last edit answered.
  useEffect(() => {
    setSaved(null);
  }, [props.d]);
  const d = saved !== null && saved.id === props.d.id ? saved : props.d;
  const v = jobDraftView(d);
  const open = d.state === 'proposed';
  const stateLabels: Readonly<Record<string, string>> = w.state;
  const st = { state: STATE[d.state] ?? ('queued' as const), label: stateLabels[d.state] ?? d.state };
  const key = `draft:${d.id}`;
  const uid = useId();
  // p15-autonomy: no code up front when the security policy waives chat cards.
  const fresh = useFreshStepUp('chat.cards');
  const navigate = useNavigate();
  const { data: usage } = useRuntimeUsage();
  const projects = useProjects(v.project);
  const queue = useQueue(open);

  const [title, setTitle] = useState(d.title);
  const [prompt, setPrompt] = useState(v.prompt);
  const editing = useRef<Field | null>(null);
  useEffect(() => {
    if (editing.current !== 'title') setTitle(d.title);
  }, [d.title]);
  useEffect(() => {
    if (editing.current !== 'prompt') setPrompt(v.prompt);
  }, [v.prompt]);

  const [saving, setSaving] = useState<Field | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState<'confirm' | 'dismiss' | null>(null);
  // oss-sec3: held because the assistant's turn read untrusted content — why, and "remember" where allowed.
  const held = useHeldCard(d, open, busy !== null);
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(field: Field, edit: DraftEdit): Promise<boolean> {
    setSaving(field);
    setErrors((e) => ({ ...e, [field]: undefined }));
    try {
      const next = await editDraft(d.id, edit);
      setSaved(next);
      props.onChanged();
      return true;
    } catch (err) {
      setErrors((e) => ({ ...e, [field]: sayError(err) }));
      return false;
    } finally {
      setSaving(null);
    }
  }

  // p15-job-titles: a job title is one short line (≤ 60 characters); the details belong in the prompt.
  const titleErr =
    title.trim() === '' ? w.titleEmpty : Array.from(title.trim()).length > 60 ? w.titleTooLong : undefined;
  const promptErr = prompt.trim() === '' ? w.promptEmpty : undefined;

  async function flushText(): Promise<boolean> {
    if (titleErr !== undefined || promptErr !== undefined) return false;
    const edit: DraftEdit = {
      ...(title.trim() !== d.title ? { title: title.trim() } : {}),
      ...(prompt.trim() !== v.prompt.trim() ? { prompt: prompt.trim() } : {}),
    };
    if (Object.keys(edit).length === 0) return true;
    return save(edit.prompt === undefined ? 'title' : 'prompt', edit);
  }

  async function confirm(): Promise<void> {
    setError(null);
    if (!(await flushText())) return;
    if (!fresh) {
      setNeedsCode(true);
      return;
    }
    setBusy('confirm');
    try {
      await confirmDraft(d.id, {}, held.remember ? { remember: true } : {});
      props.onChanged();
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

  useCardKeys(key, {
    approve: () => {
      if (open) void confirm();
    },
    deny: () => {
      if (open) void dismiss();
    },
  });

  const locked = !open || saving !== null || busy !== null;
  const blocked =
    titleErr !== undefined || promptErr !== undefined
      ? w.fixMarked
      : v.warning === null
        ? undefined
        : w.noMachine;
  const est =
    queue === null || !open
      ? null
      : estimateQueue(queue, rec(d.payload.spec), v.cls, title || d.title, {}, t, fmt);
  const deployEnv = v.deploy?.env === 'production' ? 'production' : 'preview';
  const chain = v.deploy === null ? [] : publishChain(v.deploy, deployEnv, t);
  // p12-diyalog-w4: what the classic card kept behind "Details" (repository, limits, project defaults, fallbacks).
  const extra = [
    ...schedulingFacts(rec(d.payload.spec), t),
    ...summarizeDyDraft(d, t, fmt).details.filter((f) => f.k !== t.drafts.facts.prompt),
  ];

  const ids = {
    title: `${uid}-title`,
    project: `${uid}-project`,
    prompt: `${uid}-prompt`,
    approval: `${uid}-approval`,
    sandbox: `${uid}-sandbox`,
    workers: `${uid}-workers`,
    verify: `${uid}-verify`,
    err: (f: Field) => `${uid}-err-${f}`,
  };
  const describedBy = (f: Field): string | undefined => (errors[f] === undefined ? undefined : ids.err(f));

  if (!open) {
    const started = startedJob(d, d.result);
    return (
      <LiveCard
        cardKey={key}
        kind={{ label: w.kindDone, icon: d.state === 'confirmed' ? 'check' : 'pen', tone: 'green' }}
        state={<StateBadge state={st.state} label={st.label} />}
        meta={v.project}
        title={d.title}
        sub={
          <>
            <span>{v.project}</span>
            <span>{words.cls[v.cls]}</span>
            <RuntimeMark runtime={v.runtime} />
          </>
        }
        {...(started === null
          ? {}
          : {
              // p12-diyalog-w4: the job this card started — its approval mode and the quick buttons stay in view.
              after: (
                <>
                  <JobApprovalMode
                    jobId={started}
                    state={typeof d.result?.state === 'string' ? d.result.state : ''}
                  />
                  <JobTimeLimit
                    jobId={started}
                    state={typeof d.result?.state === 'string' ? d.result.state : ''}
                  />
                  <JobQuickButtons threadId={props.threadId} jobId={started} onDrafted={props.onChanged} />
                </>
              ),
            })}
        resolved={
          <span className="text-dy-muted">
            {st.label}
            {d.decidedAt === null ? '' : `, ${shortTime(d.decidedAt)}`}
            {typeof d.result?.jobId === 'string' ? (
              <>
                {' · '}
                <Link
                  to={`/jobs/${encodeURIComponent(d.result.jobId)}`}
                  className="text-dy-ink underline-offset-2 hover:underline"
                >
                  {w.openJob}
                </Link>
              </>
            ) : null}
          </span>
        }
      >
        <p className="m-0 text-[0.875rem] whitespace-pre-wrap text-dy-muted [overflow-wrap:anywhere]">
          {v.prompt}
        </p>
      </LiveCard>
    );
  }

  return (
    <LiveCard
      cardKey={key}
      kind={{ label: w.kindDraft, icon: 'pen', tone: 'teal' }}
      meta={saving === null ? st.label : w.saving}
      aside={v.project}
      title={d.title}
      actions={
        <>
          <CardButton
            variant="primary"
            icon="plus"
            busy={busy === 'confirm'}
            disabled={locked || blocked !== undefined}
            expanded={needsCode}
            onClick={() => void confirm()}
          >
            {w.enqueue}
          </CardButton>
          <CardButton
            variant="ghost"
            busy={busy === 'dismiss'}
            disabled={locked}
            onClick={() => void dismiss()}
          >
            {w.dismiss}
          </CardButton>
          <CardButton
            variant="ghost"
            disabled={locked}
            onClick={() => {
              void flushText().then(() => {
                const prefill = summarizeDraft(d).prefill;
                if (prefill === undefined) return;
                const state: PrefillState = { prefill: prefill };
                void navigate('/jobs/new', { state });
              });
            }}
          >
            {w.editInForm}
          </CardButton>
          <CardLink to={`/jobs/templates/new?fromDraft=${encodeURIComponent(d.id)}`} variant="ghost">
            {w.saveAsTemplate}
          </CardLink>
        </>
      }
      hint={blocked ?? (v.cls === 'background' ? w.hintBackground : w.hintNow)}
      panel={
        <>
          {held.node}
          {needsCode ? (
            <DecisionPanel
              intent="approve"
              needsCode
              submitLabel={w.submitCode}
              onSubmit={async () => {
                await confirmDraft(d.id, {}, held.remember ? { remember: true } : {});
                setNeedsCode(false);
                props.onChanged();
              }}
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
      }
    >
      <div className="grid gap-3.5" data-testid="dy-draft-form">
        {v.advice === null ? null : (
          <p
            data-testid="dy-draft-advice"
            className={cx(
              'm-0 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-[10px] px-3 py-2 text-[0.875rem]',
              v.advice.recommended !== null && v.advice.recommended !== v.runtime
                ? 'bg-dy-amber-soft text-dy-amber-ink'
                : 'bg-dy-sunk text-dy-muted',
            )}
          >
            <span className="min-w-0 flex-1">
              <b className="font-bold">{w.adviceLabel}</b>
              {v.advice.text}
            </span>
            {v.advice.recommended !== null &&
            v.advice.recommended !== v.runtime &&
            (RUNTIMES as readonly string[]).includes(v.advice.recommended) ? (
              <button
                type="button"
                disabled={locked}
                onClick={() => void save('runtime', { runtime: v.advice?.recommended ?? v.runtime })}
                className="dy-press font-bold underline underline-offset-2 disabled:opacity-50"
              >
                {w.switchTo({ runtime: runtimeDisplayName(v.advice.recommended) })}
              </button>
            ) : null}
          </p>
        )}
        {v.identical === null ? null : (
          <p className="m-0 rounded-[10px] bg-dy-amber-soft px-3 py-2 text-[0.875rem] text-dy-amber-ink">
            {w.identical({ age: v.identical.age })}
            <Link to={`/jobs/${v.identical.jobId}`} className="font-bold underline underline-offset-2">
              {w.openResult}
            </Link>
            {w.orEnqueueAnyway}
          </p>
        )}
        {/* p17-embeddings: "Benzer bir kayıt var" — an open or recent similar job of the project (never blocks). */}
        {v.identical === null ? (
          <SimilarRecordNotice kind="job" project={v.project} text={`${d.title}\n${v.prompt}`} />
        ) : null}

        <div>
          <label htmlFor={ids.title} className={LABEL}>
            {w.title}
          </label>
          <input
            id={ids.title}
            type="text"
            value={title}
            maxLength={120}
            disabled={!open}
            aria-invalid={titleErr !== undefined || errors.title !== undefined ? true : undefined}
            aria-describedby={describedBy('title') ?? (titleErr === undefined ? undefined : ids.err('title'))}
            onFocus={() => {
              editing.current = 'title';
            }}
            onChange={(e) => {
              setTitle(e.target.value);
            }}
            onBlur={() => {
              editing.current = null;
              if (titleErr === undefined && title.trim() !== d.title)
                void save('title', { title: title.trim() });
            }}
            className={INPUT}
          />
          <FieldError id={ids.err('title')} text={errors.title ?? titleErr} />
        </div>

        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <div>
            <label htmlFor={ids.project} className={LABEL}>
              {w.project}
            </label>
            <select
              id={ids.project}
              value={v.project}
              disabled={locked}
              aria-describedby={describedBy('project')}
              onChange={(e) => void save('project', { project: e.target.value })}
              className={INPUT}
            >
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <FieldError id={ids.err('project')} text={errors.project} />
          </div>
          <div>
            <span className={LABEL} id={`${uid}-cls`}>
              {w.cls}
            </span>
            <Seg
              label={w.clsGroup}
              value={v.cls}
              disabled={locked}
              options={PRIORITY_CLASSES.map((c) => ({ value: c, label: words.cls[c] }))}
              onChange={(c) => void save('priorityClass', { priorityClass: c })}
            />
            <p className="m-0 mt-1 text-[0.78125rem] text-dy-muted">{words.classHint[v.cls]}</p>
            <FieldError id={ids.err('priorityClass')} text={errors.priorityClass} />
          </div>
        </div>

        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className={LABEL}>{w.runtimeAndMachine}</legend>
          <div
            role="radiogroup"
            aria-label="Runtime" // i18n-ignore: glossary term, the same in both languages
            className="grid gap-2"
            data-testid="dy-draft-runtimes"
          >
            {RUNTIMES.map((rt) => {
              const checked = rt === v.runtime;
              const line = limitLine(usage, rt, t, fmt);
              const recommended = v.advice?.recommended === rt;
              const tag: { tone: keyof typeof TAG; text: string } | null = recommended
                ? { tone: 'teal', text: w.tagRecommended }
                : line?.level === 'limited'
                  ? { tone: 'red', text: w.tagLimited }
                  : line?.level === 'near'
                    ? { tone: 'violet', text: w.tagNear }
                    : null;
              const where = checked
                ? v.pinned.length > 0
                  ? v.pinned.join(', ')
                  : (v.machines[0] ?? null)
                : null;
              return (
                <label
                  key={rt}
                  data-testid={`dy-draft-runtime-${rt}`}
                  className={cx(
                    'grid cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-2.5 rounded-[11px] border px-3 py-2.5 text-[0.9375rem]',
                    checked ? 'border-dy-teal bg-dy-teal-soft/55' : 'border-dy-line-2 bg-dy-card',
                    locked && 'cursor-default',
                  )}
                >
                  <input
                    type="radio"
                    name={`${uid}-rt`}
                    value={rt}
                    checked={checked}
                    disabled={locked}
                    onChange={() => void save('runtime', { runtime: rt })}
                    className="mt-[3px] accent-[var(--dy-teal)]"
                  />
                  <span className="min-w-0">
                    <b className="flex flex-wrap items-center gap-x-2 font-bold">
                      <RuntimeMark runtime={rt} />
                      {where === null ? null : (
                        <span className="font-dy-mono text-[0.8125rem] font-medium" translate="no">
                          {where}
                          {v.pinned.length === 0 && v.machines.length > 1
                            ? ` +${String(v.machines.length - 1)}`
                            : ''}
                        </span>
                      )}
                      {checked && v.model !== null ? (
                        <span className="text-[0.8125rem] font-normal text-dy-muted">{v.model}</span>
                      ) : null}
                    </b>
                    <small
                      className="mt-px block text-[0.8125rem] text-dy-muted"
                      data-testid={`dy-draft-limit-${rt}`}
                    >
                      {line === null ? w.noWindow : line.text}
                    </small>
                  </span>
                  {tag === null ? (
                    <span />
                  ) : (
                    <span
                      className={cx(
                        'rounded-md px-[7px] py-px text-[0.75rem] font-bold whitespace-nowrap',
                        TAG[tag.tone],
                      )}
                    >
                      {tag.text}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          <FieldError id={ids.err('runtime')} text={errors.runtime} />
          {v.warning !== null ? (
            <p
              role="alert"
              data-testid="dy-draft-placement-warning"
              className="m-0 mt-2 flex gap-2 rounded-[10px] bg-dy-red-soft px-3 py-2 text-[0.875rem] text-dy-red-ink"
            >
              <DyIcon name="xc" className="mt-0.5 size-4 shrink-0" />
              <span>{w.placementWarning({ warning: v.warning })}</span>
            </p>
          ) : v.note !== null ? (
            <p className="m-0 mt-2 text-[0.8125rem] text-dy-amber-ink">{v.note}</p>
          ) : v.machines.length > 0 ? (
            <p className="m-0 mt-2 text-[0.8125rem] text-dy-muted">
              {w.canRunOn}
              <span className="font-dy-mono" translate="no">
                {v.machines.slice(0, 6).join(', ')}
              </span>
            </p>
          ) : null}
        </fieldset>

        <div>
          <label htmlFor={ids.prompt} className={LABEL}>
            {w.prompt}
          </label>
          <textarea
            id={ids.prompt}
            value={prompt}
            disabled={!open}
            aria-invalid={promptErr !== undefined || errors.prompt !== undefined ? true : undefined}
            aria-describedby={
              describedBy('prompt') ?? (promptErr === undefined ? undefined : ids.err('prompt'))
            }
            onFocus={() => {
              editing.current = 'prompt';
            }}
            onChange={(e) => {
              setPrompt(e.target.value);
            }}
            onBlur={() => {
              editing.current = null;
              if (promptErr === undefined && prompt.trim() !== v.prompt.trim())
                void save('prompt', { prompt: prompt.trim() });
            }}
            className={cx(INPUT, 'min-h-[92px] resize-y leading-normal')}
          />
          <FieldError id={ids.err('prompt')} text={errors.prompt ?? promptErr} />
        </div>

        <div>
          <span className={LABEL}>
            {w.queueTitle}{' '}
            <span className="rounded-md bg-dy-sunk px-1.5 py-px text-[0.75rem] font-medium text-dy-muted">
              {w.estimate}
            </span>
          </span>
          {est === null ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{w.queueLoading}</p>
          ) : (
            <div data-testid="dy-draft-queue">
              <ol className="m-0 grid list-none gap-1 p-0" aria-label={w.queueList}>
                {est.hidden > 0 ? (
                  <li className="px-2.5 text-[0.78125rem] text-dy-muted">{w.moreAhead({ n: est.hidden })}</li>
                ) : null}
                {est.rows.map((r) => (
                  <li
                    key={r.key}
                    aria-current={r.isNew ? 'step' : undefined}
                    className={cx(
                      'grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-[9px] px-2.5 py-1.5 text-[0.84375rem]',
                      r.isNew
                        ? 'bg-dy-teal-soft font-bold text-dy-teal-ink outline-[1.5px] -outline-offset-[1.5px] outline-dy-teal outline-dashed'
                        : 'bg-dy-sunk',
                    )}
                  >
                    <span
                      className={cx('font-dy-mono', !r.isNew && 'text-dy-muted')}
                    >{`#${String(r.position)}`}</span>
                    <span className="min-w-0 truncate">{r.title}</span>
                    <span className={cx('text-right text-[0.78125rem]', !r.isNew && 'text-dy-muted')}>
                      {r.wait}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="m-0 mt-1.5 text-[0.8125rem] text-dy-muted">
                {w.estimatedStart({ start: est.start })}
                {est.free === null ? '' : w.freeSlots({ n: est.free })}
              </p>
            </div>
          )}
        </div>

        <details className="group rounded-[10px] border border-dy-line px-3 py-2">
          <summary className="cursor-pointer list-none text-[0.875rem] font-bold marker:hidden">
            <span className="inline-flex items-center gap-1.5">
              <DyIcon
                name="chev"
                className="size-3.5 transition-transform duration-150 ease-dy group-open:rotate-180"
              />
              {w.settings}
            </span>
            <span className="ml-2 font-normal text-dy-muted">
              {`${words.approval[v.approval]?.label ?? v.approval} · ${words.sandbox[v.sandbox]?.label ?? v.sandbox}${
                v.deploy === null ? '' : w.publishWhenDone
              }`}
            </span>
          </summary>
          <div className="mt-3 grid gap-3.5">
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div>
                <label htmlFor={ids.approval} className={LABEL}>
                  {w.approvalMode}
                </label>
                <select
                  id={ids.approval}
                  value={v.approval}
                  disabled={locked}
                  aria-describedby={describedBy('approvalPolicy')}
                  onChange={(e) => void save('approvalPolicy', { approvalPolicy: e.target.value })}
                  className={INPUT}
                >
                  {Object.entries(words.approval).map(([k, x]) => (
                    <option key={k} value={k}>
                      {x.label}
                    </option>
                  ))}
                </select>
                <p className="m-0 mt-1 text-[0.78125rem] text-dy-muted">{words.approval[v.approval]?.text}</p>
                <FieldError id={ids.err('approvalPolicy')} text={errors.approvalPolicy} />
              </div>
              <div>
                <label htmlFor={ids.sandbox} className={LABEL}>
                  {w.isolation}
                </label>
                <select
                  id={ids.sandbox}
                  value={v.sandbox}
                  disabled={locked}
                  aria-describedby={describedBy('sandboxProfile')}
                  onChange={(e) => void save('sandboxProfile', { sandboxProfile: e.target.value })}
                  className={INPUT}
                >
                  {Object.entries(words.sandbox).map(([k, x]) => (
                    <option key={k} value={k}>
                      {x.label}
                    </option>
                  ))}
                </select>
                <p className="m-0 mt-1 text-[0.78125rem] text-dy-muted">
                  {words.sandbox[v.sandbox]?.text}
                  {v.defaults.includes('sandboxProfile') ? w.projectDefaultNote : ''}
                </p>
                <FieldError id={ids.err('sandboxProfile')} text={errors.sandboxProfile} />
              </div>
            </div>
            <div>
              <DraftTimeLimitField
                sec={v.maxSec}
                disabled={locked}
                onSave={(sec) => save('maxDurationSec', { maxDurationSec: sec })}
              />
              <FieldError id={ids.err('maxDurationSec')} text={errors.maxDurationSec} />
            </div>
            <div>
              <label htmlFor={ids.workers} className={LABEL}>
                {w.machine}
              </label>
              <select
                id={ids.workers}
                value={v.pinned.length === 1 ? (v.pinned[0] ?? '') : ''}
                disabled={locked}
                aria-describedby={describedBy('workers')}
                onChange={(e) =>
                  void save('workers', { workers: e.target.value === '' ? null : [e.target.value] })
                }
                className={INPUT}
              >
                <option value="">{w.machineAuto}</option>
                {[...new Set([...v.pinned, ...v.machines])].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <FieldError id={ids.err('workers')} text={errors.workers} />
            </div>
            {v.deploy === null ? null : (
              <div data-testid="dy-draft-deploy">
                <span className={LABEL}>{w.deployTitle}</span>
                <div className="flex flex-wrap items-center gap-2.5">
                  <Seg
                    label={w.deployEnv}
                    value={deployEnv}
                    disabled={locked}
                    options={[
                      { value: 'preview', label: w.envPreview },
                      { value: 'production', label: w.envProduction },
                    ]}
                    onChange={(env) => void save('deploy', { deployEnv: env })}
                  />
                  <CardButton
                    variant="ghost"
                    disabled={locked}
                    onClick={() => void save('deploy', { deployOnSuccess: null })}
                  >
                    {w.removeDeploy}
                  </CardButton>
                </div>
                <ul className="m-0 mt-2 grid list-none gap-1 p-0 text-[0.8125rem] text-dy-muted">
                  {(chain.length > 0 ? chain : deployFacts(v.deploy, t).map((l) => l.v)).map((l) => (
                    <li key={l} className="flex gap-1.5">
                      <DyIcon name="rocket" className="mt-0.5 size-3.5 shrink-0" />
                      <span className="[overflow-wrap:anywhere]">{l}</span>
                    </li>
                  ))}
                </ul>
                {deployEnv === 'production' ? (
                  <p className="m-0 mt-1 text-[0.78125rem] text-dy-amber-ink">{w.productionCode}</p>
                ) : null}
                <FieldError id={ids.err('deploy')} text={errors.deploy} />
              </div>
            )}
            <div>
              <label htmlFor={ids.verify} className={LABEL}>
                {w.verify}
              </label>
              <select
                id={ids.verify}
                value={v.verify ?? ''}
                disabled={locked}
                aria-describedby={describedBy('verifyOnSuccess')}
                onChange={(e) =>
                  void save('verifyOnSuccess', {
                    verifyOnSuccess:
                      e.target.value === 'off' || e.target.value === 'report' || e.target.value === 'gate'
                        ? e.target.value
                        : null,
                  })
                }
                className={INPUT}
              >
                <option value="">{w.projectDefault}</option>
                {Object.entries(words.verify).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
              <FieldError id={ids.err('verifyOnSuccess')} text={errors.verifyOnSuccess} />
            </div>
            {v.branch === null && !v.refs ? null : (
              <div data-testid="dy-draft-paths">
                <span className={LABEL}>{w.paths}</span>
                <ul className="m-0 grid list-none gap-1 p-0 text-[0.8125rem]">
                  {v.branch === null ? null : (
                    <li className="flex items-center gap-1.5">
                      <DyIcon name="branch" className="size-3.5 shrink-0 text-dy-muted" />
                      <span className="font-dy-mono [overflow-wrap:anywhere]" translate="no">
                        {`${v.branch} ← ${v.base ?? w.mainBranch}`}
                      </span>
                    </li>
                  )}
                  {v.files.map((f) => (
                    <li key={f} className="flex items-center gap-1.5">
                      <DyIcon name="file" className="size-3.5 shrink-0 text-dy-muted" />
                      <span className="font-dy-mono [overflow-wrap:anywhere]">{`in/${f}`}</span>
                    </li>
                  ))}
                  {v.refs && v.files.length === 0 ? (
                    <li className="text-dy-muted">{w.earlierFiles}</li>
                  ) : null}
                </ul>
                {/* p19-repo-job-inputs: a repository job reads them next to the checkout, never committed. */}
                {v.refs && v.branch !== null ? (
                  <p className="m-0 text-[0.78125rem] text-dy-muted" data-testid="dy-draft-repo-inputs">
                    {w.repoInputsNote}
                  </p>
                ) : null}
                {v.refs ? (
                  <CardButton
                    variant="ghost"
                    disabled={locked}
                    onClick={() => void save('inputs', { inputs: null })}
                  >
                    {w.removeInputs}
                  </CardButton>
                ) : null}
                <FieldError id={ids.err('inputs')} text={errors.inputs} />
              </div>
            )}
            {v.template ? <p className="m-0 text-[0.78125rem] text-dy-muted">{w.fromTemplate}</p> : null}
            {extra.length === 0 ? null : (
              <div data-testid="dy-draft-details">
                <span className={LABEL}>{w.details}</span>
                <KeyValue rows={extra} />
              </div>
            )}
          </div>
        </details>

        <Countdown until={d.expiresAt} from={d.createdAt} label={w.expiresIn} tone="amber" />
      </div>
    </LiveCard>
  );
}
