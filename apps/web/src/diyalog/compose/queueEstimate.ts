import { PRIORITY_CLASS_VALUE, type PriorityClass, type QueueEntry, type QueueView } from '../../api/queue';
import { type Formatter, type Messages, messagesFor } from '@remyral/i18n';
import { HH_MM, TR_FORMAT } from '../common/time';

/**
 * p12-diyalog Faz 3: where a drafted job would enter the queue, from the queue the console already reads
 * (`GET /queue`: dispatch order per sandbox-profile pool, positions, wait reasons, estimated starts). The draft is not
 * queued yet, so this is an estimate ("tahmin"): the pool is the one its spec would land in (profile, or profile@machine
 * when pinned to one machine, as the master's poolKey), it goes behind every queued job of the same or a higher class,
 * and it starts at once when that pool has a free slot and nothing is ahead. Pure (unit tested).
 */

const TR = messagesFor('tr');

export interface QueueRow {
  readonly key: string;
  readonly position: number;
  readonly title: string;
  /** Why it waits / when it starts. */
  readonly wait: string;
  readonly isNew: boolean;
}

export interface QueueEstimate {
  readonly position: number;
  /** Jobs ahead of it in its pool. */
  readonly ahead: number;
  /** "Hemen başlar", "≈ 14:20 sonrası", "ilk boş slotta". */
  readonly start: string;
  /** Free slots in the pool right now (null: unknown). */
  readonly free: number | null;
  readonly rows: readonly QueueRow[];
  /** Ahead jobs not listed. */
  readonly hidden: number;
}

function waitText(e: QueueEntry, w: Messages['chatCompose']['queue'], hhmm: (iso: string) => string): string {
  if (e.estimatedStart !== null) return hhmm(e.estimatedStart);
  const until = e.reasons.find((r) => r.until !== undefined)?.until;
  if (until !== undefined) return `${hhmm(until)} ${e.category === null ? '' : w.wait[e.category]}`.trim();
  return e.category === null ? w.queued : w.wait[e.category];
}

export function poolKeyOf(spec: Record<string, unknown>): string {
  const profile = typeof spec.sandboxProfile === 'string' ? spec.sandboxProfile : 'container';
  const req = spec.requirements as { workers?: unknown } | undefined;
  const workers = Array.isArray(req?.workers) ? req.workers : [];
  return workers.length === 1 && typeof workers[0] === 'string' ? `${profile}@${workers[0]}` : profile;
}

export function estimateQueue(
  view: QueueView,
  spec: Record<string, unknown>,
  cls: PriorityClass,
  title: string,
  opts: { readonly show?: number } = {},
  t: Messages = TR,
  f: Formatter = TR_FORMAT,
): QueueEstimate {
  const w = t.chatCompose.queue;
  const hhmm = (iso: string): string => f.dateWith(iso, HH_MM);
  const key = poolKeyOf(spec);
  const pool = view.pools.find((p) => p.key === key) ?? null;
  const jobs = pool?.jobs ?? [];
  const value = PRIORITY_CLASS_VALUE[cls];
  // Queued jobs are in dispatch order; the new one goes after every queued job of its class or higher.
  let index = jobs.findIndex((j) => j.state !== 'QUEUED' || j.priority < value);
  if (index === -1) index = jobs.length;
  const aheadJobs = jobs.slice(0, index);
  const behind = jobs.slice(index);
  const slots = pool?.machines.reduce((n, m) => n + (m.slots ?? 0), 0) ?? null;
  const running = pool?.machines.reduce((n, m) => n + m.running, 0) ?? 0;
  const free = pool === null || slots === null ? null : Math.max(0, slots - running);
  const last = aheadJobs[aheadJobs.length - 1];
  const start =
    aheadJobs.length === 0
      ? free === null || free > 0
        ? w.startNow
        : w.startFirstFree
      : last?.estimatedStart !== null && last?.estimatedStart !== undefined
        ? w.startAfter({ time: hhmm(last.estimatedStart) })
        : w.startAfterJobs({ n: aheadJobs.length });
  const show = opts.show ?? 3;
  const listed = aheadJobs.slice(-show);
  const rows: QueueRow[] = [
    ...listed.map((j) => ({
      key: j.jobId,
      position: j.position,
      title: j.title.split('\n')[0] ?? j.title,
      wait: waitText(j, w, hhmm),
      isNew: false,
    })),
    {
      key: 'new',
      position: index + 1,
      title,
      wait: aheadJobs.length === 0 ? w.first : w.afterPosition({ n: index }),
      isNew: true,
    },
    ...behind.slice(0, 1).map((j) => ({
      key: j.jobId,
      position: j.position + 1,
      title: j.title.split('\n')[0] ?? j.title,
      wait: waitText(j, w, hhmm),
      isNew: false,
    })),
  ];
  return {
    position: index + 1,
    ahead: aheadJobs.length,
    start,
    free,
    rows,
    hidden: aheadJobs.length - listed.length,
  };
}
