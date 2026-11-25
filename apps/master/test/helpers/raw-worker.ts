import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { MasterToWorker, parseFrame } from '@remyral/protocol';
import { challengePayload, publicKeyFingerprint } from '@remyral/protocol/auth';
import WebSocket from 'ws';

export const FACTS = {
  os: 'darwin',
  osVersion: '26.0',
  arch: 'arm64',
  hostname: 'raw-test',
  cpuCount: 8,
  memoryBytes: 16 * 1024 ** 3,
  diskFreeBytes: 100 * 1024 ** 3,
} as const;

/** What the raw client needs from a key (TestKey here, or the worker's DeviceKey). */
export interface SigningKey {
  readonly publicKey: string;
  readonly fingerprint: string;
  signChallenge(nonce: string): string;
}

export class TestKey implements SigningKey {
  readonly privateKey: KeyObject;
  readonly publicKey: string;
  constructor() {
    const pair = generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey;
    this.publicKey = String(pair.publicKey.export({ format: 'jwk' }).x);
  }
  get fingerprint(): string {
    return publicKeyFingerprint(this.publicKey);
  }
  signChallenge(nonce: string): string {
    return sign(null, challengePayload(nonce), this.privateKey).toString('base64url');
  }
}

export interface Closed {
  code: number;
  reason: string;
}

/**
 * A hand-driven protocol client for hostile/edge-case tests of the master
 * gateway: every frame is explicit, nothing is retried.
 */
export class RawWorker {
  readonly received: MasterToWorker[] = [];
  readonly closed: Promise<Closed>;
  readonly key: SigningKey;
  #waiters: { type: string | undefined; resolve: (m: MasterToWorker) => void }[] = [];
  #closeInfo: Closed | null = null;

  private constructor(
    readonly ws: WebSocket,
    key: SigningKey,
  ) {
    this.key = key;
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.#closeInfo = { code, reason: reason.toString('utf8') };
        resolve(this.#closeInfo);
      });
    });
    ws.on('message', (data) => {
      const parsed = parseFrame(MasterToWorker, Buffer.from(data as Buffer).toString('utf8'));
      if (!parsed.ok) throw new Error(`master sent an invalid frame: ${parsed.error}`);
      this.received.push(parsed.message);
      const i = this.#waiters.findIndex((w) => w.type === undefined || w.type === parsed.message.type);
      if (i >= 0) {
        const [w] = this.#waiters.splice(i, 1);
        w?.resolve(parsed.message);
      }
    });
  }

  static connect(baseUrl: string, key: SigningKey = new TestKey()): Promise<RawWorker> {
    const ws = new WebSocket(`${baseUrl}/v1/worker`, { perMessageDeflate: false });
    const worker = new RawWorker(ws, key);
    return new Promise((resolve, reject) => {
      ws.once('open', () => {
        resolve(worker);
      });
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => {
        reject(new Error(`HTTP ${String(res.statusCode)}`));
      });
    });
  }

  get isClosed(): boolean {
    return this.#closeInfo !== null;
  }

  /** Next message of `type` (already received ones count, in order). */
  next<T extends MasterToWorker['type']>(
    type?: T,
    timeoutMs = 5_000,
  ): Promise<Extract<MasterToWorker, { type: T }>> {
    const seen = this.received.findIndex((m) => type === undefined || m.type === type);
    if (seen >= 0) {
      const [m] = this.received.splice(seen, 1);
      return Promise.resolve(m as Extract<MasterToWorker, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${type ?? 'any message'}`));
      }, timeoutMs);
      this.#waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(timer);
          const idx = this.received.indexOf(m);
          if (idx >= 0) this.received.splice(idx, 1);
          resolve(m as Extract<MasterToWorker, { type: T }>);
        },
      });
    });
  }

  sendJson(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  envelope(type: string, payload: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      protocolVersion: '1.0',
      type,
      messageId: randomUUID(),
      seq: 0,
      ts: new Date().toISOString(),
      correlationId: 'raw-test',
      payload,
      ...extra,
    };
  }

  hello(
    opts: {
      pairingCode?: string;
      versions?: string[];
      resumeFromSeq?: number;
      instanceId?: string;
      pairOnly?: boolean;
    } = {},
  ): void {
    this.sendJson(
      this.envelope('HELLO', {
        supportedVersions: opts.versions ?? ['1.0'],
        workerVersion: '0.1.0-test',
        publicKey: this.key.publicKey,
        ...(opts.pairingCode === undefined ? {} : { pairingCode: opts.pairingCode }),
        resumeFromSeq: opts.resumeFromSeq ?? 0,
        facts: FACTS,
        ...(opts.instanceId === undefined ? {} : { instanceId: opts.instanceId }),
        ...(opts.pairOnly === undefined ? {} : { pairOnly: opts.pairOnly }),
      }),
    );
  }

  auth(nonce: string, signature = this.key.signChallenge(nonce)): void {
    this.sendJson(this.envelope('AUTH', { nonce, signature }));
  }

  /** HELLO → CHALLENGE → AUTH; returns the master's answer (SESSION_ESTABLISHED, ENROLL_PENDING or ERROR). */
  async handshake(
    opts: { pairingCode?: string; resumeFromSeq?: number; instanceId?: string; pairOnly?: boolean } = {},
  ): Promise<MasterToWorker> {
    this.hello(opts);
    const challenge = await this.next('CHALLENGE');
    this.auth(challenge.payload.nonce);
    return this.next(undefined);
  }

  close(): void {
    this.ws.close();
  }
}
