/**
 * AECI-1880: shared steps for the announcement specs (`announcements-*.spec.ts`).
 *
 * Every flow here submits or changes something. None may reach a real service:
 * `.dev.vars` holds live Supabase and Resend keys. So every test calls
 * `blockWrites` first. It aborts every request that is not a read (`guardWrites`),
 * then the test adds a stub for the one write it means to answer. A route added
 * later runs first, so the stub answers and anything else is aborted. No write
 * reaches the network, the local API included.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { untilAppStable } from '../../e2e/hydration';
import { browserOf, expected } from './browser-expectations';
import { guardWrites } from './page-guards';
import { keyForLocator } from './probe';
import { tabTo } from './tab-walk';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * AECI-1885: activate a control the way this browser's users do. Every flow the
 * record judges activates through it, after `recordAnnouncements`.
 *
 * Where a click focuses a button (`pointerFocusesButtons`), it is the click the
 * flow always used. In WebKit a click does not focus a button: focus goes to the
 * nearest focusable ancestor, `main`. The record then hears all of `main`, and
 * whether that includes the new message depends on timing. A check of where
 * focus returns would judge `main` too. So in WebKit the control is reached by
 * real Tab presses and activated by Enter, as a keyboard or screen-reader user
 * does. The Tab presses are in the record on purpose: what a field announces
 * when Tab leaves it is what that user hears (AECI-2079). No `el.focus()`.
 * `keyboard: true` takes the keyboard path in any browser, for a flow whose
 * pointer path is judged by its own test (AECI-2196).
 */
export async function activate(
  page: Page,
  control: Locator,
  options: { readonly keyboard?: boolean } = {},
): Promise<void> {
  if (!options.keyboard && expected('pointerFocusesButtons', browserOf(page))) {
    return control.click();
  }
  const reached = await tabTo(page, await keyForLocator(page, control));
  expect(reached, 'Tab reaches the control before it is pressed').not.toBeNull();
  await page.keyboard.press('Enter');
}

/**
 * Abort every write, from this page and any tab or window its context opens
 * (`guardWrites`), and keep a list of what was aborted for failure messages.
 * Call before any stub.
 */
export async function blockWrites(page: Page): Promise<{ aborted: string[] }> {
  const aborted: string[] = [];
  page.context().on('requestfailed', (req) => {
    if (!READS.has(req.method())) aborted.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });
  await guardWrites(page);
  return { aborted };
}

/**
 * Answer one write with a canned response and count the calls. `match` is a
 * Playwright URL glob. Reads to the same URL pass on.
 */
export async function stubWrite(
  page: Page,
  match: string,
  respond: { status: number; json?: unknown },
): Promise<{ calls: number }> {
  const counter = { calls: 0 };
  await page.route(match, async (route) => {
    if (READS.has(route.request().method())) return route.fallback();
    counter.calls++;
    await route.fulfill({
      status: respond.status,
      contentType: 'application/json',
      body: JSON.stringify(respond.json ?? {}),
    });
  });
  return counter;
}

/**
 * Load a page that is not a manifest surface and wait for the hydration gate.
 * The flows that use it run on pages outside `docs/a11y-manual-testing-checklist.md`
 * §1 (the subscribe page, the claim confirm page, search, the vendor portal
 * preview). Adding them to `surfaces.ts` would widen the manual pass and the
 * keyboard suite, so they stay here, named by the flow that needs them.
 */
export async function openFlowPage(page: Page, route: string): Promise<void> {
  const res = await page.goto(route);
  expect(res?.status(), `GET ${route}`).toBe(200);
  await untilAppStable(page, 30_000);
}

/** Annotations for a flow on a page outside the manifest. */
export function flowAnnotations(flowId: string, route: string) {
  return {
    annotation: [
      { type: 'surface', description: flowId },
      { type: 'route', description: route },
    ],
  };
}

/**
 * The form-error wiring of WCAG 3.3.1 for one failing field: `aria-invalid="true"`,
 * and an `aria-describedby` that names a visible element carrying the error.
 * Returns the error's text.
 */
export async function expectFieldErrorWired(field: Locator, error: RegExp): Promise<string> {
  await expect(field, 'the failing field is aria-invalid').toHaveAttribute('aria-invalid', 'true');
  const ids = ((await field.getAttribute('aria-describedby')) ?? '').split(/\s+/).filter(Boolean);
  expect(ids.length, 'the failing field has an aria-describedby').toBeGreaterThan(0);
  const page = field.page();
  const texts: string[] = [];
  for (const id of ids) {
    const el = page.locator(`[id="${id}"]`);
    if ((await el.count()) === 1 && (await el.isVisible()))
      texts.push((await el.innerText()).trim());
  }
  const text = texts.find((t) => error.test(t));
  expect(
    text,
    `aria-describedby names a visible error matching ${error}. Got: ${JSON.stringify(texts)}`,
  ).toBeTruthy();
  return text!;
}
