/**
 * AECI-1877: the candidate tab-stop set, and its diff against a real Tab walk.
 *
 * This is the method in `docs/a11y-manual-testing-checklist.md` §5. A script
 * predicts which elements Tab should reach (the candidates). Real Tab presses
 * are the evidence. The difference between the two is the finding. Never let the
 * prediction stand in for the walk: it reimplements `tabindex` and `inert`, it
 * does not consult the browser's sequential focus navigation.
 *
 * Pure on purpose. Nothing here imports Playwright or touches a DOM, so the
 * plain Vitest runner pins it (`tab-candidates.unit.spec.ts`). The browser half,
 * which reads the facts off the page, is `collectElementFacts` in `./probe.ts`.
 */

/** What the probe reads off one element. Plain data, so it crosses `page.evaluate`. */
export interface ElementFacts {
  /** The probe's per-document key for the element (`./probe.ts`). */
  readonly key: number;
  /** Lower-case tag name. */
  readonly tag: string;
  /** A short human label for reports. The probe does not compute accessible names. */
  readonly label: string;
  /** Focusable with no `tabindex`: a link with an href, a form control, iframe, summary, editable. */
  readonly nativelyFocusable: boolean;
  /** The raw `tabindex` attribute, or `null` when absent. */
  readonly tabindexAttr: string | null;
  /** Has a layout box: not `display: none`, not inside a hidden ancestor. */
  readonly rendered: boolean;
  /** Computed `visibility` is `visible`. */
  readonly visible: boolean;
  /** Inside an `inert` subtree, or itself inert. */
  readonly inert: boolean;
  /** Matches `:disabled`. A disabled fieldset ancestor counts. */
  readonly disabled: boolean;
  /** Inside an `aria-hidden="true"` subtree. */
  readonly ariaHidden: boolean;
  /** For `input[type=radio]`: the group key (form plus name) and whether it is checked. */
  readonly radio: { readonly group: string; readonly checked: boolean } | null;
  /** A scroll container whose content overflows it. */
  readonly scroller: boolean;
  /** Has a focusable descendant. Only read for scrollers. */
  readonly hasFocusableDescendant: boolean;
}

export interface CandidateOptions {
  /**
   * Chromium-only. Since Chrome 130 a scroll container with no focusable content
   * is a Tab stop of its own ("keyboard-focusable scrollers"). Firefox and WebKit
   * differ, so AECI-1885 sets this per browser. Default `true`, for Chromium.
   */
  readonly keyboardFocusableScrollers?: boolean;
  /**
   * Firefox makes every scroll container a Tab stop, even one that holds
   * focusable content. Only read when `keyboardFocusableScrollers` is on.
   * Default `false`, Chromium's rule (AECI-1885).
   */
  readonly scrollersWithFocusableContent?: boolean;
}

/** Parse a `tabindex` value the way HTML does: a leading integer, else invalid. */
export function parseTabindex(raw: string | null): number | null {
  if (raw === null) return null;
  const match = raw.match(/^\s*([+-]?\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Is the element focusable at all, ignoring whether Tab reaches it. */
function isFocusable(el: ElementFacts, opts: Required<CandidateOptions>): boolean {
  if (!el.rendered || !el.visible || el.inert || el.disabled) return false;
  if (el.nativelyFocusable || parseTabindex(el.tabindexAttr) !== null) return true;
  return (
    opts.keyboardFocusableScrollers &&
    el.scroller &&
    (opts.scrollersWithFocusableContent || !el.hasFocusableDescendant)
  );
}

/**
 * The elements a forward Tab walk should reach, in the order it should reach them.
 *
 * `elements` must be in document order. The rules:
 *   - focusable, and a `tabindex` that is absent or not negative;
 *   - positive `tabindex` first, ascending, then the rest in document order;
 *   - one radio per group: the checked one, else the first (a forward walk).
 */
export function candidateTabStops(
  elements: readonly ElementFacts[],
  options: CandidateOptions = {},
): ElementFacts[] {
  const opts: Required<CandidateOptions> = {
    keyboardFocusableScrollers: options.keyboardFocusableScrollers ?? true,
    scrollersWithFocusableContent: options.scrollersWithFocusableContent ?? false,
  };
  const sequential = elements.filter((el) => {
    if (!isFocusable(el, opts)) return false;
    const index = parseTabindex(el.tabindexAttr);
    return index === null || index >= 0;
  });

  // One stop per radio group. The group's checked radio wins over its first.
  const radioWinner = new Map<string, ElementFacts>();
  for (const el of sequential) {
    if (!el.radio) continue;
    const current = radioWinner.get(el.radio.group);
    if (!current || (el.radio.checked && !current.radio?.checked)) {
      radioWinner.set(el.radio.group, el);
    }
  }
  const stops = sequential.filter((el) => !el.radio || radioWinner.get(el.radio.group) === el);

  const positive = stops
    .map((el, order) => ({ el, order, index: parseTabindex(el.tabindexAttr) ?? 0 }))
    .filter((s) => s.index > 0)
    .sort((a, b) => a.index - b.index || a.order - b.order)
    .map((s) => s.el);
  const rest = stops.filter((el) => (parseTabindex(el.tabindexAttr) ?? 0) <= 0);
  return [...positive, ...rest];
}

/** The part of a walked stop the diff reads. `TabStop` in `./tab-walk.ts` satisfies it. */
export interface WalkedStop {
  readonly key: number;
  readonly ariaHidden: boolean;
  /** The focused element had a box of non-zero size. */
  readonly visible: boolean;
}

export interface CandidateDiff<S extends WalkedStop> {
  /** Predicted, but no Tab press reached it. */
  readonly neverReached: ElementFacts[];
  /** Reached, but not predicted. A wrong prediction or an unexpected stop. */
  readonly unexpected: S[];
  /** Reached while hidden: inside `aria-hidden`, or with no visible box. */
  readonly focusableButHidden: S[];
}

/** Diff the predicted stops against the stops a real walk reached. */
export function diffCandidates<S extends WalkedStop>(
  candidates: readonly ElementFacts[],
  walk: readonly S[],
): CandidateDiff<S> {
  const reached = new Set(walk.map((s) => s.key));
  const predicted = new Set(candidates.map((c) => c.key));
  return {
    neverReached: candidates.filter((c) => !reached.has(c.key)),
    unexpected: walk.filter((s) => !predicted.has(s.key)),
    focusableButHidden: walk.filter((s) => s.ariaHidden || !s.visible),
  };
}
