/**
 * Maps a docs search response to the rows the docs search box shows
 * (AECI-1270). Pure, with no Angular and no SDK, so plain Vitest covers it.
 *
 * **Highlights are text, never HTML.** Algolia wraps matched words in the
 * pre and post tags the query asks for. The query asks for two marker strings
 * that cannot occur in the docs text, and `splitHighlight` cuts the value at
 * them into parts. The template renders each part as text, a matched part
 * inside `<mark>`. Nothing is ever bound to `innerHTML`, so a `<` in the docs
 * text stays a `<`.
 */
import type { DocsSearchRecord } from '@aeci/shared/algolia';

import type { DocsGuide } from './docs-content';

/** Wraps a matched word. Private-use code points: never in the docs text. */
export const DOCS_HIGHLIGHT_PRE = '';
export const DOCS_HIGHLIGHT_POST = '';

/** One run of a highlighted value. */
export interface HighlightPart {
  readonly text: string;
  readonly match: boolean;
}

/** One row in the docs search popup. */
export interface DocsSearchHit {
  readonly objectID: string;
  /** Site-absolute page path, no fragment. */
  readonly path: string;
  /** The heading anchor, or `undefined` for a page lede. */
  readonly fragment?: string;
  readonly section: string;
  readonly pageTitle: string;
  /** The heading, cut into matched and unmatched runs. */
  readonly heading: readonly HighlightPart[];
  /** A short excerpt of the content around the match. May be empty. */
  readonly snippet: readonly HighlightPart[];
}

/** The search function the box calls. `guide` picks the filter. */
export type DocsSearchFn = (query: string, guide: DocsGuide) => Promise<readonly DocsSearchHit[]>;

/** The `filters` value for one guide. */
export function docsGuideFilter(guide: DocsGuide): string {
  return `guide:${guide}`;
}

/** Cuts a highlighted value at the markers. Adjacent runs of one kind merge. */
export function splitHighlight(value: string): readonly HighlightPart[] {
  const parts: HighlightPart[] = [];
  const add = (text: string, match: boolean): void => {
    if (!text) return;
    const last = parts.at(-1);
    if (last && last.match === match) parts[parts.length - 1] = { text: last.text + text, match };
    else parts.push({ text, match });
  };
  let rest = value;
  while (rest.length > 0) {
    const open = rest.indexOf(DOCS_HIGHLIGHT_PRE);
    if (open < 0) {
      add(rest, false);
      break;
    }
    add(rest.slice(0, open), false);
    const close = rest.indexOf(DOCS_HIGHLIGHT_POST, open + 1);
    const end = close < 0 ? rest.length : close;
    add(rest.slice(open + 1, end), true);
    rest = close < 0 ? '' : rest.slice(close + 1);
  }
  return parts;
}

/** The slice of an Algolia hit the box reads. */
export type DocsSearchRawHit = Pick<
  DocsSearchRecord,
  'objectID' | 'url' | 'section' | 'page_title' | 'heading'
> & {
  readonly _highlightResult?: { readonly heading?: { readonly value?: string } };
  readonly _snippetResult?: { readonly content?: { readonly value?: string } };
};

/** Maps raw hits to rows. A hit whose `url` is not a `/docs` path is dropped. */
export function mapDocsSearchHits(hits: readonly DocsSearchRawHit[]): readonly DocsSearchHit[] {
  const rows: DocsSearchHit[] = [];
  for (const hit of hits) {
    if (typeof hit.url !== 'string' || !/^\/docs(\/|$|#)/.test(hit.url)) continue;
    const hash = hit.url.indexOf('#');
    const path = hash < 0 ? hit.url : hit.url.slice(0, hash);
    const fragment = hash < 0 ? undefined : hit.url.slice(hash + 1) || undefined;
    rows.push({
      objectID: hit.objectID,
      path,
      fragment,
      section: hit.section,
      pageTitle: hit.page_title,
      heading: splitHighlight(hit._highlightResult?.heading?.value ?? hit.heading),
      snippet: splitHighlight(hit._snippetResult?.content?.value ?? ''),
    });
  }
  return rows;
}
