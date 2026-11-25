import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type Logger } from '@remyral/observability';
import {
  type CapabilitiesPayload,
  ChildRegistry,
  createNodeFileOps,
  FileKeystore,
  loadOrCreateDeviceKey,
  ManualSignals,
  pairWorker,
  WorkerDaemon,
  WorkerStore,
  WsTransport,
  type TransportTiming,
  type DaemonUpdateHooks,
  RuntimePolicyStore,
  runtimePolicyHooks,
  deriveCeiling,
  LeaseKeyring,
  ManagedConfig,
  workerConfigSchema,
  CredentialVault,
  FileSecretStore,
} from '@remyral/worker';
import type { RuntimePolicyDelivery } from '@remyral/protocol';
import type { AssistantEngine } from '@remyral/agent-adapters';
import { Redactor } from '@remyral/observability';
import { AssistantAttachmentFetcher, AssistantHost } from '@remyral/worker';
import { expect } from 'vitest';
import type { Client, Harness } from './harness.js';
import { FACTS } from './raw-worker.js';

export const CAPS: CapabilitiesPayload = {
  runtimes: [
    {
      runtime: 'opencode',
      version: '1.19.0',
      installed: true,
      authenticated: 'unknown',
      capabilities: { streaming: { status: 'supported' }, resume: { status: 'unverified' } },
      pinnedVersion: '1.19.0',
      pinStatus: 'match',
    },
    {
      runtime: 'codex',
      version: '0.130.0',
      installed: true,
      authenticated: 'yes',
      capabilities: { cancel: { status: 'degraded', note: 'SIGINT only' } },
      pinnedVersion: '0.131.0',
      pinStatus: 'mismatch',
    },
  ],
  sandboxProfiles: ['host-restricted'],
  maxParallelJobs: 2,
  tools: [{ name: 'git', version: '2.50.1' }],
};

/** Pairs a throw-away data dir with the master (approving via REST) and returns its worker id. */
export async function pairRealWorker(
  h: Harness,
  url: string,
  admin: Client,
  secret: string,
  dataDir: string,
) {
  const out: string[] = [];
  const done = pairWorker({
    ops: createNodeFileOps(),
    host: { platform: process.platform, env: () => undefined, homedir: () => dataDir, isPrivileged: false },
    signals: new ManualSignals(),
    facts: () => Promise.resolve({ ...FACTS, hostname: 'real-worker' }),
    out: (t) => out.push(t),
    masterUrl: url,
    dataDir,
    logSink: () => undefined,
  });
  await expect.poll(() => out.join('').includes('Waiting for approval')).toBe(true);
  const code = /Pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(out.join(''))?.[1] ?? '';
  const fingerprint = /Fingerprint: +(SHA256:[0-9A-F-]+)/.exec(out.join(''))?.[1] ?? '';
  const list = await admin.req('GET', '/workers');
  const pending = list
    .json<{ workers: { id: string; fingerprint: string }[] }>()
    .workers.find((w) => w.fingerprint === fingerprint);
  if (pending === undefined) throw new Error('pending worker not listed');
  h.clock.advance(30_000);
  expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  const res = await admin.req('POST', `/workers/${pending.id}/approve`, { pairingCode: code });
  expect(res.statusCode).toBe(200);
  expect(await done).toBe('approved');
  return pending.id;
}

export interface RunningWorker {
  daemon: WorkerDaemon;
  transport: WsTransport;
  store: WorkerStore;
  /** p3-runtime-policy: present when the worker was started with `runtimePolicy: true`. */
  policies: RuntimePolicyStore | null;
  /** ADR-0015: present when the worker was started with `managed`. */
  managed: ManagedConfig | null;
  /** p5-credentials-models: present when the worker was started with `vault: true`. */
  vault: CredentialVault | null;
  /** p5-ops-chat: present when the worker was started with `assistant`. */
  assistant: AssistantHost | null;
  secrets: FileSecretStore;
  logger: Logger;
  lines: Record<string, unknown>[];
  stop(): Promise<void>;
}

/** Runs the real daemon + WebSocket transport on `dataDir` (already paired). */
export async function runRealWorker(
  url: string,
  dataDir: string,
  opts: {
    capabilities?: CapabilitiesPayload;
    heartbeatIntervalMs?: number;
    /** p17-chat-reconnect: transport timing (e.g. fast pings to see a stale connection). */
    timing?: Partial<TransportTiming>;
    workerVersion?: string;
    updates?: DaemonUpdateHooks;
    /** p3-runtime-policy: persist UPDATE_POLICY in the data dir and build CAPABILITIES against it. */
    runtimePolicy?: boolean;
    capabilitiesFor?: (policy: RuntimePolicyDelivery | null) => CapabilitiesPayload;
    /**
     * ADR-0015: run the real panel-config manager on a local file built from `file` (masterUrl/workspaceRoot
     * are filled in). CAPABILITIES then carry the effective values, `worker-config-v1` and the report, and
     * APPLY_WORKER_CONFIG signatures are verified against the session's lease keys (or `file.masterLeaseKeys`).
     */
    managed?: { file: Record<string, unknown>; workspaceRoot: string };
    /** p5-credentials-models: run the real credential vault (file secret store in the data dir). */
    vault?: boolean;
    /**
     * p5-ops-chat: run the real assistant host with this engine (local-login auth, no secrets). `clock` is the
     * master's (turn validity windows); CAPABILITIES then carry `assistant-v1`, `job-input-v1` and the report.
     */
    assistant?: {
      engine: AssistantEngine;
      clock?: () => Date;
      maxSessions?: number;
      /** p11-usage-limit-fallback: more engines besides Claude Code (e.g. a fallback engine). */
      extraEngines?: Partial<Record<'codex' | 'opencode' | 'pi', AssistantEngine>>;
      /**
       * p15-chat-execute-default: advertise `assistant-propose-v1` (default true, like the current worker release);
       * false plays an older assistant worker (drafts run only with `execute: true`).
       */
      proposeAware?: boolean;
      /**
       * p17-chat-reconnect: advertise `assistant-resume-v1` and keep turns across a reconnect (default true, like the
       * current worker release); false plays an older assistant worker (turns aborted on a drop, no resume).
       */
      resumeAware?: boolean;
      /**
       * p18-plan-mode: advertise `assistant-plan-v1` (default true, like the current worker release); false plays an
       * older assistant worker (no plan tools: the Planla chip is off, continuation turns wait).
       */
      planAware?: boolean;
      /** p17-chat-reconnect: the host's hold for a resume (default 90 s). */
      resumeHoldMs?: number;
    };
  } = {},
): Promise<RunningWorker> {
  const ops = createNodeFileOps();
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const { store } = await WorkerStore.open(ops, dataDir);
  const keystore = new FileKeystore(ops, dataDir);
  const { key } = await loadOrCreateDeviceKey(keystore);
  const transport = new WsTransport({
    masterUrl: url,
    logger,
    workerVersion: opts.workerVersion ?? '0.1.0-test',
    facts: () => ({ ...FACTS, hostname: 'real-worker' }),
    timing: { backoffBaseMs: 20, backoffMaxMs: 200, ...opts.timing },
  });
  const signals = new ManualSignals();
  const policies = opts.runtimePolicy === true ? (await RuntimePolicyStore.open(ops, dataDir)).store : null;
  const capabilitiesFor = opts.capabilitiesFor;
  let managed: ManagedConfig | null = null;
  let keyring: LeaseKeyring | null = null;
  if (opts.managed !== undefined) {
    const raw = { masterUrl: url, workspaceRoot: opts.managed.workspaceRoot, ...opts.managed.file };
    const parsed = workerConfigSchema(process.platform).parse(raw);
    const { dataDir: _d, $schema: _s, ...rest } = parsed;
    const base = { ...rest, dataDir, source: 'test' };
    const config = { ...base, ...deriveCeiling(raw, base) };
    const ring = new LeaseKeyring(config.masterLeaseKeys ?? null);
    keyring = ring;
    managed = (
      await ManagedConfig.open(ops, config, () => ({ keys: ring.keys, pinned: ring.isPinned }), logger)
    ).managed;
  }
  const secrets = new FileSecretStore(ops, dataDir);
  if ((opts.vault === true || opts.assistant !== undefined) && keyring === null)
    keyring = new LeaseKeyring(null);
  const assistantRing = keyring;
  const attachmentFetcher = new AssistantAttachmentFetcher();
  const assistant =
    opts.assistant === undefined || assistantRing === null
      ? null
      : new AssistantHost({
          logger,
          redactor: new Redactor(),
          engines: { 'claude-code': opts.assistant.engine, ...opts.assistant.extraEngines },
          keySource: () => ({ keys: assistantRing.keys, pinned: assistantRing.isPinned }),
          disabled: false,
          scratchRoot: join(dataDir, 'assistant'),
          runtimeAllowed: () => ({ ok: true }),
          auth: () => Promise.resolve({ authMode: 'local-login', secretEnv: {}, release: () => undefined }),
          flushMs: 5,
          fetchAttachment: (turnId, ref, signal) => attachmentFetcher.fetch(turnId, ref, signal),
          ...(opts.assistant.clock === undefined ? {} : { clock: opts.assistant.clock }),
          ...(opts.assistant.maxSessions === undefined ? {} : { maxSessions: opts.assistant.maxSessions }),
          ...(opts.assistant.resumeAware === false
            ? { resumeHoldMs: 0 }
            : opts.assistant.resumeHoldMs === undefined
              ? {}
              : { resumeHoldMs: opts.assistant.resumeHoldMs }),
        });
  const vaultRing = keyring;
  const vault =
    opts.vault === true && vaultRing !== null
      ? (
          await CredentialVault.open({
            ops,
            dataDir,
            secrets,
            keySource: () => ({ keys: vaultRing.keys, pinned: vaultRing.isPinned }),
            logger,
          })
        ).vault
      : null;
  let daemonRef: WorkerDaemon | null = null;
  const vaultCaps = (base: CapabilitiesPayload): CapabilitiesPayload =>
    vault === null || daemonRef === null
      ? base
      : {
          ...base,
          features: [...(base.features ?? []), 'credential-vault-v1'],
          credentialVault: vault.report(
            daemonRef.workerId(),
            (data) => daemonRef?.signWithDeviceKey(data) ?? '',
          ),
        };
  const assistantCaps = async (base: CapabilitiesPayload): Promise<CapabilitiesPayload> =>
    assistant === null
      ? base
      : {
          ...base,
          features: [
            ...(base.features ?? []),
            'assistant-v1',
            'assistant-input-v1',
            'job-message-v1',
            ...(opts.assistant?.proposeAware === false ? [] : ['assistant-propose-v1' as const]),
            ...(opts.assistant?.resumeAware === false ? [] : ['assistant-resume-v1' as const]),
            ...(opts.assistant?.planAware === false ? [] : ['assistant-plan-v1' as const]),
          ],
          assistant: await assistant.report(),
        };
  const m = managed;
  const managedCaps = (base: CapabilitiesPayload): CapabilitiesPayload =>
    m === null
      ? base
      : {
          ...base,
          maxParallelJobs: m.effective.maxParallelJobs,
          projects: Object.keys(m.effective.projects),
          features: [...(base.features ?? []), 'worker-config-v1'],
          workerConfig: m.report(),
        };
  const daemon = new WorkerDaemon({
    maxParallelJobs: 2,
    store,
    key,
    keystore,
    logger,
    transport,
    children: new ChildRegistry(),
    signals,
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 200,
    load: () => Promise.resolve({ cpuPercent: 12.5, memoryFreeBytes: 1024, diskFreeBytes: 4096 }),
    ...(opts.capabilities
      ? {
          capabilities: () => assistantCaps(vaultCaps(managedCaps(opts.capabilities as CapabilitiesPayload))),
        }
      : {}),
    ...(capabilitiesFor
      ? { capabilities: () => Promise.resolve(capabilitiesFor(policies?.policy ?? null)) }
      : {}),
    ...(policies === null ? {} : { runtimePolicy: runtimePolicyHooks(policies, logger) }),
    ...(opts.updates ? { updates: opts.updates } : {}),
    ...(assistant === null
      ? {}
      : {
          assistant: {
            onTurn: (workerId, payload) => assistant.onTurn(workerId, payload),
            onToolResult: (payload) => {
              assistant.onToolResult(payload);
            },
            onCancel: (payload) => {
              assistant.onCancel(payload);
            },
            onAttachmentData: (payload) => {
              attachmentFetcher.onData(payload);
            },
            onDisconnected: () => {
              attachmentFetcher.onDisconnected();
              assistant.onDisconnected();
            },
            ...(opts.assistant?.resumeAware === false
              ? {}
              : {
                  onResume: (payload) => {
                    assistant.onResume(payload);
                  },
                  onStopping: () => assistant.onStopping(),
                }),
          },
        }),
    ...(vault === null
      ? {}
      : {
          vault: {
            onApply: (workerId, payload) => vault.apply(workerId, payload),
            onRevoke: (workerId, payload) => vault.revoke(workerId, payload),
            onRotateKey: () => vault.rotateKey(),
          },
        }),
    ...(keyring === null
      ? {}
      : {
          ...(m === null
            ? {}
            : { managedConfig: { onApply: (workerId, payload) => m.apply(workerId, payload) } }),
          // Only the lease keys of the session matter here (they verify APPLY_WORKER_CONFIG signatures).
          jobs: () => {
            const ring = keyring;
            return {
              onMessage: () => Promise.resolve(false),
              onSessionEstablished: (keys) => {
                ring.setSessionKeys(keys);
                return Promise.resolve();
              },
              runningJobs: () => [],
              stop: () => Promise.resolve(),
            };
          },
        }),
  });
  daemonRef = daemon;
  assistant?.attach((payload) => daemon.sendAssistantUpdate(payload));
  attachmentFetcher.attach((payload) => daemon.sendAssistantAttachmentRequest(payload));
  m?.subscribe((e) => {
    daemon.machine.setLimits({ maxParallelJobs: e.maxParallelJobs });
  });
  await daemon.start();
  return {
    daemon,
    transport,
    store,
    policies,
    managed,
    vault,
    assistant,
    secrets,
    logger,
    lines,
    async stop() {
      await daemon.stop('test');
      await assistant?.stop();
    },
  };
}

export async function tempDataDir(dirs: string[]): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'rw-int-'));
  dirs.push(d);
  return d;
}

export async function removeDirs(dirs: string[]): Promise<void> {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
}
