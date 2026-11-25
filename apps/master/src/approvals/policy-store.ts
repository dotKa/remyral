import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { DEFAULT_STEP_UP_WINDOW_MS } from '../auth/step-up.js';
import type { Role } from '../auth/users.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import {
  ApprovalError,
  ApprovalForbiddenError,
  InvalidApprovalInputError,
  PolicyBelowFloorError,
  PolicyVersionConflictError,
  StepUpRequiredError,
} from './errors.js';
import { checkProjectRules, type ProjectPolicy, ProjectPolicyRules } from './policy.js';

export const PROJECT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_REASON = 1_000;

/** An authenticated human acting through the console/API (never a worker or the repository). */
export interface HumanActor {
  readonly id: string;
  readonly role: Role;
  /** Last TOTP verification of the session (login or step-up), for ADR-0009 §10. */
  readonly mfaAt: Date | null;
  /**
   * p5-stepup-window: accepted age of `mfaAt` for this session (Infinity for a remember-me / trusted-device
   * session after its TOTP). Omitted: the standard 10 minutes.
   */
  readonly stepUpMaxAgeMs?: number;
  /** p15-autonomy: accepted age for always-fresh actions (the security policy's cap; omitted: min(standard, 10 min)). */
  readonly alwaysFreshMaxAgeMs?: number;
}

export interface RequestMeta {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface StoredProjectPolicy extends ProjectPolicy {
  readonly project: string;
  readonly reason: string | null;
  readonly updatedAt: Date | null;
  readonly updatedBy: { readonly id: string; readonly username: string } | null;
}

export interface PutPolicyInput {
  readonly rules: unknown;
  /** Version the editor started from (0 when no policy exists yet). */
  readonly expectedVersion: number;
  readonly reason?: string;
}

/** Roles that may read or change a project's approval policy. */
const POLICY_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin']);

export function cleanText(s: string | undefined | null, max: number): string | null {
  if (s === undefined || s === null) return null;
  const cleaned = s.replaceAll('\u0000', '').trim();
  if (cleaned === '') return null;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export function stepUpFresh(mfaAt: Date | null, now: Date, maxAgeMs = DEFAULT_STEP_UP_WINDOW_MS): boolean {
  return mfaAt !== null && now.getTime() - mfaAt.getTime() <= maxAgeMs && mfaAt <= now;
}

interface PolicyRow {
  project: string;
  version: number;
  rules: unknown;
  reason: string | null;
  created_at: Date;
  created_by: string;
  username: string | null;
}

/**
 * Loads the current project policy. Stored rules are re-validated; a row that no longer parses is an error
 * (fail closed) rather than a silent fallback to platform defaults, which could undo a project's
 * tightening.
 */
export async function loadProjectPolicy(db: Queryable, project: string): Promise<StoredProjectPolicy> {
  const { rows } = await db.query<PolicyRow>(
    `SELECT p.project, p.version, p.rules, p.reason, p.created_at, p.created_by, u.username
       FROM project_policies p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.project = $1 ORDER BY p.version DESC LIMIT 1`,
    [project],
  );
  const row = rows[0];
  if (!row) {
    return { project, version: 0, rules: {}, reason: null, updatedAt: null, updatedBy: null };
  }
  const parsed = ProjectPolicyRules.safeParse(row.rules);
  if (!parsed.success) {
    throw new Error(`stored policy ${project} v${String(row.version)} does not validate`);
  }
  return {
    project: row.project,
    version: row.version,
    rules: parsed.data,
    reason: row.reason,
    updatedAt: row.created_at,
    updatedBy: { id: row.created_by, username: row.username ?? '(deleted)' },
  };
}

/**
 * Versioned per-project approval policy (`project_policies`, append-only). Only owners/admins with a fresh
 * step-up can write; a rule weaker than the platform floor is rejected. There is deliberately no code path
 * that reads policy from repository content (ADR-0010).
 */
export class ProjectPolicyStore {
  private readonly pool: pg.Pool;
  private readonly audit: AuditRecorder;
  private readonly clock: () => Date;

  constructor(deps: { pool: pg.Pool; audit: AuditRecorder; clock?: () => Date }) {
    this.pool = deps.pool;
    this.audit = deps.audit;
    this.clock = deps.clock ?? (() => new Date());
  }

  async get(project: string, user: HumanActor): Promise<StoredProjectPolicy> {
    this.checkProject(project);
    if (!POLICY_ROLES.has(user.role)) throw new ApprovalForbiddenError('role');
    return loadProjectPolicy(this.pool, project);
  }

  async put(
    project: string,
    input: PutPolicyInput,
    user: HumanActor,
    meta: RequestMeta = {},
  ): Promise<StoredProjectPolicy> {
    try {
      this.checkProject(project);
      if (!POLICY_ROLES.has(user.role)) throw new ApprovalForbiddenError('role');
      const now = this.clock();
      if (!stepUpFresh(user.mfaAt, now, user.stepUpMaxAgeMs)) throw new StepUpRequiredError();
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
        throw new InvalidApprovalInputError([{ path: 'expectedVersion', code: 'invalid' }]);
      }
      const parsed = ProjectPolicyRules.safeParse(input.rules);
      if (!parsed.success) {
        throw new InvalidApprovalInputError(
          parsed.error.issues.map((i) => ({
            path: ['rules', ...i.path.map(String)].join('.'),
            code: i.code,
          })),
        );
      }
      const violations = checkProjectRules(parsed.data);
      if (violations.length > 0) throw new PolicyBelowFloorError(violations);
      const reason = cleanText(input.reason, MAX_REASON);

      return await withTransaction(this.pool, async (tx) => {
        // Serialise writers per project so the version check below cannot race.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 5))', [`policy:${project}`]);
        const current = await loadProjectPolicy(tx, project);
        if (current.version !== input.expectedVersion) {
          throw new PolicyVersionConflictError(project, input.expectedVersion, current.version);
        }
        const version = current.version + 1;
        await tx.query(
          `INSERT INTO project_policies (project, version, rules, reason, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [project, version, JSON.stringify(parsed.data), reason, user.id, now],
        );
        await this.audit.record(
          {
            actor: { type: 'user', id: user.id },
            action: 'policy.update',
            target: `project:${project}`,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: {
              project,
              version,
              previousVersion: current.version,
              actions: Object.keys(parsed.data).sort(),
              ...(reason === null ? {} : { reason }),
            },
          },
          tx,
        );
        return loadProjectPolicy(tx, project);
      });
    } catch (err) {
      if (err instanceof ApprovalError) {
        await this.audit.record({
          actor: { type: 'user', id: user.id },
          action: 'policy.update',
          target: `project:${project.slice(0, 128)}`,
          outcome: 'denied',
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: {
            code: err.code,
            ...(err instanceof PolicyBelowFloorError
              ? { violations: err.violations.map((v) => `${v.action}.${v.field}`) }
              : {}),
          },
        });
      }
      throw err;
    }
  }

  private checkProject(project: string): void {
    if (!PROJECT_ID.test(project)) {
      throw new InvalidApprovalInputError([{ path: 'project', code: 'invalid_format' }]);
    }
  }
}
