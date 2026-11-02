# Bot traffic classification

**Status: the record of truth for how AECi classifies traffic. It describes classifier `tc-2026.10.3`, checked against the code on 2026-11-02 at commit `e858d7be2`.**

This is the one place that states how page views are sorted into bots, people and everything in between. Part 1 explains every check for a reader who knows the product but not the code. Part 2 is the technical specification.

If another document disagrees with this file, this file wins and the other is a defect. If this file and the code disagree, the code shows what is running, and the difference is a defect to fix. The reasoning behind past decisions stays in `docs/ADMIN_PANEL_SPEC.md` §13 D19.

**Update this file in the same PR as any change to how traffic is classified.** That covers the checks, thresholds, crawler and network lists, classes, reason codes, internal-traffic rules, and which reports read the classes. Update Part 1 too whenever the change alters what it says. `mirror-docs-to-linear` copies it to Linear on merge and overwrites the Linear copy, so edits made in Linear are lost.

---

## Part 1: How it works, in plain language

### The short version

Most requests to our site do not come from people. They come from search engines, AI companies, scanners and scraping tools.

We cannot prove that any single request came from a person. So we do not sort traffic into "bots" and "humans". We sort every page view into one of four groups, based on the evidence we have.

| Group | What it means | Is it a real person? |
|---|---|---|
| **Identified automation** | The visitor says it is a bot, or Cloudflare has confirmed it is one. | No |
| **Suspected automation** | At least two different kinds of check point to a bot. | Probably not |
| **Browser with human evidence** | Our app ran in the visitor's browser, and nothing points to a bot. | Probably, but not proven |
| **Unresolved** | The evidence is missing, too thin, or contradictory. | We do not know |

Two rules shape everything else:

- **One clue is not enough to suspect a bot.** Real people use VPNs and office networks that look suspicious on their own. The only exception is a visitor that names itself as a bot or that Cloudflare has confirmed.
- **"No bot found" does not mean "human".** A visitor has to show positive evidence to reach the human group. Everyone else stays Unresolved.

These numbers count page requests, not people. One person reading five pages counts as five.

### Why this is hard

Everything a visitor sends us can be faked, and we choose not to track individuals. We set no tracking ID for this, so we cannot follow one person across visits.

Here is the example that shaped much of this system. On 2026-08-23 our daily report showed 48 "human" views. Those 48 came from 44 networks in 31 countries, but only 18 browser identities. One identity read nine different pages from nine different countries. None of the 48 produced any activity in our browser analytics. That was a crawler renting home internet connections, and it looked like dozens of separate visitors.

### The checks

#### At the front door

**Cloudflare's rules.** Cloudflare sits in front of our site. It challenges known scraping tools on our main browsing pages, and it lets confirmed search engines through. A request stopped here never reaches us, so it never appears in our numbers. These rules decide who gets in. They do not classify anything.

#### When a page is requested

We can only read some details at this moment, because we do not keep them afterwards.

| # | Check | The question it asks | What it can get wrong |
|---|---|---|---|
| 1 | **Cloudflare's confirmed list** | Has Cloudflare confirmed this is a known crawler, such as Googlebot? | Very little. This is the strongest evidence we have. |
| 2 | **The visitor's name tag** | Does the browser's description of itself name a known bot, or use a word like "bot", "crawler" or "spider"? We keep a list of 21 named crawlers. | A bot can leave the word out. A faker can also claim to be Googlebot. Either way it is still not a person. |
| 3 | **Who owns the network** | Does the request come from a data center or cloud company on our list of 109 networks? | A real person on a VPN or a cloud desktop looks the same. This is why it never decides alone. |
| 4 | **What kind of network it is** | Does a public directory list this network as a content or infrastructure company rather than an internet provider? | Many networks are not in the directory, and those tell us nothing. This counts as the same kind of clue as check 3, not a second one. |
| 5 | **Does the request look like a browser** | A real browser sends a recognizable set of details with each request. Are they all there, and do they agree with what the visitor claims to be? | Cheap tools fail this. A real browser driven by a robot passes, because it really is a browser. |

We keep networks like Apple's and large internet providers off the list in check 3 on purpose. Real people use them, and being on that list marks a request permanently.

#### Each night, looking across the whole day

Just after midnight UTC, we review the previous day. These checks need a full day of data, because they look for patterns no single request can show.

| # | Check | The question it asks | What it can get wrong |
|---|---|---|---|
| 6 | **One browser identity on many networks** | Did the same browser identity appear from a different network on nearly every view? This is the rented-connections pattern from the example above. | A very popular browser version could do this by chance. It works for us today because our traffic is small. We will need to revisit it as traffic grows. |
| 7 | **One network with a new identity every time** | Did one network show a different browser identity on nearly every view, and did most of those views fail check 5? | An office shares one network across many people. That is why this check also requires failing check 5. |
| 8 | **Did our app actually run** | Did the visitor click through to another page inside our app, from a request that passed the browser check? We also accept a click within 30 minutes of arriving. | A robot driving a real browser can pass. This is why the group says "human evidence" and not "humans". |
| 9 | **Where they came from** | Did the visitor arrive from Google, LinkedIn or another site? | We record this, but it does not change the group. Anyone can fake it. |

#### Other rules that apply

| Rule | What it does |
|---|---|
| **Is it us?** | We take out our own administrators' browsing. We know it is ours from admin pages, from an admin login, or from a matching browser and network within 30 days of a login. On 2026-08-19 our own browsing was 15% of all "human" public views. This is reported on its own line, not as one of the four groups. |
| **Vendors viewing their own listing** | We mark these visits today. Our site-wide numbers still count them. The planned vendor performance report will remove them. |
| **Visitors who ask for privacy** | When a browser sends a "do not track" or Global Privacy Control signal, we keep only an anonymous count. Without the details, we cannot check the visitor, so these views stay Unresolved unless they name themselves as a bot. |
| **Double counting** | Two identical views within about 10 to 20 seconds count as one. This does not apply to known bots. |

#### What we have but do not use yet

- **Cloudflare Turnstile.** This is an invisible browser test from Cloudflare. It never blocks anyone. It is collecting answers on our test sites only. Production waits on a legal question about visitors in the EU (AECI-1458). The classifier ignores its answer for now.
- **Spur Monocle.** This is a service that detects rented home connections. It is on hold, because it would send visitor IP addresses to a third party (AECI-1459).
- **Cloudflare Bot Management.** This is Cloudflare's paid bot scoring. We do not pay for it and decided not to on 2026-10-21. We ignore any score it produces.

### How the checks become a group

The system asks these questions in order and stops at the first "yes".

1. **Did Cloudflare confirm it, or did the visitor name itself as a bot?** It goes to Identified automation.
2. **Do at least two different kinds of check point to a bot?** It goes to Suspected automation. There are four kinds: the network (checks 3 and 4), the browser check (5), many networks (6), and many identities (7).
3. **Did our app run, with no bot clue against it, and is this not a privacy-signal view?** It goes to Browser with human evidence.
4. **Otherwise,** it goes to Unresolved, with a recorded reason.

### Examples

We ran each of these through the real classifier code.

| Situation | Group | Why |
|---|---|---|
| Googlebot, confirmed by Cloudflare | Identified automation | Confirmed by Cloudflare |
| A tool calling itself Googlebot, from a rented server | Identified automation | It named itself. Our record shows it was not confirmed. |
| A browser-like visitor on Amazon's cloud, with incomplete browser details | Suspected automation | Two kinds of clue agree: network and browser check |
| A browser-like visitor on Amazon's cloud, with perfect browser details | Unresolved | Only one kind of clue |
| One browser identity spread across many networks, with incomplete browser details | Suspected automation | Two kinds of clue agree |
| **A real person arrives from Google, reads one page and leaves** | **Unresolved** | **Our app's activity was never observed** |
| A real person arrives from Google and clicks to a second page | Browser with human evidence | Our app ran, and nothing contradicts it |
| A real person on a cloud VPN who clicks around | Unresolved | Our app ran, but the network is suspicious, so the evidence conflicts |
| A careful person with a privacy signal on, clicking around | Unresolved | We keep too little to confirm it |
| An AECi administrator browsing while signed in | Reported as our own traffic | Taken out by identity, whatever the group |

### How to read the numbers

- **Unresolved is expected to be large.** It holds real one-page visitors and quiet bots side by side. We do not split it, because we would be guessing.
- **The real audience sits between two figures.** Browser with human evidence is close to a floor. Adding Unresolved gives a rough ceiling. Neither is a count of people.
- **A growing Unresolved share is a finding, not a failure.** It can mean our evidence got worse. We get a warning when it passes 50% of a day's non-internal views.
- **The group definitions have versions.** When the rules change, reports mark the change and do not compare across it. Old results are kept.
- **A day can be flagged as degraded.** If more than 5% of arrivals lost their network details, the report says the network checks could not run. This happened from 2026-09-07 until the fix on 2026-09-13, when four blind days looked like a good week.

### Where you see this

| Where | What it shows |
|---|---|
| **Daily email and the admin overview** | The four groups, our own traffic on a separate line, and any warnings |
| **Admin activity page** | The group for each individual view, with a filter |
| **Top products and top sources** | Views with known or suspected bots removed, and views from the listed data center networks |
| **Vendor performance report, not built yet (AECI-940)** | The spec calls for the same removal, plus the vendor's own visits. Vendors will never see the groups. |
| **Public "trending" card on the home page** | The older, simpler filter. It does not use the four groups yet. See question 2. |

No page, visitor or vendor is ever blocked or penalized because of a group. Classification only affects reports.

### Open questions

1. **Are we comfortable that a real person who reads one page is Unresolved?**
   - Why it matters: search visitors often read one page. Our human-evidence figure misses them, and we do not know by how many.
   - Option: wait for Turnstile on production, which could provide evidence without a click. This depends on the AECI-1458 legal answer.
2. **Should the public trending card use the four groups?**
   - Why it matters: it can still count suspected bots, so a crawler could affect what visitors see as trending.
   - Option: remove known and suspected bots, as the top products table does. Rulings so far limit the groups to operator and vendor reports, so this needs a decision.
3. **Do we want Monocle, given it sends visitor IP addresses to a third party?**
   - Why it matters: rented home connections are the pattern our checks find hardest.
   - Option: decide after 14 days of Turnstile results, as AECI-1459 proposes.
4. **What should we say when someone asks "how many visitors do we have?"**
   - Why it matters: any outreach figure must match these definitions, and we cannot measure people.
   - Option: quote requests with human evidence, and label the figure as a floor.
5. **How much error is acceptable?**
   - Why it matters: the repo records no measured rate for real people wrongly classified as bots. The procedure in section 2.10 is designed to produce one.
   - Option: run the labeled browsing sessions and publish the three measures in this document.

---

## Part 2: Technical specification

Terms: **ASN** is the autonomous system number, which identifies a network's owner. **UA** is the User-Agent header. **UA hash** is its SHA-256, because the raw UA is never stored in D1.

### 2.1 Pipeline

| Stage | When | Where | Output |
|---|---|---|---|
| Edge access rules | Request time | Cloudflare WAF (`docs/waf-rate-limits.md` §2, §3b) | Challenged or blocked requests write no row |
| Capture | Request time, in `waitUntil` | `apps/api/src/routes/page-views.ts` | One immutable `page_views` row with `is_bot`, `bot_name`, `client_verdict` and raw signals |
| Late Turnstile verdict | Up to 10 minutes after an arrival | `POST /api/page-views/turnstile` | Sets `turnstile_verdict` on the arrival row, matched by `cf_ray`. Not read by the classifier. |
| Nightly classification | Cron `45 0 * * *` for the prior UTC day, through queue `aeci-traffic-classify-{env}` | `lib/traffic-classification-writer.ts`, `lib/traffic-shadow.ts` | Append-only `page_view_classifications` rows |
| Reporting | Digest 05:00 UTC, and on request in the admin panel | `lib/admin-classification.ts`, `lib/analytics-digest.ts` | Classes, notes and filtered tables |

The cron runs at 00:45 because SPA follow-up evidence reads 30 minutes past the end of the day.

`page_views` has two writers. The SSR gateway writes `ssr-arrival` on every full-document load, including cache hits. The browser tracker writes `browser-spa` on in-app navigation. The SSR Worker sets `x-aeci-writer` and strips any client copy, so `writer_provenance` is trusted. `navigation` is only the writer's claim. `/admin` and `/account` are not written at all.

### 2.2 Ingest verdict: `is_bot` and `bot_name`

`classifyTraffic(ua, asn)` in `lib/bot-classification.ts`. First match wins.

| Order | Test | Result |
|---|---|---|
| 1 | `NAMED_BOTS`: 21 regexes | `bot_name` = crawler label |
| 2 | `GENERIC_BOT_RE`: `bot`, `crawl`, `spider`, `scraper`, `slurp`, `headless`, `phantom`, `python-requests`, `python-urllib`, `go-http-client`, `node-fetch`, `okhttp`, `libwww`, `httpclient`, `scanner`, `facebookexternalhit`, `curl/`, `wget/` | `Other bot` |
| 3 | `DATACENTER_ASNS`: 109 entries | Network label, such as `Datacenter (AWS)` |
| 4 | None | `is_bot = 0` |

Rules that must hold:

- `is_bot` is decided once. Changing it for old rows needs a one-way backfill.
- A new `DATACENTER_ASNS` entry needs a verified hosting holder and a human decision. Classifier evidence never adds one.
- AS714 Apple, AS22616 Zscaler, AS208323 Tor exits, mixed consumer networks and tier-1 transit are excluded on purpose.
- `scripts/ops/backfill-page-view-bots.sql` must mirror the map. A spec fails CI on drift.

### 2.3 Ingest verdict: `client_verdict`

`classifyClientSignals` in `lib/client-signals.ts`. It is an annotation, and it never feeds `is_bot`.

| Condition, in order | Verdict |
|---|---|
| Writer `browser-spa`, with `Sec-Fetch-Site: same-origin`, (`Sec-Fetch-Dest: empty` or `Sec-Fetch-Mode: cors`), and `Accept-Language` | `browser` |
| Writer `browser-spa`, otherwise | `unknown` |
| Body claims `navigation: 'spa'`, writer is not `ssr-arrival` | `unknown` |
| No `Sec-Fetch-Dest`, `Accept-Language` or `sec-ch-ua`, and `Accept` lacks `text/html`, with a UA present | `non-browser` |
| Same as above, with no UA | `unknown` |
| UA claims Chromium, no `sec-ch-ua` | `inconsistent` |
| `Sec-Fetch-Dest` is not `document`, or no `Accept-Language`, or `Accept` lacks `text/html` | `inconsistent` |
| Otherwise | `browser` |

`sec-ch-ua` applies only to Chromium claims, because Safari and Firefox never send it. A NULL verdict is no evidence, never "not a browser".

### 2.4 Network class

`lib/asn-registry.ts` maps the PeeringDB `info_type` from the `asn_registry` table, refreshed by a weekly cron.

| Class | `info_type` values | Classifier effect |
|---|---|---|
| `eyeball` | `Cable/DSL/ISP`, `Enterprise`, `Educational/Research`, `Non-Profit`, `Government` | None |
| `transit` | `NSP` | None |
| `non_eyeball` | `Content`, `Network Services`, `Route Server`, `Route Collector` | Emits `asn_non_eyeball` |
| `unclassified` | Missing, blank or unrecognized | None |

### 2.5 Window detectors

`detectSwarms` in `lib/swarm-detection.ts`. Candidates are computed over `HUMAN AND NOT_INTERNAL` rows for the UTC day. The classifier then applies membership to **every** row of that day with a flagged hash or ASN, including `is_bot = 1` rows.

| Detector | Group by | Flag when | Verdict's role |
|---|---|---|---|
| `detectUaHashSwarms` | `user_agent_hash` | views ≥ 4, and distinct ASNs ÷ views ≥ 0.8 | Reported beside the ratios, filters nothing |
| Same, recurring hash | `user_agent_hash` | Full-strength flag on ≥ 2 of the prior 14 days: views ≥ 2, and ratio ≥ 0.5 | Same |
| `detectAsnRotators` | `cf_asn` | views ≥ 4, distinct UA hashes ÷ views ≥ 0.8, and non-browser views > views ÷ 2 | Hard gate |

`detectNonBrowserClients` is a descriptive rollup. It does not feed the classifier, which reads each row's own verdict.

| Constant | Value |
|---|---|
| `SWARM_MIN_VIEWS` | 4 |
| `SWARM_MIN_ASN_RATIO` | 0.8 |
| `SWARM_PRIOR_LOOKBACK_DAYS` | 14 |
| `SWARM_PRIOR_MIN_FLAGGED_DAYS` | 2 |
| `SWARM_RECURRING_ASN_RATIO` | 0.5 |
| `SWARM_RECURRING_MIN_VIEWS` | 2 |
| `ASN_ROTATOR_MIN_VIEWS` | 4 |
| `ASN_ROTATOR_MIN_UA_RATIO` | 0.8 |
| `SWARM_MAX_CANDIDATES` | 25 per list. `swarmTruncated` records a cap hit. |

The prior is never built from relaxed flags or from the reported day. `NON_BROWSER_VERDICTS` is `inconsistent` and `non-browser`.

### 2.6 Internal traffic

`NOT_INTERNAL` in `lib/page-view-predicates.ts` has three halves, and it is applied at read time. The writer classifies internal rows too and stores no internal flag, because a later operator anchor can turn a row internal.

| Half | Test | Kind |
|---|---|---|
| Path | `/admin`, `/account` and sub-paths | Fact |
| Session | `is_operator = 1` | Fact |
| Visitor pair | Same `(user_agent_hash, cf_asn)` as an `is_operator = 1` row within ±30 days | Inference, reported as `operator_leak_inferred` |

Do not rewrite the pair test as `NOT (hash = ? AND asn = ?)`, because that drops NULL rows. `is_owner_visit` is separate (`NOT_OWNER_VISIT`). Vendor performance is its only planned reader, and nothing reads it yet.

### 2.7 Classifier

`classifyPageView(row, ctx)` in `lib/traffic-classifier.ts`. It is pure: no bindings, queries or clock. `buildClassificationDay` builds the context, and the shadow runner and nightly writer share it.

| Order | Class | Condition |
|---|---|---|
| 1 | `identified_automation` | `verified_edge` (`cf_verified_bot = true` or a non-null `cf_verified_bot_category`), or `ua_self_declared` (`is_bot`, a `NAMED_BOTS` label, and the ASN rule could not have written that label), or `ua_generic_token` |
| 2 | `suspected_automation` | Signals from ≥ 2 families (`SUSPECTED_MIN_SIGNAL_FAMILIES`) |
| 3 | `browser_with_human_evidence` | `app_executed`, no automation signal, no unmapped stored bot verdict, and `privacy_signal` is not true |
| 4 | `unresolved` | Otherwise, always with a code |

| Family | Codes |
|---|---|
| `network` | `asn_datacenter`, `asn_non_eyeball` |
| `request_shape` | `verdict_non_browser`, `verdict_inconsistent` |
| `swarm` | `swarm_member` |
| `rotator` | `asn_rotator_member` |

**Human evidence.** `app_executed` needs one of two things. Either the row is `browser-spa` with verdict `browser`, or it is an arrival with such a hop on the same non-NULL `(user_agent_hash, cf_asn)` pair within 30 minutes (`SPA_FOLLOWUP_WINDOW_MINUTES`), which also adds `spa_followup`.

**Reason codes.** There are 30, listed in `REASON_CODES`. They are stable, and renaming one is a data migration.

| Group | Codes |
|---|---|
| How identified | `verified_edge`, `ua_self_declared`, `ua_generic_token` |
| Purpose, one per identified row | `purpose_indexing`, `purpose_ai_training`, `purpose_assistant_retrieval`, `purpose_preview`, `purpose_monitoring`, `purpose_unknown` |
| Automation signals | `asn_datacenter`, `asn_non_eyeball`, `verdict_non_browser`, `verdict_inconsistent`, `swarm_member`, `asn_rotator_member` |
| Human evidence | `app_executed`, `spa_followup`, `search_referred`, `referred_external` |
| Why unresolved | `no_corroboration`, `conflicting_signals`, `bot_label_unmapped`, `single_signal_network`, `single_signal_request_shape`, `single_signal_swarm`, `single_signal_rotator` |
| Missing evidence, on any class | `evidence_no_asn`, `evidence_no_tls`, `evidence_pre_provenance`, `evidence_privacy_signal` |

**Purpose.** A Cloudflare category is preferred over the stored label, because it is a check rather than a claim. Labels that merge purposes, such as `OpenAI`, `Meta` and `PerplexityBot`, get `purpose_unknown` (AECI-762).

**Privacy rows.** `Sec-GPC: 1` or `DNT: 1` nulls the UA hash, ASN and holder, colo, Ray ID, referrer host, link token, request-shape facts, dedupe key and Turnstile verdict. `created_at` is cut to the hour, and no raw R2 envelope is written. `is_bot`, `bot_name`, `client_verdict` and `referrer_source` are still computed in memory and stored.

**Dedupe.** The key is `sha256(concrete_path | ua_hash | cf_asn | bucket)` with a 10-second bucket, and both the current and previous buckets are probed. The effective window is 10 to 20 seconds. Bot rows and rows with no UA hash are exempt.

### 2.8 Storage and versions

`page_view_classifications` (`docs/DATABASE_SCHEMA.md` §9.7, migration 0087) holds one row per page view and classifier version.

- It is append-only: `ON CONFLICT (page_view_id, classifier_version) DO NOTHING`.
- `TRAFFIC_CLASSIFIER_VERSION` and a SHA-256 fingerprint of `classifierRuleInputs()` are pinned by `traffic-classifier.spec.ts`, so an unversioned rule edit fails CI.
- Each day reads its latest version, meaning the one evaluated last. Version strings are never compared.
- A chart or delta that spans a version is flagged and never blended (`classification_version_seam`, `POST_LAUNCH_MONITORING.md` §3c step 5).
- The writes are derived and log-class under ADR 0022, so they emit no `audit_log` row.
- The backfill cap is 370 days (`BACKFILL_MAX_AGE_DAYS`), which keeps its lookbacks clear of the 400-day `page_views` retention.

### 2.9 Readers and alarms

| Surface | Population | Reads classes |
|---|---|---|
| Digest and `/admin/overview` class lines | Classification rows at the day's latest version, split by `NOT_INTERNAL` | Yes |
| Digest and `/admin/overview` top products and sources | `HUMAN`, `NOT_INTERNAL`, minus `identified_automation` and `suspected_automation` (`automationClassFilterForDay`) | Yes |
| `/admin/activity` | Latest class per row, `?class=` filter | Yes |
| Vendor performance, not built (AECI-940, `docs/VENDOR_PERFORMANCE_SPEC.md` §2.2) | Specified as `HUMAN`, `NOT_INTERNAL`, `NOT_OWNER_VISIT`, minus automation classes | Filter only, as specified. No class counts or codes are shown to vendors. |
| Public home trending (`lib/home-stats.ts`) | `HUMAN`, `NOT_INTERNAL` | **No** |
| `traffic.page_views_human` in `metrics_daily` | `HUMAN`, `NOT_INTERNAL` | No, raw by design |
| `traffic.page_views_human_after_automation` | None | Frozen since AECI-1460. Stored rows stay readable. |

| Alarm | Trigger |
|---|---|
| `classification_unresolved_share` | Unresolved is strictly above 50% of classified, non-internal views |
| `arrival_telemetry_unavailable` | Under 95% of arrivals carry `cf_asn` (`ARRIVAL_CF_COVERAGE_MIN`) |
| `tables_unclassified` | The day has no classification rows, or the filter read failed. Tables show unfiltered. |
| `collection_method_seam` | A `POST_LAUNCH_MONITORING.md` §3d row falls inside the 30-day chart window |

### 2.10 Changing a rule

The full procedure is `docs/POST_LAUNCH_MONITORING.md` §3c. A rule input is any `DATACENTER_ASNS` entry, `NAMED_BOTS` pattern, tunable constant, `NON_BROWSER_VERDICTS` value or new rule.

1. **Propose.** Open an issue that names the rule, the old and new values, and the specific rows it should reach.
2. **Shadow run.** Run `pnpm --filter @aeci/api ops:traffic-shadow -- --from YYYY-MM-DD --to YYYY-MM-DD`. It reads production D1 read-only. The sample needs operator sessions, known bots, privacy-hardened browsers, shared-proxy cases, unknown traffic and held-out days.
3. **Measure.** Report false exclusions, missed automation and unresolved share together.
4. **Record.** Bump the version, update this file and the §3b tunables table in the same PR, and add a `POST_LAUNCH_HEALTH_REPORT.md` entry.
5. **Show the seam.** Do not recompute stored days unless the re-evaluation is listed as approved in §3c.

### 2.11 Signals captured but not read

| Signal | Column | State |
|---|---|---|
| Turnstile invisible (ADR 0049) | `turnstile_verdict`: `pass`, `fail`, `unknown` or NULL | Capture is built. It is on staging and demo. Production waits on AECI-1458. Reading it needs a shadow run and a version bump. Under the single-signal rule, `fail` alone stays Unresolved. |
| Cloudflare bot score | `cf_bot_score` | Not licensed (AECI-1300). The classifier does not read it. |
| AS holder name | `cf_as_organization` | Display label only |
| Spur Monocle | None | Held (AECI-1459) |

### 2.12 Known gaps

| What is wrong | Why it matters | What to do |
|---|---|---|
| The rotator flag is gated on the verdict, and the verdict is its own family. A row on a flagged ASN with a bad verdict therefore scores two families from overlapping evidence. | "Two independent kinds of clue" is weaker here than it reads. Real people on that ASN are safe only if their own verdict is `browser`. | Decide whether this pairing should count as two families. Any change is a version bump. |
| A row with `is_bot = 1` from the ASN rule alone is `unresolved`, but `HUMAN` removes it from top tables and trending, and the vendor report spec uses the same predicate. | Class counts and those tables use different populations. A view can be Unresolved in the headline and absent from the table. | Decide whether to document this or align it, ideally before AECI-940 ships vendor numbers on it. |
| Trending does not read the classes. | Suspected automation can affect a public surface. | See question 2 in Part 1. |
| `cf_verified_bot` was NULL on every row checked on 2026-10-14. | The classifier relies on the category alone for edge verification. | AECI-1348 tracks it. |
| `POST_LAUNCH_HEALTH_REPORT.md` has no entry for any `tc-` version, though §3c step 4 requires one. | The record of what each version changed is incomplete, and no false-exclusion figure is published in the repo. | Backfill the entries from the shadow reports. Run the labeled sessions if they have not been run. |
| D19(g) and the `bot-classification.ts` header still say "Cloudflare Pro". The zone has been on a free Enterprise plan since 2026-10-04, still without Bot Management. | The rule still holds, but its stated reason is out of date. | Correct the text in the next change to those files. |
| Swarm ratios only discriminate at low volume. | A popular UA hash will span many ASNs at scale. | Revisit when human-evidence volume passes a few hundred views a day. |
| The rules are still restated in `ADMIN_PANEL_SPEC.md` §13 D19, `POST_LAUNCH_MONITORING.md` §3b, `DATABASE_SCHEMA.md` §9.7 and `API_CONTRACTS.md` §6.10. | A rule can change in one place and not the others. | Replace the restatements with links. |
| The rule to update this file is enforced only by review. No CI check ties this file to the code. | A classification change can merge and leave this file wrong. The classifier version will not catch every case, because `client-signals.ts`, `NOT_INTERNAL` and the report readers are outside its fingerprint. | Add a spec that pins this file's values to the code, and a CI check on changes to the classification files. |
| The current `asn_registry` row count was not checked for this document. | An empty registry would silently remove `asn_non_eyeball`. | Check it on the next read-only production query. |

### 2.13 Rulings so far

| Date | Ruling | By |
|---|---|---|
| 2026-10-14 | Four classes stand. Search-referred is a code, not a class. | Chris |
| 2026-10-14 | One row per page view and version, append-only | Chris |
| 2026-10-14 | Single-signal rows stay Unresolved. This moved 14,286 views out of the automation bucket in the 2026-09-13 to 10-13 baseline. Revisit only with a labeled held-out result. | Chris |
| 2026-10-21 | Cut-over to stored classes approved. Unresolved warning set at 50%. | Chris |
| 2026-10-21 | Bot Management not licensed (AECI-1300) | Chris |
| 2026-10-22 | Invisible, non-blocking Turnstile is not a blocking-policy change (AECI-1457) | Chris |
| 2026-10-23 | The planned vendor performance report may filter on the classes (AECI-1445) | Chris |
| 2026-10-27 | Backfill days stored at `tc-2026.10.2` to `tc-2026.10.3`, so the series carries one version | Chris |

### 2.14 Source index

| Topic | File |
|---|---|
| Decision history and rationale | `docs/ADMIN_PANEL_SPEC.md` §13 D19 |
| Operations and tunables | `docs/POST_LAUNCH_MONITORING.md` §3b, §3c, §3d |
| Storage | `docs/DATABASE_SCHEMA.md` §9.7 |
| API shapes | `docs/API_CONTRACTS.md` §6.10 |
| Edge rules | `docs/waf-rate-limits.md` |
| Classifier | `apps/api/src/lib/traffic-classifier.ts` |
| Ingest verdicts | `apps/api/src/lib/bot-classification.ts`, `apps/api/src/lib/client-signals.ts` |
| Detectors | `apps/api/src/lib/swarm-detection.ts` |
| Predicates | `apps/api/src/lib/page-view-predicates.ts` |
| Nightly writer | `apps/api/src/lib/traffic-classification-writer.ts` |
| Report reads | `apps/api/src/lib/admin-classification.ts` |
| Capture | `apps/api/src/routes/page-views.ts` |
