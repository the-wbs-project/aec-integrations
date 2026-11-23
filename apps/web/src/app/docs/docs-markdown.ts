/**
 * Renders one docs page body for the help center (AECI-1259). Pure and free of
 * `.md` imports, so plain Vitest can cover it (`docs-markdown.spec.ts`).
 *
 * **Why the headings are split out of the HTML.** The "On this page" rail and
 * every `/docs/...#heading` link need an `id` on each `h2` and `h3`. Angular's
 * `[innerHTML]` sanitizer drops `id` (it is not on the sanitizer's attribute
 * allowlist, to stop DOM clobbering), and this repo never calls
 * `bypassSecurityTrustHtml` (`src/content/README.md`). So the body is cut into
 * blocks at each top-level `h2` / `h3`. The page template renders each heading
 * itself, with a bound `[id]`, and passes only the HTML between headings
 * through the sanitizer. The ids are in the SSR HTML, so a deep link, a crawler
 * and a no-JS reader all land on the heading.
 *
 * Ids are GitHub-style slugs of the heading text, unique within the page. A
 * repeat gets `-1`, `-2` and so on. They never take an id the docs chrome
 * already uses (`DOCS_RESERVED_IDS`). They are stable while the heading text is
 * stable, so changing a heading breaks inbound `#` links to it, the same as on
 * GitHub.
 *
 * **Widgets (the Plans page).** A Markdown body cannot carry a styled
 * component: the sanitizer strips `class`. A line holding only
 * `<!-- docs:<widget> -->` becomes its own block with `widget` set and no HTML,
 * and the page template renders that widget's component in its place. Only ids
 * in `DOCS_WIDGETS` are allowed; any other `docs:` directive throws at module
 * init, so a typo cannot ship as a silent gap.
 *
 * **Tables scroll in their own box (AECI-1918).** Each table is wrapped in a
 * `div.aec-prose-table-scroll`, so a table wider than a phone scrolls inside
 * the wrapper and the page stays still. The table keeps `display: table`, so a
 * screen reader still reads it as a table. The wrapper is markup only: the
 * words, their order and the links do not change. `class` survives Angular's
 * sanitizer. The keyboard stop and the accessible name are set in the browser,
 * only when the table overflows (`shared/prose-blocks/prose-table-scroll.ts`).
 * The wrapping runs on a private `Marked` instance, so the global `marked` that
 * `legal-render.ts` and the specs compare versions with is untouched.
 */
import { Marked, Renderer, type Token, type Tokens, marked } from 'marked';

/** One heading the page renders itself, with its anchor. */
export interface DocsHeading {
  readonly id: string;
  /** Plain text, inline Markdown removed. Rendered by interpolation, so unescaped. */
  readonly text: string;
}

/** The components a docs body may place with a `<!-- docs:<id> -->` line. */
export const DOCS_WIDGETS = ['plans-actions', 'plans-comparison', 'plans-cta'] as const;

/** One widget id. */
export type DocsWidget = (typeof DOCS_WIDGETS)[number];

/** A run of body HTML, led by the `h2` or `h3` that opens it (none for the intro). */
export interface DocsBlock {
  readonly heading?: DocsHeading & { readonly level: 2 | 3 };
  /** Set on a widget block, which has no heading and empty `html`. */
  readonly widget?: DocsWidget;
  /** Sanitized by Angular at render. Empty when a heading is followed by another. */
  readonly html: string;
}

/** A rendered body. */
export interface DocsBody {
  readonly blocks: readonly DocsBlock[];
  /** The whole body as one HTML string, heading ids included. Specs read this. */
  readonly html: string;
  /** Every `h2`, in order. The rail reads it. */
  readonly h2s: readonly DocsHeading[];
  /**
   * Every Markdown link href in the body, in document order, as written
   * (fragment and query kept). Collected from the lexer's tokens, not from the
   * HTML, so it needs no DOM: the manifest builds at module init on the server
   * too. The manifest's cross-guide guard reads it (AECI-1271).
   */
  readonly links: readonly string[];
}

/**
 * Ids already on a docs page outside the body: the skip-link target and the
 * docs chrome (`docs-shell.ts`, `docs-home.ts`). A heading slug never takes one.
 */
export const DOCS_RESERVED_IDS: readonly string[] = [
  'main',
  'docs-nav-panel',
  'docs-audience-heading',
  'docs-sections-heading',
];

/** GitHub-style slug: lower case, letters, digits, `_` and `-` kept, spaces to `-`. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** The text of an inline token list, Markdown syntax removed. */
function plainText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if ('tokens' in token && Array.isArray(token.tokens)) return plainText(token.tokens);
      if (token.type === 'br') return ' ';
      if (token.type === 'html') return '';
      return 'text' in token && typeof token.text === 'string' ? token.text : '';
    })
    .join('');
}

/** Every link href in a token tree, depth first, in document order. */
function collectLinks(tokens: readonly Token[], into: string[]): void {
  for (const token of tokens) {
    if (token.type === 'link') into.push((token as Tokens.Link).href);
    if ('tokens' in token && Array.isArray(token.tokens)) collectLinks(token.tokens, into);
    if (token.type === 'list') {
      for (const item of (token as Tokens.List).items) collectLinks(item.tokens, into);
    }
    if (token.type === 'table') {
      const table = token as Tokens.Table;
      for (const cell of [...table.header, ...table.rows.flat()]) collectLinks(cell.tokens, into);
    }
  }
}

/** A block-level HTML token that is only a `<!-- docs:<id> -->` comment. */
const WIDGET_DIRECTIVE = /^<!--\s*docs:([a-z][a-z0-9-]*)\s*-->\s*$/;

/** The widget a token places, or `undefined`. Throws on an unknown id. */
function widgetOf(token: Token): DocsWidget | undefined {
  if (token.type !== 'html') return undefined;
  const id = WIDGET_DIRECTIVE.exec((token as Tokens.HTML).raw.trim())?.[1];
  if (id === undefined) return undefined;
  if (!(DOCS_WIDGETS as readonly string[]).includes(id)) {
    throw new Error(`Unknown docs widget "docs:${id}". Known: ${DOCS_WIDGETS.join(', ')}`);
  }
  return id as DocsWidget;
}

/** The class on the scroll box around every prose table (AECI-1918). */
export const PROSE_TABLE_SCROLL_CLASS = 'aec-prose-table-scroll';

/** The prose parser: `marked` with each table wrapped in its scroll box. */
const proseMarked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    table(this: Renderer, token: Tokens.Table): string {
      const table = Renderer.prototype.table.call(this, token);
      return `<div class="${PROSE_TABLE_SCROLL_CLASS}">${table}</div>\n`;
    },
  },
});

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Renders a Markdown body (frontmatter already removed) into blocks. `reservedIds`
 * are the ids the page already carries outside the body; a heading slug never
 * takes one. The `/legal/*` and `/methodology` pages pass their own list
 * (AECI-1720 layout pass), so their headings get ids too.
 */
export function renderDocsBody(
  body: string,
  reservedIds: readonly string[] = DOCS_RESERVED_IDS,
): DocsBody {
  const tokens = marked.lexer(body, { gfm: true });
  const links: string[] = [];
  collectLinks(tokens, links);
  const used = new Set(reservedIds);
  const blocks: DocsBlock[] = [];
  const h2s: DocsHeading[] = [];
  let heading: DocsBlock['heading'];
  let run: Token[] = [];

  // `async: false` (set on `proseMarked`) keeps the body in the first SSR
  // paint; `gfm` renders tables.
  // Reference links were resolved by the lexer, so a slice parses on its own.
  const flush = (): void => {
    if (heading || run.length > 0) {
      // No options here: an options object passed to `parser` replaces the
      // instance's renderer, and the table wrapper with it.
      blocks.push({ heading, html: proseMarked.parser(run) });
    }
    heading = undefined;
    run = [];
  };

  for (const token of tokens) {
    const widget = widgetOf(token);
    if (widget) {
      flush();
      blocks.push({ widget, html: '' });
      continue;
    }
    if (token.type !== 'heading' || (token.depth !== 2 && token.depth !== 3)) {
      run.push(token);
      continue;
    }
    flush();
    const { depth, tokens: inline } = token as Tokens.Heading;
    const text = plainText(inline).trim();
    const base = headingSlug(text) || 'section';
    let id = base;
    for (let n = 1; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    heading = { id, text, level: depth as 2 | 3 };
    if (depth === 2) h2s.push({ id, text });
  }
  flush();

  const html = blocks
    .map(({ heading: h, html: rest }) =>
      h ? `<h${h.level} id="${h.id}">${escapeHtml(h.text)}</h${h.level}>${rest}` : rest,
    )
    .join('');
  return { blocks, html, h2s, links };
}
