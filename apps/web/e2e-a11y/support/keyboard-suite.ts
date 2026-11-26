/**
 * AECI-1877: the keyboard checks, defined once and run per surface group.
 *
 * `keyboard-*.spec.ts` each call `defineKeyboardSuite` with a filter over
 * `SURFACES`, so every surface runs the same checks and each group gets its own
 * file (the issue's "one keyboard spec per surface group"). The checks script
 * `docs/a11y-manual-testing-checklist.md` §2 "Keyboard-only (every surface)":
 *
 *   1-6  `tab walk`: the order snapshot (2), no trap and a closed cycle that
 *        reaches the footer (3), the candidate diff (4), the skip link (5), and
 *        nothing opens or navigates on focus (6). WCAG 2.1.1, 2.1.2, 2.4.1, 2.4.3, 3.2.1.
 *   7a   `overlays`: every popup trigger in the walk, by `./overlay-check.ts`. The
 *        site header's triggers once per persona (`headerOwnerFor`, `./header-owner.ts`).
 *   7a'  `popovers`: the Tab rule for floating popovers, kept apart from 7a.
 *   7b   `aria-haspopup names the popup it opens`: the static role check (`./popup-roles.ts`).
 *   7c   one test per `OVERLAY_SCENARIOS` entry on the surface.
 *   8    `after navigation`: Enter on an in-page link, then focus is not on `body`.
 *
 * Known barriers are marked with `knownFailure`, through `KNOWN_BARRIERS` below.
 */
import { expect, test, type Page } from '@playwright/test';
import { knownFailure } from '../known-failure';
import { SURFACES, type A11ySurface } from '../surfaces';
import { browserOf, expected } from './browser-expectations';
import { markKnownBarriers, type KnownBarrier } from './known-barriers';
import {
  checkOverlay,
  classifyTrigger,
  describeStop,
  isPopupTrigger,
  POPOVER_CONTAINED,
  probeFloatingPanel,
  type OverlayPlan,
} from './overlay-check';
import { OVERLAY_SCENARIOS } from './overlay-scenarios';
import { fakeHeaderSearch, guardWrites } from './page-guards';
import { headerOwnerFor } from './header-owner';
import { haspopupMismatch } from './popup-roles';
import { collectElementFacts, focusFacts, haspopupFacts } from './probe';
import {
  openSurface,
  phase2FixturesPresent,
  prepareSurface,
  surfaceAnnotations,
} from './surface-page';
import { candidateTabStops, diffCandidates } from './tab-candidates';
import { tabTo, tabWalk, walkSnapshot, type TabStop } from './tab-walk';

export type KeyboardCheck =
  | 'tab walk'
  | 'overlays'
  | 'popovers'
  | 'aria-haspopup'
  | 'after navigation';

/** The barriers this suite finds today. The shape is in `./known-barriers.ts`. */
export const KNOWN_BARRIERS: readonly KnownBarrier<KeyboardCheck>[] = [
  {
    check: 'aria-haspopup',
    // An attribute in the markup, so every engine reads the same mismatch.
    browsers: ['chromium', 'firefox', 'webkit'],
    // The admin console nav renders on every admin surface.
    applies: (surface) => surface.persona === 'admin',
    mark: () =>
      knownFailure(
        'AECI-2058',
        'the admin nav triggers say aria-haspopup="true" (a menu) but open a list of links',
      ),
  },
];

/** The routes every keyboard test installs once, before its first load. */
async function installRoutes(page: Page, surface: A11ySurface): Promise<void> {
  await guardWrites(page);
  await fakeHeaderSearch(page);
  for (const scenario of OVERLAY_SCENARIOS) {
    if (scenario.surfaceId === surface.id) await scenario.prepare(page);
  }
}

/** Routes, then a hydrated load, as every keyboard test starts. */
async function load(
  page: Page,
  surface: A11ySurface,
  options: { settle?: boolean } = {},
): Promise<void> {
  await installRoutes(page, surface);
  await openSurface(page, surface, options);
}

/** Matches the n-th stop with the same role and name, so a trigger is found again after a reload. */
function sameStop(target: TabStop, stops: readonly TabStop[]): (s: TabStop) => boolean {
  const occurrence = stops.filter(
    (s) => s.index <= target.index && s.role === target.role && s.name === target.name,
  ).length;
  let seen = 0;
  return (s) => {
    if (s.role !== target.role || s.name !== target.name) return false;
    seen++;
    return seen === occurrence;
  };
}

function formatStops(stops: readonly { role: string; name: string }[]): string[] {
  return stops.map(describeStop);
}

export function defineKeyboardSuite(
  group: string,
  include: (surface: A11ySurface) => boolean,
): void {
  const surfaces = SURFACES.filter(include);

  test.describe(`a11y nightly keyboard: ${group}`, () => {
    let fixturesPresent = false;
    test.beforeAll(async () => {
      // A cold product page can take a while to render on a busy runner.
      test.setTimeout(120_000);
      fixturesPresent = await phase2FixturesPresent();
    });

    for (const surface of surfaces) {
      test.describe(`${surface.name} (${surface.route})`, () => {
        test(
          'tab walk: order, no trap, candidates, skip link, nothing on focus',
          surfaceAnnotations(surface),
          async ({ context, page }) => {
            test.setTimeout(120_000);
            await prepareSurface(context, surface, fixturesPresent);
            markKnownBarriers(KNOWN_BARRIERS, surface, 'tab walk', browserOf(page));
            await load(page, surface, { settle: true });

            const facts = await collectElementFacts(page);
            const walk = await tabWalk(page);

            // 3. No trap: every press moves focus, and the cycle closes through the footer.
            expect(
              walk.end,
              `the Tab cycle closes (ended ${walk.end} after ${walk.presses} presses)`,
            ).toBe('closed');
            expect
              .soft(
                walk.stops.some((s) => s.landmark === 'footer'),
                'the walk reaches the footer',
              )
              .toBe(true);

            // 6. On focus: no stop navigates or opens a popup.
            expect.soft(walk.navigatedTo, 'no Tab stop changes the URL').toBeNull();
            expect
              .soft(
                formatStops(walk.popupOpenedAt),
                'no Tab stop opens a dialog, menu or list on focus',
              )
              .toEqual([]);

            // 2. The order, against the committed snapshot. A change is a behaviour change.
            expect.soft(walkSnapshot(walk.stops)).toMatchSnapshot(`keyboard-${surface.id}.txt`);

            // 4. The candidate diff (checklist §5).
            // The scroller rule is the engine's (`./browser-expectations.ts`).
            // Chromium's value is the default the prediction always had.
            const diff = diffCandidates(
              candidateTabStops(facts, {
                keyboardFocusableScrollers: expected('keyboardFocusableScrollers', browserOf(page)),
                scrollersWithFocusableContent: expected(
                  'scrollersWithFocusableContent',
                  browserOf(page),
                ),
              }),
              walk.stops,
            );
            expect
              .soft(
                diff.neverReached.map((c) => c.label),
                'predicted Tab stops that Tab never reached',
              )
              .toEqual([]);
            expect.soft(formatStops(diff.unexpected), 'Tab stops nobody predicted').toEqual([]);
            expect
              .soft(
                formatStops(diff.focusableButHidden),
                'Tab stops that are hidden (aria-hidden or no box)',
              )
              .toEqual([]);

            // 5. The skip link: first stop, and Enter puts focus inside main without a load.
            expect(walk.stops[0], 'the first Tab stop is the skip link').toMatchObject({
              role: 'link',
              name: 'Skip to main content',
            });
            const path = new URL(page.url()).pathname;
            let documentLoads = 0;
            page.on('request', (r) => {
              if (r.resourceType() === 'document') documentLoads++;
            });
            await page.keyboard.press('Enter');
            await expect
              .poll(
                async () =>
                  (await focusFacts(page)).inMain || (await focusFacts(page)).tag === 'main',
                {
                  message: 'Enter on the skip link puts focus inside main',
                },
              )
              .toBe(true);
            expect.soft(new URL(page.url()).pathname, 'the skip link keeps the path').toBe(path);
            expect.soft(documentLoads, 'the skip link loads no new document').toBe(0);
          },
        );

        test(
          'overlays: open by keyboard, keep focus, close on Escape, return focus',
          surfaceAnnotations(surface),
          async ({ context, page }) => {
            // The slowest surface takes about 8 s on one quiet worker. 120 s leaves room for a busy runner.
            test.setTimeout(120_000);
            await prepareSurface(context, surface, fixturesPresent);
            markKnownBarriers(KNOWN_BARRIERS, surface, 'overlays', browserOf(page));
            await load(page, surface);
            const first = await tabWalk(page);
            expect(first.end, 'the Tab cycle closes, so every trigger is known').toBe('closed');
            const startUrl = page.url();

            // The triggers are checked one after another in the same document: each
            // check ends with the popup closed and focus back on its trigger, and the
            // next trigger is reached by Tab from there. The page is reloaded, and its
            // stops walked again, only after a check that may have left it changed.
            let current = first.stops;
            let reloadNeeded = false;
            const reachInPage = async (trigger: TabStop): Promise<TabStop | null> => {
              if (reloadNeeded) {
                await openSurface(page, surface);
                const again = await tabWalk(page);
                current = again.stops;
                reloadNeeded = false;
              }
              const stop = current.find(sameStop(trigger, first.stops));
              if (!stop) return null;
              const reached = await tabTo(page, stop.key, { maxPresses: current.length + 5 });
              return reached ? stop : null;
            };

            const problems: string[] = [];
            const checksHeader = headerOwnerFor(surface.persona, fixturesPresent) === surface.id;
            test.info().annotations.push({
              type: 'header-overlays',
              description: checksHeader ? 'checked here' : 'checked on another surface',
            });
            const triggers = first.stops.filter(
              (s) => isPopupTrigger(s) && (checksHeader || !s.inSiteHeader),
            );
            for (const trigger of triggers) {
              const label = describeStop(trigger);
              await test.step(label, async () => {
                const found = classifyTrigger(trigger);
                if (!found) {
                  problems.push(`${label}: no rule in overlay-check.ts says how to open it`);
                  return;
                }
                if ('notOverlay' in found) {
                  test.info().annotations.push({
                    type: 'not-an-overlay',
                    description: `${label}: ${found.notOverlay}`,
                  });
                  return;
                }
                let stop = await reachInPage(trigger);
                if (!stop) {
                  reloadNeeded = true;
                  stop = await reachInPage(trigger);
                }
                if (!stop) {
                  problems.push(`${label}: Tab did not reach it again`);
                  reloadNeeded = true;
                  return;
                }
                let plan: OverlayPlan;
                if ('probe' in found) {
                  const probed = await probeFloatingPanel(page, stop);
                  if ('notOverlay' in probed) {
                    test.info().annotations.push({
                      type: 'not-an-overlay',
                      description: `${label}: ${probed.notOverlay}`,
                    });
                    reloadNeeded = true;
                    return;
                  }
                  plan = probed.overlay;
                  if (!(await tabTo(page, stop.key, { maxPresses: current.length + 5 }))) {
                    problems.push(`${label}: focus did not come back to it after the first open`);
                    reloadNeeded = true;
                    return;
                  }
                } else {
                  plan = found.overlay;
                }
                const result = await checkOverlay(page, stop, plan);
                problems.push(...result.map((p) => `${label} (${plan.kind}): ${p}`));
                test.info().annotations.push({
                  type: 'overlay',
                  description: `${plan.kind} ${label}: ${result.length === 0 ? 'pass' : 'fail'}`,
                });
                // A failed check, a changed URL (a select that sorts), or a typed query
                // leaves the page in a state the next check should not start from.
                if (result.length > 0 || page.url() !== startUrl || plan.kind === 'search') {
                  reloadNeeded = true;
                }
              });
            }
            expect(problems).toEqual([]);
          },
        );

        test(
          'popovers: Tab stays inside an open popover or closes it',
          surfaceAnnotations(surface),
          async ({ context, page }) => {
            test.setTimeout(120_000);
            await prepareSurface(context, surface, fixturesPresent);
            markKnownBarriers(KNOWN_BARRIERS, surface, 'popovers', browserOf(page));
            await load(page, surface);
            const first = await tabWalk(page);
            expect(first.end, 'the Tab cycle closes, so every trigger is known').toBe('closed');

            // The overlays test checks a popover opens, closes on Escape and returns
            // focus. This one checks the rule every other non-modal popup meets:
            // after each Tab, focus is inside it or it has closed. It is its own
            // test so a known popover barrier does not hide the other overlays.
            const problems: string[] = [];
            let checked = 0;
            const candidates = first.stops.filter((s) => {
              const found = isPopupTrigger(s) ? classifyTrigger(s) : null;
              return !!found && 'probe' in found;
            });
            for (const trigger of candidates) {
              const label = describeStop(trigger);
              await test.step(label, async () => {
                await openSurface(page, surface);
                const again = await tabWalk(page, { until: sameStop(trigger, first.stops) });
                if (again.end !== 'matched') {
                  problems.push(`${label}: Tab did not reach it again`);
                  return;
                }
                const stop = again.stops.at(-1)!;
                const probed = await probeFloatingPanel(page, stop);
                if ('notOverlay' in probed) return;
                if (!(await tabTo(page, stop.key, { maxPresses: again.stops.length + 5 }))) {
                  problems.push(`${label}: focus did not come back to it after the first open`);
                  return;
                }
                checked++;
                const result = await checkOverlay(page, stop, POPOVER_CONTAINED);
                problems.push(...result.map((p) => `${label} (popover): ${p}`));
                test.info().annotations.push({
                  type: 'overlay',
                  description: `popover containment ${label}: ${result.length === 0 ? 'pass' : 'fail'}`,
                });
              });
            }
            test.info().annotations.push({
              type: 'popovers-checked',
              description: String(checked),
            });
            expect(problems).toEqual([]);
          },
        );

        test(
          'aria-haspopup names the popup it opens',
          surfaceAnnotations(surface),
          async ({ context, page }) => {
            test.setTimeout(90_000);
            await prepareSurface(context, surface, fixturesPresent);
            markKnownBarriers(KNOWN_BARRIERS, surface, 'aria-haspopup', browserOf(page));
            await load(page, surface);
            const mismatches = (await haspopupFacts(page))
              .filter((f) => f.role !== 'combobox')
              .map((f) => {
                const why = haspopupMismatch(f.haspopup, f.controlledRoles);
                return why ? `${f.label}: ${why}` : null;
              })
              .filter((m): m is string => m !== null);
            expect(mismatches).toEqual([]);
          },
        );

        for (const scenario of OVERLAY_SCENARIOS.filter((s) => s.surfaceId === surface.id)) {
          test(
            `overlay: ${scenario.name}`,
            surfaceAnnotations(surface),
            async ({ context, page }) => {
              test.setTimeout(120_000);
              await prepareSurface(context, surface, fixturesPresent);
              await load(page, surface);
              const trigger = await scenario.reach(page);
              const problems = await checkOverlay(page, trigger, scenario.plan);
              test.info().annotations.push({
                type: 'overlay',
                description: `${scenario.plan.kind} ${describeStop(trigger)}: ${problems.length === 0 ? 'pass' : 'fail'}`,
              });
              expect(problems).toEqual([]);
            },
          );
        }

        test(
          'after navigation: focus is not left on the page body',
          surfaceAnnotations(surface),
          async ({ context, page }) => {
            test.setTimeout(90_000);
            await prepareSurface(context, surface, fixturesPresent);
            markKnownBarriers(KNOWN_BARRIERS, surface, 'after navigation', browserOf(page));
            await load(page, surface);
            const here = new URL(page.url());
            // The first in-app link in main that leads to another page. Hash links and
            // new-tab links do not navigate this document.
            const leadsAway = (s: TabStop): boolean => {
              if (s.role !== 'link' || !s.inMain || s.target === '_blank') return false;
              if (!s.href?.startsWith('/') || s.href.startsWith('//')) return false;
              return new URL(s.href, here).pathname !== here.pathname;
            };
            const walk = await tabWalk(page, { until: leadsAway });
            test.skip(walk.end !== 'matched', 'no in-app link in main on this surface');
            const link = walk.stops.at(-1)!;

            // A list can re-render under focus after load (AECI-1863). Enter then lands
            // on nothing, so confirm focus is still on the link first.
            const before = await focusFacts(page);
            expect(before.key, `focus is still on ${describeStop(link)} before Enter`).toBe(
              link.key,
            );
            const oldHeading = await page.locator('h1').first().textContent();
            let documentLoads = 0;
            page.on('request', (r) => {
              if (r.resourceType() === 'document') documentLoads++;
            });
            await page.keyboard.press('Enter');
            // The router moves the URL only once the new route's resolvers have their
            // data, which takes a while on a busy runner.
            await expect(page, `Enter on ${describeStop(link)} navigates`).not.toHaveURL(
              here.href,
              { timeout: 30_000 },
            );
            // Wait for the new page to render, so a link that is about to be replaced
            // does not count as "focus on an element". A link in a persistent row may
            // keep focus on purpose (data-route-focus-keep, AECI-1855).
            await expect(page.locator('h1').first())
              .not.toHaveText(oldHeading ?? '', { timeout: 10_000 })
              .catch(() => undefined);
            await expect
              .poll(async () => (await focusFacts(page)).onBody, {
                message: `after Enter on ${describeStop(link)}, focus is on an element, not the page body`,
                timeout: 10_000,
              })
              .toBe(false);
            expect(documentLoads, 'the link navigates in the app, without a new document').toBe(0);
          },
        );
      });
    }
  });
}
