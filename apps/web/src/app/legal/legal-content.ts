/**
 * Legal-page content registry (AECI-237, Phase 7.2).
 *
 * The four launch-required legal documents (`STAGE_1_SPEC.md` §13/§27) live as
 * Markdown source in `apps/web/src/content/legal/`. They are inlined into the
 * bundle at build time via the esbuild `text` loader (`"loader": { ".md":
 * "text" }` in `angular.json`; see the `declare module '*.md'` in
 * `src/markdown.d.ts`), so the imports below are plain strings — no runtime fetch.
 *
 * Parsing is **pure and deterministic** and runs once at module init (a `Map`
 * memoised per isolate), so the rendered HTML is byte-identical on the SSR
 * Worker and in the browser — a hard requirement for hydration stability and the
 * cache-neutral SSR contract (CLAUDE.md). The frontmatter splitter lives in
 * `legal-frontmatter.ts` (a pure, `.md`-free module so it is unit-testable under
 * plain Vitest); we avoid `gray-matter`/`js-yaml` (they pull `Buffer`, unsafe on
 * the `platform: neutral` SSR build).
 *
 * The route slug (short, public — set by the footer links) maps to the long
 * §27.1 filename via `SOURCES`. The Markdown body is *content*, not UI strings:
 * it is rendered via `[innerHTML]` (Angular's sanitizer runs) and is not
 * `$localize`-extracted. Only the page chrome in `legal-page.ts` is i18n-wrapped.
 */
import { marked } from 'marked';

import listingAccuracyMd from '../../content/legal/listing-accuracy-policy.md';
import privacyMd from '../../content/legal/privacy-policy.md';
import reviewGuidelinesMd from '../../content/legal/review-guidelines.md';
import termsMd from '../../content/legal/terms-of-service.md';
import { parseFrontmatter } from './legal-frontmatter';

/** Public route slug for a legal page (`/legal/<slug>`). */
export type LegalSlug = 'terms' | 'privacy' | 'review-guidelines' | 'listing-accuracy';

/** Frontmatter fields surfaced in the page header. */
export interface LegalFrontmatter {
  readonly title: string;
  readonly version: string;
  /** Pre-formatted display string; empty while a doc is an unapproved draft. */
  readonly effectiveDate: string;
  /** Pre-formatted display string. */
  readonly lastUpdated: string;
}

/** A parsed legal document: header metadata + rendered body HTML. */
export interface LegalDoc {
  readonly slug: LegalSlug;
  readonly frontmatter: LegalFrontmatter;
  readonly html: string;
}

interface RawSource {
  readonly slug: LegalSlug;
  readonly source: string;
}

// slug → long §27.1 filename (the imported Markdown string).
const SOURCES: readonly RawSource[] = [
  { slug: 'terms', source: termsMd },
  { slug: 'privacy', source: privacyMd },
  { slug: 'review-guidelines', source: reviewGuidelinesMd },
  { slug: 'listing-accuracy', source: listingAccuracyMd },
];

function buildDoc({ slug, source }: RawSource): LegalDoc {
  const { data, body } = parseFrontmatter(source);
  // Synchronous render — `async: false` keeps the body in the first SSR paint.
  const html = marked.parse(body, { async: false, gfm: true });
  return {
    slug,
    frontmatter: {
      title: data['title'] ?? '',
      version: data['version'] ?? '',
      effectiveDate: data['effective_date'] ?? '',
      lastUpdated: data['last_updated'] ?? '',
    },
    html,
  };
}

const REGISTRY: ReadonlyMap<LegalSlug, LegalDoc> = new Map(
  SOURCES.map((entry) => [entry.slug, buildDoc(entry)] as const),
);

/** Every legal slug, in canonical order. */
export const LEGAL_SLUGS: readonly LegalSlug[] = SOURCES.map((entry) => entry.slug);

/** Returns the parsed document for a known slug, or `undefined` if unknown. */
export function getLegalDoc(slug: string): LegalDoc | undefined {
  return REGISTRY.get(slug as LegalSlug);
}
