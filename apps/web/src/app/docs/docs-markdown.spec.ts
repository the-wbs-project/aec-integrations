/**
 * AECI-1259 — the docs body renderer: heading ids and the block split.
 *
 * Plain Vitest (no `.md` import, no DOM). The real pages are pinned in
 * `docs-content.component.spec.ts`; the rendered ids in `docs-page.component.spec.ts`.
 */
import { describe, expect, it } from 'vitest';

import { DOCS_RESERVED_IDS, headingSlug, renderDocsBody } from './docs-markdown';

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
});
