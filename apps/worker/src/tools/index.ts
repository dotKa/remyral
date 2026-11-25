import type { Logger, Redactor } from '@remyral/observability';
import type { CustomToolInstall, ToolInventoryEntry, ToolRecipeId } from '@remyral/protocol';
import type { FileOps } from '../fs/ops.js';
import type { ToolsPort } from '../remote-ops/agent.js';
import type { SourceOptions } from '../remote-ops/fetch.js';
import { type FileLog, tailLog } from '../remote-ops/logs.js';
import type { RunFn } from '../remote-ops/process.js';
import { createNodeSystem } from '../system/node.js';
import type { System } from '../system/types.js';
import { detectTools } from './detect.js';
import { inspectMachine } from './inspect.js';
import { type CustomManagedTool, type ManagedTool, ToolInstaller, ToolRefusal } from './installer.js';
import { ToolInventory } from './inventory.js';
import { recipePlatform } from './recipes.js';

export { ToolInstaller, ToolRefusal, type CustomManagedTool } from './installer.js';
export { ToolInventory } from './inventory.js';
export { RECIPES, PLAYWRIGHT_CHROMIUM_REVISION, elevatedRecipePrompt } from './recipes.js';

export interface ToolsWiring {
  readonly installer: ToolInstaller;
  readonly inventory: ToolInventory;
  readonly port: ToolsPort;
}

/** p5-machine-admin §2: tool inventory, unprivileged recipe installs and read-only inspection for remote ops. */
export async function openTools(d: {
  readonly ops: FileOps;
  readonly dataDir: string;
  readonly logger: Logger;
  readonly redactor: Pick<Redactor, 'redact'>;
  readonly log: FileLog | null;
  readonly run: RunFn;
  readonly env: Readonly<Record<string, string>>;
  readonly source?: SourceOptions;
  /** Test seams. */
  readonly sys?: System;
  readonly detect?: (
    managed: readonly ManagedTool[],
    custom: readonly CustomManagedTool[],
  ) => Promise<ToolInventoryEntry[]>;
  readonly ttlSec?: number;
  /** p13-fleet-tools: the worker config's `gitBinary`. */
  readonly gitBinary?: string;
  /**
   * p13-fleet-tools (ADR-0052): why a custom install is refused here now (null: allowed) — machine administration
   * enabled by the owner for this worker, and the local ceiling does not forbid custom tools.
   */
  readonly customAllowed?: () => string | null;
}): Promise<ToolsWiring> {
  const installer = await ToolInstaller.open({
    ops: d.ops,
    dataDir: d.dataDir,
    platform: recipePlatform(process.platform, process.arch),
    logger: d.logger,
    ...(d.source === undefined ? {} : { source: d.source }),
  });
  const sys = d.sys ?? createNodeSystem();
  const inventory = await ToolInventory.open({
    ops: d.ops,
    dataDir: d.dataDir,
    installer,
    detect:
      d.detect ?? ((managed, custom) => detectTools({ sys }, managed, { custom, toolsRoot: installer.root })),
    logger: d.logger,
    ...(d.gitBinary === undefined ? {} : { gitBinary: () => d.gitBinary }),
    ...(d.ttlSec === undefined ? {} : { ttlSec: d.ttlSec }),
  });
  const port: ToolsPort = {
    report: () => inventory.report(),
    detect: () => inventory.refresh(),
    install: async (tool: ToolRecipeId, version: string, opts) => {
      const m = await installer.install(tool, version, opts);
      return { version: m.version };
    },
    remove: (tool, version) => installer.remove(tool, version),
    installCustom: async (spec: CustomToolInstall, opts) => {
      const why =
        d.customAllowed === undefined ? 'custom tools are not enabled on this worker' : d.customAllowed();
      if (why !== null) throw new ToolRefusal('custom_tools_not_allowed', why);
      const m = await installer.installCustom(spec, opts);
      return { version: m.version };
    },
    removeCustom: (name, version) => installer.removeCustom(name, version),
    inspect: (sections) =>
      inspectMachine(
        {
          platform: process.platform,
          run: d.run,
          env: d.env,
          cwd: d.dataDir,
          redact: (s) => d.redactor.redact(s),
          logs: async () =>
            d.log === null || !d.log.available()
              ? []
              : (await tailLog(d.log, d.redactor, { lines: 200, maxBytes: 64 * 1024 })).lines,
          tools: () => inventory.report(),
        },
        sections,
      ),
  };
  return { installer, inventory, port };
}

/** A line for job prompts that need a browser and get the worker-managed one (null: nothing to say). */
export async function browserHint(inventory: ToolInventory): Promise<string | null> {
  const b = await inventory.managedBrowser();
  if (b === null) return null;
  return (
    `A Chromium browser installed by the worker is available: executable ${b.executable}. ` +
    `For Playwright set PLAYWRIGHT_BROWSERS_PATH=${b.browsersPath} (revision chromium-1248) or pass executablePath.`
  );
}
