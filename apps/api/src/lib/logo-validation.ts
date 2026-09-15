import { LOGO_MAX_BYTES, LOGO_MAX_DIMENSION } from '@aeci/shared';

import { ApiError } from '../errors';

export type LogoFormat = {
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
};

function invalid(message = 'Use a valid PNG, JPEG or static WebP image.'): never {
  throw new ApiError(400, 'VALIDATION_FAILED', message, { field: 'file' });
}

function dimensions(
  contentType: LogoFormat['contentType'],
  width: number,
  height: number,
): LogoFormat {
  if (!width || !height || width > LOGO_MAX_DIMENSION || height > LOGO_MAX_DIMENSION) {
    invalid(`Logo dimensions must be between 1 and ${LOGO_MAX_DIMENSION} pixels.`);
  }
  return { contentType, width, height };
}

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, i) => bytes[offset + i] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(bytes: Uint8Array, view: DataView): LogoFormat {
  let offset = 8;
  let shape: LogoFormat | undefined;
  let data = false;
  let dataEnded = false;
  let palette = false;
  let indexed = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    if (end > bytes.length) invalid();
    const kind = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(kind) || kind[2] !== kind[2]!.toUpperCase()) invalid();
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) invalid();
    if (!shape && kind !== 'IHDR') invalid();
    if (kind === 'IHDR') {
      if (shape || length !== 13) invalid();
      shape = dimensions('image/png', view.getUint32(offset + 8), view.getUint32(offset + 12));
      const depth = bytes[offset + 16]!;
      const color = bytes[offset + 17]!;
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !depths[color]?.includes(depth) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20]! > 1
      )
        invalid();
      indexed = color === 3;
    } else if (kind === 'PLTE') {
      if (palette || data || !length || length > 768 || length % 3) invalid();
      palette = true;
    } else if (kind === 'IDAT') {
      if (dataEnded || (indexed && !palette)) invalid();
      data ||= length > 0;
    } else if (kind === 'IEND') {
      if (length || !data || end !== bytes.length || !shape) invalid();
      return shape;
    } else {
      if (['acTL', 'fcTL', 'fdAT'].includes(kind) || kind[0] === kind[0]!.toUpperCase()) invalid();
      if (data) dataEnded = true;
    }
    offset = end;
  }
  return invalid();
}

function jpeg(bytes: Uint8Array, view: DataView): LogoFormat {
  let offset = 2;
  let shape: LogoFormat | undefined;
  let scanned = false;
  let inScan = false;
  while (offset < bytes.length) {
    if (inScan) {
      if (bytes[offset++] !== 0xff) continue;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset];
      if (marker === 0 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) {
        offset++;
        continue;
      }
      offset--;
      inScan = false;
    }
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!shape || !scanned || offset !== bytes.length) invalid();
      return shape;
    }
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 0xd8 ||
      marker === 1 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      offset + 2 > bytes.length
    )
      invalid();
    const length = view.getUint16(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      // Baseline and progressive Huffman JPEG only.
      if (![0xc0, 0xc2].includes(marker) || shape || length < 11 || bytes[offset + 2] !== 8)
        invalid();
      const components = bytes[offset + 7]!;
      if (![1, 3, 4].includes(components) || length !== 8 + components * 3) invalid();
      shape = dimensions('image/jpeg', view.getUint16(offset + 5), view.getUint16(offset + 3));
    }
    if (marker === 0xda) {
      if (!shape || length < 8 || length !== 6 + 2 * bytes[offset + 2]!) invalid();
      scanned = true;
      inScan = true;
    }
    offset = end;
  }
  return invalid();
}

function webp(bytes: Uint8Array, view: DataView): LogoFormat {
  if (view.getUint32(4, true) + 8 !== bytes.length) invalid();
  let offset = 12;
  let canvas: LogoFormat | undefined;
  let frame: LogoFormat | undefined;
  while (offset + 8 <= bytes.length) {
    const kind = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    const paddedEnd = end + (length % 2);
    if (paddedEnd > bytes.length || (length % 2 && bytes[end] !== 0)) invalid();
    if (kind === 'VP8X') {
      if (
        offset !== 12 ||
        length !== 10 ||
        bytes[start]! & 0xc3 ||
        bytes[start + 1] ||
        bytes[start + 2] ||
        bytes[start + 3]
      )
        invalid();
      const u24 = (pos: number) => bytes[pos]! | (bytes[pos + 1]! << 8) | (bytes[pos + 2]! << 16);
      canvas = dimensions('image/webp', 1 + u24(start + 4), 1 + u24(start + 7));
    } else if (kind === 'VP8 ') {
      if (frame || length < 10 || bytes[start]! & 1 || !matches(bytes, start + 3, [0x9d, 1, 0x2a]))
        invalid();
      frame = dimensions(
        'image/webp',
        view.getUint16(start + 6, true) & 0x3fff,
        view.getUint16(start + 8, true) & 0x3fff,
      );
    } else if (kind === 'VP8L') {
      if (frame || length < 5 || bytes[start] !== 0x2f || bytes[start + 4]! & 0xe0) invalid();
      const bits = view.getUint32(start + 1, true);
      frame = dimensions('image/webp', 1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
    } else if (!canvas || !['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(kind)) invalid();
    offset = paddedEnd;
  }
  if (
    offset !== bytes.length ||
    !frame ||
    (canvas && (canvas.width !== frame.width || canvas.height !== frame.height))
  )
    invalid();
  return frame;
}

/** Structural validation only. No decoding, metadata rewriting, or MIME trust. */
export function validateLogo(bytes: Uint8Array): LogoFormat {
  if (!bytes.length || bytes.length > LOGO_MAX_BYTES) invalid('Logo must be no larger than 2 MiB.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (matches(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return png(bytes, view);
  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return jpeg(bytes, view);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP')
    return webp(bytes, view);
  return invalid();
}
