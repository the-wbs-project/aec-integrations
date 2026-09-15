import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LOGO_MAX_BYTES } from '@aeci/shared';
import { validateLogo } from './logo-validation';

const fixture = (format: string) =>
  new Uint8Array(readFileSync(join(__dirname, '../test/fixtures/logos', `valid.${format}`)));
function chunk(kind: string, bytes: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(kind), bytes]);
  let crc = 0xffffffff;
  for (const b of body) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(body.length + 8);
  result.writeUInt32BE(bytes.length);
  body.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
  return result;
}
function png(width: number, height: number): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    fixture('png').slice(0, 8),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(new Uint8Array([0, 1, 2, 3]))),
    chunk('IEND', new Uint8Array()),
  ]);
}

describe('logo byte validation', () => {
  it.each(['png', 'jpeg', 'webp'])(
    'accepts an actual %s image and derives its dimensions',
    (format) => {
      expect(validateLogo(fixture(format))).toEqual({
        contentType: `image/${format}`,
        width: 2,
        height: 3,
      });
    },
  );
  it.each(['png', 'jpeg', 'webp'])('rejects trailing bytes and truncation in %s', (format) => {
    const bytes = fixture(format);
    expect(() =>
      validateLogo(Buffer.concat([bytes, Buffer.from('<script>alert(1)</script>')])),
    ).toThrow();
    expect(() => validateLogo(bytes.slice(0, -1))).toThrow();
    for (let n = 0; n < Math.min(bytes.length, 40); n++)
      expect(() => validateLogo(bytes.slice(0, n))).toThrow();
  });
  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    '<!DOCTYPE html><script>alert(1)</script>',
    'GIF89a',
  ])('rejects non-raster input %s', (text) => {
    expect(() => validateLogo(new TextEncoder().encode(text))).toThrow();
  });
  it('enforces byte and dimension bounds', () => {
    expect(() => validateLogo(new Uint8Array(LOGO_MAX_BYTES + 1))).toThrow();
    for (const [width, height] of [
      [0, 1],
      [1, 0],
      [2049, 1],
      [1, 2049],
    ])
      expect(() => validateLogo(png(width!, height!))).toThrow();
    expect(validateLogo(png(2048, 2048)).width).toBe(2048);
  });
  it('rejects bad PNG CRCs and animation', () => {
    const bytes = fixture('png');
    bytes[20] ^= 1;
    expect(() => validateLogo(bytes)).toThrow();
    const base = fixture('png');
    expect(() =>
      validateLogo(
        Buffer.concat([base.slice(0, 33), chunk('acTL', new Uint8Array(8)), base.slice(33)]),
      ),
    ).toThrow();
  });
  it('rejects an animated WebP header and mismatched RIFF length', () => {
    const base = fixture('webp');
    const extended = Buffer.alloc(18);
    extended.write('VP8X');
    extended.writeUInt32LE(10, 4);
    extended[8] = 2;
    const bytes = Buffer.concat([base.slice(0, 12), extended, base.slice(12)]);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    expect(() => validateLogo(bytes)).toThrow();
    const corrupt = fixture('webp');
    corrupt[4] ^= 1;
    expect(() => validateLogo(corrupt)).toThrow();
  });
});
