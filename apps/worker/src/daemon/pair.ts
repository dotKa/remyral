import type { HostFacts } from '@remyral/protocol';
import { createLogger, Redactor, type LogSink, type Logger } from '@remyral/observability';
import { loadConfig } from '../config/load.js';
import { pathApi, type PathHost } from '../config/paths.js';
import type { FileOps } from '../fs/ops.js';
import { createKeystore, FileKeystore, loadOrCreateDeviceKey, type Keystore } from '../identity/keystore.js';
import { generatePairingCode } from '../identity/pairing.js';
import { WORKER_VERSION } from '../probe/probe.js';
import { WorkerStore } from '../store/store.js';
import type { TransportPort } from '../transport/port.js';
import { workerEndpoint, WsTransport } from '../transport/ws.js';
import type { ShutdownSignals } from './signals.js';

export type PairOutcome = 'approved' | 'already_enrolled' | 'denied' | 'expired' | 'refused' | 'cancelled';

export interface PairDeps {
  ops: FileOps;
  host: PathHost;
  signals: ShutdownSignals;
  facts: () => Promise<HostFacts>;
  out: (text: string) => void;
  /** `--master`; defaults to the config's masterUrl. */
  masterUrl?: string | undefined;
  configPath?: string | undefined;
  /** `--data-dir`: use this data directory (file keystore) instead of the config's. */
  dataDir?: string | undefined;
  /** Diagnostics (JSON lines). Default: stderr at `warn`. */
  logSink?: LogSink;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** How long to wait for approval. Default 11 min (pairing requests expire after 10). */
  timeoutMs?: number;
  /** Test seam. */
  transport?: (masterUrl: string, logger: Logger) => TransportPort;
  pairingCode?: () => string;
}

export class PairUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairUsageError';
  }
}

/**
 * `remyral-worker pair --master <url>` (ADR-0005 §3, p2-pairing): connect with a
 * fresh one-time pairing code, print the code and the key fingerprint for the
 * admin, and wait until the enrollment is approved (identity persisted),
 * denied, or expires. The private key never leaves the keystore; the code is
 * printed on stdout only (it is displayed on purpose and useless once used).
 */
export async function pairWorker(deps: PairDeps): Promise<PairOutcome> {
  const { ops, host } = deps;
  let dataDir: string;
  let keystore: Keystore;
  let masterUrl: string | undefined = deps.masterUrl;
  if (deps.dataDir !== undefined) {
    dataDir = pathApi(host.platform).resolve(deps.dataDir);
    keystore = new FileKeystore(ops, dataDir);
  } else {
    const config = await loadConfig(ops, host, { explicitPath: deps.configPath });
    dataDir = config.dataDir;
    keystore = createKeystore(config.keystore, ops, dataDir);
    if (masterUrl !== undefined && masterUrl !== config.masterUrl) {
      deps.out(
        `Note: --master differs from masterUrl in ${config.source}; \`remyral-worker run\` connects to the config value.\n`,
      );
    }
    masterUrl ??= config.masterUrl;
  }
  if (masterUrl === undefined) throw new PairUsageError('--master <url> is required with --data-dir');
  const endpoint = workerEndpoint(masterUrl); // validates wss:// (ws:// loopback only)

  const logger = createLogger({
    level: deps.logLevel ?? 'warn',
    redactor: new Redactor(),
    ...(deps.logSink === undefined ? {} : { sink: deps.logSink }),
    fields: { service: 'remyral-worker', command: 'pair', version: WORKER_VERSION },
  });
  const { store } = await WorkerStore.open(ops, dataDir);
  const { key, created } = await loadOrCreateDeviceKey(keystore);
  const identity = store.identity;
  if (identity !== null && identity.publicKey === key.publicKey) {
    deps.out(`Already enrolled as ${identity.workerId} (${key.fingerprint}). Nothing to do.\n`);
    return 'already_enrolled';
  }
  if (identity !== null) await store.clearIdentity(); // enrollment of a lost key: re-pair

  const code = (deps.pairingCode ?? generatePairingCode)();
  deps.out(
    [
      created ? `Generated a new device key in ${keystore.location}.` : null,
      `Pairing with ${endpoint.origin}`,
      '',
      `  Pairing code: ${code}`,
      `  Fingerprint:  ${key.fingerprint}`,
      '',
      'In the console open Machines, check that the fingerprint of the pending worker matches the one',
      'above, enter the pairing code and approve. The request expires after 10 minutes.',
      '',
    ]
      .filter((l) => l !== null)
      .join('\n'),
  );

  const transport =
    deps.transport?.(masterUrl, logger) ??
    new WsTransport({ masterUrl, logger, workerVersion: WORKER_VERSION, facts: deps.facts });

  let announcedPending = false;
  const outcome = await new Promise<PairOutcome>((resolve) => {
    let settled = false;
    const finish = (o: PairOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(o);
    };
    const timer = setTimeout(
      () => {
        deps.out('No approval before the pairing request expired. Run `remyral-worker pair` again.\n');
        finish('expired');
      },
      deps.timeoutMs ?? 11 * 60_000,
    );
    const unsubscribe = deps.signals.onShutdown(() => {
      deps.out('Pairing cancelled.\n');
      finish('cancelled');
    });
    void transport
      .start(
        {
          publicKey: key.publicKey,
          workerId: null,
          pairingCode: code,
          resumeFromSeq: 0,
          signChallenge: (nonce) => key.signChallenge(nonce),
          // p5-live-fixes-2: never a worker session — the running service keeps its connection.
          pairOnly: true,
        },
        async (event) => {
          if (event.kind !== 'message') return;
          const m = event.message;
          if (m.type === 'ENROLL_PENDING' && !announcedPending) {
            announcedPending = true;
            deps.out(`Waiting for approval (request expires ${m.payload.expiresAt}) …\n`);
          } else if (m.type === 'ENROLL_APPROVED') {
            await store.setIdentity({
              workerId: m.payload.workerId,
              publicKey: key.publicKey,
              enrolledAt: m.payload.approvedAt,
            });
            deps.out(
              `Approved: this machine is worker ${m.payload.workerId}.\nStart it with \`remyral-worker run\`.\n`,
            );
            finish('approved');
          } else if (m.type === 'ERROR') {
            switch (m.payload.code) {
              case 'enrollment_denied':
                deps.out(`Enrollment denied by an administrator (${m.payload.message}).\n`);
                finish('denied');
                return;
              case 'pairing_invalid':
              case 'revoked':
              case 'credential_superseded':
              case 'upgrade_required':
                deps.out(`The master refused the pairing request: ${m.payload.message}\n`);
                finish('refused');
                return;
              default:
                deps.out(`Master: ${m.payload.message} (retrying)\n`);
            }
          }
        },
      )
      .catch((error: unknown) => {
        deps.out(
          `Could not start the connection: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        finish('refused');
      });
  });
  await transport.stop();
  await store.flush();
  return outcome;
}
