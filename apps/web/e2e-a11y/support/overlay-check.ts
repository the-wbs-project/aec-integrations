/**
 * AECI-1877 check 7: every dialog, menu and dropdown opens by keyboard, keeps
 * focus while open, closes on Escape, and returns focus to its trigger.
 *
 * Triggers are found in the Tab walk, not listed by hand: a combobox, an element
 * with `aria-haspopup`, or one with `aria-expanded`. `classifyTrigger` decides
 * how to open each one and what "keeps focus" means for it:
 *
 * | Kind             | Found by                         | Opens on   | Focus on open | While open              |
 * |------------------|----------------------------------|------------|---------------|-------------------------|
 * | `dialog`         | `aria-haspopup="dialog"`         | Enter      | inside        | trapped (Tab and Shift+Tab cycle inside) |
 * | `menu-button`    | `aria-haspopup="true"`/`"menu"`  | Enter      | either        | Tab stays inside or closes it |
 * | `select`         | a select-only combobox           | Enter      | trigger       | Tab stays inside or closes it |
 * | `search`         | an editable combobox             | typing     | trigger       | Tab stays inside or closes it |
 * | `disclosure-nav` | a link with `aria-expanded`      | ArrowDown  | inside        | Tab stays inside or closes it |
 * | `popover`        | a button with `aria-expanded` whose panel floats over the page | Enter | either | Tab stays inside or closes it (the separate `popovers` test) |
 *
 * "Tab stays inside or closes it" is the rule for a non-modal popup: focus is
 * never behind a popup that is still open. Only a modal dialog must trap.
 * A button with `aria-expanded` whose panel sits in the flow is an inline
 * disclosure, not an overlay, and is not checked here. A native `<select>` draws
 * its list outside the page and is not checked either.
 *
 * Every check reports problems as plain sentences. The spec asserts the list is empty.
 */
import { expect, type Page } from '@playwright/test';
import { sequentialKey } from './browser-expectations';
import { focusFacts, popupFacts, triggerFacts, type FocusFacts, type PopupFacts } from './probe';
import { describeFocused, type TabStop } from './tab-walk';

export type OverlayKind =
  | 'dialog'
  | 'menu-button'
  | 'select'
  | 'search'
  | 'disclosure-nav'
  | 'popover';

export interface OverlayPlan {
  readonly kind: OverlayKind;
  /** Keys pressed on the focused trigger to open it. */
  readonly open: readonly string[];
  /** Text typed to open it, for an editable combobox. Replaces `open`. */
  readonly type?: { readonly first: string; readonly again: string };
  readonly focusOnOpen: 'inside' | 'trigger' | 'either';
  readonly containment: 'trap' | 'contain-or-close' | 'none';
}

export type TriggerClass =
  | { readonly overlay: OverlayPlan }
  | { readonly notOverlay: string }
  /** A button with `aria-expanded`: open it once to see whether its panel floats. */
  | { readonly probe: 'floating-panel' };

const DIALOG: OverlayPlan = {
  kind: 'dialog',
  open: ['Enter'],
  focusOnOpen: 'inside',
  containment: 'trap',
};
const SELECT: OverlayPlan = {
  kind: 'select',
  open: ['Enter'],
  focusOnOpen: 'trigger',
  containment: 'contain-or-close',
};
/**
 * A popover as the overlays test checks it: opens, closes on Escape, returns
 * focus. Containment is checked separately, by `POPOVER_CONTAINED` in the
 * keyboard suite's `popovers` test, so a known popover barrier stays apart.
 */
export const POPOVER: OverlayPlan = {
  kind: 'popover',
  open: ['Enter'],
  focusOnOpen: 'either',
  containment: 'none',
};
/** A popover with the non-modal rule: after each Tab, focus is inside it or it has closed. */
export const POPOVER_CONTAINED: OverlayPlan = { ...POPOVER, containment: 'contain-or-close' };

/** Does this stop open something? A combobox, `aria-haspopup`, or `aria-expanded`. */
export function isPopupTrigger(stop: TabStop): boolean {
  return (
    stop.role === 'combobox' ||
    (stop.hasPopup !== null && stop.hasPopup !== 'false') ||
    stop.expanded !== null
  );
}

/** How to open a trigger and what to expect. `null` when no rule covers it: the spec fails. */
export function classifyTrigger(stop: TabStop): TriggerClass | null {
  if (stop.tag === 'select') return { notOverlay: 'a native select; the browser draws its list' };
  if (stop.role === 'combobox') {
    if (stop.tag === 'input' || stop.tag === 'textarea') {
      // Typing opens the suggestions. "fi" matches the seeded "Fixture" products,
      // and `fakeHeaderSearch` answers any query for the header box.
      return {
        overlay: {
          kind: 'search',
          open: [],
          type: { first: 'fi', again: 'x' },
          focusOnOpen: 'trigger',
          containment: 'contain-or-close',
        },
      };
    }
    return { overlay: SELECT };
  }
  switch (stop.hasPopup) {
    case 'dialog':
      return { overlay: DIALOG };
    case 'true':
    case 'menu':
      return {
        overlay: {
          kind: 'menu-button',
          open: ['Enter'],
          focusOnOpen: 'either',
          containment: 'contain-or-close',
        },
      };
    case 'listbox':
      return { overlay: SELECT };
  }
  if (stop.expanded !== null) {
    if (stop.role === 'link') {
      // A link that also discloses a panel: Enter follows the link, ArrowDown opens
      // the panel (`layout/nav-disclosure.ts`, the Browse menu).
      return {
        overlay: {
          kind: 'disclosure-nav',
          open: ['ArrowDown'],
          focusOnOpen: 'inside',
          containment: 'contain-or-close',
        },
      };
    }
    return { probe: 'floating-panel' };
  }
  return null;
}

/** The stop the walk recorded, as `role "name"`, for messages. */
export function describeStop(stop: Pick<TabStop, 'role' | 'name'>): string {
  return `${stop.role} "${stop.name}"`;
}

/** Popups that were not open before the trigger was pressed. */
async function newPopups(
  page: Page,
  triggerKey: number,
  baseline: ReadonlySet<number>,
): Promise<PopupFacts[]> {
  return (await popupFacts(page, triggerKey)).filter((p) => !baseline.has(p.key));
}

async function isOpen(
  page: Page,
  triggerKey: number,
  baseline: ReadonlySet<number>,
): Promise<boolean> {
  const trigger = await triggerFacts(page, triggerKey);
  return trigger.expanded === 'true' || (await newPopups(page, triggerKey, baseline)).length > 0;
}

async function focusedLabel(page: Page, facts?: FocusFacts): Promise<string> {
  const f = facts ?? (await focusFacts(page));
  return f.key === null ? 'the page body' : describeStop(await describeFocused(page, f));
}

async function pressOpen(page: Page, plan: OverlayPlan, again: boolean): Promise<void> {
  if (plan.type) {
    await page.keyboard.type(again ? plan.type.again : plan.type.first);
    return;
  }
  for (const key of plan.open) await page.keyboard.press(key);
}

/**
 * Open the popup, and wait until it is open and its focus has settled. Returns
 * a problem sentence, or `null` when it opened as the plan expects.
 */
async function openAndSettle(
  page: Page,
  trigger: TabStop,
  plan: OverlayPlan,
  baseline: ReadonlySet<number>,
  again: boolean,
): Promise<string | null> {
  await pressOpen(page, plan, again);
  const opened = await expect
    .poll(() => isOpen(page, trigger.key, baseline), { timeout: 5_000 })
    .toBe(true)
    .then(() => true)
    .catch(() => false);
  if (!opened) return `${plan.open.join('+') || 'typing'} did not open it`;

  // A visible panel is not yet listening (TESTING_STRATEGY §14.3c). The trigger's
  // `aria-expanded="true"` flips in the tick that attaches the listeners.
  if ((await triggerFacts(page, trigger.key)).expanded !== null) {
    await expect
      .poll(async () => (await triggerFacts(page, trigger.key)).expanded, { timeout: 3_000 })
      .toBe('true')
      .catch(() => undefined);
  }

  const settled = async (): Promise<boolean> => {
    const popups = await newPopups(page, trigger.key, baseline);
    const inside = popups.some((p) => p.containsFocus);
    const onTrigger = (await triggerFacts(page, trigger.key)).focused;
    if (plan.focusOnOpen === 'inside') return inside;
    if (plan.focusOnOpen === 'trigger') return onTrigger;
    return inside || onTrigger;
  };
  const ok = await expect
    .poll(settled, { timeout: 3_000 })
    .toBe(true)
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    const where = plan.focusOnOpen === 'trigger' ? 'stay on the trigger' : 'move into the popup';
    return `focus did not ${where} on open. It is on ${await focusedLabel(page)}`;
  }
  return null;
}

async function closeWithEscape(
  page: Page,
  trigger: TabStop,
  baseline: ReadonlySet<number>,
): Promise<string[]> {
  const problems: string[] = [];
  await page.keyboard.press('Escape');
  const closed = await expect
    .poll(() => isOpen(page, trigger.key, baseline), { timeout: 3_000 })
    .toBe(false)
    .then(() => true)
    .catch(() => false);
  if (!closed) problems.push('Escape did not close it');
  const returned = await expect
    .poll(async () => (await triggerFacts(page, trigger.key)).focused, { timeout: 3_000 })
    .toBe(true)
    .then(() => true)
    .catch(() => false);
  if (!returned) {
    problems.push(
      `Escape did not return focus to the trigger. It is on ${await focusedLabel(page)}`,
    );
  }
  return problems;
}

/** A modal dialog: Tab and Shift+Tab must cycle inside it. */
async function checkTrap(
  page: Page,
  trigger: TabStop,
  baseline: ReadonlySet<number>,
): Promise<string[]> {
  for (const key of ['Tab', 'Shift+Tab'] as const) {
    const seen = new Set<number>();
    let cycled = false;
    for (let i = 0; i < 50; i++) {
      await page.keyboard.press(sequentialKey(page, key));
      const facts = await focusFacts(page);
      const popups = await newPopups(page, trigger.key, baseline);
      if (popups.length === 0) return [`${key} closed the dialog`];
      if (!popups.some((p) => p.containsFocus)) {
        return [`${key} moved focus out of the open dialog, to ${await focusedLabel(page, facts)}`];
      }
      if (facts.key !== null && seen.has(facts.key)) {
        cycled = true;
        break;
      }
      if (facts.key !== null) seen.add(facts.key);
    }
    if (!cycled) return [`${key} did not cycle inside the dialog within 50 presses`];
  }
  return [];
}

/** A non-modal popup: after each Tab, focus is inside it, or it has closed. */
async function checkContainOrClose(
  page: Page,
  trigger: TabStop,
  baseline: ReadonlySet<number>,
): Promise<string[]> {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press(sequentialKey(page, 'Tab'));
    if (!(await isOpen(page, trigger.key, baseline))) return [];
    const popups = await newPopups(page, trigger.key, baseline);
    const trig = await triggerFacts(page, trigger.key);
    if (!popups.some((p) => p.containsFocus) && !trig.focused) {
      // The popup may close a tick after focus leaves it. Give it that tick.
      const closes = await expect
        .poll(() => isOpen(page, trigger.key, baseline), { timeout: 1_000 })
        .toBe(false)
        .then(() => true)
        .catch(() => false);
      if (closes) return [];
      return [`Tab left it open behind focus, which is on ${await focusedLabel(page)}`];
    }
  }
  return ['Tab never left the open popup in 80 presses'];
}

/**
 * Run check 7 on one trigger. Focus must be on the trigger already, reached by
 * Tab. Leaves the popup closed when it can.
 */
export async function checkOverlay(
  page: Page,
  trigger: TabStop,
  plan: OverlayPlan,
): Promise<string[]> {
  const baseline = new Set((await popupFacts(page, null)).map((p) => p.key));
  const problems: string[] = [];

  const openProblem = await openAndSettle(page, trigger, plan, baseline, false);
  if (openProblem) return [openProblem];

  const escape = await closeWithEscape(page, trigger, baseline);
  problems.push(...escape);
  if (escape.length > 0 || plan.containment === 'none') return problems;

  const reopen = await openAndSettle(page, trigger, plan, baseline, true);
  if (reopen) return [...problems, `on the second open, ${reopen}`];
  problems.push(
    ...(plan.containment === 'trap'
      ? await checkTrap(page, trigger, baseline)
      : await checkContainOrClose(page, trigger, baseline)),
  );
  if (await isOpen(page, trigger.key, baseline)) await page.keyboard.press('Escape');
  return problems;
}

/**
 * Settle a `probe: 'floating-panel'` trigger: press Enter, and see whether a
 * panel floats over the page. Returns the plan to check it with, or the reason
 * it is not an overlay. Presses Enter again to put an inline panel back.
 */
export async function probeFloatingPanel(
  page: Page,
  trigger: TabStop,
): Promise<{ overlay: OverlayPlan } | { notOverlay: string }> {
  const baseline = new Set((await popupFacts(page, null)).map((p) => p.key));
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await triggerFacts(page, trigger.key)).expanded, { timeout: 3_000 })
    .toBe('true')
    .catch(() => undefined);
  const popups = await newPopups(page, trigger.key, baseline);
  const floats = popups.some((p) => p.floating);
  if (floats) {
    await page.keyboard.press('Escape');
    return { overlay: POPOVER };
  }
  if ((await triggerFacts(page, trigger.key)).focused) await page.keyboard.press('Enter');
  return { notOverlay: 'an inline disclosure; its panel opens in the flow of the page' };
}
