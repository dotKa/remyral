import {
  type AssignedGitAuth,
  fixesFor,
  GIT_CENTRAL_FEATURE,
  GIT_CREDENTIAL_KINDS,
  type CredentialKind,
  type GitAuthKind,
  type GitFixId,
  GitReadinessReport,
  knownHostsProblem,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { ActorContext } from '../workers/fleet.js';

/**
 * p15-git-central (docs/design/p15-git-central.md): the master's part of "git without touching machines".
 *
 *  - §3 Git hazırlığı: each machine's git readiness as its worker reported it (CAPABILITIES.gitReadiness), the one-
 *    click fix of one machine and the fleet-wide fix — both through the remote-ops path (signed OPS_COMMAND `git.fix`,
 *    admin + step-up, audited, rate-limited; security-policy event `machines.ops`).
 *  - §4 Repository credentials of non-GitHub / SSH repositories: a reference to a vault credential (sealed in the
 *    browser to the chosen workers; the master never sees the value) with the pinned known_hosts / username, and its
 *    assignment to a repository job (ASSIGN_JOB `execution.gitAuth`, only to `git-central-v1` workers).
 */

/** What the routes need from the remote-ops service (one signed operation per machine). */
export interface GitFixDispatcher {
  request(
    workerId: string,
    op: { readonly kind: 'git.fix'; readonly fixes: GitFixId[] },
    actor: ActorContext,
  ): Promise<{ readonly id: string; readonly state: string }>;
}

export interface MachineGitView {
  readonly workerId: string;
  readonly displayName: string;
  readonly connected: boolean;
  /** The worker build checks and fixes git (`git-central-v1`). */
  readonly supported: boolean;
  readonly readiness: GitReadinessReport | null;
  readonly readinessAt: string | null;
  /** What a one-click "Düzelt" applies now. */
  readonly fixable: GitFixId[];
}

export interface FleetFixOutcome {
  readonly workerId: string;
  readonly displayName: string;
  readonly outcome: 'sent' | 'skipped';
  readonly reason?: string;
  readonly opId?: string;
}

export interface RepoCredentialView {
  readonly project: string;
  readonly credential: {
    readonly kind: GitAuthKind;
    readonly credentialId: string;
    readonly credentialName: string | null;
    readonly username: string | null;
    readonly knownHosts: string | null;
    readonly access: 'read' | 'write';
    readonly version: number;
    readonly updatedAt: string;
    readonly updatedBy: string | null;
  } | null;
  /** Workers holding the vault credential (active, applied) — the machines that can run this project's jobs. */
  readonly workers: { readonly id: string; readonly name: string; readonly supported: boolean }[];
}

export interface RepoCredentialInput {
  readonly kind: GitAuthKind;
  readonly credentialId: string;
  readonly username?: string | undefined;
  readonly knownHosts?: string | undefined;
  readonly access: 'read' | 'write';
}

const VAULT_KIND: Readonly<Record<GitAuthKind, CredentialKind>> = {
  'ssh-key': 'git-ssh-key',
  'https-token': 'git-https-token',
};

interface WorkerRow {
  id: string;
  display_name: string | null;
  features: unknown;
  git_readiness: unknown;
  git_readiness_at: Date | null;
}

function features(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

export class GitCentralService {
  constructor(
    private readonly deps: {
      readonly pool: Parameters<typeof withTransaction>[0];
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      /** Connected workers (sessions). */
      readonly connected: (workerId: string) => boolean;
      readonly ops: () => GitFixDispatcher;
    },
  ) {}

  #view(w: WorkerRow): MachineGitView {
    const parsed = GitReadinessReport.safeParse(w.git_readiness);
    const readiness = parsed.success ? parsed.data : null;
    return {
      workerId: w.id,
      displayName: w.display_name ?? w.id,
      connected: this.deps.connected(w.id),
      supported: features(w.features).includes(GIT_CENTRAL_FEATURE),
      readiness,
      readinessAt: w.git_readiness_at?.toISOString() ?? null,
      fixable: readiness === null ? [] : fixesFor(readiness),
    };
  }

  async machine(workerId: string): Promise<MachineGitView> {
    const { rows } = await this.deps.pool.query<WorkerRow>(
      `SELECT id, display_name, features, git_readiness, git_readiness_at FROM workers
        WHERE id = $1 AND revoked_at IS NULL`,
      [workerId],
    );
    const w = rows[0];
    if (w === undefined) throw new HttpError(404, 'worker_not_found', 'No such worker.');
    return this.#view(w);
  }

  async fleet(): Promise<MachineGitView[]> {
    const { rows } = await this.deps.pool.query<WorkerRow>(
      `SELECT id, display_name, features, git_readiness, git_readiness_at FROM workers
        WHERE approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL
        ORDER BY display_name, id`,
    );
    return rows.map((w) => this.#view(w));
  }

  /** One machine: the requested fixes, else every fix its last report names (409 `nothing_to_fix` when none). */
  async fixMachine(
    workerId: string,
    fixes: readonly GitFixId[] | undefined,
    actor: ActorContext,
  ): Promise<{ readonly id: string; readonly state: string }> {
    const view = await this.machine(workerId);
    const wanted = fixes !== undefined && fixes.length > 0 ? [...new Set(fixes)] : view.fixable;
    if (wanted.length === 0) {
      throw new HttpError(409, 'nothing_to_fix', 'This machine reports no git problem the platform can fix.');
    }
    return this.deps.ops().request(workerId, { kind: 'git.fix', fixes: wanted }, actor);
  }

  /**
   * Fleet-wide: one `git.fix` per connected, capable machine that reports fixable problems (optionally only the
   * listed machines). Machines that are offline, on an older build or without problems are skipped with the reason;
   * each sent operation is the same audited, rate-limited remote op as the single-machine fix.
   */
  async fixFleet(actor: ActorContext, workerIds?: readonly string[]): Promise<FleetFixOutcome[]> {
    const only = workerIds === undefined ? null : new Set(workerIds);
    const out: FleetFixOutcome[] = [];
    for (const m of await this.fleet()) {
      if (only !== null && !only.has(m.workerId)) continue;
      const base = { workerId: m.workerId, displayName: m.displayName };
      if (!m.supported) {
        out.push({ ...base, outcome: 'skipped', reason: 'worker_update_required' });
        continue;
      }
      if (!m.connected) {
        out.push({ ...base, outcome: 'skipped', reason: 'worker_offline' });
        continue;
      }
      if (m.fixable.length === 0) {
        out.push({ ...base, outcome: 'skipped', reason: 'nothing_to_fix' });
        continue;
      }
      try {
        const op = await this.deps.ops().request(m.workerId, { kind: 'git.fix', fixes: m.fixable }, actor);
        out.push({ ...base, outcome: 'sent', opId: op.id });
      } catch (err) {
        out.push({
          ...base,
          outcome: 'skipped',
          reason: err instanceof HttpError ? err.code : 'request_failed',
        });
      }
    }
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'fleet.git.fix',
      target: 'fleet:git',
      outcome: 'success',
      metadata: {
        sent: out.filter((o) => o.outcome === 'sent').length,
        skipped: out.filter((o) => o.outcome === 'skipped').length,
      },
    });
    return out;
  }

  // ------------------------------------------------------------------------------------ repository credentials

  async repoCredential(project: string, db: Queryable = this.deps.pool): Promise<RepoCredentialView> {
    await this.#project(db, project);
    const { rows } = await db.query<{
      kind: GitAuthKind;
      credential_id: string;
      name: string | null;
      username: string | null;
      known_hosts: string | null;
      access: 'read' | 'write';
      version: number;
      updated_at: Date;
      by: string | null;
    }>(
      `SELECT r.kind, r.credential_id, c.name, r.username, r.known_hosts, r.access, r.version, r.updated_at,
              u.username AS by
         FROM project_repo_credentials r
         LEFT JOIN vault_credentials c ON c.id = r.credential_id
         LEFT JOIN users u ON u.id = r.updated_by
        WHERE r.project = $1`,
      [project],
    );
    const r = rows[0];
    const workers =
      r === undefined
        ? []
        : (
            await db.query<{ id: string; name: string | null; features: unknown }>(
              `SELECT w.id, w.display_name AS name, w.features FROM vault_credential_workers v
                 JOIN workers w ON w.id = v.worker_id
                WHERE v.credential_id = $1 AND v.state = 'active' AND w.revoked_at IS NULL
                ORDER BY w.display_name, w.id`,
              [r.credential_id],
            )
          ).rows.map((w) => ({
            id: w.id,
            name: w.name ?? w.id,
            supported: features(w.features).includes(GIT_CENTRAL_FEATURE),
          }));
    return {
      project,
      credential:
        r === undefined
          ? null
          : {
              kind: r.kind,
              credentialId: r.credential_id,
              credentialName: r.name,
              username: r.username,
              knownHosts: r.known_hosts,
              access: r.access,
              version: r.version,
              updatedAt: r.updated_at.toISOString(),
              updatedBy: r.by,
            },
      workers,
    };
  }

  async setRepoCredential(
    actor: ActorContext,
    project: string,
    input: RepoCredentialInput,
  ): Promise<RepoCredentialView> {
    const knownHosts = input.knownHosts?.trim() ?? '';
    if (input.kind === 'ssh-key') {
      const problem = knownHostsProblem(knownHosts);
      if (problem !== null) throw knownHostsError(problem);
    } else if (knownHosts !== '') {
      throw knownHostsError('not_allowed');
    }
    const username = input.kind === 'https-token' ? (input.username?.trim() ?? '') || 'git' : null;
    const now = this.deps.clock();
    return withTransaction(this.deps.pool, async (tx) => {
      await this.#project(tx, project);
      const { rows } = await tx.query<{ kind: string; state: string }>(
        'SELECT kind, state FROM vault_credentials WHERE id = $1',
        [input.credentialId],
      );
      const c = rows[0];
      if (c === undefined || c.state !== 'active')
        throw new HttpError(404, 'not_found', 'Credential not found.', {}, {}, { reason: 'credential' });
      if (!GIT_CREDENTIAL_KINDS.has(c.kind as CredentialKind) || c.kind !== VAULT_KIND[input.kind]) {
        throw input.kind === 'ssh-key'
          ? new HttpError(
              422,
              'credential_kind',
              'This credential is not a git SSH deploy key; create one of that kind in Settings → Credentials.',
              {},
              {},
              { reason: 'ssh_key' },
            )
          : new HttpError(
              422,
              'credential_kind',
              'This credential is not a git HTTPS token; create one of that kind in Settings → Credentials.',
              {},
              {},
              { reason: 'https_token' },
            );
      }
      const before = await tx.query<{ kind: string; credential_id: string; access: string }>(
        'SELECT kind, credential_id, access FROM project_repo_credentials WHERE project = $1',
        [project],
      );
      await tx.query(
        `INSERT INTO project_repo_credentials (project, kind, credential_id, username, known_hosts, access, version,
                                               updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)
         ON CONFLICT (project) DO UPDATE SET kind = EXCLUDED.kind, credential_id = EXCLUDED.credential_id,
           username = EXCLUDED.username, known_hosts = EXCLUDED.known_hosts, access = EXCLUDED.access,
           version = project_repo_credentials.version + 1, updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by`,
        [
          project,
          input.kind,
          input.credentialId,
          username,
          input.kind === 'ssh-key' ? knownHosts : null,
          input.access,
          now,
          actor.userId,
        ],
      );
      const b = before.rows[0];
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'project.repo_credential.update',
          target: `project:${project}`,
          outcome: 'success',
          metadata: {
            project,
            before:
              b === undefined ? null : { kind: b.kind, credentialId: b.credential_id, access: b.access },
            after: {
              kind: input.kind,
              credentialId: input.credentialId,
              access: input.access,
              knownHostsLines: input.kind === 'ssh-key' ? knownHosts.split('\n').filter(Boolean).length : 0,
            },
          },
        },
        tx,
      );
      return this.repoCredential(project, tx);
    });
  }

  async deleteRepoCredential(actor: ActorContext, project: string): Promise<RepoCredentialView> {
    return withTransaction(this.deps.pool, async (tx) => {
      await this.#project(tx, project);
      const del = await tx.query<{ kind: string; credential_id: string }>(
        'DELETE FROM project_repo_credentials WHERE project = $1 RETURNING kind, credential_id',
        [project],
      );
      const d = del.rows[0];
      if (d !== undefined) {
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: actor.userId },
            action: 'project.repo_credential.delete',
            target: `project:${project}`,
            outcome: 'success',
            metadata: { project, kind: d.kind, credentialId: d.credential_id },
          },
          tx,
        );
      }
      return this.repoCredential(project, tx);
    });
  }

  async #project(db: Queryable, project: string): Promise<void> {
    const { rowCount } = await db.query('SELECT 1 FROM projects WHERE id = $1', [project]);
    if ((rowCount ?? 0) === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
  }
}

const KNOWN_HOSTS_MESSAGES = {
  empty:
    'An SSH deploy key needs pinned known_hosts lines: one "host key-type key" line per host key, as ssh-keyscan prints them.',
  too_long: 'The known_hosts lines are too long (at most 16 KiB).',
  too_many_lines: 'At most 16 known_hosts lines.',
  bad_line:
    'A known_hosts line is not valid: "host key-type key" with plain or hashed host names; markers, wildcards and negations are refused.',
  not_allowed: 'known_hosts lines only apply to an SSH deploy key.',
} as const;

function knownHostsError(reason: keyof typeof KNOWN_HOSTS_MESSAGES): HttpError {
  return new HttpError(422, 'invalid_known_hosts', KNOWN_HOSTS_MESSAGES[reason], {}, {}, { reason });
}

/**
 * ASSIGN_JOB `execution.gitAuth` of a repository job: the project's repository credential, only for a
 * `git-central-v1` worker and — for an untrusted source — only a credential the admin declared read-only (ADR-0010:
 * no git write credential for untrusted sources). Undefined: none (the GitHub App token path, or no credential).
 */
export async function repoGitAuth(
  db: Queryable,
  job: { readonly project: string; readonly sourceTrust: string | undefined },
  workerFeatures: readonly string[],
): Promise<AssignedGitAuth | undefined> {
  if (!workerFeatures.includes(GIT_CENTRAL_FEATURE)) return undefined;
  const { rows } = await db.query<{
    kind: GitAuthKind;
    credential_id: string;
    username: string | null;
    known_hosts: string | null;
    access: 'read' | 'write';
  }>(
    `SELECT r.kind, r.credential_id, r.username, r.known_hosts, r.access
       FROM project_repo_credentials r JOIN vault_credentials c ON c.id = r.credential_id AND c.state = 'active'
      WHERE r.project = $1`,
    [job.project],
  );
  const r = rows[0];
  if (r === undefined) return undefined;
  if (job.sourceTrust !== 'trusted' && r.access !== 'read') return undefined;
  return {
    kind: r.kind,
    credentialId: r.credential_id,
    ...(r.username === null ? {} : { username: r.username }),
    ...(r.known_hosts === null ? {} : { knownHosts: r.known_hosts }),
  };
}
