/**
 * Product-docs registry (`/docs`, AECI-1104; `docs/STAGE_2_PRODUCT_DOCS_SPEC.md`
 * §3–§5). The docs manifest generalises the `/legal/*` pattern: Markdown with
 * scalar frontmatter in `src/content/docs/<section>/<slug>.md`, inlined at build
 * time by the esbuild `text` loader, split by `parseFrontmatter` and rendered
 * with `marked` once at module init. See `src/content/README.md` for the
 * mechanism and its traps.
 *
 * Only the vendor guide is built so far. A new section is a new entry in
 * `SECTIONS` plus its imports below; the route table in `docs.routes.ts` and
 * the page nav are generated from this manifest, so nothing else changes.
 *
 * The page order is the frontmatter `order`, not the import order, so the nav
 * and the Markdown agree on one source. A page whose frontmatter `section` does
 * not match the folder it is registered under throws at module init.
 */
import { marked } from 'marked';

import attestingMd from '../../content/docs/vendors/attesting-an-integration.md';
import claimingMd from '../../content/docs/vendors/claiming-your-listing.md';
import contestsMd from '../../content/docs/vendors/contests-and-protests.md';
import owningMd from '../../content/docs/vendors/owning-an-integration.md';
import plansMd from '../../content/docs/vendors/plans-and-the-account-label.md';
import seatMd from '../../content/docs/vendors/your-seat.md';
import { parseFrontmatter } from '../legal/legal-frontmatter';

/** A docs section: the first path segment under `/docs`. */
export type DocsSectionId = 'vendors';

/** One rendered docs page. */
export interface DocsPage {
  readonly section: DocsSectionId;
  readonly slug: string;
  /** Site-absolute path, `/docs/<section>/<slug>`. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly order: number;
  /** Pre-formatted display string, rendered verbatim (the legal rule). */
  readonly lastUpdated: string;
  readonly html: string;
}

interface RawPage {
  readonly slug: string;
  readonly source: string;
}

const SECTIONS: Readonly<Record<DocsSectionId, readonly RawPage[]>> = {
  vendors: [
    { slug: 'claiming-your-listing', source: claimingMd },
    { slug: 'your-seat', source: seatMd },
    { slug: 'attesting-an-integration', source: attestingMd },
    { slug: 'owning-an-integration', source: owningMd },
    { slug: 'contests-and-protests', source: contestsMd },
    { slug: 'plans-and-the-account-label', source: plansMd },
  ],
};

function buildPage(section: DocsSectionId, { slug, source }: RawPage): DocsPage {
  const { data, body } = parseFrontmatter(source);
  if (data['section'] !== section) {
    throw new Error(`Docs page "${slug}" declares section "${data['section']}", not "${section}"`);
  }
  // `async: false` keeps the body in the first SSR paint; `gfm` renders tables.
  const html = marked.parse(body, { async: false, gfm: true });
  return {
    section,
    slug,
    path: `/docs/${section}/${slug}`,
    title: data['title'] ?? '',
    description: data['description'] ?? '',
    order: Number(data['order'] ?? Number.NaN),
    lastUpdated: data['last_updated'] ?? '',
    html,
  };
}

const PAGES_BY_SECTION: ReadonlyMap<DocsSectionId, readonly DocsPage[]> = new Map(
  (Object.keys(SECTIONS) as DocsSectionId[]).map((section) => [
    section,
    SECTIONS[section].map((raw) => buildPage(section, raw)).sort((a, b) => a.order - b.order),
  ]),
);

/** Every docs page, section by section, each section in frontmatter order. */
export const DOCS_PAGES: readonly DocsPage[] = [...PAGES_BY_SECTION.values()].flat();

/** The pages of one section, in frontmatter order. */
export function docsSection(section: DocsSectionId): readonly DocsPage[] {
  return PAGES_BY_SECTION.get(section) ?? [];
}

/** The page at `/docs/<section>/<slug>`, or `undefined`. */
export function getDocsPage(section: string, slug: string): DocsPage | undefined {
  return DOCS_PAGES.find((page) => page.section === section && page.slug === slug);
}
