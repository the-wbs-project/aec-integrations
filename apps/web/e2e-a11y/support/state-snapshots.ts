/**
 * AECI-1879: before-and-after ARIA snapshots for every stateful control in a scope.
 *
 * The controls are found on the page, not listed by hand, so a new disclosure,
 * tab set, combobox or toggle is snapshotted the day it ships. Every flip is by
 * keyboard: real Tab presses bring focus to the control (`tabTo`), then a key
 * acts on it. A pointer is never used, because several triggers open on
 * `mouseenter` and a click then toggles them shut again (the admin nav row,
 * `layout/nav-disclosure.ts`, and the toxicity legend in the review queue).
 *
 *   disclosure  a button with `aria-expanded`. Enter, then Enter again.
 *   combobox    `role="combobox"`. A button opens on Enter. A text box opens on
 *               ArrowDown, or on a typed fixture query when ArrowDown shows nothing.
 *               Closed with Escape.
 *   toggle      a button with `aria-pressed`, or `role="switch"`. In a group of
 *               pressed buttons, each one not pressed gets Enter, and the one
 *               that was pressed gets Enter to restore.
 *   tab         `role="tab"` that is not selected. Enter, then the old tab gets Enter.
 *   details     a `<summary>`. Enter, then Enter again.
 *
 * A control whose state does not change, or that Tab cannot reach, is reported
 * as a problem, so the test cannot pass on a flip that never happened.
 *
 * Two kinds are left out on purpose. A link with `aria-expanded` (the header's
 * Browse link) navigates when activated. A trigger with `aria-haspopup="dialog"`
 * opens a modal that hides everything behind it. The keyboard suite's overlay
 * check covers both (`docs/TESTING_STRATEGY.md` §8.4.1).
 *
 * Every snapshot covers the control and, when the control names one with
 * `aria-controls`, the element it controls. So `aria-expanded`, `aria-selected`
 * and `aria-pressed` are pinned together with what they open.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { untilHydrated } from '../../e2e/hydration';
import { maskAriaSnapshot } from './aria-tree';
import { keyForLocator } from './probe';
import { tabTo } from './tab-walk';

export type StateKind = 'disclosure' | 'combobox' | 'toggle' | 'tab' | 'details';

/** A query the fixture catalog answers: every fixture product's name starts with it. */
const FIXTURE_QUERY = 'fixture';

const CONTROLS =
  ':is([aria-expanded], [aria-pressed], [role="tab"], [role="combobox"], [role="switch"], details > summary)' +
  ':not(a, [aria-haspopup="dialog"])';

interface ControlInfo {
  readonly kind: StateKind;
  readonly tag: string;
  /** For a toggle: is it pressed, and is it one of a group of pressed buttons? */
  readonly pressed: boolean;
  readonly grouped: boolean;
  readonly selected: boolean;
}

async function describeControl(control: Locator): Promise<ControlInfo> {
  return control.evaluate((el) => {
    const role = el.getAttribute('role');
    const tag = el.tagName.toLowerCase();
    let kind: StateKind;
    if (tag === 'summary') kind = 'details';
    else if (role === 'combobox') kind = 'combobox';
    else if (role === 'tab') kind = 'tab';
    else if (el.hasAttribute('aria-pressed') || role === 'switch') kind = 'toggle';
    else kind = 'disclosure';
    const parent = el.parentElement;
    const grouped = !!parent && parent.querySelectorAll(':scope > [aria-pressed]').length > 1;
    return {
      kind,
      tag,
      pressed:
        el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true',
      grouped,
      selected: el.getAttribute('aria-selected') === 'true',
    };
  });
}

/** The control, or its group or tab list, plus the element it controls when that is shown. */
async function snapshotOf(page: Page, control: Locator, kind: StateKind): Promise<string> {
  let own: Locator = control;
  if (kind === 'details') own = control.locator('xpath=..');
  if (kind === 'tab') own = control.locator('xpath=ancestor::*[@role="tablist"][1]');
  if (kind === 'toggle' && (await describeControl(control)).grouped)
    own = control.locator('xpath=..');
  const parts = [await own.ariaSnapshot()];
  const controls = kind === 'details' ? null : await control.getAttribute('aria-controls');
  if (controls) {
    const target = page.locator(`[id="${controls}"]`);
    if ((await target.count()) === 1 && (await target.isVisible())) {
      parts.push(`# controls #${controls.replace(/\d+/g, '<n>')}`, await target.ariaSnapshot());
    }
  }
  return maskAriaSnapshot(parts.join('\n'));
}

/**
 * The snapshot once it has stopped changing: two reads 500 ms apart that agree.
 *
 * There is no DOM signal to wait on instead. The search suggestions arrive from
 * a debounced query and set no `aria-busy`, and app stability (`untilAppStable`)
 * is only observable once, at hydration, through `jsaction`. So the read repeats
 * until it holds still, and fails with its own message if it never does.
 */
async function settledSnapshot(page: Page, control: Locator, kind: StateKind): Promise<string> {
  let last = await snapshotOf(page, control, kind);
  for (let round = 0; round < 20; round++) {
    await page.waitForTimeout(500);
    const next = await snapshotOf(page, control, kind);
    if (next === last) return next;
    last = next;
  }
  throw new Error(`the ${kind} snapshot was still changing after 10 seconds:\n${last}`);
}

/** The state attribute a kind flips, read for the wait. */
async function stateOf(control: Locator, kind: StateKind): Promise<string | null> {
  switch (kind) {
    case 'details':
      return control.evaluate((el) => String((el.parentElement as HTMLDetailsElement).open));
    case 'tab':
      return control.getAttribute('aria-selected');
    case 'toggle':
      return (await control.getAttribute('aria-pressed')) ?? control.getAttribute('aria-checked');
    default:
      return control.getAttribute('aria-expanded');
  }
}

async function waitForChange(
  control: Locator,
  kind: StateKind,
  from: string | null,
  timeout = 10_000,
): Promise<boolean> {
  try {
    await expect.poll(() => stateOf(control, kind), { timeout }).not.toBe(from);
    return true;
  } catch {
    return false;
  }
}

/** Real Tab presses until focus is on the element with this probe key. */
async function focusByTab(page: Page, key: number): Promise<boolean> {
  return (await tabTo(page, key)) !== null;
}

/**
 * Open or flip the focused control by keyboard. `from` is its state before Tab
 * reached it, so a combobox that opens on focus counts as changed. Returns false
 * when its state never changed.
 */
async function act(
  page: Page,
  control: Locator,
  kind: StateKind,
  tag: string,
  from: string | null,
): Promise<boolean> {
  if ((await stateOf(control, kind)) !== from) return true;
  if (kind === 'combobox' && tag === 'input') {
    await page.keyboard.press('ArrowDown');
    if (await waitForChange(control, kind, from, 5_000)) return true;
    await page.keyboard.type(FIXTURE_QUERY);
    return waitForChange(control, kind, from);
  }
  await page.keyboard.press('Enter');
  return waitForChange(control, kind, from);
}

export interface StateRecord {
  readonly label: string;
  readonly kind: StateKind;
  readonly text: string;
}

export interface StateResult {
  readonly records: readonly StateRecord[];
  /** One sentence per control that Tab could not reach or whose state did not change. */
  readonly problems: readonly string[];
}

/**
 * Snapshot every stateful control in `scope` before and after it is flipped.
 * `reload` puts the page back as `openSurface` left it, for when a flip cannot
 * be undone in place (a typed query, a changed URL).
 */
export async function snapshotStates(
  page: Page,
  scope: () => Locator,
  reload: () => Promise<void>,
): Promise<StateResult> {
  const records: StateRecord[] = [];
  const problems: string[] = [];
  const all = () => scope().locator(CONTROLS);
  const visibility = async (): Promise<boolean[]> => {
    const n = await all().count();
    const out: boolean[] = [];
    for (let i = 0; i < n; i++) out.push(await all().nth(i).isVisible());
    return out;
  };
  // Which controls show on the page as first loaded. Only those are flipped,
  // so a control a flip reveals, or one still rendering after a reload, does
  // not change the list.
  const shown = await visibility();
  const reloadAndWait = async () => {
    await reload();
    await expect
      .poll(async () => JSON.stringify(await visibility()), {
        message: 'after the reload, the same stateful controls show as on the first load',
        timeout: 30_000,
      })
      .toBe(JSON.stringify(shown));
  };
  for (let i = 0; i < shown.length; i++) {
    if (!shown[i]) continue;
    const control = all().nth(i);
    const info = await describeControl(control);
    // A pressed button in a group is the state the others restore to, and a
    // selected tab is where the others start. Each is snapshotted as their "before".
    if (info.kind === 'toggle' && info.pressed && info.grouped) continue;
    if (info.kind === 'tab' && info.selected) continue;

    const label = maskAriaSnapshot(
      (await control.ariaSnapshot()).split('\n')[0]!.replace(/^- /, '').replace(/:$/, ''),
    ).trim();
    await untilHydrated(control, 30_000);
    const startUrl = page.url();
    const before = await snapshotOf(page, control, info.kind);
    // The element to restore to, keyed now: after the flip "the pressed one" is
    // the control itself.
    const restoreTo =
      info.kind === 'toggle' && info.grouped
        ? control.locator('xpath=../*[@aria-pressed="true"]').first()
        : info.kind === 'tab'
          ? control
              .locator(
                'xpath=ancestor::*[@role="tablist"][1]//*[@role="tab"][@aria-selected="true"]',
              )
              .first()
          : null;
    const restoreKey =
      restoreTo && (await restoreTo.count()) > 0 ? await keyForLocator(page, restoreTo) : null;

    const controlKey = await keyForLocator(page, control);
    const from = await stateOf(control, info.kind);
    if (!(await focusByTab(page, controlKey))) {
      problems.push(`${info.kind} ${label}: Tab never reached it`);
      await reloadAndWait();
      continue;
    }
    const changed = await act(page, control, info.kind, info.tag, from);
    if (!changed) problems.push(`${info.kind} ${label}: its state did not change`);
    const after = changed
      ? await settledSnapshot(page, control, info.kind)
      : '# no state changed\n';
    records.push({ label, kind: info.kind, text: `## before\n${before}## after\n${after}` });

    // Undo in place, by keyboard, where the control can, then check the page is
    // back. A re-rendered control (a view switch) drops its probe key, so an undo
    // that cannot reach its element falls back to the reload.
    if (info.kind === 'combobox') {
      await page.keyboard.press('Escape');
    } else if (changed && restoreKey !== null) {
      if (await focusByTab(page, restoreKey)) await page.keyboard.press('Enter');
    } else if (changed && (await focusByTab(page, controlKey))) {
      await page.keyboard.press('Enter');
    }
    // A page that will not hold still here is not back either, so it is
    // reloaded rather than failed: the "after" read above already settled.
    const restored =
      new URL(page.url()).pathname === new URL(startUrl).pathname &&
      (await settledSnapshot(page, control, info.kind).catch(() => '')) === before;
    if (!restored) await reloadAndWait();
  }
  return { records, problems };
}

/** The committed text for one scope's records. */
export function statesText(heading: string, records: readonly StateRecord[]): string {
  const lines = [`# ${heading}`];
  if (records.length === 0) lines.push('# no stateful controls');
  records.forEach((r, i) => {
    lines.push(`# ${i + 1}. ${r.kind}: ${r.label}`, r.text.trimEnd());
  });
  return `${lines.join('\n')}\n`;
}
