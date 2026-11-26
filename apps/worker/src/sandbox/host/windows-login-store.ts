import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runFile, type RunFile } from './windows-jobrun.js';
import { SLOT_GROUP } from './windows-slots.js';

/**
 * p9-windows-slots-local-login (design p9-windows-host-isolation §9.3): the subscription login store of the worker
 * account (`local-login`: `%USERPROFILE%\.claude`, `.claude.json`, `.codex`) is never shared with the per-job
 * accounts.
 *
 * Live 2026-10-17 (Windows 1.0.31): two Claude Code `local-login` jobs ran at once as `remyral-job-1/2`, both sharing
 * the worker's login through a `remyral-job-slots` Modify grant, and both failed within seconds with "Failed to
 * refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh"; afterwards the login was
 * unusable for the worker account too. Claude Code (2.1.x, read from the shipped CLI) serialises an OAuth refresh with
 * two mkdir locks - `<config dir>\.oauth_refresh.lock` and a legacy `<config dir>.lock` next to the config dir, i.e.
 * in the profile root (stale after 60 s, refreshed every 5 s, 5 tries 1-2 s apart, then "another Claude Code process
 * is refreshing it") - and rotates the refresh token on every refresh. A slot account may not create, refresh or
 * remove anything in the worker's profile root, nor atomically replace `.claude.json` there, and a refresh whose new
 * tokens are not persisted leaves a consumed refresh token behind. No read-only credential mode exists. So:
 * `local-login` attempts never run as a slot account (they run as the worker account, one at a time - policy.ts),
 * and the slots get no access to the login store at all; this module removes an old grant (worker releases
 * 1.0.30-1.0.31 added it) and proves the removal before slots are used.
 *
 * The worker owns its own profile (it may rewrite the DACL and take back ownership of files a slot replaced there),
 * so this runs unprivileged as part of the worker's `job_slots` check (Prepare and worker start).
 */

/** Login stores of the local-login runtimes below the worker's profile (Windows). */
export const LOGIN_STORE_NAMES = ['.claude', '.claude.json', '.codex'] as const;

/**
 * Paths whose sharing is checked: the runtimes' usual login stores under `%USERPROFILE%` plus the owner's
 * `hostExtraWritable` dirs (they were the shared set when listed). Always, not only with `keepHome`: an earlier
 * release may have granted them.
 */
export function loginStorePaths(extra: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.USERPROFILE;
  const base = home === undefined || home === '' ? [] : LOGIN_STORE_NAMES.map((n) => join(home, n));
  return [...new Set([...base, ...extra])];
}

export type LoginStoreCheck =
  | {
      readonly ok: true;
      /** Paths that exist and were checked. */
      readonly checked: readonly string[];
      /** Of them, paths that were shared and are not any more. */
      readonly unshared: readonly string[];
    }
  | { readonly ok: false; readonly code: 'job_slots_login_shared'; readonly detail: string };

const SID = /^S-1-5(-\d{1,10}){1,14}$/;

/**
 * Whether `icacls <path>` output names the slot group or any slot account (by name - icacls prints resolvable
 * accounts as `MACHINE\name:(...)` - or by the raw SID of an unresolvable one).
 */
export function loginStoreShared(icaclsOutput: string, groupSid: string): boolean {
  if (icaclsOutput.includes(groupSid)) return true;
  const group = SLOT_GROUP.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
  return new RegExp(`\\\\(?:${group}|remyral\\-job\\-[1-9][0-9]?):\\(`, 'i').test(icaclsOutput);
}

/**
 * icacls calls that take a login store back: ownership to the worker (a slot that atomically replaced a file there
 * owns the new file and could otherwise rewrite its DACL), then every entry of the slot group removed. `/T` for
 * directories (children may carry explicit entries), `/C` so one locked file does not stop the rest.
 */
export function loginStoreUnshareArgs(
  path: string,
  workerSid: string,
  groupSid: string,
  isDir: boolean,
): string[][] {
  if (!SID.test(workerSid) || !SID.test(groupSid)) throw new Error('invalid SID');
  const rec = isDir ? ['/T', '/C'] : ['/C'];
  return [
    [path, '/setowner', `*${workerSid}`, ...rec, '/Q'],
    [path, '/remove:g', `*${groupSid}`, ...rec, '/Q'],
  ];
}

export interface LoginStoreDeps {
  readonly paths: readonly string[];
  readonly workerSid: string;
  readonly groupSid: string;
  readonly run?: RunFile;
  /** Tests: whether a path exists and is a directory (null: missing). */
  readonly kind?: (path: string) => Promise<'dir' | 'file' | null>;
}

async function pathKind(path: string): Promise<'dir' | 'file' | null> {
  const st = await stat(path).catch(() => null);
  return st === null ? null : st.isDirectory() ? 'dir' : 'file';
}

/** Checks every existing login store, takes back the shared ones and re-checks them. Never throws. */
export async function unshareLoginStores(d: LoginStoreDeps): Promise<LoginStoreCheck> {
  const run = d.run ?? runFile;
  const kind = d.kind ?? pathKind;
  const checked: string[] = [];
  const unshared: string[] = [];
  const show = async (path: string): Promise<string> => {
    const r = await run('icacls.exe', [path], 60_000);
    if (r.code !== 0)
      throw new Error(`icacls ${path}: exit ${String(r.code)} ${(r.stderr || r.stdout).trim()}`);
    return r.stdout;
  };
  try {
    for (const path of d.paths) {
      const k = await kind(path);
      if (k === null) continue;
      checked.push(path);
      if (!loginStoreShared(await show(path), d.groupSid)) continue;
      for (const args of loginStoreUnshareArgs(path, d.workerSid, d.groupSid, k === 'dir')) {
        const r = await run('icacls.exe', args, 600_000);
        // /C: a file in use is reported but does not stop the rest; the re-check below decides.
        if (r.code !== 0 && args[1] === '/remove:g') {
          throw new Error(
            `icacls ${path} /remove:g: exit ${String(r.code)} ${(r.stderr || r.stdout).trim()}`,
          );
        }
      }
      if (loginStoreShared(await show(path), d.groupSid)) {
        throw new Error(`${path} still grants the per-job accounts access after icacls /remove:g`);
      }
      unshared.push(path);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 'job_slots_login_shared',
      detail:
        `the subscription login store is shared with the per-job accounts and could not be taken back (${msg}); remove the ${SLOT_GROUP} entries from it (icacls <path> /remove:g ${SLOT_GROUP} /T) and run Prepare`.slice(
          0,
          600,
        ),
    };
  }
  return { ok: true, checked, unshared };
}
