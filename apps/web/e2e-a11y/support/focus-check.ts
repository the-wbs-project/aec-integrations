/**
 * AECI-1878: the focus ring checks for one Tab walk. `../focus-ring.spec.ts`
 * runs them on every surface and decides what is a failure. The four checks
 * are described there and in `docs/TESTING_STRATEGY.md` §8.4.5.
 */
import type { Page } from '@playwright/test';
import {
  boundaryVerdict,
  changedRegions,
  decodePng,
  groundAround,
  measureIndicator,
  requiredIndicatorPixels,
  sameRect,
  strongestInside,
  toHex,
  type Rect,
} from './focus-pixels';
import {
  blurActive,
  prepareBaseline,
  readFocused,
  restoreScroll,
  shoot,
  type FocusedRead,
  type StopState,
} from './focus-probe';
import { describeStop } from './overlay-check';
import { tabWalk, type TabStop } from './tab-walk';

export type FocusCheck = 'visible' | 'contrast' | 'obscured' | 'boundary' | 'unmeasured';

export interface FocusFinding {
  readonly check: FocusCheck;
  readonly stop: TabStop;
  readonly detail: string;
}

export function formatFinding(f: FocusFinding): string {
  return `${f.check}: ${f.stop.landmark} ${describeStop(f.stop)} (stop ${f.stop.index}): ${f.detail}`;
}

/**
 * Why a stop got no verdict. Only the first two are expected: an iframe draws
 * its own focus, and a stop with no box has nothing to picture (the keyboard
 * suite fails that one). Every other reason is a failure of the check, and
 * `measureWalk` reports it as an `unmeasured` finding, so a walk cannot
 * quietly measure fewer stops.
 */
export type UnmeasuredReason =
  | 'iframe'
  | 'no box'
  | 'focus moved before it was read'
  | 'the stop moved or resized between its pictures'
  | 'the stop left the page before its unfocused picture'
  | 'the scroll position could not be restored'
  | 'focus never moved clear of the stop'
  | 'no ground round the control';

/** The reasons a stop may go unmeasured without failing its test. */
export const EXPECTED_UNMEASURED: ReadonlySet<UnmeasuredReason> = new Set(['iframe', 'no box']);

export interface Unmeasured {
  readonly stop: TabStop;
  readonly reason: UnmeasuredReason;
  readonly detail: string;
}

interface Pending {
  readonly stop: TabStop;
  readonly read: FocusedRead & { clip: NonNullable<FocusedRead['clip']> };
  readonly focused: Buffer;
}

export interface Measured {
  readonly end: string;
  /** Every finding, including an `unmeasured` one for each unexpected reason. */
  readonly findings: FocusFinding[];
  /** Stops that reached the four checks. Any of them that then got no verdict is in `unmeasured`. */
  readonly measured: number;
  /** Site header and footer stops that ran only the obscured check here. */
  readonly sharedChromeHitTestOnly: number;
  /** Every stop that got no verdict, expected or not. */
  readonly unmeasured: Unmeasured[];
}

function fmt(r: Rect): string {
  return `${r.x.toFixed(2)},${r.y.toFixed(2)} ${r.width.toFixed(2)}x${r.height.toFixed(2)}`;
}

/**
 * What changed between the two pictures for a reason other than focus.
 * Other elements that appeared, went, moved or changed (an error rendered on
 * blur). And the stop's own box, when its own attributes or text changed:
 * `aria-invalid` and a red edge on blur are not a ring.
 */
function notFocus(focused: StopState, unfocused: StopState): Rect[] {
  const out = changedRegions(focused.region, unfocused.region);
  if (focused.sig !== unfocused.sig) out.push(focused.ownBox);
  return out;
}

/**
 * A stop that is visually hidden until it has focus, as the skip link is. Its
 * box goes from a pixel or less to a full box, and that change is its focus
 * indicator, not a layout shift. Its pictures are compared as they are.
 */
function appearsOnFocus(focused: StopState, unfocused: StopState): boolean {
  const area = (r: Rect) => r.width * r.height;
  return area(unfocused.ownBox) <= 4 && area(focused.ownBox) > 4;
}

/** Judge one stop from its two pictures and the two reads that came with them. */
function judge(p: Pending, unfocusedPng: Buffer, after: StopState): FocusFinding[] {
  const out: FocusFinding[] = [];
  const focused = decodePng(p.focused);
  const unfocused = decodePng(unfocusedPng);
  const m = measureIndicator(focused, unfocused, notFocus(p.read.state, after));
  const outline = `outline ${p.read.outline}`;
  const masked = m.excluded > 0 ? `, ${m.excluded} changed pixels left out as not focus` : '';
  if (m.changed === 0) {
    out.push({
      check: 'visible',
      stop: p.stop,
      detail: `nothing but blur changes the picture (${outline}${masked})`,
    });
  } else {
    const required = requiredIndicatorPixels(p.read.box, p.read.visibleBox ?? p.read.box);
    if (m.strong < required) {
      out.push({
        check: 'contrast',
        stop: p.stop,
        detail:
          `${m.strong} of ${m.changed} changed pixels reach 3:1, ${required} needed. ` +
          `Best ${m.best.toFixed(2)}:1 (${outline}${masked})`,
      });
    }
  }
  const control = p.read.control;
  if (control) {
    const ground = groundAround(unfocused, control.boxInClip);
    if (!ground) {
      out.push({ check: 'unmeasured', stop: p.stop, detail: 'no ground round the control' });
    } else {
      const verdict = boundaryVerdict({
        ground,
        borders: control.borders,
        fill: control.fill,
        drawnBox: control.drawnByBrowser
          ? strongestInside(unfocused, control.boxInClip, ground)
          : null,
      });
      if (!verdict.pass) {
        out.push({
          check: 'boundary',
          stop: p.stop,
          detail:
            `the ${control.kind} edge is ${verdict.best.toFixed(2)}:1 at best (${verdict.by}) ` +
            `on the ground ${toHex(ground)}`,
        });
      }
    }
  }
  return out;
}

/**
 * Take the unfocused picture of every pending stop that the focused element's
 * ring is clear of. A stop that is blocked, or whose scroll position cannot be
 * put back exactly, waits for a later stop. A stop that moved or resized is
 * not compared at all.
 */
async function takeBaselines(
  page: Page,
  pending: Pending[],
  findings: FocusFinding[],
  unmeasured: (stop: TabStop, reason: UnmeasuredReason, detail?: string) => void,
  focusedKey: number | null,
  final: boolean,
): Promise<void> {
  for (let i = 0; i < pending.length; ) {
    const p = pending[i];
    if (p.stop.key === focusedKey) {
      i++;
      continue;
    }
    const setup = await prepareBaseline(page, p.read.scroll, p.read.clip, p.stop.key);
    if (setup.blocked || setup.moved) {
      await restoreScroll(page, setup.saved);
      if (final) {
        unmeasured(
          p.stop,
          setup.moved
            ? 'the scroll position could not be restored'
            : 'focus never moved clear of the stop',
        );
        pending.splice(i, 1);
      } else {
        i++;
      }
      continue;
    }
    const after = setup.state;
    if (!after) {
      await restoreScroll(page, setup.saved);
      unmeasured(p.stop, 'the stop left the page before its unfocused picture');
      pending.splice(i, 1);
      continue;
    }
    if (
      !appearsOnFocus(p.read.state, after) &&
      (!sameRect(after.box, p.read.state.box) || !sameRect(after.ownBox, p.read.state.ownBox))
    ) {
      await restoreScroll(page, setup.saved);
      unmeasured(
        p.stop,
        'the stop moved or resized between its pictures',
        `${fmt(p.read.state.box)} focused, ${fmt(after.box)} unfocused`,
      );
      pending.splice(i, 1);
      continue;
    }
    const unfocused = await shoot(page, p.read.clip);
    await restoreScroll(page, setup.saved);
    for (const f of judge(p, unfocused, after)) {
      if (f.check === 'unmeasured') unmeasured(f.stop, 'no ground round the control');
      else findings.push(f);
    }
    pending.splice(i, 1);
  }
}

/**
 * Walk the page once with real Tab presses and run the checks at every stop.
 *
 * `checksSharedChrome` is true on the one surface per persona that measures
 * the site header and footer in full (`headerOwnerFor`). They are the same
 * components on every page, so elsewhere their stops run only the obscured
 * check, which needs no picture: a page of its own can still cover them.
 */
export async function measureWalk(page: Page, checksSharedChrome: boolean): Promise<Measured> {
  const findings: FocusFinding[] = [];
  const pending: Pending[] = [];
  const skipped: Unmeasured[] = [];
  let measured = 0;
  let sharedChromeHitTestOnly = 0;

  const unmeasured = (stop: TabStop, reason: UnmeasuredReason, detail = '') => {
    skipped.push({ stop, reason, detail });
    if (!EXPECTED_UNMEASURED.has(reason)) {
      findings.push({
        check: 'unmeasured',
        stop,
        detail: detail ? `${reason}: ${detail}` : reason,
      });
    }
  };

  const walk = await tabWalk(page, {
    // In Firefox, which does not wrap, end at the last stop: a wrap by hand would
    // Shift+Tab up the whole page before the last unfocused pictures are taken.
    atDocumentEnd: 'stop',
    onStop: async (stop) => {
      if (stop.tag === 'iframe') {
        unmeasured(stop, 'iframe');
        return;
      }
      if (!stop.visible) {
        unmeasured(stop, 'no box');
        return;
      }
      const read = await readFocused(page);
      if (!read || read.key !== stop.key) {
        unmeasured(stop, 'focus moved before it was read');
        return;
      }
      if (!read.hit.ok) {
        findings.push({
          check: 'obscured',
          stop,
          detail: `elementFromPoint at its centre is ${read.hit.found}`,
        });
      }
      if (read.inSharedChrome && !checksSharedChrome) {
        sharedChromeHitTestOnly++;
        return;
      }
      measured++;
      if (!read.clip) {
        findings.push({ check: 'visible', stop, detail: 'no part of it is on screen' });
        return;
      }
      const clip = read.clip;
      pending.push({ stop, read: { ...read, clip }, focused: await shoot(page, clip) });
      await takeBaselines(page, pending, findings, unmeasured, stop.key, false);
    },
  });

  await blurActive(page);
  await takeBaselines(page, pending, findings, unmeasured, null, true);
  findings.sort((a, b) => a.stop.index - b.stop.index);
  skipped.sort((a, b) => a.stop.index - b.stop.index);
  return { end: walk.end, findings, measured, sharedChromeHitTestOnly, unmeasured: skipped };
}
