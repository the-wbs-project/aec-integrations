/**
 * AECI-1882: the pure half of the interaction checks. No Playwright, no page.
 * `interaction-rules.unit.spec.ts` pins it in the plain Vitest runner.
 *
 * The browser half is `./interaction-checks.ts`. It reads facts off the page
 * and hands them here to be judged, so each verdict can be tested with known
 * inputs. `docs/TESTING_STRATEGY.md` §8.4.7 describes the checks.
 */

// ── Shared ──────────────────────────────────────────────────────────────────

/**
 * Writes that are telemetry, not something a control did: the page-view beacon
 * and PostHog. A click can send them on any page, so they are not an activation.
 */
export function isTelemetryWrite(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (/(^|\.)posthog\.com$/.test(parsed.hostname)) return true;
  return parsed.pathname.startsWith('/api/page-views');
}

/** Mask numbers so two items of one kind ("3 reviews", "12 reviews") share a signature. */
export function maskDigits(text: string): string {
  return text
    .replace(/\d+([.,]\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Check 2: pointer cancellation (WCAG 2.5.2) ─────────────────────────────

/**
 * What a control can have done, read before and after a press. Focus is left
 * out on purpose: a press focuses a button, and that is not an activation.
 */
export interface ActivationState {
  readonly url: string;
  /** A token set on each new document. A changed token is a full page load. */
  readonly doc: string;
  /** Non-telemetry writes sent so far. */
  readonly writes: number;
  /** Open dialogs, menus and listboxes. */
  readonly popups: number;
  /** Every `aria-expanded`, `aria-pressed`, `aria-checked` and `aria-selected`, checked box and select value, in document order. */
  readonly states: readonly string[];
}

/** The ways two states differ, as plain sentences. Empty when they match. */
export function activationChanges(before: ActivationState, after: ActivationState): string[] {
  const out: string[] = [];
  if (before.doc !== after.doc) out.push('a new document loaded');
  else if (before.url !== after.url) out.push(`the URL changed to ${after.url}`);
  if (after.writes > before.writes) out.push(`${after.writes - before.writes} write(s) were sent`);
  if (after.popups !== before.popups) {
    out.push(`open popups went from ${before.popups} to ${after.popups}`);
  }
  const changed = diffStates(before.states, after.states);
  if (changed.length > 0) out.push(`state changed: ${changed.slice(0, 3).join('; ')}`);
  return out;
}

function diffStates(before: readonly string[], after: readonly string[]): string[] {
  const a = new Set(before);
  const b = new Set(after);
  const gone = before.filter((s) => !b.has(s));
  const added = after.filter((s) => !a.has(s));
  return [...gone.map((s) => `was ${s}`), ...added.map((s) => `now ${s}`)];
}

/**
 * The pointer verdict, from two runs that start in the same state.
 *
 * `pressed` is a press on the control, a move off it and a release. `hovered` is
 * the same pointer path with no press: onto the control and off again. A control
 * that opens on hover (the admin nav, AECI-2099) changes the page in both runs
 * the same way, and that is not an activation. `hovered` is `null` when the
 * pressed run changed nothing, so no second run was needed.
 */
export function pointerCancelVerdict(
  before: ActivationState,
  pressed: ActivationState,
  hovered: { readonly before: ActivationState; readonly after: ActivationState } | null,
): string[] {
  const byPress = activationChanges(before, pressed);
  if (byPress.length === 0) return [];
  if (!hovered) return byPress;
  const byHover = activationChanges(hovered.before, hovered.after);
  return byPress.filter((c) => !byHover.includes(c));
}

// ── Check 3: on input (WCAG 3.2.2) ──────────────────────────────────────────

/**
 * What changing a control did to the page.
 *   - `none`: the page stayed where it was, with focus on the control.
 *   - `url-query`: the address changed only in its query or hash. A listing
 *     filter that writes its state to the URL does this.
 *   - `navigates`: a new path, or a new document.
 *   - `new-window`: a tab or window opened.
 *   - `focus-moved`: focus left the control for another element.
 */
export type OnInputEffect = 'none' | 'url-query' | 'navigates' | 'new-window' | 'focus-moved';

export function onInputEffect(p: {
  readonly beforeUrl: string;
  readonly afterUrl: string;
  readonly sameDocument: boolean;
  readonly newWindows: number;
  /** Focus is on the control, or inside the popup it owns. */
  readonly focusStayed: boolean;
}): OnInputEffect {
  if (p.newWindows > 0) return 'new-window';
  if (!p.sameDocument) return 'navigates';
  const a = new URL(p.beforeUrl);
  const b = new URL(p.afterUrl);
  if (a.origin !== b.origin || a.pathname !== b.pathname) return 'navigates';
  if (a.search !== b.search || a.hash !== b.hash) return 'url-query';
  if (!p.focusStayed) return 'focus-moved';
  return 'none';
}

/** A form control the check changed, as the on-input list matches it. */
export interface ControlFacts {
  /** The nearest custom element around it, `aec-…`. Names the component. */
  readonly host: string;
  readonly role: string;
  readonly tag: string;
  /** `type` of an input, else empty. */
  readonly type: string;
  readonly name: string;
  readonly inSharedChrome: boolean;
}

export type OnInputStatus =
  /** Ruled by Chris: the control may change the page on change. */
  | 'allowed'
  /** Waiting for Chris's ruling. Passes, and is listed in §8.4.7 as pending. */
  | 'pending-ruling';

/** A control allowed to change the page on input, with what it does and why. */
export interface OnInputEntry {
  readonly id: string;
  readonly surfaces: (surfaceId: string) => boolean;
  readonly control: (c: ControlFacts) => boolean;
  readonly effect: Exclude<OnInputEffect, 'none'>;
  readonly status: OnInputStatus;
  /** What the control does on change, in one sentence. */
  readonly does: string;
  /** Why it is listed. */
  readonly why: string;
}

export interface OnInputResult {
  readonly control: ControlFacts;
  /** `null` when the check could not change it. */
  readonly effect: OnInputEffect | null;
  readonly note?: string;
}

export function describeControl(c: Pick<ControlFacts, 'host' | 'role' | 'name'>): string {
  return `${c.host} ${c.role} "${c.name}"`;
}

/**
 * Judge every control the check changed on one surface against the list.
 * Returns the problems and the listed entries that matched, so the test can
 * name the pending ones.
 */
export function judgeOnInput(
  surfaceId: string,
  results: readonly OnInputResult[],
  list: readonly OnInputEntry[],
): { problems: string[]; matched: OnInputEntry[] } {
  const problems: string[] = [];
  const matched = new Set<OnInputEntry>();
  const here = list.filter((e) => e.surfaces(surfaceId));
  for (const r of results) {
    if (r.effect === null) {
      problems.push(
        `${describeControl(r.control)}: could not be changed (${r.note ?? 'no reason'})`,
      );
      continue;
    }
    if (r.effect === 'none') continue;
    const entry = here.find((e) => e.control(r.control));
    if (!entry) {
      problems.push(`${describeControl(r.control)}: changing it ${r.effect} and it is not listed`);
      continue;
    }
    if (entry.effect !== r.effect) {
      problems.push(
        `${describeControl(r.control)}: listed as ${entry.id} (${entry.effect}) but it ${r.effect}`,
      );
      continue;
    }
    matched.add(entry);
  }
  // A listed control that was changed here and did nothing is a stale entry.
  for (const e of here) {
    const hits = results.filter((r) => r.effect !== null && e.control(r.control));
    if (hits.length > 0 && hits.every((r) => r.effect === 'none')) {
      problems.push(`${e.id} is listed but no longer changes the page here: remove it`);
    }
  }
  return { problems, matched: [...matched] };
}

// ── Check 4: character shortcuts (WCAG 2.1.4) ───────────────────────────────

export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly scroll: string;
  readonly focus: string;
  readonly popups: number;
  readonly elements: number;
  readonly text: string;
}

/**
 * The differences a key press made. `churns` is true when the page changed its
 * own text or element count with no key pressed (a clock, a poll), so those two
 * are not compared.
 */
export function snapshotChanges(a: PageSnapshot, b: PageSnapshot, churns: boolean): string[] {
  const out: string[] = [];
  if (a.url !== b.url) out.push(`the URL changed to ${b.url}`);
  if (a.title !== b.title) out.push(`the title changed to "${b.title}"`);
  if (a.scroll !== b.scroll) out.push(`the page scrolled from ${a.scroll} to ${b.scroll}`);
  if (a.focus !== b.focus) out.push(`focus moved from ${a.focus} to ${b.focus}`);
  if (a.popups !== b.popups) out.push(`open popups went from ${a.popups} to ${b.popups}`);
  if (!churns) {
    if (a.elements !== b.elements) out.push(`elements went from ${a.elements} to ${b.elements}`);
    else if (a.text !== b.text) out.push('the text of the page changed');
  }
  return out;
}

// ── Check 5: motion (WCAG 2.2.2, and reduced motion) ────────────────────────

/** One animation or transition the recorder saw, as `getComputedTiming()` gave it. */
export interface RecordedAnimation {
  readonly kind: string;
  /** The CSS animation name, the transitioned property, or the WAAPI id. */
  readonly name: string;
  readonly target: string;
  readonly iterations: number;
  /** One iteration, in ms. */
  readonly duration: number;
  /** All iterations, in ms. `Infinity` for an endless one. */
  readonly activeDuration: number;
}

/** WCAG 2.2.2: moving content that starts on its own and lasts more than 5 seconds. */
export const MOTION_LIMIT_MS = 5_000;
/**
 * Under `prefers-reduced-motion: reduce` the global block in `styles.css` makes
 * every animation and transition 0.01ms. A motion this short reads as no motion.
 */
export const REDUCED_MOTION_LIMIT_MS = 100;

export function describeAnimation(a: RecordedAnimation): string {
  const length = Number.isFinite(a.activeDuration)
    ? `${Math.round(a.activeDuration)}ms`
    : `endless, ${Math.round(a.duration)}ms a loop`;
  return `${a.kind} "${a.name}" on ${a.target} (${length})`;
}

/** Longer than 5 seconds, endless included. */
export function isLongMotion(a: Pick<RecordedAnimation, 'activeDuration'>): boolean {
  return a.activeDuration > MOTION_LIMIT_MS;
}

/** Every motion longer than the reduced-motion limit, once per target and name. */
export function reducedMotionProblems(seen: readonly RecordedAnimation[]): string[] {
  const out = new Set<string>();
  for (const a of seen) {
    if (a.activeDuration > REDUCED_MOTION_LIMIT_MS) out.add(describeAnimation(a));
  }
  return [...out];
}
