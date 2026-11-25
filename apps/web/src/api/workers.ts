import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';
import { invalidating } from '../lib/invalidate';

/** Typed wrappers for the master's fleet routes (apps/master/src/workers/routes.ts). */

export interface WorkerSummary {
  readonly id: string;
  /** The machine's display name: its label when a person gave one, else its hostname. */
  readonly name: string;
  /** p15-chat-cards-scroll: the name a person gave the machine (null: none, or an older master). */
  readonly label: string | null;
  readonly state: string;
  readonly quarantineReason: string | null;
  readonly connected: boolean;
  readonly fingerprint: string | null;
  readonly os: string | null;
  readonly arch: string | null;
  readonly osVersion: string | null;
  readonly hostname: string | null;
  readonly workerVersion: string;
  readonly runningJobs: number;
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
  readonly pairingExpiresAt: string | null;
  readonly pairingExpired: boolean;
  readonly drainRequestedAt: string | null;
  readonly revokedAt: string | null;
  /** p5-fleet-archive: set while the worker is removed from the fleet list (absent on older masters). */
  readonly archivedAt: string | null;
}

export interface RuntimeInfo {
  readonly runtime: string;
  readonly version: string;
  readonly installed: boolean;
  readonly authenticated: string;
  readonly pinnedVersion: string | null;
  readonly pinStatus: string;
  readonly present: boolean;
}

export interface CredentialInfo {
  readonly fingerprint: string;
  readonly status: string;
}

/** p17-chat-reconnect: one connection drop as the worker reported it in its next HELLO. */
export interface WorkerDisconnect {
  readonly at: string;
  readonly cause: string;
  readonly code: number | null;
  readonly detail: string | null;
  readonly pongWaitMs: number | null;
  readonly loopDelayMaxMs: number | null;
}

export interface WorkerDetail extends WorkerSummary {
  readonly runtimes: readonly RuntimeInfo[];
  readonly credentials: readonly CredentialInfo[];
  /** p17-chat-reconnect: newest first (empty on an older master). */
  readonly disconnects: readonly WorkerDisconnect[];
}

function optNum(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function disconnect(v: unknown): WorkerDisconnect[] {
  if (typeof v !== 'object' || v === null) return [];
  const o = v as Record<string, unknown>;
  if (typeof o.at !== 'string' || typeof o.cause !== 'string') return [];
  return [
    {
      at: o.at,
      cause: o.cause,
      code: optNum(o, 'code'),
      detail: typeof o.detail === 'string' ? o.detail : null,
      pongWaitMs: optNum(o, 'pongWaitMs'),
      loopDelayMaxMs: optNum(o, 'loopDelayMaxMs'),
    },
  ];
}

type Opts = Omit<RequestOptions, 'body'>;

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

export function workerSummary(v: unknown): WorkerSummary {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    label: o.label === undefined ? null : nullableStr(o, 'label'),
    state: str(o, 'state'),
    quarantineReason: nullableStr(o, 'quarantineReason'),
    connected: bool(o, 'connected'),
    fingerprint: nullableStr(o, 'fingerprint'),
    os: nullableStr(o, 'os'),
    arch: nullableStr(o, 'arch'),
    osVersion: nullableStr(o, 'osVersion'),
    hostname: nullableStr(o, 'hostname'),
    workerVersion: str(o, 'workerVersion'),
    runningJobs: int(o, 'runningJobs'),
    lastSeenAt: nullableStr(o, 'lastSeenAt'),
    createdAt: str(o, 'createdAt'),
    pairingExpiresAt: nullableStr(o, 'pairingExpiresAt'),
    pairingExpired: bool(o, 'pairingExpired'),
    drainRequestedAt: nullableStr(o, 'drainRequestedAt'),
    revokedAt: nullableStr(o, 'revokedAt'),
    archivedAt: o.archivedAt === undefined ? null : nullableStr(o, 'archivedAt'),
  };
}

function runtime(v: unknown): RuntimeInfo {
  const o = obj(v);
  return {
    runtime: str(o, 'runtime'),
    version: str(o, 'version'),
    installed: bool(o, 'installed'),
    authenticated: str(o, 'authenticated'),
    pinnedVersion: nullableStr(o, 'pinnedVersion'),
    pinStatus: str(o, 'pinStatus'),
    present: bool(o, 'present'),
  };
}

/** Listed workers, or (`archived: true`) only the workers removed from the list. */
export function listWorkers(opts: Opts & { readonly archived?: boolean } = {}): Promise<WorkerSummary[]> {
  const { archived, ...rest } = opts;
  return apiRequest(
    'GET',
    archived === true ? '/workers?archived=1' : '/workers',
    (v) => {
      const list = obj(v).workers;
      if (!Array.isArray(list)) throw new ShapeError('expected workers[]');
      return list.map(workerSummary);
    },
    rest,
  );
}

export function getWorker(id: string, opts: Opts = {}): Promise<WorkerDetail> {
  return apiRequest(
    'GET',
    `/workers/${encodeURIComponent(id)}`,
    (v) => {
      const o = obj(v);
      const rts = o.runtimes;
      const creds = o.credentials;
      if (!Array.isArray(rts) || !Array.isArray(creds))
        throw new ShapeError('expected runtimes[] and credentials[]');
      return {
        ...workerSummary(v),
        runtimes: rts.map(runtime),
        credentials: creds.map((c) => {
          const co = obj(c);
          return { fingerprint: str(co, 'fingerprint'), status: str(co, 'status') };
        }),
        disconnects: Array.isArray(o.disconnects) ? o.disconnects.flatMap(disconnect) : [],
      };
    },
    opts,
  );
}

export function approveWorker(id: string, pairingCode: string, opts: Opts = {}): Promise<WorkerSummary> {
  return invalidating(
    'workers',
    apiRequest('POST', `/workers/${encodeURIComponent(id)}/approve`, workerSummary, {
      ...opts,
      body: { pairingCode },
    }),
  );
}

export function workerAction(
  id: string,
  action: 'deny' | 'drain' | 'revoke' | 'approve-rotation' | 'archive' | 'unarchive',
  opts: Opts = {},
): Promise<WorkerSummary> {
  return invalidating(
    'workers',
    apiRequest('POST', `/workers/${encodeURIComponent(id)}/${action}`, workerSummary, {
      ...opts,
      body: {},
    }),
  );
}

/** The longest machine name the master takes (p15-chat-cards-scroll). */
export const MACHINE_NAME_MAX = 60;

/**
 * p15-chat-cards-scroll: give a machine a display name (`PUT /workers/:id/name`, admin); null / "" clears it (the
 * hostname again). Every cached machine name (job cards, placement, chat) is refreshed.
 */
export function renameWorker(id: string, name: string | null, opts: Opts = {}): Promise<WorkerSummary> {
  return invalidating(
    'workers',
    apiRequest('PUT', `/workers/${encodeURIComponent(id)}/name`, workerSummary, { ...opts, body: { name } }),
  );
}

/** Ask an online worker to rotate its device key (202; the result shows up in the credentials). */
export function rotateWorkerKey(id: string, opts: Opts = {}): Promise<{ requiresApproval: boolean }> {
  return apiRequest(
    'POST',
    `/workers/${encodeURIComponent(id)}/rotate`,
    (v) => {
      const r = obj(v).requiresApproval;
      if (typeof r !== 'boolean') throw new ShapeError('expected requiresApproval');
      return { requiresApproval: r };
    },
    { ...opts, body: {} },
  );
}
