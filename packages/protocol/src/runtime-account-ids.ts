import { z } from 'zod';
import type { RuntimeKind } from './common.js';

/**
 * p13-runtime-accounts (docs/design/p13-runtime-accounts.md, ADR-0049): the identifiers of a **runtime account** — one
 * of several Claude Code / Codex logins (or API keys) of one machine. Kept in their own module (no imports beyond
 * common types) because the config document, the remote-ops commands and the account reports all use them.
 */

export const RUNTIME_ACCOUNTS_FEATURE = 'runtime-accounts-v1';

/** Runtimes that can have several accounts on a machine (the ones with a login relay, ADR-0017). */
export const AccountRuntime = z.enum(['claude-code', 'codex']);
export type AccountRuntime = z.infer<typeof AccountRuntime>;

/** The machine's configured runtime auth (the login / key it had before accounts existed) — never deleted. */
export const DEFAULT_ACCOUNT_ID = 'default';

/** An account's opaque id on its machine: `default`, or a short random id the master assigns. */
export const RuntimeAccountId = z.string().regex(/^[a-z0-9]{1,12}$/, 'account id [a-z0-9]{1,12}');
export type RuntimeAccountId = z.infer<typeof RuntimeAccountId>;

/** An added account's id (`default` is the machine's configured auth and never listed as an added account). */
export const AddedAccountId = RuntimeAccountId.refine((id) => id !== DEFAULT_ACCOUNT_ID, {
  message: '"default" is the machine\'s configured runtime auth',
});

/** `subscription`: the runtime's own login in the account's config dir; `api_key`: a vault credential. */
export const RuntimeAccountKind = z.enum(['subscription', 'api_key']);
export type RuntimeAccountKind = z.infer<typeof RuntimeAccountKind>;

export const MAX_ACCOUNTS_PER_RUNTIME = 8;

/** The login store of a runtime (same names as the worker's `LOGIN_STORE_OF`). */
const BASE_STORE: Readonly<Record<RuntimeKind, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
};

/**
 * The login store id of an account: the runtime's own store for `default` (unchanged since p9: `claude`, `codex`),
 * `<store>-<id>` for an added one. Fits `LoginStoreId` (`^[a-z][a-z0-9-]{0,31}$`).
 */
export function accountStoreId(runtime: RuntimeKind, account: string): string {
  const base = BASE_STORE[runtime];
  return account === DEFAULT_ACCOUNT_ID ? base : `${base}-${account}`;
}

/** `<workerId>/<runtime>/<accountId>`: how a policy names an account across machines. */
export const AccountRef = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]{1,128}\/(claude-code|codex)\/[a-z0-9]{1,12}$/, 'account reference');
export type AccountRef = z.infer<typeof AccountRef>;

export function accountRef(workerId: string, runtime: string, account: string): string {
  return `${workerId}/${runtime}/${account}`;
}

export function parseAccountRef(
  ref: string,
): { readonly workerId: string; readonly runtime: AccountRuntime; readonly account: string } | null {
  if (!AccountRef.safeParse(ref).success) return null;
  const parts = ref.split('/');
  const [workerId, runtime, account] = parts;
  if (workerId === undefined || runtime === undefined || account === undefined) return null;
  return { workerId, runtime: runtime as AccountRuntime, account };
}
