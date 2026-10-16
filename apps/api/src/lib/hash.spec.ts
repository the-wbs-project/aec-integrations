import { describe, expect, it } from 'vitest';

import { bytesToHex, monthlyIpHash, recipientHash, sha256Hex } from './hash';

describe('sha256Hex', () => {
  it('matches the known SHA-256 vectors', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('bytesToHex', () => {
  it('pads every byte to two lowercase hex digits', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 255]).buffer)).toBe('00010f10ff');
  });
});

describe('recipientHash', () => {
  it('trims and lowercases before hashing', async () => {
    const canonical = await recipientHash('seat@vendor.example');
    expect(await recipientHash('  Seat@Vendor.EXAMPLE ')).toBe(canonical);
    expect(canonical).toBe(await sha256Hex('seat@vendor.example'));
  });

  it('never contains the address', async () => {
    const hash = await recipientHash('seat@vendor.example');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('vendor');
  });
});

describe('monthlyIpHash', () => {
  const oct = new Date('2026-10-02T00:00:00Z');
  const lateOct = new Date('2026-10-31T23:59:59Z');
  const nov = new Date('2026-11-01T00:00:00Z');

  it('is stable within a month and differs across months', async () => {
    const a = await monthlyIpHash('s3cret', '203.0.113.9', oct);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await monthlyIpHash('s3cret', '203.0.113.9', lateOct)).toBe(a);
    expect(await monthlyIpHash('s3cret', '203.0.113.9', nov)).not.toBe(a);
  });

  it('differs by secret and never equals an unkeyed hash', async () => {
    const a = await monthlyIpHash('s3cret', '203.0.113.9', oct);
    expect(await monthlyIpHash('other', '203.0.113.9', oct)).not.toBe(a);
    expect(a).not.toBe(await sha256Hex('203.0.113.9'));
  });

  it('is null without a secret or an IP', async () => {
    expect(await monthlyIpHash(undefined, '203.0.113.9', oct)).toBeNull();
    expect(await monthlyIpHash('', '203.0.113.9', oct)).toBeNull();
    expect(await monthlyIpHash('s3cret', null, oct)).toBeNull();
  });
});
