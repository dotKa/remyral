import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * p17-object-storage test helper: a small S3-compatible server (path-style, one bucket) that checks AWS Signature
 * Version 4 itself — header and query-string (presigned) authentication, signed headers such as `content-length` and
 * `x-amz-checksum-sha256`, the payload hash — and implements PutObject, GetObject (with Range), HeadObject,
 * DeleteObject and the multipart calls. The canonicalisation here is written separately from src/blobs/sigv4.ts.
 */

export interface FakeS3Options {
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region?: string;
}

interface Multipart {
  readonly key: string;
  readonly parts: Map<number, { data: Buffer; etag: string }>;
}

const enc = (s: string): string =>
  [...Buffer.from(s, 'utf8')]
    .map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9\-_.~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');

function hmac(key: Buffer | string, s: string): Buffer {
  return createHmac('sha256', key).update(s).digest();
}

export class FakeS3 {
  readonly objects = new Map<string, { data: Buffer; checksum: string | null; contentType: string | null }>();
  readonly uploads = new Map<string, Multipart>();
  readonly log: { method: string; path: string; status: number }[] = [];
  #server: Server | null = null;
  #url = '';
  /** Answer the next request with this status + S3 error code (fault injection). */
  failNext: { status: number; code: string } | null = null;

  constructor(readonly opts: FakeS3Options) {}

  get url(): string {
    return this.#url;
  }

  async start(): Promise<string> {
    this.#server = createServer((req, res) => {
      void this.#handle(req, res).catch((err: unknown) => {
        this.#error(res, 500, 'InternalError', err instanceof Error ? err.message : 'error');
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    const a = this.#server.address() as AddressInfo;
    this.#url = `http://127.0.0.1:${String(a.port)}`;
    return this.#url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.#server === null) resolve();
      else
        this.#server.close(() => {
          resolve();
        });
    });
  }

  #error(res: ServerResponse, status: number, code: string, message = code): void {
    res.statusCode = status;
    res.setHeader('content-type', 'application/xml');
    res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);
  }

  #verify(req: IncomingMessage, url: URL, body: Buffer): string | null {
    const q = url.searchParams;
    const presigned = q.has('X-Amz-Signature');
    let credential: string;
    let signedHeaders: string;
    let signature: string;
    let amzDate: string;
    let payloadHash: string;
    if (presigned) {
      credential = q.get('X-Amz-Credential') ?? '';
      signedHeaders = q.get('X-Amz-SignedHeaders') ?? '';
      signature = q.get('X-Amz-Signature') ?? '';
      amzDate = q.get('X-Amz-Date') ?? '';
      payloadHash = 'UNSIGNED-PAYLOAD';
    } else {
      const m = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
        req.headers.authorization ?? '',
      );
      if (m === null) return 'AccessDenied';
      credential = m[1] ?? '';
      signedHeaders = m[2] ?? '';
      signature = m[3] ?? '';
      amzDate = String(req.headers['x-amz-date'] ?? '');
      payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
      if (
        payloadHash !== 'UNSIGNED-PAYLOAD' &&
        createHash('sha256').update(body).digest('hex') !== payloadHash
      ) {
        return 'XAmzContentSHA256Mismatch';
      }
    }
    const [keyId, date, region, service] = credential.split('/');
    if (keyId !== this.opts.accessKeyId) return 'InvalidAccessKeyId';
    if (region !== (this.opts.region ?? 'us-east-1') || service !== 's3')
      return 'AuthorizationHeaderMalformed';
    const pairs: [string, string][] = [];
    for (const [k, v] of q) if (k !== 'X-Amz-Signature') pairs.push([enc(k), enc(v)]);
    pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
    const canonicalHeaders = signedHeaders
      .split(';')
      .map((h) => `${h}:${String(req.headers[h] ?? '').trim()}\n`)
      .join('');
    const path = decodeURIComponent(url.pathname)
      .split('/')
      .map((s) => enc(s))
      .join('/');
    const canonical = [
      req.method ?? '',
      path,
      pairs.map(([k, v]) => `${k}=${v}`).join('&'),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${date ?? ''}/${region}/s3/aws4_request`;
    const sts = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonical).digest('hex'),
    ].join('\n');
    const key = hmac(
      hmac(hmac(hmac(`AWS4${this.opts.secretAccessKey}`, date ?? ''), region), 's3'),
      'aws4_request',
    );
    const expected = createHmac('sha256', key).update(sts).digest('hex');
    if (expected !== signature) return 'SignatureDoesNotMatch';
    const checksum = req.headers['x-amz-checksum-sha256'];
    if (typeof checksum === 'string') {
      if (createHash('sha256').update(body).digest('base64') !== checksum) return 'BadDigest';
    }
    return null;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', this.#url);
    const done = (status: number): void => {
      this.log.push({ method: req.method ?? '', path: url.pathname, status });
    };
    if (this.failNext !== null) {
      const f = this.failNext;
      this.failNext = null;
      done(f.status);
      this.#error(res, f.status, f.code);
      return;
    }
    const bad = this.#verify(req, url, body);
    if (bad !== null) {
      done(bad === 'BadDigest' ? 400 : 403);
      this.#error(res, bad === 'BadDigest' ? 400 : 403, bad);
      return;
    }
    const segs = decodeURIComponent(url.pathname).replace(/^\//, '').split('/');
    if (segs[0] !== this.opts.bucket) {
      done(404);
      this.#error(res, 404, 'NoSuchBucket');
      return;
    }
    const key = segs.slice(1).join('/');
    const q = url.searchParams;
    const send = (
      status: number,
      payload: Buffer | string = '',
      headers: Record<string, string> = {},
    ): void => {
      done(status);
      res.statusCode = status;
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(payload);
    };
    switch (req.method) {
      case 'PUT': {
        const uploadId = q.get('uploadId');
        if (uploadId !== null) {
          const mp = this.uploads.get(uploadId);
          if (mp === undefined || mp.key !== key) {
            this.#error(res, 404, 'NoSuchUpload');
            return;
          }
          const etag = `"${createHash('md5').update(body).digest('hex')}"`;
          mp.parts.set(Number(q.get('partNumber')), { data: body, etag });
          send(200, '', { etag });
          return;
        }
        const checksum = req.headers['x-amz-checksum-sha256'];
        this.objects.set(key, {
          data: body,
          checksum: typeof checksum === 'string' ? checksum : null,
          contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null,
        });
        send(200, '', { etag: `"${createHash('md5').update(body).digest('hex')}"` });
        return;
      }
      case 'POST': {
        if (q.has('uploads')) {
          const id = randomUUID();
          this.uploads.set(id, { key, parts: new Map() });
          send(
            200,
            `<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>${this.opts.bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
          );
          return;
        }
        const uploadId = q.get('uploadId');
        const mp = uploadId === null ? undefined : this.uploads.get(uploadId);
        if (mp === undefined) {
          this.#error(res, 404, 'NoSuchUpload');
          return;
        }
        const listed = [
          ...body.toString('utf8').matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag>/g),
        ];
        const datas: Buffer[] = [];
        for (const m of listed) {
          const p = mp.parts.get(Number(m[1]));
          const etag = (m[2] ?? '').replace(/&#34;/g, '"');
          if (p?.etag !== etag) {
            this.#error(res, 400, 'InvalidPart');
            return;
          }
          datas.push(p.data);
        }
        this.objects.set(key, { data: Buffer.concat(datas), checksum: null, contentType: null });
        this.uploads.delete(uploadId ?? '');
        send(
          200,
          `<?xml version="1.0"?><CompleteMultipartUploadResult><Key>${key}</Key></CompleteMultipartUploadResult>`,
        );
        return;
      }
      case 'DELETE': {
        const uploadId = q.get('uploadId');
        if (uploadId !== null) this.uploads.delete(uploadId);
        else this.objects.delete(key);
        send(204);
        return;
      }
      case 'HEAD':
      case 'GET': {
        const o = this.objects.get(key);
        if (o === undefined) {
          done(404);
          if (req.method === 'HEAD') {
            res.statusCode = 404;
            res.end();
          } else this.#error(res, 404, 'NoSuchKey');
          return;
        }
        const headers: Record<string, string> = {
          'content-type': q.get('response-content-type') ?? o.contentType ?? 'application/octet-stream',
          ...(q.get('response-content-disposition') === null
            ? {}
            : { 'content-disposition': q.get('response-content-disposition') ?? '' }),
          ...(o.checksum === null || req.headers['x-amz-checksum-mode'] !== 'ENABLED'
            ? {}
            : { 'x-amz-checksum-sha256': o.checksum }),
        };
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
        if (range !== null && req.method === 'GET') {
          const from = Number(range[1]);
          const to = Math.min(Number(range[2]), o.data.length - 1);
          if (from >= o.data.length) {
            this.#error(res, 416, 'InvalidRange');
            return;
          }
          const part = o.data.subarray(from, to + 1);
          send(206, part, { ...headers, 'content-length': String(part.length) });
          return;
        }
        if (req.method === 'HEAD') {
          done(200);
          res.statusCode = 200;
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
          res.setHeader('content-length', String(o.data.length));
          res.end();
          return;
        }
        send(200, o.data, { ...headers, 'content-length': String(o.data.length) });
        return;
      }
      default:
        this.#error(res, 405, 'MethodNotAllowed');
    }
  }
}
