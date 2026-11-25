/**
 * Metadata scrub of chat image attachments (p8-chat-attachments-mentions, design note §2): removes EXIF (with GPS),
 * XMP, IPTC, comments and text chunks from JPEG, PNG, WebP and GIF files by rewriting their container structure —
 * pure TypeScript, no image codec. Pixel data is copied unchanged. A JPEG's orientation survives as a minimal EXIF
 * block with only the Orientation tag, so phone photos stay upright. Anything the parser does not understand is
 * refused ({@link ScrubError}) instead of being stored with unknown metadata.
 */

export class ScrubError extends Error {}

export interface ScrubResult {
  readonly data: Buffer;
  /** What was removed: exif, gps, xmp, iptc, comment, text-chunks, metadata. */
  readonly removed: string[];
}

export function scrubImage(input: Buffer, mediaType: string): ScrubResult {
  switch (mediaType) {
    case 'image/jpeg':
      return scrubJpeg(input);
    case 'image/png':
      return scrubPng(input);
    case 'image/webp':
      return scrubWebp(input);
    case 'image/gif':
      return scrubGif(input);
    default:
      throw new ScrubError(`unsupported image type ${mediaType}`);
  }
}

function need(cond: boolean, what: string): asserts cond {
  if (!cond) throw new ScrubError(what);
}

function add(removed: string[], tag: string): void {
  if (!removed.includes(tag)) removed.push(tag);
}

// ------------------------------------------------------------------------------------------------------- JPEG

const ascii = (b: Buffer, at: number, s: string): boolean =>
  b.length >= at + s.length && b.toString('latin1', at, at + s.length) === s;

/** Orientation (1–8) and whether IFD0 points to GPS data, from an APP1 Exif payload ("Exif\0\0" + TIFF). */
export function exifFacts(app1: Buffer): { orientation: number | null; gps: boolean } {
  const t = app1.subarray(6);
  if (t.length < 8) return { orientation: null, gps: false };
  const le = ascii(t, 0, 'II');
  if (!le && !ascii(t, 0, 'MM')) return { orientation: null, gps: false };
  const u16 = (o: number): number => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number): number => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return { orientation: null, gps: false };
  const n = u16(ifd);
  let orientation: number | null = null;
  let gps = false;
  for (let i = 0; i < n; i += 1) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) break;
    const tag = u16(e);
    if (tag === 0x0112 && u16(e + 2) === 3) {
      const v = u16(e + 8);
      if (v >= 1 && v <= 8) orientation = v;
    }
    if (tag === 0x8825) gps = true;
  }
  return { orientation, gps };
}

/** APP1 segment with a big-endian TIFF holding only IFD0 → Orientation. */
function orientationSegment(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function scrubJpeg(b: Buffer): ScrubResult {
  need(b.length > 4 && b[0] === 0xff && b[1] === 0xd8, 'not a JPEG');
  const out: Buffer[] = [b.subarray(0, 2)];
  const removed: string[] = [];
  let orientation: number | null = null;
  let insertAt = 1; // after SOI (index into out), moved past a kept APP0
  let i = 2;
  let sawSos = false;
  while (i < b.length) {
    need(b[i] === 0xff, 'JPEG marker expected');
    // Fill bytes.
    let m = i + 1;
    while (m < b.length && b[m] === 0xff) m += 1;
    need(m < b.length, 'truncated JPEG');
    const marker = b[m] as number;
    const start = m - 1;
    if (marker === 0xd9) {
      out.push(b.subarray(start, m + 1));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(b.subarray(start, m + 1));
      i = m + 1;
      continue;
    }
    need(m + 3 <= b.length, 'truncated JPEG segment');
    const len = b.readUInt16BE(m + 1);
    need(len >= 2 && m + 1 + len <= b.length, 'bad JPEG segment length');
    const end = m + 1 + len;
    const payload = b.subarray(m + 3, end);
    let keep = true;
    if (marker >= 0xe0 && marker <= 0xef) {
      if (marker === 0xe0 && (ascii(payload, 0, 'JFIF\0') || ascii(payload, 0, 'JFXX\0'))) keep = true;
      else if (marker === 0xe2 && ascii(payload, 0, 'ICC_PROFILE\0')) keep = true;
      else if (marker === 0xee && ascii(payload, 0, 'Adobe')) keep = true;
      else {
        keep = false;
        if (marker === 0xe1 && ascii(payload, 0, 'Exif\0')) {
          add(removed, 'exif');
          const f = exifFacts(payload);
          if (f.gps) add(removed, 'gps');
          if (orientation === null && f.orientation !== null) orientation = f.orientation;
        } else if (marker === 0xe1 && ascii(payload, 0, 'http://ns.adobe.com/')) add(removed, 'xmp');
        else if (marker === 0xed) add(removed, 'iptc');
        else add(removed, 'metadata');
      }
    } else if (marker === 0xfe) {
      keep = false;
      add(removed, 'comment');
    }
    if (keep) {
      out.push(b.subarray(start, end));
      if (marker === 0xe0 && !sawSos && out.length - 1 === insertAt) insertAt = out.length;
    }
    i = end;
    if (marker === 0xda) {
      sawSos = true;
      // Entropy-coded data up to the next marker (FF followed by neither 00 nor a restart marker).
      let j = i;
      while (j < b.length - 1) {
        if (b[j] === 0xff) {
          const n = b[j + 1] as number;
          if (n !== 0x00 && !(n >= 0xd0 && n <= 0xd7) && n !== 0xff) break;
        }
        j += 1;
      }
      need(j < b.length - 1, 'JPEG without end marker');
      out.push(b.subarray(i, j));
      i = j;
    }
  }
  need(sawSos, 'JPEG without image data');
  if (orientation !== null && orientation !== 1) out.splice(insertAt, 0, orientationSegment(orientation));
  return { data: Buffer.concat(out), removed };
}

// -------------------------------------------------------------------------------------------------------- PNG

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP: Readonly<Record<string, string>> = {
  eXIf: 'exif',
  tEXt: 'text-chunks',
  zTXt: 'text-chunks',
  iTXt: 'text-chunks',
  tIME: 'metadata',
};

function scrubPng(b: Buffer): ScrubResult {
  need(b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG), 'not a PNG');
  const out: Buffer[] = [PNG_SIG];
  const removed: string[] = [];
  let i = 8;
  let ended = false;
  while (i < b.length) {
    need(i + 12 <= b.length, 'truncated PNG chunk');
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    need(/^[A-Za-z]{4}$/.test(type), 'bad PNG chunk type');
    const end = i + 12 + len;
    need(end <= b.length, 'bad PNG chunk length');
    const drop = PNG_DROP[type];
    if (drop === undefined) out.push(b.subarray(i, end));
    else {
      add(removed, drop);
      // XMP lives in an iTXt chunk named XML:com.adobe.xmp.
      if (type === 'iTXt' && b.toString('latin1', i + 8, i + 8 + 17) === 'XML:com.adobe.xmp')
        add(removed, 'xmp');
    }
    i = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  need(ended, 'PNG without IEND');
  return { data: Buffer.concat(out), removed };
}

// ------------------------------------------------------------------------------------------------------- WebP

function scrubWebp(b: Buffer): ScrubResult {
  need(b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'), 'not a WebP');
  const riffEnd = Math.min(b.length, 8 + b.readUInt32LE(4));
  const chunks: Buffer[] = [];
  const removed: string[] = [];
  let i = 12;
  while (i + 8 <= riffEnd) {
    const fourcc = b.toString('latin1', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    need(i + 8 + size <= riffEnd, 'bad WebP chunk length');
    if (fourcc === 'EXIF') add(removed, 'exif');
    else if (fourcc === 'XMP ') add(removed, 'xmp');
    else {
      const chunk = Buffer.from(b.subarray(i, Math.min(end, riffEnd)));
      if (fourcc === 'VP8X' && size >= 1) chunk[8] = (chunk[8] as number) & ~0x0c;
      chunks.push(chunk.length % 2 === 1 ? Buffer.concat([chunk, Buffer.alloc(1)]) : chunk);
    }
    i = end;
  }
  need(chunks.length > 0, 'WebP without image data');
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return { data: Buffer.concat([head, body]), removed };
}

// -------------------------------------------------------------------------------------------------------- GIF

const GIF_KEEP_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

function scrubGif(b: Buffer): ScrubResult {
  need(b.length >= 13 && (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')), 'not a GIF');
  const removed: string[] = [];
  const packed = b[10] as number;
  let i = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  need(i <= b.length, 'truncated GIF');
  const out: Buffer[] = [b.subarray(0, i)];
  /** End of the sub-block chain starting at `j`. */
  const blocks = (j: number): number => {
    let k = j;
    for (;;) {
      need(k < b.length, 'truncated GIF sub-blocks');
      const n = b[k] as number;
      k += 1 + n;
      if (n === 0) return k;
    }
  };
  let ended = false;
  while (i < b.length) {
    const intro = b[i] as number;
    if (intro === 0x3b) {
      out.push(b.subarray(i, i + 1));
      ended = true;
      break;
    }
    if (intro === 0x2c) {
      need(i + 10 <= b.length, 'truncated GIF image');
      const p = b[i + 9] as number;
      const afterTable = i + 10 + (p & 0x80 ? 3 * 2 ** ((p & 0x07) + 1) : 0);
      need(afterTable + 1 <= b.length, 'truncated GIF image');
      const end = blocks(afterTable + 1);
      out.push(b.subarray(i, end));
      i = end;
      continue;
    }
    need(intro === 0x21 && i + 2 <= b.length, 'bad GIF block');
    const label = b[i + 1] as number;
    const end = blocks(i + 2);
    let keep = true;
    if (label === 0xfe) {
      keep = false;
      add(removed, 'comment');
    } else if (label === 0xff) {
      const app = (b[i + 2] as number) >= 11 ? b.toString('latin1', i + 3, i + 14) : '';
      if (!GIF_KEEP_APPS.has(app)) {
        keep = false;
        add(removed, app.startsWith('XMP') ? 'xmp' : 'metadata');
      }
    }
    if (keep) out.push(b.subarray(i, end));
    i = end;
  }
  need(ended, 'GIF without trailer');
  return { data: Buffer.concat(out), removed };
}
