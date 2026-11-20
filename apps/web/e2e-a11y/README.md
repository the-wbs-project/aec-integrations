# The accessibility nightly (`e2e-a11y/`)

AECI-1875 built this harness. The sub-issues of AECI-1874 add the checks. The full description is
`docs/TESTING_STRATEGY.md` §8.4. The workflow and its alert are `docs/CICD_PLAN.md` §11a-quater.

| File | What it is |
|---|---|
| `surfaces.ts` | The one list of surfaces, `SURFACES`, and `personaCredentials()`. Add a surface here, never in a spec. |
| `surfaces.spec.ts` | The placeholder check: each surface answers its status and renders one visible `h1`. Copy its session and skip pattern. |
| `known-failure.ts` | `knownFailure('AECI-<n>', reason)`, the only allowed way to mark a test as failing. |
| `summary-reporter.ts` | Writes `apps/web/a11y-nightly-summary.json`, which the alert and AECI-1682 read. |

The PR e2e job never runs these specs. They run from `playwright.a11y-nightly.config.ts`:

```bash
pnpm test:a11y:nightly
```

Against `pnpm dev:agent`, set `AECI_WEB_PORT` and `PLAYWRIGHT_BASE_URL` to the web port it printed.

To add a check:

1. Write a spec here that loops over `SURFACES`.
2. Give each test the `surface` and `route` annotations, as `surfaces.spec.ts` does.
3. Mark a barrier you cannot fix yet with `knownFailure()`, never a bare `test.fail()`. `pnpm test:scripts` enforces it.
4. If you change `surfaces.ts`, change `docs/a11y-manual-testing-checklist.md` §1 with it.
