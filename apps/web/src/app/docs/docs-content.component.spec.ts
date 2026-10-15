/**
 * AECI-1104, AECI-1248, AECI-1259, AECI-1265, AECI-1271 — the docs manifest and
 * the routes generated from it, including the split into the General guide and
 * the vendor guide, and the guard against General → vendor-guide links.
 *
 * `*.component.spec.ts` (the Angular `ng test` tier) because the manifest
 * imports `.md` files, and only the Angular build carries the esbuild `text`
 * loader. The sitemap's use of `indexableDocsPaths` is pinned with a stand-in in
 * `src/server/sitemap.spec.ts`; the real derivation is pinned here.
 */
import { describe, expect, it } from 'vitest';

import { routes } from '../app.routes';

import {
  DOCS_PAGES,
  DOCS_SECTIONS,
  type DocsSectionId,
  GENERAL_TO_VENDOR_LINK_ALLOWLIST,
  type DocsSectionMeta,
  type RawDocsPage,
  buildDocsManifest,
  docsGuideForPath,
  docsNeighbours,
  docsSection,
  docsSectionsInGuide,
  getDocsPage,
  getDocsPageByPath,
  getDocsSection,
  getDocsSectionIndexByPath,
  indexableDocsPaths,
} from './docs-content';
import { NOINDEX_PATH_PREFIXES, pathForcesNoindex } from './docs-indexing';
import { appRoutePatterns, findBrokenDocsLinks } from './docs-link-check.harness';
import { headingSlug } from './docs-markdown';
import { DocsShellComponent } from './docs-shell';
import { DOCS_CHILD_ROUTES, DOCS_ROUTES } from './docs.routes';

// AECI-1265, AECI-1271: the vendor guide, overview and claiming first. Every
// page keeps its `/docs/vendors/*` URL.
const VENDOR_SLUGS = [
  'overview',
  'claiming-your-listing',
  'your-seat',
  'your-dashboard',
  'editing-profile-and-products',
  'notifications-and-messages',
  'confirming-integration-data',
  'owning-an-integration',
  'requesting-changes-and-appeals',
  'replying-to-reviews',
  'plans',
  'checklists',
  'change-history',
  'connector-vendors',
];

const REVIEWER_SLUGS = ['writing-a-review', 'requests-and-corrections'];

const ACCOUNT_SLUGS = ['signing-in', 'your-data'];

const GETTING_STARTED_SLUGS = [
  'about-aec-integrations',
  'reading-an-integration-page',
  'checking-before-you-buy',
  'taxonomy',
];

const TRUST_SLUGS = ['how-ranking-works', 'agreement-states', 'listing-submissions'];

// ─── Fixture manifest ────────────────────────────────────────────────────────

const FIXTURE_META: Record<DocsSectionId, DocsSectionMeta> = {
  'getting-started': { label: 'Getting started', summary: 's', audience: 'reader', order: 1 },
  trust: { label: 'Trust', summary: 's', audience: 'reader', order: 2 },
  reviewers: { label: 'Reviewers', summary: 's', audience: 'reviewer', order: 3 },
  account: { label: 'Account', summary: 's', audience: 'reviewer', order: 4 },
  vendors: { label: 'Vendors', summary: 's', audience: 'vendor', order: 5, guide: 'vendor' },
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
    'last_updated: October 8, 2026',
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

  // AECI-1271: the two guides have disjoint URL spaces.
  it('puts every vendor-guide page under /docs/vendors and nothing else there', () => {
    const manifest = buildDocsManifest(FIXTURE_META, {
      trust: [raw('t', md('trust', 1))],
      vendors: [raw('overview', md('vendors', 1)), raw('seat', md('vendors', 2))],
    });
    const guide = getDocsSection('vendors', manifest)!;
    expect(guide.path).toBe('/docs/vendors');
    expect(guide.hasIndex).toBe(true);
    expect(guide.guide).toBe('vendor');
    expect(guide.pages.map((page) => page.path)).toEqual([
      '/docs/vendors/overview',
      '/docs/vendors/seat',
    ]);
    expect(getDocsSectionIndexByPath('/docs/vendors', manifest)?.id).toBe('vendors');
    expect(docsGuideForPath('/docs/vendors/overview', manifest)).toBe('vendor');
    expect(docsGuideForPath('/docs/trust/t', manifest)).toBe('help');
    expect(docsGuideForPath('/docs', manifest)).toBe('help');
    expect(docsSectionsInGuide('help', manifest).map((section) => section.id)).toEqual(['trust']);
  });

  it('throws when two pages share a path', () => {
    expect(() =>
      buildDocsManifest(FIXTURE_META, {
        vendors: [raw('overview', md('vendors', 1)), raw('overview', md('vendors', 2))],
      }),
    ).toThrow(/share a path/);
  });

  it('builds a section intro, split at its first heading, for an index page only', () => {
    const manifest = buildDocsManifest(
      FIXTURE_META,
      { vendors: [raw('a', md('vendors', 1))] },
      { vendors: 'Lead [link](/docs).\n\n## Current limits\n\n- One.\n' },
    );
    const intro = getDocsSection('vendors', manifest)!.intro!;
    expect(intro.lead.map((block) => block.heading)).toEqual([undefined]);
    expect(intro.lead[0].html).toContain('Lead');
    expect(intro.rest[0].heading).toEqual({
      id: 'current-limits',
      text: 'Current limits',
      level: 2,
    });
    expect(intro.html).toContain('id="current-limits"');
    expect(() =>
      buildDocsManifest(FIXTURE_META, { faq: [raw('faq', md('faq', 1))] }, { faq: 'Lead.' }),
    ).toThrow(/no index page/);
  });
});

// ─── The cross-guide guard (AECI-1271) ───────────────────────────────────────

describe('buildDocsManifest cross-guide guard (fixtures)', () => {
  const related = (links: string): string => `Body.\n\n## Related\n\n${links}`;
  const vendorPages = { vendors: [raw('plans', md('vendors', 1))] };

  it('throws on a General page linking into the vendor guide, naming the file', () => {
    for (const href of [
      '/docs/vendors',
      '/docs/vendors/plans',
      '/docs/vendors/plans#free',
      '/docs/vendors/plans?x=1',
      '/docs/vendors/',
      'https://www.aecintegrations.com/docs/vendors/plans',
    ]) {
      expect(
        () =>
          buildDocsManifest(FIXTURE_META, {
            ...vendorPages,
            trust: [raw('ranking', md('trust', 1, related(`- [Plans](${href})\n`)))],
          }),
        href,
      ).toThrow(
        `docs: content/docs/trust/ranking.md links into the vendor guide (${href}). Add it to GENERAL_TO_VENDOR_LINK_ALLOWLIST if that is deliberate.`,
      );
    }
  });

  it('checks inline body links and General intros too', () => {
    expect(() =>
      buildDocsManifest(FIXTURE_META, {
        ...vendorPages,
        trust: [
          raw('a', md('trust', 1, 'See [plans](/docs/vendors/plans).\n\n## Related\n\n- x\n')),
        ],
      }),
    ).toThrow(/content\/docs\/trust\/a\.md/);
    expect(() =>
      buildDocsManifest(
        FIXTURE_META,
        { ...vendorPages, trust: [raw('a', md('trust', 1))] },
        { trust: 'Vendors read [the guide](/docs/vendors).' },
      ),
    ).toThrow(/content\/docs\/trust\/_index\.md links into the vendor guide/);
  });

  it('passes an allowlisted link, matched without its fragment', () => {
    expect(() =>
      buildDocsManifest(
        FIXTURE_META,
        {
          ...vendorPages,
          trust: [raw('a', md('trust', 1, related('- [Plans](/docs/vendors/plans#free)\n')))],
        },
        {},
        ['/docs/vendors/plans'],
      ),
    ).not.toThrow();
  });

  it('passes vendor → General links and look-alike paths outside the guide', () => {
    expect(() =>
      buildDocsManifest(FIXTURE_META, {
        vendors: [raw('plans', md('vendors', 1, related('- [Ranking](/docs/trust/a)\n')))],
        trust: [
          raw(
            'a',
            md(
              'trust',
              1,
              related(
                '- [Look-alike](/docs/vendorsx)\n- [Portal](/vendor)\n- [Mail](mailto:x@y.z)\n',
              ),
            ),
          ),
        ],
      }),
    ).not.toThrow();
  });
});

// ─── The real manifest ───────────────────────────────────────────────────────

describe('docs manifest', () => {
  it('shows only the sections that have pages, in section order', () => {
    expect(DOCS_SECTIONS.map((section) => section.id)).toEqual([
      'getting-started',
      'trust',
      'reviewers',
      'account',
      'vendors',
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
    }
    expect(getDocsSection('vendors')?.label).toBe('Vendor guide');
  });

  // AECI-1265, AECI-1271: the General guide and the vendor guide, from one
  // manifest, with disjoint URL spaces.
  it('splits the docs into the General guide and the vendor guide', () => {
    expect(docsSectionsInGuide('help').map((section) => section.id)).toEqual([
      'getting-started',
      'trust',
      'reviewers',
      'account',
    ]);
    expect(docsSectionsInGuide('vendor').map((section) => section.id)).toEqual(['vendors']);
    for (const section of DOCS_SECTIONS) {
      expect(section.path, section.id).toBe(`/docs/${section.id}`);
      expect(section.hasIndex, section.id).toBe(true);
    }
    // Every vendor URL kept its address, the moved overview and claiming included.
    for (const page of docsSection('vendors')) {
      expect(page.path).toBe(`/docs/vendors/${page.slug}`);
    }
    expect(docsGuideForPath('/docs/vendors')).toBe('vendor');
    expect(docsGuideForPath('/docs/vendors/plans')).toBe('vendor');
    expect(docsGuideForPath('/docs/vendors/overview')).toBe('vendor');
    expect(docsGuideForPath('/docs/vendors/claiming-your-listing')).toBe('vendor');
    // No General section or page lives under /docs/vendors.
    for (const section of docsSectionsInGuide('help')) {
      for (const path of [section.path, ...section.pages.map((page) => page.path)]) {
        expect(path === '/docs/vendors' || path.startsWith('/docs/vendors/'), path).toBe(false);
      }
    }
  });

  // AECI-1271: the guard ships with nothing on its allowlist, and the real
  // content passes it (the manifest built at import, or this file would not load).
  it('ships an empty General → vendor allowlist, and no General page links into the guide', () => {
    expect(GENERAL_TO_VENDOR_LINK_ALLOWLIST).toEqual([]);
    for (const page of DOCS_PAGES.filter((entry) => entry.section !== 'vendors')) {
      for (const href of page.links) {
        expect(href.startsWith('/docs/vendors'), `${page.slug} → ${href}`).toBe(false);
      }
    }
  });

  it('gives the vendor guide a landing page with one Current limits note', () => {
    const intro = getDocsSection('vendors')!.intro!;
    expect(intro.lead.length).toBeGreaterThan(0);
    expect(intro.rest.map((block) => block.heading?.text)).toEqual(['Current limits']);
    const doc = new DOMParser().parseFromString(intro.html, 'text/html');
    expect(Array.from(doc.querySelectorAll('li')).length).toBe(3);
    // The notes it collects are gone from the pages they came from.
    for (const page of DOCS_PAGES) {
      expect(page.html, page.slug).not.toMatch(/is planned|not part of the portal yet|For now,/);
    }
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
      expect(page.lastUpdated, page.slug).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
      expect(Number.isInteger(page.order), page.slug).toBe(true);
    }
    for (const section of DOCS_SECTIONS) {
      const orders = section.pages.map((page) => page.order);
      expect(new Set(orders).size, section.id).toBe(orders.length);
    }
  });

  it('writes titles in sentence case', () => {
    for (const page of DOCS_PAGES) {
      // The brand name is a proper noun, so it keeps its capitals (AECI-1261).
      const words = page.title.replaceAll('AEC Integrations', 'AEC').split(' ').slice(1);
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

  // AECI-1254: the link checker (`docs-link-check.harness.ts`). Every in-app
  // href in every page and intro must land: a /docs href on a page, index or
  // heading the manifest serves, anything else on a route in the real route
  // table. A renamed page breaks the links to its old path here.
  it('only links to docs pages and app routes that exist', async () => {
    const hrefsIn = (html: string): string[] =>
      Array.from(
        new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a[href]'),
      ).map((a) => a.getAttribute('href') ?? '');
    const headingIdsIn = (html: string): string[] =>
      Array.from(new DOMParser().parseFromString(html, 'text/html').querySelectorAll('[id]')).map(
        (el) => el.id,
      );

    // The folder is the section id and the file name is the slug (the manifest
    // enforces the first; `RawDocsPage` documents the second).
    const sources = [
      ...DOCS_PAGES.map((page) => ({
        file: `src/content/docs/${page.section}/${page.slug}.md`,
        hrefs: hrefsIn(page.html),
      })),
      ...DOCS_SECTIONS.filter((section) => section.intro).map((section) => ({
        file: `src/content/docs/${section.id}/_index.md`,
        hrefs: hrefsIn(section.intro!.html),
      })),
    ];
    const routePatterns = await appRoutePatterns(routes);
    // A flattening bug must not shrink the table unnoticed: pin one route from
    // the root, one from a lazy child table and one parameterised.
    expect(routePatterns).toEqual(
      expect.arrayContaining(['/methodology', '/vendor/:vendorSlug/seats', '/products/:slug']),
    );

    const failures = findBrokenDocsLinks(sources, {
      routePatterns,
      docsHeadingIds: (path) => {
        if (path === '/docs') return [];
        const html = getDocsPageByPath(path)?.html ?? getDocsSectionIndexByPath(path)?.intro?.html;
        if (html !== undefined) return headingIdsIn(html);
        return getDocsSectionIndexByPath(path) ? [] : undefined;
      },
    });
    expect(failures).toEqual([]);
  });

  // AECI-1259: the rail and every #link depend on these ids being unique and
  // derived from the heading text alone, so a rebuild never moves them.
  it('gives every h2 and h3 a unique id slugged from its text', () => {
    for (const page of DOCS_PAGES) {
      const doc = new DOMParser().parseFromString(page.html, 'text/html');
      const headings = Array.from(doc.querySelectorAll('h2, h3'));
      const ids = headings.map((h) => h.id);
      expect(new Set(ids).size, page.slug).toBe(ids.length);
      for (const h of headings) {
        expect(h.id, `${page.slug}: ${h.textContent}`).toMatch(
          new RegExp(`^${headingSlug(h.textContent ?? '')}(-\\d+)?$`),
        );
      }
    }
  });

  // AECI-1259: the rail lists the h2s minus the closing Related, in order.
  it('exposes each page h2 list for the rail, Related left out', () => {
    for (const page of DOCS_PAGES) {
      const doc = new DOMParser().parseFromString(page.html, 'text/html');
      const h2s = Array.from(doc.querySelectorAll('h2')).map((h) => ({
        id: h.id,
        text: h.textContent,
      }));
      expect(page.headings, page.slug).toEqual(h2s.slice(0, -1));
      expect(
        page.headings.map((h) => h.text),
        page.slug,
      ).not.toContain('Related');
    }
    expect(getDocsPage('trust', 'how-ranking-works')!.headings.map((h) => h.id)).toEqual([
      'search',
      'browsing-lists',
      'the-home-page',
      'what-does-not-count',
      'what-a-plan-does-not-buy',
      'corrections-are-free',
    ]);
  });

  it('uses no em dashes and never calls the account label a Verified badge', () => {
    for (const page of DOCS_PAGES) {
      expect(page.html, page.slug).not.toContain('—');
      // AECI-965 renamed the public label; "Verified badge" is retired copy.
      expect(page.html, page.slug).not.toMatch(/verified badge|verified vendor/i);
    }
  });

  // AECI-1264 (marketing review B1): the public account badge is gone, and no
  // page may say a plan turns a public label on or off.
  it('never describes a public account label, and never links its retired pages', () => {
    for (const page of DOCS_PAGES) {
      expect(page.html, page.slug).not.toMatch(/Active on AEC Integrations|account label/i);
      expect(page.html, page.slug).not.toContain('/docs/trust/the-account-label');
      expect(page.html, page.slug).not.toContain('/docs/vendors/plans-and-the-account-label');
      // AECI-1267: the two renamed vendor pages 301 to their new slugs.
      expect(page.html, page.slug).not.toContain('/docs/vendors/contests-and-protests');
      expect(page.html, page.slug).not.toContain('/docs/vendors/attesting-an-integration');
    }
    expect(getDocsPage('trust', 'the-account-label')).toBeUndefined();
    expect(getDocsPage('vendors', 'plans')?.title).toBe('Plans');
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
    // AECI-1265: there is no reviews@ mailbox, so reports go to support@.
    expect(page.html).toContain('mailto:support@aecintegrations.com');
  });

  it('describes vendor change requests by the buttons the portal shows (AECI-1248 re-check)', () => {
    const textOf = (section: string, slug: string): string =>
      new DOMParser().parseFromString(getDocsPage(section, slug)!.html, 'text/html').body
        .textContent ?? '';
    const requests = textOf('reviewers', 'requests-and-corrections');
    // A public correction is never forwarded to an integration's owner by code.
    expect(requests).not.toContain('We will share it with the owner');
    expect(requests).toContain('Suggest a correction');
    // AECI-1265: the vendor route moved to the vendor guide. AECI-1271: one
    // sentence names it, in plain text.
    expect(requests).not.toContain('Request a change');
    const contests = textOf('vendors', 'requesting-changes-and-appeals');
    // The integration page's buttons. AECI-1267: the connector lane says
    // Request a change too, and Messages files them under Change requests.
    expect(contests).toContain('Request a change');
    expect(contests).toContain('Request a correction');
    expect(contests).not.toContain('Contest a field');
    expect(contests).not.toContain('Field contests');
  });

  // AECI-1265 B3: vendor material lives in the vendor guide, not on buyer pages.
  it('keeps vendor material out of the buyer pages', () => {
    const textOf = (section: string, slug: string): string =>
      new DOMParser().parseFromString(getDocsPage(section, slug)!.html, 'text/html').body
        .textContent ?? '';
    expect(textOf('trust', 'agreement-states')).not.toContain('If you are the vendor');
    expect(textOf('account', 'signing-in')).not.toContain('seat was granted to');
    const data = textOf('account', 'your-data');
    expect(data).not.toContain('your colleagues see your display name');
    expect(data).not.toContain('gives up that seat');
    const seat = textOf('vendors', 'your-seat');
    expect(seat).toContain('see your display name in the vendor portal');
    expect(seat).toContain('If you delete your account, you give up your seat.');
    // The connector sections moved to their own page.
    expect(textOf('vendors', 'owning-an-integration')).not.toContain(
      'Integrations your company offers',
    );
    expect(textOf('vendors', 'claiming-your-listing')).not.toContain(
      'maintains your connector catalog',
    );
    expect(textOf('vendors', 'connector-vendors')).toContain('maintains your connector catalog');
    expect(textOf('vendors', 'connector-vendors')).toContain('Integrations your company offers');
  });

  // AECI-1265 B2: the panel line and the Plans list, as approved 2026-10-09.
  it('quotes the reworded plan panel line and the Why buyers trust the order list', () => {
    const page = getDocsPage('vendors', 'plans')!;
    const text = new DOMParser().parseFromString(page.html, 'text/html').body.textContent ?? '';
    expect(text).toContain(
      'No plan changes where you rank or appear, or whether a review is published.',
    );
    expect(text).toContain(
      "how an agreement label is worked out. Both companies' answers count the same.",
    );
    expect(text).not.toContain('what we verify');
  });

  // Chris, 2026-10-13: connector-delivered integrations are not sold as part of Managed.
  it('never lists connector integrations among what Managed adds', () => {
    const page = getDocsPage('vendors', 'plans')!;
    const doc = new DOMParser().parseFromString(page.html, 'text/html');
    const heading = doc.getElementById('what-managed-adds')!;
    const list = heading.nextElementSibling!;
    expect(list.tagName).toBe('UL');
    expect(list.textContent).not.toMatch(/connector/i);
    const overview = new DOMParser().parseFromString(
      getDocsPage('vendors', 'overview')!.html,
      'text/html',
    );
    const managedLine = [...overview.querySelectorAll('li')].find((li) =>
      li.textContent?.startsWith('Managed'),
    )!;
    expect(managedLine.textContent).not.toMatch(/connector/i);
  });

  // AECI-1265 B4: the buying page quotes the four labels as the badge renders them.
  it('quotes the agreement labels exactly on Checking an integration before you buy', () => {
    const page = getDocsPage('getting-started', 'checking-before-you-buy')!;
    const text = new DOMParser().parseFromString(page.html, 'text/html').body.textContent ?? '';
    for (const label of [
      'Listed by AEC Integrations',
      'Confirmed by (a company)',
      'Confirmed by one company',
      'Confirmed by both companies',
      'Companies disagree',
    ]) {
      expect(text, label).toContain(label);
    }
    // Never claim the catalog is vendor-verified.
    expect(text).not.toMatch(/verified/i);
  });

  // AECI-1265 B5: claiming opens with what buyers see, using the marker's labels.
  it('opens Claiming your vendor listing with what changes for buyers', () => {
    const page = getDocsPage('vendors', 'claiming-your-listing')!;
    const first = new DOMParser().parseFromString(page.html, 'text/html').querySelector('p');
    expect(first?.textContent).toContain('Vendor maintained · Updated');
    expect(first?.textContent).toContain('AEC Integrations maintained');
  });

  // AECI-1266: the claim button reads the same on every listing, so the page names
  // one button and says a colleague joining uses it too.
  it('names one claim button and covers a colleague joining', () => {
    const page = getDocsPage('vendors', 'claiming-your-listing')!;
    const text = new DOMParser().parseFromString(page.html, 'text/html').body.textContent ?? '';
    expect(text).not.toContain('Request access');
    expect(text).toContain('when a colleague already has a seat');
  });

  // AECI-1265 B6: the full "cannot be bought" statement lives on How ranking works.
  it('states the cannot-be-bought rule in full only on How ranking works', () => {
    for (const page of DOCS_PAGES.filter((entry) => entry.slug !== 'how-ranking-works')) {
      expect(page.html, page.slug).not.toMatch(
        /at any price|for sale|can buy|not bought|sponsored placement|promoted tier|pay-for-placement|pay to change/i,
      );
    }
    const ranking = getDocsPage('trust', 'how-ranking-works')!.html;
    expect(ranking).toContain('No plan, at any price, changes');
  });

  // AECI-1265 B7: the connector contest list uses the labels the form shows.
  it('names connector contest fields by their portal labels, and defines data flow', () => {
    const textOf = (section: string, slug: string): string =>
      new DOMParser().parseFromString(getDocsPage(section, slug)!.html, 'text/html').body
        .textContent ?? '';
    const contests = textOf('vendors', 'requesting-changes-and-appeals');
    for (const label of [
      'Name',
      'Connection name',
      'Direction',
      'Description',
      'Listing link',
      'Documentation link',
      'Pricing',
      'Release stage',
      'Owner',
    ]) {
      expect(contests, label).toContain(label);
    }
    // AECI-1267: the form now uses the integration page's labels.
    expect(contests).not.toContain('Mechanism name');
    expect(contests).not.toContain('Maturity');
    const attesting = textOf('vendors', 'confirming-integration-data');
    expect(attesting).toContain("Data that's shared");
    expect(attesting).toContain('types of data');
    expect(attesting).not.toContain('only just opened');
  });

  // AECI-1265 B9: there is no reviews@ mailbox.
  it('sends every report to support@, never a reviews@ address', () => {
    for (const page of DOCS_PAGES) {
      expect(page.html, page.slug).not.toContain('reviews@');
    }
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
    // The vendor guide's last page is followed by no other section; the pager stops.
    expect(docsNeighbours(vendors.at(-1)!)).toEqual({ prev: vendors.at(-2), next: undefined });
    const [writing, requests] = docsSection('reviewers');
    expect(docsNeighbours(writing)).toEqual({ prev: undefined, next: requests });
    expect(docsNeighbours(requests)).toEqual({ prev: writing, next: undefined });
  });
});

describe('indexableDocsPaths', () => {
  it('lists /docs, every help page and the whole vendor guide (AECI-1253)', () => {
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
      // The vendor guide is indexable since AECI-1253: its landing and every page.
      '/docs/vendors',
      ...VENDOR_SLUGS.map((slug) => `/docs/vendors/${slug}`),
    ]);
  });

  it('holds no docs path out, and the prefix rule still works for a later entry', () => {
    // NOINDEX_PATH_PREFIXES holds no docs path since AECI-1253; its only entries
    // are the archived legal versions (AECI-1361). The explicit-list call pins
    // the matching rule a later entry would rely on.
    expect(pathForcesNoindex('/docs/vendors/your-seat', ['/docs/vendors'])).toBe(true);
    expect(NOINDEX_PATH_PREFIXES.filter((prefix) => prefix.startsWith('/docs'))).toEqual([]);
    expect(indexableDocsPaths().some((path) => pathForcesNoindex(path))).toBe(false);
  });
});

describe('DOCS_ROUTES', () => {
  // AECI-1259: one layout route that adds no path segment, so URLs are unchanged.
  it('is one shell layout route with the docs routes as its children', () => {
    expect(DOCS_ROUTES).toHaveLength(1);
    expect(DOCS_ROUTES[0]).toEqual({
      path: '',
      component: DocsShellComponent,
      children: DOCS_CHILD_ROUTES,
    });
    // No pathMatch: an unmatched child backs out of the shell to the 404.
    expect(DOCS_ROUTES[0].pathMatch).toBeUndefined();
  });

  it('registers the home, one index per non-empty section and one route per page', () => {
    expect(DOCS_CHILD_ROUTES.map((route) => route.path)).toEqual([
      '',
      'getting-started',
      ...GETTING_STARTED_SLUGS.map((slug) => `getting-started/${slug}`),
      'trust',
      ...TRUST_SLUGS.map((slug) => `trust/${slug}`),
      'reviewers',
      ...REVIEWER_SLUGS.map((slug) => `reviewers/${slug}`),
      'account',
      ...ACCOUNT_SLUGS.map((slug) => `account/${slug}`),
      'vendors',
      ...VENDOR_SLUGS.map((slug) => `vendors/${slug}`),
    ]);
  });

  it('uses no params, so an unknown /docs path falls through to the 404', () => {
    expect(DOCS_CHILD_ROUTES.some((route) => route.path?.includes(':'))).toBe(false);
    expect(DOCS_CHILD_ROUTES.some((route) => route.path?.includes('*'))).toBe(false);
    expect(DOCS_CHILD_ROUTES[0].pathMatch).toBe('full');
  });

  it('gives an empty section no route', () => {
    for (const empty of ['faq']) {
      expect(
        DOCS_CHILD_ROUTES.some(
          (route) => route.path === empty || route.path?.startsWith(`${empty}/`),
        ),
        empty,
      ).toBe(false);
    }
  });
});
