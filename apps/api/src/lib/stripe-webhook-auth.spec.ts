/**
 * `Stripe-Signature` verification (AECI-1500). The expected signature is built with Node's
 * own HMAC, so the spec checks the WebCrypto path against an independent implementation.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  parseStripeSignatureHeader,
  STRIPE_SIGNATURE_TOLERANCE_SECONDS,
  verifyStripeSignature,
} from './stripe-webhook-auth';

const SECRET = 'whsec_test_secret_value';
const NOW_MS = Date.UTC(2026, 9, 28, 12, 0, 0);
const T = Math.floor(NOW_MS / 1000);
const BODY = '{"id":"evt_1","type":"invoice.paid"}';

const sign = (body: string, t: number, secret = SECRET) =>
  createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

const verify = (header: string | undefined, over: { secret?: string; body?: string } = {}) =>
  verifyStripeSignature({
    header,
    rawBody: over.body ?? BODY,
    secret: 'secret' in over ? over.secret : SECRET,
    nowMs: NOW_MS,
  });

describe('verifyStripeSignature', () => {
  it('accepts a valid v1 signature and returns the timestamp', async () => {
    expect(await verify(`t=${T},v1=${sign(BODY, T)}`)).toEqual({ ok: true, timestamp: T });
  });

  it('accepts when any v1 entry matches (a secret roll) and ignores v0', async () => {
    const header = `t=${T},v0=deadbeef,v1=${'0'.repeat(64)},v1=${sign(BODY, T)}`;
    expect((await verify(header)).ok).toBe(true);
  });

  it('fails closed with no secret', async () => {
    expect(await verify(`t=${T},v1=${sign(BODY, T)}`, { secret: undefined })).toEqual({
      ok: false,
      reason: 'missing_secret',
    });
    expect(await verify(`t=${T},v1=${sign(BODY, T)}`, { secret: '  ' })).toEqual({
      ok: false,
      reason: 'missing_secret',
    });
  });

  it('refuses a missing or malformed header', async () => {
    expect(await verify(undefined)).toEqual({ ok: false, reason: 'missing_header' });
    expect(await verify(`v1=${sign(BODY, T)}`)).toEqual({ ok: false, reason: 'malformed_header' });
    expect(await verify(`t=${T}`)).toEqual({ ok: false, reason: 'malformed_header' });
    expect(await verify(`t=soon,v1=${sign(BODY, T)}`)).toEqual({
      ok: false,
      reason: 'malformed_header',
    });
  });

  it('refuses a timestamp outside five minutes, either way', async () => {
    const old = T - STRIPE_SIGNATURE_TOLERANCE_SECONDS - 1;
    const future = T + STRIPE_SIGNATURE_TOLERANCE_SECONDS + 1;
    expect(await verify(`t=${old},v1=${sign(BODY, old)}`)).toEqual({ ok: false, reason: 'stale' });
    expect(await verify(`t=${future},v1=${sign(BODY, future)}`)).toEqual({
      ok: false,
      reason: 'stale',
    });
    const edge = T - STRIPE_SIGNATURE_TOLERANCE_SECONDS;
    expect((await verify(`t=${edge},v1=${sign(BODY, edge)}`)).ok).toBe(true);
  });

  it('refuses a signature over another body, timestamp or secret', async () => {
    expect(await verify(`t=${T},v1=${sign('{}', T)}`)).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verify(`t=${T},v1=${sign(BODY, T - 1)}`)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(await verify(`t=${T},v1=${sign(BODY, T, 'whsec_other')}`)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });
});

describe('parseStripeSignatureHeader', () => {
  it('reads the first t and every v1, lower-cased, skipping junk', () => {
    expect(parseStripeSignatureHeader('t=1,v1=AB,junk,v1=cd,t=2,v0=ee')).toEqual({
      timestamp: '1',
      signatures: ['ab', 'cd'],
    });
  });
});
