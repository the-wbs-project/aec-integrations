/**
 * `affectedUrlsForPromote` (AECI-236) — the affected-URL set IndexNow submits on
 * promote. Pure; mirrors the `cacheTagsForPromote` spec structure. Asserts the
 * URL set is computed correctly (the §20.2 / AECI-236 acceptance criterion).
 * Since AECI-1130 hub and facet pages go out only when their list of entries
 * changes: a created product or a created term.
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
      preserved: [],
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

  // AECI-1130: an updated product that stays on the same pages changes no list,
  // so no hub or facet page is announced. Only its own detail page goes out.
  it('updated entities + all-reused taxonomy → detail pages only, no index, facet or nav', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'updated')],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: { categories: [tax('bim', 'reused')], audiences: [], phases: [], trades: [] },
      skipped: [],
      preserved: [],
    };
    expect(new Set(affectedUrlsForPromote(response, BASE))).toEqual(
      new Set([`${BASE}/products/revit`, `${BASE}/vendors/autodesk`]),
    );
  });

  // AECI-1130: a created product joins every page it is on, so all its facet
  // pages and the products index gain an entry, reused terms included.
  it('created product + reused terms → products index and every facet page', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'created'),
      integrations: [],
      taxonomy: {
        categories: [tax('bim', 'reused')],
        audiences: [tax('architecture', 'reused')],
        phases: [tax('design', 'reused')],
        trades: [],
      },
      skipped: [],
      preserved: [],
    };
    expect(new Set(affectedUrlsForPromote(response, BASE))).toEqual(
      new Set([
        `${BASE}/products/revit`,
        `${BASE}/products`,
        `${BASE}/categories/bim`,
        `${BASE}/audiences/architecture`,
        `${BASE}/phases/design`,
      ]),
    );
  });

  // AECI-1130: on an updated product only the CREATED term's page is new. The
  // reused term may be one the product already had, so it is not announced.
  it('updated product + one created and one reused term → only the created term page', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: {
        categories: [tax('bim', 'reused'), tax('digital-twin', 'created')],
        audiences: [],
        phases: [],
        trades: [],
      },
      skipped: [],
      preserved: [],
    };
    const urls = affectedUrlsForPromote(response, BASE);
    expect(urls).toContain(`${BASE}/categories/digital-twin`);
    expect(urls).not.toContain(`${BASE}/categories/bim`);
    expect(urls).not.toContain(`${BASE}/products`);
  });

  it('a taxonomy-only promote with no product announces only created terms', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: null,
      integrations: [],
      taxonomy: {
        categories: [tax('bim', 'reused'), tax('digital-twin', 'created')],
        audiences: [],
        phases: [],
        trades: [],
      },
      skipped: [],
      preserved: [],
    };
    const urls = affectedUrlsForPromote(response, BASE);
    expect(urls).toContain(`${BASE}/categories/digital-twin`);
    expect(urls).not.toContain(`${BASE}/categories/bim`);
    expect(urls).not.toContain(`${BASE}/products`);
  });

  it('an integration missing endpoint slugs contributes no URL — the retired /integrations/{id} route is not submitted (AECI-298)', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: null,
      integrations: [integration('11111111-2222-4333-8444-555555555555', 'created')],
      taxonomy: emptyTaxonomy,
      skipped: [],
      preserved: [],
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
      preserved: [],
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
      preserved: [],
    };
    expect(new Set(affectedUrlsForPromote(response, BASE))).toEqual(
      new Set([
        `${BASE}/products/revit`,
        `${BASE}/phases/design`,
        `${BASE}/`,
        `${BASE}/categories`,
        `${BASE}/audiences`,
        `${BASE}/phases`,
      ]),
    );
  });

  // ── Trades: the publication gate (AECI-546) ────────────────────────────────
  // AECI-542 excluded trade URLs outright and deferred the call here. The rule
  // now: PUBLISHED term URLs are submitted, sub-floor ones never are, and the
  // `/trades` index is submitted on any touch at all.
  describe('trades', () => {
    const withTrades = (trades: string[]): PromoteResponse => ({
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: {
        categories: [],
        audiences: [],
        phases: [],
        trades: trades.map((slug) => tax(slug, 'reused')),
      },
      skipped: [],
      preserved: [],
    });

    // The floor is the caller's to resolve; without it we must submit nothing
    // rather than guess, because a sub-floor page is `noindex`.
    it('omits every trade URL when the caller resolved no publication data', () => {
      const urls = affectedUrlsForPromote(withTrades(['electrical']), BASE);
      expect(urls).toEqual([`${BASE}/products/revit`, `${BASE}/trades`]);
      expect(urls.some((u) => u.startsWith(`${BASE}/trades/`))).toBe(false);
    });

    it('submits published trade terms and withholds sub-floor ones', () => {
      const urls = affectedUrlsForPromote(withTrades(['electrical', 'plumbing']), BASE, {
        publishedTradeSlugs: ['electrical'],
      });
      expect(urls).toContain(`${BASE}/trades/electrical`);
      expect(urls).not.toContain(`${BASE}/trades/plumbing`);
    });

    // The index renders live per-term counts and gains/loses a tile on a floor
    // crossing, so ANY touch repaints it — unlike the sibling facets, whose index
    // pages are submitted only on a term creation.
    it('submits the /trades index for a touched but unpublished trade', () => {
      const urls = affectedUrlsForPromote(withTrades(['plumbing']), BASE, {
        publishedTradeSlugs: [],
      });
      expect(urls).toContain(`${BASE}/trades`);
    });

    // A removal isn't echoed on the response, but it can push a term back under
    // the floor — which changes the index just as a crossing upward does.
    it('submits the /trades index when the promote only REMOVED trades', () => {
      const urls = affectedUrlsForPromote(withTrades([]), BASE, {
        removedTradeSlugs: ['plumbing'],
      });
      expect(urls).toContain(`${BASE}/trades`);
    });

    // A removed term that still clears the floor is a real content change on its
    // own page, so it is submitted even though the response never echoed it.
    it('submits a removed trade that is still published', () => {
      const urls = affectedUrlsForPromote(withTrades([]), BASE, {
        publishedTradeSlugs: ['electrical'],
        removedTradeSlugs: ['electrical'],
      });
      expect(urls).toContain(`${BASE}/trades/electrical`);
    });

    // AECI-1130 narrowed the three ungated facets only. A trade page that just
    // crossed the floor is genuinely new, and promote cannot tell an added trade
    // from a kept one, so an UPDATED product still announces its published trade
    // pages and the `/trades` index, exactly as before.
    it('leaves trade URLs unchanged on an updated product (AECI-1130 scope)', () => {
      const urls = affectedUrlsForPromote(withTrades(['electrical', 'plumbing']), BASE, {
        publishedTradeSlugs: ['electrical'],
      });
      expect(new Set(urls)).toEqual(
        new Set([`${BASE}/products/revit`, `${BASE}/trades/electrical`, `${BASE}/trades`]),
      );
    });

    it('leaves /trades out entirely when no trade was touched', () => {
      const urls = affectedUrlsForPromote(withTrades([]), BASE);
      expect(urls.some((u) => u.includes('/trades'))).toBe(false);
    });

    // Trades are find-only, so `operation: 'created'` can never fire for them —
    // home and the sibling index pages must not be dragged in by a trade touch.
    it('never adds home or the sibling taxonomy indexes', () => {
      const urls = affectedUrlsForPromote(withTrades(['electrical']), BASE, {
        publishedTradeSlugs: ['electrical'],
      });
      expect(urls).not.toContain(`${BASE}/`);
      expect(urls).not.toContain(`${BASE}/categories`);
      expect(urls).not.toContain(`${BASE}/audiences`);
      expect(urls).not.toContain(`${BASE}/phases`);
    });
  });

  it('vendor-only create → vendor detail only (no sitemap URL)', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: null,
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
      preserved: [],
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
      preserved: [],
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
      preserved: [],
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
