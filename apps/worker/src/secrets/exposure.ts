import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import { assertPrivateFile } from '../fs/permissions.js';
import { SECRET_NAME } from './ref.js';

/**
 * Which of this machine's own secrets (`secret:<name>`, set with `remyral-worker secret set`) a job or a service may
 * ask for by name (`JobSpec.secretRefs`, service `secretEnv`). Default deny: a local secret is the machine owner's
 * (runtime keys, gateway keys), and the master — any operator — must not be able to pull one into a job's environment
 * just by naming it. The owner exposes a name explicitly, for every project or some:
 *
 *   remyral-worker secret expose <name> [--project <id> ...]
 *   remyral-worker secret unexpose <name>
 *
 * Kept in `<dataDir>/job-secrets.json` (0600, owner only) — not in config.json, which every worker version parses
 * strictly: an older worker after a rollback simply ignores this file (it injects every name again, as before).
 * Read at every assignment / service start, so a change applies without a restart. The worker's own uses (runtime
 * auth from the worker configuration, model profile credentials) are not job requests and never consult it.
 * `vault-*` names are not covered: panel vault credentials follow the master's signed lease scope.
 */
export const JOB_SECRETS_FILE = 'job-secrets.json';
const MAX_BYTES = 64 * 1024;

const ProjectId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const Entry = z.strictObject({
  /** null: every project of this machine. */
  projects: z.array(ProjectId).min(1).max(200).nullable(),
});
const ExposureFile = z.strictObject({
  schema: z.literal(1),
  secrets: z.record(z.string().regex(SECRET_NAME), Entry),
});
type ExposureFile = z.infer<typeof ExposureFile>;

export interface JobSecretExposure {
  /** Whether a job / service of `project` may get the local secret `name`. */
  allows(name: string, project: string): boolean;
  /** name → projects (null: all). */
  readonly entries: Readonly<Record<string, readonly string[] | null>>;
  /** Why nothing is exposed although the file exists (unreadable, insecure, invalid). */
  readonly problem: string | null;
}

function view(file: ExposureFile, problem: string | null = null): JobSecretExposure {
  const entries: Record<string, readonly string[] | null> = {};
  for (const [name, e] of Object.entries(file.secrets)) {
    if (!name.toLowerCase().startsWith('vault-')) entries[name] = e.projects;
  }
  return {
    entries,
    problem,
    allows: (name, project) => {
      if (!Object.hasOwn(entries, name)) return false;
      const projects = entries[name];
      return projects === null || projects === undefined || projects.includes(project);
    },
  };
}

const EMPTY: ExposureFile = { schema: 1, secrets: {} };

/** Nothing exposed: no file, or one that cannot be trusted (fail closed; `problem` says why). */
export async function readJobSecretExposure(ops: FileOps, dataDir: string): Promise<JobSecretExposure> {
  const path = join(dataDir, JOB_SECRETS_FILE);
  try {
    await assertPrivateFile(ops, path);
  } catch (err) {
    return view(EMPTY, err instanceof Error ? err.message : 'insecure file');
  }
  const raw = await ops.readFile(path, MAX_BYTES).catch(() => null);
  if (raw === null) return view(EMPTY);
  try {
    return view(ExposureFile.parse(JSON.parse(raw.toString('utf8'))));
  } catch {
    return view(EMPTY, `${path} is not a valid exposure file`);
  }
}

async function readStrict(ops: FileOps, dataDir: string): Promise<ExposureFile> {
  const path = join(dataDir, JOB_SECRETS_FILE);
  await assertPrivateFile(ops, path);
  const raw = await ops.readFile(path, MAX_BYTES).catch(() => null);
  if (raw === null) return { schema: 1, secrets: {} };
  return ExposureFile.parse(JSON.parse(raw.toString('utf8')));
}

/** CLI: expose `name` to jobs of every project (`projects` null) or of the listed ones (replaces the entry). */
export async function exposeJobSecret(
  ops: FileOps,
  dataDir: string,
  name: string,
  projects: readonly string[] | null,
): Promise<void> {
  const file = await readStrict(ops, dataDir);
  const next = ExposureFile.parse({
    schema: 1,
    secrets: {
      ...file.secrets,
      [name]: { projects: projects === null ? null : [...new Set(projects)].sort() },
    },
  });
  await atomicWriteFile(ops, join(dataDir, JOB_SECRETS_FILE), `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** CLI: stop exposing `name`; false when it was not exposed. */
export async function unexposeJobSecret(ops: FileOps, dataDir: string, name: string): Promise<boolean> {
  const file = await readStrict(ops, dataDir);
  if (!Object.hasOwn(file.secrets, name)) return false;
  const { [name]: _gone, ...rest } = file.secrets;
  await atomicWriteFile(
    ops,
    join(dataDir, JOB_SECRETS_FILE),
    `${JSON.stringify({ schema: 1, secrets: rest }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return true;
}
