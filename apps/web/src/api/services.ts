import { apiRequest, obj, type RequestOptions, ShapeError } from './client';

/**
 * p15-services (apps/master/src/services/routes.ts): Servisler — long-running dev servers / backends a machine keeps
 * running outside any job (no job slot). The console only reads their state and logs and asks the master to start,
 * stop, restart or extend them; secrets are references (`secret:vault-<id>`), never values.
 */

type Opts = Omit<RequestOptions, 'body'>;

export interface ServiceView {
  readonly id: string;
  readonly project: string;
  readonly workerId: string;
  readonly workerName: string | null;
  readonly name: string;
  readonly desired: 'running' | 'stopped' | 'removed';
  readonly state: string;
  readonly health: string;
  readonly detail: string | null;
  readonly url: string | null;
  readonly port: number | null;
  readonly command: string;
  readonly cwd: string | null;
  readonly tunnel: { readonly mode: string; readonly state: string | null; readonly detail: string | null };
  readonly sandboxProfile: string;
  readonly restartPolicy: string;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly restarts: number;
  readonly cpuPercent: number | null;
  readonly memoryBytes: number | null;
  readonly sourceJobId: string | null;
  readonly createdBy: { readonly type: string; readonly id: string; readonly username: string | null };
  readonly createdVia: string;
  readonly expiresAt: string | null;
  readonly statusAt: string | null;
  readonly createdAt: string;
  readonly stoppedAt: string | null;
  readonly stopReason: string | null;
  readonly workerConnected: boolean;
  /** p21-service-egress: `project` = the project's network access policy applies; else model APIs only. */
  readonly network: 'project' | 'model_apis_only';
}

export interface ServiceLogLine {
  readonly at: string;
  readonly stream: string;
  readonly text: string;
}

const s = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  if (typeof v !== 'string') throw new ShapeError(`${k} must be a string`);
  return v;
};
const ns = (o: Record<string, unknown>, k: string): string | null => {
  const v = o[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new ShapeError(`${k} must be a string or null`);
  return v;
};
const nn = (o: Record<string, unknown>, k: string): number | null => {
  const v = o[k];
  return typeof v === 'number' ? v : null;
};

export function parseService(raw: unknown): ServiceView {
  const o = obj(raw);
  const tunnel = obj(o.tunnel);
  const by = obj(o.createdBy);
  const desired = s(o, 'desired');
  if (desired !== 'running' && desired !== 'stopped' && desired !== 'removed')
    throw new ShapeError('desired');
  return {
    id: s(o, 'id'),
    project: s(o, 'project'),
    workerId: s(o, 'workerId'),
    workerName: ns(o, 'workerName'),
    name: s(o, 'name'),
    desired,
    state: s(o, 'state'),
    health: s(o, 'health'),
    detail: ns(o, 'detail'),
    url: ns(o, 'url'),
    port: nn(o, 'port'),
    command: s(o, 'command'),
    cwd: ns(o, 'cwd'),
    tunnel: { mode: s(tunnel, 'mode'), state: ns(tunnel, 'state'), detail: ns(tunnel, 'detail') },
    sandboxProfile: s(o, 'sandboxProfile'),
    restartPolicy: s(o, 'restartPolicy'),
    pid: nn(o, 'pid'),
    startedAt: ns(o, 'startedAt'),
    restarts: nn(o, 'restarts') ?? 0,
    cpuPercent: nn(o, 'cpuPercent'),
    memoryBytes: nn(o, 'memoryBytes'),
    sourceJobId: ns(o, 'sourceJobId'),
    createdBy: { type: s(by, 'type'), id: s(by, 'id'), username: ns(by, 'username') },
    createdVia: s(o, 'createdVia'),
    expiresAt: ns(o, 'expiresAt'),
    statusAt: ns(o, 'statusAt'),
    createdAt: s(o, 'createdAt'),
    stoppedAt: ns(o, 'stoppedAt'),
    stopReason: ns(o, 'stopReason'),
    workerConnected: o.workerConnected === true,
    network: o.network === 'model_apis_only' ? 'model_apis_only' : 'project',
  };
}

const parseList = (b: unknown): ServiceView[] => {
  const o = obj(b);
  if (!Array.isArray(o.services)) throw new ShapeError('services must be an array');
  return o.services.map(parseService);
};
const parseOne = (b: unknown): ServiceView => parseService(obj(b).service);

export function listServices(
  filter: { project?: string; worker?: string; state?: 'live' | 'stopped' | 'failed' | 'any' } = {},
  opts: Opts = {},
): Promise<ServiceView[]> {
  const q = new URLSearchParams();
  if (filter.project !== undefined) q.set('project', filter.project);
  if (filter.worker !== undefined) q.set('worker', filter.worker);
  q.set('state', filter.state ?? 'any');
  return apiRequest('GET', `/services?${q.toString()}`, parseList, opts);
}

export interface StartServiceInput {
  readonly worker?: string;
  readonly fromJobId?: string;
  readonly baseRef?: string;
  readonly request: {
    readonly name: string;
    readonly command: string;
    readonly cwd?: string;
    readonly port?: number;
    readonly tunnel?: 'none' | 'quick' | 'named';
    readonly ttlMinutes?: number;
    readonly untilStopped?: boolean;
    readonly health?:
      { readonly kind: 'none' } | { readonly kind: 'tcp' } | { readonly kind: 'http'; readonly path: string };
    readonly restart?: { readonly policy: 'never' | 'on-failure' | 'always' };
  };
}

export function startService(
  project: string,
  input: StartServiceInput,
  opts: Opts = {},
): Promise<ServiceView> {
  return apiRequest('POST', `/projects/${encodeURIComponent(project)}/services`, parseOne, {
    ...opts,
    body: input,
  });
}

export function stopService(id: string, remove = false, opts: Opts = {}): Promise<ServiceView> {
  return apiRequest('POST', `/services/${encodeURIComponent(id)}/stop`, parseOne, {
    ...opts,
    body: remove ? { remove: true } : {},
  });
}

export function restartService(id: string, opts: Opts = {}): Promise<ServiceView> {
  return apiRequest('POST', `/services/${encodeURIComponent(id)}/restart`, parseOne, { ...opts, body: {} });
}

export function extendService(
  id: string,
  ext: { minutes?: number; untilStopped?: boolean },
  opts: Opts = {},
): Promise<ServiceView> {
  return apiRequest('POST', `/services/${encodeURIComponent(id)}/extend`, parseOne, { ...opts, body: ext });
}

export function serviceLogs(
  id: string,
  lines = 200,
  opts: Opts = {},
): Promise<{ lines: ServiceLogLine[]; truncated: boolean }> {
  return apiRequest(
    'GET',
    `/services/${encodeURIComponent(id)}/logs?lines=${String(lines)}`,
    (b) => {
      const o = obj(b);
      if (!Array.isArray(o.lines)) throw new ShapeError('lines must be an array');
      return {
        lines: o.lines.map((l) => {
          const x = obj(l);
          return { at: s(x, 'at'), stream: s(x, 'stream'), text: s(x, 'text') };
        }),
        truncated: o.truncated === true,
      };
    },
    opts,
  );
}

/** States in which the process is (meant to be) alive. */
export const LIVE_STATES: ReadonlySet<string> = new Set([
  'pending',
  'starting',
  'running',
  'unhealthy',
  'restarting',
]);
