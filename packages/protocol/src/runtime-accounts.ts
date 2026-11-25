import { z } from 'zod';
import { Timestamp } from './common.js';
import { LoginStoreId } from './queue.js';
import { LoginStatus } from './remote-ops.js';
import { AccountRef, AccountRuntime, RuntimeAccountId, RuntimeAccountKind } from './runtime-account-ids.js';

export * from './runtime-account-ids.js';

/**
 * p13-runtime-accounts (docs/design/p13-runtime-accounts.md, ADR-0049): several Claude Code / Codex accounts per machine
 * — subscription logins in their own config dirs on the worker, or API keys from the vault — and how the scheduler picks
 * one. Additive in protocol 1.0, with the worker feature `runtime-accounts-v1`:
 *
 * - APPLY_WORKER_CONFIG `runtimes.<rt>.accounts` (worker-config.ts): the added accounts (id, kind, vault credential);
 * - CAPABILITIES `runtimeAccounts`: every account the worker has, with its login state (never an identity);
 * - OPS_COMMAND `login.start/status/logout {account}`: the login relay for one account;
 * - ASSIGN_JOB `execution.account`: the account an attempt runs with;
 * - HEARTBEAT `runtimeUsage[].account`, ASSISTANT_TURN `account`, PAUSE_JOB `cause: "account_switch"`.
 */

/** CAPABILITIES `runtimeAccounts[]`: one account as the worker has it. Values only; no identity, no token. */
export const RuntimeAccountReport = z.object({
  runtime: AccountRuntime,
  id: RuntimeAccountId,
  kind: RuntimeAccountKind,
  /** Subscription accounts: the login store (`claude`, `claude-a1b2c3d4`, …). */
  store: LoginStoreId.optional(),
  /** Subscription accounts: the runtime's own status command (ADR-0014 rule 4); API keys: absent. */
  login: LoginStatus.optional(),
  /** Why the login is not usable (`login_expired`, `login_refresh_contention`, `login_unverified`). */
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  checkedAt: Timestamp.optional(),
  /** API keys: the vault credential is held on the worker (its current version). */
  ready: z.boolean().optional(),
  /**
   * The account's attempts run on a per-job Windows account (its folder is lent to that attempt): they may run beside
   * unrelated jobs. Absent / false: a subscription attempt runs as the worker account (ADR-0034 addendum 7a).
   */
  lendable: z.boolean().optional(),
});
export type RuntimeAccountReport = z.infer<typeof RuntimeAccountReport>;

export const MAX_ACCOUNT_REPORTS = 32;
export const RuntimeAccountsReport = z.array(RuntimeAccountReport).max(MAX_ACCOUNT_REPORTS);
export type RuntimeAccountsReport = z.infer<typeof RuntimeAccountsReport>;

/** ASSIGN_JOB `execution.account`: run the attempt with this account (only to `runtime-accounts-v1` workers). */
export const AssignedAccount = z.object({
  id: RuntimeAccountId,
  kind: RuntimeAccountKind,
});
export type AssignedAccount = z.infer<typeof AssignedAccount>;

// ------------------------------------------------------------------------------------------------ policy

/**
 * How the scheduler picks an account (default `balanced`): `balanced` — spread jobs over the
 * accounts (fewest running, then least used); `fill_first` — use the accounts in the given order, the next only when
 * the earlier ones are busy, near their limit or limited; `least_used` — the account with the lowest usage first.
 */
export const AccountStrategy = z.enum(['balanced', 'fill_first', 'least_used']);
export type AccountStrategy = z.infer<typeof AccountStrategy>;

export const ACCOUNT_POLICY_BOUNDS = { minSkipPercent: 50, maxSkipPercent: 100, maxOrder: 64 } as const;

/**
 * Account selection policy: workspace default, overridable per project. The paid switch is the usage-limit policy's
 * `allowPaidFallback` (ADR-0040), authoritative for accounts too (ADR-0049).
 */
export const AccountPolicy = z
  .object({
    strategy: AccountStrategy,
    /** Preferred order (`fill_first`; a tie-breaker otherwise). Accounts not listed come after. */
    order: z.array(AccountRef).max(ACCOUNT_POLICY_BOUNDS.maxOrder),
    /**
     * An account whose fullest usage window is at or above this share is used only when no other account is left
     * (100 = never skipped).
     */
    skipPercent: z
      .number()
      .int()
      .min(ACCOUNT_POLICY_BOUNDS.minSkipPercent)
      .max(ACCOUNT_POLICY_BOUNDS.maxSkipPercent),
  })
  .strict()
  .refine((p) => new Set(p.order).size === p.order.length, {
    message: 'an account is listed once',
    path: ['order'],
  });
export type AccountPolicy = z.infer<typeof AccountPolicy>;

export const DEFAULT_ACCOUNT_POLICY: AccountPolicy = { strategy: 'balanced', order: [], skipPercent: 90 };

/** A person's label of an account: one line, no control characters. */
export const AccountLabel = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}]*$/u, 'no control characters');

/** p13-runtime-accounts: the `job_pauses` cause / PAUSE_JOB cause of a manual account switch. */
export const ACCOUNT_SWITCH_CAUSE = 'account_switch';
