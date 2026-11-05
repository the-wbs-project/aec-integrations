# Bot traffic classification

**Status: the record of truth for how AECi classifies traffic. It describes classifier `tc-2026.11.2`, checked against the code on 2026-11-05 on top of commit `125eb9ee1`, with the `Claude-User` rule from AECI-1626.**

This is the one place that states how page views are sorted into bots, people and everything in between. Part 1 explains every check for a reader who knows the product but not the code. Part 2 is the technical specification.

If another document disagrees with this file, this file wins and the other is a defect. If this file and the code disagree, the code shows what is running, and the difference is a defect to fix. The reasoning behind past decisions stays in `docs/ADMIN_PANEL_SPEC.md` §13 D19.

**Update this file in the same PR as any change to how traffic is classified.** That covers the checks, thresholds, crawler and network lists, classes, reason codes, internal-traffic rules, and which reports read the classes. Update Part 1 too whenever the change alters what it says. Two checks enforce this. `bot-traffic-classification-doc.spec.ts` fails when this file's version, classes, reason codes, list counts or thresholds differ from the code. `classification-doc-check.yml` goes red when a PR touches a classification file and leaves this file alone. A change with no rule impact opts out with this line in the PR description: `**Classification doc:** no rule impact — <reason>`. `mirror-docs-to-linear` copies it to Linear on merge and overwrites the Linear copy, so edits made in Linear are lost.

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
| 2 | **The visitor's name tag** | Does the browser's description of itself name a known bot, or use a word like "bot", "crawler" or "spider"? We keep a list of 22 named crawlers. | A bot can leave the word out. A faker can also claim to be Googlebot. Either way it is still not a person. |
| 3 | **Who owns the network** | Does the request come from a data center or cloud company on our list of 109 networks? | A real person on a VPN or a cloud desktop looks the same. This is why it never decides alone. |
| 4 | **What kind of network it is** | Does a public directory list this network as a content or infrastructure company rather than an internet provider? | Many networks are not in the directory, and those tell us nothing. This counts as the same kind of clue as check 3, not a second one. |
| 5 | **Does the request look like a browser** | A real browser sends a recognizable set of details with each request. Are they all there, and do they agree with what the visitor claims to be? | Cheap tools fail this. A real browser driven by a robot passes, because it really is a browser. |

We keep networks like Apple's and large internet providers off the list in check 3 on purpose. Real people use them, and being on that list marks a request permanently.

#### Each night, looking across the whole day

Just after midnight UTC, we review the previous day. These checks need a full day of data, because they look for patterns no single request can show. A day is judged only on what came at or before it, apart from the 30-minute allowance in check 8. So we never go back and re-judge a client's earlier quiet days, and we accept missing those.

| # | Check | The question it asks | What it can get wrong |
|---|---|---|---|
| 6 | **One browser identity on many networks** | Did the same browser identity appear from a different network on nearly every view? This is the rented-connections pattern from the example above. | A very popular browser version could do this by chance. It works for us today because our traffic is small. We will need to revisit it as traffic grows. |
| 7 | **One network with a new identity every time** | Did one network show a different browser identity on nearly every view, and did most of those views fail check 5? | An office shares one network across many people. That is why this check also requires failing check 5. |
| 8 | **Did our app actually run** | Did the visitor click through to another page inside our app, from a request that passed the browser check? We also accept a click within 30 minutes of arriving. | A robot driving a real browser can pass. This is why the group says "human evidence" and not "humans". |
| 9 | **Where they came from** | Did the visitor arrive from Google, LinkedIn or another site? | We record this, but it does not change the group. Anyone can fake it. |
| 10 | **Crawl shape** | Did one browser identity on one network load at least 15 pages, at least 80% of them different, on this day alone or over this day and the 14 before it, while our app never ran in those 15 days? Only that identity's page loads on this day are marked. | A person on a VPN who loads 15 different pages and never clicks through inside the app looks the same. So can a shared office network. That is why it never decides alone. One person's click-through on a shared identity and network also clears everyone on it for those 15 days, so a crawler can hide behind it. |
| 11 | **Burst** | Did one client load the same page at least 20 times within any 60 seconds? | A monitor or a broken script can do this. It can come from one machine and still cost us little, because most of the requests are cache hits. It only says the count is inflated by something that is not reading. |

#### Other rules that apply

| Rule | What it does |
|---|---|
| **Is it us?** | We take out our own administrators' browsing. We know it is ours from admin pages, from an admin login, or from a matching browser and network within 30 days of a login. On 2026-08-19 our own browsing was 15% of all "human" public views. This is reported on its own line, not as one of the four groups. |
| **Vendors viewing their own listing** | We mark these visits today. Our site-wide numbers still count them. The planned vendor performance report will remove them. |
| **Visitors who ask for privacy** | When a browser sends a "do not track" or Global Privacy Control signal, we keep only an anonymous count. Without the details, we cannot check the visitor, so these views stay Unresolved unless they name themselves as a bot. |
| **Double counting** | Two identical views within about 10 to 20 seconds count as one. This does not apply to known bots or to a visitor with a blank browser description. So a burst (check 11) can only come from one of those two. |

#### What we have but do not use yet

- **Cloudflare Turnstile.** This is an invisible browser test from Cloudflare. It never blocks anyone. It collects answers on our test sites and on production. On production it skips visitors in the EU, EEA, UK and Switzerland (AECI-1581), who wait on a legal question (AECI-1458). The classifier ignores its answer for now.
- **Spur Monocle.** This is a service that detects rented home connections. It is on hold, because it would send visitor IP addresses to a third party (AECI-1459).
- **Cloudflare Bot Management.** This is Cloudflare's paid bot scoring. We do not pay for it and decided not to on 2026-10-21. We ignore any score it produces.

### How the checks become a group

The system asks these questions in order and stops at the first "yes".

1. **Did Cloudflare confirm it, or did the visitor name itself as a bot?** It goes to Identified automation.
2. **Do at least two different kinds of check point to a bot?** It goes to Suspected automation. There are six kinds: the network (checks 3 and 4), the browser check (5), many networks (6), many identities (7), crawl shape (10) and burst (11).
3. **Did our app run, with no bot clue against it, and is this not a privacy-signal view?** It goes to Browser with human evidence.
4. **Otherwise,** it goes to Unresolved, with a recorded reason.

### Examples

We ran each of these through the real classifier code.

| Situation | Group | Why |
|---|---|---|
| Googlebot, confirmed by Cloudflare | Identified automation | Confirmed by Cloudflare |
| A tool calling itself Googlebot, from a rented server | Identified automation | It named itself. Our record shows it was not confirmed. |
| A browser-like visitor on Amazon's cloud, with incomplete browser details | Suspected automation | Two kinds of clue agree: network and browser check |
| A browser-like visitor on Amazon's cloud, with perfect browser details, reading a few pages | Unresolved | Only one kind of clue |
| A browser-like visitor on Amazon's cloud, with perfect browser details, loading hundreds of different pages in a day while our app never runs | Suspected automation | Two kinds of clue agree: network and crawl shape |
| A visitor with a blank browser description on Microsoft's cloud, loading one page 130 times in a minute | Suspected automation | Two kinds of clue agree: network and burst |
| Someone on a home connection loading 20 different pages in a day while our app never runs | Unresolved | Only one kind of clue |
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
- **A single large client in Unresolved is a lead, not a verdict.** The daily email lists the ten largest and warns when one passes 5% of the day's non-internal views. The list changes no group. On 2026-10-23 one crawler held 791 of 6,940 views, 11.4%, and nothing flagged it at the time.
- **The group definitions have versions.** When the rules change, reports mark the change and do not compare across it. Old results are kept.
- **A day can be flagged as degraded.** If more than 5% of arrivals lost their network details, the report says the network checks could not run. This happened from 2026-09-07 until the fix on 2026-09-13, when four blind days looked like a good week.

### Where you see this

| Where | What it shows |
|---|---|
| **Daily email and the admin overview** | The four groups, our own traffic on a separate line, and any warnings |
| **Daily email only** | The ten largest Unresolved clients, by browser identity and network, with a warning above 5% |
| **Admin activity page** | The group for each individual view, with a filter |
| **Top products and top sources** | Views with known or suspected bots removed, and views from the listed data center networks |
| **Vendor performance report, not built yet (AECI-940)** | The spec calls for the same removal, plus the vendor's own visits. Vendors will never see the groups. |
| **Public "trending" card on the home page** | The older, simpler filter. It does not use the four groups yet. See question 2. |

No page, visitor or vendor is ever blocked or penalized because of a group. Classification only affects reports.

### Open questions

1. **Are we comfortable that a real person who reads one page is Unresolved?**
   - Why it matters: search visitors often read one page. Our human-evidence figure misses them, and we do not know by how many.
   - Option: wait for Turnstile on production, which could provide evidence without a click. It runs there outside the exclusion since AECI-1581. Evidence for EU, EEA, UK and Swiss visitors depends on the AECI-1458 legal answer.
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
| 1 | `NAMED_BOTS`: 22 regexes | `bot_name` = crawler label |
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

The values are in §2.15. `swarmTruncated` records a hit on the `SWARM_MAX_CANDIDATES` cap.

The prior is never built from relaxed flags or from the reported day. `NON_BROWSER_VERDICTS` is `inconsistent` and `non-browser`.

**Crawl shape and burst (AECI-1578).** `findCrawlShapeRows` and `findBurstRows` in `lib/traffic-classifier.ts`, called by `buildClassificationDay`. They read **every** row, not `HUMAN AND NOT_INTERNAL`, because their targets are mostly `is_bot = 1` rows from the ASN rule. So they cannot reuse the swarm prior. Crawl shape has its own read, `readCrawlShapeWindows` in `lib/traffic-shadow.ts`: one grouped statement with a fixed few bound values. Only rows on the reported day get the signal. Nothing looks forward except the 30-minute hop margin, and earlier days are never re-judged.

| Rule | Group by | Rows counted | Flag when |
|---|---|---|---|
| Crawl shape | `(user_agent_hash, cf_asn)`, tested on the reported UTC day alone and on that day plus the prior 14 | Arrivals with a non-NULL hash, ASN and `concrete_path` | Either span passes: views ≥ 15 and true distinct `concrete_path` ÷ views ≥ 0.8 on that span. A browser-verified `browser-spa` hop for the pair anywhere in the 15 days or the 30-minute follow-up margin stops both tests. |
| Burst | `(concrete_path, cf_asn, user_agent_hash)`, a sliding 60 seconds | Any row with a non-NULL ASN and `concrete_path`. A NULL hash groups with NULL hashes. | views ≥ 20 within 60 seconds. Two views exactly 60 seconds apart are not in one window. Only rows inside a qualifying window carry the signal. |

The thresholds are in §2.15. They are starting values for the shadow run, not rulings. Crawl shape has two tests because each misses a real client. A crawler revisiting a finite catalog lowers the trailing ratio with every pass: `7484a43e` on AS14618 read 94.0%, 86.0% and 75.9% on 10-30, 10-31 and 11-01, with 606 views and 606 distinct paths on 11-01 alone. A slow crawler never fills one day. `readCrawlShapeWindows` returns both spans' counts from its one statement, with eleven bound values and no compound SELECT. A burst across midnight is seen on the second day, which reads back 60 seconds. The first day's rows stay unflagged unless they qualify alone. `evidence_from` takes the longer of the swarm and crawl-shape lookbacks, so a stored row still states what its judgement rested on. A privacy row cannot reach either rule. It stores no hash or ASN, and its `created_at` is cut to the hour, so the NULL-ASN guard is what stops every DNT/GPC visit to a page in an hour from reading as one burst. Ingest dedupe uses the burst tuple, so a hashed non-bot row cannot reach the burst threshold. Rows older than AECI-585 have no `concrete_path` and carry neither signal.

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
| `crawl_shape` | `crawl_shape_member` |
| `burst` | `burst_member` |

**Human evidence.** `app_executed` needs one of two things. Either the row is `browser-spa` with verdict `browser`, or it is an arrival with such a hop on the same non-NULL `(user_agent_hash, cf_asn)` pair within 30 minutes (`SPA_FOLLOWUP_WINDOW_MINUTES`), which also adds `spa_followup`.

**Reason codes.** There are 34, listed in `REASON_CODES`. They are stable, and renaming one is a data migration.

| Group | Codes |
|---|---|
| How identified | `verified_edge`, `ua_self_declared`, `ua_generic_token` |
| Purpose, one per identified row | `purpose_indexing`, `purpose_ai_training`, `purpose_assistant_retrieval`, `purpose_preview`, `purpose_monitoring`, `purpose_unknown` |
| Automation signals | `asn_datacenter`, `asn_non_eyeball`, `verdict_non_browser`, `verdict_inconsistent`, `swarm_member`, `asn_rotator_member`, `crawl_shape_member`, `burst_member` |
| Human evidence | `app_executed`, `spa_followup`, `search_referred`, `referred_external` |
| Why unresolved | `no_corroboration`, `conflicting_signals`, `bot_label_unmapped`, `single_signal_network`, `single_signal_request_shape`, `single_signal_swarm`, `single_signal_rotator`, `single_signal_crawl_shape`, `single_signal_burst` |
| Missing evidence, on any class | `evidence_no_asn`, `evidence_no_tls`, `evidence_pre_provenance`, `evidence_privacy_signal` |

**Purpose.** A Cloudflare category is preferred over the stored label, because it is a check rather than a claim. Labels that merge purposes, such as `OpenAI`, `Meta` and `PerplexityBot`, get `purpose_unknown` (AECI-762). `Claude-User (Anthropic)` is the one on-demand fetcher with its own label, so it reads `purpose_assistant_retrieval` (AECI-1626). Its rule sits above the `claudebot` rule because one of its forms carries `claudebot@anthropic.com` as a contact address. A row stored before AECI-1626 keeps its old label or `is_bot = 0`, because the classifier reads the stored label and not the user agent. The label is a claim: an unverified row that borrows the name reads the same, without `verified_edge`.

**Privacy rows.** `Sec-GPC: 1` or `DNT: 1` nulls the UA hash, ASN and holder, colo, Ray ID, referrer host, link token, request-shape facts, dedupe key and Turnstile verdict. `created_at` is cut to the hour, and no raw R2 envelope is written. `is_bot`, `bot_name`, `client_verdict` and `referrer_source` are still computed in memory and stored. A privacy row's human evidence reads as `no_corroboration`, not `conflicting_signals`, because nothing contradicts it. Its evidence gap is the one code `evidence_privacy_signal`, in place of `evidence_no_asn` and `evidence_no_tls`. A label the ASN rule can also write, such as `Censys (scanner)`, is never read as `ua_self_declared` on a privacy row, because the row has no ASN to tell which rule wrote it.

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
| Digest top Unresolved clients (`readTopUnresolvedClients`, AECI-1579) | `unresolved` rows at the day's latest version, `NOT_INTERNAL`, grouped by `(user_agent_hash, cf_asn)`. A NULL hash with a non-NULL ASN and no privacy signal is kept, as one no-user-agent client per network. Privacy rows and rows with neither are dropped. No `HUMAN` filter, because a row with `is_bot = 1` from the ASN rule alone is `unresolved`. | Yes. Report-only. |
| Vendor performance, not built (AECI-940, `docs/VENDOR_PERFORMANCE_SPEC.md` §2.2) | Specified as `HUMAN`, `NOT_INTERNAL`, `NOT_OWNER_VISIT`, minus automation classes | Filter only, as specified. No class counts or codes are shown to vendors. |
| Public home trending (`lib/home-stats.ts`) | `HUMAN`, `NOT_INTERNAL` | **No** |
| `traffic.page_views_human` in `metrics_daily` | `HUMAN`, `NOT_INTERNAL` | No, raw by design |
| `traffic.page_views_human_after_automation` | None | Frozen since AECI-1460. Stored rows stay readable. |

| Alarm | Trigger |
|---|---|
| `classification_unresolved_share` | Unresolved is strictly above 50% of classified, non-internal views |
| Unresolved client above the line (digest subject and callout, not an `AdminNote`) | One `(user_agent_hash, cf_asn)` pair is strictly above 5% of classified, non-internal views (`UNRESOLVED_CLIENT_ALERT_SHARE`) |
| `arrival_telemetry_unavailable` | Under 95% of arrivals carry `cf_asn` (`ARRIVAL_CF_COVERAGE_MIN`) |
| `tables_unclassified` | The day has no classification rows, or the filter read failed. Tables show unfiltered. |
| `collection_method_seam` | A `POST_LAUNCH_MONITORING.md` §3d row falls inside the 30-day chart window |

### 2.10 Changing a rule

The full procedure is `docs/POST_LAUNCH_MONITORING.md` §3c. A rule input is any `DATACENTER_ASNS` entry, `NAMED_BOTS` pattern, rule-input constant in §2.15, `NON_BROWSER_VERDICTS` value or new rule.

1. **Propose.** Open an issue that names the rule, the old and new values, and the specific rows it should reach.
2. **Shadow run.** Run `pnpm --filter @aeci/api ops:traffic-shadow -- --from YYYY-MM-DD --to YYYY-MM-DD`. It reads production D1 read-only. The sample needs operator sessions, known bots, privacy-hardened browsers, shared-proxy cases, unknown traffic and held-out days.
3. **Measure.** Report false exclusions, missed automation and unresolved share together.
4. **Record.** Bump the version, update this file, including §2.15, in the same PR, and add a `POST_LAUNCH_HEALTH_REPORT.md` entry.
5. **Show the seam.** Do not recompute stored days unless the re-evaluation is listed as approved in §3c.

### 2.11 Signals captured but not read

| Signal | Column | State |
|---|---|---|
| Turnstile invisible (ADR 0049) | `turnstile_verdict`: `pass`, `fail`, `unknown` or NULL | Capture is built. It is on staging, demo and production, except for EU, EEA, UK and Swiss visitors (AECI-1581). They wait on AECI-1458. Reading it needs a shadow run and a version bump. Under the single-signal rule, `fail` alone stays Unresolved. |
| Cloudflare bot score | `cf_bot_score` | Not licensed (AECI-1300). The classifier does not read it. |
| AS holder name | `cf_as_organization` | Display label only |
| Spur Monocle | None | Held (AECI-1459) |

### 2.12 Known gaps

| What is wrong | Why it matters | What to do |
|---|---|---|
| One browser-verified hop on a shared `(user_agent_hash, cf_asn)` pair exempts the whole pair from both crawl-shape tests for 15 days. | A person on a shared pair can hide a crawler, and that crawler stays Unresolved. | The shadow report lists each such pair under "pairs the hop veto stopped", fewest hops first. Decide after reading it. |
| The rotator flag is gated on the verdict, and the verdict is its own family. A row on a flagged ASN with a bad verdict therefore scores two families from overlapping evidence. | "Two independent kinds of clue" is weaker here than it reads. Real people on that ASN are safe only if their own verdict is `browser`. | Decide whether this pairing should count as two families. Any change is a version bump. |
| A row with `is_bot = 1` from the ASN rule alone is `unresolved`, but `HUMAN` removes it from top tables and trending, and the vendor report spec uses the same predicate. | Class counts and those tables use different populations. A view can be Unresolved in the headline and absent from the table. | Decide whether to document this or align it, ideally before AECI-940 ships vendor numbers on it. |
| Trending does not read the classes. | Suspected automation can affect a public surface. | See question 2 in Part 1. |
| `cf_verified_bot` was NULL on every row checked on 2026-10-14. | The classifier relies on the category alone for edge verification. | AECI-1348 tracks it. |
| `POST_LAUNCH_HEALTH_REPORT.md` has an entry for `tc-2026.11.1` but none for `tc-2026.10.2` or `tc-2026.10.3`, though §3c step 4 requires one. | The record of what those versions changed is incomplete. | Backfill the two entries from the shadow reports. Run the labeled sessions if they have not been run. |
| `matchLabelledSession` needs a non-NULL `cf_asn`, and a DNT/GPC row has none and an hour-cut timestamp. So a labelled session with GPC on matches no rows. | The privacy-hardened slice measures nothing for those sessions. Firefox with GPC and Brave are two of the §3c sessions. | Run a hardened session with GPC off as well (§3c). A spec proves privacy rows cannot reach crawl shape or burst. A later rule that reads other fields needs its own check. |
| Swarm ratios only discriminate at low volume. | A popular UA hash will span many ASNs at scale. | Revisit when human-evidence volume passes a few hundred views a day. |
| `classification-doc-check.yml` sees only that this file changed, not that the change is right. Its opt-out line is a claim. The spec cannot pin prose such as the `client_verdict` table in §2.3. | A wrong edit or a wrong opt-out can still pass. | Review judges both (`docs/CODE_REVIEW_CHECKLIST.md`). |
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
| 2026-11-02 | Add crawl shape and burst as their own signal families (AECI-1578). Each alone stays Unresolved. No blocking and no rate limit follow from them. Crawl shape counts a trailing 15 days, burst a sliding 60 seconds, and a day is never judged on later rows. Pending the shadow run. | Chris |
| 2026-11-02 | Crawl shape passes on the reported day alone or on the trailing 15 days, because the trailing test alone lost `7484a43e` on AS14618 (AECI-1578). The veto, the thresholds and the two-family rule do not change. The version stays `tc-2026.11.1`, because no tier had stored a row at it. Pending the shadow run. | Chris |
| 2026-11-05 | `Claude-User` gets its own label from the deploy forward (AECI-1626). No `is_bot` backfill and no re-evaluation of stored days. The known rows stay as stored: 55 with `is_bot = 0`, a floor. AECI-940 is told. | Chris |

### 2.14 Source index

| Topic | File |
|---|---|
| Decision history and rationale | `docs/ADMIN_PANEL_SPEC.md` §13 D19 |
| Operations | `docs/POST_LAUNCH_MONITORING.md` §3b, §3c, §3d |
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
| Pins this file to the code | `apps/api/src/lib/bot-traffic-classification-doc.spec.ts` |
| Fails a PR that skips this file, and lists the classification files | `.github/workflows/classification-doc-check.yml`, `scripts/ci/check-classification-doc.mjs` |

### 2.15 Tunable constants

Change a value here and in its module in the same PR. Moved from `POST_LAUNCH_MONITORING.md` §3b by AECI-1577.

| Constant | Value | Why |
|---|---|---|
| `SWARM_MIN_VIEWS` | `4` | Below this the ratios are noise; one view is trivially "1 ASN for 1 view". |
| `SWARM_MIN_ASN_RATIO` | `0.8` | "Nearly every view came from a different network." A real browser sits on one network; a proxy pool cannot. |
| `ASN_ROTATOR_MIN_VIEWS` | `4` | Same floor, same reason. A separate constant even though the values match: the two groupings have different false-positive profiles and will be tuned apart. |
| `ASN_ROTATOR_MIN_UA_RATIO` | `0.8` | "Nearly every request wore a different fingerprint." A UA changes on browser update, not between page loads. **Validated at exactly this value**: the AS47544 shape is 4 hashes over 5 views = 0.80, so `0.85` would have missed it. |
| *(the verdict signal)* | *none* | `detectNonBrowserClients` has **no threshold by design** (AECI-744) — listed here so its absence reads as a decision rather than an oversight. Adding a floor would reintroduce the defect. The only tunable is the vocabulary itself, `NON_BROWSER_VERDICTS`. It is a classifier input, so a change to it bumps `TRAFFIC_CLASSIFIER_VERSION` (`POST_LAUNCH_MONITORING.md` §3c). |
| `SWARM_MAX_CANDIDATES` | `25` | Caps each candidate list, because the union count binds one parameter per flagged hash/ASN and D1's parameter ceiling is far below stock SQLite's. `swarmNote` said when it bit until AECI-1460 deleted it on 2026-10-23. The cap is applied BEFORE the union read, so AECI-742's longer candidate list makes truncation more likely and never the bound looser. It also caps `verdictCandidates`, but only for display: those views are flagged per row in SQL, so slicing the list cannot remove one from the count. |
| `SWARM_PRIOR_LOOKBACK_DAYS` | `14` | How far back the recurrence read looks for a hash's flagged history (AECI-742). Ends at the reported window's start, never inside it. Long enough to survive a client pausing over a weekend, short enough to forgive a hash that reformed within a fortnight. `page_views` is retained 400 days, so the ceiling here is judgement, not retention. |
| `SWARM_PRIOR_MIN_FLAGGED_DAYS` | `2` | Flagged days inside the lookback before a hash counts as recurring. Two, not one: one flagged day is the evidence the per-day test already acted on, so requiring one would merely re-apply yesterday's verdict. The eight hashes this was built from ran **every** day of 2026-08-21..30. |
| `SWARM_RECURRING_ASN_RATIO` | `0.5` | The ratio a recurring hash is held to instead of `SWARM_MIN_ASN_RATIO`. Both measured escapes sit above it (0.70 and 0.63) and below the standing 0.8. **Must stay above zero** - a prior lowers the bar, it does not remove it. |
| `SWARM_RECURRING_MIN_VIEWS` | `2` | The view floor a recurring hash is held to instead of `SWARM_MIN_VIEWS`. The 4-view floor exists because ratios over 1-3 views are noise *when nothing else is known*; a fortnight of flagged history is something else being known. Still two rather than one: a single view is trivially ratio 1.0 and would let the prior decide alone. |
| `CLASSIFICATION_UNRESOLVED_SHARE_MAX` | `0.5` | The unresolved share of classified non-internal views above which the overview emits the `classification_unresolved_share` warning (AECI-1345, ruled 2026-10-21). Strictly greater than, so exactly half does not fire. `apps/api/src/lib/admin-classification.ts`. A display threshold only: changing it moves no stored row and needs no classifier version bump. |
| `UNRESOLVED_CLIENT_ALERT_SHARE` | `0.05` | The share of the day's classified, non-internal views above which one `(user_agent_hash, cf_asn)` pair alerts in the digest (AECI-1579, ruled 2026-11-02 as a starting value). Strictly greater than, so exactly 5% does not alert. `apps/api/src/lib/admin-classification.ts`. |
| `TOP_UNRESOLVED_CLIENTS_LIMIT` | `10` | How many Unresolved clients the digest lists (AECI-1579). Only display: the largest client is always listed, so the limit can only hide an alert if more than ten clients pass the line together. `apps/api/src/lib/admin-classification.ts`. |
| `OPERATOR_PAIR_LOOKBACK_DAYS` | `30` | How far either side of a row the operator retro-join looks for an `is_operator = 1` anchor on the same `(user_agent_hash, cf_asn)` pair (§2.6). Symmetric, because a lapse can precede the session's first flagged row as easily as follow its last. |
| `SUSPECTED_MIN_SIGNAL_FAMILIES` | `2` | D19 classifier (AECI-872, joined this table with AECI-1346). Distinct signal families a row needs before it is `suspected_automation`. Two network facts about one ASN are one family, so they never add up to two signals. `apps/api/src/lib/traffic-classifier.ts`. A rule input: changing it bumps `TRAFFIC_CLASSIFIER_VERSION` (`POST_LAUNCH_MONITORING.md` §3c). |
| `SPA_FOLLOWUP_WINDOW_MINUTES` | `30` | D19 classifier. How long after an arrival a `browser-spa` hop on the same `(user_agent_hash, cf_asn)` pair still counts as that arrival's app running. It is why `traffic-classify` runs at 00:45, not 00:15. `apps/api/src/lib/traffic-classifier.ts`. A rule input: changing it bumps the classifier version. |
| `CRAWL_SHAPE_LOOKBACK_DAYS` | `14` | D19 classifier (AECI-1578). Days before the reported one that crawl shape's trailing test counts, so a slow crawler and one split across midnight are seen. Separate from `SWARM_PRIOR_LOOKBACK_DAYS` because the two read different populations. `evidenceWindows` takes the longer, so `evidence_from` stays true. A starting value, not a ruling. `apps/api/src/lib/traffic-classifier.ts`. A rule input: changing it bumps the classifier version. |
| `CRAWL_SHAPE_MIN_VIEWS` | `15` | D19 classifier (AECI-1578). Arrivals one `(user_agent_hash, cf_asn)` pair needs, on the reported day alone or across the window, before it can have a crawl shape. A starting value for the shadow run, not a ruling. `apps/api/src/lib/traffic-classifier.ts`. A rule input: changing it bumps the classifier version. |
| `CRAWL_SHAPE_MIN_DISTINCT_PATH_RATIO` | `0.8` | D19 classifier (AECI-1578). True distinct `concrete_path` values ÷ arrivals, on the same span as the view floor, at or above which a pair reads as crawling. A person rereads pages. A crawler that revisits does too, which is why the reported day is tested on its own as well as the window. A starting value, not a ruling. `apps/api/src/lib/traffic-classifier.ts`. A rule input: changing it bumps the classifier version. |
| `BURST_MIN_VIEWS` | `20` | D19 classifier (AECI-1578). Views of one `(concrete_path, cf_asn, user_agent_hash)` inside `BURST_WINDOW_SECONDS` that make a burst. Ingest dedupe holds a hashed non-bot row to about 6 a minute on this same tuple, so only bot rows and blank user agents can reach it. A starting value, not a ruling. `apps/api/src/lib/traffic-classifier.ts`. A rule input: changing it bumps the classifier version. |
| `BURST_WINDOW_SECONDS` | `60` | D19 classifier (AECI-1578). The sliding burst window, so a burst across a clock minute or midnight is seen. It reads back across midnight and never forward. `apps/api/src/lib/traffic-classifier.ts`. A rule input: changing it bumps the classifier version. |
| `SHARED_PROXY_MIN_UA_HASHES` | `5` | D19 shadow runner only. Distinct user-agent hashes on one eyeball ASN in one UTC hour before the shadow report lists it for review as a shared-proxy case (the D19(d) sample). `apps/api/src/lib/traffic-shadow.ts`. It classifies nothing, so changing it needs no version bump. |

**Tuning a rule input is a classifier-version change.** Since AECI-1460 (2026-10-23), the detector constants reach reports only through the classifier. A change to a rule input follows the `POST_LAUNCH_MONITORING.md` §3c loop and bumps `TRAFFIC_CLASSIFIER_VERSION`. The classifier record then shows the seam. The display thresholds and the shadow runner's constant move no stored row and need no bump, as their rows say. `traffic.page_views_human_after_automation` is frozen with no writer, so tuning no longer corrupts it. Its stored rows were written under the constants in force on each day.
