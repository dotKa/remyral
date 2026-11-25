import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p11-session-continuity (ADR-0042): a job's checkpoints and its resumes after worker restarts
 * (`GET /jobs/:id/continuity`). Tool names are runtime text: render as text only.
 */

export type ToolClass = 'idempotent' | 'workspace_write' | 'external' | 'unknown';

export interface ToolNote {
  readonly toolName: string;
  readonly class: ToolClass;
  readonly state: 'running' | 'done' | 'failed';
}

export interface Checkpoint {
  readonly n: number;
  readonly epoch: number;
  readonly takenAt: string;
  readonly kind: 'git' | 'snapshot';
  readonly ref: string | null;
  readonly files: number;
  readonly bytes: number;
  readonly lastTool: ToolNote | null;
  readonly inFlight: number;
}

export interface RestartEntry {
  readonly pauseId: string;
  readonly status: string;
  readonly detectedAt: string;
  readonly pausedEpoch: number;
  readonly resumedEpoch: number | null;
  readonly checkpoint: number;
  readonly restarts: number;
  readonly resume: 'session' | 'continuation';
  readonly unknownOutcome: readonly ToolNote[];
  readonly blockedReason: string | null;
  readonly endReason: string | null;
  readonly summary: string;
}

export interface JobContinuity {
  readonly checkpoints: readonly Checkpoint[];
  readonly restarts: readonly RestartEntry[];
}

const CLASSES: readonly ToolClass[] = ['idempotent', 'workspace_write', 'external', 'unknown'];

function tool(v: unknown): ToolNote {
  const o = obj(v);
  const c = str(o, 'class');
  const state = str(o, 'state');
  return {
    toolName: str(o, 'toolName'),
    class: (CLASSES as readonly string[]).includes(c) ? (c as ToolClass) : 'unknown',
    state: state === 'done' || state === 'failed' ? state : 'running',
  };
}

function list(o: Record<string, unknown>, key: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ShapeError(`expected array at ${key}`);
  return v;
}

export function parseContinuity(body: unknown): JobContinuity {
  const b = obj(body);
  return {
    checkpoints: list(b, 'checkpoints').map((x) => {
      const o = obj(x);
      return {
        n: int(o, 'n'),
        epoch: int(o, 'epoch'),
        takenAt: str(o, 'takenAt'),
        kind: str(o, 'kind') === 'snapshot' ? 'snapshot' : 'git',
        ref: nullableStr(o, 'ref'),
        files: int(o, 'files'),
        bytes: typeof o.bytes === 'number' ? o.bytes : 0,
        lastTool: o.lastTool === null || o.lastTool === undefined ? null : tool(o.lastTool),
        inFlight: int(o, 'inFlight'),
      };
    }),
    restarts: list(b, 'restarts').map((x) => {
      const o = obj(x);
      return {
        pauseId: str(o, 'pauseId'),
        status: str(o, 'status'),
        detectedAt: str(o, 'detectedAt'),
        pausedEpoch: int(o, 'pausedEpoch'),
        resumedEpoch: o.resumedEpoch === null ? null : int(o, 'resumedEpoch'),
        checkpoint: int(o, 'checkpoint'),
        restarts: int(o, 'restarts'),
        resume: str(o, 'resume') === 'session' ? 'session' : 'continuation',
        unknownOutcome: list(o, 'unknownOutcome').map(tool),
        blockedReason: nullableStr(o, 'blockedReason'),
        endReason: nullableStr(o, 'endReason'),
        summary: str(o, 'summary'),
      };
    }),
  };
}

export function getJobContinuity(
  id: string,
  opts: Omit<RequestOptions, 'body'> = {},
): Promise<JobContinuity> {
  return apiRequest('GET', `/jobs/${encodeURIComponent(id)}/continuity`, parseContinuity, opts);
}
