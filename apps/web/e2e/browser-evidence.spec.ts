/**
 * AECI-1714 — the browser report on the local tier (`BROWSER_EVIDENCE_ENABLED` is
 * `"true"` in the top-level `wrangler.jsonc` block).
 *
 * `wrangler dev` sends no inbound `cf-ray`, so the gateway would stamp no
 * `Server-Timing: cfray` and the tracker would post nothing (`docs/local-dev.md`
 * §4.4). The test supplies the header itself. The gateway stamps that ray, and the
 * API stores it on the arrival row as `cf_ray`, which is exactly what Cloudflare
 * does with a real one.
 *
 * It then reads the row back from the local API Worker's D1 through wrangler's Local
 * Explorer API (`/cdn-cgi/local/explorer/api/d1/database/{id}/raw`), so it checks the
 * whole loop: the browser's gate, both posts, and the API's UPDATE.
 *
 * Local only. A deployed tier has a real ray and no Local Explorer, so the file
 * skips when `PLAYWRIGHT_BASE_URL` is set. It also skips when the gateway stamped
 * `geo;desc="eu"`, because `wrangler dev` fills `request.cf` from the machine's real
 * location and a held region rightly sends nothing.
 */
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from '@playwright/test';

import { E2E_BASE_URL, E2E_WEB_PORT } from './base-url';

/** The local API Worker's port. `dev:agent` and `dev:bound` pair it one below the web port. */
const API_PORT = process.env['AECI_API_PORT'] ?? String(Number(E2E_WEB_PORT) - 1);
const EXPLORER = `http://localhost:${API_PORT}/cdn-cgi/local/explorer/api/d1/database`;

/** A fresh Ray ID in Cloudflare's shape, so the row this run writes is its own. */
function freshRay(): string {
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join(
    '',
  );
  return `${hex}-DEV`;
}

async function databaseId(api: APIRequestContext): Promise<string> {
  const res = await api.get(EXPLORER);
  expect(res.ok(), 'the local API exposes its D1 through the Local Explorer').toBe(true);
  const body = (await res.json()) as { result: { name: string; uuid: string }[] };
  const db = body.result.find((d) => d.name === 'DB');
  expect(db, 'the API Worker binds D1 as DB').toBeTruthy();
  return db!.uuid;
}

async function evidenceFor(
  api: APIRequestContext,
  dbId: string,
  ray: string,
): Promise<string | null | undefined> {
  const res = await api.post(`${EXPLORER}/${dbId}/raw`, {
    data: {
      sql: "SELECT browser_evidence FROM page_views WHERE cf_ray = ? AND writer_provenance = 'ssr-arrival'",
      params: [ray],
    },
  });
  const body = (await res.json()) as {
    result: { results: { rows: (string | null)[][] } }[];
  };
  const rows = body.result[0]?.results.rows ?? [];
  return rows.length === 0 ? undefined : rows[0][0];
}

test.describe('browser report (AECI-1714)', () => {
  test.skip(!!process.env['PLAYWRIGHT_BASE_URL'], 'local tier only: needs the Local Explorer');

  test('a landing view posts ran, then interacted after a click, onto its arrival row', async ({
    browser,
  }) => {
    const ray = freshRay();
    // A user agent unique to this run. The API drops a second arrival for the same
    // page, user agent and network inside 10–20 s, so a re-run or an earlier spec on
    // the same page would otherwise leave this load with no row to update.
    const probeContext = await browser.newContext();
    const defaultUa = await (await probeContext.newPage()).evaluate(() => navigator.userAgent);
    await probeContext.close();
    const context = await browser.newContext({
      baseURL: E2E_BASE_URL,
      userAgent: `${defaultUa} aeci-e2e/${ray}`,
      extraHTTPHeaders: { 'cf-ray': ray },
    });
    const page = await context.newPage();

    const api = await playwrightRequest.newContext();
    const dbId = await databaseId(api);

    // A product page when the fixture is seeded, else the index: both are cacheable,
    // so the gateway writes an arrival row for either. The probe is a HEAD, which
    // writes no row.
    const probe = await api.head(`http://localhost:${E2E_WEB_PORT}/products/fixture-procore`);
    const path = probe.status() === 200 ? '/products/fixture-procore' : '/products';

    const ranPost = page.waitForRequest(
      (req) =>
        req.url().endsWith('/api/page-views/browser-evidence') &&
        req.postDataJSON()?.evidence === 'ran',
    );
    await page.goto(path);

    const held = await page.evaluate(() =>
      (
        performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      )?.serverTiming?.some((t) => t.name === 'geo' && t.description === 'eu'),
    );
    test.skip(held === true, 'this machine is in a held region: the report is rightly not sent');

    const ran = await ranPost;
    expect(ran.postDataJSON()).toEqual({ cf_ray: ray, evidence: 'ran' });
    expect((await ran.response())?.status()).toBe(204);
    await expect.poll(() => evidenceFor(api, dbId, ray), { timeout: 15_000 }).toBe('ran');

    const interactedPost = page.waitForRequest(
      (req) =>
        req.url().endsWith('/api/page-views/browser-evidence') &&
        req.postDataJSON()?.evidence === 'interacted',
    );
    await page.locator('h1').first().click();
    const interacted = await interactedPost;
    expect(interacted.postDataJSON()).toEqual({ cf_ray: ray, evidence: 'interacted' });
    await expect.poll(() => evidenceFor(api, dbId, ray), { timeout: 15_000 }).toBe('interacted');

    // Once per page load: a second interaction posts nothing more.
    let extra = 0;
    page.on('request', (req) => {
      if (req.url().endsWith('/api/page-views/browser-evidence')) extra += 1;
    });
    await page.locator('h1').first().click();
    await page.keyboard.press('Shift');
    await page.waitForTimeout(500);
    expect(extra).toBe(0);

    // Nothing was written to the browser's storage.
    const stored = await page.evaluate(() => ({
      local: Object.keys(localStorage).filter((k) => /evidence/i.test(k)),
      session: Object.keys(sessionStorage).filter((k) => /evidence/i.test(k)),
    }));
    expect(stored).toEqual({ local: [], session: [] });

    await api.dispose();
    await context.close();
  });
});
