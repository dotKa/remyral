import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { OriginInput } from '../console-domain/origin.js';
import type { MasterConfig } from '../config.js';
import type { Pool } from '../db/pool.js';
import { InstallerService } from '../installers/service.js';
import type { WorkerHub } from '../workers/hub.js';
import { ReleaseService } from './service.js';

/** The release/installer part of the master's configuration (RELEASE_PUBLIC_KEYS, PUBLIC_ORIGIN, …). */
export interface ReleaseServicesConfig {
  readonly releases?: { readonly publicKeys?: readonly string[] };
  /** `publicOrigin`: PUBLIC_ORIGIN, or the master's live console address (p17-domain-wizard). */
  readonly installers?: { readonly publicOrigin?: OriginInput; readonly publicDownloads?: boolean };
}

/** From the validated environment: what main.ts hands to the master and the release-import CLI uses. */
export function releaseServicesConfig(config: Pick<MasterConfig, 'releasePublicKeys' | 'installers'>): {
  releases: { publicKeys: readonly string[] };
  installers: { publicOrigin: string | null; publicDownloads: boolean };
} {
  return {
    releases: { publicKeys: config.releasePublicKeys },
    installers: {
      publicOrigin: config.installers.publicOrigin,
      publicDownloads: config.installers.publicDownloads,
    },
  };
}

/**
 * The release registry and installer kits with the one verification path of uploads
 * (RELEASE_PUBLIC_KEYS for both the manifest and the installer index). Used by the master (compose.ts)
 * and by the host-side `release-import` CLI, so both verify exactly alike.
 */
export function createReleaseServices(
  base: {
    readonly pool: Pool;
    readonly audit: AuditRecorder;
    readonly hub: WorkerHub;
    readonly clock: () => Date;
    readonly log: FastifyBaseLogger;
  },
  config: ReleaseServicesConfig,
): { releases: ReleaseService; installers: InstallerService } {
  const publicKeys = config.releases?.publicKeys ?? [];
  return {
    releases: new ReleaseService({
      pool: base.pool,
      audit: base.audit,
      hub: base.hub,
      clock: base.clock,
      log: base.log,
      publicKeys,
    }),
    installers: new InstallerService({
      pool: base.pool,
      audit: base.audit,
      clock: base.clock,
      publicKeys,
      publicOrigin: config.installers?.publicOrigin ?? null,
      publicDownloads: config.installers?.publicDownloads ?? true,
    }),
  };
}
