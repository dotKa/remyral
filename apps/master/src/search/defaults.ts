import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';

/**
 * p10-semantic-defaults-chat (docs/design/p10-semantic-memory.md §12): project knowledge is on by default.
 *
 * - A platform default (one row, admin-editable): new projects get search capture on and memory suggestions `rules`.
 * - The create-project form (and `POST /projects`) can switch either off; the choice is written as the project's
 *   setting with provenance `create` — an unchecked box is an explicit "off" that later backfills never touch.
 * - A one-time backfill (run by the master at start, recorded in `backfilled_at`) turns them on for existing projects
 *   that never made a choice (no row), and for the `global` namespace, with provenance `platform_default` and one
 *   audit entry per project. A project whose admin had set capture or memory off keeps it off.
 * - Changing a project's choice later goes through the existing admin + step-up routes (provenance `explicit`).
 */

export type MemoryMode = 'off' | 'rules' | 'assisted';
export type SettingSource = 'explicit' | 'create' | 'platform_default';

export interface SemanticDefaults {
  readonly projectCapture: boolean;
  readonly memoryMode: MemoryMode;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly backfilledAt: Date | null;
}

/** What a new project gets (the form's checkboxes; undefined = the platform default). */
export interface ProjectKnowledgeChoice {
  readonly searchCapture?: boolean | undefined;
  readonly memorySuggestions?: boolean | undefined;
}

export interface AppliedKnowledge {
  readonly searchCapture: boolean;
  readonly memoryMode: MemoryMode;
}

export interface BackfillStats {
  readonly ran: boolean;
  readonly projects: number;
  readonly captureOn: number;
  readonly memoryOn: number;
  readonly global: boolean;
}

/** Provenance text of the backfill's audit entries. */
export const PLATFORM_DEFAULT = 'platform default';

interface Row {
  project_capture: boolean;
  memory_mode: MemoryMode;
  version: number;
  updated_at: Date;
  updated_by: string | null;
  backfilled_at: Date | null;
}

export class SemanticDefaultsService {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock?: () => Date;
    },
  ) {}

  #now(): Date {
    return (this.deps.clock ?? (() => new Date()))();
  }

  async get(db: Queryable = this.deps.pool): Promise<SemanticDefaults> {
    const { rows } = await db.query<Row>(
      `SELECT project_capture, memory_mode, version, updated_at, updated_by::text AS updated_by, backfilled_at
         FROM semantic_defaults WHERE id = 1`,
    );
    const r = rows[0];
    if (r === undefined) throw new Error('semantic_defaults row missing (migration 0081)');
    return {
      projectCapture: r.project_capture,
      memoryMode: r.memory_mode,
      version: r.version,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
      backfilledAt: r.backfilled_at,
    };
  }

  /** Settings → Context → "Defaults for new projects" (admin+, step-up on the route, optimistic, audited). */
  async put(
    actor: { readonly id: string; readonly ip?: string | null; readonly userAgent?: string | null },
    input: {
      readonly projectCapture: boolean;
      readonly memoryMode: MemoryMode;
      readonly expectedVersion: number;
    },
  ): Promise<SemanticDefaults> {
    return withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT 1 FROM semantic_defaults WHERE id = 1 FOR UPDATE');
      const before = await this.get(tx);
      if (before.version !== input.expectedVersion) {
        throw new HttpError(
          409,
          'version_conflict',
          'The defaults changed meanwhile. Reload and try again.',
          {},
          {},
          { reason: 'defaults' },
        );
      }
      await tx.query(
        `UPDATE semantic_defaults SET project_capture = $1, memory_mode = $2, version = version + 1,
                updated_at = $3, updated_by = $4 WHERE id = 1`,
        [input.projectCapture, input.memoryMode, this.#now(), actor.id],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'context.defaults.update',
          target: 'semantic-defaults',
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: {
            before: { projectCapture: before.projectCapture, memoryMode: before.memoryMode },
            after: { projectCapture: input.projectCapture, memoryMode: input.memoryMode },
          },
        },
        tx,
      );
      return this.get(tx);
    });
  }

  /**
   * The knowledge settings of a project being created (inside the project's insert transaction). Both are written
   * as rows with provenance `create`, on or off, so the choice is explicit and sticky.
   */
  async applyOnCreate(
    tx: Queryable,
    project: string,
    choice: ProjectKnowledgeChoice,
    actorId: string,
  ): Promise<AppliedKnowledge> {
    const d = await this.get(tx);
    const capture = choice.searchCapture ?? d.projectCapture;
    const onMode: MemoryMode = d.memoryMode === 'off' ? 'rules' : d.memoryMode;
    const memoryMode: MemoryMode =
      choice.memorySuggestions === undefined ? d.memoryMode : choice.memorySuggestions ? onMode : 'off';
    const now = this.#now();
    await tx.query(
      `INSERT INTO search_consent (namespace, enabled, version, updated_at, updated_by, source)
       VALUES ($1, $2, 1, $3, $4, 'create') ON CONFLICT (namespace) DO NOTHING`,
      [`project:${project}`, capture, now, actorId],
    );
    await tx.query(
      `INSERT INTO memory_suggestion_settings (project, mode, version, enabled_at, updated_at, updated_by, source)
       VALUES ($1, $2, 1, CASE WHEN $2 = 'off' THEN NULL ELSE $3::timestamptz END, $3, $4, 'create')
       ON CONFLICT (project) DO NOTHING`,
      [project, memoryMode, now, actorId],
    );
    return { searchCapture: capture, memoryMode };
  }

  /**
   * One-time backfill (idempotent: the first run marks `backfilled_at`, later runs do nothing). Projects without a
   * capture row get capture on, projects without a memory row get the default mode — both with provenance
   * `platform_default` and one audit entry per project (actor: system). `global` gets capture on when it has no row.
   * Explicit choices (rows) are never touched.
   */
  async backfill(): Promise<BackfillStats> {
    return withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT 1 FROM semantic_defaults WHERE id = 1 FOR UPDATE');
      const d = await this.get(tx);
      if (d.backfilledAt !== null)
        return { ran: false, projects: 0, captureOn: 0, memoryOn: 0, global: false };
      const now = this.#now();
      const { rows: projects } = await tx.query<{ id: string; has_consent: boolean; has_memory: boolean }>(
        `SELECT p.id,
                EXISTS (SELECT 1 FROM search_consent c WHERE c.namespace = 'project:' || p.id) AS has_consent,
                EXISTS (SELECT 1 FROM memory_suggestion_settings m WHERE m.project = p.id) AS has_memory
           FROM projects p ORDER BY p.id`,
      );
      let touched = 0;
      let captureOn = 0;
      let memoryOn = 0;
      for (const p of projects) {
        const capture = d.projectCapture && !p.has_consent;
        const memory = d.memoryMode !== 'off' && !p.has_memory;
        if (!capture && !memory) continue;
        if (capture) {
          await tx.query(
            `INSERT INTO search_consent (namespace, enabled, version, updated_at, updated_by, source)
             VALUES ($1, true, 1, $2, NULL, 'platform_default') ON CONFLICT (namespace) DO NOTHING`,
            [`project:${p.id}`, now],
          );
          captureOn += 1;
        }
        if (memory) {
          await tx.query(
            `INSERT INTO memory_suggestion_settings (project, mode, version, enabled_at, updated_at, updated_by, source)
             VALUES ($1, $2, 1, $3, $3, NULL, 'platform_default') ON CONFLICT (project) DO NOTHING`,
            [p.id, d.memoryMode, now],
          );
          memoryOn += 1;
        }
        touched += 1;
        await this.deps.audit.record(
          {
            actor: { type: 'system', id: 'semantic-defaults' },
            action: 'context.defaults.applied',
            target: `project:${p.id}`,
            outcome: 'success',
            metadata: {
              project: p.id,
              provenance: PLATFORM_DEFAULT,
              searchCapture: capture ? 'on' : 'kept (explicit choice)',
              memorySuggestions: memory ? d.memoryMode : 'kept (explicit choice)',
            },
          },
          tx,
        );
      }
      let global = false;
      if (d.projectCapture) {
        const res = await tx.query(
          `INSERT INTO search_consent (namespace, enabled, version, updated_at, updated_by, source)
           VALUES ('global', true, 1, $1, NULL, 'platform_default') ON CONFLICT (namespace) DO NOTHING`,
          [now],
        );
        global = (res.rowCount ?? 0) > 0;
        if (global) {
          await this.deps.audit.record(
            {
              actor: { type: 'system', id: 'semantic-defaults' },
              action: 'context.defaults.applied',
              target: 'search-consent:global',
              outcome: 'success',
              metadata: { namespace: 'global', provenance: PLATFORM_DEFAULT, searchCapture: 'on' },
            },
            tx,
          );
        }
      }
      await tx.query('UPDATE semantic_defaults SET backfilled_at = $1 WHERE id = 1', [now]);
      return { ran: true, projects: touched, captureOn, memoryOn, global };
    });
  }
}
