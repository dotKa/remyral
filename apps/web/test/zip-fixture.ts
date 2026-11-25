import { crc32 } from '../src/lib/siteZip';

/** p15-chat-zip: a minimal stored .zip writer for tests (the reader's own tests cover deflate, symlinks and bombs). */
export function storedZip(entries: readonly { name: string; data: string | Uint8Array }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const body = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data);
    const crc = crc32(body);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(body.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...locals, cd, end]));
}

export const zipFile = (
  name: string,
  entries: readonly { name: string; data: string | Uint8Array }[],
): File => new File([storedZip(entries) as BlobPart], name, { type: 'application/zip' });

/** A site in one top folder (stripped by the planner) plus macOS litter. */
export const SITE_ZIP_ENTRIES = [
  { name: 'deck/', data: '' },
  { name: 'deck/index.html', data: '<!doctype html><h1>Deck</h1>' },
  { name: 'deck/css/app.css', data: 'body{margin:0}' },
  { name: '__MACOSX/deck/._index.html', data: 'x' },
];
