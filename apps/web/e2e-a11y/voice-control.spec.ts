/**
 * AECI-1883: stand-ins for voice-control and switch users, on every manifest surface.
 *
 * Real Dragon, Voice Control or switch sessions are out of reach in CI. These
 * checks catch the common failures. Two tests per surface:
 *
 *   controls  One load, everything that renders on scroll in place. Reads every
 *             rendered control: its Chromium role and accessible name, and the
 *             text a sighted user reads as its label (`support/voice-probe.ts`).
 *             1. Label in name (WCAG 2.5.3): the name contains the visible
 *                label, word for word. Fails the run.
 *             2. Unique names: no two controls share a name while doing
 *                different things. Groups made only of links are the ARIA
 *                suite's `link names` rule, not this one. Fails the run.
 *             3. Target size (WCAG 2.5.8): axe's `target-size` rule. Report
 *                only: written to the summary, never fails.
 *             4. Input purpose (WCAG 1.3.5): a field that collects the user's
 *                name, email, organisation and the like carries the matching
 *                `autocomplete` token. Fails the run.
 *   effort    5. Tab presses from load to the surface's primary action
 *                (`PRIMARY_ACTIONS`), with the keyboard suite's `tabWalk`.
 *                Written to the summary with its change from the committed
 *                baseline. Fails only above `effortMargin`, or when the walk
 *                never reaches the action.
 *
 * The rules are pure, in `support/voice-names.ts`. `KNOWN_PROBLEMS` covers real
 * barriers, narrowed by `matches`, so a new problem on a marked surface still
 * fails and a fixed one turns its mark red. `NOT_ABOUT_THE_USER` lists fields
 * 1.3.5 does not cover, each with its reason. Never a real barrier.
 *
 * `docs/TESTING_STRATEGY.md` §8.4.8.
 */
import { expect, test } from '@playwright/test';
import { knownFailure } from './known-failure';
import { SURFACES, type A11ySurface } from './surfaces';
import { expectOnlyKnownProblems, type KnownProblem } from './support/known-barriers';
import { fakeHeaderSearch, guardWrites } from './support/page-guards';
import {
  openSurface,
  phase2FixturesPresent,
  prepareSurface,
  surfaceAnnotations,
} from './support/surface-page';
import { tabWalk, type TabStop } from './support/tab-walk';
import {
  effortMargin,
  effortVerdict,
  inputPurposeProblems,
  labelInNameProblems,
  sharedControlNameProblems,
  type ControlFact,
} from './support/voice-names';
import { readControls, readTargetSize } from './support/voice-probe';
import {
  VOICE_EFFORT_ANNOTATION,
  VOICE_TARGET_SIZE_ANNOTATION,
  type EffortRecord,
} from './support/voice-summary';

/**
 * Check 5. The primary action of each surface: the first control of the task a
 * person comes to the page for. A judgement, so it is written down here, one
 * line each, for review. `baseline` is the committed count of Tab presses from
 * load to it, on a freshly seeded D1. Update it on purpose, in the same change
 * that moved it, and say why.
 */
interface PrimaryAction {
  readonly action: string;
  readonly matches: (stop: TabStop) => boolean;
  readonly baseline: number;
}

const inMain = (role: string, name?: RegExp) => (s: TabStop) =>
  s.landmark === 'main' && s.role === role && (!name || name.test(s.name));

const FIRST_RESULT = 'the first result card';
const FIRST_TERM = 'the first term card';

export const PRIMARY_ACTIONS: Readonly<Record<string, PrimaryAction>> = {
  home: { action: 'the hero search box', matches: inMain('combobox', /^Search$/), baseline: 8 },
  'product-detail': {
    action: 'the first "Sign in to review" link',
    matches: inMain('link', /^Sign in to review$/),
    baseline: 12,
  },
  'review-submission': {
    action: 'the first star rating',
    matches: inMain('option', /star/),
    baseline: 9,
  },
  login: { action: 'the email field', matches: inMain('textbox', /^Email$/), baseline: 9 },
  account: {
    action: 'the display name field',
    matches: inMain('textbox', /^Display name$/),
    baseline: 14,
  },
  'admin-reviews': {
    action: 'the first Approve button',
    matches: inMain('button', /^Approve$/),
    baseline: 23,
  },
  'admin-requests': {
    action: 'the first queue filter (the seed has no request rows)',
    matches: inMain('button'),
    baseline: 12,
  },
  'vendor-products': {
    action: 'the first product card',
    matches: inMain('link'),
    baseline: 17,
  },
  'vendor-integrations': {
    action: 'the first integration row',
    matches: inMain('link'),
    baseline: 28,
  },
  'product-index': { action: FIRST_RESULT, matches: inMain('link'), baseline: 38 },
  'vendor-index': { action: FIRST_RESULT, matches: inMain('link'), baseline: 38 },
  'vendor-detail': {
    action: "the first of the vendor's products",
    matches: inMain('link', /^View /),
    baseline: 14,
  },
  'integration-index': { action: FIRST_RESULT, matches: inMain('link'), baseline: 38 },
  'integration-detail': {
    action: 'the "View listing" link',
    matches: inMain('link', /^View listing/),
    baseline: 17,
  },
  'product-pair': {
    action: 'the "View listing" link',
    matches: inMain('link', /^View listing/),
    baseline: 17,
  },
  'category-browse': { action: FIRST_RESULT, matches: inMain('link'), baseline: 18 },
  'audience-browse': { action: FIRST_RESULT, matches: inMain('link'), baseline: 22 },
  'phase-browse': { action: FIRST_RESULT, matches: inMain('link'), baseline: 21 },
  'categories-index': { action: FIRST_TERM, matches: inMain('link'), baseline: 10 },
  'audiences-index': { action: FIRST_TERM, matches: inMain('link'), baseline: 10 },
  'phases-index': { action: FIRST_TERM, matches: inMain('link'), baseline: 10 },
  'not-found': { action: 'the "Go home" link', matches: inMain('link', /^Go home$/), baseline: 13 },
};

/** A field 1.3.5 does not cover: it collects something, but not about the person filling it in. */
interface NotAboutTheUser {
  readonly applies: (surface: A11ySurface) => boolean;
  readonly covers: (control: ControlFact) => boolean;
  readonly reason: string;
}

export const NOT_ABOUT_THE_USER: readonly NotAboutTheUser[] = [];

const on =
  (...ids: string[]) =>
  (surface: A11ySurface) =>
    ids.includes(surface.id);

/**
 * Check 2 decides "different things" from the DOM: a link's target, an
 * `aria-controls`, a form. Two controls with none of those count as different.
 * An entry here says two same-named controls do the same thing after all. Each
 * names the exact problem string and why. A real barrier never goes here.
 */
interface SameAction {
  readonly applies: (surface: A11ySurface) => boolean;
  readonly problem: string;
  readonly reason: string;
}

export const SAME_ACTION: readonly SameAction[] = [
  {
    applies: on('home'),
    problem:
      'unique names: "Search" names 2 controls that do different things: combobox in header, combobox in main',
    reason:
      'The header search and the hero search are the same SearchAutocomplete widget. Both search ' +
      'the whole directory and land on /search, so either one does what the user asked.',
  },
];

interface VoiceKnownProblem extends KnownProblem {
  readonly applies: (surface: A11ySurface) => boolean;
}

/** A check 2 problem for one name, whatever controls the name covers. */
const sharedName = (name: string) => (p: string) => p.startsWith(`unique names: "${name}" names `);

export const KNOWN_PROBLEMS: readonly VoiceKnownProblem[] = [
  {
    applies: on('review-submission'),
    issue: 'AECI-2114',
    matches: (p) => /^unique names: "<n> stars?" names 2 controls .*: option in main$/.test(p),
    mark: () =>
      knownFailure('AECI-2114', 'both star ratings name their options "1 star" to "5 stars"'),
  },
  {
    applies: on('account'),
    issue: 'AECI-2115',
    matches: sharedName('Delete account'),
    mark: () =>
      knownFailure('AECI-2115', '"Delete account" names a nav link and the delete dialog button'),
  },
  {
    applies: on('admin-requests'),
    issue: 'AECI-2116',
    matches: (p) => sharedName('Open')(p) || sharedName('Declined')(p),
    mark: () =>
      knownFailure(
        'AECI-2116',
        'the three request sections share filter names "Open" and "Declined"',
      ),
  },
  {
    applies: on('vendor-integrations'),
    issue: 'AECI-2117',
    matches: (p) =>
      p ===
      'unique names: "Search" names 2 controls that do different things: combobox in header, searchbox in main',
    mark: () =>
      knownFailure(
        'AECI-2117',
        'the portal integration filter is named "Search", like the site search',
      ),
  },
  {
    applies: on('product-index', 'vendor-index', 'integration-index', 'phase-browse'),
    issue: 'AECI-2118',
    matches: (p) =>
      /^unique names: "Construction Management \(<n>\)" names 2 controls .*: checkbox in aside$/.test(
        p,
      ),
    mark: () =>
      knownFailure('AECI-2118', 'a value in two filter facets gives two checkboxes one name'),
  },
];

function note(type: string, description: string): void {
  test.info().annotations.push({ type, description });
}

test.describe('a11y nightly voice control and switch', () => {
  // Every test stands alone, so the nightly's shards may split the file anywhere.
  // The fixture probe runs once per worker, on the first test that needs it.
  let fixtures: Promise<boolean> | null = null;
  const fixturesPresent = () => (fixtures ??= phase2FixturesPresent());

  test('every surface has a primary action', () => {
    expect(
      SURFACES.map((s) => s.id).filter((id) => !PRIMARY_ACTIONS[id]),
      'surfaces with no entry in PRIMARY_ACTIONS',
    ).toEqual([]);
    expect(
      Object.keys(PRIMARY_ACTIONS).filter((id) => !SURFACES.some((s) => s.id === id)),
      'PRIMARY_ACTIONS entries for surfaces the manifest no longer has',
    ).toEqual([]);
  });

  for (const surface of SURFACES) {
    test.describe(`${surface.name} (${surface.route})`, () => {
      test(
        'controls: label in name, unique names, input purpose, and the target size report',
        surfaceAnnotations(surface),
        async ({ context, page }) => {
          test.setTimeout(120_000);
          await prepareSurface(context, surface, await fixturesPresent());
          await guardWrites(page);
          await fakeHeaderSearch(page);
          await openSurface(page, surface, { settle: true });

          const controls = await readControls(page);
          note('controls read', String(controls.length));
          expect(controls.length, 'the probe found controls on the page').toBeGreaterThan(0);

          // Check 3 first: it is report only, so it is recorded whatever the others find.
          const targets = await readTargetSize(page);
          note(
            VOICE_TARGET_SIZE_ANNOTATION,
            JSON.stringify({ surfaceId: surface.id, route: surface.route, targets }),
          );

          const fields = controls.filter((c) => {
            const allowed = NOT_ABOUT_THE_USER.find((a) => a.applies(surface) && a.covers(c));
            if (allowed) note('input purpose allowed', `"${c.name}". ${allowed.reason}`);
            return !allowed;
          });
          const sharedAll = sharedControlNameProblems(controls);
          expect(
            SAME_ACTION.filter((s) => s.applies(surface) && !sharedAll.includes(s.problem)).map(
              (s) => s.problem,
            ),
            'SAME_ACTION entries that no longer match anything here: remove them',
          ).toEqual([]);
          const shared = sharedAll.filter((p) => {
            const same = SAME_ACTION.find((s) => s.applies(surface) && s.problem === p);
            if (same) note('unique names allowed', `${p}. ${same.reason}`);
            return !same;
          });
          const problems = [
            ...labelInNameProblems(controls),
            ...shared,
            ...inputPurposeProblems(fields),
          ];
          expectOnlyKnownProblems(
            problems,
            KNOWN_PROBLEMS.filter((k) => k.applies(surface)),
          );
        },
      );

      test(
        'effort: Tab presses from load to the primary action',
        surfaceAnnotations(surface),
        async ({ context, page }) => {
          test.setTimeout(120_000);
          const primary = PRIMARY_ACTIONS[surface.id];
          test.skip(!primary, 'no primary action: the manifest test above fails for it');
          await prepareSurface(context, surface, await fixturesPresent());
          await guardWrites(page);
          await fakeHeaderSearch(page);
          await openSurface(page, surface, { settle: true });

          const walk = await tabWalk(page, { until: primary!.matches });
          const reached = walk.end === 'matched' ? walk.stops.at(-1)! : null;
          const presses = reached?.press ?? null;
          const record: EffortRecord = {
            surfaceId: surface.id,
            route: surface.route,
            action: primary!.action,
            presses,
            baseline: primary!.baseline,
            margin: effortMargin(primary!.baseline),
            change: presses === null ? null : presses - primary!.baseline,
            verdict: effortVerdict(presses, primary!.baseline),
          };
          note(VOICE_EFFORT_ANNOTATION, JSON.stringify(record));

          expect(
            reached,
            `the walk reaches ${primary!.action} (it ended "${walk.end}" after ${walk.presses} presses)`,
          ).not.toBeNull();
          expect(
            record.verdict,
            `${presses} Tab presses to ${primary!.action}, baseline ${primary!.baseline}, ` +
              `margin ${record.margin}`,
          ).not.toBe('over-margin');
        },
      );
    });
  }
});
