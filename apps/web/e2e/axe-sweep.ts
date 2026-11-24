/**
 * AECI-1876: the axe sweep. With `AECI_E2E_AXE=1`, every e2e test that uses the
 * `page` fixture ends with an axe scan of whatever state the test left the page in.
 * The fixture that calls it is `./fixtures.ts`. Every spec imports `test` from
 * there, and `scripts/e2e-axe-sweep.test.mjs` fails a spec that does not.
 *
 * Off (the default, and the PR e2e job), nothing here runs.
 *
 * On (the accessibility nightly, `playwright.e2e-axe.config.ts`):
 *   1. Gate. Any violation of a rule tagged `wcag2a`, `wcag2aa`, `wcag21a` or
 *      `wcag21aa` fails the test. That is the PR suite's threshold.
 *   2. Report. Rules tagged only `wcag22aa`, `best-practice` or `experimental`
 *      never fail. Their findings go to the run summary, grouped by rule.
 *   3. Hydration. An NG0500 or NG0602 logged during the test voids the scan and
 *      fails the test. A scan of a page that hydrated wrong measures nothing.
 *   4. Known failures. A gate violation listed in `./axe-known-failures.ts` for
 *      its page passes, and a listed one that stopped failing turns the test red.
 *
 * Only `./fixtures.ts` calls the sweep. A spec opts a test out with `axeOptOut(reason)`.
 *
 * One axe run per test covers both lists: the rules are split by tag after the
 * run. An `experimental` rule is never gated, even when it also carries a WCAG
 * tag, because the PR suite's tag list never turns experimental rules on.
 *
 * `docs/TESTING_STRATEGY.md` §8.2 and §8.3 describe the sweep.
 */
import AxeBuilder from '@axe-core/playwright';
import { test, type Browser, type Page, type TestInfo } from '@playwright/test';

import {
  AXE_OPT_OUT_ANNOTATION,
  AXE_SCAN_ANNOTATION,
  GATE_TAGS,
  REPORT_TAGS,
  applyKnownFailures,
  isHydrationError,
  partitionViolations,
  type AxeFinding,
  type AxeScanRecord,
} from './axe-summary';
import { AXE_KNOWN_FAILURES } from './axe-known-failures';
import { untilAppStable } from './hydration';
import { KNOWN_FAILURE_ANNOTATION } from '../e2e-a11y/known-failure';

export { axeSweepEnabled } from './axe-summary';

/**
 * DOM that is not ours to judge. Excluded from both lists.
 * Each entry says why, as the existing scans do.
 */
export const EXCLUDED_DOM: ReadonlyArray<{ readonly selector: string; readonly why: string }> = [
  {
    selector: '[aria-label="Concept switcher (dev only)"]',
    why: 'Preview-only design switcher. Never rendered on a public tier.',
  },
  {
    selector: 'iframe[src*="challenges.cloudflare.com"]',
    why: 'Cloudflare Turnstile. Third-party DOM.',
  },
  {
    selector: '[id="1p-menu-live-region"], com-1password-button, com-1password-menu',
    why: '1Password extension DOM. ACCESSIBILITY_AUDIT.md §2.',
  },
];

/**
 * Opt this test out of the sweep. Call it in the test body or a `beforeEach`.
 * The reason is required and shows in the run summary. Every call is listed in
 * `scripts/e2e-axe-sweep.test.mjs`, so the count stays visible.
 */
export function axeOptOut(reason: string): void {
  if (reason.trim() === '') throw new Error('axeOptOut needs a reason.');
  test.info().annotations.push({ type: AXE_OPT_OUT_ANNOTATION, description: reason });
}

/** Collect hydration errors from the page for the length of a test. */
export function watchHydrationErrors(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (isHydrationError(text)) seen.push(text);
  });
  page.on('pageerror', (err) => {
    if (isHydrationError(err.message)) seen.push(err.message);
  });
  return seen;
}

function record(testInfo: TestInfo, scan: AxeScanRecord): void {
  testInfo.annotations.push({ type: AXE_SCAN_ANNOTATION, description: JSON.stringify(scan) });
}

function notScanned(testInfo: TestInfo, reason: string, url?: string): void {
  record(testInfo, { status: 'not-scanned', reason, url, gate: [], report: [] });
}

/** Why a test that never reached the sweep was not scanned. */
export const OWN_CONTEXT_REASON =
  'the test opened its own browser context, and the sweep scans only the page fixture';
export const NO_PAGE_REASON = 'the test never asks for the page fixture';

/**
 * Count the browser contexts a test opens itself (`browser.newContext()`,
 * `browser.newPage()`) while it runs. Call `restore()` in teardown.
 *
 * Those pages are not scanned. Most such tests close the context in their own
 * body, and many set up a state the sweep cannot judge: JavaScript off, forced
 * colours, a held stylesheet. Counting them keeps them visible in the summary.
 */
export function trackOwnContexts(browser: Browser): { count: () => number; restore: () => void } {
  let opened = 0;
  const newContext = browser.newContext;
  const newPage = browser.newPage;
  // Playwright's own `context` fixture calls `browser.newContext()` too. Count
  // only the calls made from test code, which runs from `apps/web/e2e/`.
  const fromTestCode = (): boolean => /[\\/]e2e[\\/]/.test(new Error().stack ?? '');
  browser.newContext = (...args) => {
    if (fromTestCode()) opened += 1;
    return newContext.apply(browser, args);
  };
  browser.newPage = (...args) => {
    if (fromTestCode()) opened += 1;
    return newPage.apply(browser, args);
  };
  return {
    count: () => opened,
    restore: () => {
      browser.newContext = newContext;
      browser.newPage = newPage;
    },
  };
}

/**
 * For a test the sweep never reached: record it as not scanned, with the reason.
 * Every test in the lane then carries an `axe-scan` record and is counted.
 */
export function recordUnreached(testInfo: TestInfo, ownContexts: number): void {
  if (testInfo.annotations.some((a) => a.type === AXE_SCAN_ANNOTATION)) return;
  notScanned(testInfo, ownContexts > 0 ? OWN_CONTEXT_REASON : NO_PAGE_REASON);
}

/** `target-size` on the product-detail integrations section is gated by its own spec (AECI-1079). */
async function dropGatedTargetSize(page: Page, report: AxeFinding[]): Promise<AxeFinding[]> {
  const path = new URL(page.url()).pathname;
  if (!/^\/products\/[^/]+\/?$/.test(path)) return report;
  const out: AxeFinding[] = [];
  for (const f of report) {
    if (f.id !== 'target-size') {
      out.push(f);
      continue;
    }
    const outside = await page.evaluate(
      (targets) =>
        targets.filter((sel) => {
          try {
            return !document.querySelector(sel)?.closest('#integrations');
          } catch {
            return true;
          }
        }),
      [...f.targets],
    );
    // Only the first few targets are kept, so judge the finding by them.
    if (outside.length > 0) out.push({ ...f, targets: outside });
  }
  return out;
}

async function analyze(page: Page) {
  const builder = (): AxeBuilder => {
    let b = new AxeBuilder({ page }).withTags([...GATE_TAGS, ...REPORT_TAGS]);
    for (const { selector } of EXCLUDED_DOM) b = b.exclude(selector);
    return b;
  };
  try {
    return await builder().analyze();
  } catch {
    // The test may have left a navigation in flight. Let it land and try once more.
    await page.waitForLoadState('load', { timeout: LOAD_WAIT_MS }).catch(() => undefined);
    return builder().analyze();
  }
}

function describeGate(gate: readonly AxeFinding[]): string {
  return gate
    .map(
      (f) =>
        `  ${f.id} (${f.impact ?? 'no impact'}): ${f.help}. ${f.nodes} node(s): ${f.targets.join(', ')}` +
        (f.summary ? `\n    ${f.summary}` : ''),
    )
    .join('\n');
}

/** Bounded waits, so a page that never settles costs seconds, not the test's budget. */
const LOAD_WAIT_MS = 10_000;
const ANIMATION_WAIT_MS = 5_000;
const BUSY_POLLS = 30;
const BUSY_POLL_MS = 300;

/**
 * Let finite animations and transitions finish. A scan mid-fade reads a
 * part-transparent colour and reports a contrast failure no reader sees
 * (TESTING_STRATEGY §14.3 (a), AECI-1922). Infinite animations (spinners) are left alone.
 */
async function animationsSettled(page: Page): Promise<void> {
  await page
    .evaluate(async (cap) => {
      const deadline = Date.now() + cap;
      const running = () =>
        document
          .getAnimations()
          .filter(
            (a) =>
              a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity,
          );
      // One finished transition can start another (a scroll spy moving
      // `aria-current`), so look again after each round.
      while (running().length > 0 && Date.now() < deadline) {
        await Promise.race([
          Promise.all(running().map((a) => a.finished.catch(() => undefined))),
          new Promise((resolve) => setTimeout(resolve, deadline - Date.now())),
        ]);
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      }
    }, ANIMATION_WAIT_MS)
    .catch(() => undefined);
}

/**
 * Wait until no `aria-busy="true"` region is left, on two samples apart in time,
 * as `waitForHydrationSettle` does. A client navigation fetches its data after
 * the app is stable, so the stability gate alone can scan the loading text.
 * A page that stays busy is scanned as it is.
 */
async function busyRegionsSettled(page: Page): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < BUSY_POLLS && quiet < 2; i++) {
    const busy = await page
      .locator('[aria-busy="true"]')
      .count()
      .catch(() => 0);
    quiet = busy === 0 ? quiet + 1 : 0;
    // A fixed interval on purpose: the two quiet samples need a gap between them.
    if (quiet < 2) await page.waitForTimeout(BUSY_POLL_MS);
  }
}

export interface SweepContext {
  /** The test's `javaScriptEnabled` option. Off, the page never hydrates. */
  readonly javaScriptEnabled: boolean;
  readonly hydrationErrors: readonly string[];
}

/**
 * The end-of-test sweep. Throws when the gate finds a violation or the test
 * logged a hydration error. Records what it did in the `axe-scan` annotation.
 */
export async function sweepAfterTest(
  page: Page,
  testInfo: TestInfo,
  ctx: SweepContext,
): Promise<void> {
  const optOut = testInfo.annotations.find((a) => a.type === AXE_OPT_OUT_ANNOTATION);
  if (optOut) {
    record(testInfo, { status: 'opted-out', reason: optOut.description, gate: [], report: [] });
    return;
  }
  // A failed or skipped test already has its answer. A scan of a broken state is noise.
  if (testInfo.status !== testInfo.expectedStatus || testInfo.status === 'skipped') {
    notScanned(testInfo, `the test ended ${testInfo.status ?? 'unknown'}`);
    return;
  }
  if (page.isClosed()) {
    notScanned(testInfo, 'the page was closed');
    return;
  }
  await page.waitForLoadState('load', { timeout: LOAD_WAIT_MS }).catch(() => undefined);
  const url = page.url();
  if (!/^https?:/.test(url)) {
    notScanned(testInfo, 'the page never loaded a document', url);
    return;
  }
  const isHtml = await page
    .evaluate(() => document.contentType === 'text/html' && !!document.body)
    .catch(() => false);
  if (!isHtml) {
    notScanned(testInfo, 'the page is not an HTML document', url);
    return;
  }
  // axe runs as a script in the page, so it cannot run with JavaScript off.
  if (!ctx.javaScriptEnabled) {
    notScanned(testInfo, 'JavaScript is off, so axe cannot run in the page', url);
    return;
  }
  // Gate on hydration (TESTING_STRATEGY §14.3 (a)). Every app page has the site
  // header, and its home link's `jsaction` goes when the app is stable.
  if ((await page.locator('aec-site-header a[href="/"]').count()) > 0) {
    await untilAppStable(page);
  }
  if (ctx.hydrationErrors.length > 0) {
    notScanned(testInfo, 'a hydration error voided the scan', url);
    throw new Error(
      `axe sweep: hydration error during the test, so the scan is void (${url}):\n` +
        ctx.hydrationErrors.map((e) => `  ${e.split('\n')[0]}`).join('\n'),
    );
  }
  await busyRegionsSettled(page);
  await animationsSettled(page);
  // Forced colours is a reader's setting, not a page state, and the contrast
  // rule does not apply under it. A test that emulated it gets the default
  // back before the scan. Every other emulated setting stays.
  await page.emulateMedia({ forcedColors: 'none' });
  const results = await analyze(page);
  const { gate: allGate, report } = partitionViolations(results.violations);
  const kept = await dropGatedTargetSize(page, report);
  const path = new URL(url).pathname;
  const { failing, known, stale } = applyKnownFailures(path, allGate, AXE_KNOWN_FAILURES);
  record(testInfo, { status: 'scanned', url, gate: failing, report: kept, known });
  for (const issue of new Set(known.map((k) => k.issue))) {
    testInfo.annotations.push({ type: KNOWN_FAILURE_ANNOTATION, description: issue });
  }
  const problems: string[] = [];
  if (failing.length > 0) {
    problems.push(
      `axe sweep: ${failing.length} WCAG A/AA rule(s) fail on the state this test ended in (${url}):\n` +
        describeGate(failing),
    );
  }
  for (const e of stale) {
    problems.push(
      `axe sweep: ${e.issue} no longer fails as listed: ${e.rule} on ${e.path}` +
        (e.targets ? ` (targets ${e.targets.join(', ')})` : '') +
        ' passed in part or in full. Drop the fixed targets from its entry in ' +
        'e2e/axe-known-failures.ts, or delete the entry and close the issue.',
    );
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
}
