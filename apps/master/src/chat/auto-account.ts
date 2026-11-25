import {
  accountExclusion,
  type AccountStrategyName,
  chooseAccounts,
  type JobAccountFacts,
  type PlacementAccount,
} from '@remyral/scheduler';

/**
 * p15-message-delivery item 2 (Ayarlar → Sohbet → Limitte yedek hesap = Otomatik): the account the chat continues with
 * while its chosen account is at its usage limit — another account of the same runtime on the same machine that a job
 * could use as a fallback right now (the job rules of `accountExclusion`: not paused, logged in, no open limit episode,
 * an API key only with the workspace's paid switch, the machine's own key never as a fallback), that the chat has not
 * itself seen at its limit, in the workspace's account strategy order. Null: none (the fallback engine is next). Pure.
 */
export function pickAutoFallbackAccount(input: {
  readonly workerId: string;
  readonly runtime: string;
  /** The chat's account now (`default` = the configured login). */
  readonly mainAccount: string;
  /** The machine's accounts of that runtime (RuntimeAccountService.facts). */
  readonly accounts: readonly PlacementAccount[];
  /** Accounts of that runtime the chat recorded at their limit (chat_engine_limits). */
  readonly chatLimited: readonly string[];
  readonly allowPaid: boolean;
  readonly policy: {
    readonly strategy: AccountStrategyName;
    readonly order: readonly string[];
    readonly skipPercent: number;
  };
}): string | null {
  const job: JobAccountFacts = {
    allowPaid: input.allowPaid,
    fallback: true,
    exclude: [{ workerId: input.workerId, account: input.mainAccount }],
    strategy: input.policy.strategy,
    order: input.policy.order,
    skipPercent: input.policy.skipPercent,
  };
  const usable = input.accounts.filter(
    (a) =>
      accountExclusion({ accounts: job }, input.workerId, a) === null && !input.chatLimited.includes(a.id),
  );
  const ranked = chooseAccounts({ runtime: input.runtime, accounts: job }, [
    { workerId: input.workerId, accounts: usable },
  ]);
  return ranked[0]?.account.id ?? null;
}
