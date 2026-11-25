import { z } from 'zod';
import { AttemptId, Epoch, Timestamp } from './common.js';

/**
 * p14-ask-user (docs/design/p14-ask-user.md): structured questions to a person — from the Sohbet assistant (`ask_user`
 * assistant tool) and from a running job's agent (`ask_user` / `wait_for_answer` in-job tools). One schema for both,
 * shared by the master (validation, storage), the worker (tool host), the adapters (tool definitions) and the web
 * (card, answer validation). Browser-safe: zod only.
 *
 * Wire (additive in 1.0, control messages, job-scoped, only from / to `ask-user-v1` workers):
 *  - worker → master `QUESTION_REQUEST {attemptId, epoch, requestId, op}` — op `ask | status | cancel`;
 *  - master → worker `QUESTION_STATUS {attemptId, epoch, requestId, state, …}` — the answer to exactly that request.
 * Every request is fenced to the job's live lease; asking is idempotent per (job, requestId).
 *
 * Everything a question carries comes from an agent or a model: untrusted data. It is bounded here, stored as data and
 * rendered as plain text only (never HTML, never Markdown).
 */

export const ASK_USER_FEATURE = 'ask-user-v1';
/** Version of the stored / transmitted question shape (`v` of a stored set). */
export const QUESTION_SCHEMA_VERSION = 1;

export const QUESTION_LIMITS = {
  maxQuestions: 4,
  minOptions: 2,
  maxOptions: 8,
  maxTitleChars: 120,
  maxPromptChars: 1000,
  maxLabelChars: 120,
  maxDescriptionChars: 300,
  maxPlaceholderChars: 120,
  /** p18-plan-mode: why the recommended option is recommended. */
  maxRationaleChars: 500,
  /** A free-text answer, the "Diğer" (other) text, a text default. */
  maxAnswerChars: 2000,
  /** How long a question stays open (job questions; the attempt's own deadline cuts it shorter). */
  defaultTimeoutSec: 30 * 60,
  minTimeoutSec: 60,
  maxTimeoutSec: 24 * 3600,
  /** Longest a single in-job tool call blocks before it returns "still open" (as `wait_subtask`). */
  defaultWaitSec: 540,
  maxWaitSec: 600,
  /** Open question sets per job / per conversation, and sets per job in total. */
  maxOpenPerJob: 1,
  maxPerJob: 20,
  /** Stored size bounds (JSON text). */
  maxSetBytes: 32 * 1024,
  maxAnswersBytes: 16 * 1024,
} as const;

/** No control characters except newline and tab (prompts may have lines; labels may not). */
const hex4 = (n: number): string => n.toString(16).padStart(4, '0');
const charClass = (ranges: readonly (readonly [number, number])[]): RegExp =>
  new RegExp(`[${ranges.map(([a, b]) => `\\u${hex4(a)}-\\u${hex4(b)}`).join('')}]`, 'u');
/** C0 controls (newline / tab allowed), DEL, line / paragraph separators, bidi overrides and isolates. */
const CONTROL = charClass([
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]);
const LINE_CONTROL = charClass([
  [0x00, 0x1f],
  [0x7f, 0x7f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]);

const text = (max: number, opts: { lines?: boolean; min?: number } = {}) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length >= (opts.min ?? 1), { message: 'empty' })
    .refine((s) => !(opts.lines === true ? CONTROL : LINE_CONTROL).test(s), {
      message: 'control characters are not allowed',
    });

export const QuestionKind = z.enum(['single', 'multi', 'text']);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const QuestionId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'question id');

export const QuestionOption = z.strictObject({
  label: text(QUESTION_LIMITS.maxLabelChars),
  description: text(QUESTION_LIMITS.maxDescriptionChars, { min: 0 }).optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

const questionShape = {
  prompt: text(QUESTION_LIMITS.maxPromptChars, { lines: true }),
  kind: QuestionKind,
  options: z.array(QuestionOption).max(QUESTION_LIMITS.maxOptions).optional(),
  /** Choice kinds: the person may write their own answer ("Diğer"). */
  allowOther: z.boolean().optional(),
  /** single: one label · multi: labels · text: a text. Pre-selected / pre-filled, never sent without a click. */
  default: z
    .union([
      text(QUESTION_LIMITS.maxAnswerChars, { lines: true }),
      z.array(text(QUESTION_LIMITS.maxLabelChars)).max(QUESTION_LIMITS.maxOptions),
    ])
    .optional(),
  /** Text kind: the field's hint. */
  placeholder: text(QUESTION_LIMITS.maxPlaceholderChars).optional(),
  /**
   * p18-plan-mode: choice kinds — the option the asker recommends (one of the labels; shown first with an "Önerilen"
   * badge, never pre-selected) and why. Optional; older consoles ignore both.
   */
  recommended: text(QUESTION_LIMITS.maxLabelChars).optional(),
  rationale: text(QUESTION_LIMITS.maxRationaleChars, { lines: true }).optional(),
};

const norm = (s: string): string => s.trim().toLocaleLowerCase('en');

/** The rules every question obeys beyond its field shapes (options per kind, unique labels, defaults). */
function checkQuestion(q: z.infer<z.ZodObject<typeof questionShape>>, ctx: z.RefinementCtx): void {
  const options = q.options ?? [];
  if (q.kind === 'text') {
    if (options.length > 0)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'text questions have no options' });
    if (q.allowOther === true)
      ctx.addIssue({
        code: 'custom',
        path: ['allowOther'],
        message: 'text questions have no "other" choice',
      });
    if (Array.isArray(q.default))
      ctx.addIssue({ code: 'custom', path: ['default'], message: 'a text default is one text' });
    if (q.recommended !== undefined)
      ctx.addIssue({ code: 'custom', path: ['recommended'], message: 'text questions recommend no option' });
    return;
  }
  if (options.length < QUESTION_LIMITS.minOptions) {
    ctx.addIssue({
      code: 'custom',
      path: ['options'],
      message: `choice questions need ${String(QUESTION_LIMITS.minOptions)}–${String(QUESTION_LIMITS.maxOptions)} options`,
    });
  }
  const labels = options.map((o) => norm(o.label));
  if (new Set(labels).size !== labels.length) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'option labels must be unique' });
  }
  if (q.placeholder !== undefined)
    ctx.addIssue({
      code: 'custom',
      path: ['placeholder'],
      message: 'only text questions have a placeholder',
    });
  if (q.recommended !== undefined && !labels.includes(norm(q.recommended)))
    ctx.addIssue({
      code: 'custom',
      path: ['recommended'],
      message: 'the recommended option must be one of the option labels',
    });
  if (q.default !== undefined) {
    const picked = Array.isArray(q.default) ? q.default : [q.default];
    if (q.kind === 'single' && picked.length !== 1)
      ctx.addIssue({ code: 'custom', path: ['default'], message: 'a single-choice default is one label' });
    if (picked.some((d) => !labels.includes(norm(d))))
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: 'a default must be one of the option labels',
      });
  }
}

/** One question as an agent / the assistant writes it (`id` optional: q1…q4 are assigned in order). */
export const UserQuestionInput = z
  .strictObject({ id: QuestionId.optional(), ...questionShape })
  .superRefine(checkQuestion);
export type UserQuestionInput = z.infer<typeof UserQuestionInput>;

/** One stored / transmitted question (ids assigned). */
export const UserQuestion = z.strictObject({ id: QuestionId, ...questionShape }).superRefine(checkQuestion);
export type UserQuestion = z.infer<typeof UserQuestion>;

function uniqueIds(qs: readonly { id?: string | undefined }[], ctx: z.RefinementCtx): void {
  const ids = qs.flatMap((q) => (q.id === undefined ? [] : [q.id]));
  if (new Set(ids).size !== ids.length)
    ctx.addIssue({ code: 'custom', path: ['questions'], message: 'question ids must be unique' });
}

/** The `questions` argument of the tools: 1–4 questions. */
export const UserQuestionInputs = z
  .array(UserQuestionInput)
  .min(1)
  .max(QUESTION_LIMITS.maxQuestions)
  .superRefine(uniqueIds);

export const UserQuestions = z
  .array(UserQuestion)
  .min(1)
  .max(QUESTION_LIMITS.maxQuestions)
  .superRefine(uniqueIds);

export const QuestionTitle = text(QUESTION_LIMITS.maxTitleChars);
export const QuestionTimeoutSec = z
  .number()
  .int()
  .min(QUESTION_LIMITS.minTimeoutSec)
  .max(QUESTION_LIMITS.maxTimeoutSec);
export const QuestionWaitSec = z.number().int().min(0).max(QUESTION_LIMITS.maxWaitSec);

/** Assigns `q1`…`q4` to questions without an id (ids an author chose are kept; a clash with an assigned one is skipped). */
export function withQuestionIds(input: readonly UserQuestionInput[]): UserQuestion[] {
  const taken = new Set(input.flatMap((q) => (q.id === undefined ? [] : [q.id])));
  let n = 0;
  return input.map((q) => {
    if (q.id !== undefined) return { ...q, id: q.id };
    let id: string;
    do {
      n += 1;
      id = `q${String(n)}`;
    } while (taken.has(id));
    taken.add(id);
    return { ...q, id };
  });
}

// ------------------------------------------------------------------------------------------------ answers

export const QuestionAnswer = z.strictObject({
  id: QuestionId,
  /** Option labels picked (single: at most one; multi: any number). */
  choices: z.array(text(QUESTION_LIMITS.maxLabelChars)).max(QUESTION_LIMITS.maxOptions).optional(),
  /** The "Diğer" text (only where `allowOther`). */
  other: text(QUESTION_LIMITS.maxAnswerChars, { lines: true }).optional(),
  /** The answer of a text question. */
  text: text(QUESTION_LIMITS.maxAnswerChars, { lines: true }).optional(),
  /** p19-plan-decide: a note the person added to their answer (any kind). */
  note: text(QUESTION_LIMITS.maxAnswerChars, { lines: true }).optional(),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;

export const QuestionAnswers = z.array(QuestionAnswer).min(1).max(QUESTION_LIMITS.maxQuestions);

export type AnswerCheck =
  | { readonly ok: true; readonly answers: QuestionAnswer[] }
  | { readonly ok: false; readonly questionId: string | null; readonly issue: AnswerIssue };

export type AnswerIssue =
  | 'missing'
  | 'unknown_question'
  | 'duplicate'
  | 'unknown_option'
  | 'too_many'
  | 'other_not_allowed'
  | 'wrong_kind'
  | 'shape';

/**
 * Checks a person's answers against the questions: every question answered exactly once, labels from the options (the
 * stored spelling is returned), "other" only where allowed, single choice one answer. Shared by the master (authority)
 * and the web (to enable the submit button).
 */
export function validateAnswers(questions: readonly UserQuestion[], raw: unknown): AnswerCheck {
  const parsed = QuestionAnswers.safeParse(raw);
  if (!parsed.success) return { ok: false, questionId: null, issue: 'shape' };
  const byId = new Map(parsed.data.map((a) => [a.id, a] as const));
  if (byId.size !== parsed.data.length) return { ok: false, questionId: null, issue: 'duplicate' };
  for (const a of parsed.data) {
    if (!questions.some((q) => q.id === a.id))
      return { ok: false, questionId: a.id, issue: 'unknown_question' };
  }
  const out: QuestionAnswer[] = [];
  for (const q of questions) {
    const a = byId.get(q.id);
    if (a === undefined) return { ok: false, questionId: q.id, issue: 'missing' };
    if (q.kind === 'text') {
      if (a.choices !== undefined || a.other !== undefined)
        return { ok: false, questionId: q.id, issue: 'wrong_kind' };
      if (a.text === undefined) return { ok: false, questionId: q.id, issue: 'missing' };
      out.push({ id: q.id, text: a.text.trim(), ...noteOf(a) });
      continue;
    }
    if (a.text !== undefined) return { ok: false, questionId: q.id, issue: 'wrong_kind' };
    if (a.other !== undefined && q.allowOther !== true)
      return { ok: false, questionId: q.id, issue: 'other_not_allowed' };
    const labels = new Map((q.options ?? []).map((o) => [norm(o.label), o.label] as const));
    const picked: string[] = [];
    for (const c of a.choices ?? []) {
      const label = labels.get(norm(c));
      if (label === undefined) return { ok: false, questionId: q.id, issue: 'unknown_option' };
      if (picked.includes(label)) return { ok: false, questionId: q.id, issue: 'duplicate' };
      picked.push(label);
    }
    const count = picked.length + (a.other === undefined ? 0 : 1);
    if (count === 0) return { ok: false, questionId: q.id, issue: 'missing' };
    if (q.kind === 'single' && count > 1) return { ok: false, questionId: q.id, issue: 'too_many' };
    out.push({
      id: q.id,
      ...(picked.length === 0 ? {} : { choices: picked }),
      ...(a.other === undefined ? {} : { other: a.other.trim() }),
      ...noteOf(a),
    });
  }
  return { ok: true, answers: out };
}

/** p19-plan-decide: the answer's note, trimmed; an empty one is left out. */
function noteOf(a: QuestionAnswer): { note?: string } {
  const n = a.note?.trim() ?? '';
  return n === '' ? {} : { note: n };
}

/**
 * p19-plan-decide: an answer as a worker older than the note understands it (its wire schema is strict): the note is
 * folded into the text / the "other" text.
 */
export function answerWithoutNote(a: QuestionAnswer): QuestionAnswer {
  if (a.note === undefined) return a;
  const { note, ...rest } = a;
  if (rest.text !== undefined) return { ...rest, text: `${rest.text}\n\nNote: ${note}` };
  return { ...rest, other: rest.other === undefined ? `Note: ${note}` : `${rest.other}\n\nNote: ${note}` };
}

/** Same answers (order-insensitive per choice list) — a repeated answer is idempotent, a different one is refused. */
export function sameAnswers(a: readonly QuestionAnswer[], b: readonly QuestionAnswer[]): boolean {
  if (a.length !== b.length) return false;
  const key = (x: QuestionAnswer): string =>
    JSON.stringify([x.id, [...(x.choices ?? [])].sort(), x.other ?? null, x.text ?? null, x.note ?? null]);
  const ka = a.map(key).sort();
  const kb = b.map(key).sort();
  return ka.every((k, i) => k === kb[i]);
}

/**
 * The answers as plain text for an agent or the assistant (one block per question; prompts quoted so the agent sees
 * which question each answer belongs to). The text is the person's — no fencing.
 */
export function answersText(questions: readonly UserQuestion[], answers: readonly QuestionAnswer[]): string {
  const lines: string[] = [];
  for (const [i, q] of questions.entries()) {
    const a = answers.find((x) => x.id === q.id);
    const head = `${String(i + 1)}. [${q.id}] ${q.prompt.replace(/\s+/g, ' ').trim()}`;
    let value: string;
    if (a === undefined) value = '(no answer)';
    else if (q.kind === 'text') value = a.text ?? '';
    else {
      const parts = [...(a.choices ?? [])];
      if (a.other !== undefined) parts.push(`Other: ${a.other}`);
      value = parts.join('; ');
    }
    lines.push(head, `   → ${value.replace(/\n/g, '\n     ')}`);
    if (a?.note !== undefined) lines.push(`   Note: ${a.note.replace(/\n/g, '\n     ')}`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------ wire

export const QUESTION_STATES = ['pending', 'answered', 'expired', 'cancelled'] as const;
export const QuestionState = z.enum(QUESTION_STATES);
export type QuestionState = z.infer<typeof QuestionState>;

const LeaseRef = { attemptId: AttemptId, epoch: Epoch };
const QuestionSetId = z.uuid();

export const QuestionAskOp = z.object({
  kind: z.literal('ask'),
  title: QuestionTitle.optional(),
  questions: UserQuestions,
  timeoutSec: QuestionTimeoutSec,
});
export type QuestionAskOp = z.infer<typeof QuestionAskOp>;

export const QuestionRequestOp = z.discriminatedUnion('kind', [
  QuestionAskOp,
  z.object({ kind: z.literal('status'), questionId: QuestionSetId }),
  z.object({ kind: z.literal('cancel'), questionId: QuestionSetId }),
]);
export type QuestionRequestOp = z.infer<typeof QuestionRequestOp>;

/** `QUESTION_REQUEST` payload (worker → master, control, job-scoped). */
export const QuestionRequestPayload = z.object({
  ...LeaseRef,
  requestId: z.uuid(),
  op: QuestionRequestOp,
});
export type QuestionRequestPayload = z.infer<typeof QuestionRequestPayload>;

/** `QUESTION_STATUS` payload (master → worker, control, job-scoped): the answer to one QUESTION_REQUEST. */
export const QuestionStatusPayload = z.object({
  ...LeaseRef,
  requestId: z.uuid(),
  /** `refused`: the request itself was refused (`reason` says why); otherwise the question set's state. */
  state: z.enum([...QUESTION_STATES, 'refused']),
  questionId: QuestionSetId.optional(),
  /** `answered`: the person's answers (validated on the master). */
  answers: QuestionAnswers.optional(),
  /** `answered`: who answered (username, display only) and when. */
  answeredBy: z.string().max(64).optional(),
  answeredAt: Timestamp.optional(),
  /** `pending`: when the question expires. */
  deadlineAt: Timestamp.optional(),
  /** `refused` / `cancelled`: a stable code (`stale_lease`, `limit`, `job_ended`, …). */
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  /** Plain language for the agent (bounded). */
  detail: z.string().max(1000).optional(),
});
export type QuestionStatusPayload = z.infer<typeof QuestionStatusPayload>;

/** ASSIGN_JOB `execution.askUser` (only to `ask-user-v1` workers): the job's agent may ask the user questions. */
export const AssignedAskUser = z.object({
  /** The longest timeout the master grants (the attempt's deadline may cut it shorter). */
  maxTimeoutSec: QuestionTimeoutSec,
});
export type AssignedAskUser = z.infer<typeof AssignedAskUser>;
