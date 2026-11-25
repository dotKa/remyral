import { scanForSecrets } from '@remyral/memory';
import {
  CUSTOM_TOOL_HOSTS,
  CustomToolRecipe,
  customToolRecipeIssues,
  type RecipeIssue,
  RESERVED_TOOL_NAMES,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { ActorContext } from '../workers/fleet.js';

/**
 * p13-fleet-tools (ADR-0052): admin-defined ("custom") tool recipes. A recipe is configuration that decides what may be
 * downloaded onto machines, so writing one is machine administration (admin + always-fresh step-up, audited). The
 * master validates it with the shared schema (allowlisted https hosts, mandatory SHA-256 + size, safe relative entry,
 * package ids per manager, no free-form command) and refuses secret-looking text; the worker validates the download
 * part again before it fetches anything.
 */

export interface StoredRecipe {
  readonly id: string;
  readonly recipe: CustomToolRecipe;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string | null;
}

const MESSAGE_CODE: Readonly<Record<string, string>> = {
  'download host not allowed': 'host_not_allowed',
  'reserved tool name': 'reserved_name',
  'custom tool name': 'name_invalid',
  'relative path inside the install dir': 'path_invalid',
  'lowercase hex sha256': 'sha256_invalid',
  'version check argument': 'check_arg_invalid',
  'tool version': 'version_invalid',
};

/** Validates a recipe document; throws 400 `recipe_invalid` with `issues[{path, code}]`. */
export function validateRecipe(raw: unknown): CustomToolRecipe {
  const parsed = CustomToolRecipe.safeParse(raw);
  if (!parsed.success) {
    const issues: RecipeIssue[] = parsed.error.issues.slice(0, 20).map((i) => ({
      path: i.path.map(String).join('.'),
      code: MESSAGE_CODE[i.message] ?? i.code,
    }));
    throw new HttpError(400, 'recipe_invalid', 'The tool recipe is not valid.', {}, { issues });
  }
  const issues = customToolRecipeIssues(parsed.data);
  const text = { title: parsed.data.title, description: parsed.data.description ?? '' };
  if (scanForSecrets(text).length > 0) issues.push({ path: 'title', code: 'secret_detected' });
  if (issues.length > 0) {
    throw new HttpError(400, 'recipe_invalid', 'The tool recipe is not valid.', {}, { issues });
  }
  return parsed.data;
}

interface Row {
  id: string;
  recipe: unknown;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

function view(r: Row): StoredRecipe {
  return {
    id: r.id,
    recipe: CustomToolRecipe.parse(r.recipe),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    createdBy: r.created_by,
  };
}

export const RECIPE_LIMITS = { hosts: CUSTOM_TOOL_HOSTS, reservedNames: RESERVED_TOOL_NAMES };
const MAX_RECIPES = 100;

export class CustomRecipeStore {
  constructor(
    private readonly deps: { readonly pool: Pool; readonly audit: AuditRecorder; readonly clock: () => Date },
  ) {}

  async list(): Promise<StoredRecipe[]> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT id::text AS id, recipe, created_at, updated_at, created_by::text AS created_by
         FROM custom_tool_recipes WHERE archived_at IS NULL ORDER BY name`,
    );
    return rows.flatMap((r) => {
      try {
        return [view(r)];
      } catch {
        return []; // a row a newer schema no longer accepts is not offered
      }
    });
  }

  async get(id: string): Promise<StoredRecipe> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT id::text AS id, recipe, created_at, updated_at, created_by::text AS created_by
         FROM custom_tool_recipes WHERE id::text = $1 AND archived_at IS NULL`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'recipe_not_found', 'No such custom tool recipe.');
    return view(r);
  }

  async byName(name: string): Promise<StoredRecipe | null> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT id::text AS id, recipe, created_at, updated_at, created_by::text AS created_by
         FROM custom_tool_recipes WHERE name = $1 AND archived_at IS NULL`,
      [name],
    );
    return rows[0] === undefined ? null : view(rows[0]);
  }

  async create(raw: unknown, actor: ActorContext): Promise<StoredRecipe> {
    const recipe = validateRecipe(raw);
    const { rows: count } = await this.deps.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM custom_tool_recipes WHERE archived_at IS NULL',
    );
    if (Number(count[0]?.n ?? '0') >= MAX_RECIPES)
      throw new HttpError(
        409,
        'too_many_recipes',
        `At most ${String(MAX_RECIPES)} custom tool recipes.`,
        {},
        {},
        { max: MAX_RECIPES },
      );
    if ((await this.byName(recipe.name)) !== null) {
      throw new HttpError(
        409,
        'recipe_exists',
        `A custom tool named ${recipe.name} exists already.`,
        {},
        {},
        { name: recipe.name },
      );
    }
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `INSERT INTO custom_tool_recipes (name, recipe, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $3, $4, $4) RETURNING id::text AS id`,
      [recipe.name, JSON.stringify(recipe), actor.userId, now],
    );
    const id = rows[0]?.id ?? '';
    await this.#audit('fleet.tools.recipe.create', id, recipe, actor);
    return this.get(id);
  }

  async update(id: string, raw: unknown, actor: ActorContext): Promise<StoredRecipe> {
    const before = await this.get(id);
    const recipe = validateRecipe(raw);
    if (recipe.name !== before.recipe.name) {
      throw new HttpError(409, 'recipe_rename', 'A custom tool keeps its name; create a new recipe instead.');
    }
    await this.deps.pool.query(
      'UPDATE custom_tool_recipes SET recipe = $2, updated_by = $3, updated_at = $4 WHERE id::text = $1',
      [id, JSON.stringify(recipe), actor.userId, this.deps.clock()],
    );
    await this.#audit('fleet.tools.recipe.update', id, recipe, actor);
    return this.get(id);
  }

  async archive(id: string, actor: ActorContext): Promise<void> {
    const before = await this.get(id);
    await this.deps.pool.query('UPDATE custom_tool_recipes SET archived_at = $2 WHERE id::text = $1', [
      id,
      this.deps.clock(),
    ]);
    await this.#audit('fleet.tools.recipe.delete', id, before.recipe, actor);
  }

  async #audit(action: string, id: string, r: CustomToolRecipe, actor: ActorContext): Promise<void> {
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action,
      target: `tool-recipe:${id}`,
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: {
        name: r.name,
        version: r.version,
        // What the recipe allows onto machines, for the audit trail.
        platforms: Object.fromEntries(
          Object.entries(r.platforms).map(([p, s]) => [
            p,
            s.kind === 'download'
              ? { kind: 'download', host: new URL(s.url).hostname, sha256: s.sha256, size: s.size }
              : { kind: 'package', manager: s.manager, package: s.package },
          ]),
        ),
      },
    });
  }
}
