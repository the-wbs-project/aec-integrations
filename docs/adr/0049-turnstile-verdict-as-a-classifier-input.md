# ADR 0049: A Turnstile verdict per page view, as classifier evidence

- Status: Accepted. Capture built. Amended 2026-10-29: the secret is CI-pushed and deploy-required on every tier. Production's site key waits on AECI-1458.
- Date: 2026-10-28
- Issue: AECI-1457 (capture; the classifier rule follows in AECI-1528). Closes AECI-1330, the gateway `Server-Timing` stamp.
- Relates to: ADR 0045 (the edge log; this revives its parked AECI-1330); ADR 0041 (the raw page-view store); ADR 0022 (log-class writes); `docs/ADMIN_PANEL_SPEC.md` §13 D19(e) and D19(g); `docs/DATABASE_SCHEMA.md` §9.1; `docs/API_CONTRACTS.md` §6.9; `docs/ANALYTICS.md` §5; `docs/waf-rate-limits.md` §3b, §6.2

## Context

The D19 traffic classifier cannot tell a headless browser on a residential proxy pool from a person. Our own beacon checks pass a real headless Chrome, because it is a real browser. Bot Management would answer this, but it is not licensed and will not be for now (AECI-1300). D19 already plans to take vendor-maintained verdicts as inputs.

Cloudflare Turnstile in invisible mode runs a check in the browser and returns a single-use token. Siteverify turns the token into pass or fail. It shows the visitor nothing and blocks nothing. Chris ruled on 2026-10-22 to run it on every public page and keep a per-view verdict. The same ruling says an invisible, non-blocking widget is not a blocking-policy change and not a new public surface (D19(g)).

Two problems shaped the build. A landing view's row is written by the SSR gateway, which never sees a token. And a cached page cannot carry the page load's Ray ID in its HTML.

## Decision

**One verdict per view, stored as evidence.** `page_views.turnstile_verdict` holds `pass`, `fail` or `unknown` (migration `0095`). Null means no check ran. It feeds the classifier as one more input. It is **never an exclusion axis**: nothing drops or hides a row on it. `fail` means siteverify rejected the token: an invalid token, or a `cData` that is present and differs. A widget that cannot produce a token sends none, so the row stores null and the metric says `absent`. Under D19's single-signal rule a `fail` alone stays Unresolved. `pass`, `unknown` and null are never automation evidence.

**In-app views verify before the insert.** The beacon carries `turnstile_token`. The API calls siteverify inside the capture's existing `waitUntil`, after the dedupe and sampling exits, and only for a row that will be written. That is one row write, and the raw envelope gets the verdict too. A timeout, a non-2xx or a network error stores `unknown`. A verify failure never costs the row or delays the `204`. The token is never stored, in D1 or in the raw envelope.

**Landing views verify against the page load's Ray ID.** The gateway stamps `Server-Timing: cfray;desc="<ray>"` on every response, after the cache, so each HIT and MISS gets its own ray (AECI-1330). The browser reads it, runs the widget with the ray as `cData`, and posts `{ cf_ray, token }` to `POST /api/page-views/turnstile`. Siteverify echoes `cdata`. A `cdata` that is present and differs is `fail`, so a token minted for one page load cannot vouch for another row. A success with `cdata` missing is `unknown`, because it says nothing about the visitor.

**The landing UPDATE is keyed on the ray, bounded by time, with no index.** It matches `cf_ray`, `writer_provenance = 'ssr-arrival'`, `turnstile_verdict IS NULL`, `privacy_signal = 0` and `created_at` within the last 10 minutes. The time bound lets it ride `page_views_created_at_idx`. An index on `cf_ray` or on the verdict would add an index row to every insert on the hottest write path. First verdict wins. One retry after 2 s covers an arrival write still in flight.

**The script runs before consent, and DNT/GPC skips it.** It is classifier evidence for the census row, not product analytics, so the cookie choice does not gate it. A DNT/GPC visitor gets no script and a null verdict. The lawful basis for running it pre-consent is with counsel (AECI-1458). The privacy policy draft names the check and references Cloudflare's Turnstile Privacy Addendum, which invisible mode requires.

**The site key is the switch; the secret is deploy-required (amended 2026-10-29).** The browser loads the Turnstile module by dynamic import, and only when a site key is present. A tier with no site key ships no Turnstile code to the browser. The web Worker's public `TURNSTILE_SITE_KEY` is a committed per-env var: required on staging and demo, absent on production until AECI-1458 closes (`apps/web/src/turnstile-site-key.spec.ts`). The API Worker's `TURNSTILE_SECRET_KEY` is part of the deployment process. Each tier has its own GH secret, `TURNSTILE_SECRET_KEY_{STAGING,DEMO,PRODUCTION}`, listed in `REQUIRED_SECRETS`, so a missing one fails the deploy. CI pushes it to the API Worker (`apps/api/src/turnstile-secrets-ci.spec.ts`). The 2026-10-28 text had the secret hand-set and unset everywhere. Chris ruled on 2026-10-29 that a deploy must fail when the key is missing. No site key means no script and no token, so production stays dark while still carrying the secret. Its in-app beacons count as `verdict:absent`. The runbook is `docs/environments.md` "Turnstile per tier".

## Consequences

- **The classifier gains a vendor-maintained browser signal without Bot Management.** It does not read it yet. AECI-1528 adds the rule under a classifier version bump, after a `POST_LAUNCH_MONITORING.md` §3c shadow run on enabled data.
- **Every verdict costs one siteverify subrequest.** The landing endpoint takes the in-Worker `token` bucket by IP, because it is anonymous. A 429 costs one verdict, never a page. The beacon itself stays unlimited.
- **Some verdicts are lost by design.** An in-app beacon waits for its token, up to about 8 s. A tab closed in that window loses the beacon. A never-cached landing route has no arrival row, so its verdict post spends a siteverify call and finds nothing (`outcome:no_row`, ruled accepted 2026-10-28).
- **`unknown` is watched.** Metric `aeci.pageviews.turnstile`, alert `pageviews-turnstile-unknown` above 20% in an hour. A wrong secret reads as about 100% `unknown`, so the runbook checks the secret first.
- **Cloudflare's frame stores an identifier before consent.** The check sets no cookie, but its frame on `challenges.cloudflare.com` keeps one random identifier, `cf.turnstile.u`, in local storage, and it persists. We never read or receive it. Whether that storage access needs consent under ePrivacy rules is a question for counsel in AECI-1458, alongside the lawful basis.
- **The CSP grants `https://challenges.cloudflare.com` on every tier**, in `script-src` and a new `frame-src`. On a dark tier the grant loads nothing.
- **The stamp is public.** `Server-Timing` carries the Ray ID that `cf-ray` already exposes. Scanners flag it as informational; `docs/CODE_REVIEW_EXEMPTIONS.md` EX-006 records the acceptance.
- **Log-class.** `page_views` is exempt from `audit_log` (ADR 0022). Nothing written here renders on a cached page, so there is no purge.

## Alternatives considered

- **Make the verdict an exclusion axis, like `is_bot`.** Rejected. A false `fail` would delete a real visitor from every figure. D19 holds that one signal never settles identity.
- **Verify after the D1 write and UPDATE the row.** Rejected on 2026-10-28. It costs a second write per view and leaves the raw envelope without the verdict.
- **Have the browser write landing views too.** Rejected. AECI-1297 moved arrivals to the gateway so no-JS visitors and cache hits keep their rows.
- **Print the ray into the HTML.** Rejected. A cached page would replay the ray of the request that filled the cache.
- **Index `cf_ray`.** Rejected. The 10-minute `created_at` bound already narrows the scan, and the index would tax every insert.
- **Gate the script on the consent banner.** Rejected for now. The verdict exists to classify the census row, which every visitor writes. Counsel may overturn this in AECI-1458, and then the enable runbook simply stays unrun.
