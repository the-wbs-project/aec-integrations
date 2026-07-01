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
const emptyTaxonomy = { categories: [], audiences: [], phases: [] };

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
      taxonomy: { categories: [tax('bim', 'reused')], audiences: [], phases: [] },
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

  it('includes integration detail URLs (UUID route)', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: null,
      integrations: [integration('11111111-2222-4333-8444-555555555555', 'created')],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(affectedUrlsForPromote(response, BASE)).toEqual([
      `${BASE}/integrations/11111111-2222-4333-8444-555555555555`,
    ]);
  });

  it('emits the canonical pair URL for an integration carrying both slugs (AECI-297)', () => {
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
    // Additive to the legacy detail URL; pair context = alphabetically-first slug.
    expect(urls).toContain(`${BASE}/integrations/id-1`);
    expect(urls).toContain(`${BASE}/products/navisworks/integrations/revit`);
  });

  it('omits the pair URL when an integration lacks endpoint slugs', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: null,
      integrations: [integration('id-1', 'created')],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(affectedUrlsForPromote(response, BASE).some((u) => u.includes('/products/'))).toBe(
      false,
    );
  });

  it('a newly created phase → phase browse page + home + nav', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: { categories: [], audiences: [], phases: [tax('design', 'created')] },
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
