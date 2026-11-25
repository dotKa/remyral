import type { Logger } from '@remyral/observability';
import {
  type ConfigRejection,
  type LeaseKey,
  type MasterToWorker,
  verifyWorkerConfigSignature,
  type WorkerConfigDelivery,
  workerConfigHash,
  workerConfigIssues,
  type WorkerConfigReport,
  type WorkerConfigStatusPayload,
} from '@remyral/protocol';
import type { z } from 'zod';
import type { WorkerConfig } from '../config/schema.js';
import type { FileOps } from '../fs/ops.js';
import {
  configReport,
  type EffectiveConfig,
  effectiveConfig,
  type EffectiveResult,
  type VaultLookup,
} from './effective.js';
import { WorkerConfigStore } from './store.js';
import {
  changedSettingPaths,
  machineAdminInEffect,
  type SettingsPlan,
  settingsPlan,
  type SettingsValues,
} from './settings.js';
import { LIVE_SETTING_PATHS, type ConfigBlock } from '@remyral/protocol';
import { ceilingOf } from '../config/ceiling.js';

/**
 * p17-worker-managed: what the daemon started with — the local file's config (before the panel's settings were laid
 * over it), the values in effect since the start and the start-time refusals (runtime paths that failed their check).
 */
export interface SettingsContext {
  readonly file: WorkerConfig;
  readonly boot: SettingsValues;
  readonly bootBlocked: readonly ConfigBlock[];
  readonly platform: NodeJS.Platform;
}

export type ApplyWorkerConfigPayload = Extract<MasterToWorker, { type: 'APPLY_WORKER_CONFIG' }>['payload'];
export type WorkerConfigStatus = z.infer<typeof WorkerConfigStatusPayload>;

/** Master keys a delivery signature is checked against (the job runner's lease keyring). */
export interface ConfigKeySource {
  /** Pinned `masterLeaseKeys` when configured, else the current session's keys. */
  readonly keys: readonly LeaseKey[];
  /** True when the keys are pinned in the local file (then an unsigned document is always refused). */
  readonly pinned: boolean;
}

export interface ApplyResult {
  readonly status: WorkerConfigStatus;
  /** The effective configuration changed (CAPABILITIES must be re-sent). */
  readonly changed: boolean;
}

/**
 * Panel-managed configuration on the worker (ADR-0015): validates APPLY_WORKER_CONFIG, persists the applied
 * document, computes the effective configuration (panel ∩ local ceiling) and notifies subscribers so it takes
 * effect without a restart (state machine limits, workspace allowlist, runtime registry, job admission).
 */
export class ManagedConfig {
  #result: EffectiveResult;
  readonly #listeners = new Set<(e: EffectiveConfig) => void>();
  readonly #log: Logger;
  /** p5-credentials-models: held vault credentials (target env vars of vault references). */
  #vault: VaultLookup = { held: () => false, env: () => undefined };
  /** p17-worker-managed: the settings context (null: a caller that does not manage settings, e.g. tests). */
  #settings: SettingsContext | null = null;

  private constructor(
    private readonly config: WorkerConfig,
    private readonly store: WorkerConfigStore,
    private readonly keySource: () => ConfigKeySource,
    logger: Logger,
    private readonly clock: () => Date,
  ) {
    this.#log = logger.child({ component: 'worker-config' });
    this.#result = effectiveConfig(config, store.delivery);
  }

  static async open(
    ops: FileOps,
    config: WorkerConfig,
    keySource: () => ConfigKeySource,
    logger: Logger,
    clock: () => Date = () => new Date(),
    settings: SettingsContext | null = null,
  ): Promise<{ managed: ManagedConfig; corrupt: boolean }> {
    const { store, corrupt } = await WorkerConfigStore.open(ops, config.dataDir);
    const managed = new ManagedConfig(config, store, keySource, logger, clock);
    managed.#settings = settings;
    if (corrupt) {
      managed.#log.error(
        'stored panel configuration is unreadable; the local file applies until the master re-delivers',
      );
    }
    return { managed, corrupt };
  }

  get effective(): EffectiveConfig {
    return this.#result.config;
  }

  get generation(): number {
    return this.store.generation;
  }

  /** Attaches the credential vault and recomputes (vault references then map to the held env vars). */
  setVault(vault: VaultLookup): boolean {
    this.#vault = vault;
    return this.refresh();
  }

  /**
   * Recomputes the effective configuration (e.g. after a vault credential arrived or was revoked) and notifies
   * subscribers when it changed. Returns whether it changed.
   */
  refresh(): boolean {
    const before = JSON.stringify(this.#result.config);
    this.#result = effectiveConfig(this.config, this.store.delivery, this.#vault);
    const changed = JSON.stringify(this.#result.config) !== before;
    if (changed) this.#notify();
    return changed;
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener(this.#result.config);
      } catch (err) {
        this.#log.error('applying the new configuration to a component failed', { err });
      }
    }
  }

  /**
   * p17-worker-managed: the settings the current document asks for (pins, floor and runtime-path rules applied against
   * the local file), or null without a settings context.
   */
  desiredSettings(): SettingsPlan | null {
    const c = this.#settings;
    if (c === null) return null;
    const d = this.store.delivery;
    return settingsPlan(c.file, d?.document.settings, {
      machineAdmin: machineAdminInEffect(c.file, d),
      platform: c.platform,
    });
  }

  /** p17-worker-managed: a live setting (the log level) was applied without a restart. */
  markLive(values: Partial<Pick<SettingsValues, 'logLevel'>>): void {
    const c = this.#settings;
    if (c === null) return;
    this.#settings = { ...c, boot: { ...c.boot, ...values } };
  }

  #settingsReport(): Parameters<typeof configReport>[5] {
    const c = this.#settings;
    const plan = this.desiredSettings();
    if (c === null || plan === null) return undefined;
    const pending = changedSettingPaths(plan.values, c.boot).filter((p) => !LIVE_SETTING_PATHS.has(p));
    // Start-time refusals still matter while the document asks for the same paths.
    const bootBlocked = c.bootBlocked.filter((b) => !pending.some((p) => b.path === `settings.${p}`));
    return {
      values: c.boot,
      pinned: [...(ceilingOf(c.file).pins.settings ?? [])],
      pendingRestart: pending,
      blocked: [...plan.blocked, ...bootBlocked.filter((b) => !plan.blocked.some((x) => x.path === b.path))],
    };
  }

  report(): WorkerConfigReport {
    const d = this.store.delivery;
    const at = this.store.appliedAt;
    return configReport(
      this.config,
      this.#result,
      d === null || at === null
        ? null
        : { generation: d.generation, documentHash: d.documentHash, appliedAt: at },
      this.store.lastRejection,
      this.#vault,
      this.#settingsReport(),
    );
  }

  /** Called with every new effective configuration. */
  subscribe(listener: (e: EffectiveConfig) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Validates and applies one delivery. Never throws for a bad delivery: it is rejected with a reason. */
  async apply(workerId: string | null, payload: ApplyWorkerConfigPayload): Promise<ApplyResult> {
    const applied = this.store.generation;
    const status = (outcome: WorkerConfigStatus['outcome'], detail?: string): ApplyResult => ({
      status: {
        generation: payload.generation,
        outcome,
        report: this.report(),
        ...(detail === undefined ? {} : { detail }),
      },
      changed: false,
    });
    if (payload.generation < applied) {
      this.#log.info('older panel configuration ignored', { received: payload.generation, applied });
      return status('stale', `generation ${String(applied)} is already applied`);
    }
    const hash = workerConfigHash(payload.document);
    if (hash !== payload.documentHash)
      return this.#reject(payload, 'hash_mismatch', 'document hash does not match');
    if (payload.generation === applied) {
      if (hash === this.store.delivery?.documentHash) return status('unchanged');
      return this.#reject(
        payload,
        'generation_conflict',
        `generation ${String(applied)} was applied with another document`,
      );
    }
    // p5-credentials-models: this build understands vault references (`credential-vault-v1`).
    // p13-runtime-accounts: and added runtime accounts (`runtime-accounts-v1`).
    const issues = workerConfigIssues(payload.document, { vault: true, accounts: true });
    if (issues.length > 0) {
      const onlyCredential = issues.every((i) => i.code === 'credential_source_unsupported');
      return this.#reject(
        payload,
        onlyCredential ? 'credential_source_unsupported' : 'invalid_document',
        onlyCredential
          ? 'credential vault references are not supported by this worker release'
          : 'document is inconsistent',
        issues.slice(0, 50).map((i) => ({ path: i.path.slice(0, 256), code: i.code.slice(0, 64) })),
      );
    }
    if (workerId === null) return this.#reject(payload, 'not_enrolled', 'worker is not enrolled');
    const { keys, pinned } = this.keySource();
    if (keys.length > 0 || pinned) {
      const v = verifyWorkerConfigSignature(workerId, payload, keys);
      if (v === 'missing')
        return this.#reject(payload, 'unsigned', 'the document is not signed by a trusted master key');
      if (v !== 'ok') return this.#reject(payload, 'bad_signature', `signature check failed: ${v}`);
    } else if (payload.document.panelSkillKeys !== undefined) {
      // ADR-0021: a skills trust root is never taken from a document nobody signed.
      return this.#reject(
        payload,
        'unsigned',
        'panel skills keys are only accepted in a document signed by a trusted master key',
      );
    } else {
      this.#log.warn(
        'panel configuration accepted without signature check: the master announced no lease keys',
        {
          generation: payload.generation,
        },
      );
    }

    const before = JSON.stringify(this.#result.config);
    await this.store.saveApplied(payload, this.clock().toISOString());
    this.#result = effectiveConfig(this.config, payload, this.#vault);
    const changed = JSON.stringify(this.#result.config) !== before;
    this.#log.info('panel configuration applied', {
      generation: payload.generation,
      documentHash: payload.documentHash,
      projects: Object.keys(this.#result.config.projects).length,
      runtimes: this.#result.config.allowedRuntimes.length,
      maxParallelJobs: this.#result.config.maxParallelJobs,
      blocked: this.#result.blocked.length,
      changed,
    });
    if (changed) this.#notify();
    return { ...status('applied'), changed };
  }

  async #reject(
    payload: WorkerConfigDelivery,
    reason: string,
    detail: string,
    issues: ConfigRejection['issues'] = [],
  ): Promise<ApplyResult> {
    const rejection: ConfigRejection = { generation: payload.generation, reason, detail, issues };
    await this.store.saveRejection(rejection);
    this.#log.error('panel configuration refused; keeping the previous one', {
      generation: payload.generation,
      reason,
      issues: issues.length,
    });
    return {
      status: { generation: payload.generation, outcome: 'rejected', report: this.report(), detail },
      changed: false,
    };
  }
}
