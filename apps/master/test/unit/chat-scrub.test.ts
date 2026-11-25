import { describe, expect, it } from 'vitest';
import { exifFacts, ScrubError, scrubImage } from '../../src/chat/scrub.js';
import {
  GPS_MARKER,
  gifWithMetadata,
  jpegWithMetadata,
  pngWithMetadata,
  webpWithMetadata,
  XMP_MARKER,
} from '../helpers/images.js';

/** p8-chat-attachments-mentions: the metadata scrub of chat images (design note §2). */
const has = (b: Buffer, s: string): boolean => b.includes(Buffer.from(s, 'latin1'));

describe('chat image scrub', () => {
  it('JPEG: EXIF (with GPS), XMP, IPTC and comments go; the orientation survives; pixel data is unchanged', () => {
    const src = jpegWithMetadata(6);
    expect(has(src, GPS_MARKER)).toBe(true);
    const { data, removed } = scrubImage(src, 'image/jpeg');
    expect(removed).toEqual(expect.arrayContaining(['exif', 'gps', 'xmp', 'iptc', 'comment']));
    for (const m of [GPS_MARKER, XMP_MARKER, 'IPTC-CITY', 'camera comment']) expect(has(data, m)).toBe(false);
    expect(data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(has(data, 'JFIF')).toBe(true);
    // Orientation 6 written back as a minimal EXIF right after JFIF.
    const at = data.indexOf(Buffer.from('Exif\0\0', 'latin1'));
    expect(at).toBeGreaterThan(0);
    expect(exifFacts(data.subarray(at))).toEqual({ orientation: 6, gps: false });
    // Entropy-coded bytes (incl. stuffed FF00 and a restart marker) are copied verbatim.
    expect(data.includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]))).toBe(true);
    expect(data.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    // Idempotent.
    expect(scrubImage(data, 'image/jpeg').data).toEqual(data);
  });

  it('JPEG: orientation 1 needs no EXIF; data appended after EOI is dropped', () => {
    const src = Buffer.concat([jpegWithMetadata(1), Buffer.from('PK\x03\x04hidden zip', 'latin1')]);
    const { data } = scrubImage(src, 'image/jpeg');
    expect(has(data, 'Exif')).toBe(false);
    expect(has(data, 'hidden zip')).toBe(false);
  });

  it('PNG: text chunks, XMP and eXIf go, image chunks stay', () => {
    const { data, removed } = scrubImage(pngWithMetadata(), 'image/png');
    expect(removed).toEqual(expect.arrayContaining(['text-chunks', 'xmp', 'exif']));
    for (const m of [GPS_MARKER, XMP_MARKER, 'eXIf', 'tEXt']) expect(has(data, m)).toBe(false);
    for (const m of ['IHDR', 'IDAT', 'IEND']) expect(has(data, m)).toBe(true);
  });

  it('WebP: EXIF / XMP chunks go and the VP8X flags are cleared', () => {
    const { data, removed } = scrubImage(webpWithMetadata(), 'image/webp');
    expect(removed).toEqual(expect.arrayContaining(['exif', 'xmp']));
    expect(has(data, XMP_MARKER)).toBe(false);
    expect(has(data, 'EXIF')).toBe(false);
    const flags = data[20] as number;
    expect(flags & 0x0c).toBe(0);
    expect(flags & 0x10).toBe(0x10);
    expect(data.readUInt32LE(4)).toBe(data.length - 8);
  });

  it('GIF: comments and foreign application extensions go, looping stays', () => {
    const { data, removed } = scrubImage(gifWithMetadata(), 'image/gif');
    expect(removed).toEqual(expect.arrayContaining(['comment', 'xmp']));
    expect(has(data, GPS_MARKER)).toBe(false);
    expect(has(data, XMP_MARKER)).toBe(false);
    expect(has(data, 'NETSCAPE2.0')).toBe(true);
    expect(data.at(-1)).toBe(0x3b);
  });

  it('refuses what it cannot parse', () => {
    expect(() => scrubImage(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), 'image/jpeg')).toThrow(
      ScrubError,
    );
    expect(() => scrubImage(pngWithMetadata().subarray(0, 40), 'image/png')).toThrow(ScrubError);
    expect(() => scrubImage(gifWithMetadata().subarray(0, 30), 'image/gif')).toThrow(ScrubError);
    expect(() => scrubImage(Buffer.from('RIFF\x04\0\0\0WEBP', 'latin1'), 'image/webp')).toThrow(ScrubError);
    expect(() => scrubImage(Buffer.from('x'), 'image/svg+xml')).toThrow(ScrubError);
  });
});
