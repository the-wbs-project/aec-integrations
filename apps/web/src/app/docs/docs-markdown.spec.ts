/**
 * AECI-1259 — the docs body renderer: heading ids and the block split.
 *
 * Plain Vitest (no `.md` import, no DOM). The real pages are pinned in
 * `docs-content.component.spec.ts`; the rendered ids in `docs-page.component.spec.ts`.
 */
import { marked } from 'marked';
import { describe, expect, it } from 'vitest';

import {
  DOCS_RESERVED_IDS,
  PROSE_TABLE_SCROLL_CLASS,
  headingSlug,
  renderDocsBody,
} from './docs-markdown';

describe('headingSlug', () => {
  // The two in-content deep links that already exist depend on this exact shape.
  it('lower-cases and hyphenates like GitHub', () => {
    expect(headingSlug('If AEC Integrations changes something you hold')).toBe(
      'if-aec-integrations-changes-something-you-hold',
    );
    expect(headingSlug('Vendors whose products are connectors')).toBe(
      'vendors-whose-products-are-connectors',
    );
  });

  // Punctuation in a heading must not leak into the id.
  it('drops punctuation and quotes but keeps hyphens and underscores', () => {
    expect(headingSlug('What "confirmed" means, and what it does not')).toBe(
      'what-confirmed-means-and-what-it-does-not',
    );
    expect(headingSlug('Sign-in & the_seat?')).toBe('sign-in--the_seat');
  });

  // Only punctuation leaves nothing; the renderer falls back.
  it('returns an empty string for a heading with no letters or digits', () => {
    expect(headingSlug('?!')).toBe('');
  });
});

describe('renderDocsBody', () => {
  const body = [
    'Intro paragraph with a [reference link][ref].',
    '',
    '## First part',
    '',
    'Body one.',
    '',
    '### A detail',
    '',
    'Detail body.',
    '',
    '## First part',
    '',
    '## Main',
    '',
    '#### Deep heading',
    '',
    '## Related',
    '',
    '- [Docs](/docs)',
    '',
    '[ref]: /docs/trust',
  ].join('\n');

  // The rail and the template both depend on this split.
  it('splits the body into an intro and one block per h2 and h3', () => {
    const { blocks } = renderDocsBody(body);
    expect(blocks.map((b) => b.heading?.text ?? null)).toEqual([
      null,
      'First part',
      'A detail',
      'First part',
      'Main',
      'Related',
    ]);
    expect(blocks[0].html).toContain('<a href="/docs/trust">reference link</a>');
    expect(blocks[3].html).toBe('');
    // h4 and below stay inside the HTML run, unanchored.
    expect(blocks[4].html).toContain('<h4>Deep heading</h4>');
  });

  // Duplicate headings and chrome ids must never produce a duplicate DOM id.
  it('gives every heading a unique id that never takes a reserved chrome id', () => {
    const { blocks } = renderDocsBody(body);
    const ids = blocks.flatMap((b) => (b.heading ? [b.heading.id] : []));
    expect(ids).toEqual(['first-part', 'a-detail', 'first-part-1', 'main-1', 'related']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const reserved of DOCS_RESERVED_IDS) expect(ids).not.toContain(reserved);
  });

  // Ids must not change between builds, or inbound #links break silently.
  it('is deterministic', () => {
    expect(renderDocsBody(body)).toEqual(renderDocsBody(body));
  });

  // The rail lists h2s only.
  it('lists the h2s in order', () => {
    expect(renderDocsBody(body).h2s.map((h) => h.id)).toEqual([
      'first-part',
      'first-part-1',
      'main-1',
      'related',
    ]);
  });

  // Specs read `html`; it must carry the ids and escape the heading text.
  it('joins the blocks back into one HTML string with ids', () => {
    const { html } = renderDocsBody('## A "quoted" & 1 < 2 heading\n\nText.\n');
    expect(html).toBe(
      '<h2 id="a-quoted--1--2-heading">A &quot;quoted&quot; &amp; 1 &lt; 2 heading</h2><p>Text.</p>\n',
    );
  });

  // Inline Markdown in a heading is formatting, not text.
  it('strips inline Markdown from heading text', () => {
    const { h2s } = renderDocsBody('## The **bold** and `code` [link](/x) part\n');
    expect(h2s).toEqual([
      { id: 'the-bold-and-code-link-part', text: 'The bold and code link part' },
    ]);
  });

  // A heading of punctuation alone still gets a usable id.
  it('falls back to "section" when the slug is empty', () => {
    expect(renderDocsBody('## ?!\n\n## ?!\n').h2s.map((h) => h.id)).toEqual([
      'section',
      'section-1',
    ]);
  });

  // The cross-guide guard (AECI-1271) reads these: every link, wherever it sits.
  it('collects every link href in document order, fragments and queries kept', () => {
    const { links } = renderDocsBody(
      [
        'See [one](/docs/a#part) and **[two](/docs/b?x=1)**.',
        '',
        '> A [quoted](/docs/c) link.',
        '',
        '| Col |',
        '| --- |',
        '| [cell](/docs/d) |',
        '',
        '## Related',
        '',
        '- [Item](/docs/e).',
        '- Nested',
        '  - [deep](/docs/f#g)',
        '- [Ref][r]',
        '',
        '[r]: /docs/h',
      ].join('\n'),
    );
    expect(links).toEqual([
      '/docs/a#part',
      '/docs/b?x=1',
      '/docs/c',
      '/docs/d',
      '/docs/e',
      '/docs/f#g',
      '/docs/h',
    ]);
  });

  // A heading link counts too, and a page with none collects nothing.
  it('collects a link in a heading and returns an empty list when there is none', () => {
    expect(renderDocsBody('## See [x](/docs/x)\n').links).toEqual(['/docs/x']);
    expect(renderDocsBody('Plain text.\n').links).toEqual([]);
  });
});

describe('renderDocsBody widgets', () => {
  // A directive line becomes its own block, so the page can place a component.
  it('cuts a widget block out of the flow, with no heading and no HTML', () => {
    const { blocks, html } = renderDocsBody(
      '## Compare\n\nLead.\n\n<!-- docs:plans-comparison -->\n\nAfter.\n\n## Next\n',
    );
    expect(blocks.map((block) => block.widget ?? block.heading?.id ?? 'run')).toEqual([
      'compare',
      'plans-comparison',
      'run',
      'next',
    ]);
    expect(blocks[1].html).toBe('');
    expect(html).not.toContain('docs:');
  });

  // A typo must fail at module init, not ship as a silent gap.
  it('throws on an unknown widget id', () => {
    expect(() => renderDocsBody('<!-- docs:plans-comparisn -->\n')).toThrow(/Unknown docs widget/);
  });

  // Any other HTML comment stays ordinary content.
  it('leaves a plain HTML comment alone', () => {
    expect(renderDocsBody('<!-- a note -->\n').blocks.every((block) => !block.widget)).toBe(true);
  });
});

// AECI-1918: a wide table scrolls in its own box, so the page does not scroll
// sideways on a phone. The wrapper is markup only: the table inside it is the
// exact HTML `marked` renders, so no word, link or cell changes.
describe('renderDocsBody tables', () => {
  const table =
    '| Event | Who | Channel |\n| -- | -- | -- |\n| A [link](/docs/x) | `code` | Email |\n';
  const open = `<div class="${PROSE_TABLE_SCROLL_CLASS}">`;

  it('wraps each table in one scroll box around the unchanged table HTML', () => {
    const { html } = renderDocsBody(`## Events\n\nLead.\n\n${table}\nAfter.\n`);
    const plain = marked.parse(table, { async: false, gfm: true });
    expect(html).toContain(`${open}${plain}</div>`);
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html.split(PROSE_TABLE_SCROLL_CLASS)).toHaveLength(2);
  });

  it('changes nothing but the wrapper', () => {
    const source = `Lead.\n\n${table}\nAfter.\n`;
    const plain = marked.parse(source, { async: false, gfm: true });
    const unwrapped = renderDocsBody(source)
      .html.replace(open, '')
      .replace('</table>\n</div>\n', '</table>\n');
    expect(unwrapped).toBe(plain);
  });

  it('leaves a body without a table unwrapped', () => {
    expect(renderDocsBody('Plain text.\n').html).not.toContain(PROSE_TABLE_SCROLL_CLASS);
  });

  // The global `marked` renders legal `html` and the version specs: it must not wrap.
  it('does not change the global marked renderer', () => {
    renderDocsBody(table);
    expect(marked.parse(table, { async: false, gfm: true })).not.toContain(
      PROSE_TABLE_SCROLL_CLASS,
    );
  });
});
