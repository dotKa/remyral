import type { RuntimeKind } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool, Queryable } from '../db/pool.js';
import { defaultSettings, type VerifyMode, type VerifySettings, type VerifySettingsInput } from './model.js';

/**
 * p10-verify-health: a project's verification and post-deploy health settings (`project_verify_settings`; no row =
 * defaults). Written only by project admins through `PUT /projects/:id/verify-settings` (route: deploy.targets.write +
 * step-up), audited with the full new value (no secrets: the test command is a command line the admin typed).
 */

interface Row {
  project: string;
  verify_default: VerifyMode;
  verify_runtime: RuntimeKind | null;
  test_command: string | null;
  health_after_deploy: boolean;
  health_screenshots: boolean;
  health_keyword: string | null;
  auto_rollback: boolean;
  auto_rollback_production: boolean;
  updated_by: string | null;
  updated_at: Date;
}

function view(r: Row): VerifySettings {
  return {
    project: r.project,
    verifyDefault: r.verify_default,
    verifyRuntime: r.verify_runtime,
    testCommand: r.test_command,
    healthAfterDeploy: r.health_after_deploy,
    healthScreenshots: r.health_screenshots,
    healthKeyword: r.health_keyword,
    autoRollback: r.auto_rollback,
    autoRollbackProduction: r.auto_rollback_production,
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by,
  };
}

export class VerifySettingsStore {
  constructor(
    private readonly deps: { readonly pool: Pool; readonly audit: AuditRecorder; readonly clock: () => Date },
  ) {}

  async get(project: string, db: Queryable = this.deps.pool): Promise<VerifySettings> {
    const { rows } = await db.query<Row>(
      `SELECT project, verify_default, verify_runtime, test_command, health_after_deploy, health_screenshots,
              health_keyword, auto_rollback, auto_rollback_production, updated_by::text AS updated_by, updated_at
         FROM project_verify_settings WHERE project = $1`,
      [project],
    );
    const r = rows[0];
    return r === undefined ? defaultSettings(project) : view(r);
  }

  async put(
    project: string,
    input: VerifySettingsInput,
    actor: { readonly userId: string; readonly ip?: string | null; readonly userAgent?: string | null },
  ): Promise<VerifySettings> {
    const before = await this.get(project);
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<Row>(
      `INSERT INTO project_verify_settings (project, verify_default, verify_runtime, test_command, health_after_deploy,
         health_screenshots, health_keyword, auto_rollback, auto_rollback_production, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (project) DO UPDATE SET verify_default = EXCLUDED.verify_default,
         verify_runtime = EXCLUDED.verify_runtime, test_command = EXCLUDED.test_command,
         health_after_deploy = EXCLUDED.health_after_deploy, health_screenshots = EXCLUDED.health_screenshots,
         health_keyword = EXCLUDED.health_keyword, auto_rollback = EXCLUDED.auto_rollback,
         auto_rollback_production = EXCLUDED.auto_rollback_production, updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at
       RETURNING project, verify_default, verify_runtime, test_command, health_after_deploy, health_screenshots,
                 health_keyword, auto_rollback, auto_rollback_production, updated_by::text AS updated_by, updated_at`,
      [
        project,
        input.verifyDefault,
        input.verifyRuntime,
        input.testCommand,
        input.healthAfterDeploy,
        input.healthScreenshots,
        input.healthKeyword,
        input.autoRollback,
        input.autoRollbackProduction,
        actor.userId,
        now,
      ],
    );
    const after = view(rows[0] as Row);
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'verify.settings.update',
      target: `project:${project}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        before: { ...before, updatedAt: undefined, updatedBy: undefined },
        after: { ...after, updatedAt: undefined, updatedBy: undefined },
      },
    });
    return after;
  }
}
