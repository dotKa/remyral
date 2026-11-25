import type { z } from 'zod';
import { assertNotWorldWritable, ensurePrivateDir, InsecurePermissionsError } from '../fs/permissions.js';
import { FileTooLargeError, type FileOps } from '../fs/ops.js';
import { deriveCeiling } from './ceiling.js';
import { dropRetiredConfig } from './retired.js';
import { CONFIG_ENV, configLocations, pathApi, type PathHost } from './paths.js';
import { workerConfigSchema, type WorkerConfig } from './schema.js';

export const MAX_CONFIG_BYTES = 64 * 1024;

/** Every config problem the operator must fix; the message is safe to print. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly path: string | null,
    readonly issues: readonly string[] = [],
  ) {
    super(issues.length === 0 ? message : `${message}\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export interface LoadConfigOptions {
  /** Explicit `--config` path; beats `REMYRAL_WORKER_CONFIG` and the OS defaults. */
  explicitPath?: string | undefined;
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
    return `${where}: ${issue.message}`;
  });
}

/** Which config file to read, and which dataDir default applies to it. */
export async function resolveConfigPath(
  ops: FileOps,
  host: PathHost,
  options: LoadConfigOptions,
): Promise<{ path: string; defaultDataDir: string }> {
  const locations = configLocations(host);
  const fallbackDataDir = locations[0]?.defaultDataDir ?? '';
  const explicit = options.explicitPath ?? host.env(CONFIG_ENV);
  if (explicit !== undefined && explicit !== '') {
    const abs = pathApi(host.platform).resolve(explicit);
    const match = locations.find((l) => l.configPath === abs);
    return { path: abs, defaultDataDir: match?.defaultDataDir ?? fallbackDataDir };
  }
  for (const loc of locations) {
    if ((await ops.stat(loc.configPath)) !== null) {
      return { path: loc.configPath, defaultDataDir: loc.defaultDataDir };
    }
  }
  throw new ConfigError(
    `no config file found; looked in:\n${locations.map((l) => `  - ${l.configPath}`).join('\n')}\n` +
      `create one or pass --config <path> (or set ${CONFIG_ENV})`,
    null,
  );
}

/**
 * Loads, validates and permission-checks the worker config. Creates `dataDir`
 * (0700) if it does not exist. Throws `ConfigError` with an actionable message;
 * never returns a partially valid config.
 */
export async function loadConfig(
  ops: FileOps,
  host: PathHost,
  options: LoadConfigOptions = {},
): Promise<WorkerConfig> {
  const { path, defaultDataDir } = await resolveConfigPath(ops, host, options);
  const p = pathApi(host.platform);

  let raw: Buffer | null;
  try {
    raw = await ops.readFile(path, MAX_CONFIG_BYTES);
  } catch (error) {
    if (error instanceof FileTooLargeError) throw new ConfigError(`config file is larger than 64 KiB`, path);
    throw new ConfigError(`cannot read config: ${(error as Error).message}`, path);
  }
  if (raw === null) throw new ConfigError(`config file ${path} does not exist`, path);

  try {
    await assertNotWorldWritable(ops, path);
    await assertNotWorldWritable(ops, p.dirname(path));
  } catch (error) {
    if (error instanceof InsecurePermissionsError) throw new ConfigError(error.message, path);
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`, path);
  }
  // ADR-0023: a file written for an older build may still name OpenHands; it must not stop the worker.
  const { json, notices } = dropRetiredConfig(parsedJson);

  const parsed = workerConfigSchema(host.platform).safeParse(json);
  if (!parsed.success) throw new ConfigError(`invalid config ${path}:`, path, formatIssues(parsed.error));
  const { dataDir, $schema: _schema, ...rest } = parsed.data;
  const base = { ...rest, dataDir: dataDir ?? defaultDataDir, source: path };
  // ADR-0015: the local ceiling and pins, from `localCeiling` and the legacy keys actually written.
  const config: WorkerConfig = {
    ...base,
    ...deriveCeiling(json, base),
    ...(notices.length === 0 ? {} : { notices }),
  };

  if (p.relative(config.dataDir, config.workspaceRoot) === '') {
    throw new ConfigError(`invalid config ${path}:`, path, ['workspaceRoot: must differ from dataDir']);
  }
  const rel = p.relative(config.workspaceRoot, config.dataDir);
  if (!rel.startsWith('..') && !p.isAbsolute(rel)) {
    throw new ConfigError(`invalid config ${path}:`, path, [
      'dataDir: must not be inside workspaceRoot (agents can write there)',
    ]);
  }

  try {
    await ensurePrivateDir(ops, config.dataDir);
    await assertNotWorldWritable(ops, config.workspaceRoot);
  } catch (error) {
    if (error instanceof InsecurePermissionsError) throw new ConfigError(error.message, path);
    throw error;
  }
  return config;
}
