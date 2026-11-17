/**
 * RFC 3161 timestamps from DigiCert (AECI-1680, ADR 0057).
 *
 * The acceptance chain asks a third party to sign "this file hash existed at this time",
 * so the night's file cannot be back-dated by anyone who holds our Cloudflare account.
 * Chris chose DigiCert's public service (`http://timestamp.digicert.com`) on 2026-11-17.
 * Only the 32-byte SHA-256 of the file is sent. It is not personal data.
 *
 * The request is a fixed DER shape, so it is built by hand here instead of pulling an
 * ASN.1 library into the Worker:
 *
 *   TimeStampReq ::= SEQUENCE {
 *     version        INTEGER (1),
 *     messageImprint SEQUENCE { AlgorithmIdentifier (sha256, NULL), OCTET STRING (32) },
 *     nonce          INTEGER,
 *     certReq        BOOLEAN (TRUE) }
 *
 * The reply travels over plain HTTP, so anyone on the path can replace it. The token is
 * stored under an R2 bucket lock and can never be replaced, so the Worker verifies it
 * with Web Crypto before it counts as granted ({@link parseTimeStampResponse}):
 *
 * 1. TSTInfo: the message imprint is SHA-256 of our digest, the nonce is ours, and
 *    `genTime` is within 24 hours of now.
 * 2. SignerInfo: the `contentType` and `messageDigest` signed attributes match the
 *    TSTInfo, and the RSA signature over the signed attributes verifies under the
 *    signer certificate's key.
 * 3. Signer certificate: found in the token by the SignerInfo `sid`, valid at `genTime`,
 *    with a critical extended key usage of exactly `id-kp-timeStamping`.
 * 4. Chain pin: the signer certificate is signed by a pinned DigiCert intermediate key
 *    ({@link PINNED_TSA_ISSUERS}). An unpinned issuer is `unpinned_issuer`.
 *
 * The intermediate's own link to the DigiCert root is checked offline by
 * `openssl ts -verify` in `scripts/verify-acceptance-chain.ts`, against the pinned
 * `scripts/certs/digicert-tsa-chain.pem`. A spec keeps the pin and that file in step.
 */

import { discardResponseBody } from '@aeci/shared/response-drain';

/** DigiCert's public RFC 3161 endpoint. Plain HTTP is the published URL, and HTTPS fails
 *  TLS there. The Worker verifies the signed token, so transport security adds nothing. */
export const DIGICERT_TSA_URL = 'http://timestamp.digicert.com';

/** The request timeout. A slow TSA must not hold the nightly run. */
export const TSA_TIMEOUT_MS = 10_000;

/** How far `genTime` may sit from the Worker's clock. */
export const GEN_TIME_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * The issuer keys a DigiCert timestamp signer certificate must be signed by. Each is the
 * DER SubjectPublicKeyInfo of an intermediate in `scripts/certs/digicert-tsa-chain.pem`,
 * in base64. `rfc3161.spec.ts` checks every entry against that file.
 *
 * When DigiCert rotates to a new intermediate, every request fails with
 * `unpinned_issuer` and a later run retries it. Fetch the new intermediate from the CA
 * Issuers URL in the responder certificate, add it to the PEM file, and add its SPKI
 * here. `docs/runbooks/alerts.md` "Acceptance chain export" has the steps.
 */
export const PINNED_TSA_ISSUERS: readonly { subject: string; spkiBase64: string }[] = [
  {
    // C=US, O=DigiCert, Inc., CN=DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1
    // Certificate SHA-256: CA:0B:15:54:EC:D9:01:EA:19:DC:AD:87:49:E9:F2:64:8C:8D:6D:FC:EA:1A:DD:9D:2C:21:09:41:5B:B8:2C:CD
    // SPKI SHA-256:        6806f8c7f9c356a294a28796c4db6425d132ca877bf4fded0c2bb00e38807c28
    subject: 'DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1',
    spkiBase64:
      'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAtHgx0wqYQXK+PEbAHKx126NGaHS0URedTa2NDZS1mZaDLFTtQ2oR' +
      'jzUXMmxCqvkbsDpz4aH+qbxeLho8I6jY3xL1IusLopuW2qftJYJaDNs1+JH7Z+QdSKWM06qchUP+AbdJgMQB3h2DZ0Mal5kY' +
      'p77jYMVQXSZH++0trj6Ao+xh/AS7sQRuQL37QXbDhAktVJMQbzIBHYJBYgzWIjk8eDrYhXDEpKk7RdoX0M980EpLtlrNyHw0' +
      'Xm+nt5pnYJU3Gmq6bNMI1I7Gb5IBZK4ivbVCiZv7PNBYqHEpNVWC2ZQ8BbfnFRQVESYOszFI2Wv82wnJRfN20VRS3hpLgIR4' +
      'hjzL0hpoYGk81coWJ+KdPvMvaB0WkE/2qHxJ0ucS638ZxqU14lDnki7CcoKCz6eum5A19WZQHkqUJfdkDjHkccpL6uoG8pbF' +
      '0LJAQQZxst7VvwDDjAmSFTUms+wV/FbWBqi7fTJnjq3hj0XbQcd8hjj/q8d6ylgxCZSKi17yVp2NL+cnT6Toy+rN+nM8M7Ln' +
      'LqCrO2JP3oW//1sfuZDKiDEb1AQ8es9Xr/u6bDTnYCTKIsDq1BtmXUqEG1NqzJKS4kOmxkYp2WyODi7vQTCBZtVFJfVZ3j7O' +
      'gWmnhFr4yUozZtqgPrHRVHhGNKlYzyjlroPxul+bgIspzOwbtmsgY1MCAwEAAQ==',
  },
];

/** DER for `AlgorithmIdentifier { id-sha256 (2.16.840.1.101.3.4.2.1), NULL }`. */
const SHA256_ALGORITHM = [
  0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00,
];

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) throw new Error('rfc3161: bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** A DER length. Every length this file writes is under 128, but the long form is cheap. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, content: ArrayLike<number>): number[] {
  return [tag, ...derLength(content.length), ...Array.from(content)];
}

/** A DER INTEGER from unsigned big-endian bytes: minimal, and positive. */
function derUnsignedInteger(bytes: Uint8Array): number[] {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const body = Array.from(bytes.subarray(start));
  if (body.length === 0) body.push(0);
  if (body[0]! & 0x80) body.unshift(0);
  return tlv(0x02, body);
}

/**
 * The DER `TimeStampReq` for a SHA-256 digest (64 hex chars) and a nonce (1 to 16
 * bytes). `certReq` is TRUE, so the token carries the TSA's signing certificate.
 */
export function buildTimeStampRequest(sha256HexDigest: string, nonce: Uint8Array): Uint8Array {
  const digest = hexToBytes(sha256HexDigest);
  if (digest.length !== 32) throw new Error('rfc3161: the digest must be 32 bytes');
  if (nonce.length < 1 || nonce.length > 16) throw new Error('rfc3161: nonce of 1 to 16 bytes');
  const version = tlv(0x02, [0x01]);
  const imprint = tlv(0x30, [...SHA256_ALGORITHM, ...tlv(0x04, digest)]);
  const certReq = tlv(0x01, [0xff]);
  return new Uint8Array(
    tlv(0x30, [...version, ...imprint, ...derUnsignedInteger(nonce), ...certReq]),
  );
}

interface Der {
  tag: number;
  /** Offset of the tag byte. */
  offset: number;
  /** Offset of the first content byte. */
  start: number;
  /** Offset just past the last content byte. */
  end: number;
}

/** Read one TLV at `offset`. Throws on a truncated or indefinite-length encoding. */
function readDer(bytes: Uint8Array, offset: number): Der {
  if (offset + 2 > bytes.length) throw new Error('rfc3161: truncated DER');
  const tag = bytes[offset]!;
  let len = bytes[offset + 1]!;
  let start = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('rfc3161: unsupported DER length');
    if (start + n > bytes.length) throw new Error('rfc3161: truncated DER');
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + bytes[start + i]!;
    start += n;
  }
  const end = start + len;
  if (end > bytes.length) throw new Error('rfc3161: truncated DER');
  return { tag, offset, start, end };
}

/** The children of a constructed TLV, in order. */
function children(bytes: Uint8Array, der: Der): Der[] {
  const out: Der[] = [];
  for (let at = der.start; at < der.end; ) {
    const child = readDer(bytes, at);
    if (child.end > der.end) throw new Error('rfc3161: child overruns its parent');
    out.push(child);
    at = child.end;
  }
  return out;
}

/** A copy of a TLV's content bytes. */
const content = (bytes: Uint8Array, der: Der) => bytes.slice(der.start, der.end);
/** A copy of a whole TLV, header included. */
const whole = (bytes: Uint8Array, der: Der) => bytes.slice(der.offset, der.end);

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function contentEquals(bytes: Uint8Array, der: Der, expected: readonly number[]): boolean {
  if (der.end - der.start !== expected.length) return false;
  return expected.every((b, i) => bytes[der.start + i] === b);
}

/** INTEGER content without its sign-padding zeros, so `00 80` and `80` compare equal. */
function unsignedMagnitude(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  return bytes.subarray(start);
}

// ── OIDs (DER content bytes) ─────────────────────────────────────────────────
/** `id-signedData`, 1.2.840.113549.1.7.2. */
const OID_SIGNED_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
/** `id-ct-TSTInfo`, 1.2.840.113549.1.9.16.1.4. */
const OID_TST_INFO = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04];
/** `id-contentType`, 1.2.840.113549.1.9.3. */
const OID_CONTENT_TYPE = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03];
/** `id-messageDigest`, 1.2.840.113549.1.9.4. */
const OID_MESSAGE_DIGEST = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04];
/** `rsaEncryption`, 1.2.840.113549.1.1.1: PKCS #1 v1.5 with the SignerInfo digest. */
const OID_RSA_ENCRYPTION = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
/** `id-ce-extKeyUsage`, 2.5.29.37. */
const OID_EXT_KEY_USAGE = [0x55, 0x1d, 0x25];
/** `id-ce-subjectKeyIdentifier`, 2.5.29.14. */
const OID_SUBJECT_KEY_ID = [0x55, 0x1d, 0x0e];
/** `id-kp-timeStamping`, 1.3.6.1.5.5.7.3.8. */
const OID_KP_TIME_STAMPING = [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x08];

type HashName = 'SHA-256' | 'SHA-384' | 'SHA-512';

/** `id-sha256/384/512`, 2.16.840.1.101.3.4.2.{1,2,3}. */
const DIGEST_OIDS: readonly [readonly number[], HashName][] = [
  [[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01], 'SHA-256'],
  [[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02], 'SHA-384'],
  [[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03], 'SHA-512'],
];

/** `sha{256,384,512}WithRSAEncryption`, 1.2.840.113549.1.1.{11,12,13}. */
const RSA_SIGNATURE_OIDS: readonly [readonly number[], HashName][] = [
  [[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b], 'SHA-256'],
  [[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0c], 'SHA-384'],
  [[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0d], 'SHA-512'],
];

function lookupOid(
  bytes: Uint8Array,
  oid: Der | undefined,
  table: readonly [readonly number[], HashName][],
): HashName | null {
  if (!oid || oid.tag !== 0x06) return null;
  for (const [value, name] of table) if (contentEquals(bytes, oid, value)) return name;
  return null;
}

// ── Verification ─────────────────────────────────────────────────────────────

/** Why a reply was not granted. Every value is safe to log. */
export type TimeStampRejectReason =
  | `pki_status_${number}`
  | 'no_token'
  | 'token_malformed'
  | 'content_not_tstinfo'
  | 'imprint_algorithm'
  | 'digest_mismatch'
  | 'nonce_mismatch'
  | 'gen_time_invalid'
  | 'gen_time_skew'
  | 'signer_count'
  | 'digest_algorithm_unsupported'
  | 'signed_attrs_missing'
  | 'content_type_attr'
  | 'message_digest_mismatch'
  | 'signature_algorithm_unsupported'
  | 'signer_cert_missing'
  | 'signer_cert_validity'
  | 'signer_cert_eku'
  | 'signer_key_unsupported'
  | 'signature_invalid'
  | 'unpinned_issuer';

/** Thrown inside the verifier and caught by {@link parseTimeStampResponse}. */
class TokenRejected extends Error {
  constructor(readonly reason: TimeStampRejectReason) {
    super(reason);
  }
}
function reject(reason: TimeStampRejectReason): never {
  throw new TokenRejected(reason);
}

/** What the reply must match: the digest and nonce we sent, and the Worker's clock. */
export interface TimeStampExpectation {
  sha256HexDigest: string;
  nonce: Uint8Array;
  now: Date;
}

/** `PKIStatus`: 0 granted, 1 grantedWithMods, 2 rejection, 3 waiting, 4 and 5 revocation. */
export type TimeStampStatus = 'granted' | 'rejected';

export interface ParsedTimeStampResponse {
  /** The raw `PKIStatus` integer. */
  pkiStatus: number;
  /** `granted` only when `verified` is true. */
  status: TimeStampStatus;
  /** True when a `timeStampToken` follows the status. */
  hasToken: boolean;
  /** True when every check in the header comment passed. */
  verified: boolean;
  /** The first check that failed, when `verified` is false. */
  reason?: TimeStampRejectReason;
  /** TSTInfo `genTime` as an ISO string, when verified. */
  genTime?: string;
}

/** `UTCTime` (0x17) or `GeneralizedTime` (0x18), `Z` form only. Null when unreadable. */
function parseDerTime(bytes: Uint8Array, der: Der): Date | null {
  const text = String.fromCharCode(...content(bytes, der));
  let m: RegExpMatchArray | null;
  let year: number;
  let ms = 0;
  if (der.tag === 0x17) {
    m = text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) return null;
    const yy = Number(m[1]);
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
  } else if (der.tag === 0x18) {
    m = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,9}))?Z$/);
    if (!m) return null;
    year = Number(m[1]);
    if (m[7]) ms = Math.floor(Number(`0.${m[7]}`) * 1000);
  } else {
    return null;
  }
  const [month, day, hour, minute, second] = m.slice(2, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  // Reject rollovers such as month 13 or 31 February.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return date;
}

/**
 * TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber, genTime,
 * accuracy OPTIONAL, ordering DEFAULT FALSE, nonce OPTIONAL, tsa [0] OPTIONAL,
 * extensions [1] OPTIONAL }. Checks the imprint, nonce and time. Returns `genTime`.
 */
function checkTstInfo(bytes: Uint8Array, octets: Der, expected: TimeStampExpectation): Date {
  const tst = readDer(bytes, octets.start);
  if (tst.tag !== 0x30 || tst.end !== octets.end) reject('token_malformed');
  const fields = children(bytes, tst);
  const [version, policy, imprint, serial, genTimeDer] = fields;
  if (
    version?.tag !== 0x02 ||
    policy?.tag !== 0x06 ||
    imprint?.tag !== 0x30 ||
    serial?.tag !== 0x02 ||
    genTimeDer?.tag !== 0x18
  ) {
    reject('token_malformed');
  }

  const [hashAlg, hashed] = children(bytes, imprint!);
  if (hashAlg?.tag !== 0x30 || hashed?.tag !== 0x04) reject('token_malformed');
  const [algOid, ...params] = children(bytes, hashAlg!);
  const nullParams =
    params.length === 0 ||
    (params.length === 1 && params[0]!.tag === 0x05 && params[0]!.end === params[0]!.start);
  if (lookupOid(bytes, algOid, DIGEST_OIDS) !== 'SHA-256' || !nullParams) {
    reject('imprint_algorithm');
  }
  if (!bytesEqual(content(bytes, hashed!), hexToBytes(expected.sha256HexDigest))) {
    reject('digest_mismatch');
  }

  // After genTime: accuracy (SEQUENCE), ordering (BOOLEAN), nonce (INTEGER), [0], [1].
  const nonce = fields.slice(5).find((f) => f.tag === 0x02);
  if (
    !nonce ||
    !bytesEqual(unsignedMagnitude(content(bytes, nonce)), unsignedMagnitude(expected.nonce))
  ) {
    reject('nonce_mismatch');
  }

  const genTime = parseDerTime(bytes, genTimeDer!);
  if (!genTime) return reject('gen_time_invalid');
  if (Math.abs(genTime.getTime() - expected.now.getTime()) > GEN_TIME_TOLERANCE_MS) {
    reject('gen_time_skew');
  }
  return genTime;
}

interface Certificate {
  /** `TBSCertificate`, header included: the bytes the issuer signed. */
  tbs: Uint8Array<ArrayBuffer>;
  /** The issuer's signature algorithm, when it is RSA PKCS #1 v1.5. */
  signatureHash: HashName | null;
  /** The signature BIT STRING without its unused-bits byte. */
  signature: Uint8Array<ArrayBuffer>;
  issuer: Uint8Array;
  serial: Uint8Array;
  notBefore: Date | null;
  notAfter: Date | null;
  spki: Uint8Array<ArrayBuffer>;
  subjectKeyId: Uint8Array | null;
  /** True when the EKU extension is critical and lists exactly `id-kp-timeStamping`. */
  timeStampingOnly: boolean;
}

function parseCertificate(bytes: Uint8Array, cert: Der): Certificate {
  const [tbs, sigAlg, sigValue] = children(bytes, cert);
  if (tbs?.tag !== 0x30 || sigAlg?.tag !== 0x30 || sigValue?.tag !== 0x03) {
    reject('token_malformed');
  }
  const t = children(bytes, tbs!);
  let i = t[0]?.tag === 0xa0 ? 1 : 0;
  const serial = t[i++];
  const innerSigAlg = t[i++];
  const issuer = t[i++];
  const validity = t[i++];
  i += 1; // subject
  const spki = t[i++];
  if (
    serial?.tag !== 0x02 ||
    innerSigAlg?.tag !== 0x30 ||
    issuer?.tag !== 0x30 ||
    validity?.tag !== 0x30 ||
    spki?.tag !== 0x30
  ) {
    reject('token_malformed');
  }
  const [notBefore, notAfter] = children(bytes, validity!);

  let subjectKeyId: Uint8Array | null = null;
  let timeStampingOnly = false;
  const extensions = t.slice(i).find((d) => d.tag === 0xa3);
  if (extensions) {
    const [list] = children(bytes, extensions);
    for (const ext of list ? children(bytes, list) : []) {
      const parts = children(bytes, ext);
      const oid = parts[0];
      const critical =
        parts.length === 3 && parts[1]!.tag === 0x01 && bytes[parts[1]!.start] === 0xff;
      const value = parts[parts.length - 1];
      if (!oid || oid.tag !== 0x06 || value?.tag !== 0x04) continue;
      if (contentEquals(bytes, oid, OID_SUBJECT_KEY_ID)) {
        const inner = readDer(bytes, value.start);
        if (inner.tag === 0x04) subjectKeyId = content(bytes, inner);
      } else if (contentEquals(bytes, oid, OID_EXT_KEY_USAGE)) {
        const purposes = children(bytes, readDer(bytes, value.start));
        timeStampingOnly =
          critical &&
          purposes.length === 1 &&
          purposes[0]!.tag === 0x06 &&
          contentEquals(bytes, purposes[0]!, OID_KP_TIME_STAMPING);
      }
    }
  }

  // The algorithm inside TBSCertificate must match the one outside it (RFC 5280 4.1.1.2).
  const sameAlg = bytesEqual(whole(bytes, sigAlg!), whole(bytes, innerSigAlg!));
  const [sigAlgOid] = children(bytes, sigAlg!);
  return {
    tbs: whole(bytes, tbs!),
    signatureHash: sameAlg ? lookupOid(bytes, sigAlgOid, RSA_SIGNATURE_OIDS) : null,
    signature: bytes.slice(sigValue!.start + 1, sigValue!.end),
    issuer: whole(bytes, issuer!),
    serial: unsignedMagnitude(content(bytes, serial!)),
    notBefore: notBefore ? parseDerTime(bytes, notBefore) : null,
    notAfter: notAfter ? parseDerTime(bytes, notAfter) : null,
    spki: whole(bytes, spki!),
    subjectKeyId,
    timeStampingOnly,
  };
}

/** The certificate named by the SignerInfo `sid`: issuerAndSerialNumber or [0] SKI. */
function findSignerCert(bytes: Uint8Array, certs: Der | null, sid: Der): Certificate {
  if (!certs) return reject('signer_cert_missing');
  let match: (c: Certificate) => boolean;
  if (sid.tag === 0x30) {
    const [issuer, serial] = children(bytes, sid);
    if (issuer?.tag !== 0x30 || serial?.tag !== 0x02) return reject('token_malformed');
    const wantIssuer = whole(bytes, issuer);
    const wantSerial = unsignedMagnitude(content(bytes, serial));
    match = (c) => bytesEqual(c.issuer, wantIssuer) && bytesEqual(c.serial, wantSerial);
  } else if (sid.tag === 0x80) {
    const wantKeyId = content(bytes, sid);
    match = (c) => c.subjectKeyId !== null && bytesEqual(c.subjectKeyId, wantKeyId);
  } else {
    return reject('token_malformed');
  }
  // CertificateChoices: only a plain Certificate (SEQUENCE) can be the signer.
  for (const der of children(bytes, certs)) {
    if (der.tag !== 0x30) continue;
    const cert = parseCertificate(bytes, der);
    if (match(cert)) return cert;
  }
  return reject('signer_cert_missing');
}

async function importRsaKey(spki: Uint8Array<ArrayBuffer>, hash: HashName): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash }, false, [
    'verify',
  ]);
}

/** True when a pinned issuer key verifies the certificate's signature. */
async function issuedByPinnedKey(cert: Certificate): Promise<boolean> {
  if (!cert.signatureHash) return false;
  for (const pin of PINNED_TSA_ISSUERS) {
    const key = await importRsaKey(base64ToBytes(pin.spkiBase64), cert.signatureHash);
    if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, cert.signature, cert.tbs)) {
      return true;
    }
  }
  return false;
}

/**
 * SignerInfo ::= SEQUENCE { version, sid, digestAlgorithm, [0] signedAttrs,
 * signatureAlgorithm, signature, [1] unsignedAttrs OPTIONAL }.
 */
async function checkSigner(
  bytes: Uint8Array,
  signerInfo: Der,
  eContent: Der,
  certs: Der | null,
  genTime: Date,
): Promise<void> {
  const parts = children(bytes, signerInfo);
  const [version, sid, digestAlg] = parts;
  if (version?.tag !== 0x02 || !sid || digestAlg?.tag !== 0x30) reject('token_malformed');
  const signedAttrs = parts[3]?.tag === 0xa0 ? parts[3] : null;
  if (!signedAttrs) return reject('signed_attrs_missing');
  const [sigAlg, signature] = parts.slice(4);
  if (sigAlg?.tag !== 0x30 || signature?.tag !== 0x04) reject('token_malformed');

  const digestHash = lookupOid(bytes, children(bytes, digestAlg!)[0], DIGEST_OIDS);
  if (!digestHash) return reject('digest_algorithm_unsupported');

  // Each of contentType and messageDigest exactly once, with exactly one value.
  let contentType: Der | null = null;
  let messageDigest: Der | null = null;
  for (const attr of children(bytes, signedAttrs)) {
    const [type, values] = children(bytes, attr);
    if (type?.tag !== 0x06 || values?.tag !== 0x31) reject('token_malformed');
    const vals = children(bytes, values!);
    if (contentEquals(bytes, type!, OID_CONTENT_TYPE)) {
      if (contentType || vals.length !== 1) reject('content_type_attr');
      contentType = vals[0]!;
    } else if (contentEquals(bytes, type!, OID_MESSAGE_DIGEST)) {
      if (messageDigest || vals.length !== 1) reject('message_digest_mismatch');
      messageDigest = vals[0]!;
    }
  }
  if (
    !contentType ||
    contentType.tag !== 0x06 ||
    !contentEquals(bytes, contentType, OID_TST_INFO)
  ) {
    reject('content_type_attr');
  }
  const eContentHash = new Uint8Array(
    await crypto.subtle.digest(digestHash, content(bytes, eContent)),
  );
  if (
    !messageDigest ||
    messageDigest.tag !== 0x04 ||
    !bytesEqual(content(bytes, messageDigest), eContentHash)
  ) {
    reject('message_digest_mismatch');
  }

  const sigAlgOid = children(bytes, sigAlg!)[0];
  const signatureHash =
    sigAlgOid?.tag === 0x06 && contentEquals(bytes, sigAlgOid, OID_RSA_ENCRYPTION)
      ? digestHash
      : lookupOid(bytes, sigAlgOid, RSA_SIGNATURE_OIDS);
  if (!signatureHash) return reject('signature_algorithm_unsupported');

  const cert = findSignerCert(bytes, certs, sid!);
  if (!cert.notBefore || !cert.notAfter || genTime < cert.notBefore || genTime > cert.notAfter) {
    reject('signer_cert_validity');
  }
  if (!cert.timeStampingOnly) reject('signer_cert_eku');

  let key: CryptoKey;
  try {
    key = await importRsaKey(cert.spki, signatureHash);
  } catch {
    return reject('signer_key_unsupported');
  }
  // The signature covers the DER of signedAttrs as a SET (RFC 5652 5.4), not as [0].
  const signed = whole(bytes, signedAttrs);
  signed[0] = 0x31;
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, content(bytes, signature!), signed))) {
    reject('signature_invalid');
  }

  if (!(await issuedByPinnedKey(cert))) reject('unpinned_issuer');
}

/**
 * Verify a `timeStampToken`: ContentInfo { id-signedData, [0] SignedData { version,
 * digestAlgorithms, encapContentInfo { id-ct-TSTInfo, [0] OCTET STRING },
 * [0] certificates, [1] crls OPTIONAL, signerInfos } }. Returns `genTime`.
 */
async function verifyToken(
  bytes: Uint8Array,
  token: Der,
  expected: TimeStampExpectation,
): Promise<Date> {
  if (token.tag !== 0x30) reject('token_malformed');
  const [contentTypeOid, explicit] = children(bytes, token);
  if (
    contentTypeOid?.tag !== 0x06 ||
    !contentEquals(bytes, contentTypeOid, OID_SIGNED_DATA) ||
    explicit?.tag !== 0xa0
  ) {
    reject('token_malformed');
  }
  const [signedData] = children(bytes, explicit!);
  if (signedData?.tag !== 0x30) reject('token_malformed');
  const parts = children(bytes, signedData!);
  let i = 0;
  const version = parts[i++];
  const digestAlgorithms = parts[i++];
  const encap = parts[i++];
  const certs = parts[i]?.tag === 0xa0 ? parts[i++]! : null;
  if (parts[i]?.tag === 0xa1) i += 1;
  const signerInfos = parts[i++];
  if (
    version?.tag !== 0x02 ||
    digestAlgorithms?.tag !== 0x31 ||
    encap?.tag !== 0x30 ||
    signerInfos?.tag !== 0x31 ||
    i !== parts.length
  ) {
    reject('token_malformed');
  }

  const [eType, eContentExplicit] = children(bytes, encap!);
  if (eType?.tag !== 0x06 || !contentEquals(bytes, eType, OID_TST_INFO)) {
    reject('content_not_tstinfo');
  }
  if (eContentExplicit?.tag !== 0xa0) reject('token_malformed');
  const [octets] = children(bytes, eContentExplicit!);
  if (octets?.tag !== 0x04) reject('token_malformed');

  const genTime = checkTstInfo(bytes, octets!, expected);

  // RFC 3161 2.4.2: exactly one signer, the TSA.
  const signers = children(bytes, signerInfos!);
  if (signers.length !== 1 || signers[0]!.tag !== 0x30) reject('signer_count');
  await checkSigner(bytes, signers[0]!, octets!, certs, genTime);
  return genTime;
}

/**
 * Read and verify a DER `TimeStampResp`. `status` is `granted` only when `PKIStatus` is
 * 0 or 1 and the token passes every check in the header comment. Any failed check is
 * `rejected` with a `reason`, so the reply is never stored and a later run retries.
 * Throws only on bytes that are not a `TimeStampResp` at all.
 */
export async function parseTimeStampResponse(
  bytes: Uint8Array,
  expected: TimeStampExpectation,
): Promise<ParsedTimeStampResponse> {
  const outer = readDer(bytes, 0);
  if (outer.tag !== 0x30) throw new Error('rfc3161: response is not a SEQUENCE');
  const statusInfo = readDer(bytes, outer.start);
  if (statusInfo.tag !== 0x30) throw new Error('rfc3161: PKIStatusInfo is not a SEQUENCE');
  const statusInt = readDer(bytes, statusInfo.start);
  if (statusInt.tag !== 0x02 || statusInt.end - statusInt.start > 4) {
    throw new Error('rfc3161: PKIStatus is not a small INTEGER');
  }
  let pkiStatus = 0;
  for (let i = statusInt.start; i < statusInt.end; i += 1) pkiStatus = pkiStatus * 256 + bytes[i]!;
  const hasToken = statusInfo.end < outer.end;
  const rejected = (reason: TimeStampRejectReason): ParsedTimeStampResponse => ({
    pkiStatus,
    status: 'rejected',
    hasToken,
    verified: false,
    reason,
  });
  if (pkiStatus !== 0 && pkiStatus !== 1) return rejected(`pki_status_${pkiStatus}`);
  if (!hasToken) return rejected('no_token');
  try {
    const genTime = await verifyToken(bytes, readDer(bytes, statusInfo.end), expected);
    return {
      pkiStatus,
      status: 'granted',
      hasToken,
      verified: true,
      genTime: genTime.toISOString(),
    };
  } catch (error) {
    // A DER error inside the token, or Web Crypto refusing a malformed input.
    return rejected(error instanceof TokenRejected ? error.reason : 'token_malformed');
  }
}

/** Verifies a reply. Production always uses {@link parseTimeStampResponse}. */
export type TimeStampVerifier = (
  bytes: Uint8Array,
  expected: TimeStampExpectation,
) => Promise<ParsedTimeStampResponse>;

export type TimeStampResult = { ok: true; token: ArrayBuffer } | { ok: false; reason: string };

/**
 * Ask DigiCert to timestamp a SHA-256 digest. Never throws: a network error, a timeout,
 * a non-200 status, or a reply that fails verification is `{ ok: false, reason }`. The
 * caller records the failure and a later run retries it. `fetchImpl` lets a spec stub
 * the network. `now` is the clock `genTime` is checked against. `verify` is a spec seam
 * for the export's flow tests. No production caller passes it.
 */
export async function requestTimestamp(
  sha256HexDigest: string,
  opts: {
    fetchImpl?: typeof fetch;
    url?: string;
    nonce?: Uint8Array;
    now?: Date;
    verify?: TimeStampVerifier;
  } = {},
): Promise<TimeStampResult> {
  const nonce = opts.nonce ?? crypto.getRandomValues(new Uint8Array(8));
  let body: Uint8Array;
  try {
    body = buildTimeStampRequest(sha256HexDigest, nonce);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(opts.url ?? DIGICERT_TSA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/timestamp-query' },
      body: body as BodyInit,
      signal: AbortSignal.timeout(TSA_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `fetch: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (res.status !== 200) {
    discardResponseBody(res);
    return { ok: false, reason: `http_${res.status}` };
  }
  let token: ArrayBuffer;
  try {
    token = await res.arrayBuffer();
  } catch (error) {
    return { ok: false, reason: `body: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const verify = opts.verify ?? parseTimeStampResponse;
    const parsed = await verify(new Uint8Array(token), {
      sha256HexDigest,
      nonce,
      now: opts.now ?? new Date(),
    });
    if (parsed.status !== 'granted' || !parsed.verified) {
      return {
        ok: false,
        reason: `rejected pki_status=${parsed.pkiStatus} reason=${parsed.reason ?? 'unverified'}`,
      };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, token };
}
