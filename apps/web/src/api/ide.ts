import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p19-ide W2 (apps/master/src/ide/routes.ts, ADR-0066): "Tam IDE" — openvscode-server workspaces on a Linux machine.
 * The console lists and steers them; the IDE itself opens in a new tab on the IDE origin (`ide.<domain>`) with a
 * one-time ticket. Nothing here is code or a secret: names, states, machines.
 */

type Opts = Omit<RequestOptions, 'body'>;
const enc = encodeURIComponent;

export interface IdeWorkspace {
  readonly id: string;
  readonly project: string;
  readonly userId: string;
  readonly username: string | null;
  readonly workerId: string;
  readonly workerName: string | null;
  readonly workerConnected: boolean;
  readonly name: string;
  readonly source: 'repository' | 'files';
  readonly branch: string | null;
  readonly baseRef: string | null;
  readonly desired: 'running' | 'stopped' | 'deleted';
  readonly state: string;
  readonly detail: string | null;
  readonly stopReason: string | null;
  readonly head: string | null;
  readonly memoryMb: number;
  readonly idleMinutes: number;
  readonly memoryBytes: number | null;
  readonly pullRequestUrl: string | null;
  readonly startedAt: string | null;
  readonly lastActivityAt: string | null;
  readonly lastPushedAt: string | null;
  readonly createdAt: string;
  readonly stoppedAt: string | null;
  /** p19-ide W3: the last start's extensions (null: none recorded). */
  readonly extensions: IdeWorkspaceExtensions | null;
}

export interface IdeWorkspaceExtensions {
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly installed: readonly string[] | null;
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
}

function parseWorkspaceExtensions(raw: unknown): IdeWorkspaceExtensions | null {
  if (raw === null || raw === undefined) return null;
  const o = obj(raw);
  const list = (v: unknown): { id: string; reason: string }[] =>
    (Array.isArray(v) ? v : []).map((x) => {
      const e = obj(x);
      return { id: str(e, 'id'), reason: str(e, 'reason') };
    });
  return {
    skipped: list(o.skipped),
    installed: Array.isArray(o.installed)
      ? o.installed.filter((x): x is string => typeof x === 'string')
      : null,
    failed: list(o.failed),
  };
}

export interface IdeMachine {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
  readonly available: boolean;
  /**
   * `offline`, `no_feature`, `platform_update` (p19-ide W2b: macOS / Windows machine on an older worker release),
   * `capacity`, `not_assigned`, `unavailable` (the machine's own reason: `detail`, `detailCode`).
   */
  readonly reason: string | null;
  readonly detail: string | null;
  /** p19-ide W2b: the machine's reason code for `unavailable` (e.g. `platform_unsupported`, `seatbelt_required`). */
  readonly detailCode: string | null;
  /** p19-ide W2b: `linux`, `darwin`, `win32` (null: unknown). */
  readonly platform: string | null;
  readonly running: number;
  readonly max: number;
}

export interface IdeState {
  readonly configured: boolean;
  readonly canUse: boolean;
  readonly limits: {
    readonly perMachine: number;
    readonly memoryMb: number;
    readonly idleMinutes: number;
    readonly perUserProject: number;
  };
  readonly machines: readonly IdeMachine[];
  readonly workspaces: readonly IdeWorkspace[];
}

export interface IdeGit {
  readonly status: 'ok' | 'refused' | 'failed';
  readonly reason: string | null;
  readonly detail: string | null;
  readonly branch: string | null;
  readonly head: string | null;
  readonly committed: boolean;
  readonly pushed: boolean;
  readonly changedFiles: number | null;
  readonly ahead: number | null;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
}

const num = (o: Record<string, unknown>, k: string): number => {
  const v = o[k];
  if (typeof v !== 'number') throw new ShapeError(`${k} must be a number`);
  return v;
};
const nnum = (o: Record<string, unknown>, k: string): number | null => {
  const v = o[k];
  return typeof v === 'number' ? v : null;
};

export function parseIdeWorkspace(raw: unknown): IdeWorkspace {
  const o = obj(raw);
  const source = str(o, 'source');
  const desired = str(o, 'desired');
  if (source !== 'repository' && source !== 'files') throw new ShapeError('source');
  if (desired !== 'running' && desired !== 'stopped' && desired !== 'deleted')
    throw new ShapeError('desired');
  return {
    id: str(o, 'id'),
    project: str(o, 'project'),
    userId: str(o, 'userId'),
    username: nullableStr(o, 'username'),
    workerId: str(o, 'workerId'),
    workerName: nullableStr(o, 'workerName'),
    workerConnected: o.workerConnected === true,
    name: str(o, 'name'),
    source,
    branch: nullableStr(o, 'branch'),
    baseRef: nullableStr(o, 'baseRef'),
    desired,
    state: str(o, 'state'),
    detail: nullableStr(o, 'detail'),
    stopReason: nullableStr(o, 'stopReason'),
    head: nullableStr(o, 'head'),
    memoryMb: num(o, 'memoryMb'),
    idleMinutes: num(o, 'idleMinutes'),
    memoryBytes: nnum(o, 'memoryBytes'),
    pullRequestUrl: nullableStr(o, 'pullRequestUrl'),
    startedAt: nullableStr(o, 'startedAt'),
    lastActivityAt: nullableStr(o, 'lastActivityAt'),
    lastPushedAt: nullableStr(o, 'lastPushedAt'),
    createdAt: str(o, 'createdAt'),
    stoppedAt: nullableStr(o, 'stoppedAt'),
    extensions: parseWorkspaceExtensions(o.extensions),
  };
}

function parseMachine(raw: unknown): IdeMachine {
  const o = obj(raw);
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    online: o.online === true,
    available: o.available === true,
    reason: nullableStr(o, 'reason'),
    detail: nullableStr(o, 'detail'),
    // p19-ide W2b (absent from an older master: null).
    detailCode: typeof o.detailCode === 'string' ? o.detailCode : null,
    platform: typeof o.platform === 'string' ? o.platform : null,
    running: num(o, 'running'),
    max: num(o, 'max'),
  };
}

function parseState(raw: unknown): IdeState {
  const o = obj(raw);
  const l = obj(o.limits);
  if (!Array.isArray(o.machines) || !Array.isArray(o.workspaces))
    throw new ShapeError('machines / workspaces');
  return {
    configured: o.configured === true,
    canUse: o.canUse === true,
    limits: {
      perMachine: num(l, 'perMachine'),
      memoryMb: num(l, 'memoryMb'),
      idleMinutes: num(l, 'idleMinutes'),
      perUserProject: num(l, 'perUserProject'),
    },
    machines: o.machines.map(parseMachine),
    workspaces: o.workspaces.map(parseIdeWorkspace),
  };
}

function parseGit(raw: unknown): IdeGit {
  const o = obj(raw);
  const status = str(o, 'status');
  if (status !== 'ok' && status !== 'refused' && status !== 'failed') throw new ShapeError('status');
  const pr = o.pullRequest === null || o.pullRequest === undefined ? null : obj(o.pullRequest);
  return {
    status,
    reason: nullableStr(o, 'reason'),
    detail: nullableStr(o, 'detail'),
    branch: nullableStr(o, 'branch'),
    head: nullableStr(o, 'head'),
    committed: o.committed === true,
    pushed: o.pushed === true,
    changedFiles: nnum(o, 'changedFiles'),
    ahead: nnum(o, 'ahead'),
    pullRequest: pr === null ? null : { number: num(pr, 'number'), url: str(pr, 'url') },
  };
}

const one = (b: unknown): IdeWorkspace => parseIdeWorkspace(obj(b).workspace);

/** The Kod tab's Tam IDE state: configured, may the caller use it, machines (with why not), own workspaces. */
export function getIdeState(project: string, opts: Opts = {}): Promise<IdeState> {
  return apiRequest('GET', `/projects/${enc(project)}/ide`, parseState, opts);
}

export interface CreateIdeInput {
  readonly name: string;
  readonly worker?: string;
  readonly baseRef?: string;
  readonly seedJobId?: string;
}

/** Creates and starts a workspace (step-up: event `ide.start`). */
export function createIdeWorkspace(
  project: string,
  input: CreateIdeInput,
  opts: Opts = {},
): Promise<IdeWorkspace> {
  return apiRequest('POST', `/projects/${enc(project)}/ide/workspaces`, one, { ...opts, body: input });
}

export function getIdeWorkspace(id: string, opts: Opts = {}): Promise<IdeWorkspace> {
  return apiRequest('GET', `/ide/workspaces/${enc(id)}`, one, opts);
}

/** Starts a stopped workspace again (step-up: event `ide.start`). */
export function startIdeWorkspace(id: string, opts: Opts = {}): Promise<IdeWorkspace> {
  return apiRequest('POST', `/ide/workspaces/${enc(id)}/start`, one, { ...opts, body: {} });
}

export function stopIdeWorkspace(id: string, opts: Opts = {}): Promise<IdeWorkspace> {
  return apiRequest('POST', `/ide/workspaces/${enc(id)}/stop`, one, { ...opts, body: {} });
}

export function deleteIdeWorkspace(id: string, opts: Opts = {}): Promise<null> {
  return apiRequest('DELETE', `/ide/workspaces/${enc(id)}`, () => null, opts);
}

/** A one-time ticket URL on the IDE origin (open it in a new tab within a minute). */
export function openIdeWorkspace(id: string, opts: Opts = {}): Promise<{ url: string; expiresAt: string }> {
  return apiRequest(
    'POST',
    `/ide/workspaces/${enc(id)}/open`,
    (b) => {
      const o = obj(b);
      return { url: str(o, 'url'), expiresAt: str(o, 'expiresAt') };
    },
    { ...opts, body: {} },
  );
}

export function getIdeGit(id: string, opts: Opts = {}): Promise<IdeGit> {
  return apiRequest('GET', `/ide/workspaces/${enc(id)}/git`, parseGit, opts);
}

/** "Sohbete ekle" references made in the caller's IDEs, taken now (each comes once). */
export function claimIdeReferences(
  opts: Opts = {},
): Promise<{ project: string; id: string; label: string }[]> {
  return apiRequest(
    'POST',
    '/me/ide/references/claim',
    (b) => {
      const o = obj(b);
      if (!Array.isArray(o.references)) throw new ShapeError('references');
      return o.references.map((r) => {
        const x = obj(r);
        return { project: str(x, 'project'), id: str(x, 'id'), label: str(x, 'label') };
      });
    },
    { ...opts, body: {} },
  );
}

/** States in which the server is (meant to be) coming up or up. */
export const IDE_LIVE_STATES: ReadonlySet<string> = new Set(['pending', 'preparing', 'starting', 'running']);
/** States that change by themselves soon (the list polls while one is shown). */
export const IDE_MOVING_STATES: ReadonlySet<string> = new Set(['pending', 'preparing', 'starting']);
