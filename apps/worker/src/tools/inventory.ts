import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from '@remyral/observability';
import {
  resolveEffectiveTools,
  satisfiedToolNames,
  type ToolInventoryEntry,
  ToolInventoryReport,
  type ToolRecipeId,
} from '@remyral/protocol';
import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import type { CustomManagedTool, ManagedTool, ToolInstaller } from './installer.js';

/**
 * The machine's tool inventory (p5-machine-admin §2): detected once, cached in memory and in
 * `<dataDir>/tools/inventory.json` (so a restart does not probe again), refreshed after `ttlSec` or on demand
 * (`tools.detect`, after a tool install / removal). Concurrent callers share one detection.
 */

export const DEFAULT_TOOLS_TTL_SEC = 6 * 3600;

export interface ToolInventoryDeps {
  readonly ops: FileOps;
  readonly dataDir: string;
  readonly installer: ToolInstaller;
  readonly detect: (
    managed: readonly ManagedTool[],
    custom: readonly CustomManagedTool[],
  ) => Promise<ToolInventoryEntry[]>;
  readonly logger: Logger;
  /** p13-fleet-tools: the worker config's `gitBinary` (it wins over every install for the worker's git). */
  readonly gitBinary?: () => string | undefined;
  readonly ttlSec?: number;
  readonly clock?: () => Date;
  /** Delay of a background detection started by `snapshot` (default 20 s). */
  readonly detectDelayMs?: number;
}

export class ToolInventory {
  readonly #d: ToolInventoryDeps;
  #current: ToolInventoryReport | null = null;
  #running: Promise<ToolInventoryReport> | null = null;
  #scheduled: NodeJS.Timeout | null = null;

  private constructor(d: ToolInventoryDeps) {
    this.#d = d;
  }

  static async open(d: ToolInventoryDeps): Promise<ToolInventory> {
    const inv = new ToolInventory(d);
    try {
      const parsed = ToolInventoryReport.safeParse(JSON.parse(await readFile(inv.#file, 'utf8')));
      if (parsed.success) inv.#current = parsed.data;
    } catch {
      // nothing cached yet
    }
    return inv;
  }

  get #file(): string {
    return join(this.#d.dataDir, 'tools', 'inventory.json');
  }

  get #ttlSec(): number {
    return this.#d.ttlSec ?? DEFAULT_TOOLS_TTL_SEC;
  }

  #now(): Date {
    return this.#d.clock?.() ?? new Date();
  }

  #fresh(r: ToolInventoryReport): boolean {
    return this.#now().getTime() - Date.parse(r.detectedAt) < r.ttlSec * 1000;
  }

  /** The cached inventory (detects when there is none or it expired). */
  async report(): Promise<ToolInventoryReport> {
    const cur = this.#current;
    if (cur !== null && this.#fresh(cur)) {
      // Recipes change with installs only; keep them current without a new detection.
      return { ...cur, recipes: await this.#d.installer.report() };
    }
    return this.refresh();
  }

  /** Detects again now (shared by concurrent callers). */
  refresh(): Promise<ToolInventoryReport> {
    this.#running ??= this.#detect().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #detect(): Promise<ToolInventoryReport> {
    const started = Date.now();
    const managed = await this.#d.installer.installed();
    const custom = await this.#d.installer.installedCustom();
    const tools = await this.#d.detect(managed, custom);
    const report: ToolInventoryReport = ToolInventoryReport.parse({
      detectedAt: this.#now().toISOString(),
      ttlSec: this.#ttlSec,
      tools,
      recipes: await this.#d.installer.report(),
      // p13-fleet-tools: which install jobs use, so the panel does not list one tool twice without saying so.
      effective: resolveEffectiveTools(tools, { gitBinary: this.#d.gitBinary?.() }),
    });
    this.#current = report;
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 }).catch(() => undefined);
    await atomicWriteFile(this.#d.ops, this.#file, JSON.stringify(report), { mode: 0o600 }).catch(
      (err: unknown) => {
        this.#d.logger.warn('could not persist the tool inventory', { err });
      },
    );
    this.#d.logger.info('tools detected', {
      found: tools
        .filter((t) => t.found)
        .map((t) => `${t.name}${t.version === undefined ? '' : `@${t.version}`}`),
      ms: Date.now() - started,
    });
    return report;
  }

  /**
   * For CAPABILITIES without waiting: the cached inventory (possibly expired, null before the first detection).
   * When there is none or it expired, a detection starts in the background and `onRefreshed` runs after it.
   */
  async snapshot(onRefreshed?: () => void): Promise<ToolInventoryReport | null> {
    const cur = this.#current;
    if ((cur === null || !this.#fresh(cur)) && this.#running === null && this.#scheduled === null) {
      // Detection spawns a handful of short-lived processes: not in the middle of a (re)connect.
      this.#scheduled = setTimeout(() => {
        this.#scheduled = null;
        void this.refresh()
          .then(() => onRefreshed?.())
          .catch((err: unknown) => {
            this.#d.logger.warn('tool detection failed', { err });
          });
      }, this.#d.detectDelayMs ?? 20_000);
      this.#scheduled.unref();
    }
    return cur === null ? null : { ...cur, recipes: await this.#d.installer.report() };
  }

  /** Cancels a scheduled background detection (daemon shutdown). */
  stop(): void {
    if (this.#scheduled !== null) clearTimeout(this.#scheduled);
    this.#scheduled = null;
  }

  /** CAPABILITIES.tools: found tools and their aliases (`browser`, `container`), with versions. */
  static capabilityTools(r: ToolInventoryReport): { name: string; version: string }[] {
    const byName = new Map<string, string>();
    for (const t of r.tools) if (t.found && !byName.has(t.name)) byName.set(t.name, t.version ?? '');
    return satisfiedToolNames(r).map((name) => ({
      name,
      version: (byName.get(name) ?? (name === 'browser' ? firstBrowserVersion(r) : '')).slice(0, 64),
    }));
  }

  /** Path of the worker-managed browser executable (for jobs: REMYRAL_BROWSER), or null. */
  async managedBrowser(): Promise<{ executable: string; browsersPath: string } | null> {
    const m = (await this.#d.installer.installed()).find(
      (t) => t.tool === ('browser' satisfies ToolRecipeId),
    );
    return m === undefined ? null : { executable: m.entry, browsersPath: m.dir };
  }
}

function firstBrowserVersion(r: ToolInventoryReport): string {
  return (
    r.tools.find((t) => t.found && ['chrome', 'edge', 'chromium', 'playwright-chromium'].includes(t.name))
      ?.version ?? ''
  );
}
