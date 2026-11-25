import { chmod, chown, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { fingerprint } from '../../identity/device-key.js';
import { type AdminBinding, adminBindingPath, readAdminBinding } from '../../machine-admin/binding.js';
import { WorkerIdentityRecord } from '../../store/schema.js';
import { readUntrustedFile } from '../files.js';

/**
 * `remyral-worker-updater admin-bind` (root / Administrator): records which worker this machine's privileged helper
 * serves (machine-admin/binding.ts). Run by the owner once after the machine was approved, or by the installer
 * (`--if-unbound`) on every run. The worker id comes from the enrolled identity in the worker's data dir — at this
 * moment an administrator on the machine vouches for it (the command prints it with the device key fingerprint to
 * compare with the console); `--worker-id` states the expected id explicitly and refuses a mismatch.
 *
 * Exit codes: 0 bound / already bound / nothing to do (`--if-unbound`), 1 refused.
 */
export interface AdminBindOptions {
  readonly platform: NodeJS.Platform;
  readonly dataDir: string;
  readonly installDir: string;
  /** The id the owner expects (from the console); must equal the enrolled identity. */
  readonly workerId?: string | undefined;
  /** Installer mode: bind only when nothing is bound yet; never fail. */
  readonly ifUnbound: boolean;
  /** Replace a binding to another worker id (the machine was paired again). */
  readonly replace: boolean;
  readonly now: () => Date;
  readonly out: (text: string) => void;
  /** Test seam: owner the binding must have (default root). */
  readonly ownerUid?: number;
}

/** The worker store's file in the data dir (store/store.ts STATE_FILE). */
const STATE_FILE = 'state.json';

const StoredIdentity = z.object({ identity: WorkerIdentityRecord.nullable() });

async function enrolledIdentity(dataDir: string): Promise<{ workerId: string; publicKey: string } | null> {
  try {
    const raw = await readUntrustedFile(join(dataDir, STATE_FILE), 4 * 1024 * 1024);
    if (raw === null) return null;
    const parsed = StoredIdentity.safeParse(JSON.parse(raw.toString('utf8')));
    return parsed.success && parsed.data.identity !== null
      ? { workerId: parsed.data.identity.workerId, publicKey: parsed.data.identity.publicKey }
      : null;
  } catch {
    return null;
  }
}

export async function adminBind(o: AdminBindOptions): Promise<number> {
  const current = await readAdminBinding(o.installDir, {
    platform: o.platform,
    rootOnly: true,
    ...(o.ownerUid === undefined ? {} : { ownerUid: o.ownerUid }),
  });
  const identity = await enrolledIdentity(o.dataDir);
  const fail = (text: string): number => {
    o.out(`${o.ifUnbound ? 'note' : 'refused'}: ${text}\n`);
    return o.ifUnbound ? 0 : 1;
  };
  if (identity === null) {
    return fail(
      'this worker is not enrolled yet (no approved identity in its data dir): approve the machine in the console first, then run admin-bind again',
    );
  }
  if (o.workerId !== undefined && o.workerId !== identity.workerId) {
    return fail(
      `the worker on this machine is enrolled as ${identity.workerId}, not ${o.workerId}; check the machine in the console`,
    );
  }
  const print = `${identity.workerId} (device key ${fingerprint(identity.publicKey)})`;
  if (current.state === 'bound') {
    if (current.binding.workerId === identity.workerId) {
      o.out(`machine administration is bound to worker ${print}; nothing to do\n`);
      return 0;
    }
    if (o.ifUnbound || !o.replace) {
      return fail(
        `machine administration is bound to worker ${current.binding.workerId}, but this machine is now enrolled as ${print}. If the machine was paired again, run admin-bind --replace (as root / Administrator) after comparing the fingerprint with the console`,
      );
    }
  } else if (current.state === 'invalid' && o.ifUnbound) {
    return fail(`${current.detail}; not changed (run admin-bind --replace as root / Administrator)`);
  }
  const binding: AdminBinding = {
    v: 1,
    workerId: identity.workerId,
    boundAt: o.now().toISOString(),
    source: o.ifUnbound ? 'installer' : 'operator',
    fingerprint: fingerprint(identity.publicKey),
  };
  const path = adminBindingPath(o.installDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(binding)}\n`, { mode: 0o644 });
  if (o.platform !== 'win32') {
    await chown(tmp, o.ownerUid ?? 0, 0).catch((err: unknown) => {
      if (o.ownerUid === undefined) throw err;
    });
    await chmod(tmp, 0o644);
  }
  await rename(tmp, path);
  o.out(
    `machine administration bound to worker ${print}. Compare the id and fingerprint with Machines > <machine> in the console; master-signed requests for any other worker are refused on this machine.\n`,
  );
  return 0;
}
