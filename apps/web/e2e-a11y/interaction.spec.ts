/**
 * AECI-1882: interaction checks on every manifest surface. Checks 1 to 6 of the
 * issue. Check 7, error prevention, is `interaction-flows.spec.ts`.
 *
 * These criteria describe behaviour, not markup, so no rule engine tests them:
 *
 *   1. Content on hover (WCAG 1.4.13): hoverable, dismissible with Escape
 *      without moving focus, and inside the viewport at 768px.
 *   2. Pointer cancellation (WCAG 2.5.2): press, move off, release does nothing.
 *   3. On input (WCAG 3.2.2): a change does not move the page, unless the
 *      control is on `ON_INPUT_LIST`.
 *   4. Character shortcuts (WCAG 2.1.4): a to z on `body` change nothing.
 *   5. Motion (WCAG 2.2.2): nothing moves for more than 5 seconds. Under
 *      reduced motion, nothing moves for more than 100ms.
 *   6. Forced colours: axe and the focus ring check, with `forcedColors: 'active'`.
 *
 * Each surface is loaded twice, each time in a `beforeAll` that runs the checks
 * that load serves and records their problems. Load A has the default media
 * and runs 1 to 5 in that order: motion and shortcuts read before anything
 * else touches the page, and a check that changes the page reloads it before
 * the next. Load B has reduced motion and forced colours and runs the reduced
 * motion check, axe and the focus walk. Each check is then its own test, so a
 * known barrier marks only the check it is on (`expectOnlyKnownProblems`).
 *
 * `docs/TESTING_STRATEGY.md` §8.4.7.
 */
import { test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { untilAppStable } from '../e2e/hydration';
import { knownFailure } from './known-failure';
import { SURFACES, type A11ySurface } from './surfaces';
import { formatFinding, measureWalk } from './support/focus-check';
import { headerOwnerFor } from './support/header-owner';
import {
  checkCharacterShortcuts,
  checkForcedColoursAxe,
  checkHoverContent,
  checkMotion,
  checkOnInput,
  checkPointerCancellation,
  checkReducedMotion,
  describeOnInput,
  type CheckContext,
} from './support/interaction-checks';
import { installInteractionProbe } from './support/interaction-probe';
import { isTelemetryWrite, judgeOnInput } from './support/interaction-rules';
import { expectOnlyKnownProblems, type KnownProblem } from './support/known-barriers';
import { ON_INPUT_LIST } from './support/on-input-list';
import { fakeHeaderSearch, guardWrites } from './support/page-guards';
import {
  openSurface,
  phase2FixturesPresent,
  prepareSurface,
  surfaceAnnotations,
} from './support/surface-page';

type LoadACheck = 'hover' | 'pointer' | 'on input' | 'shortcuts' | 'motion';
type LoadBCheck = 'reduced motion' | 'forced colours axe' | 'forced colours focus';
type Check = LoadACheck | LoadBCheck;

const TITLES: Record<Check, string> = {
  hover: 'content on hover stays, is dismissible and fits at 768px (WCAG 1.4.13)',
  pointer: 'press, move off and release activates nothing (WCAG 2.5.2)',
  'on input': 'changing a control does not change the page unless listed (WCAG 3.2.2)',
  shortcuts: 'a to z on the page body change nothing (WCAG 2.1.4)',
  motion: 'nothing moves for more than 5 seconds (WCAG 2.2.2)',
  'reduced motion': 'with reduced motion, no animation runs past 100ms (WCAG 2.3.3, 2.2.2)',
  'forced colours axe': 'with forced colours, axe finds no WCAG A or AA violation',
  'forced colours focus':
    'with forced colours, the focus ring passes on every Tab stop (WCAG 2.4.7, 1.4.11)',
};

const LOAD_A: readonly LoadACheck[] = ['motion', 'shortcuts', 'hover', 'pointer', 'on input'];
const LOAD_B: readonly LoadBCheck[] = [
  'reduced motion',
  'forced colours axe',
  'forced colours focus',
];

/**
 * A barrier this spec finds today: its check, the surfaces it is on, and the
 * problems it covers (`matches`). `sharedChrome` is true on the surface that
 * checks the site header and footer for its persona (`headerOwnerFor`).
 */
interface InteractionBarrier extends KnownProblem {
  readonly check: Check;
  readonly applies: (surface: A11ySurface, sharedChrome: boolean) => boolean;
}

/**
 * AECI-2097's finding and nothing else: a contrast finding on a vendor portal
 * section nav link (the portal level and the product level) whose ring is
 * strong (its best pixel reaches 3:1) but too short, because the nav clips its
 * top and bottom. A ring on those links that is faint, or drawn another way,
 * is a new finding and still fails.
 */
const CLIPPED_PORTAL_RING =
  /^contrast: nav link "(Vendor Overview|Profile|Products|Messages|Conversations|Changes|Seats|Product Overview|Categories|Trades|Audiences|Phases|Integrations|Reviews)" \(stop \d+\): \d+ of \d+ changed pixels reach 3:1, \d+ needed\. Best (\d+(?:\.\d+)?):1 \(outline 2px solid [^)]*\), offset 2px\)$/;

function isClippedPortalRing(problem: string): boolean {
  const m = problem.match(CLIPPED_PORTAL_RING);
  return !!m && Number(m[2]) >= 3;
}

export const KNOWN_INTERACTION_BARRIERS: readonly InteractionBarrier[] = [
  {
    issue: 'AECI-2119',
    check: 'hover',
    // The admin console nav renders on every admin surface.
    applies: (surface) => surface.persona === 'admin',
    matches: (p) =>
      p.startsWith('aec-admin-nav-dropdown ') &&
      p.endsWith('Escape does not close it while the pointer is on it'),
    mark: () =>
      knownFailure(
        'AECI-2119',
        'the admin nav dropdowns close on Escape only with focus inside, so a hover-opened panel stays',
      ),
  },
  {
    issue: 'AECI-2120',
    check: 'pointer',
    // The site header is checked once per persona.
    applies: (_surface, sharedChrome) => sharedChrome,
    matches: (p) => p.startsWith('link "Browse": '),
    mark: () =>
      knownFailure(
        'AECI-2120',
        'a press on "Browse" dragged off and released leaves the Browse panel open',
      ),
  },
  {
    // AECI-1885, first Linux run: Linux Chromium draws the consent banner link's
    // default `outline: auto` as a 1px ring round a link that wraps there, in
    // forced colours too. A Mac passes. The cause is AECI-2197: no ring of its own.
    issue: 'AECI-2197',
    check: 'forced colours focus',
    applies: () => process.platform === 'linux',
    matches: (p) =>
      /^contrast: page link "Read our Privacy Policy" \(stop \d+\): .* \(outline 1px auto [^)]*\), offset 1px\)$/.test(
        p,
      ),
    mark: () =>
      knownFailure(
        'AECI-2197',
        'Linux Chromium draws the default outline auto as a 1px ring round a wrapped link, in forced colours too',
      ),
  },
  {
    issue: 'AECI-2097',
    check: 'forced colours focus',
    applies: (surface) => surface.id === 'vendor-products' || surface.id === 'vendor-integrations',
    matches: isClippedPortalRing,
    mark: () =>
      knownFailure(
        'AECI-2097',
        'the vendor portal section nav clips the top and bottom of its links’ focus ring, in forced colours too',
      ),
  },
];

function knownFor(check: Check, surface: A11ySurface, sharedChrome: boolean): KnownProblem[] {
  return KNOWN_INTERACTION_BARRIERS.filter(
    (b) => b.check === check && b.applies(surface, sharedChrome),
  );
}

interface Recorded {
  readonly problems: Partial<Record<Check, string[]>>;
  readonly notes: string[];
  readonly sharedChrome: boolean;
  /** How long the load and its checks took, for reading the nightly's time. */
  readonly seconds: number;
}

/** Open a page for the surface with the guards and probes every load installs. */
async function openGuarded(
  browser: Browser,
  surface: A11ySurface,
  fixturesPresent: boolean,
  media: Parameters<Page['emulateMedia']>[0],
): Promise<{ context: BrowserContext; page: Page; ctx: Omit<CheckContext, 'notes'> }> {
  const context = await browser.newContext();
  await prepareSurface(context, surface, fixturesPresent);
  const page = await context.newPage();
  let writes = 0;
  let windows = 0;
  page.on('request', (req) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !isTelemetryWrite(req.url())) {
      writes++;
    }
  });
  context.on('page', () => windows++);
  await guardWrites(page);
  await fakeHeaderSearch(page);
  await installInteractionProbe(page);
  await page.emulateMedia(media);
  await openSurface(page, surface, { settle: true });
  return {
    context,
    page,
    ctx: {
      page,
      checksSharedChrome: headerOwnerFor(surface.persona, fixturesPresent) === surface.id,
      writes: () => writes,
      popups: () => windows,
      // A check reloads between steps, often. Under a heavy machine load one
      // load can miss the hydration gate, so a failed reload is tried once more.
      reload: async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            await page.goto(surface.route);
            await untilAppStable(page, 30_000);
            return;
          } catch (err) {
            if (attempt === 2) throw err;
          }
        }
      },
    },
  };
}

/** Run one check and keep its problems. A check that throws reports that as its problem. */
async function run(
  out: Partial<Record<Check, string[]>>,
  check: Check,
  fn: () => Promise<string[]>,
): Promise<void> {
  try {
    out[check] = await fn();
  } catch (err) {
    out[check] = [`the check could not run: ${(err as Error).message.split('\n')[0]}`];
  }
}

function judge(surface: A11ySurface, check: Check, recorded: Recorded | null): void {
  test.skip(recorded === null, 'the load did not run');
  const problems = recorded!.problems[check];
  if (problems === undefined) throw new Error(`${check} did not run`);
  expectOnlyKnownProblems(problems, knownFor(check, surface, recorded!.sharedChrome));
}

function annotate(recorded: Recorded, prefix: string): void {
  test.info().annotations.push({
    type: 'interaction-load-seconds',
    description: String(recorded.seconds),
  });
  for (const n of recorded.notes) {
    if (n.startsWith(prefix)) test.info().annotations.push({ type: 'interaction', description: n });
  }
}

for (const surface of SURFACES) {
  test.describe(`a11y nightly interaction: ${surface.name} (${surface.route})`, () => {
    test.describe('default media', () => {
      // One shard, in order. A failed test restarts the worker, and the hook
      // runs again for the tests left, so no test reads another's state.
      // No retries: the findings are deterministic, and a retry would run the
      // whole surface load again. A regression in a shared component could
      // fail many loads at once and push a CI shard (retries: 1) toward its
      // 30-minute limit.
      test.describe.configure({ mode: 'default', retries: 0 });
      let recorded: Recorded | null = null;
      let onInputNotes: string[] = [];

      test.beforeAll(async ({ browser }) => {
        // Load, settle, then five checks. A listing page takes the longest.
        test.setTimeout(300_000);
        const started = Date.now();
        const fixturesPresent = await phase2FixturesPresent();
        const { context, ctx: base } = await openGuarded(browser, surface, fixturesPresent, {
          reducedMotion: 'no-preference',
          forcedColors: 'none',
        });
        const notes: string[] = [];
        const ctx: CheckContext = { ...base, notes };
        const problems: Partial<Record<Check, string[]>> = {};
        try {
          await run(problems, 'motion', () => checkMotion(ctx));
          await run(problems, 'shortcuts', () => checkCharacterShortcuts(ctx));
          await run(problems, 'hover', () => checkHoverContent(ctx));
          await run(problems, 'pointer', () => checkPointerCancellation(ctx));
          await run(problems, 'on input', async () => {
            const results = await checkOnInput(ctx);
            onInputNotes = results.map(describeOnInput);
            const { problems: found, matched } = judgeOnInput(surface.id, results, ON_INPUT_LIST);
            for (const e of matched) {
              notes.push(`on input: ${e.id} (${e.status}): ${e.does}`);
            }
            return found;
          });
        } finally {
          await context.close();
        }
        recorded = {
          problems,
          notes,
          sharedChrome: ctx.checksSharedChrome,
          seconds: Math.round((Date.now() - started) / 1000),
        };
      });

      for (const check of LOAD_A) {
        test(TITLES[check], surfaceAnnotations(surface), () => {
          if (recorded) {
            annotate(recorded, check);
            if (check === 'on input') {
              for (const n of onInputNotes) {
                test.info().annotations.push({ type: 'on-input-effect', description: n });
              }
            }
          }
          judge(surface, check, recorded);
        });
      }
    });

    test.describe('reduced motion and forced colours', () => {
      // As above: one shard, in order, and no retries.
      test.describe.configure({ mode: 'default', retries: 0 });
      let recorded: Recorded | null = null;

      test.beforeAll(async ({ browser }) => {
        // The focus walk is the long part: about 40 seconds on a listing page.
        test.setTimeout(300_000);
        const started = Date.now();
        const fixturesPresent = await phase2FixturesPresent();
        const {
          context,
          page,
          ctx: base,
        } = await openGuarded(browser, surface, fixturesPresent, {
          reducedMotion: 'reduce',
          forcedColors: 'active',
        });
        const notes: string[] = [];
        const ctx: CheckContext = { ...base, notes };
        const problems: Partial<Record<Check, string[]>> = {};
        try {
          await run(problems, 'forced colours axe', () => checkForcedColoursAxe(ctx));
          await run(problems, 'forced colours focus', async () => {
            const walk = await measureWalk(page, ctx.checksSharedChrome);
            notes.push(`forced colours focus: ${walk.measured} stops measured, walk ${walk.end}`);
            const found = walk.findings.map(formatFinding);
            if (walk.end !== 'closed') found.push(`the Tab walk ended ${walk.end}, not closed`);
            return found;
          });
          // Last, so the record covers the load, the settle scroll and every
          // focus move of the walk.
          await run(problems, 'reduced motion', () => checkReducedMotion(ctx));
        } finally {
          await context.close();
        }
        recorded = {
          problems,
          notes,
          sharedChrome: ctx.checksSharedChrome,
          seconds: Math.round((Date.now() - started) / 1000),
        };
      });

      for (const check of LOAD_B) {
        test(TITLES[check], surfaceAnnotations(surface), () => {
          if (recorded) annotate(recorded, check);
          judge(surface, check, recorded);
        });
      }
    });
  });
}
