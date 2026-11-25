import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, rename, rm, stat, statfs, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * p17-object-storage: the master's local-disk blob store (no object storage configured). One file per key below the
 * blob directory (a volume), files 0600 and directories 0700, written to a temporary name and renamed into place
 * after an fsync, so a reader never sees half a blob. Keys are validated (`blob_objects.key` grammar): no `..`, no
 * absolute paths, nothing outside the root.
 */

export const BLOB_KEY =
  /^(artifacts|inputs|site-uploads|releases|kits|chat-attachments|workflow-files|automation-files|input-uploads|ide-extensions)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,4}$/;

export class BlobKeyError extends Error {
  constructor(key: string) {
    super(`invalid blob key ${JSON.stringify(key.slice(0, 80))}`);
    this.name = 'BlobKeyError';
  }
}

export class BlobNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`blob ${key} not found`);
    this.name = 'BlobNotFoundError';
  }
}

export class LocalBlobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  path(key: string): string {
    if (!BLOB_KEY.test(key) || key.split('/').some((s) => s === '..' || s === '.'))
      throw new BlobKeyError(key);
    const p = resolve(this.root, ...key.split('/'));
    if (!p.startsWith(this.root + sep)) throw new BlobKeyError(key);
    return p;
  }

  async #prepare(key: string): Promise<{ final: string; temp: string }> {
    const final = this.path(key);
    await mkdir(dirname(final), { recursive: true, mode: 0o700 });
    return { final, temp: join(dirname(final), `.tmp-${randomBytes(8).toString('hex')}`) };
  }

  async put(key: string, body: Buffer): Promise<void> {
    const { final, temp } = await this.#prepare(key);
    const fh = await open(temp, 'w', 0o600);
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await chmod(temp, 0o600);
    await rename(temp, final);
  }

  /**
   * Streams `body` into the key, counting and hashing on the way; refuses (and removes the partial file) when it is
   * longer than `maxBytes`. The file is renamed into place only when `accept(size, sha256)` agrees.
   */
  async putStream(
    key: string,
    body: Readable,
    maxBytes: number,
    accept: (size: number, sha256: string, head: Buffer) => boolean,
  ): Promise<{ size: number; sha256: string; accepted: boolean; head: Buffer }> {
    // Listeners are attached only after the directory exists: a flowing stream must not emit before the pipe.
    const { final, temp } = await this.#prepare(key);
    const h = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    // An object, not a `let`: the flag is set in the data listener (TypeScript would narrow a `let` to false).
    const over = { tooLarge: false };
    body.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes && !over.tooLarge) {
        over.tooLarge = true;
        body.destroy(new Error('too_large'));
        return;
      }
      if (head.length < 64) head = Buffer.concat([head, c.subarray(0, 64 - head.length)]);
      h.update(c);
    });
    try {
      await pipeline(body, createWriteStream(temp, { mode: 0o600 }));
    } catch (err) {
      await rm(temp, { force: true });
      if (over.tooLarge) return { size, sha256: '', accepted: false, head };
      throw err;
    }
    const sha256 = h.digest('hex');
    if (!accept(size, sha256, head)) {
      await rm(temp, { force: true });
      return { size, sha256, accepted: false, head };
    }
    const fh = await open(temp, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(temp, final);
    return { size, sha256, accepted: true, head };
  }

  /** Directory of the parts of one upload (outside every key's namespace: keys never start with a dot). */
  partDir(uploadId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new BlobKeyError(uploadId);
    return join(this.root, '.uploads', uploadId);
  }

  /**
   * Streams one part of an upload (exactly `size` bytes with SHA-256 `sha256`) into the upload's part directory.
   * Returns false (nothing kept) when the body differs.
   */
  async putPart(
    uploadId: string,
    n: number,
    body: Readable,
    size: number,
    sha256: string,
  ): Promise<{ accepted: boolean; size: number }> {
    const dir = this.partDir(uploadId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const final = join(dir, String(n));
    const temp = join(dir, `.tmp-${String(n)}-${randomBytes(6).toString('hex')}`);
    const h = createHash('sha256');
    let got = 0;
    // An object, not a `let`: the flag is set in the data listener (TypeScript would narrow a `let` to false).
    const over = { tooLarge: false };
    body.on('data', (c: Buffer) => {
      got += c.length;
      if (got > size && !over.tooLarge) {
        over.tooLarge = true;
        body.destroy(new Error('too_large'));
        return;
      }
      h.update(c);
    });
    try {
      await pipeline(body, createWriteStream(temp, { mode: 0o600 }));
    } catch (err) {
      await rm(temp, { force: true });
      if (over.tooLarge) return { accepted: false, size: got };
      throw err;
    }
    if (got !== size || h.digest('hex') !== sha256) {
      await rm(temp, { force: true });
      return { accepted: false, size: got };
    }
    await rename(temp, final);
    return { accepted: true, size: got };
  }

  /** Which parts (1…count) of an upload are present. */
  async partsPresent(uploadId: string, count: number): Promise<number[]> {
    const out: number[] = [];
    for (let n = 1; n <= count; n++) {
      if ((await stat(join(this.partDir(uploadId), String(n))).catch(() => null)) !== null) out.push(n);
    }
    return out;
  }

  /**
   * Concatenates the parts 1…count into `key` (hashing on the way); renames into place only for the expected size +
   * SHA-256 and `accept(head)`. The part directory is removed either way.
   */
  async assemble(
    key: string,
    uploadId: string,
    count: number,
    expected: { readonly size: number; readonly sha256: string },
    accept: (head: Buffer) => boolean,
  ): Promise<{ accepted: boolean; size: number; sha256: string }> {
    const { final, temp } = await this.#prepare(key);
    const dir = this.partDir(uploadId);
    const h = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const out = await open(temp, 'w', 0o600);
    try {
      for (let n = 1; n <= count; n++) {
        for await (const c of createReadStream(join(dir, String(n))) as AsyncIterable<Buffer>) {
          size += c.length;
          if (head.length < 64) head = Buffer.concat([head, c.subarray(0, 64 - head.length)]);
          h.update(c);
          await out.write(c);
        }
      }
      await out.sync();
    } finally {
      await out.close();
    }
    const sha256 = h.digest('hex');
    const accepted = size === expected.size && sha256 === expected.sha256 && accept(head);
    if (accepted) await rename(temp, final);
    else await rm(temp, { force: true });
    await rm(dir, { recursive: true, force: true });
    return { accepted, size, sha256 };
  }

  /** Removes the parts of an upload (expired / failed grants). */
  async dropParts(uploadId: string): Promise<void> {
    await rm(this.partDir(uploadId), { recursive: true, force: true });
  }

  async get(key: string, maxBytes: number): Promise<Buffer> {
    const p = this.path(key);
    const st = await stat(p).catch(() => null);
    if (st === null) throw new BlobNotFoundError(key);
    if (st.size > maxBytes) throw new Error(`blob ${key} is larger than ${String(maxBytes)} bytes`);
    const fh = await open(p, 'r');
    try {
      return await fh.readFile();
    } finally {
      await fh.close();
    }
  }

  async range(key: string, offset: number, length: number): Promise<Buffer> {
    const fh = await open(this.path(key), 'r').catch(() => {
      throw new BlobNotFoundError(key);
    });
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async stream(key: string): Promise<{ stream: Readable; size: number }> {
    const p = this.path(key);
    const st = await stat(p).catch(() => null);
    if (st === null) throw new BlobNotFoundError(key);
    return { stream: createReadStream(p), size: st.size };
  }

  async head(key: string): Promise<{ size: number } | null> {
    const st = await stat(this.path(key)).catch(() => null);
    return st === null ? null : { size: st.size };
  }

  async delete(key: string): Promise<void> {
    await unlink(this.path(key)).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }

  /** Free and total bytes of the volume holding the blob directory (Doctor). */
  async space(): Promise<{ freeBytes: number; totalBytes: number }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const s = await statfs(this.root);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  }
}
