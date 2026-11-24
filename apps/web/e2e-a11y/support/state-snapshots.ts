/**
 * AECI-1879: before-and-after ARIA snapshots for every stateful control in a scope.
 *
 * The controls are found on the page, not listed by hand, so a new disclosure,
 * tab set, combobox or toggle is snapshotted the day it ships:
 *
 *   disclosure  a button with `aria-expanded`. Clicked, then clicked again.
 *   combobox    `role="combobox"`. A button opens on click. A text box opens on
 *               ArrowDown, or on a typed fixture query when ArrowDown shows nothing.
 *               Closed with Escape.
 *   toggle      a button with `aria-pressed`, or `role="switch"`. In a group of
 *               pressed buttons, the ones not pressed are clicked, and the one
 *               that was pressed is clicked to restore.
 *   tab         `role="tab"` that is not selected. Clicked, then the old tab is.
 *   details     a `<summary>`. Clicked, then clicked again.
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
 * The snapshot once it has stopped changing. A popup can show before its options
 * land (a debounced query, a fetch), so one read can catch it half drawn.
 */
async function settledSnapshot(page: Page, control: Locator, kind: StateKind): Promise<string> {
  let last = await snapshotOf(page, control, kind);
  for (let round = 0; round < 20; round++) {
    await page.waitForTimeout(500);
    const next = await snapshotOf(page, control, kind);
    if (next === last) return next;
    last = next;
  }
  return last;
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

/** Open or flip the control. Returns false when its state never changed. */
async function act(page: Page, control: Locator, kind: StateKind, tag: string): Promise<boolean> {
  const from = await stateOf(control, kind);
  if (kind === 'combobox' && tag === 'input') {
    await control.click();
    if ((await stateOf(control, kind)) !== 'true') await page.keyboard.press('ArrowDown');
    if (await waitForChange(control, kind, from, 5_000)) return true;
    await control.pressSequentially(FIXTURE_QUERY);
    return waitForChange(control, kind, from);
  }
  await control.click();
  return waitForChange(control, kind, from);
}

/**
 * The element `selector` finds from `control` today, as a locator that keeps
 * finding that same element after the page's state changes. Null when none.
 */
async function pinned(control: Locator, selector: string): Promise<Locator | null> {
  const found = control.locator(selector).first();
  if ((await found.count()) === 0) return null;
  const marker = `aeci-1879-${Math.random().toString(36).slice(2)}`;
  await found.evaluate((el, m) => el.setAttribute('data-aria-restore', m), marker);
  return control.page().locator(`[data-aria-restore="${marker}"]`);
}

export interface StateRecord {
  readonly label: string;
  readonly kind: StateKind;
  /** False when acting on the control changed none of its state. */
  readonly changed: boolean;
  readonly text: string;
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
): Promise<StateRecord[]> {
  const records: StateRecord[] = [];
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
      .poll(async () => JSON.stringify(await visibility()), { timeout: 30_000 })
      .toBe(JSON.stringify(shown))
      .catch(() => undefined);
  };
  for (let i = 0; i < shown.length; i++) {
    if (!shown[i]) continue;
    const control = all().nth(i);
    const info = await describeControl(control);
    // A pressed button in a group is the state the others restore to, and a
    // selected tab is where the others start. Each is snapshotted as their "before".
    if (info.kind === 'toggle' && info.pressed && info.grouped) continue;
    if (info.kind === 'tab' && info.selected) continue;

    const label = (await control.ariaSnapshot())
      .split('\n')[0]!
      .replace(/^- /, '')
      .replace(/:$/, '');
    await untilHydrated(control, 30_000);
    const startUrl = page.url();
    const before = await snapshotOf(page, control, info.kind);
    // Pin the element to restore to now: a locator is resolved when it is used,
    // and after the flip "the pressed one" is the control itself.
    const pressedSibling =
      info.kind === 'toggle' && info.grouped
        ? await pinned(control, 'xpath=../*[@aria-pressed="true"]')
        : null;
    const selectedTab =
      info.kind === 'tab'
        ? await pinned(
            control,
            'xpath=ancestor::*[@role="tablist"][1]//*[@role="tab"][@aria-selected="true"]',
          )
        : null;
    const changed = await act(page, control, info.kind, info.tag);
    const after = changed
      ? await settledSnapshot(page, control, info.kind)
      : '# no state changed\n';
    records.push({
      label: maskAriaSnapshot(label).trim(),
      kind: info.kind,
      changed,
      text: `## before\n${before}## after\n${after}`,
    });

    // Undo in place where the control can, then check the page is back. A
    // re-rendered control (a view switch) can drop the pinned element, so a
    // failed undo falls back to the reload.
    try {
      if (info.kind === 'combobox') await page.keyboard.press('Escape');
      else if (changed && pressedSibling) await pressedSibling.click({ timeout: 10_000 });
      else if (changed && selectedTab) await selectedTab.click({ timeout: 10_000 });
      else if (changed) await control.click({ timeout: 10_000 });
    } catch {
      // The comparison below sees the page is not back.
    }
    const restored =
      new URL(page.url()).pathname === new URL(startUrl).pathname &&
      (await settledSnapshot(page, control, info.kind).catch(() => '')) === before;
    if (!restored) await reloadAndWait();
  }
  return records;
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
