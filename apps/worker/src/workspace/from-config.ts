import type { Logger } from '@remyral/observability';
import type { WorkerConfig } from '../config/schema.js';
import type { WorkspaceManagerOptions } from './manager.js';

/** Manager options from the resolved worker config (the daemon wiring uses this). */
export function workspaceOptionsFromConfig(
  config: Pick<WorkerConfig, 'workspaceRoot' | 'workspace'>,
  logger?: Logger,
): WorkspaceManagerOptions {
  return {
    root: config.workspaceRoot,
    projects: config.workspace.projects,
    retainFailed: config.workspace.retainFailed,
    minFreeBytes: config.workspace.minFreeBytes,
    submodules: config.workspace.submodules,
    symlinks: config.workspace.symlinks,
    ...(logger === undefined ? {} : { logger: logger.child({ component: 'workspace' }) }),
  };
}
