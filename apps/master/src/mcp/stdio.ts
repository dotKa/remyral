import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  MAX_MCP_LOCK_BYTES,
  MCP_PACKAGE_HOSTS,
  MCP_STDIO_FEATURE,
  type McpInstallReport,
  type McpInstallsReport,
  type McpLockfile,
  type McpPackageManager,
  McpLockfile as McpLockfileSchema,
  NPM_PACKAGE_NAME,
  PYPI_PACKAGE_NAME,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import type { ActionView, FleetToolsService } from '../fleet-tools/service.js';
import { HttpError } from '../http/errors.js';

/**
 * p14-mcp-stdio (ADR-0054 P4, docs/design/p14-mcp-skills.md §2.7, §14): the master's side of local (stdio) MCP
 * packages. The master **never runs, downloads or unpacks** a package: it only
 *  - looks up a package's registry metadata for the admin's form (`registry.npmjs.org`, `pypi.org`; JSON only, no
 *    redirects, bounded) — the integrity a spec pins;
 *  - creates install / removal actions through the fleet-tools pipeline (canary first, the creator's role re-checked
 *    when a queued machine is reached later);
 *  - stores the lockfile the canary resolved (`mcp_lockfiles`, first write wins, sha256 re-checked after gunzip) and
 *    hands exactly that lock to every other machine;
 *  - records what each machine reports (`mcp_worker_installs`: OPS_UPDATE of the install, CAPABILITIES `mcpInstalls`),
 *    which placement uses: a job pinning a stdio server goes only to a machine with that exact install.
 */

export type McpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface McpPackageInfo {
  readonly manager: McpPackageManager;
  readonly name: string;
  readonly version: string;
  /** npm `dist.integrity` (sha512) / `sha256:<hex>` of the chosen PyPI file. */
  readonly integrity: string;
  /** npm `bin` names (PyPI: unknown from the JSON API — the admin names the console script). */
  readonly bins: string[];
  /** PyPI: the release file the integrity is of. */
  readonly file: string | null;
  readonly license: string | null;
  readonly description: string | null;
}

export interface McpInstallView {
  readonly workerId: string;
  readonly name: string;
  readonly version: string;
  readonly state: 'queued' | 'installing' | 'installed' | 'failed' | 'removed';
  readonly digest: string | null;
  readonly error: string | null;
  readonly updatedAt: string;
  readonly connected: boolean;
}

export interface McpLockView {
  readonly version: string;
  readonly manager: McpPackageManager;
  readonly sha256: string;
  readonly bytes: number;
  readonly producedOnWorker: string;
  readonly createdAt: string;
}

export interface McpStdioWorker {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  readonly canary: boolean;
  readonly os: string;
  readonly arch: string;
}

const LOOKUP_TIMEOUT_MS = 15_000;
const MAX_LOOKUP_BYTES = 4 * 1024 * 1024;
const LOOKUPS_PER_MINUTE = 30;
const EXACT_VERSION = /^[0-9][0-9A-Za-z.+!-]{0,63}$/;

export interface McpStdioDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly fleetTools?: () => FleetToolsService | null;
  readonly connected?: (workerId: string) => boolean;
  /** Registry fetch (tests); default the global fetch. */
  readonly fetch?: McpFetch | null;
}

async function readJson(res: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_LOOKUP_BYTES) throw new Error('too large');
  if (signal.aborted) throw new Error('timeout');
  const body = Buffer.from(await res.arrayBuffer());
  if (body.byteLength > MAX_LOOKUP_BYTES) throw new Error('too large');
  return JSON.parse(body.toString('utf8')) as unknown;
}

function text(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;
}

/** Decodes a received lockfile and checks it is what it claims (size, sha256, manager). */
export function lockBytes(lock: McpLockfile, manager: McpPackageManager): Buffer | null {
  if (!McpLockfileSchema.safeParse(lock).success || lock.manager !== manager) return null;
  let raw: Buffer;
  try {
    raw = gunzipSync(Buffer.from(lock.gz, 'base64'), { maxOutputLength: MAX_MCP_LOCK_BYTES });
  } catch {
    return null;
  }
  if (raw.byteLength !== lock.bytes) return null;
  return createHash('sha256').update(raw).digest('hex') === lock.sha256 ? raw : null;
}

export type McpInstalledListener = (serverId: string, version: string, workerId: string) => Promise<void>;

export class McpStdio {
  readonly #lookups = new Map<string, number[]>();
  readonly #installed: McpInstalledListener[] = [];

  /**
   * p14-mcp-chat: called after a machine's install of a version was recorded `installed` (committed) — a confirmed
   * install card probes the tools on its canary then. A failing listener never fails the report.
   */
  onInstalled(listener: McpInstalledListener): void {
    this.#installed.push(listener);
  }

  constructor(private readonly d: McpStdioDeps) {}

  // ------------------------------------------------------------------------------------------- lookup

  /** Registry metadata of one exact package version (admin form; the spec pins what it returns). */
  async lookup(
    userId: string,
    input: { readonly manager: McpPackageManager; readonly name: string; readonly version: string },
  ): Promise<McpPackageInfo> {
    const now = this.d.clock().getTime();
    const recent = (this.#lookups.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= LOOKUPS_PER_MINUTE) {
      throw new HttpError(
        429,
        'rate_limited',
        'Too many package lookups; try again in a minute.',
        { 'retry-after': '60' },
        {},
        { reason: 'mcp_lookup' },
      );
    }
    this.#lookups.set(userId, [...recent, now]);
    const nameOk =
      input.manager === 'npm' ? NPM_PACKAGE_NAME.test(input.name) : PYPI_PACKAGE_NAME.test(input.name);
    if (!nameOk || input.name.length > 214 || !EXACT_VERSION.test(input.version)) {
      throw new HttpError(
        422,
        'mcp_package_invalid',
        'The package name or version is invalid (an exact version is needed).',
      );
    }
    const url =
      input.manager === 'npm'
        ? `https://${MCP_PACKAGE_HOSTS.npm[0] ?? ''}/${input.name.replaceAll('/', '%2f')}/${encodeURIComponent(input.version)}`
        : `https://pypi.org/pypi/${encodeURIComponent(input.name)}/${encodeURIComponent(input.version)}/json`;
    const fetch: McpFetch = this.d.fetch ?? ((u, i) => globalThis.fetch(u, i));
    const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
    let res: Response;
    let body: unknown;
    try {
      res = await fetch(url, {
        signal,
        redirect: 'error',
        headers: { accept: 'application/json' },
        credentials: 'omit',
      });
      if (res.status === 404) {
        throw new HttpError(
          404,
          'mcp_package_not_found',
          `${input.name} ${input.version} is not on ${input.manager === 'npm' ? 'npm' : 'PyPI'}.`,
          {},
          {},
          { name: input.name, version: input.version },
        );
      }
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      body = await readJson(res, signal);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        502,
        'mcp_registry_unavailable',
        'The package registry did not answer; try again later.',
        {},
        {},
        { manager: input.manager },
      );
    }
    const info = input.manager === 'npm' ? npmInfo(body, input) : pypiInfo(body, input);
    if (info === null) {
      throw new HttpError(
        422,
        'mcp_package_invalid',
        'The registry answer has no usable release file / integrity for this version.',
        {},
        {},
        { reason: 'registry' },
      );
    }
    return info;
  }

  // ------------------------------------------------------------------------------------------- locks

  async lock(serverId: string, version: string): Promise<McpLockfile | null> {
    const { rows } = await this.d.pool.query<{ manager: McpPackageManager; lock: Buffer; sha256: string }>(
      'SELECT manager, lock, sha256 FROM mcp_lockfiles WHERE server_id = $1 AND version = $2',
      [serverId, version],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      manager: r.manager,
      sha256: r.sha256,
      bytes: r.lock.byteLength,
      gz: gzipSync(r.lock, { level: 9 }).toString('base64'),
    };
  }

  async lockViews(db: Queryable, serverId: string): Promise<McpLockView[]> {
    const { rows } = await db.query<{
      version: string;
      manager: McpPackageManager;
      sha256: string;
      bytes: number;
      produced_on_worker: string;
      created_at: Date;
    }>(
      `SELECT version, manager, sha256, octet_length(lock)::int AS bytes, produced_on_worker, created_at
         FROM mcp_lockfiles WHERE server_id = $1 ORDER BY created_at DESC`,
      [serverId],
    );
    return rows.map((r) => ({
      version: r.version,
      manager: r.manager,
      sha256: r.sha256,
      bytes: r.bytes,
      producedOnWorker: r.produced_on_worker,
      createdAt: r.created_at.toISOString(),
    }));
  }

  // --------------------------------------------------------------------------------------- installs

  async installViews(db: Queryable, serverId: string): Promise<McpInstallView[]> {
    const { rows } = await db.query<{
      worker_id: string;
      name: string;
      version: string;
      state: McpInstallView['state'];
      digest: string | null;
      error: string | null;
      updated_at: Date;
    }>(
      `SELECT i.worker_id, w.display_name AS name, i.version, i.state, i.digest, i.error, i.updated_at
         FROM mcp_worker_installs i JOIN workers w ON w.id = i.worker_id
        WHERE i.server_id = $1 ORDER BY i.version, w.display_name`,
      [serverId],
    );
    return rows.map((r) => ({
      workerId: r.worker_id,
      name: r.name,
      version: r.version,
      state: r.state,
      digest: r.digest,
      error: r.error,
      updatedAt: r.updated_at.toISOString(),
      connected: this.d.connected?.(r.worker_id) ?? false,
    }));
  }

  /** Approved machines that install and run local MCP servers (the install and probe pickers). */
  async workers(): Promise<McpStdioWorker[]> {
    const { rows } = await this.d.pool.query<{
      id: string;
      name: string;
      canary: boolean | null;
      os: string | null;
      arch: string | null;
    }>(
      `SELECT w.id, w.display_name AS name, p.canary, w.facts->>'os' AS os, w.facts->>'arch' AS arch
         FROM workers w LEFT JOIN worker_runtime_policies p ON p.worker_id = w.id
        WHERE w.approved_at IS NOT NULL AND w.revoked_at IS NULL AND w.archived_at IS NULL AND w.features ? $1
        ORDER BY w.display_name, w.id`,
      [MCP_STDIO_FEATURE],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      connected: this.d.connected?.(r.id) ?? false,
      canary: r.canary === true,
      os: r.os ?? '',
      arch: r.arch ?? '',
    }));
  }

  async actions(serverId: string): Promise<ActionView[]> {
    const fleet = this.d.fleetTools?.() ?? null;
    return fleet === null ? [] : fleet.listForItem(`mcp:${serverId}`);
  }

  /** Machines with every one of these (id, version) installs in state `installed` (placement). */
  async installedWorkers(db: Queryable, pins: readonly { id: string; version: string }[]): Promise<string[]> {
    if (pins.length === 0) return [];
    const { rows } = await db.query<{ worker_id: string }>(
      `SELECT worker_id FROM mcp_worker_installs
        WHERE state = 'installed' AND (server_id || '@' || version) = ANY ($1::text[])
        GROUP BY worker_id HAVING count(DISTINCT (server_id || '@' || version)) = $2`,
      [pins.map((p) => `${p.id}@${p.version}`), new Set(pins.map((p) => `${p.id}@${p.version}`)).size],
    );
    return rows.map((r) => r.worker_id);
  }

  /** OPS_UPDATE of an `mcp.install` / `mcp.remove` (from the machine that ran it). */
  async onInstallUpdate(input: {
    readonly workerId: string;
    readonly opId: string;
    readonly kind: 'mcp.install' | 'mcp.remove';
    readonly params: Record<string, unknown>;
    readonly state: string;
    readonly reason: string | null;
    readonly detail: string | null;
    readonly report: McpInstallReport | undefined;
  }): Promise<void> {
    const id = typeof input.params.serverId === 'string' ? input.params.serverId : null;
    const version = typeof input.params.version === 'string' ? input.params.version : null;
    if (id === null || version === null) return;
    const now = this.d.clock();
    const outcome = { installed: false };
    await withTransaction(this.d.pool, async (tx) => {
      const v = await tx.query<{ spec_sha256: string; spec: Buffer }>(
        'SELECT spec_sha256, spec FROM mcp_server_versions WHERE server_id = $1 AND version = $2',
        [id, version],
      );
      const row = v.rows[0];
      if (row === undefined) return;
      const upsert = (
        state: McpInstallView['state'],
        extra: {
          digest?: string | null;
          error?: string | null;
          lock?: string | null;
          files?: number | null;
          bytes?: number | null;
        },
      ) =>
        tx.query(
          `INSERT INTO mcp_worker_installs (worker_id, server_id, version, state, digest, error, updated_at, lock_sha256,
                                            files, bytes, op_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (worker_id, server_id, version) DO UPDATE
             SET state = $4, digest = $5, error = $6, updated_at = $7, lock_sha256 = COALESCE($8, mcp_worker_installs.lock_sha256),
                 files = COALESCE($9, mcp_worker_installs.files), bytes = COALESCE($10, mcp_worker_installs.bytes),
                 op_id = $11`,
          [
            input.workerId,
            id,
            version,
            state,
            extra.digest ?? null,
            extra.error === undefined || extra.error === null ? null : extra.error.slice(0, 300),
            now,
            extra.lock ?? null,
            extra.files ?? null,
            extra.bytes ?? null,
            input.opId,
          ],
        );
      if (input.kind === 'mcp.remove') {
        if (input.state === 'succeeded') await upsert('removed', {});
        return;
      }
      if (['accepted', 'running', 'sent'].includes(input.state)) {
        await upsert('installing', {});
        return;
      }
      if (input.state !== 'succeeded' || input.report === undefined) {
        if (['failed', 'refused', 'cancelled', 'lost'].includes(input.state)) {
          await upsert('failed', {
            error: `${input.reason ?? input.state}${input.detail === null ? '' : `: ${input.detail}`}`,
          });
        }
        return;
      }
      const r = input.report;
      const manager = parseManager(row.spec);
      if (r.id !== id || r.version !== version || manager === null || r.manager !== manager) {
        await upsert('failed', { error: 'the report names another server, version or manager' });
        return;
      }
      if (r.lock !== undefined) {
        const raw = lockBytes(r.lock, manager);
        if (raw === null || r.lock.sha256 !== r.lockSha256) {
          await upsert('failed', { error: 'lock_invalid: the reported lockfile does not match its hash' });
          return;
        }
        // First write wins: one canary's resolution is the lock of this version everywhere.
        const ins = await tx.query(
          `INSERT INTO mcp_lockfiles (server_id, version, manager, lock, sha256, produced_on_worker, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (server_id, version) DO NOTHING`,
          [id, version, manager, raw, r.lockSha256, input.workerId, now],
        );
        if ((ins.rowCount ?? 0) > 0) {
          await this.d.audit.record(
            {
              actor: { type: 'worker', id: input.workerId },
              action: 'mcp.lock.stored',
              target: `mcp:${id}`,
              outcome: 'success',
              metadata: {
                serverId: id,
                version,
                manager,
                lockSha256: r.lockSha256,
                bytes: raw.byteLength,
                opId: input.opId,
              },
            },
            tx,
          );
        }
      }
      const stored = await tx.query<{ sha256: string }>(
        'SELECT sha256 FROM mcp_lockfiles WHERE server_id = $1 AND version = $2',
        [id, version],
      );
      const lockSha = stored.rows[0]?.sha256 ?? null;
      if (lockSha === null || lockSha !== r.lockSha256) {
        await upsert('failed', {
          digest: r.digest,
          lock: r.lockSha256,
          error: 'lock_mismatch: this machine installed another lockfile than the one captured on the canary',
        });
        return;
      }
      await upsert('installed', { digest: r.digest, lock: r.lockSha256, files: r.files, bytes: r.bytes });
      outcome.installed = true;
      await this.d.audit.record(
        {
          actor: { type: 'worker', id: input.workerId },
          action: 'mcp.install.result',
          target: `mcp:${id}`,
          outcome: 'success',
          metadata: {
            serverId: id,
            version,
            digest: r.digest,
            lockSha256: r.lockSha256,
            files: r.files,
            opId: input.opId,
            // p19-install-scripts: the approved install scripts this machine ran (and where).
            ...(r.scripts === undefined
              ? {}
              : { scriptsRan: r.scripts.ran, scriptsSandbox: r.scripts.sandbox }),
          },
        },
        tx,
      );
    });
    if (outcome.installed) {
      for (const l of this.#installed) {
        await l(id, version, input.workerId).catch(() => undefined);
      }
    }
  }

  /**
   * CAPABILITIES `mcpInstalls`: what the machine has intact now. Rows it no longer reports become `removed` (a tree
   * found modified, or deleted by hand); reported installs whose lock matches the stored one become `installed`.
   */
  async onInstallsReport(workerId: string, report: McpInstallsReport | undefined): Promise<void> {
    if (report === undefined) return;
    const now = this.d.clock();
    await withTransaction(this.d.pool, async (tx) => {
      const keys = report.map((e) => `${e.id}@${e.version}`);
      await tx.query(
        `UPDATE mcp_worker_installs SET state = 'removed', updated_at = $3, error = 'not reported by the machine any more'
          WHERE worker_id = $1 AND state = 'installed' AND NOT ((server_id || '@' || version) = ANY ($2::text[]))`,
        [workerId, keys, now],
      );
      for (const e of report) {
        const lock = await tx.query<{ sha256: string }>(
          'SELECT sha256 FROM mcp_lockfiles WHERE server_id = $1 AND version = $2',
          [e.id, e.version],
        );
        if (lock.rows[0] === undefined || lock.rows[0].sha256 !== e.lockSha256) continue;
        await tx.query(
          `INSERT INTO mcp_worker_installs (worker_id, server_id, version, state, digest, error, updated_at, lock_sha256)
           SELECT $1, $2, $3, 'installed', $4, NULL, $5, $6
            WHERE EXISTS (SELECT 1 FROM mcp_server_versions WHERE server_id = $2 AND version = $3)
           ON CONFLICT (worker_id, server_id, version) DO UPDATE
             SET state = 'installed', digest = $4, error = NULL, updated_at = $5, lock_sha256 = $6
           WHERE mcp_worker_installs.state <> 'installed' OR mcp_worker_installs.digest IS DISTINCT FROM $4`,
          [workerId, e.id, e.version, e.digest, now, e.lockSha256],
        );
      }
    });
  }
}

function parseManager(spec: Buffer): McpPackageManager | null {
  try {
    const s = JSON.parse(spec.toString('utf8')) as { stdio?: { package?: { manager?: unknown } } };
    const m = s.stdio?.package?.manager;
    return m === 'npm' || m === 'pypi' ? m : null;
  } catch {
    return null;
  }
}

export function npmInfo(body: unknown, input: { name: string; version: string }): McpPackageInfo | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as {
    name?: unknown;
    version?: unknown;
    dist?: { integrity?: unknown };
    bin?: unknown;
    license?: unknown;
    description?: unknown;
  };
  if (b.name !== input.name || b.version !== input.version) return null;
  const integrity = b.dist?.integrity;
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity)) return null;
  const unscoped = input.name.split('/').pop() ?? input.name;
  const bins =
    typeof b.bin === 'string'
      ? [unscoped]
      : typeof b.bin === 'object' && b.bin !== null
        ? Object.keys(b.bin).filter((k) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(k))
        : [];
  return {
    manager: 'npm',
    name: input.name,
    version: input.version,
    integrity,
    bins: bins.slice(0, 16),
    file: null,
    license: text(b.license, 64),
    description: text(b.description, 300),
  };
}

export function pypiInfo(body: unknown, input: { name: string; version: string }): McpPackageInfo | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as {
    info?: { version?: unknown; license?: unknown; summary?: unknown; license_expression?: unknown };
    urls?: { filename?: unknown; packagetype?: unknown; digests?: { sha256?: unknown }; yanked?: unknown }[];
  };
  if (b.info?.version !== input.version || !Array.isArray(b.urls)) return null;
  const files = b.urls.filter(
    (u) =>
      typeof u.filename === 'string' &&
      typeof u.digests?.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(u.digests.sha256) &&
      u.yanked !== true,
  );
  // Wheels only are installed (`--no-build`): prefer a pure-Python wheel, else any wheel.
  const wheel =
    files.find((u) => String(u.filename).endsWith('-py3-none-any.whl')) ??
    files.find((u) => u.packagetype === 'bdist_wheel');
  if (wheel === undefined) return null;
  return {
    manager: 'pypi',
    name: input.name,
    version: input.version,
    integrity: `sha256:${String(wheel.digests?.sha256)}`,
    bins: [],
    file: String(wheel.filename).slice(0, 200),
    license: text(b.info.license_expression, 64) ?? text(b.info.license, 64),
    description: text(b.info.summary, 300),
  };
}
