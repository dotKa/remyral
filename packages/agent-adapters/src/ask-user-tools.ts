import {
  QUESTION_LIMITS,
  QuestionTimeoutSec,
  QuestionTitle,
  QuestionWaitSec,
  type UserQuestionInput,
  UserQuestionInputs,
} from '@remyral/protocol';
import { z } from 'zod';

/**
 * p14-ask-user (docs/design/p14-ask-user.md §4): the question tools of a job whose master allows them (ASSIGN_JOB
 * `execution.askUser`). The agent asks the user 1–4 structured questions (single / multiple choice, free text, "other")
 * and blocks until the answer, the deadline or `waitSec`. Every runtime registers them over the job-tool channel it
 * already has (ADR-0048): Claude Code an in-process MCP server ({@link ASK_USER_MCP_SERVER}); Codex app-server dynamic
 * tools, Pi the job-tool extension and OpenCode the local MCP server with the file relay — together with the sub-job and
 * deploy tools of that channel. Each call goes to the worker's {@link AskUserToolHost}, which asks the master over the
 * job's live lease. The runtime's own permission prompt is skipped for these tools: they only show a card to people who
 * may message the job; nothing runs.
 */

export const ASK_USER_MCP_SERVER = 'remyral-ask';
export const ASK_USER_TOOL_PREFIX = `mcp__${ASK_USER_MCP_SERVER}__`;

export interface AskUserToolHost {
  /** Shows the questions and waits up to `waitSec` (0: does not wait). Never throws: `ok: false` with the reason. */
  ask(
    args: {
      readonly title?: string | undefined;
      readonly questions: readonly UserQuestionInput[];
      readonly timeoutSec?: number | undefined;
      readonly waitSec?: number | undefined;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly ok: boolean; readonly text: string }>;
  /** Waits for the answer of an earlier question up to `waitSec` (0: its state now). */
  wait(
    questionId: string,
    waitSec: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ readonly ok: boolean; readonly text: string }>;
}

export const ASK_USER_TOOLS = {
  ask_user: {
    description:
      'Ask the user (the people who supervise this job) 1–4 questions and WAIT for the answer — use it when you need a decision or a detail only they can give (which option, a missing value, confirmation of an assumption); never ask in plain text and stop. Per question: prompt; kind single (one option), multi (any options) or text (free text); single / multi need 2–8 options with a short label and an optional description; allowOther: true adds an "Other" choice with its own text; default pre-selects (labels) or pre-fills (text). Write in the language of the task. Never ask for passwords, tokens or other secrets. The question appears on the job page, in the user\'s inbox and as a notification. The call waits up to waitSec seconds (default 540); if nobody has answered by then it returns the question id — call wait_for_answer to keep waiting, or continue. timeoutSec (default 1800) is when the question expires: then you get "no answer" and continue with your own best judgement (say what you assumed). Answers are the user\'s words.',
    input: {
      title: QuestionTitle.optional(),
      questions: UserQuestionInputs,
      timeoutSec: QuestionTimeoutSec.optional(),
      waitSec: QuestionWaitSec.optional(),
    },
  },
  wait_for_answer: {
    description:
      'Keep waiting for the answer to a question you asked with ask_user (questionId from its result), up to waitSec seconds (default 540; 0 = its state now). Returns the answers, "still open", or "no answer" when it expired or was withdrawn.',
    input: { questionId: z.uuid(), waitSec: QuestionWaitSec.optional() },
  },
} as const;

export type AskUserToolName = keyof typeof ASK_USER_TOOLS;
export const ASK_USER_TOOL_NAMES = Object.keys(ASK_USER_TOOLS) as AskUserToolName[];

export function isAskUserToolName(name: string): name is AskUserToolName {
  return (ASK_USER_TOOL_NAMES as readonly string[]).includes(name);
}

/** The question tools with JSON Schema inputs (Codex dynamic tools, Pi extension tools, the OpenCode MCP server). */
export function askUserToolSpecs(): {
  name: AskUserToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}[] {
  return ASK_USER_TOOL_NAMES.map((name) => {
    const schema = z.toJSONSchema(z.strictObject(ASK_USER_TOOLS[name].input), {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
    delete schema.$schema;
    return { name, description: ASK_USER_TOOLS[name].description, inputSchema: schema };
  });
}

/** Dispatches one validated tool call to the host (shared by the adapters and the fake runtime). Never throws. */
export async function runAskUserTool(
  host: AskUserToolHost,
  name: AskUserToolName,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; text: string }> {
  const parsed = z.strictObject(ASK_USER_TOOLS[name].input).safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      text: `invalid arguments: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`,
    };
  }
  const a = parsed.data as Record<string, unknown>;
  try {
    switch (name) {
      case 'ask_user':
        return await host.ask(
          {
            title: a.title as string | undefined,
            questions: a.questions as UserQuestionInput[],
            timeoutSec: a.timeoutSec as number | undefined,
            waitSec: a.waitSec as number | undefined,
          },
          signal,
        );
      case 'wait_for_answer':
        return await host.wait(a.questionId as string, a.waitSec as number | undefined, signal);
    }
  } catch (err) {
    return { ok: false, text: `the question tool failed: ${err instanceof Error ? err.message : 'error'}` };
  }
}

/** The worker's prompt preamble line for jobs with the question tools. */
export const ASK_USER_PREAMBLE =
  '[Remyral questions] If you need a decision or a detail only the user can give, call ask_user (single / multiple ' +
  'choice or free text, an "Other" choice where useful) instead of asking in plain text — the question reaches the ' +
  'user on the job page and as a notification, and the call waits for the answer. Do not ask for secrets. If it ' +
  `expires unanswered (default ${String(QUESTION_LIMITS.defaultTimeoutSec / 60)} min), continue with your best ` +
  'judgement and say what you assumed.';
