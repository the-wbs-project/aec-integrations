/**
 * AECI-1270 — the docs search records, built from the real manifest.
 *
 * `*.component.spec.ts` because the manifest imports `.md` files, which only
 * the Angular test runner loads (see `docs-page.component.spec.ts`).
 */
import { describe, expect, it } from 'vitest';

import { DOCS_PAGES, DOCS_SECTIONS, type DocsSection } from './docs-content';
import {
  DOCS_RECORD_CONTENT_BYTES,
  buildDocsSearchRecords,
  docsHtmlToText,
} from './docs-search-records';

const RECORDS = buildDocsSearchRecords(DOCS_SECTIONS);

describe('buildDocsSearchRecords (real manifest)', () => {
  it('gives every objectID once, and objectID equals url', () => {
    const ids = RECORDS.map((record) => record.objectID);
    expect(new Set(ids).size).toBe(ids.length);
    for (const record of RECORDS) expect(record.objectID).toBe(record.url);
  });

  it('gives every page a lede record with no fragment', () => {
    const urls = new Set(RECORDS.map((record) => record.url));
    for (const page of DOCS_PAGES) expect(urls.has(page.path), page.path).toBe(true);
  });

  it('points every anchor at a heading id the page renders', () => {
    for (const record of RECORDS) {
      const [path, anchor] = record.url.split('#');
      if (!anchor) continue;
      const page = DOCS_PAGES.find((entry) => entry.path === path);
      const html = page?.html ?? DOCS_SECTIONS.find((s) => s.path === path)?.intro?.html ?? '';
      expect(html, record.url).toContain(`<h2 id="${anchor}">`);
    }
  });

  it('skips the Related list on every page', () => {
    expect(RECORDS.some((record) => record.heading === 'Related')).toBe(false);
    expect(RECORDS.some((record) => record.url.endsWith('#related'))).toBe(false);
  });

  it('indexes every h2 except Related, and nothing else', () => {
    for (const page of DOCS_PAGES) {
      const anchors = RECORDS.filter((r) => r.url.startsWith(`${page.path}#`)).map(
        (r) => r.url.split('#')[1],
      );
      expect(anchors, page.path).toEqual(page.headings.map((heading) => heading.id));
    }
  });

  it('tags overview and claiming as the vendor guide, and help pages as help', () => {
    const guideOf = (url: string) => RECORDS.find((record) => record.url === url)?.guide;
    expect(guideOf('/docs/vendors/overview')).toBe('vendor');
    expect(guideOf('/docs/vendors/claiming-your-listing')).toBe('vendor');
    expect(guideOf('/docs/vendors')).toBe('vendor');
    expect(guideOf('/docs/reviewers/writing-a-review')).toBe('help');
    for (const record of RECORDS) {
      expect(record.guide).toBe(record.url.startsWith('/docs/vendors') ? 'vendor' : 'help');
    }
  });

  it('includes the vendor guide intro on /docs/vendors', () => {
    expect(RECORDS.some((record) => record.url === '/docs/vendors#current-limits')).toBe(true);
  });

  it('keeps reading order, plain text and the size cap', () => {
    RECORDS.forEach((record, index) => expect(record.order).toBe(index + 1));
    const encoder = new TextEncoder();
    for (const record of RECORDS) {
      expect(record.content, record.url).not.toMatch(/<[a-z/][^>]*>/i);
      expect(record.content, record.url).not.toMatch(/&(amp|lt|gt|quot|#\d+);/);
      expect(encoder.encode(record.content).length).toBeLessThanOrEqual(DOCS_RECORD_CONTENT_BYTES);
      expect(record.section).not.toBe('');
      expect(record.page_title).not.toBe('');
    }
  });
});

describe('buildDocsSearchRecords (fixture)', () => {
  it('folds h3 text into its h2 record and caps long content', () => {
    const long = 'word '.repeat(4000);
    const page = {
      section: 'trust',
      slug: 'x',
      path: '/docs/trust/x',
      title: 'X',
      description: 'Desc',
      order: 1,
      lastUpdated: '',
      html: '',
      headings: [],
      links: [],
      blocks: [
        { html: '<p>Lede &amp; more</p>' },
        { heading: { id: 'a', text: 'A', level: 2 as const }, html: '<p>Under A</p>' },
        { heading: { id: 'a-sub', text: 'Sub', level: 3 as const }, html: `<p>${long}</p>` },
        { heading: { id: 'related', text: 'Related', level: 2 as const }, html: '<ul></ul>' },
      ],
    };
    const section = {
      id: 'trust',
      path: '/docs/trust',
      hasIndex: true,
      pages: [page],
      label: 'Trust',
      summary: 'S',
      audience: 'reader',
      order: 1,
      guide: 'help',
    } as unknown as DocsSection;
    const records = buildDocsSearchRecords([section]);
    expect(records.map((record) => record.url)).toEqual(['/docs/trust/x', '/docs/trust/x#a']);
    expect(records[0]?.content).toBe('Lede & more');
    expect(records[1]?.content.startsWith('Under A Sub word')).toBe(true);
    expect(new TextEncoder().encode(records[1]!.content).length).toBeLessThanOrEqual(
      DOCS_RECORD_CONTENT_BYTES,
    );
  });

  it('turns HTML into plain text', () => {
    expect(docsHtmlToText('<p>A&nbsp;<a href="/x">link</a>&#39;s</p><ul><li>one</li></ul>')).toBe(
      "A link's one",
    );
  });
});
