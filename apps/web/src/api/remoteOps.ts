import { ApiError, apiRequest, obj, type RequestOptions, ShapeError } from './client';

/**
 * Remote operations of a worker (p5-remote-ops, ADR-0017; apps/master/src/remote-ops/routes.ts): install /
 * upgrade / roll back / remove pinned runtimes, relay a runtime's own subscription login (URL / device code and
 * a pasted code — the platform never sees the resulting token), restart the worker or a runtime, read redacted
 * logs and run diagnostics. Every write is admin + step-up (login: always-fresh step-up).
 */

/** ADR-0023: the four runtimes the platform runs (OpenHands was removed). */
export const OPS_RUNTIMES = ['claude-code', 'codex', 'opencode', 'pi'] as const;
export type OpsRuntime = (typeof OPS_RUNTIMES)[number];
export const LOGIN_RUNTIMES = ['claude-code', 'codex'] as const;
export type LoginRuntime = (typeof LOGIN_RUNTIMES)[number];

export const RUNTIME_NAME: Record<OpsRuntime, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

export type LoginStatus = 'logged_in' | 'logged_out' | 'expired' | 'unknown' | 'unsupported';

export interface ManagedRuntime {
  readonly runtime: OpsRuntime;
  readonly method: 'npm' | 'binary';
  readonly supported: boolean;
  readonly unsupportedReason?: string;
  readonly pinned: string;
  readonly previous?: string;
  readonly available: readonly string[];
  readonly installed: readonly {
    readonly version: string;
    readonly installedAt: string;
    readonly integrity: 'ok' | 'modified' | 'unknown';
  }[];
  readonly active: string | null;
}

export interface RemoteOpsReport {
  readonly runtimes: readonly ManagedRuntime[];
  readonly login: readonly {
    readonly runtime: LoginRuntime;
    readonly status: LoginStatus;
    readonly method?: string;
    readonly checkedAt?: string;
    /** p5-claude-auth-health: `login_expired` — a run could not refresh the login (re-login on the worker). */
    readonly reason?: string;
  }[];
  readonly service: { readonly manager: string; readonly restartable: boolean };
  readonly logs: { readonly available: boolean; readonly bytes: number };
  readonly activeCommand?: string;
}

export type OpState =
  | 'sent'
  | 'accepted'
  | 'running'
  | 'waiting_for_user'
  | 'succeeded'
  | 'failed'
  | 'refused'
  | 'cancelled'
  | 'lost';

export const TERMINAL_STATES: ReadonlySet<OpState> = new Set([
  'succeeded',
  'failed',
  'refused',
  'cancelled',
  'lost',
]);

export interface DiagnosticsView {
  readonly collectedAt: string;
  readonly workerVersion: string;
  readonly node: { readonly version: string; readonly ok: boolean; readonly requiredMajor: number };
  readonly os: { readonly platform: string; readonly release: string; readonly arch: string };
  readonly uptimeSec: number;
  readonly memory: { readonly freeBytes: number; readonly totalBytes: number };
  readonly disk: readonly {
    readonly name: string;
    readonly freeBytes: number | null;
    readonly totalBytes: number | null;
  }[];
  readonly sandbox: readonly {
    readonly profile: string;
    readonly ready: boolean;
    readonly reason?: string;
  }[];
  readonly runtimes: readonly {
    readonly runtime: string;
    readonly source: string;
    readonly version: string | null;
    readonly enabled: boolean;
    readonly authenticated: string;
    readonly integrity?: string;
    readonly problem?: string;
  }[];
  readonly service: { readonly manager: string; readonly state?: string; readonly restarts?: number | null };
  readonly problems: readonly {
    readonly code: string;
    readonly severity: string;
    readonly message: string;
  }[];
}

export interface Op {
  readonly id: string;
  readonly workerId: string;
  readonly kind: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly state: OpState;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly progress: { readonly step: string; readonly done?: number; readonly total?: number } | null;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly requestedBy: string | null;
  readonly requestedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly login: {
    readonly runtime: string;
    readonly url: string | null;
    readonly userCode: string | null;
    readonly expectsCode: boolean;
    readonly codeSent: boolean;
  } | null;
  readonly logs: {
    readonly lines: readonly string[];
    readonly next: number;
    readonly complete: boolean;
    readonly truncated: boolean;
  } | null;
}

export interface OpsStatus {
  readonly workerId: string;
  readonly displayName: string;
  readonly state: string;
  readonly connected: boolean;
  readonly supported: boolean;
  readonly report: RemoteOpsReport | null;
  readonly reportedAt: string | null;
  readonly ops: readonly Op[];
  /**
   * p14-code-images: `supported` — the machine can build its code node images (code-images-v1); `ready` — it runs
   * code nodes now (function-code-v1). Absent on older masters (read as not supported).
   */
  readonly codeImages: { readonly supported: boolean; readonly ready: boolean };
}

function parseOp(body: unknown): Op {
  const o = obj(body);
  if (typeof o.id !== 'string' || typeof o.kind !== 'string' || typeof o.state !== 'string') {
    throw new ShapeError('op');
  }
  return o as unknown as Op;
}

function parseStatus(body: unknown): OpsStatus {
  const o = obj(body);
  if (typeof o.supported !== 'boolean' || !Array.isArray(o.ops)) throw new ShapeError('ops status');
  const ci =
    o.codeImages !== null && typeof o.codeImages === 'object'
      ? (o.codeImages as Record<string, unknown>)
      : {};
  return {
    ...(o as unknown as OpsStatus),
    ops: o.ops.map(parseOp),
    codeImages: { supported: ci.supported === true, ready: ci.ready === true },
  };
}

/** Diagnostics of a finished `diagnostics.run` operation (null otherwise). */
export function diagnosticsOf(op: Op): DiagnosticsView | null {
  const d = op.result?.diagnostics;
  return d !== null && typeof d === 'object' ? (d as DiagnosticsView) : null;
}

/** Only the providers' own sign-in pages are ever shown as a link (mirrors LOGIN_URL_HOSTS). */
const LOGIN_HOSTS = [
  'claude.com',
  'claude.ai',
  'platform.claude.com',
  'console.anthropic.com',
  'auth.openai.com',
];
export function safeLoginUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && LOGIN_HOSTS.includes(u.hostname) && u.username === ''
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}

/** Compare `x.y.z` versions (pre-releases ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]?.split('.').map(Number) ?? [];
  const pb = b.split(/[-+]/)[0]?.split('.').map(Number) ?? [];
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

type Opts = Omit<RequestOptions, 'body'>;
const wid = (id: string) => `/workers/${encodeURIComponent(id)}`;

export function getOpsStatus(workerId: string, opts: Opts = {}): Promise<OpsStatus> {
  return apiRequest('GET', `${wid(workerId)}/ops`, parseStatus, opts);
}

export function getOp(workerId: string, opId: string, after = 0, opts: Opts = {}): Promise<Op> {
  return apiRequest(
    'GET',
    `${wid(workerId)}/ops/${encodeURIComponent(opId)}?after=${String(after)}`,
    parseOp,
    opts,
  );
}

const post = (path: string, body: unknown, opts: Opts) =>
  apiRequest('POST', path, parseOp, { ...opts, body });

export function installRuntime(workerId: string, runtime: OpsRuntime, version: string, opts: Opts = {}) {
  return post(`${wid(workerId)}/runtimes/${runtime}/install`, { version }, opts);
}

export function removeRuntime(workerId: string, runtime: OpsRuntime, version: string, opts: Opts = {}) {
  return post(`${wid(workerId)}/runtimes/${runtime}/remove`, { version }, opts);
}

export function restartRuntime(workerId: string, runtime: OpsRuntime, opts: Opts = {}) {
  return post(`${wid(workerId)}/runtimes/${runtime}/restart`, {}, opts);
}

/** p13-runtime-accounts: `account` = the login of that runtime account (absent: the machine's configured login). */
const accountBody = (account: string | undefined): Record<string, string> =>
  account === undefined ? {} : { account };

/**
 * The worker runs one login at a time: when one is already open (`login_in_progress`, e.g. a dialog closed before
 * its login finished), that login is returned instead, so its dialog shows the link / code again and can cancel it.
 */
export async function startLogin(
  workerId: string,
  runtime: LoginRuntime,
  account?: string,
  opts: Opts = {},
): Promise<Op> {
  try {
    return await post(`${wid(workerId)}/runtimes/${runtime}/login`, accountBody(account), opts);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'login_in_progress') throw err;
    const status = await getOpsStatus(workerId, opts);
    const open = status.ops.find((o) => o.kind === 'login.start' && !TERMINAL_STATES.has(o.state));
    if (open === undefined) throw err;
    return open;
  }
}

export function checkLogin(workerId: string, runtime: LoginRuntime, account?: string, opts: Opts = {}) {
  return post(`${wid(workerId)}/runtimes/${runtime}/login-status`, accountBody(account), opts);
}

export function logoutRuntime(workerId: string, runtime: LoginRuntime, account?: string, opts: Opts = {}) {
  return post(`${wid(workerId)}/runtimes/${runtime}/logout`, accountBody(account), opts);
}

export function sendLoginCode(workerId: string, opId: string, code: string, opts: Opts = {}) {
  return post(`${wid(workerId)}/ops/${encodeURIComponent(opId)}/input`, { code }, opts);
}

export function cancelOp(workerId: string, opId: string, opts: Opts = {}) {
  return post(`${wid(workerId)}/ops/${encodeURIComponent(opId)}/cancel`, {}, opts);
}

export function restartWorker(
  workerId: string,
  body: { drain: boolean; drainTimeoutSec: number },
  opts: Opts = {},
) {
  return post(`${wid(workerId)}/restart`, body, opts);
}

/**
 * p6-worker-boot-diagnostics: which log file — `worker` (the daemon's log), `boot` (start / fatal / early-exit
 * records written before the logger exists) or `updater` (the privileged updater's log).
 */
export type LogSource = 'worker' | 'boot' | 'updater';

export function fetchLogs(workerId: string, lines: number, source: LogSource = 'worker', opts: Opts = {}) {
  return post(`${wid(workerId)}/logs`, source === 'worker' ? { lines } : { lines, source }, opts);
}

export function runDiagnostics(workerId: string, opts: Opts = {}) {
  return post(`${wid(workerId)}/diagnostics`, {}, opts);
}

/**
 * p17-disk-selfclean: "Şimdi temizle" — the worker's disk hygiene now (what it owns and can recreate, oldest first, up
 * to its free-space target). Admin, step-up, audited.
 */
export function cleanDisk(workerId: string, opts: Opts = {}) {
  return post(`${wid(workerId)}/disk/clean`, {}, opts);
}

/** p14-code-images: pull the pinned code base images by digest and build the code node images on the machine. */
export function prepareCodeImages(workerId: string, opts: Opts = {}) {
  return post(`${wid(workerId)}/code-images/prepare`, {}, opts);
}
