/**
 * AECI-1879: the per-surface ARIA checks, defined once and run per surface group.
 *
 * `aria-*.spec.ts` each call `defineAriaSuite` with a filter over `SURFACES`,
 * as the keyboard specs do. Every surface gets:
 *
 *   `snapshot: main`   the ARIA snapshot of `main`, against the committed file (rule 1).
 *   `structure`        one h1, no skipped level, the four landmarks, unique
 *                      navigation and search names (rule 3).
 *   `link names`       no name points to two targets on one page (rule 5).
 *   `states: main`     before and after each disclosure, tab, combobox and toggle
 *                      button in `main` (rule 2), from `./state-snapshots.ts`.
 *   `states: header`   the same for the site header, on the first surface of each
 *                      persona only. The header is one component on every page.
 *
 * The header and footer snapshots and rule 4 compare pages with each other, so
 * they are in `aria-cross-page.spec.ts`. WCAG 1.3.1, 2.4.4, 2.4.6, 4.1.2.
 * `docs/TESTING_STRATEGY.md` §8.4.3.
 */
import { expect, test, type Page } from '@playwright/test';
import { knownFailure } from '../known-failure';
import { SURFACES, type A11ySurface } from '../surfaces';
import {
  collectPageFacts,
  maskAriaSnapshot,
  sharedNameProblems,
  structureProblems,
  type AriaNode,
} from './aria-tree';
import { headerOwnerFor } from './header-owner';
import { expectOnlyKnownProblems, type KnownProblem } from './known-barriers';
import { fakeHeaderSearch, guardWrites } from './page-guards';
import { snapshotStates, statesText } from './state-snapshots';
import {
  openSurface,
  phase2FixturesPresent,
  prepareSurface,
  surfaceAnnotations,
} from './surface-page';

export type AriaCheck = 'structure' | 'link names' | 'states' | 'header states';

/**
 * A known barrier, with the problem strings it covers. `expectOnlyKnownProblems`
 * (`./known-barriers.ts`) still fails on any other problem, and on a known issue
 * that no longer reproduces.
 */
interface AriaKnownProblem extends KnownProblem {
  readonly check: AriaCheck;
  readonly applies: (surface: A11ySurface) => boolean;
}

export const KNOWN_PROBLEMS: readonly AriaKnownProblem[] = [
  {
    check: 'link names',
    applies: (surface) => surface.id === 'product-detail',
    issue: 'AECI-2077',
    matches: (p) => p.startsWith('"About" links to '),
    mark: () =>
      knownFailure(
        'AECI-2077',
        'the section nav "About" goes to #about and the footer "About" goes to /about',
      ),
  },
  {
    check: 'link names',
    applies: (surface) => surface.persona === 'vendor',
    issue: 'AECI-2086',
    matches: (p) => /^"(Products|Categories|Audiences|Trades|Phases)" links to \//.test(p),
    mark: () =>
      knownFailure(
        'AECI-2086',
        'the portal nav and the footer both have "Products" (and four taxonomy names) for different pages',
      ),
  },
];

function knownFor(surface: A11ySurface, check: AriaCheck): AriaKnownProblem[] {
  return KNOWN_PROBLEMS.filter((k) => k.check === check && k.applies(surface));
}

/** Guards and stubs, then a hydrated load. The same start as the keyboard suite. */
async function load(page: Page, surface: A11ySurface, settle: boolean): Promise<void> {
  await guardWrites(page);
  await fakeHeaderSearch(page);
  await openSurface(page, surface, { settle });
}

/** The whole page's accessibility tree, as JSON. */
export async function pageTree(page: Page): Promise<AriaNode[]> {
  const tree = (await page.locator('body').ariaSnapshotJSON()) as unknown;
  return (Array.isArray(tree) ? tree : [tree]) as AriaNode[];
}

export function defineAriaSuite(group: string, include: (surface: A11ySurface) => boolean): void {
  const surfaces = SURFACES.filter(include);

  test.describe(`a11y nightly aria: ${group}`, () => {
    let fixturesPresent = false;
    test.beforeAll(async () => {
      test.setTimeout(120_000);
      fixturesPresent = await phase2FixturesPresent();
    });

    for (const surface of surfaces) {
      test.describe(`${surface.name} (${surface.route})`, () => {
        test('snapshot: main', surfaceAnnotations(surface), async ({ context, page }) => {
          test.setTimeout(120_000);
          await prepareSurface(context, surface, fixturesPresent);
          await load(page, surface, true);
          const main = page.getByRole('main');
          await expect(main).toHaveCount(1);
          expect(maskAriaSnapshot(await main.ariaSnapshot())).toMatchSnapshot(
            `aria-${surface.id}.yml`,
          );
        });

        test(
          'structure: one h1, no skipped level, landmarks, unique nav and search names',
          surfaceAnnotations(surface),
          async ({ context, page }) => {
            test.setTimeout(90_000);
            await prepareSurface(context, surface, fixturesPresent);
            await load(page, surface, true);
            expectOnlyKnownProblems(
              structureProblems(collectPageFacts(await pageTree(page))),
              knownFor(surface, 'structure'),
            );
          },
        );

        test(
          'link names: one name never points to two targets',
          surfaceAnnotations(surface),
          async ({ context, page }) => {
            test.setTimeout(90_000);
            await prepareSurface(context, surface, fixturesPresent);
            await load(page, surface, true);
            expectOnlyKnownProblems(
              sharedNameProblems(collectPageFacts(await pageTree(page)).links),
              knownFor(surface, 'link names'),
            );
          },
        );

        test(
          'states: each disclosure, tab, combobox and toggle button in main, before and after',
          surfaceAnnotations(surface),
          async ({ context, page }) => {
            test.setTimeout(300_000);
            await prepareSurface(context, surface, fixturesPresent);
            await load(page, surface, false);
            const { records, problems } = await snapshotStates(
              page,
              () => page.getByRole('main'),
              () => openSurface(page, surface).then(() => undefined),
            );
            expect(statesText(`${surface.id}: main`, records)).toMatchSnapshot(
              `aria-states-${surface.id}.txt`,
            );
            expectOnlyKnownProblems(problems, knownFor(surface, 'states'));
          },
        );

        // The header is one component on every page, so its states are
        // snapshotted on each persona's first surface only, as the keyboard
        // suite checks its popups (`./header-owner.ts`).
        if (headerOwnerFor(surface.persona, true) === surface.id) {
          test(
            'states: the site header, before and after',
            surfaceAnnotations(surface),
            async ({ context, page }) => {
              test.setTimeout(300_000);
              await prepareSurface(context, surface, fixturesPresent);
              await load(page, surface, false);
              const { records, problems } = await snapshotStates(
                page,
                () => page.getByRole('banner'),
                () => openSurface(page, surface).then(() => undefined),
              );
              expect(statesText(`header, ${surface.persona}`, records)).toMatchSnapshot(
                `aria-states-header-${surface.persona}.txt`,
              );
              expectOnlyKnownProblems(problems, knownFor(surface, 'header states'));
            },
          );
        }
      });
    }
  });
}
