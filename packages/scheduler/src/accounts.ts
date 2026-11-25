/**
 * p13-runtime-accounts (docs/design/p13-runtime-accounts.md §3, ADR-0049): several Claude Code / Codex accounts per
 * machine. Pure: the master loads the facts (accounts, their login state, open limits, usage, running leases) and the
 * job's policy; this module says which accounts of a machine can take a job now, why none can, and which
 * (machine, account) pair the strategy picks.
 */

/** The account id of a machine's configured runtime auth (the login / key it had before accounts existed). */
export const DEFAULT_ACCOUNT = 'default';

export type AccountStrategyName = 'balanced' | 'fill_first' | 'least_used';

/** One runtime account of a machine as placement sees it (master facts). */
export interface PlacementAccount {
  readonly id: string;
  readonly kind: 'subscription' | 'api_key';
  /** Subscription accounts: the login store (`claude`, `claude-a1b2c3d4`). */
  readonly store?: string | undefined;
  /** Its attempts run on a per-job Windows account (the folder is lent): no worker-account exclusivity. */
  readonly lendable: boolean;
  readonly isDefault: boolean;
  readonly position: number;
  /** `ok` = logged in / key held; `needs_login` = signed out / expired / key missing; `unknown` = not reported. */
  readonly login: 'ok' | 'needs_login' | 'unknown';
  /** A person paused it (never picked automatically, never as a fallback). */
  readonly paused: boolean;
  /** An open usage-limit episode of the account: limited until then (ISO-8601). */
  readonly limitedUntil?: string | undefined;
  /** The fullest window of its latest usage reading (0–100); null = unknown. */
  readonly usedPercent: number | null;
  /** Its slot-holding leases on this machine (master count). */
  readonly active: number;
  /** A person's label (messages only). */
  readonly label?: string | undefined;
}

/** What the job brings for account selection (master facts). */
export interface JobAccountFacts {
  /** The project's paid switch (`allowPaidFallback`, ADR-0040 — authoritative for API-key accounts, ADR-0049). */
  readonly allowPaid: boolean;
  /** This option is a fallback (index > 0) or a usage-limit resume: API keys only with `allowPaid`, never the default key. */
  readonly fallback: boolean;
  /** A person pinned the job to this account (an explicit choice: honoured even for an API key). */
  readonly pin?: { readonly workerId: string; readonly account: string } | undefined;
  /** Accounts not to use (the account that just hit its limit). */
  readonly exclude?: readonly { readonly workerId: string; readonly account: string }[] | undefined;
  readonly strategy: AccountStrategyName;
  /** `<worker>/<runtime>/<account>` in the policy's order. */
  readonly order: readonly string[];
  /** Accounts at or above this usage share go last (100 = never). */
  readonly skipPercent: number;
}

/** Why one account cannot take the job (for messages and the reason code). */
export type AccountExclusion = 'paused' | 'needs_login' | 'limited' | 'paid' | 'excluded' | 'not_pinned';

export function accountExclusion(
  job: { readonly accounts?: JobAccountFacts | undefined },
  workerId: string,
  a: PlacementAccount,
): AccountExclusion | null {
  const f = job.accounts;
  const pin = f?.pin;
  if (pin !== undefined && (pin.workerId !== workerId || pin.account !== a.id)) return 'not_pinned';
  if ((f?.exclude ?? []).some((x) => x.workerId === workerId && x.account === a.id)) return 'excluded';
  if (a.login === 'needs_login') return 'needs_login';
  if (a.limitedUntil !== undefined) return 'limited';
  // A pinned account is the person's explicit choice: a pause still holds it (they paused it), paid does not.
  if (a.paused) return 'paused';
  if (a.kind === 'api_key' && pin === undefined) {
    const allowPaid = f?.allowPaid ?? false;
    // The machine's own configured key (legacy API-key machines) runs its ordinary jobs; never a fallback.
    const ownKey = a.isDefault && f?.fallback !== true;
    if (!allowPaid && !ownKey) return 'paid';
  }
  return null;
}

/** A free account: not used right now by another attempt of the same login store (subscriptions). */
export function storeBusy(
  a: PlacementAccount,
  runtime: string,
  leases: readonly { readonly runtime: string; readonly account?: string | undefined }[],
  accounts: readonly PlacementAccount[],
): number {
  if (a.kind !== 'subscription') return 0;
  const store = a.store ?? a.id;
  return leases.filter((l) => {
    if (l.runtime !== runtime) return false;
    const other = accounts.find((x) => x.id === (l.account ?? DEFAULT_ACCOUNT));
    return other !== undefined && other.kind === 'subscription' && (other.store ?? other.id) === store;
  }).length;
}

const RUNTIME_LABEL: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

function name(a: PlacementAccount): string {
  return a.label === undefined ? a.id : `${a.label} (${a.id})`;
}

/**
 * The reason a machine has no usable account for the job (or null when one is usable). `account_limited` (with the
 * earliest reset) when every candidate is at its usage limit; `runtime_not_authenticated`-like login waits are left to
 * the caller (all candidates signed out); otherwise `account_unavailable` naming what holds each one.
 */
export function noAccountReason(
  job: { readonly runtime: string; readonly accounts?: JobAccountFacts | undefined },
  workerId: string,
  accounts: readonly PlacementAccount[],
):
  | { readonly kind: 'none' }
  | { readonly kind: 'login' }
  | {
      readonly kind: 'reason';
      readonly code: 'account_limited' | 'account_unavailable';
      readonly message: string;
      readonly until?: string;
    } {
  const label = RUNTIME_LABEL[job.runtime] ?? job.runtime;
  const why = accounts.map((a) => ({ a, x: accountExclusion(job, workerId, a) }));
  if (why.some((w) => w.x === null)) return { kind: 'none' };
  const relevant = why.filter((w) => w.x !== 'not_pinned' && w.x !== 'excluded');
  if (accounts.length === 0 || relevant.length === 0) {
    const pin = job.accounts?.pin;
    return {
      kind: 'reason',
      code: 'account_unavailable',
      message:
        pin !== undefined
          ? pin.workerId === workerId
            ? `the job is pinned to the ${label} account ${pin.account}, which this machine does not have`
            : `the job is pinned to a ${label} account on ${pin.workerId}`
          : `no ${label} account on ${workerId} can take the job (the one that hit its limit is skipped)`,
    };
  }
  if (relevant.every((w) => w.x === 'needs_login')) return { kind: 'login' };
  if (relevant.every((w) => w.x === 'limited' || w.x === 'needs_login')) {
    const until = relevant
      .map((w) => w.a.limitedUntil)
      .filter((u): u is string => u !== undefined)
      .sort()[0];
    return {
      kind: 'reason',
      code: 'account_limited',
      message: `every ${label} account on ${workerId} is at its usage limit${until === undefined ? '' : ` (the first resets at ${until})`}`,
      ...(until === undefined ? {} : { until }),
    };
  }
  const parts = relevant.map((w) => {
    const text: Readonly<Record<AccountExclusion, string>> = {
      paused: 'paused',
      needs_login: 'needs a login',
      limited: `at its usage limit until ${w.a.limitedUntil ?? '?'}`,
      paid: 'an API key (billed per token) and the project does not allow paid API use',
      excluded: 'skipped',
      not_pinned: 'not the pinned account',
    };
    return `${name(w.a)}: ${text[w.x ?? 'excluded']}`;
  });
  return {
    kind: 'reason',
    code: 'account_unavailable',
    message: `no ${label} account on ${workerId} can take the job now — ${parts.join('; ')}`.slice(0, 600),
  };
}

/** One (machine, account) pair the orchestrator may assign, best first. */
export interface AccountChoice {
  readonly workerId: string;
  readonly account: PlacementAccount;
}

function rankKey(
  f: JobAccountFacts,
  runtime: string,
  c: AccountChoice & { readonly workerRank: number },
  strategy: AccountStrategyName | 'rank',
): number[] {
  const a = c.account;
  const near = a.usedPercent !== null && a.usedPercent >= f.skipPercent ? 1 : 0;
  const paid = a.kind === 'api_key' ? 1 : 0;
  // A worker-account login (not lent to a per-job account) holds the machine alone on Windows: prefer the others.
  const workerLogin = a.kind === 'subscription' && !a.lendable ? 1 : 0;
  const ref = `${c.workerId}/${runtime}/${a.id}`;
  const listed = f.order.indexOf(ref);
  // Unlisted accounts follow the listed ones: the default first, then by position.
  const order = listed >= 0 ? listed : f.order.length + (a.isDefault ? 0 : 1 + a.position);
  const used = a.usedPercent ?? 0;
  const strategyKey =
    strategy === 'rank'
      ? []
      : strategy === 'fill_first'
        ? [order]
        : strategy === 'least_used'
          ? [Math.round(used), a.active]
          : [a.active, Math.round(used)];
  return [near, paid, ...strategyKey, workerLogin, c.workerRank, a.position];
}

function compare(x: readonly number[], y: readonly number[]): number {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Orders the (machine, account) pairs of the eligible machines (`ranked`: placement order, best first) — design §3.3:
 * below the skip threshold first, subscriptions before API keys, then the strategy, then the machine's rank. With the
 * balanced strategy and one usable account per machine (today's fleets), the machine rank alone decides.
 */
export function chooseAccounts(
  job: { readonly runtime: string; readonly accounts?: JobAccountFacts | undefined },
  ranked: readonly { readonly workerId: string; readonly accounts: readonly PlacementAccount[] }[],
): AccountChoice[] {
  const f = job.accounts ?? {
    allowPaid: false,
    fallback: false,
    strategy: 'balanced' as const,
    order: [],
    skipPercent: 100,
  };
  const pairs = ranked.flatMap((w, workerRank) =>
    w.accounts.map((account) => ({ workerId: w.workerId, account, workerRank })),
  );
  const oneEach = ranked.every((w) => w.accounts.length <= 1);
  // One usable account per machine and the balanced strategy: the machine score (capacity, reliability, affinity)
  // already spreads the load — existing single-account fleets keep their placement.
  const strategy: AccountStrategyName | 'rank' =
    f.strategy === 'balanced' && oneEach && f.order.length === 0 ? 'rank' : f.strategy;
  const keyed = pairs.map((p) => ({ p, k: rankKey(f, job.runtime, p, strategy) }));
  keyed.sort((x, y) => compare(x.k, y.k));
  return keyed.map(({ p }) => ({ workerId: p.workerId, account: p.account }));
}
