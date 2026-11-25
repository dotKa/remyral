import type { Logger, Redactor } from '@remyral/observability';
import { pathApi } from '../config/paths.js';
import type { WorkerConfig } from '../config/schema.js';
import type { FileOps } from '../fs/ops.js';
import { WORKER_VERSION } from '../probe/probe.js';
import { UpdateAgent } from './agent.js';
import { type Downloader, httpsDownloader } from './download.js';
import { trustedReleaseKeys } from './keys.js';
import { dataLayout, defaultInstallDir, installLayout } from './layout.js';

export { UpdateAgent, type DaemonUpdateHooks, type UpdateHost, type UpdateOffer } from './agent.js';

/** The daemon's update agent for a loaded config (p2-signed-updates); `null` when updates are disabled. */
export function createUpdateAgent(
  config: WorkerConfig,
  ops: FileOps,
  logger: Logger,
  overrides: {
    download?: Downloader;
    env?: (name: string) => string | undefined;
    redactor?: Pick<Redactor, 'redact'>;
  } = {},
): UpdateAgent | null {
  if (!config.updates.enabled) return null;
  const platform = ops.platform;
  const env = overrides.env ?? ((name: string) => process.env[name]);
  return new UpdateAgent({
    ops,
    data: dataLayout(platform, pathApi(platform).resolve(config.dataDir)),
    install: installLayout(platform, config.updates.installDir ?? defaultInstallDir(platform, env)),
    settings: config.updates,
    currentVersion: WORKER_VERSION,
    trustedKeys: trustedReleaseKeys(config.updates.releaseKeys),
    download:
      overrides.download ?? httpsDownloader({ masterUrl: config.masterUrl, workerVersion: WORKER_VERSION }),
    logger,
    env,
    ...(overrides.redactor === undefined ? {} : { redactor: overrides.redactor }),
  });
}
