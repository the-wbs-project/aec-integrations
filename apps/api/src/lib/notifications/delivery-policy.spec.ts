/**
 * The AECI-1198 tier delivery policy: outside recipients get mail from production only.
 * Every tier is checked against an allowlisted address, an outside address, mixed case
 * and the two subdomain lookalikes. A missing or unknown `ENV` must fail closed.
 * Staging (2026-10-09) redirects every recipient to one internal inbox instead.
 */

import { describe, expect, it } from 'vitest';

import {
  deliverySubject,
  envelopeRecipients,
  INTERNAL_RECIPIENT_DOMAINS,
  isInternalRecipient,
  isProductionTier,
  isRedirectTier,
  partitionRecipients,
  refusedByTierRule,
  STAGING_REDIRECT_RECIPIENT,
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

const NON_PRODUCTION = ['development', 'staging', 'demo'] as const;
/** The non-production tiers that keep the allowlist: every one but staging. */
const ALLOWLIST_TIERS = ['development', 'demo'] as const;

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

  it('rejects a bare address with more than one @', () => {
    expect(isInternalRecipient('a@thewbsproject.com@vendor.example')).toBe(false);
    expect(isInternalRecipient('"a@vendor.example"@thewbsproject.com')).toBe(false);
    expect(isInternalRecipient('"a@x.com"@aecintegrations.com')).toBe(false);
  });

  it('rejects a value that carries more than one address', () => {
    // Resend reads `to` as a list, so each of these would mail the outside inbox.
    expect(isInternalRecipient('x@gmail.com,support@aecintegrations.com')).toBe(false);
    expect(isInternalRecipient('support@aecintegrations.com,x@gmail.com')).toBe(false);
    expect(isInternalRecipient('a@aecintegrations.com; b@gmail.com')).toBe(false);
    expect(isInternalRecipient('a@aecintegrations.com b@gmail.com')).toBe(false);
    expect(isInternalRecipient('x@gmail.com <a@aecintegrations.com>')).toBe(false);
    expect(isInternalRecipient('Evil <a@aecintegrations.com>, x@gmail.com')).toBe(false);
    expect(isInternalRecipient('<x@gmail.com> <a@aecintegrations.com>')).toBe(false);
    expect(isInternalRecipient('Name <a @aecintegrations.com>')).toBe(false);
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

  it('allows everyone on staging, because the envelope redirects them all', () => {
    expect(partitionRecipients({ ENV: 'staging' }, ALL)).toEqual({
      allowed: ALL,
      suppressed: [],
    });
  });

  for (const tier of ALLOWLIST_TIERS) {
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

describe('the staging redirect (2026-10-09)', () => {
  it('names the support inbox as the one redirect address', () => {
    expect(STAGING_REDIRECT_RECIPIENT).toBe('support@aecintegrations.com');
    expect(isInternalRecipient(STAGING_REDIRECT_RECIPIENT)).toBe(true);
  });

  it('applies to ENV=staging exactly, and nowhere else', () => {
    expect(isRedirectTier({ ENV: 'staging' })).toBe(true);
    for (const ENV of ['production', 'demo', 'preview', 'development', 'Staging', 'qa', '']) {
      expect(isRedirectTier({ ENV })).toBe(false);
    }
    expect(isRedirectTier({})).toBe(false);
  });

  it('sends every staging envelope to the redirect address, internal or outside', () => {
    expect(envelopeRecipients({ ENV: 'staging' }, [OUTSIDE])).toEqual([STAGING_REDIRECT_RECIPIENT]);
    expect(envelopeRecipients({ ENV: 'staging' }, [INTERNAL, OUTSIDE])).toEqual([
      STAGING_REDIRECT_RECIPIENT,
    ]);
  });

  it('leaves the envelope unchanged on every other tier', () => {
    for (const ENV of ['production', ...ALLOWLIST_TIERS, undefined]) {
      expect(envelopeRecipients({ ENV }, [INTERNAL, INTERNAL_2])).toEqual([INTERNAL, INTERNAL_2]);
    }
  });

  it('names the intended recipients in a staging subject, bare and lowercased', () => {
    expect(deliverySubject({ ENV: 'staging' }, 'Hi', [`Seat <${MIXED_CASE}>`])).toBe(
      '[staging → support@aecintegrations.com] Hi',
    );
    expect(deliverySubject({ ENV: 'staging' }, 'Hi', [OUTSIDE, INTERNAL])).toBe(
      `[staging → ${OUTSIDE}, ${INTERNAL}] Hi`,
    );
  });

  it('flattens a line break in an address, so it cannot add a header line', () => {
    expect(deliverySubject({ ENV: 'staging' }, 'Hi', ['a@x.com\r\nBcc: b@y.com'])).toBe(
      '[staging → a@x.com bcc: b@y.com] Hi',
    );
  });

  it('is tierSubject on every other tier', () => {
    expect(deliverySubject({ ENV: 'production' }, 'Hi', [OUTSIDE])).toBe('Hi');
    expect(deliverySubject({ ENV: 'demo' }, 'Hi', [INTERNAL])).toBe('[demo] Hi');
    expect(deliverySubject({}, 'Hi', [INTERNAL])).toBe('[non-production] Hi');
  });
});

describe('refusedByTierRule (AECI-1220)', () => {
  it('refuses a production-only entry on every other tier, and when ENV is missing', () => {
    for (const tier of NON_PRODUCTION) {
      expect(refusedByTierRule({ ENV: tier }, 'production-only')).toBe(true);
    }
    expect(refusedByTierRule({}, 'production-only')).toBe(true);
    expect(refusedByTierRule({ ENV: 'qa' }, 'production-only')).toBe(true);
  });

  it('lets a production-only entry through on production', () => {
    expect(refusedByTierRule({ ENV: 'production' }, 'production-only')).toBe(false);
  });

  it('lets a production-and-demo entry through on production and demo only', () => {
    expect(refusedByTierRule({ ENV: 'production' }, 'production-and-demo')).toBe(false);
    expect(refusedByTierRule({ ENV: 'demo' }, 'production-and-demo')).toBe(false);
    for (const tier of ['development', 'preview', 'staging', 'qa']) {
      expect(refusedByTierRule({ ENV: tier }, 'production-and-demo')).toBe(true);
    }
    expect(refusedByTierRule({}, 'production-and-demo')).toBe(true);
  });

  it('never refuses the other rules outright: the allowlist decides those', () => {
    for (const rule of ['production-external', 'any-tier']) {
      expect(refusedByTierRule({ ENV: 'staging' }, rule)).toBe(false);
      expect(refusedByTierRule({}, rule)).toBe(false);
    }
  });
});
