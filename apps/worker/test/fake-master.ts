import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { parseFrame, WorkerToMaster } from '@remyral/protocol';
import { WebSocketServer, type ServerOptions, type WebSocket } from 'ws';

/** A scripted master for transport unit tests: records frames, lets the test answer. */
export class FakeMaster {
  readonly wss: WebSocketServer;
  readonly sockets: WebSocket[] = [];
  readonly frames: { conn: number; message: WorkerToMaster }[] = [];
  readonly rawFrames: string[] = [];
  #waiters: {
    pred: (m: WorkerToMaster, conn: number) => boolean;
    resolve: (v: { message: WorkerToMaster; conn: number }) => void;
  }[] = [];
  #connWaiters: ((ws: WebSocket) => void)[] = [];
  #unconsumed: { conn: number; message: WorkerToMaster }[] = [];
  onConnection: ((ws: WebSocket, index: number) => void) | null = null;

  private constructor(options: ServerOptions) {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
    this.wss.on('connection', (ws) => {
      const index = this.sockets.length;
      this.sockets.push(ws);
      ws.on('message', (data) => {
        const text = Buffer.from(data as Buffer).toString('utf8');
        this.rawFrames.push(text);
        const parsed = parseFrame(WorkerToMaster, text);
        if (!parsed.ok) return;
        this.frames.push({ conn: index, message: parsed.message });
        const i = this.#waiters.findIndex((w) => w.pred(parsed.message, index));
        if (i >= 0) this.#waiters.splice(i, 1)[0]?.resolve({ message: parsed.message, conn: index });
        else this.#unconsumed.push({ conn: index, message: parsed.message });
      });
      this.onConnection?.(ws, index);
      for (const w of this.#connWaiters.splice(0)) w(ws);
    });
  }

  static async start(options: ServerOptions = {}): Promise<FakeMaster> {
    const m = new FakeMaster(options);
    await new Promise<void>((resolve) => m.wss.once('listening', resolve));
    return m;
  }

  get url(): string {
    return `ws://127.0.0.1:${String((this.wss.address() as AddressInfo).port)}`;
  }

  nextConnection(): Promise<WebSocket> {
    return new Promise((resolve) => this.#connWaiters.push(resolve));
  }

  /** Waits for the next matching frame (not yet consumed) from any connection. */
  waitFor<T extends WorkerToMaster['type']>(
    type: T,
    conn?: number,
    timeoutMs = 3_000,
  ): Promise<Extract<WorkerToMaster, { type: T }>> {
    const seen = this.#unconsumed.findIndex(
      (f) => f.message.type === type && (conn === undefined || f.conn === conn),
    );
    if (seen >= 0) {
      const [f] = this.#unconsumed.splice(seen, 1);
      return Promise.resolve(f?.message as Extract<WorkerToMaster, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      this.#waiters.push({
        pred: (m, c) => m.type === type && (conn === undefined || c === conn),
        resolve: ({ message }) => {
          clearTimeout(timer);
          resolve(message as Extract<WorkerToMaster, { type: T }>);
        },
      });
    });
  }

  send(ws: WebSocket, type: string, payload: unknown, extra: Record<string, unknown> = {}): void {
    ws.send(
      JSON.stringify({
        protocolVersion: '1.0',
        type,
        messageId: randomUUID(),
        seq: 0,
        ts: new Date().toISOString(),
        correlationId: 'fake-master',
        payload,
        ...extra,
      }),
    );
  }

  /** CHALLENGE → (AUTH) → SESSION_ESTABLISHED on `ws`; returns the AUTH frame. */
  async establish(
    ws: WebSocket,
    conn: number,
    opts: { workerId?: string; resumeFromSeq?: number; nonce?: string } = {},
  ): Promise<Extract<WorkerToMaster, { type: 'AUTH' }>> {
    await this.waitFor('HELLO', conn);
    const nonce = opts.nonce ?? `nonce-${randomUUID()}`;
    const authP = this.waitFor('AUTH', conn);
    this.send(ws, 'CHALLENGE', { nonce, expiresAt: new Date(Date.now() + 30_000).toISOString() });
    const auth = await authP;
    this.send(
      ws,
      'SESSION_ESTABLISHED',
      {
        negotiatedVersion: '1.0',
        sessionExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        ...(opts.resumeFromSeq === undefined ? {} : { resumeFromSeq: opts.resumeFromSeq }),
      },
      { workerId: opts.workerId ?? 'wrk_test' },
    );
    return auth;
  }

  async close(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        resolve();
      });
    });
  }
}
