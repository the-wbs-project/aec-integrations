/**
 * AECI-1882: the in-page half of the interaction checks.
 *
 * `installInteractionProbe` runs before any page script, on every document:
 *
 *   - It marks each element that registers a hover listener (`mouseenter`,
 *     `mouseover`, `pointerenter`, `pointerover`). Angular binds a template's
 *     `(mouseenter)` with `addEventListener`, so every hover-opened panel in the
 *     app is found this way, with no list kept by hand. A reveal done in CSS
 *     alone (`:hover` showing a hidden element) is not found. The app has none
 *     (`docs/TESTING_STRATEGY.md` §8.4.7, "Limits").
 *   - It records every animation and transition the document runs, from the
 *     first frame: CSS animations and transitions by their start events, and
 *     anything else by sampling `document.getAnimations()`.
 *   - It gives the document a random token, so a check can tell a full load
 *     from a client navigation.
 *
 * Every other read uses the keyboard suite's probe (`./probe.ts`) for element
 * keys, so a key means the same element in both.
 */
import type { Page } from '@playwright/test';
import { ensureProbe } from './probe';
import type {
  ActivationState,
  ControlFacts,
  PageSnapshot,
  RecordedAnimation,
} from './interaction-rules';

interface InteractionApi {
  readonly doc: string;
  readonly hover: Set<Element>;
  readonly animations: Array<RecordedAnimation & { readonly ref: WeakRef<Animation> }>;
}

declare global {
  interface Window {
    __aeciInteraction?: InteractionApi;
  }
}

/** Install before the first `goto`. Runs on every new document. */
export async function installInteractionProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new WeakSet<Animation>();
    const api = {
      doc: Math.random().toString(36).slice(2),
      hover: new Set<Element>(),
      animations: [] as InteractionApi['animations'],
    };
    (window as unknown as { __aeciInteraction: unknown }).__aeciInteraction = api;

    const HOVER = new Set(['mouseenter', 'mouseover', 'pointerenter', 'pointerover']);
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (HOVER.has(type) && this instanceof Element) api.hover.add(this);
      return add.call(this, type, listener, options);
    };

    const describe = (el: Element | null | undefined): string => {
      if (!el) return 'no element';
      let host: Element | null = el;
      while (host && !host.tagName.includes('-')) host = host.parentElement;
      const bits = [el.tagName.toLowerCase()];
      if (el.id) bits.push(`#${el.id}`);
      const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length > 0) bits.push(`.${cls.join('.')}`);
      return host && host !== el
        ? `${bits.join('')} in ${host.tagName.toLowerCase()}`
        : bits.join('');
    };
    const note = (a: Animation): void => {
      if (seen.has(a)) return;
      seen.add(a);
      const timing = a.effect?.getComputedTiming();
      const target = (a.effect as KeyframeEffect | null)?.target ?? null;
      const named = a as Animation & { animationName?: string; transitionProperty?: string };
      api.animations.push({
        kind: a.constructor.name,
        name: named.animationName ?? named.transitionProperty ?? a.id ?? '',
        target: describe(target),
        iterations: Number(timing?.iterations ?? 1),
        duration: Number(timing?.duration ?? 0) || 0,
        activeDuration: Number(timing?.activeDuration ?? 0) || 0,
        ref: new WeakRef(a),
      });
    };
    const sample = (): void => {
      for (const a of document.getAnimations()) note(a);
    };
    const onEvent = (e: Event): void => {
      const t = e.target;
      if (t instanceof Element) for (const a of t.getAnimations()) note(a);
    };
    for (const type of ['animationstart', 'transitionrun', 'transitionstart']) {
      document.addEventListener(type, onEvent, true);
    }
    // Catches a Web Animations API `element.animate()`, which fires no event.
    setInterval(sample, 50);
  });
}

/** Every animation seen on this document so far. */
export async function recordedAnimations(page: Page): Promise<RecordedAnimation[]> {
  return page.evaluate(() =>
    (window.__aeciInteraction?.animations ?? []).map(({ ref: _ref, ...rest }) => rest),
  );
}

/**
 * The long motions still running now (more than 5 seconds, or endless), on an
 * element that is drawn, with how long each has run.
 */
export async function runningLongMotions(
  page: Page,
  limitMs: number,
): Promise<Array<RecordedAnimation & { readonly ranMs: number }>> {
  return page.evaluate((limit) => {
    const api = window.__aeciInteraction;
    if (!api) return [];
    const out: Array<RecordedAnimation & { ranMs: number }> = [];
    for (const { ref, ...rest } of api.animations) {
      const a = ref.deref();
      if (!a || a.playState !== 'running') continue;
      if (!(rest.activeDuration > limit)) continue;
      const target = (a.effect as KeyframeEffect | null)?.target;
      if (target && !target.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
        continue;
      }
      const t = a.currentTime;
      out.push({ ...rest, ranMs: typeof t === 'number' ? t : 0 });
    }
    return out;
  }, limitMs);
}

/** What a press could have changed. `writes` is counted outside the page. */
export async function activationState(page: Page, writes: number): Promise<ActivationState> {
  await ensureProbe(page);
  const read = await page.evaluate(() => {
    const visible = (el: Element) =>
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
      el.getClientRects().length > 0;
    const popups = Array.from(
      document.querySelectorAll(
        'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
      ),
    ).filter(visible).length;
    const states: string[] = [];
    const ATTRS = ['aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected'];
    const stateful = Array.from(
      document.querySelectorAll(
        '[aria-expanded], [aria-pressed], [aria-checked], [aria-selected], input[type="checkbox"], input[type="radio"], select',
      ),
    );
    // Labelled by place in document order, not by probe key, so two loads of
    // the same page give the same labels and their changes can be compared.
    for (const [i, el] of stateful.entries()) {
      const label = `${el.tagName.toLowerCase()}[${i}]`;
      for (const attr of ATTRS) {
        const v = el.getAttribute(attr);
        if (v !== null) states.push(`${label} ${attr}=${v}`);
      }
      if (el instanceof HTMLInputElement) states.push(`${label} checked=${el.checked}`);
      if (el instanceof HTMLSelectElement) states.push(`${label} value=${el.value}`);
    }
    return { url: location.href, doc: window.__aeciInteraction?.doc ?? 'none', popups, states };
  });
  return { ...read, writes };
}

/** The facts a character-shortcut check compares. */
export async function pageSnapshot(page: Page): Promise<PageSnapshot> {
  await ensureProbe(page);
  return page.evaluate(() => {
    const el = document.activeElement;
    const onBody = !el || el === document.body || el === document.documentElement;
    const focus = onBody
      ? 'the page body'
      : `${el.tagName.toLowerCase()}#${window.__aeciKeyboardProbe!.keyOf(el)}`;
    const popups = Array.from(
      document.querySelectorAll(
        'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], .cdk-overlay-pane',
      ),
    ).filter((p) => p.getClientRects().length > 0 && p.checkVisibility()).length;
    return {
      url: location.href,
      title: document.title,
      scroll: `${Math.round(scrollX)},${Math.round(scrollY)}`,
      focus,
      popups,
      elements: document.getElementsByTagName('*').length,
      text: document.body.innerText,
    };
  });
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A trigger with a hover listener, as the hover check sees it. */
export interface HoverTrigger {
  readonly key: number;
  readonly label: string;
  readonly inSharedChrome: boolean;
  /** The element to point at: the listener's element, or its first focusable child. */
  readonly box: Box;
}

/** Drawn elements now, remembered as the baseline for `newContent`. */
export async function rememberShown(page: Page): Promise<void> {
  await page.evaluate(() => {
    const shown = new Set<Element>();
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) shown.add(el);
      }
    }
    (window as unknown as { __aeciShown: Set<Element> }).__aeciShown = shown;
  });
}

/** Content drawn since `rememberShown`, outside the trigger: the roots of each new subtree. */
export interface NewContent {
  readonly keys: number[];
  /** The biggest root: where the pointer goes to hover the content. */
  readonly main: Box | null;
  readonly union: Box | null;
  readonly label: string;
}

export async function newContent(page: Page, triggerKey: number): Promise<NewContent> {
  await ensureProbe(page);
  return page.evaluate((key) => {
    const probe = window.__aeciKeyboardProbe!;
    const baseline = (window as unknown as { __aeciShown?: Set<Element> }).__aeciShown ?? new Set();
    const trigger = probe.byKey(key);
    const isNew = (el: Element): boolean => {
      if (baseline.has(el)) return false;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const roots: Element[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (trigger && trigger.contains(el)) continue;
      if (!isNew(el)) continue;
      const parent = el.parentElement;
      if (parent && parent !== document.body && isNew(parent) && !(trigger && parent === trigger)) {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 100) continue;
      roots.push(el);
    }
    // Where the pointer goes: the biggest new element whose own centre hits it.
    // A CDK bounding box is a large new root that ignores the pointer, so its
    // centre hits the page behind it and it is passed over for its panel.
    let main: Element | null = null;
    let area = 0;
    for (const root of roots) {
      for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
        const r = el.getBoundingClientRect();
        if (r.width * r.height <= area) continue;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit && el.contains(hit)) {
          area = r.width * r.height;
          main = el;
        }
      }
    }
    let union: { x0: number; y0: number; x1: number; y1: number } | null = null;
    for (const el of roots) {
      const r = el.getBoundingClientRect();
      union = union
        ? {
            x0: Math.min(union.x0, r.left),
            y0: Math.min(union.y0, r.top),
            x1: Math.max(union.x1, r.right),
            y1: Math.max(union.y1, r.bottom),
          }
        : { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
    }
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    return {
      keys: roots.map((el) => probe.keyOf(el)),
      main: box(main),
      union: union
        ? { x: union.x0, y: union.y0, width: union.x1 - union.x0, height: union.y1 - union.y0 }
        : null,
      label: main
        ? `${main.tagName.toLowerCase()}${main.getAttribute('role') ? `[role=${main.getAttribute('role')}]` : ''}`
        : 'nothing',
    };
  }, triggerKey);
}

/** Are these elements all still drawn? */
export async function stillShown(page: Page, keys: readonly number[]): Promise<boolean> {
  if (keys.length === 0) return false;
  return page.evaluate((ks) => {
    const probe = window.__aeciKeyboardProbe!;
    return ks.every((k) => {
      const el = probe.byKey(k);
      if (!el || !el.isConnected) return false;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }, keys);
}

/** Does the page scroll sideways, or does the box leave the viewport? */
export async function overflowsViewport(page: Page, box: Box): Promise<string | null> {
  return page.evaluate((b) => {
    const doc = document.documentElement;
    const problems: string[] = [];
    if (doc.scrollWidth > doc.clientWidth + 1) {
      problems.push(
        `the page scrolls sideways (${doc.scrollWidth}px wide in ${doc.clientWidth}px)`,
      );
    }
    if (b.x < -1 || b.x + b.width > innerWidth + 1) {
      problems.push(
        `the content spans ${Math.round(b.x)} to ${Math.round(b.x + b.width)}px in a ${innerWidth}px viewport`,
      );
    }
    return problems.length > 0 ? problems.join(', ') : null;
  }, box);
}

/** The elements with hover listeners that are drawn now. */
export async function hoverTriggers(page: Page): Promise<HoverTrigger[]> {
  await ensureProbe(page);
  return page.evaluate(() => {
    const api = window.__aeciInteraction;
    const probe = window.__aeciKeyboardProbe!;
    if (!api) return [];
    const out: HoverTrigger[] = [];
    for (const el of api.hover) {
      if (!el.isConnected || el === document.body || el === document.documentElement) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // A host element's own box can be the whole open panel. Point at its first
      // control instead, the thing a reader hovers.
      const control = el.matches('a, button, [role="button"]')
        ? el
        : (el.querySelector('a[href], button, [role="button"]') ?? el);
      const box = control.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const name =
        control.getAttribute('aria-label') ??
        (control.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      out.push({
        key: probe.keyOf(control),
        label: `${el.tagName.toLowerCase()} "${name}"`,
        inSharedChrome: !!el.closest('aec-site-header, aec-site-footer'),
        box: { x: box.left, y: box.top, width: box.width, height: box.height },
      });
    }
    return out;
  });
}

/** One activatable control per kind, for the pointer check. */
export interface PointerTarget {
  readonly key: number;
  readonly label: string;
  readonly signature: string;
  readonly inSharedChrome: boolean;
}

export async function pointerTargets(page: Page): Promise<PointerTarget[]> {
  await ensureProbe(page);
  return page.evaluate(() => {
    const probe = window.__aeciKeyboardProbe!;
    const SELECTOR =
      'a[href], button, summary, input[type="checkbox"], input[type="radio"], ' +
      'input[type="submit"], input[type="button"], [role="button"], [role="link"], [role="tab"], ' +
      '[role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], ' +
      '[role="combobox"]:not(input):not(textarea)';
    const LANDMARKS = 'header, nav, main, footer, aside, [role="dialog"], dialog';
    const seen = new Set<string>();
    const out: PointerTarget[] = [];
    for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
      if (el.closest('[inert], [aria-hidden="true"]') || el.matches(':disabled')) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      let host: Element | null = el.parentElement;
      while (host && !host.tagName.includes('-')) host = host.parentElement;
      const role =
        el.getAttribute('role') ??
        (el.tagName === 'A'
          ? 'link'
          : el.tagName === 'INPUT'
            ? `input-${el.getAttribute('type')}`
            : el.tagName.toLowerCase());
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? '')
        .replace(/\d+([.,]\d+)?/g, '#')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
      const landmark = el.closest(LANDMARKS)?.tagName.toLowerCase() ?? 'page';
      // Links of one kind differ only by where they go. Other controls are told
      // apart by name too: Approve and Reject are two functions in one card.
      const signature = [
        host?.tagName.toLowerCase() ?? 'none',
        landmark,
        role,
        role === 'link' ? '' : name,
      ].join('|');
      if (seen.has(signature)) continue;
      seen.add(signature);
      out.push({
        key: probe.keyOf(el),
        label: `${role} "${name}"`,
        signature,
        inSharedChrome: !!el.closest('aec-site-header, aec-site-footer'),
      });
    }
    return out;
  });
}

/**
 * Bring the control into view and find where to press it and where to let go:
 * its centre, and a nearby point on nothing interactive (`away`, `null` when
 * there is none). `skip` with a reason when the centre is covered.
 */
export async function pressPoints(
  page: Page,
  key: number,
): Promise<
  { centre: { x: number; y: number }; away: { x: number; y: number } | null } | { skip: string }
> {
  return page.evaluate((k) => {
    const probe = window.__aeciKeyboardProbe!;
    const el = probe.byKey(k);
    if (!el) return { skip: 'it left the page' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const centre = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const hit = document.elementFromPoint(centre.x, centre.y);
    if (!hit || !(el === hit || el.contains(hit))) {
      return { skip: `its centre is covered by ${hit?.tagName.toLowerCase() ?? 'nothing'}` };
    }
    const INTERACTIVE =
      'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], ' +
      '[role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], ' +
      '[role="option"], [role="combobox"], [tabindex]:not([tabindex="-1"]), [contenteditable]';
    const hover = window.__aeciInteraction?.hover ?? new Set<Element>();
    const neutral = (x: number, y: number): boolean => {
      if (x < 2 || y < 2 || x > innerWidth - 2 || y > innerHeight - 2) return false;
      const at = document.elementFromPoint(x, y);
      if (!at || at === document.documentElement) return false;
      if (at.closest(INTERACTIVE)) return false;
      for (const h of hover) if (h !== document.body && h.contains(at)) return false;
      return true;
    };
    for (const d of [48, 96, 160]) {
      const tries = [
        [r.left - d, centre.y],
        [r.right + d, centre.y],
        [centre.x, r.top - d],
        [centre.x, r.bottom + d],
        [r.left - d, r.top - d],
        [r.right + d, r.bottom + d],
      ];
      for (const [x, y] of tries) if (neutral(x, y)) return { centre, away: { x, y } };
    }
    return { centre, away: null };
  }, key);
}

/**
 * A point in the viewport over nothing interactive and nothing with a hover
 * listener, to park the pointer between checks. Scans from the bottom left.
 */
export async function parkingSpot(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const INTERACTIVE =
      'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], ' +
      '[role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [tabindex]:not([tabindex="-1"])';
    const hover = window.__aeciInteraction?.hover ?? new Set<Element>();
    for (let y = innerHeight - 8; y > 8; y -= 40) {
      for (let x = 8; x < innerWidth - 8; x += 40) {
        const at = document.elementFromPoint(x, y);
        if (!at || at.closest(INTERACTIVE)) continue;
        let onHover = false;
        for (const h of hover) if (h !== document.body && h.contains(at)) onHover = true;
        if (!onHover) return { x, y };
      }
    }
    return { x: 2, y: innerHeight - 2 };
  });
}

/** The form controls the on-input check changes, one per component and kind. */
export interface InputTarget extends ControlFacts {
  readonly key: number;
  /** How to change it. */
  readonly action: 'toggle' | 'select' | 'pick' | 'type' | 'type-number';
}

export async function inputTargets(page: Page): Promise<InputTarget[]> {
  await ensureProbe(page);
  return page.evaluate(() => {
    const probe = window.__aeciKeyboardProbe!;
    const SELECTOR =
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="file"]), ' +
      'select, textarea, [role="combobox"], [role="switch"], [role="checkbox"], [role="radio"]';
    const seen = new Set<string>();
    const out: InputTarget[] = [];
    for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
      if (el.closest('[inert], [aria-hidden="true"]') || el.matches(':disabled')) continue;
      if ((el as HTMLInputElement).readOnly) continue;
      // A visually hidden input behind a styled label is still the control.
      const drawn =
        el.getClientRects().length > 0 ||
        (el instanceof HTMLInputElement && (el.labels?.length ?? 0) > 0);
      if (!drawn || !el.checkVisibility({ visibilityProperty: true })) continue;
      let host: Element | null = el.parentElement;
      while (host && !host.tagName.includes('-')) host = host.parentElement;
      const tag = el.tagName.toLowerCase();
      const type = el instanceof HTMLInputElement ? el.type : '';
      const explicit = el.getAttribute('role');
      const role =
        explicit ??
        (tag === 'select'
          ? 'select'
          : tag === 'textarea'
            ? 'textbox'
            : type === 'checkbox'
              ? 'checkbox'
              : type === 'radio'
                ? 'radio'
                : 'textbox');
      let action: InputTarget['action'];
      if (role === 'checkbox' || role === 'radio' || role === 'switch') action = 'toggle';
      else if (tag === 'select') action = 'select';
      else if (role === 'combobox' && tag !== 'input' && tag !== 'textarea') action = 'pick';
      else if (type === 'number') action = 'type-number';
      else action = 'type';
      const labelled =
        el.getAttribute('aria-label') ??
        (el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLButtonElement
          ? Array.from(el.labels ?? [])
              .map((l) => l.textContent ?? '')
              .join(' ')
          : '');
      const name = (labelled || el.getAttribute('placeholder') || el.id || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
      const hostTag = host?.tagName.toLowerCase() ?? 'none';
      // One per component instance and kind: one box of each filter group, one
      // of each select, not all forty audience boxes.
      const instance = host ? probe.keyOf(host) : 0;
      const signature = `${instance}|${role}|${action}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      out.push({
        key: probe.keyOf(el),
        host: hostTag,
        role,
        tag,
        type,
        name,
        action,
        inSharedChrome: !!el.closest('aec-site-header, aec-site-footer'),
      });
    }
    return out;
  });
}

/** Is focus on the control, or inside a popup it owns (`aria-controls`, or a CDK pane)? */
export async function focusStayedWith(page: Page, key: number): Promise<boolean> {
  return page.evaluate((k) => {
    const el = window.__aeciKeyboardProbe!.byKey(k);
    const active = document.activeElement;
    if (!el || !active) return false;
    if (el === active || el.contains(active)) return true;
    const owned = (el.getAttribute('aria-controls') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id));
    if (owned.some((o) => o?.contains(active))) return true;
    return !!active.closest('.cdk-overlay-container');
  }, key);
}

/** Read a control's current value, for the pick and select actions. */
export async function controlValue(page: Page, key: number): Promise<string> {
  return page.evaluate((k) => {
    const el = window.__aeciKeyboardProbe!.byKey(k);
    if (!el) return '';
    if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) return el.value;
    return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  }, key);
}
