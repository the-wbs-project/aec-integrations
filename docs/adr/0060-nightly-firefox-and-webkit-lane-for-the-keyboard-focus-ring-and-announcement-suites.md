# ADR 0060: A nightly Firefox and WebKit lane for the keyboard, focus ring and announcement suites

- Status: Accepted. Chris accepted this record on 2026-11-26, with the recommended answer to each of the seven open questions. Built under AECI-1885.
- Date: 2026-11-25
- Issue: AECI-1885, sub-issue 11 of the epic AECI-1874. Chris accepted a nightly cross-browser lane in principle on 2026-11-19, ruling 1 on AECI-1874.
- Supersedes: one sentence of ADR 0012's retirement note, named under "What this supersedes in ADR 0012".
- Relates to: ADR 0012; `docs/TESTING_STRATEGY.md` §7.7, §8.4, §8.4.1, §8.4.4 and §8.4.5; `docs/CICD_PLAN.md` §11a-quater; `docs/a11y-manual-testing-checklist.md` §2, §6 and §7; `docs/LEGAL_IMPACT_REVIEW.md` §3

## Summary

Run three nightly accessibility suites in Playwright's Firefox and WebKit builds, as well as Chromium. The suites are the keyboard walkthroughs, the focus ring check and the announcement checks. The lane runs once a night against `main`, never on a PR, and uses no BrowserStack. It adds about 6 runner jobs and 50 to 70 runner minutes a night, at no charge, because the repo is public. It does not test real Safari or real Firefox, so the manual pass keeps its full scope and cadence.

**Legal impact:** none — a test-only CI lane. The accessibility statement's "How we test" sentences stay true, and the manual pass keeps its scope and cadence. No personal data, vendor, billing or moderation behaviour is touched.

## Context

Every automated accessibility check runs in Chromium only. The manual checklist asks for a keyboard-only pass "in each browser", and its scripted walks use Safari with VoiceOver and Firefox with NVDA. Keyboard behaviour differs between engines in ways a Chromium run cannot see. Which elements are Tab stops, how a `<details>` or a scroll container takes focus, and when `:focus-visible` matches are all engine rules.

Playwright ships its own Firefox and WebKit builds with the version the lockfile already holds, 1.64.1. The three suites were written to be portable where they could be. Four notes in the code name the known differences:

| Where | What it says |
|---|---|
| `support/tab-candidates.ts` | `candidateTabStops` models Chromium's rule that a scroll container with no focusable content is a Tab stop. `keyboardFocusableScrollers: false` turns it off for another engine |
| `support/tab-walk.ts`, `support/probe.ts` | The walk and the probe use portable DOM and Playwright's `ariaSnapshot()`, so they run in every engine. Safari skips links on Tab unless a system setting is on |
| `playwright.a11y-nightly.config.ts` | The snapshot path is keyed by browser project: `__snapshots__/chromium/` today |
| `support/focus-probe.ts`, `support/focus-pixels.ts` | Colours go through a 1x1 canvas, because Chrome reports `oklch()`. The PNG decoder reads the one format Chromium writes and throws on any other |

The announcement recorder in `support/announcements.ts` uses a `MutationObserver`, which every engine has.

### Why the last cross-browser lane was removed

ADR 0012 added a BrowserStack lane in Phase 7.8 under AECI-154. AECI-1269 removed it on 2026-10-10. The reasons, from the issue and from ADR 0012's note:

- The workflow had been disabled by hand since 2026-06-26.
- Its last 8 runs failed.
- It never gated a merge or a deploy.
- It needed a paid personal BrowserStack subscription, which Chris was asked to cancel.

AECI-1269 deleted the workflow, both BrowserStack configs, the `test:e2e:browserstack` script, the `browserstack-node-sdk` dependency, the MCP server entry and the repo secrets. `docs/TESTING_STRATEGY.md` §7.7 says a new cross-browser lane needs a new decision record. This is that record.

None of those reasons applies to Playwright's own builds. They need no account, no secret and no network hop. They run on the same runner, against the same local `dev:bound`, as the Chromium suites.

## Decision

1. **A nightly-only lane.** The nightly workflow `a11y-nightly.yml` gains one job that runs the three suites in Playwright's `firefox` and `webkit` projects. It runs on the same schedule, the same skip rule and the same commit as the rest of the nightly.
2. **The PR job does not change.** `apps/web/playwright.config.ts` keeps its single `chromium` project. The two new projects are declared in `playwright.a11y-nightly.config.ts` only. `deploy.yml` still installs and runs Chromium only.
3. **The existing Chromium shards do not grow.** The eight `suite` shards pass `--project=chromium`. Without it, a nightly config with three projects would run every suite three times.
4. **No BrowserStack.** No account, SDK, secret, MCP server or cloud grid comes back.
5. **Real Tab presses only, as today.** The lane reuses `tabWalk`, `measureWalk` and the recorder unchanged. No test calls `el.focus()` in any browser.

### Scope

The lane runs these suites over every surface in `apps/web/e2e-a11y/surfaces.ts`, signed in and signed out:

| Suite | Spec files | Section | Tests per browser |
|---|---|---|---|
| Keyboard walkthroughs, sub-issue 3 | `keyboard-public`, `keyboard-reviewer`, `keyboard-admin`, `keyboard-vendor` | §8.4.1 | About 111, estimated from the source: 22 surfaces with 5 tests each, plus one overlay scenario |
| Focus ring, sub-issue 4 | `focus-ring` | §8.4.5 | 25, measured |
| Announcements, sub-issue 6 | `announcements-public`, `announcements-signed-in` | §8.4.4 | About 38, estimated from the source |

Out of scope:

| Left out | Why | Could Chris add it later? |
|---|---|---|
| The whole e2e suite | It is 838 tests of product behaviour, not accessibility. That is what ADR 0012 tried, and what AECI-1269 retired | Not under this record |
| The e2e axe sweep | axe runs the same rules in every engine. A second and third run would mostly repeat the first | No. The value is low |
| ARIA snapshots, §8.4.3 | 56 committed snapshots would become 168. Playwright computes roles and names in its own script, so the trees should barely differ between engines. That last point is unverified | Yes, if the keyboard lane finds name differences |
| Magnification, §8.4.6 | `support/magnify-probe.ts` opens a Chrome DevTools session, and its scrollbar widths are measured for Chromium on Linux | Only after a rewrite without DevTools |
| Interaction, §8.4.7 | 185 tests that took 15.2 to 17.4 minutes on one local worker. Its forced-colours check is Chromium's emulation | Yes, as a later option. It would roughly double the lane's cost |
| Voice control, §8.4.8 | `support/voice-probe.ts` reads Chromium's accessibility tree over DevTools. It cannot run elsewhere | No |
| IBM Equal Access, §8.4.9 | A second rule engine, report only. The same argument as axe | No |

### What this lane does not prove

**Playwright WebKit is not Safari.** It is a WebKit build that Playwright patches and drives. On a Linux runner it is not even the macOS port of WebKit. Real Safari on macOS skips links on Tab unless "Press Tab to highlight each item" is on. The issue states that Playwright WebKit does not model that setting. A WebKit walk therefore shows what a Safari user with that setting on would meet, at best. That is unverified until the first run shows whether a WebKit walk reaches links.

**Playwright Firefox is not a Firefox release.** It is a patched build, on Linux, with no screen reader attached.

These still need real browsers, and stay in the manual pass:

| Check | Needs | Where in the checklist |
|---|---|---|
| Tab order with Safari's default setting, where links are skipped | Real Safari on macOS | §2 keyboard-only, in each browser |
| Everything VoiceOver speaks | Real Safari with VoiceOver | §6, V1 to V15 |
| Everything NVDA speaks, and browse and forms mode | Real Firefox and Chrome on Windows with NVDA | §7, N1 to N11 |
| The focus ring as macOS and Windows draw it, at the user's own zoom and theme | Real browsers on each OS | §2 keyboard-only |
| iOS Safari and Android | Real devices | Not covered by any lane since AECI-1269 |

The manual pass keeps its scope and its cadence. The accessibility statement promises "a manual keyboard and screen-reader checklist" before major releases. `docs/LEGAL_IMPACT_REVIEW.md` §3 makes a change to that cadence a legal-impact change. This record does not narrow the checklist, and the build must not either. The notes it adds to checklist §2 say the same thing the Chromium notes say today: "The manual pass above keeps its full scope and cadence."

### How differences are handled

1. **A difference by design is a per-browser expectation with a reason.** It lives in one typed table beside the check, keyed by browser and by check. Each entry names the element or rule it covers, why the engine differs, and a link to the spec or engine bug. The `keyboardFocusableScrollers` setting is the first entry. It is set from the run's project name, never by a blanket skip.
2. **The Chromium assertion is never loosened.** An entry for `firefox` or `webkit` cannot change what Chromium checks. A spec in `scripts/` or the unit runner pins that every Chromium value is the one Chromium has today.
3. **Each browser has its own snapshot directory.** The keyboard snapshots go to `__snapshots__/firefox/` and `__snapshots__/webkit/` beside `__snapshots__/chromium/`. That is 22 snapshot files per browser, 66 in all. A change that alters a tab order updates all three in the same PR.
4. **A real barrier in one browser is a barrier.** It is filed under AECI-1069 and marked with `knownFailure('AECI-<n>', reason)`. The barrier tables `KNOWN_BARRIERS` and `KNOWN_FOCUS_BARRIERS` gain a browser field. A WebKit-only barrier marks the WebKit test only. It covers only its own finding, as the Chromium marks do today, so a new finding on the same surface still fails.
5. **A harness problem is fixed in the harness.** If a probe reads wrong in one engine, the probe is fixed. It is never an expectation and never a barrier.

## What this supersedes in ADR 0012

ADR 0012's note of 2026-10-10 says: "E2E stays chromium-only. There is no cross-browser or real-device lane today."

This record supersedes the second sentence for one case only: the nightly accessibility lane, in Playwright's own builds, over the three suites above. Everything else in the note stays retired:

- BrowserStack in every form: the workflow, the SDK, both configs, the secrets and the MCP server.
- Real-device testing, real iOS Safari and real Android.
- Any cross-browser run on a PR or a merge.
- The whole e2e suite in more than one browser. The PR e2e job stays Chromium only.
- Percy. Chromatic stays the visual tool.

On acceptance, ADR 0012's note and its line in `docs/adr/README.md` gain a pointer to this record. Their history is not rewritten.

## Cost

Every figure below is marked. "Measured" means a number in the repo's docs from a real run. "Estimated" means arithmetic on measured numbers. Every measured time is local, on one worker, on a laptop, 2026-11-24. No CI time for these suites exists yet.

### Inputs

| Figure | Value | Kind | Source |
|---|---|---|---|
| Jobs the nightly runs at once today | 12: 8 `suite`, 4 `e2e-axe` | Documented | `docs/CICD_PLAN.md` §11a-quater |
| Concurrent jobs a public repo gets | 20 | Documented, not checked against GitHub | §11a-quater |
| Signed-out keyboard walks | 80 tests, 7.0 min | Measured | §11a-quater |
| Focus ring | 25 tests, 6.1 min. §8.4.5 gives 5.6 to 6.5 | Measured | §11a-quater, §8.4.5 |
| The other 185 tests of that 290-test run | 10.1 min. It holds the signed-in keyboard walks, the announcements, the ARIA checks and the placeholder | Estimated: 23.2 minus 7.0 minus 6.1 | §11a-quater |
| Signed-in keyboard walks and announcements alone | We do not know | | |
| Setup per shard: install, build, browser install, boot | About 4 min | The doc's own estimate | §11a-quater |
| Firefox and WebKit speed against Chromium | We do not know | | |
| A GitHub runner against the laptop | We do not know. The doc says the runner is slower | | §11a-quater |
| Firefox and WebKit download size, install time and `install-deps` time | We do not know | | |
| Runner minutes cost | 0. Standard runners are free on a public repo | Documented | AECI-1874 "Why" |

So one browser's share of the three suites is at least 13.1 minutes, the two measured groups. It is at most 23.2 minutes, the whole run they were part of. The table below calls that range T.

### Layouts, for two more browsers

Times are local, one worker, Chromium speed. Multiply by the unknown engine and runner factors.

| Layout | New jobs | Jobs at once | Under 20 by | Test time per shard | Added runner minutes a night |
|---|---|---|---|---|---|
| A: 2 shards per browser | 4 | 16 | 4 | 6.6 to 11.6 min | 42 to 62 |
| **B: 3 shards per browser, proposed** | 6 | 18 | 2 | 4.4 to 7.7 min | 50 to 70 |
| C: 4 shards per browser | 8 | 20 | 0 | 3.3 to 5.8 min | 58 to 78 |
| D: inside the 8 Chromium shards | 0 | 12 | 8 | 3.3 to 5.8 min more per shard, unevenly | 26 to 46, plus both browsers installed on all 8 shards |

The arithmetic: runner minutes are jobs times 4 minutes of setup, plus 2T. Test time per shard is T divided by the shards per browser, assuming an even split. Playwright splits by test count, not time, so the real split is uneven. §11a-quater saw one shard take 10.7 minutes while another took 1.5.

**B is proposed.** Suppose WebKit ran twice as slow as Chromium, which is a guess. An even B shard would then take about 15 minutes of tests and 4 of setup, inside the 30-minute limit. B also stays under the 20-job figure. A job past the limit waits in the queue. It does not fail, so going over costs wall-clock time only. D is rejected because it couples the Chromium result to two new engines, and it re-balances shards that were tuned by measurement.

**Wall clock.** The new jobs run beside the existing ones. The nightly gets longer only if a cross-browser shard outlasts the slowest existing shard, about 7 minutes of tests locally. We do not know whether it will.

**Browser install and cache.** The PR job and the nightly share one cache key today: `playwright-<os>-<image>-<lockfile hash>`. A job that installs three browsers under that key would race the PR job, which saves Chromium alone. Whichever saves first wins, and a cross-browser job that restores a Chromium-only cache cannot launch Firefox. The new job therefore uses its own key prefix, built the same way. A cache hit still runs `playwright install-deps firefox webkit` for the system libraries, as the Chromium steps do. The cache size and the install time are not known. The first run measures them: the cache save step logs the archive size, and each step's time is in the job log.

**How the first run measures the rest.** One `workflow_dispatch` run of the built lane records each shard's wall clock and the per-test times in its HTML report. Those replace the estimates above, in §11a-quater, in the same PR that makes the lane scheduled.

## Consequences

- **Three snapshot sets to review.** A change to a tab order now shows in up to three diffs. The reviewer judges each.
- **Local snapshots may not match CI for WebKit.** Chromium is the same engine on a Mac and on Linux, which is why the path is keyed by project, not OS. Playwright's WebKit on macOS and on Linux are different ports. Whether their Tab walks differ is unverified. If they do, the WebKit snapshots are written by a CI run, not on a laptop.
- **More flake surface.** Two more engines, each with its own timing. CI retries a failed test once, so a test that passes on retry does not turn the night red, but it is counted as flaky.
- **A longer nightly, in runner minutes.** About 50 to 70 more a night under layout B, before the unknown engine and runner factors.
- **The `report` job counts more summaries.** It checks that all twelve summaries arrived today. The new shards add six more, and the workflow spec `scripts/a11y-nightly-workflow.test.mjs` pins the count.
- **New barriers.** Some findings will be real barriers in one browser. Each is a new issue under AECI-1069. That is the purpose of the lane, but it is also work.
- **The lane is green on the day it lands.** That is the epic's rule. Every failure on landing is either a per-browser expectation with a reason or a filed barrier with a `knownFailure` mark.

### Docs that change when the lane is built

None changes with this record. The build PR changes:

| Doc | What changes |
|---|---|
| `docs/TESTING_STRATEGY.md` §7.7 | The heading and text: one nightly cross-browser lane exists, in Playwright's builds, under this ADR |
| `docs/TESTING_STRATEGY.md` §8.4 | The boundary, the shards paragraph and the projects |
| `docs/TESTING_STRATEGY.md` §8.4.1 | The snapshot paths, and the "Two places are Chromium-only" paragraph |
| `docs/TESTING_STRATEGY.md` §8.4.4, §8.4.5 | The browsers each suite runs in. §8.4.5 "Limits" says the pictures are Chromium only |
| `docs/CICD_PLAN.md` §11a-quater | The jobs table, the summary count, the concurrency figure and the measured times |
| `docs/a11y-manual-testing-checklist.md` §2 | The automation notes say "in Chrome" and "or run outside Chrome (AECI-1885)". They name the three browsers, and say what still needs real Safari |
| `apps/web/e2e-a11y/README.md` | The projects and how to update the per-browser snapshots |
| `docs/adr/README.md`, ADR 0012 | This record becomes Accepted, and ADR 0012 points to it |

`docs/OBSERVABILITY.md` changes only if Chris picks a separate alert in question 2.

## Exit

**Proposal, not a ruling.** The lane is removed, or set to dispatch only, when either test holds:

1. **Too many false failures.** More than 3 false red nights in any 14 nights in a row. A false red night is one where the cross-browser lane is red and the cause is not a site barrier: a flake that survived the retry, a browser build fault, or a runner fault.
2. **No value.** After 60 nights, the lane has found no barrier that the Chromium suites missed. Chris then reviews whether to keep it.

The night's summary already records each test's outcome and its known-failure mark. The build adds the browser to each test's entry, so both counts can be read from the kept summaries. They are kept for 30 days, so the 60-night review needs the dated record AECI-1682 plans, or a count kept on the epic.

## Alternatives considered

- **Do nothing, and keep the manual pass only.** It costs nothing, and the manual pass already covers Safari and Firefox. It was not chosen because the manual pass runs only before major releases. A Firefox-only or WebKit-only trap could ship and stay live until the next one.
- **Firefox only.** Half the cost, and Firefox is the browser the NVDA walk uses. It was not chosen because WebKit is the engine with the largest known keyboard difference, the link rule. Leaving it out drops the most likely finding.
- **WebKit only.** Half the cost, and it covers the Safari engine. It was not chosen because Firefox has its own focus rules, and NVDA users meet them. The extra cost of the second browser is about 25 to 35 runner minutes a night, at no charge.
- **Bring back BrowserStack.** It is the only option that reaches real Safari and real devices. It was not chosen for the reasons AECI-1269 gave: a paid account, secrets, a network hop, and a lane that failed and was switched off. It would also not replace the manual screen-reader pass.
- **Weekly, not nightly.** About one seventh of the runner minutes. It was not chosen because minutes cost nothing here, and a weekly run puts up to six days of merges between a break and its alert. A failure would also be harder to tie to one commit. If the exit test on false failures is close, weekly is the first step down before removal.

## Open questions for Chris

1. **Which shard layout?** A uses 16 jobs at once, B 18, C 20. *Recommendation:* B, three shards per browser. It has the most room under the time limit at the cost of 2 more jobs than A.
2. **Same status and alert, or its own?** The lane could feed the one `a11y-nightly` status and alert, or post its own status, `a11y-nightly-cross-browser`, and its own Linear label. *Recommendation:* the same status and alert. One red signal is easier to act on, and the epic's known-failure rule keeps it green on landing. The exit test is the guard against noise.
3. **Keep announcements in scope?** The recorder reads the DOM, so most of its checks behave alike in every engine. The engine-dependent part is focus: a `focus` entry depends on where the engine puts focus. Safari does not focus a button on click. Whether Playwright WebKit on Linux does the same is unverified. *Recommendation:* keep it. It is about 38 tests, and it is the part most likely to differ in WebKit. Strike it if cost matters more.
4. **Every surface, or public pages only?** Signed-in surfaces need a minted session in each browser, and that is the part most likely to break first. *Recommendation:* every surface, as the Chromium suites do. The admin and portal surfaces hold the dialogs and menus where a trap is most likely.
5. **Where are WebKit snapshots written?** *Recommendation:* by a CI dispatch run that uploads them as an artifact, if the first run shows macOS and Linux WebKit walks differ. Otherwise on a laptop, as Chromium's are.
6. **Accept the proposed exit test?** More than 3 false red nights in 14, or no new barrier in 60 nights. *Recommendation:* accept it as written, and revisit the numbers after the first 14 nights.
7. **Add the interaction suite later?** *Recommendation:* no, not under this record. Revisit after 14 green nights, with its measured cost.

## Unverified claims

Each needs the built lane's first run, or a read of Playwright's source. None was run for this record.

| Claim | How to verify |
|---|---|
| Playwright WebKit does not model Safari's "Press Tab to highlight each item" setting | The first WebKit keyboard walk: check whether links are Tab stops |
| Firefox and WebKit do not make an empty scroll container a Tab stop, as `support/tab-candidates.ts` says. Firefox may in fact do so | The candidate diff in each browser's first walk |
| `ariaSnapshot()` roles and names barely differ between engines | Compare the first run's three snapshot sets |
| Firefox and WebKit screenshots decode with `decodePng`, and `scale: 'css'` behaves the same | The first focus ring run. The decoder throws on an unknown format, so a mismatch is loud |
| The canvas conversion reads `oklch()` colours in Firefox and WebKit | The first focus ring run, and the `focus-pixels` unit spec in each browser |
| Playwright 1.64.1 installs WebKit and Firefox on the `ubuntu-26.04` runner | The first dispatch run's install step |
| Session minting works the same in Firefox and WebKit | The first run's skip count on signed-in surfaces |
| macOS and Linux WebKit give the same Tab walk | One local WebKit walk on a Mac against the CI snapshot |
| The 20-job figure is not shared with the other repos in the GitHub organisation | GitHub's plan settings for the organisation |
| Every time in the cost section | The first dispatch run's job log and HTML report |

## As built (2026-11-26, AECI-1885)

The decision above stands. The build ran the three suites locally in Playwright 1.64.1's Firefox 157.0
build and WebKit 27.2, on macOS, one worker. Those runs corrected some of this record's claims. The
lane's description is `docs/TESTING_STRATEGY.md` §8.4.10.

| Claim | Outcome |
|---|---|
| Playwright WebKit does not model Safari's "Press Tab to highlight each item" setting | **Wrong on macOS.** It models the default, setting off: a plain Tab walk of home reached only the two text fields. Option+Tab reaches every item, in Firefox's order. WebKit walks press Option+Tab. They test the setting turned on, not Safari's default. Linux WebKit is not measured |
| Firefox and WebKit do not make an empty scroll container a Tab stop. Firefox may | **Half wrong.** Firefox does, and it also stops on a scroll container that holds a link. WebKit makes no scroll container a stop |
| `ariaSnapshot()` roles and names barely differ between engines | **True for the tab orders.** All 22 surfaces give the same roles and names in all three browsers. The one difference is a Firefox-only stop on the account page, the scroller rule. The ARIA snapshot suite did not run outside Chromium |
| Screenshots decode with `decodePng`, and `scale: 'css'` behaves the same | **True on macOS.** No decode error in either browser |
| The canvas conversion reads `oklch()` colours in Firefox and WebKit | **True on macOS,** from the focus ring runs. The `focus-pixels` unit spec runs in Node, so it does not test a browser |
| Playwright 1.64.1 installs WebKit and Firefox on the `ubuntu-26.04` runner | Not verified. Needs the first dispatch run. On macOS the install took 35 seconds, 309 MB for Firefox and 299 MB for WebKit |
| Session minting works the same in Firefox and WebKit | **True locally.** No signed-in surface skipped in either browser |
| macOS and Linux WebKit give the same Tab walk | Not verified. Needs the first CI run. §8.4.10 has the commands to rewrite WebKit snapshots on the runner |
| The 20-job figure is not shared with the other repos in the organisation | **Wrong.** The organisation is on GitHub's Team plan. GitHub's published limit for Team is 60 concurrent jobs, counted for the whole organisation. Read from the plan, not measured |
| Every time in the cost section | Local one-worker times are in `docs/CICD_PLAN.md` §11a-quater. CI times need the first run |

**Not foreseen here.**

- Playwright Firefox does not wrap: Tab on the last stop leaves focus there. The walk now wraps by hand
  with real key presses (`sequentialFocusWraps`).
- A WebKit click does not focus a button. Focus goes to `main`, so the announcement flows activate by
  keyboard in WebKit (`pointerFocusesButtons`).
- A focus ring barrier test found in one browser is kept out of the others by a `@not-<browser>` tag and
  `grepInvert`. A Chromium skip row would have changed the Chromium result.
- `report` now counts eighteen summaries.

**Barriers the lane found on landing,** each filed under AECI-1069 and marked for its browsers only:
AECI-2195 (focus under the consent banner, Firefox and WebKit), AECI-2196 (the login button moves under
the pointer), AECI-2197 (WebKit's `outline: auto` ring on three named links), and AECI-2097 on one more
link in WebKit. Review 4 (2026-11-26) added a slow-press test, which loses the click in all three
browsers, so AECI-2196 is marked there for every browser.

**Before it merges,** the lane runs once on Linux by dispatch, because the WebKit snapshots and the
marks were captured on macOS. `docs/TESTING_STRATEGY.md` §8.4.10, "First run on Linux", has the steps.
