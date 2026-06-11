import { describe, expect, it } from 'vitest';

import { buildRobotsTxt } from './robots';

describe('buildRobotsTxt', () => {
  const robots = buildRobotsTxt('https://aecintegrations.com');

  it('allows all crawlers across the public surface', () => {
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Allow: /');
  });

  it('disallows the non-public / private routes', () => {
    for (const path of ['/api/', '/auth/', '/account', '/search', '/preview/']) {
      expect(robots).toContain(`Disallow: ${path}`);
    }
  });

  it('points at the sitemap on the same origin', () => {
    expect(robots).toContain('Sitemap: https://aecintegrations.com/sitemap.xml');
  });

  it('derives the Sitemap line from the supplied origin', () => {
    expect(buildRobotsTxt('http://localhost:8788')).toContain(
      'Sitemap: http://localhost:8788/sitemap.xml',
    );
  });

  it('does not double up the slash when the origin has a trailing slash', () => {
    expect(buildRobotsTxt('https://aecintegrations.com/')).toContain(
      'Sitemap: https://aecintegrations.com/sitemap.xml',
    );
  });

  it('does not Disallow any public surface path', () => {
    // The AC requires /products, /categories, /audiences, /phases to remain
    // crawlable — none may appear in a Disallow line. (AECI-165 removed the
    // /vendors and /integrations index pages; they 301-redirect to /products and
    // are not standalone public surfaces.)
    for (const path of ['/products', '/categories', '/audiences', '/phases']) {
      expect(robots).not.toContain(`Disallow: ${path}`);
    }
  });

  it('allows indexing by default (back-compat: no second arg)', () => {
    expect(buildRobotsTxt('https://aecintegrations.com')).toContain('Allow: /');
  });

  describe('when indexing is disallowed (pre-launch / non-public envs)', () => {
    const blocked = buildRobotsTxt('https://demo.aecintegrations.com', false);

    it('still allows crawling so the X-Robots-Tag noindex header is honored', () => {
      expect(blocked).toContain('User-agent: *');
      expect(blocked).toContain('Allow: /');
    });

    it('does not Disallow the crawl (that would hide the noindex from crawlers)', () => {
      expect(blocked).not.toContain('Disallow: /');
    });

    it('does not advertise the sitemap', () => {
      expect(blocked).not.toContain('Sitemap:');
    });
  });
});
