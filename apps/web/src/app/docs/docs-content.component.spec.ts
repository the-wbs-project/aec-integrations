/**
 * AECI-1104, AECI-1248 — the docs manifest and the routes generated from it.
 *
 * `*.component.spec.ts` (the Angular `ng test` tier) because the manifest
 * imports `.md` files, and only the Angular build carries the esbuild `text`
 * loader. The sitemap's use of `indexableDocsPaths` is pinned with a stand-in in
 * `src/server/sitemap.spec.ts`; the real derivation is pinned here.
 */
import { describe, expect, it } from 'vitest';

import {
  DOCS_PAGES,
  DOCS_SECTIONS,
  type DocsSectionId,
  type DocsSectionMeta,
  type RawDocsPage,
  buildDocsManifest,
  docsNeighbours,
  docsSection,
  getDocsPage,
  getDocsSection,
  indexableDocsPaths,
} from './docs-content';
import { DOCS_ROUTES } from './docs.routes';

const VENDOR_SLUGS = [
  'claiming-your-listing',
  'your-seat',
  'attesting-an-integration',
  'owning-an-integration',
  'contests-and-protests',
  'replying-to-reviews',
  'plans-and-the-account-label',
  'change-history',
];

const REVIEWER_SLUGS = ['writing-a-review', 'requests-and-corrections'];

const ACCOUNT_SLUGS = ['signing-in', 'your-data'];

const GETTING_STARTED_SLUGS = ['what-aeci-is', 'reading-an-integration-page', 'taxonomy'];

const TRUST_SLUGS = ['how-ranking-works', 'the-account-label', 'agreement-states'];

// ─── Fixture manifest ────────────────────────────────────────────────────────

const FIXTURE_META: Record<DocsSectionId, DocsSectionMeta> = {
  'getting-started': { label: 'Getting started', summary: 's', audience: 'reader', order: 1 },
  trust: { label: 'Trust', summary: 's', audience: 'reader', order: 2 },
  vendors: { label: 'Vendors', summary: 's', audience: 'vendor', order: 3 },
  reviewers: { label: 'Reviewers', summary: 's', audience: 'reviewer', order: 4 },
  account: { label: 'Account', summary: 's', audience: 'reviewer', order: 5 },
  faq: { label: 'FAQ', summary: 's', audience: 'reader', order: 6, singlePage: true },
};

function md(
  section: string,
  order: number | string,
  body = 'Body.\n\n## Related\n\n- [Docs](/docs)\n',
): string {
  return [
    '---',
    `title: Page ${order}`,
    'description: A page.',
    `section: ${section}`,
    `order: ${order}`,
    'last_updated: 8 October 2026',
    '---',
    '',
    body,
  ].join('\n');
}

function raw(slug: string, source: string): RawDocsPage {
  return { slug, source };
}

describe('buildDocsManifest (fixtures)', () => {
  it('hides a section with no pages: no section entry, no pages', () => {
    const manifest = buildDocsManifest(FIXTURE_META, {
      trust: [],
      reviewers: [raw('a', md('reviewers', 1))],
    });
    expect(manifest.sections.map((s) => s.id)).toEqual(['reviewers']);
    expect(getDocsSection('trust', manifest)).toBeUndefined();
    expect(indexableDocsPaths(manifest)).toEqual(['/docs', '/docs/reviewers', '/docs/reviewers/a']);
  });

  it('serves a single-page section at /docs/<section>, with no separate index', () => {
    const manifest = buildDocsManifest(FIXTURE_META, { faq: [raw('faq', md('faq', 1))] });
    const [faq] = manifest.sections;
    expect(faq.singlePage).toBe(true);
    expect(faq.path).toBe('/docs/faq');
    expect(faq.pages[0].path).toBe('/docs/faq');
    expect(indexableDocsPaths(manifest)).toEqual(['/docs', '/docs/faq']);
    expect(docsNeighbours(faq.pages[0], manifest)).toEqual({ prev: undefined, next: undefined });
  });

  it('orders sections by section order and pages by frontmatter order', () => {
    const manifest = buildDocsManifest(FIXTURE_META, {
      reviewers: [raw('b', md('reviewers', 2)), raw('a', md('reviewers', 1))],
      trust: [raw('t', md('trust', 1))],
    });
    expect(manifest.sections.map((s) => s.id)).toEqual(['trust', 'reviewers']);
    expect(manifest.pages.map((p) => p.slug)).toEqual(['t', 'a', 'b']);
  });

  it('never reads section chrome while building, so no $localize runs at module init', () => {
    // `sitemap.xml` loads the manifest in a server chunk that can run before
    // Angular installs `$localize`. Building and listing paths must not touch it.
    const trap = (): never => {
      throw new Error('section chrome read during build');
    };
    const meta = Object.fromEntries(
      Object.entries(FIXTURE_META).map(([id, m]) => [
        id,
        {
          audience: m.audience,
          order: m.order,
          singlePage: m.singlePage,
          get label(): string {
            return trap();
          },
          get summary(): string {
            return trap();
          },
        },
      ]),
    ) as unknown as Record<DocsSectionId, DocsSectionMeta>;
    const manifest = buildDocsManifest(meta, { reviewers: [raw('a', md('reviewers', 1))] });
    expect(indexableDocsPaths(manifest)).toEqual(['/docs', '/docs/reviewers', '/docs/reviewers/a']);
    expect(() => manifest.sections[0].label).toThrow(/chrome read/);
  });

  it('throws when two pages in a section share an order', () => {
    expect(() =>
      buildDocsManifest(FIXTURE_META, {
        reviewers: [raw('a', md('reviewers', 1)), raw('b', md('reviewers', 1))],
      }),
    ).toThrow(/share order 1/);
  });

  it('allows the same order in different sections', () => {
    expect(() =>
      buildDocsManifest(FIXTURE_META, {
        trust: [raw('a', md('trust', 1))],
        reviewers: [raw('b', md('reviewers', 1))],
      }),
    ).not.toThrow();
  });

  it('throws when a page does not end in a ## Related list', () => {
    expect(() =>
      buildDocsManifest(FIXTURE_META, { trust: [raw('a', md('trust', 1, 'Body.\n'))] }),
    ).toThrow(/Related/);
    expect(() =>
      buildDocsManifest(FIXTURE_META, {
        trust: [raw('a', md('trust', 1, '## Related\n\n- x\n\n## Later\n\nMore.\n'))],
      }),
    ).toThrow(/Related/);
  });

  it('throws when the frontmatter section does not match the folder', () => {
    expect(() => buildDocsManifest(FIXTURE_META, { trust: [raw('a', md('vendors', 1))] })).toThrow(
      /declares section "vendors"/,
    );
  });

  it('throws when the order is not an integer', () => {
    expect(() =>
      buildDocsManifest(FIXTURE_META, { trust: [raw('a', md('trust', 'one'))] }),
    ).toThrow(/integer/);
  });

  it('throws when a single-page section registers more than one page', () => {
    expect(() =>
      buildDocsManifest(FIXTURE_META, {
        faq: [raw('a', md('faq', 1)), raw('b', md('faq', 2))],
      }),
    ).toThrow(/single-page/);
  });
});

// ─── The real manifest ───────────────────────────────────────────────────────

describe('docs manifest', () => {
  it('shows only the sections that have pages, in section order', () => {
    expect(DOCS_SECTIONS.map((section) => section.id)).toEqual([
      'getting-started',
      'trust',
      'vendors',
      'reviewers',
      'account',
    ]);
    for (const empty of ['faq']) {
      expect(getDocsSection(empty), empty).toBeUndefined();
    }
  });

  it('gives every visible section a label, a summary and an audience', () => {
    for (const section of DOCS_SECTIONS) {
      expect(section.label, section.id).not.toBe('');
      expect(section.summary, section.id).not.toBe('');
      expect(['reader', 'vendor', 'reviewer']).toContain(section.audience);
      expect(section.path).toBe(`/docs/${section.id}`);
    }
    expect(getDocsSection('vendors')?.label).toBe('Vendor guide');
  });

  it('lists the vendor guide, the reviewer guide and the account pages in task order', () => {
    expect(docsSection('vendors').map((page) => page.slug)).toEqual(VENDOR_SLUGS);
    expect(docsSection('reviewers').map((page) => page.slug)).toEqual(REVIEWER_SLUGS);
    expect(docsSection('account').map((page) => page.slug)).toEqual(ACCOUNT_SLUGS);
    expect(docsSection('getting-started').map((page) => page.slug)).toEqual(GETTING_STARTED_SLUGS);
    expect(docsSection('trust').map((page) => page.slug)).toEqual(TRUST_SLUGS);
    expect(DOCS_PAGES).toHaveLength(
      GETTING_STARTED_SLUGS.length +
        TRUST_SLUGS.length +
        VENDOR_SLUGS.length +
        REVIEWER_SLUGS.length +
        ACCOUNT_SLUGS.length,
    );
  });

  it('gives every page a title, a description, a date and an order unique in its section', () => {
    for (const page of DOCS_PAGES) {
      expect(page.title, page.slug).not.toBe('');
      expect(page.description, page.slug).not.toBe('');
      expect(page.lastUpdated, page.slug).toMatch(/^\d{1,2} \w+ \d{4}$/);
      expect(Number.isInteger(page.order), page.slug).toBe(true);
    }
    for (const section of DOCS_SECTIONS) {
      const orders = section.pages.map((page) => page.order);
      expect(new Set(orders).size, section.id).toBe(orders.length);
    }
  });

  it('writes titles in sentence case', () => {
    for (const page of DOCS_PAGES) {
      const words = page.title.split(' ').slice(1);
      const capitalised = words.filter((w) => /^[A-Z][a-z]/.test(w));
      expect(capitalised, page.title).toEqual([]);
    }
  });

  it('ends every page with a Related section linking to its section neighbours', () => {
    for (const page of DOCS_PAGES) {
      const doc = new DOMParser().parseFromString(page.html, 'text/html');
      const last = Array.from(doc.querySelectorAll('h2')).at(-1);
      expect(last?.textContent, page.slug).toBe('Related');
      const links = Array.from(doc.querySelectorAll('h2:last-of-type ~ ul a')).map((a) =>
        a.getAttribute('href'),
      );
      const { prev, next } = docsNeighbours(page);
      for (const neighbour of [prev, next]) {
        if (neighbour) expect(links, `${page.slug} → ${neighbour.slug}`).toContain(neighbour.path);
      }
    }
  });

  it('only links to docs pages and sections that exist', () => {
    for (const page of DOCS_PAGES) {
      const doc = new DOMParser().parseFromString(page.html, 'text/html');
      for (const a of Array.from(doc.querySelectorAll('a[href^="/docs"]'))) {
        const href = a.getAttribute('href') ?? '';
        const [, , section, slug] = href.split('#')[0].split('/');
        const target = !section
          ? true
          : slug
            ? getDocsPage(section, slug)
            : getDocsSection(section);
        expect(target, `${page.slug} → ${href}`).toBeTruthy();
      }
    }
  });

  it('uses no em dashes and never calls the account label a Verified badge', () => {
    for (const page of DOCS_PAGES) {
      expect(page.html, page.slug).not.toContain('—');
      // AECI-965 renamed the public label; "Verified badge" is retired copy.
      expect(page.html, page.slug).not.toMatch(/verified badge|verified vendor/i);
    }
  });

  it('describes review replies the way STAGE_2_VENDOR_PORTAL_SPEC.md §11c ships them (AECI-1181)', () => {
    const page = getDocsPage('vendors', 'replying-to-reviews')!;
    const text = new DOMParser().parseFromString(page.html, 'text/html').body.textContent ?? '';
    // §11c.15: the public label, and §11c.10: a reply never moves ranking.
    expect(text).toContain('"Response from" your company name');
    expect(text).toContain('or where anything ranks');
    // Ruling 1 (pre-moderation), ruling 5 (an edit hides the live reply), §11c.6 (removed is final).
    expect(text).toContain('We check every reply before anyone sees it.');
    expect(text).toContain('Editing a published reply takes it off the product page.');
    expect(text).toContain('A removed reply is final.');
    // §11c.9 and §11c.14: Free cannot write, but can withdraw.
    expect(text).toContain('You can still withdraw one.');
    // Ruling 3: no reviewer notice. Reporting stays the email route.
    expect(text).toContain('We do not tell the reviewer that you replied.');
    expect(page.html).toContain('mailto:reviews@thewbsproject.com');
  });

  it('describes vendor change requests by the buttons the portal shows (AECI-1248 re-check)', () => {
    const page = getDocsPage('reviewers', 'requests-and-corrections')!;
    const text = new DOMParser().parseFromString(page.html, 'text/html').body.textContent ?? '';
    // A public correction is never forwarded to an integration's owner by code.
    expect(text).not.toContain('We will share it with the owner');
    // The integration page's buttons; Contest a field is the connector lane only.
    expect(text).toContain('Request a change');
    expect(text).toContain('Request a correction');
    expect(text).toContain('Suggest a correction');
  });

  it('describes reviews and accounts as the code ships them (AECI-1250)', () => {
    const textOf = (section: string, slug: string): string =>
      new DOMParser().parseFromString(getDocsPage(section, slug)!.html, 'text/html').body
        .textContent ?? '';
    const review = textOf('reviewers', 'writing-a-review');
    // A turned-down review still blocks a second one (reviews.ts dedup).
    expect(review).toContain('You cannot send a second one.');
    // No moderation SLA, and no badge that no code path ever sets (AECI-1258).
    expect(review).not.toMatch(/24 hours|Verified reviewer/);
    const data = textOf('account', 'your-data');
    // Public reviews carry no name (publicReviewColumns), whatever the form help says (AECI-1256).
    expect(data).toContain('Published reviews never show your display name');
    // DELETE /api/account anonymizes reviews and clears the firm.
    expect(data).toContain('Your reviews stay, with no link to you.');
    const signIn = textOf('account', 'signing-in');
    expect(signIn).toContain('Continue with Google');
    expect(signIn).toContain('Email me a sign-in link');
  });

  it('explains ranking in words, with no numbers and no signal names (STAGE_2_5_SPEC.md §2)', () => {
    const page = getDocsPage('trust', 'how-ranking-works')!;
    const text = new DOMParser().parseFromString(page.html, 'text/html').body.textContent ?? '';
    // "No precise published numbers": no weight, threshold or count in the body.
    expect(text).not.toMatch(/\d/);
    // Parameters in words, never the index attributes or the formula.
    expect(text).not.toMatch(
      /listing_tier|review_count|integration_count|mechanism_rank|customRanking|Algolia/,
    );
    // The two signals that order search, and the ruled review-count tie-break.
    expect(text).toContain('completeness decides');
    expect(text).toContain('the number of published reviews');
    expect(text).toContain('No plan, at any price, changes');
  });

  it('carries no screenshots at v0', () => {
    for (const page of DOCS_PAGES) {
      expect(page.html, page.slug).not.toContain('<img');
    }
  });
});

describe('docsNeighbours', () => {
  it('walks one section in order and never crosses into the next', () => {
    const vendors = docsSection('vendors');
    expect(docsNeighbours(vendors[0])).toEqual({ prev: undefined, next: vendors[1] });
    expect(docsNeighbours(vendors[3])).toEqual({ prev: vendors[2], next: vendors[4] });
    // The last vendor page is followed by the reviewer section; the pager stops.
    expect(docsNeighbours(vendors.at(-1)!)).toEqual({ prev: vendors.at(-2), next: undefined });
    const [writing, requests] = docsSection('reviewers');
    expect(docsNeighbours(writing)).toEqual({ prev: undefined, next: requests });
    expect(docsNeighbours(requests)).toEqual({ prev: writing, next: undefined });
  });
});

describe('indexableDocsPaths', () => {
  it('lists /docs and the reader and reviewer pages, and leaves the noindex vendor guide out', () => {
    expect(indexableDocsPaths()).toEqual([
      '/docs',
      '/docs/getting-started',
      ...GETTING_STARTED_SLUGS.map((slug) => `/docs/getting-started/${slug}`),
      '/docs/trust',
      ...TRUST_SLUGS.map((slug) => `/docs/trust/${slug}`),
      '/docs/reviewers',
      ...REVIEWER_SLUGS.map((slug) => `/docs/reviewers/${slug}`),
      '/docs/account',
      ...ACCOUNT_SLUGS.map((slug) => `/docs/account/${slug}`),
    ]);
  });
});

describe('DOCS_ROUTES', () => {
  it('registers the home, one index per non-empty section and one route per page', () => {
    expect(DOCS_ROUTES.map((route) => route.path)).toEqual([
      '',
      'getting-started',
      ...GETTING_STARTED_SLUGS.map((slug) => `getting-started/${slug}`),
      'trust',
      ...TRUST_SLUGS.map((slug) => `trust/${slug}`),
      'vendors',
      ...VENDOR_SLUGS.map((slug) => `vendors/${slug}`),
      'reviewers',
      ...REVIEWER_SLUGS.map((slug) => `reviewers/${slug}`),
      'account',
      ...ACCOUNT_SLUGS.map((slug) => `account/${slug}`),
    ]);
  });

  it('uses no params, so an unknown /docs path falls through to the 404', () => {
    expect(DOCS_ROUTES.some((route) => route.path?.includes(':'))).toBe(false);
    expect(DOCS_ROUTES.some((route) => route.path?.includes('*'))).toBe(false);
    expect(DOCS_ROUTES[0].pathMatch).toBe('full');
  });

  it('gives an empty section no route', () => {
    for (const empty of ['faq']) {
      expect(
        DOCS_ROUTES.some((route) => route.path === empty || route.path?.startsWith(`${empty}/`)),
        empty,
      ).toBe(false);
    }
  });
});
