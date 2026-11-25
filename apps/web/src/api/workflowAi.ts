import {
  type ChatMessage,
  type ChatThread,
  type ChatWorkflowLink,
  parseMessage,
  parseThread,
  parseWorkflowLink,
} from './chat';
import { apiRequest, obj, str } from './client';

/**
 * p15-workflow-ai (docs/design/p15-workflow-ai.md): the workflow editor's AI panel — the caller's conversation linked
 * to a workflow (a normal chat thread; its live view is the chat stream) and the panel's messages with the editor's
 * context (mode, the current document, the selected nodes, a failed run).
 */

type Opts = { readonly signal?: AbortSignal };

export const WORKFLOW_AI_MODES = ['design', 'edit', 'explain', 'debug'] as const;
export type WorkflowAiMode = (typeof WORKFLOW_AI_MODES)[number];

export interface WorkflowAiThread {
  readonly thread: ChatThread;
  readonly workflow: ChatWorkflowLink;
  readonly created: boolean;
}

function parseOpened(v: unknown): WorkflowAiThread {
  const o = obj(v);
  const workflow = parseWorkflowLink(o.workflow);
  if (workflow === null) throw new Error('workflow ai: no workflow link');
  return { thread: parseThread(o.thread), workflow, created: o.created === true };
}

/** Opens (or reuses) the caller's AI conversation of a workflow; `workflowId` absent: a new workflow. */
export function openWorkflowAiThread(
  body: {
    readonly project: string;
    readonly workflowId?: string;
    readonly fresh?: boolean;
    /** Continue this conversation (Sohbet -> back to the editor). */
    readonly threadId?: string;
  },
  opts: Opts = {},
): Promise<WorkflowAiThread> {
  return apiRequest('POST', '/workflows/ai/threads', parseOpened, { ...opts, body });
}

/** Links the conversation to the workflow the editor just saved. */
export function linkWorkflowAiThread(
  threadId: string,
  body: { readonly project: string; readonly workflowId: string },
  opts: Opts = {},
): Promise<ChatWorkflowLink> {
  return apiRequest(
    'PUT',
    `/workflows/ai/threads/${encodeURIComponent(threadId)}/link`,
    (v) => {
      const l = parseWorkflowLink(v);
      if (l === null) throw new Error('workflow ai: no workflow link');
      return l;
    },
    { ...opts, body },
  );
}

export interface WorkflowAiRequest {
  readonly mode: WorkflowAiMode;
  readonly text: string;
  readonly project: string;
  readonly workflowId?: string;
  readonly document?: Record<string, unknown>;
  readonly selected?: readonly string[];
  readonly runId?: string;
}

/** Sends a panel message; the answer arrives on the conversation's stream. */
export function sendWorkflowAi(
  threadId: string,
  req: WorkflowAiRequest,
  opts: Opts = {},
): Promise<{ message: ChatMessage; turnId: string }> {
  return apiRequest(
    'POST',
    `/workflows/ai/threads/${encodeURIComponent(threadId)}/messages`,
    (v) => {
      const o = obj(v);
      return { message: parseMessage(o.message), turnId: str(o, 'turnId') };
    },
    {
      ...opts,
      body: {
        mode: req.mode,
        text: req.text,
        project: req.project,
        ...(req.workflowId === undefined ? {} : { workflowId: req.workflowId }),
        ...(req.document === undefined ? {} : { document: req.document }),
        ...(req.selected === undefined || req.selected.length === 0 ? {} : { selected: [...req.selected] }),
        ...(req.runId === undefined ? {} : { runId: req.runId }),
      },
    },
  );
}
