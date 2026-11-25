import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Identifier } from '@remyral/protocol';
import { z } from 'zod';

/**
 * Which worker this machine's root/SYSTEM helper serves (security fix: master-signed sessions, commands and privileged
 * requests are bound to a worker id, and one master signs for every worker). The id in a request file comes from the
 * service account, so the helper needs a source of its own: `<install>/state/admin-binding.json`, written only by
 * root/SYSTEM — the installer (`admin-bind --if-unbound`) or the owner (`admin-bind`) — and never by the worker. A
 * separate file, not a key of config.json: that file is parsed strictly by every worker version, so a new key would
 * stop an older version (a rollback) from starting.
 *
 * Helpers carrying {@link ADMIN_BINDING_MARKER} refuse machine-admin sessions until the file exists and refuse every
 * session, command and privileged request for another worker id; the worker's readiness probe reports `helper_not_bound`
 * / `helper_bound_elsewhere` for them (older helpers do not know the file).
 */
export const ADMIN_BINDING_MARKER = 'remyral-admin-binding/v1';
export const ADMIN_BINDING_FILE = 'admin-binding.json';

export const AdminBinding = z.strictObject({
  v: z.literal(1),
  workerId: Identifier,
  boundAt: z.string().max(40),
  /** Who recorded it: the installer (from the enrolled identity) or the owner's explicit `admin-bind`. */
  source: z.enum(['installer', 'operator']),
  /** Device key fingerprint of the enrollment at binding time (for the owner to compare; not a control). */
  fingerprint: z.string().max(128).optional(),
});
export type AdminBinding = z.infer<typeof AdminBinding>;

export function adminBindingPath(installDir: string): string {
  return join(installDir, 'state', ADMIN_BINDING_FILE);
}

export type BindingRead =
  | { readonly state: 'bound'; readonly binding: AdminBinding }
  | { readonly state: 'unbound' }
  /** Present but not trustworthy (not root-owned, writable by others, a link) or not a valid document. */
  | { readonly state: 'invalid'; readonly detail: string };

/**
 * Reads the binding. `rootOnly` (the helper, POSIX): the file and its directory must be owned by root and not
 * group/world-writable, and the file must be a regular file (no link) — otherwise it is `invalid`, never trusted.
 */
export async function readAdminBinding(
  installDir: string,
  opts: { readonly platform: NodeJS.Platform; readonly rootOnly: boolean; readonly ownerUid?: number },
): Promise<BindingRead> {
  const path = adminBindingPath(installDir);
  let st;
  try {
    st = await lstat(path);
  } catch {
    return { state: 'unbound' };
  }
  if (!st.isFile()) return { state: 'invalid', detail: `${path} is not a regular file` };
  if (opts.rootOnly && opts.platform !== 'win32') {
    const owner = opts.ownerUid ?? 0;
    for (const [p, s] of [
      [path, st],
      [dirname(path), await lstat(dirname(path))],
    ] as const) {
      if (s.uid !== owner || (s.mode & 0o022) !== 0)
        return { state: 'invalid', detail: `${p} must be owned by root and not group/world-writable` };
    }
  }
  try {
    if (st.size > 4096) return { state: 'invalid', detail: `${path} is too large` };
    const parsed = AdminBinding.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success
      ? { state: 'bound', binding: parsed.data }
      : { state: 'invalid', detail: `${path} is not a valid binding document` };
  } catch {
    return { state: 'invalid', detail: `${path} is not a valid binding document` };
  }
}

/** The owner's one-time step on this machine, as a command line (for refusals and the readiness probe). */
export function adminBindCommand(platform: NodeJS.Platform, nodePath: string, installDir: string): string {
  if (platform === 'win32') {
    return `& "${nodePath}" "${installDir}\\remyral-worker-updater.mjs" admin-bind (elevated PowerShell)`;
  }
  return `sudo "${nodePath}" "${join(installDir, 'remyral-worker-updater.mjs')}" admin-bind`;
}
