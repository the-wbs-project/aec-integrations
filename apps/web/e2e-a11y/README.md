# The accessibility nightly (`e2e-a11y/`)

AECI-1875 built this harness. The sub-issues of AECI-1874 add the checks. The full description is
`docs/TESTING_STRATEGY.md` §8.4. The workflow and its alert are `docs/CICD_PLAN.md` §11a-quater.

| File | What it is |
|---|---|
| `surfaces.ts` | The one list of surfaces, `SURFACES`, and `personaCredentials()`. Add a surface here, never in a spec. |
| `surfaces.spec.ts` | The placeholder check: each surface answers its status and renders one visible `h1`. |
| `keyboard-*.spec.ts` | The keyboard walkthroughs (AECI-1877), one file per persona. The checks are in `support/keyboard-suite.ts`. `docs/TESTING_STRATEGY.md` §8.4.1. |
| `__snapshots__/chromium/` | The committed tab-order snapshots, one per surface. A change is a behaviour change: review it. |
| `support/` | Helpers every spec shares. `surface-page.ts` mints the session, skips, and waits for hydration. `tab-walk.ts`, `probe.ts`, `tab-candidates.ts` and `overlay-check.ts` are the keyboard tools. `page-guards.ts` blocks writes. |
| `known-failure.ts` | `knownFailure('AECI-<n>', reason)`, the only allowed way to mark a test as failing. |
| `summary-reporter.ts` | Writes `apps/web/a11y-nightly-summary.json`, which the alert and AECI-1682 read. |

The PR e2e job never runs these specs. They run from `playwright.a11y-nightly.config.ts`:

```bash
pnpm test:a11y:nightly
```

Against `pnpm dev:agent`, set `AECI_WEB_PORT` and `PLAYWRIGHT_BASE_URL` to the web port it printed.
The signed-in surfaces need the `SUPABASE_*TEST_USER_*` pairs in `apps/web/.dev.vars`. Without them those
surfaces skip, and a run that skipped them proved nothing about them.

To add a check:

1. Write a spec here that loops over `SURFACES`.
2. Start each test with `prepareSurface()` and `openSurface()` from `support/surface-page.ts`. Give it
   `surfaceAnnotations(surface)`, so the summary names the surface.
3. Mark a barrier you cannot fix yet with `knownFailure()`, never a bare `test.fail()`. `pnpm test:scripts` enforces it.
4. If you change `surfaces.ts`, change `docs/a11y-manual-testing-checklist.md` §1 with it.

To update the tab-order snapshots after a deliberate change:

```bash
pnpm --filter @aeci/web exec playwright test -c playwright.a11y-nightly.config.ts keyboard --update-snapshots
```
