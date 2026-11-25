import { chmod, chown, lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { workerConfigSchema } from '../../config/schema.js';

/**
 * `remyral-worker-updater machine-admin-ceiling allow|forbid|unset --config <file>` (root / Administrator): sets
 * `localCeiling.allowMachineAdmin` in the root-owned worker config, the machine owner's local word on AI machine
 * administration (docs/ops/machine-admin.md). Used by the installers' `--allow-machine-admin` / `--no-machine-admin`
 * on an existing config (a new config gets the key written directly).
 *
 *  - `forbid` (false): the worker refuses machine-admin jobs and the helper every session, whatever the panel says;
 *  - `allow` (true): an explicit opt-in — also while host jobs on this machine run without filesystem confinement;
 *  - `unset`: the default (absent: the panel decides per machine; refused while host jobs run unconfined).
 *
 * Only that key changes; the result is validated with the worker's own schema before anything is written (a config
 * the worker would refuse is never written). POSIX: temp file + rename with the original owner and mode; Windows:
 * rewritten in place (keeps the file's ACL). The worker reads its config at start: restart it afterwards.
 */
export type CeilingValue = 'allow' | 'forbid' | 'unset';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function setMachineAdminCeiling(o: {
  readonly platform: NodeJS.Platform;
  readonly configPath: string;
  readonly value: CeilingValue;
  readonly out: (text: string) => void;
}): Promise<number> {
  const raw = (await readFile(o.configPath, 'utf8')).replace(/^\uFEFF/, '');
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    o.out(`refused: ${o.configPath} is not valid JSON; not changed\n`);
    return 1;
  }
  if (!isObj(doc)) {
    o.out(`refused: ${o.configPath} is not a JSON object; not changed\n`);
    return 1;
  }
  const before = isObj(doc.localCeiling) ? doc.localCeiling.allowMachineAdmin : undefined;
  const ceiling: Json = isObj(doc.localCeiling) ? { ...doc.localCeiling } : {};
  if (o.value === 'unset') delete ceiling.allowMachineAdmin;
  else ceiling.allowMachineAdmin = o.value === 'allow';
  const next: Json = { ...doc };
  if (Object.keys(ceiling).length === 0) delete next.localCeiling;
  else next.localCeiling = ceiling;
  const label = (v: unknown): string => (v === true ? 'true' : v === false ? 'false' : 'unset (default)');
  if (before === ceiling.allowMachineAdmin) {
    o.out(`localCeiling.allowMachineAdmin is already ${label(before)}; nothing to do\n`);
    return 0;
  }
  const valid = workerConfigSchema(o.platform).safeParse(next);
  if (!valid.success) {
    o.out(
      `refused: the config would not be valid (${valid.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}); not changed\n`,
    );
    return 1;
  }
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (o.platform === 'win32') {
    await writeFile(o.configPath, text, 'utf8');
  } else {
    const st = await lstat(o.configPath);
    const tmp = `${o.configPath}.remyral-tmp`;
    await writeFile(tmp, text, { mode: st.mode & 0o777, flag: 'w' });
    await chown(tmp, st.uid, st.gid);
    await chmod(tmp, st.mode & 0o777);
    await rename(tmp, o.configPath);
  }
  o.out(
    `localCeiling.allowMachineAdmin: ${label(before)} -> ${label(ceiling.allowMachineAdmin)} in ${o.configPath}; restart the worker service to apply it\n`,
  );
  return 0;
}
