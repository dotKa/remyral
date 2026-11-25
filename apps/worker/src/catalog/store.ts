import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@remyral/observability';
import {
  type AcceptedCatalog,
  type ApplyVersionCatalogPayload,
  type CatalogFloor,
  type CatalogSkip,
  checkVersionCatalog,
  type VersionCatalog,
  type VersionCatalogReport,
  type VersionCatalogStatusPayload,
} from '@remyral/protocol';
import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';

/**
 * p17-update-channel (ADR-0065 §5): the version catalog this worker accepted. The master only delivers bytes; every
 * rule is checked here with this worker's own catalog keys (compiled in or the root-owned config) and its release
 * floor. Stored as the exact bytes + signature under `<dataDir>/catalog/` (0600) and verified again on every start: a
 * catalog whose key is no longer trusted (a rotation) is dropped, so the release pins apply until a catalog of a
 * trusted key arrives — which also resets the sequence.
 */

export interface CatalogStoreOptions {
  readonly ops: FileOps;
  readonly dataDir: string;
  readonly keys: readonly string[];
  /** `updates.catalog` (default true). Off: every delivery is refused, a stored catalog is not used. */
  readonly enabled: boolean;
  readonly floor: CatalogFloor;
  readonly logger: Logger;
  readonly clock?: () => Date;
}

interface Current extends AcceptedCatalog {
  readonly keyId: string;
  readonly skipped: readonly CatalogSkip[];
}

export class CatalogStore {
  readonly #o: CatalogStoreOptions;
  readonly #log: Logger;
  #current: Current | null = null;
  #lastRefusal: { sequence: number; reason: string } | null = null;
  readonly #listeners = new Set<() => void>();

  private constructor(o: CatalogStoreOptions) {
    this.#o = o;
    this.#log = o.logger.child({ component: 'version-catalog' });
  }

  static async open(o: CatalogStoreOptions): Promise<CatalogStore> {
    const s = new CatalogStore(o);
    await s.#load();
    return s;
  }

  get #dir(): string {
    return join(this.#o.dataDir, 'catalog');
  }

  #now(): Date {
    return this.#o.clock?.() ?? new Date();
  }

  async #load(): Promise<void> {
    let bytes: Buffer;
    let sig: unknown;
    try {
      bytes = await readFile(join(this.#dir, 'catalog.json'));
      sig = JSON.parse(await readFile(join(this.#dir, 'catalog.sig.json'), 'utf8'));
    } catch {
      return;
    }
    if (!this.#o.enabled) return;
    const r = checkVersionCatalog(bytes, sig, {
      keys: this.#o.keys,
      previous: null,
      floor: this.#o.floor,
      now: this.#now(),
    });
    if (!r.ok) {
      this.#log.warn('stored version catalog is no longer accepted; the release pins apply', {
        reason: r.reason,
      });
      await rm(this.#dir, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    this.#current = {
      sequence: r.catalog.sequence,
      catalog: r.catalog,
      sha256: r.sha256,
      keyId: r.keyId,
      skipped: r.skipped,
    };
  }

  /** The accepted catalog (null: none — the release pins apply). */
  get catalog(): VersionCatalog | null {
    return this.#current?.catalog ?? null;
  }

  get sequence(): number {
    return this.#current?.sequence ?? 0;
  }

  /** Called after a newly accepted catalog was stored. */
  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  report(): VersionCatalogReport {
    const c = this.#current;
    return {
      enabled: this.#o.enabled,
      keys: Math.min(this.#o.keys.length, 2),
      sequence: c?.sequence ?? 0,
      ...(c === null ? {} : { keyId: c.keyId, generatedAt: c.catalog.generatedAt }),
      ...(c === null || c.skipped.length === 0 ? {} : { skipped: c.skipped.slice(0, 64) }),
      ...(this.#lastRefusal === null ? {} : { lastRefusal: this.#lastRefusal }),
    };
  }

  #refused(sequence: number, reason: string, detail?: string): VersionCatalogStatusPayload {
    this.#lastRefusal = { sequence, reason };
    this.#log.warn('version catalog refused', { sequence, reason, detail });
    return { sequence, outcome: 'refused', reason, ...(detail === undefined ? {} : { detail }) };
  }

  /** APPLY_VERSION_CATALOG: verify, store, notify. Never throws for a bad delivery. */
  async apply(p: ApplyVersionCatalogPayload): Promise<VersionCatalogStatusPayload> {
    if (!this.#o.enabled) return this.#refused(p.sequence, 'catalog_disabled');
    const bytes = Buffer.from(p.catalog, 'base64');
    const r = checkVersionCatalog(bytes, p.signature, {
      keys: this.#o.keys,
      previous: this.#current,
      floor: this.#o.floor,
      now: this.#now(),
    });
    if (!r.ok) return this.#refused(p.sequence, r.reason, r.detail);
    if (r.catalog.sequence !== p.sequence) {
      return this.#refused(p.sequence, 'invalid_catalog', 'the delivery names another sequence');
    }
    if (r.alreadyCurrent) return { sequence: p.sequence, outcome: 'already_current' };
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(this.#o.ops, join(this.#dir, 'catalog.sig.json'), JSON.stringify(p.signature), {
      mode: 0o600,
    });
    await atomicWriteFile(this.#o.ops, join(this.#dir, 'catalog.json'), bytes, { mode: 0o600 });
    this.#current = {
      sequence: r.catalog.sequence,
      catalog: r.catalog,
      sha256: r.sha256,
      keyId: r.keyId,
      skipped: r.skipped,
    };
    this.#lastRefusal = null;
    this.#log.info('version catalog accepted', {
      sequence: r.catalog.sequence,
      keyId: r.keyId,
      skipped: r.skipped.length,
    });
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch (err) {
        this.#log.warn('version catalog listener failed', { err });
      }
    }
    return {
      sequence: p.sequence,
      outcome: 'accepted',
      ...(r.skipped.length === 0 ? {} : { skipped: r.skipped.slice(0, 64) }),
    };
  }
}
