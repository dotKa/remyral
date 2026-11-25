import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';
import { getOp, type Op } from './remoteOps';

/**
 * p15-git-central (apps/master/src/git-central/routes.ts): a machine's git readiness and its one-click fix, the
 * fleet-wide fix, and a project's repository credential (non-GitHub / SSH repositories; a vault reference, never a
 * value). Reads: viewers; writes: admins with step-up.
 */

export {
  knownHostsProblem,
  MAX_KNOWN_HOSTS_BYTES,
  MIN_GIT_VERSION,
  sshPrivateKeyProblem,
} from '@remyral/protocol/git-central-rules';

export const GIT_FIX_IDS = ['erase_github_credentials', 'remove_github_insteadof'] as const;
export type GitFixId = (typeof GIT_FIX_IDS)[number];

export const GIT_READINESS_CODES = [
  'git_missing',
  'git_too_old',
  'global_credential_helper',
  'global_insteadof',
  'insteadof_with_credentials',
  'safe_directory_wildcard',
  'autocrlf_true',
  'credential_store_file',
  'os_store_github',
  'global_identity',
] as const;
export type GitReadinessCode = (typeof GIT_READINESS_CODES)[number];
export type GitSeverity = 'blocking' | 'warning' | 'info';

export interface GitProblem {
  readonly code: GitReadinessCode;
  readonly severity: GitSeverity;
  readonly fix?: GitFixId;
  readonly count?: number;
  readonly helpers?: readonly string[];
}

export interface GitReadiness {
  readonly checkedAt: string;
  readonly git: {
    readonly present: boolean;
    readonly version?: string;
    readonly source?: 'config' | 'managed' | 'system';
  };
  readonly problems: readonly GitProblem[];
  readonly jobsIsolated: boolean;
  readonly osStoreUnchecked?: boolean;
}

export interface MachineGit {
  readonly workerId: string;
  readonly displayName: string;
  readonly connected: boolean;
  readonly supported: boolean;
  readonly readiness: GitReadiness | null;
  readonly readinessAt: string | null;
  readonly fixable: readonly GitFixId[];
}

type Opts = Omit<RequestOptions, 'body'>;

const isFix = (v: unknown): v is GitFixId => (GIT_FIX_IDS as readonly unknown[]).includes(v);
const isCode = (v: unknown): v is GitReadinessCode => (GIT_READINESS_CODES as readonly unknown[]).includes(v);

function parseReadiness(v: unknown): GitReadiness | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const g = obj(o.git);
  const problems: GitProblem[] = [];
  for (const raw of Array.isArray(o.problems) ? o.problems : []) {
    const p = obj(raw);
    // A code this console does not know (newer worker) is left out rather than failing the card.
    if (!isCode(p.code)) continue;
    const severity = p.severity === 'blocking' || p.severity === 'warning' ? p.severity : 'info';
    problems.push({
      code: p.code,
      severity,
      ...(isFix(p.fix) ? { fix: p.fix } : {}),
      ...(typeof p.count === 'number' ? { count: p.count } : {}),
      ...(Array.isArray(p.helpers)
        ? { helpers: p.helpers.filter((x): x is string => typeof x === 'string') }
        : {}),
    });
  }
  const source =
    g.source === 'config' || g.source === 'managed' || g.source === 'system' ? g.source : undefined;
  return {
    checkedAt: str(o, 'checkedAt'),
    git: {
      present: g.present === true,
      ...(typeof g.version === 'string' ? { version: g.version } : {}),
      ...(source === undefined ? {} : { source }),
    },
    problems,
    jobsIsolated: o.jobsIsolated === true,
    ...(o.osStoreUnchecked === true ? { osStoreUnchecked: true } : {}),
  };
}

function parseMachine(body: unknown): MachineGit {
  const o = obj(body);
  if (typeof o.supported !== 'boolean' || typeof o.connected !== 'boolean')
    throw new ShapeError('machine git');
  return {
    workerId: str(o, 'workerId'),
    displayName: str(o, 'displayName'),
    connected: o.connected,
    supported: o.supported,
    readiness: parseReadiness(o.readiness),
    readinessAt: nullableStr(o, 'readinessAt'),
    fixable: (Array.isArray(o.fixable) ? o.fixable : []).filter(isFix),
  };
}

const wid = (id: string) => `/workers/${encodeURIComponent(id)}`;

export function getMachineGit(workerId: string, opts: Opts = {}): Promise<MachineGit> {
  return apiRequest('GET', `${wid(workerId)}/git`, parseMachine, opts);
}

/** One-click "Düzelt": every fix the last report names (or the given ones). Returns the remote operation. */
export async function fixMachineGit(
  workerId: string,
  fixes?: readonly GitFixId[],
  opts: Opts = {},
): Promise<Op> {
  const ref = await apiRequest('POST', `${wid(workerId)}/git/fix`, (b) => str(obj(b), 'id'), {
    ...opts,
    body: fixes === undefined ? {} : { fixes },
  });
  return getOp(workerId, ref, 0, opts);
}

export function getFleetGit(opts: Opts = {}): Promise<MachineGit[]> {
  return apiRequest(
    'GET',
    '/fleet/git',
    (b) => {
      const o = obj(b);
      if (!Array.isArray(o.machines)) throw new ShapeError('fleet git');
      return o.machines.map(parseMachine);
    },
    opts,
  );
}

export interface FleetFixResult {
  readonly workerId: string;
  readonly displayName: string;
  readonly outcome: 'sent' | 'skipped';
  readonly reason?: string;
  readonly opId?: string;
}

export function fixFleetGit(workerIds?: readonly string[], opts: Opts = {}): Promise<FleetFixResult[]> {
  return apiRequest(
    'POST',
    '/fleet/git/fix',
    (b) => {
      const o = obj(b);
      if (!Array.isArray(o.results)) throw new ShapeError('fleet git fix');
      return o.results.map((raw) => {
        const r = obj(raw);
        return {
          workerId: str(r, 'workerId'),
          displayName: str(r, 'displayName'),
          outcome: r.outcome === 'sent' ? ('sent' as const) : ('skipped' as const),
          ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
          ...(typeof r.opId === 'string' ? { opId: r.opId } : {}),
        };
      });
    },
    { ...opts, body: workerIds === undefined ? {} : { workerIds } },
  );
}

// ------------------------------------------------------------------------------------------ repository credential

export type RepoAuthKind = 'ssh-key' | 'https-token';

export interface RepoCredential {
  readonly project: string;
  readonly credential: {
    readonly kind: RepoAuthKind;
    readonly credentialId: string;
    readonly credentialName: string | null;
    readonly username: string | null;
    readonly knownHosts: string | null;
    readonly access: 'read' | 'write';
    readonly version: number;
    readonly updatedAt: string;
    readonly updatedBy: string | null;
  } | null;
  readonly workers: readonly { readonly id: string; readonly name: string; readonly supported: boolean }[];
}

function parseRepoCredential(body: unknown): RepoCredential {
  const o = obj(body);
  const c = o.credential === null ? null : obj(o.credential);
  const kind = c?.kind;
  if (c !== null && kind !== 'ssh-key' && kind !== 'https-token')
    throw new ShapeError('repo credential kind');
  return {
    project: str(o, 'project'),
    credential:
      c === null
        ? null
        : {
            kind: kind as RepoAuthKind,
            credentialId: str(c, 'credentialId'),
            credentialName: nullableStr(c, 'credentialName'),
            username: nullableStr(c, 'username'),
            knownHosts: nullableStr(c, 'knownHosts'),
            access: c.access === 'read' ? 'read' : 'write',
            version: int(c, 'version'),
            updatedAt: str(c, 'updatedAt'),
            updatedBy: nullableStr(c, 'updatedBy'),
          },
    workers: (Array.isArray(o.workers) ? o.workers : []).map((raw) => {
      const w = obj(raw);
      return { id: str(w, 'id'), name: str(w, 'name'), supported: w.supported === true };
    }),
  };
}

const pid = (p: string) => `/projects/${encodeURIComponent(p)}/git/credential`;

export function getRepoCredential(project: string, opts: Opts = {}): Promise<RepoCredential> {
  return apiRequest('GET', pid(project), parseRepoCredential, opts);
}

export function putRepoCredential(
  project: string,
  input: {
    readonly kind: RepoAuthKind;
    readonly credentialId: string;
    readonly username?: string;
    readonly knownHosts?: string;
    readonly access: 'read' | 'write';
  },
  opts: Opts = {},
): Promise<RepoCredential> {
  return apiRequest('PUT', pid(project), parseRepoCredential, { ...opts, body: input });
}

export function deleteRepoCredential(project: string, opts: Opts = {}): Promise<RepoCredential> {
  return apiRequest('DELETE', pid(project), parseRepoCredential, opts);
}
