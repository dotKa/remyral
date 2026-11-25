import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IdeRelPath } from '@remyral/protocol';
import type { Logger } from '@remyral/observability';

/**
 * p19-ide W2: the loopback endpoint the bridge extension (bridge-extension.ts) calls from inside an IDE workspace —
 * `POST http://127.0.0.1:<port>/ide/<workspaceId>/{reference|push|terminal}` with `Authorization: Bearer <token>`.
 *
 * - One random token per workspace start, handed to the IDE process in its environment only (secret env of the
 *   sandbox launch: redacted from logs). The token can do exactly what the workspace owner can already do in the IDE:
 *   add a chat reference, ask the daemon to commit + push the workspace branch, report a terminal. On Linux host
 *   profiles another local process of the worker user could read it from the IDE's environment — the residual of host
 *   execution without filesystem confinement (ADR-0007, p19-ide §11); the master re-authorizes the owner on every push.
 * - Bodies are JSON, ≤ 16 KiB (a settings save ≤ 640 KiB: one file ≤ 256 KiB, JSON-escaped), validated; at most 5
 *   calls per second per workspace (burst 20).
 * - The worker answers a push or a settings save only after the master did (IDE_NOTICE).
 * - p19-ide W3: `GET …/settings` hands the bridge v2 the user's synced settings fetched at start (or `sync: false`);
 *   `POST …/settings {file, content}` saves one file through the master (secret-scanned there).
 */

export interface BridgeAnswer {
  readonly status: 'ok' | 'refused' | 'failed';
  readonly message: string;
  readonly url?: string;
}

export interface BridgeHandler {
  reference(
    workspaceId: string,
    r: { path: string; startLine: number; endLine: number },
  ): Promise<BridgeAnswer>;
  push(workspaceId: string, r: { message: string; pullRequest: boolean }): Promise<BridgeAnswer>;
  terminal(workspaceId: string, r: { name: string }): Promise<BridgeAnswer>;
  /** W3: the synced settings of this start (`sync: false` when the master sent none). */
  settings?(workspaceId: string): Promise<BridgeSettings>;
  /** W3: saves one settings file through the master. */
  saveSettings?(
    workspaceId: string,
    r: { file: 'settings' | 'keybindings'; content: string },
  ): Promise<BridgeAnswer>;
}

export interface BridgeSettings {
  readonly sync: boolean;
  readonly settings: string | null;
  readonly keybindings: string | null;
}

interface Entry {
  readonly token: Buffer;
  tokens: number;
  at: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY = 16 * 1024;
const MAX_SETTINGS_BODY = 640 * 1024;
const SETTINGS_MAX_BYTES = 256 * 1024;

export class IdeBridgeServer {
  readonly #handler: BridgeHandler;
  readonly #log: Logger;
  readonly #entries = new Map<string, Entry>();
  #server: Server | null = null;
  #port: number | null = null;

  constructor(handler: BridgeHandler, logger: Logger) {
    this.#handler = handler;
    this.#log = logger.child({ component: 'ide-bridge' });
  }

  /** Listens on 127.0.0.1 (ephemeral port) once; returns the port. */
  async start(): Promise<number> {
    if (this.#port !== null) return this.#port;
    const server = createServer({ maxHeaderSize: 8 * 1024, requestTimeout: 200_000 }, (req, res) => {
      void this.#handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.unref();
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
    return this.#port;
  }

  /** A fresh token for a workspace start (replaces the previous one). */
  register(workspaceId: string): { url: string; token: string } {
    if (this.#port === null) throw new Error('bridge not started');
    const token = randomBytes(32).toString('base64url');
    this.#entries.set(workspaceId, { token: Buffer.from(token), tokens: 20, at: Date.now() });
    return { url: `http://127.0.0.1:${String(this.#port)}/ide/${workspaceId}`, token };
  }

  unregister(workspaceId: string): void {
    this.#entries.delete(workspaceId);
  }

  async close(): Promise<void> {
    this.#entries.clear();
    const s = this.#server;
    this.#server = null;
    this.#port = null;
    if (s !== null)
      await new Promise<void>((resolve) =>
        s.close(() => {
          resolve();
        }),
      );
  }

  #send(res: ServerResponse, status: number, body: BridgeAnswer | BridgeSettings): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/ide\/([0-9a-f-]{36})\/(reference|push|terminal|settings)$/.exec(req.url ?? '');
    const id = m?.[1];
    const op = m?.[2];
    const methodOk = req.method === 'POST' || (req.method === 'GET' && op === 'settings');
    if (!methodOk || id === undefined || op === undefined || !UUID.test(id)) {
      req.resume();
      this.#send(res, 404, { status: 'refused', message: 'Bilinmeyen istek.' });
      return;
    }
    const entry = this.#entries.get(id);
    const auth = req.headers.authorization ?? '';
    const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (entry === undefined || given.length !== entry.token.length || !timingSafeEqual(given, entry.token)) {
      req.resume();
      this.#send(res, 401, { status: 'refused', message: 'Bu oturum için yetki yok.' });
      return;
    }
    const now = Date.now();
    entry.tokens = Math.min(20, entry.tokens + ((now - entry.at) / 1000) * 5);
    entry.at = now;
    if (entry.tokens < 1) {
      req.resume();
      this.#send(res, 429, { status: 'refused', message: 'Çok sık istek; biraz bekleyin.' });
      return;
    }
    entry.tokens -= 1;
    if (op === 'settings' && req.method === 'GET') {
      req.resume();
      const got = (await this.#handler.settings?.(id).catch(() => null)) ?? null;
      this.#send(res, 200, got ?? { sync: false, settings: null, keybindings: null });
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req, op === 'settings' ? MAX_SETTINGS_BODY : MAX_BODY);
    } catch {
      this.#send(res, 400, { status: 'refused', message: 'Geçersiz istek.' });
      return;
    }
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    try {
      let answer: BridgeAnswer;
      if (op === 'reference') {
        const path = IdeRelPath.safeParse(b.path);
        const start = Number(b.startLine);
        const end = Number(b.endLine);
        if (
          !path.success ||
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 1 ||
          end < start ||
          end > 1_000_000
        ) {
          this.#send(res, 400, { status: 'refused', message: 'Geçersiz satır aralığı.' });
          return;
        }
        answer = await this.#handler.reference(id, { path: path.data, startLine: start, endLine: end });
      } else if (op === 'push') {
        const message = typeof b.message === 'string' ? b.message.trim() : '';
        if (message.length === 0 || message.length > 2000) {
          this.#send(res, 400, { status: 'refused', message: 'Commit mesajı 1–2000 karakter olmalı.' });
          return;
        }
        answer = await this.#handler.push(id, { message, pullRequest: b.pullRequest === true });
      } else if (op === 'settings') {
        const file = b.file === 'settings' || b.file === 'keybindings' ? b.file : null;
        const content = typeof b.content === 'string' ? b.content : null;
        if (file === null || content === null || Buffer.byteLength(content, 'utf8') > SETTINGS_MAX_BYTES) {
          this.#send(res, 400, {
            status: 'refused',
            message: 'Ayar dosyası 256 KiB’den büyük ya da geçersiz.',
          });
          return;
        }
        answer =
          this.#handler.saveSettings === undefined
            ? { status: 'refused', message: 'Ayar eşitleme bu makinede yok.' }
            : await this.#handler.saveSettings(id, { file, content });
      } else {
        const name = typeof b.name === 'string' ? b.name.slice(0, 80) : '';
        answer = await this.#handler.terminal(id, { name });
      }
      this.#send(res, 200, answer);
    } catch (err) {
      this.#log.warn('bridge call failed', { op, err });
      this.#send(res, 200, { status: 'failed', message: 'İstek işlenemedi.' });
    }
  }
}

function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.destroy();
        reject(new Error('too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e instanceof Error ? e : new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}
