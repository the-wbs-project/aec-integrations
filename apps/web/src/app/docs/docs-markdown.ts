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
 */
import { type Token, type Tokens, marked } from 'marked';

/** One heading the page renders itself, with its anchor. */
export interface DocsHeading {
  readonly id: string;
  /** Plain text, inline Markdown removed. Rendered by interpolation, so unescaped. */
  readonly text: string;
}

/** A run of body HTML, led by the `h2` or `h3` that opens it (none for the intro). */
export interface DocsBlock {
  readonly heading?: DocsHeading & { readonly level: 2 | 3 };
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

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Renders a Markdown body (frontmatter already removed) into blocks. */
export function renderDocsBody(body: string): DocsBody {
  const tokens = marked.lexer(body, { gfm: true });
  const used = new Set(DOCS_RESERVED_IDS);
  const blocks: DocsBlock[] = [];
  const h2s: DocsHeading[] = [];
  let heading: DocsBlock['heading'];
  let run: Token[] = [];

  // `async: false` keeps the body in the first SSR paint; `gfm` renders tables.
  // Reference links were resolved by the lexer, so a slice parses on its own.
  const flush = (): void => {
    if (heading || run.length > 0) {
      blocks.push({ heading, html: marked.parser(run, { gfm: true, async: false }) });
    }
    heading = undefined;
    run = [];
  };

  for (const token of tokens) {
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
  return { blocks, html, h2s };
}
