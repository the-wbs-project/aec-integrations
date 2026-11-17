/**
 * RFC 3161 request and response (AECI-1680, ADR 0057). The fixtures are one real
 * exchange with `http://timestamp.digicert.com` on 2026-11-17, for a random digest:
 * `digicert-request.tsq` is what `buildTimeStampRequest` sent, and
 * `digicert-response.tsr` is DigiCert's reply. `openssl ts -verify` passed on that reply
 * against `scripts/certs/digicert-tsa-chain.pem`. The `throwaway-*` replies answer the
 * same request but are signed by a throwaway CA (fixtures README). No spec here touches
 * the network.
 */

import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildTimeStampRequest,
  DIGICERT_TSA_URL,
  parseTimeStampResponse,
  PINNED_TSA_ISSUERS,
  requestTimestamp,
} from './rfc3161';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, '../test/fixtures/rfc3161', name)));

const DIGEST = 'f6abbf5e4abf20da6fc1c6e12e2aaeb2acf42b7a328966a4a9bb83c74fbc4099';
const NONCE = new Uint8Array([0x13, 0x7e, 0xdb, 0xde, 0x3d, 0xcd, 0x38, 0x29]);
const REQUEST = fixture('digicert-request.tsq');
const RESPONSE = fixture('digicert-response.tsr');
/** Signed for the same request by a throwaway CA's TSA certificate (critical EKU). */
const THROWAWAY_CA = fixture('throwaway-ca-response.tsr');
/** The same TSTInfo, re-signed by a throwaway certificate with no EKU, `sid` by key id. */
const THROWAWAY_NO_EKU = fixture('throwaway-no-eku-response.tsr');
/** Near both genTimes: DigiCert 2026-11-17T00:22:23Z, the throwaway 01:59:24Z. */
const NOW = new Date('2026-11-17T01:00:00.000Z');
const EXPECTED = { sha256HexDigest: DIGEST, nonce: NONCE, now: NOW };

/** A copy of `bytes` with one byte inverted. */
const flip = (bytes: Uint8Array, at: number) => {
  const out = bytes.slice();
  out[at] = out[at]! ^ 0xff;
  return out;
};
const indexOf = (haystack: Uint8Array, needle: number[]) => {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  throw new Error('spec: needle not found');
};

/** Minimal DER writer for synthetic tokens (short lengths only). */
const tlv = (tag: number, ...content: number[][]): number[] => {
  const body = content.flat();
  if (body.length > 127) throw new Error('spec tlv: too long');
  return [tag, body.length, ...body];
};
const hex = (h: string) => Array.from(h.match(/../g)!, (b) => parseInt(b, 16));
const OID_SIGNED_DATA = tlv(0x06, hex('2a864886f70d010702'));
const OID_DATA = tlv(0x06, hex('2a864886f70d010701'));
const OID_TST_INFO = tlv(0x06, hex('2a864886f70d0109100104'));
/** `TimeStampResp { status 0, token }`. */
const granted = (token: number[]) => new Uint8Array(tlv(0x30, tlv(0x30, tlv(0x02, [0])), token));
/** `ContentInfo { id-signedData, [0] SignedData { … signerInfos } }` over TSTInfo holding the digest. */
const signedToken = (signerInfos: number[], contentOid = OID_TST_INFO) =>
  tlv(
    0x30,
    OID_SIGNED_DATA,
    tlv(
      0xa0,
      tlv(
        0x30,
        tlv(0x02, [3]),
        tlv(0x31),
        tlv(0x30, contentOid, tlv(0xa0, tlv(0x04, hex(DIGEST)))),
        signerInfos,
      ),
    ),
  );

/** `TimeStampResp { PKIStatusInfo { status } }` with no token. */
const statusOnly = (status: number) => new Uint8Array([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, status]);

describe('buildTimeStampRequest', () => {
  it('builds the exact DER that DigiCert accepted', () => {
    expect(Array.from(buildTimeStampRequest(DIGEST, NONCE))).toEqual(Array.from(REQUEST));
  });

  it('keeps a nonce with its high bit set positive', () => {
    const der = buildTimeStampRequest(DIGEST, new Uint8Array([0x80, 0x01]));
    // INTEGER, length 3, a leading 0x00, the two bytes, then certReq TRUE.
    expect(Array.from(der.slice(-8))).toEqual([0x02, 0x03, 0x00, 0x80, 0x01, 0x01, 0x01, 0xff]);
  });

  it('refuses a digest that is not 32 bytes', () => {
    expect(() => buildTimeStampRequest('abcd', NONCE)).toThrow(/32 bytes/);
  });
});

describe('parseTimeStampResponse', () => {
  it('verifies the recorded DigiCert reply as granted', async () => {
    expect(await parseTimeStampResponse(RESPONSE, EXPECTED)).toEqual({
      pkiStatus: 0,
      status: 'granted',
      hasToken: true,
      verified: true,
      genTime: '2026-11-17T00:22:23.000Z',
    });
  });

  it('a token for another digest is rejected', async () => {
    const expected = { ...EXPECTED, sha256HexDigest: '0'.repeat(64) };
    expect(await parseTimeStampResponse(RESPONSE, expected)).toMatchObject({
      status: 'rejected',
      verified: false,
      reason: 'digest_mismatch',
    });
  });

  it('a token for another nonce is rejected, a replayed reply included', async () => {
    for (const nonce of [new Uint8Array([1, 2, 3, 4]), NONCE.slice(0, 7)]) {
      expect(await parseTimeStampResponse(RESPONSE, { ...EXPECTED, nonce })).toMatchObject({
        status: 'rejected',
        reason: 'nonce_mismatch',
      });
    }
    // Sign padding is not a different nonce.
    const padded = new Uint8Array([0, ...NONCE]);
    expect((await parseTimeStampResponse(RESPONSE, { ...EXPECTED, nonce: padded })).status).toBe(
      'granted',
    );
  });

  it('a genTime more than 24 hours from now is rejected', async () => {
    for (const now of [
      new Date('2026-11-18T01:00:00.000Z'),
      new Date('2026-11-16T00:00:00.000Z'),
    ]) {
      expect(await parseTimeStampResponse(RESPONSE, { ...EXPECTED, now })).toMatchObject({
        status: 'rejected',
        reason: 'gen_time_skew',
      });
    }
  });

  it('a garbled signature is rejected', async () => {
    // The SignerInfo signature is the last 512 bytes of the reply.
    const forged = flip(RESPONSE, RESPONSE.length - 10);
    expect(await parseTimeStampResponse(forged, EXPECTED)).toMatchObject({
      pkiStatus: 0,
      status: 'rejected',
      hasToken: true,
      verified: false,
      reason: 'signature_invalid',
    });
  });

  it('an edited signed attribute is rejected', async () => {
    // A digit of the signingTime attribute, UTCTime (0x17) "261117002223Z".
    const at = indexOf(RESPONSE, [0x17, 0x0d, ...new TextEncoder().encode('261117002223Z')]);
    expect(at).toBeGreaterThan(5264);
    expect(await parseTimeStampResponse(flip(RESPONSE, at + 13), EXPECTED)).toMatchObject({
      reason: 'signature_invalid',
    });
  });

  it('an edited TSTInfo no longer matches the signed messageDigest', async () => {
    // A byte of the TSTInfo serial number.
    const at = indexOf(RESPONSE, [0x9c, 0xc8, 0x62, 0x18, 0xfe, 0x57]);
    expect(at).toBeLessThan(185);
    expect(await parseTimeStampResponse(flip(RESPONSE, at + 2), EXPECTED)).toMatchObject({
      reason: 'message_digest_mismatch',
    });
  });

  it('a signer certificate with a garbled issuer signature is not from the pinned issuer', async () => {
    // Inside the responder certificate's own signature BIT STRING (offset 1449).
    expect(await parseTimeStampResponse(flip(RESPONSE, 1500), EXPECTED)).toMatchObject({
      reason: 'unpinned_issuer',
    });
  });

  it('a correctly signed token from a TSA outside the pinned chain is rejected', async () => {
    expect(await parseTimeStampResponse(THROWAWAY_CA, EXPECTED)).toMatchObject({
      pkiStatus: 0,
      status: 'rejected',
      verified: false,
      reason: 'unpinned_issuer',
    });
  });

  it('a signer certificate without the timeStamping EKU is rejected', async () => {
    expect(await parseTimeStampResponse(THROWAWAY_NO_EKU, EXPECTED)).toMatchObject({
      status: 'rejected',
      reason: 'signer_cert_eku',
    });
  });

  it('a granted status with an unsigned or shape-only token is rejected', async () => {
    // Bare digest, a plain `data` ContentInfo, SignedData with no SignerInfo, a
    // non-TSTInfo content, and SignedData whose "TSTInfo" is only the digest.
    const cases: [number[], string][] = [
      [tlv(0x04, hex(DIGEST)), 'token_malformed'],
      [tlv(0x30, OID_DATA, tlv(0xa0, tlv(0x04, hex(DIGEST)))), 'token_malformed'],
      [signedToken(tlv(0x31)), 'token_malformed'],
      [signedToken(tlv(0x31, tlv(0x30, tlv(0x02, [1]))), OID_DATA), 'content_not_tstinfo'],
      [signedToken(tlv(0x31, tlv(0x30, tlv(0x02, [1])))), 'token_malformed'],
    ];
    for (const [token, reason] of cases) {
      expect(await parseTimeStampResponse(granted(token), EXPECTED)).toMatchObject({
        pkiStatus: 0,
        status: 'rejected',
        hasToken: true,
        verified: false,
        reason,
      });
    }
  });

  it('a rejection status with no token is rejected', async () => {
    expect(await parseTimeStampResponse(statusOnly(2), EXPECTED)).toEqual({
      pkiStatus: 2,
      status: 'rejected',
      hasToken: false,
      verified: false,
      reason: 'pki_status_2',
    });
    expect(await parseTimeStampResponse(statusOnly(0), EXPECTED)).toMatchObject({
      status: 'rejected',
      reason: 'no_token',
    });
  });

  it('throws on bytes that are not a TimeStampResp', async () => {
    await expect(
      parseTimeStampResponse(new Uint8Array([0x04, 0x01, 0x00]), EXPECTED),
    ).rejects.toThrow();
    await expect(parseTimeStampResponse(new Uint8Array([0x30, 0x10]), EXPECTED)).rejects.toThrow(
      /truncated/,
    );
  });
});

describe('PINNED_TSA_ISSUERS', () => {
  const pem = readFileSync(join(__dirname, '../../scripts/certs/digicert-tsa-chain.pem'), 'utf8');
  const certs = [
    ...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g),
  ].map((m) => new X509Certificate(m[0]));
  const spki = (cert: X509Certificate) =>
    Buffer.from(cert.publicKey.export({ type: 'spki', format: 'der' }) as Uint8Array).toString(
      'base64',
    );

  it('pins the intermediate in digicert-tsa-chain.pem, so the two cannot drift', () => {
    const intermediates = certs.filter((c) => c.subject !== c.issuer);
    expect(intermediates.length).toBeGreaterThan(0);
    // Every intermediate in the file is pinned, and every pin is in the file.
    expect(PINNED_TSA_ISSUERS.map((p) => p.spkiBase64).sort()).toEqual(
      intermediates.map(spki).sort(),
    );
    for (const pin of PINNED_TSA_ISSUERS) {
      const cert = intermediates.find((c) => spki(c) === pin.spkiBase64)!;
      expect(cert.subject).toContain(`CN=${pin.subject}`);
    }
  });
});

describe('requestTimestamp', () => {
  const respond = (body: Uint8Array, status = 200) =>
    vi.fn<typeof fetch>().mockResolvedValue(new Response(body as BodyInit, { status }));

  it('posts the query to DigiCert with a timeout and returns the verified token', async () => {
    const fetchImpl = respond(RESPONSE);
    const result = await requestTimestamp(DIGEST, { fetchImpl, nonce: NONCE, now: NOW });
    expect(result.ok).toBe(true);
    expect(result.ok && new Uint8Array(result.token)).toEqual(RESPONSE);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(DIGICERT_TSA_URL);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/timestamp-query' },
    });
    expect(Array.from(init!.body as Uint8Array)).toEqual(Array.from(REQUEST));
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('a non-200 reply is a failure, and its body is released', async () => {
    const res = new Response('busy', { status: 503 });
    const cancel = vi.spyOn(res.body!, 'cancel');
    const result = await requestTimestamp(DIGEST, {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(res),
    });
    expect(result).toEqual({ ok: false, reason: 'http_503' });
    expect(cancel).toHaveBeenCalled();
  });

  it('a network error is a failure, never a throw', async () => {
    const result = await requestTimestamp(DIGEST, {
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('timed out')),
    });
    expect(result).toEqual({ ok: false, reason: 'fetch: timed out' });
  });

  it('a rejected or unreadable reply is a failure', async () => {
    expect(await requestTimestamp(DIGEST, { fetchImpl: respond(statusOnly(2)) })).toMatchObject({
      ok: false,
      reason: 'rejected pki_status=2 reason=pki_status_2',
    });
    expect(
      await requestTimestamp(DIGEST, { fetchImpl: respond(new Uint8Array([1, 2, 3])) }),
    ).toMatchObject({ ok: false });
  });

  it('a forged reply is a failure, never a token', async () => {
    const forged = flip(RESPONSE, RESPONSE.length - 10);
    expect(
      await requestTimestamp(DIGEST, { fetchImpl: respond(forged), nonce: NONCE, now: NOW }),
    ).toEqual({ ok: false, reason: 'rejected pki_status=0 reason=signature_invalid' });
  });

  it('the real reply fails against a fresh random nonce, as a replay would', async () => {
    expect(await requestTimestamp(DIGEST, { fetchImpl: respond(RESPONSE), now: NOW })).toEqual({
      ok: false,
      reason: 'rejected pki_status=0 reason=nonce_mismatch',
    });
  });

  it('an unpinned issuer is a failure with its own reason', async () => {
    expect(
      await requestTimestamp(DIGEST, { fetchImpl: respond(THROWAWAY_CA), nonce: NONCE, now: NOW }),
    ).toEqual({ ok: false, reason: 'rejected pki_status=0 reason=unpinned_issuer' });
  });
});
