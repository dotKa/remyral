import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AccountRuntime,
  accountStoreId,
  DEFAULT_ACCOUNT_ID,
  type RuntimeAccountKind,
  type RuntimeKind,
} from '@remyral/protocol';
import type { EffectiveConfig } from '../managed-config/effective.js';
import type { RuntimeAuth } from '../secrets/auth.js';

/**
 * p13-runtime-accounts (docs/design/p13-runtime-accounts.md §2.1, ADR-0049): the runtime accounts of this worker.
 *
 * - `default` is the runtime's configured auth (`runtimes.<rt>.auth` / local `runtimeAuth`): the worker profile's own
 *   `.claude` / `.codex` (local-login) or its key (secret-ref). Nothing moves; no re-login.
 * - An added **subscription** account lives in `<dataDir>/runtime-accounts/<runtime>/<id>/` with the runtime's config
 *   dir inside (`.claude` → `CLAUDE_CONFIG_DIR`, `.codex` → `CODEX_HOME`), so Claude Code's legacy refresh lock
 *   `${config dir}.lock` lands inside the account folder too. Owner-only (0700; on Windows the data dir's
 *   worker-only DACL is inherited — a per-job account gets Modify on one folder only while its attempt runs).
 * - An added **API-key** account is a vault credential (`secret:vault-<id>`), injected like any secret-ref auth.
 *
 * The worker never reads, copies or transmits what the runtimes store in these folders (ADR-0014): it only creates
 * the empty folder, points the runtime at it and deletes it when the account is removed.
 */

export const ACCOUNTS_DIR = 'runtime-accounts';

const CONFIG_DIR_NAME: Readonly<Record<AccountRuntime, string>> = {
  'claude-code': '.claude',
  codex: '.codex',
};

export function isAccountRuntime(runtime: string): runtime is AccountRuntime {
  return runtime === 'claude-code' || runtime === 'codex';
}

/** `<dataDir>/runtime-accounts`. */
export function accountsRoot(dataDir: string): string {
  return join(dataDir, ACCOUNTS_DIR);
}

/** The account's own folder (what a per-job account is lent): `<root>/<runtime>/<id>`. */
export function accountFolder(dataDir: string, runtime: AccountRuntime, id: string): string {
  if (!/^[a-z0-9]{1,12}$/.test(id) || id === DEFAULT_ACCOUNT_ID) {
    throw new RangeError(`not an added account id: ${id}`);
  }
  return join(accountsRoot(dataDir), runtime, id);
}

/** The runtime's config dir of an added subscription account (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`). */
export function accountLoginDir(dataDir: string, runtime: AccountRuntime, id: string): string {
  return join(accountFolder(dataDir, runtime, id), CONFIG_DIR_NAME[runtime]);
}

/** One account of this worker, as the job runner, the assistant and the login relay use it. */
export interface RuntimeAccount {
  readonly runtime: AccountRuntime;
  readonly id: string;
  readonly kind: RuntimeAccountKind;
  readonly isDefault: boolean;
  /** How the runtime authenticates with this account (a reference, never a value). */
  readonly auth: RuntimeAuth;
  /** Subscription accounts: the login store id (`claude`, `claude-a1b2c3d4`). */
  readonly store?: string;
  /** Added subscription accounts: the runtime's config dir; absent for `default` (the worker's own). */
  readonly loginDir?: string;
  /** Added subscription accounts: the folder lent to a per-job account for one attempt. */
  readonly folder?: string;
  /** API-key accounts from the vault: the credential id. */
  readonly credentialId?: string;
}

const VAULT_REF = /^secret:vault-(.+)$/;

/** Every account of the account runtimes in effect (the default first). */
export function accountsOf(
  e: Pick<EffectiveConfig, 'runtimeAuth' | 'runtimeAccounts' | 'allowedRuntimes'>,
  dataDir: string,
): RuntimeAccount[] {
  const out: RuntimeAccount[] = [];
  for (const runtime of ['claude-code', 'codex'] as const) {
    if (!e.allowedRuntimes.includes(runtime)) continue;
    const auth = e.runtimeAuth[runtime];
    if (auth !== undefined) {
      const vaultId = auth.mode === 'secret-ref' ? VAULT_REF.exec(auth.ref)?.[1] : undefined;
      out.push({
        runtime,
        id: DEFAULT_ACCOUNT_ID,
        kind: auth.mode === 'local-login' ? 'subscription' : 'api_key',
        isDefault: true,
        auth,
        ...(auth.mode === 'local-login' ? { store: accountStoreId(runtime, DEFAULT_ACCOUNT_ID) } : {}),
        ...(vaultId === undefined ? {} : { credentialId: vaultId }),
      });
    }
    for (const a of e.runtimeAccounts?.[runtime] ?? []) {
      if (a.kind === 'subscription') {
        out.push({
          runtime,
          id: a.id,
          kind: 'subscription',
          isDefault: false,
          auth: { mode: 'local-login' },
          store: accountStoreId(runtime, a.id),
          loginDir: accountLoginDir(dataDir, runtime, a.id),
          folder: accountFolder(dataDir, runtime, a.id),
        });
      } else if (a.auth !== undefined) {
        out.push({
          runtime,
          id: a.id,
          kind: 'api_key',
          isDefault: false,
          auth: a.auth,
          ...(a.credentialId === undefined ? {} : { credentialId: a.credentialId }),
        });
      }
    }
  }
  return out;
}

export function findAccount(
  list: readonly RuntimeAccount[],
  runtime: RuntimeKind,
  id: string | undefined,
): RuntimeAccount | undefined {
  const want = id ?? DEFAULT_ACCOUNT_ID;
  return list.find((a) => a.runtime === runtime && a.id === want);
}

/** The login store an account's runtime processes share (one at a time): the account's, else the runtime's own. */
export function storeOf(runtime: RuntimeKind, account: RuntimeAccount | undefined): string {
  return account?.store ?? accountStoreId(runtime, DEFAULT_ACCOUNT_ID);
}

export interface AccountFolderOps {
  readonly mkdir?: typeof mkdir;
  readonly rm?: typeof rm;
  readonly exists?: (path: string) => Promise<boolean>;
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

/**
 * Creates the folders of the added subscription accounts (owner-only) and returns the folders that exist on disk but
 * belong to no account any more (removed accounts; the caller logs them out first, then deletes them).
 */
export async function syncAccountFolders(
  dataDir: string,
  accounts: readonly RuntimeAccount[],
  listExisting: () => Promise<readonly string[]>,
  ops: AccountFolderOps = {},
): Promise<{ readonly created: string[]; readonly stale: string[] }> {
  const md = ops.mkdir ?? mkdir;
  const has = ops.exists ?? exists;
  const created: string[] = [];
  const keep = new Set<string>();
  for (const a of accounts) {
    if (a.folder === undefined || a.loginDir === undefined) continue;
    keep.add(a.folder);
    if (!(await has(a.loginDir))) {
      await md(a.loginDir, { recursive: true, mode: 0o700 });
      created.push(a.folder);
    }
  }
  const stale = (await listExisting()).filter((f) => !keep.has(f));
  return { created, stale };
}

/** Deletes a removed account's folder (its login goes with it). Never follows anything outside the root. */
export async function removeAccountFolder(
  dataDir: string,
  folder: string,
  ops: AccountFolderOps = {},
): Promise<void> {
  const root = accountsRoot(dataDir);
  if (!folder.startsWith(`${root}/`) && !folder.startsWith(`${root}\\`)) {
    throw new RangeError(`${folder} is not an account folder`);
  }
  await (ops.rm ?? rm)(folder, { recursive: true, force: true });
}

/** Folders under `<root>/<runtime>/<id>` that exist now. */
export async function existingAccountFolders(
  dataDir: string,
  readdir: (p: string) => Promise<string[]>,
): Promise<string[]> {
  const out: string[] = [];
  for (const runtime of ['claude-code', 'codex'] as const) {
    const dir = join(accountsRoot(dataDir), runtime);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of names) {
      if (/^[a-z0-9]{1,12}$/.test(n) && n !== DEFAULT_ACCOUNT_ID) out.push(join(dir, n));
    }
  }
  return out;
}

const SID = /^S-1-5(-\d{1,10}){1,14}$/;

/**
 * Windows: icacls calls that take an account folder back from per-job accounts after a lend (or at worker start, when
 * no attempt runs): ownership to the worker (`/T /C` — files a slot created are its own), then every grant of the slot
 * group and of each slot account removed. Children re-inherit the worker-only entries of the data dir.
 */
export function accountFolderReclaimArgs(
  folder: string,
  workerSid: string,
  slotSids: readonly string[],
): string[][] {
  if (!SID.test(workerSid) || slotSids.some((s) => !SID.test(s))) throw new Error('invalid SID');
  return [
    [folder, '/setowner', `*${workerSid}`, '/T', '/C', '/Q'],
    ...slotSids.map((sid) => [folder, '/remove:g', `*${sid}`, '/T', '/C', '/Q']),
  ];
}
