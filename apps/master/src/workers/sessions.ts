import type { WorkerToMaster } from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from '../db/pool.js';
import { CloseCode } from './connection.js';
import type { WorkerHub } from './hub.js';
import { type InboxSink, type ReplayLimits, type SequencedWorkerMessage, WorkerReplay } from './replay.js';
import type { RotationService } from './rotation.js';
import type { WorkerSession, WorkerSessionHandler } from './types.js';

export interface FleetSessionDeps {
  readonly pool: Pool;
  readonly hub: WorkerHub;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  /** A connected worker that sent no HEARTBEAT for this long is offline (3 missed 15 s beats). */
  readonly heartbeatTimeoutMs?: number;
  /** p2-replay: where sequenced worker messages go (default: worker_inbox journal). */
  readonly sink?: InboxSink;
  readonly replayLimits?: Partial<ReplayLimits>;
  /** p2-identity-rotation: ROTATE_KEY handling and re-issued requests on reconnect. */
  readonly rotation?: RotationService;
  /** p3-runtime-policy: policy delivery on session start and applied-policy reports in CAPABILITIES. */
  readonly runtimePolicy?: {
    onSessionStart(session: WorkerSession): Promise<void>;
    onCapabilities(
      session: WorkerSession,
      applied: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload']['runtimePolicy'],
    ): Promise<void>;
  };
  /**
   * ADR-0015 panel-managed configuration: the worker's report (CAPABILITIES.workerConfig, WORKER_CONFIG_STATUS)
   * is stored and the desired generation (re-)sent when the worker runs another one.
   */
  readonly workerConfig?: {
    onReport(
      session: WorkerSession,
      report: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload']['workerConfig'],
    ): Promise<void>;
  };
  /** p5-credentials-models: vault key + held credentials (CAPABILITIES) and CREDENTIAL_STATUS. */
  readonly vault?: {
    onReport(
      session: WorkerSession,
      report: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload']['credentialVault'],
    ): Promise<void>;
    onStatus(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'CREDENTIAL_STATUS' }>['payload'],
    ): Promise<void>;
  };
  /** p5-remote-ops: CAPABILITIES.remoteOps and OPS_UPDATE. */
  readonly remoteOps?: {
    onReport(
      session: WorkerSession,
      report: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload']['remoteOps'],
    ): Promise<void>;
    onUpdate(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'OPS_UPDATE' }>['payload'],
    ): Promise<void>;
  };
  /** p5-ops-chat: CAPABILITIES.assistant, ASSISTANT_UPDATE and the end of the assistant worker's session. */
  readonly assistant?: {
    onReport(
      session: WorkerSession,
      report: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload']['assistant'],
    ): Promise<void>;
    onUpdate(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'ASSISTANT_UPDATE' }>['payload'],
    ): Promise<void>;
    /** p8-chat-attachments-mentions: a slice of a running turn's attachment. */
    onAttachmentRequest?(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'ASSISTANT_ATTACHMENT_REQUEST' }>['payload'],
    ): Promise<void>;
    onSessionEnd(session: WorkerSession): Promise<void>;
    /** p17-chat-reconnect: a session started (turns held after a drop of the same process continue on it). */
    onSessionStart?(session: WorkerSession): Promise<void>;
  };
  /**
   * p5-machine-admin (ADR-0021): CAPABILITIES.machineAdmin / .toolInventory, and the elevated command requests and
   * results of machine-admin jobs (MACHINE_ADMIN_REQUEST / RESULT).
   */
  /** p14-mcp-stdio: CAPABILITIES.mcpInstalls (local MCP server installs intact on the machine). */
  readonly mcpInstalls?: {
    onReport(
      session: WorkerSession,
      report: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload']['mcpInstalls'],
    ): Promise<void>;
  };
  readonly machineAdmin?: {
    onReport(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload'],
    ): Promise<void>;
    onRequest(
      session: WorkerSession,
      message: Extract<WorkerToMaster, { type: 'MACHINE_ADMIN_REQUEST' }>,
    ): Promise<void>;
    onResult(
      session: WorkerSession,
      message: Extract<WorkerToMaster, { type: 'MACHINE_ADMIN_RESULT' }>,
    ): Promise<void>;
  };
  /** p15-message-delivery: JOB_MESSAGE_STATUS receipts and outbox ACKs of JOB_MESSAGE. */
  readonly jobMessages?: {
    onStatus(
      session: WorkerSession,
      message: Extract<WorkerToMaster, { type: 'JOB_MESSAGE_STATUS' }>,
    ): Promise<void>;
    onAcked(workerId: string, throughSeq: number): Promise<void>;
  };
  /** p6-approval-mode-switch: APPROVAL_POLICY_STATUS (how a worker applied a running job's new approval mode). */
  readonly approvalMode?: {
    onStatus(
      session: WorkerSession,
      message: Extract<WorkerToMaster, { type: 'APPROVAL_POLICY_STATUS' }>,
    ): Promise<void>;
  };
  /**
   * p20-job-clock: HEARTBEAT `runningJobs` — each attempt's run clock is stored and a job whose time runs low is
   * warned (never fails the heartbeat).
   */
  readonly jobClock?: {
    onHeartbeat(
      session: WorkerSession,
      running: Extract<WorkerToMaster, { type: 'HEARTBEAT' }>['payload']['runningJobs'],
    ): Promise<void>;
  };
  /** p15-autonomy: TIME_LIMIT_STATUS (how a worker applied a running job's new time limit). */
  readonly timeLimit?: {
    onStatus(
      session: WorkerSession,
      message: Extract<WorkerToMaster, { type: 'TIME_LIMIT_STATUS' }>,
    ): Promise<void>;
  };
  /**
   * p8-preview-tunnels (ADR-0032): CAPABILITIES.previewTunnels (stored, connectors reconciled), PREVIEW_REQUEST from a
   * job's agent tool / auto-open, TUNNEL_STATUS of a connector.
   */
  readonly previews?: {
    onReport(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload'],
    ): Promise<void>;
    onRequest(
      session: WorkerSession,
      message: Extract<WorkerToMaster, { type: 'PREVIEW_REQUEST' }>,
    ): Promise<void>;
    onStatus(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'TUNNEL_STATUS' }>['payload'],
    ): Promise<void>;
  };
  /**
   * p15-services: CAPABILITIES.services (reconciled), SERVICE_STATUS, SERVICE_LOGS and a job agent's SERVICE_REQUEST.
   */
  readonly services?: () => {
    onReport(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload'],
    ): Promise<void>;
    onStatus(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'SERVICE_STATUS' }>['payload'],
    ): Promise<void>;
    onLogs(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'SERVICE_LOGS' }>['payload'],
    ): void;
    onRequest(
      session: WorkerSession,
      message: Extract<WorkerToMaster, { type: 'SERVICE_REQUEST' }>,
    ): Promise<void>;
  } | null;
  /**
   * p19-ide W2: CAPABILITIES.ide (availability, reconciliation), IDE_STATUS, the answers to IDE_GIT / IDE_FILE_REQUEST
   * and the bridge's IDE_EVENT.
   */
  readonly ide?: () => {
    onReport(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload'],
    ): Promise<void>;
    onSessionEnd(session: WorkerSession): void;
    onStatus(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'IDE_STATUS' }>['payload'],
    ): Promise<void>;
    onGitResult(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'IDE_GIT_RESULT' }>['payload'],
    ): void;
    onFileData(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'IDE_FILE_DATA' }>['payload'],
    ): void;
    onEvent(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'IDE_EVENT' }>['payload'],
    ): Promise<void>;
  } | null;
  /**
   * p15-workspace-retention: CAPABILITIES.workfiles (reconciled), WORKFILES_STATUS, WORKFILES_DATA (answers) and a
   * seeding job's WORKFILES_FETCH (relayed to the machine that keeps the files).
   */
  readonly workfiles?: () => {
    onReport(
      session: WorkerSession,
      report: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload']['workfiles'],
    ): Promise<void>;
    onStatus(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'WORKFILES_STATUS' }>['payload'],
    ): Promise<void>;
    onData(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'WORKFILES_DATA' }>['payload'],
    ): void;
    onFetch(
      session: WorkerSession,
      message: Extract<WorkerToMaster, { type: 'WORKFILES_FETCH' }>,
    ): Promise<void>;
  } | null;
  /** p11-limit-visibility: HEARTBEAT `runtimeUsage` (the runtimes' usage-limit windows). */
  readonly runtimeUsage?: { onReport(workerId: string, report: unknown): Promise<void> };
  /**
   * p17-update-channel (ADR-0065): CAPABILITIES.versionCatalog (the master re-sends its newest catalog to a
   * `version-catalog-v1` worker that holds an older one) and VERSION_CATALOG_STATUS.
   */
  readonly versionCatalog?: {
    onReport(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload'],
    ): Promise<void>;
    onStatus(
      session: WorkerSession,
      payload: Extract<WorkerToMaster, { type: 'VERSION_CATALOG_STATUS' }>['payload'],
    ): Promise<void>;
    onSessionEnd?(session: WorkerSession): void;
  };
  /** p2-signed-updates: update offers on session start and UPDATE_STATUS reports. */
  readonly updates?: {
    onSessionStart(session: WorkerSession): Promise<void>;
    onStatus(
      session: WorkerSession,
      message: Extract<WorkerToMaster, { type: 'UPDATE_STATUS' }>,
    ): Promise<void>;
  };
}

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
/** p17-chat-reconnect: connection drops kept per worker (workers.disconnects). */
export const MAX_DISCONNECTS = 10;

type Heartbeat = Extract<WorkerToMaster, { type: 'HEARTBEAT' }>;
type Capabilities = Extract<WorkerToMaster, { type: 'CAPABILITIES' }>;

/** Master view of a worker's state from its own report plus admin intent (drain wins). */
export function stateFromHeartbeat(reported: Heartbeat['payload']['state'], drainRequested: boolean): string {
  if (drainRequested) return 'draining';
  switch (reported) {
    case 'busy':
    case 'updating':
      return reported;
    default:
      return 'online';
  }
}

/**
 * Master-side worker state (p2-heartbeat-caps): online on session start (draining
 * when an admin asked for it, and DRAIN is re-sent), HEARTBEAT keeps it fresh and
 * carries busy/updating, CAPABILITIES is persisted per (runtime, version, os,
 * arch), and a worker that stops heartbeating or disconnects becomes offline.
 */
export class FleetSessionHandler implements WorkerSessionHandler {
  readonly heartbeatTimeoutMs: number;
  /** Resume cursors, dedupe and the master outbox (p2-replay). */
  readonly replay: WorkerReplay;

  constructor(protected readonly deps: FleetSessionDeps) {
    this.heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.replay = new WorkerReplay({
      pool: deps.pool,
      hub: deps.hub,
      clock: deps.clock,
      log: deps.log,
      ...(deps.sink ? { sink: deps.sink } : {}),
      ...(deps.replayLimits ? { limits: deps.replayLimits } : {}),
      // p15-message-delivery: an ACKed JOB_MESSAGE reached the machine.
      onAcked: (workerId, throughSeq) => deps.jobMessages?.onAcked(workerId, throughSeq) ?? Promise.resolve(),
    });
  }

  /**
   * Latest session per worker, and a per-worker queue for the state writes of
   * session start/end. Without both, an old connection closing while a
   * replacement is still handshaking could write `offline` after the new
   * session wrote `online` (seen as a flaky rotation test).
   */
  readonly #currentConnection = new Map<string, string>();
  readonly #stateQueue = new Map<string, Promise<void>>();

  #serialize(workerId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#stateQueue.get(workerId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.#stateQueue.set(workerId, settled);
    void settled.then(() => {
      if (this.#stateQueue.get(workerId) === settled) this.#stateQueue.delete(workerId);
    });
    return next;
  }

  async onSessionStart(session: WorkerSession): Promise<void> {
    await this.#serialize(session.workerId, async () => {
      this.#currentConnection.set(session.workerId, session.connectionId);
      await this.#markOnline(session);
    });
    await this.#recordDisconnect(session).catch((err: unknown) => {
      this.deps.log.warn({ err, workerId: session.workerId }, 'worker disconnect report not recorded');
    });
    // p17-chat-reconnect: assistant turns held for this worker continue on the new session (same process only).
    await this.deps.assistant?.onSessionStart?.(session).catch((err: unknown) => {
      this.deps.log.error({ err, workerId: session.workerId }, 'assistant session start handling failed');
    });
    // Replay unacknowledged master messages after the worker's cursor (p2-replay).
    await this.replay.onSessionStart(session);
    await this.deps.rotation?.onSessionStart(session);
    await this.deps.runtimePolicy?.onSessionStart(session).catch((err: unknown) => {
      this.deps.log.error({ err, workerId: session.workerId }, 'runtime policy delivery failed');
    });
    await this.deps.updates?.onSessionStart(session).catch((err: unknown) => {
      this.deps.log.error({ err, workerId: session.workerId }, 'update offer failed');
    });
  }

  /**
   * p17-chat-reconnect: the worker's report of why its previous connection ended (HELLO.lastDisconnect) is kept with the
   * worker — newest first, at most {@link MAX_DISCONNECTS}, the same report (same `at`) only once.
   */
  async #recordDisconnect(session: WorkerSession): Promise<void> {
    const report = session.lastDisconnect;
    if (report === undefined || report === null) return;
    const entry = { ...report, receivedAt: this.deps.clock().toISOString() };
    await this.deps.pool.query(
      `UPDATE workers
          SET disconnects = (
            SELECT coalesce(jsonb_agg(e ORDER BY i), '[]'::jsonb)
              FROM jsonb_array_elements(jsonb_build_array($2::jsonb) || disconnects) WITH ORDINALITY AS x(e, i)
             WHERE i <= $4)
        WHERE id = $1 AND (disconnects->0->>'at') IS DISTINCT FROM $3`,
      [session.workerId, JSON.stringify(entry), report.at, MAX_DISCONNECTS],
    );
  }

  async #markOnline(session: WorkerSession): Promise<void> {
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{ drain_reason: string | null; draining: boolean }>(
      `UPDATE workers
          SET state = CASE WHEN drain_requested_at IS NOT NULL THEN 'draining' ELSE 'online' END,
              connected_at = $2, last_seen_at = $2, last_ip = $3, updated_at = $2
        WHERE id = $1 AND state <> 'quarantined'
        RETURNING drain_reason, drain_requested_at IS NOT NULL AS draining`,
      [session.workerId, now, session.ip],
    );
    const row = rows[0];
    // The master owns drain intent: re-send it on every session (docs/design/p2-worker-core.md #10).
    if (row?.draining === true)
      await session.send('DRAIN', { reason: row.drain_reason ?? 'drain requested' });
  }

  async onMessage(session: WorkerSession, message: WorkerToMaster): Promise<void> {
    switch (message.type) {
      case 'HEARTBEAT':
        await this.#heartbeat(session, message);
        return;
      case 'CAPABILITIES':
        await this.#capabilities(session, message);
        await this.deps.runtimePolicy?.onCapabilities(session, message.payload.runtimePolicy);
        await this.deps.workerConfig
          ?.onReport(session, message.payload.workerConfig)
          .catch((err: unknown) => {
            this.deps.log.error({ err, workerId: session.workerId }, 'worker configuration report failed');
          });
        await this.deps.vault?.onReport(session, message.payload.credentialVault).catch((err: unknown) => {
          this.deps.log.error({ err, workerId: session.workerId }, 'vault report failed');
        });
        await this.deps.remoteOps?.onReport(session, message.payload.remoteOps).catch((err: unknown) => {
          this.deps.log.error({ err, workerId: session.workerId }, 'remote ops report failed');
        });
        await this.deps.assistant?.onReport(session, message.payload.assistant).catch((err: unknown) => {
          this.deps.log.error({ err, workerId: session.workerId }, 'assistant report failed');
        });
        await this.deps.machineAdmin?.onReport(session, message.payload).catch((err: unknown) => {
          this.deps.log.error({ err, workerId: session.workerId }, 'machine admin report failed');
        });
        await this.deps.versionCatalog?.onReport(session, message.payload).catch((err: unknown) => {
          this.deps.log.error({ err, workerId: session.workerId }, 'version catalog report failed');
        });
        await this.deps.mcpInstalls?.onReport(session, message.payload.mcpInstalls).catch((err: unknown) => {
          this.deps.log.error({ err, workerId: session.workerId }, 'MCP installs report failed');
        });
        await this.deps.previews?.onReport(session, message.payload).catch((err: unknown) => {
          this.deps.log.error({ err, workerId: session.workerId }, 'preview tunnels report failed');
        });
        await this.deps
          .services?.()
          ?.onReport(session, message.payload)
          .catch((err: unknown) => {
            this.deps.log.error({ err, workerId: session.workerId }, 'services report failed');
          });
        await this.deps
          .workfiles?.()
          ?.onReport(session, message.payload.workfiles)
          .catch((err: unknown) => {
            this.deps.log.error({ err, workerId: session.workerId }, 'workfiles report failed');
          });
        await this.deps
          .ide?.()
          ?.onReport(session, message.payload)
          .catch((err: unknown) => {
            this.deps.log.error({ err, workerId: session.workerId }, 'IDE report failed');
          });
        return;
      case 'IDE_STATUS':
        await this.deps
          .ide?.()
          ?.onStatus(session, message.payload)
          .catch((err: unknown) => {
            this.deps.log.error({ err, workerId: session.workerId }, 'IDE status failed');
          });
        return;
      case 'IDE_GIT_RESULT':
        this.deps.ide?.()?.onGitResult(session, message.payload);
        return;
      case 'IDE_FILE_DATA':
        this.deps.ide?.()?.onFileData(session, message.payload);
        return;
      case 'IDE_EVENT':
        await this.deps
          .ide?.()
          ?.onEvent(session, message.payload)
          .catch((err: unknown) => {
            this.deps.log.error({ err, workerId: session.workerId }, 'IDE event failed');
          });
        return;
      case 'SERVICE_STATUS':
        await this.deps.services?.()?.onStatus(session, message.payload);
        return;
      case 'SERVICE_LOGS':
        this.deps.services?.()?.onLogs(session, message.payload);
        return;
      case 'SERVICE_REQUEST':
        await this.deps.services?.()?.onRequest(session, message);
        return;
      case 'WORKFILES_STATUS':
        await this.deps
          .workfiles?.()
          ?.onStatus(session, message.payload)
          .catch((err: unknown) => {
            this.deps.log.error({ err, workerId: session.workerId }, 'workfiles status failed');
          });
        return;
      case 'WORKFILES_DATA':
        this.deps.workfiles?.()?.onData(session, message.payload);
        return;
      case 'WORKFILES_FETCH':
        await this.deps
          .workfiles?.()
          ?.onFetch(session, message)
          .catch((err: unknown) => {
            this.deps.log.error({ err, workerId: session.workerId }, 'workfiles relay failed');
          });
        return;
      case 'PREVIEW_REQUEST':
        await this.deps.previews?.onRequest(session, message);
        return;
      case 'TUNNEL_STATUS':
        await this.deps.previews?.onStatus(session, message.payload);
        return;
      case 'MACHINE_ADMIN_REQUEST':
        await this.deps.machineAdmin?.onRequest(session, message);
        return;
      case 'MACHINE_ADMIN_RESULT':
        await this.deps.machineAdmin?.onResult(session, message);
        return;
      case 'APPROVAL_POLICY_STATUS':
        await this.deps.approvalMode?.onStatus(session, message);
        return;
      case 'TIME_LIMIT_STATUS':
        await this.deps.timeLimit?.onStatus(session, message);
        return;
      case 'JOB_MESSAGE_STATUS':
        await this.deps.jobMessages?.onStatus(session, message);
        return;
      case 'ASSISTANT_UPDATE':
        await this.deps.assistant?.onUpdate(session, message.payload);
        return;
      case 'ASSISTANT_ATTACHMENT_REQUEST':
        await this.deps.assistant?.onAttachmentRequest?.(session, message.payload);
        return;
      case 'OPS_UPDATE':
        await this.deps.remoteOps?.onUpdate(session, message.payload);
        return;
      case 'CREDENTIAL_STATUS':
        this.deps.log.info(
          {
            workerId: session.workerId,
            credentialId: message.payload.credentialId,
            version: message.payload.version,
            outcome: message.payload.outcome,
            reason: message.payload.reason,
          },
          'vault credential status',
        );
        await this.deps.vault?.onStatus(session, message.payload);
        return;
      case 'VERSION_CATALOG_STATUS':
        await this.deps.versionCatalog?.onStatus(session, message.payload).catch((err: unknown) => {
          this.deps.log.error({ err, workerId: session.workerId }, 'version catalog status failed');
        });
        return;
      case 'WORKER_CONFIG_STATUS':
        this.deps.log.info(
          {
            workerId: session.workerId,
            generation: message.payload.generation,
            outcome: message.payload.outcome,
            reason: message.payload.report.rejected?.reason,
          },
          'worker configuration status',
        );
        await this.deps.workerConfig?.onReport(session, message.payload.report);
        return;
      case 'ACK':
        await this.replay.onAck(session, message.payload.throughSeq);
        return;
      case 'ROTATE_KEY':
        if (this.deps.rotation === undefined) {
          await session.send('ERROR', {
            code: 'rotation_refused',
            message: 'rotation disabled',
            retryable: false,
          });
          return;
        }
        await this.deps.rotation.onRotateKey(session, message);
        return;
      case 'UPDATE_STATUS':
        await this.deps.updates?.onStatus(session, message);
        return;
      case 'LEASE_ACK':
      case 'EVENT':
      case 'LOG_CHUNK':
      case 'JOB_RESULT':
      case 'ARTIFACT_REF':
      case 'ARTIFACT_CHUNK':
        await this.replay.onSequenced(session, message satisfies SequencedWorkerMessage);
        return;
      default:
        this.deps.log.debug(
          { workerId: session.workerId, type: message.type },
          'worker message not handled yet',
        );
    }
  }

  async onSessionEnd(session: WorkerSession, reason: string): Promise<void> {
    this.replay.onSessionEnd(session);
    this.deps.versionCatalog?.onSessionEnd?.(session);
    // Assistant turns sent over this connection cannot be answered any more (the worker aborts them).
    await this.deps.assistant?.onSessionEnd(session).catch((err: unknown) => {
      this.deps.log.error({ err, workerId: session.workerId }, 'assistant session end handling failed');
    });
    await this.#serialize(session.workerId, async () => {
      // A newer session of the same worker already started (replacement): keep it online.
      if (this.#currentConnection.get(session.workerId) !== session.connectionId) return;
      this.#currentConnection.delete(session.workerId);
      // p19-ide W2: the machine's IDE availability is known again from its next CAPABILITIES.
      this.deps.ide?.()?.onSessionEnd(session);
      if (this.deps.hub.isConnected(session.workerId)) return;
      await this.#markOffline(session.workerId);
      this.deps.log.info({ workerId: session.workerId, reason }, 'worker offline');
    });
  }

  async #markOffline(workerId: string): Promise<void> {
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE workers SET state = 'offline', connected_at = NULL, updated_at = $2
        WHERE id = $1 AND state IN ('online', 'busy', 'draining', 'updating')`,
      [workerId, now],
    );
  }

  async #heartbeat(session: WorkerSession, message: Heartbeat): Promise<void> {
    const now = this.deps.clock();
    const p = message.payload;
    // p16-doctor: master time minus the heartbeat's own timestamp (network latency included; bounded to ±1 day).
    const sentAt = Date.parse(message.ts);
    const skew = Number.isFinite(sentAt)
      ? Math.max(-86_400_000, Math.min(86_400_000, now.getTime() - sentAt))
      : null;
    await this.deps.pool.query(
      `UPDATE workers
          SET state = CASE
                WHEN drain_requested_at IS NOT NULL THEN 'draining'
                WHEN $3 IN ('busy', 'updating') THEN $3
                ELSE 'online' END,
              last_seen_at = $2, running_jobs = $4, load = $5, updated_at = $2,
              clock_skew_ms = $6, clock_skew_at = CASE WHEN $6::int IS NULL THEN clock_skew_at ELSE $2 END
        WHERE id = $1 AND state <> 'quarantined'`,
      [session.workerId, now, p.state, p.runningJobs.length, JSON.stringify(p.load), skew],
    );
    if (p.runtimeUsage !== undefined && p.runtimeUsage.length > 0) {
      await this.deps.runtimeUsage?.onReport(session.workerId, p.runtimeUsage).catch((err: unknown) => {
        this.deps.log.error({ err, workerId: session.workerId }, 'runtime usage report failed');
      });
    }
    if (p.runningJobs.length > 0) {
      await this.deps.jobClock?.onHeartbeat(session, p.runningJobs).catch((err: unknown) => {
        this.deps.log.error({ err, workerId: session.workerId }, 'job clock report failed');
      });
    }
  }

  async #capabilities(session: WorkerSession, message: Capabilities): Promise<void> {
    const now = this.deps.clock();
    const p = message.payload;
    const { os, arch } = session.facts;
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE workers SET sandbox_profiles = $2, tools = $3, max_parallel_jobs = $4, capabilities_at = $5,
                last_seen_at = $5, updated_at = $5, local_projects = $6, sandbox_readiness = $7,
                features = $8, sandbox_status = $9, sandbox_status_at = $10,
                package_caches = COALESCE($11::jsonb, package_caches),
                package_caches_at = CASE WHEN $11::jsonb IS NULL THEN package_caches_at ELSE $5 END,
                profile_concurrency = $12, exclusive_profiles = $13, local_login = $14,
                runtime_accounts = $15,
                git_readiness = COALESCE($16::jsonb, git_readiness),
                git_readiness_at = CASE WHEN $16::jsonb IS NULL THEN git_readiness_at ELSE $5 END,
                runtime_models = COALESCE($17::jsonb, runtime_models),
                runtime_models_at = CASE WHEN $17::jsonb IS NULL THEN runtime_models_at ELSE $5 END,
                disk_hygiene = COALESCE($18::jsonb, disk_hygiene),
                disk_hygiene_at = CASE WHEN $18::jsonb IS NULL THEN disk_hygiene_at ELSE $5 END
          WHERE id = $1`,
        [
          session.workerId,
          JSON.stringify(p.sandboxProfiles),
          JSON.stringify(p.tools),
          p.maxParallelJobs,
          now,
          p.projects === undefined ? null : JSON.stringify(p.projects),
          // p5-fleet-ui: why profiles are (not) ready, as reported (informational).
          p.sandboxReadiness === undefined ? null : JSON.stringify(p.sandboxReadiness),
          JSON.stringify(p.features ?? []),
          // p5-sandbox-ops: the Sandbox card's data (per-profile codes and fixes, host checks).
          p.sandboxStatus === undefined ? null : JSON.stringify(p.sandboxStatus),
          p.sandboxStatus === undefined ? null : now,
          // p6-warm-caches: sizes per project and package manager (machine page).
          p.packageCaches === undefined ? null : JSON.stringify(p.packageCaches),
          // p9-queue-priority (profile-slots-v1): per-profile slots; NULL when not reported (older workers).
          p.profileConcurrency === undefined ? null : JSON.stringify(p.profileConcurrency),
          p.exclusiveProfiles === undefined ? null : JSON.stringify(p.exclusiveProfiles),
          // p9-queue-local-login-accounting: subscription logins that run one at a time; NULL when not reported.
          p.localLogin === undefined ? null : JSON.stringify(p.localLogin),
          // p13-runtime-accounts: the worker's accounts (kinds, stores, login states); NULL when not reported.
          p.runtimeAccounts === undefined ? null : JSON.stringify(p.runtimeAccounts),
          // p15-git-central: the Git card (kept when a report leaves it out, e.g. while detection runs).
          p.gitReadiness === undefined ? null : JSON.stringify(p.gitReadiness),
          // p15-model-picker: the runtimes' model lists (kept when a report leaves them out, e.g. while listing).
          p.runtimeModels === undefined ? null : JSON.stringify(p.runtimeModels),
          // p17-disk-selfclean: the worker's own disk cleanup (machine page, doctor).
          p.diskHygiene === undefined ? null : JSON.stringify(p.diskHygiene),
        ],
      );
      // p13-runtime-accounts: login states of the stored account rows (labels never come from a worker).
      if (p.runtimeAccounts !== undefined) {
        for (const a of p.runtimeAccounts) {
          if (a.login === undefined) continue;
          await client.query(
            `UPDATE runtime_accounts SET login_status = $4, login_reason = $5, login_checked_at = $6
              WHERE worker_id = $1 AND runtime = $2 AND account_id = $3`,
            [session.workerId, a.runtime, a.id, a.login, a.reason ?? null, a.checkedAt ?? null],
          );
        }
      }
      await client.query('UPDATE worker_runtimes SET present = false WHERE worker_id = $1', [
        session.workerId,
      ]);
      for (const r of p.runtimes) {
        await client.query(
          `INSERT INTO worker_runtimes (worker_id, runtime, version, os, arch, installed, authenticated,
                                        pinned_version, pin_status, capabilities, present,
                                        first_reported_at, last_reported_at, unverified_update,
                                        adapter_version, declared_capabilities, evidence_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, $11, $12, $13, $14, $15)
           ON CONFLICT (worker_id, runtime, version, os, arch) DO UPDATE
             SET installed = EXCLUDED.installed, authenticated = EXCLUDED.authenticated,
                 pinned_version = EXCLUDED.pinned_version, pin_status = EXCLUDED.pin_status,
                 capabilities = EXCLUDED.capabilities, present = true, last_reported_at = EXCLUDED.last_reported_at,
                 unverified_update = EXCLUDED.unverified_update, adapter_version = EXCLUDED.adapter_version,
                 declared_capabilities = EXCLUDED.declared_capabilities,
                 evidence_version = EXCLUDED.evidence_version`,
          [
            session.workerId,
            r.runtime,
            r.version,
            os,
            arch,
            r.installed,
            r.authenticated,
            r.pinnedVersion ?? null,
            r.pinStatus ?? 'unknown',
            JSON.stringify(r.capabilities),
            now,
            // p16-runtime-updates: an owner-approved install outside the release pins (capabilities stay unverified).
            r.unverifiedUpdate === true,
            // p17-runtime-verify: the adapter revision and declared table master-side evidence is applied with.
            r.verification?.adapterVersion ?? null,
            r.verification === undefined ? null : JSON.stringify(r.verification.declared),
            // The adapter probe's version (Claude Code with a non-pinned SDK: `<cli>+sdk.<sdk>`), evidence's tuple.
            r.evidenceVersion ?? null,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Offline detection by missed heartbeats: connected workers silent for longer
   * than the timeout are disconnected (the socket may be a half-open NAT flow)
   * and marked offline; rows left online without any connection (e.g. after a
   * master crash) are marked offline too. Returns the affected worker ids.
   */
  async sweep(): Promise<string[]> {
    const cutoff = new Date(this.deps.clock().getTime() - this.heartbeatTimeoutMs);
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM workers
        WHERE state IN ('online', 'busy', 'draining', 'updating')
          AND (last_seen_at IS NULL OR last_seen_at < $1)`,
      [cutoff],
    );
    const stale = rows.map((r) => r.id);
    const unconnected = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM workers WHERE state IN ('online', 'busy', 'draining', 'updating')`,
    );
    const orphans = unconnected.rows.map((r) => r.id).filter((id) => !this.deps.hub.isConnected(id));
    const affected = [...new Set([...stale, ...orphans])];
    for (const id of affected) {
      if (this.deps.hub.isConnected(id)) {
        this.deps.log.warn({ workerId: id }, 'worker missed heartbeats; disconnecting');
        await this.deps.hub.disconnect(id, CloseCode.timeout, 'missed heartbeats');
      }
      await this.#markOffline(id);
    }
    return affected;
  }
}
