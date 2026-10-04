/**
 * Svix signature verification for the Resend delivery webhook (AECI-1222). The first case
 * is Svix's own published test vector, so the construction is checked against an outside
 * answer and not only against itself.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SVIX_TOLERANCE_SECONDS, verifySvixSignature } from './resend-webhook-auth';

// From https://docs.svix.com/receiving/verifying-payloads/how-manual (read 2026-10-02).
const DOC_SECRET = 'whsec_plJ3nmyCDGBKInavdOK15jsl';
const DOC_ID = 'msg_loFOjxBNrRLzqYUf';
const DOC_TS = '1731705121';
const DOC_BODY = '{"event_type":"ping","data":{"success":true}}';
const DOC_SIG = 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=';
const DOC_NOW = 1731705121 * 1000;

const SECRET_BYTES = Buffer.from('a-test-signing-key-of-some-length');
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;

function sign(id: string, ts: string, body: string, key = SECRET_BYTES): string {
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}

const base = (over: Partial<Parameters<typeof verifySvixSignature>[0]> = {}) => ({
  id: 'msg_1',
  timestamp: '1700000000',
  signature: sign('msg_1', '1700000000', '{"a":1}'),
  rawBody: '{"a":1}',
  secret: SECRET,
  nowMs: 1700000000 * 1000,
  ...over,
});

describe('verifySvixSignature', () => {
  it("accepts Svix's published test vector", async () => {
    expect(
      await verifySvixSignature({
        id: DOC_ID,
        timestamp: DOC_TS,
        signature: DOC_SIG,
        rawBody: DOC_BODY,
        secret: DOC_SECRET,
        nowMs: DOC_NOW,
      }),
    ).toEqual({ ok: true });
  });

  it('accepts a correctly signed request', async () => {
    expect(await verifySvixSignature(base())).toEqual({ ok: true });
  });

  it('accepts when any one of several space-separated entries matches (secret rotation)', async () => {
    const good = sign('msg_1', '1700000000', '{"a":1}');
    const other = sign('msg_1', '1700000000', '{"a":1}', Buffer.from('old-key'));
    expect(await verifySvixSignature(base({ signature: `${other} ${good}` }))).toEqual({
      ok: true,
    });
  });

  it('rejects a body changed by one byte', async () => {
    expect(await verifySvixSignature(base({ rawBody: '{"a":2}' }))).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects a signature made with another secret', async () => {
    const forged = sign('msg_1', '1700000000', '{"a":1}', Buffer.from('attacker'));
    expect(await verifySvixSignature(base({ signature: forged }))).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects a non-v1 entry even when its value is right', async () => {
    const value = sign('msg_1', '1700000000', '{"a":1}').slice(3);
    expect(await verifySvixSignature(base({ signature: `v2,${value}` }))).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects a swapped svix-id, because the id is signed', async () => {
    expect(await verifySvixSignature(base({ id: 'msg_2' }))).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects a missing header', async () => {
    for (const over of [{ id: undefined }, { timestamp: undefined }, { signature: undefined }]) {
      expect(await verifySvixSignature(base(over))).toEqual({
        ok: false,
        reason: 'missing_headers',
      });
    }
  });

  it('fails closed when the secret is unset or not whsec_ base64', async () => {
    expect(await verifySvixSignature(base({ secret: undefined }))).toEqual({
      ok: false,
      reason: 'missing_secret',
    });
    expect(await verifySvixSignature(base({ secret: '' }))).toEqual({
      ok: false,
      reason: 'missing_secret',
    });
    expect(await verifySvixSignature(base({ secret: 'whsec_not base64!' }))).toEqual({
      ok: false,
      reason: 'bad_secret',
    });
  });

  it('rejects a timestamp more than five minutes off, in either direction', async () => {
    const now = 1700000000 * 1000;
    const late = now + (SVIX_TOLERANCE_SECONDS + 1) * 1000;
    const early = now - (SVIX_TOLERANCE_SECONDS + 1) * 1000;
    expect(await verifySvixSignature(base({ nowMs: late }))).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(await verifySvixSignature(base({ nowMs: early }))).toEqual({
      ok: false,
      reason: 'stale',
    });
    // Inside the window passes.
    expect(await verifySvixSignature(base({ nowMs: now + SVIX_TOLERANCE_SECONDS * 1000 }))).toEqual(
      { ok: true },
    );
  });

  it('rejects a non-numeric timestamp as stale', async () => {
    expect(await verifySvixSignature(base({ timestamp: 'soon' }))).toEqual({
      ok: false,
      reason: 'stale',
    });
  });
});
