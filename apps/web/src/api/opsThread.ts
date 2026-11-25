import { type ApprovalRequest, parseRequest } from './approvals';
import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';
import { type OpsAction, parseAction } from './deploy';
import { type IntegrationView, parseIntegrationView } from './integration';
import { type JobSummary, parseSummary } from './jobs';
import { safeLink } from './notifications';
import { parseWorkflowApproval, type WorkflowApproval } from './workflowApprovals';

/**
 * p12-diyalog Faz 1: the operations thread (`GET /ops-thread`, apps/master/src/ops-thread, docs/design/p12-diyalog.md
 * §9). One page = the caller's notifications (newest first, keyset `before`) merged with the open cards they can
 * see. Payloads are the entities' own wire shapes, parsed with the same parsers as their screens. Every string is
 * untrusted (from runtimes, workers, repositories): rendered as text only.
 *
 * A card payload that does not parse (a newer master) degrades to an event line, never drops the item.
 */

type Opts = Omit<RequestOptions, 'body'>;

export interface ThreadEvent {
  readonly notificationId: string;
  readonly kind: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
}

export interface UsageLimitPause {
  readonly id: string;
  readonly runtime: string;
  readonly workerId: string | null;
  readonly workerName: string | null;
  readonly model: string | null;
  readonly credential: string | null;
  readonly project: string | null;
  readonly resetAt: string | null;
  readonly resumeAt: string;
  readonly since: string;
  readonly hits: number;
  readonly message: string | null;
}

interface Base {
  readonly id: string;
  readonly at: string;
  readonly subject: string | null;
  readonly unread: boolean;
  readonly event: ThreadEvent | null;
}

export type OpsItem =
  | (Base & { readonly type: 'approval:request'; readonly approval: ApprovalRequest })
  | (Base & { readonly type: 'deploy:action'; readonly deploy: OpsAction })
  | (Base & { readonly type: 'merge:integration'; readonly merge: IntegrationView })
  | (Base & {
      readonly type: 'job:failed';
      readonly job: JobSummary;
      /**
       * p15-rerun-thread: the caller's own conversation that started this job (its re-run is drafted there), or null
       * (not started from chat, archived, or an older master): the re-run then opens the composer.
       */
      readonly chatThreadId: string | null;
    })
  | (Base & { readonly type: 'limit:paused'; readonly limit: UsageLimitPause })
  /** p17-chat-flow: a workflow's approval step waiting for the caller. */
  | (Base & { readonly type: 'workflow:approval'; readonly approval: WorkflowApproval })
  /** Any notification line (`event:<kind>`), and any card type this console does not know yet. */
  | (Base & { readonly type: 'event'; readonly kind: string });

export interface OpenCounts {
  readonly approvals: number;
  readonly deploys: number;
  readonly merges: number;
  readonly failures: number;
  readonly limits: number;
}

export interface OpsThreadPage {
  readonly items: OpsItem[];
  readonly nextCursor: string | null;
  readonly open: OpenCounts | null;
}

function event(v: unknown): ThreadEvent | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const severity = str(o, 'severity');
  if (severity !== 'info' && severity !== 'warning' && severity !== 'critical')
    throw new ShapeError('severity');
  return {
    notificationId: str(o, 'notificationId'),
    kind: str(o, 'kind'),
    severity,
    title: str(o, 'title'),
    body: str(o, 'body'),
    link: safeLink(nullableStr(o, 'link')),
  };
}

export function parseLimitPause(v: unknown): UsageLimitPause {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    runtime: str(o, 'runtime'),
    workerId: nullableStr(o, 'workerId'),
    workerName: nullableStr(o, 'workerName'),
    model: nullableStr(o, 'model'),
    credential: nullableStr(o, 'credential'),
    project: nullableStr(o, 'project'),
    resetAt: nullableStr(o, 'resetAt'),
    resumeAt: str(o, 'resumeAt'),
    since: str(o, 'since'),
    hits: typeof o.hits === 'number' ? o.hits : 1,
    message: nullableStr(o, 'message'),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** p15-rerun-thread: `payload.chatThreadId` when it is a conversation id, else null (never a guess). */
function chatThreadOf(payload: unknown): string | null {
  const id =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).chatThreadId
      : null;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

export function parseOpsItem(v: unknown): OpsItem {
  const o = obj(v);
  const base: Base = {
    id: str(o, 'id'),
    at: str(o, 'at'),
    subject: nullableStr(o, 'subject'),
    unread: o.unread === true,
    event: event(o.event),
  };
  const type = str(o, 'type');
  const payload = o.payload;
  const fallback = (): OpsItem => ({
    ...base,
    type: 'event',
    kind: base.event?.kind ?? type.replace(/^event:/, ''),
  });
  if (payload === null || payload === undefined) return fallback();
  try {
    switch (type) {
      case 'approval:request':
        return { ...base, type, approval: parseRequest(payload) };
      case 'deploy:action':
        return { ...base, type, deploy: parseAction(payload) };
      case 'merge:integration':
        return { ...base, type, merge: parseIntegrationView(payload) };
      case 'job:failed':
        return { ...base, type, job: parseSummary(payload), chatThreadId: chatThreadOf(payload) };
      case 'limit:paused':
        return { ...base, type, limit: parseLimitPause(payload) };
      case 'workflow:approval':
        return { ...base, type, approval: parseWorkflowApproval(payload) };
      default:
        return fallback();
    }
  } catch {
    return fallback();
  }
}

function counts(v: unknown): OpenCounts | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return {
    approvals: int(o, 'approvals'),
    deploys: int(o, 'deploys'),
    merges: int(o, 'merges'),
    failures: int(o, 'failures'),
    limits: int(o, 'limits'),
  };
}

export function getOpsThread(
  q: { readonly before?: string | null; readonly limit?: number } = {},
  opts: Opts = {},
): Promise<OpsThreadPage> {
  const p = new URLSearchParams();
  if (q.limit !== undefined) p.set('limit', String(q.limit));
  if (q.before !== undefined && q.before !== null) p.set('before', q.before);
  const qs = p.toString();
  return apiRequest(
    'GET',
    `/ops-thread${qs === '' ? '' : `?${qs}`}`,
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.items)) throw new ShapeError('items');
      return {
        items: o.items.map(parseOpsItem),
        nextCursor: nullableStr(o, 'nextCursor'),
        open: counts(o.open),
      };
    },
    opts,
  );
}
