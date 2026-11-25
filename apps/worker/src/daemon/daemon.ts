import { randomUUID } from 'node:crypto';
import {
  type LeaseKey,
  isSequencedWorkerType,
  PROTOCOL_VERSION,
  WorkerId,
  type MasterToWorker,
  type WorkerToMaster,
} from '@remyral/protocol';
import type { Logger } from '@remyral/observability';
import type { DeviceKey } from '../identity/device-key.js';
import type { Keystore } from '../identity/keystore.js';
import { rotationPayload } from '@remyral/protocol/auth';
import { generatePairingCode } from '../identity/pairing.js';
import { WorkerStateMachine } from '../state/machine.js';
import type { WorkerStore } from '../store/store.js';
import type { ConnectParams, TransportEvent, TransportPort } from '../transport/port.js';
import type { ChildRegistry } from './children.js';
import type { ShutdownSignals } from './signals.js';
import type { CapabilitiesPayload, LoadSample } from './telemetry.js';
import type { DaemonUpdateHooks } from '../update/agent.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ControlType =
  | 'HEARTBEAT'
  | 'CAPABILITIES'
  | 'ACK'
  | 'ROTATE_KEY'
  | 'CREDENTIAL_REQUEST'
  | 'JOB_INPUT_REQUEST'
  | 'SKILL_FILE_REQUEST'
  | 'UPDATE_STATUS'
  | 'WORKER_CONFIG_STATUS'
  | 'VERSION_CATALOG_STATUS'
  | 'CREDENTIAL_STATUS'
  | 'OPS_UPDATE'
  | 'ASSISTANT_UPDATE'
  | 'ASSISTANT_ATTACHMENT_REQUEST'
  | 'MACHINE_ADMIN_REQUEST'
  | 'MACHINE_ADMIN_RESULT'
  | 'APPROVAL_POLICY_STATUS'
  | 'TIME_LIMIT_STATUS'
  | 'JOB_MESSAGE_STATUS'
  | 'SUBTASK_REQUEST'
  | 'QUESTION_REQUEST'
  | 'PREVIEW_REQUEST'
  | 'TUNNEL_STATUS'
  | 'CHECKPOINT_REPORT'
  | 'SERVICE_REQUEST'
  | 'SERVICE_STATUS'
  | 'SERVICE_LOGS'
  | 'WORKFILES_DATA'
  | 'WORKFILES_STATUS'
  | 'WORKFILES_FETCH'
  | 'INPUT_BUNDLE_REQUEST'
  | 'BLOB_UPLOAD_REQUEST'
  | 'BLOB_UPLOAD_COMPLETE'
  | 'IDE_STATUS'
  | 'IDE_GIT_RESULT'
  | 'IDE_FILE_DATA'
  | 'IDE_EVENT';
type ControlPayload<T extends ControlType> = Extract<WorkerToMaster, { type: T }>['payload'];

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export interface DaemonDeps {
  maxParallelJobs: number;
  store: WorkerStore;
  key: DeviceKey;
  logger: Logger;
  transport: TransportPort;
  children: ChildRegistry;
  signals: ShutdownSignals;
  /** Grace period between the polite stop and the tree kill for children. Default 10 s. */
  childGraceMs?: number;
  pairingCode?: () => string;
  /** CAPABILITIES sent at the start of every session (p2-heartbeat-caps). */
  capabilities?: () => Promise<CapabilitiesPayload>;
  /** Host load for HEARTBEAT. */
  load?: () => Promise<LoadSample>;
  /**
   * p11-limit-visibility: HEARTBEAT `runtimeUsage` — what changed since the last heartbeat (or is due for a refresh);
   * `sent` after the heartbeat went out, `resendAll` when a session starts.
   */
  runtimeUsage?: {
    pending(): ControlPayload<'HEARTBEAT'>['runtimeUsage'];
    sent(report: NonNullable<ControlPayload<'HEARTBEAT'>['runtimeUsage']>): void;
    resendAll(): void;
  };
  /** HEARTBEAT period; the master marks a worker offline after 3 missed beats. Default 15 s. */
  heartbeatIntervalMs?: number;
  /** ACKs for sequenced master messages are coalesced over this delay. Default 50 ms. */
  ackDelayMs?: number;
  /**
   * p11-master-resilience: at most this many outbox messages per second are sent (the master closes a connection
   * above 200/s sustained). Matters for the replay after a long outage; normal traffic is far below. Default 150.
   */
  replayRatePerSec?: number;
  /** Needed for key rotation (p2-identity-rotation); without it ROTATE_CREDENTIAL is refused locally. */
  keystore?: Keystore;
  /** p2-signed-updates: the update agent (UPDATE_AVAILABLE, health proof, outcome reports). */
  updates?: DaemonUpdateHooks;
  /**
   * p3-runtime-policy: validates and persists UPDATE_POLICY; resolves true when the applied runtime policy
   * changed (CAPABILITIES is then re-sent, its pins compared against the new policy).
   */
  runtimePolicy?: {
    onUpdatePolicy(payload: Extract<MasterToWorker, { type: 'UPDATE_POLICY' }>['payload']): Promise<boolean>;
  };
  /**
   * p17-update-channel (ADR-0065): verifies and stores APPLY_VERSION_CATALOG with this worker's own catalog keys. The
   * daemon answers VERSION_CATALOG_STATUS; the store's listeners re-send CAPABILITIES after an accepted catalog.
   */
  versionCatalog?: {
    onApply(
      payload: Extract<MasterToWorker, { type: 'APPLY_VERSION_CATALOG' }>['payload'],
    ): Promise<ControlPayload<'VERSION_CATALOG_STATUS'>>;
  };
  /**
   * ADR-0015: validates and applies APPLY_WORKER_CONFIG (panel-managed configuration). The daemon answers with
   * WORKER_CONFIG_STATUS and re-sends CAPABILITIES when the effective configuration changed.
   */
  managedConfig?: {
    onApply(
      workerId: string | null,
      payload: Extract<MasterToWorker, { type: 'APPLY_WORKER_CONFIG' }>['payload'],
    ): Promise<{ status: ControlPayload<'WORKER_CONFIG_STATUS'>; changed: boolean }>;
  };
  /**
   * p5-credentials-models: the panel credential vault (APPLY_CREDENTIAL, REVOKE_CREDENTIAL, ROTATE_VAULT_KEY).
   * The daemon answers CREDENTIAL_STATUS and re-sends CAPABILITIES when the held credentials or the key changed.
   */
  vault?: {
    onApply(
      workerId: string | null,
      payload: Extract<MasterToWorker, { type: 'APPLY_CREDENTIAL' }>['payload'],
    ): Promise<{ status: ControlPayload<'CREDENTIAL_STATUS'>; changed: boolean }>;
    onRevoke(
      workerId: string | null,
      payload: Extract<MasterToWorker, { type: 'REVOKE_CREDENTIAL' }>['payload'],
    ): Promise<{ status: ControlPayload<'CREDENTIAL_STATUS'>; changed: boolean }>;
    onRotateKey(): Promise<void>;
  };
  /** p4: job execution (ASSIGN_JOB, RENEW_LEASE, CANCEL_JOB, APPROVAL_DECISION, JOB_CREDENTIAL). */
  jobs?: (daemon: WorkerDaemon) => JobHandler;
  /**
   * p5-remote-ops (ADR-0017): OPS_COMMAND handling. Commands run in the background (an install or a login
   * takes minutes and must not hold up the message queue); results go out as OPS_UPDATE.
   */
  remoteOps?: {
    onCommand(
      workerId: string | null,
      payload: Extract<MasterToWorker, { type: 'OPS_COMMAND' }>['payload'],
    ): Promise<void>;
    onSessionEstablished(): void;
  };
  /**
   * p5-ops-chat (ADR-0018): the assistant host. Turns run in the background (they last up to minutes and must
   * not hold up the message queue: their tool results arrive as later messages); answers go out as
   * ASSISTANT_UPDATE.
   */
  assistant?: {
    onTurn(
      workerId: string | null,
      payload: Extract<MasterToWorker, { type: 'ASSISTANT_TURN' }>['payload'],
    ): Promise<void>;
    onToolResult(payload: Extract<MasterToWorker, { type: 'ASSISTANT_TOOL_RESULT' }>['payload']): void;
    onCancel(payload: Extract<MasterToWorker, { type: 'ASSISTANT_CANCEL' }>['payload']): void;
    /** p8-chat-attachments-mentions: one slice of a running turn's attachment (answers our request). */
    onAttachmentData?(
      payload: Extract<MasterToWorker, { type: 'ASSISTANT_ATTACHMENT_DATA' }>['payload'],
    ): void;
    onDisconnected(): void;
    /**
     * p17-chat-reconnect: ASSISTANT_RESUME — the master continues a turn after a reconnect of this process (re-send its
     * updates after `afterSeq`).
     */
    onResume?(payload: Extract<MasterToWorker, { type: 'ASSISTANT_RESUME' }>['payload']): void;
    /**
     * p17-chat-reconnect: the daemon stops on purpose — running turns are reported as lost now (before the transport
     * closes), so the master does not wait for a reconnect that will not come.
     */
    onStopping?(): Promise<void>;
  };
}

/** Job side of the daemon (implemented by jobs/runner.ts). */
export interface JobHandler {
  /** Returns true when the message was handled. */
  onMessage(message: MasterToWorker): Promise<boolean>;
  onSessionEstablished(leaseKeys: readonly LeaseKey[] | undefined): Promise<void>;
  /** p11-master-resilience: the session went down (running attempts continue within their offline grace). */
  onSessionLost?(): void;
  /** p15-message-delivery: the session can carry control messages now (after the outbox replay). */
  onSessionReady?(): void;
  runningJobs(): {
    jobId: string;
    attemptId: string;
    epoch: number;
    /** p20-job-clock: the attempt's run clock (HEARTBEAT `runningJobs[].clock`). */
    clock?: NonNullable<ControlPayload<'HEARTBEAT'>['runningJobs'][number]['clock']>;
  }[];
  /** p11-session-continuity: attempts a restarted worker can resume (HEARTBEAT `recoverableJobs`). */
  recoverableJobs?(): ControlPayload<'HEARTBEAT'>['recoverableJobs'];
  stop(): Promise<void>;
}

/** A sequenced worker message before the outbox assigns its seq. */
export type SequencedDraft =
  Extract<
    WorkerToMaster,
    { type: 'LEASE_ACK' | 'EVENT' | 'LOG_CHUNK' | 'JOB_RESULT' | 'ARTIFACT_REF' | 'ARTIFACT_CHUNK' }
  > extends infer M
    ? M extends WorkerToMaster
      ? Omit<M, 'seq' | 'messageId' | 'ts' | 'protocolVersion' | 'workerId'>
      : never
    : never;

export interface DaemonStopInfo {
  reason: string;
  /** Children that could not be confirmed terminated. */
  childErrors: number;
  /** p5-remote-ops: stopped for a remote restart (the process exits for its service manager). */
  restart?: boolean;
}

/**
 * Daemon core: wires store, identity, state machine and the transport port.
 * It owns no network code (p2-transport) and runs no jobs yet (p3/p4); it does
 * own shutdown, which must leave no child process behind.
 */
export class WorkerDaemon {
  readonly machine: WorkerStateMachine;
  readonly done: Promise<DaemonStopInfo>;
  #resolveDone!: (info: DaemonStopInfo) => void;
  #stopping: Promise<void> | null = null;
  #unsubscribeSignals: (() => void) | null = null;
  #events: Promise<void> = Promise.resolve();
  #pairingCode: string | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #sessionUp = false;
  /** Highest own outbox seq handed to the transport in this session (p2-replay). */
  #lastSent = 0;
  #pumping: Promise<void> = Promise.resolve();
  #ackTimer: NodeJS.Timeout | null = null;
  readonly #log: Logger;
  /** Current device key; replaced by a completed rotation. */
  #key: DeviceKey;
  readonly #jobs: JobHandler | null;
  /** The master asked for DRAIN (p2-signed-updates must not undo it after a local update drain). */
  #masterDrain = false;
  /** p5-remote-ops: the stop was requested for a remote restart. */
  #restart = false;

  constructor(private readonly deps: DaemonDeps) {
    this.#key = deps.key;
    this.#log = deps.logger.child({ component: 'daemon' });
    this.machine = new WorkerStateMachine(
      { maxParallelJobs: deps.maxParallelJobs },
      deps.logger.child({ component: 'state' }),
    );
    this.done = new Promise((resolve) => {
      this.#resolveDone = resolve;
    });
    this.#jobs = deps.jobs?.(this) ?? null;
  }

  /** Durable local state (the job runner persists leases here). */
  get store(): WorkerStore {
    return this.deps.store;
  }

  /** The job handler, if jobs are enabled (tests). */
  get jobs(): JobHandler | null {
    return this.#jobs;
  }

  /** Enrolled worker id (null before enrollment). */
  workerId(): string | null {
    return this.deps.store.identity?.workerId ?? null;
  }

  /**
   * Signs `data` with the current device key (it changes with a rotation). Used for statements the worker
   * vouches for, e.g. its vault key announcement (p5-credentials-models).
   */
  signWithDeviceKey(data: Uint8Array): string {
    return this.#key.sign(data);
  }

  /** OPS_UPDATE over the live session (p5-remote-ops; rejects without a session). */
  sendOpsUpdate(payload: ControlPayload<'OPS_UPDATE'>): Promise<void> {
    if (!this.#sessionUp) return Promise.reject(new Error('no session'));
    return this.#sendControl('OPS_UPDATE', payload);
  }

  /** ASSISTANT_UPDATE over the live session (p5-ops-chat; rejects without a session). */
  sendAssistantUpdate(payload: ControlPayload<'ASSISTANT_UPDATE'>): Promise<void> {
    if (!this.#sessionUp) return Promise.reject(new Error('no session'));
    return this.#sendControl('ASSISTANT_UPDATE', payload);
  }

  /** ASSISTANT_ATTACHMENT_REQUEST over the live session (p8-chat-attachments-mentions; rejects without a session). */
  sendAssistantAttachmentRequest(payload: ControlPayload<'ASSISTANT_ATTACHMENT_REQUEST'>): Promise<void> {
    if (!this.#sessionUp) return Promise.reject(new Error('no session'));
    return this.#sendControl('ASSISTANT_ATTACHMENT_REQUEST', payload);
  }

  /** Re-sends CAPABILITIES now (something it reports changed, e.g. a runtime install). */
  refreshCapabilities(): void {
    if (this.#sessionUp) void this.#sendCapabilities();
  }

  /** Jobs with a live run now (and children the daemon tracks). */
  runningJobCount(): number {
    return Math.max(this.machine.status.runningJobs, this.#jobs?.runningJobs().length ?? 0);
  }

  /**
   * p5-remote-ops: a local drain for a graceful remote restart (no new jobs; the master sees `draining`).
   * `false` ends it again unless the master itself asked for a drain.
   */
  setLocalDrain(on: boolean): void {
    if (on) {
      if (this.machine.state !== 'draining') this.machine.dispatch({ type: 'drain_requested' });
    } else if (!this.#masterDrain && this.machine.state === 'draining') {
      this.machine.dispatch({ type: 'drain_cancelled' });
    }
    if (this.#sessionUp) void this.#heartbeat();
  }

  /** p5-remote-ops: stop for a restart by the service manager (`done` resolves with `restart: true`). */
  requestRestart(reason: string): Promise<void> {
    this.#restart = true;
    return this.stop(reason);
  }

  /** p5-machine-admin: MACHINE_ADMIN_REQUEST / RESULT over the live session (control; rejects without one). */
  readonly machineAdmin = {
    request: (jobId: string, payload: ControlPayload<'MACHINE_ADMIN_REQUEST'>): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('MACHINE_ADMIN_REQUEST', payload, jobId)
        : Promise.reject(new Error('no session')),
    result: (jobId: string, payload: ControlPayload<'MACHINE_ADMIN_RESULT'>): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('MACHINE_ADMIN_RESULT', payload, jobId)
        : Promise.reject(new Error('no session')),
  };

  /** p8-orchestration: SUBTASK_REQUEST over the live session (control; rejects without one). */
  readonly subtasks = {
    request: (jobId: string, payload: ControlPayload<'SUBTASK_REQUEST'>): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('SUBTASK_REQUEST', payload, jobId)
        : Promise.reject(new Error('no session')),
  };

  /** p14-ask-user: QUESTION_REQUEST over the live session (control; rejects without one). */
  readonly questions = {
    request: (jobId: string, payload: ControlPayload<'QUESTION_REQUEST'>): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('QUESTION_REQUEST', payload, jobId)
        : Promise.reject(new Error('no session')),
  };

  /** p6-approval-mode-switch: APPROVAL_POLICY_STATUS over the live session (control; rejects without one). */
  reportApprovalPolicy(jobId: string, payload: ControlPayload<'APPROVAL_POLICY_STATUS'>): Promise<void> {
    if (!this.#sessionUp) return Promise.reject(new Error('no session'));
    return this.#sendControl('APPROVAL_POLICY_STATUS', payload, jobId);
  }

  /** p15-autonomy: TIME_LIMIT_STATUS over the live session (control; rejects without one). */
  reportTimeLimit(jobId: string, payload: ControlPayload<'TIME_LIMIT_STATUS'>): Promise<void> {
    if (!this.#sessionUp) return Promise.reject(new Error('no session'));
    return this.#sendControl('TIME_LIMIT_STATUS', payload, jobId);
  }

  /** p15-message-delivery: JOB_MESSAGE_STATUS over the live session (control; rejects without one). */
  reportMessageStatus(jobId: string, payload: ControlPayload<'JOB_MESSAGE_STATUS'>): Promise<void> {
    if (!this.#sessionUp) return Promise.reject(new Error('no session'));
    return this.#sendControl('JOB_MESSAGE_STATUS', payload, jobId);
  }

  /** p11-session-continuity: CHECKPOINT_REPORT over the live session (control; rejects without one). */
  reportCheckpoint(jobId: string, payload: ControlPayload<'CHECKPOINT_REPORT'>): Promise<void> {
    if (!this.#sessionUp) return Promise.reject(new Error('no session'));
    return this.#sendControl('CHECKPOINT_REPORT', payload, jobId);
  }

  /** p8-preview-tunnels: PREVIEW_REQUEST / TUNNEL_STATUS over the live session (control; rejects without one). */
  readonly previews = {
    request: (jobId: string, payload: ControlPayload<'PREVIEW_REQUEST'>): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('PREVIEW_REQUEST', payload, jobId)
        : Promise.reject(new Error('no session')),
    status: (payload: ControlPayload<'TUNNEL_STATUS'>): Promise<void> =>
      this.#sessionUp ? this.#sendControl('TUNNEL_STATUS', payload) : Promise.reject(new Error('no session')),
  };

  /** p15-services: SERVICE_REQUEST / SERVICE_STATUS / SERVICE_LOGS over the live session (control; rejects without one). */
  readonly services = {
    request: (jobId: string, payload: ControlPayload<'SERVICE_REQUEST'>): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('SERVICE_REQUEST', payload, jobId)
        : Promise.reject(new Error('no session')),
    status: (payload: ControlPayload<'SERVICE_STATUS'>): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('SERVICE_STATUS', payload)
        : Promise.reject(new Error('no session')),
    logs: (payload: ControlPayload<'SERVICE_LOGS'>): Promise<void> =>
      this.#sessionUp ? this.#sendControl('SERVICE_LOGS', payload) : Promise.reject(new Error('no session')),
  };

  /** p19-ide W2: IDE_STATUS / IDE_GIT_RESULT / IDE_FILE_DATA / IDE_EVENT over the live session (control). */
  readonly ide = {
    status: (payload: ControlPayload<'IDE_STATUS'>): Promise<void> =>
      this.#sessionUp ? this.#sendControl('IDE_STATUS', payload) : Promise.reject(new Error('no session')),
    gitResult: (payload: ControlPayload<'IDE_GIT_RESULT'>): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('IDE_GIT_RESULT', payload)
        : Promise.reject(new Error('no session')),
    fileData: (payload: ControlPayload<'IDE_FILE_DATA'>): Promise<void> =>
      this.#sessionUp ? this.#sendControl('IDE_FILE_DATA', payload) : Promise.reject(new Error('no session')),
    event: (payload: ControlPayload<'IDE_EVENT'>): Promise<void> =>
      this.#sessionUp ? this.#sendControl('IDE_EVENT', payload) : Promise.reject(new Error('no session')),
  };

  /**
   * p15-workspace-retention: WORKFILES_FETCH (a seeding attempt's relay request) / WORKFILES_DATA (answer to the
   * master's WORKFILES_REQUEST) / WORKFILES_STATUS (kept / removed) over the live session (control; rejects without one).
   */
  readonly workfiles = {
    fetch: (
      jobId: string,
      payload: Omit<ControlPayload<'WORKFILES_FETCH'>, 'attemptId'> & { readonly attemptId: string },
    ): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('WORKFILES_FETCH', payload as ControlPayload<'WORKFILES_FETCH'>, jobId)
        : Promise.reject(new Error('no session')),
    data: (payload: ControlPayload<'WORKFILES_DATA'>): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('WORKFILES_DATA', payload)
        : Promise.reject(new Error('no session')),
    status: (payload: ControlPayload<'WORKFILES_STATUS'>): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('WORKFILES_STATUS', payload)
        : Promise.reject(new Error('no session')),
  };

  /** p16-zip-job-input: INPUT_BUNDLE_REQUEST of a job pulling its input bundle (control; rejects without a session). */
  readonly inputBundles = {
    request: (
      jobId: string,
      payload: Omit<ControlPayload<'INPUT_BUNDLE_REQUEST'>, 'attemptId'> & { readonly attemptId: string },
    ): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('INPUT_BUNDLE_REQUEST', payload as ControlPayload<'INPUT_BUNDLE_REQUEST'>, jobId)
        : Promise.reject(new Error('no session')),
  };

  /** p17-object-storage: BLOB_UPLOAD_REQUEST / BLOB_UPLOAD_COMPLETE of a job's large output (control; rejects without a session). */
  readonly blobUploads = {
    request: (
      jobId: string,
      payload: Omit<ControlPayload<'BLOB_UPLOAD_REQUEST'>, 'attemptId'> & { readonly attemptId: string },
    ): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('BLOB_UPLOAD_REQUEST', payload as ControlPayload<'BLOB_UPLOAD_REQUEST'>, jobId)
        : Promise.reject(new Error('no session')),
    complete: (
      jobId: string,
      payload: Omit<ControlPayload<'BLOB_UPLOAD_COMPLETE'>, 'attemptId'> & { readonly attemptId: string },
    ): Promise<void> =>
      this.#sessionUp
        ? this.#sendControl('BLOB_UPLOAD_COMPLETE', payload as ControlPayload<'BLOB_UPLOAD_COMPLETE'>, jobId)
        : Promise.reject(new Error('no session')),
  };

  /** CREDENTIAL_REQUEST over the live session (control message; rejects without a session). */
  requestCredential(
    jobId: string,
    payload: {
      attemptId: string;
      epoch: number;
      requestId: string;
      kind: 'git';
      purpose?: 'fetch' | 'push';
      retry?: boolean;
    },
  ): Promise<void> {
    if (!this.#sessionUp) return Promise.reject(new Error('no session'));
    return this.#sendControl('CREDENTIAL_REQUEST', payload as ControlPayload<'CREDENTIAL_REQUEST'>, jobId);
  }

  /** p5-research-workspace: JOB_INPUT_REQUEST over the live session (control message; rejects without a session). */
  requestInput(
    jobId: string,
    payload: { attemptId: string; epoch: number; requestId: string; inputId: string; offset: number },
  ): Promise<void> {
    if (!this.#sessionUp) return Promise.reject(new Error('no session'));
    return this.#sendControl('JOB_INPUT_REQUEST', payload as ControlPayload<'JOB_INPUT_REQUEST'>, jobId);
  }

  /** p14-skill-catalogs: SKILL_FILE_REQUEST over the live session (control message; rejects without a session). */
  requestSkillFile(
    jobId: string,
    payload: {
      attemptId: string;
      epoch: number;
      requestId: string;
      manifestSha256: string;
      path: string;
      offset: number;
    },
  ): Promise<void> {
    if (!this.#sessionUp) return Promise.reject(new Error('no session'));
    return this.#sendControl('SKILL_FILE_REQUEST', payload as ControlPayload<'SKILL_FILE_REQUEST'>, jobId);
  }

  async start(): Promise<void> {
    const { store, transport } = this.deps;
    this.#unsubscribeSignals = this.deps.signals.onShutdown((reason) => {
      void this.stop(reason);
    });
    this.#attachUpdates();

    let identity = store.identity;
    if (identity !== null && identity.publicKey !== this.#key.publicKey) {
      // A rotation that was confirmed but not yet applied locally (crash in between): finish it.
      const next = await this.deps.keystore?.loadNext().catch(() => null);
      if (next?.publicKey === identity.publicKey && this.deps.keystore !== undefined) {
        this.#key = await this.deps.keystore.promoteNext();
        this.#log.warn('completed an interrupted key rotation', { fingerprint: this.#key.fingerprint });
      }
    }
    const key = this.#key;
    if (identity !== null && identity.publicKey !== key.publicKey) {
      // The enrollment belongs to a different key (keystore lost/replaced): re-pair (ADR-0005).
      this.#log.error('stored enrollment does not match the device key; clearing it, re-pairing required', {
        workerId: identity.workerId,
        fingerprint: key.fingerprint,
      });
      await store.clearIdentity();
      identity = null;
    }

    const leases = store.leases;
    this.#log.info('worker daemon starting', {
      state: this.machine.state,
      enrolled: identity !== null,
      workerId: identity?.workerId ?? null,
      fingerprint: key.fingerprint,
      leasesAwaitingReconciliation: leases.length,
      outboxPending: store.outbox.size,
    });
    if (leases.length > 0) {
      // Job processes did not survive the restart; the master decides (ADR-0004: reconcile, never blind rerun).
      this.#log.warn('restored leases from a previous run; awaiting reconciliation with the master', {
        jobs: leases.map((l) => ({
          jobId: l.jobId,
          attemptId: l.attemptId,
          epoch: l.epoch,
          expiresAt: l.expiresAt,
        })),
      });
    }

    let pairingCode: string | null = null;
    if (identity === null) {
      pairingCode = (this.deps.pairingCode ?? generatePairingCode)();
      // Displayed on purpose: the admin enters it and matches the fingerprint (ADR-0005 §3).
      this.#log.info('not enrolled; approve this worker in the dashboard', {
        pairingCode,
        fingerprint: key.fingerprint,
      });
    }

    this.#pairingCode = pairingCode;
    await transport.start({ ...this.#connectParams(), refresh: () => this.#connectParams() }, (event) => {
      const run = this.#events.then(() => this.#handle(event));
      this.#events = run.catch((error: unknown) => {
        this.#log.error('failed to handle transport event', { event: event.kind, err: error });
      });
      // The transport pauses reading while too many of these are outstanding (backpressure).
      return this.#events;
    });
  }

  /** Current identity/cursor for the next (re)connect attempt. */
  #connectParams(): ConnectParams {
    const { store } = this.deps;
    const key = this.#key;
    const identity = store.identity;
    return {
      publicKey: key.publicKey,
      workerId: identity?.workerId ?? null,
      // A pairing code is only offered while not enrolled (ADR-0005 §3).
      pairingCode: identity === null ? this.#pairingCode : null,
      resumeFromSeq: store.state.cursors.lastMasterSeq,
      signChallenge: (nonce) => key.signChallenge(nonce),
    };
  }

  /** Resolves once all queued transport events are processed (tests). */
  async settled(): Promise<void> {
    await this.#events;
  }

  /** Graceful, idempotent shutdown: transport, children, store. */
  stop(reason: string): Promise<void> {
    if (this.#stopping !== null) {
      this.#log.warn('shutdown already in progress', { reason });
      return this.#stopping;
    }
    this.#stopping = this.#shutdown(reason);
    return this.#stopping;
  }

  async #shutdown(reason: string): Promise<void> {
    this.#log.info('worker daemon stopping', { reason, children: this.deps.children.size });
    this.#unsubscribeSignals?.();
    // While the session is still up (telemetry stop below closes the send path).
    try {
      // p17-chat-reconnect: tell the master the running assistant turns end here (bounded; never blocks the stop).
      await Promise.race([
        this.deps.assistant?.onStopping?.(),
        new Promise((resolve) => setTimeout(resolve, 1_000).unref()),
      ]);
    } catch (error) {
      this.#log.warn('assistant stop notice failed', { err: error });
    }
    this.deps.updates?.stop();
    this.#stopTelemetry();
    try {
      // Runs stop without reporting; the master reconciles their leases (ADR-0004).
      await this.#jobs?.stop();
    } catch (error) {
      this.#log.error('stopping jobs failed', { err: error });
    }
    try {
      await this.deps.transport.stop();
    } catch (error) {
      this.#log.error('transport stop failed', { err: error });
    }
    const { terminated, errors } = await this.deps.children.terminateAll(this.deps.childGraceMs ?? 10_000);
    const childErrors = errors.length;
    for (const error of errors) this.#log.error('child process could not be terminated', { err: error });
    await this.#events;
    await this.deps.store.flush();
    this.#log.info('worker daemon stopped', { reason, childrenTerminated: terminated, childErrors });
    this.#resolveDone({ reason, childErrors, ...(this.#restart ? { restart: true } : {}) });
  }

  async #handle(event: TransportEvent): Promise<void> {
    if (this.#stopping !== null) return;
    switch (event.kind) {
      case 'connected':
        this.machine.dispatch({ type: event.enrolled ? 'session_established' : 'connected_unenrolled' });
        return;
      case 'disconnected':
        this.#stopTelemetry();
        this.deps.assistant?.onDisconnected();
        this.#jobs?.onSessionLost?.();
        // Anything not acknowledged is replayed after the next SESSION_ESTABLISHED.
        this.#lastSent = this.deps.store.state.cursors.ackedOutboundSeq;
        this.machine.dispatch({ type: 'disconnected', reason: event.reason });
        return;
      case 'message': {
        const message = event.message;
        if (message.seq === 0) {
          // Connection-scoped control message: handled, never a cursor (p2-replay).
          await this.#handleMessage(message);
          return;
        }
        const last = this.deps.store.state.cursors.lastMasterSeq;
        if (message.seq <= last) {
          // Replayed duplicate (at-least-once delivery): acknowledge without effect.
          // p5-live-fixes-2: a dropped user message must be visible in the service log.
          const level = message.type === 'JOB_MESSAGE' ? 'info' : 'debug';
          this.#log[level]('duplicate master message ignored', {
            type: message.type,
            seq: message.seq,
            lastMasterSeq: last,
          });
          this.#scheduleAck();
          return;
        }
        if (message.seq > last + 1) {
          this.#log.warn('gap in master sequence; processing anyway', {
            expected: last + 1,
            got: message.seq,
          });
        }
        await this.#handleMessage(message);
        await this.deps.store.recordMasterSeq(message.seq);
        this.#scheduleAck();
        return;
      }
    }
  }

  async #handleMessage(message: MasterToWorker): Promise<void> {
    if (this.#jobs !== null && (await this.#jobs.onMessage(message))) return;
    switch (message.type) {
      case 'ENROLL_APPROVED': {
        await this.deps.store.setIdentity({
          workerId: message.payload.workerId,
          publicKey: this.#key.publicKey,
          enrolledAt: message.payload.approvedAt,
        });
        this.machine.dispatch({ type: 'enrollment_approved' });
        return;
      }
      case 'DRAIN':
        this.#masterDrain = true;
        this.machine.dispatch({ type: 'drain_requested' });
        // Tell the master right away instead of waiting for the next beat.
        if (this.#sessionUp) void this.#heartbeat();
        return;
      case 'ERROR':
        if (message.payload.code === 'revoked') {
          this.machine.dispatch({ type: 'revoked', reason: message.payload.message });
          this.#log.error('worker credential revoked by the master; quarantined, transport stopped');
          this.#stopTelemetry();
          await this.deps.transport.stop();
          return;
        }
        if (message.payload.code === 'enrollment_denied') {
          this.#log.error('an administrator denied this enrollment; this key will not be accepted again');
          this.#stopTelemetry();
          await this.deps.transport.stop();
          return;
        }
        if (message.payload.code === 'credential_superseded') {
          await this.#onSuperseded();
          return;
        }
        if (message.payload.code === 'rotation_refused') {
          this.#log.error('the master refused the key rotation; keeping the current key', {
            message: message.payload.message,
          });
          await this.deps.keystore?.discardNext().catch(() => undefined);
          return;
        }
        if (message.payload.code === 'upgrade_required') {
          this.#log.error('master requires a newer protocol version; self-update is p2-signed-updates', {
            message: message.payload.message,
          });
          return;
        }
        this.#log.warn('master reported an error', {
          code: message.payload.code,
          message: message.payload.message,
          retryable: message.payload.retryable,
        });
        return;
      case 'ENROLL_PENDING':
        this.#log.info('pairing request received by the master; waiting for admin approval', {
          fingerprint: message.payload.fingerprint,
          expiresAt: message.payload.expiresAt,
        });
        return;
      case 'ROTATE_CREDENTIAL':
        await this.#rotate(message.payload.nonce);
        return;
      case 'CREDENTIAL_ROTATED':
        if (message.payload.status === 'pending_approval') {
          this.#log.info('rotated key registered; waiting for administrator approval', {
            fingerprint: message.payload.fingerprint,
          });
          return;
        }
        await this.#adoptNextKey(message.payload.fingerprint);
        this.deps.transport.reconnect?.('device key rotated');
        return;
      case 'UPDATE_AVAILABLE':
        if (this.deps.updates === undefined) {
          this.#log.warn('update offered but auto-update is disabled on this worker', {
            version: message.payload.version,
          });
          return;
        }
        this.deps.updates.onUpdateAvailable(message.payload);
        return;
      case 'SESSION_ESTABLISHED':
        this.deps.updates?.onSessionEstablished(message.payload.negotiatedVersion);
        if (message.payload.resumeFromSeq !== undefined) {
          await this.#resume(message.payload.resumeFromSeq);
        }
        await this.#jobs?.onSessionEstablished(message.payload.leaseKeys);
        if (!this.#sessionUp) {
          // Replay the durable outbox before the first HEARTBEAT: the master takes the first heartbeat's
          // running-jobs list as authoritative for LOST jobs, so a JOB_RESULT still in the outbox (crash or
          // partition after the run) must reach it first (p4-chaos finding; one socket keeps the order).
          this.#sessionUp = true;
          this.#pump();
          await this.#pumping;
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a disconnect during the replay clears it
          if (this.#sessionUp) {
            this.#startTelemetry();
            this.deps.remoteOps?.onSessionEstablished();
            this.#jobs?.onSessionReady?.();
          }
          return;
        }
        this.#pump();
        return;
      case 'ACK': {
        const through = message.payload.throughSeq;
        if (through >= this.deps.store.outbox.nextSeq) {
          this.#log.warn('master acknowledged a seq that was never sent; ignored', { throughSeq: through });
          return;
        }
        await this.deps.store.ackOutbound(through);
        this.#pump();
        return;
      }
      case 'CHALLENGE':
        // Handshake messages: the transport already acted on them.
        return;
      case 'UPDATE_POLICY': {
        if (this.deps.runtimePolicy === undefined) {
          this.#log.warn('runtime policy received but this daemon has no policy store; ignored', {
            policyVersion: message.payload.policyVersion,
          });
          return;
        }
        const changed = await this.deps.runtimePolicy.onUpdatePolicy(message.payload);
        if (changed && this.#sessionUp) void this.#sendCapabilities();
        return;
      }
      case 'APPLY_VERSION_CATALOG': {
        if (this.deps.versionCatalog === undefined) {
          this.#log.warn('version catalog received but this daemon cannot apply it; ignored', {
            sequence: message.payload.sequence,
          });
          return;
        }
        const status = await this.deps.versionCatalog.onApply(message.payload);
        if (this.#sessionUp) {
          await this.#sendControl('VERSION_CATALOG_STATUS', status).catch((err: unknown) => {
            this.#log.warn('could not send VERSION_CATALOG_STATUS', { err });
          });
        }
        return;
      }
      case 'APPLY_WORKER_CONFIG': {
        if (this.deps.managedConfig === undefined) {
          this.#log.warn('panel configuration received but this daemon cannot apply it; ignored', {
            generation: message.payload.generation,
          });
          return;
        }
        const { status, changed } = await this.deps.managedConfig.onApply(this.workerId(), message.payload);
        if (this.#sessionUp) {
          await this.#sendControl('WORKER_CONFIG_STATUS', status).catch((err: unknown) => {
            this.#log.warn('could not send WORKER_CONFIG_STATUS', { err });
          });
          if (changed) void this.#sendCapabilities();
        }
        return;
      }
      case 'APPLY_CREDENTIAL':
      case 'REVOKE_CREDENTIAL': {
        const vault = this.deps.vault;
        if (vault === undefined) {
          this.#log.warn('credential delivery received but this daemon has no vault; ignored', {
            credentialId: message.payload.credentialId,
          });
          return;
        }
        const { status, changed } =
          message.type === 'APPLY_CREDENTIAL'
            ? await vault.onApply(this.workerId(), message.payload)
            : await vault.onRevoke(this.workerId(), message.payload);
        if (this.#sessionUp) {
          await this.#sendControl('CREDENTIAL_STATUS', status).catch((err: unknown) => {
            this.#log.warn('could not send CREDENTIAL_STATUS', { err });
          });
          if (changed) void this.#sendCapabilities();
        }
        return;
      }
      case 'OPS_COMMAND': {
        const remote = this.deps.remoteOps;
        if (remote === undefined) {
          this.#log.warn('remote operation received but remote ops are not enabled on this worker; ignored', {
            commandId: message.payload.commandId,
          });
          return;
        }
        // Background: installs and logins take minutes; login.input / ops.cancel must still get through.
        void remote.onCommand(this.workerId(), message.payload).catch((err: unknown) => {
          this.#log.error('remote operation crashed', { err, commandId: message.payload.commandId });
        });
        return;
      }
      case 'ASSISTANT_TURN': {
        const assistant = this.deps.assistant;
        if (assistant === undefined) {
          this.#log.warn('assistant turn received but the assistant is not enabled on this worker; ignored', {
            turnId: message.payload.turnId,
          });
          return;
        }
        void assistant.onTurn(this.workerId(), message.payload).catch((err: unknown) => {
          this.#log.error('assistant turn crashed', { err, turnId: message.payload.turnId });
        });
        return;
      }
      case 'ASSISTANT_TOOL_RESULT':
        this.deps.assistant?.onToolResult(message.payload);
        return;
      case 'ASSISTANT_CANCEL':
        this.deps.assistant?.onCancel(message.payload);
        return;
      case 'ASSISTANT_RESUME':
        this.deps.assistant?.onResume?.(message.payload);
        return;
      case 'ASSISTANT_ATTACHMENT_DATA':
        this.deps.assistant?.onAttachmentData?.(message.payload);
        return;
      case 'ROTATE_VAULT_KEY': {
        if (this.deps.vault === undefined) return;
        try {
          await this.deps.vault.onRotateKey();
        } catch (err) {
          this.#log.error('vault key rotation failed; keeping the current key', { err });
          return;
        }
        if (this.#sessionUp) void this.#sendCapabilities();
        return;
      }
      default:
        // Jobs/policy belong to p3/p4.
        this.#log.warn('master message not handled by the daemon core yet', {
          type: message.type,
          messageId: message.messageId,
        });
    }
  }

  // ------------------------------------------------------------ telemetry (p2-heartbeat-caps)

  #startTelemetry(): void {
    this.#sessionUp = true;
    this.deps.runtimeUsage?.resendAll();
    void this.#sendCapabilities();
    void this.#heartbeat();
    this.#heartbeatTimer = setInterval(() => {
      void this.#heartbeat();
    }, this.deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  }

  #stopTelemetry(): void {
    this.#sessionUp = false;
    if (this.#ackTimer !== null) clearTimeout(this.#ackTimer);
    this.#ackTimer = null;
    if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }

  async #sendCapabilities(): Promise<void> {
    const provider = this.deps.capabilities;
    if (provider === undefined) return;
    try {
      await this.#sendControl('CAPABILITIES', await provider());
    } catch (error) {
      this.#log.warn('could not send CAPABILITIES', { err: error });
    }
  }

  async #heartbeat(): Promise<void> {
    try {
      const load = (await this.deps.load?.()) ?? { cpuPercent: 0, memoryFreeBytes: 0, diskFreeBytes: 0 };
      const usage = this.deps.runtimeUsage?.pending();
      await this.#sendControl('HEARTBEAT', {
        state: this.machine.state,
        // Only jobs with a live run (leases restored after a restart are not running).
        runningJobs: (this.#jobs?.runningJobs() ?? []) as ControlPayload<'HEARTBEAT'>['runningJobs'],
        // p11-session-continuity: attempts the previous process left that this one can resume (or why not).
        ...(() => {
          const r = this.#jobs?.recoverableJobs?.() ?? [];
          return r.length === 0 ? {} : { recoverableJobs: r };
        })(),
        load,
        ...(usage === undefined || usage.length === 0 ? {} : { runtimeUsage: usage }),
      });
      if (usage !== undefined && usage.length > 0) this.deps.runtimeUsage?.sent(usage);
      this.deps.updates?.onHeartbeatSent();
    } catch (error) {
      this.#log.debug('heartbeat not sent', { err: error });
    }
  }

  /** Connection-scoped control message (seq 0, never replayed). */
  #sendControl<T extends ControlType>(type: T, payload: ControlPayload<T>, jobId?: string): Promise<void> {
    const identity = this.deps.store.identity;
    if (identity === null) return Promise.reject(new Error('not enrolled'));
    return this.deps.transport.send({
      protocolVersion: PROTOCOL_VERSION,
      type,
      messageId: randomUUID(),
      seq: 0,
      ts: new Date().toISOString(),
      correlationId: `${type.toLowerCase()}-${randomUUID().slice(0, 8)}`,
      workerId: WorkerId.parse(identity.workerId),
      ...(jobId === undefined ? {} : { jobId }),
      payload,
    } as WorkerToMaster);
  }

  // ------------------------------------------------------------ updates (p2-signed-updates)

  #attachUpdates(): void {
    this.deps.updates?.attach({
      send: (payload) => this.#sendControl('UPDATE_STATUS', payload),
      runningJobs: () => Math.max(this.machine.status.runningJobs, this.deps.children.size),
      beginLocalDrain: () => {
        this.machine.dispatch({ type: 'drain_requested' });
        if (this.#sessionUp) void this.#heartbeat();
      },
      endLocalDrain: () => {
        if (this.#masterDrain || this.machine.state !== 'draining') return;
        this.machine.dispatch({ type: 'drain_cancelled' });
        if (this.#sessionUp) void this.#heartbeat();
      },
      updateStarted: () => {
        const ok = this.machine.dispatch({ type: 'update_started' }).ok;
        if (ok && this.#sessionUp) void this.#heartbeat();
        return ok;
      },
      updateFailed: () => {
        if (this.machine.state !== 'updating') return;
        this.machine.dispatch({ type: 'update_failed' });
        // `updating → offline`: reconnect to come back online with a fresh session.
        this.deps.transport.reconnect?.('update failed');
      },
    });
  }

  // ------------------------------------------------------------ replay (p2-replay)

  /**
   * Queue a sequenced message durably (outbox, fsynced) and send it when a session
   * is up. It is replayed after reconnects until the master acknowledges it.
   * Resolves with the assigned seq once it is on disk.
   */
  async sendSequenced(draft: SequencedDraft & { readonly messageId?: string }): Promise<number> {
    if (!isSequencedWorkerType(draft.type)) throw new TypeError(`${draft.type} is not a sequenced type`);
    const identity = this.deps.store.identity;
    if (identity === null) throw new Error('not enrolled');
    // p11-master-resilience: a LEASE_ACK carries the runner's own messageId (renewals / refusals are matched to it).
    const own = (draft as { messageId?: unknown }).messageId;
    const messageId = typeof own === 'string' && UUID_RE.test(own) ? own : randomUUID();
    const seq = await this.deps.store.outbox.append((s) => ({
      ...draft,
      protocolVersion: PROTOCOL_VERSION,
      messageId,
      seq: s,
      ts: new Date().toISOString(),
      workerId: identity.workerId,
    }));
    this.#pump();
    return seq;
  }

  /** Master's cursor from SESSION_ESTABLISHED: implicit ack, then replay everything after it. */
  async #resume(resumeFromSeq: number): Promise<void> {
    const fastForwarded = await this.deps.store.resumeOutbound(resumeFromSeq);
    if (fastForwarded) {
      this.#log.warn('master is ahead of the local outbox (local state was reset); numbering continues', {
        resumeFromSeq,
      });
    }
    if (this.deps.store.takeRollback()) {
      // p11-master-resilience: e.g. the control plane was restored from its standby backup (RPO window lost).
      this.#log.warn(
        'master is behind messages it had acknowledged (restored from a backup?); pending ones follow it',
        {
          resumeFromSeq,
        },
      );
    }
    this.#lastSent = resumeFromSeq;
  }

  /** Send outbox entries after `#lastSent` in order; stops at the first failure (resumed later). */
  #pump(): void {
    this.#pumping = this.#pumping.then(async () => {
      for (;;) {
        if (!this.#sessionUp || this.#stopping !== null) return;
        const next = this.deps.store.outbox.pending(this.#lastSent)[0];
        if (next === undefined) return;
        await this.#pace();
        try {
          await this.deps.transport.send(next.message as WorkerToMaster);
        } catch (error) {
          this.#log.debug('outbox send paused; will resume', { seq: next.seq, err: error });
          return;
        }
        this.#lastSent = next.seq;
      }
    });
  }

  #paceWindowStart = 0;
  #paceSent = 0;

  /** p11-master-resilience: keeps the outbox below the master's per-connection message rate (fixed 1 s windows). */
  async #pace(): Promise<void> {
    const limit = this.deps.replayRatePerSec ?? 150;
    const now = Date.now();
    if (now - this.#paceWindowStart >= 1_000) {
      this.#paceWindowStart = now;
      this.#paceSent = 0;
    }
    if (this.#paceSent >= limit) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, this.#paceWindowStart + 1_000 - now)));
      this.#paceWindowStart = Date.now();
      this.#paceSent = 0;
    }
    this.#paceSent += 1;
  }

  #scheduleAck(): void {
    if (this.#ackTimer !== null || !this.#sessionUp) return;
    this.#ackTimer = setTimeout(() => {
      this.#ackTimer = null;
      void this.#sendControl('ACK', { throughSeq: this.deps.store.state.cursors.lastMasterSeq }).catch(
        () => undefined,
      );
    }, this.deps.ackDelayMs ?? 50);
  }

  /** Resolves when the outbox pump is idle (tests). */
  async drained(): Promise<void> {
    await this.#pumping;
  }

  // ------------------------------------------------------------ key rotation (p2-identity-rotation)

  /** ROTATE_CREDENTIAL: generate (or reuse) the next key, sign the statement with both keys, send ROTATE_KEY. */
  async #rotate(nonce: string | undefined): Promise<void> {
    const keystore = this.deps.keystore;
    const identity = this.deps.store.identity;
    if (keystore === undefined || nonce === undefined || identity === null) {
      this.#log.warn('cannot rotate the device key (no keystore, nonce or enrollment)');
      return;
    }
    // Stored before the master knows it, so a crash after the master accepted cannot lose the key.
    const next = await keystore.createNext();
    const statement = rotationPayload({
      workerId: identity.workerId,
      oldPublicKey: this.#key.publicKey,
      newPublicKey: next.publicKey,
      nonce,
    });
    this.#log.info('rotating the device key', { from: this.#key.fingerprint, to: next.fingerprint });
    await this.#sendControl('ROTATE_KEY', {
      nonce,
      newPublicKey: next.publicKey,
      oldKeySignature: this.#key.sign(statement),
      newKeySignature: next.sign(statement),
    });
  }

  /** The master activated the next key: persist the enrollment for it first, then swap the key file. */
  async #adoptNextKey(expectedFingerprint: string | null): Promise<boolean> {
    const keystore = this.deps.keystore;
    const identity = this.deps.store.identity;
    const next = await keystore?.loadNext().catch(() => null);
    if (keystore === undefined || identity === null || next === null || next === undefined) return false;
    if (expectedFingerprint !== null && next.fingerprint !== expectedFingerprint) {
      this.#log.error('master confirmed a key this worker did not generate; ignored', {
        expected: expectedFingerprint,
        actual: next.fingerprint,
      });
      return false;
    }
    // Order matters for crash safety: enrollment → new key, then the file swap (finished on restart).
    await this.deps.store.setIdentity({ ...identity, publicKey: next.publicKey });
    this.#key = await keystore.promoteNext();
    this.#log.info('device key rotated', { fingerprint: this.#key.fingerprint });
    return true;
  }

  /** Connected with a key the master replaced: switch to the rotated key, or give up. */
  async #onSuperseded(): Promise<void> {
    if (await this.#adoptNextKey(null)) return; // the transport reconnects with the new key
    this.#log.error('this device key was superseded and no rotated key is available; re-pair the worker');
    this.#stopTelemetry();
    await this.deps.transport.stop();
  }
}
