import websocket from '@fastify/websocket';
import {
  type LeaseKey,
  MAX_FRAME_BYTES,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ProtocolVersion,
} from '@remyral/protocol';
import type { FastifyInstance } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { ConnectionCaps, type ConnectionCapRule } from '../http/connection-caps.js';
import { HttpError } from '../http/errors.js';
import { CONNECTION_CAPS, WORKER_LIMITS, type WindowRule } from '../http/rate-policy.js';
import {
  CloseCode,
  type ConnectionHost,
  DEFAULT_GATEWAY_LIMITS,
  DEFAULT_GATEWAY_TIMING,
  type GatewayLimits,
  type GatewayTiming,
  WorkerConnection,
} from './connection.js';
import type { WorkerHub } from './hub.js';
import type { DeviceDirectory, StreamSinkFactory, WorkerSessionHandler } from './types.js';

export const WORKER_ENDPOINT = '/v1/worker';

export interface ConnectRateLimit {
  /** WebSocket upgrades per IP per window (before any protocol work is done). */
  readonly perIp: number;
  readonly windowMs: number;
}

export const DEFAULT_CONNECT_RATE_LIMIT: ConnectRateLimit = {
  perIp: WORKER_LIMITS.connectPerIp.max,
  windowMs: WORKER_LIMITS.connectPerIp.windowMs,
};

export interface WorkerGatewayDeps {
  readonly hub: WorkerHub;
  readonly directory: DeviceDirectory;
  readonly handler: WorkerSessionHandler;
  readonly audit: AuditRecorder;
  readonly limiter: RateLimiter;
  readonly clock: () => Date;
  readonly timing?: Partial<GatewayTiming>;
  readonly limits?: Partial<GatewayLimits>;
  readonly connectRateLimit?: ConnectRateLimit;
  /** p7-rate-limit: concurrent worker sockets per IP / total (default CONNECTION_CAPS.workerSocket). */
  readonly connectionCaps?: ConnectionCapRule;
  /** p7-rate-limit: established sessions per worker id (default WORKER_LIMITS.sessionsPerWorker). */
  readonly sessionRateLimit?: WindowRule;
  readonly supportedVersions?: readonly ProtocolVersion[];
  readonly leaseKeys?: () => readonly LeaseKey[];
  /** p19-ide W2: STREAM_* plane per session (ADR-0066). */
  readonly streams?: StreamSinkFactory;
}

/**
 * `GET /v1/worker` — the worker WebSocket endpoint (ADR-0005, p2-transport).
 *
 * Not behind the human session (route auth level `device`): the device
 * authenticates in-band with its Ed25519 key. Before that, only HELLO and AUTH
 * are accepted (WorkerConnection). Upgrades are rate limited per IP before the
 * handshake; frames are capped at `MAX_FRAME_BYTES` by the WebSocket layer and
 * compression is disabled. Plain HTTP requests get 426.
 */
export function workerGatewayRoutes(deps: WorkerGatewayDeps) {
  const timing: GatewayTiming = { ...DEFAULT_GATEWAY_TIMING, ...deps.timing };
  const limits: GatewayLimits = { ...DEFAULT_GATEWAY_LIMITS, ...deps.limits };
  const connectLimit = deps.connectRateLimit ?? DEFAULT_CONNECT_RATE_LIMIT;
  const sockets = new ConnectionCaps(deps.connectionCaps ?? CONNECTION_CAPS.workerSocket);
  const sessionLimit = deps.sessionRateLimit ?? WORKER_LIMITS.sessionsPerWorker;
  const host: ConnectionHost = {
    directory: deps.directory,
    handler: deps.handler,
    audit: deps.audit,
    clock: deps.clock,
    timing,
    limits,
    supportedVersions: deps.supportedVersions ?? SUPPORTED_PROTOCOL_VERSIONS,
    ...(deps.leaseKeys === undefined ? {} : { leaseKeys: deps.leaseKeys }),
    ...(deps.streams === undefined ? {} : { streams: deps.streams }),
    admitSession: async (workerId) =>
      (await deps.limiter.hit('worker-session', workerId, sessionLimit.max, sessionLimit.windowMs)).allowed,
    attach: (workerId, connection) => {
      deps.hub.attach(workerId, connection);
    },
    detach: (workerId, connection) => {
      deps.hub.detach(workerId, connection);
    },
  };

  return async (app: FastifyInstance): Promise<void> => {
    await app.register(websocket, {
      // Close worker sockets with 1001 (and an orderly session end) before the HTTP server drains.
      preClose: async () => {
        await deps.hub.closeAll();
      },
      options: {
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
        // Text JSON only; UTF-8 validation stays on (default).
      },
    });

    app.route({
      method: 'GET',
      url: WORKER_ENDPOINT,
      exposeHeadRoute: false,
      config: { auth: 'device' },
      schema: { hide: true },
      preValidation: async (request) => {
        const r = await deps.limiter.hit(
          'worker-connect',
          request.ip,
          connectLimit.perIp,
          connectLimit.windowMs,
        );
        if (!r.allowed) {
          throw new HttpError(
            429,
            'rate_limited',
            'Too many connection attempts.',
            {
              'retry-after': String(Math.ceil(r.retryAfterMs / 1000)),
            },
            {},
            { reason: 'connections' },
          );
        }
      },
      handler: async (_request, reply) =>
        reply
          .code(426)
          .header('upgrade', 'websocket')
          .send({ error: 'upgrade_required', message: 'This endpoint only accepts WebSocket connections.' }),
      wsHandler: (socket, request) => {
        // p7-rate-limit: concurrent sockets per client IP (several workers may share a home NAT) and total.
        const slot = sockets.tryAcquire(request.ip);
        if (slot === null) {
          request.log.warn({ ip: request.ip }, 'worker socket refused: connection cap');
          socket.close(CloseCode.rateLimited, 'too many connections');
          return;
        }
        socket.once('close', slot);
        const connection = new WorkerConnection(socket, request.ip, host, request.log);
        deps.hub.track(connection);
        socket.once('close', () => {
          deps.hub.untrack(connection);
        });
      },
    });
  };
}
