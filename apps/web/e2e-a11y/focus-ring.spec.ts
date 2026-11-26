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
import { KNOWN_FAILURE_ANNOTATION, knownFailure } from './known-failure';
import { SURFACES, type A11ySurface } from './surfaces';
import {
  formatFinding as format,
  measureWalk,
  type FocusCheck,
  type FocusFinding,
  type Measured,
} from './support/focus-check';
import {
  A11Y_BROWSERS,
  browserOf,
  browserOfProject,
  notInTags,
  type A11yBrowser,
} from './support/browser-expectations';
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
 * Each surface gets one `known focus barriers: <check>, <issue>` test per check
 * and issue (AECI-1885 review 4). Every entry of that issue must still match a
 * finding, or the test fails unmarked. Then it asserts the covered findings are
 * gone, so it stays green while the barrier is there and turns red the day it is
 * fixed, whatever other issue on the same check stays open. Then the entry goes.
 */
interface FocusBarrier {
  readonly check: FocusCheck;
  /** The issue `mark` names. One test per check and issue judges it alone. */
  readonly issue: `AECI-${number}`;
  /** AECI-1885: the browsers the barrier is found in. The others still fail on it. */
  readonly browsers: readonly A11yBrowser[];
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

/** The surfaces where WebKit leaves a text field under the consent banner (AECI-2195). */
const WEBKIT_FIELDS_UNDER_BANNER = new Set([
  'login',
  'review-submission',
  'account',
  'vendor-integrations',
  'categories-index',
]);
const TEXT_FIELD_ROLES = new Set(['textbox', 'searchbox']);

/**
 * AECI-2197: the links that keep the browser's `outline-style: auto`, found by
 * the WebKit runs of 2026-11-26. Each by name and landmark, on its surfaces. A new
 * control with no ring of its own is a new finding, not absorbed here.
 */
const AUTO_RING_LINKS: ReadonlyArray<{
  readonly name: string;
  readonly landmark: string;
  readonly on: (surface: A11ySurface) => boolean;
}> = [
  // The consent banner, on every surface.
  { name: 'Read our Privacy Policy', landmark: 'page', on: () => true },
  { name: 'suggest a correction', landmark: 'main', on: (s) => s.id === 'product-detail' },
  {
    name: 'Fixture Procore Technologies',
    landmark: 'main',
    on: (s) => s.id === 'integration-detail' || s.id === 'product-pair',
  },
];

export const KNOWN_FOCUS_BARRIERS: readonly FocusBarrier[] = [
  {
    check: 'contrast',
    issue: 'AECI-2097',
    browsers: ['chromium', 'firefox', 'webkit'],
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
    // Found by the Firefox lane (AECI-1885). Firefox does not scroll a stop that
    // is already inside the viewport, so the consent banner's scroll margin
    // (AECI-1818) never applies and the banner covers the stop.
    check: 'obscured',
    issue: 'AECI-2195',
    browsers: ['firefox'],
    applies: (surface) => surface.id === 'not-found' || surface.id === 'account',
    covers: ({ detail }) => detail.includes('in aec-consent-banner'),
    mark: () =>
      knownFailure(
        'AECI-2195',
        'Firefox ignores the consent banner scroll margin, so a stop lands under the banner',
      ),
  },
  {
    // Found by the WebKit lane (AECI-1885). WebKit does not scroll a text field
    // that is already inside the viewport, so the banner's margin never applies.
    check: 'obscured',
    issue: 'AECI-2195',
    browsers: ['webkit'],
    applies: (surface) => WEBKIT_FIELDS_UNDER_BANNER.has(surface.id),
    covers: ({ stop, detail }) =>
      TEXT_FIELD_ROLES.has(stop.role) && detail.includes('in aec-consent-banner'),
    mark: () =>
      knownFailure(
        'AECI-2195',
        'WebKit ignores the consent banner scroll margin for a text field, so it lands under the banner',
      ),
  },
  {
    // The same field: the banner covers part of its ring, so too few pixels reach 3:1.
    check: 'contrast',
    issue: 'AECI-2195',
    browsers: ['webkit'],
    applies: (surface) => surface.id === 'categories-index',
    covers: ({ stop }) => stop.role === 'textbox' && stop.name === 'Email address',
    mark: () =>
      knownFailure('AECI-2195', 'the consent banner covers part of the field and its ring'),
  },
  {
    // Found by the WebKit lane (AECI-1885). The control keeps the browser's
    // `outline-style: auto`, which WebKit draws as the system ring, not in our colour.
    check: 'contrast',
    issue: 'AECI-2197',
    browsers: ['webkit'],
    applies: (surface) => AUTO_RING_LINKS.some((c) => c.on(surface)),
    covers: ({ stop, detail }) =>
      / \d+px auto /.test(detail) &&
      AUTO_RING_LINKS.some(
        (c) => stop.role === 'link' && stop.landmark === c.landmark && stop.name === c.name,
      ),
    mark: () =>
      knownFailure(
        'AECI-2197',
        'WebKit draws outline-style auto as its system ring, about 2.1:1, not the Forest ring',
      ),
  },
  {
    // AECI-2097 in WebKit: the same section nav clips one more link's ring.
    check: 'contrast',
    issue: 'AECI-2097',
    browsers: ['webkit'],
    applies: (surface) => surface.id === 'vendor-products',
    covers: ({ stop }) => stop.role === 'link' && stop.landmark === 'nav' && stop.name === 'Seats',
    mark: () =>
      knownFailure(
        'AECI-2097',
        'the vendor portal section nav clips the top and bottom of its links’ focus ring',
      ),
  },
  {
    check: 'boundary',
    issue: 'AECI-2098',
    browsers: ['chromium', 'firefox', 'webkit'],
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

function barriersFor(
  surface: A11ySurface,
  check: FocusCheck,
  browser: A11yBrowser,
): FocusBarrier[] {
  return KNOWN_FOCUS_BARRIERS.filter(
    (b) => b.check === check && b.browsers.includes(browser) && b.applies(surface),
  );
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
          // Every stop with no verdict is counted and named. Only an iframe and a
          // stop with no box are expected. Any other reason is an `unmeasured`
          // finding below, so the test fails rather than measure fewer stops.
          info.push({
            type: 'focus-stops-unmeasured',
            description: String(measured.unmeasured.length),
          });
          for (const u of measured.unmeasured) {
            info.push({
              type: 'focus-unmeasured',
              description: `${u.stop.landmark} ${u.stop.role} "${u.stop.name}": ${u.reason}${u.detail ? ` (${u.detail})` : ''}`,
            });
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
            if (barriersFor(surface, f.check, browserOf(page)).some((b) => b.covers(f))) {
              info.push({ type: 'focus-known', description: format(f) });
              continue;
            }
            open.push(format(f));
          }
          expect(open, 'focus ring findings with no allow-list entry or known issue').toEqual([]);
        },
      );

      for (const check of CHECKS) {
        // One test per check and issue, declared when the issue is known here in
        // any browser. A test is declared before its project is known, so a
        // browser the issue is not found in drops it by tag (`@not-<browser>`,
        // the projects' `grepInvert`).
        const here = KNOWN_FOCUS_BARRIERS.filter((b) => b.check === check && b.applies(surface));
        for (const issue of [...new Set(here.map((b) => b.issue))]) {
          const ofIssue = here.filter((b) => b.issue === issue);
          const foundIn = A11Y_BROWSERS.filter((browser) =>
            ofIssue.some((b) => b.browsers.includes(browser)),
          );
          test(
            `known focus barriers: ${check}, ${issue}`,
            { ...surfaceAnnotations(surface), tag: notInTags(foundIn) },
            () => {
              const browser = browserOfProject(test.info().project.name);
              const barriers = ofIssue.filter((b) => b.browsers.includes(browser));
              test.skip(barriers.length === 0, `${issue} is not known here in ${browser}`);
              test.skip(result === null, 'the walk test did not run');
              const findings = result!.findings.filter((f) => f.check === check);
              // Each entry is judged alone: one that matches nothing is fixed, or
              // wrong, and fails unmarked until it is removed.
              const stale = barriers.filter((b) => !findings.some((f) => b.covers(f)));
              expect(stale.length, `${issue}: an entry no longer matches any finding`).toBe(0);
              for (const b of barriers) b.mark();
              expect(
                test
                  .info()
                  .annotations.filter(
                    (x) => x.type === KNOWN_FAILURE_ANNOTATION && x.description === issue,
                  ).length,
                `every ${issue} entry marks ${issue}`,
              ).toBeGreaterThan(0);
              expect(findings.filter((f) => barriers.some((b) => b.covers(f))).map(format)).toEqual(
                [],
              );
            },
          );
        }
      }
    });
  }
});
