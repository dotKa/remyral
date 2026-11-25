import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { RuntimeKind, type HostFacts, type RuntimePolicyDelivery } from '@remyral/protocol';
import { currentBootGuard } from './boot/guard.js';
import { policyPins } from './runtime-policy/enforce.js';
import { ConfigError, loadConfig } from './config/load.js';
import { pathApi, type PathHost } from './config/paths.js';
import { pairWorker, PairUsageError } from './daemon/pair.js';
import { type CapabilitiesPayload, capabilitiesFromProbe } from './daemon/telemetry.js';
import type { ProbeReport } from './probe/report.js';
import { nodeShutdownSignals, type ShutdownSignals } from './daemon/signals.js';
import { InsecurePermissionsError } from './fs/permissions.js';
import { createNodeFileOps, type FileOps } from './fs/ops.js';
import { FileKeystore, KeystoreError, createKeystore, loadOrCreateDeviceKey } from './identity/keystore.js';
import { formatReport } from './probe/format.js';
import { secretCommand } from './secrets/cli.js';
import { VaultKeyError, VaultKeyStore } from './vault/key-store.js';
import { vaultKeyFingerprint } from '@remyral/protocol';
import { WORKER_VERSION, runProbe } from './probe/probe.js';
import type { System } from './system/types.js';
import type { TransportPort } from './transport/port.js';
// --- p2-service-*: service integration (logic lives in src/service/) ---
import { SERVICE_USAGE, serviceStatusCommand } from './service/command.js';
import { runWorkerWithStatusFile } from './service/status-file.js';
import { probeHost } from './probe/host.js';
import { locateBinary } from './probe/locate.js';
import { RUNTIME_PINS } from './runtimes/pins.js';
import { InvalidMasterUrlError } from './transport/ws.js';
import type { Logger } from '@remyral/observability';
import { formatDoctorReport, runWorkerDoctor, type WorkerDoctorDeps } from './doctor/doctor.js';
import { nodeDoctorDeps } from './doctor/host.js';
import { buildZip } from './doctor/zip.js';

export const USAGE = `Usage:
  remyral-worker probe [--json] [--self-test] [--runtime <kind>]
  remyral-worker run [--config <path>]
  remyral-worker pair [--master <url>] [--config <path> | --data-dir <dir>]
  remyral-worker identity show [--config <path> | --data-dir <dir>] [--json]
  remyral-worker vault key [--config <path> | --data-dir <dir>] [--json]
  remyral-worker secret set|list|rm …   (provider API keys on this worker; see \`secret --help\`)
  remyral-worker service status [--config <path>] [--json]
  remyral-worker doctor [--config <path>] [--json] [--out <file.json|file.zip>]

  probe                 Inventory this node: host facts, tools, runtimes, sandbox profiles.
    --json              Print the ProbeReport as JSON (schemaVersion 1) instead of a table.
    --self-test         Also run loopback-only self-tests (no credentials, no model calls):
                        OpenCode server auth (401 without / 200 with a random secret),
                        Claude Code/Codex/Pi \`--help\`.
    --runtime <kind>    Only probe one runtime: ${RuntimeKind.options.join(', ')}.

  run                   Start the worker daemon (structured JSON logs on stderr).
    --config <path>     Config file (default: REMYRAL_WORKER_CONFIG, then the OS location:
                        /etc/remyral-worker/config.json or $XDG_CONFIG_HOME/remyral-worker/config.json,
                        /Library/Application Support/RemyralWorker/config.json,
                        %ProgramData%\\RemyralWorker\\config.json).

  pair                  Pair this machine with the master (ADR-0005): prints a one-time pairing
                        code and the key fingerprint, then waits (up to 10 minutes) until an
                        admin approves it in the console. Exit 0 approved / already enrolled,
                        1 denied / expired / refused, 130 interrupted.
    --master <url>      Master URL (wss://…; ws:// only for loopback). Default: config masterUrl.
    --data-dir <dir>    Use this data directory instead of the config (requires --master).

  identity show         Print this worker's device key fingerprint and public key (never the
                        private key). Generates the key on first use (ADR-0005).
    --data-dir <dir>    Use this data directory instead of the one from the config.

  vault key             Print this worker's credential-vault key id and fingerprint (X25519, never
                        the private key) to compare with Machines → <machine> in the console. Generates
                        the key on first use (p5-credentials-models).

${SERVICE_USAGE}
  doctor                p16-doctor: check this machine — config, connection to the master (DNS, TLS,
                        HTTPS), clock against the master, service, data directory, disk, Node / npm,
                        git, runtimes (installed, version, signed in) and sandbox profiles. Read-only;
                        works when the worker cannot reach the master. Secrets are never printed.
    --json              Print the report as JSON (schemaVersion 1).
    --out <file>        Also write the redacted report to a new file (.json, or .zip with
                        doctor.json + doctor.txt) to attach to a support request.
                        Exit: 0 no error found, 1 errors found.

Exit codes: 0 ok (probe: report produced, problems are inside it), 2 crash or bad arguments,
78 configuration / permission / keystore problem.
`;

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const EXIT_OK = 0;
export const EXIT_CRASH = 2;
/** `pair`: denied, expired or refused by the master. */
export const EXIT_NOT_PAIRED = 1;
export const EXIT_INTERRUPTED = 130;
/** p16-doctor: `doctor` found at least one error. */
export const EXIT_DOCTOR_ERRORS = 1;
/** sysexits EX_CONFIG: systemd/launchd should not restart-loop on it. */
export const EXIT_CONFIG = 78;
/** p5-remote-ops: stopped for a remote restart (sysexits EX_TEMPFAIL; every service definition restarts it). */
export const EXIT_RESTART = 75;

/** Host services for the daemon commands; defaults are the real Node implementations. */
export interface DaemonHost {
  ops?: FileOps;
  pathHost?: PathHost;
  signals?: ShutdownSignals;
  transport?: TransportPort;
  /** Test seam for `pair`. */
  pairTransport?: (masterUrl: string, logger: Logger) => TransportPort;
  logSink?: (line: string) => void;
  /** p16-doctor: test seam for `doctor` (fixtures instead of the real host). */
  doctor?: WorkerDoctorDeps;
}

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  probe: ['json', 'self-test', 'runtime'],
  run: ['config'],
  pair: ['config', 'data-dir', 'master'],
  'identity show': ['config', 'data-dir', 'json'],
  'vault key': ['config', 'data-dir', 'json'],
  'service status': ['config', 'json'], // p2-service-*
  doctor: ['config', 'json', 'out'], // p16-doctor
};

/** HostFacts for HELLO; an OS/arch the protocol cannot express is a configuration problem. */
export async function hostFacts(sys: System): Promise<HostFacts> {
  const { host } = await probeHost(sys);
  if (host.facts === null) {
    throw new Error(`unsupported platform ${host.raw.platform}/${host.raw.arch} for the worker protocol`);
  }
  return host.facts;
}

/**
 * CAPABILITIES from a probe (no self-test), cached for an hour: probing spawns every runtime CLI. A new
 * runtime policy (p3-runtime-policy) invalidates the cache: pins are compared against the policy's.
 */
export function probeCapabilities(
  sys: System,
  maxAgeMs = 60 * 60_000,
): (
  maxParallelJobs: number,
  policy?: RuntimePolicyDelivery | null,
  followPins?: Partial<Record<RuntimeKind, string>>,
) => Promise<CapabilitiesPayload> {
  let cached: { at: number; key: string; report: Promise<ProbeReport> } | null = null;
  return async (maxParallelJobs, policy = null, followPins = {}) => {
    const now = Date.now();
    const key = `${policy === null ? '' : `${policy.name}@${String(policy.version)}#${policy.documentHash}`}|${JSON.stringify(followPins)}`;
    if (cached === null || cached.key !== key || now - cached.at > maxAgeMs) {
      cached = {
        at: now,
        key,
        report: runProbe(sys, { selfTest: false, runtime: null, pins: policyPins(policy, followPins) }),
      };
    }
    const applied =
      policy === null
        ? undefined
        : { name: policy.name, version: policy.version, documentHash: policy.documentHash };
    return capabilitiesFromProbe(await cached.report, maxParallelJobs, applied);
  };
}

export function nodePathHost(sys: System): PathHost {
  return {
    platform: sys.platform as NodeJS.Platform,
    env: (name) => sys.getEnv(name),
    homedir: () => sys.homedir() || homedir(),
    isPrivileged:
      sys.platform === 'win32' || (typeof process.geteuid === 'function' && process.geteuid() === 0),
  };
}

/** CLI entry; returns the process exit code. Never prints env values or secrets. */
export async function main(
  argv: readonly string[],
  sys: System,
  io: Io,
  host: DaemonHost = {},
): Promise<number> {
  // p3-secrets-worker: own sub-parser (positional secret names, --stdin).
  if (argv[0] === 'secret') {
    return secretCommand(argv.slice(1), io, {
      ops: host.ops ?? createNodeFileOps(),
      pathHost: host.pathHost ?? nodePathHost(sys),
    });
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean', default: false },
        'self-test': { type: 'boolean', default: false },
        runtime: { type: 'string' },
        config: { type: 'string' },
        'data-dir': { type: 'string' },
        master: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return EXIT_CRASH;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${WORKER_VERSION}\n`);
    return EXIT_OK;
  }
  if (values.help) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  if (positionals.length === 0) {
    io.stderr(USAGE);
    return EXIT_CRASH;
  }
  const command = positionals.join(' ');
  const allowed = COMMAND_OPTIONS[command];
  if (allowed === undefined) {
    io.stderr(`Unknown command: ${command}\n\n${USAGE}`);
    return EXIT_CRASH;
  }
  // Options are parsed globally; reject ones that do not belong to this command.
  const given = Object.entries(values)
    .filter(([name, v]) => v !== false && name !== 'help' && name !== 'version')
    .map(([name]) => name);
  const foreign = given.filter((name) => !allowed.includes(name));
  if (foreign.length > 0) {
    io.stderr(`Option(s) not valid for "${command}": ${foreign.map((n) => `--${n}`).join(', ')}\n\n${USAGE}`);
    return EXIT_CRASH;
  }

  switch (command) {
    case 'probe':
      return probeCommand(sys, io, values);
    case 'run':
      return daemonCommand(io, () =>
        runWorkerWithStatusFile({
          ops: host.ops ?? createNodeFileOps(),
          host: host.pathHost ?? nodePathHost(sys),
          signals: host.signals ?? nodeShutdownSignals(),
          ...(host.transport === undefined ? {} : { transport: host.transport }),
          ...(host.logSink === undefined ? {} : { logSink: host.logSink }),
          facts: () => hostFacts(sys),
          capabilities: probeCapabilities(sys),
          locateRuntime: (runtime) => locateBinary(sys, RUNTIME_PINS[runtime].binary),
          configPath: values.config,
          // p16-doctor: the remote op doctor.run runs the same checks as `remyral-worker doctor`.
          doctor: () =>
            runWorkerDoctor(
              nodeDoctorDeps({
                sys,
                ops: host.ops ?? createNodeFileOps(),
                pathHost: host.pathHost ?? nodePathHost(sys),
                configPath: values.config,
                mode: 'remote',
              }),
            ),
        }).then((info) =>
          // p5-remote-ops: a remote restart exits 75 so the service manager starts the worker again.
          info.restart === true ? EXIT_RESTART : info.childErrors > 0 ? EXIT_CRASH : EXIT_OK,
        ),
      );
    case 'doctor': // p16-doctor
      return doctorCommand(sys, io, host, { configPath: values.config, json: values.json, out: values.out });
    case 'service status': // p2-service-*
      return serviceStatusCommand(
        sys,
        host.ops ?? createNodeFileOps(),
        host.pathHost ?? nodePathHost(sys),
        io,
        { configPath: values.config, json: values.json },
      );
    case 'pair':
      return daemonCommand(io, async () => {
        if (values.config !== undefined && values['data-dir'] !== undefined) {
          throw new PairUsageError('use either --config or --data-dir, not both');
        }
        const outcome = await pairWorker({
          ops: host.ops ?? createNodeFileOps(),
          host: host.pathHost ?? nodePathHost(sys),
          signals: host.signals ?? nodeShutdownSignals(),
          facts: () => hostFacts(sys),
          out: (text) => {
            io.stdout(text);
          },
          masterUrl: values.master,
          configPath: values.config,
          dataDir: values['data-dir'],
          ...(host.logSink === undefined ? {} : { logSink: host.logSink }),
          ...(host.pairTransport === undefined ? {} : { transport: host.pairTransport }),
        });
        return outcome === 'approved' || outcome === 'already_enrolled'
          ? EXIT_OK
          : outcome === 'cancelled'
            ? EXIT_INTERRUPTED
            : EXIT_NOT_PAIRED;
      });
    case 'vault key':
      return daemonCommand(io, () =>
        vaultKeyShow(io, host.ops ?? createNodeFileOps(), host.pathHost ?? nodePathHost(sys), {
          configPath: values.config,
          dataDir: values['data-dir'],
          json: values.json,
        }),
      );
    default:
      return daemonCommand(io, () =>
        identityShow(io, host.ops ?? createNodeFileOps(), host.pathHost ?? nodePathHost(sys), {
          configPath: values.config,
          dataDir: values['data-dir'],
          json: values.json,
        }),
      );
  }
}

async function probeCommand(
  sys: System,
  io: Io,
  values: {
    json: boolean;
    'self-test': boolean;
    runtime?: string | undefined;
  },
): Promise<number> {
  let runtime: RuntimeKind | null = null;
  if (values.runtime !== undefined) {
    const r = RuntimeKind.safeParse(values.runtime);
    if (!r.success) {
      io.stderr(`--runtime must be one of: ${RuntimeKind.options.join(', ')}\n`);
      return EXIT_CRASH;
    }
    runtime = r.data;
  }
  try {
    const report = await runProbe(sys, {
      selfTest: values['self-test'],
      runtime,
    });
    io.stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    return EXIT_OK;
  } catch (error) {
    io.stderr(
      `remyral-worker probe crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return EXIT_CRASH;
  }
}

/** p16-doctor: `remyral-worker doctor` — read-only checks of this machine; exit 1 when an error was found. */
async function doctorCommand(
  sys: System,
  io: Io,
  host: DaemonHost,
  options: { configPath: string | undefined; json: boolean; out: string | undefined },
): Promise<number> {
  const ops = host.ops ?? createNodeFileOps();
  try {
    const report = await runWorkerDoctor(
      host.doctor ??
        nodeDoctorDeps({
          sys,
          ops,
          pathHost: host.pathHost ?? nodePathHost(sys),
          configPath: options.configPath,
          mode: 'local',
        }),
    );
    const text = formatDoctorReport(report);
    io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : text);
    if (options.out !== undefined) {
      const json = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
      const data = options.out.toLowerCase().endsWith('.zip')
        ? buildZip([
            { path: 'doctor.json', data: json },
            { path: 'doctor.txt', data: Buffer.from(text, 'utf8') },
          ])
        : json;
      await ops.writeNew(pathApi(ops.platform).resolve(options.out), data, 0o600);
      io.stderr(`remyral-worker: wrote ${options.out} (${String(data.length)} bytes)\n`);
    }
    return report.summary.error > 0 ? EXIT_DOCTOR_ERRORS : EXIT_OK;
  } catch (error) {
    io.stderr(`remyral-worker doctor failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CRASH;
  }
}

/** Maps operator-fixable failures to EXIT_CONFIG with a plain message; anything else is a crash. */
async function daemonCommand(io: Io, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (error) {
    const operatorFixable =
      error instanceof ConfigError ||
      error instanceof InsecurePermissionsError ||
      error instanceof KeystoreError ||
      error instanceof VaultKeyError ||
      error instanceof PairUsageError ||
      error instanceof InvalidMasterUrlError;
    // p6-worker-boot-diagnostics: the daemon's fatal error, with stage and (redacted) stack, into boot.log
    // (origin `config` for operator-fixable problems: the boot verdict is then `exited`, not `crashed`).
    currentBootGuard()?.fatal(error, operatorFixable ? 'config' : 'daemon');
    if (operatorFixable) {
      io.stderr(`remyral-worker: ${error.message}\n`);
      return EXIT_CONFIG;
    }
    // Message only: a stack of an unexpected error is not needed to act and may carry paths/data.
    io.stderr(`remyral-worker crashed: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CRASH;
  }
}

async function vaultKeyShow(
  io: Io,
  ops: FileOps,
  pathHost: PathHost,
  options: { configPath: string | undefined; dataDir: string | undefined; json: boolean },
): Promise<number> {
  const dataDir =
    options.dataDir !== undefined
      ? pathApi(pathHost.platform).resolve(options.dataDir)
      : (await loadConfig(ops, pathHost, { explicitPath: options.configPath })).dataDir;
  const { store, created } = await VaultKeyStore.open(ops, dataDir);
  if (created) io.stderr(`remyral-worker: generated a new vault key in ${store.location}\n`);
  const k = store.current;
  const fingerprint = await vaultKeyFingerprint(k.publicKey);
  if (options.json) {
    io.stdout(
      `${JSON.stringify(
        {
          keyId: k.keyId,
          fingerprint,
          publicKey: k.publicKey,
          createdAt: k.createdAt,
          previousKeyId: store.previous?.keyId ?? null,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.stdout(
      [
        `Vault key id: ${k.keyId}`,
        `Fingerprint:  ${fingerprint}`,
        `Public key:   ${k.publicKey}`,
        `Created:      ${k.createdAt}`,
        '',
      ].join('\n'),
    );
  }
  return EXIT_OK;
}

async function identityShow(
  io: Io,
  ops: FileOps,
  pathHost: PathHost,
  options: { configPath: string | undefined; dataDir: string | undefined; json: boolean },
): Promise<number> {
  const keystore =
    options.dataDir !== undefined
      ? new FileKeystore(ops, pathApi(pathHost.platform).resolve(options.dataDir))
      : await (async () => {
          const config = await loadConfig(ops, pathHost, { explicitPath: options.configPath });
          return createKeystore(config.keystore, ops, config.dataDir);
        })();
  const { key, created } = await loadOrCreateDeviceKey(keystore);
  if (created) io.stderr(`remyral-worker: generated a new device key in ${keystore.location}\n`);
  if (options.json) {
    io.stdout(
      `${JSON.stringify(
        {
          fingerprint: key.fingerprint,
          publicKey: key.publicKey,
          keystore: keystore.kind,
          location: keystore.location,
          accessControlVerified: keystore.accessControlVerified,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.stdout(
      [
        `Fingerprint: ${key.fingerprint}`,
        `Public key:  ${key.publicKey}`,
        `Keystore:    ${keystore.kind} (${keystore.location})${keystore.accessControlVerified ? '' : ' — access control UNVERIFIED'}`,
        '',
      ].join('\n'),
    );
  }
  return EXIT_OK;
}
