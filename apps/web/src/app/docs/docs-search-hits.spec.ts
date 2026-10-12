/**
 * AECI-1270 — the docs search hit mapper. Highlights become text runs, never
 * HTML, and the guide filter is the one the index facets on.
 */
import { describe, expect, it } from 'vitest';

import {
  DOCS_HIGHLIGHT_POST as POST,
  DOCS_HIGHLIGHT_PRE as PRE,
  docsGuideFilter,
  mapDocsSearchHits,
  splitHighlight,
} from './docs-search-hits';

describe('docsGuideFilter', () => {
  it('filters on the guide attribute', () => {
    expect(docsGuideFilter('help')).toBe('guide:help');
    expect(docsGuideFilter('vendor')).toBe('guide:vendor');
  });
});

describe('splitHighlight', () => {
  it('cuts a value into matched and unmatched runs', () => {
    expect(splitHighlight(`Write a ${PRE}review${POST} today`)).toEqual([
      { text: 'Write a ', match: false },
      { text: 'review', match: true },
      { text: ' today', match: false },
    ]);
  });

  it('keeps angle brackets as text', () => {
    expect(splitHighlight(`<b>${PRE}x${POST}</b>`)).toEqual([
      { text: '<b>', match: false },
      { text: 'x', match: true },
      { text: '</b>', match: false },
    ]);
  });

  it('merges adjacent matches and survives an unclosed marker', () => {
    expect(splitHighlight(`${PRE}a${POST}${PRE}b${POST}`)).toEqual([{ text: 'ab', match: true }]);
    expect(splitHighlight(`a ${PRE}b`)).toEqual([
      { text: 'a ', match: false },
      { text: 'b', match: true },
    ]);
    expect(splitHighlight('')).toEqual([]);
  });
});

describe('mapDocsSearchHits', () => {
  const base = {
    objectID: '/docs/reviewers/writing-a-review#before-you-start',
    url: '/docs/reviewers/writing-a-review#before-you-start',
    section: 'Reviewer guide',
    page_title: 'Writing a review',
    heading: 'Before you start',
  };

  it('splits the url into an absolute path and a fragment', () => {
    const [row] = mapDocsSearchHits([
      {
        ...base,
        _highlightResult: { heading: { value: `${PRE}Before${POST} you start` } },
        _snippetResult: { content: { value: `You need an ${PRE}account${POST}…` } },
      },
    ]);
    expect(row).toMatchObject({
      path: '/docs/reviewers/writing-a-review',
      fragment: 'before-you-start',
      section: 'Reviewer guide',
      pageTitle: 'Writing a review',
    });
    expect(row?.heading[0]).toEqual({ text: 'Before', match: true });
    expect(row?.snippet[1]).toEqual({ text: 'account', match: true });
  });

  it('gives a lede no fragment and falls back to the plain heading', () => {
    const [row] = mapDocsSearchHits([{ ...base, url: '/docs/vendors/overview' }]);
    expect(row?.path).toBe('/docs/vendors/overview');
    expect(row?.fragment).toBeUndefined();
    expect(row?.heading).toEqual([{ text: 'Before you start', match: false }]);
    expect(row?.snippet).toEqual([]);
  });

  it('drops a hit whose url is not a docs path', () => {
    expect(mapDocsSearchHits([{ ...base, url: 'https://evil.example/docs' }])).toEqual([]);
    expect(mapDocsSearchHits([{ ...base, url: '/admin' }])).toEqual([]);
  });
});
