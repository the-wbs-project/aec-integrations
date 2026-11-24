/**
 * AECI-1879: the cross-page checks (rule 4), one group per persona.
 *
 * A `beforeAll` visits every surface of the persona once, in one signed-in
 * context, and records what the rules compare. The tests then judge the record:
 *
 *   `titles`          every page has a non-empty title no other page has (WCAG 2.4.2).
 *   `header, footer`  the header and footer snapshots are the same on every page,
 *                     and match the committed files (WCAG 3.2.3).
 *   `link names`      a target carries a consistent name on every page, within
 *                     the same landmark (WCAG 3.2.4).
 *   `on every page`   a search landmark, a navigation landmark with links, and a
 *                     footer with links (WCAG 2.4.5).
 *
 * Surfaces that redirect to the same page (`/vendors` and `/integrations` both
 * answer 301 to `/products`) are one page for the title rule.
 * `docs/TESTING_STRATEGY.md` §8.4.3.
 */
import { expect, test } from '@playwright/test';
import { knownFailure } from './known-failure';
import { SURFACES, type A11ySurface, type Persona } from './surfaces';
import {
  collectPageFacts,
  inconsistentNameProblems,
  maskAriaSnapshot,
  titleProblems,
  type PageFacts,
  type PageLinkName,
} from './support/aria-tree';
import { pageTree } from './support/aria-suite';
import { fakeHeaderSearch, guardWrites } from './support/page-guards';
import { openSurface, phase2FixturesPresent, signInAs } from './support/surface-page';

interface PageRecord {
  readonly surface: A11ySurface;
  /** Path and query after redirects. */
  readonly finalPath: string;
  readonly title: string;
  readonly header: string;
  readonly footer: string;
  readonly facts: PageFacts;
}

const PERSONAS: readonly Persona[] = ['anonymous', 'reviewer', 'admin', 'vendor'];

for (const persona of PERSONAS) {
  const surfaces = SURFACES.filter((s) => s.persona === persona);
  if (surfaces.length === 0) continue;

  test.describe(`a11y nightly aria cross-page: ${persona}`, () => {
    // One worker runs the group in order, so the record is collected once.
    test.describe.configure({ mode: 'default' });
    const records: PageRecord[] = [];
    const notVisited: string[] = [];
    const annotations = {
      annotation: [
        { type: 'surface', description: `cross-page-${persona}` },
        { type: 'route', description: surfaces.map((s) => s.route).join(' ') },
      ],
    };

    test.beforeAll(async ({ browser }) => {
      // One load per surface, on a busy runner.
      test.setTimeout(60_000 + surfaces.length * 120_000);
      const fixturesPresent = await phase2FixturesPresent();
      const context = await browser.newContext();
      try {
        await signInAs(context, persona);
        const page = await context.newPage();
        await guardWrites(page);
        await fakeHeaderSearch(page);
        for (const surface of surfaces) {
          if (surface.fixture === 'phase2' && !fixturesPresent) {
            notVisited.push(`${surface.id}: phase2 fixtures not seeded`);
            continue;
          }
          await openSurface(page, surface);
          const url = new URL(page.url());
          records.push({
            surface,
            finalPath: `${url.pathname}${url.search}`,
            title: await page.title(),
            header: maskAriaSnapshot(await page.getByRole('banner').ariaSnapshot()),
            footer: maskAriaSnapshot(await page.getByRole('contentinfo').ariaSnapshot()),
            facts: collectPageFacts(await pageTree(page)),
          });
        }
      } finally {
        await context.close();
      }
      if (notVisited.length > 0)
        console.warn(`[a11y-nightly] not visited: ${notVisited.join('; ')}`);
    });

    test('titles: every page has a unique, non-empty title', annotations, () => {
      if (persona === 'admin') {
        knownFailure('AECI-2084', 'both admin queues are titled "Admin · AEC Integrations"');
      }
      if (persona === 'vendor') {
        knownFailure(
          'AECI-2085',
          'both portal screens are titled "Vendor portal · AEC Integrations"',
        );
      }
      const pages = new Map<string, { page: string; title: string }>();
      for (const r of records) {
        if (!pages.has(r.finalPath)) pages.set(r.finalPath, { page: r.finalPath, title: r.title });
      }
      expect(titleProblems([...pages.values()])).toEqual([]);
    });

    test('header and footer: the same snapshot on every page', annotations, () => {
      expect(records.length, 'at least one page was visited').toBeGreaterThan(0);
      const [first] = records;
      for (const r of records) {
        expect
          .soft(r.header, `the header on ${r.surface.route} matches ${first!.surface.route}`)
          .toBe(first!.header);
        expect
          .soft(r.footer, `the footer on ${r.surface.route} matches ${first!.surface.route}`)
          .toBe(first!.footer);
      }
      expect.soft(first!.header).toMatchSnapshot(`aria-header-${persona}.yml`);
      expect.soft(first!.footer).toMatchSnapshot(`aria-footer-${persona}.yml`);
    });

    test('link names: one target, one name, on every page', annotations, () => {
      if (persona === 'anonymous') {
        knownFailure(
          'AECI-2078',
          'home names three audience links by role, /audiences names them by discipline',
        );
      }
      if (persona === 'vendor') {
        knownFailure(
          'AECI-2087',
          'the portal overview is linked as "Vendor portal" and as the vendor name',
        );
      }
      const names: PageLinkName[] = records.flatMap((r) =>
        r.facts.links.map((l) => ({ page: r.surface.route, ...l })),
      );
      expect(inconsistentNameProblems(names)).toEqual([]);
    });

    test('on every page: search, navigation links and footer links', annotations, () => {
      const problems: string[] = [];
      for (const r of records) {
        const { landmarks } = r.facts;
        if (!landmarks.some((l) => l.role === 'search'))
          problems.push(`${r.surface.route}: no search landmark`);
        if (!landmarks.some((l) => l.role === 'navigation' && l.links > 0)) {
          problems.push(`${r.surface.route}: no navigation landmark with links`);
        }
        if (!landmarks.some((l) => l.role === 'contentinfo' && l.links > 0)) {
          problems.push(`${r.surface.route}: no footer links`);
        }
      }
      expect(problems).toEqual([]);
    });
  });
}
