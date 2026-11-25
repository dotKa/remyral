import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p8-orchestration (ADR-0031): a job's place in its sub-job family (`GET /jobs/:id/subtasks`). Titles are agent text:
 * render as text only.
 */

export interface SubtaskChild {
  readonly jobId: string;
  readonly title: string;
  readonly state: string;
  readonly runtime: string;
  readonly worker: string | null;
  readonly depth: number;
  readonly wait: boolean;
  /** How the runtime was chosen (`requested`, `requires`, `routing`, `auto`, `parent`) and its notes. */
  readonly source: string | null;
  readonly notes: readonly string[];
  readonly deliveredFiles: number;
  readonly createdAt: string;
}

export interface JobSubtasks {
  readonly parent: { readonly jobId: string; readonly title: string; readonly state: string } | null;
  readonly children: readonly SubtaskChild[];
}

export function parseSubtasks(body: unknown): JobSubtasks {
  const b = obj(body);
  if (!Array.isArray(b.children)) throw new ShapeError('expected array at children');
  const p = b.parent === null || b.parent === undefined ? null : obj(b.parent);
  return {
    parent: p === null ? null : { jobId: str(p, 'jobId'), title: str(p, 'title'), state: str(p, 'state') },
    children: b.children.map((x) => {
      const o = obj(x);
      const placement = typeof o.placement === 'object' && o.placement !== null ? obj(o.placement) : {};
      return {
        jobId: str(o, 'jobId'),
        title: str(o, 'title'),
        state: str(o, 'state'),
        runtime: str(o, 'runtime'),
        worker: nullableStr(o, 'worker'),
        depth: int(o, 'depth'),
        wait: o.wait === true,
        source: typeof placement.source === 'string' ? placement.source : null,
        notes: Array.isArray(placement.notes)
          ? placement.notes.filter((n): n is string => typeof n === 'string')
          : [],
        deliveredFiles: int(o, 'deliveredFiles'),
        createdAt: str(o, 'createdAt'),
      };
    }),
  };
}

export function getJobSubtasks(id: string, opts: Omit<RequestOptions, 'body'> = {}): Promise<JobSubtasks> {
  return apiRequest('GET', `/jobs/${encodeURIComponent(id)}/subtasks`, parseSubtasks, opts);
}
