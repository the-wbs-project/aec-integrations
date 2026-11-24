/**
 * AECI-1877: open a manifest surface, signed in as its persona, and wait for hydration.
 *
 * The session-mint-and-skip pattern from AECI-1875's `surfaces.spec.ts`, moved here
 * so every nightly spec shares it:
 *   - A signed-in surface skips when its persona's session cannot be minted
 *     (Supabase env unset, or sign-in failed). The skip reason names which.
 *   - A `phase2` surface skips when the fixture product is absent from the D1 the
 *     app reads.
 * Skips are green. A run that skipped the signed-in surfaces proved nothing about
 * them, so read the skip count in the report.
 */
import {
  expect,
  request as playwrightRequest,
  test,
  type BrowserContext,
  type Page,
  type Response,
} from '@playwright/test';
import { authEnvMissing, mintSessionCookies, type SessionPersona } from '../../e2e/auth-session';
import { E2E_BASE_URL } from '../../e2e/base-url';
import { untilAppStable } from '../../e2e/hydration';
import { FIXTURE, personaCredentials, type A11ySurface } from '../surfaces';

type Cookies = NonNullable<Awaited<ReturnType<typeof mintSessionCookies>>>;

/** One session per test account per worker, minted on first use. */
const sessions = new Map<SessionPersona, Promise<Cookies | null>>();

export function sessionFor(account: SessionPersona): Promise<Cookies | null> {
  let pending = sessions.get(account);
  if (!pending) {
    pending = mintSessionCookies(E2E_BASE_URL, account);
    sessions.set(account, pending);
  }
  return pending;
}

/**
 * Is the `phase2` fixture seeded in the D1 the app reads? Call once per file in
 * `beforeAll` and pass the answer to `prepareSurface`.
 */
export async function phase2FixturesPresent(): Promise<boolean> {
  const ctx = await playwrightRequest.newContext({ baseURL: E2E_BASE_URL });
  try {
    const res = await ctx.get(`/products/${FIXTURE.productSlug}`, { maxRedirects: 0 });
    if (res.status() !== 200) {
      console.warn(
        `[a11y-nightly] Fixtures absent: GET /products/${FIXTURE.productSlug} -> ${res.status()}. ` +
          'Surfaces that need phase2 fixtures will be SKIPPED. `dev:bound` seeds them.',
      );
    }
    return res.status() === 200;
  } finally {
    await ctx.dispose();
  }
}

/** The `surface` and `route` annotations the summary reporter reads. */
export function surfaceAnnotations(surface: A11ySurface) {
  return {
    annotation: [
      { type: 'surface', description: surface.id },
      { type: 'route', description: surface.route },
    ],
  };
}

/**
 * Skip the test unless the surface can be reached, then sign the context in as
 * the surface's persona. Call first in the test body.
 */
export async function prepareSurface(
  context: BrowserContext,
  surface: A11ySurface,
  fixturesPresent: boolean,
): Promise<void> {
  test.skip(
    surface.fixture === 'phase2' && !fixturesPresent,
    'phase2 fixtures not seeded, see the beforeAll warning',
  );
  const account = personaCredentials(surface.persona);
  if (!account) return;
  const cookies = await sessionFor(account);
  const missing = authEnvMissing(account);
  test.skip(
    !cookies,
    missing.length > 0
      ? `No ${surface.persona} session: ${missing.join(', ')} unset`
      : `No ${surface.persona} session: sign-in failed`,
  );
  await context.addCookies(cookies!);
}

/**
 * Load the surface, check its status, and wait until the app is stable after
 * hydration. Key presses before that point are dropped or replayed late
 * (`docs/TESTING_STRATEGY.md` §14.3), so every keyboard check starts here.
 *
 * `settle: true` also loads everything that renders on scroll (`settleLazyContent`),
 * so a Tab walk sees the same page on every run.
 */
export async function openSurface(
  page: Page,
  surface: A11ySurface,
  options: { readonly settle?: boolean } = {},
): Promise<Response | null> {
  const res = await page.goto(surface.route);
  expect(res?.status(), `GET ${surface.route}`).toBe(surface.expectStatus);
  // Longer than the PR suite's 15s: the nightly runs every surface on one worker.
  await untilAppStable(page, 30_000);
  // Some pages fetch after hydration, in `afterNextRender` (the account page's
  // own reviews), so stability alone can come before their rows. This is the
  // document's first load, so its network-idle state is a real signal (§14.3b).
  // A page that polls may never go idle: the wait then ends at its timeout.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  if (options.settle) await settleLazyContent(page);
  return res;
}

/**
 * Scroll to the bottom until the page stops growing, then back to the top.
 *
 * Listings load their next page when the footer scrolls into view, and `@defer
 * (on viewport)` blocks render as they scroll in. A Tab walk scrolls the page as
 * it goes, so without this the rows it meets depend on how fast each load
 * lands. Scrolling moves no focus and does not move the sequential focus
 * navigation starting point, so the walk still starts at the top of the document.
 */
export async function settleLazyContent(page: Page): Promise<void> {
  let lastHeight = -1;
  for (let round = 0; round < 12; round++) {
    const height = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      return document.documentElement.scrollHeight;
    });
    // A stability check samples over time and needs a gap between samples. The
    // next page of a listing has no signal of its own until it has rendered.
    await page.waitForTimeout(400);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 10_000 });
    const after = await page.evaluate(() => document.documentElement.scrollHeight);
    if (after === height && height === lastHeight) break;
    lastHeight = after;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await untilAppStable(page, 30_000);
}
