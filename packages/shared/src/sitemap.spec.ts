import { describe, expect, it } from 'vitest';

import {
  SITEMAP_XML_HEAD,
  SITEMAP_XML_TAIL,
  type SitemapEntry,
  buildSitemapXml,
  renderSitemapUrls,
} from './sitemap';

const a: SitemapEntry[] = [
  { loc: 'https://x.test/products', changefreq: 'daily', priority: 0.8 },
  { loc: 'https://x.test/docs', changefreq: 'monthly', priority: 0.4 },
];
const b: SitemapEntry[] = [
  {
    loc: 'https://x.test/products/a&b',
    lastmod: '2026-10-01T00:00:00.000Z',
    changefreq: 'weekly',
    priority: 0.7,
  },
];

describe('renderSitemapUrls', () => {
  it('renders nothing for no entries', () => {
    expect(renderSitemapUrls([])).toBe('');
  });

  it('ends every element with a newline and escapes the loc', () => {
    const out = renderSitemapUrls(b);
    expect(out).toBe(
      '  <url>\n' +
        '    <loc>https://x.test/products/a&amp;b</loc>\n' +
        '    <lastmod>2026-10-01T00:00:00.000Z</lastmod>\n' +
        '    <changefreq>weekly</changefreq>\n' +
        '    <priority>0.7</priority>\n' +
        '  </url>\n',
    );
  });
});

// AECI-1505 — the SSR route streams HEAD, its own fragment, the stored KV fragment
// and TAIL. That is only the same document as one render if these identities hold.
describe('the fragment join', () => {
  it('HEAD + fragment + TAIL is buildSitemapXml', () => {
    expect(SITEMAP_XML_HEAD + renderSitemapUrls(a) + SITEMAP_XML_TAIL).toBe(buildSitemapXml(a));
  });

  it('two fragments joined equal one render of both lists', () => {
    expect(SITEMAP_XML_HEAD + renderSitemapUrls(a) + renderSitemapUrls(b) + SITEMAP_XML_TAIL).toBe(
      buildSitemapXml([...a, ...b]),
    );
  });

  it('an empty catalog fragment still yields a valid document', () => {
    expect(SITEMAP_XML_HEAD + renderSitemapUrls(a) + '' + SITEMAP_XML_TAIL).toBe(
      buildSitemapXml(a),
    );
  });
});
