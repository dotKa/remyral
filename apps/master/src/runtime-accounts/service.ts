import { randomBytes } from 'node:crypto';
import {
  AccountLabel,
  AccountPolicy,
  type AccountRuntime,
  accountStoreId,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ACCOUNT_POLICY,
  MAX_ACCOUNTS_PER_RUNTIME,
  RUNTIME_ACCOUNTS_FEATURE,
  RuntimeAccountReport,
  type RuntimeUsageWindow,
  usageLevel,
  type UsageLevel,
} from '@remyral/protocol';
import type { JobAccountFacts, PlacementAccount } from '@remyral/scheduler';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { slotLease } from '../queue/facts.js';
import { effectivePolicy as usageLimitPolicy } from '../usage-limits/policy.js';
import {
  effectiveSnapshot,
  newestByIdentity,
  readingLimitUntil,
  type UsageSnapshotRow,
  windowsOf,
} from '../runtime-usage/identity.js';

/**
 * p13-runtime-accounts (docs/design/p13-runtime-accounts.md, ADR-0049): the master's view of the runtime accounts of the
 * machines — several Claude Code / Codex logins (or API keys) per machine runtime.
 *
 * The master keeps a label, the kind, an opaque id, the vault credential id of an API-key account, the pause state and
 * the login state the worker reported (the runtime's own status command) — never a token, an email or an identity.
 * The machine's configured runtime auth is the `default` account: synthesised from the worker's report until a person
 * renames / pauses / orders it (then stored), so nothing moves and nobody logs in again.
 *
 * Used by the routes (Machine → Runtimes), the worker configuration (`runtimes.<rt>.accounts` of the delivered
 * document), placement (facts and the job's selection facts), the usage-limit service (account-scoped limits and the
 * "same runtime, another account" fallback), the manual switch and the chat tools.
 */

export const ACCOUNT_RUNTIMES: readonly AccountRuntime[] = ['claude-code', 'codex'];
export const DEFAULT_LABEL = 'Varsayılan';

/** Vault credential kinds an API-key account of a runtime may use (the runtime's provider). */
const PROVIDER_KINDS: Readonly<Record<AccountRuntime, readonly string[]>> = {
  'claude-code': ['anthropic'],
  codex: ['openai'],
};

export type AccountState = 'logged_in' | 'needs_login' | 'paused' | 'limited' | 'unknown';

/** One account as the console, the chat tools and the scheduler see it. */
export interface RuntimeAccountView {
  readonly workerId: string;
  readonly workerName: string;
  readonly runtime: AccountRuntime;
  readonly id: string;
  readonly label: string;
  readonly kind: 'subscription' | 'api_key';
  readonly credentialId: string | null;
  readonly store: string | null;
  readonly isDefault: boolean;
  readonly position: number;
  readonly paused: boolean;
  readonly pausedReason: string | null;
  readonly login: {
    readonly status: 'logged_in' | 'logged_out' | 'expired' | 'unknown' | 'unsupported' | null;
    readonly reason: string | null;
    readonly checkedAt: string | null;
  };
  readonly state: AccountState;
  readonly limit: {
    readonly episodeId: string;
    readonly resetAt: string | null;
    readonly resumeAt: string;
  } | null;
  readonly usage: {
    readonly level: UsageLevel;
    readonly observedAt: string | null;
    readonly usedPercent: number | null;
    readonly windows: readonly (RuntimeUsageWindow & { readonly level: UsageLevel })[];
  } | null;
  /**
   * p15-usage-refresh: the account's newest reading (on any machine it is logged in on) says it is at its session /
   * weekly limit until then (null: not at the limit, or no such reading).
   */
  readonly limitedByReading: string | null;
  readonly running: number;
  readonly lendable: boolean;
  /** The machine advertises `runtime-accounts-v1` (added accounts, per-account login, jobs per account). */
  readonly supported: boolean;
  /** The worker reported this account (its configuration is applied there). */
  readonly reported: boolean;
}

export interface AccountActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface RuntimeAccountsDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  /** The worker configuration (a new generation with the added accounts, delivered). Absent: not synchronised. */
  readonly syncConfig?: (workerId: string, actor: AccountActor | null, note: string) => Promise<void>;
  /** Whether the machine has a panel configuration (added accounts are delivered in it). Absent: assumed. */
  readonly managed?: (workerId: string) => Promise<boolean>;
}

interface Row {
  worker_id: string;
  runtime: AccountRuntime;
  account_id: string;
  label: string;
  kind: 'subscription' | 'api_key';
  credential_id: string | null;
  position: number;
  is_default: boolean;
  paused: boolean;
  paused_reason: string | null;
  login_status: RuntimeAccountView['login']['status'];
  login_reason: string | null;
  login_checked_at: Date | null;
}

interface WorkerRow {
  id: string;
  name: string;
  features: unknown;
  runtime_accounts: unknown;
  config_report: unknown;
  remote_ops: unknown;
}

interface EpisodeRow {
  id: string;
  worker_id: string | null;
  runtime: string;
  runtime_account: string | null;
  pause_scope: string;
  credential_key: string | null;
  model: string | null;
  reset_at: Date | null;
  resume_at: Date;
}

const ReportList = z.array(RuntimeAccountReport);

/** Usage per login; `identity`: the provider account (p15-usage-refresh). */
type UsageByLogin = Map<string, { windows: RuntimeUsageWindow[]; observedAt: Date; identity: string | null }>;
const LoginList = z.array(
  z.object({
    runtime: z.string(),
    status: z.string(),
    reason: z.string().optional(),
    checkedAt: z.string().optional(),
  }),
);

function features(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** The configured auth mode / vault credential of each runtime from the worker's config report. */
function configuredAuth(
  report: unknown,
): Partial<Record<AccountRuntime, { mode: 'local-login' | 'secret-ref'; credential?: string }>> {
  const out: Partial<Record<AccountRuntime, { mode: 'local-login' | 'secret-ref'; credential?: string }>> =
    {};
  const eff = (report as { effective?: { runtimeAuth?: unknown; runtimes?: unknown } } | null)?.effective;
  const modes = (eff?.runtimeAuth ?? {}) as Record<string, unknown>;
  const runtimes = (eff?.runtimes ?? {}) as Record<
    string,
    { auth?: { source?: unknown; credential?: unknown } }
  >;
  for (const r of ACCOUNT_RUNTIMES) {
    const m = modes[r];
    if (m !== 'local-login' && m !== 'secret-ref') continue;
    const auth = runtimes[r]?.auth;
    const credential =
      auth?.source === 'vault' && typeof auth.credential === 'string' ? auth.credential : undefined;
    out[r] = { mode: m, ...(credential === undefined ? {} : { credential }) };
  }
  return out;
}

function newAccountId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(7);
  let id = 'a';
  for (const b of bytes) id += alphabet[b % 32] ?? 'a';
  return id;
}

function loginState(status: RuntimeAccountView['login']['status']): 'ok' | 'needs_login' | 'unknown' {
  if (status === 'logged_in') return 'ok';
  if (status === 'logged_out' || status === 'expired') return 'needs_login';
  return 'unknown';
}

export class RuntimeAccountError extends HttpError {}

export class RuntimeAccountService {
  constructor(private readonly deps: RuntimeAccountsDeps) {}

  // ------------------------------------------------------------------------------------------------ reading

  /** Every account of the given machines (all machines when absent), best first per machine runtime. */
  async list(
    filter: { readonly workerIds?: readonly string[]; readonly runtime?: string } = {},
    model?: string,
  ): Promise<{
    accounts: RuntimeAccountView[];
    workers: { id: string; name: string; supported: boolean }[];
  }> {
    const now = this.deps.clock();
    const workers = await this.#workers(filter.workerIds);
    if (workers.length === 0) return { accounts: [], workers: [] };
    const ids = workers.map((w) => w.id);
    const [rows, episodes, usage, running] = await Promise.all([
      this.#rows(this.deps.pool, ids),
      this.#episodes(now),
      this.#usage(ids),
      this.#running(ids),
    ]);
    const accounts: RuntimeAccountView[] = [];
    for (const w of workers) {
      for (const runtime of ACCOUNT_RUNTIMES) {
        if (filter.runtime !== undefined && filter.runtime !== runtime) continue;
        accounts.push(...this.#resolve(w, runtime, rows, episodes, usage, running, now, model));
      }
    }
    return {
      accounts,
      workers: workers.map((w) => ({
        id: w.id,
        name: w.name,
        supported: features(w.features).includes(RUNTIME_ACCOUNTS_FEATURE),
      })),
    };
  }

  /** One account (null: no such account on that machine runtime). */
  async get(workerId: string, runtime: string, account: string): Promise<RuntimeAccountView | null> {
    const { accounts } = await this.list({ workerIds: [workerId], runtime });
    return accounts.find((a) => a.id === account) ?? null;
  }

  /**
   * Placement facts: per supported machine, runtime → its accounts (`model`: a model-scoped limit holds only jobs of
   * that model). Machines without `runtime-accounts-v1` are absent (the per-runtime rules apply to them).
   */
  async facts(
    workerIds: readonly string[],
    model?: string,
  ): Promise<Map<string, Partial<Record<AccountRuntime, PlacementAccount[]>>>> {
    const out = new Map<string, Partial<Record<AccountRuntime, PlacementAccount[]>>>();
    if (workerIds.length === 0) return out;
    const { accounts } = await this.list({ workerIds }, model);
    for (const a of accounts) {
      if (!a.supported || !a.reported) continue;
      const m = out.get(a.workerId) ?? {};
      const list = m[a.runtime] ?? [];
      list.push({
        id: a.id,
        kind: a.kind,
        ...(a.store === null ? {} : { store: a.store }),
        lendable: a.lendable,
        isDefault: a.isDefault,
        position: a.position,
        login: loginState(a.login.status),
        paused: a.paused,
        ...(a.limit !== null
          ? { limitedUntil: a.limit.resumeAt }
          : a.limitedByReading !== null
            ? { limitedUntil: a.limitedByReading }
            : {}),
        usedPercent: a.usage?.usedPercent ?? null,
        active: a.running,
        label: a.label,
      });
      m[a.runtime] = list;
      out.set(a.workerId, m);
    }
    return out;
  }

  /** The job's account selection facts (design §3): policy, paid switch, pin, exclusions. */
  async jobFacts(
    job: { readonly id: string; readonly project: string },
    opts: {
      readonly fallback: boolean;
      readonly exclude?: readonly { readonly workerId: string; readonly account: string }[];
      readonly pin?: { readonly workerId: string; readonly account: string } | null;
    },
    db: Queryable = this.deps.pool,
  ): Promise<JobAccountFacts> {
    const policy = (await this.effectivePolicy(job.project, db)).policy;
    const paid = (await usageLimitPolicy(db, job.project)).policy.allowPaidFallback;
    let pin = opts.pin ?? null;
    if (opts.pin === undefined) {
      const { rows } = await db.query<{ account_pin: { workerId?: unknown; account?: unknown } | null }>(
        'SELECT account_pin FROM jobs WHERE id = $1',
        [job.id],
      );
      const p = rows[0]?.account_pin;
      pin =
        p !== null && p !== undefined && typeof p.workerId === 'string' && typeof p.account === 'string'
          ? { workerId: p.workerId, account: p.account }
          : null;
    }
    return {
      allowPaid: paid,
      fallback: opts.fallback,
      ...(pin === null ? {} : { pin }),
      ...(opts.exclude === undefined || opts.exclude.length === 0 ? {} : { exclude: opts.exclude }),
      strategy: policy.strategy,
      order: policy.order,
      skipPercent: policy.skipPercent,
    };
  }

  /** Whether a machine runs jobs with accounts (`runtime-accounts-v1`). */
  async supported(workerId: string, db: Queryable = this.deps.pool): Promise<boolean> {
    const { rows } = await db.query<{ ok: boolean }>(
      'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
      [workerId, RUNTIME_ACCOUNTS_FEATURE],
    );
    return rows[0]?.ok === true;
  }

  /** The added accounts of a machine runtime as the delivered configuration carries them. */
  async documentAccounts(
    db: Queryable,
    workerId: string,
  ): Promise<
    Partial<
      Record<AccountRuntime, { id: string; kind: 'subscription' | 'api_key'; credentialId: string | null }[]>
    >
  > {
    const rows = await this.#rows(db, [workerId]);
    const out: Partial<
      Record<AccountRuntime, { id: string; kind: 'subscription' | 'api_key'; credentialId: string | null }[]>
    > = {};
    for (const r of rows) {
      if (r.account_id === DEFAULT_ACCOUNT_ID) continue;
      const list = out[r.runtime] ?? [];
      list.push({ id: r.account_id, kind: r.kind, credentialId: r.credential_id });
      out[r.runtime] = list;
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ writes

  async create(
    workerId: string,
    input: {
      readonly runtime: string;
      readonly label: string;
      readonly kind: string;
      readonly credentialId?: string | null | undefined;
    },
    actor: AccountActor,
  ): Promise<RuntimeAccountView> {
    const runtime = this.#runtime(input.runtime);
    const label = this.#label(input.label);
    const kind = input.kind === 'subscription' || input.kind === 'api_key' ? input.kind : null;
    if (kind === null) throw new RuntimeAccountError(400, 'invalid_kind', 'kind is subscription or api_key.');
    const now = this.deps.clock();
    const id = await withTransaction(this.deps.pool, async (tx) => {
      const w = await this.#lockWorker(tx, workerId);
      if (!features(w.features).includes(RUNTIME_ACCOUNTS_FEATURE)) {
        throw new RuntimeAccountError(
          409,
          'worker_update_required',
          'This machine needs a newer worker release for several accounts (runtime-accounts-v1).',
        );
      }
      if (this.deps.managed !== undefined && !(await this.deps.managed(workerId))) {
        throw new RuntimeAccountError(
          409,
          'worker_unmanaged',
          'Added accounts travel in the machine’s panel configuration: take the configuration over first (Machine → Configuration).',
        );
      }
      const existing = (await this.#rows(tx, [workerId])).filter(
        (r) => r.runtime === runtime && r.account_id !== DEFAULT_ACCOUNT_ID,
      );
      if (existing.length >= MAX_ACCOUNTS_PER_RUNTIME) {
        throw new RuntimeAccountError(
          409,
          'too_many_accounts',
          `A machine runtime has at most ${String(MAX_ACCOUNTS_PER_RUNTIME)} added accounts.`,
        );
      }
      let credentialId: string | null = null;
      if (kind === 'api_key')
        credentialId = await this.#checkCredential(tx, workerId, runtime, input.credentialId);
      let accountId = newAccountId();
      while (existing.some((r) => r.account_id === accountId)) accountId = newAccountId();
      const position = existing.reduce((m, r) => Math.max(m, r.position), 0) + 1;
      await tx.query(
        `INSERT INTO runtime_accounts (worker_id, runtime, account_id, label, kind, credential_id, position, created_by,
                                       created_at, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, $9)`,
        [workerId, runtime, accountId, label, kind, credentialId, Math.min(position, 99), actor.userId, now],
      );
      await this.#audit(tx, actor, 'runtime_account.create', workerId, {
        runtime,
        account: accountId,
        kind,
        label,
        ...(credentialId === null ? {} : { credentialId }),
      });
      return accountId;
    });
    await this.deps.syncConfig?.(workerId, actor, `account ${id} added (${runtime})`);
    const view = await this.get(workerId, runtime, id);
    if (view === null) throw new RuntimeAccountError(500, 'account_missing', 'The account was not stored.');
    return view;
  }

  async update(
    workerId: string,
    runtimeIn: string,
    account: string,
    patch: {
      readonly label?: string | undefined;
      readonly paused?: boolean | undefined;
      readonly pausedReason?: string | null | undefined;
      readonly isDefault?: boolean | undefined;
      readonly position?: number | undefined;
    },
    actor: AccountActor,
  ): Promise<RuntimeAccountView> {
    const runtime = this.#runtime(runtimeIn);
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      await this.#lockWorker(tx, workerId);
      const current = await this.get(workerId, runtime, account);
      if (current === null) throw new RuntimeAccountError(404, 'account_not_found', 'No such account.');
      // The default account's row exists once a person changed it.
      if (account === DEFAULT_ACCOUNT_ID) {
        await tx.query(
          `INSERT INTO runtime_accounts (worker_id, runtime, account_id, label, kind, position, is_default, created_by,
                                         created_at, updated_by, updated_at)
           VALUES ($1, $2, 'default', $3, $4, 0, $5, $6, $7, $6, $7) ON CONFLICT DO NOTHING`,
          [workerId, runtime, current.label, current.kind, current.isDefault, actor.userId, now],
        );
      }
      const changes: Record<string, unknown> = {};
      if (patch.label !== undefined) {
        const label = this.#label(patch.label);
        await tx.query(
          `UPDATE runtime_accounts SET label = $4, updated_by = $5, updated_at = $6
            WHERE worker_id = $1 AND runtime = $2 AND account_id = $3`,
          [workerId, runtime, account, label, actor.userId, now],
        );
        changes.label = { before: current.label, after: label };
      }
      if (patch.paused !== undefined && patch.paused !== current.paused) {
        const reason = patch.pausedReason ?? null;
        if (reason !== null && (reason.length > 200 || /\p{Cc}/u.test(reason))) {
          throw new RuntimeAccountError(
            400,
            'invalid_reason',
            'The reason is one line of at most 200 characters.',
          );
        }
        await tx.query(
          `UPDATE runtime_accounts SET paused = $4, paused_reason = $5, paused_by = $6, paused_at = $7, updated_by = $6,
                  updated_at = $7
            WHERE worker_id = $1 AND runtime = $2 AND account_id = $3`,
          [workerId, runtime, account, patch.paused, patch.paused ? reason : null, actor.userId, now],
        );
        await this.#audit(
          tx,
          actor,
          patch.paused ? 'runtime_account.pause' : 'runtime_account.resume',
          workerId,
          {
            runtime,
            account,
            ...(reason === null || !patch.paused ? {} : { reason }),
          },
        );
      }
      if (patch.isDefault === true && !current.isDefault) {
        // The default row must exist to be cleared; then exactly one default per machine runtime.
        await tx.query(
          `INSERT INTO runtime_accounts (worker_id, runtime, account_id, label, kind, position, is_default, created_by,
                                         created_at, updated_by, updated_at)
           SELECT $1, $2, 'default', $3, $4, 0, false, $5, $6, $5, $6
            WHERE NOT EXISTS (SELECT 1 FROM runtime_accounts WHERE worker_id = $1 AND runtime = $2 AND account_id = 'default')`,
          [workerId, runtime, DEFAULT_LABEL, 'subscription', actor.userId, now],
        );
        await tx.query(
          'UPDATE runtime_accounts SET is_default = false WHERE worker_id = $1 AND runtime = $2 AND is_default',
          [workerId, runtime],
        );
        await tx.query(
          `UPDATE runtime_accounts SET is_default = true, updated_by = $4, updated_at = $5
            WHERE worker_id = $1 AND runtime = $2 AND account_id = $3`,
          [workerId, runtime, account, actor.userId, now],
        );
        await this.#audit(tx, actor, 'runtime_account.default', workerId, { runtime, account });
      }
      if (patch.position !== undefined) {
        if (!Number.isInteger(patch.position) || patch.position < 0 || patch.position > 99) {
          throw new RuntimeAccountError(400, 'invalid_position', 'position is 0–99.');
        }
        await tx.query(
          `UPDATE runtime_accounts SET position = $4, updated_by = $5, updated_at = $6
            WHERE worker_id = $1 AND runtime = $2 AND account_id = $3`,
          [workerId, runtime, account, patch.position, actor.userId, now],
        );
        changes.position = { before: current.position, after: patch.position };
      }
      if (Object.keys(changes).length > 0) {
        await this.#audit(tx, actor, 'runtime_account.update', workerId, { runtime, account, ...changes });
      }
    });
    const view = await this.get(workerId, runtime, account);
    if (view === null) throw new RuntimeAccountError(404, 'account_not_found', 'No such account.');
    return view;
  }

  async remove(workerId: string, runtimeIn: string, account: string, actor: AccountActor): Promise<void> {
    const runtime = this.#runtime(runtimeIn);
    if (account === DEFAULT_ACCOUNT_ID) {
      throw new RuntimeAccountError(
        409,
        'default_account',
        "The machine's configured login cannot be removed here; change it in Configuration or log it out.",
      );
    }
    await withTransaction(this.deps.pool, async (tx) => {
      await this.#lockWorker(tx, workerId);
      const { rows } = await tx.query<{ label: string; kind: string; is_default: boolean }>(
        `DELETE FROM runtime_accounts WHERE worker_id = $1 AND runtime = $2 AND account_id = $3
         RETURNING label, kind, is_default`,
        [workerId, runtime, account],
      );
      const r = rows[0];
      if (r === undefined) throw new RuntimeAccountError(404, 'account_not_found', 'No such account.');
      // Removing the account a machine treated as its default hands that role back to the configured login.
      if (r.is_default) {
        await tx.query(
          `UPDATE runtime_accounts SET is_default = true WHERE worker_id = $1 AND runtime = $2 AND account_id = 'default'`,
          [workerId, runtime],
        );
      }
      // Jobs pinned to it lose the pin (they run with the strategy again).
      await tx.query(
        `UPDATE jobs SET account_pin = NULL, version = version + 1, updated_at = now()
          WHERE account_pin->>'workerId' = $1 AND account_pin->>'runtime' = $2 AND account_pin->>'account' = $3
            AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`,
        [workerId, runtime, account],
      );
      await this.#audit(tx, actor, 'runtime_account.remove', workerId, {
        runtime,
        account,
        kind: r.kind,
        label: r.label,
      });
    });
    await this.deps.syncConfig?.(workerId, actor, `account ${account} removed (${runtime})`);
  }

  // ------------------------------------------------------------------------------------------------ policy

  async defaults(db: Queryable = this.deps.pool): Promise<{ policy: AccountPolicy; updatedAt: Date | null }> {
    const { rows } = await db.query<{ policy: unknown; updated_at: Date }>(
      'SELECT policy, updated_at FROM runtime_account_defaults WHERE id = 1',
    );
    const parsed = AccountPolicy.safeParse(rows[0]?.policy);
    return {
      policy: parsed.success ? parsed.data : DEFAULT_ACCOUNT_POLICY,
      updatedAt: rows[0]?.updated_at ?? null,
    };
  }

  async projectPolicy(
    project: string,
    db: Queryable = this.deps.pool,
  ): Promise<{ policy: AccountPolicy | null; updatedAt: Date | null } | undefined> {
    const { rows } = await db.query<{ account_policy: unknown; account_policy_updated_at: Date | null }>(
      'SELECT account_policy, account_policy_updated_at FROM projects WHERE id = $1',
      [project],
    );
    const r = rows[0];
    if (r === undefined) return undefined;
    const parsed = r.account_policy === null ? null : AccountPolicy.safeParse(r.account_policy);
    return {
      policy: parsed === null || !parsed.success ? null : parsed.data,
      updatedAt: r.account_policy_updated_at,
    };
  }

  async effectivePolicy(
    project: string,
    db: Queryable = this.deps.pool,
  ): Promise<{ policy: AccountPolicy; source: 'project' | 'default' }> {
    const own = await this.projectPolicy(project, db);
    if (own?.policy !== null && own?.policy !== undefined) return { policy: own.policy, source: 'project' };
    return { policy: (await this.defaults(db)).policy, source: 'default' };
  }

  async saveDefaults(input: unknown, actor: AccountActor): Promise<AccountPolicy> {
    const policy = this.#policy(input);
    await withTransaction(this.deps.pool, async (tx) => {
      const before = await this.defaults(tx);
      await tx.query(
        `INSERT INTO runtime_account_defaults (id, policy, updated_by, updated_at) VALUES (1, $1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET policy = EXCLUDED.policy, updated_by = EXCLUDED.updated_by,
                                        updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(policy), actor.userId, this.deps.clock()],
      );
      await this.#audit(tx, actor, 'runtime_account.policy.update', 'runtime-accounts:defaults', {
        before: before.policy,
        after: policy,
      });
    });
    return policy;
  }

  async saveProjectPolicy(
    project: string,
    input: unknown,
    actor: AccountActor,
  ): Promise<AccountPolicy | null> {
    const policy = input === null ? null : this.#policy(input);
    await withTransaction(this.deps.pool, async (tx) => {
      const before = await this.projectPolicy(project, tx);
      if (before === undefined) throw new RuntimeAccountError(404, 'project_not_found', 'Project not found.');
      await tx.query(
        `UPDATE projects SET account_policy = $2, account_policy_updated_by = $3, account_policy_updated_at = $4
          WHERE id = $1`,
        [project, policy === null ? null : JSON.stringify(policy), actor.userId, this.deps.clock()],
      );
      await this.#audit(tx, actor, 'project.account_policy.update', `project:${project}`, {
        before: before.policy,
        after: policy,
      });
    });
    return policy;
  }

  // ------------------------------------------------------------------------------------------------ internals

  #runtime(value: string): AccountRuntime {
    if (value !== 'claude-code' && value !== 'codex') {
      throw new RuntimeAccountError(400, 'invalid_runtime', 'Accounts exist for Claude Code and Codex.');
    }
    return value;
  }

  #label(value: string): string {
    const r = AccountLabel.safeParse(value);
    if (!r.success) {
      throw new RuntimeAccountError(400, 'invalid_label', 'A label is one line of 1–64 characters.');
    }
    return r.data;
  }

  #policy(input: unknown): AccountPolicy {
    const r = AccountPolicy.safeParse(input);
    if (!r.success) {
      const first = r.error.issues[0];
      throw new RuntimeAccountError(
        400,
        'invalid_policy',
        `Invalid account policy${first === undefined ? '' : ` at ${first.path.join('.') || 'policy'}: ${first.message}`}.`,
      );
    }
    return r.data;
  }

  async #checkCredential(
    tx: Queryable,
    workerId: string,
    runtime: AccountRuntime,
    credentialId: string | null | undefined,
  ): Promise<string> {
    if (credentialId === null || credentialId === undefined) {
      throw new RuntimeAccountError(
        400,
        'credential_required',
        'An API-key account needs a vault credential.',
      );
    }
    const { rows } = await tx.query<{ kind: string; state: string; shared: boolean }>(
      `SELECT c.kind, c.state,
              EXISTS (SELECT 1 FROM vault_credential_workers x WHERE x.credential_id = c.id AND x.worker_id = $2
                        AND x.state = 'active') AS shared
         FROM vault_credentials c WHERE c.id = $1`,
      [credentialId, workerId],
    );
    const c = rows[0];
    if (c === undefined || c.state !== 'active') {
      throw new RuntimeAccountError(404, 'credential_not_found', 'No such active vault credential.');
    }
    if (!PROVIDER_KINDS[runtime].includes(c.kind)) {
      throw new RuntimeAccountError(
        400,
        'credential_wrong_provider',
        runtime === 'claude-code'
          ? 'Claude Code accounts use an Anthropic API key.'
          : 'Codex accounts use an OpenAI API key.',
      );
    }
    if (!c.shared) {
      throw new RuntimeAccountError(
        409,
        'credential_not_shared',
        'The credential is not sealed to this machine yet: add the machine to it in Settings → Credentials first.',
      );
    }
    return credentialId;
  }

  async #lockWorker(tx: Queryable, workerId: string): Promise<WorkerRow> {
    const { rows } = await tx.query<WorkerRow>(
      `SELECT id, COALESCE(display_name, id) AS name, features, runtime_accounts, config_report, remote_ops
         FROM workers WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
      [workerId],
    );
    const w = rows[0];
    if (w === undefined) throw new RuntimeAccountError(404, 'worker_not_found', 'Machine not found.');
    return w;
  }

  async #audit(
    tx: Queryable,
    actor: AccountActor,
    action: string,
    target: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actor: { type: 'user', id: actor.userId },
        action,
        target:
          target.startsWith('runtime-accounts:') || target.startsWith('project:')
            ? target
            : `worker:${target}`,
        outcome: 'success',
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata,
      },
      tx,
    );
  }

  async #workers(ids?: readonly string[]): Promise<WorkerRow[]> {
    const { rows } = await this.deps.pool.query<WorkerRow>(
      `SELECT id, COALESCE(display_name, id) AS name, features, runtime_accounts, config_report, remote_ops
         FROM workers WHERE archived_at IS NULL AND state <> 'pending' AND ($1::text[] IS NULL OR id = ANY($1))
        ORDER BY COALESCE(display_name, id)`,
      [ids === undefined ? null : [...ids]],
    );
    return rows;
  }

  async #rows(db: Queryable, ids: readonly string[]): Promise<Row[]> {
    const { rows } = await db.query<Row>(
      `SELECT worker_id, runtime, account_id, label, kind, credential_id, position, is_default, paused, paused_reason,
              login_status, login_reason, login_checked_at
         FROM runtime_accounts WHERE worker_id = ANY($1) ORDER BY worker_id, runtime, position, account_id`,
      [[...ids]],
    );
    return rows;
  }

  async #episodes(now: Date): Promise<EpisodeRow[]> {
    const { rows } = await this.deps.pool.query<EpisodeRow>(
      `SELECT id, worker_id, runtime, runtime_account, pause_scope, credential_key, model, reset_at, resume_at
         FROM usage_limit_episodes WHERE ended_at IS NULL AND resume_at > $1`,
      [now],
    );
    return rows;
  }

  /**
   * Usage per login (`worker \0 runtime \0 auth \0 account`). p15-usage-refresh: a login with a known provider account
   * gets the newest reading of that account on any machine, and `identity` names the account (also for logins of
   * other machines, so their limit hits hold this one too).
   */
  async #usage(ids: readonly string[]): Promise<UsageByLogin> {
    const { rows } = await this.deps.pool.query<UsageSnapshotRow>(
      `SELECT worker_id, runtime, auth, account, windows, observed_at, identity_key, identity_hint
         FROM runtime_usage_snapshots WHERE worker_id = ANY($1) OR identity_key IS NOT NULL`,
      [[...ids]],
    );
    const newest = newestByIdentity(rows);
    const out: UsageByLogin = new Map();
    for (const r of rows) {
      const eff = effectiveSnapshot(r, newest);
      out.set(`${r.worker_id}\u0000${r.runtime}\u0000${r.auth}\u0000${r.account}`, {
        windows: windowsOf(eff.windows),
        observedAt: eff.observed_at,
        identity: r.auth === 'subscription' ? r.identity_key : null,
      });
    }
    return out;
  }

  async #running(ids: readonly string[]): Promise<Map<string, number>> {
    const { rows } = await this.deps.pool.query<{
      worker_id: string;
      runtime: string;
      account: string;
      n: number;
    }>(
      `SELECT l.worker_id, COALESCE(r.runtime_choice->>'runtime', j.spec->>'runtime') AS runtime,
              COALESCE(r.runtime_choice->>'account', 'default') AS account, count(*)::int AS n
         FROM leases l JOIN jobs j ON j.id = l.job_id LEFT JOIN job_runs r ON r.attempt_id = l.attempt_id
        WHERE l.worker_id = ANY($1) AND ${slotLease('l', 'j')}
        GROUP BY 1, 2, 3`,
      [[...ids]],
    );
    return new Map(rows.map((r) => [`${r.worker_id}\u0000${r.runtime}\u0000${r.account}`, r.n]));
  }

  #resolve(
    w: WorkerRow,
    runtime: AccountRuntime,
    rows: readonly Row[],
    episodes: readonly EpisodeRow[],
    usage: UsageByLogin,
    running: Map<string, number>,
    now: Date,
    model: string | undefined,
  ): RuntimeAccountView[] {
    const supported = features(w.features).includes(RUNTIME_ACCOUNTS_FEATURE);
    const reportedList = (() => {
      const r = ReportList.safeParse(w.runtime_accounts);
      return r.success ? r.data.filter((a) => a.runtime === runtime) : [];
    })();
    const mine = rows.filter((r) => r.worker_id === w.id && r.runtime === runtime);
    const configured = configuredAuth(w.config_report)[runtime];
    const legacyLogin = (() => {
      const r = LoginList.safeParse((w.remote_ops as { login?: unknown } | null)?.login);
      return r.success ? r.data.find((l) => l.runtime === runtime) : undefined;
    })();
    const ids: string[] = [];
    const repDefault = reportedList.find((a) => a.id === DEFAULT_ACCOUNT_ID);
    if (
      repDefault !== undefined ||
      (!supported && configured !== undefined) ||
      mine.some((r) => r.account_id === DEFAULT_ACCOUNT_ID)
    ) {
      ids.push(DEFAULT_ACCOUNT_ID);
    }
    for (const r of mine) if (r.account_id !== DEFAULT_ACCOUNT_ID) ids.push(r.account_id);
    const anyDefaultFlag = mine.some((r) => r.is_default);
    const out: RuntimeAccountView[] = [];
    for (const id of ids) {
      const row = mine.find((r) => r.account_id === id);
      const rep = reportedList.find((a) => a.id === id);
      const isDefaultAccount = id === DEFAULT_ACCOUNT_ID;
      const kind: 'subscription' | 'api_key' =
        rep?.kind ??
        (isDefaultAccount
          ? configured?.mode === 'secret-ref'
            ? 'api_key'
            : 'subscription'
          : (row?.kind ?? 'subscription'));
      const credentialId = isDefaultAccount ? (configured?.credential ?? null) : (row?.credential_id ?? null);
      const status: RuntimeAccountView['login']['status'] =
        kind === 'api_key'
          ? rep?.ready === true
            ? 'logged_in'
            : rep?.ready === false
              ? 'logged_out'
              : null
          : (rep?.login ??
            row?.login_status ??
            (isDefaultAccount && legacyLogin !== undefined
              ? (legacyLogin.status as RuntimeAccountView['login']['status'])
              : null));
      const reason =
        rep?.reason ?? row?.login_reason ?? (isDefaultAccount ? (legacyLogin?.reason ?? null) : null);
      const checkedAt =
        rep?.checkedAt ??
        row?.login_checked_at?.toISOString() ??
        (isDefaultAccount ? (legacyLogin?.checkedAt ?? null) : null);
      const snap = usage.get(
        `${w.id}\u0000${runtime}\u0000${kind === 'api_key' ? 'api_key' : 'subscription'}\u0000${id}`,
      );
      const identity = snap?.identity ?? null;
      const episode = episodes.find((e) => {
        if (e.model !== null && model !== undefined && e.model !== model) return false;
        if (e.model !== null && model === undefined) return false;
        if (kind === 'api_key' && credentialId !== null && e.credential_key === `vault:${credentialId}`)
          return true;
        if (e.runtime !== runtime || e.pause_scope !== 'worker_runtime' || e.worker_id === null) return false;
        if (e.worker_id === w.id && (e.runtime_account ?? DEFAULT_ACCOUNT_ID) === id) return true;
        // p15-usage-refresh: a hit of the same provider account on another login (another machine) holds this one.
        if (identity === null || kind !== 'subscription') return false;
        const other = usage.get(
          `${e.worker_id}\u0000${runtime}\u0000subscription\u0000${e.runtime_account ?? DEFAULT_ACCOUNT_ID}`,
        );
        return other?.identity === identity;
      });
      const windows = (snap?.windows ?? []).map((x) => ({ ...x, level: usageLevel(x) }));
      const used = windows.reduce<number | null>(
        (m, x) => (x.usedPercent === null ? m : Math.max(m ?? 0, x.usedPercent)),
        null,
      );
      const level = windows.reduce<UsageLevel>(
        (l, x) => (rankLevel(x.level) > rankLevel(l) ? x.level : l),
        'unknown',
      );
      const paused = row?.paused === true;
      const limitView =
        episode === undefined
          ? null
          : {
              episodeId: episode.id,
              resetAt: episode.reset_at?.toISOString() ?? null,
              resumeAt: episode.resume_at.toISOString(),
            };
      const limitedByReading =
        kind === 'subscription' && snap !== undefined ? readingLimitUntil(snap.windows, now) : null;
      const state: AccountState = paused
        ? 'paused'
        : limitView !== null || limitedByReading !== null
          ? 'limited'
          : loginState(status) === 'needs_login'
            ? 'needs_login'
            : loginState(status) === 'ok'
              ? 'logged_in'
              : 'unknown';
      out.push({
        workerId: w.id,
        workerName: w.name,
        runtime,
        id,
        label: row?.label ?? (isDefaultAccount ? DEFAULT_LABEL : id),
        kind,
        credentialId,
        store: kind === 'subscription' ? (rep?.store ?? accountStoreId(runtime, id)) : null,
        isDefault: anyDefaultFlag ? row?.is_default === true : isDefaultAccount,
        position: row?.position ?? (isDefaultAccount ? 0 : 1),
        paused,
        pausedReason: row?.paused_reason ?? null,
        login: { status, reason, checkedAt },
        state,
        limit: limitView,
        usage:
          snap === undefined
            ? null
            : { level, observedAt: snap.observedAt.toISOString(), usedPercent: used, windows },
        limitedByReading,
        running: running.get(`${w.id}\u0000${runtime}\u0000${id}`) ?? 0,
        lendable: rep?.lendable === true,
        supported,
        reported: rep !== undefined,
      });
    }
    return out;
  }
}

function rankLevel(l: UsageLevel): number {
  return l === 'limited' ? 3 : l === 'near' ? 2 : l === 'ok' ? 1 : 0;
}
