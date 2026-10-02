/**
 * `tagLink` (AECI-1209): the one place an email link gains its tag.
 */

import { ARRIVAL_QUERY_PARAMS, arrivalFromSearch } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { EMAIL_LINK_PARAMS, createLinkTagger, isUntaggedPath, tagLink } from './link-tag';

const SITE = 'https://www.aecintegrations.com';
const CTX = { siteUrl: SITE, templateId: 'claim-approved', sendId: 42 };

describe('tagLink', () => {
  it('appends utm_source, utm_campaign and n to a site link', () => {
    expect(tagLink(`${SITE}/vendor`, CTX)).toBe(
      `${SITE}/vendor?utm_source=email&utm_campaign=claim-approved&n=42`,
    );
  });

  it('is idempotent', () => {
    const once = tagLink(`${SITE}/products/revit`, CTX);
    expect(tagLink(once, CTX)).toBe(once);
  });

  it('replaces an earlier tag rather than adding a second one', () => {
    const other = tagLink(`${SITE}/vendor`, { ...CTX, templateId: 'review-approved', sendId: 7 });
    const retagged = new URL(tagLink(other, CTX));
    expect(retagged.searchParams.getAll('utm_campaign')).toEqual(['claim-approved']);
    expect(retagged.searchParams.getAll('n')).toEqual(['42']);
  });

  it('keeps an existing query and the fragment', () => {
    const tagged = new URL(tagLink(`${SITE}/products?view=table&page=2#grid`, CTX));
    expect(tagged.pathname).toBe('/products');
    expect(tagged.hash).toBe('#grid');
    expect([...tagged.searchParams.keys()]).toEqual([
      'view',
      'page',
      'utm_source',
      'utm_campaign',
      'n',
    ]);
    expect(tagged.searchParams.get('view')).toBe('table');
    expect(tagged.searchParams.get('page')).toBe('2');
  });

  it('omits n when the send has no ledger id, and keeps both utm params', () => {
    expect(tagLink(`${SITE}/vendor`, { ...CTX, sendId: null })).toBe(
      `${SITE}/vendor?utm_source=email&utm_campaign=claim-approved`,
    );
  });

  it.each([
    'https://evil.example/vendor',
    'https://aecintegrations.com/vendor', // a different host is a different origin
    'http://www.aecintegrations.com/vendor', // and so is a different scheme
    'https://linear.app/aeci/issue/AECI-1',
    'mailto:unsubscribe@aecintegrations.com?subject=unsubscribe',
    'not a url',
  ])('leaves an off-origin or unparseable URL unchanged: %s', (url) => {
    expect(tagLink(url, CTX)).toBe(url);
  });

  it.each([
    `${SITE}/api/unsubscribe?token=t`,
    `${SITE}/api/notifications/nudges/mute?token=t`,
    `${SITE}/unsubscribe?token=t`,
    `${SITE}/notifications/mute?token=t`,
  ])('never tags an opt-out or API link: %s', (url) => {
    expect(tagLink(url, CTX)).toBe(url);
  });

  it('matches untagged paths by segment, not by prefix text', () => {
    expect(isUntaggedPath('/api')).toBe(true);
    expect(isUntaggedPath('/api/x')).toBe(true);
    expect(isUntaggedPath('/apis')).toBe(false);
    expect(isUntaggedPath('/unsubscribed-help')).toBe(false);
  });

  it('tags nothing when PUBLIC_SITE_URL is unset or does not parse', () => {
    expect(tagLink(`${SITE}/vendor`, { ...CTX, siteUrl: undefined })).toBe(`${SITE}/vendor`);
    expect(tagLink(`${SITE}/vendor`, { ...CTX, siteUrl: '  ' })).toBe(`${SITE}/vendor`);
    expect(tagLink(`${SITE}/vendor`, { ...CTX, siteUrl: 'nope' })).toBe(`${SITE}/vendor`);
  });

  it('accepts a PUBLIC_SITE_URL with a trailing slash', () => {
    expect(tagLink(`${SITE}/vendor`, { ...CTX, siteUrl: `${SITE}/` })).toContain('n=42');
  });

  it('createLinkTagger binds one send', () => {
    const link = createLinkTagger(CTX);
    expect(link(`${SITE}/vendor`)).toBe(tagLink(`${SITE}/vendor`, CTX));
  });
});

describe('the tag matches what the arrival beacon reads (AECI-1208)', () => {
  it('uses the same three param names', () => {
    expect([...EMAIL_LINK_PARAMS]).toEqual([...ARRIVAL_QUERY_PARAMS]);
  });

  it('a tagged link yields an arrival the beacon accepts in full', () => {
    const tagged = new URL(tagLink(`${SITE}/vendor`, { ...CTX, sendId: 999_999_999_999_999 }));
    expect(arrivalFromSearch(tagged.search)).toEqual({
      utm_source: 'email',
      utm_campaign: 'claim-approved',
      n: '999999999999999',
    });
  });
});
