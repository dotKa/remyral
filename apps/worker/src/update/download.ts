import * as http from 'node:http';
import * as https from 'node:https';

/** Fetches `path` on the master origin with the worker-scoped download token; at most `maxBytes`. */
export type Downloader = (path: string, token: string, maxBytes: number) => Promise<Buffer>;

export class DownloadError extends Error {
  constructor(
    readonly reason: 'http_status' | 'too_large' | 'network' | 'timeout' | 'bad_url',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface HttpsDownloaderOptions {
  /** The worker's `masterUrl` (wss://host/v1/worker; ws:// only for loopback, enforced by the config). */
  readonly masterUrl: string;
  readonly workerVersion: string;
  /** Extra trusted CA (tests); production uses the default trust store, like the WebSocket transport. */
  readonly ca?: string | Buffer;
  readonly timeoutMs?: number;
  /**
   * Path prefixes this downloader may fetch (default: the release endpoint). p19-ide W3 uses one for
   * `/v1/worker/ide/` (VSIX blobs and settings of an IDE start, with that start's token).
   */
  readonly pathPrefixes?: readonly string[];
}

/** `wss://host:port/...` → `https://host:port`; `ws://` → `http://` (loopback dev only). */
export function masterOrigin(masterUrl: string): URL {
  const url = new URL(masterUrl);
  if (url.protocol === 'wss:' || url.protocol === 'https:') return new URL(`https://${url.host}`);
  if (url.protocol === 'ws:' || url.protocol === 'http:') return new URL(`http://${url.host}`);
  throw new DownloadError('bad_url', `unsupported master URL scheme ${url.protocol}`);
}

/**
 * Downloads over the same authenticated origin as the worker WebSocket: TLS 1.3 with certificate
 * verification (never configurable), no redirects (a 3xx is an error), no compression, a hard size
 * cap enforced while streaming and an overall timeout. The bearer token is single-worker,
 * single-release and short-lived; integrity does not depend on it (the release signature does).
 */
export function httpsDownloader(opts: HttpsDownloaderOptions): Downloader {
  const origin = masterOrigin(opts.masterUrl);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const prefixes = opts.pathPrefixes ?? ['/v1/worker/releases/'];
  return (path, token, maxBytes) =>
    new Promise<Buffer>((resolve, reject) => {
      if (!prefixes.some((p) => path.startsWith(p)) || path.includes('..')) {
        reject(new DownloadError('bad_url', 'download path outside the allowed endpoint'));
        return;
      }
      const url = new URL(path, origin);
      if (url.origin !== origin.origin) {
        reject(new DownloadError('bad_url', 'download URL leaves the master origin'));
        return;
      }
      const headers = {
        authorization: `Bearer ${token}`,
        'user-agent': `remyral-worker/${opts.workerVersion}`,
        'accept-encoding': 'identity',
      };
      const onResponse = (res: http.IncomingMessage) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new DownloadError('http_status', `HTTP ${String(res.statusCode)} for ${path}`, res.statusCode),
          );
          return;
        }
        const declared = Number(res.headers['content-length'] ?? '0');
        if (declared > maxBytes) {
          res.destroy();
          reject(new DownloadError('too_large', `${path} is larger than ${String(maxBytes)} bytes`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new DownloadError('too_large', `${path} is larger than ${String(maxBytes)} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve(Buffer.concat(chunks, size));
        });
        res.on('error', (error) => {
          reject(new DownloadError('network', error.message));
        });
      };
      const req =
        url.protocol === 'https:'
          ? https.request(
              url,
              {
                method: 'GET',
                headers,
                rejectUnauthorized: true,
                minVersion: 'TLSv1.3',
                ...(opts.ca === undefined ? {} : { ca: opts.ca }),
              },
              onResponse,
            )
          : http.request(url, { method: 'GET', headers }, onResponse);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new DownloadError('timeout', `download of ${path} timed out`));
      });
      req.on('error', (error) => {
        reject(error instanceof DownloadError ? error : new DownloadError('network', error.message));
      });
      req.end();
    });
}
