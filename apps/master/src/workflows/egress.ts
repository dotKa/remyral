import { FUNCTION_LIMITS, type FunctionEgress } from '@remyral/protocol';
import { HOST_NAME, isForbiddenHost } from '@remyral/workflow-nodes';
import type { AuditRecorder } from '../audit/audit.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';

/**
 * p14-workflow-engine 14.3, decision K1 (ADR-0055 §8.4): a project's HTTP egress policy for workflow HTTP
 * request and e-mail nodes. Default **open** — any public address (the UI shows "Açık (öneri: listeyle sınırla)");
 * `allowlist` — only the listed hosts. In `open` mode the list matters only for `host:port` entries that unlock a
 * non-default port. LAN / private / loopback / link-local / metadata addresses are refused in every mode (here for
 * names and literals, on the worker for every resolved address); requests always leave from a worker.
 *
 * Changing it needs `workflows.egress.write` (project admin) and an always-fresh step-up; every change is audited
 * (`workflow.egress.update`, before / after). The policy in force is read again for every node run and sent with the
 * function job (the worker re-checks it).
 */

export interface EgressView {
  readonly project: string;
  readonly mode: 'open' | 'allowlist';
  readonly hosts: string[];
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

/** `host` or `host:port`, lower case. */
const ENTRY = /^([^:]+)(?::(\d{1,5}))?$/;

/** Why one allowlist entry is refused, or null. Public DNS names only: no IP literals, no internal names. */
export function egressEntryProblem(raw: string): string | null {
  const m = ENTRY.exec(raw);
  if (m === null || m[1] === undefined) return 'malformed';
  const host = m[1];
  if (raw !== raw.toLowerCase() || raw.trim() !== raw) return 'not_normalised';
  if (/^[0-9.]+$/.test(host) || host.includes('[')) return 'ip_literal';
  if (!HOST_NAME.test(host) || !host.includes('.')) return 'invalid_host';
  if (isForbiddenHost(host)) return 'forbidden_host';
  if (m[2] !== undefined) {
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'invalid_port';
  }
  return null;
}

/** Normalises user input (trim, lower case, drop a trailing dot) without validating it. */
export function normaliseEgressEntry(raw: string): string {
  const t = raw.trim().toLowerCase();
  const m = ENTRY.exec(t);
  if (m?.[1] === undefined) return t;
  const host = m[1].endsWith('.') ? m[1].slice(0, -1) : m[1];
  return m[2] === undefined ? host : `${host}:${m[2]}`;
}

/** Does the policy let a request reach `host:port`? (`defaultPorts`: ports usable without a `host:port` entry.) */
export function egressAllows(
  policy: FunctionEgress,
  host: string,
  port: number,
  defaultPorts: readonly number[],
): boolean {
  const h = host.toLowerCase();
  const exact = policy.hosts.includes(`${h}:${String(port)}`);
  if (policy.mode === 'allowlist') return exact || (policy.hosts.includes(h) && defaultPorts.includes(port));
  return exact || defaultPorts.includes(port);
}

export class WorkflowEgressService {
  constructor(
    private readonly deps: {
      readonly pool: Parameters<typeof withTransaction>[0];
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
    },
  ) {}

  /** The policy in force (the K1 default when the project never set one). */
  async get(project: string, db: Queryable = this.deps.pool): Promise<EgressView> {
    await this.#project(db, project);
    const { rows } = await db.query<{
      mode: 'open' | 'allowlist';
      hosts: string[];
      updated_at: Date;
      updated_by: string;
    }>('SELECT mode, hosts, updated_at, updated_by FROM workflow_egress WHERE project = $1', [project]);
    const r = rows[0];
    if (r === undefined) return { project, mode: 'open', hosts: [], updatedAt: null, updatedBy: null };
    return {
      project,
      mode: r.mode,
      hosts: [...r.hosts],
      updatedAt: r.updated_at.toISOString(),
      updatedBy: r.updated_by,
    };
  }

  /** What a function job carries (the effective policy, re-read for every node run). */
  async effective(project: string, db: Queryable = this.deps.pool): Promise<FunctionEgress> {
    const v = await this.get(project, db);
    return { mode: v.mode, hosts: v.hosts };
  }

  async set(
    actor: { readonly userId: string },
    project: string,
    input: { readonly mode: 'open' | 'allowlist'; readonly hosts: readonly string[] },
  ): Promise<EgressView> {
    const hosts = [...new Set(input.hosts.map(normaliseEgressEntry))].sort();
    if (hosts.length > FUNCTION_LIMITS.maxEgressHosts)
      throw new HttpError(
        422,
        'invalid_egress',
        `At most ${String(FUNCTION_LIMITS.maxEgressHosts)} hosts.`,
        {},
        {},
        { reason: 'too_many', max: FUNCTION_LIMITS.maxEgressHosts },
      );
    for (const h of hosts) {
      const problem = egressEntryProblem(h);
      if (problem !== null)
        throw new HttpError(
          422,
          'invalid_egress',
          `${h}: not a public host name (${problem}); LAN, private, loopback and metadata addresses are never allowed.`,
          {},
          { detail: h },
          { entry: h, problem },
        );
    }
    const now = this.deps.clock();
    return withTransaction(this.deps.pool, async (tx) => {
      const before = await this.get(project, tx);
      await tx.query(
        `INSERT INTO workflow_egress (project, mode, hosts, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project) DO UPDATE SET mode = EXCLUDED.mode, hosts = EXCLUDED.hosts,
           updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [project, input.mode, hosts, actor.userId, now],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'workflow.egress.update',
          target: `project:${project}`,
          outcome: 'success',
          metadata: {
            project,
            before: { mode: before.mode, hosts: before.hosts },
            after: { mode: input.mode, hosts },
          },
        },
        tx,
      );
      return this.get(project, tx);
    });
  }

  async #project(db: Queryable, project: string): Promise<void> {
    const { rowCount } = await db.query('SELECT 1 FROM projects WHERE id = $1', [project]);
    if ((rowCount ?? 0) === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
  }
}
