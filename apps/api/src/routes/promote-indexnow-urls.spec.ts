/**
 * `affectedUrlsForPromote` (AECI-236) — the affected-URL set IndexNow submits on
 * promote. Pure; mirrors the `cacheTagsForPromote` spec structure. Asserts the
 * URL set is computed correctly (the §20.2 / AECI-236 acceptance criterion).
 */

import type { PromoteResponse } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { affectedUrlsForPromote } from './promote-indexnow-urls';

const BASE = 'https://aecintegrations.com';

const entity = (slug: string, operation: 'created' | 'updated') => ({
  ref: `ref-${slug}`,
  id: `id-${slug}`,
  slug,
  operation,
});
const integration = (id: string, operation: 'created' | 'updated') => ({
  ref: `ref-${id}`,
  id,
  operation,
});
const tax = (slug: string, operation: 'created' | 'reused') => ({
  id: `id-${slug}`,
  slug,
  operation,
});
const emptyTaxonomy = { categories: [], audiences: [], phases: [], trades: [] };

describe('affectedUrlsForPromote', () => {
  it('created product + vendor + mixed taxonomy → detail, index, browse, home + nav', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: entity('revit', 'created'),
      integrations: [],
      taxonomy: {
        categories: [tax('bim', 'reused')],
        audiences: [tax('architecture', 'created')],
        phases: [],
        trades: [],
      },
      skipped: [],
    };
    expect(new Set(affectedUrlsForPromote(response, BASE))).toEqual(
      new Set([
        `${BASE}/products/revit`,
        `${BASE}/products`,
        `${BASE}/vendors/autodesk`,
        `${BASE}/categories/bim`,
        `${BASE}/audiences/architecture`,
        // A created term (architecture) repaints the global nav:
        `${BASE}/`,
        `${BASE}/categories`,
        `${BASE}/audiences`,
        `${BASE}/phases`,
      ]),
    );
  });

  it('updated entities + all-reused taxonomy → browse pages but no home/nav', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'updated')],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: { categories: [tax('bim', 'reused')], audiences: [], phases: [], trades: [] },
      skipped: [],
    };
    expect(new Set(affectedUrlsForPromote(response, BASE))).toEqual(
      new Set([
        `${BASE}/products/revit`,
        `${BASE}/products`,
        `${BASE}/vendors/autodesk`,
        `${BASE}/categories/bim`,
      ]),
    );
  });

  it('an integration missing endpoint slugs contributes no URL — the retired /integrations/{id} route is not submitted (AECI-298)', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: null,
      integrations: [integration('11111111-2222-4333-8444-555555555555', 'created')],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    const urls = affectedUrlsForPromote(response, BASE);
    expect(urls).toEqual([]);
    // The legacy detail route is a 301 redirect now; never submit it.
    expect(urls).not.toContain(`${BASE}/integrations/11111111-2222-4333-8444-555555555555`);
  });

  it('emits only the canonical pair URL for an integration carrying both slugs — never the legacy detail URL (AECI-297 / AECI-298)', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: null,
      integrations: [
        {
          ref: 'i1',
          id: 'id-1',
          operation: 'created',
          sourceSlug: 'revit',
          targetSlug: 'navisworks',
        },
      ],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    const urls = affectedUrlsForPromote(response, BASE);
    // Pair context = alphabetically-first slug; the retired /integrations/{id}
    // detail URL is not submitted (AECI-298).
    expect(urls).toEqual([`${BASE}/products/navisworks/integrations/revit`]);
    expect(urls).not.toContain(`${BASE}/integrations/id-1`);
  });

  it('a newly created phase → phase browse page + home + nav', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: { categories: [], audiences: [], phases: [tax('design', 'created')], trades: [] },
      skipped: [],
    };
    expect(new Set(affectedUrlsForPromote(response, BASE))).toEqual(
      new Set([
        `${BASE}/products/revit`,
        `${BASE}/products`,
        `${BASE}/phases/design`,
        `${BASE}/`,
        `${BASE}/categories`,
        `${BASE}/audiences`,
        `${BASE}/phases`,
      ]),
    );
  });

  // AECI-542 decision: trade browse URLs are deliberately NOT submitted in v1 —
  // the route doesn't exist until AECI-544 and a sub-floor term is `noindex`.
  // Gated inclusion is AECI-546's call; this locks the current behaviour so the
  // omission stays a decision rather than a regression.
  it('a touched trade contributes no URL (deliberately excluded in v1)', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: {
        categories: [],
        audiences: [],
        phases: [],
        trades: [tax('electrical', 'reused')],
      },
      skipped: [],
    };
    const urls = affectedUrlsForPromote(response, BASE);
    expect(urls).toEqual([`${BASE}/products/revit`, `${BASE}/products`]);
    expect(urls.some((u) => u.includes('/trades'))).toBe(false);
  });

  it('vendor-only create → vendor detail only (no sitemap URL)', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: null,
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(affectedUrlsForPromote(response, BASE)).toEqual([`${BASE}/vendors/autodesk`]);
  });

  it('nothing public changed → empty url set', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: null,
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(affectedUrlsForPromote(response, BASE)).toEqual([]);
  });

  it('normalizes a trailing slash on the base URL and dedups', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'created'),
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    const urls = affectedUrlsForPromote(response, `${BASE}/`);
    expect(urls).toContain(`${BASE}/products/revit`);
    expect(urls).toContain(`${BASE}/products`);
    // No double slash anywhere.
    expect(urls.some((u) => u.includes('com//'))).toBe(false);
    // No sitemap URL is ever emitted.
    expect(urls.some((u) => u.includes('/sitemap'))).toBe(false);
  });
});
