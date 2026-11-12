/**
 * Content registry for the accessibility statement (`/accessibility`, AECI-1673).
 *
 * The `/methodology` pattern (`methodology/methodology-content.ts`): the Markdown
 * source is inlined into the bundle at build time by the esbuild `text` loader,
 * parsed once at module init, and served from memory, so SSR and the client
 * render byte-identical HTML on an edge-cached route.
 *
 * **Not a `/legal/*` page.** The statement is a public promise of process, not an
 * agreement anyone accepts, so it carries no `version`, no archive and no change
 * history (`docs/STAGE_1_SPEC.md` §27.6). Its wording still follows counsel's
 * Q40 rules, and `accessibility-statement.spec.ts` pins them.
 */
import { marked } from 'marked';

import accessibilityMd from '../../content/accessibility.md';
import { parseFrontmatter } from '../legal/legal-frontmatter';

/** Frontmatter fields surfaced in the page header. */
export interface AccessibilityFrontmatter {
  readonly title: string;
  /** Pre-formatted display string, rendered verbatim (hydration-safe). */
  readonly lastUpdated: string;
}

/** The parsed page: header metadata + rendered body HTML. */
export interface AccessibilityDoc {
  readonly frontmatter: AccessibilityFrontmatter;
  readonly html: string;
}

function buildDoc(source: string): AccessibilityDoc {
  const { data, body } = parseFrontmatter(source);
  const html = marked.parse(body, { async: false, gfm: true });
  return {
    frontmatter: {
      title: data['title'] ?? '',
      lastUpdated: data['last_updated'] ?? '',
    },
    html,
  };
}

/** The single accessibility statement, parsed at module init. */
export const ACCESSIBILITY_DOC: AccessibilityDoc = buildDoc(accessibilityMd);
