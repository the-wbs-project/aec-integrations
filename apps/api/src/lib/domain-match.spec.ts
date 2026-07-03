import { describe, expect, it } from 'vitest';

import { computeDomainMatch, extractEmailDomain, extractWebsiteDomain } from './domain-match';

describe('extractEmailDomain', () => {
  it('returns the registrable domain of the address host', () => {
    expect(extractEmailDomain('jane@acme.com')).toBe('acme.com');
  });

  it('reduces a subdomain host to its registrable domain', () => {
    expect(extractEmailDomain('jane@mail.acme.com')).toBe('acme.com');
  });

  it('handles multi-part public suffixes', () => {
    expect(extractEmailDomain('jane@acme.co.uk')).toBe('acme.co.uk');
  });

  it('lowercases', () => {
    expect(extractEmailDomain('Jane@ACME.COM')).toBe('acme.com');
  });

  it('takes the host after the LAST @', () => {
    expect(extractEmailDomain('weird@local@acme.com')).toBe('acme.com');
  });

  it('returns null when there is no @ or no resolvable domain', () => {
    expect(extractEmailDomain('not-an-email')).toBeNull();
    expect(extractEmailDomain('jane@')).toBeNull();
    expect(extractEmailDomain('jane@localhost')).toBeNull();
  });
});

describe('extractWebsiteDomain', () => {
  it('parses a full URL down to the registrable domain', () => {
    expect(extractWebsiteDomain('https://www.acme.com/products?x=1')).toBe('acme.com');
  });

  it('parses a bare host', () => {
    expect(extractWebsiteDomain('acme.com')).toBe('acme.com');
  });

  it('returns null for null/empty/unparseable input', () => {
    expect(extractWebsiteDomain(null)).toBeNull();
    expect(extractWebsiteDomain(undefined)).toBeNull();
    expect(extractWebsiteDomain('')).toBeNull();
    expect(extractWebsiteDomain('   ')).toBeNull();
    expect(extractWebsiteDomain('not a url')).toBeNull();
  });
});

describe('computeDomainMatch', () => {
  it('matches when email and website share a registrable domain', () => {
    expect(computeDomainMatch('jane@acme.com', 'https://www.acme.com')).toBe('match');
  });

  it('tolerates subdomains on either side', () => {
    expect(computeDomainMatch('jane@mail.acme.com', 'https://acme.com')).toBe('match');
    expect(computeDomainMatch('jane@acme.com', 'https://docs.acme.com')).toBe('match');
  });

  it('is correct on multi-part TLDs', () => {
    expect(computeDomainMatch('jane@acme.co.uk', 'https://www.acme.co.uk')).toBe('match');
  });

  it('is case-insensitive', () => {
    expect(computeDomainMatch('Jane@ACME.com', 'HTTPS://ACME.COM')).toBe('match');
  });

  it('flags a mismatch (e.g. a gmail address claiming a vendor)', () => {
    expect(computeDomainMatch('jane@gmail.com', 'https://acme.com')).toBe('no_match');
    expect(computeDomainMatch('jane@acme.com', 'https://other.com')).toBe('no_match');
  });

  it('falls back to manual_review when the target website is missing', () => {
    expect(computeDomainMatch('jane@acme.com', null)).toBe('manual_review');
    expect(computeDomainMatch('jane@acme.com', undefined)).toBe('manual_review');
    expect(computeDomainMatch('jane@acme.com', '')).toBe('manual_review');
  });

  it('falls back to manual_review when a domain is unparseable', () => {
    expect(computeDomainMatch('jane@acme.com', 'not a url')).toBe('manual_review');
    expect(computeDomainMatch('jane@localhost', 'https://acme.com')).toBe('manual_review');
  });
});
