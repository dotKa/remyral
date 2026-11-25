import type { Messages } from '@remyral/i18n';
import { type QuestionAnswer, type UserQuestion, validateAnswers } from '@remyral/protocol/questions';
import { type KeyboardEvent, type ReactNode, useId, useMemo, useRef, useState } from 'react';
import type { QuestionSet } from '../../api/questions';
import { cx } from '../../components/ui';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { Countdown } from '../Countdown';
import { DyIcon } from '../icons';

/**
 * p14-ask-user (docs/design/p14-ask-user.md §3–§4): one question set as an interactive card — single choice (radio
 * group), multiple choice (checkboxes), free text, and "Diğer" with its own text where allowed. Keyboard: arrow keys
 * move inside a group, Space selects, digits 1–9 pick the n-th option of the focused question (the next digit after the
 * options is "Diğer"), Enter sends when every question is answered (Shift+Enter: new line in a text field).
 *
 * Every prompt, label and description is agent / model text: rendered as React text nodes only (never HTML, never
 * Markdown). Answered / expired / withdrawn sets are read-only and show the chosen answers, who and when.
 */

interface Draft {
  readonly choices: readonly string[];
  readonly otherOn: boolean;
  readonly other: string;
  readonly text: string;
  /** p19-plan-decide: a note added to the answer (shown once "Not ekle" is pressed). */
  readonly noteOn?: boolean;
  readonly note?: string;
}

function initial(q: UserQuestion): Draft {
  const d = q.default;
  if (q.kind === 'text')
    return { choices: [], otherOn: false, other: '', text: typeof d === 'string' ? d : '' };
  const picked = d === undefined ? [] : Array.isArray(d) ? d : [d];
  const labels = (q.options ?? []).map((o) => o.label);
  return { choices: picked.filter((p) => labels.includes(p)), otherOn: false, other: '', text: '' };
}

/** The answers the drafts make (only filled parts; the protocol validator decides whether they are complete). */
export function draftAnswers(
  questions: readonly UserQuestion[],
  drafts: Readonly<Record<string, Draft>>,
): QuestionAnswer[] {
  return questions.map((q) => {
    const d = drafts[q.id] ?? initial(q);
    const note = d.noteOn === true && (d.note ?? '').trim() !== '' ? { note: d.note ?? '' } : {};
    if (q.kind === 'text') return d.text.trim() === '' ? { id: q.id } : { id: q.id, text: d.text, ...note };
    const other = d.otherOn && d.other.trim() !== '' ? { other: d.other } : {};
    return { id: q.id, ...(d.choices.length === 0 ? {} : { choices: [...d.choices] }), ...other, ...note };
  });
}

function AnsweredValue(props: {
  readonly q: UserQuestion;
  readonly a: QuestionAnswer | undefined;
}): ReactNode {
  const t = useT().questions.card;
  const { q, a } = props;
  if (a === undefined) return <span className="text-dy-muted">{t.noAnswer}</span>;
  const note =
    a.note === undefined ? null : (
      <span className="mt-0.5 block whitespace-pre-wrap font-normal text-dy-muted">
        {t.noteAnswer({ text: a.note })}
      </span>
    );
  if (q.kind === 'text')
    return (
      <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        {a.text ?? ''}
        {note}
      </span>
    );
  const parts = [...(a.choices ?? [])];
  return (
    <span className="[overflow-wrap:anywhere]">
      {parts.join(', ')}
      {a.other === undefined ? null : (
        <span className="whitespace-pre-wrap">{`${parts.length === 0 ? '' : ', '}${t.otherAnswer({ text: a.other })}`}</span>
      )}
      {note}
    </span>
  );
}

/**
 * Why a set closed without an answer. p20-decisions: a plan decision the conversation settled says what was settled
 * ("Sohbette karara bağlandı: …"); one its plan's replacement or end closed says so.
 */
export function closedText(s: QuestionSet, t: Messages['questions']['card']): string {
  switch (s.closeReason) {
    case 'superseded':
      return t.superseded;
    case 'settled_in_chat':
      return t.settled({ answer: s.closeNote ?? null });
    case 'plan_superseded':
      return t.planReplaced;
    case 'plan_cancelled':
    case 'plan_done':
      return t.planClosed;
    default:
      return t.cancelled;
  }
}

function Closed(props: { readonly set: QuestionSet }): ReactNode {
  const t = useT().questions.card;
  const format = useFormat();
  const s = props.set;
  return (
    <div className="grid gap-2" data-testid="question-closed" data-state={s.state}>
      <dl className="m-0 grid gap-2">
        {s.questions.map((q) => (
          <div key={q.id} className="grid gap-0.5">
            <dt className="text-[0.8125rem] text-dy-muted whitespace-pre-wrap [overflow-wrap:anywhere]">
              {q.prompt}
            </dt>
            <dd className="m-0 text-[0.875rem] font-medium">
              {s.state === 'answered' ? (
                <AnsweredValue q={q} a={s.answers?.find((a) => a.id === q.id)} />
              ) : (
                <span className="text-dy-muted">{t.noAnswer}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="m-0 text-[0.75rem] text-dy-muted">
        {s.state === 'answered'
          ? t.answeredBy({
              who: s.answeredBy?.username ?? '—',
              when: s.answeredAt === null ? '' : format.dateTime(s.answeredAt),
            })
          : s.state === 'expired'
            ? t.expired
            : closedText(s, t)}
      </p>
    </div>
  );
}

function OneQuestion(props: {
  readonly q: UserQuestion;
  readonly index: number;
  readonly count: number;
  readonly draft: Draft;
  readonly onChange: (d: Draft) => void;
  readonly onSubmit: () => void;
  readonly disabled: boolean;
}): ReactNode {
  const t = useT().questions.card;
  const { q, draft, onChange } = props;
  const name = useId();
  const otherRef = useRef<HTMLInputElement>(null);
  // p18-plan-mode: the recommended option comes first with an "Önerilen" badge (never pre-selected).
  const tp = useT().plan.decisions;
  const options = [...(q.options ?? [])].sort(
    (a, b) => Number(b.label === q.recommended) - Number(a.label === q.recommended),
  );
  const isSingle = q.kind === 'single';

  const pick = (label: string): void => {
    if (isSingle) onChange({ ...draft, choices: [label], otherOn: false });
    else
      onChange({
        ...draft,
        choices: draft.choices.includes(label)
          ? draft.choices.filter((c) => c !== label)
          : [...draft.choices, label],
      });
  };
  const toggleOther = (): void => {
    onChange(isSingle ? { ...draft, choices: [], otherOn: true } : { ...draft, otherOn: !draft.otherOn });
    requestAnimationFrame(() => otherRef.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFieldSetElement>): void => {
    const target = e.target as HTMLElement;
    const typing =
      target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type === 'text');
    if (!typing && /^[1-9]$/.test(e.key) && q.kind !== 'text') {
      const n = Number(e.key) - 1;
      const opt = options[n];
      if (opt !== undefined) {
        e.preventDefault();
        pick(opt.label);
        e.currentTarget.querySelectorAll<HTMLInputElement>('input[data-option]')[n]?.focus();
      } else if (n === options.length && q.allowOther === true) {
        e.preventDefault();
        toggleOther();
      }
      return;
    }
    // Checkboxes have no native arrow navigation: move between this question's choices.
    if (!typing && q.kind === 'multi' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const inputs = [...e.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
      const i = inputs.indexOf(target as HTMLInputElement);
      if (i >= 0) {
        e.preventDefault();
        inputs[(i + (e.key === 'ArrowDown' ? 1 : inputs.length - 1)) % inputs.length]?.focus();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && target.tagName !== 'BUTTON') {
      e.preventDefault();
      props.onSubmit();
    }
  };

  const optionClass = (checked: boolean): string =>
    cx(
      'flex min-h-11 cursor-pointer items-start gap-2.5 rounded-[10px] border px-3 py-2 sm:min-h-9',
      checked ? 'border-dy-teal bg-dy-teal-soft' : 'border-dy-line-2 bg-dy-card',
      props.disabled && 'cursor-not-allowed opacity-60',
    );

  return (
    <fieldset
      className="m-0 grid min-w-0 gap-1.5 border-0 p-0"
      onKeyDown={onKeyDown}
      disabled={props.disabled}
    >
      <legend className="mb-1 p-0 text-[0.9375rem] font-bold whitespace-pre-wrap [overflow-wrap:anywhere]">
        {props.count > 1 ? (
          <span className="mr-1.5 text-[0.75rem] font-medium text-dy-muted">
            {t.question({ i: props.index + 1, n: props.count })}
          </span>
        ) : null}
        {q.prompt}
      </legend>
      {q.rationale === undefined ? null : (
        <p
          className="m-0 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]"
          data-testid="question-rationale"
        >
          {q.recommended === undefined ? q.rationale : `${tp.recommended}: ${q.recommended} — ${q.rationale}`}
        </p>
      )}
      {q.kind === 'text' ? (
        <textarea
          rows={2}
          value={draft.text}
          maxLength={2000}
          aria-label={q.prompt}
          placeholder={q.placeholder ?? t.textPlaceholder}
          onChange={(e) => {
            onChange({ ...draft, text: e.target.value });
          }}
          className="min-h-11 w-full resize-y rounded-[10px] border border-dy-line-2 bg-dy-card px-3 py-2 text-base text-dy-ink outline-none focus-visible:border-dy-teal sm:text-[0.9375rem]"
        />
      ) : (
        <div className="grid gap-1.5" role="group" aria-label={isSingle ? t.single : t.multi}>
          {options.map((o, i) => {
            const checked = draft.choices.includes(o.label);
            return (
              <label key={o.label} className={optionClass(checked)}>
                <input
                  type={isSingle ? 'radio' : 'checkbox'}
                  name={name}
                  data-option=""
                  checked={checked}
                  onChange={() => {
                    pick(o.label);
                  }}
                  className="mt-1 size-4 shrink-0 accent-[var(--dy-teal)]"
                />
                <span className="grid min-w-0 gap-0.5">
                  <span className="text-[0.875rem] font-medium [overflow-wrap:anywhere]">
                    <kbd
                      className="mr-1.5 hidden font-dy-mono text-[0.6875rem] text-dy-faint sm:inline"
                      aria-hidden="true"
                    >
                      {String(i + 1)}
                    </kbd>
                    {o.label}
                    {o.label === q.recommended ? (
                      <span
                        className="ml-2 inline-flex rounded-full bg-dy-teal-soft px-1.5 py-px align-middle text-[0.6875rem] font-bold text-dy-teal-ink"
                        data-testid="question-recommended"
                      >
                        {tp.recommended}
                      </span>
                    ) : null}
                  </span>
                  {o.description === undefined || o.description === '' ? null : (
                    <span className="text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
                      {o.description}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
          {q.allowOther === true ? (
            <div className={cx(optionClass(draft.otherOn), 'flex-wrap')}>
              <label className="flex cursor-pointer items-center gap-2.5">
                <input
                  type={isSingle ? 'radio' : 'checkbox'}
                  name={name}
                  data-option=""
                  checked={draft.otherOn}
                  onChange={toggleOther}
                  className="size-4 shrink-0 accent-[var(--dy-teal)]"
                />
                <span className="text-[0.875rem] font-medium">
                  <kbd
                    className="mr-1.5 hidden font-dy-mono text-[0.6875rem] text-dy-faint sm:inline"
                    aria-hidden="true"
                  >
                    {String(options.length + 1)}
                  </kbd>
                  {t.other}
                </span>
              </label>
              {draft.otherOn ? (
                <input
                  ref={otherRef}
                  type="text"
                  value={draft.other}
                  maxLength={2000}
                  aria-label={t.other}
                  placeholder={t.otherPlaceholder}
                  onChange={(e) => {
                    onChange({ ...draft, other: e.target.value });
                  }}
                  className="min-h-9 w-full min-w-0 flex-1 rounded-[8px] border border-dy-line-2 bg-dy-card px-2.5 text-base outline-none focus-visible:border-dy-teal sm:text-[0.875rem]"
                />
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      {draft.noteOn === true ? (
        <textarea
          value={draft.note ?? ''}
          maxLength={2000}
          rows={2}
          aria-label={t.note}
          placeholder={t.notePlaceholder}
          onChange={(e) => {
            onChange({ ...draft, note: e.target.value });
          }}
          className="mt-1.5 min-h-11 w-full resize-y rounded-[10px] border border-dy-line-2 bg-dy-card px-3 py-2 text-base text-dy-ink outline-none focus-visible:border-dy-teal sm:text-[0.875rem]"
          data-testid="question-note"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            onChange({ ...draft, noteOn: true });
          }}
          className="dy-press mt-1 inline-flex min-h-8 items-center justify-self-start rounded-lg px-1.5 text-[0.8125rem] font-medium text-dy-teal-ink [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-teal-soft"
          data-testid="question-add-note"
        >
          {t.addNote}
        </button>
      )}
    </fieldset>
  );
}

export function QuestionCard(props: {
  readonly set: QuestionSet;
  /** Who asks: the job's agent or the assistant (the header line). */
  readonly from: 'job' | 'assistant';
  /** May this viewer answer (pending sets only)? */
  readonly canAnswer: boolean;
  /** Sends the answers; rejects with the API error (shown in the card). */
  readonly onAnswer: (answers: QuestionAnswer[]) => Promise<void>;
  /** The assistant's turn still runs: choices can be made, sending waits. */
  readonly waiting?: boolean | undefined;
  /** p18-plan-mode: the header's words instead of "Asistan soruyor" (a plan decision). */
  readonly heading?: string | undefined;
  /** p18-plan-mode: tighter padding (the plan panel). */
  readonly compact?: boolean | undefined;
}): ReactNode {
  const tq = useT().questions;
  const t = tq.card;
  const sayError = useErrorText();
  const s = props.set;
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(s.questions.map((q) => [q.id, initial(q)])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answers = useMemo(() => draftAnswers(s.questions, drafts), [s.questions, drafts]);
  const check = useMemo(() => validateAnswers(s.questions, answers), [s.questions, answers]);
  const open = s.state === 'pending';
  const hasText = s.questions.some((q) => q.kind === 'text');
  const headId = useId();

  const submit = (): void => {
    if (!open || !props.canAnswer || busy || props.waiting === true || !check.ok) return;
    setBusy(true);
    setError(null);
    props.onAnswer(check.answers).then(
      () => {
        setBusy(false);
      },
      (err: unknown) => {
        setBusy(false);
        setError(sayError(err));
      },
    );
  };

  return (
    <section
      aria-labelledby={headId}
      data-testid="question-card"
      data-card={`question:${s.id}`}
      data-state={s.state}
      className={cx(
        'grid min-w-0 gap-3 rounded-[14px] border bg-dy-card shadow-dy',
        props.compact === true ? 'px-3 py-2.5' : 'px-3.5 py-3 sm:px-4',
        open ? 'border-dy-amber' : 'border-dy-line',
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cx(
            'grid size-[22px] shrink-0 place-items-center rounded-md text-dy-on-fill',
            open ? 'bg-dy-amber' : 'bg-dy-line-2',
          )}
          aria-hidden="true"
        >
          <DyIcon name="bubble" className="size-3.5" />
        </span>
        <h3 id={headId} className="m-0 min-w-0 flex-1 text-[0.875rem] font-bold [overflow-wrap:anywhere]">
          {props.heading ?? (props.from === 'job' ? t.fromJob : t.fromAssistant)}
          {s.title === null ? null : <span className="font-medium text-dy-muted">{` · ${s.title}`}</span>}
        </h3>
        {open && s.deadlineAt !== null ? (
          <Countdown until={s.deadlineAt} label={t.expiresIn} tone="amber" className="shrink-0" />
        ) : null}
      </header>
      {open ? (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {s.questions.map((q, i) => (
            <OneQuestion
              key={q.id}
              q={q}
              index={i}
              count={s.questions.length}
              draft={drafts[q.id] ?? initial(q)}
              disabled={!props.canAnswer || busy}
              onSubmit={submit}
              onChange={(d) => {
                setError(null);
                setDrafts((prev) => ({ ...prev, [q.id]: d }));
              }}
            />
          ))}
          <p className="m-0 text-[0.75rem] text-dy-muted">
            {props.from === 'job' ? `${t.untrusted} ` : ''}
            {t.noSecrets}
          </p>
          {props.canAnswer ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={!check.ok || busy || props.waiting === true}
                aria-busy={busy ? true : undefined}
                className="dy-press inline-flex min-h-11 items-center gap-[7px] rounded-[9px] border border-dy-ink bg-dy-ink px-[13px] text-sm font-bold text-dy-card disabled:opacity-50 sm:min-h-9"
              >
                <DyIcon name="send" />
                {busy ? t.sending : t.send}
              </button>
              <span
                className="min-w-0 text-[0.75rem] text-dy-faint"
                role={props.waiting === true ? 'status' : undefined}
              >
                {props.waiting === true
                  ? t.waitTurn
                  : !check.ok
                    ? t.incomplete
                    : hasText
                      ? t.textKeysHint
                      : t.keysHint}
              </span>
            </div>
          ) : (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.readOnly}</p>
          )}
          {error === null ? null : (
            <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
              {error}
            </p>
          )}
        </form>
      ) : (
        <Closed set={s} />
      )}
    </section>
  );
}
