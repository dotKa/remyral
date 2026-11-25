import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';

/**
 * p16-selfhost-onboarding §5: the owners' first-run wizard of a fresh install (Diyalog `/onboarding`). The server keeps
 * the progress so the wizard is resumable on any device: the owner's explicit marks per step (done / skipped) and the
 * organisation name. Whether a machine, a git connection, a project or a succeeded job exists is DERIVED at read time
 * (`detected`), so a step done elsewhere in the console counts without a click here. Shown to owners until completed;
 * an installation that already had accounts when migration 0148 ran is recorded as completed.
 */

export const ONBOARDING_STEPS = [
  'account',
  // p17-memory-import: "Seni tanıyalım" — import what the owner's own AI assistant knows about them (optional).
  'about_you',
  'organisation',
  // p17-remyral-brand: the public address, TLS and access (read-only, self-hosted guidance).
  'domain',
  'security',
  'machine',
  'git',
  'integrations',
  'project',
  'sample_job',
  'done',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type StepMark = 'done' | 'skipped';
export type StepState = 'todo' | StepMark;

export interface OnboardingStepView {
  readonly id: OnboardingStep;
  readonly state: StepState;
  /** The fact behind the step exists (an enrolled authenticator, an approved machine, …). */
  readonly detected: boolean;
}

export interface OnboardingView {
  /** The wizard is shown to this caller (an owner, not completed). */
  readonly visible: boolean;
  readonly completedAt: string | null;
  readonly organisationName: string | null;
  readonly steps: readonly OnboardingStepView[];
  /** Steps done or skipped, of all steps but the final one. */
  readonly progress: { readonly done: number; readonly total: number };
  /** The first step still to do (resume point); `done` when nothing is left. */
  readonly current: OnboardingStep;
}

export class OnboardingError extends Error {
  override name = 'OnboardingError';
  constructor(
    readonly code: 'invalid_organisation_name' | 'unknown_step',
    message: string,
  ) {
    super(message);
  }
}

interface Row {
  organisation_name: string | null;
  steps: Record<string, unknown>;
  completed_at: Date | null;
}

interface Facts {
  totp: boolean;
  machines: number;
  git: number;
  projects: number;
  succeeded: number;
  imports: number;
}

/** Plain text, one line, 1–80 characters (no control characters). */
export function normaliseOrganisationName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (n.length < 1 || n.length > 80 || /[\u0000-\u001f\u007f]/.test(n)) {
    throw new OnboardingError(
      'invalid_organisation_name',
      'The organisation name must be 1-80 characters of plain text.',
    );
  }
  return n;
}

export class OnboardingService {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  private async row(): Promise<Row | null> {
    const { rows } = await this.deps.pool.query<Row>(
      'SELECT organisation_name, steps, completed_at FROM onboarding_state WHERE id = 1',
    );
    return rows[0] ?? null;
  }

  private async facts(userId: string): Promise<Facts> {
    const { rows } = await this.deps.pool.query<{
      totp: boolean | null;
      machines: string;
      git: string;
      projects: string;
      succeeded: string;
      imports: string;
    }>(
      `SELECT (SELECT totp_enabled FROM users WHERE id = $1) AS totp,
              (SELECT count(*) FROM workers
                WHERE approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL)::text AS machines,
              ((SELECT count(*) FROM github_app_connection) + (SELECT count(*) FROM git_host_connections))::text AS git,
              -- Created by someone: the seeded workspaces (genel, machines) do not count.
              (SELECT count(*) FROM projects WHERE created_by IS NOT NULL)::text AS projects,
              (SELECT count(*) FROM (SELECT 1 FROM jobs WHERE state = 'SUCCEEDED' LIMIT 1) s)::text AS succeeded,
              -- p17-memory-import: an import of the caller's that imported something and was not undone.
              (SELECT count(*) FROM memory_imports
                WHERE user_id = $1 AND undone_at IS NULL AND items_imported > 0)::text AS imports`,
      [userId],
    );
    const r = rows[0];
    return {
      totp: r?.totp === true,
      machines: Number(r?.machines ?? 0),
      git: Number(r?.git ?? 0),
      projects: Number(r?.projects ?? 0),
      succeeded: Number(r?.succeeded ?? 0),
      imports: Number(r?.imports ?? 0),
    };
  }

  async view(subject: { userId: string; role: string }): Promise<OnboardingView> {
    const [row, facts] = await Promise.all([this.row(), this.facts(subject.userId)]);
    const marks = row?.steps ?? {};
    const detected: Record<OnboardingStep, boolean> = {
      account: facts.totp,
      about_you: facts.imports > 0,
      organisation: (row?.organisation_name ?? null) !== null,
      // Read-only facts the owner reviews; nothing to detect.
      domain: false,
      security: false,
      machine: facts.machines > 0,
      git: facts.git > 0,
      integrations: false,
      project: facts.projects > 0,
      sample_job: facts.succeeded > 0,
      done: row?.completed_at != null,
    };
    const steps = ONBOARDING_STEPS.map((id): OnboardingStepView => {
      const mark = marks[id];
      const state: StepState = mark === 'done' || mark === 'skipped' ? mark : detected[id] ? 'done' : 'todo';
      return { id, state, detected: detected[id] };
    });
    const counted = steps.filter((s) => s.id !== 'done');
    const current = counted.find((s) => s.state === 'todo')?.id ?? 'done';
    return {
      visible: subject.role === 'owner' && row?.completed_at == null,
      completedAt: row?.completed_at?.toISOString() ?? null,
      organisationName: row?.organisation_name ?? null,
      steps,
      progress: { done: counted.filter((s) => s.state !== 'todo').length, total: counted.length },
      current,
    };
  }

  private async upsert(
    userId: string,
    action: string,
    metadata: Record<string, unknown>,
    change: { sql: string; params: readonly unknown[] },
  ): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `INSERT INTO onboarding_state (id, updated_at, updated_by) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`,
        [this.now(), userId],
      );
      await tx.query(change.sql, [this.now(), userId, ...change.params]);
      await this.deps.audit.record(
        { actor: { type: 'user', id: userId }, action, target: 'onboarding', outcome: 'success', metadata },
        tx,
      );
    });
  }

  async setOrganisation(userId: string, name: string): Promise<void> {
    const n = normaliseOrganisationName(name);
    await this.upsert(
      userId,
      'onboarding.organisation',
      { name: n },
      {
        sql: `UPDATE onboarding_state SET organisation_name = $3,
                     steps = steps || '{"organisation": "done"}'::jsonb, updated_at = $1, updated_by = $2
               WHERE id = 1`,
        params: [n],
      },
    );
  }

  async markStep(userId: string, step: string, state: StepState): Promise<void> {
    if (!(ONBOARDING_STEPS as readonly string[]).includes(step) || step === 'done') {
      throw new OnboardingError('unknown_step', 'The wizard has no such step.');
    }
    await this.upsert(
      userId,
      'onboarding.step',
      { step, state },
      state === 'todo'
        ? {
            sql: 'UPDATE onboarding_state SET steps = steps - $3::text, updated_at = $1, updated_by = $2 WHERE id = 1',
            params: [step],
          }
        : {
            sql: `UPDATE onboarding_state SET steps = steps || jsonb_build_object($3::text, $4::text),
                         updated_at = $1, updated_by = $2 WHERE id = 1`,
            params: [step, state],
          },
    );
  }

  async complete(userId: string): Promise<void> {
    await this.upsert(
      userId,
      'onboarding.complete',
      {},
      {
        sql: `UPDATE onboarding_state SET completed_at = COALESCE(completed_at, $1), completed_by = COALESCE(completed_by, $2),
                     updated_at = $1, updated_by = $2 WHERE id = 1`,
        params: [],
      },
    );
  }

  async reopen(userId: string): Promise<void> {
    await this.upsert(
      userId,
      'onboarding.reopen',
      {},
      {
        sql: `UPDATE onboarding_state SET completed_at = NULL, completed_by = NULL, updated_at = $1, updated_by = $2
               WHERE id = 1`,
        params: [],
      },
    );
  }
}
