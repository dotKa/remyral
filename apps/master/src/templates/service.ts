import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { AuditRecorder } from '../audit/audit.js';
import { authorize, type Subject, visibleProjects } from '../authz/model.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { unifiedDiff } from '../skills/diff.js';
import { projectKind } from '../workspaces/service.js';
import {
  MAX_TEMPLATE_PROMPT,
  type TemplateDefaults,
  TemplateDefaults as TemplateDefaultsSchema,
  TemplateError,
  type TemplateInput,
  type TemplatePatch,
  type TemplateSource,
  type TemplateStats,
  type TemplateVersionView,
  type TemplateView,
  UUID,
} from './model.js';
import {
  candidateParameters,
  type ParamType,
  parseTemplate,
  renderPrompt,
  type TemplateIssue,
  type TemplateParameter,
  TemplateParameter as TemplateParameterSchema,
  validateValues,
} from './params.js';
import { type SourceItem, suggest, type Suggestion, titleOf } from './similarity.js';

/**
 * p8-templates (docs/design/p8-templates.md): parameterised job templates — CRUD with immutable versions, rendering,
 * run attribution and usage stats, and the per-user suggestions of recurring prompts. Authorization: reading needs
 * `templates.read` in the template's project (a global template is visible to every signed-in user); changing a
 * project template needs `templates.write` there, a global one `templates.global` (admin). Every write is audited.
 */

export interface TemplateActor {
  readonly id: string;
  readonly subject: Subject;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface TemplateServiceDeps {
  readonly pool: pg.Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
}

interface TemplateRow {
  id: string;
  project: string | null;
  title: string;
  description: string;
  tags: string[];
  state: 'active' | 'archived';
  current_version: number;
  owner_id: string | null;
  owner_username: string | null;
  source: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  prompt: string;
  parameters: TemplateParameter[];
  defaults: TemplateDefaults;
  change_note: string | null;
  created_by: string | null;
  version_created_at: Date;
  /** p18-multi-project W4 (migration 0185): the projects it is shared to ('*' = every project). */
  shared_to: string[];
  /** Hidden in the listed project (only with a project filter). */
  hidden_here?: boolean;
}

/** The template + current version; `extra` adds select columns (the list's hidden flag). */
const selectWith = (
  extra = '',
): string => `SELECT t.id, t.project, t.title, t.description, t.tags, t.state, t.current_version, t.owner_id,
       u.username AS owner_username, t.source, t.created_at, t.updated_at,
       v.prompt, v.parameters, v.defaults, v.change_note, v.created_by, v.created_at AS version_created_at,
       ARRAY(SELECT sh.project FROM job_template_shares sh WHERE sh.template_id = t.id ORDER BY sh.project)
         AS shared_to${extra}
  FROM job_templates t
  JOIN job_template_versions v ON v.template_id = t.id AND v.version = t.current_version
  LEFT JOIN users u ON u.id = t.owner_id`;
const SELECT = selectWith();

const EMPTY_STATS: TemplateStats = {
  runs: 0,
  finished: 0,
  succeeded: 0,
  successRate: null,
  avgCostUsd: null,
  avgDurationSec: null,
  lastRunAt: null,
  automations: 0,
};

export interface RenderedTemplate {
  readonly template: TemplateView;
  readonly version: number;
  readonly prompt: string;
  readonly values: Record<string, string | number | boolean>;
  readonly defaults: TemplateDefaults;
  /** Values of `file` parameters (chat attachment ids or input file names). */
  readonly files: readonly string[];
}

/** One template version's settings a job spec takes (the parameters never reach these). */
export function specFromDefaults(
  project: string,
  defaults: TemplateDefaults,
  prompt: string,
): Record<string, unknown> {
  const limits = defaults.limits ?? {};
  return {
    projectId: project,
    runtime: defaults.runtime,
    ...(defaults.modelProfile === undefined ? {} : { model: defaults.modelProfile }),
    prompt,
    ...(defaults.sandboxProfile === undefined ? {} : { sandboxProfile: defaults.sandboxProfile }),
    ...(defaults.approvalPolicy === undefined ? {} : { approvalPolicy: defaults.approvalPolicy }),
    limits: { ...limits },
  };
}

/**
 * The job spec of a template run in `project` (automations, REST): the template's settings, the project's registered
 * repository for a repository project (trusted, like the composer), a fresh work branch. The project's defaults fill
 * the rest where the caller applies them (automations: AutomationService.withDefaults).
 */
export async function jobSpecForProject(
  db: Queryable,
  project: string,
  defaults: TemplateDefaults,
  prompt: string,
): Promise<Record<string, unknown>> {
  const base = { ...specFromDefaults(project, defaults, prompt), sourceTrust: 'trusted' };
  if ((await projectKind(db, project)) === 'workspace') return base;
  const { rows } = await db.query<{ repository_url: string; base_branch: string }>(
    'SELECT repository_url, base_branch FROM project_git_configs WHERE project = $1',
    [project],
  );
  const git = rows[0];
  if (git === undefined) {
    throw new TemplateError(
      400,
      'no_repository',
      `Project ${project} has no repository configured; an administrator sets it in Projects → Git.`,
    );
  }
  return {
    ...base,
    repository: {
      url: git.repository_url,
      baseRef: defaults.baseRef ?? git.base_branch,
      workBranch: `agent/tpl-${randomUUID().slice(0, 8)}`,
    },
  };
}

export class TemplateService {
  constructor(private readonly deps: TemplateServiceDeps) {}

  // ----------------------------------------------------------------------------------------- reading

  /** The template's project (null = global), or undefined when it does not exist (authorization resolver). */
  async projectOf(id: string): Promise<string | null | undefined> {
    if (!UUID.test(id)) return undefined;
    const { rows } = await this.deps.pool.query<{ project: string | null }>(
      'SELECT project FROM job_templates WHERE id = $1',
      [id],
    );
    return rows.length === 0 ? undefined : (rows[0]?.project ?? null);
  }

  /** The caller reads the template's own project (or it is global). */
  #readable(s: Subject, project: string | null): boolean {
    return project === null || authorize(s, 'templates.read', { project }).allow;
  }

  /**
   * p18-multi-project W4: visible = global, readable in its own project, or shared to a project the caller reads
   * ('*': to anyone who reads a project).
   */
  #visible(
    s: Subject,
    r: { readonly project: string | null; readonly shared_to: readonly string[] },
  ): boolean {
    if (this.#readable(s, r.project)) return true;
    return r.shared_to.some((p) =>
      p === '*'
        ? (visibleProjects(s) ?? ['*']).length > 0
        : authorize(s, 'templates.read', { project: p }).allow,
    );
  }

  /** Whether the template (project `owner`, shares `shared`) may run in `project`. */
  static usableIn(
    owner: string | null,
    shared: readonly string[],
    project: string,
  ): 'own' | 'global' | 'shared' | null {
    if (owner === null) return 'global';
    if (owner === project) return 'own';
    return shared.includes('*') || shared.includes(project) ? 'shared' : null;
  }

  #canEdit(s: Subject, project: string | null): boolean {
    return project === null
      ? authorize(s, 'templates.global').allow
      : authorize(s, 'templates.write', { project }).allow;
  }

  #requireEdit(s: Subject, project: string | null): void {
    if (!this.#readable(s, project))
      throw new TemplateError(404, 'template_not_found', 'Template not found.');
    if (!this.#canEdit(s, project)) {
      throw new TemplateError(
        403,
        'forbidden',
        project === null
          ? 'Only admins create or change global templates.'
          : 'You need the operator role in this project to change its templates.',
      );
    }
  }

  async list(
    s: Subject,
    filter: {
      readonly project?: string | undefined;
      readonly state?: 'active' | 'archived' | 'any' | undefined;
      readonly tag?: string | undefined;
      readonly q?: string | undefined;
      readonly limit?: number | undefined;
      /** p18-multi-project W4: with a project filter, the templates hidden there too (`include`) or only them. */
      readonly hidden?: 'exclude' | 'include' | 'only' | undefined;
    } = {},
  ): Promise<TemplateView[]> {
    const visible = visibleProjects(s);
    const where: string[] = [];
    const args: unknown[] = [];
    const arg = (v: unknown): string => {
      args.push(v);
      return `$${String(args.length)}`;
    };
    if (visible !== null) {
      const v = arg(visible);
      // p18-multi-project W4: plus the templates shared to a project the caller reads ('*': to every project).
      where.push(
        `(t.project IS NULL OR t.project = ANY(${v}::text[]) OR EXISTS (SELECT 1 FROM job_template_shares sh
           WHERE sh.template_id = t.id AND (sh.project = ANY(${v}::text[]) OR (sh.project = '*' AND cardinality(${v}::text[]) > 0))))`,
      );
    }
    // A project filter shows what can run there: its own templates, the global ones and those shared to it — minus
    // the ones the project hid (p18-multi-project W4).
    let hiddenCol = 'false';
    if (filter.project !== undefined) {
      const p = arg(filter.project);
      where.push(
        `(t.project IS NULL OR t.project = ${p} OR EXISTS (SELECT 1 FROM job_template_shares sh
           WHERE sh.template_id = t.id AND (sh.project = ${p} OR sh.project = '*')))`,
      );
      hiddenCol = `EXISTS (SELECT 1 FROM job_template_hidden hd WHERE hd.template_id = t.id AND hd.project = ${p})`;
      const mode = filter.hidden ?? 'exclude';
      if (mode === 'exclude') where.push(`NOT ${hiddenCol}`);
      else if (mode === 'only') where.push(hiddenCol);
    }
    const state = filter.state ?? 'active';
    if (state !== 'any') where.push(`t.state = ${arg(state)}`);
    if (filter.tag !== undefined) where.push(`${arg(filter.tag)} = ANY(t.tags)`);
    if (filter.q !== undefined && filter.q.trim() !== '') {
      const q = `%${filter.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const p = arg(q);
      where.push(
        `(t.title ILIKE ${p} OR t.description ILIKE ${p} OR array_to_string(t.tags, ' ') ILIKE ${p})`,
      );
    }
    const { rows } = await this.deps.pool.query<TemplateRow>(
      `${selectWith(`, ${hiddenCol} AS hidden_here`)} ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
       ORDER BY t.state, t.updated_at DESC, t.id LIMIT ${arg(Math.min(filter.limit ?? 200, 500))}`,
      args,
    );
    const stats = await this.stats(
      s,
      rows.map((r) => r.id),
    );
    return rows.map((r) => this.#view(s, r, stats.get(r.id) ?? EMPTY_STATS, filter.project));
  }

  async get(s: Subject, id: string, here?: string): Promise<TemplateView> {
    const row = await this.#row(this.deps.pool, id);
    if (row === null || !this.#visible(s, row)) {
      throw new TemplateError(404, 'template_not_found', 'Template not found.');
    }
    if (here !== undefined && here !== row.project) {
      const { rowCount } = await this.deps.pool.query(
        'SELECT 1 FROM job_template_hidden WHERE template_id = $1 AND project = $2',
        [id, here],
      );
      row.hidden_here = (rowCount ?? 0) > 0;
    }
    const stats = await this.stats(s, [id]);
    return this.#view(s, row, stats.get(id) ?? EMPTY_STATS, here);
  }

  async #row(db: Queryable, id: string, lock = false): Promise<TemplateRow | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await db.query<TemplateRow>(
      `${SELECT} WHERE t.id = $1${lock ? ' FOR UPDATE OF t' : ''}`,
      [id],
    );
    return rows[0] ?? null;
  }

  #view(s: Subject, r: TemplateRow, stats: TemplateStats, here?: string): TemplateView {
    const shared = r.shared_to;
    const readableShares = shared.filter(
      (p) => p === '*' || authorize(s, 'templates.read', { project: p }).allow,
    );
    const scope: TemplateView['scope'] =
      r.project === null
        ? 'global'
        : here !== undefined
          ? here === r.project
            ? 'project'
            : 'shared'
          : this.#readable(s, r.project)
            ? 'project'
            : 'shared';
    return {
      id: r.id,
      project: r.project,
      title: r.title,
      description: r.description,
      tags: r.tags,
      state: r.state,
      version: r.current_version,
      owner: { id: r.owner_id, username: r.owner_username },
      source: r.source,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      current: {
        version: r.current_version,
        prompt: r.prompt,
        parameters: r.parameters,
        defaults: r.defaults,
        changeNote: r.change_note,
        createdBy: r.created_by,
        createdAt: r.version_created_at.toISOString(),
      },
      stats,
      canEdit: this.#canEdit(s, r.project),
      scope,
      sharedTo: readableShares,
      sharedToHidden: shared.length - readableShares.length,
      canShare: r.project !== null && authorize(s, 'templates.share', { project: r.project }).allow,
      hidden: r.hidden_here === true,
    };
  }

  async versions(s: Subject, id: string): Promise<TemplateVersionView[]> {
    await this.get(s, id);
    const { rows } = await this.deps.pool.query<{
      version: number;
      prompt: string;
      parameters: TemplateParameter[];
      defaults: TemplateDefaults;
      change_note: string | null;
      created_by: string | null;
      created_at: Date;
    }>(
      `SELECT version, prompt, parameters, defaults, change_note, created_by, created_at
         FROM job_template_versions WHERE template_id = $1 ORDER BY version DESC`,
      [id],
    );
    return rows.map((v) => ({
      version: v.version,
      prompt: v.prompt,
      parameters: v.parameters,
      defaults: v.defaults,
      changeNote: v.change_note,
      createdBy: v.created_by,
      createdAt: v.created_at.toISOString(),
    }));
  }

  async version(s: Subject, id: string, version: number): Promise<TemplateVersionView> {
    const v = (await this.versions(s, id)).find((x) => x.version === version);
    if (v === undefined) throw new TemplateError(404, 'version_not_found', 'Template version not found.');
    return v;
  }

  /** Unified diff of two versions: the prompt, then the parameters and settings as JSON. */
  async diff(
    s: Subject,
    id: string,
    from: number,
    to: number,
  ): Promise<{ from: number; to: number; diff: string }> {
    const all = await this.versions(s, id);
    const a = all.find((x) => x.version === from);
    const b = all.find((x) => x.version === to);
    if (a === undefined || b === undefined) {
      throw new TemplateError(404, 'version_not_found', 'Template version not found.');
    }
    const json = (v: unknown): string => JSON.stringify(v, null, 2);
    const diff = [
      unifiedDiff('prompt', a.prompt, b.prompt),
      unifiedDiff('parameters.json', json(a.parameters), json(b.parameters)),
      unifiedDiff('settings.json', json(a.defaults), json(b.defaults)),
    ]
      .filter((d) => d !== '')
      .join('');
    return { from, to, diff };
  }

  /**
   * Usage per template: jobs started from it (composer, chat, REST) and the jobs of automations made from it. Only
   * jobs in projects the caller may see are counted (a global template's numbers never reveal other projects).
   */
  async stats(s: Subject, ids: readonly string[]): Promise<Map<string, TemplateStats>> {
    const out = new Map<string, TemplateStats>();
    if (ids.length === 0) return out;
    const visible = visibleProjects(s);
    const { rows } = await this.deps.pool.query<{
      template_id: string;
      runs: string;
      finished: string;
      succeeded: string;
      avg_cost: string | null;
      avg_dur: number | null;
      last_run: Date | null;
    }>(
      `WITH runs AS (
         SELECT template_id, job_id FROM job_template_runs WHERE template_id = ANY($1::uuid[])
         UNION
         SELECT l.template_id, ar.job_id FROM job_template_automations l
           JOIN automation_runs ar ON ar.automation_id = l.automation_id
          WHERE l.template_id = ANY($1::uuid[]) AND ar.job_id IS NOT NULL
       ), per_job AS (
         SELECT r.template_id, j.state::text AS state, j.created_at,
                (SELECT sum(u.cost_usd) FROM usage_records u WHERE u.job_id = j.id) AS cost,
                (SELECT EXTRACT(EPOCH FROM (max(a.ended_at) - min(a.started_at)))::float8
                   FROM job_attempts a WHERE a.job_id = j.id) AS dur
           FROM runs r JOIN jobs j ON j.id = r.job_id
          WHERE $2::text[] IS NULL OR j.project = ANY($2::text[])
       )
       SELECT template_id, count(*) AS runs,
              count(*) FILTER (WHERE state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'LOST')) AS finished,
              count(*) FILTER (WHERE state = 'SUCCEEDED') AS succeeded,
              avg(cost) FILTER (WHERE cost IS NOT NULL) AS avg_cost,
              avg(dur) FILTER (WHERE dur IS NOT NULL AND state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')) AS avg_dur,
              max(created_at) AS last_run
         FROM per_job GROUP BY template_id`,
      [ids, visible],
    );
    const autos = await this.deps.pool.query<{ template_id: string; n: string }>(
      `SELECT l.template_id, count(*) AS n FROM job_template_automations l JOIN automations a ON a.id = l.automation_id
        WHERE l.template_id = ANY($1::uuid[]) AND a.state <> 'deleted'
          AND ($2::text[] IS NULL OR a.project = ANY($2::text[]))
        GROUP BY l.template_id`,
      [ids, visible],
    );
    const autoCount = new Map(autos.rows.map((r) => [r.template_id, Number(r.n)]));
    for (const id of ids) out.set(id, { ...EMPTY_STATS, automations: autoCount.get(id) ?? 0 });
    for (const r of rows) {
      const finished = Number(r.finished);
      const succeeded = Number(r.succeeded);
      out.set(r.template_id, {
        runs: Number(r.runs),
        finished,
        succeeded,
        successRate: finished === 0 ? null : Math.round((succeeded / finished) * 1000) / 1000,
        avgCostUsd: r.avg_cost === null ? null : Math.round(Number(r.avg_cost) * 10000) / 10000,
        avgDurationSec: r.avg_dur === null ? null : Math.round(r.avg_dur),
        lastRunAt: r.last_run === null ? null : r.last_run.toISOString(),
        automations: autoCount.get(r.template_id) ?? 0,
      });
    }
    return out;
  }

  // ----------------------------------------------------------------------------------------- writing

  /** Checks prompt + parameters + settings together; throws a 400 with every issue. */
  async #content(
    db: Queryable,
    project: string | null,
    prompt: string,
    declared: readonly TemplateParameter[],
    defaults: TemplateDefaults,
    /** p18-multi-project W4: the template is shared to other projects (full access is per project, like global). */
    shared = false,
  ): Promise<TemplateParameter[]> {
    const { parameters, issues } = parseTemplate(prompt, declared);
    const problems: TemplateIssue[] = [...issues];
    if (defaults.approvalPolicy === 'allow-all' || defaults.sandboxProfile === 'unconfined') {
      if (shared && project !== null) {
        problems.push({
          code: 'full_access_shared',
          message:
            'A shared template cannot default to full access (“Never ask” / unconfined); withdraw its shares first or set it per project.',
        });
      }
      if (project === null) {
        problems.push({
          code: 'full_access_global',
          message:
            'A global template cannot default to full access (“Never ask” / unconfined); set it per project.',
        });
      } else {
        const { rows } = await db.query<{ auto_approve_execution: boolean; unconfined_execution: boolean }>(
          'SELECT auto_approve_execution, unconfined_execution FROM projects WHERE id = $1',
          [project],
        );
        const p = rows[0];
        if (defaults.approvalPolicy === 'allow-all' && p?.auto_approve_execution !== true) {
          problems.push({
            code: 'auto_approve_not_allowed',
            message: `Project ${project} does not allow “Never ask”; choose another approval policy.`,
          });
        }
        if (defaults.sandboxProfile === 'unconfined' && p?.unconfined_execution !== true) {
          problems.push({
            code: 'unconfined_not_allowed',
            message: `Project ${project} does not allow the unconfined profile.`,
          });
        }
      }
    }
    if (parameters.some((p) => p.type === 'file') && project !== null) {
      if ((await projectKind(db, project)) !== 'workspace') {
        problems.push({
          code: 'file_parameter',
          message:
            'File parameters are for workspace projects (repository projects work on their repository).',
        });
      }
    }
    if (problems.length > 0) {
      throw new TemplateError(
        400,
        'invalid_template',
        problems
          .slice(0, 5)
          .map((i) => i.message)
          .join(' '),
        problems,
      );
    }
    return parameters;
  }

  async create(actor: TemplateActor, input: TemplateInput): Promise<TemplateView> {
    const project = input.project ?? null;
    this.#requireEdit(actor.subject, project);
    if (project !== null) {
      const { rowCount } = await this.deps.pool.query('SELECT 1 FROM projects WHERE id = $1', [project]);
      if ((rowCount ?? 0) === 0) throw new TemplateError(404, 'project_not_found', 'Project not found.');
    }
    const source: TemplateSource = input.source ?? { kind: 'manual' };
    const now = this.deps.clock();
    const id = await withTransaction(this.deps.pool, async (tx) => {
      const parameters = await this.#content(
        tx,
        project,
        input.prompt,
        input.parameters ?? [],
        input.defaults,
      );
      const newId = randomUUID();
      await tx.query(
        `INSERT INTO job_templates (id, project, title, description, tags, state, current_version, owner_id, source,
                                    created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $7, $8, $8)`,
        [newId, project, input.title, input.description ?? '', dedupe(input.tags), actor.id, source, now],
      );
      await this.#insertVersion(
        tx,
        newId,
        1,
        input.prompt,
        parameters,
        input.defaults,
        input.changeNote,
        actor.id,
        now,
      );
      if (source.kind === 'suggestion' && project !== null) {
        await tx.query(
          `INSERT INTO job_template_suggestion_feedback (user_id, project, suggestion_id, kind, member_keys, created_at)
           VALUES ($1, $2, $3, 'created', $4, $5)
           ON CONFLICT (user_id, project, suggestion_id) DO UPDATE SET kind = 'created', created_at = $5`,
          [actor.id, project, source.id, source.members ?? [], now],
        );
      }
      await this.#audit(tx, actor, 'template.create', newId, {
        project,
        version: 1,
        source: source.kind,
        parameters: parameters.map((p) => `${p.name}:${p.type}`),
      });
      return newId;
    });
    return this.get(actor.subject, id);
  }

  async #insertVersion(
    tx: Queryable,
    id: string,
    version: number,
    prompt: string,
    parameters: readonly TemplateParameter[],
    defaults: TemplateDefaults,
    changeNote: string | undefined,
    by: string,
    now: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO job_template_versions (template_id, version, prompt, parameters, defaults, change_note, created_by,
                                          created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        version,
        prompt,
        JSON.stringify(parameters),
        JSON.stringify(defaults),
        changeNote === undefined || changeNote === '' ? null : changeNote,
        by,
        now,
      ],
    );
  }

  /** Metadata changes in place; a prompt / parameter / settings change makes a new version. */
  async update(actor: TemplateActor, id: string, patch: TemplatePatch): Promise<TemplateView> {
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const row = await this.#row(tx, id, true);
      if (row === null) throw new TemplateError(404, 'template_not_found', 'Template not found.');
      this.#requireEdit(actor.subject, row.project);
      if (row.state === 'archived') {
        throw new TemplateError(409, 'template_archived', 'Restore the template before changing it.');
      }
      if (patch.expectedVersion !== row.current_version) {
        throw new TemplateError(
          409,
          'version_conflict',
          `The template changed meanwhile (now version ${String(row.current_version)}); reload it and apply your change again.`,
        );
      }
      const prompt = patch.prompt ?? row.prompt;
      const declared = patch.parameters ?? row.parameters;
      const defaults = patch.defaults ?? row.defaults;
      const contentChanged =
        prompt !== row.prompt ||
        JSON.stringify(declared) !== JSON.stringify(row.parameters) ||
        JSON.stringify(defaults) !== JSON.stringify(row.defaults);
      let version = row.current_version;
      if (contentChanged) {
        const parameters = await this.#content(
          tx,
          row.project,
          prompt,
          declared,
          defaults,
          row.shared_to.length > 0,
        );
        version = row.current_version + 1;
        await this.#insertVersion(
          tx,
          id,
          version,
          prompt,
          parameters,
          defaults,
          patch.changeNote,
          actor.id,
          now,
        );
      }
      await tx.query(
        `UPDATE job_templates SET title = $2, description = $3, tags = $4, current_version = $5, updated_at = $6
          WHERE id = $1`,
        [
          id,
          patch.title ?? row.title,
          patch.description ?? row.description,
          patch.tags === undefined ? row.tags : dedupe(patch.tags),
          version,
          now,
        ],
      );
      await this.#audit(tx, actor, 'template.update', id, {
        project: row.project,
        version,
        contentChanged,
      });
    });
    return this.get(actor.subject, id);
  }

  async setArchived(actor: TemplateActor, id: string, archived: boolean): Promise<TemplateView> {
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const row = await this.#row(tx, id, true);
      if (row === null) throw new TemplateError(404, 'template_not_found', 'Template not found.');
      this.#requireEdit(actor.subject, row.project);
      await tx.query(`UPDATE job_templates SET state = $2, archived_at = $3, updated_at = $4 WHERE id = $1`, [
        id,
        archived ? 'archived' : 'active',
        archived ? now : null,
        now,
      ]);
      await this.#audit(tx, actor, archived ? 'template.archive' : 'template.restore', id, {
        project: row.project,
      });
    });
    return this.get(actor.subject, id);
  }

  async duplicate(
    actor: TemplateActor,
    id: string,
    opts: { readonly project?: string | null | undefined; readonly title?: string | undefined },
  ): Promise<TemplateView> {
    const t = await this.get(actor.subject, id);
    return this.create(actor, {
      project: opts.project === undefined ? t.project : opts.project,
      title: (opts.title ?? `${t.title} (copy)`).slice(0, 200),
      description: t.description,
      tags: [...t.tags],
      prompt: t.current.prompt,
      parameters: [...t.current.parameters],
      defaults: t.current.defaults,
      changeNote: `Copied from ${t.title} v${String(t.version)}`.slice(0, 500),
      source: { kind: 'duplicate', id: t.id },
    });
  }

  async #audit(
    tx: Queryable,
    actor: TemplateActor,
    action: string,
    id: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actor: { type: 'user', id: actor.id },
        action,
        target: `template:${id}`,
        outcome: 'success',
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata,
      },
      tx,
    );
  }

  // ------------------------------------------------------------------------- p18-multi-project W4: the library

  /**
   * `PUT /templates/:id/shares`: the projects a project template is shared to (replaced; `['*']` = every project,
   * `[]` withdraws). Needs `templates.share` in the template's project (checked by the route and here) and
   * `templates.read` in every listed project (an unreadable one answers 404 like a missing one). A template with
   * full-access defaults cannot be shared (like a global one). Audited `template.share`.
   */
  async setShares(actor: TemplateActor, id: string, projects: readonly string[]): Promise<TemplateView> {
    const set = [...new Set(projects)].sort();
    if (set.includes('*') && set.length > 1) {
      throw new TemplateError(
        400,
        'invalid_shares',
        'Share with every project ("*") or with listed projects, not both.',
      );
    }
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const row = await this.#row(tx, id, true);
      if (row === null || !this.#readable(actor.subject, row.project))
        throw new TemplateError(404, 'template_not_found', 'Template not found.');
      if (row.project === null)
        throw new TemplateError(
          400,
          'invalid_shares',
          'A global template is in every project’s library already.',
        );
      if (!authorize(actor.subject, 'templates.share', { project: row.project }).allow)
        throw new TemplateError(
          403,
          'forbidden',
          'You need the operator role in this project to share its templates.',
        );
      if (set.includes(row.project))
        throw new TemplateError(400, 'invalid_shares', 'The template belongs to that project already.');
      if (row.state === 'archived' && set.length > 0)
        throw new TemplateError(409, 'template_archived', 'Restore the template before sharing it.');
      for (const p of set) {
        if (p === '*') continue;
        if (!authorize(actor.subject, 'templates.read', { project: p }).allow)
          throw new TemplateError(404, 'project_not_found', `Project ${p.slice(0, 128)} not found.`);
        const { rowCount } = await tx.query('SELECT 1 FROM projects WHERE id = $1', [p]);
        if ((rowCount ?? 0) === 0)
          throw new TemplateError(404, 'project_not_found', `Project ${p.slice(0, 128)} not found.`);
      }
      const d = row.defaults;
      if (set.length > 0 && (d.approvalPolicy === 'allow-all' || d.sandboxProfile === 'unconfined')) {
        throw new TemplateError(
          400,
          'full_access_shared',
          'A template that defaults to full access (“Never ask” / unconfined) cannot be shared; change its settings first.',
        );
      }
      const prev = row.shared_to;
      await tx.query(
        'DELETE FROM job_template_shares WHERE template_id = $1 AND NOT (project = ANY($2::text[]))',
        [id, set],
      );
      for (const p of set)
        await tx.query(
          `INSERT INTO job_template_shares (template_id, project, shared_by, shared_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [id, p, actor.id, now],
        );
      await this.#audit(tx, actor, 'template.share', id, {
        project: row.project,
        version: row.current_version,
        projects: set.slice(0, 50),
        withdrawn: prev.filter((p) => !set.includes(p)).slice(0, 50),
      });
    });
    return this.get(actor.subject, id);
  }

  /**
   * `PUT /templates/:id/hidden`: hide a global or shared template from a project's library (or show it again). Needs
   * `templates.write` in that project; the project's own templates are archived instead. Audited `template.hide`.
   */
  async setHidden(actor: TemplateActor, id: string, project: string, hidden: boolean): Promise<TemplateView> {
    if (!authorize(actor.subject, 'templates.read', { project }).allow)
      throw new TemplateError(404, 'project_not_found', 'Project not found.');
    if (!authorize(actor.subject, 'templates.write', { project }).allow)
      throw new TemplateError(
        403,
        'forbidden',
        'You need the operator role in this project to change its template library.',
      );
    const row = await this.#row(this.deps.pool, id);
    if (row === null || !this.#visible(actor.subject, row))
      throw new TemplateError(404, 'template_not_found', 'Template not found.');
    const use = TemplateService.usableIn(row.project, row.shared_to, project);
    if (use === 'own')
      throw new TemplateError(
        400,
        'template_own_project',
        'This is the project’s own template; archive it instead of hiding it.',
      );
    if (use === null) throw new TemplateError(404, 'template_not_found', 'Template not found.');
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      if (hidden)
        await tx.query(
          `INSERT INTO job_template_hidden (template_id, project, hidden_by, hidden_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [id, project, actor.id, now],
        );
      else
        await tx.query('DELETE FROM job_template_hidden WHERE template_id = $1 AND project = $2', [
          id,
          project,
        ]);
      await this.#audit(tx, actor, 'template.hide', id, {
        project,
        ownerProject: row.project,
        hidden,
        scope: use,
      });
    });
    return this.get(actor.subject, id, project);
  }

  /** Whether the template is shared to `project` (route authorization of a reader in a target project). */
  async sharedTo(id: string, project: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const { rowCount } = await this.deps.pool.query(
      `SELECT 1 FROM job_template_shares WHERE template_id = $1 AND (project = $2 OR project = '*')`,
      [id, project],
    );
    return (rowCount ?? 0) > 0;
  }

  // ----------------------------------------------------------------------------------------- rendering

  /** Live preview of an unsaved template (the editor): the merged parameters, issues and the rendered prompt. */
  preview(input: {
    readonly prompt: string;
    readonly parameters?: readonly unknown[] | undefined;
    readonly values?: Readonly<Record<string, unknown>> | undefined;
    readonly title?: string | undefined;
  }): {
    parameters: TemplateParameter[];
    issues: TemplateIssue[];
    valueIssues: TemplateIssue[];
    prompt: string | null;
    candidates: ReturnType<typeof candidateParameters>;
  } {
    const declared: TemplateParameter[] = [];
    const issues: TemplateIssue[] = [];
    for (const raw of input.parameters ?? []) {
      const p = TemplateParameterSchema.safeParse(raw);
      if (p.success) declared.push(p.data);
      else issues.push({ code: 'invalid_parameter', message: 'A parameter definition is not valid.' });
    }
    const parsed = parseTemplate(input.prompt.slice(0, MAX_TEMPLATE_PROMPT), declared);
    issues.push(...parsed.issues);
    const values = validateValues(parsed.parameters, input.values ?? {});
    // The preview renders what it can: missing values show as "(not given)".
    const prompt = renderPrompt({
      prompt: input.prompt.slice(0, MAX_TEMPLATE_PROMPT),
      parameters: parsed.parameters,
      values: values.values,
      title: input.title ?? 'Template',
      version: 1,
    });
    return {
      parameters: parsed.parameters,
      issues,
      valueIssues: values.issues.filter((i) => i.code !== 'required'),
      prompt,
      candidates: parsed.parameters.length === 0 ? candidateParameters(input.prompt) : [],
    };
  }

  /**
   * A template rendered for a run in `project` by `s` (composer prefill, chat card, automation): the template must be
   * visible, active and usable in that project; every value is validated. Throws TemplateError (400 with the issues).
   */
  async render(
    s: Subject,
    id: string,
    values: Readonly<Record<string, unknown>>,
    project?: string | null,
  ): Promise<RenderedTemplate & { readonly project: string }> {
    const t = await this.get(s, id);
    if (t.state !== 'active') throw new TemplateError(409, 'template_archived', 'This template is archived.');
    // p18-multi-project W4: a shared template runs in the named project (its own project when none is named).
    const target = project ?? t.project ?? null;
    if (target === null) {
      throw new TemplateError(
        400,
        'project_required',
        'This template is global: name the project to run it in.',
      );
    }
    const use = TemplateService.usableIn(t.project, t.sharedTo, target);
    if (use === null) {
      throw new TemplateError(
        400,
        'wrong_project',
        `This template belongs to project ${t.project ?? ''} and is not shared to ${target}.`,
      );
    }
    if (!authorize(s, 'templates.read', { project: target }).allow) {
      throw new TemplateError(404, 'project_not_found', 'Project not found.');
    }
    if (use === 'shared') {
      // The target's policy caps the run: no full access from another project's template, no file parameters in a
      // repository project, never the owner's base branch.
      const d = t.current.defaults;
      if (d.approvalPolicy === 'allow-all' || d.sandboxProfile === 'unconfined') {
        throw new TemplateError(
          400,
          'full_access_shared',
          'A shared template cannot run with full access (“Never ask” / unconfined) in another project.',
        );
      }
      if (
        t.current.parameters.some((p) => p.type === 'file') &&
        (await projectKind(this.deps.pool, target)) !== 'workspace'
      ) {
        throw new TemplateError(
          400,
          'file_parameter',
          'File parameters are for workspace projects (repository projects work on their repository).',
        );
      }
    }
    const checked = validateValues(t.current.parameters, values);
    if (!checked.ok) {
      throw new TemplateError(
        400,
        'invalid_parameters',
        checked.issues
          .slice(0, 6)
          .map((i) => i.message)
          .join(' '),
        checked.issues,
      );
    }
    const prompt = renderPrompt({
      prompt: t.current.prompt,
      parameters: t.current.parameters,
      values: checked.values,
      title: t.title,
      version: t.version,
    });
    if (prompt.length > 256 * 1024) {
      throw new TemplateError(400, 'prompt_too_long', 'The rendered prompt is longer than 256 KiB.');
    }
    const parsedDefaults = TemplateDefaultsSchema.parse(t.current.defaults);
    // p18-multi-project W4: another project's base branch means nothing here (the project's own is used).
    const { baseRef: _ownerBase, ...sharedDefaults } = parsedDefaults;
    const defaults: TemplateDefaults = use === 'shared' ? sharedDefaults : parsedDefaults;
    return {
      template: t,
      version: t.version,
      prompt,
      values: checked.values,
      defaults,
      files: t.current.parameters
        .filter((p) => p.type === 'file' && checked.values[p.name] !== undefined)
        .map((p) => String(checked.values[p.name])),
      project: target,
    };
  }

  /**
   * Records that `jobId` came from a template version (inside the job's creation transaction). The template must be
   * visible to the creator and usable in the job's project; anything else refuses the job (400) rather than
   * mis-attributing it.
   */
  async recordRun(
    tx: Queryable,
    s: Subject,
    jobId: string,
    project: string,
    ref: { readonly id: string; readonly version: number },
    via: 'composer' | 'chat' | 'api',
  ): Promise<void> {
    const { rows } = await tx.query<{ project: string | null; current_version: number; shared_to: string[] }>(
      `SELECT project, current_version,
              ARRAY(SELECT sh.project FROM job_template_shares sh WHERE sh.template_id = t.id) AS shared_to
         FROM job_templates t WHERE id = $1`,
      [ref.id],
    );
    const t = rows[0];
    if (
      t === undefined ||
      !this.#visible(s, t) ||
      TemplateService.usableIn(t.project, t.shared_to, project) === null
    ) {
      throw new TemplateError(
        400,
        'invalid_template',
        'The template does not exist or does not fit this project.',
      );
    }
    if (ref.version < 1 || ref.version > t.current_version) {
      throw new TemplateError(400, 'invalid_template', 'Unknown template version.');
    }
    await tx.query(
      `INSERT INTO job_template_runs (job_id, template_id, version, via, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (job_id) DO NOTHING`,
      [jobId, ref.id, ref.version, via, this.deps.clock()],
    );
  }

  async linkAutomation(
    automationId: string,
    ref: { readonly id: string; readonly version: number; readonly params?: Record<string, unknown> },
    db: Queryable = this.deps.pool,
  ): Promise<void> {
    await db.query(
      `INSERT INTO job_template_automations (automation_id, template_id, version, params, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (automation_id) DO NOTHING`,
      [automationId, ref.id, ref.version, JSON.stringify(ref.params ?? {}), this.deps.clock()],
    );
  }

  /** Which template an automation was made from (its detail page links it). */
  async automationTemplate(
    s: Subject,
    automationId: string,
  ): Promise<{ id: string; title: string; version: number } | null> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      title: string;
      version: number;
      project: string | null;
      shared_to: string[];
    }>(
      `SELECT t.id, t.title, l.version, t.project,
              ARRAY(SELECT sh.project FROM job_template_shares sh WHERE sh.template_id = t.id) AS shared_to
         FROM job_template_automations l
         JOIN job_templates t ON t.id = l.template_id WHERE l.automation_id = $1`,
      [automationId],
    );
    const r = rows[0];
    return r === undefined || !this.#visible(s, r) ? null : { id: r.id, title: r.title, version: r.version };
  }

  // ------------------------------------------------------------------------- "Save as template"

  /** An editor prefill from a job the caller can read: its prompt verbatim, its settings, candidate parameters. */
  async proposalFromJob(s: Subject, jobId: string): Promise<Proposal> {
    if (!UUID.test(jobId)) throw new TemplateError(404, 'job_not_found', 'Job not found.');
    const { rows } = await this.deps.pool.query<{ project: string; spec: Record<string, unknown> }>(
      'SELECT project, spec FROM jobs WHERE id = $1',
      [jobId],
    );
    const j = rows[0];
    if (j === undefined || !authorize(s, 'jobs.read', { project: j.project }).allow) {
      throw new TemplateError(404, 'job_not_found', 'Job not found.');
    }
    return proposalOf(j.project, j.spec, { kind: 'job', id: jobId });
  }

  /** An editor prefill from one of the caller's own chat job drafts. */
  async proposalFromDraft(s: Subject, draftId: string): Promise<Proposal> {
    if (!UUID.test(draftId)) throw new TemplateError(404, 'draft_not_found', 'Draft not found.');
    const { rows } = await this.deps.pool.query<{ kind: string; payload: Record<string, unknown> }>(
      'SELECT kind, payload FROM chat_drafts WHERE id = $1 AND user_id = $2',
      [draftId, s.userId],
    );
    const d = rows[0];
    if (d === undefined || d.kind !== 'job')
      throw new TemplateError(404, 'draft_not_found', 'Draft not found.');
    const project = typeof d.payload.project === 'string' ? d.payload.project : '';
    if (!authorize(s, 'jobs.read', { project }).allow) {
      throw new TemplateError(404, 'draft_not_found', 'Draft not found.');
    }
    return proposalOf(project, (d.payload.spec ?? {}) as Record<string, unknown>, {
      kind: 'draft',
      id: draftId,
    });
  }

  // ----------------------------------------------------------------------------------------- suggestions

  /**
   * Recurring prompts the caller could turn into templates: their visible finished jobs (last 90 days, not started
   * from a template, not automation, workflow or sub-jobs) and their own chat job drafts, grouped deterministically.
   */
  async suggestions(s: Subject, project?: string): Promise<Suggestion[]> {
    const visible = visibleProjects(s);
    if (project !== undefined && !authorize(s, 'templates.read', { project }).allow) {
      throw new TemplateError(404, 'project_not_found', 'Project not found.');
    }
    const since = new Date(this.deps.clock().getTime() - 90 * 24 * 3600_000);
    const jobs = await this.deps.pool.query<{
      id: string;
      project: string;
      prompt: string | null;
      runtime: string | null;
      model: string | null;
      sandbox: string | null;
      approval: string | null;
      created_at: Date;
    }>(
      `SELECT j.id, j.project, j.spec->>'prompt' AS prompt, j.spec->>'runtime' AS runtime, j.spec->>'model' AS model,
              j.spec->>'sandboxProfile' AS sandbox, j.spec->>'approvalPolicy' AS approval, j.created_at
         FROM jobs j
        WHERE j.state IN ('SUCCEEDED', 'FAILED') AND j.created_at >= $1 AND j.created_by_type = 'user'
          AND ($2::text[] IS NULL OR j.project = ANY($2::text[]))
          AND ($3::text IS NULL OR j.project = $3)
          AND length(coalesce(j.spec->>'prompt', '')) BETWEEN 1 AND 16384
          AND NOT EXISTS (SELECT 1 FROM job_template_runs r WHERE r.job_id = j.id)
          AND NOT EXISTS (SELECT 1 FROM automation_runs ar WHERE ar.job_id = j.id)
          AND NOT EXISTS (SELECT 1 FROM workflow_job_links w WHERE w.job_id = j.id)
          AND NOT EXISTS (SELECT 1 FROM job_subtasks st WHERE st.child_job_id = j.id)
        ORDER BY j.created_at DESC LIMIT 400`,
      [since, visible, project ?? null],
    );
    const drafts = await this.deps.pool.query<{
      id: string;
      project: string | null;
      prompt: string | null;
      runtime: string | null;
      model: string | null;
      sandbox: string | null;
      approval: string | null;
      title: string;
      created_at: Date;
    }>(
      `SELECT id, payload->>'project' AS project, payload->'spec'->>'prompt' AS prompt,
              payload->'spec'->>'runtime' AS runtime, payload->'spec'->>'model' AS model,
              payload->'spec'->>'sandboxProfile' AS sandbox, payload->'spec'->>'approvalPolicy' AS approval,
              title, created_at
         FROM chat_drafts
        WHERE user_id = $1 AND kind = 'job' AND state NOT IN ('confirmed', 'invalid') AND created_at >= $2
          AND payload->'template' IS NULL AND ($3::text IS NULL OR payload->>'project' = $3)
        ORDER BY created_at DESC LIMIT 200`,
      [s.userId, since, project ?? null],
    );
    const items: SourceItem[] = [
      ...jobs.rows.map((r) => ({
        key: `job:${r.id}`,
        kind: 'job' as const,
        id: r.id,
        project: r.project,
        prompt: r.prompt ?? '',
        title: titleOf(r.prompt ?? ''),
        createdAt: r.created_at.toISOString(),
        runtime: r.runtime,
        model: r.model,
        sandboxProfile: r.sandbox,
        approvalPolicy: r.approval,
      })),
      ...drafts.rows
        .filter((r) => r.project !== null && authorize(s, 'jobs.read', { project: r.project }).allow)
        .map((r) => ({
          key: `draft:${r.id}`,
          kind: 'draft' as const,
          id: r.id,
          project: r.project ?? '',
          prompt: r.prompt ?? '',
          title: r.title,
          createdAt: r.created_at.toISOString(),
          runtime: r.runtime,
          model: r.model,
          sandboxProfile: r.sandbox,
          approvalPolicy: r.approval,
        })),
    ];
    const fb = await this.deps.pool.query<{
      project: string;
      suggestion_id: string;
      kind: string;
      member_keys: string[];
    }>(
      'SELECT project, suggestion_id, kind, member_keys FROM job_template_suggestion_feedback WHERE user_id = $1',
      [s.userId],
    );
    const hidden = new Set(
      fb.rows.filter((r) => r.kind !== 'not_similar').map((r) => `${r.project}\n${r.suggestion_id}`),
    );
    const notSimilar = fb.rows.filter((r) => r.kind === 'not_similar').map((r) => r.member_keys);
    return suggest(items, { notSimilar })
      .filter(
        (x) =>
          !hidden.has(`${x.project}\n${x.id}`) && !notSimilar.some((m) => sameSet(m, x.members.map(keyOf))),
      )
      .slice(0, 20);
  }

  async feedback(
    actor: TemplateActor,
    input: {
      readonly project: string;
      readonly suggestionId: string;
      readonly kind: 'dismissed' | 'not_similar';
      readonly members?: readonly string[] | undefined;
    },
  ): Promise<void> {
    if (!authorize(actor.subject, 'templates.read', { project: input.project }).allow) {
      throw new TemplateError(404, 'project_not_found', 'Project not found.');
    }
    const members = [...new Set(input.members ?? [])].slice(0, 50);
    if (input.kind === 'not_similar' && members.length < 2) {
      throw new TemplateError(400, 'invalid_feedback', '“Not similar” needs the suggestion’s items.');
    }
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(
        `INSERT INTO job_template_suggestion_feedback (user_id, project, suggestion_id, kind, member_keys, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, project, suggestion_id) DO UPDATE SET kind = $4, member_keys = $5, created_at = $6`,
        [actor.id, input.project, input.suggestionId, input.kind, members, now],
      );
      await this.#audit(tx, actor, 'template.suggestion.feedback', input.suggestionId, {
        project: input.project,
        kind: input.kind,
        members: members.length,
      });
    });
  }
}

function keyOf(m: { readonly kind: string; readonly id: string }): string {
  return `${m.kind}:${m.id}`;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  return b.length > 0 && b.every((k) => x.has(k));
}

function dedupe(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim()).filter((t) => t !== ''))].slice(0, 16);
}

export interface Proposal {
  readonly project: string;
  readonly title: string;
  readonly prompt: string;
  readonly defaults: TemplateDefaults;
  readonly candidates: { text: string; type: ParamType; name: string }[];
  readonly source: TemplateSource;
}

const RUNTIMES = new Set(['claude-code', 'codex', 'pi', 'opencode']);

function proposalOf(project: string, spec: Record<string, unknown>, source: TemplateSource): Proposal {
  const prompt = typeof spec.prompt === 'string' ? spec.prompt.slice(0, MAX_TEMPLATE_PROMPT) : '';
  const limits = (spec.limits ?? {}) as Record<string, unknown>;
  const raw: Record<string, unknown> = {
    runtime: typeof spec.runtime === 'string' && RUNTIMES.has(spec.runtime) ? spec.runtime : 'claude-code',
    ...(typeof spec.model === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(spec.model)
      ? { modelProfile: spec.model }
      : {}),
    ...(typeof spec.sandboxProfile === 'string' ? { sandboxProfile: spec.sandboxProfile } : {}),
    ...(typeof spec.approvalPolicy === 'string' ? { approvalPolicy: spec.approvalPolicy } : {}),
    ...(typeof limits.maxDurationSec === 'number'
      ? { limits: { maxDurationSec: limits.maxDurationSec } }
      : {}),
  };
  const parsed = TemplateDefaultsSchema.safeParse(raw);
  return {
    project,
    title: titleOf(prompt),
    prompt,
    defaults: parsed.success ? parsed.data : { runtime: raw.runtime as TemplateDefaults['runtime'] },
    candidates: candidateParameters(prompt),
    source,
  };
}
