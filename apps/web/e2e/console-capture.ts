/**
 * AECI-162 — shared console-health capture for Phase 2 e2e specs.
 *
 * Phase 2 Spec §15.15 gates completion on "No new console warnings or errors on
 * any page type." This is the single source of truth for that policy, so the
 * crawler and the per-page specs that close its coverage gaps (`not-found`,
 * `/vendors`, `/integrations` — types the crawler can't BFS-reach) all enforce
 * the SAME rule and share ONE allowlist.
 *
 * Policy (matches the homepage smoke posture, `smoke.spec.ts` AECI-36 AC #6):
 *   - console `error` messages + uncaught `pageerror` events FAIL the test;
 *   - console `warning` messages are COLLECTED and REPORTED (logged + counted)
 *     but DO NOT fail — smoke gates errors only, and gating warnings across every
 *     page type would turn pre-existing benign framework/3rd-party warnings into
 *     spurious red CI (the exact risk that deferred this work out of AECI-67).
 *     The collection infra means flipping warnings to a hard gate later is a
 *     one-line change once the warning baseline is zero.
 */
import { expect, type Page } from '@playwright/test';

/**
 * Allowlist hook for genuinely-benign console output. Returns `false` today —
 * matching smoke's no-allowlist posture. On local `dev:bound` there is no
 * analytics/Datadog/Cloudflare-beacon injection (PostHog `PageViewTracker` fires
 * only on in-app navigations, never on the full-document `page.goto()` loads these
 * specs perform; Datadog RUM / CF-beacon injection is deployment-token-gated in
 * `server-runtime.ts` and absent locally), so a clean local run needs no entries.
 * The concrete future consumer is the deployed-preview job, which DOES inject
 * beacons. Add an entry ONLY for provably-benign noise, each with an inline reason
 * — mirroring the `EXPECTED_PENDING_PREFIXES` discipline in
 * `internal-link-graph.spec.ts`.
 */
export function isIgnorableConsole(text: string): boolean {
  void text;
  return false;
}

export interface ConsoleCapture {
  errors: string[];
  warnings: string[];
  pageErrors: string[];
}

/**
 * Attach `console` + `pageerror` listeners to a page and collect into live arrays.
 * For single-page specs (one URL per test). The crawler keeps its own per-path
 * listener because it reuses one `page` across a whole BFS, but imports
 * `isIgnorableConsole` from here so the allowlist stays single-source.
 */
export function attachConsoleCapture(page: Page): ConsoleCapture {
  const capture: ConsoleCapture = { errors: [], warnings: [], pageErrors: [] };
  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = msg.text();
    if (isIgnorableConsole(text)) return;
    (type === 'error' ? capture.errors : capture.warnings).push(text);
  });
  page.on('pageerror', (err) => {
    if (isIgnorableConsole(err.message)) return;
    capture.pageErrors.push(err.message);
  });
  return capture;
}

/**
 * Wait for a page to finish hydrating before reading captured console output.
 * Index/browse pages render their rows client-side from a non-blocking
 * `httpResource` (AECI-126): the SSR shell ships `aria-busy="true"` rows that are
 * replaced ~1s after hydration fetches `/api/*`, so a console error thrown by a
 * rejected resource fires AFTER load. A flat `waitForTimeout` (smoke's 200ms,
 * tuned for the static home page) would miss it. So we wait for load, then poll
 * until no `aria-busy` remains and that stays stable. SSR-complete pages (detail,
 * 404 shell, browse-via-resolver) have no `aria-busy` and settle in ~2 polls.
 * Caps at ~400ms + 30×300ms ≈ 9.5s for a page whose data never arrives.
 */
export async function waitForHydrationSettle(page: Page): Promise<void> {
  await page.waitForLoadState('load').catch(() => undefined);
  await page.waitForTimeout(400);
  let stable = 0;
  for (let i = 0; i < 30; i++) {
    const busy = await page.locator('[aria-busy="true"]').count();
    if (busy === 0) {
      if (++stable >= 2) break;
    } else {
      stable = 0;
    }
    await page.waitForTimeout(300);
  }
}

/**
 * Assert a captured page is console-clean: fail on errors + uncaught page errors
 * (surfacing each message), report warnings without failing. `label` names the
 * page in the failure/log output.
 *
 * `opts.ignore` drops messages that are inherent to the page under test rather
 * than app defects — e.g. on a deliberately-404 page the browser logs a
 * "Failed to load resource: ...404" for the main document. Keep such predicates
 * narrow and local (do NOT push them into the global `isIgnorableConsole`, which
 * would also hide a genuine sub-resource 404 on a 200 page).
 */
export function expectConsoleClean(
  capture: ConsoleCapture,
  label: string,
  opts?: { ignore?: (text: string) => boolean },
): void {
  const ignore = opts?.ignore ?? (() => false);
  const errors = capture.errors.filter((e) => !ignore(e));
  const warnings = capture.warnings.filter((w) => !ignore(w));
  const pageErrors = capture.pageErrors.filter((e) => !ignore(e));
  if (warnings.length > 0) {
    // Reported, not gated (see file header). `console.log` is the established
    // surfacing channel in these specs (cf. internal-link-graph.spec.ts).
    console.log(
      `[console-capture] ${label}: ${warnings.length} console warning(s) (reported, not gated):\n` +
        warnings.map((w) => `  ${w}`).join('\n'),
    );
  }
  expect(
    pageErrors,
    `${label}: uncaught page errors:\n${pageErrors.map((e) => `  ${e}`).join('\n')}`,
  ).toEqual([]);
  expect(errors, `${label}: console errors:\n${errors.map((e) => `  ${e}`).join('\n')}`).toEqual(
    [],
  );
}
