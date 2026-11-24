/**
 * AECI-1875: the placeholder check for every surface in the manifest.
 *
 * It proves the harness can reach each surface: the route answers the expected
 * status and renders one visible `h1`. It runs no accessibility rule. The
 * AECI-1874 sub-issues add those as their own specs over `SURFACES`.
 *
 * Skips are green, as in the PR suite. The session and fixture skips live in
 * `support/surface-page.ts` (`prepareSurface`), shared with every nightly spec.
 */
import { expect, test } from '@playwright/test';
import { SURFACES } from './surfaces';
import { phase2FixturesPresent, prepareSurface, surfaceAnnotations } from './support/surface-page';

let fixturesPresent = false;

test.beforeAll(async () => {
  // A cold product page can take a while to render on a busy runner.
  test.setTimeout(120_000);
  fixturesPresent = await phase2FixturesPresent();
});

test.describe('a11y nightly: every surface is reachable', () => {
  for (const surface of SURFACES) {
    test(
      `${surface.name} (${surface.route})`,
      surfaceAnnotations(surface),
      async ({ context, page }) => {
        await prepareSurface(context, surface, fixturesPresent);
        const res = await page.goto(surface.route);
        expect(res?.status(), `GET ${surface.route}`).toBe(surface.expectStatus);
        await expect(page.locator('h1').filter({ visible: true })).toHaveCount(1);
      },
    );
  }
});
