/**
 * The AECI-1198 tier delivery policy: outside recipients get mail from production only.
 * Every tier is checked against an allowlisted address, an outside address, mixed case
 * and the two subdomain lookalikes. A missing or unknown `ENV` must fail closed.
 */

import { describe, expect, it } from 'vitest';

import {
  INTERNAL_RECIPIENT_DOMAINS,
  isInternalRecipient,
  isProductionTier,
  partitionRecipients,
  tierLabel,
  tierSubject,
} from './delivery-policy';

const INTERNAL = 'chrisw@thewbsproject.com';
const INTERNAL_2 = 'support@aecintegrations.com';
const MIXED_CASE = 'Support@AECIntegrations.COM';
const OUTSIDE = 'seat@vendor.example';
const PREFIX_LOOKALIKE = 'x@evilthewbsproject.com';
const SUFFIX_LOOKALIKE = 'x@thewbsproject.com.evil.io';
const SUBDOMAIN = 'x@mail.thewbsproject.com';

const NON_PRODUCTION = ['development', 'preview', 'staging', 'demo'] as const;

describe('isProductionTier', () => {
  it('is true only for ENV=production', () => {
    expect(isProductionTier({ ENV: 'production' })).toBe(true);
    for (const tier of NON_PRODUCTION) expect(isProductionTier({ ENV: tier })).toBe(false);
  });

  it('fails closed on a missing, empty or unknown ENV', () => {
    expect(isProductionTier({})).toBe(false);
    expect(isProductionTier({ ENV: undefined })).toBe(false);
    expect(isProductionTier({ ENV: '' })).toBe(false);
    expect(isProductionTier({ ENV: 'prod' })).toBe(false);
    expect(isProductionTier({ ENV: 'Production' })).toBe(false);
  });
});

describe('isInternalRecipient', () => {
  it('holds exactly the two internal domains', () => {
    expect([...INTERNAL_RECIPIENT_DOMAINS]).toEqual(['thewbsproject.com', 'aecintegrations.com']);
  });

  it('accepts both domains, in any case, bare or display-name form', () => {
    expect(isInternalRecipient(INTERNAL)).toBe(true);
    expect(isInternalRecipient(INTERNAL_2)).toBe(true);
    expect(isInternalRecipient(MIXED_CASE)).toBe(true);
    expect(isInternalRecipient(`  ${INTERNAL}  `)).toBe(true);
    expect(isInternalRecipient(`AECi Support <${INTERNAL_2}>`)).toBe(true);
  });

  it('rejects outside domains, lookalikes and subdomains', () => {
    expect(isInternalRecipient(OUTSIDE)).toBe(false);
    expect(isInternalRecipient(PREFIX_LOOKALIKE)).toBe(false);
    expect(isInternalRecipient(SUFFIX_LOOKALIKE)).toBe(false);
    expect(isInternalRecipient(SUBDOMAIN)).toBe(false);
  });

  it('reads the domain after the LAST @', () => {
    expect(isInternalRecipient('a@thewbsproject.com@vendor.example')).toBe(false);
    expect(isInternalRecipient('"a@vendor.example"@thewbsproject.com')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isInternalRecipient('')).toBe(false);
    expect(isInternalRecipient('thewbsproject.com')).toBe(false);
    expect(isInternalRecipient('@thewbsproject.com')).toBe(false);
    expect(isInternalRecipient('a@')).toBe(false);
  });
});

describe('partitionRecipients', () => {
  const ALL = [
    INTERNAL,
    OUTSIDE,
    MIXED_CASE,
    PREFIX_LOOKALIKE,
    SUFFIX_LOOKALIKE,
    SUBDOMAIN,
    INTERNAL_2,
  ];
  const OUTSIDERS = [OUTSIDE, PREFIX_LOOKALIKE, SUFFIX_LOOKALIKE, SUBDOMAIN];

  it('allows everyone on production', () => {
    expect(partitionRecipients({ ENV: 'production' }, ALL)).toEqual({
      allowed: ALL,
      suppressed: [],
    });
  });

  for (const tier of NON_PRODUCTION) {
    it(`on ${tier}, allows only internal addresses, in order`, () => {
      expect(partitionRecipients({ ENV: tier }, ALL)).toEqual({
        allowed: [INTERNAL, MIXED_CASE, INTERNAL_2],
        suppressed: OUTSIDERS,
      });
    });
  }

  it('treats a missing ENV as non-production', () => {
    expect(partitionRecipients({}, [INTERNAL, OUTSIDE])).toEqual({
      allowed: [INTERNAL],
      suppressed: [OUTSIDE],
    });
  });

  it('treats an unknown ENV as non-production', () => {
    expect(partitionRecipients({ ENV: 'qa' }, [INTERNAL, OUTSIDE])).toEqual({
      allowed: [INTERNAL],
      suppressed: [OUTSIDE],
    });
  });
});

describe('tierSubject / tierLabel', () => {
  it('leaves a production subject alone', () => {
    expect(tierSubject({ ENV: 'production' }, 'Hello')).toBe('Hello');
    expect(tierLabel({ ENV: 'production' })).toBe('production');
  });

  for (const tier of NON_PRODUCTION) {
    it(`prefixes [${tier}]`, () => {
      expect(tierSubject({ ENV: tier }, 'Hello')).toBe(`[${tier}] Hello`);
    });
  }

  it('prefixes [non-production] when ENV is missing or unknown', () => {
    expect(tierSubject({}, 'Hello')).toBe('[non-production] Hello');
    expect(tierSubject({ ENV: 'qa' }, 'Hello')).toBe('[non-production] Hello');
    expect(tierLabel({})).toBe('non-production');
  });
});
