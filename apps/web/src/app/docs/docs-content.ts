/**
 * Product-docs registry, the **docs manifest** (`/docs`, AECI-1104, AECI-1248;
 * `docs/STAGE_2_PRODUCT_DOCS_SPEC.md` §3–§5, ADR 0040). It generalises the
 * `/legal/*` pattern: Markdown with scalar frontmatter in
 * `src/content/docs/<section>/<slug>.md`, inlined at build time by the esbuild
 * `text` loader, split by `parseFrontmatter` and rendered with `marked` once at
 * module init. See `src/content/README.md` for the mechanism and its traps.
 *
 * This module is the single source for the routes (`docs.routes.ts`), the docs
 * home, the section indexes, the help-center sidebar (`docs-shell.ts`), the
 * "On this page" rail, prev/next and the sitemap (`indexableDocsPaths`, loaded
 * lazily by `src/server/sitemap.ts`). The body is rendered by `renderDocsBody`
 * (`docs-markdown.ts`), which gives every `h2` and `h3` a stable id (AECI-1259).
 *
 * A section is declared in `SECTION_META` (label, summary, audience, order) and
 * gets pages by listing them in `SECTION_PAGES`. **A section with no pages does
 * not exist anywhere a visitor can see**: no home card, no route, no sitemap
 * entry. A `singlePage` section (`faq`) serves its one page at `/docs/<section>`
 * and has no index page.
 *
 * The page order is the frontmatter `order`, not the import order, so the nav
 * and the Markdown agree on one source. `buildDocsManifest` throws at module
 * init when a page's frontmatter `section` does not match the folder, when its
 * `order` is not an integer or repeats within the section, when it does not end
 * in a `## Related` list, or when a single-page section has more than one page.
 */
import signingInMd from '../../content/docs/account/signing-in.md';
import yourDataMd from '../../content/docs/account/your-data.md';
import aboutMd from '../../content/docs/getting-started/about-aec-integrations.md';
import readingMd from '../../content/docs/getting-started/reading-an-integration-page.md';
import taxonomyMd from '../../content/docs/getting-started/taxonomy.md';
import requestsMd from '../../content/docs/reviewers/requests-and-corrections.md';
import writingReviewMd from '../../content/docs/reviewers/writing-a-review.md';
import agreementStatesMd from '../../content/docs/trust/agreement-states.md';
import rankingMd from '../../content/docs/trust/how-ranking-works.md';
import attestingMd from '../../content/docs/vendors/attesting-an-integration.md';
import changeHistoryMd from '../../content/docs/vendors/change-history.md';
import claimingMd from '../../content/docs/vendors/claiming-your-listing.md';
import contestsMd from '../../content/docs/vendors/contests-and-protests.md';
import owningMd from '../../content/docs/vendors/owning-an-integration.md';
import plansMd from '../../content/docs/vendors/plans.md';
import replyingMd from '../../content/docs/vendors/replying-to-reviews.md';
import seatMd from '../../content/docs/vendors/your-seat.md';
import { parseFrontmatter } from '../legal/legal-frontmatter';
import { pathForcesNoindex } from './docs-indexing';
import { type DocsBlock, type DocsHeading, renderDocsBody } from './docs-markdown';

export type { DocsBlock, DocsHeading } from './docs-markdown';

/** A docs section: the first path segment under `/docs`. */
export type DocsSectionId =
  | 'getting-started'
  | 'trust'
  | 'vendors'
  | 'reviewers'
  | 'account'
  | 'faq';

/** Who a section is written for. Drives the audience split on the docs home. */
export type DocsAudience = 'reader' | 'vendor' | 'reviewer';

/** The declared chrome of one section, whether or not it has pages yet. */
export interface DocsSectionMeta {
  readonly label: string;
  /** One line, shown on the docs home and under the section `h1`. */
  readonly summary: string;
  readonly audience: DocsAudience;
  /** Position on the docs home. Unique across sections. */
  readonly order: number;
  /** The section is one page, served at `/docs/<section>` with no index page. */
  readonly singlePage?: boolean;
}

/** One rendered docs page. */
export interface DocsPage {
  readonly section: DocsSectionId;
  readonly slug: string;
  /**
   * Site-absolute path: `/docs/<section>/<slug>`, or `/docs/<section>` for the
   * page of a single-page section.
   */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly order: number;
  /** Pre-formatted display string, rendered verbatim (the legal rule). */
  readonly lastUpdated: string;
  /** The body as one HTML string, heading ids included. Specs read it; the page renders `blocks`. */
  readonly html: string;
  /** The body cut at each `h2` / `h3`, so the template can render the headings with ids. */
  readonly blocks: readonly DocsBlock[];
  /**
   * The `h2`s the "On this page" rail lists, in order. The closing `## Related`
   * is left out: the manifest guarantees it is the last `h2` of every page.
   */
  readonly headings: readonly DocsHeading[];
}

/** A section that has pages, ready to render. */
export interface DocsSection extends DocsSectionMeta {
  readonly id: DocsSectionId;
  /** `/docs/<section>`: the section index, or the page of a single-page section. */
  readonly path: string;
  /** In frontmatter `order`. Never empty. */
  readonly pages: readonly DocsPage[];
}

/** A page source as registered: the slug (file name) and the inlined Markdown. */
export interface RawDocsPage {
  readonly slug: string;
  readonly source: string;
}

/** The built manifest. */
export interface DocsManifest {
  /** Sections with at least one page, in section `order`. */
  readonly sections: readonly DocsSection[];
  /** Every page, section by section, each section in frontmatter order. */
  readonly pages: readonly DocsPage[];
}

/**
 * Section chrome. `label` and `summary` are GETTERS, so no `$localize` runs at
 * module init: `sitemap.xml` loads this module in a lazy server chunk that can
 * run before Angular has installed `$localize` in the isolate, and an eager call
 * there throws `$localize is not defined` and 500s the sitemap (AECI-1248).
 * `buildDocsManifest` keeps them lazy; keep any new chrome lazy too.
 */
const SECTION_META: Readonly<Record<DocsSectionId, DocsSectionMeta>> = {
  'getting-started': {
    get label() {
      return $localize`:@@app.docs.section.gettingStarted:Getting started`;
    },
    get summary() {
      return $localize`:@@app.docs.section.gettingStarted.summary:What AEC Integrations is and how to read an integration page.`;
    },
    audience: 'reader',
    order: 1,
  },
  trust: {
    get label() {
      return $localize`:@@app.docs.section.trust:Trust and ranking`;
    },
    get summary() {
      return $localize`:@@app.docs.section.trust.summary:How ranking works and how to read the agreement labels.`;
    },
    audience: 'reader',
    order: 2,
  },
  vendors: {
    get label() {
      return $localize`:@@app.docs.section.vendors:Vendor guide`;
    },
    get summary() {
      return $localize`:@@app.docs.section.vendors.summary:Claim your listing, manage your seat, and keep your integrations accurate.`;
    },
    audience: 'vendor',
    order: 3,
  },
  reviewers: {
    get label() {
      return $localize`:@@app.docs.section.reviewers:Reviewer guide`;
    },
    get summary() {
      return $localize`:@@app.docs.section.reviewers.summary:Write a review, ask for a missing integration, or correct a listing.`;
    },
    audience: 'reviewer',
    order: 4,
  },
  account: {
    get label() {
      return $localize`:@@app.docs.section.account:Your account`;
    },
    get summary() {
      return $localize`:@@app.docs.section.account.summary:Signing in, and what happens to your data.`;
    },
    audience: 'reviewer',
    order: 5,
  },
  faq: {
    get label() {
      return $localize`:@@app.docs.section.faq:Common questions`;
    },
    get summary() {
      return $localize`:@@app.docs.section.faq.summary:Short answers to the questions people ask us most.`;
    },
    audience: 'reader',
    order: 6,
    singlePage: true,
  },
};

/** Registered pages per section. A section absent here, or empty, is hidden. */
const SECTION_PAGES: Readonly<Partial<Record<DocsSectionId, readonly RawDocsPage[]>>> = {
  'getting-started': [
    { slug: 'about-aec-integrations', source: aboutMd },
    { slug: 'reading-an-integration-page', source: readingMd },
    { slug: 'taxonomy', source: taxonomyMd },
  ],
  trust: [
    { slug: 'how-ranking-works', source: rankingMd },
    { slug: 'agreement-states', source: agreementStatesMd },
  ],
  vendors: [
    { slug: 'claiming-your-listing', source: claimingMd },
    { slug: 'your-seat', source: seatMd },
    { slug: 'attesting-an-integration', source: attestingMd },
    { slug: 'owning-an-integration', source: owningMd },
    { slug: 'contests-and-protests', source: contestsMd },
    { slug: 'replying-to-reviews', source: replyingMd },
    { slug: 'plans', source: plansMd },
    { slug: 'change-history', source: changeHistoryMd },
  ],
  reviewers: [
    { slug: 'writing-a-review', source: writingReviewMd },
    { slug: 'requests-and-corrections', source: requestsMd },
  ],
  account: [
    { slug: 'signing-in', source: signingInMd },
    { slug: 'your-data', source: yourDataMd },
  ],
};

function buildPage(
  section: DocsSectionId,
  meta: DocsSectionMeta,
  { slug, source }: RawDocsPage,
): DocsPage {
  const { data, body } = parseFrontmatter(source);
  if (data['section'] !== section) {
    throw new Error(`Docs page "${slug}" declares section "${data['section']}", not "${section}"`);
  }
  const order = Number(data['order'] ?? Number.NaN);
  if (!Number.isInteger(order)) {
    throw new Error(`Docs page "${section}/${slug}" has no integer frontmatter order`);
  }
  const { html, blocks, h2s } = renderDocsBody(body);
  if (h2s.at(-1)?.text !== 'Related') {
    throw new Error(`Docs page "${section}/${slug}" does not end in a "## Related" list`);
  }
  return {
    section,
    slug,
    path: meta.singlePage ? `/docs/${section}` : `/docs/${section}/${slug}`,
    title: data['title'] ?? '',
    description: data['description'] ?? '',
    order,
    lastUpdated: data['last_updated'] ?? '',
    html,
    blocks,
    headings: h2s.slice(0, -1),
  };
}

/**
 * Builds the manifest from declared section chrome and registered pages. Pure,
 * and exported so a spec can build a fixture manifest (an empty section, a
 * single-page section) without touching the real content.
 */
export function buildDocsManifest(
  meta: Readonly<Record<DocsSectionId, DocsSectionMeta>>,
  pagesBySection: Readonly<Partial<Record<DocsSectionId, readonly RawDocsPage[]>>>,
): DocsManifest {
  const sections: DocsSection[] = [];
  for (const id of Object.keys(meta) as DocsSectionId[]) {
    const raw = pagesBySection[id] ?? [];
    if (raw.length === 0) continue;
    const sectionMeta = meta[id];
    if (sectionMeta.singlePage && raw.length > 1) {
      throw new Error(`Docs section "${id}" is single-page but registers ${raw.length} pages`);
    }
    const pages = raw.map((page) => buildPage(id, sectionMeta, page));
    const seen = new Map<number, string>();
    for (const page of pages) {
      const clash = seen.get(page.order);
      if (clash) {
        throw new Error(
          `Docs pages "${id}/${clash}" and "${id}/${page.slug}" share order ${page.order}`,
        );
      }
      seen.set(page.order, page.slug);
    }
    pages.sort((a, b) => a.order - b.order);
    // No spread: it would read the `label` / `summary` getters, and so call
    // `$localize`, at module init (see `SECTION_META`).
    sections.push({
      id,
      path: `/docs/${id}`,
      pages,
      audience: sectionMeta.audience,
      order: sectionMeta.order,
      singlePage: sectionMeta.singlePage === true,
      get label() {
        return sectionMeta.label;
      },
      get summary() {
        return sectionMeta.summary;
      },
    });
  }
  sections.sort((a, b) => a.order - b.order);
  return { sections, pages: sections.flatMap((section) => section.pages) };
}

const MANIFEST = buildDocsManifest(SECTION_META, SECTION_PAGES);

/** Sections with at least one page, in section order. Empty sections never appear. */
export const DOCS_SECTIONS: readonly DocsSection[] = MANIFEST.sections;

/** Every docs page, section by section, each section in frontmatter order. */
export const DOCS_PAGES: readonly DocsPage[] = MANIFEST.pages;

/** A non-empty section, or `undefined`. */
export function getDocsSection(
  section: string,
  manifest: DocsManifest = MANIFEST,
): DocsSection | undefined {
  return manifest.sections.find((entry) => entry.id === section);
}

/** The pages of one section, in frontmatter order. */
export function docsSection(section: DocsSectionId): readonly DocsPage[] {
  return getDocsSection(section)?.pages ?? [];
}

/** The page at `/docs/<section>/<slug>`, or `undefined`. */
export function getDocsPage(section: string, slug: string): DocsPage | undefined {
  return DOCS_PAGES.find((page) => page.section === section && page.slug === slug);
}

/** The previous and next page in the same section, by `order`. Never across sections. */
export function docsNeighbours(
  page: DocsPage,
  manifest: DocsManifest = MANIFEST,
): { readonly prev?: DocsPage; readonly next?: DocsPage } {
  const pages = getDocsSection(page.section, manifest)?.pages ?? [];
  const index = pages.findIndex((entry) => entry.slug === page.slug);
  if (index < 0) return {};
  return { prev: pages[index - 1], next: pages[index + 1] };
}

/**
 * The docs paths `sitemap.xml` lists: `/docs`, each section index, each page,
 * minus anything `pathForcesNoindex` covers. A single-page section contributes
 * its one path once.
 */
export function indexableDocsPaths(manifest: DocsManifest = MANIFEST): readonly string[] {
  const paths = ['/docs'];
  for (const section of manifest.sections) {
    if (!section.singlePage) paths.push(section.path);
    for (const page of section.pages) paths.push(page.path);
  }
  return paths.filter((path) => !pathForcesNoindex(path));
}
