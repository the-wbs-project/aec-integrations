/**
 * One legal version, rendered (AECI-1689): its header metadata and its body as HTML.
 * Split out of `legal-content.ts` so a plain Vitest spec can render fixture sources
 * without the bundled Markdown (`legal-bump-equivalence.spec.ts`). Pure and
 * deterministic: the same bytes on the SSR Worker and in the browser.
 */
import { marked } from 'marked';

import { type DocsBlock, type DocsHeading, renderDocsBody } from '../docs/docs-markdown';

import type { LegalSlug } from './legal-slugs';
import type { LegalVersion } from './legal-versions';

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
  /**
   * The same body cut at each `h2` and `h3` (AECI-1720 layout pass), so the page
   * renders each heading itself with a bound `id`: Angular's `[innerHTML]`
   * sanitizer drops `id`. The words are the same Markdown, parsed by the same
   * `marked` with the same options. `html` above stays the whole body as one
   * string, with no ids, for the specs that compare versions.
   */
  readonly blocks: readonly DocsBlock[];
  /** Every `h2`, in order: the "On this page" list reads it. */
  readonly headings: readonly DocsHeading[];
  /**
   * Set on an archived version only (`/legal/<slug>/v<version>`): the day the
   * next version replaced it. Absent on the current version.
   */
  readonly supersededOn?: string;
  /**
   * Set on an upcoming version only (AECI-1610): the day it takes effect,
   * `YYYY-MM-DD`. Its display label is `frontmatter.effectiveDate`.
   */
  readonly effectiveOn?: string;
}

/**
 * Ids a `/legal/*` or `/methodology` page already carries outside its body: the
 * skip-link target and the page-level ids of the site shell. A heading slug
 * never takes one, so an in-page link can never land on the wrong element.
 */
export const PROSE_PAGE_RESERVED_IDS: readonly string[] = ['main', 'page-toc-heading'];

export function renderLegalVersion(v: LegalVersion): LegalDoc {
  // Synchronous render — `async: false` keeps the body in the first SSR paint.
  const html = marked.parse(v.body, { async: false, gfm: true });
  const body = renderDocsBody(v.body, PROSE_PAGE_RESERVED_IDS);
  return {
    slug: v.slug,
    frontmatter: {
      title: v.data['title'] ?? '',
      version: v.version,
      effectiveDate: v.data['effective_date'] ?? '',
      lastUpdated: v.data['last_updated'] ?? '',
    },
    html,
    blocks: body.blocks,
    headings: body.h2s,
    ...(v.supersededOn === undefined ? {} : { supersededOn: v.supersededOn }),
    ...(v.effectiveOn === undefined ? {} : { effectiveOn: v.effectiveOn }),
  };
}
