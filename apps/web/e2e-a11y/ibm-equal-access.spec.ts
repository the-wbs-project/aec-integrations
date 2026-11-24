/**
 * AECI-1884: IBM Equal Access as a second rule engine, on every manifest surface.
 * Report only.
 *
 * One test per surface. Each loads the surface with everything that renders on
 * scroll in place (`openSurface` with `settle`), then runs axe and the IBM
 * engine on that one state, and marks each IBM finding axe also reported
 * (`matchAxe` in `support/ibm-overlap.ts`). The record goes to the summary's
 * `ibm` block. axe remains the gate. Nothing IBM finds fails the run.
 *
 * The test fails only when:
 *   - the surface did not render (wrong status, or no visible `h1`), or the
 *     engine did not run: it failed to load, threw, or no rule returned a
 *     result. A broken scan must not read as a clean one.
 *   - the browser context made a request, or the page opened a WebSocket, to
 *     another host between injecting the engine and the end of both scans. The
 *     engine has no network code, so that would mean page data could leave the
 *     runner, which AECI-1884 rules out.
 *
 * `docs/TESTING_STRATEGY.md` §8.4.9.
 */
import { expect, test } from '@playwright/test';
import { E2E_BASE_URL } from '../e2e/base-url';
import { SURFACES } from './surfaces';
import {
  IBM_ENGINE_VERSION,
  IBM_RULESET,
  injectEngines,
  runAxe,
  runIbm,
  watchRequests,
} from './support/ibm-engine';
import { IBM_ANNOTATION, matchAxe, type IbmSurfaceRecord } from './support/ibm-overlap';
import { guardWrites } from './support/page-guards';
import {
  openSurface,
  phase2FixturesPresent,
  prepareSurface,
  surfaceAnnotations,
} from './support/surface-page';

test.describe('a11y nightly IBM Equal Access, report only', () => {
  // Every test stands alone, so the nightly's shards may split the file anywhere.
  // The fixture probe runs once per worker, on the first test that needs it.
  let fixtures: Promise<boolean> | null = null;
  const fixturesPresent = () => (fixtures ??= phase2FixturesPresent());

  for (const surface of SURFACES) {
    test(
      `${surface.name} (${surface.route})`,
      surfaceAnnotations(surface),
      async ({ context, page }) => {
        test.setTimeout(120_000);
        await prepareSurface(context, surface, await fixturesPresent());
        // Reads only. The signed-in surfaces run as real test accounts.
        await guardWrites(page);
        await openSurface(page, surface, { settle: true });
        // "Did it run" needs a real page. Rules on `html`, `head` and `title`
        // return results on an error page too, so check the surface rendered:
        // `openSurface` checked its status, and this is `surfaces.spec.ts`'s h1 rule.
        await expect(page.locator('h1').filter({ visible: true })).toHaveCount(1);

        // The window opens before the engine is injected and closes after both
        // engines ran, so injection, axe and IBM are all inside it.
        const requests = watchRequests(context, page);
        await injectEngines(page);
        const axeStart = Date.now();
        const axe = await runAxe(page);
        const axeMs = Date.now() - axeStart;
        const ibm = await runIbm(page);
        const during = requests.stop();

        // `data:` and `blob:` URLs never leave the page, so only network schemes count.
        const own = new URL(E2E_BASE_URL).origin;
        expect(
          during.filter((url) => {
            const u = new URL(url);
            return /^(https?|wss?):$/.test(u.protocol) && u.origin !== own;
          }),
          'requests or sockets to another host while the engines ran',
        ).toEqual([]);
        expect(ibm.rulesRun, 'rules the IBM engine ran').toBeGreaterThan(0);

        const record: IbmSurfaceRecord = {
          surfaceId: surface.id,
          route: surface.route,
          engine: { version: IBM_ENGINE_VERSION, ruleset: IBM_RULESET },
          rulesRun: ibm.rulesRun,
          scanMs: ibm.scanMs,
          axeMs,
          axeNodes: axe.length,
          findings: ibm.findings.map((f) => ({ ...f, axe: matchAxe(f, axe) })),
        };
        test.info().annotations.push({
          type: IBM_ANNOTATION,
          description: JSON.stringify(record),
        });
        if (during.length > 0) {
          test.info().annotations.push({
            type: 'ibm requests during the scan window',
            description: during.join(', '),
          });
        }
      },
    );
  }
});
