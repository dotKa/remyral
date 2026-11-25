import { randomUUID } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import type { DraftRecord } from './store.js';
import { machinePolicyCard } from './drafts.js';

/**
 * p20-scope-preview (docs/design/p20-scope-preview.md §2): the goal-bound grant
 * ("Hedefe bağlı yetki", security policy `autonomy.goalGrants`).
 *
 * What the user's OWN chat message ran directly (trigger `default` / `execute`, a person's session attached) is recorded
 * as a scope entry: the operation type ({@link GoalScope.cls}), the machine and the project, whether it ran machine
 * administration by policy (`chatMachineAdmin`), and until when it holds ({@link GOAL_GRANT_TTL_MS}). A system-written
 * continuation turn of the SAME conversation and user — an approved autonomous plan, a watch follow-up — inherits the
 * user turn's direct run (and, for machine administration, `chatMachineAdmin`) only for a draft inside one of those
 * entries. Revocable: the policy switch (read on every use), {@link GoalGrants.revoke} (the conversation's grants,
 * `DELETE /chat/threads/:id/goal-grants`), and — since only continuation turns read them — cancelling the plan / watch.
 *
 * What it never changes: the security policy's code rules (no person is present in a continuation turn, so a step that
 * needs a fresh authenticator code stays a card), the user's role, the machine's own machine-admin switch (local veto),
 * cards that are always cards (`cardOnly`, alwaysCard tools, confirm-only tools).
 */

/** How long a user turn's direct run counts for the continuations of its goal. */
export const GOAL_GRANT_TTL_MS = 6 * 3600_000;

/** The scope of one draft: the operation type and where it acts. */
export interface GoalScope {
  /** `machine_admin`, `service.run`, `service.stop`, `settings:<target>:<op>`, or the draft kind. */
  readonly cls: string;
  readonly project: string | null;
  readonly workerId: string | null;
}

/** A recorded entry (one directly-run draft of a user turn). */
export interface GoalGrantRow extends GoalScope {
  readonly id: string;
  readonly machineAdmin: boolean;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** The entry a continuation draft inherits from. */
export type GoalGrantMatch = GoalGrantRow;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * The scope of a draft. Machine administration (a machine task, an elevated tool install, the sandbox prepare) is ONE
 * operation type per machine; a service start and restart are one (bringing a service up), its stop another; a settings
 * change is its target + op; every other draft its kind. Null: a draft that has no scope (never inherited).
 */
export function goalScopeOf(d: Pick<DraftRecord, 'kind' | 'payload' | 'project'>): GoalScope | null {
  const p = d.payload;
  if (machinePolicyCard(d)) {
    const workerId = str(p.workerId);
    return workerId === null ? null : { cls: 'machine_admin', project: d.project, workerId };
  }
  if (d.kind === 'service_action') {
    const op = str(p.op);
    if (op === null) return null;
    return {
      cls: op === 'stop' ? 'service.stop' : 'service.run',
      project: str(p.project) ?? d.project,
      workerId: str(p.worker) ?? str(p.workerId),
    };
  }
  if (d.kind === 'settings_change') {
    const target = str(p.target) ?? 'unknown';
    const op = str(p.op);
    const cls = `settings:${target}${op === null ? '' : `:${op}`}`
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]/g, '_')
      .slice(0, 80);
    return { cls, project: d.project, workerId: str(p.workerId) };
  }
  return { cls: d.kind, project: d.project, workerId: str(p.workerId) };
}

/**
 * Whether `entry` covers `scope`: the same operation type and project, and the same machine when both name one (a
 * machine administration entry always names its machine, so another machine is never covered).
 */
export function covers(entry: GoalScope, scope: GoalScope): boolean {
  if (entry.cls !== scope.cls) return false;
  if ((entry.project ?? null) !== (scope.project ?? null)) return false;
  if (scope.cls === 'machine_admin') return entry.workerId !== null && entry.workerId === scope.workerId;
  if (entry.workerId !== null && scope.workerId !== null) return entry.workerId === scope.workerId;
  return true;
}

/**
 * The entry a continuation draft inherits from (the newest unexpired one that covers it), or null. Machine
 * administration needs an entry that itself ran by `chatMachineAdmin`.
 */
export function matchGrant(
  rows: readonly GoalGrantRow[],
  scope: GoalScope,
  now: Date,
): GoalGrantMatch | null {
  let best: GoalGrantRow | null = null;
  for (const r of rows) {
    if (r.expiresAt.getTime() <= now.getTime()) continue;
    if (!covers(r, scope)) continue;
    if (scope.cls === 'machine_admin' && !r.machineAdmin) continue;
    if (best === null || r.createdAt.getTime() > best.createdAt.getTime()) best = r;
  }
  return best;
}

/** A short English description of a scope (the model's tool result and the audit). */
export function describeScope(s: GoalScope): string {
  const where = [
    s.workerId === null ? null : `machine ${s.workerId}`,
    s.project === null ? null : `project ${s.project}`,
  ]
    .filter((x): x is string => x !== null)
    .join(', ');
  return where === '' ? s.cls : `${s.cls} on ${where}`;
}

export interface GoalGrantsDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
}

interface Row {
  id: string;
  scope_class: string;
  project: string | null;
  worker_id: string | null;
  machine_admin: boolean;
  created_at: Date;
  expires_at: Date;
}

export class GoalGrants {
  constructor(private readonly deps: GoalGrantsDeps) {}

  /** Records the scope of a draft the user's own turn ran directly (no-op for a draft without a scope). */
  async record(input: {
    readonly userId: string;
    readonly threadId: string;
    readonly draft: Pick<DraftRecord, 'id' | 'kind' | 'payload' | 'project'>;
    readonly machineAdmin: boolean;
  }): Promise<string | null> {
    const scope = goalScopeOf(input.draft);
    if (scope === null) return null;
    const now = this.deps.clock();
    const id = randomUUID();
    await this.deps.pool.query(
      `INSERT INTO chat_goal_grants
         (id, thread_id, user_id, scope_class, project, worker_id, machine_admin, draft_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        input.threadId,
        input.userId,
        scope.cls,
        scope.project,
        scope.workerId,
        input.machineAdmin,
        input.draft.id,
        now,
        new Date(now.getTime() + GOAL_GRANT_TTL_MS),
      ],
    );
    return id;
  }

  /** The live entries of a conversation (unrevoked, unexpired), newest first. */
  async live(userId: string, threadId: string): Promise<GoalGrantRow[]> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT id::text AS id, scope_class, project, worker_id, machine_admin, created_at, expires_at
         FROM chat_goal_grants
        WHERE thread_id::text = $1 AND user_id::text = $2 AND revoked_at IS NULL AND expires_at > $3
        ORDER BY created_at DESC LIMIT 50`,
      [threadId, userId, this.deps.clock()],
    );
    return rows.map((r) => ({
      id: r.id,
      cls: r.scope_class,
      project: r.project,
      workerId: r.worker_id,
      machineAdmin: r.machine_admin,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
  }

  /** The entry a continuation draft of this conversation inherits from, or null. */
  async match(
    userId: string,
    threadId: string,
    draft: Pick<DraftRecord, 'kind' | 'payload' | 'project'>,
  ): Promise<GoalGrantMatch | null> {
    const scope = goalScopeOf(draft);
    if (scope === null) return null;
    return matchGrant(await this.live(userId, threadId), scope, this.deps.clock());
  }

  /** Revokes every live grant of the conversation (audited); returns how many. */
  async revoke(
    actor: { readonly userId: string; readonly ip: string | null; readonly userAgent: string | null },
    threadId: string,
  ): Promise<number> {
    const now = this.deps.clock();
    const res = await this.deps.pool.query(
      `UPDATE chat_goal_grants SET revoked_at = $3
        WHERE thread_id::text = $1 AND user_id::text = $2 AND revoked_at IS NULL AND expires_at > $3`,
      [threadId, actor.userId, now],
    );
    const n = res.rowCount ?? 0;
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'chat.goal_grant.revoke',
      target: `chat-thread:${threadId}`,
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { revoked: n },
    });
    return n;
  }
}
