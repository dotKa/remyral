/**
 * Hand-built image containers with metadata (p8-chat-attachments-mentions tests): just enough structure for the
 * scrubber — the pixel data is a placeholder (nothing here decodes images).
 */

const seg = (marker: number, payload: Buffer): Buffer => {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(0xff00 | marker, 0);
  h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
};

/** EXIF (little-endian TIFF) with Orientation and a GPS IFD holding a latitude marker string. */
export function exifPayload(orientation: number): Buffer {
  const t = Buffer.alloc(64);
  t.write('II', 0, 'latin1');
  t.writeUInt16LE(42, 2);
  t.writeUInt32LE(8, 4);
  t.writeUInt16LE(2, 8);
  // Orientation SHORT
  t.writeUInt16LE(0x0112, 10);
  t.writeUInt16LE(3, 12);
  t.writeUInt32LE(1, 14);
  t.writeUInt16LE(orientation, 18);
  // GPS IFD pointer
  t.writeUInt16LE(0x8825, 22);
  t.writeUInt16LE(4, 24);
  t.writeUInt32LE(1, 26);
  t.writeUInt32LE(40, 30);
  t.writeUInt32LE(0, 34);
  t.write('GPSLAT41.0082N', 40, 'latin1');
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
}

export const GPS_MARKER = 'GPSLAT41.0082N';
export const XMP_MARKER = 'xmp-secret-location';

export function jpegWithMetadata(orientation = 6): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe1, exifPayload(orientation)),
    seg(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x>${XMP_MARKER}</x>`, 'latin1')),
    seg(0xed, Buffer.from('Photoshop 3.0\0IPTC-CITY', 'latin1')),
    seg(0xfe, Buffer.from('camera comment', 'latin1')),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc0, Buffer.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0])),
    seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const chunk = (type: string, data: Buffer): Buffer => {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(data.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, data, Buffer.alloc(4)]);
};

export function pngWithMetadata(idat: Buffer = Buffer.from([1, 2, 3, 4])): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    chunk('tEXt', Buffer.from(`Comment\0${GPS_MARKER}`, 'latin1')),
    chunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${XMP_MARKER}`, 'latin1')),
    chunk('eXIf', exifPayload(1).subarray(6)),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function webpWithMetadata(): Buffer {
  const c = (fourcc: string, data: Buffer): Buffer => {
    const h = Buffer.alloc(8);
    h.write(fourcc, 0, 'latin1');
    h.writeUInt32LE(data.length, 4);
    return Buffer.concat([h, data, data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04 | 0x10;
  const body = Buffer.concat([
    c('VP8X', vp8x),
    c('VP8L', Buffer.from([0x2f, 0, 0, 0, 0])),
    c('EXIF', exifPayload(1).subarray(6)),
    c('XMP ', Buffer.from(XMP_MARKER, 'latin1')),
  ]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

export function gifWithMetadata(): Buffer {
  const sub = (data: Buffer): Buffer => Buffer.concat([Buffer.from([data.length]), data, Buffer.from([0])]);
  return Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([1, 0, 1, 0, 0x80, 0, 0]),
    Buffer.alloc(6),
    Buffer.from([0x21, 0xff]),
    Buffer.concat([Buffer.from([11]), Buffer.from('NETSCAPE2.0', 'latin1'), sub(Buffer.from([1, 0, 0]))]),
    Buffer.from([0x21, 0xfe]),
    sub(Buffer.from(GPS_MARKER, 'latin1')),
    Buffer.from([0x21, 0xff]),
    Buffer.concat([
      Buffer.from([11]),
      Buffer.from('XMP DataXMP', 'latin1'),
      sub(Buffer.from(XMP_MARKER, 'latin1')),
    ]),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([2]),
    sub(Buffer.from([0x44, 0x01])),
    Buffer.from([0x3b]),
  ]);
}
