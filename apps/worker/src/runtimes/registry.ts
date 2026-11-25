import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AgentAdapter,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createOpenCodeAdapter,
  createPiAdapter,
  type FakeAdapterOptions,
  FakeRuntimeAdapter,
  type ProbeResult,
  type SpawnContext,
  type VerifiedOverlay,
} from '@remyral/agent-adapters';
import type { Logger } from '@remyral/observability';
import { RuntimeKind, type RuntimeAuthMode } from '@remyral/protocol';
import type { EffectiveRuntimeSettings } from '../managed-config/effective.js';
import type { RuntimeAuthMap } from '../secrets/auth.js';
import { RUNTIME_PINS } from './pins.js';

/**
 * Runtime adapter registry (job runner wiring, docs/design/p4-orchestration.md "Runner"):
 * `RuntimeKind → factory` for the real adapters of `@remyral/agent-adapters`, created with
 *  - the binary from the worker config (`runtimes.<kind>.binary`) or the probe's located executable,
 *  - the ADR-0014 auth mode from `runtimeAuth` (secret values never pass through here),
 *  - the confiner of the attempt's selected sandbox runner (`SpawnContext.confiner`, set per job),
 *  - a per-attempt state dir (inside the attempt's sandbox dir) and the job's non-secret env from the
 *    secrets env builder (`ResolvedJobEnv.publicEnv`).
 *
 * One adapter instance per attempt (`create`), so per-session state, transcripts and the runtime's
 * private config dirs never mix between attempts; one long-lived *reference* instance per runtime is
 * only probed (CAPABILITIES, version gate). The fake adapter exists only when the dev/test flag is set.
 */

/** Everything a factory gets for one adapter instance. */
export interface AdapterFactoryInput {
  readonly runtime: RuntimeKind;
  readonly authMode: RuntimeAuthMode;
  /** Absolute path of the runtime executable on this host (null: not found; factories that need it refuse). */
  readonly binary: string | null;
  /**
   * p5-remote-ops: arguments before the runtime's own (a worker-managed Pi install runs its bin script with
   * the worker's Node: `binary` = node, `binaryArgs` = [script]). Empty otherwise.
   */
  readonly binaryArgs: readonly string[];
  /** The executable is a worker-managed install (p5-remote-ops), so adapters must use exactly it. */
  readonly managed: boolean;
  /** Private, absolute state dir of this instance (per attempt for job instances). */
  readonly stateDir: string;
  readonly settings: EffectiveRuntimeSettings | undefined;
  /** `secret-ref` with a configured reference (adapters report `authenticated: unknown` → scheduler ok). */
  readonly credentialConfigured: boolean;
  /** Non-secret child environment (`ResolvedJobEnv.publicEnv`); undefined for the reference instance. */
  readonly env: Readonly<Record<string, string>> | undefined;
  /** p5-claude-auth-health: housekeeping before the runtime starts (stale Claude lock cleanup). */
  readonly beforeStart?: () => Promise<void>;
  /**
   * p13-runtime-accounts: `local-login` with an added account — its config dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`).
   * Absent: the worker user's own login.
   */
  readonly loginDir?: string;
  /** p17-runtime-verify: master-side evidence for this attempt (job instances only). */
  readonly verified?: VerifiedOverlay;
}

/**
 * p13-runtime-accounts: how one attempt (or one account's usage probe) authenticates — the job's model-profile key,
 * its runtime account, else the worker's configured auth. Before p13 every attempt took the worker's auth mode.
 */
export interface AttemptAuth {
  readonly mode: RuntimeAuthMode;
  readonly loginDir?: string;
}

export type AdapterFactory = (input: AdapterFactoryInput) => AgentAdapter;

/** The confiner the job runner set for the attempt (p3-sandbox) — every real adapter spawns through it. */
const attemptConfiner = (ctx: SpawnContext) => ctx.confiner;

function needBinary(input: AdapterFactoryInput): string {
  if (input.binary === null) {
    throw new RuntimeUnavailableError(
      input.runtime,
      'runtime_binary_missing',
      `${input.runtime} executable not found: install ${RUNTIME_PINS[input.runtime].install} as the worker user or set runtimes.${input.runtime}.binary in the worker config`,
    );
  }
  return input.binary;
}

/** The real adapters (ADR-0023: OpenHands was removed; four runtimes remain). */
export const RUNTIME_FACTORIES: Readonly<Record<RuntimeKind, AdapterFactory | null>> = {
  'claude-code': (i) =>
    createClaudeCodeAdapter({
      authMode: i.authMode,
      ...(i.verified === undefined ? {} : { verified: i.verified }),
      ...(i.loginDir === undefined ? {} : { loginDir: i.loginDir }),
      stateDir: i.stateDir,
      confinerFor: attemptConfiner,
      credentialConfigured: i.credentialConfigured,
      ...(i.env === undefined ? {} : { sourceEnv: { ...i.env } }),
      ...(i.beforeStart === undefined ? {} : { beforeStart: i.beforeStart }),
      ...(i.settings?.binary === undefined
        ? i.managed && i.binary !== null
          ? { binaryPath: i.binary }
          : {}
        : { binaryPath: i.settings.binary }),
    }),
  codex: (i) =>
    createCodexAdapter({
      authMode: i.authMode,
      ...(i.verified === undefined ? {} : { verified: i.verified }),
      ...(i.loginDir === undefined ? {} : { loginDir: i.loginDir }),
      codexPath: needBinary(i),
      stateDir: i.stateDir,
      confinerFor: attemptConfiner,
      credentialConfigured: i.credentialConfigured,
      ...(i.env === undefined ? {} : { sourceEnv: { ...i.env } }),
    }),
  pi: (i) =>
    createPiAdapter({
      command: needBinary(i),
      ...(i.verified === undefined ? {} : { verified: i.verified }),
      ...(i.binaryArgs.length === 0 ? {} : { commandArgs: i.binaryArgs }),
      stateDir: i.stateDir,
      authMode: i.authMode,
      confiner: attemptConfiner,
      ...(i.env === undefined ? {} : { env: i.env, inheritEnv: [] }),
      ...(i.settings?.model === undefined ? {} : { model: i.settings.model }),
      ...(i.settings?.provider === undefined ? {} : { provider: i.settings.provider }),
      ...(i.settings === undefined || i.settings.extensions.length === 0
        ? {}
        : { extraExtensions: i.settings.extensions }),
    }),
  opencode: (i) =>
    createOpenCodeAdapter({
      command: needBinary(i),
      ...(i.verified === undefined ? {} : { verified: i.verified }),
      ...(i.binaryArgs.length === 0 ? {} : { commandArgs: i.binaryArgs }),
      stateDir: i.stateDir,
      authMode: i.authMode,
      confiner: attemptConfiner,
      ...(i.env === undefined ? {} : { env: i.env, inheritEnv: [] }),
      ...(i.settings?.model === undefined ? {} : { model: i.settings.model }),
      ...(i.settings?.config === undefined ? {} : { config: i.settings.config }),
    }),
};

export type RuntimeUnavailableCode =
  'runtime_not_enabled' | 'runtime_not_available_in_build' | 'runtime_binary_missing';

/** Typed refusal: this worker cannot offer the runtime at all (never a generic failure). */
export class RuntimeUnavailableError extends Error {
  constructor(
    readonly runtime: RuntimeKind,
    readonly code: RuntimeUnavailableCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeUnavailableError';
  }
}

export interface RuntimeRegistryOptions {
  /** `allowedRuntimes` from the worker config: everything else is `runtime_not_enabled`. */
  readonly enabled: readonly RuntimeKind[];
  readonly auth: RuntimeAuthMap;
  readonly settings: Partial<Record<RuntimeKind, EffectiveRuntimeSettings>>;
  /** Root for the reference instances' state (`<dataDir>/runtimes`). */
  readonly stateRoot: string;
  /** Located executable per runtime (the probe's `binaryPath`); used when the config names none. */
  readonly locate: (runtime: RuntimeKind) => Promise<string | null>;
  /**
   * p5-remote-ops: the worker-managed install of a runtime (active version, integrity verified). Precedence:
   * a binary named in the local config, then the managed install, then `locate`.
   */
  readonly managed?: (runtime: RuntimeKind) => { file: string; args: readonly string[] } | null;
  readonly logger: Logger;
  /** Factories (default {@link RUNTIME_FACTORIES}); tests inject their own. */
  readonly factories?: Partial<Record<RuntimeKind, AdapterFactory | null>>;
  /**
   * Development/tests only: every enabled runtime runs on the deterministic fake adapter. The worker
   * config accepts `devFakeRuntime` only with a loopback ws:// master (config/schema.ts).
   */
  readonly fake?: FakeAdapterOptions | null;
  /** Re-probe the reference instance when its last probe is older than this. Default 60 s. */
  readonly probeMaxAgeMs?: number;
  /** p5-claude-auth-health: per-runtime housekeeping before a session starts (job instances only). */
  readonly beforeStart?: Partial<Record<RuntimeKind, () => Promise<void>>>;
}

export interface RuntimeStatus {
  readonly runtime: RuntimeKind;
  /** null while not probed (or the runtime is unavailable). */
  readonly probe: ProbeResult | null;
  readonly unavailable: { readonly code: RuntimeUnavailableCode; readonly message: string } | null;
  readonly reference: AgentAdapter | null;
}

interface Entry {
  readonly runtime: RuntimeKind;
  readonly binary: string | null;
  readonly binaryArgs: readonly string[];
  readonly managed: boolean;
  reference: AgentAdapter | null;
  unavailable: { code: RuntimeUnavailableCode; message: string } | null;
  probe: ProbeResult | null;
  probedAt: number;
}

export class RuntimeRegistry {
  #o: RuntimeRegistryOptions;
  #entries = new Map<RuntimeKind, Entry>();
  /** Dev/test flag: one fake adapter per enabled runtime (null = real adapters). */
  #fake: Map<RuntimeKind, FakeRuntimeAdapter> | null;
  readonly #log: Logger;

  private constructor(o: RuntimeRegistryOptions) {
    this.#o = o;
    this.#log = o.logger.child({ component: 'runtimes' });
    this.#fake = RuntimeRegistry.#fakes(o);
  }

  static #fakes(o: RuntimeRegistryOptions): Map<RuntimeKind, FakeRuntimeAdapter> | null {
    const fake = o.fake;
    return fake === undefined || fake === null
      ? null
      : new Map(o.enabled.map((runtime) => [runtime, new FakeRuntimeAdapter({ ...fake, runtime })]));
  }

  /** Builds the reference instances (no runtime is started; probing happens in `refresh`). */
  static async create(o: RuntimeRegistryOptions): Promise<RuntimeRegistry> {
    const r = new RuntimeRegistry(o);
    r.#entries = await r.#build(o, r.#fake);
    return r;
  }

  /**
   * ADR-0015 hot reload: new enabled runtimes, auth modes and settings from the panel configuration. Reference
   * instances are rebuilt (probes refresh lazily on the next admission or CAPABILITIES); attempts already
   * running keep the adapter they were created with.
   */
  async reconfigure(next: Pick<RuntimeRegistryOptions, 'enabled' | 'auth' | 'settings'>): Promise<void> {
    const o: RuntimeRegistryOptions = { ...this.#o, ...next };
    const fake = RuntimeRegistry.#fakes(o);
    const entries = await this.#build(o, fake);
    this.#o = o;
    this.#fake = fake;
    this.#entries = entries;
  }

  /** p5-remote-ops: re-resolve executables (an install changed) and rebuild the reference instances. */
  async rebuild(): Promise<void> {
    await this.reconfigure({ enabled: this.#o.enabled, auth: this.#o.auth, settings: this.#o.settings });
  }

  /** Where `runtime`'s executable comes from now (diagnostics). */
  source(runtime: RuntimeKind): { source: 'config' | 'managed' | 'path' | 'none'; binary: string | null } {
    const e = this.#entries.get(runtime);
    if (e === undefined || e.binary === null) return { source: 'none', binary: null };
    if (this.#o.settings[runtime]?.binary !== undefined) return { source: 'config', binary: e.binary };
    return { source: e.managed ? 'managed' : 'path', binary: e.binary };
  }

  /**
   * The executable and its leading arguments (a worker-managed Pi/OpenCode install may be `node <script>`); the
   * ops-chat assistant engines start exactly what jobs start (p5-ops-chat-next). null: not available.
   */
  launch(runtime: RuntimeKind): { readonly command: string; readonly args: readonly string[] } | null {
    const e = this.#entries.get(runtime);
    if (e === undefined || e.binary === null) return null;
    return { command: e.binary, args: e.binaryArgs };
  }

  /** Runtimes enabled by the current configuration. */
  get enabled(): readonly RuntimeKind[] {
    return this.#o.enabled;
  }

  async #build(
    o: RuntimeRegistryOptions,
    fakes: Map<RuntimeKind, FakeRuntimeAdapter> | null,
  ): Promise<Map<RuntimeKind, Entry>> {
    const entries = new Map<RuntimeKind, Entry>();
    for (const runtime of RuntimeKind.options) {
      const configured = o.settings[runtime]?.binary;
      const managed = configured === undefined ? (o.managed?.(runtime) ?? null) : null;
      const binary = configured ?? managed?.file ?? (await o.locate(runtime).catch(() => null));
      const entry: Entry = {
        runtime,
        binary,
        binaryArgs: managed?.args ?? [],
        managed: managed !== null,
        reference: null,
        unavailable: null,
        probe: null,
        probedAt: 0,
      };
      entries.set(runtime, entry);
      if (!o.enabled.includes(runtime)) {
        entry.unavailable = {
          code: 'runtime_not_enabled',
          message: `${runtime} is not enabled on this worker (add it to allowedRuntimes in the worker config)`,
        };
        continue;
      }
      if (fakes !== null) continue;
      const factory = (o.factories ?? RUNTIME_FACTORIES)[runtime] ?? null;
      if (factory === null) {
        entry.unavailable = {
          code: 'runtime_not_available_in_build',
          message: `${runtime} adapter is not available in this worker build (runtime_not_available_in_build)`,
        };
        continue;
      }
      try {
        const stateDir = join(o.stateRoot, runtime, 'reference');
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        entry.reference = factory(this.#inputFor(o, entry, stateDir, undefined));
      } catch (error) {
        entry.unavailable =
          error instanceof RuntimeUnavailableError
            ? { code: error.code, message: error.message }
            : {
                code: 'runtime_binary_missing',
                message: `${runtime} adapter could not be created: ${error instanceof Error ? error.message : 'error'}`,
              };
      }
    }
    return entries;
  }

  /** Whether jobs run on the fake adapter (dev/test flag). */
  get fake(): boolean {
    return this.#fake !== null;
  }

  #inputFor(
    o: RuntimeRegistryOptions,
    entry: Pick<Entry, 'runtime' | 'binary' | 'binaryArgs' | 'managed'>,
    stateDir: string,
    env: Readonly<Record<string, string>> | undefined,
    attempt?: AttemptAuth,
  ): AdapterFactoryInput {
    const runtime = entry.runtime;
    const auth = o.auth[runtime];
    const mode = attempt?.mode ?? auth?.mode ?? 'secret-ref';
    return {
      runtime,
      authMode: mode,
      binary: entry.binary,
      binaryArgs: entry.binaryArgs,
      managed: entry.managed,
      stateDir,
      settings: o.settings[runtime],
      credentialConfigured: mode === 'secret-ref' && (attempt !== undefined || auth?.mode === 'secret-ref'),
      env,
      ...(mode === 'local-login' && attempt?.loginDir !== undefined ? { loginDir: attempt.loginDir } : {}),
      ...(o.beforeStart?.[runtime] === undefined ? {} : { beforeStart: o.beforeStart[runtime] }),
    };
  }

  /** Typed status of one runtime (unavailable reason, last probe). */
  status(runtime: RuntimeKind): RuntimeStatus {
    const e = this.#entries.get(runtime);
    if (e === undefined) {
      return {
        runtime,
        probe: null,
        reference: null,
        unavailable: { code: 'runtime_not_enabled', message: `${runtime} is unknown` },
      };
    }
    const fake = this.#fake?.get(runtime);
    if (fake !== undefined && e.unavailable === null) {
      return { runtime, probe: e.probe, unavailable: null, reference: fake };
    }
    return { runtime, probe: e.probe, unavailable: e.unavailable, reference: e.reference };
  }

  /** Probes the reference instance of `runtime` when its probe is stale (never starts a session). */
  async refresh(runtime: RuntimeKind, force = false): Promise<RuntimeStatus> {
    const e = this.#entries.get(runtime);
    const s = this.status(runtime);
    if (e === undefined || s.reference === null) return s;
    const maxAge = this.#o.probeMaxAgeMs ?? 60_000;
    if (force || e.probe === null || Date.now() - e.probedAt > maxAge) {
      try {
        e.probe = await s.reference.probe();
        e.probedAt = Date.now();
      } catch (error) {
        this.#log.warn('runtime probe failed', { runtime, err: error });
        e.probe = null;
      }
    }
    return this.status(runtime);
  }

  /**
   * p16-runtime-updates (`runtime.verify`): the adapter's own `probe()` on an executable that is not the runtime's
   * active one (a candidate in a scratch dir), with a throw-away instance — no session, no model request, the local
   * config's binary override ignored. Null when this build has no adapter for it or jobs run on the fake adapter.
   */
  async probeExecutable(
    runtime: RuntimeKind,
    launch: { readonly file: string; readonly args: readonly string[] },
    stateDir: string,
  ): Promise<ProbeResult | null> {
    if (this.#fake !== null) return null;
    const factory = (this.#o.factories ?? RUNTIME_FACTORIES)[runtime] ?? null;
    if (factory === null) return null;
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const input = this.#inputFor(
      this.#o,
      { runtime, binary: launch.file, binaryArgs: launch.args, managed: true },
      stateDir,
      undefined,
    );
    return factory({ ...input, settings: undefined }).probe();
  }

  /** Probes every available runtime (daemon start and CAPABILITIES). */
  async refreshAll(force = false): Promise<RuntimeStatus[]> {
    return Promise.all(RuntimeKind.options.map((rt) => this.refresh(rt, force)));
  }

  /**
   * A fresh adapter for one attempt. `stateDir` must be private to the attempt (the job runner uses
   * `<root>/sandboxes/<job>/<attempt>/runtime`), `env` is the job's non-secret environment.
   */
  createForAttempt(
    runtime: RuntimeKind,
    stateDir: string,
    env: Readonly<Record<string, string>>,
    attempt?: AttemptAuth,
    verified?: VerifiedOverlay,
  ): AgentAdapter {
    const s = this.status(runtime);
    if (s.unavailable !== null)
      throw new RuntimeUnavailableError(runtime, s.unavailable.code, s.unavailable.message);
    const fake = this.#fake?.get(runtime);
    if (fake !== undefined) return fake;
    const e = this.#entries.get(runtime);
    const factory = (this.#o.factories ?? RUNTIME_FACTORIES)[runtime] ?? null;
    if (e === undefined || factory === null) {
      throw new RuntimeUnavailableError(
        runtime,
        'runtime_not_available_in_build',
        `${runtime} has no adapter`,
      );
    }
    const input = this.#inputFor(this.#o, e, stateDir, env, attempt);
    return factory(verified === undefined ? input : { ...input, verified });
  }

  /**
   * p13-runtime-accounts: a long-lived adapter of one added subscription account (its config dir) for the read-only
   * usage probe; state under `<stateRoot>/<runtime>-<account>`. Null when the runtime is unavailable.
   */
  createForAccount(runtime: RuntimeKind, account: string, loginDir: string): AgentAdapter | null {
    const s = this.status(runtime);
    if (s.unavailable !== null) return null;
    const fake = this.#fake?.get(runtime);
    if (fake !== undefined) return fake;
    const e = this.#entries.get(runtime);
    const factory = (this.#o.factories ?? RUNTIME_FACTORIES)[runtime] ?? null;
    if (e === undefined || factory === null) return null;
    try {
      return factory(
        this.#inputFor(this.#o, e, join(this.#o.stateRoot, `${runtime}-${account}`), undefined, {
          mode: 'local-login',
          loginDir,
        }),
      );
    } catch {
      return null;
    }
  }

  /** Executable name inside the runtime image for `container` jobs. */
  containerCommand(runtime: RuntimeKind): string {
    return this.#o.settings[runtime]?.containerBinary ?? RUNTIME_PINS[runtime].binary;
  }

  /** Operator files the runtime's command line names (bind-mounted read-only into containers). */
  runtimeFiles(runtime: RuntimeKind): readonly string[] {
    return runtime === 'pi' ? (this.#o.settings.pi?.extensions ?? []) : [];
  }
}
