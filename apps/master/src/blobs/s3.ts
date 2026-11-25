import { createHash } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import { presignUrl, signRequest, type SigV4Credentials, UNSIGNED_PAYLOAD } from './sigv4.js';

/**
 * p17-object-storage: the few S3 calls the master makes against an S3-compatible bucket (AWS S3, Cloudflare R2,
 * MinIO) — PutObject, GetObject (whole / range / stream), HeadObject, DeleteObject, multipart (create, complete,
 * abort) — and the presigned URLs it hands out (PUT of one key with a bound size, GET with a forced
 * content-disposition). TLS is verified (never configurable); redirects are not followed; every call has a timeout.
 */

export type S3Provider = 'aws' | 'r2' | 'minio' | 'other';

export interface S3Config {
  readonly provider: S3Provider;
  /** `https://…` (R2: `https://<account>.r2.cloudflarestorage.com`; MinIO: its URL). Empty for AWS (derived). */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  /** Path-style addressing (`endpoint/bucket/key`); virtual-hosted (`bucket.endpoint/key`) otherwise. */
  readonly pathStyle: boolean;
  /** Key prefix inside the bucket (no leading `/`, ends with `/` when set). */
  readonly prefix: string;
  /** Server-side encryption: none, SSE-S3 (AES256) or SSE-KMS with a key id. */
  readonly sse: 'none' | 'AES256' | 'aws:kms';
  readonly kmsKeyId: string;
}

export class S3Error extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

export interface S3ClientOptions {
  readonly config: S3Config;
  readonly credentials: SigV4Credentials;
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
  /** Tests: extra CA for a local TLS endpoint. */
  readonly ca?: string | Buffer;
}

/** The endpoint origin for a configuration (AWS derives it from the region). */
export function endpointOf(c: Pick<S3Config, 'endpoint' | 'region' | 'provider'>): URL {
  if (c.endpoint.trim() !== '') return new URL(c.endpoint.trim().replace(/\/+$/, ''));
  if (c.provider === 'aws') return new URL(`https://s3.${c.region}.amazonaws.com`);
  throw new S3Error('InvalidEndpoint', null, 'an endpoint is required for this provider');
}

/** `bucket/prefix` — what `blob_objects.store_ref` records for an S3 blob (no credentials, no query). */
export function storeRefOf(c: S3Config): string {
  const e = endpointOf(c);
  return `${e.host}/${c.bucket}/${c.prefix}`.slice(0, 600);
}

const XML_ERROR = /<Code>([^<]{1,100})<\/Code>/;

function xmlValue(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m?.[1] ?? null;
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

export class S3Client {
  readonly #c: S3Config;
  readonly #creds: SigV4Credentials;
  readonly #clock: () => Date;
  readonly #timeoutMs: number;
  readonly #ca: string | Buffer | undefined;
  readonly #endpoint: URL;

  constructor(opts: S3ClientOptions) {
    this.#c = opts.config;
    this.#creds = opts.credentials;
    this.#clock = opts.clock ?? (() => new Date());
    this.#timeoutMs = opts.timeoutMs ?? 60_000;
    this.#ca = opts.ca;
    this.#endpoint = endpointOf(opts.config);
    if (this.#endpoint.protocol !== 'https:' && !isLoopback(this.#endpoint.hostname)) {
      throw new S3Error('InvalidEndpoint', null, 'the endpoint must use https (http only on this machine)');
    }
  }

  get config(): S3Config {
    return this.#c;
  }

  /** The object URL of a key (with the configured prefix). */
  objectUrl(key: string, query: Readonly<Record<string, string>> = {}): URL {
    const full = `${this.#c.prefix}${key}`;
    const encodedKey = full
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    const u = new URL(this.#endpoint.toString());
    if (this.#c.pathStyle) u.pathname = `/${this.#c.bucket}/${encodedKey}`;
    else {
      u.hostname = `${this.#c.bucket}.${u.hostname}`;
      u.pathname = `/${encodedKey}`;
    }
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  #sseHeaders(): Record<string, string> {
    if (this.#c.sse === 'AES256') return { 'x-amz-server-side-encryption': 'AES256' };
    if (this.#c.sse === 'aws:kms') {
      return {
        'x-amz-server-side-encryption': 'aws:kms',
        ...(this.#c.kmsKeyId === ''
          ? {}
          : { 'x-amz-server-side-encryption-aws-kms-key-id': this.#c.kmsKeyId }),
      };
    }
    return {};
  }

  async #send(
    method: string,
    url: URL,
    opts: {
      readonly headers?: Record<string, string>;
      readonly body?: Buffer | Readable;
      readonly payloadHash?: string;
      readonly stream?: boolean;
      /** A streamed body's length (S3 refuses a chunked PutObject without one). */
      readonly contentLength?: number;
    } = {},
  ): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
    res?: http.IncomingMessage;
  }> {
    const body = opts.body;
    const payloadHash =
      opts.payloadHash ??
      (body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? createHash('sha256').update(body).digest('hex')
          : UNSIGNED_PAYLOAD);
    const headers = signRequest(
      {
        method,
        url,
        headers: opts.headers ?? {},
        ...(payloadHash === undefined ? {} : { payloadHash }),
      },
      this.#creds,
      this.#c.region,
      this.#clock(),
    );
    if (Buffer.isBuffer(body)) headers['content-length'] = String(body.length);
    else if (opts.contentLength !== undefined) headers['content-length'] = String(opts.contentLength);
    return new Promise((resolve, reject) => {
      const onResponse = (res: http.IncomingMessage): void => {
        const status = res.statusCode ?? 0;
        if (opts.stream === true && status >= 200 && status < 300) {
          resolve({ status, headers: res.headers, body: Buffer.alloc(0), res });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          // Error / XML bodies are small; never buffer an unexpected large body.
          if (size <= 1024 * 1024 || opts.stream !== true) chunks.push(c);
        });
        res.on('end', () => {
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      };
      const reqOpts: https.RequestOptions = { method, headers };
      const req =
        url.protocol === 'https:'
          ? https.request(
              url,
              {
                ...reqOpts,
                rejectUnauthorized: true,
                minVersion: 'TLSv1.2',
                ...(this.#ca === undefined ? {} : { ca: this.#ca }),
              },
              onResponse,
            )
          : http.request(url, reqOpts, onResponse);
      req.setTimeout(this.#timeoutMs, () => {
        req.destroy(new S3Error('Timeout', null, `${method} timed out`));
      });
      req.on('error', (err) => {
        reject(err instanceof S3Error ? err : new S3Error('NetworkError', null, err.message));
      });
      if (body === undefined) req.end();
      else if (Buffer.isBuffer(body)) req.end(body);
      else {
        // A failing source (a store read cut short) aborts the request instead of leaving it hanging.
        body.on('error', (err) => req.destroy(err));
        body.pipe(req);
      }
    });
  }

  #fail(op: string, status: number, body: Buffer): never {
    const code = XML_ERROR.exec(body.toString('utf8'))?.[1] ?? `HTTP${String(status)}`;
    throw new S3Error(code, status, `${op}: ${code} (HTTP ${String(status)})`);
  }

  async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    const r = await this.#send('PUT', this.objectUrl(key), {
      headers: { 'content-type': contentType, ...this.#sseHeaders() },
      body,
    });
    if (r.status !== 200) this.#fail('PutObject', r.status, r.body);
  }

  /** PutObject of a stream of exactly `size` bytes (blobs:migrate --to-store; unsigned payload, TLS-protected). */
  async putStream(
    key: string,
    body: Readable,
    size: number,
    contentType = 'application/octet-stream',
  ): Promise<void> {
    const r = await this.#send('PUT', this.objectUrl(key), {
      headers: { 'content-type': contentType, ...this.#sseHeaders() },
      body,
      contentLength: size,
    });
    if (r.status !== 200) this.#fail('PutObject', r.status, r.body);
  }

  async get(key: string, maxBytes: number): Promise<Buffer> {
    const r = await this.#send('GET', this.objectUrl(key), { stream: true });
    if (r.res === undefined) this.#fail('GetObject', r.status, r.body);
    const res = r.res;
    const declared = Number(res.headers['content-length'] ?? '0');
    if (declared > maxBytes) {
      res.destroy();
      throw new S3Error('TooLarge', 200, `object larger than ${String(maxBytes)} bytes`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of res as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > maxBytes) {
        res.destroy();
        throw new S3Error('TooLarge', 200, `object larger than ${String(maxBytes)} bytes`);
      }
      chunks.push(c);
    }
    return Buffer.concat(chunks, size);
  }

  /** A byte range (inclusive offsets as in HTTP) of an object. */
  async range(key: string, offset: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    const r = await this.#send('GET', this.objectUrl(key), {
      headers: { range: `bytes=${String(offset)}-${String(offset + length - 1)}` },
    });
    if (r.status === 416) return Buffer.alloc(0);
    if (r.status !== 206 && r.status !== 200) this.#fail('GetObject', r.status, r.body);
    return r.status === 200 ? r.body.subarray(offset, offset + length) : r.body;
  }

  /** The object as a stream (the caller consumes or destroys it). */
  async stream(key: string): Promise<{ stream: Readable; size: number }> {
    const r = await this.#send('GET', this.objectUrl(key), { stream: true });
    if (r.res === undefined) this.#fail('GetObject', r.status, r.body);
    return { stream: r.res, size: Number(r.res.headers['content-length'] ?? '0') };
  }

  async head(key: string): Promise<{ size: number; checksumSha256: string | null } | null> {
    const r = await this.#send('HEAD', this.objectUrl(key), {
      headers: { 'x-amz-checksum-mode': 'ENABLED' },
    });
    if (r.status === 404) return null;
    if (r.status !== 200) this.#fail('HeadObject', r.status, r.body);
    const sum = r.headers['x-amz-checksum-sha256'];
    return {
      size: Number(r.headers['content-length'] ?? '0'),
      checksumSha256: typeof sum === 'string' ? sum : null,
    };
  }

  async delete(key: string): Promise<void> {
    const r = await this.#send('DELETE', this.objectUrl(key));
    // 204 deleted (or never existed, S3 semantics); 404 from some providers for a missing key.
    if (r.status !== 204 && r.status !== 200 && r.status !== 404)
      this.#fail('DeleteObject', r.status, r.body);
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const r = await this.#send('POST', this.objectUrl(key, { uploads: '' }), {
      headers: { 'content-type': contentType, ...this.#sseHeaders() },
    });
    if (r.status !== 200) this.#fail('CreateMultipartUpload', r.status, r.body);
    const id = xmlValue(r.body.toString('utf8'), 'UploadId');
    if (id === null || id === '') throw new S3Error('InvalidResponse', r.status, 'no UploadId');
    return id;
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly { readonly n: number; readonly etag: string }[],
  ): Promise<void> {
    const xml =
      '<CompleteMultipartUpload>' +
      [...parts]
        .sort((a, b) => a.n - b.n)
        .map((p) => `<Part><PartNumber>${String(p.n)}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
        .join('') +
      '</CompleteMultipartUpload>';
    const r = await this.#send('POST', this.objectUrl(key, { uploadId }), {
      headers: { 'content-type': 'application/xml' },
      body: Buffer.from(xml, 'utf8'),
    });
    // S3 may answer 200 with an <Error> body when the completion failed late.
    if (r.status !== 200 || XML_ERROR.test(r.body.toString('utf8'))) {
      this.#fail('CompleteMultipartUpload', r.status, r.body);
    }
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const r = await this.#send('DELETE', this.objectUrl(key, { uploadId }));
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) {
      this.#fail('AbortMultipartUpload', r.status, r.body);
    }
  }

  /** Presigned PUT of one key: the client must send exactly `headers` (content-length bound, SSE, checksum). */
  presignPut(
    key: string,
    opts: {
      readonly sizeBytes: number;
      readonly contentType: string;
      readonly checksumSha256?: string;
      readonly expiresSeconds: number;
    },
  ): { url: string; headers: Record<string, string> } {
    const headers: Record<string, string> = {
      'content-length': String(opts.sizeBytes),
      'content-type': opts.contentType,
      ...this.#sseHeaders(),
      ...(opts.checksumSha256 === undefined ? {} : { 'x-amz-checksum-sha256': opts.checksumSha256 }),
    };
    const url = presignUrl(
      { method: 'PUT', url: this.objectUrl(key), headers },
      this.#creds,
      this.#c.region,
      this.#clock(),
      opts.expiresSeconds,
    );
    // content-length is set by the HTTP client itself; the worker sends the others as given.
    const { 'content-length': _len, ...send } = headers;
    return { url: url.toString(), headers: send };
  }

  /** Presigned UploadPart of a multipart upload (content-length bound). */
  presignPart(
    key: string,
    uploadId: string,
    n: number,
    sizeBytes: number,
    expiresSeconds: number,
  ): { url: string; headers: Record<string, string> } {
    const url = presignUrl(
      {
        method: 'PUT',
        url: this.objectUrl(key, { partNumber: String(n), uploadId }),
        headers: { 'content-length': String(sizeBytes) },
      },
      this.#creds,
      this.#c.region,
      this.#clock(),
      expiresSeconds,
    );
    return { url: url.toString(), headers: {} };
  }

  /** Presigned GET with a forced download name and type (the bucket stays private). */
  presignGet(
    key: string,
    opts: { readonly expiresSeconds: number; readonly disposition: string; readonly contentType: string },
  ): string {
    return presignUrl(
      {
        method: 'GET',
        url: this.objectUrl(key, {
          'response-content-disposition': opts.disposition,
          'response-content-type': opts.contentType,
        }),
      },
      this.#creds,
      this.#c.region,
      this.#clock(),
      opts.expiresSeconds,
    ).toString();
  }
}

export function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

/** Base64 of a hex SHA-256 (the `x-amz-checksum-sha256` form). */
export function sha256HexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

/** Reads a stream to its SHA-256 and size (bounded). */
export async function hashStream(
  stream: Readable,
  maxBytes: number,
): Promise<{ sha256: string; size: number; head: Buffer }> {
  const h = createHash('sha256');
  let size = 0;
  const head: Buffer[] = [];
  let headLen = 0;
  for await (const c of stream as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > maxBytes) {
      stream.destroy();
      throw new S3Error('TooLarge', null, `more than ${String(maxBytes)} bytes`);
    }
    if (headLen < 64) {
      head.push(c.subarray(0, 64 - headLen));
      headLen += Math.min(c.length, 64 - headLen);
    }
    h.update(c);
  }
  return { sha256: h.digest('hex'), size, head: Buffer.concat(head) };
}

/** Wraps a Buffer as a stream (tests, small puts). */
export function bufferStream(b: Buffer): Readable {
  return Readable.from([b]);
}
