/**
 * AECI-1720 layout pass: `/legal/*` and `/methodology` now render their body cut
 * at each heading (`aec-prose-blocks`), so every `h2` and `h3` carries an `id` for
 * the "On this page" list. The words of an agreement must not change. This spec
 * reads every legal Markdown file in the repo, current and archived, and the
 * methodology page, and proves the block rendering is the single `[innerHTML]`
 * rendering it replaced, with only the heading ids added.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { marked } from 'marked';
import { describe, expect, it } from 'vitest';

import { PROSE_TABLE_SCROLL_CLASS, renderDocsBody } from '../docs/docs-markdown';
import { parseFrontmatter } from './legal-frontmatter';
import { PROSE_PAGE_RESERVED_IDS } from './legal-render';

const CONTENT = join(process.cwd(), 'src', 'content');

function legalFiles(): string[] {
  const dir = join(CONTENT, 'legal');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => join(dir, f));
  const versions = join(dir, 'versions');
  for (const slug of readdirSync(versions)) {
    for (const f of readdirSync(join(versions, slug))) {
      if (f.endsWith('.md')) files.push(join(versions, slug, f));
    }
  }
  return files;
}

const FILES = [...legalFiles(), join(CONTENT, 'methodology.md')];

const decode = (html: string): string =>
  html
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * The page's block rendering, as the template lays it out, ids removed, and the
 * table scroll box removed (AECI-1918). The box is markup only, around the
 * unchanged table, so taking it off must give back the single rendering.
 */
function asBlocks(body: string): string {
  return renderDocsBody(body, PROSE_PAGE_RESERVED_IDS)
    .blocks.map(({ heading, html }) =>
      heading ? `<h${heading.level}>${heading.text}</h${heading.level}>${html}` : html,
    )
    .join('')
    .replaceAll(`<div class="${PROSE_TABLE_SCROLL_CLASS}"><table>`, '<table>')
    .replaceAll('</table>\n</div>', '</table>');
}

/** Whitespace between tags is layout, not words. */
const normalise = (html: string): string => decode(html).replace(/>\s+</g, '><').trim();

describe('legal and methodology heading ids (AECI-1720)', () => {
  it('reads at least the six current agreements, their archives and methodology', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(12);
  });

  for (const file of FILES) {
    const name = file.slice(CONTENT.length + 1);
    const { body } = parseFrontmatter(readFileSync(file, 'utf8'));

    it(`${name}: the block rendering is the same HTML, word for word`, () => {
      const single = marked.parse(body, { async: false, gfm: true });
      expect(normalise(asBlocks(body))).toBe(normalise(single));
    });

    // AECI-1918: one scroll box per table, and none in a body with no table.
    // No legal file holds a table today, so a legal page gets no box.
    it(`${name}: wraps each table, and only tables, in one scroll box`, () => {
      const blocks = renderDocsBody(body, PROSE_PAGE_RESERVED_IDS).html;
      const tables = (marked.parse(body, { async: false, gfm: true }).match(/<table>/g) ?? [])
        .length;
      expect(blocks.split(PROSE_TABLE_SCROLL_CLASS).length - 1).toBe(tables);
      if (name.startsWith('legal')) expect(tables).toBe(0);
    });

    it(`${name}: every h2 and h3 has a unique id that no page element uses`, () => {
      const rendered = renderDocsBody(body, PROSE_PAGE_RESERVED_IDS);
      const ids = rendered.blocks.flatMap((b) => (b.heading ? [b.heading.id] : []));
      const headingCount = (body.match(/^#{2,3} /gm) ?? []).length;
      expect(ids).toHaveLength(headingCount);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(id).toMatch(/^[\p{L}\p{N}_-]+$/u);
        expect(PROSE_PAGE_RESERVED_IDS).not.toContain(id);
      }
    });
  }

  it('reserves the "On this page" label id', () => {
    expect(PROSE_PAGE_RESERVED_IDS).toContain('page-toc-heading');
    expect(PROSE_PAGE_RESERVED_IDS).toContain('main');
  });
});
