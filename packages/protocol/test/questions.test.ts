import { describe, expect, it } from 'vitest';
import {
  answersText,
  answerWithoutNote,
  ASSISTANT_TOOLS,
  assistantToolInput,
  assistantToolJsonSchema,
  AssignJob,
  MasterToWorker,
  QUESTION_LIMITS,
  QuestionStatusPayload,
  sameAnswers,
  UserQuestionInput,
  UserQuestionInputs,
  type UserQuestion,
  validateAnswers,
  WorkerFeature,
  WorkerToMaster,
  withQuestionIds,
} from '../src/index.js';
import { masterMessages, workerMessages } from './fixtures.js';

const single: UserQuestion = {
  id: 'env',
  prompt: 'Which environment?',
  kind: 'single',
  options: [{ label: 'preview' }, { label: 'production', description: 'needs an approval' }],
  allowOther: true,
};
const multi: UserQuestion = {
  id: 'langs',
  prompt: 'Which languages?',
  kind: 'multi',
  options: [{ label: 'TR' }, { label: 'EN' }, { label: 'DE' }],
};
const free: UserQuestion = { id: 'name', prompt: 'Project name?', kind: 'text', placeholder: 'e.g. shop' };

describe('question schema (p14-ask-user)', () => {
  it('accepts the three kinds and assigns ids q1… in order', () => {
    const input = UserQuestionInputs.parse([
      { prompt: 'A or B?', kind: 'single', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q1', prompt: 'Why?', kind: 'text' },
      { prompt: 'Pick any', kind: 'multi', options: [{ label: 'x' }, { label: 'y' }], default: ['x'] },
    ]);
    expect(withQuestionIds(input).map((q) => q.id)).toEqual(['q2', 'q1', 'q3']);
  });

  it('refuses malformed questions', () => {
    const bad = [
      { prompt: 'one option', kind: 'single', options: [{ label: 'A' }] },
      { prompt: 'dupes', kind: 'single', options: [{ label: 'A' }, { label: 'a ' }] },
      { prompt: 'text with options', kind: 'text', options: [{ label: 'A' }, { label: 'B' }] },
      { prompt: 'text with other', kind: 'text', allowOther: true },
      { prompt: 'bad default', kind: 'single', options: [{ label: 'A' }, { label: 'B' }], default: 'C' },
      {
        prompt: 'two defaults',
        kind: 'single',
        options: [{ label: 'A' }, { label: 'B' }],
        default: ['A', 'B'],
      },
      { prompt: '   ', kind: 'text' },
      { prompt: 'x'.repeat(QUESTION_LIMITS.maxPromptChars + 1), kind: 'text' },
      { prompt: 'label with newline', kind: 'single', options: [{ label: 'A\nB' }, { label: 'C' }] },
      { prompt: 'bidi ‮ override', kind: 'text' },
      {
        prompt: 'nine',
        kind: 'multi',
        options: Array.from({ length: 9 }, (_, i) => ({ label: `o${String(i)}` })),
      },
      { prompt: 'unknown field', kind: 'text', html: '<b>x</b>' },
      { id: 'Bad Id', prompt: 'id', kind: 'text' },
    ];
    for (const q of bad) expect(UserQuestionInput.safeParse(q).success, JSON.stringify(q)).toBe(false);
    // Prompts may have lines.
    expect(UserQuestionInput.safeParse({ prompt: 'line 1\nline 2', kind: 'text' }).success).toBe(true);
    // 1–4 questions, unique ids.
    expect(UserQuestionInputs.safeParse([]).success).toBe(false);
    expect(UserQuestionInputs.safeParse(Array.from({ length: 5 }, () => free)).success).toBe(false);
    expect(UserQuestionInputs.safeParse([free, free]).success).toBe(false);
  });

  it('validates answers: one per question, labels from the options, other only where allowed', () => {
    const qs = [single, multi, free];
    const ok = validateAnswers(qs, [
      { id: 'env', choices: ['Production'] },
      { id: 'langs', choices: ['TR', 'EN'] },
      { id: 'name', text: '  shop  ' },
    ]);
    expect(ok).toEqual({
      ok: true,
      answers: [
        { id: 'env', choices: ['production'] },
        { id: 'langs', choices: ['TR', 'EN'] },
        { id: 'name', text: 'shop' },
      ],
    });
    const other = validateAnswers([single], [{ id: 'env', other: 'staging' }]);
    expect(other.ok).toBe(true);
    const cases: [unknown, string][] = [
      [[{ id: 'env', choices: ['preview'] }], 'missing'],
      [
        [
          { id: 'env', choices: ['preview', 'production'] },
          { id: 'langs', choices: ['TR'] },
          { id: 'name', text: 'a' },
        ],
        'too_many',
      ],
      [
        [
          { id: 'env', choices: ['preview'], other: 'x' },
          { id: 'langs', choices: ['TR'] },
          { id: 'name', text: 'a' },
        ],
        'too_many',
      ],
      [
        [
          { id: 'env', choices: ['dev'] },
          { id: 'langs', choices: ['TR'] },
          { id: 'name', text: 'a' },
        ],
        'unknown_option',
      ],
      [
        [
          { id: 'env', choices: ['preview'] },
          { id: 'langs', other: 'FR' },
          { id: 'name', text: 'a' },
        ],
        'other_not_allowed',
      ],
      [
        [
          { id: 'env', choices: ['preview'] },
          { id: 'langs', choices: [] },
          { id: 'name', text: 'a' },
        ],
        'missing',
      ],
      [
        [
          { id: 'env', choices: ['preview'] },
          { id: 'langs', choices: ['TR'] },
          { id: 'name', choices: ['a'] },
        ],
        'wrong_kind',
      ],
      [
        [
          { id: 'env', choices: ['preview'] },
          { id: 'env', choices: ['preview'] },
        ],
        'duplicate',
      ],
      [[{ id: 'nope', text: 'x' }], 'unknown_question'],
      [[{ id: 'env', choices: ['preview'], extra: 1 }], 'shape'],
      ['not an array', 'shape'],
    ];
    for (const [answers, issue] of cases) {
      const r = validateAnswers(qs, answers);
      expect(r.ok, JSON.stringify(answers)).toBe(false);
      if (!r.ok) expect(r.issue, JSON.stringify(answers)).toBe(issue);
    }
  });

  it('compares answers order-insensitively and renders them as text for the agent', () => {
    expect(
      sameAnswers([{ id: 'langs', choices: ['TR', 'EN'] }], [{ id: 'langs', choices: ['EN', 'TR'] }]),
    ).toBe(true);
    expect(sameAnswers([{ id: 'langs', choices: ['TR'] }], [{ id: 'langs', choices: ['EN'] }])).toBe(false);
    const t = answersText(
      [single, free],
      [
        { id: 'env', other: 'staging' },
        { id: 'name', text: 'a\nb' },
      ],
    );
    expect(t).toContain('1. [env] Which environment?');
    expect(t).toContain('→ Other: staging');
    expect(t).toContain('→ a\n     b');
  });

  it('wire: QUESTION_REQUEST / QUESTION_STATUS are job-scoped control messages; askUser in ASSIGN_JOB; feature', () => {
    expect(WorkerToMaster.safeParse(workerMessages.QUESTION_REQUEST).success).toBe(true);
    expect(MasterToWorker.safeParse(masterMessages.QUESTION_STATUS).success).toBe(true);
    const { jobId: _j, ...noJob } = workerMessages.QUESTION_REQUEST;
    expect(WorkerToMaster.safeParse(noJob).success).toBe(false);
    // An ask must carry stored-shape questions (ids assigned).
    const noId = structuredClone(workerMessages.QUESTION_REQUEST);
    delete (noId.payload.op.questions[0] as { id?: string }).id;
    expect(WorkerToMaster.safeParse(noId).success).toBe(false);
    expect(
      QuestionStatusPayload.safeParse({ attemptId: 'att_01', epoch: 3, requestId: 'x', state: 'pending' })
        .success,
    ).toBe(false);
    expect(WorkerFeature.safeParse('ask-user-v1').success).toBe(true);
    const assign = structuredClone(masterMessages.ASSIGN_JOB) as {
      payload: { execution?: Record<string, unknown> };
    };
    assign.payload.execution = { hostExecutionOptIn: false, askUser: { maxTimeoutSec: 3600 } };
    expect(AssignJob.safeParse(assign).success).toBe(true);
    assign.payload.execution.askUser = { maxTimeoutSec: 10 };
    expect(AssignJob.safeParse(assign).success).toBe(false);
  });

  it('assistant tool ask_user: notify kind, strict input, JSON schema for every engine', () => {
    expect(ASSISTANT_TOOLS.ask_user.kind).toBe('notify');
    const input = assistantToolInput('ask_user');
    expect(input.safeParse({ questions: [free] }).success).toBe(true);
    expect(input.safeParse({ questions: [free], to: 'someone-else' }).success).toBe(false);
    const schema = assistantToolJsonSchema('ask_user');
    expect(schema.type).toBe('object');
    expect(JSON.stringify(schema)).toContain('allowOther');
  });
});

describe('answer notes (p19-plan-decide)', () => {
  const qs = withQuestionIds([
    UserQuestionInput.parse({
      prompt: 'Tasarım?',
      kind: 'single',
      options: [{ label: 'A' }, { label: 'B' }],
      allowOther: true,
    }),
    UserQuestionInput.parse({ prompt: 'Dil?', kind: 'text' }),
  ]) as UserQuestion[];
  it('keeps a trimmed note; the agent text carries it', () => {
    const r = validateAnswers(qs, [
      { id: 'q1', other: 'yeni tasarım', note: '  ikinci turdaki  ' },
      { id: 'q2', text: 'Türkçe' },
    ]);
    expect(r).toEqual({
      ok: true,
      answers: [
        { id: 'q1', other: 'yeni tasarım', note: 'ikinci turdaki' },
        { id: 'q2', text: 'Türkçe' },
      ],
    });
    if (!r.ok) return;
    expect(answersText(qs, r.answers)).toContain('   Note: ikinci turdaki');
    expect(sameAnswers(r.answers, [{ ...r.answers[0], note: 'başka' } as never, r.answers[1] as never])).toBe(
      false,
    );
  });
  it('an older worker gets the note folded into the text (its wire schema is strict)', () => {
    expect(answerWithoutNote({ id: 'q1', choices: ['A'], note: 'n' })).toEqual({
      id: 'q1',
      choices: ['A'],
      other: 'Note: n',
    });
    expect(answerWithoutNote({ id: 'q2', text: 't', note: 'n' })).toEqual({ id: 'q2', text: 't\n\nNote: n' });
    expect(answerWithoutNote({ id: 'q2', text: 't' })).toEqual({ id: 'q2', text: 't' });
  });
});
