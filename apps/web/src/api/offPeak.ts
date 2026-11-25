import { apiRequest, obj, nullableStr, type RequestOptions, str } from './client';

/** p6-quota-scheduling: a project's off-peak window for deferrable jobs. */
export interface OffPeakWindow {
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
}

export interface OffPeakSetting {
  readonly window: OffPeakWindow | null;
  readonly open: boolean;
  readonly nextStart: string | null;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

type Opts = Omit<RequestOptions, 'body'>;

export function parseOffPeak(v: unknown): OffPeakSetting {
  const o = obj(v);
  const w = o.window === null || o.window === undefined ? null : obj(o.window);
  return {
    window: w === null ? null : { start: str(w, 'start'), end: str(w, 'end'), timeZone: str(w, 'timeZone') },
    open: o.open === true,
    nextStart: nullableStr(o, 'nextStart'),
    updatedBy: nullableStr(o, 'updatedBy'),
    updatedAt: nullableStr(o, 'updatedAt'),
  };
}

const path = (project: string): string => `/projects/${encodeURIComponent(project)}/off-peak`;

export function getOffPeak(project: string, opts: Opts = {}): Promise<OffPeakSetting> {
  return apiRequest('GET', path(project), parseOffPeak, opts);
}

/** Admin + step-up (the caller wraps it in the step-up dialog). `null` removes the window. */
export function putOffPeak(
  project: string,
  window: OffPeakWindow | null,
  opts: Opts = {},
): Promise<OffPeakSetting> {
  return apiRequest('PUT', path(project), parseOffPeak, { ...opts, body: { window } });
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Client-side check (the master validates again, including the time zone). */
export function offPeakProblem(w: OffPeakWindow): string | null {
  if (!HHMM.test(w.start) || !HHMM.test(w.end)) return 'Use 24-hour times such as 22:00 and 07:00.';
  if (w.start === w.end) return 'Start and end must differ.';
  if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(w.timeZone))
    return 'Enter a time zone such as Europe/Istanbul.';
  return null;
}
