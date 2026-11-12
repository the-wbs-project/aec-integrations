/**
 * One legal version, rendered (AECI-1689): its header metadata and its body as HTML.
 * Split out of `legal-content.ts` so a plain Vitest spec can render fixture sources
 * without the bundled Markdown (`legal-bump-equivalence.spec.ts`). Pure and
 * deterministic: the same bytes on the SSR Worker and in the browser.
 */
import { marked } from 'marked';

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

export function renderLegalVersion(v: LegalVersion): LegalDoc {
  // Synchronous render — `async: false` keeps the body in the first SSR paint.
  const html = marked.parse(v.body, { async: false, gfm: true });
  return {
    slug: v.slug,
    frontmatter: {
      title: v.data['title'] ?? '',
      version: v.version,
      effectiveDate: v.data['effective_date'] ?? '',
      lastUpdated: v.data['last_updated'] ?? '',
    },
    html,
    ...(v.supersededOn === undefined ? {} : { supersededOn: v.supersededOn }),
    ...(v.effectiveOn === undefined ? {} : { effectiveOn: v.effectiveOn }),
  };
}
