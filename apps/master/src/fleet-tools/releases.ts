import {
  type McpLockfile,
  NpmIntegrity,
  RUNTIME_PINS,
  runtimePackageVersion,
  type RuntimeKind,
  RuntimeVersion,
  type UnverifiedRuntimeSource,
} from '@remyral/protocol';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { FeedError } from './feed.js';

/**
 * p16-runtime-updates §2.1 (docs/design/p16-runtime-updates.md): the release of a runtime version that is not the worker
 * release's pin — the runtime's own npm package (RUNTIME_PINS[rt].package) at exactly the version that brings it and
 * the registry's sha512 of its tarball, read from the version document `https://registry.npmjs.org/<pkg>/<version>`
 * through the version feed's boundaries (allowlisted https host, no redirects, no credentials, 10 s, 4 MiB). Never a
 * `latest` tag or a range. Stored in `runtime_candidates` (one row per runtime version) together with the dependency
 * lock the first machine resolved, so every later machine installs the same tree.
 */

export interface RuntimeCandidate {
  readonly runtime: RuntimeKind;
  readonly version: string;
  readonly package: string;
  readonly packageVersion: string;
  readonly integrity: string;
  readonly resolvedAt: string;
  readonly lock: McpLockfile | null;
  readonly lockWorkerId: string | null;
  readonly verifyState: 'none' | 'running' | 'passed' | 'failed';
  readonly verifiedAt: string | null;
}

interface Row {
  runtime: RuntimeKind;
  version: string;
  package: string;
  package_version: string;
  integrity: string;
  resolved_at: Date;
  lock_gz: string | null;
  lock_sha256: string | null;
  lock_bytes: number | null;
  lock_worker_id: string | null;
  verify_state: RuntimeCandidate['verifyState'];
  verified_at: Date | null;
}

const COLUMNS = `runtime, version, package, package_version, integrity, resolved_at, lock_gz, lock_sha256, lock_bytes,
  lock_worker_id, verify_state, verified_at`;

function view(r: Row): RuntimeCandidate {
  return {
    runtime: r.runtime,
    version: r.version,
    package: r.package,
    packageVersion: r.package_version,
    integrity: r.integrity,
    resolvedAt: r.resolved_at.toISOString(),
    lock:
      r.lock_gz === null || r.lock_sha256 === null || r.lock_bytes === null
        ? null
        : { manager: 'npm', sha256: r.lock_sha256, bytes: r.lock_bytes, gz: r.lock_gz },
    lockWorkerId: r.lock_worker_id,
    verifyState: r.verify_state,
    verifiedAt: r.verified_at?.toISOString() ?? null,
  };
}

/** The registry URL of one exact version document (scoped names keep their `/` encoded). */
export function versionDocumentUrl(pkg: string, version: string): string {
  return `https://registry.npmjs.org/${pkg.replaceAll('/', '%2F')}/${encodeURIComponent(version)}`;
}

export class RuntimeReleases {
  constructor(
    private readonly d: {
      readonly pool: Pool;
      readonly clock: () => Date;
      /** The version feed's bounded JSON reader; null: feeds are off (FLEET_TOOLS_FEED=off) — nothing is resolved. */
      readonly getJson: ((url: string) => Promise<unknown>) | null;
    },
  ) {}

  get enabled(): boolean {
    return this.d.getJson !== null;
  }

  async get(runtime: RuntimeKind, version: string): Promise<RuntimeCandidate | null> {
    const { rows } = await this.d.pool.query<Row>(
      `SELECT ${COLUMNS} FROM runtime_candidates WHERE runtime = $1 AND version = $2`,
      [runtime, version],
    );
    return rows[0] === undefined ? null : view(rows[0]);
  }

  async list(): Promise<RuntimeCandidate[]> {
    const { rows } = await this.d.pool.query<Row>(
      `SELECT ${COLUMNS} FROM runtime_candidates ORDER BY runtime, resolved_at DESC`,
    );
    return rows.map(view);
  }

  /**
   * The stored candidate, or the release read from the registry now (and stored). Refusals are typed 409 / 502 answers
   * the console explains: `feed_disabled`, `version_not_on_pinned_line`, `runtime_release_not_found`, `release_unreadable`,
   * `release_mismatch`.
   */
  async resolve(runtime: RuntimeKind, version: string): Promise<RuntimeCandidate> {
    if (!RuntimeVersion.safeParse(version).success) {
      throw new HttpError(400, 'version_invalid', 'Not an exact runtime version.', {}, {}, { version });
    }
    const known = await this.get(runtime, version);
    if (known !== null) return known;
    const getJson = this.d.getJson;
    if (getJson === null) {
      throw new HttpError(
        409,
        'feed_disabled',
        'This master reads no package registry (FLEET_TOOLS_FEED=off), so it cannot resolve a version outside the pins.',
      );
    }
    const pin = RUNTIME_PINS[runtime];
    const packageVersion = runtimePackageVersion(runtime, version);
    if (packageVersion === null) {
      throw new HttpError(
        409,
        'version_not_on_pinned_line',
        `${runtime} ${version} is not on the line of the pinned ${pin.version}; only a worker release can bring it.`,
        {},
        {},
        { runtime, version, pin: pin.version },
      );
    }
    let doc: unknown;
    try {
      doc = await getJson(versionDocumentUrl(pin.package, packageVersion));
    } catch (err) {
      const why = err instanceof FeedError ? err.message : 'request failed';
      throw new HttpError(
        why === 'HTTP 404' ? 409 : 502,
        why === 'HTTP 404' ? 'runtime_release_not_found' : 'release_unreadable',
        why === 'HTTP 404'
          ? `${pin.package}@${packageVersion} is not published on the npm registry.`
          : `The npm registry could not be read for ${pin.package}@${packageVersion} (${why}).`,
        {},
        {},
        { package: pin.package, version: packageVersion, why },
      );
    }
    const o = doc !== null && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
    const dist = o.dist !== null && typeof o.dist === 'object' ? (o.dist as Record<string, unknown>) : {};
    const integrity = NpmIntegrity.safeParse(dist.integrity);
    if (o.name !== pin.package || o.version !== packageVersion || !integrity.success) {
      throw new HttpError(
        502,
        'release_mismatch',
        `The registry answer for ${pin.package}@${packageVersion} is not that release (name, version or sha512 integrity).`,
        {},
        {},
        { package: pin.package, version: packageVersion },
      );
    }
    // Claude Code: the agent SDK must bundle exactly the requested CLI version.
    if (runtime === 'claude-code' && o.claudeCodeVersion !== version) {
      throw new HttpError(
        409,
        'release_mismatch',
        `${pin.package}@${packageVersion} bundles Claude Code ${typeof o.claudeCodeVersion === 'string' ? o.claudeCodeVersion : '?'}, not ${version}.`,
        {},
        {},
        {
          reason: 'claude_code',
          package: pin.package,
          version: packageVersion,
          bundled: typeof o.claudeCodeVersion === 'string' ? o.claudeCodeVersion : '?',
          requested: version,
        },
      );
    }
    await this.d.pool.query(
      `INSERT INTO runtime_candidates (runtime, version, package, package_version, integrity, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (runtime, version) DO NOTHING`,
      [runtime, version, pin.package, packageVersion, integrity.data, this.d.clock()],
    );
    const stored = await this.get(runtime, version);
    if (stored === null) throw new Error('runtime candidate not stored');
    return stored;
  }

  /** The source an OPS_COMMAND carries (with the shared lock once a machine resolved it). */
  static source(c: RuntimeCandidate): UnverifiedRuntimeSource {
    return {
      package: c.package,
      packageVersion: c.packageVersion,
      integrity: c.integrity,
      ...(c.lock === null ? {} : { lock: c.lock }),
    };
  }

  /** Keeps the first lock a machine resolved for this release (later ones are ignored). */
  async storeLock(runtime: string, version: string, workerId: string, lock: McpLockfile): Promise<boolean> {
    if (lock.manager !== 'npm') return false;
    const r = await this.d.pool.query(
      `UPDATE runtime_candidates SET lock_gz = $3, lock_sha256 = $4, lock_bytes = $5, lock_worker_id = $6, lock_at = $7
        WHERE runtime = $1 AND version = $2 AND lock_gz IS NULL`,
      [runtime, version, lock.gz, lock.sha256, lock.bytes, workerId, this.d.clock()],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async setVerifyState(
    runtime: string,
    version: string,
    state: RuntimeCandidate['verifyState'],
  ): Promise<void> {
    await this.d.pool.query(
      `UPDATE runtime_candidates SET verify_state = $3,
              verified_at = CASE WHEN $3 IN ('passed', 'failed') THEN $4::timestamptz ELSE verified_at END
        WHERE runtime = $1 AND version = $2`,
      [runtime, version, state, this.d.clock()],
    );
  }
}
