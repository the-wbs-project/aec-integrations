/**
 * The re-crawl URL derivation for promote and for the vendor portal
 * (AECI-944 / AECI-945 / §20.2).
 *
 * Four INVARIANTS, each guarding something that fails silently:
 *
 *   1. **The Google list carries NO hub pages.** IndexNow is free so it takes
 *      `/products` and the facet indexes too. Request Indexing is quota-capped,
 *      and a slot spent on a hub Google already re-crawls constantly is a slot
 *      not spent on a page it has never seen. Nothing would report the waste.
 *   2. **A sub-floor trade page is never announced.** `/trades/{slug}` renders
 *      `noindex` below `TRADE_PUBLISH_MIN_PRODUCTS`, so announcing it asks a
 *      crawler to fetch a page that tells it to go away — and on the Google side
 *      spends quota to be told no.
 *   3. **A blocked entity produces no URL.** A claimed vendor is OMITTED from
 *      `response.vendors` rather than flagged (AECI-520), so every deriver must
 *      iterate the response arrays. A deriver that read the payload instead
 *      would leak a blocked entity into the queue with nothing to catch it.
 *   4. **The material/minor split is an allow-list.** A new editable column then
 *      defaults to MINOR. A deny-list would silently promote every new link
 *      field to tier 2 and crowd out real work.
 */

import type { PromoteResponse } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { gscRecrawlPriority } from '../lib/gsc-recrawl-priority';

import { gscRecrawlEntriesForPromote } from './promote-gsc-recrawl-entries';
import {
  attestationEditRecrawl,
  MATERIAL_PRODUCT_FIELDS,
  MATERIAL_VENDOR_FIELDS,
  productEditRecrawl,
  vendorProfileRecrawl,
  type RecrawlTaxonomySlugs,
} from './vendor-recrawl';

const BASE = 'https://www.aecintegrations.com';

const NO_TAXONOMY: RecrawlTaxonomySlugs = {
  categories: [],
  audiences: [],
  phases: [],
  trades: [],
};

const emptyResponse = (over: Partial<PromoteResponse> = {}): PromoteResponse =>
  ({
    vendors: [],
    product: null,
    integrations: [],
    taxonomy: { categories: [], audiences: [], phases: [], trades: [] },
    skipped: [],
    preserved: [],
    ...over,
  }) as PromoteResponse;

// ─── Promote ─────────────────────────────────────────────────────────────────

describe('gscRecrawlEntriesForPromote', () => {
  it('tiers a created product above an updated one', () => {
    const created = gscRecrawlEntriesForPromote(
      emptyResponse({
        product: { ref: 'p', id: 'i', slug: 'procore', operation: 'created' },
      }),
      BASE,
    );
    const updated = gscRecrawlEntriesForPromote(
      emptyResponse({
        product: { ref: 'p', id: 'i', slug: 'procore', operation: 'updated' },
      }),
      BASE,
    );

    expect(created[0]!.reason).toBe('product.created');
    expect(updated[0]!.reason).toBe('product.updated');
    expect(gscRecrawlPriority(created[0]!.reason)).toBeLessThan(
      gscRecrawlPriority(updated[0]!.reason),
    );
  });

  it('emits NO hub pages, unlike the IndexNow deriver', () => {
    const entries = gscRecrawlEntriesForPromote(
      emptyResponse({
        product: { ref: 'p', id: 'i', slug: 'procore', operation: 'created' },
        taxonomy: {
          categories: [{ slug: 'estimating', id: 'c1', operation: 'created' }],
          audiences: [],
          phases: [],
          trades: [],
        },
      }),
      BASE,
    );

    const urls = entries.map((e) => e.url);
    expect(urls).toEqual([`${BASE}/products/procore`]);
    // The things `affectedUrlsForPromote` DOES emit and this must not.
    expect(urls).not.toContain(`${BASE}/products`);
    expect(urls).not.toContain(`${BASE}/`);
    expect(urls).not.toContain(`${BASE}/categories`);
    expect(urls).not.toContain(`${BASE}/categories/estimating`);
  });

  it('sorts a pair URL alphabetically, so it never names the redirecting orientation', () => {
    const entries = gscRecrawlEntriesForPromote(
      emptyResponse({
        integrations: [
          {
            ref: 'i',
            id: 'x',
            operation: 'created',
            sourceSlug: 'procore',
            targetSlug: 'autodesk-build',
          },
        ],
      }),
      BASE,
    );
    expect(entries[0]!.url).toBe(`${BASE}/products/autodesk-build/integrations/procore`);
    expect(entries[0]!.reason).toBe('pair.created');
  });

  it('skips an integration whose other endpoint is not promoted', () => {
    const entries = gscRecrawlEntriesForPromote(
      emptyResponse({
        integrations: [{ ref: 'i', id: 'x', operation: 'created', sourceSlug: 'procore' }],
      }),
      BASE,
    );
    // No pair page renders without both endpoints, so there is nothing to index.
    expect(entries).toEqual([]);
  });

  it('emits a trade URL only for a term that cleared the publication floor', () => {
    const entries = gscRecrawlEntriesForPromote(emptyResponse(), BASE, {
      publishedTradeSlugs: ['roofing'],
    });
    expect(entries).toEqual([{ url: `${BASE}/trades/roofing`, reason: 'trade.published' }]);
  });

  it('emits nothing for a promote whose entities were all blocked', () => {
    // A claimed vendor is omitted from the arrays rather than marked (AECI-520).
    // Iterating the response is what makes the omission do the work.
    expect(gscRecrawlEntriesForPromote(emptyResponse(), BASE)).toEqual([]);
  });

  it('normalises a trailing slash on the site base', () => {
    const entries = gscRecrawlEntriesForPromote(
      emptyResponse({ product: { ref: 'p', id: 'i', slug: 'procore', operation: 'created' } }),
      `${BASE}///`,
    );
    expect(entries[0]!.url).toBe(`${BASE}/products/procore`);
  });
});

// ─── Vendor product edit ─────────────────────────────────────────────────────

describe('productEditRecrawl', () => {
  it('calls a description change material and a logo change minor', () => {
    const material = productEditRecrawl(BASE, 'procore', ['description'], NO_TAXONOMY, NO_TAXONOMY);
    const minor = productEditRecrawl(BASE, 'procore', ['logo_url'], NO_TAXONOMY, NO_TAXONOMY);

    expect(material.gsc[0]!.reason).toBe('product.updated');
    expect(minor.gsc[0]!.reason).toBe('product.minor');
  });

  it('treats a taxonomy move as material even with no column change', () => {
    const before = { ...NO_TAXONOMY, categories: ['estimating'] };
    const after = { ...NO_TAXONOMY, categories: ['field-management'] };
    const out = productEditRecrawl(BASE, 'procore', [], before, after);
    expect(out.gsc[0]!.reason).toBe('product.updated');
  });

  it('purges both sides of a facet move on the IndexNow list', () => {
    const before = { ...NO_TAXONOMY, categories: ['estimating'] };
    const after = { ...NO_TAXONOMY, categories: ['field-management'] };
    const out = productEditRecrawl(BASE, 'procore', [], before, after);

    // The page it LEFT never carried this product's tag either, so both sides
    // need announcing. Mirrors `productEditTags`.
    expect(out.indexNow).toContain(`${BASE}/categories/estimating`);
    expect(out.indexNow).toContain(`${BASE}/categories/field-management`);
  });

  it('announces a trade page only once the floor is cleared', () => {
    const before = NO_TAXONOMY;
    const after = { ...NO_TAXONOMY, trades: ['roofing'] };

    const belowFloor = productEditRecrawl(BASE, 'procore', [], before, after, []);
    expect(belowFloor.indexNow).not.toContain(`${BASE}/trades/roofing`);
    expect(belowFloor.gsc.map((e) => e.url)).not.toContain(`${BASE}/trades/roofing`);

    const cleared = productEditRecrawl(BASE, 'procore', [], before, after, ['roofing']);
    expect(cleared.indexNow).toContain(`${BASE}/trades/roofing`);
    expect(cleared.gsc).toContainEqual({
      url: `${BASE}/trades/roofing`,
      reason: 'trade.published',
    });
  });

  it('announces the trades index whenever the trade set changed at all', () => {
    // Its tiles are floor-filtered, so it moves on a join OR a leave.
    const left = productEditRecrawl(
      BASE,
      'procore',
      [],
      { ...NO_TAXONOMY, trades: ['roofing'] },
      NO_TAXONOMY,
    );
    expect(left.indexNow).toContain(`${BASE}/trades`);
  });

  it('leaves the trades index alone when the trade set did not change', () => {
    const same = { ...NO_TAXONOMY, trades: ['roofing'] };
    const out = productEditRecrawl(BASE, 'procore', ['logo_url'], same, { ...same });
    expect(out.indexNow).not.toContain(`${BASE}/trades`);
  });

  it('always carries the product page and the products index on IndexNow', () => {
    const out = productEditRecrawl(BASE, 'procore', ['logo_url'], NO_TAXONOMY, NO_TAXONOMY);
    expect(out.indexNow).toContain(`${BASE}/products/procore`);
    expect(out.indexNow).toContain(`${BASE}/products`);
    // …and the hub is NOT on the Google list.
    expect(out.gsc.map((e) => e.url)).not.toContain(`${BASE}/products`);
  });
});

// ─── Vendor profile edit ─────────────────────────────────────────────────────

describe('vendorProfileRecrawl', () => {
  it('calls the company-facts block material and a social link minor', () => {
    expect(vendorProfileRecrawl(BASE, 'procore', ['headquarters']).gsc[0]!.reason).toBe(
      'vendor.updated',
    );
    expect(vendorProfileRecrawl(BASE, 'procore', ['linkedin_url']).gsc[0]!.reason).toBe(
      'vendor.minor',
    );
  });

  it('touches only the vendor page', () => {
    const out = vendorProfileRecrawl(BASE, 'procore', ['description']);
    expect(out.indexNow).toEqual([`${BASE}/vendors/procore`]);
    expect(out.gsc.map((e) => e.url)).toEqual([`${BASE}/vendors/procore`]);
  });
});

// ─── Attestation edit ────────────────────────────────────────────────────────

describe('attestationEditRecrawl', () => {
  it('announces the pair page and both endpoint products', () => {
    const out = attestationEditRecrawl(BASE, 'procore', 'autodesk-build');
    expect(out.indexNow).toEqual([
      `${BASE}/products/autodesk-build/integrations/procore`,
      `${BASE}/products/procore`,
      `${BASE}/products/autodesk-build`,
    ]);
  });

  it('tiers the pair page at 4, because it already exists and is already indexed', () => {
    // A vendor can only attest against a claim on an existing integration, so
    // `pair.created` is unreachable from here.
    const out = attestationEditRecrawl(BASE, 'procore', 'autodesk-build');
    expect(out.gsc[0]!.reason).toBe('pair.updated');
    expect(gscRecrawlPriority(out.gsc[0]!.reason)).toBe(4);
    expect(out.gsc.slice(1).map((e) => e.reason)).toEqual(['product.minor', 'product.minor']);
  });
});

// ─── The allow-lists ─────────────────────────────────────────────────────────

describe('the material-field allow-lists', () => {
  it('names only fields that change what a page SAYS', () => {
    expect([...MATERIAL_PRODUCT_FIELDS]).toEqual(['description']);
    expect([...MATERIAL_VENDOR_FIELDS].sort()).toEqual([
      'description',
      'founded_year',
      'headquarters',
      'parent_company',
      'public_private',
    ]);
  });

  it('defaults an unknown field to MINOR, which is the safe direction', () => {
    // A new editable column added to PRODUCT_COLUMN_MAP without touching this
    // file gets under-prioritised until someone notices. A deny-list would
    // instead promote every new link field to tier 2 and crowd out real work.
    const out = productEditRecrawl(
      BASE,
      'procore',
      ['some_future_column'],
      NO_TAXONOMY,
      NO_TAXONOMY,
    );
    expect(out.gsc[0]!.reason).toBe('product.minor');
  });
});
