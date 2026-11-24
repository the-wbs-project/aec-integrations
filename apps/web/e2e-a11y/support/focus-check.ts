/**
 * AECI-1878: the focus ring checks for one Tab walk. `../focus-ring.spec.ts`
 * runs them on every surface and decides what is a failure. The four checks
 * are described there and in `docs/TESTING_STRATEGY.md` §8.4.5.
 */
import type { Page } from '@playwright/test';
import {
  boundaryVerdict,
  decodePng,
  groundAround,
  measureIndicator,
  requiredIndicatorPixels,
  strongestInside,
  toHex,
} from './focus-pixels';
import {
  blurActive,
  prepareBaseline,
  readFocused,
  restoreScroll,
  shoot,
  type FocusedRead,
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

interface Pending {
  readonly stop: TabStop;
  readonly read: FocusedRead & { clip: NonNullable<FocusedRead['clip']> };
  readonly focused: Buffer;
}

export interface Measured {
  readonly end: string;
  readonly findings: FocusFinding[];
  /** Stops with all four checks. */
  readonly measured: number;
  /** Site header and footer stops that ran only the obscured check here. */
  readonly sharedChromeHitTestOnly: number;
  readonly notMeasured: string[];
}

/** Judge one stop from its two pictures. */
function judge(p: Pending, unfocusedPng: Buffer): FocusFinding[] {
  const out: FocusFinding[] = [];
  const focused = decodePng(p.focused);
  const unfocused = decodePng(unfocusedPng);
  const m = measureIndicator(focused, unfocused);
  const outline = `outline ${p.read.outline}`;
  if (m.changed === 0) {
    out.push({
      check: 'visible',
      stop: p.stop,
      detail: `focused and unfocused pictures are identical (${outline})`,
    });
  } else {
    const required = requiredIndicatorPixels(p.read.box, p.read.visibleBox ?? p.read.box);
    if (m.strong < required) {
      out.push({
        check: 'contrast',
        stop: p.stop,
        detail:
          `${m.strong} of ${m.changed} changed pixels reach 3:1, ${required} needed. ` +
          `Best ${m.best.toFixed(2)}:1 (${outline})`,
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
 * ring is clear of. A stop that is blocked waits for a later stop.
 */
async function takeBaselines(
  page: Page,
  pending: Pending[],
  findings: FocusFinding[],
  focusedKey: number | null,
  final: boolean,
): Promise<void> {
  for (let i = 0; i < pending.length; ) {
    const p = pending[i];
    if (p.stop.key === focusedKey) {
      i++;
      continue;
    }
    const setup = await prepareBaseline(page, p.read.scroll, p.read.clip);
    if (setup.blocked || setup.moved) {
      await restoreScroll(page, setup.saved);
      if (final) {
        findings.push({
          check: 'unmeasured',
          stop: p.stop,
          detail: setup.moved
            ? 'the page could not be scrolled back to where the stop was focused'
            : 'focus could not be moved clear of the stop',
        });
        pending.splice(i, 1);
      } else {
        i++;
      }
      continue;
    }
    const unfocused = await shoot(page, p.read.clip);
    await restoreScroll(page, setup.saved);
    findings.push(...judge(p, unfocused));
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
  const notMeasured: string[] = [];
  let measured = 0;
  let sharedChromeHitTestOnly = 0;

  const walk = await tabWalk(page, {
    onStop: async (stop) => {
      if (stop.tag === 'iframe') {
        notMeasured.push(`${describeStop(stop)}: an iframe, its document draws its own focus`);
        return;
      }
      if (!stop.visible) {
        // The keyboard suite fails a stop with no box (`focusableButHidden`).
        notMeasured.push(`${describeStop(stop)}: no box`);
        return;
      }
      const read = await readFocused(page);
      if (!read || read.key !== stop.key) {
        findings.push({ check: 'unmeasured', stop, detail: 'focus moved before it was measured' });
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
      await takeBaselines(page, pending, findings, stop.key, false);
    },
  });

  await blurActive(page);
  await takeBaselines(page, pending, findings, null, true);
  findings.sort((a, b) => a.stop.index - b.stop.index);
  return { end: walk.end, findings, measured, sharedChromeHitTestOnly, notMeasured };
}
