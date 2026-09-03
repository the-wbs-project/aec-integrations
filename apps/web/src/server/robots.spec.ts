import { describe, expect, it } from 'vitest';

import { BLOCKED_SEO_CRAWLERS, buildRobotsTxt } from './robots';

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

  describe('blocked SEO-tool crawlers (AECI-747)', () => {
    it('gives each blocked crawler its own Disallow-all group', () => {
      const txt = buildRobotsTxt('https://www.aecintegrations.com');
      for (const agent of BLOCKED_SEO_CRAWLERS) {
        // The group is `User-agent: X` immediately followed by `Disallow: /`.
        // Asserting the PAIR, not just the name, is the point: a stray
        // `User-agent:` line with no rule under it blocks nothing.
        expect(txt).toContain(`User-agent: ${agent}\nDisallow: /\n`);
      }
    });

    it('keeps the wildcard group permissive so search engines are unaffected', () => {
      const txt = buildRobotsTxt('https://www.aecintegrations.com');
      // A blanket block belongs to the named groups only. If this ever starts
      // failing, every search engine has just been de-indexed.
      expect(txt).toMatch(/User-agent: \*\nAllow: \//);
      expect(txt).not.toMatch(/User-agent: \*\nDisallow: \/\n/);
    });

    it('does not block the crawlers that actually send traffic or feed answers', () => {
      const txt = buildRobotsTxt('https://www.aecintegrations.com');
      // AI answer surfaces are a distribution channel for a directory, not noise.
      for (const agent of ['Googlebot', 'Bingbot', 'GPTBot', 'OAI-SearchBot', 'Applebot']) {
        expect(txt).not.toContain(`User-agent: ${agent}`);
      }
    });

    it('still advertises the sitemap after the blocked groups', () => {
      // `Sitemap:` is a non-group directive, but emitting it INSIDE a
      // `Disallow: /` group reads as if it belonged to that crawler. Pin it last.
      const txt = buildRobotsTxt('https://www.aecintegrations.com');
      expect(txt.trimEnd().endsWith('Sitemap: https://www.aecintegrations.com/sitemap.xml')).toBe(
        true,
      );
    });
  });
});
