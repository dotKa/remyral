// Off-site S3-compatible target (AWS S3, Cloudflare R2) for the backup runner (p10-backup-restore §3). AWS
// Signature Version 4 with the payload hash signed (`x-amz-content-sha256`, verified by the server) plus
// `Content-MD5`; full-object SHA-256 as `x-amz-meta-sha256`, re-read with HEAD after the upload. Never deletes.
import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, openSync, readSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { PREFIX_RE } from './naming.mjs';

export const SINGLE_PUT_MAX = 256 * 1024 * 1024;
export const PART_SIZE = 32 * 1024 * 1024;
export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it (S3: the path is encoded once, `/` kept). */
export function uriEncode(value, keepSlash) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, keepSlash ? '/' : '%2F');
}

export function amzDate(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Signs a request (pure). `headers` are the headers to send (lower-case names); `host` is added. Returns the full
 * header set including `authorization`, `x-amz-date` and `x-amz-content-sha256`.
 */
export function signV4({
  method,
  url,
  headers = {},
  payloadSha256,
  accessKeyId,
  secretAccessKey,
  region,
  date,
  service = 's3',
}) {
  const datetime = amzDate(date);
  const day = datetime.slice(0, 8);
  const all = { ...headers, host: url.host, 'x-amz-date': datetime, 'x-amz-content-sha256': payloadSha256 };
  const names = Object.keys(all)
    .map((n) => n.toLowerCase())
    .sort();
  const lower = Object.fromEntries(
    Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]),
  );
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)])
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const path = uriEncode(decodeURIComponent(url.pathname), true);
  const canonical = [
    method,
    path,
    query,
    names.map((n) => `${n}:${lower[n]}\n`).join(''),
    names.join(';'),
    payloadSha256,
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', datetime, scope, sha256Hex(canonical)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    ...lower,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    canonical,
  };
}

const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Parses `offsite.env` (KEY=VALUE lines, `#` comments, optional quotes). Values are never logged. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) throw new Error('offsite.env: every line must be KEY=VALUE');
    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, '')
      .trim();
    let value = line.slice(eq + 1).trim();
    if (!KEY_RE.test(key)) throw new Error(`offsite.env: invalid key ${key.slice(0, 40)}`);
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** Off-site configuration from `offsite.env` (AWS: region + bucket; R2: endpoint, region `auto`). */
export function parseOffsiteConfig(vars) {
  const need = (k) => {
    const v = vars[k];
    if (!v) throw new Error(`offsite.env: ${k} is required`);
    return v;
  };
  const bucket = need('BACKUP_S3_BUCKET');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw new Error('offsite.env: BACKUP_S3_BUCKET is not a valid bucket name');
  const region = vars.BACKUP_S3_REGION || (vars.BACKUP_S3_ENDPOINT ? 'auto' : '');
  if (!/^[a-z0-9-]{2,32}$/.test(region)) throw new Error('offsite.env: BACKUP_S3_REGION is required for AWS');
  let endpoint;
  if (vars.BACKUP_S3_ENDPOINT) {
    endpoint = new URL(vars.BACKUP_S3_ENDPOINT);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
    if (
      endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && (loopback || vars.BACKUP_S3_ALLOW_HTTP === 'test-only'))
    )
      throw new Error('offsite.env: BACKUP_S3_ENDPOINT must be https://');
    if (endpoint.pathname !== '/' || endpoint.search || endpoint.username)
      throw new Error('offsite.env: BACKUP_S3_ENDPOINT must be an origin');
  } else {
    endpoint = new URL(`https://s3.${region}.amazonaws.com`);
  }
  const pathStyle = vars.BACKUP_S3_FORCE_PATH_STYLE
    ? vars.BACKUP_S3_FORCE_PATH_STYLE === 'true'
    : Boolean(vars.BACKUP_S3_ENDPOINT) || bucket.includes('.');
  // Frozen (p17-remyral-rebrand): the key prefix of the off-site archive already written (and of the IAM policies in
  // infra/backup/aws); a new installation may set BACKUP_S3_PREFIX.
  const prefix = vars.BACKUP_S3_PREFIX || 'remana';
  if (!PREFIX_RE.test(prefix))
    throw new Error('offsite.env: BACKUP_S3_PREFIX may contain A-Z a-z 0-9 . _ - and /');
  return {
    bucket,
    region,
    endpoint,
    pathStyle,
    prefix,
    accessKeyId: need('BACKUP_S3_ACCESS_KEY_ID'),
    secretAccessKey: need('BACKUP_S3_SECRET_ACCESS_KEY'),
    /** For status/console: where, without credentials. */
    describe: `s3://${bucket}/${prefix}/ @ ${endpoint.host}`,
  };
}

export class S3Error extends Error {
  constructor(op, status, code) {
    super(`S3 ${op} failed: HTTP ${String(status)}${code ? ` ${code}` : ''}`);
    this.name = 'S3Error';
    this.status = status;
  }
}

/** Extracts `<Tag>value</Tag>` from a small S3 XML response. */
export function xmlValue(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null;
}

export class S3Target {
  constructor(cfg, { now = () => new Date(), singlePutMax = SINGLE_PUT_MAX, partSize = PART_SIZE } = {}) {
    this.cfg = cfg;
    this.now = now;
    this.singlePutMax = singlePutMax;
    this.partSize = partSize;
  }

  url(key, query = {}) {
    const { endpoint, bucket, pathStyle } = this.cfg;
    const path = `/${pathStyle ? `${bucket}/` : ''}${key
      .split('/')
      .map((s) => uriEncode(s, false))
      .join('/')}`;
    const u = new URL(
      `${endpoint.protocol}//${pathStyle ? endpoint.host : `${bucket}.${endpoint.host}`}${path}`,
    );
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  /** One signed request. `body`: Buffer | () => Readable (with `length`). Resolves { status, headers, text }. */
  request(op, method, url, { headers = {}, body = null, length = 0, payloadSha256 = EMPTY_SHA256 } = {}) {
    const signed = signV4({
      method,
      url,
      headers,
      payloadSha256,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      region: this.cfg.region,
      date: this.now(),
    });
    delete signed.canonical;
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        { method, headers: { ...signed, 'content-length': String(length) }, timeout: 600_000 },
        (res) => {
          const chunks = [];
          res.on('data', (d) => {
            if (chunks.length < 64) chunks.push(d);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) resolve({ status, headers: res.headers, text });
            else reject(new S3Error(op, status, xmlValue(text, 'Code')));
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`S3 ${op} timed out`)));
      req.on('error', (e) => reject(new Error(`S3 ${op} failed: ${e.code ?? e.message}`)));
      if (body === null) req.end();
      else if (Buffer.isBuffer(body)) req.end(body);
      else
        body()
          .on('error', (e) => req.destroy(e))
          .pipe(req);
    });
  }

  async head(key) {
    const r = await this.request('HEAD', 'HEAD', this.url(key));
    return { bytes: Number(r.headers['content-length']), sha256: r.headers['x-amz-meta-sha256'] ?? null };
  }

  /**
   * Uploads a local file under `key` and verifies it with HEAD. `sha256`: hex SHA-256 of the whole file (stored as
   * metadata). Files above SINGLE_PUT_MAX go multipart (aborted on failure).
   */
  async putFile(key, path, { bytes, sha256, contentType = 'application/octet-stream' }) {
    const meta = { 'x-amz-meta-sha256': sha256, 'content-type': contentType };
    if (bytes <= this.singlePutMax) {
      const md5 = await md5Base64(path);
      await this.request('PutObject', 'PUT', this.url(key), {
        headers: { ...meta, 'content-md5': md5 },
        body: () => createReadStream(path),
        length: bytes,
        payloadSha256: sha256,
      });
    } else {
      await this.multipart(key, path, bytes, meta);
    }
    const h = await this.head(key);
    if (h.bytes !== bytes || h.sha256 !== sha256) {
      throw new Error(
        `S3 verification failed for ${key}: size ${String(h.bytes)}/${String(bytes)}, sha256 ${h.sha256 === sha256 ? 'ok' : 'differs'}`,
      );
    }
    return { key, bytes, sha256 };
  }

  async putBuffer(key, buf, contentType) {
    const sha256 = sha256Hex(buf);
    await this.request('PutObject', 'PUT', this.url(key), {
      headers: {
        'x-amz-meta-sha256': sha256,
        'content-type': contentType,
        'content-md5': createHash('md5').update(buf).digest('base64'),
      },
      body: buf,
      length: buf.length,
      payloadSha256: sha256,
    });
    const h = await this.head(key);
    if (h.bytes !== buf.length || h.sha256 !== sha256) throw new Error(`S3 verification failed for ${key}`);
    return { key, bytes: buf.length, sha256 };
  }

  /**
   * p11-master-resilience (standby restore, read side): every key under `prefix` (ListObjectsV2, all pages). Needs
   * `s3:ListBucket` — the owner's read principal, not the server's upload-only token.
   */
  async list(prefix) {
    const keys = [];
    let token = null;
    for (let page = 0; page < 10_000; page += 1) {
      const query = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
      const base = this.url('', query);
      // The bucket root: `url('')` ends in `/` (path style: `/<bucket>/`).
      const r = await this.request('ListObjectsV2', 'GET', base);
      for (const m of r.text.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, '&'));
      if (xmlValue(r.text, 'IsTruncated') !== 'true') return keys;
      token = xmlValue(r.text, 'NextContinuationToken');
      if (!token) return keys;
    }
    throw new Error('S3 ListObjectsV2: too many pages');
  }

  /** Downloads `key` into `path` (streamed). Resolves `{ bytes, sha256, metaSha256 }` (metaSha256: x-amz-meta-sha256). */
  getToFile(key, path) {
    const url = this.url(key);
    const signed = signV4({
      method: 'GET',
      url,
      headers: {},
      payloadSha256: EMPTY_SHA256,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      region: this.cfg.region,
      date: this.now(),
    });
    delete signed.canonical;
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method: 'GET', headers: signed, timeout: 600_000 }, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new S3Error('GetObject', status, null));
          return;
        }
        const hash = createHash('sha256');
        let bytes = 0;
        const out = createWriteStream(path, { mode: 0o600 });
        res.on('data', (d) => {
          hash.update(d);
          bytes += d.length;
        });
        res.pipe(out);
        out.on('finish', () =>
          resolve({
            bytes,
            sha256: hash.digest('hex'),
            metaSha256: res.headers['x-amz-meta-sha256'] ?? null,
          }),
        );
        out.on('error', reject);
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('S3 GetObject timed out')));
      req.on('error', (e) => reject(new Error(`S3 GetObject failed: ${e.code ?? e.message}`)));
      req.end();
    });
  }

  async multipart(key, path, bytes, meta) {
    const created = await this.request('CreateMultipartUpload', 'POST', this.url(key, { uploads: '' }), {
      headers: meta,
    });
    const uploadId = xmlValue(created.text, 'UploadId');
    if (!uploadId) throw new Error('S3 CreateMultipartUpload returned no UploadId');
    const parts = [];
    const fd = openSync(path, 'r');
    try {
      for (let n = 1, offset = 0; offset < bytes; n += 1, offset += this.partSize) {
        const len = Math.min(this.partSize, bytes - offset);
        const buf = Buffer.alloc(len);
        let read = 0;
        while (read < len) {
          const r = readSync(fd, buf, read, len - read, offset + read);
          if (r === 0) throw new Error('file shrank during upload');
          read += r;
        }
        const res = await this.request(
          'UploadPart',
          'PUT',
          this.url(key, { partNumber: String(n), uploadId }),
          {
            headers: { 'content-md5': createHash('md5').update(buf).digest('base64') },
            body: buf,
            length: len,
            payloadSha256: sha256Hex(buf),
          },
        );
        const etag = res.headers.etag;
        if (typeof etag !== 'string') throw new Error('S3 UploadPart returned no ETag');
        parts.push({ n, etag });
      }
      const xml = Buffer.from(
        `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${String(p.n)}</PartNumber><ETag>${p.etag.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`,
        'utf8',
      );
      const done = await this.request('CompleteMultipartUpload', 'POST', this.url(key, { uploadId }), {
        headers: { 'content-type': 'application/xml' },
        body: xml,
        length: xml.length,
        payloadSha256: sha256Hex(xml),
      });
      // S3 can answer 200 with an <Error> body for CompleteMultipartUpload.
      if (xmlValue(done.text, 'Code'))
        throw new S3Error('CompleteMultipartUpload', 200, xmlValue(done.text, 'Code'));
    } catch (err) {
      await this.request('AbortMultipartUpload', 'DELETE', this.url(key, { uploadId })).catch(
        () => undefined,
      );
      throw err;
    } finally {
      closeSync(fd);
    }
  }
}

async function md5Base64(path) {
  const h = createHash('md5');
  await new Promise((resolve, reject) => {
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', resolve);
  });
  return h.digest('base64');
}
