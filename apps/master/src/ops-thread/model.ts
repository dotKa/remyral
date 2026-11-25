/**
 * p12-diyalog Faz 1 (docs/design/p12-diyalog.md §9): the operations thread — the console home of the Diyalog shell.
 * Pure parts: item shape, which notification kinds open a card, subject references parsed from notification links,
 * and the merge of history (the caller's notifications, keyset-paged) with the open cards (pending approvals, ops
 * actions waiting, integrations that need a person, recent failures, active usage-limit pauses).
 *
 * Ids are stable across polls and pages: a card is `<kind>:<entity id>` whatever produced it (the notification that
 * announced it or the open set), an event line is `n:<notification id>`. A client keeps one item per id.
 */

export const CARD_TYPES = [
  'approval:request',
  'deploy:action',
  'merge:integration',
  'job:failed',
  'limit:paused',
  // p17-chat-flow: a workflow's approval step waiting for the caller (decided on the card with the run page's route).
  'workflow:approval',
] as const;
export type CardType = (typeof CARD_TYPES)[number];

export type SubjectKind = 'approval' | 'deploy' | 'merge' | 'job' | 'limit' | 'workflow';

export const CARD_OF: Readonly<Record<SubjectKind, CardType>> = {
  approval: 'approval:request',
  deploy: 'deploy:action',
  merge: 'merge:integration',
  job: 'job:failed',
  limit: 'limit:paused',
  workflow: 'workflow:approval',
};

export interface SubjectRef {
  readonly kind: SubjectKind;
  readonly id: string;
}

export function subjectKey(ref: SubjectRef): string {
  return `${ref.kind}:${ref.id}`;
}

/**
 * Notification kinds that announce a decision card: the thread shows the card (with its current state) where the
 * notification would be. Every other kind stays an event line (a follow-up such as `approval.stale`,
 * `deploy.failed`, `job.paused` keeps its `subject` so the client can relate it to the card).
 */
export const ORIGIN_KINDS: Readonly<Record<string, SubjectKind>> = {
  'approval.requested': 'approval',
  'deploy.waiting': 'deploy',
  'job.failed': 'job',
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LINKS: readonly (readonly [RegExp, SubjectKind])[] = [
  [new RegExp(`^/approvals/(${UUID})(?:[/?#]|$)`, 'i'), 'approval'],
  [new RegExp(`^/deploys/(${UUID})(?:[/?#]|$)`, 'i'), 'deploy'],
  [new RegExp(`^/jobs/(${UUID})(?:[/?#]|$)`, 'i'), 'job'],
];

/** The entity a notification link points at (`/approvals/<id>`, `/deploys/<id>`, `/jobs/<id>`), if any. */
export function refOfLink(link: string | null): SubjectRef | null {
  if (link === null) return null;
  for (const [re, kind] of LINKS) {
    const m = re.exec(link);
    if (m?.[1] !== undefined) return { kind, id: m[1].toLowerCase() };
  }
  return null;
}

export interface ThreadEvent {
  readonly notificationId: string;
  readonly kind: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
}

/** One thread item on the wire. `payload` is the entity exactly as its own endpoint returns it. */
export interface OpsThreadItem {
  readonly id: string;
  readonly type: string;
  readonly at: string;
  readonly subject: string | null;
  readonly unread: boolean;
  readonly event: ThreadEvent | null;
  readonly payload: Record<string, unknown> | null;
}

/** Newest first; equal times by id descending, so the order is total and stable across polls. */
export function compareItems(a: OpsThreadItem, b: OpsThreadItem): number {
  const t = Date.parse(b.at) - Date.parse(a.at);
  if (t !== 0) return t;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Merges history and open cards into one page: one item per id (an open card and the notification that announced
 * it become one card — the earlier time, the notification's unread flag and event, the fresher payload), newest
 * first.
 */
export function mergeItems(
  history: readonly OpsThreadItem[],
  open: readonly OpsThreadItem[],
): OpsThreadItem[] {
  const byId = new Map<string, OpsThreadItem>();
  for (const item of [...history, ...open]) {
    const prev = byId.get(item.id);
    if (prev === undefined) {
      byId.set(item.id, item);
      continue;
    }
    byId.set(item.id, {
      ...prev,
      at: Date.parse(item.at) < Date.parse(prev.at) ? item.at : prev.at,
      unread: prev.unread || item.unread,
      event: prev.event ?? item.event,
      payload: item.payload ?? prev.payload,
    });
  }
  return [...byId.values()].sort(compareItems);
}

/** Counts of open cards by kind (the pinned "Benden ne bekleniyor" summary and the rail counters). */
export interface OpenCounts {
  readonly approvals: number;
  readonly deploys: number;
  readonly merges: number;
  readonly failures: number;
  readonly limits: number;
}

export const EMPTY_COUNTS: OpenCounts = { approvals: 0, deploys: 0, merges: 0, failures: 0, limits: 0 };

export function countOpen(open: readonly OpsThreadItem[]): OpenCounts {
  const n = (type: CardType): number => open.filter((i) => i.type === type).length;
  return {
    // p17-chat-flow: a workflow's approval step counts as an approval.
    approvals: n('approval:request') + n('workflow:approval'),
    deploys: n('deploy:action'),
    merges: n('merge:integration'),
    failures: n('job:failed'),
    limits: n('limit:paused'),
  };
}

/** Integration states a person has to act on (or look at): ready = the pull request waits to be merged. */
export const MERGE_ATTENTION = ['ready', 'needs_human', 'failed'] as const;
/** Failed / lost jobs stay open cards for this long (the classic Home "Needs you" window). */
export const FAILED_WINDOW_MS = 24 * 3600_000;
/** needs_human / failed integrations stay open cards for this long; `ready` until merged. */
export const MERGE_WINDOW_MS = 7 * 24 * 3600_000;
