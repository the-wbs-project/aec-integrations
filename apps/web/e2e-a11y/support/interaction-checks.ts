/**
 * AECI-1882: the interaction checks, run on one loaded surface.
 *
 * Each check returns its problems as plain sentences and asserts nothing.
 * `../interaction.spec.ts` judges them, so a known barrier can cover the
 * problems it names and nothing else. The checks and their WCAG criteria are in
 * `docs/TESTING_STRATEGY.md` §8.4.7. The pure verdicts are `./interaction-rules.ts`.
 *
 * No check calls `el.focus()` to walk a page. The on-input check focuses the
 * control it is about to change, because what it tests is the change, not how
 * focus got there.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { EXCLUDED_DOM } from '../../e2e/axe-sweep';
import { GATE_TAGS, REPORT_TAGS, partitionViolations } from '../../e2e/axe-summary';
import { untilAppStable } from '../../e2e/hydration';
import { blurActive } from './focus-probe';
import {
  activationState,
  controlValue,
  focusStayedWith,
  hoverTriggers,
  inputTargets,
  newContent,
  overflowsViewport,
  pageSnapshot,
  parkingSpot,
  pointerTargets,
  pressPoints,
  recordedAnimations,
  rememberShown,
  runningLongMotions,
  stillShown,
  type InputTarget,
} from './interaction-probe';
import {
  MOTION_LIMIT_MS,
  describeAnimation,
  describeControl,
  onInputEffect,
  pointerCancelVerdict,
  reducedMotionProblems,
  snapshotChanges,
  type OnInputResult,
} from './interaction-rules';
import { focusFacts, locatorForKey } from './probe';

/** What every check needs from the spec. */
export interface CheckContext {
  readonly page: Page;
  /** The site header and footer are checked here (`headerOwnerFor`). */
  readonly checksSharedChrome: boolean;
  /** Non-telemetry writes the page has sent. The guard aborts them all. */
  readonly writes: () => number;
  /** Windows and tabs the page has opened. */
  readonly popups: () => number;
  /** Load the surface again and wait for the hydration gate. */
  readonly reload: () => Promise<void>;
  /** Notes for the test's annotations: what each check looked at. */
  readonly notes: string[];
}

/** The 768px viewport of AECI-1846, where a tooltip pushed the home page sideways. */
export const NARROW_VIEWPORT = { width: 768, height: 1024 } as const;

async function park(page: Page): Promise<void> {
  const spot = await parkingSpot(page);
  await page.mouse.move(spot.x, spot.y);
}

/**
 * Wait out hover timers after the pointer moves: the Browse menu opens after
 * 70ms and closes 260ms after the pointer leaves. A negative assertion (nothing
 * else opens, nothing closes) needs a window, and there is no event to wait on.
 */
async function hoverSettle(page: Page): Promise<void> {
  // A fixed window on purpose: it must outlast the longest hover timer in the app.
  await page.waitForTimeout(400);
}

async function focusLabel(page: Page): Promise<string> {
  const f = await focusFacts(page);
  return f.key === null ? 'the page body' : `${f.tag} (key ${f.key})`;
}

// ── Check 1: content on hover (WCAG 1.4.13) ─────────────────────────────────

async function hoverPass(ctx: CheckContext, where: string): Promise<string[]> {
  const { page } = ctx;
  const problems: string[] = [];
  const found = await hoverTriggers(page);
  const triggers = found.triggers.filter((t) => ctx.checksSharedChrome || !t.inSharedChrome);
  const elsewhere = found.triggers.length - triggers.length;
  ctx.notes.push(
    `hover, ${where}: ${triggers.length} trigger(s) checked, ${found.noBox} listener(s) passed over for having no box` +
      (elsewhere > 0
        ? `, ${elsewhere} in the site header or footer checked on another surface`
        : ''),
  );
  for (const t of triggers) {
    const points = await pressPoints(page, t.key);
    if ('skip' in points) {
      ctx.notes.push(`hover, ${where}: ${t.label} not checked, ${points.skip}`);
      continue;
    }
    await park(page);
    await hoverSettle(page);
    await rememberShown(page);
    await page.mouse.move(points.centre.x, points.centre.y, { steps: 2 });
    const shown = await expect
      .poll(async () => (await newContent(page, t.key)).keys.length, { timeout: 1_500 })
      .toBeGreaterThan(0)
      .then(() => true)
      .catch(() => false);
    if (!shown) {
      ctx.notes.push(`hover, ${where}: ${t.label} shows nothing on hover`);
      continue;
    }
    const content = await newContent(page, t.key);
    const what = `${t.label} (${where}) shows ${content.label} on hover`;
    ctx.notes.push(`hover, ${where}: ${t.label} shows ${content.label}`);
    if (where !== 'desktop' && content.union) {
      const overflow = await overflowsViewport(page, content.union);
      if (overflow) problems.push(`${what}: ${overflow}`);
    }
    // Hoverable: the pointer moves from the trigger onto the content.
    const target = content.main;
    if (!target) {
      problems.push(`${what}: no part of it takes the pointer, so it cannot be hovered`);
      await park(page);
      continue;
    }
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
      steps: 8,
    });
    await hoverSettle(page);
    if (!(await stillShown(page, content.keys))) {
      problems.push(`${what}: it closes when the pointer moves onto it (not hoverable)`);
      await park(page);
      continue;
    }
    // Dismissible: Escape closes it with the pointer still on it, and focus stays.
    const before = await focusLabel(page);
    await page.keyboard.press('Escape');
    const closed = await expect
      .poll(() => stillShown(page, content.keys), { timeout: 1_000 })
      .toBe(false)
      .then(() => true)
      .catch(() => false);
    if (!closed) problems.push(`${what}: Escape does not close it while the pointer is on it`);
    const after = await focusLabel(page);
    if (after !== before) problems.push(`${what}: Escape moved focus from ${before} to ${after}`);
    await park(page);
    await hoverSettle(page);
    if (await stillShown(page, content.keys)) await ctx.reload();
  }
  return problems;
}

/**
 * Every element with a hover listener: point at it, and when content appears,
 * move the pointer onto the content (it must stay), then press Escape (it must
 * close, and focus must not move). Then the same at 768px wide, where the
 * content must also stay inside the viewport.
 */
export async function checkHoverContent(ctx: CheckContext): Promise<string[]> {
  const { page } = ctx;
  const problems = await hoverPass(ctx, 'desktop');
  const size = page.viewportSize();
  await page.setViewportSize(NARROW_VIEWPORT);
  try {
    await untilAppStable(page, 30_000);
    problems.push(...(await hoverPass(ctx, `${NARROW_VIEWPORT.width}px`)));
  } finally {
    if (size) await page.setViewportSize(size);
    await untilAppStable(page, 30_000);
  }
  return problems;
}

// ── Check 2: pointer cancellation (WCAG 2.5.2) ──────────────────────────────

/** At most this many controls a surface, so a long listing stays inside the budget. */
const POINTER_TARGET_CAP = 60;

/**
 * One control of each kind: press it, move off it to a spot with nothing
 * interactive, let go. Nothing may happen. When something does, the same
 * pointer path with no press runs from a fresh load, and only what the press
 * added counts (a control that opens on hover changes the page either way).
 */
export async function checkPointerCancellation(ctx: CheckContext): Promise<string[]> {
  const { page } = ctx;
  const problems: string[] = [];
  const all = (await pointerTargets(page)).filter(
    (t) => ctx.checksSharedChrome || !t.inSharedChrome,
  );
  const targets = all.slice(0, POINTER_TARGET_CAP);
  if (all.length > targets.length) {
    ctx.notes.push(
      `pointer: ${all.length - targets.length} kinds of control past the cap not checked`,
    );
  }
  ctx.notes.push(`pointer: ${targets.length} kinds of control checked`);
  for (const signature of targets.map((t) => t.signature)) {
    const t = (await pointerTargets(page)).find((x) => x.signature === signature);
    if (!t) continue;
    const pressed = await pressAndCancel(ctx, t.key, true);
    if ('skip' in pressed) {
      ctx.notes.push(`pointer: ${t.label} not checked, ${pressed.skip}`);
      continue;
    }
    if (pointerCancelVerdict(pressed.before, pressed.after, null).length === 0) continue;
    await ctx.reload();
    const again = (await pointerTargets(page)).find((x) => x.signature === signature);
    const hovered = again ? await pressAndCancel(ctx, again.key, false) : null;
    const verdict = pointerCancelVerdict(
      pressed.before,
      pressed.after,
      hovered && !('skip' in hovered) ? hovered : null,
    );
    if (verdict.length > 0) {
      problems.push(`${t.label}: press, move off and release, and ${verdict.join(', ')}`);
    }
    await ctx.reload();
  }
  return problems;
}

async function pressAndCancel(ctx: CheckContext, key: number, press: boolean) {
  const { page } = ctx;
  const points = await pressPoints(page, key);
  if ('skip' in points) return points;
  if (!points.away) return { skip: 'no point near it is free of other controls' };
  await page.mouse.move(points.away.x, points.away.y);
  await hoverSettle(page);
  const before = await activationState(page, ctx.writes());
  await page.mouse.move(points.centre.x, points.centre.y, { steps: 2 });
  // Both runs dwell on the control, so a hover timer (the Browse menu opens
  // after 70ms) fires in both, and only the press differs between them.
  await hoverSettle(page);
  if (press) await page.mouse.down();
  await page.mouse.move(points.away.x, points.away.y, { steps: 4 });
  if (press) await page.mouse.up();
  await hoverSettle(page);
  await page.waitForLoadState('domcontentloaded');
  return { before, after: await activationState(page, ctx.writes()) };
}

// ── Check 3: on input (WCAG 3.2.2) ──────────────────────────────────────────

/**
 * Change each form control once, by keyboard, and record what the page did.
 * One control of each kind in each component: one box of a filter group, one
 * of each select. `../support/on-input-list.ts` judges the results.
 */
export async function checkOnInput(ctx: CheckContext): Promise<OnInputResult[]> {
  const { page } = ctx;
  const results: OnInputResult[] = [];
  const first = (await inputTargets(page)).filter(
    (t) => ctx.checksSharedChrome || !t.inSharedChrome,
  );
  for (let i = 0; i < first.length; i++) {
    const t = (await inputTargets(page)).filter((x) => ctx.checksSharedChrome || !x.inSharedChrome)[
      i
    ];
    if (!t || t.host !== first[i].host || t.role !== first[i].role) {
      results.push({ control: first[i], effect: null, note: 'not found again after a reload' });
      continue;
    }
    const result = await changeOnce(ctx, t);
    results.push(result);
    if (result.effect !== 'none') await ctx.reload();
  }
  return results;
}

async function changeOnce(ctx: CheckContext, t: InputTarget): Promise<OnInputResult> {
  const { page } = ctx;
  const control = await locatorForKey(page, t.key);
  if (!control) return { control: t, effect: null, note: 'it left the page' };
  await control.scrollIntoViewIfNeeded();
  const beforeUrl = page.url();
  const beforeDoc = (await activationState(page, 0)).doc;
  const windows = ctx.popups();
  const before = await controlValue(page, t.key);
  await control.focus();
  switch (t.action) {
    case 'toggle':
      await page.keyboard.press('Space');
      break;
    case 'select': {
      const next = await control.evaluate((s) => {
        if (!(s instanceof HTMLSelectElement)) return null;
        const other = Array.from(s.options).find((o) => !o.disabled && o.value !== s.value);
        return other?.value ?? null;
      });
      if (next === null) return { control: t, effect: null, note: 'it has one option' };
      await control.selectOption(next);
      break;
    }
    case 'pick': {
      await page.keyboard.press('Enter');
      // The list listens only once it is open and its active option is set
      // (TESTING_STRATEGY §14.3). Gate each key on the state it should change.
      await expect(control)
        .toHaveAttribute('aria-expanded', 'true', { timeout: 3_000 })
        .catch(() => undefined);
      await expect(page.getByRole('option').first())
        .toBeVisible({ timeout: 3_000 })
        .catch(() => undefined);
      const active = () => control.getAttribute('aria-activedescendant');
      const first = await active();
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(active, { timeout: 2_000 })
        .not.toBe(first)
        .catch(() => undefined);
      await page.keyboard.press('Enter');
      break;
    }
    case 'type':
      await page.keyboard.type('a');
      break;
    case 'type-number':
      await page.keyboard.type('1');
      break;
  }
  // A negative assertion: a control that navigates on change does it within a
  // second. There is no event for "nothing happened".
  await page.waitForTimeout(1_000);
  await page.waitForLoadState('domcontentloaded');
  const afterDoc = (await activationState(page, 0)).doc;
  const sameDocument = afterDoc === beforeDoc;
  const effect = onInputEffect({
    beforeUrl,
    afterUrl: page.url(),
    sameDocument,
    newWindows: ctx.popups() - windows,
    focusStayed: sameDocument && (await focusStayedWith(page, t.key)),
  });
  if (effect === 'none' && t.action === 'pick' && (await controlValue(page, t.key)) === before) {
    return { control: t, effect: null, note: 'Enter, ArrowDown, Enter chose nothing' };
  }
  if (effect === 'none') await undo(page, t);
  return { control: t, effect };
}

/** Put a changed control back, by keyboard, when the change did nothing else. */
async function undo(page: Page, t: InputTarget): Promise<void> {
  if (t.action === 'toggle') await page.keyboard.press('Space');
  if (t.action === 'type' || t.action === 'type-number') {
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
  }
}

export function describeOnInput(r: OnInputResult): string {
  return `${describeControl(r.control)}: ${r.effect ?? `not changed (${r.note})`}`;
}

// ── Check 4: character shortcuts (WCAG 2.1.4) ───────────────────────────────

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * With focus on `body`, press a to z. The URL, focus and the page must not
 * change, and no write may be sent: a shortcut can act with no visible change.
 */
export async function checkCharacterShortcuts(ctx: CheckContext): Promise<string[]> {
  const { page } = ctx;
  await blurActive(page);
  await park(page);
  await hoverSettle(page);
  const a = await pageSnapshot(page);
  // A stability sample needs a gap: does the page change with no key pressed?
  await page.waitForTimeout(1_000);
  const b = await pageSnapshot(page);
  const writesBefore = ctx.writes();
  const churns = a.elements !== b.elements || a.text !== b.text;
  if (churns) ctx.notes.push('shortcuts: the page changes on its own, so text is not compared');
  const changed = (at: string, changes: string[]): string[] => {
    const writes = ctx.writes() - writesBefore;
    const all = writes > 0 ? [...changes, `${writes} write(s) were sent`] : changes;
    return all.length > 0 ? [`${at} on the page body: ${all.join(', ')}`] : [];
  };
  for (const letter of LETTERS) {
    await page.keyboard.press(letter);
    const found = changed(`"${letter}"`, snapshotChanges(b, await pageSnapshot(page), churns));
    if (found.length > 0) {
      await ctx.reload();
      return found;
    }
  }
  // A key's effect can land a frame or a navigation later. Give it one window.
  await page.waitForTimeout(500);
  const found = changed('a to z', snapshotChanges(b, await pageSnapshot(page), churns));
  if (found.length > 0) await ctx.reload();
  return found;
}

// ── Check 5: motion (WCAG 2.2.2) ────────────────────────────────────────────

/**
 * No animation that runs more than 5 seconds, or forever, is still running on
 * a drawn element 5 seconds after it started. A spinner that is gone by then
 * passes.
 */
export async function checkMotion(ctx: CheckContext): Promise<string[]> {
  const { page } = ctx;
  const first = await runningLongMotions(page, MOTION_LIMIT_MS);
  if (first.length === 0) return [];
  const youngest = Math.min(...first.map((m) => m.ranMs));
  // Wait until the youngest long motion has run its 5 seconds, then look again.
  if (youngest < MOTION_LIMIT_MS) await page.waitForTimeout(MOTION_LIMIT_MS - youngest + 100);
  const still = await runningLongMotions(page, MOTION_LIMIT_MS);
  return [
    ...new Set(
      still
        .filter((m) => m.ranMs >= MOTION_LIMIT_MS)
        .map((m) => `${describeAnimation(m)} has run ${Math.round(m.ranMs / 1000)}s with no stop`),
    ),
  ];
}

/** Under reduced motion: every animation the document ran, from its first frame, is short. */
export async function checkReducedMotion(ctx: CheckContext): Promise<string[]> {
  const seen = await recordedAnimations(ctx.page);
  ctx.notes.push(`reduced motion: ${seen.length} animations and transitions recorded`);
  return reducedMotionProblems(seen);
}

// ── Check 6: forced colours (axe, WCAG A and AA) ───────────────────────────

/**
 * axe with the sweep's tags and exclusions (`e2e/axe-sweep.ts`), on a page
 * loaded with `forcedColors: 'active'`. Gate rules are problems. Report-only
 * rules go to the notes.
 */
export async function checkForcedColoursAxe(ctx: CheckContext): Promise<string[]> {
  let builder = new AxeBuilder({ page: ctx.page })
    .withTags([...GATE_TAGS, ...REPORT_TAGS])
    // Under forced colours the reader's palette replaces the author's colours,
    // so the contrast rules measure colours nobody sees. The sweep scans
    // contrast with forced colours off (`docs/TESTING_STRATEGY.md` §8.2).
    .disableRules(['color-contrast', 'color-contrast-enhanced']);
  for (const { selector } of EXCLUDED_DOM) builder = builder.exclude(selector);
  const results = await builder.analyze();
  const { gate, report } = partitionViolations(results.violations);
  for (const f of report)
    ctx.notes.push(`forced colours axe, report only: ${f.id} on ${f.targets.join(', ')}`);
  return gate.map(
    (f) =>
      `${f.id} (${f.impact ?? 'no impact'}): ${f.help}. ${f.nodes} node(s): ${f.targets.join(', ')}`,
  );
}
