/**
 * AECI-1881: scripted stand-ins for screen magnification, on every manifest surface.
 *
 * Six checks, in two page loads per surface. A load is the slow part, so the
 * checks that cannot disturb each other share one:
 *
 *   narrow  Load at 390 by 844, then turn to 844 by 390, as a phone turns.
 *           1. Orientation (WCAG 1.3.4) at both: `main` is shown, nothing from
 *              `main` up to `html` is rotated, and no script called
 *              `screen.orientation.lock`.
 *           Then 320 by 640, with everything that renders on scroll loaded:
 *           2. Reflow (WCAG 1.4.10): the page root does not scroll sideways
 *              (`scrollWidth <= clientWidth + 1`), and nothing inside it scrolls
 *              sideways unless `SCROLLER_ALLOW_LIST` says why.
 *           Then 315 by 256 at four device pixels per CSS pixel, which is 400%
 *           zoom on a 1280 by 1024 window less a classic scrollbar (`ZOOM_400`):
 *           3. 400% zoom (WCAG 1.4.10, 1.4.4): no sideways scroll, and the
 *              clip detector finds nothing.
 *   wide    Load at 1280 by 800.
 *           4. 200% text (WCAG 1.4.4): `html { font-size: 200% }`, then the
 *              clip detector.
 *           5. Text spacing (WCAG 1.4.12): line height 1.5, letter spacing
 *              0.12em, word spacing 0.16em, paragraph spacing 2em, then the
 *              clip detector. The 200% style is gone first.
 *
 *   6. The clip detector (`support/magnify-geometry.ts`) flags text cut off by
 *      a box that hides its overflow, and text painted over other text.
 *
 * The wide load measures the clip detector once before any override, so a
 * problem that is there at 100% says so. It still counts: a cut at 100% is
 * still a cut at 200%.
 *
 * Every problem is a string that starts with its check. `KNOWN_PROBLEMS` covers
 * real barriers, narrowed by `matches`, so a new problem on a marked surface
 * still fails. `CLIP_ALLOW_LIST` and `SCROLLER_ALLOW_LIST` cover places where the
 * check is wrong about the element, each with its reason. Never a real barrier.
 *
 * `docs/TESTING_STRATEGY.md` §8.4.6.
 */
import { expect, test, type Page } from '@playwright/test';
import { knownFailure } from './known-failure';
import { SURFACES, type A11ySurface } from './surfaces';
import { expectOnlyKnownProblems, type KnownProblem } from './support/known-barriers';
import {
  clipFindings,
  formatClip,
  formatOverlap,
  formatScroller,
  isRotated,
  overlapFindings,
  scrollsSideways,
  type ClipFinding,
  type ScrollerFact,
} from './support/magnify-geometry';
import {
  applyMagnification,
  clearMagnification,
  emulateZoom,
  hideScrollbars,
  readOrientation,
  readRoot,
  readScrollers,
  readText,
  settleLayout,
  watchOrientationLock,
  type Magnification,
} from './support/magnify-probe';
import { guardWrites } from './support/page-guards';
import {
  openSurface,
  phase2FixturesPresent,
  prepareSurface,
  settleLazyContent,
  surfaceAnnotations,
} from './support/surface-page';

type ClipCheck = 'zoom 400%' | Magnification;

/**
 * 400% zoom on a 1280px window leaves a 320 CSS px viewport. Scrollbars are hidden
 * for repeatable runs (`hideScrollbars`), but a Windows reader with classic
 * scrollbars still loses the scrollbar. As far as we can tell (no Chrome document
 * says it, Mozilla bug 1657549 does), Chromium keeps it at its own size under page
 * zoom: 15px for Fluent and 17px for the older theme, so 3.75 to 4.25 CSS px at 400%. The content box is then 315.75 to 316.25 px. 315 is the whole number
 * at or below both, so the check is never more lenient than that reader.
 * `docs/TESTING_STRATEGY.md` §8.4.6.
 */
const ZOOM_400 = { width: 315, height: 256 } as const;

/** A clip finding the detector gets wrong, or a clamp that is the design. */
interface ClipAllowEntry {
  readonly applies: (surface: A11ySurface) => boolean;
  readonly covers: (finding: ClipFinding, check: ClipCheck) => boolean;
  readonly reason: string;
}

/** A sideways scroller inside the page that 1.4.10 allows. */
interface ScrollerAllowEntry {
  readonly applies: (surface: A11ySurface) => boolean;
  readonly covers: (scroller: ScrollerFact) => boolean;
  readonly reason: string;
}

const on =
  (...ids: string[]) =>
  (surface: A11ySurface) =>
    ids.includes(surface.id);

/**
 * A clip finding of one kind, at any of the three enlargements, with or without
 * the 100% tag, tied to a place on the page. `host` is the component the probe
 * reads from the page (`hostOf` in `support/magnify-probe.ts`): the nearest custom
 * element, with the nearest `aec…` directive host in front when it is closer.
 * `near` is the nearest `data-testid`, or none. Both must match exactly, so the
 * same cut anywhere else on the page is still a new problem.
 */
const clip = (kind: string, el: string, by: string, host: string, near = '') => {
  const escape = (s: string) => s.replace(/[[\]]/g, '\\$&');
  return new RegExp(
    `^(zoom 400%|text 200%|text spacing): clipped \\(${kind}\\) "[^"]*" in ${el} by ${by}` +
      ` within ${escape(host)}${near ? ` near \\[data-testid="${near}"\\]` : ''}` +
      `( \\(also at 100%\\))?$`,
  );
};

const TERM_INDEXES = ['categories-index', 'audiences-index', 'phases-index'];
/** A term card's description on the index pages, projected into the browse layout. */
const TERM_DESCRIPTION = clip('line-clamp', '<p>', '<p>', 'aec-browse-layout [aeccard]');

export const CLIP_ALLOW_LIST: readonly ClipAllowEntry[] = [
  {
    applies: on('product-detail'),
    covers: (f) => f.clip === 'line-clamp' && f.el === '<p data-testid="product-hero-lede">',
    reason:
      'Intentional two-line clamp (product-hero.ts). The lede is aria-hidden and repeats the start ' +
      'of the description, whose full text is in the About band of the same page.',
  },
  {
    applies: on(...TERM_INDEXES),
    covers: (f, check) => TERM_DESCRIPTION.test(`${check}: ${formatClip(f)}`),
    reason:
      'Intentional three-line clamp on the /categories, /audiences and /phases cards ' +
      '(taxonomy-index.ts). Each card links to its term page, which holds the full description. ' +
      'Kept and allow-listed by Chris, 2026-11-26 (AECI-2108).',
  },
];

export const SCROLLER_ALLOW_LIST: readonly ScrollerAllowEntry[] = [
  {
    applies: on('vendor-detail'),
    covers: (s) => s.holdsTable && s.desc === '<div data-testid="vendor-products-scroller">',
    reason:
      'A data table (Product, Integrations, Details) that scrolls inside its own box at 320px. ' +
      'WCAG 1.4.10 excepts data tables, and the page itself does not scroll sideways.',
  },
];

/** A real barrier. `load` says which of the two tests finds it. */
interface MagnifyKnownProblem extends KnownProblem {
  readonly load: 'narrow' | 'wide';
  readonly applies: (surface: A11ySurface) => boolean;
}

/** The product card's name, vendor and "Independent" lines (`product-card-grid.ts`). */
const CARD_NAME = clip('ellipsis', '<(a|p|span)>', '<p>', 'aec-product-card-grid [aeccard]');
/** A filter row's term name (`FILTER_LABEL_CLASS`), inside the refinement list. */
const FILTER_LABEL = clip('ellipsis', '<span>', '<span>', 'aec-search-refinement-list');
const RAIL_VENDOR = clip('ellipsis', '<p>', '<p>', 'aec-review-form', 'context-rail');
const MAILING_OVERLAP =
  /^text 200%: "[^"]*" in <\w+> overlaps "[^"]*" in <\w+> near \[data-testid="mailing-list-card"\]$/;
const NAV_ROW =
  /^reflow: <(div|ul)> scrolls sideways inside the page: "(About How teams use it|Vendor Overview|Product Overview) /;

const LISTINGS = ['product-index', 'vendor-index', 'integration-index'];
const TERM_PAGES = ['category-browse', 'audience-browse', 'phase-browse'];

export const KNOWN_PROBLEMS: readonly MagnifyKnownProblem[] = [
  {
    load: 'narrow',
    applies: on(...LISTINGS),
    issue: 'AECI-1889',
    matches: (p) => CARD_NAME.test(p),
    mark: () =>
      knownFailure('AECI-1889', 'product cards cut long names with an ellipsis at 400% zoom'),
  },
  {
    load: 'wide',
    applies: on(...LISTINGS, ...TERM_PAGES),
    issue: 'AECI-1889',
    matches: (p) => CARD_NAME.test(p),
    mark: () =>
      knownFailure('AECI-1889', 'product cards cut product and vendor names at 200% text'),
  },
  {
    load: 'wide',
    applies: on(...LISTINGS, ...TERM_PAGES),
    issue: 'AECI-2106',
    matches: (p) => FILTER_LABEL.test(p),
    mark: () =>
      knownFailure('AECI-2106', 'the browse filter labels are cut to a few letters at 200% text'),
  },
  {
    load: 'narrow',
    applies: on('review-submission'),
    issue: 'AECI-2107',
    matches: (p) => RAIL_VENDOR.test(p),
    mark: () =>
      knownFailure('AECI-2107', 'the review form side panel cuts the vendor name at 400% zoom'),
  },
  {
    load: 'wide',
    applies: on('review-submission'),
    issue: 'AECI-2107',
    matches: (p) => RAIL_VENDOR.test(p),
    mark: () =>
      knownFailure('AECI-2107', 'the review form side panel cuts the vendor name at 200% text'),
  },
  {
    load: 'wide',
    applies: on(
      'product-detail',
      'vendor-detail',
      'integration-detail',
      'product-pair',
      ...LISTINGS,
      ...TERM_PAGES,
      ...TERM_INDEXES,
    ),
    issue: 'AECI-2105',
    matches: (p) => MAILING_OVERLAP.test(p),
    mark: () =>
      knownFailure(
        'AECI-2105',
        'the mailing list form paints over its own description at 200% text',
      ),
  },
  {
    load: 'narrow',
    applies: on('product-detail', 'vendor-products', 'vendor-integrations'),
    issue: 'AECI-2109',
    matches: (p) => NAV_ROW.test(p),
    mark: () =>
      knownFailure(
        'AECI-2109',
        'section and tab nav rows scroll sideways at 320px, pending a ruling',
      ),
  },
];

function knownFor(surface: A11ySurface, load: MagnifyKnownProblem['load']): KnownProblem[] {
  return KNOWN_PROBLEMS.filter((k) => k.load === load && k.applies(surface));
}

/** Note on the test what was measured, so a green run shows its work. */
function note(type: string, description: string): void {
  test.info().annotations.push({ type, description });
}

async function orientationProblems(page: Page, size: string): Promise<string[]> {
  const facts = await readOrientation(page);
  const problems: string[] = [];
  if (!facts.mainShown) problems.push(`orientation ${size}: main is not shown`);
  for (const turn of facts.turns) {
    if (isRotated(turn.transform, turn.rotate)) {
      problems.push(`orientation ${size}: ${turn.desc} is rotated`);
    }
  }
  if (facts.lockCalls > 0) problems.push('orientation: the page called screen.orientation.lock');
  return problems;
}

async function sidewaysProblems(page: Page, check: string): Promise<string[]> {
  const root = await readRoot(page);
  note(`${check} root`, `scrollWidth ${root.scrollWidth}px, clientWidth ${root.clientWidth}px`);
  if (!scrollsSideways(root)) return [];
  for (const edge of root.pastEdge) note(`${check} past the edge`, edge);
  return [`${check}: the page scrolls sideways`];
}

async function scrollerProblems(page: Page, surface: A11ySurface): Promise<string[]> {
  const problems: string[] = [];
  for (const s of await readScrollers(page)) {
    const allowed = SCROLLER_ALLOW_LIST.find((a) => a.applies(surface) && a.covers(s));
    if (allowed) {
      note('reflow allowed', `${formatScroller(s)}. ${allowed.reason}`);
      continue;
    }
    problems.push(`reflow: ${formatScroller(s)}`);
  }
  return [...new Set(problems)];
}

/** The clip detector at the page's present state, before the allow-list. */
async function detect(page: Page): Promise<{ clips: ClipFinding[]; overlaps: string[] }> {
  const facts = await readText(page);
  return { clips: clipFindings(facts), overlaps: overlapFindings(facts).map(formatOverlap) };
}

function clipProblems(
  surface: A11ySurface,
  check: ClipCheck,
  found: { clips: ClipFinding[]; overlaps: string[] },
  atBaseline: ReadonlySet<string> = new Set(),
): string[] {
  const tag = (p: string) => (atBaseline.has(p) ? `${p} (also at 100%)` : p);
  const problems: string[] = [];
  for (const f of found.clips) {
    const allowed = CLIP_ALLOW_LIST.find((a) => a.applies(surface) && a.covers(f, check));
    if (allowed) {
      note(`${check} allowed`, `${formatClip(f)}. ${allowed.reason}`);
      continue;
    }
    problems.push(`${check}: ${tag(formatClip(f))}`);
  }
  for (const o of found.overlaps) problems.push(`${check}: ${tag(o)}`);
  note(
    `${check} clip detector`,
    `${found.clips.length} clipped, ${found.overlaps.length} overlapping`,
  );
  return [...new Set(problems)];
}

test.describe('a11y nightly magnification', () => {
  // Measure settled geometry. A transition caught half way is not a layout.
  test.use({ reducedMotion: 'reduce' });

  // Every test stands alone, so the nightly's shards may split the file anywhere.
  // The fixture probe runs once per worker, on the first test that needs it, with
  // no `beforeAll` for a shard boundary to cut.
  let fixtures: Promise<boolean> | null = null;
  const fixturesPresent = () => (fixtures ??= phase2FixturesPresent());

  for (const surface of SURFACES) {
    test.describe(`${surface.name} (${surface.route})`, () => {
      test(
        'narrow: orientation both ways, reflow at 320px, and 400% zoom',
        surfaceAnnotations(surface),
        async ({ context, page }) => {
          test.setTimeout(180_000);
          await prepareSurface(context, surface, await fixturesPresent());
          await guardWrites(page);
          await hideScrollbars(page);
          await watchOrientationLock(page);
          const problems: string[] = [];

          await page.setViewportSize({ width: 390, height: 844 });
          await openSurface(page, surface);
          await settleLayout(page);
          problems.push(...(await orientationProblems(page, '390x844')));

          await page.setViewportSize({ width: 844, height: 390 });
          await settleLayout(page);
          problems.push(...(await orientationProblems(page, '844x390')));

          await page.setViewportSize({ width: 320, height: 640 });
          await settleLazyContent(page);
          await settleLayout(page);
          problems.push(...(await sidewaysProblems(page, 'reflow')));
          problems.push(...(await scrollerProblems(page, surface)));

          const zoom = await emulateZoom(page, ZOOM_400, 4);
          // The stand-in only means something if the page sees it.
          expect(zoom, 'the page sees 400% zoom').toEqual({
            devicePixelRatio: 4,
            innerWidth: ZOOM_400.width,
          });
          problems.push(...(await sidewaysProblems(page, 'zoom 400%')));
          problems.push(...clipProblems(surface, 'zoom 400%', await detect(page)));

          expectOnlyKnownProblems(problems, knownFor(surface, 'narrow'));
        },
      );

      test(
        'wide: 200% text and text spacing at 1280px',
        surfaceAnnotations(surface),
        async ({ context, page }) => {
          test.setTimeout(180_000);
          await prepareSurface(context, surface, await fixturesPresent());
          await guardWrites(page);
          await hideScrollbars(page);
          await page.setViewportSize({ width: 1280, height: 800 });
          await openSurface(page, surface, { settle: true });
          await settleLayout(page);

          const before = await detect(page);
          const atBaseline = new Set([...before.clips.map(formatClip), ...before.overlaps]);
          const problems: string[] = [];
          for (const check of ['text 200%', 'text spacing'] as const) {
            await applyMagnification(page, check);
            problems.push(...clipProblems(surface, check, await detect(page), atBaseline));
            await clearMagnification(page);
          }

          expectOnlyKnownProblems(problems, knownFor(surface, 'wide'));
        },
      );
    });
  }
});
