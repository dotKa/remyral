import type { Logger } from '@remyral/observability';
import {
  DEFAULT_DISK_HYGIENE_MARGIN_BYTES,
  DISK_HYGIENE_CATEGORIES,
  type DiskHygieneCategory,
  type DiskHygieneFreed,
  type DiskHygieneReport,
  type DiskHygieneRun,
  type DiskHygieneTrigger,
  type DiskUsageReport,
} from '@remyral/protocol';
import type { HygieneFs } from './fs.js';
import type { Candidate, HygieneSource } from './sources.js';
import { measureUsage } from './usage.js';

/**
 * p17-disk-selfclean (docs/design/p17-disk-selfclean.md): the worker cleans what it owns when its disk runs low.
 *
 * - **check** (every `checkIntervalMs`, default 5 min): free bytes under the workspace root; below
 *   `workspace.minFreeBytes + margin` a `low_disk` run starts — at most one every `minRunGapMs` (default 30 min).
 * - **daily** (first `firstDailyDelayMs` after the start, then every 24 h): a light run — only `light` candidates.
 * - **manual** (OPS_COMMAND `disk.clean`, "Şimdi temizle"): like a low-disk run, at once.
 *
 * A run removes every `light` candidate, then — for `low_disk` / `manual` while free space is below the target — the
 * other candidates category by category (DISK_HYGIENE_CATEGORIES order: temp, logs, releases, workspaces, runtimes,
 * package caches), oldest first, measuring the free space after each removal. When the target is still not reached,
 * the top-level usage of the data dir and the workspace root is measured for the machine page.
 *
 * One run at a time: a request while one runs joins it. The last run and the time of the last daily run survive a
 * restart (`state` port); a failed removal is counted and logged, never retried in the same run.
 */

export interface HygieneSettings {
  readonly enabled: boolean;
  /** `workspace.minFreeBytes` in effect. */
  readonly thresholdBytes: number;
  readonly marginBytes: number;
}

export interface HygieneState {
  readonly lastRun: DiskHygieneRun | null;
  readonly lastDailyAt: string | null;
  readonly lastLowDiskAt: string | null;
}

export interface HygieneStatePort {
  load(): Promise<HygieneState | null>;
  save(state: HygieneState): Promise<void>;
}

export interface DiskHygieneOptions {
  readonly fs: HygieneFs;
  readonly dataDir: string;
  readonly workspaceRoot: string;
  readonly sources: readonly HygieneSource[];
  readonly settings: () => HygieneSettings;
  readonly state?: HygieneStatePort;
  readonly logger?: Logger;
  readonly clock?: () => Date;
  /** After a run (CAPABILITIES should be re-sent). */
  readonly onChanged?: () => void;
  readonly checkIntervalMs?: number;
  readonly minRunGapMs?: number;
  readonly dailyIntervalMs?: number;
  readonly firstCheckDelayMs?: number;
  readonly firstDailyDelayMs?: number;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export class DiskHygiene {
  readonly #o: DiskHygieneOptions;
  #state: HygieneState = { lastRun: null, lastDailyAt: null, lastLowDiskAt: null };
  #freeBytes: number | null = null;
  #checkedAt: Date | null = null;
  #usage: DiskUsageReport | null = null;
  #running: Promise<DiskHygieneRun> | null = null;
  #timers: NodeJS.Timeout[] = [];
  #nextDailyAt: Date | null = null;
  #stopped = false;

  private constructor(o: DiskHygieneOptions) {
    this.#o = o;
  }

  static async open(o: DiskHygieneOptions): Promise<DiskHygiene> {
    const h = new DiskHygiene(o);
    const loaded = await o.state?.load().catch(() => null);
    if (loaded !== null && loaded !== undefined) h.#state = loaded;
    return h;
  }

  #now(): Date {
    return this.#o.clock?.() ?? new Date();
  }

  #target(s: HygieneSettings): number {
    return s.thresholdBytes + s.marginBytes;
  }

  /** Starts the periodic check and the daily light run. */
  start(): void {
    if (this.#stopped || this.#timers.length > 0) return;
    const check = this.#o.checkIntervalMs ?? 5 * MINUTE;
    const daily = this.#o.dailyIntervalMs ?? DAY;
    const firstCheck = setTimeout(() => {
      void this.check();
      const t = setInterval(() => void this.check(), check);
      t.unref();
      this.#timers.push(t);
    }, this.#o.firstCheckDelayMs ?? MINUTE);
    firstCheck.unref();
    // The daily run keeps its rhythm across restarts: due 24 h after the last one (at least the first delay).
    const last = this.#state.lastDailyAt === null ? null : Date.parse(this.#state.lastDailyAt);
    const now = this.#now().getTime();
    const firstDelay = Math.max(
      this.#o.firstDailyDelayMs ?? 10 * MINUTE,
      last === null || Number.isNaN(last) ? 0 : last + daily - now,
    );
    this.#nextDailyAt = new Date(now + firstDelay);
    const firstDaily = setTimeout(() => {
      void this.#daily();
      const t = setInterval(() => void this.#daily(), daily);
      t.unref();
      this.#timers.push(t);
    }, firstDelay);
    firstDaily.unref();
    this.#timers.push(firstCheck, firstDaily);
  }

  stop(): void {
    this.#stopped = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers = [];
  }

  async #daily(): Promise<void> {
    this.#nextDailyAt = new Date(this.#now().getTime() + (this.#o.dailyIntervalMs ?? DAY));
    if (!this.#o.settings().enabled) return;
    await this.run('daily').catch((err: unknown) => {
      this.#o.logger?.warn('daily disk hygiene failed', { err });
    });
  }

  /** Measures the free space; starts a low-disk run when it is below the target (spaced runs). Never throws. */
  async check(): Promise<DiskHygieneRun | null> {
    try {
      const s = this.#o.settings();
      const free = await this.#o.fs.freeBytes(this.#o.workspaceRoot);
      this.#freeBytes = free;
      this.#checkedAt = this.#now();
      if (!s.enabled || free === null || free >= this.#target(s)) return null;
      const next = this.#nextLowDisk();
      if (next !== null && next.getTime() > this.#now().getTime()) return null;
      return await this.run('low_disk');
    } catch (err) {
      this.#o.logger?.warn('disk hygiene check failed', { err });
      return null;
    }
  }

  #nextLowDisk(): Date | null {
    const last = this.#state.lastLowDiskAt === null ? NaN : Date.parse(this.#state.lastLowDiskAt);
    return Number.isNaN(last) ? null : new Date(last + (this.#o.minRunGapMs ?? 30 * MINUTE));
  }

  /** One run (a request while one runs joins it). */
  run(trigger: DiskHygieneTrigger): Promise<DiskHygieneRun> {
    if (this.#running !== null) return this.#running;
    const p = this.#run(trigger).finally(() => {
      this.#running = null;
    });
    this.#running = p;
    return p;
  }

  async #run(trigger: DiskHygieneTrigger): Promise<DiskHygieneRun> {
    const s = this.#o.settings();
    const target = this.#target(s);
    const startedAt = this.#now();
    const freeBefore = await this.#o.fs.freeBytes(this.#o.workspaceRoot);
    let free = freeBefore;
    const freed = new Map<DiskHygieneCategory, { bytes: number; items: number }>();
    let errors = 0;
    // p17-worker-managed: what another account owns (EPERM / EACCES) is skipped quietly, with a count.
    let skipped = 0;

    const collected: Candidate[] = [];
    for (const source of this.#ordered()) {
      try {
        collected.push(...(await source.collect(startedAt)));
      } catch (err) {
        errors++;
        this.#o.logger?.warn('disk hygiene could not list candidates', { category: source.category, err });
      }
    }
    const rank = (c: DiskHygieneCategory): number => DISK_HYGIENE_CATEGORIES.indexOf(c);
    const order = (a: Candidate, b: Candidate): number => rank(a.category) - rank(b.category) || a.at - b.at;

    const remove = async (c: Candidate): Promise<void> => {
      try {
        const bytes = await c.remove();
        if (bytes === false) return;
        const cur = freed.get(c.category) ?? { bytes: 0, items: 0 };
        freed.set(c.category, { bytes: cur.bytes + bytes, items: cur.items + 1 });
        this.#o.logger?.info('disk hygiene removed', { category: c.category, item: c.label, bytes });
        if (free !== null) {
          const measured = await this.#o.fs.freeBytes(this.#o.workspaceRoot);
          free = measured ?? free + bytes;
        }
      } catch (err) {
        if (notOurs(err)) {
          skipped++;
          this.#o.logger?.debug('disk hygiene skipped an item another account owns', {
            category: c.category,
            item: c.label,
          });
          return;
        }
        errors++;
        this.#o.logger?.warn('disk hygiene could not remove an item', {
          category: c.category,
          item: c.label,
          err,
        });
      }
    };

    for (const c of collected.filter((x) => x.light).sort(order)) await remove(c);
    if (trigger !== 'daily') {
      for (const c of collected.filter((x) => !x.light).sort(order)) {
        // Not measurable: nothing beyond the light candidates (never empty the caches blindly).
        if (free === null || free >= target) break;
        await remove(c);
      }
    }

    const freeAfter = await this.#o.fs.freeBytes(this.#o.workspaceRoot);
    const finishedAt = this.#now();
    const stillLow = freeAfter !== null && freeAfter < target;
    const items = DISK_HYGIENE_CATEGORIES.flatMap((category): DiskHygieneFreed[] => {
      const f = freed.get(category);
      return f === undefined ? [] : [{ category, bytes: f.bytes, items: f.items }];
    });
    const run: DiskHygieneRun = {
      trigger,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      freeBefore: freeBefore === null ? null : Math.floor(freeBefore),
      freeAfter: freeAfter === null ? null : Math.floor(freeAfter),
      freedBytes: items.reduce((n, f) => n + f.bytes, 0),
      freed: items,
      stillLow,
      errors,
      ...(skipped === 0 ? {} : { skipped }),
    };
    this.#freeBytes = freeAfter;
    this.#checkedAt = finishedAt;
    // What uses the space, when the target was not reached (no scan after a light run that was not asked to reach it).
    this.#usage = null;
    if (stillLow && trigger !== 'daily') {
      try {
        this.#usage = await measureUsage(this.#o.fs, this.#o.dataDir, this.#o.workspaceRoot, finishedAt);
      } catch (err) {
        this.#o.logger?.warn('disk usage could not be measured', { err });
      }
    }
    this.#state = {
      lastRun: run,
      lastDailyAt: trigger === 'daily' ? finishedAt.toISOString() : this.#state.lastDailyAt,
      lastLowDiskAt: trigger === 'daily' ? this.#state.lastLowDiskAt : finishedAt.toISOString(),
    };
    await this.#o.state?.save(this.#state).catch((err: unknown) => {
      this.#o.logger?.warn('disk hygiene state could not be saved', { err });
    });
    const log = stillLow ? 'warn' : 'info';
    this.#o.logger?.[log](
      stillLow ? 'disk hygiene finished; free space is still low' : 'disk hygiene finished',
      {
        trigger,
        freedBytes: run.freedBytes,
        freeBefore: run.freeBefore,
        freeAfter: run.freeAfter,
        target,
        errors,
        ...(skipped === 0 ? {} : { skipped }),
      },
    );
    try {
      this.#o.onChanged?.();
    } catch {
      // reporting only
    }
    return run;
  }

  #ordered(): HygieneSource[] {
    const rank = (c: DiskHygieneCategory): number => DISK_HYGIENE_CATEGORIES.indexOf(c);
    return [...this.#o.sources].sort((a, b) => rank(a.category) - rank(b.category));
  }

  /** CAPABILITIES `diskHygiene`. */
  report(): DiskHygieneReport {
    const s = this.#o.settings();
    const next = this.#nextLowDisk();
    return {
      enabled: s.enabled,
      thresholdBytes: s.thresholdBytes,
      marginBytes: s.marginBytes,
      targetBytes: this.#target(s),
      freeBytes: this.#freeBytes === null ? null : Math.floor(this.#freeBytes),
      checkedAt: this.#checkedAt?.toISOString() ?? null,
      running: this.#running !== null,
      lastRun: this.#state.lastRun,
      nextLowDiskAt: next !== null && next.getTime() > this.#now().getTime() ? next.toISOString() : null,
      nextDailyAt: s.enabled ? (this.#nextDailyAt?.toISOString() ?? null) : null,
      usage: this.#usage,
    };
  }
}

/**
 * p17-worker-managed: a removal refused because another account owns the item (Windows: a per-job account's sandbox
 * directory the worker service account may not delete) — EPERM / EACCES, also when wrapped in an AggregateError.
 */
export function notOurs(err: unknown): boolean {
  if (err instanceof AggregateError) return err.errors.length > 0 && err.errors.every((e) => notOurs(e));
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

/** The settings in effect: the panel's `workspace.diskHygiene` (absent: on, default margin) and `minFreeBytes`. */
export function hygieneSettings(
  minFreeBytes: number,
  panel: { readonly enabled: boolean; readonly marginBytes?: number | undefined } | undefined,
): HygieneSettings {
  return {
    enabled: panel?.enabled ?? true,
    thresholdBytes: Math.max(0, Math.floor(minFreeBytes)),
    marginBytes: panel?.marginBytes ?? DEFAULT_DISK_HYGIENE_MARGIN_BYTES,
  };
}
