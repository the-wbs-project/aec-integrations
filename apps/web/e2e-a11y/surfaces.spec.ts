/**
 * AECI-1875: the placeholder check for every surface in the manifest.
 *
 * It proves the harness can reach each surface: the route answers the expected
 * status and renders one visible `h1`. It runs no accessibility rule. The
 * AECI-1874 sub-issues add those as their own specs over `SURFACES`.
 *
 * Skips are green, as in the PR suite:
 *   - A signed-in surface skips when its persona's session cannot be minted
 *     (Supabase env unset, or sign-in failed). Same posture as `authed-console.spec.ts`.
 *   - A `phase2` surface skips when the fixture product is absent from the D1 the
 *     app reads. Same probe as `phase2-a11y.spec.ts`.
 */
import { expect, request as playwrightRequest, test } from '@playwright/test';
import { authEnvMissing, mintSessionCookies, type SessionPersona } from '../e2e/auth-session';
import { E2E_BASE_URL as BASE_URL } from '../e2e/base-url';
import { FIXTURE, SURFACES, personaCredentials } from './surfaces';

type Cookies = NonNullable<Awaited<ReturnType<typeof mintSessionCookies>>>;

/** One session per test account, minted on first use. */
const sessions = new Map<SessionPersona, Promise<Cookies | null>>();

function sessionFor(account: SessionPersona): Promise<Cookies | null> {
  let pending = sessions.get(account);
  if (!pending) {
    pending = mintSessionCookies(BASE_URL, account);
    sessions.set(account, pending);
  }
  return pending;
}

let fixturesPresent = false;

test.beforeAll(async () => {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const res = await ctx.get(`/products/${FIXTURE.productSlug}`, { maxRedirects: 0 });
    fixturesPresent = res.status() === 200;
    if (!fixturesPresent) {
      console.warn(
        `[a11y-nightly] Fixtures absent: GET /products/${FIXTURE.productSlug} -> ${res.status()}. ` +
          'Surfaces that need phase2 fixtures will be SKIPPED. `dev:bound` seeds them.',
      );
    }
  } finally {
    await ctx.dispose();
  }
});

test.describe('a11y nightly: every surface is reachable', () => {
  for (const surface of SURFACES) {
    test(
      `${surface.name} (${surface.route})`,
      {
        annotation: [
          { type: 'surface', description: surface.id },
          { type: 'route', description: surface.route },
        ],
      },
      async ({ context, page }) => {
        test.skip(
          surface.fixture === 'phase2' && !fixturesPresent,
          'phase2 fixtures not seeded, see the beforeAll warning',
        );

        const account = personaCredentials(surface.persona);
        if (account) {
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

        const res = await page.goto(surface.route);
        expect(res?.status(), `GET ${surface.route}`).toBe(surface.expectStatus);
        await expect(page.locator('h1').filter({ visible: true })).toHaveCount(1);
      },
    );
  }
});
