/**
 * AECI-1877: the in-page half of the keyboard checks.
 *
 * The probe reads facts off the page. It never moves focus: every focus change in
 * the keyboard suite comes from a real key press (`./tab-walk.ts`).
 *
 * It keys elements with a per-document `WeakMap`, so the candidate set and the
 * walk can name the same element without writing to the DOM. A full page load
 * drops the map with the document. `ensureProbe` reinstalls it.
 *
 * Portable DOM only: `checkVisibility()`, `closest()`, `getClientRects()`. No
 * Chromium-only API, so Firefox and WebKit (AECI-1885) can run it as it is.
 */
import type { Locator, Page } from '@playwright/test';
import type { ElementFacts } from './tab-candidates';

/** What the probe reads off the focused element after a key press. */
export interface FocusFacts {
  /** The element's probe key. `null` when nothing but the document has focus. */
  readonly key: number | null;
  readonly tag: string;
  /** Focus is on `body` or nothing: the walk is between the last stop and the first. */
  readonly onBody: boolean;
  /** Focus is inside an iframe. The frame keeps focus over several presses. */
  readonly inIframe: boolean;
  /** The innermost landmark around the element: `header`, `nav`, `main`, `aside`, `footer`, `dialog`, or `page`. */
  readonly landmark: string;
  readonly inMain: boolean;
  /** Inside the site header (`aec-site-header`), the same component on every page. */
  readonly inSiteHeader: boolean;
  readonly ariaHidden: boolean;
  /** The element has a box of non-zero size. */
  readonly visible: boolean;
  readonly hasPopup: string | null;
  readonly expanded: string | null;
  readonly href: string | null;
  /** The link's `target` attribute. `_blank` opens a new tab. */
  readonly target: string | null;
  readonly url: string;
  /** Rendered popups of any kind: dialogs, menus, listboxes, tooltips, CDK panes. */
  readonly openPopups: number;
}

const PROBE_KEY = '__aeciKeyboardProbe';
const MARK_ATTRIBUTE = 'data-aeci-probe';

/** A rendered popup: a dialog, menu, listbox, tooltip, CDK overlay pane, or the trigger's `aria-controls` target. */
export interface PopupFacts {
  readonly key: number;
  readonly role: string;
  /** Named by the trigger's `aria-controls`. */
  readonly controlled: boolean;
  /** Drawn over the page (a CDK pane, or fixed or absolute), not in the flow. */
  readonly floating: boolean;
  readonly modal: boolean;
  readonly containsFocus: boolean;
}

export interface TriggerFacts {
  /** The trigger is still in the document. */
  readonly exists: boolean;
  readonly expanded: string | null;
  readonly focused: boolean;
  /** An `input` or `textarea`: an editable combobox. */
  readonly editable: boolean;
}

interface ProbeApi {
  focus(): FocusFacts;
  collect(): ElementFacts[];
  keyOf(el: Element): number;
  /** The element with this key in the current document, or `null`. For other in-page helpers (AECI-1878). */
  byKey(key: number): Element | null;
  popups(triggerKey: number | null): PopupFacts[];
  triggerState(triggerKey: number): TriggerFacts;
  mark(key: number): boolean;
  unmark(): void;
  haspopups(): HaspopupFacts[];
}

/** An element with `aria-haspopup`, and the roles of what its `aria-controls` names. */
export interface HaspopupFacts {
  readonly key: number;
  readonly label: string;
  readonly haspopup: string;
  /** The element's own explicit role. A combobox's popup is judged as a listbox by default. */
  readonly role: string | null;
  /** Explicit roles of the controlled elements, or `null` when it controls none. */
  readonly controlledRoles: (string | null)[] | null;
}

declare global {
  interface Window {
    __aeciKeyboardProbe?: ProbeApi;
  }
}

/**
 * Install the probe in the current document, if it is not there yet. Every
 * function the probe needs is defined inside, because `page.evaluate` sends the
 * source text, not the closure.
 */
export async function ensureProbe(page: Page): Promise<void> {
  await page.evaluate(
    ([probeKey, MARK]) => {
      const w = window as unknown as Record<string, unknown>;
      if (w[probeKey]) return;

      const keys = new WeakMap<Element, number>();
      let next = 1;
      const keyOf = (el: Element): number => {
        let key = keys.get(el);
        if (key === undefined) {
          key = next++;
          keys.set(el, key);
        }
        return key;
      };

      const LANDMARKS: ReadonlyArray<[string, string]> = [
        ['dialog, [role="dialog"], [role="alertdialog"]', 'dialog'],
        ['nav, [role="navigation"]', 'nav'],
        ['aside, [role="complementary"]', 'aside'],
        ['main, [role="main"]', 'main'],
        ['footer, [role="contentinfo"]', 'footer'],
        ['header, [role="banner"]', 'header'],
      ];
      const landmarkOf = (el: Element): string => {
        let best: Element | null = null;
        let name = 'page';
        for (const [selector, label] of LANDMARKS) {
          const found = el.closest(selector);
          // The innermost wins: a later match that sits inside the current best replaces it.
          if (found && (!best || best.contains(found))) {
            best = found;
            name = label;
          }
        }
        return name;
      };

      const isRendered = (el: Element): boolean =>
        typeof el.checkVisibility === 'function'
          ? el.checkVisibility()
          : el.getClientRects().length > 0;

      const NATIVE =
        'a[href], area[href], button, input:not([type="hidden"]), select, textarea, iframe, ' +
        'audio[controls], video[controls], [contenteditable=""], [contenteditable="true"]';

      const nativelyFocusable = (el: Element): boolean => {
        if (el.matches(NATIVE)) return true;
        // Only a details element's first summary child is focusable.
        if (el.tagName === 'SUMMARY') {
          const parent = el.parentElement;
          return (
            !!parent &&
            parent.tagName === 'DETAILS' &&
            parent.querySelector(':scope > summary') === el
          );
        }
        return false;
      };

      const labelOf = (el: Element): string => {
        const bits = [el.tagName.toLowerCase()];
        if (el.id) bits.push(`#${el.id}`);
        const aria = el.getAttribute('aria-label');
        const href = el.getAttribute('href');
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (aria) bits.push(`[aria-label="${aria}"]`);
        else if (href) bits.push(`[href="${href}"]`);
        if (text) bits.push(`"${text}"`);
        return bits.join(' ');
      };

      const isScroller = (el: Element): boolean => {
        if (!(el instanceof HTMLElement)) return false;
        const style = getComputedStyle(el);
        const scrolls = (v: string) => v === 'auto' || v === 'scroll' || v === 'overlay';
        return (
          (scrolls(style.overflowY) && el.scrollHeight > el.clientHeight) ||
          (scrolls(style.overflowX) && el.scrollWidth > el.clientWidth)
        );
      };

      const POPUPS =
        'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], ' +
        '[role="tooltip"], .cdk-overlay-pane';

      // Drawn over the page rather than in the flow: a CDK pane, or a fixed or
      // absolute box at or above it. An inline disclosure is neither.
      const isFloating = (el: Element): boolean => {
        if (el.closest('.cdk-overlay-container')) return true;
        for (
          let node: Element | null = el;
          node && node !== document.body;
          node = node.parentElement
        ) {
          const position = getComputedStyle(node).position;
          if (position === 'fixed' || position === 'absolute') return true;
          if (node.matches('header, nav, main, footer, aside, form')) break;
        }
        return false;
      };

      const byKey = (key: number): Element | null => {
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (keys.get(el) === key) return el;
        }
        return null;
      };

      const api = {
        keyOf,
        byKey,
        popups(triggerKey: number | null) {
          const trigger = triggerKey === null ? null : byKey(triggerKey);
          const controlled = trigger
            ?.getAttribute('aria-controls')
            ?.split(/\s+/)
            .map((id) => document.getElementById(id))
            .filter((el): el is HTMLElement => !!el);
          const active = document.activeElement;
          const found = new Set<Element>(controlled ?? []);
          for (const el of Array.from(document.querySelectorAll(POPUPS))) found.add(el);
          const boxed = (el: Element): boolean => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          // A dialog container can have no box of its own when its panel is fixed, so a
          // box anywhere inside counts.
          const hasBox = (el: Element): boolean =>
            boxed(el) || Array.from(el.querySelectorAll('*')).some(boxed);
          return (
            Array.from(found)
              // An emptied CDK pane stays in the DOM after its popup closes, with no box.
              .filter((el) => isRendered(el) && hasBox(el))
              // A pane that only wraps another popup in the list is the same popup.
              .filter((el) => !(el.matches('.cdk-overlay-pane') && el.querySelector(POPUPS)))
              .map((el) => ({
                key: keyOf(el),
                role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
                controlled: !!controlled?.includes(el as HTMLElement),
                floating: isFloating(el),
                modal:
                  el.getAttribute('aria-modal') === 'true' ||
                  (el instanceof HTMLDialogElement && el.matches(':modal')),
                containsFocus: !!active && el.contains(active),
              }))
          );
        },
        haspopups() {
          return Array.from(document.querySelectorAll('[aria-haspopup]')).map((el) => {
            const ids = el.getAttribute('aria-controls')?.split(/\s+/).filter(Boolean) ?? [];
            const controlled = ids
              .map((id) => document.getElementById(id))
              .filter((c): c is HTMLElement => !!c);
            return {
              key: keyOf(el),
              label: labelOf(el),
              haspopup: el.getAttribute('aria-haspopup') ?? '',
              role: el.getAttribute('role'),
              controlledRoles:
                controlled.length > 0 ? controlled.map((c) => c.getAttribute('role')) : null,
            };
          });
        },
        triggerState(triggerKey: number) {
          const trigger = byKey(triggerKey);
          return {
            exists: !!trigger && trigger.isConnected,
            expanded: trigger?.getAttribute('aria-expanded') ?? null,
            focused: !!trigger && document.activeElement === trigger,
            editable:
              !!trigger &&
              (trigger instanceof HTMLInputElement || trigger instanceof HTMLTextAreaElement),
          };
        },
        focus() {
          const el = document.activeElement;
          const onBody = !el || el === document.body || el === document.documentElement;
          const target = onBody ? null : el;
          const rect = target?.getBoundingClientRect();
          return {
            key: target ? keyOf(target) : null,
            tag: target ? target.tagName.toLowerCase() : 'body',
            onBody,
            inIframe: target?.tagName === 'IFRAME',
            landmark: target ? landmarkOf(target) : 'page',
            inSiteHeader: !!target?.closest('aec-site-header'),
            inMain: !!target?.closest('main, [role="main"]'),
            ariaHidden: !!target?.closest('[aria-hidden="true"]'),
            visible: !!rect && rect.width > 0 && rect.height > 0,
            hasPopup: target?.getAttribute('aria-haspopup') ?? null,
            expanded: target?.getAttribute('aria-expanded') ?? null,
            href: target?.getAttribute('href') ?? null,
            target: target?.getAttribute('target') ?? null,
            url: location.href,
            openPopups: Array.from(document.querySelectorAll(POPUPS)).filter(isRendered).length,
          };
        },
        mark(key: number) {
          for (const el of Array.from(document.querySelectorAll(`[${MARK}]`)))
            el.removeAttribute(MARK);
          const el = byKey(key);
          el?.setAttribute(MARK, '');
          return !!el;
        },
        unmark() {
          for (const el of Array.from(document.querySelectorAll(`[${MARK}]`)))
            el.removeAttribute(MARK);
        },
        collect() {
          const out: ElementFacts[] = [];
          const forms = new Map<Element, number>();
          for (const el of Array.from(document.body.querySelectorAll('*'))) {
            const native = nativelyFocusable(el);
            const tabindexAttr = el.getAttribute('tabindex');
            const scroller = !native && tabindexAttr === null && isScroller(el);
            if (!native && tabindexAttr === null && !scroller) continue;
            let radio: ElementFacts['radio'] = null;
            if (el instanceof HTMLInputElement && el.type === 'radio') {
              const form = el.form;
              let formIndex = -1;
              if (form) {
                if (!forms.has(form)) forms.set(form, forms.size);
                formIndex = forms.get(form) ?? -1;
              }
              const group = el.name ? `${formIndex}|${el.name}` : `solo|${keyOf(el)}`;
              radio = { group, checked: el.checked };
            }
            const rendered = isRendered(el);
            out.push({
              key: keyOf(el),
              tag: el.tagName.toLowerCase(),
              label: labelOf(el),
              nativelyFocusable: native,
              tabindexAttr,
              rendered,
              visible: rendered && getComputedStyle(el).visibility === 'visible',
              inert: !!el.closest('[inert]'),
              disabled: el.matches(':disabled'),
              ariaHidden: !!el.closest('[aria-hidden="true"]'),
              radio,
              scroller,
              hasFocusableDescendant: scroller
                ? Array.from(el.querySelectorAll(`${NATIVE}, [tabindex]`)).some(
                    (child) => isRendered(child) && !child.matches(':disabled'),
                  )
                : false,
            });
          }
          return out;
        },
      };
      w[probeKey] = api;
    },
    [PROBE_KEY, MARK_ATTRIBUTE] as const,
  );
}

/**
 * A Playwright locator for the element with probe key `key`. It sets a
 * `data-aeci-probe` attribute on that one element and clears it from every
 * other. The attribute changes no style, role or name. `:focus` alone is not
 * enough: it stops matching whenever the page loses window focus.
 */
export async function locatorForKey(page: Page, key: number): Promise<Locator | null> {
  await ensureProbe(page);
  const found = await page.evaluate((k) => window.__aeciKeyboardProbe!.mark(k), key);
  return found ? page.locator(`[${MARK_ATTRIBUTE}]`) : null;
}

/**
 * The probe key of the element a locator finds, so `tabTo` can reach it by real
 * Tab presses (AECI-1879). Reads the page and moves no focus.
 */
export async function keyForLocator(page: Page, locator: Locator): Promise<number> {
  await ensureProbe(page);
  return locator.evaluate((el) => window.__aeciKeyboardProbe!.keyOf(el));
}

/** Facts about the focused element. Reinstalls the probe after a full load. */
export async function focusFacts(page: Page): Promise<FocusFacts> {
  await ensureProbe(page);
  return page.evaluate(() => window.__aeciKeyboardProbe!.focus());
}

/** The rendered popups, and which of them holds focus. `triggerKey` adds its `aria-controls` target. */
export async function popupFacts(page: Page, triggerKey: number | null): Promise<PopupFacts[]> {
  await ensureProbe(page);
  return page.evaluate((key) => window.__aeciKeyboardProbe!.popups(key), triggerKey);
}

/** The trigger's `aria-expanded`, whether it has focus, and whether it is still there. */
export async function triggerFacts(page: Page, triggerKey: number): Promise<TriggerFacts> {
  await ensureProbe(page);
  return page.evaluate((key) => window.__aeciKeyboardProbe!.triggerState(key), triggerKey);
}

/** Every element with `aria-haspopup`, shown or hidden, with its controlled popup's roles. */
export async function haspopupFacts(page: Page): Promise<HaspopupFacts[]> {
  await ensureProbe(page);
  return page.evaluate(() => window.__aeciKeyboardProbe!.haspopups());
}

/** Facts for every element that could be a Tab stop, in document order. */
export async function collectElementFacts(page: Page): Promise<ElementFacts[]> {
  await ensureProbe(page);
  return page.evaluate(() => window.__aeciKeyboardProbe!.collect());
}
