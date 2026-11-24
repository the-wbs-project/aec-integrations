/**
 * AECI-1878: the focus ring on every Tab stop of every manifest surface.
 *
 * axe cannot tell whether a focus indicator is visible, so this spec looks.
 * One Tab walk per surface (`tabWalk` from `support/tab-walk.ts`, the walk the
 * keyboard suite uses), and at each stop, through the walk's `onStop` hook:
 *
 *   1. Visible (WCAG 2.4.7). A picture of the stop focused and one unfocused,
 *      clipped to the stop and 8px round it. No changed pixel fails.
 *   2. Contrast (WCAG 1.4.11, the focus part). Each changed pixel is the
 *      indicator, measured against the same pixel unfocused: the ground it is
 *      drawn on. Pixels at 3:1 or more must add up to a 1px line round the stop.
 *   3. Not obscured (WCAG 2.4.11). `elementFromPoint` at the centre of the
 *      stop's on-screen box is the stop or inside it. This catches focus under
 *      the sticky header, a sticky bar or the consent banner.
 *   4. Control boundary (WCAG 1.4.11). A text field, select, combobox, checkbox
 *      or radio shows its edge at 3:1 against the ground round it: by every
 *      border it has, by its own fill, or by the box the browser draws.
 *
 * The unfocused picture of a stop is taken once focus has moved on to a stop
 * whose ring is clear of it, at the scroll position the stop had, so the walk
 * is the only walk. The last ones are taken after the walk, with focus removed.
 * The site header and footer are measured in full once per persona
 * (`headerOwnerFor`). Elsewhere their stops run the obscured check only.
 *
 * `docs/TESTING_STRATEGY.md` §8.4.5. False positives go in `ALLOW_LIST`, real
 * barriers in `KNOWN_FOCUS_BARRIERS`, each with its reason.
 */
import { expect, test } from '@playwright/test';
import { knownFailure } from './known-failure';
import { SURFACES, type A11ySurface } from './surfaces';
import {
  formatFinding as format,
  measureWalk,
  type FocusCheck,
  type FocusFinding,
  type Measured,
} from './support/focus-check';
import { headerOwnerFor } from './support/header-owner';
import { fakeHeaderSearch, guardWrites } from './support/page-guards';
import {
  openSurface,
  phase2FixturesPresent,
  prepareSurface,
  surfaceAnnotations,
} from './support/surface-page';

/**
 * A finding that is wrong about the element: the check misjudges it. Each entry
 * names the stops it covers and says why. Never a real barrier: that is a
 * Linear issue and `KNOWN_FOCUS_BARRIERS`.
 */
interface AllowEntry {
  readonly check: FocusCheck;
  readonly applies: (surface: A11ySurface) => boolean;
  readonly covers: (finding: FocusFinding) => boolean;
  readonly reason: string;
}

/** Empty on landing (2026-11-24): every finding so far was a real barrier. */
export const ALLOW_LIST: readonly AllowEntry[] = [];

/**
 * A real barrier this spec finds today, with its Linear issue. The same shape
 * as the keyboard suite's known barriers: `applies` picks the surfaces and
 * `mark` calls `knownFailure` with a literal issue ID, which `pnpm test:scripts`
 * requires. `covers` picks the findings, so the walk test still fails on any
 * other finding on the same surface.
 *
 * Each surface with a barrier gets a `known focus barriers: <check>` test. It
 * asserts the covered findings are gone, so it stays green while the barrier is
 * there and turns red the day it is fixed. Then the entry goes.
 */
interface FocusBarrier {
  readonly check: FocusCheck;
  readonly applies: (surface: A11ySurface) => boolean;
  readonly covers: (finding: FocusFinding) => boolean;
  readonly mark: () => void;
}

/** The vendor portal's section nav links: the portal level and the product level. */
const PORTAL_NAV = new Set([
  'Vendor Overview',
  'Profile',
  'Products',
  'Messages',
  'Conversations',
  'Changes',
  'Product Overview',
  'Categories',
  'Trades',
  'Audiences',
  'Phases',
  'Integrations',
  'Reviews',
]);

export const KNOWN_FOCUS_BARRIERS: readonly FocusBarrier[] = [
  {
    check: 'contrast',
    applies: (surface) => surface.id === 'vendor-products' || surface.id === 'vendor-integrations',
    covers: ({ stop }) =>
      stop.role === 'link' && stop.landmark === 'nav' && stop.inMain && PORTAL_NAV.has(stop.name),
    mark: () =>
      knownFailure(
        'AECI-2097',
        'the vendor portal section nav clips the top and bottom of its links’ focus ring',
      ),
  },
  {
    check: 'boundary',
    applies: (surface) => surface.id === 'vendor-integrations',
    covers: ({ stop }) =>
      (stop.role === 'searchbox' && stop.name === 'Search') ||
      (stop.role === 'combobox' && stop.name === 'Integrates with'),
    mark: () =>
      knownFailure(
        'AECI-2098',
        'the portal integrations filters have a 1.22:1 edge on their #FAFAFA panel',
      ),
  },
];

function barriersFor(surface: A11ySurface, check: FocusCheck): FocusBarrier[] {
  return KNOWN_FOCUS_BARRIERS.filter((b) => b.check === check && b.applies(surface));
}

const CHECKS: readonly FocusCheck[] = ['visible', 'contrast', 'obscured', 'boundary'];

test.describe('a11y nightly focus ring', () => {
  let fixturesPresent = false;
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    fixturesPresent = await phase2FixturesPresent();
  });

  for (const surface of SURFACES) {
    test.describe(`${surface.name} (${surface.route})`, () => {
      // The known-barrier tests read the walk test's findings.
      test.describe.configure({ mode: 'serial' });
      let result: Measured | null = null;

      test(
        'focus ring on every Tab stop: visible, 3:1, not obscured, and control edges at 3:1',
        surfaceAnnotations(surface),
        async ({ context, page }) => {
          // The longest surface takes under a minute on one quiet worker.
          test.setTimeout(240_000);
          await prepareSurface(context, surface, fixturesPresent);
          await guardWrites(page);
          await fakeHeaderSearch(page);
          await openSurface(page, surface, { settle: true });

          const checksChrome = headerOwnerFor(surface.persona, fixturesPresent) === surface.id;
          const measured = await measureWalk(page, checksChrome);
          result = measured;
          const info = test.info().annotations;
          info.push({
            type: 'header-footer-focus',
            description: checksChrome
              ? 'checked here'
              : 'obscured only, the rest on another surface',
          });
          info.push({ type: 'focus-stops-measured', description: String(measured.measured) });
          info.push({
            type: 'focus-stops-obscured-only',
            description: String(measured.sharedChromeHitTestOnly),
          });
          for (const note of measured.notMeasured) {
            info.push({ type: 'focus-not-measured', description: note });
          }

          expect(measured.end, 'the Tab cycle closes, so every stop was measured').toBe('closed');
          const open: string[] = [];
          for (const f of measured.findings) {
            const allowed = ALLOW_LIST.find(
              (a) => a.check === f.check && a.applies(surface) && a.covers(f),
            );
            if (allowed) {
              info.push({ type: 'focus-allowed', description: `${format(f)}. ${allowed.reason}` });
              continue;
            }
            if (barriersFor(surface, f.check).some((b) => b.covers(f))) {
              info.push({ type: 'focus-known', description: format(f) });
              continue;
            }
            open.push(format(f));
          }
          expect(open, 'focus ring findings with no allow-list entry or known issue').toEqual([]);
        },
      );

      for (const check of CHECKS) {
        const barriers = barriersFor(surface, check);
        if (barriers.length === 0) continue;
        test(`known focus barriers: ${check}`, surfaceAnnotations(surface), () => {
          test.skip(result === null, 'the walk test did not run');
          for (const b of barriers) b.mark();
          const still = result!.findings.filter(
            (f) => f.check === check && barriers.some((b) => b.covers(f)),
          );
          expect(still.map(format)).toEqual([]);
        });
      }
    });
  }
});
