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
 *                `autocomplete` token. Fails the run. Every text field it saw,
 *                and the purpose it held each to, goes to the summary. Fields
 *                inside dialogs are not read (§8.4.8).
 *   effort    5. Tab presses from load to the surface's primary action
 *                (`PRIMARY_ACTIONS`), with the keyboard suite's `tabWalk`. Each
 *                action is matched by its role, the component or test id it
 *                sits in, and its name or link target, read in `onStop`.
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
import { expect, test, type Page } from '@playwright/test';
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
  judgedFields,
  labelInNameProblems,
  sharedControlNameProblems,
  type ControlFact,
} from './support/voice-names';
import { readControls, readTargetSize } from './support/voice-probe';
import {
  VOICE_EFFORT_ANNOTATION,
  VOICE_INPUT_PURPOSE_ANNOTATION,
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
  /**
   * Is this stop the action? `chain` is every `data-testid` and every `aec-*`
   * component host from the stop up to the document, innermost first, read in
   * the walk's `onStop` hook. A stop that matches nothing ends the walk as
   * `not-reached`, which fails the test.
   */
  readonly matches: (stop: TabStop, chain: readonly string[]) => boolean;
  readonly baseline: number;
}

/**
 * Match a stop by what it is: its role, the component or test id it sits in,
 * and its name or its link target. Always in `main`. A new link or button that
 * lands ahead of the action does not match, so it cannot pass as a shorter walk.
 */
interface Target {
  readonly role: string;
  /** An `aec-*` component host or a `data-testid` on the stop's chain. A RegExp matches any one. */
  readonly within: string | RegExp;
  readonly name?: RegExp;
  readonly href?: RegExp;
}

const target =
  ({ role, within, name, href }: Target) =>
  (s: TabStop, chain: readonly string[]): boolean =>
    s.landmark === 'main' &&
    s.role === role &&
    chain.some((c) => (typeof within === 'string' ? c === within : within.test(c))) &&
    (!name || name.test(s.name)) &&
    (!href || (s.href !== null && href.test(s.href)));

/** The stop's chain: every `data-testid` and `aec-*` host from it up. Moves no focus. */
async function stopChain(page: Page, key: number): Promise<string[]> {
  return page.evaluate((k) => {
    const out: string[] = [];
    for (let a = window.__aeciKeyboardProbe!.byKey(k); a; a = a.parentElement) {
      const id = a.getAttribute('data-testid');
      if (id) out.push(id);
      if (a.tagName.startsWith('AEC-')) out.push(a.tagName.toLowerCase());
    }
    return out;
  }, key);
}

/** A product card on a listing: a link to `/products/<slug>` in the shared card grid. */
const FIRST_RESULT: PrimaryAction['matches'] = target({
  role: 'link',
  within: 'aec-product-card-grid',
  href: /^\/products\/[^/?#]+$/,
});
const FIRST_RESULT_LABEL = 'the first result card';

/** A term card on a taxonomy index: a link to `/<facet>/<slug>` in the index component. */
const firstTerm = (facet: string): PrimaryAction['matches'] =>
  target({ role: 'link', within: 'aec-taxonomy-index', href: new RegExp(`^/${facet}/[^/?#]+$`) });
const FIRST_TERM_LABEL = 'the first term card';

export const PRIMARY_ACTIONS: Readonly<Record<string, PrimaryAction>> = {
  home: {
    action: 'the hero search box',
    matches: target({ role: 'combobox', within: 'aec-home-hero', name: /^Search$/ }),
    baseline: 8,
  },
  'product-detail': {
    action: 'the "Sign in to review" link in the hero',
    matches: target({
      role: 'link',
      within: 'aec-product-hero',
      name: /^Sign in to review$/,
      href: /^\/auth\/login\?/,
    }),
    baseline: 12,
  },
  'review-submission': {
    action: 'the first star rating',
    matches: target({ role: 'option', within: 'aec-review-form', name: /^1 star$/ }),
    baseline: 9,
  },
  login: {
    action: 'the email field',
    matches: target({ role: 'textbox', within: 'aec-login-page', name: /^Email$/ }),
    baseline: 9,
  },
  account: {
    action: 'the display name field',
    matches: target({ role: 'textbox', within: 'aec-account-page', name: /^Display name$/ }),
    baseline: 14,
  },
  'admin-reviews': {
    action: 'the first Approve button',
    matches: target({ role: 'button', within: 'aec-review-queue', name: /^Approve$/ }),
    baseline: 23,
  },
  'admin-requests': {
    action: 'the "Open" filter of the first queue (the seed has no request rows)',
    matches: target({ role: 'button', within: 'aec-request-queue', name: /^Open$/ }),
    baseline: 12,
  },
  'vendor-products': {
    action: 'the first product card',
    matches: target({
      role: 'link',
      within: 'aec-vendor-product-list-page',
      href: /^\/vendor\/[^/]+\/products\/[^/?#]+$/,
    }),
    baseline: 17,
  },
  'vendor-integrations': {
    action: 'the first integration row',
    matches: target({
      role: 'link',
      within: /^integration-row-/,
      href: /^\/vendor\/[^/]+\/products\/[^/]+\/integrations\/[0-9a-f-]{36}$/,
    }),
    baseline: 28,
  },
  'product-index': { action: FIRST_RESULT_LABEL, matches: FIRST_RESULT, baseline: 38 },
  'vendor-index': { action: FIRST_RESULT_LABEL, matches: FIRST_RESULT, baseline: 38 },
  'vendor-detail': {
    action: "the first of the vendor's products",
    matches: target({
      role: 'link',
      within: 'vendor-products-scroller',
      name: /^View /,
      href: /^\/products\/[^/?#]+$/,
    }),
    baseline: 14,
  },
  'integration-index': { action: FIRST_RESULT_LABEL, matches: FIRST_RESULT, baseline: 38 },
  'integration-detail': {
    action: 'the "View listing" link',
    matches: target({ role: 'link', within: 'aec-products-pair', name: /^View listing/ }),
    baseline: 17,
  },
  'product-pair': {
    action: 'the "View listing" link',
    matches: target({ role: 'link', within: 'aec-products-pair', name: /^View listing/ }),
    baseline: 17,
  },
  'category-browse': { action: FIRST_RESULT_LABEL, matches: FIRST_RESULT, baseline: 18 },
  'audience-browse': { action: FIRST_RESULT_LABEL, matches: FIRST_RESULT, baseline: 22 },
  'phase-browse': { action: FIRST_RESULT_LABEL, matches: FIRST_RESULT, baseline: 21 },
  'categories-index': { action: FIRST_TERM_LABEL, matches: firstTerm('categories'), baseline: 10 },
  'audiences-index': { action: FIRST_TERM_LABEL, matches: firstTerm('audiences'), baseline: 10 },
  'phases-index': { action: FIRST_TERM_LABEL, matches: firstTerm('phases'), baseline: 10 },
  'not-found': {
    action: 'the "Go home" link',
    matches: target({ role: 'link', within: 'aec-not-found', name: /^Go home$/, href: /^\/$/ }),
    baseline: 13,
  },
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
          // What check 4 judged, so a green run can be told from one that judged nothing.
          const judged = judgedFields(fields);
          for (const f of judged) {
            note(
              'input purpose judged',
              f.purpose === null
                ? `"${f.field}" (${f.type}, ${f.landmark}): no purpose, not judged`
                : `"${f.field}" (${f.type}, ${f.landmark}): ${f.purpose}, wants "${f.wants}", has ${
                    f.has === null ? 'none' : `"${f.has}"`
                  }`,
            );
          }
          note(
            VOICE_INPUT_PURPOSE_ANNOTATION,
            JSON.stringify({ surfaceId: surface.id, route: surface.route, fields: judged }),
          );
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

          // `onStop` runs before `until` at each stop, so the chain is there to match on.
          const chains = new Map<number, readonly string[]>();
          const walk = await tabWalk(page, {
            onStop: async (stop) => {
              chains.set(stop.key, await stopChain(page, stop.key));
            },
            until: (stop) => primary!.matches(stop, chains.get(stop.key) ?? []),
          });
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
            matched: reached
              ? `${reached.role} "${reached.name}"${reached.href ? ` ${reached.href}` : ''}`
              : null,
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
