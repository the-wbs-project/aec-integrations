import { describe, expect, it } from 'vitest';

import { bytesToHex, recipientHash, sha256Hex } from './hash';

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
