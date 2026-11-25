import {
  ASSISTANT_FEATURE,
  AssistantRuntime,
  catalogModelFor,
  ModelCatalogEntryInput,
  RuntimeModelId,
} from '@remyral/protocol';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { ActorContext } from '../workers/fleet.js';

/**
 * Settings → Chat (p5-ops-chat): the kill switch, which worker runs the assistant, with which runtime and model
 * profile, and the limits that make up the "Chat" budget line. One row (migration 0034), versioned
 * (optimistic writes), audited.
 */

export const ChatLimits = z.strictObject({
  /** Turns a user may start per 10 minutes (rate limit). */
  turnsPerUserPer10Min: z.number().int().min(1).max(1000).default(30),
  /** Input + output tokens per user per UTC day (null = no per-user cap). */
  userDailyTokens: z.number().int().min(1).max(1_000_000_000).nullable().default(2_000_000),
  /** Input + output tokens of all users per UTC day (null = no cap). */
  dailyTokens: z.number().int().min(1).max(10_000_000_000).nullable().default(null),
  /** Runtime-reported dollars per UTC month (API-key runs only; subscription runs report none). */
  monthlyCostUsd: z.number().min(0).max(1_000_000).nullable().default(null),
  /** Tool calls the master answers per turn; later calls get an error result. */
  maxToolCallsPerTurn: z.number().int().min(1).max(100).default(24),
});
export type ChatLimits = z.infer<typeof ChatLimits>;

export const DEFAULT_CHAT_LIMITS: ChatLimits = ChatLimits.parse({});

/** Display names of the assistant runtimes (status lines, settings errors). */
export const ASSISTANT_RUNTIME_LABELS: Readonly<Record<AssistantRuntime, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

/** One assistant engine as a worker reported it (CAPABILITIES.assistant). */
export interface ChatEngineReadiness {
  readonly runtime: AssistantRuntime;
  readonly ready: boolean;
  readonly reason?: string;
}

/** A worker that runs an assistant host, with the engines it reported (Settings → Chat shows readiness). */
export interface ChatWorkerEngines {
  readonly workerId: string;
  readonly workerName: string;
  readonly online: boolean;
  /** The local opt-out (`assistant.disabled`) is set on that machine. */
  readonly disabled: boolean;
  readonly engines: readonly ChatEngineReadiness[];
  readonly reportedAt: Date | null;
  /** p15-chat-failover: the worker release it runs and whether it advertises the assistant (`assistant-v1`). */
  readonly workerVersion: string | null;
  readonly assistantFeature: boolean;
  /** p15-chat-failover: connected without interruption since (null: offline). */
  readonly connectedAt: Date | null;
}

const EngineEntry = z.object({
  runtime: AssistantRuntime,
  ready: z.boolean(),
  reason: z.string().max(300).optional(),
});

/** Engines of a stored report; entries of runtimes this master does not know are skipped (newer workers). */
export function engineReadiness(report: unknown): { disabled: boolean; engines: ChatEngineReadiness[] } {
  if (report === null || typeof report !== 'object') return { disabled: false, engines: [] };
  const r = report as { disabled?: unknown; engines?: unknown };
  const engines: ChatEngineReadiness[] = [];
  for (const e of Array.isArray(r.engines) ? r.engines.slice(0, 16) : []) {
    const parsed = EngineEntry.safeParse(e);
    if (!parsed.success) continue;
    const { runtime, ready, reason } = parsed.data;
    engines.push(reason === undefined ? { runtime, ready } : { runtime, ready, reason });
  }
  return { disabled: r.disabled === true, engines };
}

export interface ChatSettings {
  readonly enabled: boolean;
  readonly workerId: string | null;
  readonly runtime: AssistantRuntime;
  readonly modelProfile: string | null;
  /**
   * p11-usage-limit-fallback: the engine the chat continues on (same machine) while the main engine is at its usage
   * limit; null = none (the chat then says when it works again).
   */
  readonly fallbackRuntime: AssistantRuntime | null;
  readonly fallbackModelProfile: string | null;
  /**
   * p15-model-picker: the main / fallback engine's model as a model id (from the runtime model catalog or a custom
   * id) instead of a profile; at most one of `modelProfile` / `model` (and of the fallback pair) is set.
   */
  readonly model: string | null;
  readonly fallbackModel: string | null;
  /**
   * p13-runtime-accounts: the runtime account of the main engine on the chosen machine (null = its configured login /
   * key), and an account of the same runtime the chat continues with while that one is at its usage limit — tried
   * before the fallback engine.
   */
  readonly account: string | null;
  readonly fallbackAccount: string | null;
  /**
   * p15-chat-failover: the backup assistant workers after the primary, in order (0–6). A turn goes to the first machine
   * of [primary, ...backups] that can answer (docs/design/p15-chat-failover.md).
   */
  readonly backupWorkerIds: readonly string[];
  readonly limits: ChatLimits;
  readonly version: number;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

/**
 * p15-message-delivery item 2: `fallbackAccount = 'auto'` — while the chosen account is at its usage limit, another
 * ready account of the same runtime on that machine (the job rules: not paused, logged in, not limited, API keys only
 * with the workspace's paid switch), then the fallback engine. Account ids are `default` or `a` + 7 characters, so
 * 'auto' is never an account id. The default for existing (migration 0121) and new settings.
 */
export const AUTO_FALLBACK_ACCOUNT = 'auto';

/** p15-chat-failover: at most this many backup assistant workers (migration 0136 checks it too). */
export const MAX_BACKUP_WORKERS = 6;

export const ChatSettingsInput = z.strictObject({
  enabled: z.boolean(),
  workerId: z.string().min(1).max(64).nullable(),
  runtime: AssistantRuntime,
  modelProfile: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .nullable(),
  limits: ChatLimits.partial().optional(),
  /** p11-usage-limit-fallback: absent = unchanged; null = no fallback engine. */
  fallbackRuntime: AssistantRuntime.nullable().optional(),
  fallbackModelProfile: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .nullable()
    .optional(),
  /** p15-model-picker: absent = unchanged (kept only while the engine stays the same); null = none. */
  model: RuntimeModelId.nullable().optional(),
  fallbackModel: RuntimeModelId.nullable().optional(),
  /** p13-runtime-accounts: absent = unchanged; null = the machine's configured login / key. */
  account: z
    .string()
    .regex(/^[a-z0-9]{1,12}$/)
    .nullable()
    .optional(),
  fallbackAccount: z
    .string()
    .regex(/^[a-z0-9]{1,12}$/)
    .nullable()
    .optional(),
  /** p15-chat-failover: absent = unchanged; the ordered backup assistant workers (approved, distinct, not the primary). */
  backupWorkerIds: z.array(z.string().min(1).max(64)).max(MAX_BACKUP_WORKERS).optional(),
  expectedVersion: z.number().int().min(1),
});
export type ChatSettingsInput = z.infer<typeof ChatSettingsInput>;

interface Row {
  enabled: boolean;
  worker_id: string | null;
  runtime: AssistantRuntime;
  model_profile: string | null;
  fallback_runtime: AssistantRuntime | null;
  fallback_model_profile: string | null;
  model: string | null;
  fallback_model: string | null;
  account: string | null;
  fallback_account: string | null;
  backup_worker_ids: string[] | null;
  limits: unknown;
  version: number;
  updated_by: string | null;
  updated_at: Date;
}

function fromRow(r: Row): ChatSettings {
  const limits = ChatLimits.safeParse(r.limits ?? {});
  return {
    enabled: r.enabled,
    workerId: r.worker_id,
    runtime: r.runtime,
    modelProfile: r.model_profile,
    fallbackRuntime: r.fallback_runtime,
    fallbackModelProfile: r.fallback_model_profile,
    model: r.model,
    fallbackModel: r.fallback_model,
    account: r.account,
    fallbackAccount: r.fallback_account,
    backupWorkerIds: r.backup_worker_ids ?? [],
    limits: limits.success ? limits.data : DEFAULT_CHAT_LIMITS,
    version: r.version,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

export class ChatSettingsStore {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
    },
  ) {}

  async get(db: Queryable = this.deps.pool): Promise<ChatSettings> {
    const { rows } = await db.query<Row>(
      `SELECT enabled, worker_id, runtime, model_profile, fallback_runtime, fallback_model_profile, account,
              fallback_account, backup_worker_ids, limits, version, model, fallback_model,
              updated_by::text AS updated_by,
              updated_at FROM chat_settings WHERE id = 1`,
    );
    const r = rows[0];
    if (r === undefined) throw new Error('chat_settings row missing (migration 0034)');
    return fromRow(r);
  }

  /** The model id the profile resolves to for the runtime (undefined = the runtime's default model). */
  async modelFor(settings: ChatSettings, db: Queryable = this.deps.pool): Promise<string | undefined> {
    // p15-model-picker: a model id chosen directly wins (only one of the two is ever set).
    if (settings.model !== null) return settings.model;
    return this.modelOf(settings.runtime, settings.modelProfile, db);
  }

  /** p15-model-picker: the fallback engine's model (its model id, else its profile's, else its own default). */
  async fallbackModelFor(
    settings: ChatSettings,
    db: Queryable = this.deps.pool,
  ): Promise<string | undefined> {
    if (settings.fallbackRuntime === null) return undefined;
    if (settings.fallbackModel !== null) return settings.fallbackModel;
    return this.modelOf(settings.fallbackRuntime, settings.fallbackModelProfile, db);
  }

  /** p11-usage-limit-fallback: the model of any engine / profile pair (the fallback engine's). */
  async modelOf(
    runtime: AssistantRuntime,
    profile: string | null,
    db: Queryable = this.deps.pool,
  ): Promise<string | undefined> {
    if (profile === null) return undefined;
    const { rows } = await db.query<{ entry: unknown }>('SELECT entry FROM model_catalog WHERE id = $1', [
      profile,
    ]);
    const e = ModelCatalogEntryInput.safeParse(rows[0]?.entry);
    if (!e.success || !e.data.enabled || !e.data.runtimes.includes(runtime)) return undefined;
    return catalogModelFor(runtime, e.data);
  }

  /**
   * Workers that run an assistant host (they reported CAPABILITIES.assistant), with their engines' readiness.
   * Online is the worker state the fleet maintains (any master replica sees the same).
   */
  async engines(db: Queryable = this.deps.pool): Promise<ChatWorkerEngines[]> {
    const { rows } = await db.query<{
      id: string;
      display_name: string;
      state: string;
      assistant: unknown;
      assistant_at: Date | null;
      worker_version: string | null;
      features: unknown;
      connected_at: Date | null;
    }>(
      `SELECT id, display_name, state, assistant, assistant_at, worker_version, features, connected_at FROM workers
        WHERE approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL AND assistant IS NOT NULL
        ORDER BY display_name, id`,
    );
    return rows.map((r) => {
      const { disabled, engines } = engineReadiness(r.assistant);
      return {
        workerId: r.id,
        workerName: r.display_name,
        online: !['offline', 'pending', 'quarantined'].includes(r.state),
        disabled,
        engines,
        reportedAt: r.assistant_at,
        workerVersion: r.worker_version,
        assistantFeature: Array.isArray(r.features) && r.features.includes(ASSISTANT_FEATURE),
        connectedAt: r.connected_at,
      };
    });
  }

  /**
   * p15-chat-failover: the backup list a save stores — absent = the current one; the primary is never also a backup (a
   * new primary taken from the list leaves it; naming it in both is refused); distinct approved workers only.
   */
  async #backups(tx: Queryable, input: ChatSettingsInput, current: ChatSettings): Promise<string[]> {
    if (input.backupWorkerIds === undefined) {
      return current.backupWorkerIds.filter((id) => id !== input.workerId);
    }
    const ids = input.backupWorkerIds;
    if (new Set(ids).size !== ids.length) {
      throw new HttpError(400, 'backup_duplicate', 'A backup machine is listed twice.');
    }
    if (input.workerId !== null && ids.includes(input.workerId)) {
      throw new HttpError(400, 'backup_is_primary', 'The primary assistant machine cannot also be a backup.');
    }
    if (ids.length > 0 && input.workerId === null) {
      throw new HttpError(
        400,
        'worker_required',
        'Choose the primary assistant machine before its backups.',
        {},
        {},
        { reason: 'backups' },
      );
    }
    if (ids.length === 0) return [];
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM workers WHERE id = ANY($1::text[]) AND approved_at IS NOT NULL AND revoked_at IS NULL
          AND archived_at IS NULL`,
      [ids],
    );
    const known = new Set(rows.map((r) => r.id));
    const missing = ids.find((id) => !known.has(id));
    if (missing !== undefined) {
      throw new HttpError(
        400,
        'worker_not_found',
        'No such approved worker.',
        {},
        {},
        { reason: 'approved' },
      );
    }
    return [...ids];
  }

  async put(input: ChatSettingsInput, actor: ActorContext): Promise<ChatSettings> {
    return withTransaction(this.deps.pool, async (tx) => {
      const current = await this.get(tx);
      if (current.version !== input.expectedVersion) {
        throw new HttpError(
          409,
          'version_conflict',
          'The chat settings changed meanwhile. Reload and try again.',
          {},
          {},
          { reason: 'chat_settings' },
        );
      }
      if (input.workerId !== null) {
        const { rows } = await tx.query<{ id: string }>(
          `SELECT id FROM workers WHERE id = $1 AND approved_at IS NOT NULL AND revoked_at IS NULL
              AND archived_at IS NULL`,
          [input.workerId],
        );
        if (rows.length === 0)
          throw new HttpError(
            400,
            'worker_not_found',
            'No such approved worker.',
            {},
            {},
            { reason: 'approved' },
          );
      }
      if (input.modelProfile !== null) {
        const { rows } = await tx.query<{ entry: unknown }>('SELECT entry FROM model_catalog WHERE id = $1', [
          input.modelProfile,
        ]);
        const e = ModelCatalogEntryInput.safeParse(rows[0]?.entry);
        if (!e.success) throw new HttpError(400, 'model_profile_not_found', 'No such model profile.');
        if (!e.data.enabled)
          throw new HttpError(400, 'model_profile_disabled', 'The model profile is disabled.');
        if (!e.data.runtimes.includes(input.runtime)) {
          throw new HttpError(
            400,
            'model_profile_runtime',
            `The model profile is not available for ${ASSISTANT_RUNTIME_LABELS[input.runtime]}.`,
            {},
            {},
            { runtime: ASSISTANT_RUNTIME_LABELS[input.runtime] },
          );
        }
      }
      if (input.enabled && input.workerId === null) {
        throw new HttpError(
          400,
          'worker_required',
          'Choose the worker that runs the assistant before enabling chat.',
        );
      }
      const backupWorkerIds = await this.#backups(tx, input, current);
      const limits = ChatLimits.parse({ ...current.limits, ...input.limits });
      // p11-usage-limit-fallback: the fallback engine (absent = unchanged; one equal to the main engine is dropped).
      let fallbackRuntime =
        input.fallbackRuntime === undefined ? current.fallbackRuntime : input.fallbackRuntime;
      let fallbackModelProfile =
        input.fallbackModelProfile === undefined ? current.fallbackModelProfile : input.fallbackModelProfile;
      if (fallbackRuntime === input.runtime) {
        if (input.fallbackRuntime !== undefined && input.fallbackRuntime !== null) {
          throw new HttpError(
            400,
            'fallback_same_engine',
            'The fallback engine must differ from the main engine.',
          );
        }
        fallbackRuntime = null;
      }
      if (fallbackRuntime === null) fallbackModelProfile = null;
      if (fallbackRuntime !== null && fallbackModelProfile !== null) {
        const { rows } = await tx.query<{ entry: unknown }>('SELECT entry FROM model_catalog WHERE id = $1', [
          fallbackModelProfile,
        ]);
        const e = ModelCatalogEntryInput.safeParse(rows[0]?.entry);
        if (!e.success || !e.data.enabled || !e.data.runtimes.includes(fallbackRuntime)) {
          throw new HttpError(
            400,
            'fallback_model_profile',
            `The fallback model profile is not available for ${ASSISTANT_RUNTIME_LABELS[fallbackRuntime]}.`,
            {},
            {},
            { runtime: ASSISTANT_RUNTIME_LABELS[fallbackRuntime] },
          );
        }
      }
      // p15-model-picker: a model id instead of a profile (absent = unchanged while the engine stays; a profile clears it).
      if (input.model != null && input.modelProfile !== null)
        throw new HttpError(400, 'profile_and_model', 'Choose a model profile or a model, not both.');
      if (input.fallbackModel != null && input.fallbackModelProfile != null)
        throw new HttpError(400, 'profile_and_model', 'Choose a model profile or a model, not both.');
      const model =
        input.modelProfile !== null
          ? null
          : input.model === undefined
            ? input.runtime === current.runtime
              ? current.model
              : null
            : input.model;
      const fallbackModel =
        fallbackRuntime === null || fallbackModelProfile !== null
          ? null
          : input.fallbackModel === undefined
            ? fallbackRuntime === current.fallbackRuntime
              ? current.fallbackModel
              : null
            : input.fallbackModel;
      // p13-runtime-accounts: the engine's account and fallback account (absent = unchanged; another machine or runtime
      // resets them unless given again). Only accounts of that machine runtime; the fallback differs from the main one.
      const sameEngine = input.workerId === current.workerId && input.runtime === current.runtime;
      const account = input.account === undefined ? (sameEngine ? current.account : null) : input.account;
      if (account === AUTO_FALLBACK_ACCOUNT) {
        throw new HttpError(
          400,
          'account_not_found',
          'Choose an account (Automatic is only for the fallback).',
          {},
          {},
          { reason: 'auto_main' },
        );
      }
      let fallbackAccount =
        input.fallbackAccount === undefined
          ? sameEngine
            ? current.fallbackAccount
            : AUTO_FALLBACK_ACCOUNT
          : input.fallbackAccount;
      if ((fallbackAccount ?? null) !== null && fallbackAccount === (account ?? 'default')) {
        if (input.fallbackAccount !== undefined) {
          throw new HttpError(
            400,
            'fallback_same_account',
            'The fallback account must differ from the main account.',
          );
        }
        fallbackAccount = null;
      }
      for (const a of [account, fallbackAccount]) {
        if (a === null || a === 'default' || a === AUTO_FALLBACK_ACCOUNT) continue;
        if (input.workerId === null || (input.runtime !== 'claude-code' && input.runtime !== 'codex')) {
          throw new HttpError(
            400,
            'account_not_found',
            'Accounts exist for Claude Code and Codex on a chosen machine.',
          );
        }
        const { rows } = await tx.query(
          'SELECT 1 FROM runtime_accounts WHERE worker_id = $1 AND runtime = $2 AND account_id = $3',
          [input.workerId, input.runtime, a],
        );
        if (rows.length === 0)
          throw new HttpError(
            400,
            'account_not_found',
            `No account ${a} on that machine.`,
            {},
            {},
            { reason: 'missing', account: a },
          );
      }
      const now = this.deps.clock();
      await tx.query(
        `UPDATE chat_settings SET enabled = $1, worker_id = $2, runtime = $3, model_profile = $4, limits = $5,
                fallback_runtime = $8, fallback_model_profile = $9, account = $10, fallback_account = $11,
                backup_worker_ids = $12, model = $13, fallback_model = $14,
                version = version + 1, updated_by = $6, updated_at = $7 WHERE id = 1`,
        [
          input.enabled,
          input.workerId,
          input.runtime,
          input.modelProfile,
          JSON.stringify(limits),
          actor.userId,
          now,
          fallbackRuntime,
          fallbackModelProfile,
          account === 'default' ? null : account,
          fallbackAccount,
          backupWorkerIds,
          model,
          fallbackModel,
        ],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'chat.settings.update',
          target: 'chat:settings',
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: {
            enabled: input.enabled,
            workerId: input.workerId,
            runtime: input.runtime,
            modelProfile: input.modelProfile,
            fallbackRuntime,
            fallbackModelProfile,
            model,
            fallbackModel,
            account,
            fallbackAccount,
            backupWorkerIds,
            limits,
            killSwitch: current.enabled && !input.enabled,
          },
        },
        tx,
      );
      return this.get(tx);
    });
  }
}
