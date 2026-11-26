# The accessibility nightly (`e2e-a11y/`)

AECI-1875 built this harness. The sub-issues of AECI-1874 add the checks. The full description is
`docs/TESTING_STRATEGY.md` §8.4. The workflow and its alert are `docs/CICD_PLAN.md` §11a-quater.

| File | What it is |
|---|---|
| `surfaces.ts` | The one list of surfaces, `SURFACES`, and `personaCredentials()`. Add a surface here, never in a spec. |
| `surfaces.spec.ts` | The placeholder check: each surface answers its status and renders one visible `h1`. |
| `keyboard-*.spec.ts` | The keyboard walkthroughs (AECI-1877), one file per persona. The checks are in `support/keyboard-suite.ts`. `docs/TESTING_STRATEGY.md` §8.4.1. |
| `announcements-*.spec.ts` | Status messages and form errors (AECI-1880): each heard exactly once, at the promised politeness. `announcements-public.spec.ts` runs signed out, `announcements-signed-in.spec.ts` skips without a session. `docs/TESTING_STRATEGY.md` §8.4.4. |
| `aria-*.spec.ts`, `aria-cross-page.spec.ts` | The ARIA snapshots, structure and link-name rules (AECI-1879), one file per persona, and the cross-page checks. The per-surface checks are in `support/aria-suite.ts`. `docs/TESTING_STRATEGY.md` §8.4.3. |
| `focus-ring.spec.ts` | The focus ring on every Tab stop (AECI-1878): visible, 3:1 against its ground, not under another element, and control edges at 3:1. One Tab walk per surface. `ALLOW_LIST` and `KNOWN_FOCUS_BARRIERS` are in the spec. `docs/TESTING_STRATEGY.md` §8.4.5. |
| `magnification.spec.ts` | Stand-ins for screen magnification (AECI-1881): orientation both ways, reflow at 320px, 400% zoom, 200% text and text spacing, judged by a clip detector that finds cut-off and overlapping text. Two page loads per surface. `CLIP_ALLOW_LIST`, `SCROLLER_ALLOW_LIST` and `KNOWN_PROBLEMS` are in the spec. `docs/TESTING_STRATEGY.md` §8.4.6. |
| `voice-control.spec.ts` | Stand-ins for voice-control and switch users (AECI-1883): the accessible name contains the visible label, no two controls share a name while doing different things, and text fields carry their `autocomplete` token. All three fail the run. Target size is report only. The Tab presses to each surface's primary action are compared with a committed baseline in `PRIMARY_ACTIONS`. `docs/TESTING_STRATEGY.md` §8.4.8. |
| `ibm-equal-access.spec.ts` | IBM Equal Access as a second rule engine (AECI-1884), report only. One test per surface runs axe and the IBM engine on the same state, and marks each IBM finding by whether axe failed it, only marked it for review, or missed it. Only an axe failure takes a finding off the unique list. It fails only when the surface did not render or the engine did not run, or when the browser made a request or opened a WebSocket to another host during the scans. axe is the gate. `docs/TESTING_STRATEGY.md` §8.4.9. |
| `interaction.spec.ts` | The interaction scripts (AECI-1882): hover content (1.4.13), pointer cancellation (2.5.2), on input (3.2.2), character shortcuts (2.1.4), motion and reduced motion (2.2.2), and axe and the focus ring under forced colours. Two loads per surface, each check its own test. Barriers are `KNOWN_INTERACTION_BARRIERS` in the spec. `docs/TESTING_STRATEGY.md` §8.4.7. |
| `interaction-flows.spec.ts` | Error prevention (3.3.4, AECI-1882): the claim, checkout, account delete and moderation flows each stop on their confirm or review step. Nothing is confirmed against a real endpoint. `docs/TESTING_STRATEGY.md` §8.4.7. |
| `__snapshots__/chromium/keyboard-*` | The committed tab-order snapshots, one per surface (AECI-1877). A change is a behaviour change: review it. |
| `__snapshots__/chromium/aria-*` | The committed ARIA snapshots (AECI-1879): `main`, the state flips, the header and the footer, masked. Update with `playwright test -c playwright.a11y-nightly.config.ts aria- --update-snapshots`, and review the diff. |
| `support/` | Helpers every spec shares. `surface-page.ts` mints the session, skips, and waits for hydration. `tab-walk.ts`, `probe.ts`, `tab-candidates.ts` and `overlay-check.ts` are the keyboard tools. `page-guards.ts` blocks writes. `aria-tree.ts` holds the ARIA rules and the snapshot masking, `state-snapshots.ts` flips each stateful control by keyboard and snapshots it, and `known-barriers.ts` marks known barriers, narrowed to the problems each one covers. `announcements.ts` is the announcement recorder: `recordAnnouncements(page)`, then `expectHeardOnce(await rec.settle(), text, via)`. `e2e/` specs import it too. `announcement-flows.ts` holds the announcement specs' write stubs and form-error check. `focus-check.ts`, `focus-probe.ts` and `focus-pixels.ts` are the focus ring checks: the walk, the in-page reads, and the pure colour and pixel maths. `magnify-probe.ts` and `magnify-geometry.ts` are the magnification checks: the in-page reads and overrides, and the pure clip, overlap, sideways-scroll and rotation rules. `voice-probe.ts`, `voice-names.ts` and `voice-summary.ts` are the voice-control checks: the read of each control's Chromium name and visible label, the pure rules, and the summary's `voice` block. `ibm-engine.ts` injects IBM's engine from `node_modules` (`accessibility-checker-engine`, pinned) and runs it and axe on one state. `ibm-overlap.ts` is pure: IBM's levels and lists, the axe overlap rule `matchAxe`, and the summary's `ibm` block. `interaction-checks.ts`, `interaction-probe.ts` and `interaction-rules.ts` are the interaction scripts: the checks, the in-page reads and init script, and the pure verdicts. `on-input-list.ts` is the ruled list of controls allowed to change the page on input (Chris, 2026-11-26). `keyboard-suite.ts` and `aria-suite.ts` define the keyboard and ARIA tests the per-persona specs run. `header-owner.ts` picks the one surface per persona that checks the site header. `overlay-scenarios.ts` holds the overlays a fresh Tab walk cannot reach, and `popup-roles.ts` the `aria-haspopup` rule. The pure helpers are pinned by the `*.unit.spec.ts` files here, which the plain Vitest runner runs in the PR unit job. Playwright skips them. |
| `known-failure.ts` | `knownFailure('AECI-<n>', reason)`, the only allowed way to mark a test as failing. |
| `summary-reporter.ts` | Writes `apps/web/a11y-nightly-summary.json`, which the alert and AECI-1682 read. The e2e axe sweep lane uses it too, with `outputFile: 'a11y-e2e-axe-summary.json'`. The nightly merges the two. Its `voice` block holds the voice-control effort counts and target size report. Its `ibm` block holds the IBM Equal Access findings and their overlap with axe. |

The nightly also runs the whole e2e suite with the axe sweep on (AECI-1876). That lane lives in
`../e2e/`: the fixture is `e2e/fixtures.ts`, the sweep is `e2e/axe-sweep.ts`, and its known failures
are `e2e/axe-known-failures.ts`. Run it with `pnpm test:e2e:axe`. `docs/TESTING_STRATEGY.md` §8.2
describes it.

The PR e2e job never runs these specs. They run from `playwright.a11y-nightly.config.ts`:

```bash
pnpm test:a11y:nightly
```

Against `pnpm dev:agent`, set `AECI_WEB_PORT` and `PLAYWRIGHT_BASE_URL` to the web port it printed.
CI runs the suite in eight shards (`--shard=N/8`). Playwright splits by test, so a test must never rely
on another test having run. A group that shares a `beforeAll` record needs
`test.describe.configure({ mode: 'serial' })` or `{ mode: 'default' }`, which keeps it on one shard.
`docs/TESTING_STRATEGY.md` §8.4 "Shards".
The signed-in surfaces need the `SUPABASE_*TEST_USER_*` pairs in `apps/web/.dev.vars`. Without them those
surfaces skip, and a run that skipped them proved nothing about them.

To add a check:

1. Write a spec here that loops over `SURFACES`.
2. Start each test with `prepareSurface()` and `openSurface()` from `support/surface-page.ts`. Give it
   `surfaceAnnotations(surface)`, so the summary names the surface.
3. Install a write guard before the first action. A check that only reads calls `guardWrites` from
   `support/page-guards.ts`. A check that submits anything calls `blockWrites` from
   `support/announcement-flows.ts`, then stubs the one write it answers. `.dev.vars` holds live keys.
4. Mark a barrier you cannot fix yet with `knownFailure()`, never a bare `test.fail()`. `pnpm test:scripts` enforces it.
   The mark passes on any failure, so it must cover only the barrier. For a check that reports a list of
   problems, judge them with `expectOnlyKnownProblems` from `support/known-barriers.ts` and a
   `KNOWN_PROBLEMS` list, as `voice-control.spec.ts` does: a new problem or a fixed one still fails. Otherwise
   keep the mark on a test that asserts only the barrier, and put the checks that pass today in an unmarked
   test beside it, as `announcements-*.spec.ts` do. `docs/TESTING_STRATEGY.md` §8.4 "The known-failure rule".
5. Keep each test independent of the others, by the shard rule above.
6. If you change `surfaces.ts`, change `docs/a11y-manual-testing-checklist.md` §1 with it.

To update the tab-order snapshots after a deliberate change:

```bash
pnpm --filter @aeci/web exec playwright test -c playwright.a11y-nightly.config.ts keyboard --update-snapshots
```
