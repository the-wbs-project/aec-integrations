/**
 * Content registry for the editorial methodology page (`/methodology`, AECI-804).
 *
 * A one-document mirror of `legal/legal-content.ts`: the Markdown source is
 * inlined into the bundle at build time by the esbuild `text` loader
 * (`"loader": { ".md": "text" }` in `apps/web/angular.json`), parsed once at
 * module init, and served from memory. Editing `src/content/methodology.md`
 * changes the rendered page on the next build.
 *
 * **Why the legal pattern and not an inline template.** The page is long-form
 * editorial prose that has to stay easy to revise as the product's posture
 * changes — the "where this stands today" paragraph is written to be edited the
 * day the vendor portal opens. Markdown keeps that a content edit rather than a
 * template edit, and the body is content rather than UI strings, so it is not
 * extracted into `messages.xlf` (same rule as `/legal/*`; see
 * `src/content/README.md`). The page CHROME is still `$localize`-wrapped in
 * `methodology.ts`.
 *
 * **Parsed once, at module init**, exactly like the legal registry: SSR and the
 * client must produce byte-identical HTML or hydration mismatches, and the route
 * is edge-cached, so per-request parsing would be both wrong and wasteful.
 *
 * `parseFrontmatter` is reused from the legal module rather than duplicated. It
 * is deliberately `.md`-free so plain Vitest can cover it, and it is a
 * scalar-only splitter, not a YAML library (`js-yaml`/`gray-matter` pull
 * `Buffer`, which is unsafe on the `platform: neutral` SSR build).
 */
import { marked } from 'marked';

import methodologyMd from '../../content/methodology.md';
import { parseFrontmatter } from '../legal/legal-frontmatter';

/** Frontmatter fields surfaced in the page header. */
export interface MethodologyFrontmatter {
  readonly title: string;
  /** Pre-formatted display string. Never parsed or reformatted at render time —
   *  that would be an SSR/CSR hydration and edge-cache trap. */
  readonly lastUpdated: string;
}

/** The parsed page: header metadata + rendered body HTML. */
export interface MethodologyDoc {
  readonly frontmatter: MethodologyFrontmatter;
  readonly html: string;
}

function buildDoc(source: string): MethodologyDoc {
  const { data, body } = parseFrontmatter(source);
  // Synchronous render — `async: false` keeps the body in the first SSR paint.
  // `gfm: true` is load-bearing here and not merely inherited from the legal
  // registry: the agreement-state table is a GFM table, and without the flag it
  // renders as literal pipe characters.
  const html = marked.parse(body, { async: false, gfm: true });
  return {
    frontmatter: {
      title: data['title'] ?? '',
      lastUpdated: data['last_updated'] ?? '',
    },
    html,
  };
}

/** The single methodology document, parsed at module init. */
export const METHODOLOGY_DOC: MethodologyDoc = buildDoc(methodologyMd);
